// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherRadarTests.swift
//
// The radar screen rules of revision 11: which tile is drawn, how old it is, what it says about
// a place, and the rectangles a map draws. The Dallas case is the bot's own
// `test_dallas_under_the_squall_line`, read off the published `radar_tile` vector, so the words
// this phone puts on screen and the words the bot puts in a DM come from the same numbers.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MeshWXCompass, MeshWXNotAvailableReason, MeshWXRadar, MeshWXRadarLevel, decode, hexToBytes,
} from '../src/meshwx/index.js'
import {
  WeatherRadarAge,
  WeatherRadarCard,
  WeatherRadarCells,
  WeatherRadarLoop,
  WeatherRadarPick,
  WeatherRadarRefusal,
  WeatherRadarSummary,
} from '../src/screen/index.js'
import { WeatherRequest } from '../src/weather/index.js'
import { vector } from './helpers/meshwx-vectors.js'
import { botState, storedRadarTile, WeatherPhoneFixture as P } from './helpers/screen-fixture.js'

const minutes = (value) => value * 60 * 1000

/** The publisher's own tile: Dallas under the squall line of 20 September 2026, 23:38 UTC. */
const dallasPicture = decode(hexToBytes(vector('radar_tile').hex))
const dallas = { latitude: 32.78, longitude: -96.8 }

/** That tile as the app holds it, with `taken` moved to the fixture's clock. */
function dallasTile({ takenAgo = 12, receivedAgo = 12 } = {}) {
  return {
    tile: MeshWXRadar.tile(dallasPicture),
    radar: { ...dallasPicture, taken_min: P.nowMinutes - takenAgo },
    receivedAt: P.now - minutes(receivedAgo),
    source: 1,
  }
}

// MARK: - Picking a tile

test('the newest quarter-hour wins, then the narrowest tile, then the finer grid', () => {
  const local = storedRadarTile({ south: 29, west: -99, zoom: 0, takenMinutes: P.nowMinutes - 12 })
  const wide = storedRadarTile({ south: 24, west: -104, zoom: 3, takenMinutes: P.nowMinutes - 10 })
  // Two minutes apart is the same picture as far as the screen is concerned: without the
  // quarter-hour rounding the wide tile would win and the map would flip width on its own.
  assert.equal(
    WeatherRadarPick.best({ for: P.austin, tiles: [wide, local], now: P.now }), local,
  )

  // A genuinely newer picture does win, however wide it is.
  const newer = storedRadarTile({ south: 24, west: -104, zoom: 3, takenMinutes: P.nowMinutes })
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles: [local, newer], now: P.now }), newer)

  // Same picture, one of them at half the detail: the fine one is drawn.
  const coarse = storedRadarTile({ south: 29, west: -99, size: 16, takenMinutes: P.nowMinutes - 12 })
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles: [coarse, local], now: P.now }), local)
})

test('a tile that does not reach the place is not the place\'s picture', () => {
  const elsewhere = storedRadarTile({ south: 32, west: -98, takenMinutes: P.nowMinutes })
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles: [elsewhere], now: P.now }), null)
  assert.equal(WeatherRadarPick.best({ for: P.dallas, tiles: [elsewhere], now: P.now }), elsewhere)
})

/**
 * A partial tile stops where the radar picture stops. Inside the bounds it answers; outside them
 * it has no reading at all, which is not the same as a dry one — so it is not this place's
 * picture, however new it is.
 */
test('a partial tile answers only for the part the picture reaches', () => {
  const partial = storedRadarTile({
    south: 24, west: -100, zoom: 1, size: 16, bounds: [0, 9, 0, 15], takenMinutes: P.nowMinutes,
  })
  // The tile is 24N to 28N; 27N is row 4 of its sixteen, inside the bounds.
  assert.equal(
    WeatherRadarPick.best({ for: { latitude: 27, longitude: -98 }, tiles: [partial], now: P.now }),
    partial,
  )
  // 24.1N is in the southern rows the picture does not cover.
  assert.equal(
    WeatherRadarPick.best({ for: { latitude: 24.1, longitude: -98 }, tiles: [partial], now: P.now }),
    null,
  )
})

test('past two hours no tile is drawn at all', () => {
  const old = storedRadarTile({ takenMinutes: P.nowMinutes - WeatherRadarPick.maximumAgeMinutes - 1 })
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles: [old], now: P.now }), null)
  const just = storedRadarTile({ takenMinutes: P.nowMinutes - WeatherRadarPick.maximumAgeMinutes })
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles: [just], now: P.now }), just)
})

