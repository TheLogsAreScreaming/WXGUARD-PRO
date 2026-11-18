// Port of MC1/Views/Tools/Weather/WeatherAreaMapView.swift.
//
// The alert map (docs/MESHWX_UI.md §17): every area the radio says is under an alert, shaded by
// event. Revision 10 dropped "National" from its name, because a map is no longer necessarily of
// the country:
//
//   *"Can we go from national alert map to just alert map, and have a way for the user to select
//   which areas they want to request the warnings for. One, a few, or all. That way we don't
//   default to sending everything."* (owner, 20 September 2026)
//
// **This screen never asks for anything on its own.** No request on appear, none on a pull, none
// on a timer — one sweep is up to eight packets broadcast to everyone on `#meshwx`, and a screen
// that fetched one because it was opened would spend the whole channel's airtime on a swipe. The
// only thing that sends is a tap on a button, and the button says what the tap costs before it is
// spent.
//
// What it shows is a **picture**, not a sweep: a phone can hold last hour's country and this
// minute's Texas at once and both are true, so `WeatherAlertMapPicture` resolves them into one
// map and one status line per part (`model.alertMapPicture`). Areas of states outside every held
// scope are simply not drawn — never implied clear, which is what the "not asked for" line under
// a scoped map is there to say.
import { h } from '../kit/dom.js'
import { Card, List, Row } from '../kit/components.js'
import { t } from '../../l10n.js'
import { MeshWXAreaSweep, MeshWXWarningIdentity } from '../../meshwx/index.js'
import { WeatherAlertMapPicture, WeatherAreaSelection } from '../../screen/index.js'
import { WeatherReferenceNames } from '../../app/index.js'
import { WeatherRequest } from '../../weather/index.js'
import { copy, Line, Loading, safeScreen, Segmented } from './support.js'
import { AskButton, isAskable, PendingBar, PendingOverlay } from './WeatherAskControl.js'
import { AlertRow } from './WeatherAlertRow.js'
import {
  applyDrawing, isGeometryLoaded, MapCard, MapView, preloadGeometry, WeatherAreaMapDrawing,
} from './WeatherAlertMap.js'
import { WeatherAlertDetailScreen } from './WeatherAlertDetailView.js'
import { WeatherAreaPickerScreen } from './WeatherAreaPickerView.js'

// MARK: - Level

/**
 * How much of the weather the next map should carry (spec §12). *What* it covers is the area
 * selection; this is only how far down the severity list the bot should go.
 *
 * Not what a held part covers — a part says that itself (`Part.includesAdvisories`), and the two
 * can differ: a radio may answer the wider request with the narrower sweep.
 */
export const WeatherAreaMapScope = Object.freeze({
  /** The default. Warnings and watches only — what people open a map during a storm to see. */
  warningsAndWatches: 'warningsAndWatches',
  /** The wider one, and the more expensive: advisories as well. */
  alsoAdvisories: 'alsoAdvisories',

  allCases: Object.freeze(['warningsAndWatches', 'alsoAdvisories']),

  includesAdvisories(scope) {
    return scope === 'alsoAdvisories'
  },

  title(scope) {
    return WeatherAreaMapScope.includesAdvisories(scope)
      ? t('weather.areaMap.scopeAll')
      : t('weather.areaMap.scopeWarnings')
  },
})

// MARK: - Copy

