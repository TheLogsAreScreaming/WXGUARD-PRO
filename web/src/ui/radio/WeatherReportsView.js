// Port of MC1/Views/Tools/Weather/WeatherReportsView.swift.
//
// One Weather Service product per screen, reached straight from a row on the place page
// (docs/MESHWX_UI.md §12): the newest reply to **this page's** request for it, else the newest
// one somebody else asked for, said to be somebody else's.
//
// **One attribution rule for all five** (§3.1 U-15): the blurb says what the product *is* and
// nothing about where a copy came from; the header directly above the text attributes it, read
// off the reply actually on screen.
import { h } from '../kit/dom.js'
import { Card, List, Prose, Row } from '../kit/components.js'
import { icon } from '../kit/icons.js'
import { t } from '../../l10n.js'
import { MeshWXTextSubject } from '../../meshwx/index.js'
import { WeatherReportSelection } from '../../screen/index.js'
import { WeatherRequest, WeatherTextAssembly } from '../../weather/index.js'
import { WeatherReferenceNames } from '../../app/index.js'
import { copy, Line, safeScreen } from './support.js'
import { AskButton, PendingBar } from './WeatherAskControl.js'

/** A text reply's body with a marker wherever a part never arrived. */
export const WeatherReportText = Object.freeze({
  /**
   * The chunks in order, with the missing-part marker in place of the ones the air ate.
   *
   * A marker and a cut reply are different things: a marker is a hole asking again may fill, and
   * the cut note under the card is the whole reply that radio will ever send (§12.1).
   */
  body(assembly) {
    return WeatherTextAssembly.orderedChunks(assembly)
      .map((chunk) => chunk ?? t('weather.reports.missingPart'))
      .join('')
  },
})

/**
 * The reply's text as DOM, with each missing part its own marked element rather than a line of
 * body text that happens to read like one.
 */
export function NarrativeBody(assembly, { key = 'narrative' } = {}) {
  const chunks = WeatherTextAssembly.orderedChunks(assembly)
  const marker = t('weather.reports.missingPart').trim()
  const children = chunks.map((chunk, index) => (chunk == null
    ? h('span', { class: 'narrative__missing', key: `gap-${index}` }, marker)
    : document.createTextNode(chunk)))
  return h('div', { class: 'narrative narrative--mono', key }, children)
}

/**
 * The Weather Service products a bot sends on request, keyed by the text subject the wire
 * carries (spec §8), which is what a screen is opened with.
 */
export const WeatherReportProduct = Object.freeze({
  bySubject: Object.freeze({
    [MeshWXTextSubject.forecastDiscussion]: 'discussion',
    [MeshWXTextSubject.hazardousOutlook]: 'outlook',
    [MeshWXTextSubject.stormReports]: 'stormReports',
    [MeshWXTextSubject.rainfall]: 'rainfall',
    [MeshWXTextSubject.spaceWeather]: 'spaceWeather',
  }),

  kind(subject) {
    return WeatherReportProduct.bySubject[subject] ?? null
  },

  title(kind) {
    switch (kind) {
      case 'discussion': return t('weather.reports.discussion.title')
      case 'outlook': return t('weather.reports.outlook.title')
      case 'stormReports': return t('weather.reports.storms.title')
      case 'rainfall': return t('weather.reports.rainfall.title')
      case 'spaceWeather': return t('weather.reports.space.title')
      default: return t('weather.reports.title')
    }
  },

  /** What the product *is*, and nothing about where a copy came from (§3.1 U-15). */
  description(kind) {
    switch (kind) {
      case 'discussion': return t('weather.reports.discussion.description')
      case 'outlook': return t('weather.reports.outlook.description')
      case 'stormReports': return t('weather.reports.storms.description')
      case 'rainfall': return t('weather.reports.rainfall.description')
      case 'spaceWeather': return t('weather.reports.space.description')
      default: return ''
    }
  },

  /** Asked for by state, and so carries the state row on its own screen. */
  isByState(kind) {
    return kind === 'stormReports' || kind === 'rainfall'
  },

  /**
   * Whether the product's argument names an *area* — an office or a state. A reply to one of
   * these that this phone did not ask for could be about anywhere, because a chunk carries only
   * its subject (§14 Q5).
   */
  isByArea(kind) {
    return kind === 'discussion' || kind === 'stormReports' || kind === 'rainfall'
  },

  /** The request, with its argument from **this page's** place; null when the place gives none. */
  request(kind, page) {
    switch (kind) {
      case 'discussion': {
        const office = page?.context?.placeOffice ?? null
        return office == null ? null : WeatherRequest.forecastDiscussion({ office })
      }
      case 'outlook': return WeatherRequest.hazardousOutlook
      case 'stormReports': {
        const state = page?.reportState ?? null
        return state == null ? null : WeatherRequest.stormReports({ state })
      }
      case 'rainfall': {
        const state = page?.reportState ?? null
        return state == null ? null : WeatherRequest.rainfall({ state })
      }
      case 'spaceWeather': return WeatherRequest.spaceWeather
      default: return null
    }
  },
})

