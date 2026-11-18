// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherPlace.swift

import { MeshWXPlaceNames, MeshWXZip } from '../meshwx/index.js'
import { WeatherGeo } from './WeatherGeo.js'
import { WeatherNames } from './WeatherNames.js'

/**
 * A phone fix reduced to the values a weather screen compares:
 * `{ latitude, longitude, horizontalAccuracy, timestamp }`.
 *
 * `horizontalAccuracy` is metres, negative when the fix carries no usable accuracy;
 * `timestamp` is milliseconds.
 */
export const WeatherLocationSample = Object.freeze({
  make({ latitude, longitude, horizontalAccuracy, timestamp }) {
    return { latitude, longitude, horizontalAccuracy, timestamp }
  },

  coordinate(sample) {
    return { latitude: sample.latitude, longitude: sample.longitude }
  },
})

/** Where the place came from (docs/MESHWX_UI.md §5). */
export const WeatherPlaceKind = Object.freeze({
  /** Where the phone is, from a fix no older than an hour. */
  current: 'current',
  /** Where the phone was: shown with its age and never enough for a "no alerts" claim. */
  lastKnown: 'lastKnown',
  /** A town, ZIP or station the user searched for. */
  searched: 'searched',
})

/**
 * What a searched place was found as, so the header says what it is rather than calling
 * everything a town (docs/MESHWX_UI.md §10). A ZIP says so through `zipCode`.
 */
export const WeatherSearchedAs = Object.freeze({
  town: 'town',
  /** A weather station found by its airport code, named by the town it serves. */
  airportCode: 'airportCode',
  /** A forecast point held because somebody on the channel asked about it. */
  forecastPoint: 'forecastPoint',
})

/** The one place the Weather screen answers for (docs/MESHWX_UI.md §5). */
export const WeatherPlace = Object.freeze({
  Kind: WeatherPlaceKind,
  SearchedAs: WeatherSearchedAs,

  lastKnownAfter: 60 * 60,
  freshFixAge: 5 * 60,
  maximumDriftKilometres: 25,
  searchedUncertaintyKilometres: 5,

  make({
    kind,
    coordinate,
    label,
    uncertaintyKilometres,
    locatedAt = null,
    zipCode = null,
    searchedAs = WeatherSearchedAs.town,
  }) {
    return { kind, coordinate, label, uncertaintyKilometres, locatedAt, zipCode, searchedAs }
  },

  /** The place for a phone fix. */
  location(sample, { label, now }) {
    const age = Math.max(0, (now - sample.timestamp) / 1000)
    return WeatherPlace.make({
      kind: age > WeatherPlace.lastKnownAfter ? WeatherPlaceKind.lastKnown : WeatherPlaceKind.current,
      coordinate: WeatherLocationSample.coordinate(sample),
      label,
      uncertaintyKilometres: WeatherPlace.uncertainty({ accuracyMetres: sample.horizontalAccuracy, age }),
      locatedAt: sample.timestamp,
    })
  },

  /** The place for a searched town: its census centre, with a radius a town spans. */
  searched(place) {
    return WeatherPlace.make({
      kind: WeatherPlaceKind.searched,
      coordinate: { latitude: place.lat, longitude: place.lon },
      label: WeatherNames.placeLabel({ name: place.name, state: place.state }),
      uncertaintyKilometres: WeatherPlace.searchedUncertaintyKilometres,
    })
  },

  /**
   * The place for a searched ZIP: the ZIP's own point, not its town's, labelled by spec §16.2 as
   * the weather bot labels it ("Austin, TX 78701"), with a town's radius.
   */
  zip(zip) {
    return WeatherPlace.make({
      kind: WeatherPlaceKind.searched,
      coordinate: { latitude: zip.lat, longitude: zip.lon },
      label: MeshWXZip.label(zip),
      uncertaintyKilometres: WeatherPlace.searchedUncertaintyKilometres,
      zipCode: zip.code,
    })
  },

  /**
   * max(accuracy, 0.5 km) + 1 km for each minute of age past five, capped at 25 km.
   *
   * A kilometre a minute is someone driving. For someone walking it over-includes a neighbouring
   * county, and the cost of that is being shown an alert close enough to be worth seeing — the
   * cheap side of the error.
   */
  uncertainty({ accuracyMetres, age }) {
    const accuracy = accuracyMetres >= 0 ? accuracyMetres / 1000 : 1
    const drift = Math.min(Math.max(0, age - WeatherPlace.freshFixAge) / 60, WeatherPlace.maximumDriftKilometres)
    return Math.max(accuracy, 0.5) + drift
  },
})

// MARK: - Saved places

/**
 * A place the user keeps in Places, held across visits to the tool (docs/MESHWX_UI.md §5).
 *
 * Not a `WeatherPlace`: what is worth keeping is what the user chose — a town, a ZIP, a station
 * found by its airport code — while the kind and the uncertainty radius are the screen's business
 * and are read back from `place`.
 */