/** The sentences the alert map is built from, as pure functions of the picture. */
export const WeatherAreaMapCopy = Object.freeze({
  /**
   * "Texas and Oklahoma", "6 states" — state codes as their names, joined the one way the app
   * joins them (`WeatherReferenceNames.stateList`), in the order they are given.
   */
  stateNames(codes) {
    return WeatherReferenceNames.stateList(codes)
  },

  /**
   * What one status line is about.
   *
   * A national part is "the whole country" until something scoped and newer takes states off it,
   * and then it is honestly "the rest of the country". A scoped part is named by the states it
   * **asked for**, not by the ones it kept: a part every one of whose states a newer sweep now
   * covers is still the part that asked for them, and `partReplaced` under it says what happened.
   */
  partName(part, { picture, states = [] }) {
    if (!part.isScoped) {
      const replaced = picture.parts.some((one) => one.isScoped && one.stateCodes.length > 0)
      return replaced
        ? t('weather.areaMap.restOfCountry')
        : t('weather.areaMap.wholeCountry')
    }
    const codes = WeatherAreaMapCopy.scopeCodes(part, { states })
    // Scoped, and the packet carrying the scope never arrived. Its entries are real and are
    // drawn; which states it was asked for is not in what came (spec §12.3).
    if (codes == null || codes.length === 0) return t('weather.areaMap.partStatesUnknown')
    return WeatherAreaMapCopy.stateNames(codes)
  },

  /** The state codes a scoped part names, or null when its scope has not arrived. */
  scopeCodes(part, { states = [] } = {}) {
    if (part.scope == null) return null
    return part.scope.map((index) => states[index]).filter((code) => code != null).sort()
  },

  /**
   * Every state a newer part has taken off this one: it asked for them and no longer speaks for
   * any of them.
   */
  isReplaced(part) {
    return part.isScoped && (part.scope ?? []).length > 0 && part.stateCodes.length === 0
  },

  /** "Texas, Oklahoma · as of 13:40 · 2 min old". */
  partLine(part, { picture, states = [], words }) {
    return [
      WeatherAreaMapCopy.partName(part, { picture, states }),
      t('weather.areaMap.partAsOf', words.time(part.builtAt)),
      words.age(part.builtAt),
    ].filter(Boolean).join(' · ')
  },

  /** What a part carries: warnings and watches, or also advisories. Read off the part itself. */
  scopeHeld(part) {
    return part.includesAdvisories ? t('weather.areaMap.heldAll') : t('weather.areaMap.heldWarnings')
  },

  /**
   * "Map as of 8:02 PM · 3 h old" for the newest part: the one line the alerts list's map row
   * has room for. The build time is the radio's own (spec §12), never when this phone happened
   * to hear the packets.
   */
  pictureLine(picture, words) {
    const part = picture.parts[0] ?? null
    if (part == null) return t('weather.areaMap.never')
    return `${t('weather.areaMap.asOf', words.time(part.builtAt))} · ${words.age(part.builtAt)}`
  },

  /**
   * How many areas are under an alert — or, for a map of the whole country that found none, that
   * the country is clear.
   *
   * **The clear sentence needs the whole country, whole.** A picture with a state nobody asked
   * about, a cut part or a missing packet says nothing about the areas it does not name, so it
   * says only what it counted, and the lines above it are what the reader is left with.
   */
  areaCount(drawing, { picture, source, words }) {
    if (!(drawing.areaCount > 0)) {
      if (!WeatherAreaMapCopy.speaksForTheCountry(picture)) return null
      return t('weather.areaMap.clear', words.sentenceStart(source))
    }
    return drawing.areaCount === 1
      ? t('weather.areaMap.areasOne')
      : t('weather.areaMap.areas', drawing.areaCount)
  },

  /** Whether every state in the country is accounted for by a part that arrived whole. */
  speaksForTheCountry(picture) {
    if (!picture.coversWholeCountry) return false
    return picture.parts.every((part) => !part.wasCut && part.missingIndexes.length === 0)
  },

  /** Areas the picture named that this bundle has no outline for. Said rather than swallowed. */
  undrawn(drawing) {
    if (drawing.undrawnCount === 0) return null
    return drawing.undrawnCount === 1
      ? t('weather.areaMap.noOutlineOne')
      : t('weather.areaMap.noOutline', drawing.undrawnCount)
  },

  /**
   * "About 4 packets on the shared channel."
   *
   * One state is often one packet, which revision 9 never had to say: its only map was the whole
   * country and the figure was never below four.
   */
  cost(packets) {
    return packets === 1 ? t('weather.areaMap.costOne') : t('weather.areaMap.cost', packets)
  },

  /** "3 packets" — what a `>part` tap spends, beside its button. */
  packets(count) {
    return count === 1 ? t('weather.areaMap.packetsOne') : t('weather.areaMap.packets', count)
  },

  /** What the ask button says: the selection, by name, before the tap. */
  askTitle(selection) {
    if (WeatherAreaSelection.asksWholeCountry(selection)) return t('weather.areaMap.askWholeCountry')
    return t('weather.areaMap.askStates', WeatherAreaMapCopy.stateNames(selection.states))
  },

  /**
   * The same selection as the value of the "Areas to ask for" row: the choice, never what the
   * request will be turned into. Somebody who picked twenty states sees twenty states, and the
   * orange line under the picker says what that will actually send.
   */
  selectionValue(selection) {
    if (selection.isWholeCountry || selection.states.length === 0) {
      return t('weather.areaMap.pickerWholeCountry')
    }
    return WeatherAreaMapCopy.stateNames(selection.states)
  },
})

