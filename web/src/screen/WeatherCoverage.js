// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherCoverage.swift

import { MeshWXCoverage, MeshWXGeometry, MeshWXTables } from '../meshwx/index.js'
import { WeatherStoredObservation } from '../weather/index.js'
import { WeatherGeo } from './WeatherGeo.js'

/**
 * What a coverage test needs from the bundled outlines: the areas a *place* is in.
 *
 * `WeatherAreaGeometry` answers the other way round — how far one named area is from a place —
 * which is what the alerts card asks. Reading a bot's own statement asks this way: the statement
 * names zones, and the question is whether the place is in one of them.
 *
 * In JS this is a shape, not a type: any object with `isLoaded` and
 * `areaCodes({ near, withinKilometres })` is one.
 */
export const WeatherPlaceAreas = Object.freeze({
  /** The port of `extension MeshWXGeometry: WeatherPlaceAreas`. */
  of(geometry) {
    return {
      get isLoaded() {
        return geometry.isZoneFileLoaded && geometry.isCountyFileLoaded
      },
      areaCodes({ near, withinKilometres }) {
        return geometry.areaCodes({ near, withinKilometres })
      },
    }
  },

  shared() {
    return WeatherPlaceAreas.of(MeshWXGeometry.shared)
  },
})

/** What the evidence says about a place and a bot's area. */
export const WeatherCoverageVerdict = Object.freeze({
  inside: 'inside',
  /**
   * The only verdict that may be read as "outside": a bot's own complete statement, or — with
   * nothing stated — its station footprint.
   */
  outside: 'outside',
  /**
   * Nothing said yet, a list the bot had to cut, or outlines that have not loaded. A cut list
   * means "not listed", never "not covered" (spec §10), and unknown is where that lands.
   */
  unknown: 'unknown',
})

/**
 * Whether a place is in a bot's area, and from what evidence:
 * `{ stations, stated, tables, areas }`.
 *
 * First the bot's own statement (Coverage, spec §10): its circle and the zones it lists. That is
 * the only thing that describes coverage, and the reason the message exists — guessing from the
 * hourly stations and from the offices of whatever warnings were active told a real phone that
 * WX-AUS "may not carry alerts for Travis County", the bot's own home county (§3.1 I-B18).
 *
 * Failing a statement, the footprint the bot has demonstrated: the stations in its scheduled
 * batches (docs/MESHWX_UI.md §6). A batch of one station is the answer to somebody's
 * single-station request — a `>o KJFK` would otherwise put Manhattan "in coverage" — so only
 * multi-station batches count, and only from the last 24 hours on the bot's clock.
 *
 * A place is in that footprint when it is inside the convex hull of the bot's stations, or within
 * `stationReachKilometres` of one of them. The bot relays alerts for about 120 km around its home
 * but reports only the nearest reporting stations inside that circle, the farthest about 96 km out
 * for WX-AUS. A fixed reach around every station therefore ran well past the alert area. The hull
 * stays inside the area: a place between its edge and the area's is called out of coverage, which
 * is the side to err on.
 *
 * Either way, "outside" needs evidence.
 */