test('a width can be asked for on its own, and answers for itself', () => {
  const local = storedRadarTile({ south: 29, west: -99, zoom: 0, takenMinutes: P.nowMinutes })
  const wide = storedRadarTile({ south: 24, west: -104, zoom: 3, takenMinutes: P.nowMinutes - 40 })
  const tiles = [local, wide]
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles, zoom: 0, now: P.now }), local)
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles, zoom: 3, now: P.now }), wide)
  assert.equal(WeatherRadarPick.best({ for: P.austin, tiles, zoom: 2, now: P.now }), null, 'not asked for yet')
})

/** A square of the earth is the same square whoever sent it. */
test('tiles are read across every bot, newest first', () => {
  const states = {
    1: botState({ botID: 1, radarTiles: [storedRadarTile({ takenMinutes: P.nowMinutes - 30 })] }),
    2: botState({ botID: 2, radarTiles: [storedRadarTile({ takenMinutes: P.nowMinutes })] }),
  }
  const tiles = WeatherRadarPick.tiles({ states })
  assert.equal(tiles.length, 2)
  assert.equal(tiles[0].radar.taken_min, P.nowMinutes)
  // A bot that has never sent one contributes nothing rather than failing.
  assert.deepStrictEqual(WeatherRadarPick.tiles({ states: { 3: botState({ botID: 3 }) } }), [])
})

// MARK: - Age

test('a picture ages from the minute printed on it, and is old from thirty minutes', () => {
  const at = (ago) => WeatherRadarAge.make({ takenMinutes: P.nowMinutes - ago, now: P.now })
  assert.deepStrictEqual(at(12), { minutes: 12, isOld: false })
  assert.deepStrictEqual(at(29), { minutes: 29, isOld: false })
  assert.deepStrictEqual(at(30), { minutes: 30, isOld: true })
  // A tile drained from the radio's queue an hour after the picture was made is an hour old the
  // moment it lands: receipt is not in this at all.
  assert.deepStrictEqual(at(60), { minutes: 60, isOld: true })
})

// MARK: - What a picture says about a place

/**
 * The bot's own `test_dallas_under_the_squall_line`, cell for cell: light rain over Dallas, the
 * nearest echo four kilometres west, the nearest heavy core forty-two kilometres south.
 */
test('the Dallas tile says what the bot says about it', () => {
  const summary = WeatherRadarSummary.make({ tile: dallasPicture, coordinate: dallas })
  assert.equal(summary.here, MeshWXRadarLevel.light)
  assert.equal(MeshWXCompass.abbreviation(summary.nearest.bearing), 'W')
  assert.ok(Math.round(summary.nearest.kilometres) === 4, `${summary.nearest.kilometres} km`)
  assert.equal(summary.nearestHeavy.level, MeshWXRadarLevel.heavy)
  assert.ok(summary.nearestHeavy.kilometres > 30 && summary.nearestHeavy.kilometres < 60)
  assert.equal(MeshWXCompass.abbreviation(summary.nearestHeavy.bearing), 'S')
  // Eight points, never sixteen: a cell is seven kilometres across and "NNE" is a claim the
  // picture cannot support.
  for (const reach of [summary.nearest, summary.nearestHeavy]) {
    assert.equal(reach.bearing % 2, 0, MeshWXCompass.abbreviation(reach.bearing))
  }
})

test('a dry tile says so, and an empty one says there is nothing on the picture', () => {
  const dry = storedRadarTile({ south: 32, west: -98, cells: [[0, 0, 1]] }).radar
  const summary = WeatherRadarSummary.make({ tile: dry, coordinate: P.dallas })
  assert.equal(summary.here, MeshWXRadarLevel.none)
  assert.equal(summary.nearest.level, MeshWXRadarLevel.light)
  assert.equal(summary.nearestHeavy, null)

  const empty = storedRadarTile({ south: 32, west: -98 }).radar
  assert.deepStrictEqual(
    WeatherRadarSummary.make({ tile: empty, coordinate: P.dallas }),
    { here: MeshWXRadarLevel.none, nearest: null, nearestHeavy: null },
  )
})

