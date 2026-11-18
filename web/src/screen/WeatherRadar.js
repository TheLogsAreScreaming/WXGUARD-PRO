// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherRadar.swift
//
// What a radar picture says (spec §13, revision 11, and the screen decisions in docs/MESHWX_UI.md
// §18): which tile to draw, how old it is, what it says about one place, what the card
// shows, and the rectangles a map draws. Revision 13 (docs/MESHWX_UI.md §18.5) adds the
// last hour of a square as a loop (`WeatherRadarLoop`).
//
// Pure, as everything in this layer is: no clock of its own, no words, no colours. `now` is
// always a parameter, distances come back in kilometres for the caller to convert to the
// device's units, and a level is the wire's number — the three colours and the three names are
// the view's.
//
// One rule runs through all of it: **a cell outside a partial tile's bounds is unknown, not
// dry.** The wire has four levels and no fifth, so an uncovered cell is level 0 like a clear
// one, and every reader here goes through `MeshWXRadar.isKnown` before it believes a zero.

import {
  MeshWXGeo, MeshWXNotAvailableReason, MeshWXRadar, MeshWXRadarLevel, MeshWXRadarTile, MeshWXWire,
} from '../meshwx/index.js'
import { WeatherRequest } from '../weather/index.js'

// MARK: - Picking a tile

/**
 * Which held tile a place is drawn from (docs/MESHWX_UI.md §18).
 *
 * The channel is shared, so a phone can hold several pictures of the same ground: the zoom 0
 * tile it asked for, a zoom 2 tile somebody across town asked for, and the coarse half of one of
 * them. They are all true, and the one to draw is the newest, then the *narrowest* — a 2° tile
 * is seven kilometres a cell and a 16° tile is fifty-five, and a phone looking at a place wants
 * the fine one.
 *
 * `taken` is compared **rounded down to a quarter of an hour** before the zoom is looked at,
 * because the pictures are made about every fifteen minutes and two products cut from the same
 * sweep print times a couple of minutes apart. Without the rounding a wide tile two minutes
 * newer would beat the local one every time, and the map would flip between widths on its own.
 */
