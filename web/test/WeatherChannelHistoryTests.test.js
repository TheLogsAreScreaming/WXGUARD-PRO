// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherChannelHistoryTests.swift
//
// What the channel carried, and what the phone kept of it (docs/MESHWX_UI.md §12).
//
// Both lists are read from the held state alone, which records no requester: a scheduled broadcast
// and an answer to somebody's question are the same thing on a broadcast channel, and nothing here
// tells them apart or claims to.

import test from 'node:test'
import assert from 'node:assert/strict'

import { MeshWXSky, MeshWXTextSubject } from '../src/meshwx/index.js'
import { WeatherRequest } from '../src/weather/WeatherRequest.js'
import {
  WeatherAlertItems,
  WeatherCache,
  WeatherChannelSubject,
  WeatherCoverage,
  WeatherHeard,
  WeatherStations,
} from '../src/screen/index.js'
import {
  areaRun,
  botState,
  coverageMessage,
  digest,
  loadedGeometry,
  loadGeometry,
  loadTables,
  observation,
  period,
  storedRadarTile,
  warning,
} from './helpers/screen-fixture.js'

const tables = await loadTables()
await loadGeometry()
const geometry = loadedGeometry()

/** `bot = 19578` (0x4C7A) in every kit vector. */
const botID = 19578
const t0 = 1_789_436_700 * 1000 // 2026-09-15 00:45 UTC
const t0Minutes = Math.floor(1_789_436_700 / 60)
const svw42 = { event: 3, office: 35, etn: 42 }

const fixtureWarning = warning({
  event: 3,
  office: 35,
  etn: 42,
  expiresMinutes: t0Minutes + 45,
  tornado: 2,
  polygon: [[30.52, -97.98], [30.61, -97.62], [30.38, -97.41]],
  areas: [areaRun({ stateIndex: 42, isCounty: true, start: 453, run: 1 })],
})

/** One of each kind, oldest first, all inside the day the page looks back over. */
function state() {
  const ago = (seconds) => t0 - seconds * 1000
  return botState({
    botID,
    lastHeardAt: ago(100),
    lastLiveHeardAt: ago(100),
    digest: {
      digest: digest({
        nowMinutes: t0Minutes,
        feedHealth: 7,
        entries: [{ identity: svw42, expiresRelativeMinutes: 45 }],
      }),
      receivedAt: ago(600),
    },
    warnings: {
      '3.35.42': { warning: fixtureWarning, receivedAt: ago(500), updateCount: 0, seq: 2, issuedAt: null, source: 0 },
    },
    observations: {
      202: {
        observation: observation({ station: 202, tempF: 88 }),
        timestampMinutes: t0Minutes,
        receivedAt: ago(400),
        batchSize: 2,
        lastBatchMinutes: t0Minutes,
        source: 0,
      },
      860: {
        observation: observation({ station: 860, tempF: 84 }),
        timestampMinutes: t0Minutes,
        receivedAt: ago(400),
        batchSize: 2,
        lastBatchMinutes: t0Minutes,
        source: 0,
      },
    },
    forecasts: {
      102: {
        forecast: {
          point: 102,
          issued_min: t0Minutes,
          first_period: 1,
          periods: [period({ lowF: 73, popPercent: 20, sky: MeshWXSky.scattered }), period({ highF: 93, popPercent: 40, sky: MeshWXSky.broken, thunder: true })],
        },
        receivedAt: ago(300),
        requestLabel: null,
        requestedHere: false,
        source: 0,
      },
    },
    texts: {
      7: {
        subject: MeshWXTextSubject.metarOrTAF,
        group: 7,
        total: 1,
        chunks: { 0: 'METAR KAUS' },
        firstReceivedAt: ago(200),
        lastReceivedAt: ago(200),
        request: null,
        source: 0,
        wasCut: false,
      },
    },
    coverage: {
      coverage: coverageMessage({
        latitude: 30.2672,
        longitude: -97.7431,
        radiusKilometres: 120,
        stationCap: 14,
        officeIndices: [35, 40, 51, 113],
        areas: [areaRun({ stateIndex: 42, isCounty: false, start: 155, run: 6 })],
      }),
      receivedAt: ago(100),
    },
  })
}

// MARK: - Heard

test("the channel's traffic is listed newest first, a batch as one row", () => {
  // Fourteen readings arrived as one message; fourteen rows would bury everything else the channel
  // carried, so a batch is one row that says how many stations it held.
  const heard = WeatherHeard.make({ states: { [String(botID)]: state() }, now: t0 })
  assert.equal(heard.length, 6)
  assert.deepEqual(heard.map((item) => item.subject), [
    WeatherChannelSubject.coverage,
    WeatherChannelSubject.text({ subject: MeshWXTextSubject.metarOrTAF, request: null }),
    WeatherChannelSubject.forecast({ point: 102, label: null }),
    WeatherChannelSubject.readings({ stations: 2 }),
    WeatherChannelSubject.warning(svw42),
    WeatherChannelSubject.alertList({ entries: 1 }),
  ])
  assert.deepEqual(
    heard.map((item) => item.receivedAt),
    [...heard.map((item) => item.receivedAt)].sort((lhs, rhs) => rhs - lhs),
  )
})