/** `here` is null for a place the picture does not reach — never `none`, which would read dry. */
test('outside the bounds the picture says nothing about the place', () => {
  const partial = storedRadarTile({
    south: 24, west: -100, zoom: 1, size: 16, bounds: [0, 9, 0, 15], cells: [[2, 3, 1]],
  }).radar
  assert.equal(
    WeatherRadarSummary.make({ tile: partial, coordinate: { latitude: 24.1, longitude: -98 } }).here,
    null,
  )
  assert.equal(
    WeatherRadarSummary.make({ tile: partial, coordinate: { latitude: 27, longitude: -98 } }).here,
    MeshWXRadarLevel.none,
  )
  // A coordinate off the tile altogether is the same answer.
  assert.equal(
    WeatherRadarSummary.make({ tile: partial, coordinate: P.dallas }).here, null,
  )
})

test('the nearest heavy core is left out when it is already the nearest, or overhead', () => {
  // One heavy cell and nothing else: it is the nearest, so naming it twice would be two
  // sentences about one cell.
  const one = storedRadarTile({ south: 32, west: -98, cells: [[0, 0, 3]] }).radar
  const summary = WeatherRadarSummary.make({ tile: one, coordinate: P.dallas })
  assert.equal(summary.nearest.level, MeshWXRadarLevel.heavy)
  assert.equal(summary.nearestHeavy, null)

  // Heavy over the place itself: the place's own cell is never the "nearest" anything, and a
  // core elsewhere is not worth a second sentence either.
  // (19, 19) is Dallas's own cell on a 32N, 98W tile.
  const overhead = storedRadarTile({ south: 32, west: -98, cells: [[19, 19, 3], [0, 0, 3]] }).radar
  const here = WeatherRadarSummary.make({ tile: overhead, coordinate: P.dallas })
  assert.equal(here.here, MeshWXRadarLevel.heavy)
  assert.equal(here.nearestHeavy, null)
  assert.equal(here.nearest.level, MeshWXRadarLevel.heavy, 'the other core is still the nearest echo')
})

// MARK: - The card

test('a place with no coordinate has no radar section at all', () => {
  assert.deepStrictEqual(
    WeatherRadarCard.make({ place: null, tiles: [], now: P.now }), WeatherRadarCard.noCoordinate,
  )
  assert.equal(WeatherRadarCard.tile({ for: null }), null)
})

test('nothing held names the tile a tap would ask for', () => {
  const card = WeatherRadarCard.make({ place: P.place(P.austin), tiles: [], now: P.now })
  assert.equal(card.kind, 'missing')
  assert.deepStrictEqual(card.tile, { south: 29, west: -99, zoom: 0 })
  // The radar screen's three widths ask about the same place, each for its own square.
  assert.deepStrictEqual(
    WeatherRadarCard.tile({ for: P.place(P.austin), zoom: 2 }), { south: 28, west: -100, zoom: 2 },
  )
})

test('a held picture carries its age, its summary and whether it is wider than asked', () => {
  const card = WeatherRadarCard.make({
    place: P.place(P.dallas, { label: 'Dallas, TX' }), tiles: [dallasTile()], now: P.now,
  })
  assert.equal(card.kind, 'held')
  assert.equal(card.picture.stored.tile.zoom, 0)
  assert.deepStrictEqual(card.picture.age, { minutes: 12, isOld: false })
  assert.equal(card.picture.summary.here, MeshWXRadarLevel.light)
  assert.equal(card.picture.isWiderThanAsked, false)

  // The only tile held is a wide one somebody else asked for: it is drawn, and the card says so.
  const wide = storedRadarTile({ south: 24, west: -104, zoom: 3, takenMinutes: P.nowMinutes - 5 })
  const wider = WeatherRadarCard.make({ place: P.place(P.austin), tiles: [wide], now: P.now })
  assert.equal(wider.kind, 'held')
  assert.equal(wider.picture.isWiderThanAsked, true)
})

test('a picture too old to draw leaves the card asking for one', () => {
  const stale = storedRadarTile({ takenMinutes: P.nowMinutes - 180 })
  const card = WeatherRadarCard.make({ place: P.place(P.austin), tiles: [stale], now: P.now })
  assert.equal(card.kind, 'missing')
  assert.deepStrictEqual(card.tile, { south: 29, west: -99, zoom: 0 })
})

// MARK: - Drawing the cells

