// Shared helpers for the radio side of the tool (the radio page, the alerts, the maps, the text
// reports, Cached and the alert notifications).
//
// Two jobs only:
//
// 1. **One place that calls the app layer's formatting.** Every `WeatherFormatting` and
//    `WeatherCopy` call that needs "now", the time zone and the locale goes through `copy()`, so
//    the eight screens do not each spell the argument list out and a correction to the port lands
//    in one file.
// 2. **A screen never throws.** `render()` runs on every model change; a screen that throws takes
//    the navigation down with it. `safeScreen` catches, says so in one quiet line, and leaves the
//    rest of the app standing.
import { h } from '../kit/dom.js'
import { Card, List, Note } from '../kit/components.js'
import { icon } from '../kit/icons.js'
import { t } from '../../l10n.js'
import { WeatherCopy, WeatherFormatting } from '../../app/index.js'

/**
 * The formatting and copy calls the radio screens make, bound to one page's clock.
 *
 * `page` is the `WeatherPageScreen` the screen was opened from — never "the model's current
 * page" (docs/MESHWX_UI.md §3.1 P-1, U-18). With no page yet the app's own clock stands in, so a
 * screen built a frame early still renders.
 */
export function copy(app, page = null) {
  const now = page?.now ?? app?.model?.now ?? Date.now()
  const timeZone = app?.timeZone
  const locale = app?.locale
  const when = { now, timeZone, locale }
  return {
    now,
    /** "4:02 PM", "yesterday 8:11 PM". */
    time: (date) => (date == null ? null : WeatherFormatting.clockTime(date, when)),
    /** "2 min ago". */
    ago: (date) => (date == null ? null : WeatherFormatting.ago(date, { now })),
    /** "3 h old". */
    age: (date) => (date == null ? null : WeatherFormatting.age(date, { now })),
    /** "40 min", from seconds. */
    duration: (seconds) => WeatherFormatting.duration({ seconds }),
    /**
     * "from Wed 7:00 PM until Fri 7:00 PM", "until 9:41 PM · 40 min left", "until Fri 7:00 PM"
     * (spec §18.2, revision 12). `beginsAt` is the alert's start (`WeatherAlertItem.beginsAt`), or null.
     */
    alertWindow: ({ beginsAt = null, expiresAt }) =>
      WeatherFormatting.alertWindow({ beginsAt, expiresAt, ...when }),
    eventName: (event, tables) => WeatherFormatting.eventName(event, { tables }),
    symbol: (event, tables) => WeatherFormatting.symbol({ for: event, tables }),
    tint: (event, tables) => WeatherFormatting.tint({ for: event, tables }),
    tagLine: (warning) => WeatherFormatting.tagLine({ for: warning, locale }),
    tagTexts: (warning) => WeatherFormatting.tagTexts({ for: warning, locale }),
    areaName: (area) => WeatherFormatting.areaName(area),
    uniqueAreas: (areas) => WeatherFormatting.uniqueAreas(areas),
    sentenceStart: (text) => WeatherFormatting.sentenceStart(text ?? ''),
    kilometres: (km) => WeatherFormatting.kilometres(km),
    quietDuration: (minutes) => WeatherFormatting.quietDuration({ minutes }),

    // WeatherCopy, in the same voice.
    alertStatus: (status, { source, place, areaName }) =>
      WeatherCopy.alertStatus(status, { source, place, areaName, ...when }),
    alertQualifier: (item, placeName) => WeatherCopy.alertQualifier(item, { placeName, now }),
    alertLocation: (warning, place, tables) => WeatherCopy.alertLocation(warning, { place, tables }),
    coversLine: (placement, placeName) => WeatherCopy.coversLine(placement, { placeName }),
    requestBlocked: (block, source) => WeatherCopy.requestBlocked(block, { source }),
    askAlertsTitle: (request, tables) => WeatherCopy.askAlertsTitle({ for: request, tables }),
    ownedReply: (source, at) => WeatherCopy.ownedReply({ source, at, ...when }),
    quietCaption: (source, since) => WeatherCopy.quietCaption({ source, since, ...when }),
    dataSource: (source) => WeatherCopy.dataSource(source),
    reportFootnote: (source, wasCut) => WeatherCopy.reportFootnote({ source, wasCut }),
    requestName: (request, tables) => WeatherCopy.requestName(request, { tables }),
    requestOutcome: (outcome) => WeatherCopy.requestOutcome(outcome ?? null),
    channelSubject: (subject, tables) => WeatherCopy.channelSubject(subject, { tables }),
    channelTimes: (contentAt, receivedAt) => WeatherCopy.channelTimes({ contentAt, receivedAt, ...when }),
    cacheGroup: (group) => WeatherCopy.cacheGroup(group),

    // Radar (docs/MESHWX_UI.md §18).
    /** "Picture from 6:38 PM · 12 min old", from the minute printed on the picture. */
    radarTime: (picture) => WeatherCopy.radarTime(picture, when),
    radarSummary: (summary, placeName) => WeatherCopy.radarSummary(summary, { placeName }),
    radarWidthName: (zoom) => WeatherCopy.radarWidthName(zoom),
    radarMosaic: (product, tables) => WeatherCopy.radarMosaic(product, { tables }),
    /** "6:08 PM · 2 of 5": one frame of a loop (revision 13). */
    radarFrameLine: (stored, index, count) => WeatherCopy.radarFrameLine(stored, { index, count, ...when }),
    radarLoopCost: (packets) => WeatherCopy.radarLoopCost(packets),
    stationLink: (inArea, total, source) => WeatherCopy.stationLink({ inArea, total, source }),
  }
}