export const WeatherRadarPick = Object.freeze({
  /** Past this a picture is not drawn at all (spec §18.4). Minutes. */
  maximumAgeMinutes: 120,
  /** The cadence pictures are made at, and the step `taken` is compared in. Minutes. */
  takenBucketMinutes: 15,

  /**
   * The best tile for a coordinate, or null.
   *
   * `tiles` is every `WeatherStoredRadarTile` this phone holds, **across all bots**: a square of
   * the earth is the same square whoever sent it, and a picture of it from the bot next door is
   * this place's picture too.
   *
   * `zoom`, when given, limits the choice to one width. That is *not* what the radar screen's
   * width control uses — see `held`, which answers "what is held for this square" rather than
   * "which picture is this place's".
   */
  best({ for: coordinate, tiles, zoom = null, now }) {
    const nowMinutes = Math.floor(now / 60_000)
    let best = null
    for (const stored of tiles ?? []) {
      if (zoom != null && stored.tile.zoom !== zoom) continue
      if (WeatherRadarPick.age({ ofTakenMinutes: stored.radar.taken_min, nowMinutes })
        > WeatherRadarPick.maximumAgeMinutes) continue
      if (!WeatherRadarPick.reaches(stored, { coordinate })) continue
      if (best == null || WeatherRadarPick.isBetter(stored, { than: best })) best = stored
    }
    return best
  },

  /**
   * The picture held for one **exact** square, whether or not it reaches the place.
   *
   * This is the radar screen's width control (docs/MESHWX_UI.md §18.2): each width shows the tile held for it,
   * and a partial tile whose bounds stop short of the place is still the tile held for that
   * width — the screen says "This picture does not reach Austin", which is an answer, and a very
   * different one from "Not asked for yet". `best` is for the other question.
   *
   * Since revision 13 `tiles` holds frames, several pictures of one square: this is the newest of
   * them, by the same ordering `best` uses.
   */
  held(tile, { tiles, now }) {
    const nowMinutes = Math.floor(now / 60_000)
    let best = null
    for (const stored of tiles ?? []) {
      if (!MeshWXRadarTile.isEqual(stored.tile, tile)) continue
      if (WeatherRadarPick.age({ ofTakenMinutes: stored.radar.taken_min, nowMinutes })
        > WeatherRadarPick.maximumAgeMinutes) continue
      if (best == null || WeatherRadarPick.isBetter(stored, { than: best })) best = stored
    }
    return best
  },

  /**
   * Whether a tile has anything to say about a coordinate: the coordinate is on the square, and
   * — when the picture reaches only part of the square — inside the part it reaches. A partial
   * tile that stops short of the place says nothing about it, however new it is.
   */
  reaches(stored, { coordinate }) {
    const size = MeshWXRadar.size(stored.radar)
    const cell = MeshWXRadarTile.cell(stored.tile, {
      latitude: coordinate.latitude, longitude: coordinate.longitude, size
    })
    if (cell == null) return false
    return !MeshWXRadar.isUnknown(stored.radar, cell)
  },

  /** Minutes from the time printed on a picture to now, which may be negative on a fast bot. */
  age({ ofTakenMinutes, nowMinutes }) {
    return nowMinutes - ofTakenMinutes
  },

  /** Newest quarter-hour, then the narrowest tile, then the finer grid. */
  isBetter(stored, { than: held }) {
    const quarter = (one) => Math.floor(one.radar.taken_min / WeatherRadarPick.takenBucketMinutes)
    if (quarter(stored) !== quarter(held)) return quarter(stored) > quarter(held)
    if (stored.tile.zoom !== held.tile.zoom) return stored.tile.zoom < held.tile.zoom
    if ((stored.radar.coarse === true) !== (held.radar.coarse === true)) return held.radar.coarse === true
    // Everything that matters is equal; the newer picture by the minute printed on it, and then
    // whichever arrived last, so the answer is stable rather than order-dependent.
    if (stored.radar.taken_min !== held.radar.taken_min) return stored.radar.taken_min > held.radar.taken_min
    return stored.receivedAt > held.receivedAt
  },

  /**
   * Every tile held, across every bot, newest `taken` first.
   *
   * A JS convenience the Swift does not need: `WeatherBotState` is per bot, and every rule here
   * reads the channel's tiles as one list.
   */
  tiles({ states }) {
    const all = []
    for (const botID of Object.keys(states ?? {}).map(Number).sort((lhs, rhs) => lhs - rhs)) {
      for (const stored of states[String(botID)].radarTiles ?? []) all.push(stored)
    }
    return all.sort((lhs, rhs) => rhs.radar.taken_min - lhs.radar.taken_min)
  }
})

// MARK: - Age

/**
 * How old the picture is, in the two terms the screen uses: `{ minutes, isOld }`.
 *
 * Measured from the time printed on the radar picture, never from when the packet arrived — a
 * tile drained from the radio's queue at connect is as old as its picture, and a picture the bot
 * cut an hour after it received it is an hour old the moment it lands.
 *
 * `isOld` from thirty minutes, which is two missed pictures: past it the time line takes the
 * caution tone and says that precipitation has moved since. Past
 * `WeatherRadarPick.maximumAgeMinutes` nothing is drawn at all, which is the pick's rule and not
 * this one.
 */
export const WeatherRadarAge = Object.freeze({
  /** From here the picture is old enough that the storm has moved. Minutes. */
  oldFromMinutes: 30,

  /** Negative is clamped to 0: a bot a minute ahead must not produce "−1 min old". */
  make({ takenMinutes, now }) {
    const minutes = Math.max(0, WeatherRadarPick.age({
      ofTakenMinutes: takenMinutes, nowMinutes: Math.floor(now / 60_000),
    }))
    return { minutes, isOld: minutes >= WeatherRadarAge.oldFromMinutes }
  },

  /** Past `WeatherRadarPick.maximumAgeMinutes` nothing is drawn at all. */
  isTooOldToDraw(age) {
    return age.minutes > WeatherRadarPick.maximumAgeMinutes
  }
})

// MARK: - What a picture says about a place

/**
 * One thing a summary can point at: `{ level, kilometres, bearing }`, the bearing an 8-point
 * `MeshWXCompass` value.
 *
 * Eight points and not sixteen because the cell is the resolution: a zoom 0 cell is seven
 * kilometres across, and "north-north-east" of a place is a claim the picture cannot support.
 */
export const WeatherRadarReach = Object.freeze({
  make({ level, kilometres, bearing }) {
    return { level, kilometres, bearing }
  }
})