test('a row of equal cells is one rectangle', () => {
  const radar = storedRadarTile({
    south: 32, west: -98, cells: [[0, 0, 1], [0, 1, 1], [0, 2, 1], [0, 4, 2], [5, 5, 3]],
  }).radar
  const rectangles = WeatherRadarCells.rectangles({ radar })
  assert.equal(rectangles.length, 3)
  assert.deepStrictEqual(rectangles[0], {
    level: 1, south: 34 - 1 / 16, west: -98, north: 34, east: -98 + 3 / 16,
  })
  assert.equal(rectangles[1].level, 2)
  assert.equal(rectangles[1].west, -98 + 4 / 16)
  assert.equal(rectangles[2].level, 3)
  // Dry cells are not drawn at all, and a whole tile has nothing unknown on it.
  assert.deepStrictEqual(WeatherRadarCells.unknownRectangles({ radar }), [])
})

/** The published tile: 380 wet cells come out as a few dozen rectangles, not a thousand. */
test('a real picture is a few dozen rectangles', () => {
  const rectangles = WeatherRadarCells.rectangles({ radar: dallasPicture })
  assert.equal(MeshWXRadar.wetCells(dallasPicture), 380)
  assert.ok(rectangles.length < 120, `${rectangles.length} rectangles`)
  let cells = 0
  for (const rectangle of rectangles) {
    assert.ok(rectangle.level > 0)
    cells += Math.round((rectangle.east - rectangle.west) * 16)
  }
  assert.equal(cells, 380, 'every wet cell is in exactly one rectangle')
})

/**
 * The cells a partial picture does not reach come back separately, so a map can hatch them.
 * Drawing them the way clear ground is drawn would tell somebody their ground is dry on the
 * strength of a picture that stops short of it.
 */
test('unknown cells are returned apart from the dry ones', () => {
  const radar = storedRadarTile({
    south: 24, west: -100, zoom: 1, size: 16, bounds: [0, 9, 0, 15], cells: [[2, 3, 1]],
  }).radar
  const unknown = WeatherRadarCells.unknownRectangles({ radar })
  assert.equal(unknown.length, 6, 'rows 10 to 15, one rectangle each')
  for (const rectangle of unknown) {
    assert.equal(rectangle.level, MeshWXRadarLevel.none)
    assert.equal(rectangle.west, -100)
    assert.equal(rectangle.east, -96)
  }
  assert.equal(WeatherRadarCells.rectangles({ radar }).length, 1, 'the one echo inside the bounds')
})

// MARK: - One width of the radar screen's control

/**
 * The width control asks a different question from the card: not "which picture is this place's"
 * but "what is held for this width". A partial tile whose bounds stop short of the place is held
 * for its width, and the summary's null `here` is what lets the screen say the picture does not
 * reach the place rather than showing nothing at all.
 */
test("a width holds a tile the card would not call the place's picture", () => {
  const place = P.place(P.austin)
  const short = storedRadarTile({ south: 29, west: -99, zoom: 0, bounds: [0, 5, 0, 31] })
  const tiles = [short]
  assert.equal(WeatherRadarCard.make({ place, tiles, now: P.now }).kind, 'missing')

  const width = WeatherRadarCard.width(0, { place, tiles, now: P.now })
  assert.equal(width.kind, 'held')
  assert.equal(WeatherRadarCard.Picture.isPartial(width.picture), true)
  assert.equal(width.picture.summary.here, null, 'this picture does not reach the place')

  // Nothing held for that width is "Not asked for yet"; no coordinate is no section at all.
  const empty = WeatherRadarCard.width(2, { place, tiles, now: P.now })
  assert.equal(empty.kind, 'missing')
  assert.deepStrictEqual(empty.tile, { south: 28, west: -100, zoom: 2 })
  assert.deepStrictEqual(
    WeatherRadarCard.width(0, { place: null, tiles, now: P.now }), WeatherRadarCard.noCoordinate,
  )

  // And it is the width's own square, never a neighbouring one: the zoom 1 tile of the same
  // place is a different square and does not answer for zoom 0.
  const regional = [storedRadarTile({ south: 28, west: -100, zoom: 1 })]
  assert.equal(WeatherRadarCard.width(0, { place, tiles: regional, now: P.now }).kind, 'missing')
  assert.equal(WeatherRadarCard.width(1, { place, tiles: regional, now: P.now }).kind, 'held')
  // Past two hours a width holds nothing either.
  const old = [storedRadarTile({ south: 28, west: -100, zoom: 1, takenMinutes: P.nowMinutes - 121 })]
  assert.equal(WeatherRadarCard.width(1, { place, tiles: old, now: P.now }).kind, 'missing')
})

