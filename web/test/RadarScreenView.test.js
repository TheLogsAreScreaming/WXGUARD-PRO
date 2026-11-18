// The radar screen's own decisions (docs/MESHWX_UI.md §18.5), without a DOM.
//
// `WeatherRadarView` is a view and has no Swift test to port; the rules it adds on top of the
// screen layer — the width control, the loop row, which frame is on screen and how long it stays
// — live in `radarScreenModel` so they can be pinned here. The canvas is not exercised: a
// stand-in `Path2D` is enough to see that a frame's map layer is built once.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RADAR_LOOP_TIMING, RADAR_WIDTHS, radarDrawing, radarLoopDelay, radarPrint, radarScreenModel,
} from '../src/ui/radio/WeatherRadarView.js'
import { WeatherRequest } from '../src/weather/index.js'
import { storedRadarTile, WeatherPhoneFixture as P } from './helpers/screen-fixture.js'

// The map layer is a canvas path; a node test has none, and only needs to see it built once.
globalThis.Path2D ??= class { rect() {} }

const austin = P.place(P.austin)
const austinLocal = { south: 29, west: -99, zoom: 0 }
const austinRegional = { south: 28, west: -100, zoom: 1 }
const at = (tile, ago, options = {}) => storedRadarTile({ ...tile, takenMinutes: P.nowMinutes - ago, ...options })
const model = (options) => radarScreenModel({ place: austin, tiles: [], zoom: 0, now: P.now, ...options })

/**
 * "Local, Regional and Wide as revision 11", and nothing else: the Detail segment of the first
 * draft, the tap that picked its spot and the square it outlined are gone. Each width frames its
 * own tile and asks for it at the place.
 */
test('the width control is Local, Regional and Wide, each framing its own tile', () => {
  assert.deepStrictEqual(RADAR_WIDTHS, [0, 1, 2])
  const local = model({ zoom: 0 })
  assert.deepStrictEqual(local.tile, austinLocal)
  assert.equal(WeatherRequest.wireText(local.request), '>radar 30.267,-97.743')
  const regional = model({ zoom: 1 })
  assert.deepStrictEqual(regional.tile, austinRegional)
  assert.equal(WeatherRequest.wireText(regional.request), '>radar 30.267,-97.743 z1')
  assert.equal(WeatherRequest.wireText(regional.loopRequest), '>radar 30.267,-97.743 z1 loop')
  // A zoom below the narrowest width reads as Local, and asks for nothing finer.
  const below = model({ zoom: -1 })
  assert.equal(below.zoom, 0)
  assert.deepStrictEqual(below.tile, austinLocal)
  assert.equal(WeatherRequest.wireText(below.request), '>radar 30.267,-97.743')

  for (const view of [local, regional]) {
    // The only shapes on the map are the alerts held: no square is outlined.
    assert.deepStrictEqual(radarDrawing({ app: null, snapshot: { place: austin, alerts: [] }, model: view }).shapes, [])
  }
  assert.deepStrictEqual(
    radarDrawing({ app: null, snapshot: { place: austin, alerts: [] }, model: regional }).bounds,
    { minLatitude: 28, maxLatitude: 32, minLongitude: -100, maxLongitude: -96 },
  )
})

/**
 * The loop row: Play / Pause from two frames, "Ask for the last hour" while fewer than five, the
 * ask listing the frames held newest first, as many as fit.
 */
test('the loop row offers what the frames allow', () => {
  const three = [0, 15, 30].map((ago) => at(austinLocal, ago))
  const view = model({ tiles: three })
  assert.equal(view.canPlay, true)
  assert.equal(view.canAskForMore, true)
  assert.equal(
    WeatherRequest.wireText(view.loopRequest),
    `>radar 30.267,-97.743 loop ${WeatherRequest.utcHourMinute(P.nowMinutes)} ${WeatherRequest.utcHourMinute(P.nowMinutes - 15)}`,
  )
  assert.equal(view.loop.hasGap, false)

  const full = model({ tiles: [0, 15, 30, 45, 60].map((ago) => at(austinLocal, ago)) })
  assert.equal(full.canAskForMore, false, 'a full hour plays without asking')

  const gappy = model({ tiles: [0, 45].map((ago) => at(austinLocal, ago)) })
  assert.equal(gappy.loop.hasGap, true, '"Some pictures from this hour are missing."')

  const none = model({})
  assert.equal(none.canPlay, false)
  assert.equal(none.canAskForMore, true)
  assert.equal(WeatherRequest.wireText(none.loopRequest), '>radar 30.267,-97.743 loop')

  // A width the place has no coordinate for asks for nothing at all.
  const nowhere = radarScreenModel({ place: null, tiles: [], zoom: 0, now: P.now })
  assert.equal(nowhere.loopRequest, null)
  assert.equal(nowhere.canAskForMore, false)
})