// MARK: - What the map is showing, as a list (§3.1 U-32)

export const WeatherAreaMapList = Object.freeze({
  /**
   * The picture's entries collapsed to one row per event code. An area under two alerts belongs
   * to the first that named it, which is the more severe: entries arrive in severity order and
   * the map shades them the same way.
   */
  groups(entries, { tables }) {
    const order = []
    const codesByEvent = new Map()
    const partByCode = new Map()
    const taken = new Set()
    for (const entry of entries ?? []) {
      for (const code of MeshWXAreaSweep.Entry.ugcCodes(entry, { states: tables.states })) {
        if (taken.has(code)) continue
        taken.add(code)
        partByCode.set(code, entry.part ?? 0)
        if (!codesByEvent.has(entry.event)) {
          codesByEvent.set(entry.event, [])
          order.push(entry.event)
        }
        codesByEvent.get(entry.event).push(code)
      }
    }
    return order.map((event) => ({
      event,
      name: tables.eventLabel({ for: event }),
      codes: codesByEvent.get(event) ?? [],
      partOf: (code) => partByCode.get(code) ?? 0,
    }))
  },

  /**
   * "Travis County, TX" for a county, the zone's own name for a zone, and the bare code for an
   * area this phone's tables do not carry — which is never nothing, because the code is what the
   * radio would be asked about.
   */
  areaName(ugc, { tables }) {
    const county = tables?.county?.(ugc)
    if (county != null) return t('weather.areaMap.areaIn', t('weather.area.county', county.name), county.state)
    const zone = tables?.zone?.(ugc)
    if (zone != null) return t('weather.areaMap.areaIn', zone.name, zone.state)
    return ugc
  },
})

// MARK: - The drawing, built once per picture

/**
 * One picture can name hundreds of areas, so the shading is built once per picture and shared by
 * the card, the full map and the screens under them — never per render.
 */
let cached = { print: null, drawing: WeatherAreaMapDrawing.empty }

/**
 * What would change the picture, and nothing that would not. Never the clock: an unchanged set of
 * sweeps is not re-shaded every 30 seconds, and re-shading a country is not cheap.
 *
 * Never the picture object itself: a screen snapshot holds the whole tables object, so nothing
 * here may deep-compare or serialise one (docs/UI_KIT.md).
 */
function picturePrint(app, page, picture) {
  const parts = picture.parts
    .map((part) => `${part.group}.${part.builtAt}.${part.receivedPackets}/${part.totalPackets}.${part.stateCodes.join('')}`)
    .join(',')
  return [
    page?.snapshot?.source?.botID ?? '',
    parts,
    picture.entries.length,
    isGeometryLoaded(app),
  ].join('|')
}

function pictureDrawing(app, page, picture) {
  const print = picturePrint(app, page, picture)
  if (cached.print === print) return cached.drawing
  const drawing = picture.entries.length === 0 && picture.parts.length === 0
    ? WeatherAreaMapDrawing.empty
    : WeatherAreaMapDrawing.make({
      entries: picture.entries,
      tables: app.tables,
      geometry: app.geometry,
    })
  cached = { print, drawing }
  return drawing
}

/** Load the outlines once, then redraw. Nothing here goes on the air. */
function ensureOutlines(app) {
  if (isGeometryLoaded(app)) return
  preloadGeometry(app).then(() => app.nav.refresh())
}

/** The picture for **this page**, never for the model's current page (§3.1 P-1). */
export function pictureOf(app, page) {
  const pageID = page?.pageID ?? null
  if (pageID == null) return WeatherAlertMapPicture.empty
  return app.model?.alertMapPicture?.({ pageID }) ?? WeatherAlertMapPicture.empty
}

// MARK: - The screen