/** `held` is by the square alone, and still prefers the better picture of it. */
test('the tile held for a square is the newest and finest of that square', () => {
  const square = { south: 29, west: -99, zoom: 0 }
  const coarse = storedRadarTile({ ...square, size: 16, takenMinutes: P.nowMinutes })
  const fine = storedRadarTile({ ...square, takenMinutes: P.nowMinutes })
  const elsewhere = storedRadarTile({ south: 32, west: -98, takenMinutes: P.nowMinutes })
  assert.equal(
    WeatherRadarPick.held(square, { tiles: [coarse, fine, elsewhere], now: P.now }), fine,
  )
  assert.equal(WeatherRadarPick.held({ south: 31, west: -99, zoom: 0 }, { tiles: [fine], now: P.now }), null)
})

/**
 * The ask is the coordinate and never the place's name: the lattice turns the coordinate into a
 * tile this phone can name before the answer arrives (spec §13).
 */
test('the ask names the coordinate and the width', () => {
  assert.equal(WeatherRadarCard.ask({ place: null }), null)
  assert.deepStrictEqual(
    WeatherRadarCard.ask({ place: P.place(P.austin) }),
    WeatherRequest.radar({ latitude: P.austin.latitude, longitude: P.austin.longitude, zoom: 0 }),
  )
  assert.equal(
    WeatherRequest.wireText(WeatherRadarCard.ask({ place: P.place(P.austin) })),
    '>radar 30.267,-97.743',
  )
  assert.equal(
    WeatherRequest.wireText(WeatherRadarCard.ask({ place: P.place(P.austin), zoom: 2 })),
    '>radar 30.267,-97.743 z2',
  )
  // The page's own width is the narrowest, which is the one that is about the place.
  assert.equal(WeatherRadarCard.pageZoom, 0)
})

// MARK: - Age

test('a picture from a bot a minute ahead is not minus one minute old', () => {
  const ahead = WeatherRadarAge.make({ takenMinutes: P.nowMinutes + 1, now: P.now })
  assert.deepStrictEqual(ahead, { minutes: 0, isOld: false })
  assert.equal(WeatherRadarAge.isTooOldToDraw(ahead), false)
  assert.equal(
    WeatherRadarAge.isTooOldToDraw(WeatherRadarAge.make({ takenMinutes: P.nowMinutes - 121, now: P.now })),
    true,
  )
})

// MARK: - The refusals

test("the wire's reasons split into the four the screen says different things for", () => {
  const of = (reason) => WeatherRadarRefusal.make({ reason })
  assert.deepStrictEqual(of(MeshWXNotAvailableReason.noData), WeatherRadarRefusal.noPicture)
  assert.deepStrictEqual(of(MeshWXNotAvailableReason.unknownLocation), WeatherRadarRefusal.unknownPlace)
  assert.deepStrictEqual(of(MeshWXNotAvailableReason.unsupported), WeatherRadarRefusal.unsupported)
  assert.deepStrictEqual(of(MeshWXNotAvailableReason.rateLimited), WeatherRadarRefusal.sentRecently)
  assert.deepStrictEqual(of(MeshWXNotAvailableReason.botError), WeatherRadarRefusal.other(MeshWXNotAvailableReason.botError))
  assert.deepStrictEqual(of(9), WeatherRadarRefusal.other(9))
})

// MARK: - The tile a picture is of

/** A coarse tile's rectangles are twice the size, because its cells are. */
test("a coarse tile's rectangles are twice the size", () => {
  const radar = storedRadarTile({ south: 32, west: -98, size: 16, cells: [[0, 0, 2]] }).radar
  const [box] = WeatherRadarCells.rectangles({ radar })
  assert.ok(Math.abs((box.east - box.west) - 2 / 16) < 1e-9)
  assert.ok(Math.abs((box.north - box.south) - 2 / 16) < 1e-9)
})

// MARK: - Revision 13: the last hour

const square = { south: 29, west: -99, zoom: 0 }
const frameAgo = (ago, options = {}) => storedRadarTile({ ...square, takenMinutes: P.nowMinutes - ago, ...options })
const loopOf = (tiles, tile = square) => WeatherRadarLoop.make({ tile, tiles, now: P.now })
const agesOf = (loop) => loop.frames.map((one) => P.nowMinutes - one.radar.taken_min)

/**
 * "The frames of that exact tile whose `taken` is within 60 minutes before the newest held for it
 * … oldest first", and `held` their `taken` minutes, newest first: the order a loop request lists
 * them in.
 */
