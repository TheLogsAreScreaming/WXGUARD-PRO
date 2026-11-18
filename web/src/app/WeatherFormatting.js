// Port of MC1/Views/Tools/Weather/WeatherFormatting.swift (docs/PORTING.md).

import { t } from '../l10n.js'
import {
  MeshWXCompass,
  MeshWXDataSource,
  MeshWXEventTint,
  MeshWXPresentation,
  MeshWXSky,
} from '../meshwx/index.js'

/**
 * Words, units and colours the Weather tool puts on screen, as pure functions.
 *
 * `MeshWX` stops at numbers and enum cases; this is where they become text. Kept free of any
 * view so each rule is a unit test rather than a screenshot.
 *
 * ## Deviations from the Swift (docs/PORTING.md)
 *
 * - Swift formats with `Date.FormatStyle`, `Measurement` and a `Calendar`. Here the calendar is
 *   an **IANA time zone id** and the formatters are `Intl.DateTimeFormat`, `Intl.NumberFormat`.
 *   Both `locale` and `timeZone` are injected; left out, they are whatever the runtime resolves
 *   (the browser's).
 * - Swift's `color(for:)` returns a SwiftUI `Color`. The web has a token per event tint
 *   (`--tint-<name>`), so `color` returns the `MeshWXEventTint` **name** and the screen sets
 *   `--tint` from it. `uiColor` has no web counterpart and is not ported.
 * - `symbol(for:tables:)` returns the SF Symbol name unchanged: `src/ui/kit/icons.js` is keyed
 *   by exactly those names.
 * - `MeshWXCompass` is a nibble (0-15) in JS, so a direction is a number and
 *   `MeshWXCompass.abbreviation` turns it into "N".
 */