/**
 * What one picture says about one place: `{ here, nearest, nearestHeavy }`.
 *
 * - `here`: the level over the place, or **null** when the picture does not reach it — the
 *   coordinate is off the tile, or inside it but outside a partial picture's bounds. Null is
 *   "this picture does not reach here", and is the one thing that must never be worded as dry.
 * - `nearest`: the closest wet cell other than the place's own.
 * - `nearestHeavy`: the closest level 3 cell, left out when it is the same cell as `nearest`
 *   (the sentence would say it twice) or when the place is already under heavy precipitation.
 *
 * Distances are great circle to the cell's centre, which is also what the bot's own DM says, so
 * the words on this screen and the words in a text reply agree.
 */
export const WeatherRadarSummary = Object.freeze({
  /** Nothing at all on this picture: dry at the place and no wet cell anywhere in the tile. */
  isAllDry(summary) {
    return summary.here === MeshWXRadarLevel.none && summary.nearest == null
  },

  /** `tile` is the decoded Radar message — the picture — not a `MeshWXRadarTile`. */
  make({ tile: radar, coordinate }) {
    const size = MeshWXRadar.size(radar)
    const square = MeshWXRadar.tile(radar)
    const own = MeshWXRadarTile.cell(square, {
      latitude: coordinate.latitude, longitude: coordinate.longitude, size
    })
    const isKnownHere = own != null && !MeshWXRadar.isUnknown(radar, own)
    const here = isKnownHere ? MeshWXRadar.level(radar, own) : null

    let nearest = null
    let heavy = null
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        // Outside the bounds a level 0 is unknown, not dry, and every cell out there is 0 — so
        // there is nothing to measure and nothing to report.
        if (MeshWXRadar.isUnknown(radar, { row, col })) continue
        const level = MeshWXRadar.level(radar, { row, col })
        if (!MeshWXRadarLevel.isWet(level)) continue
        if (own != null && row === own.row && col === own.col) continue
        const centre = MeshWXRadarTile.cellCentre(square, { row, col, size })
        const reach = {
          level,
          kilometres: MeshWXGeo.distanceKilometres({
            fromLat: coordinate.latitude,
            fromLon: coordinate.longitude,
            toLat: centre.latitude,
            toLon: centre.longitude
          }),
          bearing: bearingTo(coordinate, centre),
          row,
          col
        }
        if (nearest == null || reach.kilometres < nearest.kilometres) nearest = reach
        if (level === MeshWXRadarLevel.heavy && (heavy == null || reach.kilometres < heavy.kilometres)) {
          heavy = reach
        }
      }
    }
    if (heavy != null && (here === MeshWXRadarLevel.heavy
      || (nearest != null && heavy.row === nearest.row && heavy.col === nearest.col))) {
      heavy = null
    }
    return { here, nearest: reach(nearest), nearestHeavy: reach(heavy) }
  }
})

function reach(found) {
  if (found == null) return null
  return WeatherRadarReach.make({
    level: found.level, kilometres: found.kilometres, bearing: found.bearing
  })
}

/**
 * The 8-point compass direction from a place towards a cell centre, as a `MeshWXCompass` value
 * (so `N`, `NE`, `E` … are nibbles 0, 2, 4 …).
 *
 * The initial bearing of the great circle, the same formula the bot uses, rather than
 * `WeatherGeo.direction`: that one rounds to sixteen points, and a picture whose cells are seven
 * kilometres across has no business naming a sixteenth of the compass.
 */
function bearingTo(from, to) {
  const toRadians = Math.PI / 180
  const lat1 = from.latitude * toRadians
  const lat2 = to.latitude * toRadians
  const dLon = (to.longitude - from.longitude) * toRadians
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  const degrees = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
  const point = Math.floor((degrees + 22.5) / 45) % 8
  return point * 2
}

// MARK: - The card

/**
 * The radar picture a place page is holding open: `{ stored, age, summary, isWiderThanAsked }`.
 *
 * `isWiderThanAsked` is the zoom being above 0: the page asks for the local tile, and anything
 * wider is a picture somebody else asked for that happens to cover this place. It is worth a
 * quiet line on screen, because a 16° tile's cells are half a degree and a shower in one of them
 * could be forty kilometres from the place.
 */
