// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherChannelHistory.swift

import { MeshWXTextSubject, MeshWXWire } from '../meshwx/index.js'
import {
  UNASKED_FORECAST_KEY,
  WeatherStoredDigest,
  WeatherStoredForecast,
  WeatherStoredObservation,
  WeatherStoredRadarTile,
  WeatherStoredWarning
} from '../weather/index.js'
import { WeatherAlertRequests } from './WeatherAlertRequests.js'

// MARK: - Subject

/**
 * What one message on `#meshwx` was about, in the wire's own terms.
 *
 * Wire values rather than words: this is built from the held state, and the view turns each case
 * into a name a person reads. Nothing here names a requester — a broadcast carries none, and the
 * phone records none, so nothing downstream can claim one (docs/MESHWX_UI.md §12).
 */
export const WeatherChannelSubject = Object.freeze({
  /** The bot's alert list, with how many warnings it named. */
  alertList({ entries }) {
    return { kind: 'alertList', entries }
  },
  warning(value) {
    return { kind: 'warning', value }
  },
  /** One observations batch, with how many stations it carried. */
  readings({ stations }) {
    return { kind: 'readings', stations }
  },
  /** One station's held reading. */
  reading({ station }) {
    return { kind: 'reading', station }
  },
  /**
   * A forecast. `label` is the request text for a place the bot resolved for itself, which is the
   * only name that forecast has (spec §7); null for a bundled point.
   */
  forecast({ point, label }) {
    return { kind: 'forecast', point, label }
  },
  /**
   * A text reply, with the request of this phone's that it answered where it answered one. A chunk
   * carries only its subject, so a reply with no request is one nobody here asked for — which is
   * not the same as knowing who did.
   */
  text({ subject, request }) {
    return { kind: 'text', subject, request }
  },
  /** The bot's statement of what it carries (spec §10). */
  coverage: Object.freeze({ kind: 'coverage' }),
  /**
   * One radar tile (spec §13, revision 11). **The tile is the subject**: a picture of a square of
   * earth, named by its width and its centre rather than by anybody's question — nothing on the
   * wire says who asked for it, and the lattice means several people may have.
   *
   * `frames` (revision 13) is how many pictures of the square the row stands for: 1 for a row of
   * the channel history, which lists each frame as the packet it was, and the count held on the
   * Cached screen, which keeps one row per square and says "5 pictures".
   */
  radar({ tile, frames = 1 }) {
    return { kind: 'radar', tile, frames }
  },
})

// MARK: - Heard on the channel

/**
 * What the channel has carried recently, scheduled broadcasts and answers alike.
 *
 * Read from what the phone is holding, so a message it kept nothing of is not listed. Answers to
 * other people's requests are here beside the scheduled broadcasts and are not told apart from
 * them: on a broadcast channel they are the same thing, and which was which would be a claim about
 * who asked.
 *
 * An item is `{ id, botID, subject, contentAt, receivedAt }`. `contentAt` is the content's own
 * time on the bot's clock where the message carries one — a list's build time, a batch's
 * observation time, a forecast's issue time — and null for a warning, a text reply and a
 * statement, which carry none.
 */