/** Run `fn`, and hand back `fallback` rather than letting a screen's render throw. */
export function attempt(fn, fallback = null) {
  try {
    return fn()
  } catch (error) {
    report(error)
    return fallback
  }
}

let reported = 0

function report(error) {
  // Noisy once, quiet after: the model rebuilds every 30 seconds and a broken field would
  // otherwise flood the console until the tab is closed.
  if (reported > 20) return
  reported += 1
  if (typeof console !== 'undefined') console.error('[weather.radio]', error)
}

/**
 * The same screen, with `render`, `title` and `trailing` wrapped so a half-built model cannot
 * take the navigation down. A screen that fails says one line and stays on screen, which is what
 * the back button needs.
 */
export function safeScreen(screen) {
  return {
    ...screen,
    title: () => attempt(() => screen.title?.() ?? '', ''),
    trailing: screen.trailing ? () => attempt(() => screen.trailing(), null) : undefined,
    toolbar: screen.toolbar ? () => attempt(() => screen.toolbar(), null) : undefined,
    render: () => attempt(() => screen.render(), List(Card({}, Note(t('web.radio.error'))))),
  }
}

/**
 * A two-way (or more) picker in the shape iOS gives a segmented control: the Cached screen's
 * "By kind / Newest first", the map's "Warnings and watches / Also advisories".
 *
 * `options` is `[{ value, label }]`. Real radio buttons, so arrow keys and a screen reader work.
 */
export function Segmented({ label, options, value, onchange, key = null }) {
  return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label, key },
    options.map((option) => h('button', {
      class: ['segmented__option', option.value === value && 'is-selected'],
      type: 'button',
      role: 'radio',
      'aria-checked': option.value === value ? 'true' : 'false',
      key: String(option.value),
      onclick: () => { if (option.value !== value) onchange(option.value) },
    }, h('span', null, option.label))))
}

/** A quiet line in the footnote voice; `warn` paints it orange, for what is *not* on screen. */
export function Line(text, { warn = false, mono = false, key = null } = {}) {
  if (text == null) return null
  return h('p', { class: ['line', warn && 'line--warn', mono && 'mono'], key }, text)
}

/** A quiet "still working" line: the outlines being parsed, never a request on the air. */
export function Loading(text) {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', null, text))
}

/** An icon-led headline inside a card (the alert detail's own head). */
export function Headline({ symbol, tint, title }) {
  return h('div', { class: 'headline', style: tint ? `--tint: var(--tint-${tint})` : null },
    h('span', { class: 'headline__icon' }, icon(symbol, { size: 26 })),
    h('h2', { class: 'headline__title' }, title))
}