export const WeatherFormatting = Object.freeze({
  // MARK: - Clock and durations

  /**
   * "11:02 PM" for today and for anything up to twelve hours ahead (a warning ending at 12:40 AM
   * is "until 12:40 AM"); "yesterday 2:00 PM" for yesterday; "Sep 13, 8:02 PM" otherwise.
   */
  clockTime(date, { now, timeZone, locale } = {}) {
    const time = timeFormatter(locale, timeZone).format(date)
    const day = civilDay(date, timeZone)
    const today = civilDay(now, timeZone)
    if (day === today) return time
    if (date > now && (date - now) / 1000 < 12 * 3600) return time
    if (date < now && day === today - 1) return t('weather.time.yesterday', time)
    return dateTimeFormatter(locale, timeZone).format(date)
  },

  /** "40 s", "2 min", "3 h", "2 d": the largest unit that fits, rounded down. */
  duration({ seconds: raw }) {
    const seconds = Math.max(0, Math.trunc(raw))
    if (seconds < 60) return t('weather.unit.seconds', seconds)
    if (seconds < 3600) return t('weather.unit.minutes', Math.floor(seconds / 60))
    if (seconds < 48 * 3600) return t('weather.unit.hours', Math.floor(seconds / 3600))
    return t('weather.unit.days', Math.floor(seconds / 86_400))
  },

  /** "just now", "40 s ago", "2 min ago", "3 h ago". */
  ago(date, { now }) {
    const elapsed = (now - date) / 1000
    if (elapsed < 5) return t('weather.time.justNow')
    return t('weather.time.ago', WeatherFormatting.duration({ seconds: elapsed }))
  },

  /** "3 h old". */
  age(date, { now }) {
    return t('weather.time.old', WeatherFormatting.duration({ seconds: (now - date) / 1000 }))
  },

  /** "40 min", "1 h 20 min", "2 h": how long is left on an alert, in whole minutes. */
  timeLeft({ minutes: raw }) {
    const minutes = Math.max(0, raw)
    if (minutes < 60) return t('weather.unit.minutes', minutes)
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0 ? t('weather.unit.hours', hours) : t('weather.unit.hoursMinutes', hours, rest)
  },

  /** "45 min" or "5 h", for how long a feed has been quiet. */
  quietDuration({ minutes }) {
    return minutes < 60
      ? t('weather.unit.minutes', Math.max(0, minutes))
      : t('weather.unit.hours', Math.floor(minutes / 60))
  },

  // MARK: - When an alert applies (spec §18.2, revision 12; docs/MESHWX_UI.md §3.1 U-49)

  /**
   * The longest an alert can have left and still count down: twelve hours. Past it, the day and
   * the time say when it ends and a count of hours says nothing more.
   */
  alertCountdownMinutes: 12 * 60,

  /**
   * A moment an alert starts or ends. **Today, or within 12 hours ahead:** the time alone
   * ("19:00", "7:00 PM"). **Within 7 days ahead:** the abbreviated weekday and the time
   * ("Fri 19:00", "Fri 7:00 PM"). **Beyond:** the abbreviated month, day and time, the form
   * `clockTime` uses for another day. Always the locale's own 12- or 24-hour clock, never a
   * pattern (see `alertFormatter` for the hour's width).
   *
   * "Within 12 hours" is the countdown's own bound, `≤ 720` minutes, so a line that counts
   * down never names a weekday for the moment it counts down to. "Within 7 days" is by the
   * calendar — the next six days — because a weekday a whole week ahead is today's name, and
   * "Tue 8:00 AM" said on a Tuesday means this one.
   */
  alertClock(date, { now, timeZone, locale } = {}) {
    const days = civilDay(date, timeZone) - civilDay(now, timeZone)
    const soon = date > now && date - now <= WeatherFormatting.alertCountdownMinutes * 60_000
    if (days === 0 || soon) return alertFormatter('time', locale, timeZone).format(date)
    if (days >= 1 && days < 7) return alertFormatter('weekday', locale, timeZone).format(date)
    return alertFormatter('date', locale, timeZone).format(date)
  },

  /**
   * When an alert applies, everywhere a screen or a notification says so (spec §18.2):
   *
   * - **Not in effect yet** (`beginsAt` later than now): "from Wed 19:00 until Fri 19:00".
   *   Nothing counts down to an expiry that has not begun.
   * - **In effect, ending within 12 hours**, with `countdown`: "until 23:41 · 40 min left".
   * - **In effect, ending later**, or without `countdown`: "until Fri 19:00".
   *
   * Replaces the revision 11 `untilLine`, which put "in 81 h 28 min" beside a date that already
   * said when a Flood Watch ends, and showed that watch — issued Tuesday 09:24 for "Wednesday
   * evening through Friday evening" — as in force two days before it began. Notifications pass
   * `countdown: false`: "40 min left" in a notification centre is stale the moment it is read.
   *
   * `beginsAt` is the alert's start (`WeatherAlertItem.beginsAt`), null when the product is in
   * effect from issuance. The time left is rounded up to the minute, so an alert in effect is
   * never said to have none.
   */
  alertWindow({ beginsAt = null, expiresAt, now, timeZone, locale, countdown = true }) {
    const clock = (date) => WeatherFormatting.alertClock(date, { now, timeZone, locale })
    if (beginsAt != null && beginsAt > now) {
      return t('weather.alerts.fromUntil', clock(beginsAt), clock(expiresAt))
    }
    const minutes = Math.ceil((expiresAt - now) / 60000)
    if (countdown && minutes <= WeatherFormatting.alertCountdownMinutes) {
      return t(
        'weather.alerts.until',
        clock(expiresAt),
        t('weather.alerts.left', WeatherFormatting.timeLeft({ minutes })),
      )
    }
    return t('weather.alerts.untilOnly', clock(expiresAt))
  },

  // MARK: - Distance

  /** "3 km", "under 1 km". */
  kilometres(kilometres) {
    if (!(kilometres >= 0.5)) return t('weather.unit.underOneKilometre')
    return t('weather.unit.kilometres', Math.round(kilometres))
  },

  /** "25 km N". */
  distance(kilometres, { direction } = {}) {
    const distance = WeatherFormatting.kilometres(kilometres)
    if (direction == null) return distance
    return t('weather.unit.distanceDirection', distance, MeshWXCompass.abbreviation(direction))
  },

  /** The 16-point compass direction from one coordinate towards another. */
  direction({ from, to }) {
    const lat1 = (from.latitude * Math.PI) / 180
    const lat2 = (to.latitude * Math.PI) / 180
    const dLon = ((to.longitude - from.longitude) * Math.PI) / 180
    const y = Math.sin(dLon) * Math.cos(lat2)
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
    const degrees = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
    return MeshWXCompass.fromDegrees(degrees)
  },

  // MARK: - Names

  /** "WX-AUS", or "Weather radio 041D" for a bot heard without an advert. */
  botName({ botID, bot }) {
    if (bot != null) return bot.name
    return t('weather.bot.heardOnly', botID.toString(16).toUpperCase().padStart(4, '0'))
  },

  /** A name at the start of a sentence: "the weather radio" becomes "The weather radio". */
  sentenceStart(text) {
    if (text == null || text.length === 0) return text
    const first = [...text][0]
    return first.toUpperCase() + text.slice(first.length)
  },

  /**
   * **The one way a place is named**, everywhere the app names one (docs/MESHWX_UI.md §3.1 U-12).
   *
   * One tap used to produce three names: "Austin" in the title bar, "Austin, TX" in Places and
   * the station's own town in the line under the temperature, and nothing on screen said they
   * were the same place. The label the place carries is that name — the state stays on, because
   * it is what tells two Austins apart — and it is not shortened for one screen and not another.
   */
  placeName(label) {
    return label.replace(/^[ \t]+|[ \t]+$/g, '')
  },

  /** "v1.14.0" → "1.14"; anything unrecognised is returned as it is. */
  firmwareVersion(raw) {
    let text = raw.replace(/^[ \t]+|[ \t]+$/g, '')
    if (text.toLowerCase().startsWith('v')) text = text.slice(1)
    const parts = text.split('.')
    if (parts.length < 2 || !parts.every((part) => part.length > 0 && /^[0-9]+$/.test(part))) return raw
    while (parts.length > 2 && parts[parts.length - 1] === '0') parts.pop()
    return parts.join('.')
  },

  // A forecast point is named by `WeatherNames.pointLabel`, which is the one function every site
  // that names one now calls (docs/MESHWX_UI.md §3.1 U-25). The two that used to live here —
  // a state reader and a label builder — were the second and third spellings of "Austin Camp
  // Mabry".

  eventName(event, { tables }) {
    return tables.eventName({ for: event })?.long ?? tables.eventLabel({ for: event })
  },

  /** "Travis, TX" for a named area; the bare UGC when the bundle is older than the product. */
  areaName(area) {
    if (area.name == null) return area.ugc
    return t('weather.alerts.area', area.name, area.state)
  },

  /** "Llano County" for a county, the zone's own name for a zone. */
  shortAreaName(area) {
    if (area.name == null) return area.ugc
    return area.isCounty ? t('weather.area.county', area.name) : area.name
  },

  /** Areas once each, in the order the product names them. */
  uniqueAreas(areas) {
    const seen = new Set()
    return areas.filter((area) => {
      if (seen.has(area.ugc)) return false
      seen.add(area.ugc)
      return true
    })
  },

  // MARK: - Weather values

  /**
   * Whole degrees, converted by the locale: the wire is °F, a phone set to metric is not.
   *
   * `Intl` never converts a unit, so the measurement system is read off the locale's region the
   * way CLDR's temperature preference does, and the value is converted before formatting.
   */
  temperature({ fahrenheit, locale }) {
    if (usesFahrenheit(locale)) {
      return temperatureFormatter(locale, 'fahrenheit').format(fahrenheit)
    }
    return temperatureFormatter(locale, 'celsius').format(((fahrenheit - 32) * 5) / 9)
  },

  /** "SSE 12 gusting 21", "calm", or null when the station reported no wind at all. */
  wind(reading) {
    const speed = reading.speedMph
    if (speed == null) return null
    if (!(speed > 0) || reading.direction == null) return t('weather.wind.calm')
    const base = t('weather.wind.speed', MeshWXCompass.abbreviation(reading.direction), Math.trunc(speed))
    const gust = reading.gustMph
    if (gust == null || !(gust > 0)) return base
    return t('weather.wind.gusting', base, Math.trunc(gust))
  },

  pressure({ inchesOfMercury, locale }) {
    return decimalFormatter(locale, 2).format(inchesOfMercury)
  },

  /**
   * "10 mi"; 0 reads "under 1 mi", since the bot sends whole miles rounded down (spec §6,
   * revision 3: 1/2SM is 0).
   */
  visibility({ miles, locale }) {
    const formatted = (value) => mileFormatter(locale).format(value)
    return miles === 0 ? t('weather.unit.under', formatted(1)) : formatted(miles)
  },

  /** The word for a sky code; null for "other", which names nothing. */
  condition(sky) {
    switch (sky) {
      case MeshWXSky.clear: return t('weather.sky.clear')
      case MeshWXSky.few: return t('weather.sky.few')
      case MeshWXSky.scattered: return t('weather.sky.scattered')
      case MeshWXSky.broken: return t('weather.sky.broken')
      case MeshWXSky.overcast: return t('weather.sky.overcast')
      case MeshWXSky.fog: return t('weather.sky.fog')
      case MeshWXSky.smoke: return t('weather.sky.smoke')
      case MeshWXSky.haze: return t('weather.sky.haze')
      case MeshWXSky.rain: return t('weather.sky.rain')
      case MeshWXSky.snow: return t('weather.sky.snow')
      case MeshWXSky.thunderstorm: return t('weather.sky.thunderstorm')
      case MeshWXSky.drizzle: return t('weather.sky.drizzle')
      case MeshWXSky.mist: return t('weather.sky.mist')
      case MeshWXSky.squall: return t('weather.sky.squall')
      case MeshWXSky.sandOrDust: return t('weather.sky.dust')
      default: return null
    }
  },

  /** An observation taken between 7 PM and 6 AM on the phone's clock draws the night icon. */
  isNight(date, { timeZone } = {}) {
    const hour = hourIn(date, timeZone)
    return hour < 6 || hour >= 19
  },

  // MARK: - Tags

  tagTexts({ for: warning, locale }) {
    const texts = []
    for (const tag of MeshWXPresentation.tags({ for: warning })) {
      const text = WeatherFormatting.tagText(tag, { locale })
      if (text != null) texts.push(text)
    }
    return texts
  },

  /** Every tag on one line, for a row that truncates. */
  tagLine({ for: warning, locale }) {
    return WeatherFormatting.tagTexts({ for: warning, locale }).join(' · ')
  },

  tagText(tag, { locale } = {}) {
    switch (tag.kind) {
      case 'tornado': {
        const word = TORNADO_TAGS[tag.value]
        return word == null ? null : t('weather.tag.tornado', t(`weather.tornadoTag.${word}`))
      }
      case 'floodSource': {
        const word = FLOOD_SOURCE_TAGS[tag.value]
        return word == null ? null : t('weather.tag.floodSource', t(`weather.floodSourceTag.${word}`))
      }
      case 'floodDamage': {
        // `.none` and `.reserved` name nothing; the MeshWX layer already drops both.
        const word = FLOOD_DAMAGE_TAGS[tag.value]
        return word == null ? null : t('weather.tag.floodDamage', t(`weather.floodDamageTag.${word}`))
      }
      case 'hail':
        return t('weather.tag.hail', decimalFormatter(locale, 2).format(tag.inches))
      case 'wind':
        return t('weather.tag.wind', Math.trunc(tag.mph))
      default:
        return null
    }
  },

  // MARK: - Colour

  /**
   * The NWS colour convention, as a **name**. The palette is the stylesheet's
   * (`--tint-orangeRed`), so this is where the Swift's literal sRGB values stop and the token
   * name is handed over instead.
   */
  color(tint) {
    return MeshWXEventTint[tint] ?? tint
  },

  tint({ for: event, tables }) {
    return MeshWXPresentation.tint({ forVTEC: tables.vtec({ for: event }) ?? '' })
  },

  /** The SF Symbol name, unchanged: `src/ui/kit/icons.js` is keyed by it. */
  symbol({ for: event, tables }) {
    return MeshWXPresentation.symbolName({ forVTEC: tables.vtec({ for: event }) ?? '' })
  },
})