/**
 * "While playing or paused on an older frame, the time line shows that frame's own time and place
 * in the loop: '6:08 PM · 2 of 5', in the caution tone like any old picture" — from thirty
 * minutes, by the frame's own age. "The summary sentences always describe the newest picture."
 */
test('the frame on screen, and when the time line names it', () => {
  const tiles = [0, 15, 30].map((ago) => at(austinLocal, ago))
  const resting = model({ tiles })
  assert.equal(resting.frame, null)
  assert.equal(resting.shown.radar.taken_min, P.nowMinutes)

  const older = model({ tiles, frameIndex: 0 })
  assert.equal(older.frame.number, 1)
  assert.equal(older.frame.count, 3)
  assert.equal(older.frame.isOld, true, 'thirty minutes old')
  assert.equal(older.shown.radar.taken_min, P.nowMinutes - 30)
  assert.equal(older.picture.stored.radar.taken_min, P.nowMinutes, 'the summary stays on the newest')
  assert.equal(older.summary, older.picture.summary)
  assert.equal(model({ tiles, frameIndex: 1 }).frame.isOld, false, 'fifteen minutes is not old yet')

  // Paused on the newest is the picture at rest; playing on it names it, by its own age.
  assert.equal(model({ tiles, frameIndex: 2 }).frame, null)
  const playing = model({ tiles, frameIndex: 2, playing: true })
  assert.equal(playing.frame.number, 3)
  assert.equal(playing.frame.isOld, false, 'the newest picture is minutes old')
  const stale = model({ tiles: [40, 55].map((ago) => at(austinLocal, ago)), frameIndex: 1, playing: true })
  assert.equal(stale.frame.isOld, true, 'and in the caution tone once it is old')

  // An index the loop no longer has is the picture at rest.
  assert.equal(model({ tiles, frameIndex: 7, playing: true }).frame, null)
})

/** "Each frame shows for 0.8 s and the newest for 2 s." */
test('each frame shows for 0.8 seconds and the newest for 2', () => {
  assert.equal(RADAR_LOOP_TIMING.frameMilliseconds, 800)
  assert.equal(RADAR_LOOP_TIMING.newestMilliseconds, 2000)
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4].map((index) => radarLoopDelay({ index, count: 5 })), [800, 800, 800, 800, 2000],
  )
})

/**
 * "Each frame's drawing is made once, not on every step", and a step never moves the camera: the
 * frame is outside the fingerprint that re-frames the map.
 */
test('a step of the loop swaps a layer built once, and does not re-frame the map', () => {
  const tiles = [0, 15].map((ago) => at(austinLocal, ago, { cells: [[3, 4, 2]] }))
  const snapshot = { place: austin, alerts: [] }
  const first = model({ tiles, frameIndex: 0, playing: true })
  const second = model({ tiles, frameIndex: 1, playing: true })
  const again = model({ tiles, frameIndex: 0, playing: true })

  const layer = radarDrawing({ app: null, snapshot, model: first }).cellLayer
  assert.ok(layer != null)
  assert.notEqual(radarDrawing({ app: null, snapshot, model: second }).cellLayer, layer, 'another frame')
  assert.equal(radarDrawing({ app: null, snapshot, model: again }).cellLayer, layer, 'built once, kept')

  assert.equal(radarPrint({ app: null, snapshot, model: first }), radarPrint({ app: null, snapshot, model: second }))
  // Another width is another square, and that does re-frame.
  assert.notEqual(
    radarPrint({ app: null, snapshot, model: first }),
    radarPrint({ app: null, snapshot, model: model({ zoom: 1, tiles }) }),
  )
})