test('a loop is the frames of one square in the hour before its newest, oldest first', () => {
  const tiles = [0, 15, 30, 45, 60, 75].map((ago) => frameAgo(ago))
  // Another square, and another width of the same place, are other loops.
  tiles.push(storedRadarTile({ south: 32, west: -98, zoom: 0 }), storedRadarTile({ south: 28, west: -100, zoom: 1 }))
  const loop = loopOf(tiles)
  assert.deepStrictEqual(agesOf(loop), [60, 45, 30, 15, 0], 'sixty minutes before the newest is in, seventy-five is not')
  assert.deepStrictEqual(loop.held, [0, 15, 30, 45, 60].map((ago) => P.nowMinutes - ago))
  assert.equal(loop.hasGap, false)
  assert.equal(WeatherRadarLoop.newest(loop).radar.taken_min, P.nowMinutes)
  // The window runs from the newest held, not from now.
  assert.deepStrictEqual(agesOf(loopOf([40, 70, 100, 115].map((ago) => frameAgo(ago)))), [100, 70, 40])
})

test('a loop has at most five frames, the newest kept', () => {
  const loop = loopOf([0, 10, 20, 30, 40, 50, 60].map((ago) => frameAgo(ago)))
  assert.equal(loop.frames.length, WeatherRadarLoop.maxFrames)
  assert.deepStrictEqual(agesOf(loop), [40, 30, 20, 10, 0])
})

/** "At most 120 minutes old (the 'not drawn' rule of revision 11)." */
test('a frame past two hours is not in the loop', () => {
  assert.deepStrictEqual(agesOf(loopOf([100, 115, 121, 130].map((ago) => frameAgo(ago)))), [115, 100])
  assert.deepStrictEqual(agesOf(loopOf([120].map((ago) => frameAgo(ago)))), [120])
  const gone = loopOf([121, 135].map((ago) => frameAgo(ago)))
  assert.deepStrictEqual(gone, WeatherRadarLoop.empty)
  assert.equal(WeatherRadarLoop.canPlay(gone), false)
})

/** "`hasGap` when two consecutive frames are more than 20 minutes apart." */
test('a missing picture is a gap of more than twenty minutes', () => {
  assert.equal(loopOf([0, 15, 45].map((ago) => frameAgo(ago))).hasGap, true)
  assert.equal(loopOf([0, 20, 40].map((ago) => frameAgo(ago))).hasGap, false, 'twenty is not more than twenty')
  assert.equal(loopOf([0].map((ago) => frameAgo(ago))).hasGap, false)
})

/**
 * Every bot's frames go in, and two copies of one picture are one frame: the finer, then the
 * later arrival. A loop that showed one picture twice would stand still for a step.
 */
test('two copies of one picture are one frame, the finer kept', () => {
  const coarse = frameAgo(15, { size: 16, receivedAt: P.now })
  const fine = frameAgo(15, { receivedAt: P.now - 60_000 })
  const loop = loopOf([coarse, frameAgo(0), fine])
  assert.equal(loop.frames.length, 2)
  assert.equal(loop.frames[0], fine)
  assert.deepStrictEqual(loop.held, [P.nowMinutes, P.nowMinutes - 15])
})

/** Play from two frames; "Ask for the last hour" until the hour is full, at five. */
test('a loop plays from two frames and asks for more until it has five', () => {
  const of = (count) => loopOf([0, 15, 30, 45, 60].slice(0, count).map((ago) => frameAgo(ago)))
  assert.equal(WeatherRadarLoop.canPlay(of(0)), false)
  assert.equal(WeatherRadarLoop.canPlay(of(1)), false)
  assert.equal(WeatherRadarLoop.canPlay(of(2)), true)
  assert.equal(WeatherRadarLoop.isFull(of(0)), false)
  assert.equal(WeatherRadarLoop.isFull(of(4)), false)
  assert.equal(WeatherRadarLoop.isFull(of(5)), true)
  // The ask lists what the loop holds, newest first, at the width and coordinate given.
  assert.equal(
    WeatherRequest.wireText(WeatherRadarLoop.ask(of(2), { latitude: 30.27, longitude: -97.74, zoom: 0 })),
    `>radar 30.270,-97.740 loop ${WeatherRequest.utcHourMinute(P.nowMinutes)} ${WeatherRequest.utcHourMinute(P.nowMinutes - 15)}`,
  )
  // No square, no loop.
  assert.deepStrictEqual(loopOf([0, 15].map((ago) => frameAgo(ago)), null), WeatherRadarLoop.empty)
})