export function WeatherAreaMapScreen({ app, page }) {
  const state = { map: null, drawn: null, app }
  let level = WeatherAreaMapScope.warningsAndWatches

  return safeScreen({
    id: 'area-map',
    title: () => t('weather.areaMap.title'),
    onAppear() { ensureOutlines(app) },
    render() {
      const words = copy(app, page)
      const model = app.model
      const pageID = page?.pageID ?? null
      const picture = pictureOf(app, page)
      const includesAdvisories = WeatherAreaMapScope.includesAdvisories(level)
      const selection = model?.areaSelection?.({ pageID }) ?? WeatherAreaSelection.wholeCountry
      const request = model?.areaSweepRequest?.({ pageID, includesAdvisories })
        ?? WeatherRequest.areaSweep({ includesAdvisories })
      const status = model?.status?.({ for: request }) ?? null
      const askable = isAskable(status)
      const drawing = pictureDrawing(app, page, picture)
      const loading = picture.parts.length > 0 && !isGeometryLoaded(app)
      const offers = model?.sweepPartsOffers?.({ pageID }) ?? {}
      applyDrawing(state, drawing, picturePrint(app, page, picture))

      const groups = WeatherAreaMapList.groups(picture.entries, { tables: app.tables })
      // Every state any part is the newest word on, for "This map covers Texas, Oklahoma."
      const covered = [...new Set(picture.parts.flatMap((part) => part.stateCodes))].sort()

      return List(
        picture.parts.length > 0
          ? MapCard({
            app,
            state,
            label: t('weather.areaMap.mapLabel'),
            onOpen: () => app.nav.push(WeatherAreaFullMapScreen({ app, page })),
          })
          : null,

        // One block per part, newest first, each answering for itself: when it was built, what
        // level it carries, whether it was cut, and what of it never arrived (§17).
        Card({ key: 'status' },
          picture.parts.length === 0
            ? h('div', { class: 'status-line' }, h('p', { class: 'line' }, t('weather.areaMap.empty')))
            : [
              picture.parts.map((part, index) => PartBlock({
                app,
                page,
                part,
                picture,
                words,
                states: app.tables?.states ?? [],
                offer: offers[String(part.group)] ?? null,
                index,
              })),
              h('div', { class: 'status-line part-summary' },
                Line(WeatherAreaMapCopy.areaCount(drawing, { picture, source: page?.sourceName ?? '', words })),
                Line(WeatherAreaMapCopy.undrawn(drawing)),
                // With nothing national held, an unshaded state outside the scope is unknown and
                // never clear — which is the whole claim this card may make (§17).
                !picture.coversWholeCountry && covered.length > 0
                  ? Line(t('weather.areaMap.covers', WeatherAreaMapCopy.stateNames(covered)))
                  : null,
                !picture.coversWholeCountry ? Line(t('weather.areaMap.notAsked'), { warn: true }) : null,
                loading ? Loading(t('web.radio.map.loading')) : null),
            ]),

        // What the shading says, as a list. The map answers "where"; a reader who wants "what"
        // was reading colours off a legend and counting shapes (§3.1 U-32).
        groups.length > 0
          ? Card({ label: t('weather.areaMap.list'), labelTrailing: String(groups.length), key: 'list' },
            groups.map((group) => Row({
              key: String(group.event),
              icon: words.symbol(group.event, app.tables),
              title: group.name,
              value: String(group.codes.length),
              onclick: () => app.nav.push(WeatherAreaListScreen({ app, page, group })),
            })))
          : null,

        drawing.legend.length > 0
          ? Card({ label: t('weather.areaMap.legend'), key: 'legend' },
            h('div', { class: 'legend' }, drawing.legend.map((item) => h('span', {
              class: 'legend__item',
              key: String(item.event),
              style: `--tint: var(--tint-${item.tint})`,
            }, h('span', { class: 'legend__swatch' }), h('span', null, words.eventName(item.event, app.tables))))))
          : null,

        Card({ key: 'ask' },
          // Which areas the next tap asks about, kept on the device between visits: the screen
          // is answering "which part of the country am I looking at", and that outlives a visit.
          Row({
            title: t('weather.areaMap.areasToAsk'),
            value: WeatherAreaMapCopy.selectionValue(selection),
            onclick: () => app.nav.push(WeatherAreaPickerScreen({ app, page })),
          }),
          h('div', { class: 'ask-block' },
            Segmented({
              label: t('weather.areaMap.scope'),
              value: level,
              options: WeatherAreaMapScope.allCases.map((one) => ({ value: one, label: WeatherAreaMapScope.title(one) })),
              onchange: (next) => { level = next; app.nav.refresh() },
            }),
            // Said before the tap, never after it: past fifteen codes the request does not fit
            // and the button asks for the country, which is a different map and a different bill.
            !selection.isWholeCountry && WeatherAreaSelection.asksWholeCountry(selection)
              ? Line(t('weather.areaMap.tooManyStates', WeatherAreaSelection.maxStates), { warn: true })
              : null,
            // The cost above the button, not under it: it is what the tap is about to spend, and
            // a reader who has already tapped, or who cannot tap at all, does not need telling.
            askable
              ? Line(WeatherAreaMapCopy.cost(model?.areaSweepCost?.({ pageID, includesAdvisories }) ?? 0))
              : null,
            // No tap hint under the ask: there is no shaded area here to tap. It lives on the map
            // itself, the one place a tap does something (docs/MESHWX_UI.md §3.1 U-54).
            AskButton({ app, page, title: WeatherAreaMapCopy.askTitle(selection), request, showsFootnotes: true }))),

        Card({ key: 'source' },
          h('div', { class: 'status-line' },
            h('p', { class: 'line line--quiet' },
              page?.snapshot?.source == null
                ? t('weather.alerts.sourceGeneric')
                : t('weather.alerts.source', page?.sourceName ?? '')))),

        PendingBar({ app, requestsOnScreen: [request, ...Object.values(offers)] }),
      )
    },
  })
}