export const WeatherHeard = Object.freeze({
  /** How far back the page looks. */
  window: 24 * 60 * 60,
  /** A page, not a history. */
  limit: 30,

  make({ states, now, limit = WeatherHeard.limit }) {
    const items = []
    const botIDs = Object.keys(states)
      .map(Number)
      .sort((lhs, rhs) => lhs - rhs)

    for (const botID of botIDs) {
      const state = states[String(botID)]
      const add = (id, subject, { contentAt, receivedAt }) => {
        if ((now - receivedAt) / 1000 > WeatherHeard.window) return
        items.push({ id: `${botID}-${id}`, botID, subject, contentAt, receivedAt })
      }

      if (state.digest != null) {
        add('digest', WeatherChannelSubject.alertList({ entries: state.digest.digest.entries.length }), {
          contentAt: WeatherStoredDigest.builtAt(state.digest),
          receivedAt: state.digest.receivedAt,
        })
      }
      for (const stored of Object.values(state.warnings ?? {})) {
        const identity = WeatherStoredWarning.identity(stored)
        add(
          `warning-${identity.event}.${identity.office}.${identity.etn}`,
          WeatherChannelSubject.warning(identity),
          { contentAt: null, receivedAt: stored.receivedAt },
        )
      }
      // One row per batch rather than per station: fourteen readings arrived as one message, and
      // fourteen rows would bury everything else the channel carried. Keyed by the batch's own
      // time, not the station's: since revision 5 each reading carries when *that station*
      // reported (batch `ts` less its age), so one hourly batch holds fourteen different times and
      // grouping by those would be fourteen rows again.
      const batches = new Map()
      for (const stored of Object.values(state.observations ?? {})) {
        const key = stored.lastBatchMinutes ?? stored.timestampMinutes
        const batch = batches.get(key) ?? { stations: 0, receivedAt: stored.receivedAt }
        batch.stations += 1
        batch.receivedAt = Math.max(batch.receivedAt, stored.receivedAt)
        batches.set(key, batch)
      }
      for (const [minutes, batch] of batches) {
        add(`batch-${minutes}`, WeatherChannelSubject.readings({ stations: batch.stations }), {
          contentAt: minutes * 60000,
          receivedAt: batch.receivedAt,
        })
      }
      for (const [pointKey, stored] of Object.entries(state.forecasts ?? {})) {
        const point = Number(pointKey)
        add(
          `forecast-${point}`,
          WeatherChannelSubject.forecast({ point, label: stored.requestLabel ?? null }),
          { contentAt: WeatherStoredForecast.issuedAt(stored), receivedAt: stored.receivedAt },
        )
      }
      // Forecasts the bot chose the point for (spec §7, revision 10). They are here and nowhere
      // else: the channel did carry them, and the coordinate asked about is the only thing that
      // says where each one is for — which is why the key is the label.
      for (const [asked, stored] of Object.entries(state.unbundledForecasts ?? {})) {
        add(
          `forecast-asked-${asked}`,
          WeatherChannelSubject.forecast({
            point: MeshWXWire.unbundledPoint,
            label: stored.requestLabel ?? labelForAskedForecast(asked),
          }),
          { contentAt: WeatherStoredForecast.issuedAt(stored), receivedAt: stored.receivedAt },
        )
      }
      for (const assembly of Object.values(state.texts ?? {})) {
        add(
          `text-${assembly.group}`,
          WeatherChannelSubject.text({ subject: assembly.subject, request: assembly.request ?? null }),
          { contentAt: null, receivedAt: assembly.lastReceivedAt },
        )
      }
      if (state.coverage != null) {
        add('coverage', WeatherChannelSubject.coverage, { contentAt: null, receivedAt: state.coverage.receivedAt })
      }
      // One row per frame, with its own time: an older picture off a loop went past on the
      // channel like any other (revision 13).
      for (const stored of state.radarTiles ?? []) {
        const tile = stored.tile
        add(
          `radar-${tile.zoom}-${tile.south}-${tile.west}-${stored.radar.taken_min}`,
          WeatherChannelSubject.radar({ tile, frames: 1 }),
          // The picture's own time, which is not when it was sent: a tile cut from a mosaic an
          // hour after it was made is an hour old the moment it lands.
          { contentAt: WeatherStoredRadarTile.takenAt(stored), receivedAt: stored.receivedAt },
        )
      }
    }

    return items
      .sort((lhs, rhs) => {
        if (lhs.receivedAt !== rhs.receivedAt) return rhs.receivedAt - lhs.receivedAt
        return lhs.id < rhs.id ? -1 : lhs.id > rhs.id ? 1 : 0
      })
      .slice(0, limit)
  },
})

// MARK: - Cache

/** The kinds of thing the phone is holding from the channel (docs/MESHWX_UI.md §12). */
export const WeatherCacheGroup = Object.freeze({
  readings: 'readings',
  forecasts: 'forecasts',
  /** METAR and TAF: the coded airport reports, text subject 5. */
  airportReports: 'airportReports',
  /** The full text of a warning, text subject 0. */
  warningNarratives: 'warningNarratives',
  /** Warnings the phone holds for somewhere other than the place on screen. */
  warningsElsewhere: 'warningsElsewhere',
  /** The radar tiles the phone is holding (spec §13, revision 11), one row per square of earth. */
  radarPictures: 'radarPictures',

  allCases: Object.freeze([
    'readings', 'forecasts', 'airportReports', 'warningNarratives', 'warningsElsewhere',
    'radarPictures',
  ]),
})

