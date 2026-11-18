// Port of MC1/Views/Tools/Weather/WeatherAlertRow.swift.
//
// One alert: colour bar, icon, event, when it ends, one line of tags, and — on the alerts list —
// where it is. The card these rows used to sit in is gone (docs/MESHWX_UI.md §7): on a place page
// one alert covering the place is a strip of fixed height, and every other row lives here.
import { h } from '../kit/dom.js'
import { icon } from '../kit/icons.js'
import { t } from '../../l10n.js'
import { WeatherAlertItem } from '../../screen/index.js'
import { copy } from './support.js'
import { AskButton } from './WeatherAskControl.js'

/**
 * `AlertRow({ app, page, item, location, onclick, key })`.
 *
 * `location` is "Llano County · 105 km W", for rows away from the place; the list passes it only
 * for the sections that are not about where you are.
 */
export function AlertRow({ app, page, item, location = null, onclick = null, key = null }) {
  const tables = app.tables
  const words = copy(app, page)
  const event = item.warning.event
  const tint = words.tint(event, tables)
  const qualifier = words.alertQualifier(item, page?.placeName ?? null)
  const tags = words.tagLine(item.warning)
  const isActive = item.kind?.kind === 'active'
  // When it applies (spec §18.2, revision 12): a watch that has not begun says so rather than
  // counting down to an expiry two days out.
  const until = isActive
    ? words.alertWindow({ beginsAt: item.beginsAt ?? null, expiresAt: WeatherAlertItem.expiresAt(item) })
    : null

  const children = [
    h('span', { class: 'alert-row__swatch' }),
    h('span', { class: 'row__icon' }, icon(words.symbol(event, tables), { size: 22 })),
    h('span', { class: 'row__main' },
      h('span', { class: 'row__title alert-row__name' }, words.eventName(event, tables)),
      until ? h('span', { class: 'row__subtitle' }, until) : null,
      qualifier ? h('span', { class: ['row__subtitle', !isActive && 'line--warn'] }, qualifier) : null,
      location ? h('span', { class: 'row__subtitle' }, location) : null,
      tags ? h('span', { class: 'row__subtitle alert-row__tags' }, tags) : null),
    onclick ? h('span', { class: 'row__chevron' }, icon('chevron.right', { size: 16 })) : null,
  ]
  const classes = ['row', 'alert-row', item.kind?.kind === 'expiredRecently' && 'alert-row--expired']
  const style = `--tint: var(--tint-${tint})`
  if (onclick) return h('button', { class: classes, type: 'button', style, key, onclick }, children)
  return h('div', { class: classes, style, key }, children)
}

/**
 * The §7.4 line, with its action and the alerts' source under it. It is on the alerts list, on
 * the radio page, and nowhere else: a place page says nothing about alerts on a quiet day.
 */
export function AlertStatusRow({ app, page, line, source, request, showsAskFootnotes }) {
  const action = line?.action ?? null
  return h('div', { class: 'status-line' },
    h('p', null, line.text),
    line.caption ? h('p', { class: 'line' }, line.caption) : null,
    action === 'askForAlerts' && request != null
      ? AskButton({
        app,
        page,
        title: copy(app, page).askAlertsTitle(request, app.tables),
        request,
        showsFootnotes: showsAskFootnotes,
      })
      : null,
    action === 'updateLocation'
      ? h('button', {
        class: 'button button--plain button--strong',
        type: 'button',
        onclick: () => app.model?.updateLocation?.(),
      }, h('span', null, t('weather.place.updateLocation')))
      : null,
    h('p', { class: 'line line--quiet' }, source))
}