export function WeatherReportScreen({ app, page, subject }) {
  const kind = WeatherReportProduct.kind(subject)

  /**
   * What the text on screen is: the area it answers for when that is known, and the radio it came
   * from. An overheard reply names no area — it has none the phone can read — and says so rather
   * than borrowing the page's.
   */
  const header = (choice) => {
    const parts = []
    const request = choice.item.assembly?.request ?? null
    if (request?.kind === 'stormReports' || request?.kind === 'rainfall') {
      parts.push(WeatherReferenceNames.stateName(request.state))
    } else if (request?.kind === 'forecastDiscussion') {
      parts.push(WeatherReferenceNames.officeName(request.office))
    }
    if (!choice.isOwn) {
      parts.push(t('weather.reports.overheard'))
      if (choice.isUnknownArea) parts.push(t('weather.reports.unknownArea'))
    }
    parts.push(app.model?.botName?.(choice.item.botID) ?? '')
    return parts.filter(Boolean).join(' · ')
  }

  return safeScreen({
    id: 'report',
    title: () => WeatherReportProduct.title(kind),
    render() {
      const words = copy(app, page)
      const request = WeatherReportProduct.request(kind, page)
      const choice = WeatherReportSelection.choose({
        texts: page?.snapshot?.texts ?? [],
        subject,
        request,
        isByArea: WeatherReportProduct.isByArea(kind),
      })

      return List(
        Card({ key: 'about' },
          Prose(WeatherReportProduct.description(kind)),
          // Storm reports and rainfall are asked for by state, so the state is chosen here
          // rather than on a screen above this one — and it is this page's state.
          WeatherReportProduct.isByState(kind)
            ? Row({
              title: t('weather.reports.stateRow', page?.reportState != null
                ? WeatherReferenceNames.stateName(page.reportState)
                : t('weather.reports.noState')),
              onclick: () => app.nav.push(WeatherStatePickerScreen({ app, page })),
            })
            : null,
          h('div', { class: 'ask-block' },
            // A hole in the reply on screen, and a way to fill it: the bot keeps the bytes of its
            // last eight answers for ten minutes (spec §12, revision 10), so a chunk the air ate
            // costs one packet instead of the whole report. Above the ordinary ask because it is
            // the cheaper of the two and answers the same question.
            PartsOffer({ app, page, assembly: choice?.item?.assembly ?? null }),
            request != null
              ? AskButton({ app, page, title: t('weather.request.askLatest'), request, showsFootnotes: true })
              : Line(t('weather.reports.needsPlace')))),

        choice != null
          ? Card({
            label: header(choice),
            labelTrailing: t('weather.reports.received', words.time(choice.item.assembly.lastReceivedAt)),
            key: 'text',
          },
          NarrativeBody(choice.item.assembly),
          // Where the bot got the product, and whether it had to drop its tail (spec §2.2 and
          // §8, revision 7). Provenance, not a warning: a radio that has said neither leaves
          // the card exactly as it was.
          Line(words.reportFootnote(choice.item.assembly.source, choice.item.assembly.wasCut), { key: 'footnote' }))
          : Card({ key: 'empty' }, Line(t('weather.reports.nothingYet'))),

        PendingBar({
          app,
          requestsOnScreen: [request, partsOffer({ app, assembly: choice?.item?.assembly ?? null })].filter(Boolean),
        }),
      )
    },
  })
}

/** The `>part` request for this reply's holes, or null when there is nothing to offer. */
function partsOffer({ app, assembly }) {
  if (assembly == null) return null
  return app.model?.textPartsOffer?.({ assembly }) ?? null
}

/**
 * "Ask for the missing part", and what it costs, for a reply with a hole in it.
 *
 * The cost above the button, as the alert map states it: it is what the tap is about to spend.
 * Offered, never automatic, and only inside the bot's ten-minute cache window — past that the
 * ordinary ask below it is the only offer there is (`WeatherPartsOffer`).
 *
 * An array rather than a wrapper, so it sits inside the caller's own `ask-block` with the
 * ordinary ask and the two read as one column of choices.
 */
function PartsOffer({ app, page, assembly }) {
  const request = partsOffer({ app, assembly })
  if (request == null) return null
  const missing = request.indexes.length
  return [
    Line(missing === 1 ? t('weather.areaMap.packetsOne') : t('weather.areaMap.packets', missing)),
    AskButton({
      app,
      page,
      key: 'parts',
      title: missing === 1 ? t('weather.reports.askPartsOne') : t('weather.reports.askParts', missing),
      request,
    }),
  ]
}

/** The state storm reports and rainfall ask for on one page, for this visit. */
export function WeatherStatePickerScreen({ app, page }) {
  return safeScreen({
    id: 'report-state',
    title: () => t('weather.reports.stateTitle'),
    render() {
      // A leading unlabelled Swift parameter stays positional (docs/PORTING.md §4): the codes
      // themselves, not `{ from: … }`, which threw and left the picker showing one quiet line.
      const codes = WeatherReferenceNames.requestableStates(app.tables?.states ?? [])
      return List(Card({ key: 'states' }, codes.map((code) => Row({
        key: code,
        title: WeatherReferenceNames.stateName(code),
        chevron: false,
        trailing: page?.reportState === code
          ? h('span', { class: 'row__check' }, icon('checkmark.circle.fill', { size: 20, label: t('weather.common.selected') }))
          : null,
        onclick: () => {
          app.model?.setReportState?.(code, { forPageID: page.pageID })
          app.nav.pop()
        },
      }))))
    },
  })
}