// MARK: - Tag words

const TORNADO_TAGS = Object.freeze({ 1: 'possible', 2: 'radarIndicated', 3: 'observed' })
const FLOOD_SOURCE_TAGS = Object.freeze({ 1: 'radar', 2: 'radarAndGauge', 3: 'observed' })
const FLOOD_DAMAGE_TAGS = Object.freeze({ 1: 'considerable', 2: 'catastrophic' })

// MARK: - Where the data came from

/** The wire's source codes, for a screen that iterates them. */
export const WeatherDataSource = MeshWXDataSource

// MARK: - Intl plumbing
//
// Formatters are expensive to build and the tool rebuilds a page every thirty seconds, so each
// one is made once per (locale, time zone) pair.

const formatters = new Map()

function cached(key, build) {
  let formatter = formatters.get(key)
  if (formatter === undefined) {
    formatter = build()
    formatters.set(key, formatter)
  }
  return formatter
}

function timeFormatter(locale, timeZone) {
  return cached(`t|${locale ?? ''}|${timeZone ?? ''}`, () =>
    new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }),
  )
}

function dateTimeFormatter(locale, timeZone) {
  return cached(`dt|${locale ?? ''}|${timeZone ?? ''}`, () =>
    new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }),
  )
}

/**
 * `alertClock`'s three forms — the time, the weekday and time, the month, day and time — with
 * one hour style between them, the locale's own.
 *
 * On a 24-hour clock the hour is two digits ("08:00", "Wed 08:00", "6 Oct, 08:00"), as the phone
 * writes it; on a 12-hour clock it is bare ("8:00 AM"). Asked for a `numeric` hour, ICU pads it
 * beside a weekday and not alone, so one line could read "from 0:30 until Wed 08:01"; the width
 * is chosen from the locale's `hourCycle` instead, and nothing is spelled as a pattern.
 */
