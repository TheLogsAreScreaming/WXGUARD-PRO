// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherAreaSelection.swift
//
// Owner, 20 September 2026: *"Can we go from national alert map to just alert map, and have a way
// for the user to select which areas they want to request the warnings for. One, a few, or all.
// That way we don't default to sending everything."*
//
// So the selection is a thing the device *holds*, not a thing a screen builds each time it opens:
// it is answering "which part of the country am I looking at", and that outlives a visit.

import { MeshWXWire } from '../meshwx/index.js'
import { t } from '../l10n.js'
import { WeatherRequest } from '../weather/index.js'

/**
 * How a set of states is named, wherever one is: "Texas", "Texas and Oklahoma", "Texas, Oklahoma
 * and New Mexico", "6 states".
 *
 * The design writes both joins out ("Texas, Oklahoma · as of 13:40" and "Ask for Texas and
 * Oklahoma"), so the comma folds every pair but the last and the last takes the word. Past
 * `maxNamed` the count is the fact and the names are a wall.
 *
 * Swift keeps this on `WeatherAreaMapCopy` (MC1/Views/Tools/Weather/WeatherAreaMapView.swift),
 * beside the screen it was written for, and `WeatherTrafficCopy` calls across to it. Here the
 * traffic log's words are built in `src/screen` and may not reach into `src/ui` or `src/app`
 * (docs/PORTING.md §9), so the rule itself lives in the pure layer and the *names* are handed to
 * it: `WeatherReferenceNames.stateList` is the one that turns codes into them.
 */
export const WeatherStateList = Object.freeze({
  /**
   * How many states a line names before it gives up and counts them. Three is what fits on one
   * line of a status card at the largest text size the tool is read at.
   */
  maxNamed: 3,

  /** `names` in the order they should read — the caller sorts, or keeps the packet's own order. */
  of(names) {
    const list = (names ?? []).filter((name) => name != null && name !== '')
    if (list.length > WeatherStateList.maxNamed) return t('weather.areaMap.stateCount', list.length)
    const last = list[list.length - 1]
    if (last == null) return ''
    if (list.length === 1) return last
    const head = list.slice(0, -1).reduce((joined, name) => (
      joined === '' ? name : t('weather.areaMap.listJoin', joined, name)
    ), '')
    return t('weather.areaMap.listJoinAnd', head, last)
  },
})

/**
 * Which areas the next alert map should cover: `{ isWholeCountry, states }`.
 *
 * `states` is two-letter codes from `index.json` `states`, upper case, sorted, without
 * duplicates — the form `>wmap` sends and the form the answer slot is keyed by. It is empty when
 * `isWholeCountry`, so the two halves never disagree.
 */
export const WeatherAreaSelection = Object.freeze({
  /** Where the key lives on the device, beside the saved places and the bot choice. */
  defaultsKey: 'weather.areaSelection',

  /**
   * States one request may name (spec §14, revision 10). Past it the tap asks for the whole
   * country instead, **and the screen says so before the tap**: fifteen codes are the whole
   * 40-byte request budget, and silently dropping the sixteenth would draw a map missing a state
   * the user picked.
   */
  maxStates: MeshWXWire.maxSweepScopeStates,

  wholeCountry: Object.freeze({ isWholeCountry: true, states: Object.freeze([]) }),

  make({ isWholeCountry = false, states = [] } = {}) {
    if (isWholeCountry) return { isWholeCountry: true, states: [] }
    const codes = WeatherRequest.sweepStates(states)
    // No states is the whole country: there is no third thing a sweep of nowhere could mean.
    if (codes.length === 0) return { isWholeCountry: true, states: [] }
    return { isWholeCountry: false, states: codes }
  },

  /** A selection read back from persisted JSON, tolerant of anything that is not one. */
  decode(json) {
    if (json == null || typeof json !== 'object') return null
    return WeatherAreaSelection.make({
      isWholeCountry: json.isWholeCountry === true,
      states: Array.isArray(json.states) ? json.states : [],
    })
  },

  /**
   * What is selected on first use: the state of the page's place, or the whole country when the
   * page has no place. A phone that has never touched the picker asks about where it is, which
   * is the cheapest useful answer and the one somebody opening the map during a storm wants.
   */
  default({ stateCode = null } = {}) {
    if (stateCode == null) return WeatherAreaSelection.wholeCountry
    return WeatherAreaSelection.make({ states: [stateCode] })
  },

  /**
   * Whether a tap on this selection would ask for the whole country although states are picked:
   * more than `maxStates` does not fit one request. The screen says this before the tap, so the
   * cost and the button title are never a surprise.
   */
  asksWholeCountry(selection) {
    return selection.isWholeCountry || selection.states.length > WeatherAreaSelection.maxStates
  },

  /** The request one tap sends. */
  request(selection, { includesAdvisories }) {
    return WeatherRequest.areaSweep({
      includesAdvisories,
      states: WeatherAreaSelection.asksWholeCountry(selection) ? [] : selection.states,
    })
  },

  /** The same selection with one state added or removed, for the picker's multi-select. */
  toggling(selection, { state }) {
    const code = String(state).trim().toUpperCase()
    if (code.length === 0) return selection
    const held = selection.isWholeCountry ? [] : selection.states
    const states = held.includes(code)
      ? held.filter((one) => one !== code)
      : [...held, code]
    return WeatherAreaSelection.make({ states })
  },

  isEqual(lhs, rhs) {
    if (lhs == null || rhs == null) return lhs === rhs
    if (lhs.isWholeCountry !== rhs.isWholeCountry) return false
    return lhs.states.join() === rhs.states.join()
  },
})

/**
 * Where the selection lives between visits.
 *
 * The same shape as the tool's other small stores (`WeatherSavedPlacesStore`,
 * `WeatherRequestLogStore`): an injected **synchronous** `{ get(key), set(key, value) }`, which
 * is `WeatherDefaults` in the app and a plain object in a test. Nothing here touches a browser
 * API, so it stays inside the pure layer.
 */
export class WeatherAreaSelectionStore {
  static key = WeatherAreaSelection.defaultsKey

  constructor({ defaults }) {
    this.defaults = defaults
  }

  /**
   * What is selected, or the default for a page that has never been chosen for.
   * `defaultStateCode` is the state of the page's place, when the page has one.
   */
  selection({ defaultStateCode = null } = {}) {
    const stored = WeatherAreaSelection.decode(this.defaults.get(WeatherAreaSelectionStore.key))
    return stored ?? WeatherAreaSelection.default({ stateCode: defaultStateCode })
  }

  /** Whether a choice has ever been made, so a screen can tell the default from a pick. */
  get hasSelection() {
    return WeatherAreaSelection.decode(this.defaults.get(WeatherAreaSelectionStore.key)) != null
  }

  /**
   * Keeps a pick. A method rather than a setter, because the reader takes the page's default and
   * a property cannot: the two halves would then not be the same name for the same thing.
   */
  setSelection(value) {
    this.defaults.set(WeatherAreaSelectionStore.key, value == null ? null : WeatherAreaSelection.make(value))
  }
}
