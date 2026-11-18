// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherNames.swift

import { MeshWXPlaceNames } from '../meshwx/index.js'

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC', 'PR', 'VI', 'GU', 'AS', 'MP',
])

const STATION_ABBREVIATIONS = Object.freeze({
  ARPT: 'Airport', AIRPT: 'Airport', AP: 'Airport',
  INTL: 'International', RGNL: 'Regional', REGL: 'Regional', CNTRL: 'Central',
  MUNI: 'Municipal', MEM: 'Memorial', FLD: 'Field', CNTY: 'County', MTN: 'Mountain',
  FT: 'Fort', ST: 'St',
})

/** Swift's `split(separator: " ")`, which omits the empty pieces JS keeps. */
function words(text) {
  return text.split(' ').filter((word) => word.length > 0)
}

/**
 * Turning the bundle's names into words a person reads (docs/MESHWX_UI.md §3 A12).
 *
 * The tables are NOAA's: station names in capitals with aviation abbreviations
 * ("DRAUGHON-MILLER CNTRL TX RGNL ARPT"), forecast points with a county and state stuck on the end
 * ("Austin Camp Mabry-Travis TX"), census places in capitals. Places follow spec §16.2
 * (`MeshWXPlaceNames`), the weather bot's rule; station names add state codes and abbreviations.
 */
export const WeatherNames = Object.freeze({
  stateCodes: STATE_CODES,
  stationAbbreviations: STATION_ABBREVIATIONS,

  /**
   * Capitals to title case by the place rule's word casing (`MeshWXPlaceNames`), keeping state
   * codes in capitals too, as station names carry them ("CNTRL TX RGNL ARPT").
   * A name already in mixed case is left alone: it was not the bundle's to shout.
   */
  titleCased(raw, { expanding = {} } = {}) {
    if (raw !== raw.toUpperCase()) return raw
    return MeshWXPlaceNames.titleCased(raw, { keepingUpper: STATE_CODES, expanding })
  },

  /** A `places.json` name as shown (spec §16.2): "ADJUNTAS ZONA URBANA" → "Adjuntas". */
  placeName(raw) {
    return MeshWXPlaceNames.placeName(raw)
  },

  /**
   * **The one function a bundle name is shown through** (docs/MESHWX_UI.md §3.1 U-25, U-26).
   *
   * One site read "Austin-Camp Mabry", the next "Austin Camp Mabry" and the third "Austin Camp
   * Mabry, TX", because three call sites each did their own tidying. Every name on screen comes
   * through here now, and `qualified` is the **only** thing that varies: whether the bundle's
   * trailing "-…" is a qualifier this name can be shown without.
   *
   * It has to vary, because the two tables mean opposite things by a hyphen. A station's is part
   * of its name — "AUSTIN-BERGSTROM INTL AIRPORT" — and 81 of the 205 hyphenated station names
   * would lose half of themselves to the point rule. A forecast point's hyphen always separates
   * the name from where it is.
   *
   * The casing is judged on the **whole** name, before any tail comes off: "351001
   * (PATJENS)-Sherman OR" is a mixed-case name the bundle did not shout.
   */
  displayName(raw, { qualified }) {
    const cased = WeatherNames.titleCased(raw, { expanding: STATION_ABBREVIATIONS })
    return qualified ? WeatherNames.withoutQualifier(cased) : cased
  },

  /** "DRAUGHON-MILLER CNTRL TX RGNL ARPT" → "Draughon-Miller Central TX Regional Airport". */
  stationName(raw) {
    return WeatherNames.displayName(raw, { qualified: false })
  },

  /**
   * A forecast point's name without the bundle's tail: "Austin Camp Mabry-Travis TX" → "Austin
   * Camp Mabry". Internal on purpose: a point is **shown** by `pointLabel`, which keeps the state
   * on, so no screen can show the bare head while its neighbour shows the labelled one.
   */
  pointName(raw) {
    return WeatherNames.displayName(raw, { qualified: true })
  },

  /**
   * "Austin Camp Mabry, TX" — **the way a forecast point is named**, everywhere one is named
   * (docs/MESHWX_UI.md §3.1 U-25). The state stays on because it is what tells two of them apart.
   * A point whose tail is a town, not a state, is left with its name alone.
   */
  pointLabel(raw) {
    const name = WeatherNames.pointName(raw)
    const state = WeatherNames.pointState(raw)
    return state == null ? name : `${name}, ${state}`
  },

  /** A forecast point's state from its bundle name, "Austin Camp Mabry-Travis TX" → "TX". */
  pointState(raw) {
    if (!raw.includes('-')) return null
    const parts = words(raw)
    const last = parts[parts.length - 1]
    if (last == null || last.length !== 2 || !/^\p{Lu}{2}$/u.test(last)) return null
    return last
  },

  /**
   * The bundle's tail on a forecast point's name, dropped once: a county and state ("-Travis TX"),
   * or the town the point is named for ("-San Juan"). The town form is only a qualifier when the
   * head is a name on its own — more than one word — so a point called "Boerne-Kendall TX" keeps
   * its county rule and one called "Foo-Bar" keeps its name.
   */
  withoutQualifier(raw) {
    const dash = raw.lastIndexOf('-')
    if (dash < 0) return raw
    const head = raw.slice(0, dash).trim()
    const tail = raw.slice(dash + 1).trim()
    if (head.length === 0 || tail.length === 0) return raw
    const parts = words(tail)
    const last = parts[parts.length - 1]
    const isCountyAndState = parts.length >= 2 && last.length === 2 && STATE_CODES.has(last)
    if (!isCountyAndState && !head.includes(' ')) return raw
    return head
  },

  /**
   * "ROUND ROCK", "TX" → "Round Rock, TX" (spec §16.2), or — with `near` and `tables` — the label
   * for a coordinate: the nearest place of any size worth naming within 25 km.
   *
   * The two Swift overloads `placeLabel(name:state:)` and `placeLabel(near:tables:)` are one
   * function here, told apart by the labels the caller passes.
   */
  placeLabel(options) {
    if (options.near != null) {
      const place = options.tables.nearestPlace({
        toLat: options.near.latitude,
        lon: options.near.longitude,
      })
      return place == null ? null : WeatherNames.placeLabel({ name: place.name, state: place.state })
    }
    return MeshWXPlaceNames.label({ name: options.name, state: options.state })
  },
})