export const WeatherCoverage = Object.freeze({
  footprintWindow: 24 * 60 * 60,
  /**
   * A place this close to a footprint station is in that bot's coverage, inside the hull or not:
   * just past an outer station, or near a bot with one or two stations, which has no hull.
   */
  stationReachKilometres: 20,

  /** One entry per bot and station: a station two bots report is in both footprints. */
  Station: Object.freeze({
    make({ index, station, botID }) {
      return { index, station, botID }
    },
    coordinate(entry) {
      return { latitude: entry.station.lat, longitude: entry.station.lon }
    },
  }),

  /** One bot's own statement of its area (spec §10), and when it arrived. */
  Stated: Object.freeze({
    make({ botID, coverage, receivedAt }) {
      return { botID, coverage, receivedAt }
    },
  }),

  make(options) {
    // `WeatherCoverage(stations:stated:tables:areas:)`, the memberwise initialiser, when it is
    // handed stations rather than bot states.
    if (options.stations !== undefined) {
      return {
        stations: options.stations,
        stated: options.stated ?? {},
        tables: options.tables ?? MeshWXTables.shared,
        areas: options.areas ?? WeatherPlaceAreas.shared(),
      }
    }
    const { states, tables, now, areas = WeatherPlaceAreas.shared() } = options
    const stations = []
    const stated = {}
    for (const [key, state] of Object.entries(states)) {
      const botID = Number(key)
      // A statement does not go stale the way a batch does: it describes the bot, not an hour.
      if (state.coverage != null) {
        stated[String(botID)] = WeatherCoverage.Stated.make({
          botID,
          coverage: state.coverage.coverage,
          receivedAt: state.coverage.receivedAt,
        })
      }
      for (const [indexKey, stored] of Object.entries(state.observations ?? {})) {
        const lastBatchAt = WeatherStoredObservation.lastBatchAt(stored)
        if (lastBatchAt == null || (now - lastBatchAt) / 1000 > WeatherCoverage.footprintWindow) continue
        const index = Number(indexKey)
        const station = tables.station({ at: index })
        if (station == null) continue
        stations.push(WeatherCoverage.Station.make({ index, station, botID }))
      }
    }
    stations.sort((lhs, rhs) => (lhs.index !== rhs.index ? lhs.index - rhs.index : lhs.botID - rhs.botID))
    return { stations, stated, tables, areas }
  },

  /**
   * The Swift's custom `==`: the tables and the outlines are not part of the value — two coverages
   * with the same stations and the same statements are the same coverage whichever bundle read
   * them.
   */
  equals(lhs, rhs) {
    return JSON.stringify(lhs.stations) === JSON.stringify(rhs.stations)
      && JSON.stringify(lhs.stated) === JSON.stringify(rhs.stated)
  },

  /** No evidence of any kind: no bot has stated its coverage or reported a scheduled batch. */
  isEmpty(coverage) {
    return coverage.stations.length === 0 && Object.keys(coverage.stated).length === 0
  },

  nearest(coverage, { to: point }) {
    let best = null
    for (const station of coverage.stations) {
      const kilometres = WeatherGeo.kilometres(point, WeatherCoverage.Station.coordinate(station))
      if (best == null || kilometres < best.kilometres) best = { station, kilometres }
    }
    return best
  },

  contains(coverage, point) {
    return WeatherCoverage.botIDs(coverage, { covering: point }).size > 0
  },

  /**
   * The bots whose area covers a point — or a place, with the place's uncertainty included: what
   * each one says about itself, else its footprint. The two Swift overloads are told apart by
   * whether the value carries a `coordinate`.
   */
  botIDs(coverage, { covering }) {
    const isPlace = covering != null && covering.coordinate !== undefined
    return new Set(
      [...WeatherCoverage.evidenceBotIDs(coverage)].filter((botID) =>
        isPlace
          ? WeatherCoverage.verdict(coverage, { of: botID, for: covering }) === WeatherCoverageVerdict.inside
          : WeatherCoverage.verdict(coverage, { of: botID, covering, withinKilometres: 0 }) ===
            WeatherCoverageVerdict.inside,
      ),
    )
  },

  /**
   * Every bot with something to say about a place: one that stated its coverage, or one with
   * stations in its footprint.
   */
  evidenceBotIDs(coverage) {
    return new Set([
      ...Object.keys(coverage.stated).map(Number),
      ...coverage.stations.map((station) => station.botID),
    ])
  },

  // MARK: - Verdicts

  /**
   * The four Swift `verdict` overloads, told apart by the labels passed:
   *
   * - `{ for: place }` — what every bot's evidence together says about a place. Inside as soon as
   *   one bot's area covers it. Otherwise unknown if any bot cannot say, because one bot's
   *   "outside" says nothing about a place another may carry. Outside only when at least one bot's
   *   evidence puts it outside and no bot leaves it open; with no evidence at all, unknown.
   * - `{ of: botID, for: place }` — one bot against a place.
   * - `{ of: botID, covering: point, withinKilometres }` — one bot: its own statement where it has
   *   made one, its station footprint where it has not.
   * - `{ statement, covering: point, withinKilometres }` — what one statement says about a point
   *   (spec §10). Inside on the stated circle, on a stated run, or on a statement with no area
   *   filter at all. Outside only when both lists are whole, the bot listed zones to test against,
   *   and the place resolved to UGCs that none of the runs covers. Everything else is unknown.
   */
  verdict(coverage, options) {
    if (options.statement !== undefined) {
      const { statement, covering: point, withinKilometres: radius } = options
      if (MeshWXCoverage.hasNoAreaFilter(statement)) return WeatherCoverageVerdict.inside
      if (MeshWXCoverage.circleContains(statement, point)) return WeatherCoverageVerdict.inside
      const codes = WeatherCoverage.areaCodes(coverage, { near: point, withinKilometres: radius })
      if (codes.some((ugc) => MeshWXCoverage.covers(statement, { ugc, states: coverage.tables.states }))) {
        return WeatherCoverageVerdict.inside
      }
      if (!MeshWXCoverage.isComplete(statement)) return WeatherCoverageVerdict.unknown
      // The runs are the only list that speaks about a place. The office list can deny an office
      // (`uncarriedOffice`) but never place a point, so a statement without runs settles nothing.
      if ((statement.areas ?? []).length === 0 || codes.length === 0) return WeatherCoverageVerdict.unknown
      return WeatherCoverageVerdict.outside
    }

    if (options.of !== undefined) {
      const botID = options.of
      const point = options.for !== undefined ? options.for.coordinate : options.covering
      const radius = options.for !== undefined ? options.for.uncertaintyKilometres : options.withinKilometres
      const statement = coverage.stated[String(botID)]?.coverage
      if (statement != null) {
        return WeatherCoverage.verdict(coverage, { statement, covering: point, withinKilometres: radius })
      }
      const footprint = coverage.stations.filter((station) => station.botID === botID)
      if (footprint.length === 0) return WeatherCoverageVerdict.unknown
      return WeatherCoverage.footprint(footprint, { covers: point })
        ? WeatherCoverageVerdict.inside
        : WeatherCoverageVerdict.outside
    }

    const place = options.for
    let sawOutside = false
    let sawUnknown = false
    for (const botID of WeatherCoverage.evidenceBotIDs(coverage)) {
      switch (WeatherCoverage.verdict(coverage, { of: botID, for: place })) {
        case WeatherCoverageVerdict.inside:
          return WeatherCoverageVerdict.inside
        case WeatherCoverageVerdict.outside:
          sawOutside = true
          break
        default:
          sawUnknown = true
      }
    }
    return sawOutside && !sawUnknown ? WeatherCoverageVerdict.outside : WeatherCoverageVerdict.unknown
  },

  /**
   * The counties and zones a place could be in: the ones it lies in, plus any within its
   * uncertainty. Empty while the outlines load, which is why empty never reads as "outside".
   */
  areaCodes(coverage, { near: point, withinKilometres: radius }) {
    if (!coverage.areas.isLoaded) return []
    return coverage.areas.areaCodes({ near: point, withinKilometres: Math.max(0, radius) })
  },

  // MARK: - Offices

  /**
   * The place's forecast office when no bot answering for it says it carries that office
   * (spec §10, docs/MESHWX_UI.md §3.1 I-B18 and §7.4).
   *
   * The bot's own word and nothing weaker: every bot that could answer for the place must have
   * stated its offices with the office-cut flag clear, and none of them may list the place's
   * office. A bot that has stated nothing, a cut list, an office any of them carries, or a place
   * with no office to name all mean the app has nothing to say.
   */
  uncarriedOffice(coverage, { for: place }) {
    const answering = [...WeatherCoverage.evidenceBotIDs(coverage)].filter(
      (botID) => WeatherCoverage.verdict(coverage, { of: botID, for: place }) !== WeatherCoverageVerdict.outside,
    )
    if (answering.length === 0) return null
    const offices = WeatherCoverage.placeOffices(coverage, { for: place })
    if (offices.size === 0) return null
    for (const botID of answering) {
      const statement = coverage.stated[String(botID)]?.coverage
      if (statement == null || statement.offices_cut || (statement.offices ?? []).length === 0) return null
      const carried = new Set(
        (statement.offices ?? []).map((index) => coverage.tables.officeCode(index)).filter((code) => code != null),
      )
      if ([...offices].some((office) => carried.has(office))) return null
    }
    return [...offices].sort()[0]
  },

  /**
   * The NWS forecast offices of the zones a place is in (`zones.json` `wfo`). Counties carry no
   * office of their own and drop out.
   */
  placeOffices(coverage, { for: place }) {
    const codes = WeatherCoverage.areaCodes(coverage, {
      near: place.coordinate,
      withinKilometres: place.uncertaintyKilometres,
    })
    return new Set(codes.map((ugc) => coverage.tables.zone(ugc)?.office).filter((office) => office != null))
  },

  /** One bot's stations: within reach of one, or inside their hull. */
  footprint(stations, { covers: point }) {
    if (
      stations.some(
        (station) =>
          WeatherGeo.kilometres(point, WeatherCoverage.Station.coordinate(station)) <=
          WeatherCoverage.stationReachKilometres,
      )
    ) {
      return true
    }
    // Kilometres east and north of the point on a flat projection: over a footprint a couple of
    // hundred kilometres across the error is far below the reach.
    const cosLatitude = Math.cos((point.latitude * Math.PI) / 180)
    const planar = stations.map((station) => {
      let longitude = station.station.lon - point.longitude
      if (longitude > 180) longitude -= 360
      else if (longitude < -180) longitude += 360
      return { x: longitude * 111.32 * cosLatitude, y: (station.station.lat - point.latitude) * 110.574 }
    })
    const hull = convexHull(planar)
    if (hull.length < 3) return false
    // Counter-clockwise: the point (the origin) is inside, or on the edge, when it is to the right
    // of no edge.
    const origin = { x: 0, y: 0 }
    for (let index = 0; index < hull.length; index += 1) {
      if (cross(hull[index], hull[(index + 1) % hull.length], origin) < 0) return false
    }
    return true
  },
})

/** Andrew's monotone chain: the hull counter-clockwise, points on an edge dropped. */
function convexHull(points) {
  const sorted = [...points].sort((lhs, rhs) => (lhs.x !== rhs.x ? lhs.x - rhs.x : lhs.y - rhs.y))
  if (sorted.length < 3) return sorted
  const chain = (ordered) => {
    const built = []
    for (const point of ordered) {
      while (built.length >= 2 && cross(built[built.length - 2], built[built.length - 1], point) <= 0) {
        built.pop()
      }
      built.push(point)
    }
    return built
  }
  const lower = chain(sorted)
  const upper = chain([...sorted].reverse())
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** Positive when `point` is to the left of the line from `start` to `end`. */
function cross(start, end, point) {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x)
}