export const WeatherRadarPicture = Object.freeze({
  make({ stored, age, summary, isWiderThanAsked }) {
    return { stored, age, summary, isWiderThanAsked }
  },

  /** The grid this picture was sent at: 16 when the bot halved the detail to fit a packet. */
  isCoarse(picture) {
    return picture.stored.radar.coarse === true
  },

  /** Part of the tile is outside the radar picture, so some cells are unknown rather than dry. */
  isPartial(picture) {
    return picture.stored.radar.bounds != null
  }
})

/**
 * The Radar section of a place page (docs/MESHWX_UI.md §18.1): `.noCoordinate`, `.missing` or `.held`.
 *
 * - `noCoordinate`: the place has no coordinate, so there is no tile to ask for and the section
 *   is absent — not empty, absent.
 * - `missing`: nothing held that reaches the place. `tile` is the square a tap would ask for,
 *   so the ask and the answer are worked out in one place.
 * - `held`: a picture, in `picture`.
 */
export const WeatherRadarCard = Object.freeze({
  Picture: WeatherRadarPicture,

  /**
   * The width the place page's own ask uses: the narrowest, which is the one that is actually
   * about the place. The radar screen offers the others.
   */
  pageZoom: 0,

  noCoordinate: Object.freeze({ kind: 'noCoordinate' }),
  /**
   * `tile` is the square a tap would ask for. The Swift's `.missing` carries nothing and reads
   * the square back through `tile(for:zoom:)`; here it is on the case, because every view that
   * has a `.missing` in its hand wants it and a page snapshot is read, never compared.
   */
  missing({ tile }) {
    return { kind: 'missing', tile }
  },
  held({ picture }) {
    return { kind: 'held', picture }
  },

  make({ place, tiles, now }) {
    if (place?.coordinate == null) return WeatherRadarCard.noCoordinate
    const coordinate = place.coordinate
    const stored = WeatherRadarPick.best({ for: coordinate, tiles, now })
    if (stored == null) {
      return WeatherRadarCard.missing({ tile: WeatherRadarCard.tile({ for: place }) })
    }
    return WeatherRadarCard.picture({ stored, coordinate, now })
  },

  /**
   * One width of the radar screen's control (docs/MESHWX_UI.md §18.2): the tile held for the square this
   * place's ask at that width would name, or `missing` — "Not asked for yet".
   *
   * Not `make` with a zoom, because the two answer different questions. The card asks *which
   * picture is this place's*, and a partial tile whose bounds stop short of the place is not
   * one. A width asks *what is held for this width*, and that same tile is held for it: the
   * summary's `here` comes back null and the screen says the picture does not reach the place,
   * which is an answer and not an absence.
   */
  width(zoom, { place, tiles, now }) {
    if (place?.coordinate == null) return WeatherRadarCard.noCoordinate
    const tile = WeatherRadarCard.tile({ for: place, zoom })
    const stored = WeatherRadarPick.held(tile, { tiles, now })
    if (stored == null) return WeatherRadarCard.missing({ tile })
    return WeatherRadarCard.picture({ stored, coordinate: place.coordinate, now })
  },

  /** The held case around one stored tile, as both `make` and `width` build it. */
  picture({ stored, coordinate, now }) {
    return WeatherRadarCard.held({
      picture: WeatherRadarPicture.make({
        stored,
        age: WeatherRadarAge.make({ takenMinutes: stored.radar.taken_min, now }),
        summary: WeatherRadarSummary.make({ tile: stored.radar, coordinate }),
        isWiderThanAsked: stored.tile.zoom > WeatherRadarCard.pageZoom
      })
    })
  },

  /**
   * The ask for a place at one width, or null when the place has no coordinate to ask about.
   *
   * The coordinate, never the place's name: the lattice turns the coordinate into a tile this
   * phone can name before the answer arrives, and a place the bot resolves for itself would come
   * back as a square nobody here chose (spec §13).
   */
  ask({ place, zoom = WeatherRadarCard.pageZoom }) {
    if (place?.coordinate == null) return null
    return WeatherRequest.radar({
      latitude: place.coordinate.latitude, longitude: place.coordinate.longitude, zoom
    })
  },

  /**
   * The lattice square a place's own request is for, at a width, or null for a place with no
   * coordinate. The radar screen's three width buttons each ask about the same place, so this
   * is what tells "not asked for yet" from "held" per width.
   */
  tile({ for: place, zoom = WeatherRadarCard.pageZoom }) {
    if (place?.coordinate == null) return null
    return MeshWXRadarTile.containing({
      latitude: place.coordinate.latitude, longitude: place.coordinate.longitude, zoom
    })
  },

  /** Every bot's tiles in one list, which is what `make` and `width` want. */
  tiles({ in: states }) {
    return WeatherRadarPick.tiles({ states })
  }
})

