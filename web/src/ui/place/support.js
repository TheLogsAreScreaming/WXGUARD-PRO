// The one module in `src/ui/place/` that is not a port of a Swift view.
//
// It holds two things the place screens all need and that would otherwise be copied into seven
// files: the bridge to `src/app/` (`WeatherCopy`, `WeatherFormatting`), which is being written at
// the same time as these screens, and the page-resolution rule of docs/MESHWX_UI.md §3.1 U-18 —
// a screen answers for the page it was opened from, read back by id while the model still holds
// that page's build.
//
// **The bridge.** Every sentence on these screens comes from `WeatherCopy` / `WeatherFormatting`,
// which live in `src/app/` (docs/PORTING.md §2) and may not exist when this file is loaded. A
// static import would then make every screen here unloadable, so the namespace is fetched with a
// dynamic import and each call goes through a wrapper that names the Swift function and the
// argument shape docs/PORTING.md §4 gives it. Until it lands the wrappers answer with a plain
// formatter or with null, and a line with nothing to say is left out rather than invented.

import { t } from '../../l10n.js'
import { WeatherEmptyPlace } from '../../screen/index.js'

// MARK: - The app layer

let app = null
let pending = null
let warned = false

function warnOnce() {
  if (warned) return
  warned = true
  if (typeof console !== 'undefined') {
    console.warn('[place] src/app/index.js is not loaded yet: sentences from WeatherCopy are left out')
  }
}

/**
 * Loads `src/app/index.js` if it is there, and calls `onReady` once, so a screen built before the
 * view-model layer landed fills in on the next refresh instead of staying blank for the visit.
 */
export function loadAppNamespace(onReady) {
  if (app != null) return
  if (pending == null) {
    pending = import('../../app/index.js').then(
      (module) => { app = module },
      () => { app = null; warnOnce() },
    )
  }
  pending.then(() => { if (app != null) onReady?.() })
}

/** For a harness, or for an entry point that already holds the namespace. */
export function setAppNamespace(namespace) {
  app = namespace ?? null
}