function alertFormatter(form, locale, timeZone) {
  return cached(`a${form}|${locale ?? ''}|${timeZone ?? ''}`, () => {
    const fields = { hour: alertHourWidth(locale), minute: '2-digit', timeZone }
    if (form === 'weekday') fields.weekday = 'short'
    if (form === 'date') Object.assign(fields, { month: 'short', day: 'numeric' })
    return new Intl.DateTimeFormat(locale, fields)
  })
}

function alertHourWidth(locale) {
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
  return cycle === 'h23' || cycle === 'h24' ? '2-digit' : 'numeric'
}

function partsFormatter(locale, timeZone) {
  return cached(`p|${timeZone ?? ''}`, () =>
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hour12: false,
      timeZone,
    }),
  )
}

function decimalFormatter(locale, fractionDigits) {
  return cached(`n|${locale ?? ''}|${fractionDigits}`, () =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }),
  )
}

function temperatureFormatter(locale, unit) {
  return cached(`deg|${locale ?? ''}|${unit}`, () =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow',
      maximumFractionDigits: 0,
    }),
  )
}

function mileFormatter(locale) {
  return cached(`mi|${locale ?? ''}`, () =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: 'mile', unitDisplay: 'short' }),
  )
}

/** The date's civil day in `timeZone`, as whole days since the epoch: the port of `isDate(inSameDayAs:)`. */
function civilDay(date, timeZone) {
  const parts = fieldsOf(date, timeZone)
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000)
}

function hourIn(date, timeZone) {
  return fieldsOf(date, timeZone).hour
}

function fieldsOf(date, timeZone) {
  const fields = { year: 1970, month: 1, day: 1, hour: 0 }
  for (const part of partsFormatter(undefined, timeZone).formatToParts(new Date(date))) {
    if (part.type in fields) fields[part.type] = Number(part.value)
  }
  // `hour12: false` still spells midnight "24" in some ICU builds.
  if (fields.hour === 24) fields.hour = 0
  return fields
}

/**
 * Whether the locale's region reads temperatures in Fahrenheit. CLDR's `temperature-unit`
 * preference: the United States, its territories, and the handful of countries that follow it.
 */
const FAHRENHEIT_REGIONS = new Set([
  'US', 'AS', 'BS', 'BZ', 'FM', 'GU', 'KY', 'LR', 'MH', 'MP', 'PR', 'PW', 'VI',
])

function usesFahrenheit(locale) {
  const tag = locale ?? new Intl.NumberFormat().resolvedOptions().locale
  try {
    const region = new Intl.Locale(tag).maximize().region
    return region != null && FAHRENHEIT_REGIONS.has(region)
  } catch {
    return true
  }
}