// MARK: - The last hour (revision 13)

/**
 * The last hour of one square, as the radar screen plays it: `{ frames, hasGap, held }`
 * (spec §13.5; docs/MESHWX_UI.md §18.5).
 *
 * - `frames`: the pictures of **that exact tile**, **oldest first** (the order they play in),
 *   whose `taken` is within 60 minutes before the newest held for it and at most 120 minutes old
 *   (the "not drawn" rule of revision 11). At most 5; when there are more, the newest are kept.
 * - `hasGap`: two consecutive frames more than 20 minutes apart. The pictures come every 15
 *   minutes, so a wider step is a picture missing, and the screen says so rather than letting a
 *   jump in the storm read as its speed.
 * - `held`: the frames' `taken` minutes, **newest first** — the order a loop request lists them
 *   in (`WeatherRequest.radarLoop`), so the bot leaves them out.
 *
 * Every bot's frames go in, as with `WeatherRadarPick`: a square cut from the same mosaic is the
 * same picture whoever sent it. Two copies of one minute are one frame, the better copy by
 * `WeatherRadarPick`'s own order (fine before coarse, then the later arrival): a loop that showed
 * one picture twice would stand still for a step and look like the weather had.
 */
export const WeatherRadarLoop = Object.freeze({
  /** How far back a loop reaches from its newest frame. Minutes. */
  windowMinutes: MeshWXWire.radarLoopWindowMinutes,
  /** An hour at 15-minute steps, the newest included. */
  maxFrames: MeshWXWire.radarLoopMaxFrames,
  /** Past this between two frames, one is missing: 20 is one picture late, not yet one lost. */
  gapMinutes: 20,

  /** No frames: nothing to play and nothing held. */
  empty: Object.freeze({ frames: Object.freeze([]), hasGap: false, held: Object.freeze([]) }),

  make({ tile, tiles, now }) {
    if (tile == null) return WeatherRadarLoop.empty
    const nowMinutes = Math.floor(now / 60_000)
    const byTaken = new Map()
    for (const stored of tiles ?? []) {
      if (!MeshWXRadarTile.isEqual(stored.tile, tile)) continue
      const taken = stored.radar.taken_min
      if (WeatherRadarPick.age({ ofTakenMinutes: taken, nowMinutes }) > WeatherRadarPick.maximumAgeMinutes) continue
      const other = byTaken.get(taken)
      if (other != null && !WeatherRadarPick.isBetter(stored, { than: other })) continue
      byTaken.set(taken, stored)
    }
    if (byTaken.size === 0) return WeatherRadarLoop.empty

    const newest = Math.max(...byTaken.keys())
    const frames = [...byTaken.values()]
      .filter((stored) => stored.radar.taken_min >= newest - WeatherRadarLoop.windowMinutes)
      .sort((lhs, rhs) => lhs.radar.taken_min - rhs.radar.taken_min)
      .slice(-WeatherRadarLoop.maxFrames)
    let hasGap = false
    for (let index = 1; index < frames.length; index += 1) {
      if (frames[index].radar.taken_min - frames[index - 1].radar.taken_min > WeatherRadarLoop.gapMinutes) {
        hasGap = true
      }
    }
    return { frames, hasGap, held: frames.map((stored) => stored.radar.taken_min).reverse() }
  },

  /** Play and Pause are offered from two frames: one frame is a picture, not a loop. */
  canPlay(loop) {
    return (loop?.frames?.length ?? 0) >= 2
  },

  /** The hour is all here, and "Ask for the last hour" is not offered. */
  isFull(loop) {
    return (loop?.frames?.length ?? 0) >= WeatherRadarLoop.maxFrames
  },

  /** The frame the screen shows when nothing is playing: the newest. */
  newest(loop) {
    const frames = loop?.frames ?? []
    return frames.length === 0 ? null : frames[frames.length - 1]
  },

  /**
   * The ask for the rest of the hour at one width, listing what this loop already holds so the
   * bot leaves those pictures out (spec revision 13, §13.5), at the place's coordinate.
   */
  ask(loop, { latitude, longitude, zoom }) {
    return WeatherRequest.radarLoop({ latitude, longitude, zoom, held: loop?.held ?? [] })
  }
})

