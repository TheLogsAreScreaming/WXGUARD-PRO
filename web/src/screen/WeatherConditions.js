// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherConditions.swift

import { MeshWXSky } from '../meshwx/index.js'
import { WeatherStoredObservation } from '../weather/index.js'
import { WeatherNames } from './WeatherNames.js'
import { WeatherStations } from './WeatherStations.js'

/**
 * A weather station near the place that the phone holds no good reading from ("Luis Munoz Marin
 * International Airport, 11 km"): the one station worth asking for by its code.
 */
export const WeatherNearbyStation = Object.freeze({
  make({ icao, name, kilometres }) {
    return { icao, name, kilometres }
  },
})

const GOOD_READING_KILOMETRES = 25
const LABELLED_READING_KILOMETRES = 40

/**
 * What a place's page leads with, and when it leads with nothing (docs/MESHWX_UI.md §8).
 *
 * A temperature on the page is a claim about the weather *here*. The owner's threshold decides
 * when that claim can be made: the reading the phone holds must be within `goodReadingKilometres`
 * of the place and no more than twelve hours old. One over two hours old (`isStale`) is still
 * shown, labelled with its age: "No current conditions" while the phone held a reading from five
 * hours ago told the reader less than the phone knew (owner decision 2026-10-16).
 *
 * Past that, up to `labelledReadingKilometres`, a fresh reading is still shown, **attributed to
 * its station** — "Nearest report: San Marcos, 26 km away" — rather than passed off as the town's
 * (owner decision 2026-09-18, docs/MESHWX_UI.md §3.1 U-2a). Wimberley's nearest station is 25.5 km
 * off: under a hard 25 km cliff its page asked, the answer arrived, and the page threw it away.
 * Further than that, or over twelve hours old (`isTooOld`), a reading answers a different question
 * and the page shows the ask instead, naming the station a refresh would spend airtime on — or, when no station is
 * close enough for its answer to be shown, says so and asks for nothing.
 *
 * `WeatherUpdatePlan` reads its readings step **off this verdict**, so the sentence on the page and
 * the packet on the air are always the same station. They used to be worked out twice, and the two
 * drifted: the page offered to ask about a station while Update called it current.
 */
export const WeatherConditions = Object.freeze({
  /**
   * **Tunable** (docs/MESHWX_UI.md §8): how close a reading has to be to speak for the place.
   * Readings reach 80 km (`WeatherPrimaryStation.maxDistanceKilometres`) for the stations list and
   * for what a Places row shows; this is the narrower distance at which the page is willing to
   * print one number and call it the temperature here.
   */
  goodReadingKilometres: GOOD_READING_KILOMETRES,
  /**
   * **Tunable** (docs/MESHWX_UI.md §3.1 U-2a): how close a reading has to be to be shown at all,
   * attributed to its station, when it is too far to be the temperature here. Also the furthest
   * the page will spend a packet on.
   */
  labelledReadingKilometres: LABELLED_READING_KILOMETRES,

  /** A good reading: this is the weather here. */
  reading(value) {
    return { kind: 'reading', value }
  },
  /**
   * A fresh reading too far off to be the weather here but near enough to show, under its
   * station's name and distance. `nearer` is a closer bundled station worth asking by code: the
   * page shows what it holds, and Update asks for something better.
   */
  nearby(value, { nearer }) {
    return { kind: 'nearby', value, nearer }
  },
  /** No good reading, and a station to ask about by code. */
  ask({ icao, kilometres }) {
    return { kind: 'ask', icao, kilometres }
  },
  /**
   * Nothing has ever arrived: the hourly batch is what fills this in, and it is not a place
   * problem.
   */
  noneYet: Object.freeze({ kind: 'noneYet' }),
  /** No station near enough to ask about, with the nearest one there is for naming it. */
  noStation({ nearest }) {
    return { kind: 'noStation', nearest }
  },
  noPlace: Object.freeze({ kind: 'noPlace' }),

  /** The station whose reading is on the page, when one is. */
  readingOf(conditions) {
    return conditions.kind === 'reading' || conditions.kind === 'nearby' ? conditions.value : null
  },

  /**
   * **The one rule**, for the page and for a Places row alike (docs/MESHWX_UI.md §3.1 U-2): a
   * reading speaks for a place when it is within `goodReadingKilometres` of it and is not too old
   * to show (`MeshWXPresentation.observationShownForMinutes`). A stale one is shown with its age,
   * on the page and in the row alike.
   *
   * The row used to reach 80 km and show anything it found, so Places read "86° Partly cloudy ·
   * 3 h old" for a place whose own page said "No current conditions" — the list and the page
   * contradicting each other about the same town, one tap apart.
   */
  isGood({ kilometres, isTooOld = false }) {
    if (kilometres == null || isTooOld) return false
    return kilometres <= GOOD_READING_KILOMETRES
  },

  /**
   * A reading the page will show at all: good, or within `labelledReadingKilometres` to be shown
   * under its station's name. Not too old either way. The same rule for a Places row.
   */
  isShowable({ kilometres, isTooOld = false }) {
    if (kilometres == null || isTooOld) return false
    return kilometres <= LABELLED_READING_KILOMETRES
  },

  make({ primary, nearbyStation }) {
    switch (primary.kind) {
      case 'reading': {
        const reading = primary.value
        const kilometres = reading.distanceKilometres ?? Infinity
        if (WeatherConditions.isGood({ kilometres: reading.distanceKilometres, isTooOld: reading.isTooOld })) {
          return WeatherConditions.reading(reading)
        }
        // Too far to speak for the place: asking that same station again would not bring it
        // closer, so a nearer bundled station is the one worth a packet — while its answer could
        // be shown.
        const nearer =
          nearbyStation != null &&
          nearbyStation.icao !== reading.station.icao &&
          kilometres > GOOD_READING_KILOMETRES &&
          nearbyStation.kilometres <= LABELLED_READING_KILOMETRES
            ? nearbyStation
            : null
        // Near enough to show, and young enough: shown under its own name, never as the town's.
        if (WeatherConditions.isShowable({ kilometres: reading.distanceKilometres, isTooOld: reading.isTooOld })) {
          return WeatherConditions.nearby(reading, { nearer })
        }
        if (nearer != null) return WeatherConditions.ask({ icao: nearer.icao, kilometres: nearer.kilometres })
        // Near enough to show once it reports again: the station itself is the one to ask about.
        if (kilometres <= LABELLED_READING_KILOMETRES) {
          return WeatherConditions.ask({ icao: reading.station.icao, kilometres: reading.distanceKilometres })
        }
        // Nothing close enough for an answer to be shown: say so, and spend nothing.
        return WeatherConditions.noStation({ nearest: reading })
      }
      case 'noneNearby': {
        if (nearbyStation == null || nearbyStation.kilometres > LABELLED_READING_KILOMETRES) {
          return WeatherConditions.noStation({ nearest: primary.nearest })
        }
        return WeatherConditions.ask({ icao: nearbyStation.icao, kilometres: nearbyStation.kilometres })
      }
      case 'noObservations':
        return WeatherConditions.noneYet
      default:
        return WeatherConditions.noPlace
    }
  },
})