/**
 * One part of the picture, as a status block: what it is the newest word on, when the radio built
 * it, what level it carries, and — the owner's first ask of revision 10 — a way to re-request
 * what never arrived.
 *
 * *"'4 of 7 parts arrived': should allow me to re-request the missing data."* The button appears
 * only while `WeatherPartsOffer` says the bytes are still in the bot's cache and its own resend
 * has had its chance; past that the whole-map ask below is the only offer there is.
 */
function PartBlock({ app, page, part, picture, words, states, offer, index }) {
  const missing = part.missingIndexes.length
  return h('div', { class: 'status-line part', key: `part-${part.group}-${index}` },
    h('p', { class: 'part__name' }, WeatherAreaMapCopy.partLine(part, { picture, states, words })),
    Line(WeatherAreaMapCopy.scopeHeld(part)),
    // Both are honesty about what is *not* on the map, so both are orange rather than grey: a gap
    // in a cut or partial sweep is not calm weather.
    part.wasCut ? Line(t('weather.areaMap.cut'), { warn: true }) : null,
    missing > 0
      ? Line(t('weather.areaMap.partsArrived', part.receivedPackets, part.totalPackets), { warn: true })
      : null,
    WeatherAreaMapCopy.isReplaced(part) ? Line(t('weather.areaMap.partReplaced')) : null,
    offer != null
      ? h('div', { class: 'ask-block' },
        Line(WeatherAreaMapCopy.packets(missing)),
        AskButton({
          app,
          page,
          title: missing === 1 ? t('weather.areaMap.askPartsOne') : t('weather.areaMap.askParts', missing),
          request: offer,
        }))
      : null)
}

// MARK: - The interactive map

/**
 * The full map, where a tap on a shaded area opens what the phone knows about it.
 *
 * A tap on empty land opens nothing rather than guessing at a county, and the screen it opens
 * costs no airtime: the picture already says which kind of alert covers the area. Only the button
 * on that screen spends anything, and only on a tap (§3.1 U-34).
 */
export function WeatherAreaFullMapScreen({ app, page }) {
  const state = { map: null, drawn: null, app }

  const tapped = ({ shapes }) => {
    const hit = shapes?.[0]?.data ?? null
    if (hit == null) return
    // A tap while anything else is on the air does nothing (§17.3): the pending bar is already
    // speaking, and a second screen would bury it.
    if (app.model?.activeRequest != null) return
    state.map?.setSelected(hit.ugc)
    app.nav.push(WeatherAreaDetailScreen({ app, page, area: hit }))
  }

  return safeScreen({
    id: 'area-map-full',
    fullBleed: true,
    title: () => t('weather.areaMap.title'),
    onAppear() { ensureOutlines(app) },
    render() {
      const picture = pictureOf(app, page)
      const drawing = pictureDrawing(app, page, picture)
      applyDrawing(state, drawing, picturePrint(app, page, picture))
      // The hint stands down while a request is on the air or while everything is blocked, so
      // the page never tells someone to tap while nothing would go out (§3.1 U-24).
      const showsHint = app.model?.activeRequest == null && (page?.snapshot?.requestBlock ?? null) == null
      return h('div', { class: 'map-screen' },
        MapView({ app, state, key: 'map', interactive: true, ariaLabel: t('weather.areaMap.mapLabel'), onTap: tapped }),
        showsHint
          ? h('div', { class: 'map__overlay map__overlay--top', key: 'hint' },
            h('div', { class: 'map__chip' }, t('weather.areaMap.tapHint', page?.sourceName ?? '')))
          : null,
        PendingOverlay({ app, requestsOnScreen: [] }))
    },
  })
}