export const WeatherSavedPlace = Object.freeze({
  make({
    label,
    latitude,
    longitude,
    zipCode = null,
    searchedAs = WeatherSearchedAs.town,
    stationIndex = null,
    chosenAt,
    isWatched = false,
  }) {
    return { label, latitude, longitude, zipCode, searchedAs, stationIndex, chosenAt, isWatched }
  },

  coordinate(saved) {
    return { latitude: saved.latitude, longitude: saved.longitude }
  },

  /**
   * One row per place, whichever way it was found: a town picked from a search and the same town
   * picked from the channel's suggestions are one saved place, and picking it again only moves it
   * up. Coordinates are rounded to about 100 m, finer than any of these sources.
   */
  id(saved) {
    if (saved.zipCode != null) return `zip:${saved.zipCode}`
    if (saved.stationIndex != null) return `station:${saved.stationIndex}`
    return `at:${saved.latitude.toFixed(3)},${saved.longitude.toFixed(3)}`
  },

  /** The place the screen answers for. */
  place(saved) {
    return WeatherPlace.make({
      kind: WeatherPlaceKind.searched,
      coordinate: WeatherSavedPlace.coordinate(saved),
      label: saved.label,
      uncertaintyKilometres: WeatherPlace.searchedUncertaintyKilometres,
      zipCode: saved.zipCode,
      searchedAs: saved.searchedAs,
    })
  },

  from(place, { stationIndex = null, at, isWatched = false }) {
    return WeatherSavedPlace.make({
      label: place.label,
      latitude: place.coordinate.latitude,
      longitude: place.coordinate.longitude,
      zipCode: place.zipCode,
      searchedAs: place.searchedAs,
      stationIndex,
      chosenAt: at,
      isWatched,
    })
  },
})

/** One change to the saved list, as a value (`WeatherSavedPlaces.Edit`). */
export const WeatherSavedPlacesEdit = Object.freeze({
  /** A place picked in Places: added at the front, or left where it is if it is already held. */
  remember(place) {
    return { kind: 'remember', value: place }
  },
  remove({ id }) {
    return { kind: 'remove', id }
  },
  /**
   * The order a drag produced, by id. Ids rather than indexes: the store's list may hold a place
   * this screen never saw, and an index would then move the wrong row.
   */
  reorder({ ids }) {
    return { kind: 'reorder', ids }
  },
  watch(isOn, { id }) {
    return { kind: 'watch', value: isOn, id }
  },

  /** Whether the edit can make the list longer, and so let the ceiling push a row off the end. */
  adds(edit) {
    return edit.kind === 'remember'
  },

  /** The one id this edit asks to be dropped. */
  removedID(edit) {
    return edit.kind === 'remove' ? edit.id : null
  },
})

/**
 * The saved list's rules (docs/MESHWX_UI.md §5): a new place first, one row per place, and a
 * ceiling so the sheet stays a list of places rather than a history of taps.
 *
 * The list's own order is the order: it is what the Places sheet shows and what the pager swipes
 * through (`WeatherPages`), and a drag in Places rewrites it.
 */