/**
 * One thing the phone is holding, and the screen that shows it in full:
 * `{ id, group, botID, subject, contentAt, receivedAt, destination }`.
 */
export const WeatherCachedItem = Object.freeze({
  /**
   * The screen a row opens, where one exists. A forecast has none: the place picker is where a
   * point becomes a place (§12).
   */
  Destination: Object.freeze({
    station(value) {
      return { kind: 'station', value }
    },
    alert(value) {
      return { kind: 'alert', value }
    },
  }),
})

/**
 * Everything the phone kept from `#meshwx`, grouped and counted: `{ groups, total }`, where a
 * group is `{ group, items }` holding only the groups with something in them, in
 * `WeatherCacheGroup.allCases` order.
 *
 * One disclosed row at the foot of the weather radio's page, and nothing from it on the main
 * screens: the point is to be able to see what is being held — and how much of it is somebody
 * else's question — without any of it claiming to be an answer to yours.
 */
export const WeatherCache = Object.freeze({
  empty: Object.freeze({ groups: Object.freeze([]), total: 0 }),

  count(group) {
    return group.items.length
  },

  /**
   * - `readings`: the snapshot's own readings, already one per station across bots, so the list
   *   counts what the phone would show rather than every copy two bots sent.
   * - `alerts`: the placed alerts; the ones elsewhere are the warnings this phone is keeping for
   *   somewhere other than the place on screen.
   */
  make({ states, readings, alerts, tables }) {
    const items = new Map()
    const add = (item) => {
      const list = items.get(item.group) ?? []
      list.push(item)
      items.set(item.group, list)
    }

    for (const reading of readings) {
      add({
        id: `reading-${reading.index}`,
        group: WeatherCacheGroup.readings,
        botID: reading.botID,
        subject: WeatherChannelSubject.reading({ station: reading.index }),
        contentAt: WeatherStoredObservation.observedAt(reading.stored),
        receivedAt: reading.stored.receivedAt,
        destination: WeatherCachedItem.Destination.station(reading.index),
      })
    }

    const botIDs = Object.keys(states)
      .map(Number)
      .sort((lhs, rhs) => lhs - rhs)
    for (const botID of botIDs) {
      const state = states[String(botID)]
      for (const [pointKey, stored] of Object.entries(state.forecasts ?? {})) {
        const point = Number(pointKey)
        add({
          id: `forecast-${botID}-${point}`,
          group: WeatherCacheGroup.forecasts,
          botID,
          subject: WeatherChannelSubject.forecast({ point, label: stored.requestLabel ?? null }),
          contentAt: WeatherStoredForecast.issuedAt(stored),
          receivedAt: stored.receivedAt,
          destination: null,
        })
      }
      for (const [asked, stored] of Object.entries(state.unbundledForecasts ?? {})) {
        add({
          id: `forecast-${botID}-asked-${asked}`,
          group: WeatherCacheGroup.forecasts,
          botID,
          subject: WeatherChannelSubject.forecast({
            point: MeshWXWire.unbundledPoint,
            label: stored.requestLabel ?? labelForAskedForecast(asked),
          }),
          contentAt: WeatherStoredForecast.issuedAt(stored),
          receivedAt: stored.receivedAt,
          // No place on this phone: the coordinate was the question, and a row that opened a
          // page would be opening somebody else's.
          destination: null,
        })
      }
      for (const assembly of Object.values(state.texts ?? {})) {
        let group
        if (assembly.subject === MeshWXTextSubject.metarOrTAF) group = WeatherCacheGroup.airportReports
        else if (assembly.subject === MeshWXTextSubject.warningNarrative) group = WeatherCacheGroup.warningNarratives
        // The Weather Service products have a screen of their own (§12); this page is for what
        // would otherwise go unaccounted for.
        else continue
        add({
          id: `text-${botID}-${assembly.group}`,
          group,
          botID,
          subject: WeatherChannelSubject.text({ subject: assembly.subject, request: assembly.request ?? null }),
          contentAt: null,
          receivedAt: assembly.lastReceivedAt,
          destination: WeatherCache.destination({ of: assembly.request ?? null, tables }),
        })
      }
      // One row per square of earth held, whatever its width (docs/MESHWX_UI.md §18.4), with its newest
      // picture's time and, since revision 13, how many pictures of it are held. No destination:
      // the radar screen is reached from the place page's card, which knows which place it is
      // about; a cached row knows only a tile.
      for (const { stored, frames } of radarSquares(state.radarTiles)) {
        const tile = stored.tile
        add({
          id: `radar-${botID}-${tile.zoom}-${tile.south}-${tile.west}`,
          group: WeatherCacheGroup.radarPictures,
          botID,
          subject: WeatherChannelSubject.radar({ tile, frames }),
          contentAt: WeatherStoredRadarTile.takenAt(stored),
          receivedAt: stored.receivedAt,
          destination: null,
        })
      }
    }

    for (const alert of alerts) {
      if (alert.placement.kind !== 'elsewhere') continue
      add({
        id: `alert-${alert.identity.event}.${alert.identity.office}.${alert.identity.etn}`,
        group: WeatherCacheGroup.warningsElsewhere,
        botID: alert.botIDs[0] ?? 0,
        subject: WeatherChannelSubject.warning(alert.identity),
        contentAt: null,
        receivedAt: alert.receivedAt,
        destination: WeatherCachedItem.Destination.alert(alert.identity),
      })
    }

    const groups = []
    for (const group of WeatherCacheGroup.allCases) {
      const rows = items.get(group)
      if (rows == null || rows.length === 0) continue
      groups.push({
        group,
        items: rows.sort((lhs, rhs) => {
          if (lhs.receivedAt !== rhs.receivedAt) return rhs.receivedAt - lhs.receivedAt
          return lhs.id < rhs.id ? -1 : lhs.id > rhs.id ? 1 : 0
        }),
      })
    }
    return { groups, total: groups.reduce((total, group) => total + group.items.length, 0) }
  },

  /**
   * Where a text reply's row goes: only a reply that answered a request of this phone's names the
   * station or the warning it is about. One nobody here asked for carries its subject and nothing
   * else, and gets no destination rather than a guessed one.
   */
  destination({ of: request, tables }) {
    if (request == null) return null
    switch (request.kind) {
      case 'metar':
      case 'taf': {
        const index = tables.stationIndex({ forICAO: request.station })
        return index == null ? null : WeatherCachedItem.Destination.station(index)
      }
      case 'warningText': {
        const identity = WeatherAlertRequests.identity({ from: request.identity, tables })
        return identity == null ? null : WeatherCachedItem.Destination.alert(identity)
      }
      default:
        return null
    }
  },
})

/**
 * What to call a bot-chosen forecast with no request label: the coordinate that was asked about,
 * which is the only thing that says where it is for. The one slot for a question nobody here
 * asked (`"?"`) has no coordinate either, so it has no name.
 */
function labelForAskedForecast(key) {
  return key === UNASKED_FORECAST_KEY ? null : key
}

/**
 * One bot's radar frames as squares (revision 13): each square's newest frame — then the one
 * that arrived last — and how many pictures (distinct `taken`) of it are held, in the order the
 * squares first appear.
 */
function radarSquares(list) {
  const squares = new Map()
  for (const stored of list ?? []) {
    const tile = stored.tile
    const key = `${tile.zoom}|${tile.south}|${tile.west}`
    const held = squares.get(key)
    if (held == null) {
      squares.set(key, { stored, taken: new Set([stored.radar.taken_min]) })
      continue
    }
    held.taken.add(stored.radar.taken_min)
    const newer = stored.radar.taken_min > held.stored.radar.taken_min
      || (stored.radar.taken_min === held.stored.radar.taken_min && stored.receivedAt > held.stored.receivedAt)
    if (newer) held.stored = stored
  }
  return [...squares.values()].map(({ stored, taken }) => ({ stored, frames: taken.size }))
}
