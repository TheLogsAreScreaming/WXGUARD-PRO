// Port of MC1/Views/Tools/Weather/WeatherAlertDetailView.swift.
//
// One alert in full (docs/MESHWX_UI.md §12): the ground it covers, whether that includes the
// place, when it ends, who issued it, its narrative on request, its tags and areas.
//
// Read from the page's build **by identity** rather than held as a value, so an update or a
// cancel that arrives while the screen is open shows here.
import { h } from '../kit/dom.js'
import { Card, Empty, List, Row } from '../kit/components.js'
import { icon } from '../kit/icons.js'
import { t } from '../../l10n.js'
import { MeshWXWarning, MeshWXWarningIdentity } from '../../meshwx/index.js'
import { WeatherAlertRequests, WeatherAlertItem } from '../../screen/index.js'
import { WeatherRequest } from '../../weather/index.js'
import { WeatherReferenceNames } from '../../app/index.js'
import { copy, Headline, Line, safeScreen } from './support.js'
import { AskButton, PendingBar } from './WeatherAskControl.js'
import {
  alertsPrint, drawWhenChanged, isGeometryLoaded, MapCard, preloadGeometry, WeatherAlertFullMapScreen,
  WeatherMapDrawing,
} from './WeatherAlertMap.js'
import { NarrativeBody } from './WeatherReportsView.js'

export function WeatherAlertDetailScreen({ app, page, identity }) {
  const state = { map: null, drawn: null, app }
  const key = MeshWXWarningIdentity.key(identity)
  const itemOf = () => (page?.snapshot?.alerts ?? []).find((one) => MeshWXWarningIdentity.key(one.identity) === key) ?? null
  const identityString = WeatherAlertRequests.identityString(identity, { tables: app.tables })
  const textRequest = identityString == null ? null : WeatherRequest.warningText({ identity: identityString })

  /** The narrative, only when it answered this phone's request for this identity. */
  const narrative = () => {
    if (textRequest == null) return null
    const wire = WeatherRequest.wireText(textRequest)
    return (page?.snapshot?.texts ?? []).find((item) => {
      const request = item.assembly?.request ?? null
      return request != null && WeatherRequest.wireText(request) === wire
    }) ?? null
  }

  /**
   * "issued 1:29 PM" when the wire carried the issue time, "received 1:28 AM" when it did not.
   * The two are different claims: one is when the Weather Service said it, the other is when
   * this radio happened to be in range — and only the first is the warning's own age.
   */
  const timeLine = (item, words) => {
    const issuedAt = page?.context?.warningIssuedAt?.[key] ?? null
    // A saturated field is a ceiling, not a time (spec §3): receipt is the honest one.
    if (issuedAt != null && !MeshWXWarning.isIssueTimeSaturated(item.warning)) {
      return t('weather.alertDetail.issued', words.time(issuedAt))
    }
    return t('weather.alertDetail.received', words.time(item.receivedAt))
  }

  return safeScreen({
    id: 'alert-detail',
    title: () => copy(app, page).eventName(identity.event, app.tables),
    onAppear() {
      // The outlines are what turns a zone-coded warning from a pin into a shape; the iOS screen
      // parses them here too. Nothing on this screen goes on the air.
      if (!isGeometryLoaded(app)) preloadGeometry(app).then(() => app.nav.refresh())
    },
    render() {
      const words = copy(app, page)
      const item = itemOf()
      if (item == null) {
        return List(Empty(icon('tray.full', { size: 28 }), h('p', null, t('weather.alertDetail.gone'))))
      }

      const tables = app.tables
      const tint = words.tint(item.warning.event, tables)
      const areas = words.uniqueAreas(tables?.namedAreas?.({ for: item.warning }) ?? [])
      const tags = words.tagTexts(item.warning)
      const placement = item.placement?.kind ?? null
      // An alert here or near the place is framed with it; one elsewhere frames itself.
      const framesPlace = placement === 'here' || placement === 'near'
      const source = page?.context?.warningSource?.[key] ?? 0
      const office = tables?.officeCode?.(item.warning.office) ?? null
      const held = narrative()

      drawWhenChanged(state, alertsPrint(app, [item], page?.snapshot?.place ?? null, framesPlace), () => WeatherMapDrawing.make({
        warnings: [item.warning],
        place: page?.snapshot?.place ?? null,
        framesPlace,
        tables,
        geometry: app.geometry,
      }))

      return List(
        MapCard({
          app,
          state,
          label: t('weather.alertsList.openMap'),
          onOpen: () => app.nav.push(WeatherAlertFullMapScreen({
            app,
            page,
            title: words.eventName(item.warning.event, tables),
            items: () => [itemOf()].filter(Boolean),
            framesPlace,
          })),
        }),

        Card({ key: 'head' },
          h('div', { class: 'detail-head' },
            Headline({ symbol: words.symbol(item.warning.event, tables), tint, title: words.eventName(item.warning.event, tables) }),
            page?.placeName != null
              ? h('p', { class: 'detail-head__covers' }, words.coversLine(item.placement, page.placeName))
              : null,
            // "from Wed 19:00 until Fri 19:00" for a watch not yet in effect (spec §18.2,
            // revision 12); the countdown only for what is in effect and ends soon.
            item.kind?.kind === 'active'
              ? h('p', null, words.alertWindow({
                beginsAt: item.beginsAt ?? null,
                expiresAt: WeatherAlertItem.expiresAt(item),
              }))
              : Line(words.alertQualifier(item, null), { warn: true }),
            // Since revision 5 the wire carries when NWS issued the warning, and that is the
            // time worth showing: a radio out of range for three hours still says *issued
            // 1:29 PM*. Receipt is the fallback (spec §3).
            Line(timeLine(item, words)),
            office != null ? Line(t('weather.alertDetail.issuedBy', WeatherReferenceNames.officeName(office))) : null,
            // How the radio came by this warning (spec §2.2, revision 7): the last of the quiet
            // lines, and absent entirely when the radio did not say.
            Line(words.dataSource(source)))),

        textRequest != null
          ? Card({ label: t('weather.alertDetail.fullText'), key: 'text' },
            h('div', { class: 'ask-block' },
              AskButton({ app, page, title: t('weather.request.askFullText'), request: textRequest, showsFootnotes: true })),
            held != null ? NarrativeBody(held.assembly) : null)
          : null,

        tags.length > 0
          ? Card({ label: t('weather.alertDetail.details'), key: 'tags' },
            h('div', { class: 'tag-list' }, tags.map((tag) => h('span', { class: 'tag', key: tag }, tag))))
          : null,

        areas.length > 0
          ? Card({ label: t('weather.alertDetail.areas'), key: 'areas' },
            areas.map((area) => Row({
              key: area.ugc,
              title: words.areaName(area),
              value: area.isCounty ? t('weather.alertDetail.county') : t('weather.alertDetail.zone'),
            })))
          : null,

        PendingBar({ app, requestsOnScreen: textRequest == null ? [] : [textRequest] }),
      )
    },
  })
}
