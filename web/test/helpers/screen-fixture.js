// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherScreenFixture.swift, plus the
// pieces of WeatherTestSupport.swift the screen suites use.
//
// The state is built as literal objects — the shapes of `src/weather/WeatherBotState.js` and the
// decoded messages of docs/meshwx_v5_vectors.json — rather than driven through the reducer, so a
// screen test fails for a screen rule and for nothing else.

import { MeshWXGeometry, MeshWXSky, MeshWXTables } from '../../src/meshwx/index.js'
import { nodeBundleLoader } from '../../src/meshwx/nodeLoader.js'
import { WeatherAreaGeometry } from '../../src/screen/index.js'
import { WeatherPlaceAreas } from '../../src/screen/WeatherCoverage.js'

/** Load the bundle once for a whole `node --test` process. */
let tablesPromise = null
export function loadTables() {
  if (tablesPromise == null) tablesPromise = MeshWXTables.load(nodeBundleLoader())
  return tablesPromise
}

/**
 * The outlines, parsed once per process. The Swift's `MeshWXGeometry.shared` finds the bundle on
 * its own; the JS one is given a loader (docs/PORTING.md §8).
 */
let geometryPromise = null
export function loadGeometry() {
  if (geometryPromise == null) {
    MeshWXGeometry.configure(nodeBundleLoader())
    geometryPromise = MeshWXGeometry.shared.preload().then(() => MeshWXGeometry.shared)
  }
  return geometryPromise
}

/** The loaded outlines as the alerts card reads them. */
export function loadedGeometry() {
  return WeatherAreaGeometry.of(MeshWXGeometry.shared)
}

/** The loaded outlines as a coverage test reads them. */
export function loadedAreas() {
  return WeatherPlaceAreas.of(MeshWXGeometry.shared)
}

/** A `MeshWXStationObservation` as the decoder hands one over (spec §6). */
export function observation({ station, tempF = null, sky = MeshWXSky.few, windMph = 0, ageMinutes = null }) {
  return {
    station,
    temp_f: tempF,
    dewpoint_f: null,
    wind_dir_deg: 0,
    wind_dir: 'N',
    sky,
    wind_mph: windMph,
    gust_mph: 0,
    visibility_mi: null,
    pressure_inhg: null,
    humidity_pct: null,
    feels_delta_f: 0,
    age_min: ageMinutes,
  }
}

/** A `MeshWXForecastPeriod` as the decoder hands one over (spec §7). */
export function period({
  highF = null,
  lowF = null,
  popPercent = null,
  sky = 15,
  thunder = false,
  wintry = false,
  windy = false,
  fog = false,
  windDirectionDegrees = 0,
  windMph = 0,
}) {
  return {
    high_f: highF,
    low_f: lowF,
    pop_pct: popPercent,
    sky,
    thunder,
    wintry,
    windy,
    fog,
    wind_dir_deg: windDirectionDegrees,
    wind_dir: 'N',
    wind_mph: windMph,
  }
}

/** A `MeshWXWarning` as the decoder hands one over (spec §3). */
export function warning({
  event,
  office = 35,
  etn,
  expiresMinutes,
  tornado = 0,
  floodDamage = 0,
  polygon = null,
  areas = null,
  issuedMinutes = null,
  beginsMinutes = null,
}) {
  return {
    event,
    office,
    etn,
    expires_min: expiresMinutes,
    tornado,
    flood_source: 0,
    flood_damage: floodDamage,
    hail_qin: 0,
    wind_mph: 0,
    update: false,
    source: 0,
    polygon,
    areas,
    issued_min: issuedMinutes,
    begins_min: beginsMinutes,
  }
}

/** A `MeshWXDigest` as the decoder hands one over (spec §5). */
export function digest({ nowMinutes, feedHealth = 3, entries = [] }) {
  return {
    now_min: nowMinutes,
    feed_health: feedHealth,
    entries: entries.map((entry) => ({
      event: entry.identity.event,
      office: entry.identity.office,
      etn: entry.identity.etn,
      expires_rel: entry.expiresRelativeMinutes,
      expires_min: entry.expiresMinutes ?? nowMinutes + entry.expiresRelativeMinutes,
    })),
    source: 0,
  }
}