function callInto(container, name, args, fallback) {
  const fn = app?.[container]?.[name]
  if (typeof fn !== 'function') {
    warnOnce()
    return typeof fallback === 'function' ? fallback() : fallback
  }
  try {
    return fn(...args)
  } catch (error) {
    if (typeof console !== 'undefined') console.warn(`[place] ${container}.${name} threw`, error)
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

const copy = (name, args, fallback = null) => callInto('WeatherCopy', name, args, fallback)
const format = (name, args, fallback = null) => callInto('WeatherFormatting', name, args, fallback)

// MARK: - WeatherFormatting
//
// Swift `f(_ a:, b:, c:)` is `f(a, { b, c })`; every label becomes a key. The Swift's `Calendar`
// is an IANA `timeZone` id here, as it is in `src/screen/WeatherForecastRows.js`.

/** Whole degrees, converted by the locale. The fallback is the wire's own °F, unconverted. */
export const temperature = (fahrenheit, { locale } = {}) =>
  format('temperature', [{ fahrenheit, locale }], () => (fahrenheit == null ? null : `${Math.round(fahrenheit)}°`))

export const kilometres = (value) =>
  format('kilometres', [value], () =>
    value == null ? null : value < 0.5 ? t('weather.unit.underOneKilometre') : t('weather.unit.kilometres', Math.round(value)))

export const distance = (value, { direction } = {}) =>
  format('distance', [value, { direction }], () => kilometres(value))

export const clockTime = (date, { now, timeZone, locale } = {}) =>
  format('clockTime', [date, { now, timeZone, locale }], () => plainTime(date, timeZone, locale))

export const ago = (date, { now } = {}) => format('ago', [date, { now }])

export const age = (date, { now } = {}) => format('age', [date, { now }])

/** When an alert applies (spec §18.2, revision 12). The fallback is the end's bare clock time. */
export const alertWindow = ({ beginsAt = null, expiresAt, now, timeZone, locale, countdown = true }) =>
  format('alertWindow', [{ beginsAt, expiresAt, now, timeZone, locale, countdown }],
    () => plainTime(expiresAt, timeZone, locale))

export const condition = (sky) => format('condition', [sky])

export const isNight = (date, { timeZone } = {}) =>
  format('isNight', [date, { timeZone }], () => {
    const hour = Number(hourIn(date, timeZone))
    return Number.isFinite(hour) ? hour < 6 || hour >= 19 : false
  })

export const wind = (reading) => format('wind', [reading])

export const pressure = ({ inchesOfMercury, locale } = {}) =>
  format('pressure', [{ inchesOfMercury, locale }], () =>
    inchesOfMercury == null ? null : inchesOfMercury.toFixed(2))

export const visibility = ({ miles, locale } = {}) => format('visibility', [{ miles, locale }])

export const eventName = (event, { tables } = {}) => format('eventName', [event, { tables }])

/** A `MeshWXEventTint` name, which the stylesheet turns into `--tint-<name>`. */
export const eventTint = ({ for: event, tables }) => format('tint', [{ for: event, tables }], 'grey')

export const eventSymbol = ({ for: event, tables }) =>
  format('symbol', [{ for: event, tables }], 'exclamationmark.triangle')

/** The one way a place is named (docs/MESHWX_UI.md §3.1 U-12). */
export const placeName = (label) => format('placeName', [label], () => (label ?? '').trim())

export const sentenceStart = (text) =>
  format('sentenceStart', [text], () => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text))

// MARK: - WeatherCopy

export const bannerText = (banner) => copy('banner', [banner])

export const requestBlocked = (block, { source }) => copy('requestBlocked', [block, { source }])

export const updateAsks = (plan, { source }) => copy('updateAsks', [plan, { source }])

export const updateJustReceived = ({ source }) => copy('updateJustReceived', [{ source }])

export const everythingCurrent = ({ source, asOf, now, timeZone, locale }) =>
  copy('everythingCurrent', [{ source, asOf, now, timeZone, locale }], () => t('weather.update.currentUnknown'))

export const conditionsSource = ({ stationName, kilometres: km, observedAt, now, timeZone, locale, isStale = false }) =>
  copy('conditionsSource', [{ stationName, kilometres: km, observedAt, now, timeZone, locale, isStale }])

export const nearbyReadingLead = ({ stationName, kilometres: km }) =>
  copy('nearbyReadingLead', [{ stationName, kilometres: km }])

/**
 * **The one place the web says something different from the phone.** `weather.conditions.ask`
 * reads "Pull down to ask WX-AUS for KAQO", and there is no pull here: Update is the refresh
 * (§11.1, and §3.1 O-4, which preferred the button because it can say what it will ask for).
 * Naming a gesture the browser does not have is the failure §3.1 U-6 is about, from the other
 * side. Blocked, the sentence stops offering anything and names the station only, which is
 * `WeatherCopy`'s own wording with no gesture in it, so that branch is its.
 */
export const conditionsAsk = ({ placeName: name, source, icao, block }) =>
  (block != null
    ? copy('conditionsAsk', [{ placeName: name, source, icao, block }])
    : t('web.place.conditionsAsk', name, source, icao))

export const noStationNearby = ({ placeName: name, nearestTown, kilometres: km }) =>
  copy('noStationNearby', [{ placeName: name, nearestTown, kilometres: km }])

export const emptyPlaceTitle = ({ placeName: name }) => copy('emptyPlaceTitle', [{ placeName: name }])

export const emptyPlaceNearest = (empty) => copy('emptyPlaceNearest', [empty])

/**
 * Nothing while every request is blocked — the reason is said once, by the caption (§3.1 U-24).
 * With nothing in reach to ask about, `WeatherCopy`'s own sentence. Otherwise the web's, because
 * `weather.empty.ask` reads "Pull down, or tap Update" and only half of that is true here.
 */
export const emptyPlaceAction = (empty, { placeName: name, source, block }) => {
  if (block != null) return null
  if (attempt(() => WeatherEmptyPlace.hasNothingToAsk(empty)) === true) {
    return copy('emptyPlaceAction', [empty, { placeName: name, source, block }])
  }
  return t('web.place.emptyAsk', source)
}

export const forecastMissing = ({ placeName: name, point, kilometres: km }) =>
  copy('forecastMissing', [{ placeName: name, point, kilometres: km }])

export const forecastPointChosenByBot = ({ source }) => copy('forecastPointChosenByBot', [{ source }])

export const rowLabel = (label, { timeZone, locale } = {}) => copy('rowLabel', [label, { timeZone, locale }])

export const rainChance = (row) => copy('rainChance', [row])

export const hazards = (row) => copy('hazards', [row])

export const temperatures = ({ highF, lowF, locale } = {}) => copy('temperatures', [{ highF, lowF, locale }])

export const dataSource = (source) => copy('dataSource', [source])

export const radioRowText = (row, { source, now, timeZone, locale }) =>
  copy('radioRow', [row, { source, now, timeZone, locale }], () => source ?? null)

export const alertQualifier = (item, { placeName: name, now }) =>
  copy('alertQualifier', [item, { placeName: name, now }])

export const placeRowText = (reading, { now, locale } = {}) =>
  copy('placeRow', [reading, { now, locale }], () => t('weather.picker.noReading'))

export const stationReport = ({ botName, reportedAt, now, timeZone, locale }) =>
  copy('stationReport', [{ botName, reportedAt, now, timeZone, locale }])

export const ownedReply = ({ source, at, now, timeZone, locale }) =>
  copy('ownedReply', [{ source, at, now, timeZone, locale }])

export const quietCaption = ({ source, since, now, timeZone, locale }) =>
  copy('quietCaption', [{ source, since, now, timeZone, locale }])

// Radar (docs/MESHWX_UI.md §18). A sentence the copy layer cannot word yet is left out, as
// everything else here is: the card is a picture with a caption, and a caption it cannot write is
// no caption.

export const radarSummary = (summary, { placeName: name }) =>
  copy('radarSummary', [summary, { placeName: name }], () => [])

export const radarTime = (picture, { now, timeZone, locale }) =>
  copy('radarTime', [picture, { now, timeZone, locale }])

export const radarWidthName = (zoom) => copy('radarWidthName', [zoom])

// MARK: - Pages
//
// **A pushed screen answers for the page it was opened from** (docs/MESHWX_UI.md §3.1 U-18, P-1),
// never for "the page the pager is on". It is handed that page's `WeatherPageScreen` (or its id),
// reads the page's build back by id while the model still holds it, and falls back to the build
// it was opened with once that page has been evicted from under it.

export function pageIDOf(page) {
  if (page == null) return null
  if (typeof page === 'string') return page
  return page.pageID ?? page.page?.pageID ?? null
}

/** This page's current screen, or the one it was opened with. Null before the first build. */
export function screenFor(app_, page) {
  const id = pageIDOf(page)
  if (id != null) {
    const live = attempt(() => app_?.model?.screen?.({ for: id }))
    if (live != null) return live
  }
  return typeof page === 'object' ? page : null
}

/** A value off a `WeatherPageScreen`, whether it is a field or the model's own accessor. */
export function screenValue(screen, key, modelCall) {
  if (screen == null) return null
  // `WeatherPageScreen` is a class of getters that read the model back, so reading one can throw
  // while a page is between builds. A screen never throws from `render()`.
  let held
  try {
    held = screen[key]
  } catch {
    held = undefined
  }
  if (held !== undefined) return held
  return attempt(() => modelCall?.(screen)) ?? null
}

export function planOf(screen) {
  return (
    screenValue(screen, 'plan', (one) => one.model?.plan?.({ for: one.pageID })) ?? {
      steps: [],
      justReceived: [],
      currentAsOf: null,
    }
  )
}

export function sourceNameOf(screen) {
  return screenValue(screen, 'sourceName', null) ?? t('weather.bot.generic')
}

export function placeNameOf(screen) {
  const held = screenValue(screen, 'placeName', null)
  if (held != null) return held
  const label = screen?.snapshot?.place?.label
  return label == null ? null : placeName(label)
}

export function nowOf(screen, app_) {
  return screen?.now ?? app_?.model?.now ?? Date.now()
}

// MARK: - Odds and ends

/** Runs `fn`, swallowing anything it throws: `render()` never throws (the brief). */
export function attempt(fn, fallback = null) {
  try {
    const value = fn()
    return value === undefined ? fallback : value
  } catch (error) {
    if (typeof console !== 'undefined') console.warn('[place]', error)
    return fallback
  }
}

/**
 * Runs `fn` once the navigation has settled after a sheet closed.
 *
 * `Navigation.sheet().close()` calls `history.back()` and the pop lands a frame or two later, so
 * pushing a screen straight from `onDismiss` would put a history entry in front of a back that is
 * already on its way and the pushed screen would close itself. This waits for that pop, and for a
 * sheet the user closed *with* Back — where no further pop is coming — falls through on a timer.
 */
export function afterNavigationSettles(fn) {
  if (typeof window === 'undefined') { fn(); return }
  let done = false
  const run = () => {
    if (done) return
    done = true
    window.removeEventListener('popstate', onPop)
    fn()
  }
  const onPop = () => requestAnimationFrame(run)
  window.addEventListener('popstate', onPop)
  setTimeout(() => requestAnimationFrame(run), 150)
}

/** The five text products of a place page, in the order docs/MESHWX_UI.md §4 lists them. */
export const WeatherReportProduct = Object.freeze([
  { id: 'discussion', subject: 1, titleKey: 'weather.reports.discussion.title' },
  { id: 'outlook', subject: 6, titleKey: 'weather.reports.outlook.title' },
  { id: 'stormReports', subject: 3, titleKey: 'weather.reports.storms.title' },
  { id: 'rainfall', subject: 4, titleKey: 'weather.reports.rainfall.title' },
  { id: 'spaceWeather', subject: 2, titleKey: 'weather.reports.space.title' },
])

function plainTime(date, timeZone, locale) {
  if (date == null) return null
  return attempt(
    () => new Intl.DateTimeFormat(locale ?? undefined, { hour: 'numeric', minute: '2-digit', timeZone: timeZone ?? undefined }).format(new Date(date)),
    null,
  )
}

function hourIn(date, timeZone) {
  if (date == null) return NaN
  return attempt(
    () => new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23', timeZone: timeZone ?? undefined }).format(new Date(date)),
    NaN,
  )
}
