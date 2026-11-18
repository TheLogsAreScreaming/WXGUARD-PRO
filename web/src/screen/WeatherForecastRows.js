// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherForecastRows.swift

import {
  MeshWXCompass,
  MeshWXForecastEntry,
  MeshWXForecastLayout,
  MeshWXSky,
  MeshWXWire,
} from '../meshwx/index.js'
import { WeatherStoredForecast } from '../weather/index.js'
import { WeatherGeo } from './WeatherGeo.js'

// MARK: - The calendar
//
// The Swift takes a `Calendar` carrying a `TimeZone`; docs/PORTING.md takes an injected IANA
// time-zone id and `Intl.DateTimeFormat`, so nothing in a rule reads the machine's own zone.

const formatters = new Map()

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** The wall-clock fields of an instant in `timeZone`. */
function fields(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms))
  const read = (type) => Number(parts.find((part) => part.type === type).value)
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

function utcOf(value) {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetMs(ms, timeZone) {
  return utcOf(fields(ms, timeZone)) - ms
}

/** The instant a wall-clock time names in `timeZone`, resolved across an offset change. */
function epochFrom({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const first = offsetMs(wall, timeZone)
  let instant = wall - first
  const again = offsetMs(instant, timeZone)
  if (again !== first) instant = wall - again
  return instant
}

function startOfDay(ms, timeZone) {
  const value = fields(ms, timeZone)
  return epochFrom({ year: value.year, month: value.month, day: value.day }, timeZone)
}

function addingDays(ms, days, timeZone) {
  const value = fields(ms, timeZone)
  return epochFrom(
    { year: value.year, month: value.month, day: value.day + days, hour: value.hour, minute: value.minute, second: value.second },
    timeZone,
  )
}

function settingHour(hour, ms, timeZone) {
  const value = fields(ms, timeZone)
  return epochFrom({ year: value.year, month: value.month, day: value.day, hour }, timeZone)
}

/** `calendar.dateComponents([.day], from:to:).day` between two instants' calendar days. */
function dayDifference(from, to, timeZone) {
  const left = fields(from, timeZone)
  const right = fields(to, timeZone)
  return Math.round(
    (Date.UTC(right.year, right.month - 1, right.day) - Date.UTC(left.year, left.month - 1, left.day)) / 86400000,
  )
}

// MARK: - Rows

/**
 * One line of the forecast card, labelled against now (docs/MESHWX_UI.md §9):
 * `{ id, label, highF, lowF, popPercent, popIsNight, sky, isNightIcon, thunder, wintry, windy,
 * fog, windDirection, windMph }`.
 *
 * - `popIsNight`: for a row pairing a day with its night, the rain chance shown is the night's.
 * - `isNightIcon`: draw the night variant of the sky icon.
 */
export const WeatherForecastRowLabel = Object.freeze({
  today: Object.freeze({ kind: 'today' }),
  tonight: Object.freeze({ kind: 'tonight' }),
  tomorrow: Object.freeze({ kind: 'tomorrow' }),
  tomorrowNight: Object.freeze({ kind: 'tomorrowNight' }),
  day(value) {
    return { kind: 'day', value }
  },
  night(value) {
    return { kind: 'night', value }
  },
})

export const WeatherForecastRow = Object.freeze({
  Label: WeatherForecastRowLabel,
})

export const WeatherForecastRows = Object.freeze({
  /** NWS day periods run 6 AM–6 PM and nights 6 PM–6 AM. */
  dayEndsHour: 18,
  nightEndsHour: 6,

  /**
   * Rows for a forecast, dropping what has already ended. The shape comes from the entries
   * (`MeshWXForecastLayout`): whole days, spec periods paired day-with-night, or one row per entry
   * when neither reading can be trusted.
   */
  rows({ for: forecast, now, timeZone }) {
    const layout = MeshWXForecastLayout.make({ of: forecast })
    const entries = MeshWXForecastEntry.entries({ of: forecast })
    const issueDay = startOfDay(forecast.issued_min * 60000, timeZone)
    const today = startOfDay(now, timeZone)

    const date = (offset) => addingDays(issueDay, offset, timeZone)
    const at = (hour, day) => settingHour(hour, day, timeZone)
    const dayEnded = (day) => now >= at(WeatherForecastRows.dayEndsHour, day)
    const nightEnded = (day) => now >= at(WeatherForecastRows.nightEndsHour, addingDays(day, 1, timeZone))
    const wholeDayEnded = (day) => day < today
    const label = (day, night) => {
      const days = dayDifference(today, day, timeZone)
      if (days <= 0 && night) return WeatherForecastRowLabel.tonight
      if (days === 0 && !night) return WeatherForecastRowLabel.today
      if (days === 1 && !night) return WeatherForecastRowLabel.tomorrow
      if (days === 1 && night) return WeatherForecastRowLabel.tomorrowNight
      return night ? WeatherForecastRowLabel.night(day) : WeatherForecastRowLabel.day(day)
    }
    const row = (id, rowLabel, period, night) => ({
      id,
      label: rowLabel,
      highF: period.high_f ?? null,
      lowF: period.low_f ?? null,
      popPercent: period.pop_pct ?? null,
      popIsNight: night,
      sky: period.sky,
      isNightIcon: night,
      thunder: period.thunder,
      wintry: period.wintry,
      windy: period.windy,
      fog: period.fog,
      windDirection: MeshWXCompass.make({ degrees: period.wind_dir_deg }),
      windMph: period.wind_mph,
    })

    // A `MeshWXForecastLayout` is its Swift case name as a string (docs/PORTING.md §3).
    if (layout === 'days') {
      const rows = []
      for (const entry of entries) {
        const day = date(entry.dayOffset)
        if (wholeDayEnded(day)) continue
        rows.push(row(entry.index, label(day, false), entry.period, false))
      }
      return rows
    }

    if (layout === 'mixed') {
      const rows = []
      for (const entry of entries) {
        const day = date(entry.dayOffset)
        const night = entry.isNight ?? false
        if (night ? nightEnded(day) : dayEnded(day)) continue
        rows.push(row(entry.index, label(day, night), entry.period, night))
      }
      return rows
    }

    const byDay = new Map()
    for (const entry of entries) {
      const slot = byDay.get(entry.dayOffset) ?? { day: null, night: null }
      if (entry.isNight === true) slot.night = entry
      else slot.day = entry
      byDay.set(entry.dayOffset, slot)
    }
    const rows = []
    for (const offset of [...byDay.keys()].sort((lhs, rhs) => lhs - rhs)) {
      const day = date(offset)
      const slot = byDay.get(offset)
      const dayPart = slot.day != null && !dayEnded(day) ? slot.day : null
      const nightPart = slot.night != null && !nightEnded(day) ? slot.night : null
      if (dayPart == null && nightPart == null) continue
      if (dayPart == null) {
        rows.push(row(nightPart.index, label(day, true), nightPart.period, true))
        continue
      }
      if (nightPart == null) {
        rows.push(row(dayPart.index, label(date(offset), false), dayPart.period, false))
        continue
      }
      rows.push(WeatherForecastRows.merged(dayPart, nightPart, { label: label(day, false) }))
    }
    return rows
  },

  /**
   * A day and its night as one row: the day's high, the night's low, the worse sky, every hazard
   * flag from either half, the higher rain chance and which half it belongs to.
   */
  merged(day, night, { label }) {
    const dayPop = day.period.pop_pct ?? null
    const nightPop = night.period.pop_pct ?? null
    const popIsNight = (nightPop ?? 0) > (dayPop ?? 0) || (dayPop == null && nightPop != null)
    const windier = night.period.wind_mph > day.period.wind_mph ? night.period : day.period
    return {
      id: day.index,
      label,
      highF: day.period.high_f ?? null,
      lowF: night.period.low_f ?? null,
      popPercent: popIsNight ? nightPop : dayPop,
      popIsNight,
      sky: WeatherForecastRows.worse(day.period.sky, night.period.sky),
      isNightIcon: false,
      thunder: day.period.thunder || night.period.thunder,
      wintry: day.period.wintry || night.period.wintry,
      windy: day.period.windy || night.period.windy,
      fog: day.period.fog || night.period.fog,
      windDirection: MeshWXCompass.make({ degrees: windier.wind_dir_deg }),
      windMph: windier.wind_mph,
    }
  },

  worse(lhs, rhs) {
    return WeatherForecastRows.skyRank(lhs) >= WeatherForecastRows.skyRank(rhs) ? lhs : rhs
  },

  skyRank(sky) {
    switch (sky) {
      case MeshWXSky.thunderstorm:
        return 12
      case MeshWXSky.snow:
        return 11
      case MeshWXSky.squall:
        return 10
      case MeshWXSky.rain:
        return 9
      case MeshWXSky.drizzle:
        return 8
      case MeshWXSky.fog:
        return 7
      case MeshWXSky.sandOrDust:
      case MeshWXSky.smoke:
        return 6
      case MeshWXSky.mist:
        return 5
      case MeshWXSky.haze:
        return 4
      case MeshWXSky.overcast:
        return 3
      case MeshWXSky.broken:
        return 2
      case MeshWXSky.scattered:
      case MeshWXSky.few:
        return 1
      case MeshWXSky.clear:
        return 0
      default:
        return -1
    }
  },
})

// MARK: - The card

/** Where a shown forecast came from. */
export const WeatherForecastSource = Object.freeze({
  /** The forecast point nearest the place. */
  placePoint: Object.freeze({ kind: 'placePoint' }),
  /** Another point's forecast, already held, close enough to stand in. */
  nearbyPoint({ kilometres }) {
    return { kind: 'nearbyPoint', kilometres }
  },
  /**
   * The bot chose the point (spec §7, revision 10): this phone asked `>f <lat>,<lon>` and the
   * answer came back for the nearest point the bot *holds a forecast for*, which is not in the
   * bundle at all. There is no name to show, so the card says where it came from instead:
   * "Forecast point chosen by WX-AUS".
   */
  chosenByBot({ kilometres }) {
    return { kind: 'chosenByBot', kilometres }
  },
})

/**
 * The Forecast card's content (docs/MESHWX_UI.md §9).
 *
 * A summary is `{ point, coordinate, stored, botID, layout, rows, source, isStale, kilometres }`.
 * `kilometres` is how far the point is from the place: a forecast is for a *point*, and two towns
 * twenty kilometres apart share one. The header names the point and this distance whenever the
 * point is not the place itself, so a page never shows a forecast without saying what it is a
 * forecast of — which is how Round Rock and Austin came to show the same seven rows with nothing
 * to tell them apart (docs/MESHWX_UI.md §3.1 U-9).
 *
 * `point` is null and `coordinate` is the coordinate that was asked about when the bot chose the
 * point for itself: there is no bundled point to name, and the source says so.
 *
 * Revision 10 removed `.noPointNearby`. The bundle's point list was built from one day's products
 * and has no point at all for nine offices, so "no forecast point near Santa Fe" was a claim
 * about *this app's table*, made to a user whose bot held a forecast fifteen kilometres away:
 * "Forecast works in chat (`forecast santa fe nm`) but not in the app. I thought we were using
 * the same engine" (owner, 20 September 2026). A place with a coordinate now always has
 * something to ask for.
 */
export const WeatherForecastCard = Object.freeze({
  Source: WeatherForecastSource,

  nearbyPointKilometres: 10,
  /**
   * How far the nearest forecast point may be and still stand for the place.
   *
   * From the bundle's own density (2026-09-15 kit): measured from every `places.json` entry to its
   * nearest `pfm_points.json` point, over the 34,556 places with any point within 1,000 km, the
   * distance is 23 km at the median, 68 km at p95 and 114 km at p99. The cutoff is p99 rounded up.
   * About 1% of places lie beyond it, mostly New Mexico (Albuquerque is 213 km from its nearest
   * point), Utah, Idaho and western Alaska — places where the nearest point's forecast is another
   * landscape's.
   */
  pointReachKilometres: 115,

  /**
   * How near a bot-chosen point's *asked* coordinate must be to the place for that answer to be
   * this place's forecast (docs/MESHWX_UI.md §9). Tighter than `pointReachKilometres` on purpose: a bundled
   * point is a place the Weather Service publishes for, while this is a question somebody typed,
   * and 25 km is about as far as two questions can be apart and still be one place.
   */
  askedPointKilometres: 25,

  noPlace: Object.freeze({ kind: 'noPlace' }),
  /**
   * Nothing held for the place: ask.
   *
   * `point` is the bundled point to ask for, `kilometres` from the place — or **null** when the
   * bundle has no point within reach, in which case `WeatherUpdatePlan` asks the bot to choose
   * one with `>f <lat>,<lon>`. Either way there is something to ask for, which is the whole of
   * revision 10's change here.
   */
  missing({ point, kilometres }) {
    return { kind: 'missing', point, kilometres }
  },
  forecast(value) {
    return { kind: 'forecast', value }
  },

  /**
   * The forecast was answered to a request of this phone's. False for one overheard on the
   * channel, which the header says (docs/MESHWX_UI.md §3.1 U-14).
   */
  isOwn(summary) {
    return summary.stored.requestedHere
  },

  make({ states, place, tables, now, timeZone }) {
    if (place == null) return WeatherForecastCard.noPlace
    // The nearest bundled point, when there is one close enough to speak for the place. Past the
    // reach cutoff it is another landscape's forecast and is treated as no point at all — but
    // "no point" is no longer "nothing to ask for": the bot is asked to choose.
    const nearest = tables.nearestPoint({ toLat: place.coordinate.latitude, lon: place.coordinate.longitude })
    const nearestKilometres = nearest == null ? null : WeatherGeo.kilometres(place.coordinate, {
      latitude: nearest.lat,
      longitude: nearest.lon,
    })
    const isInReach = nearest != null && nearestKilometres <= WeatherForecastCard.pointReachKilometres
    const placePoint = isInReach ? nearest : null
    const placePointKilometres = isInReach ? nearestKilometres : null

    const newest = new Map()
    const botIDs = Object.keys(states)
      .map(Number)
      .sort((lhs, rhs) => lhs - rhs)
    for (const botID of botIDs) {
      const state = states[String(botID)]
      for (const [indexKey, stored] of Object.entries(state.forecasts ?? {})) {
        const index = Number(indexKey)
        if (index === MeshWXWire.unbundledPoint) continue
        const held = newest.get(index)
        if (held != null && held.stored.forecast.issued_min >= stored.forecast.issued_min) continue
        newest.set(index, { stored, botID })
      }
    }

    const summary = (point, entry, source, kilometres, coordinate = null) =>
      WeatherForecastCard.forecast({
        point,
        coordinate,
        stored: entry.stored,
        botID: entry.botID,
        layout: MeshWXForecastLayout.make({ of: entry.stored.forecast }),
        rows: WeatherForecastRows.rows({ for: entry.stored.forecast, now, timeZone }),
        source,
        isStale: WeatherStoredForecast.isStale(entry.stored, { at: now }),
        kilometres,
      })

    const held = placePoint == null ? null : newest.get(placePoint.index)
    if (held != null) return summary(placePoint, held, WeatherForecastSource.placePoint, placePointKilometres)

    // A forecast the bot chose the point for, asked about a coordinate within 25 km of the place
    // (spec §7, revision 10). It comes second because a bundled point the Weather Service
    // publishes for is a better answer when one is held — and first past that, because it was
    // asked about *this* place while a nearby point is a coincidence.
    const asked = nearestAskedForecast({ states, place })
    if (asked != null) {
      return summary(
        null,
        asked,
        WeatherForecastSource.chosenByBot({ kilometres: asked.distance }),
        asked.distance,
        asked.coordinate,
      )
    }

    let nearby = null
    for (const [index, entry] of newest) {
      const point = tables.point({ at: index })
      if (point == null) continue
      const distance = WeatherGeo.kilometres(place.coordinate, { latitude: point.lat, longitude: point.lon })
      if (distance > WeatherForecastCard.nearbyPointKilometres) continue
      if (nearby == null || distance < nearby.distance) nearby = { point, entry, distance }
    }
    if (nearby != null) {
      return summary(
        nearby.point,
        nearby.entry,
        WeatherForecastSource.nearbyPoint({ kilometres: nearby.distance }),
        nearby.distance,
      )
    }

    return WeatherForecastCard.missing({ point: placePoint, kilometres: placePointKilometres })
  },
})

/**
 * The newest bot-chosen forecast asked about a coordinate within 25 km of the place, across
 * every bot: `{ stored, botID, distance, coordinate }`, or null.
 *
 * Only forecasts this phone asked for are here at all — the coordinate lives in the question, so
 * a bot-chosen forecast nobody here asked about sits under `"?"` and is never anywhere's
 * forecast (`WeatherBotState.unbundledForecasts`). A key that is not a coordinate is skipped
 * rather than guessed at.
 */
function nearestAskedForecast({ states, place }) {
  let best = null
  const botIDs = Object.keys(states)
    .map(Number)
    .sort((lhs, rhs) => lhs - rhs)
  for (const botID of botIDs) {
    const state = states[String(botID)]
    for (const [key, stored] of Object.entries(state.unbundledForecasts ?? {})) {
      const coordinate = parseCoordinateKey(key)
      if (coordinate == null) continue
      const distance = WeatherGeo.kilometres(place.coordinate, coordinate)
      if (distance > WeatherForecastCard.askedPointKilometres) continue
      // Newest issue wins, then nearest: a fresher forecast of the same place beats a closer
      // question asked about it yesterday.
      if (best != null) {
        const issued = best.stored.forecast.issued_min
        if (issued > stored.forecast.issued_min) continue
        if (issued === stored.forecast.issued_min && best.distance <= distance) continue
      }
      best = { stored, botID, distance, coordinate }
    }
  }
  return best
}

/** `"35.687,-105.938"` back into a coordinate; null for `"?"` and for anything else. */
function parseCoordinateKey(key) {
  const match = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(key)
  if (match == null) return null
  return { latitude: Number(match[1]), longitude: Number(match[2]) }
}

/**
 * Forecasts on the channel that this phone did not ask for: somebody else's places, offered in the
 * place picker and labelled as theirs (docs/MESHWX_UI.md §12).
 */
export const WeatherOtherPlace = Object.freeze({
  window: 24 * 60 * 60,

  id(other) {
    return other.point.index
  },

  make({ states, excludingPoint: excluded, tables, now }) {
    const byPoint = new Map()
    for (const state of Object.values(states)) {
      for (const [indexKey, stored] of Object.entries(state.forecasts ?? {})) {
        const index = Number(indexKey)
        if (index === MeshWXWire.unbundledPoint || index === excluded || stored.requestedHere) continue
        if ((now - stored.receivedAt) / 1000 > WeatherOtherPlace.window) continue
        const point = tables.point({ at: index })
        if (point == null) continue
        const candidate = {
          point,
          issuedAt: WeatherStoredForecast.issuedAt(stored),
          receivedAt: stored.receivedAt,
        }
        const held = byPoint.get(index)
        if (held != null && held.receivedAt >= candidate.receivedAt) continue
        byPoint.set(index, candidate)
      }
    }
    return [...byPoint.values()].sort((lhs, rhs) => rhs.receivedAt - lhs.receivedAt)
  },
})