/** A `MeshWXCoverage` as the decoder hands one over (spec §10). */
export function coverageMessage({
  latitude,
  longitude,
  radiusKilometres,
  stationCap = 14,
  officeIndices = [],
  areas = [],
  areasCut = false,
  officesCut = false,
}) {
  return {
    lat: latitude,
    lon: longitude,
    radius_km: radiusKilometres,
    stations: stationCap,
    offices: officeIndices,
    areas,
    zones_cut: areasCut,
    offices_cut: officesCut,
  }
}

/** A `MeshWXAreaRun` as the decoder hands one over: `county` is the Swift's `isCounty`. */
export function areaRun({ stateIndex, isCounty, start, run }) {
  return { state: stateIndex, county: isCounty, start, run }
}

/**
 * One radar tile as the app holds it (`WeatherStoredRadarTile`, spec §13, revision 11): the
 * lattice square, the decoded Radar message, when it arrived and where the bot got it.
 *
 * `cells` is `[row, col, level]` triples on a dry grid; `size` 16 makes it a coarse tile and
 * `bounds` (the four-element wire array) a partial one, exactly as the flags are read off the
 * body on the air.
 */
export function storedRadarTile({
  south = 29,
  west = -99,
  zoom = 0,
  size = 32,
  cells = [],
  bounds = null,
  product = 1,
  takenMinutes,
  receivedAt,
  source = 1,
} = {}) {
  const grid = Array.from({ length: size }, () => new Array(size).fill(0))
  for (const [row, col, level] of cells) grid[row][col] = level
  const taken = takenMinutes ?? WeatherPhoneFixture.nowMinutes
  return {
    tile: { south, west, zoom },
    radar: {
      seq: 0,
      bot: WeatherPhoneFixture.botID,
      type: 11,
      name: 'radar',
      flags: (size === 16 ? 1 : 0) | (bounds == null ? 0 : 2) | (source << 2),
      taken_min: taken,
      south,
      west,
      zoom,
      product,
      coarse: size === 16,
      partial: bounds != null,
      bounds,
      size,
      rows: grid.map((row) => row.join('')),
      source,
    },
    receivedAt: receivedAt ?? WeatherPhoneFixture.now,
    source,
  }
}

export function botState({ botID, ...rest }) {
  return {
    botID,
    lastSeq: null,
    recentMessages: [],
    lastHeardAt: null,
    lastLiveHeardAt: null,
    needsDigest: false,
    gapDetectedAt: null,
    warnings: {},
    pendingUpgrades: {},
    recentCancels: {},
    digest: null,
    missingFromDigest: [],
    observations: {},
    forecasts: {},
    /** Revision 10: forecasts the bot chose the point for, keyed by the coordinate asked about. */
    unbundledForecasts: {},
    texts: {},
    coverage: null,
    /** Revision 10: several, newest first, where revision 9 held one `areaSweep`. */
    areaSweeps: [],
    ...rest,
  }
}

export function identity({ event, office = 35, etn }) {
  return { event, office, etn }
}

export function identityKey(one) {
  return `${one.event}.${one.office}.${one.etn}`
}

/**
 * The owner's phone as it was at 23:20 CDT on 2026-09-14 (devicectl copy): WX-AUS (bot 0x041D)
 * with its 14-station hourly batch, the bot's Austin Camp Mabry forecast, and New York and
 * San Juan forecasts somebody else asked for. No warnings and no digest.
 */