// MARK: - Every area under one kind of alert

/**
 * A tap opens what the phone knows about the area, the same screen a tap on the map opens.
 */
export function WeatherAreaListScreen({ app, page, group }) {
  return safeScreen({
    id: 'area-list',
    title: () => group.name,
    render() {
      return List(
        Card({ key: 'areas' },
          group.codes.map((code) => Row({
            key: code,
            title: WeatherAreaMapList.areaName(code, { tables: app.tables }),
            value: h('span', { class: 'mono' }, code),
            onclick: () => app.nav.push(WeatherAreaDetailScreen({
              app, page, area: { ugc: code, event: group.event, part: group.partOf?.(code) ?? 0 },
            })),
          }))),
        // No tap hint in the footer: a list has no shaded area to tap (§3.1 U-54).
        PendingBar({ app, requestsOnScreen: [] }),
      )
    },
  })
}

// MARK: - One area, and what is known about it (§3.1 U-34, §17.3)

/**
 * What the phone knows about one area, and the one request that would learn more.
 *
 * **One card.** Revision 9 split it into "On the map" and "What this phone holds", which the
 * owner read as two answers to one question: *"This 'on the map' vs 'what the phone holds' is
 * weird."* So the alerts this phone holds for the area are ordinary alert rows, and the map's own
 * event appears as a row only when it is **not** one of them — because then, and only then, the
 * map is saying something the rows are not.
 *
 * Only the button spends airtime — one packet, not a sweep — and only on a tap.
 */
export function WeatherAreaDetailScreen({ app, page, area }) {
  const request = WeatherRequest.warningsTouching({ ugc: area.ugc })

  /** Every alert this phone holds whose own area list names this area. */
  const held = () => (page?.snapshot?.alerts ?? []).filter((item) => (app.tables?.namedAreas?.({ for: item.warning }) ?? [])
    .some((named) => String(named.ugc).toUpperCase() === String(area.ugc).toUpperCase()))

  return safeScreen({
    id: 'area-detail',
    title: () => WeatherAreaMapList.areaName(area.ugc, { tables: app.tables }),
    render() {
      const words = copy(app, page)
      const alerts = held()
      const picture = pictureOf(app, page)
      // The part the shading came from says when the map was built; with no part index (an older
      // push, a list row from a picture that has since moved on) the newest part stands in.
      const part = picture.parts[area.part ?? 0] ?? picture.parts[0] ?? null
      const isHeld = area.event != null && alerts.some((item) => item.warning?.event === area.event)
      const onMapOnly = area.event != null && !isHeld

      return List(
        Card({
          label: WeatherAreaMapList.areaName(area.ugc, { tables: app.tables }),
          labelTrailing: h('span', { class: 'mono' }, area.ugc),
          key: 'area',
        },
        alerts.map((item) => AlertRow({
          app,
          page,
          item,
          key: MeshWXWarningIdentity.key(item.identity),
          onclick: () => app.nav.push(WeatherAlertDetailScreen({ app, page, identity: item.identity })),
        })),
        // The map's event, and only when no row above it already says so. "Details not received"
        // is the whole of what the sweep carries: a run of areas and an event byte.
        onMapOnly
          ? Row({
            key: 'on-map',
            icon: words.symbol(area.event, app.tables),
            title: words.eventName(area.event, app.tables),
            subtitle: part == null
              ? null
              : t('weather.areaMap.onMapAsOf', words.time(part.builtAt)),
            chevron: false,
          })
          : null),

        Card({ key: 'ask', foot: t('weather.areaMap.askAreaFootnote', page?.sourceName ?? '') },
          h('div', { class: 'ask-block' },
            AskButton({
              app,
              page,
              title: alerts.length === 0 ? t('weather.areaMap.askArea') : t('weather.areaMap.askAreaAgain'),
              request,
              showsFootnotes: true,
            }))),

        PendingBar({ app, requestsOnScreen: [request] }),
      )
    },
  })
}