test('a batch whose stations reported at different times is still one row', () => {
  // Since revision 5 each reading carries when *that station* reported, so one hourly batch holds
  // as many times as it has stations. The row is still one row: it is keyed by the batch's own
  // time, not by the stations'.
  const built = botState({ botID })
  const ages = [[202, 88, 0], [860, 84, 17], [194, 86, 41]]
  for (const [index, tempF, age] of ages) {
    built.observations[String(index)] = {
      observation: observation({ station: index, tempF, ageMinutes: age }),
      timestampMinutes: t0Minutes - age,
      receivedAt: t0 - 400 * 1000,
      batchSize: 3,
      lastBatchMinutes: t0Minutes,
      source: 0,
    }
  }
  assert.equal(new Set(Object.values(built.observations).map((one) => one.timestampMinutes)).size, 3)

  const heard = WeatherHeard.make({ states: { [String(botID)]: built }, now: t0 })
  assert.deepEqual(heard.map((item) => item.subject), [WeatherChannelSubject.readings({ stations: 3 })])
  assert.equal(heard[0].contentAt, t0Minutes * 60000)
})

test('content times come from the message, and only where it carries one', () => {
  const heard = WeatherHeard.make({ states: { [String(botID)]: state() }, now: t0 })
  const list = heard.find((item) => item.subject.kind === 'alertList')
  assert.ok(list != null)
  assert.equal(list.contentAt, t0Minutes * 60000)
  assert.equal(list.receivedAt, t0 - 600 * 1000)
  // A warning, a text reply and a statement carry no time of their own (spec §3, §10, §8).
  assert.equal(heard.find((item) => item.subject.kind === 'warning').contentAt, null)
  assert.equal(heard.find((item) => item.subject.kind === 'coverage').contentAt, null)
})

test('nothing older than a day is listed', () => {
  assert.equal(WeatherHeard.make({ states: { [String(botID)]: state() }, now: t0 + 25 * 3600 * 1000 }).length, 0)
})

test('the list is a page, not a history', () => {
  const built = botState({ botID })
  for (let point = 0; point < 40; point += 1) {
    built.forecasts[String(point)] = {
      forecast: { point, issued_min: t0Minutes, first_period: 0, periods: [] },
      receivedAt: t0 - point * 1000,
      requestLabel: null,
      requestedHere: false,
      source: 0,
    }
  }
  assert.equal(WeatherHeard.make({ states: { [String(botID)]: built }, now: t0 }).length, WeatherHeard.limit)
})

// MARK: - Cache

function cacheOf(one, { place = null } = {}) {
  const states = { [String(botID)]: one }
  const readings = WeatherStations.readings({
    states,
    coverage: WeatherCoverage.make({ states, tables, now: t0 }),
    place,
    tables,
    now: t0,
  })
  const alerts = WeatherAlertItems.make({ states, place, geometry, tables, now: t0 })
  return WeatherCache.make({ states, readings, alerts, tables })
}

test('the cache groups what the phone is holding and counts it', () => {
  const cache = cacheOf(state())
  assert.deepEqual(cache.groups.map((group) => group.group), ['readings', 'forecasts', 'airportReports', 'warningsElsewhere'])
  assert.equal(cache.total, cache.groups.reduce((total, group) => total + group.items.length, 0))
  assert.equal(cache.groups.find((group) => group.group === 'forecasts').items.length, 1)
  assert.equal(cache.groups.find((group) => group.group === 'airportReports').items.length, 1)
  assert.equal(cache.groups.find((group) => group.group === 'warningsElsewhere').items.length, 1)
})

test('a product reply is not cache, it is the reports screen', () => {
  // The Weather Service products have a screen of their own; this page accounts for what would
  // otherwise go unaccounted for.
  const built = state()
  built.texts['9'] = {
    subject: MeshWXTextSubject.forecastDiscussion,
    group: 9,
    total: 1,
    chunks: { 0: 'AFD' },
    firstReceivedAt: t0,
    lastReceivedAt: t0,
    request: null,
    source: 0,
    wasCut: false,
  }
  assert.equal(cacheOf(built).groups.find((group) => group.group === 'airportReports').items.length, 1)
  assert.ok(!cacheOf(built).groups.some((group) => group.items.length > 1 && group.group === 'airportReports'))
})