export const WeatherPhoneFixture = {
  botID: 0x041d,
  /** 2026-09-15 04:20 UTC = 23:20 CDT on the 14th. */
  now: 1_789_446_000 * 1000,
  get nowMinutes() {
    return Math.floor(WeatherPhoneFixture.now / 60000)
  },

  austin: { latitude: 30.2672, longitude: -97.7431 },
  roundRock: { latitude: 30.5083, longitude: -97.6789 },
  dallas: { latitude: 32.7767, longitude: -96.797 },

  /** The Swift fixture's `Calendar`, as the IANA id docs/PORTING.md takes in its place. */
  timeZone: 'America/Chicago',

  stations: [
    [1929, 88], [976, 82], [593, 86], [194, 86], [875, 84], [229, 84], [202, 84],
    [606, 88], [860, 88], [1208, 86], [296, 86], [169, 86], [1014, 86], [1723, 84],
  ],

  dailyForecast({ point, issuedMinutes, temps }) {
    return {
      point,
      issued_min: issuedMinutes,
      first_period: 0,
      periods: temps.map(([highF, lowF]) => period({ highF, lowF, popPercent: 10, sky: MeshWXSky.scattered })),
    }
  },

  state({ observationsAgo = 120 } = {}) {
    const now = WeatherPhoneFixture.now
    const nowMinutes = WeatherPhoneFixture.nowMinutes
    const tsMinutes = Math.floor((now / 1000 - observationsAgo) / 60)
    const observations = {}
    for (const [index, tempF] of WeatherPhoneFixture.stations) {
      observations[String(index)] = {
        observation: observation({ station: index, tempF, sky: MeshWXSky.few, windMph: 5 }),
        timestampMinutes: tsMinutes,
        receivedAt: now - observationsAgo * 1000,
        batchSize: WeatherPhoneFixture.stations.length,
        lastBatchMinutes: tsMinutes,
        source: 0,
      }
    }
    const forecast = (point, issuedMinutes, temps, receivedSecondsAgo) => ({
      forecast: WeatherPhoneFixture.dailyForecast({ point, issuedMinutes, temps }),
      receivedAt: now - receivedSecondsAgo * 1000,
      requestLabel: null,
      requestedHere: false,
      source: 0,
    })
    return botState({
      botID: WeatherPhoneFixture.botID,
      lastHeardAt: now - 420 * 1000,
      lastLiveHeardAt: now - 420 * 1000,
      observations,
      forecasts: {
        // 19:52 CDT.
        103: forecast(103, nowMinutes - 208, [[102, 77], [100, 78], [98, 75], [97, 73], [98, 74], [99, 76], [96, 81]], 540),
        1010: forecast(1010, nowMinutes - 588, [[91, 80], [93, 80], [92, 80], [93, 79], [92, 79], [92, 79], [92, 80]], 540),
        304: forecast(304, nowMinutes - 259, [[72, 60], [79, 66], [80, 68], [82, 64], [77, 66], [79, 64], [75, 66]], 420),
      },
    })
  },

  /** WX-AUS's own statement of its area (spec §10, the vector `coverage_wx_aus`). */
  get statement() {
    return coverageMessage({
      latitude: 30.2672,
      longitude: -97.7431,
      radiusKilometres: 120,
      stationCap: 14,
      officeIndices: [35, 40, 51, 113],
      areas: [
        areaRun({ stateIndex: 42, isCounty: false, start: 155, run: 6 }),
        areaRun({ stateIndex: 42, isCounty: false, start: 170, run: 6 }),
        areaRun({ stateIndex: 42, isCounty: false, start: 186, run: 12 }),
        areaRun({ stateIndex: 42, isCounty: false, start: 205, run: 7 }),
        areaRun({ stateIndex: 42, isCounty: false, start: 221, run: 5 }),
      ],
    })
  },

  /** The bot stating its coverage on top of a state, as the reducer would leave it. */
  stating(coverage, { on = WeatherPhoneFixture.state(), at = WeatherPhoneFixture.now } = {}) {
    return { ...on, coverage: { coverage, receivedAt: at } }
  },

  place(coordinate, { kind = 'current', radius = 0.5, label = 'Austin, TX' } = {}) {
    return {
      kind,
      coordinate,
      label,
      uncertaintyKilometres: radius,
      locatedAt: WeatherPhoneFixture.now,
      zipCode: null,
      searchedAs: 'town',
    }
  },

  /** A bot state keyed by its id, as every screen rule takes its states. */
  states(state = WeatherPhoneFixture.state()) {
    return { [String(state.botID)]: state }
  },
}

/** Geometry whose outlines have not loaded yet. */
export const UnloadedGeometry = Object.freeze({
  isLoaded: false,
  distanceKilometres() {
    return null
  },
  centre() {
    return null
  },
})

/** Areas whose outlines have not loaded yet (`WeatherPlaceAreas`). */
export const UnloadedAreas = Object.freeze({
  isLoaded: false,
  areaCodes() {
    return []
  },
})