export const WeatherSavedPlaces = Object.freeze({
  limit: 12,
  Edit: WeatherSavedPlacesEdit,

  /**
   * The list with this place in it.
   *
   * A place the list does not hold goes to the **front**; a place it already holds **stays where
   * it is**. Picking Round Rock out of Places to look at it is not a request to reorder the pager
   * (docs/MESHWX_UI.md §3.1 U-4). Picking a place again keeps its bell.
   */
  remember(place, { in: list }) {
    const id = WeatherSavedPlace.id(place)
    const existing = list.find((one) => WeatherSavedPlace.id(one) === id)
    if (existing != null) {
      // Its bell and its place in the order both survive being picked again; the label and the
      // time it was last chosen are refreshed, because both of those are about this tap.
      const chosen = { ...place, isWatched: existing.isWatched }
      return WeatherSavedPlaces.ordered(list.map((one) => (WeatherSavedPlace.id(one) === id ? chosen : one)))
    }
    return WeatherSavedPlaces.ordered([place, ...list])
  },

  apply(edit, { to: list }) {
    switch (edit.kind) {
      case 'remember':
        return WeatherSavedPlaces.remember(edit.value, { in: list })
      case 'remove':
        return WeatherSavedPlaces.removing(edit.id, { from: list })
      case 'reorder':
        return WeatherSavedPlaces.ordering({ ids: edit.ids, in: list })
      case 'watch':
        return WeatherSavedPlaces.setting({ watched: edit.value, id: edit.id, in: list })
      default:
        return list
    }
  },

  /**
   * The list in the order these ids name. A place the ids do not name keeps its own order at the
   * end: it was saved after the drag began, and a reorder is not a removal.
   */
  ordering({ ids, in: list }) {
    const remaining = [...list]
    const ordered = []
    for (const id of ids) {
      const index = remaining.findIndex((one) => WeatherSavedPlace.id(one) === id)
      if (index < 0) continue
      ordered.push(remaining.splice(index, 1)[0])
    }
    return [...ordered, ...remaining]
  },

  /**
   * The places in `loaded` that `updated` no longer holds. The list is the only record of what
   * the user chose, so a write that drops one nobody asked to drop is refused rather than applied.
   */
  dropped(updated, { from: loaded }) {
    const after = new Set(updated.map(WeatherSavedPlace.id))
    return new Set(loaded.map(WeatherSavedPlace.id).filter((id) => !after.has(id)))
  },

  /**
   * The list after a drag in Places. `destination` is `onMove`'s: the index the rows land
   * *before*, counted in the list as it was.
   */
  moving({ fromOffsets, toOffset, in: list }) {
    const indexes = [...new Set(fromOffsets)]
      .filter((index) => index >= 0 && index < list.length)
      .sort((lhs, rhs) => lhs - rhs)
    if (indexes.length === 0) return list
    const picked = indexes.map((index) => list[index])
    const moved = [...list]
    for (const index of [...indexes].sort((lhs, rhs) => rhs - lhs)) moved.splice(index, 1)
    const before = indexes.filter((index) => index < toOffset).length
    const landing = Math.max(0, Math.min(toOffset - before, moved.length))
    moved.splice(landing, 0, ...picked)
    return moved
  },

  removing(id, { from: list }) {
    return list.filter((one) => WeatherSavedPlace.id(one) !== id)
  },

  /**
   * The list with one place's bell turned on or off. Nothing is trimmed here: a bell adds no row,
   * so there is nothing for the ceiling to make room for, and turning one on must never take a
   * page out from under the pager — least of all the page the tap came from.
   */
  setting({ watched, id, in: list }) {
    return list.map((place) => (WeatherSavedPlace.id(place) === id ? { ...place, isWatched: watched } : place))
  },

  /**
   * The list as given, cut to the ceiling from the end.
   *
   * A watched place never falls off: the ceiling is there so the sheet stays a list of places, and
   * dropping one the user asked to be warned about — silently, because they searched for twelve
   * towns — is not what it is for. The newest pick is always kept too.
   */
  ordered(list) {
    let room = Math.max(WeatherSavedPlaces.limit - list.filter((place) => place.isWatched).length, 1)
    return list.filter((place) => {
      if (place.isWatched) return true
      if (room <= 0) return false
      room -= 1
      return true
    })
  },
})

// MARK: - The search rows (§12, §3.1 U-22, U-23)

/**
 * What the Places search offers, once the table has answered (docs/MESHWX_UI.md §12).
 *
 * Both rules came out of one live search for "San Juan": six rows, the first and the last both
 * reading "San Juan, PR", none of them carrying a distance and the order between them one only
 * the table could see.
 */
export const WeatherPlaceSearch = Object.freeze({
  /**
   * A town of one name and one state, twice, this close together is the table's own doubling and
   * not two places.
   */
  duplicateWithinKilometres: 15,

  /**
   * Two rows that read the same word for word are one row.
   *
   * `places.json` carries San Juan, PR as both the municipio and its zona urbana, 7 km apart, and
   * spec §16.2 drops "ZONA URBANA" from the second. The first is kept, so the table's own ranking
   * still decides which coordinate a tap opens.
   */
  collapsingDuplicates(places) {
    const kept = []
    for (const place of places) {
      const label = WeatherNames.placeLabel({ name: place.name, state: place.state })
      const isDouble = kept.some(
        (one) =>
          WeatherNames.placeLabel({ name: one.name, state: one.state }) === label &&
          WeatherGeo.kilometres(
            { latitude: one.lat, longitude: one.lon },
            { latitude: place.lat, longitude: place.lon },
          ) <= WeatherPlaceSearch.duplicateWithinKilometres,
      )
      if (!isDouble) kept.push(place)
    }
    return kept
  },

  /**
   * The rows in the order they are shown. With nothing to measure from the rows carry no distance
   * either, and the table's fallback — biggest first — is an order nobody can read off the screen.
   * A to Z is.
   */
  ordered(places, { hasOrigin }) {
    const ordered = hasOrigin
      ? places
      : [...places].sort((lhs, rhs) => {
          const left = WeatherNames.placeLabel({ name: lhs.name, state: lhs.state })
          const right = WeatherNames.placeLabel({ name: rhs.name, state: rhs.state })
          return left < right ? -1 : left > right ? 1 : 0
        })
    return WeatherPlaceSearch.collapsingDuplicates(ordered)
  },
})