/**
 * What a Places row shows for its place (docs/MESHWX_UI.md §12): the reading the place's own page
 * would lead with, and "—" when that page would lead with nothing.
 *
 * It is **the same rule as the page's** (`WeatherConditions.isGood`). The row used to reach 80 km
 * and show whatever it found, stale or not, so the list and the page said different things about
 * the same town one tap apart (docs/MESHWX_UI.md §3.1 U-2). A row is a hint, but a hint that
 * contradicts the page it opens is worse than no hint.
 */
export const WeatherPlaceRowReading = Object.freeze({
  make(options) {
    // The memberwise initialiser, when it is handed values rather than readings.
    if (options.readings === undefined) {
      const { tempF = null, sky = null, observedAt = null, isStale = false, attributedStation = null } = options
      return { tempF, sky, observedAt, isStale, attributedStation }
    }
    const { readings, at: coordinate, now } = options
    const near = WeatherStations.nearestReading({
      in: readings,
      to: coordinate,
      within: WeatherConditions.labelledReadingKilometres,
    })
    if (
      near == null ||
      !WeatherConditions.isShowable({
        kilometres: near.kilometres,
        isTooOld: WeatherStoredObservation.isTooOld(near.reading.stored, { at: now }),
      })
    ) {
      return WeatherPlaceRowReading.make({})
    }
    const observation = near.reading.stored.observation
    return {
      tempF: observation.temp_f ?? null,
      // No cloud or weather group in the report: no condition word rather than a made-up sky.
      sky: observation.sky === MeshWXSky.other ? null : observation.sky,
      observedAt: WeatherStoredObservation.observedAt(near.reading.stored),
      isStale: WeatherStoredObservation.isStale(near.reading.stored, { at: now }),
      attributedStation:
        near.kilometres > WeatherConditions.goodReadingKilometres
          ? WeatherNames.stationName(near.reading.station.name)
          : null,
    }
  },

  /** Nothing is held for this place: the row reads "—" rather than a bare degree sign. */
  isEmpty(row) {
    return row.observedAt == null
  },
})

/**
 * A place the phone holds nothing for: no reading good enough to be its temperature (§8) **and**
 * no forecast for its point (§9).
 *
 * The Llano page was three separate refusals stacked down the screen — a blocked-request caption,
 * "No current conditions for Llano…", "No forecast for Llano yet…" — which reads as the app
 * failing three times rather than as one place the channel has not carried yet. The 25 km rule
 * that produces them is unchanged and is not the complaint (docs/MESHWX_UI.md §3.1 U-13).
 */
export const WeatherEmptyPlace = Object.freeze({
  /**
   * Nothing near enough to spend airtime on: the card says so instead of offering an ask that
   * would come back empty.
   */
  hasNothingToAsk(empty) {
    return empty.stationICAO == null && empty.pointName == null
  },

  /**
   * Nil unless the page would say no to both the weather and the forecast. A page with either one
   * keeps the two sections it has always had.
   */
  make({ conditions, forecast }) {
    switch (conditions.kind) {
      case 'reading':
      case 'nearby':
      case 'noPlace':
        return null
      default:
        break
    }
    const empty = { stationICAO: null, stationKilometres: null, pointName: null, pointKilometres: null }
    if (conditions.kind === 'ask') {
      empty.stationICAO = conditions.icao
      empty.stationKilometres = conditions.kilometres
    }
    switch (forecast.kind) {
      case 'noPlace':
      case 'forecast':
        return null
      case 'missing':
        empty.pointName = forecast.point.name
        empty.pointKilometres = forecast.kilometres
        break
      default:
        break
    }
    return empty
  },
})
