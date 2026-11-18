// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherStations.swift

import { WeatherStoredObservation } from '../weather/index.js'
import { WeatherGeo } from './WeatherGeo.js'

/**
 * One station's newest reading across every bot, placed against the place:
 * `{ index, station, stored, botID, distanceKilometres, direction, isStale, isTooOld,
 * isInFootprint, isInLatestBatch }`.
 *
 * - `direction` is from the place towards the station.
 * - `isStale`: over two hours old, shown with its age. `isTooOld`: over twelve, not shown at all
 *   (`MeshWXPresentation.observationShownForMinutes`).
 * - `isInFootprint`: the station has been in one of a bot's scheduled batches in the last day, so
 *   it is in that bot's area, whoever's request delivered the reading held now.
 * - `isInLatestBatch`: the station is in the newest scheduled batch its bot has sent, so a bare
 *   `>o` would come back carrying it. One the bot has since dropped from its batch stays in the
 *   footprint for a day but can only be refreshed by `>o <ICAO>` (docs/MESHWX_UI.md §8, §11).
 */
export const WeatherStationReading = Object.freeze({
  make({
    index,
    station,
    stored,
    botID,
    distanceKilometres = null,
    direction = null,
    isStale,
    isTooOld = false,
    isInFootprint,
    isInLatestBatch,
  }) {
    return {
      index, station, stored, botID, distanceKilometres, direction, isStale, isTooOld, isInFootprint, isInLatestBatch,
    }
  },

  id(reading) {
    return reading.index
  },
})

export const WeatherStations = Object.freeze({
  /**
   * Newest reading per station, nearest to the place first (footprint before one-off answers when
   * there is no place).
   */
  readings({ states, coverage, place, tables, now }) {
    const newest = new Map()
    // The newest scheduled batch each bot has sent: what a bare `>o` to that bot would answer with.
    const latestBatch = new Map()
    const botIDs = Object.keys(states)
      .map(Number)
      .sort((lhs, rhs) => lhs - rhs)
    for (const botID of botIDs) {
      const state = states[String(botID)]
      for (const [indexKey, stored] of Object.entries(state.observations ?? {})) {
        const index = Number(indexKey)
        if (stored.lastBatchMinutes != null) {
          latestBatch.set(botID, Math.max(latestBatch.get(botID) ?? 0, stored.lastBatchMinutes))
        }
        const held = newest.get(index)
        if (held != null && held.stored.timestampMinutes >= stored.timestampMinutes) continue
        newest.set(index, { stored, botID })
      }
    }

    const footprint = new Set(coverage.stations.map((station) => station.index))
    const readings = []
    for (const [index, entry] of newest) {
      const station = tables.station({ at: index })
      if (station == null) continue
      const coordinate = { latitude: station.lat, longitude: station.lon }
      readings.push(
        WeatherStationReading.make({
          index,
          station,
          stored: entry.stored,
          botID: entry.botID,
          distanceKilometres: place == null ? null : WeatherGeo.kilometres(place.coordinate, coordinate),
          direction: place == null ? null : WeatherGeo.direction({ from: place.coordinate, to: coordinate }),
          isStale: WeatherStoredObservation.isStale(entry.stored, { at: now }),
          isTooOld: WeatherStoredObservation.isTooOld(entry.stored, { at: now }),
          isInFootprint: footprint.has(index),
          isInLatestBatch:
            entry.stored.lastBatchMinutes != null && entry.stored.lastBatchMinutes === latestBatch.get(entry.botID),
        }),
      )
    }

    return readings.sort((lhs, rhs) => {
      if (
        lhs.distanceKilometres != null &&
        rhs.distanceKilometres != null &&
        lhs.distanceKilometres !== rhs.distanceKilometres
      ) {
        return lhs.distanceKilometres - rhs.distanceKilometres
      }
      if (lhs.isInFootprint !== rhs.isInFootprint) return lhs.isInFootprint ? -1 : 1
      return lhs.station.icao < rhs.station.icao ? -1 : lhs.station.icao > rhs.station.icao ? 1 : 0
    })
  },

  /**
   * The newest reading near a coordinate that is not the place on screen: the temperature and age
   * each row of the Places sheet carries (docs/MESHWX_UI.md §12).
   *
   * The readings' own `distanceKilometres` are measured from the place on screen, so they say
   * nothing about a saved place; this measures from the row's own coordinate. Only a reading
   * carrying a temperature counts — a row with nothing to show says so rather than printing a bare
   * degree sign.
   */
  nearestReading({ in: readings, to: coordinate, within: kilometres = WeatherPrimaryStationMaxDistance }) {
    let best = null
    for (const reading of readings) {
      if (reading.stored.observation.temp_f == null) continue
      const distance = WeatherGeo.kilometres(coordinate, {
        latitude: reading.station.lat,
        longitude: reading.station.lon,
      })
      if (distance > kilometres) continue
      if (
        best != null &&
        (distance > best.kilometres ||
          (distance === best.kilometres && reading.station.icao >= best.reading.station.icao))
      ) {
        continue
      }
      best = { reading, kilometres: distance }
    }
    return best
  },

  /**
   * The station the Now card is showing first, then the order above — distance from the place.
   * The nearest reading is not always the one the card leads with: a nearer stale one sorts ahead
   * of the fresh station `WeatherPrimaryStation.pick` chooses, and the list that opens from the
   * card must not start with a different station from the one the card names.
   */
  ordered(readings, { leading: index }) {
    if (index == null) return readings
    const primary = readings.find((reading) => reading.index === index)
    if (primary == null) return readings
    return [primary, ...readings.filter((reading) => reading.index !== index)]
  },
})

const WeatherPrimaryStationMaxDistance = 80

/** The reading the Now card leads with (docs/MESHWX_UI.md §8). */
export const WeatherPrimaryStation = Object.freeze({
  maxDistanceKilometres: WeatherPrimaryStationMaxDistance,

  reading(value) {
    return { kind: 'reading', value }
  },
  /** Nothing within reach; the nearest is named with its distance instead. */
  noneNearby({ nearest }) {
    return { kind: 'noneNearby', nearest }
  },
  noObservations: Object.freeze({ kind: 'noObservations' }),
  noPlace: Object.freeze({ kind: 'noPlace' }),

  /** The station whose reading the card is showing, when it is showing one. */
  index(primary) {
    return primary.kind === 'reading' ? primary.value.index : null
  },

  /**
   * Fresh with a temperature, then fresh, then stale but young enough to show with its age (with a
   * temperature, then without), then anything — each the nearest within 80 km. All fields come
   * from the one station chosen. A nearby station silent for a day must not hide one a little
   * further off that reported five hours ago: the page would ask instead of showing it.
   */
  pick({ readings, place }) {
    if (readings.length === 0) return WeatherPrimaryStation.noObservations
    if (place == null) return WeatherPrimaryStation.noPlace
    const inReach = readings.filter(
      (reading) => (reading.distanceKilometres ?? Infinity) <= WeatherPrimaryStationMaxDistance,
    )
    const choice =
      inReach.find((reading) => !reading.isStale && reading.stored.observation.temp_f != null) ??
      inReach.find((reading) => !reading.isStale) ??
      inReach.find((reading) => !reading.isTooOld && reading.stored.observation.temp_f != null) ??
      inReach.find((reading) => !reading.isTooOld) ??
      inReach.find((reading) => reading.stored.observation.temp_f != null) ??
      inReach[0]
    if (choice != null) return WeatherPrimaryStation.reading(choice)
    return WeatherPrimaryStation.noneNearby({ nearest: readings[0] })
  },
})