// MARK: - Refusals

/**
 * Why the bot would not send a radar tile (docs/MESHWX_UI.md §18.3).
 *
 * The wire's reasons, split into the four the screen says different things for. Radar is the one
 * request where the refusal carries most of the information: "no recent picture for this area"
 * and "this bot has no dish at all" ask the reader to do entirely different things, and a single
 * "not available" would leave them tapping again for ever.
 */
export const WeatherRadarRefusal = Object.freeze({
  /** Reason 0: nothing newer than an hour covers the tile, or it is outside every mosaic. */
  noPicture: Object.freeze({ kind: 'noPicture' }),
  /** Reason 1: the app sends a coordinate, so this means the bot could not place it at all. */
  unknownPlace: Object.freeze({ kind: 'unknownPlace' }),
  /** Reason 2: this bot has no radar source. Nothing to retry, at this bot or any time. */
  unsupported: Object.freeze({ kind: 'unsupported' }),
  /** Reason 4: this tile went out in the last five minutes. Waiting is the answer. */
  sentRecently: Object.freeze({ kind: 'sentRecently' }),
  /** Anything else a bot sends back under `x`. */
  other(value) {
    return { kind: 'other', value }
  },

  make({ reason }) {
    switch (reason) {
      case MeshWXNotAvailableReason.noData: return WeatherRadarRefusal.noPicture
      case MeshWXNotAvailableReason.unknownLocation: return WeatherRadarRefusal.unknownPlace
      case MeshWXNotAvailableReason.unsupported: return WeatherRadarRefusal.unsupported
      case MeshWXNotAvailableReason.rateLimited: return WeatherRadarRefusal.sentRecently
      default: return WeatherRadarRefusal.other(reason)
    }
  }
})

// MARK: - Drawing the cells

/**
 * One rectangle of the map: `{ level, south, west, north, east }`.
 *
 * A run of cells of the same level in one row, merged, because a 32 × 32 tile is a thousand
 * cells and a map that draws a thousand shapes on a phone is a map that scrolls badly. A real
 * picture comes out at a few hundred.
 *
 * Merged along a row only, never down a column: the runs are what the quadtree already thinks in,
 * and merging rectangles in both directions is a bigger problem than the drawing it saves.
 */
export const WeatherRadarRectangle = Object.freeze({
  make({ level, south, west, north, east }) {
    return { level, south, west, north, east }
  }
})

export const WeatherRadarCells = Object.freeze({
  Rectangle: WeatherRadarRectangle,

  /** The wet cells, level by level, as rectangles in the order they are drawn. */
  rectangles({ radar }) {
    return runs(radar, (level, isKnown) => (isKnown && MeshWXRadarLevel.isWet(level) ? level : null))
  },

  /**
   * The cells the picture does not reach, as rectangles.
   *
   * Separately, and never as level 0: outside a partial tile's bounds there is no reading at
   * all, and a map that drew those cells the way it draws clear ones would be telling somebody
   * their ground is dry on the strength of a picture that stops short of it. The view hatches or
   * greys them.
   */
  unknownRectangles({ radar }) {
    return runs(radar, (level, isKnown) => (isKnown ? null : MeshWXRadarLevel.none))
  }
})

/**
 * Horizontal runs of cells the classifier gives the same non-null value to, as rectangles.
 * `classify(level, isKnown)` returns the rectangle's level, or null to leave the cell out.
 */
function runs(radar, classify) {
  const size = MeshWXRadar.size(radar)
  const tile = MeshWXRadar.tile(radar)
  const out = []
  for (let row = 0; row < size; row += 1) {
    let start = -1
    let level = null
    const flush = (end) => {
      if (start < 0) return
      const first = MeshWXRadarTile.cellBox(tile, { row, col: start, size })
      const last = MeshWXRadarTile.cellBox(tile, { row: row, col: end, size })
      out.push(WeatherRadarRectangle.make({
        level, south: first.south, west: first.west, north: first.north, east: last.east,
      }))
      start = -1
      level = null
    }
    for (let col = 0; col < size; col += 1) {
      const value = classify(MeshWXRadar.level(radar, { row, col }), MeshWXRadar.isKnown(radar, { row, col }))
      if (value === level && start >= 0) continue
      flush(col - 1)
      if (value == null) continue
      start = col
      level = value
    }
    flush(size - 1)
  }
  return out
}