test('a row opens the screen that shows it, and guesses none where it cannot know', () => {
  // A reply nobody here asked for names only its subject, so it gets no destination rather than a
  // guessed one — a station screen reached from somebody else's METAR would be a claim.
  const overheard = cacheOf(state()).groups.find((group) => group.group === 'airportReports').items[0]
  assert.equal(overheard.destination, null)

  const built = state()
  built.texts['7'].request = WeatherRequest.metar({ station: 'KAUS' })
  const index = tables.stationIndex({ forICAO: 'KAUS' })
  assert.ok(index != null)
  const owned = cacheOf(built).groups.find((group) => group.group === 'airportReports').items[0]
  assert.deepEqual(owned.destination, { kind: 'station', value: index })

  // A forecast has no screen of its own: a point becomes a place in Places, not here.
  assert.equal(cacheOf(built).groups.find((group) => group.group === 'forecasts').items[0].destination, null)
})

test('a warning elsewhere opens its own alert', () => {
  const item = cacheOf(state()).groups.find((group) => group.group === 'warningsElsewhere').items[0]
  assert.deepEqual(item.destination, { kind: 'alert', value: svw42 })
  assert.deepEqual(item.subject, WeatherChannelSubject.warning(svw42))
})

test('nothing held is an empty cache', () => {
  assert.equal(cacheOf(botState({ botID })).total, 0)
})

/**
 * A radar tile is one row per square of earth held, whatever its width, and it opens nothing: a
 * cached row knows a tile and not a place, and the radar screen is reached from the card of the
 * place it is about (docs/MESHWX_UI.md §12).
 */
test('every radar tile held is a row of its own, named by its square', () => {
  const built = state()
  built.radarTiles = [
    storedRadarTile({ south: 29, west: -99, zoom: 0, takenMinutes: t0Minutes - 12, receivedAt: t0 - 60_000 }),
    storedRadarTile({ south: 28, west: -100, zoom: 2, takenMinutes: t0Minutes - 14, receivedAt: t0 - 120_000 }),
  ]
  const group = cacheOf(built).groups.find((one) => one.group === 'radarPictures')
  assert.equal(group.items.length, 2)
  assert.deepEqual(group.items[0].subject, WeatherChannelSubject.radar({ tile: { south: 29, west: -99, zoom: 0 } }))
  // The picture's own time, not when the packet arrived.
  assert.equal(group.items[0].contentAt, (t0Minutes - 12) * 60_000)
  assert.equal(group.items[0].destination, null)
  assert.equal(group.items[0].id, `radar-${botID}-0-29--99`)
  // Last of the groups, as `allCases` orders them.
  assert.deepEqual(
    cacheOf(built).groups.map((one) => one.group),
    ['readings', 'forecasts', 'airportReports', 'warningsElsewhere', 'radarPictures'],
  )

  // And the same tiles are rows of what the channel carried.
  const heard = WeatherHeard.make({ states: { [String(botID)]: built }, now: t0 })
  const row = heard.find((item) => item.subject.kind === 'radar')
  assert.deepEqual(row.subject.tile, { south: 29, west: -99, zoom: 0 })
  assert.equal(row.contentAt, (t0Minutes - 12) * 60_000)
})

/**
 * Revision 13: "one row per tile as before, its newest time, and '5 pictures' when it holds more
 * than one." The frames of a square's loop are one square of earth, not five rows of it.
 */
test('a square holding several frames is still one row, with its newest time and a count', () => {
  const built = state()
  built.radarTiles = [0, 15, 30, 45, 60].map((ago) => storedRadarTile({
    south: 29, west: -99, zoom: 0, takenMinutes: t0Minutes - ago, receivedAt: t0 - 60_000 + ago,
  }))
  built.radarTiles.push(storedRadarTile({ south: 28, west: -100, zoom: 1, takenMinutes: t0Minutes - 8 }))
  const group = cacheOf(built).groups.find((one) => one.group === 'radarPictures')
  assert.equal(group.items.length, 2)
  const local = group.items.find((item) => item.subject.tile.zoom === 0)
  assert.deepEqual(local.subject, WeatherChannelSubject.radar({ tile: { south: 29, west: -99, zoom: 0 }, frames: 5 }))
  assert.equal(local.contentAt, t0Minutes * 60_000, 'the newest picture')
  assert.equal(local.id, `radar-${botID}-0-29--99`)
  const regional = group.items.find((item) => item.subject.tile.zoom === 1)
  assert.equal(regional.subject.frames, 1)
  assert.equal(regional.id, `radar-${botID}-1-28--100`)

  // What the channel carried lists each frame as the packet it was, with its own time.
  const heard = WeatherHeard.make({ states: { [String(botID)]: built }, now: t0 })
  const rows = heard.filter((item) => item.subject.kind === 'radar')
  assert.equal(rows.length, 6)
  assert.equal(new Set(rows.map((item) => item.id)).size, 6)
  assert.ok(rows.every((item) => item.subject.frames === 1))
  assert.deepEqual(
    rows.filter((item) => item.subject.tile.zoom === 0).map((item) => item.contentAt).sort((a, b) => b - a),
    [0, 15, 30, 45, 60].map((ago) => (t0Minutes - ago) * 60_000),
  )
})
