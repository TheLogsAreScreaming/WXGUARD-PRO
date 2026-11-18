// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherScreenTests.swift

import test from 'node:test'
import assert from 'node:assert/strict'

import { MeshWXCompass, MeshWXGeo, MeshWXSky, MeshWXTables } from '../src/meshwx/index.js'
import {
  WeatherAlertItems,
  WeatherAlertPlacement,
  WeatherAlertPriority,
  WeatherAlertStatus,
  WeatherConditions,
  WeatherCoverage,
  WeatherForecastCard,
  WeatherForecastRowLabel,
  WeatherForecastRows,
  WeatherGeo,
  WeatherNames,
  WeatherOtherPlace,
  WeatherPlace,
  WeatherPrimaryStation,
  WeatherStations,
} from '../src/screen/index.js'
import {
  botState,
  digest,
  loadedGeometry,
  loadGeometry,
  loadTables,
  observation,
  period,
  UnloadedGeometry,
  warning,
  WeatherPhoneFixture as P,
} from './helpers/screen-fixture.js'

const tables = await loadTables()
await loadGeometry()
const geometry = loadedGeometry()

// MARK: - Weather names

test('station names lose their capitals and abbreviations but keep state codes', () => {
  assert.equal(WeatherNames.stationName('DRAUGHON-MILLER CNTRL TX RGNL ARPT'), 'Draughon-Miller Central TX Regional Airport')
  assert.equal(WeatherNames.stationName('AUSTIN-BERGSTROM INTL AIRPORT'), 'Austin-Bergstrom International Airport')
  assert.equal(WeatherNames.stationName('NEW BRAUNFELS MUNICIPAL AP'), 'New Braunfels Municipal Airport')
  assert.equal(WeatherNames.stationName('RANDOLPH AFB'), 'Randolph AFB')
  assert.equal(WeatherNames.stationName('Already Mixed Case'), 'Already Mixed Case')
})

test('forecast point names drop their county and state tail', () => {
  assert.equal(WeatherNames.pointName('Austin Camp Mabry-Travis TX'), 'Austin Camp Mabry')
  assert.equal(WeatherNames.pointName('Central Park-New York NY'), 'Central Park')
  assert.equal(WeatherNames.pointName('10 Mile Boxcars'), '10 Mile Boxcars')
})

test("a forecast point's tail is dropped when it is a town too", () => {
  assert.equal(
    WeatherNames.pointName('Luis Munoz Marin International Airport-San Juan'),
    'Luis Munoz Marin International Airport',
  )
  assert.equal(WeatherNames.pointName('Boerne-Kendall TX'), 'Boerne')
  assert.equal(WeatherNames.pointName('Foo-Bar'), 'Foo-Bar')
  assert.equal(WeatherNames.pointName('351001 (PATJENS)-Sherman OR'), '351001 (PATJENS)')
  // Station names never go through the point rule, and would not survive it.
  assert.equal(
    WeatherNames.stationName('OCALA INTERNATIONAL AIRPORT-JIM TAYLOR FIELD'),
    'Ocala International Airport-Jim Taylor Field',
  )
})

test('the three sites that name a forecast point agree', () => {
  const raw = 'Austin Camp Mabry-Travis TX'
  const label = WeatherNames.pointLabel(raw)
  assert.equal(label, 'Austin Camp Mabry, TX')
  assert.equal(WeatherNames.pointLabel(raw), label)
  assert.equal(WeatherNames.pointName(raw), 'Austin Camp Mabry')
  assert.equal(WeatherNames.pointState(raw), 'TX')
  assert.equal(
    WeatherNames.pointLabel('Luis Munoz Marin International Airport-San Juan'),
    'Luis Munoz Marin International Airport',
  )
  assert.equal(WeatherNames.pointLabel('Central Park-New York NY'), 'Central Park, NY')
  assert.equal(WeatherNames.pointLabel('10 Mile Boxcars'), '10 Mile Boxcars')
})

test('place labels are title case with the state', () => {
  assert.equal(WeatherNames.placeLabel({ name: 'ROUND ROCK', state: 'TX' }), 'Round Rock, TX')
  assert.equal(WeatherNames.placeLabel({ near: P.austin, tables }), 'Austin, TX')
})

// MARK: - Weather place

test('a fresh accurate fix is the current place with a half-kilometre radius', () => {
  const sample = { latitude: 30.27, longitude: -97.74, horizontalAccuracy: 20, timestamp: P.now - 30_000 }
  const place = WeatherPlace.location(sample, { label: 'Austin, TX', now: P.now })
  assert.equal(place.kind, 'current')
  assert.equal(place.uncertaintyKilometres, 0.5)
})

test('the radius grows a kilometre a minute past five minutes and stops at twenty-five', () => {
  assert.equal(WeatherPlace.uncertainty({ accuracyMetres: 100, age: 15 * 60 }), 10.5)
  assert.equal(WeatherPlace.uncertainty({ accuracyMetres: 100, age: 50 * 60 }), 25.5)
  assert.equal(WeatherPlace.uncertainty({ accuracyMetres: 3000, age: 0 }), 3)
  assert.equal(WeatherPlace.uncertainty({ accuracyMetres: -1, age: 0 }), 1)
})

test('a fix over an hour old is only where the phone was', () => {
  const sample = { latitude: 30.27, longitude: -97.74, horizontalAccuracy: 20, timestamp: P.now - 3 * 3600 * 1000 }
  assert.equal(WeatherPlace.location(sample, { label: 'Austin, TX', now: P.now }).kind, 'lastKnown')
})

test('a searched town has a town-sized radius and a readable label', () => {
  const place = WeatherPlace.searched({ name: 'ROUND ROCK', state: 'TX', lat: 30.51, lon: -97.68, population: 119_000 })
  assert.equal(place.kind, 'searched')
  assert.equal(place.uncertaintyKilometres, 5)
  assert.equal(place.label, 'Round Rock, TX')
})

// MARK: - Weather coverage

function coverageOf(states) {
  return WeatherCoverage.make({ states, tables, now: P.now })
}

test('the hourly batch is the footprint and Austin is inside it', () => {
  const coverage = coverageOf(P.states())
  assert.equal(coverage.stations.length, 14)
  assert.ok(WeatherCoverage.contains(coverage, P.austin))
  assert.deepEqual([...WeatherCoverage.botIDs(coverage, { covering: P.austin })], [P.botID])
})

test('Dallas is outside it', () => {
  const coverage = coverageOf(P.states())
  assert.ok(!WeatherCoverage.contains(coverage, P.dallas))
  const nearest = WeatherCoverage.nearest(coverage, { to: P.dallas })
  assert.ok(nearest != null)
  assert.equal(nearest.station.station.icao, 'KTPL')
  assert.ok(nearest.kilometres > 150)
})

test('a place inside the ring of stations is covered, however far from the nearest', () => {
  const coverage = coverageOf(P.states())
  // Between Temple, Caldwell and Austin Executive: about 50 km from each.
  const middle = { latitude: 30.75, longitude: -97.15 }
  assert.ok(WeatherCoverage.nearest(coverage, { to: middle }).kilometres > 40)
  assert.ok(WeatherCoverage.contains(coverage, middle))
})

test('a place past the outer stations is outside, though one is within 80 km', () => {
  const coverage = coverageOf(P.states())
  // North of Lampasas, and east of Caldwell.
  for (const outside of [{ latitude: 31.6, longitude: -98.2 }, { latitude: 30.3, longitude: -96.3 }]) {
    const nearest = WeatherCoverage.nearest(coverage, { to: outside }).kilometres
    assert.ok(nearest > WeatherCoverage.stationReachKilometres && nearest < 80)
    assert.ok(!WeatherCoverage.contains(coverage, outside))
    assert.equal(WeatherCoverage.botIDs(coverage, { covering: outside }).size, 0)
  }
  // Just west of Llano's station, outside the ring but within its reach.
  assert.ok(WeatherCoverage.contains(coverage, { latitude: 30.784, longitude: -98.85 }))
})

test('each bot covers its own ring, and two stations reach twenty kilometres', () => {
  // Austin-Bergstrom and Camp Mabry: two stations, no ring.
  const second = botState({
    botID: 0x0102,
    observations: {
      202: {
        observation: observation({ station: 202, tempF: 80 }),
        timestampMinutes: P.nowMinutes,
        receivedAt: P.now,
        batchSize: 2,
        lastBatchMinutes: P.nowMinutes,
        source: 0,
      },
      194: {
        observation: observation({ station: 194, tempF: 81 }),
        timestampMinutes: P.nowMinutes,
        receivedAt: P.now,
        batchSize: 2,
        lastBatchMinutes: P.nowMinutes,
        source: 0,
      },
    },
  })
  const coverage = coverageOf({ ...P.states(), '258': second })
  assert.equal(coverage.stations.length, 16, 'a station both bots report is in both footprints')
  assert.deepEqual([...WeatherCoverage.botIDs(coverage, { covering: P.austin })].sort((a, b) => a - b), [0x0102, P.botID])
  assert.deepEqual([...WeatherCoverage.botIDs(coverage, { covering: { latitude: 30.75, longitude: -97.15 } })], [P.botID])
})

test('a single-station answer and a day-old batch are not coverage', () => {
  const state = P.state({ observationsAgo: 25 * 3600 })
  state.observations['1000'] = {
    observation: observation({ station: 1000, tempF: 70 }),
    timestampMinutes: P.nowMinutes,
    receivedAt: P.now,
    batchSize: 1,
    lastBatchMinutes: null,
    source: 0,
  }
  assert.ok(WeatherCoverage.isEmpty(coverageOf({ [String(P.botID)]: state })))
})

test('a single-station answer leaves the station in the footprint it was reported in', () => {
  const state = P.state()
  const before = coverageOf({ [String(P.botID)]: state })
  assert.equal(before.stations.length, 14)
  // Anybody's `>o KATT` is broadcast to everyone, and every phone keeps the newer reading. It must
  // not also take Camp Mabry out of WX-AUS's area.
  state.observations['202'] = {
    observation: observation({ station: 202, tempF: 91 }),
    timestampMinutes: P.nowMinutes,
    receivedAt: P.now,
    batchSize: 1,
    lastBatchMinutes: state.observations['202'].lastBatchMinutes,
    source: 0,
  }
  const after = coverageOf({ [String(P.botID)]: state })
  assert.deepEqual(after.stations.map((one) => one.index), before.stations.map((one) => one.index))
  assert.ok(WeatherCoverage.contains(after, P.austin))
  assert.equal(state.observations['202'].observation.temp_f, 91, 'the newer reading is still what is shown')
})

// MARK: - Alert placement and priority

const stormPolygon = [
  [30.52, -97.98], [30.61, -97.62], [30.38, -97.41], [30.15, -97.5], [30.09, -97.85], [30.28, -98.04],
]

function placementWarning({ event = 3, polygon = null, areas = null, tornado = 0, floodDamage = 0, etn = 1 } = {}) {
  return warning({ event, etn, expiresMinutes: P.nowMinutes + 60, tornado, floodDamage, polygon, areas })
}

test('a polygon covering the place is here', () => {
  assert.deepEqual(
    WeatherAlertPlacement.place(placementWarning({ polygon: stormPolygon }), {
      at: P.place(P.austin),
      geometry: UnloadedGeometry,
      tables,
    }),
    WeatherAlertPlacement.here,
  )
})

test("a polygon just beyond an accurate fix is near, but within a stale fix's radius it is here", () => {
  // 9.6 km east of the polygon's eastern vertex.
  const east = { latitude: 30.38, longitude: -97.31 }
  const accurate = WeatherAlertPlacement.place(placementWarning({ polygon: stormPolygon }), {
    at: P.place(east),
    geometry: UnloadedGeometry,
    tables,
  })
  assert.equal(accurate.kind, 'near')
  assert.ok(accurate.kilometres > 9 && accurate.kilometres < 10)
  assert.equal(accurate.direction, MeshWXCompass.west)
  assert.deepEqual(
    WeatherAlertPlacement.place(placementWarning({ polygon: stormPolygon }), {
      at: P.place(east, { radius: 12 }),
      geometry: UnloadedGeometry,
      tables,
    }),
    WeatherAlertPlacement.here,
  )
})

test('a polygon far away is elsewhere', () => {
  const sanAntonio = { latitude: 29.42, longitude: -98.49 }
  assert.deepEqual(
    WeatherAlertPlacement.place(placementWarning({ polygon: stormPolygon }), {
      at: P.place(sanAntonio),
      geometry: UnloadedGeometry,
      tables,
    }),
    WeatherAlertPlacement.elsewhere,
  )
})

test('a zone warning is checking until outlines load, then here over Travis', () => {
  const travisZone = [{ state: 42, county: false, start: 192, run: 1 }]
  assert.deepEqual(
    WeatherAlertPlacement.place(placementWarning({ event: 24, areas: travisZone }), {
      at: P.place(P.austin),
      geometry: UnloadedGeometry,
      tables,
    }),
    WeatherAlertPlacement.checking,
  )
  assert.deepEqual(
    WeatherAlertPlacement.place(placementWarning({ event: 24, areas: travisZone }), {
      at: P.place(P.austin),
      geometry,
      tables,
    }),
    WeatherAlertPlacement.here,
  )
})

test('an area with no outline near the place is unplaced, never elsewhere', () => {
  // Zone 999 has neither an outline nor a centroid in the bundle.
  const unknownZone = [{ state: 42, county: false, start: 999, run: 1 }]
  assert.deepEqual(
    WeatherAlertPlacement.place(placementWarning({ event: 24, areas: unknownZone }), {
      at: P.place(P.austin),
      geometry,
      tables,
    }),
    WeatherAlertPlacement.unplaced,
  )
  assert.deepEqual(
    WeatherAlertPlacement.place(placementWarning({ event: 24 }), { at: P.place(P.austin), geometry, tables }),
    WeatherAlertPlacement.unplaced,
  )
})

test('tornado warnings outrank everything, then the tagged storms', () => {
  const rank = (options) => WeatherAlertPriority.rank(placementWarning(options), { tables })
  const ranks = [
    rank({ event: 1 }),
    rank({ event: 6, floodDamage: 2 }),
    rank({ event: 3, tornado: 1 }),
    rank({ event: 6 }),
    rank({ event: 3 }),
    rank({ event: 25 }),
    rank({ event: 14 }),
  ]
  assert.deepEqual(ranks, [0, 2, 3, 4, 5, 7, 8])
})

// MARK: - Alert items and status

function storedWarning({ etn = 42, event = 3, expiresMinutes = null, polygon = undefined, receivedAt }) {
  const shape =
    polygon === undefined
      ? [[30.52, -97.98], [30.61, -97.62], [30.38, -97.41], [30.15, -97.5], [30.09, -97.85]]
      : polygon
  return {
    warning: warning({ event, etn, expiresMinutes: expiresMinutes ?? P.nowMinutes + 60, polygon: shape }),
    receivedAt,
    updateCount: 0,
    seq: null,
    issuedAt: null,
    source: 0,
  }
}

function storedDigest({ builtMinutes, entries = [], feedHealth = 3, receivedAt }) {
  return { digest: digest({ nowMinutes: builtMinutes, feedHealth, entries }), receivedAt }
}

function statusOf(states, { place, connected = true, session = P.now - 7200 * 1000 }) {
  const coverage = coverageOf(states)
  const items = WeatherAlertItems.make({ states, place, geometry, tables, now: P.now })
  return WeatherAlertStatus.evaluate({
    place,
    coverage,
    states,
    items,
    isRadioConnected: connected,
    sessionStartedAt: session,
    tables,
    now: P.now,
  })
}

/** A phone that heard a fresh, complete list twenty minutes ago. */
function listening(mutate = () => {}) {
  const state = P.state()
  state.digest = storedDigest({ builtMinutes: P.nowMinutes - 20, receivedAt: P.now - 1190 * 1000 })
  mutate(state)
  return { [String(P.botID)]: state }
}

test("the owner's phone had no alert list, so alerts are not checked", () => {
  assert.deepEqual(statusOf(P.states(), { place: P.place(P.austin) }), WeatherAlertStatus.notChecked)
})

test('no place and out of coverage come first', () => {
  assert.deepEqual(statusOf(listening(), { place: null }), WeatherAlertStatus.noPlace)
  assert.deepEqual(
    statusOf(listening(), { place: P.place(P.dallas, { label: 'Dallas, TX' }) }),
    WeatherAlertStatus.outOfCoverage,
  )
})

test('a fresh complete list while listening, with nothing anywhere, is the green check', () => {
  assert.deepEqual(
    statusOf(listening(), { place: P.place(P.austin) }),
    WeatherAlertStatus.clear({ asOf: (P.nowMinutes - 20) * 60000 }),
  )
})

test('offline, stale feed, missed messages, and an old list each withhold the check', () => {
  assert.deepEqual(
    statusOf(listening(), { place: P.place(P.austin), connected: false }),
    WeatherAlertStatus.radioOffline({ listAsOf: (P.nowMinutes - 20) * 60000 }),
  )

  const quiet = P.state()
  quiet.digest = storedDigest({ builtMinutes: P.nowMinutes - 20, feedHealth: 75, receivedAt: P.now })
  assert.deepEqual(
    statusOf({ [String(P.botID)]: quiet }, { place: P.place(P.austin) }),
    WeatherAlertStatus.feedQuiet({ minutesSinceProduct: 300 }),
  )

  assert.deepEqual(
    statusOf(listening((state) => { state.needsDigest = true }), { place: P.place(P.austin) }),
    WeatherAlertStatus.missedMessages,
  )

  const old = P.state()
  old.digest = storedDigest({ builtMinutes: P.nowMinutes - 200, receivedAt: P.now - 12_000 * 1000 })
  assert.deepEqual(
    statusOf({ [String(P.botID)]: old }, { place: P.place(P.austin) }),
    WeatherAlertStatus.listOld({ asOf: (P.nowMinutes - 200) * 60000 }),
  )
})

test('a quiet home office withholds calm below the other statuses, a feed that never delivered above them', () => {
  const quiet = P.state()
  quiet.digest = storedDigest({ builtMinutes: P.nowMinutes - 20, feedHealth: 75, receivedAt: P.now })
  quiet.needsDigest = true
  assert.deepEqual(statusOf({ [String(P.botID)]: quiet }, { place: P.place(P.austin) }), WeatherAlertStatus.missedMessages)
  assert.deepEqual(
    statusOf({ [String(P.botID)]: quiet }, { place: P.place(P.austin), connected: false }),
    WeatherAlertStatus.radioOffline({ listAsOf: (P.nowMinutes - 20) * 60000 }),
  )

  const never = P.state()
  never.digest = storedDigest({ builtMinutes: P.nowMinutes - 20, feedHealth: 255, receivedAt: P.now })
  never.needsDigest = true
  assert.deepEqual(statusOf({ [String(P.botID)]: never }, { place: P.place(P.austin) }), WeatherAlertStatus.feedNeverReceived)
  assert.deepEqual(
    statusOf({ [String(P.botID)]: never }, { place: P.place(P.austin), connected: false }),
    WeatherAlertStatus.feedNeverReceived,
  )
})

test('a watch the bot sends as office 0 does not say which office it carries', () => {
  // A revision 2 bot, without the Storm Prediction Center in its bundle, sent its watches as
  // office 0.
  const tornadoWatch = tables.eventByCode.get('TO.A')
  assert.ok(tornadoWatch != null)
  const state = P.state()
  state.digest = storedDigest({
    builtMinutes: P.nowMinutes - 20,
    entries: [
      { identity: { event: tornadoWatch, office: 0, etn: 612 }, expiresRelativeMinutes: 300, expiresMinutes: P.nowMinutes + 280 },
    ],
    receivedAt: P.now - 1190 * 1000,
  })
  state.missingFromDigest = []
  assert.deepEqual(
    statusOf({ [String(P.botID)]: state }, { place: P.place(P.austin) }),
    WeatherAlertStatus.clear({ asOf: (P.nowMinutes - 20) * 60000 }),
  )
})

test("a national centre's product does not say which office the bot carries", () => {
  const updated = new MeshWXTables({ index: { offices: ['ABQ', 'EWX', 'NHC', 'WNS'], stations: [], states: [] } })
  assert.ok(WeatherAlertStatus.showsOffice({ event: 3, office: 1, etn: 42 }, { tables: updated }))
  assert.ok(!WeatherAlertStatus.showsOffice({ event: 3, office: 2, etn: 9 }, { tables: updated }))
  assert.ok(!WeatherAlertStatus.showsOffice({ event: 3, office: 3, etn: 612 }, { tables: updated }))
})

test('a list received before this radio session started is old, however recent', () => {
  assert.deepEqual(
    statusOf(listening(), { place: P.place(P.austin), session: P.now - 60 * 1000 }),
    WeatherAlertStatus.listOld({ asOf: (P.nowMinutes - 20) * 60000 }),
  )
})

test('a last-known location never earns the check', () => {
  assert.deepEqual(
    statusOf(listening(), { place: P.place(P.austin, { kind: 'lastKnown' }) }),
    WeatherAlertStatus.locationOld({ since: P.now }),
  )
})

test('an alert here lets the rows speak; one elsewhere withholds the check', () => {
  const here = listening((state) => {
    state.warnings['3.35.42'] = storedWarning({ receivedAt: P.now })
  })
  assert.deepEqual(statusOf(here, { place: P.place(P.austin) }), WeatherAlertStatus.rowsSpeak)

  const farPolygon = [[29.0, -99.9], [29.1, -99.8], [29.0, -99.7]]
  const elsewhere = listening((state) => {
    state.warnings['3.35.42'] = storedWarning({ receivedAt: P.now, polygon: farPolygon })
  })
  assert.deepEqual(
    statusOf(elsewhere, { place: P.place(P.austin) }),
    WeatherAlertStatus.noneHere({ elsewhere: 1, asOf: (P.nowMinutes - 20) * 60000 }),
  )
})

test('a place forecast by an office the list does not name is not called uncovered', () => {
  // Temple is in the footprint (KTPL) but forecast by NWS Fort Worth; WX-AUS's list names
  // Austin/San Antonio. `.officeMayNotBeCovered` is no longer produced from that
  // (docs/MESHWX_UI.md §3.1 I-B18).
  const temple = { latitude: 31.1, longitude: -97.34 }
  const office = tables.nearestPoint({ toLat: temple.latitude, lon: temple.longitude })?.office
  assert.ok(office != null && office !== 'EWX')
  const state = P.state()
  state.digest = storedDigest({
    builtMinutes: P.nowMinutes - 20,
    entries: [{ identity: { event: 14, office: 35, etn: 3 }, expiresRelativeMinutes: 300, expiresMinutes: P.nowMinutes + 280 }],
    receivedAt: P.now - 1190 * 1000,
  })
  state.missingFromDigest = []
  assert.deepEqual(
    statusOf({ [String(P.botID)]: state }, { place: P.place(temple, { label: 'Temple, TX' }) }),
    WeatherAlertStatus.clear({ asOf: (P.nowMinutes - 20) * 60000 }),
  )
})

test('alerts from two bots are one row each, and a covering alert that just expired stays', () => {
  const first = P.state()
  first.warnings['3.35.42'] = storedWarning({ receivedAt: P.now })
  const second = botState({
    botID: 0x0102,
    warnings: {
      '3.35.42': storedWarning({ receivedAt: P.now - 30 * 1000 }),
      '3.35.99': storedWarning({ etn: 99, expiresMinutes: P.nowMinutes - 5, receivedAt: P.now - 3600 * 1000 }),
    },
  })
  const items = WeatherAlertItems.make({
    states: { [String(P.botID)]: first, '258': second },
    place: P.place(P.austin),
    geometry,
    tables,
    now: P.now,
  })
  assert.equal(items.length, 2)
  const active = items.find((item) => item.identity.etn === 42)
  assert.deepEqual(active.botIDs, [0x0102, P.botID])
  assert.equal(items.find((item) => item.identity.etn === 99).kind.kind, 'expiredRecently')
})

test('an upgrade whose replacement is missing is a row where it was', () => {
  const state = P.state()
  const stored = storedWarning({ receivedAt: P.now })
  state.pendingUpgrades['3.35.42'] = { warning: stored.warning, cancelledAt: P.now }
  const items = WeatherAlertItems.make({
    states: { [String(P.botID)]: state },
    place: P.place(P.austin),
    geometry,
    tables,
    now: P.now,
  })
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].kind, { kind: 'upgradedAwaitingReplacement', cancelledAt: P.now })
  assert.deepEqual(items[0].placement, WeatherAlertPlacement.here)
})

// MARK: - Weather stations

function readingsOf(state, place) {
  const states = { [String(state.botID)]: state }
  const coverage = WeatherCoverage.make({ states, tables, now: P.now })
  return WeatherStations.readings({ states, coverage, place, tables, now: P.now })
}

function primaryOf(state, place) {
  return WeatherPrimaryStation.pick({ readings: readingsOf(state, place), place })
}

test("only a station in the newest batch can be refreshed by the bot's batch", () => {
  const state = P.state()
  // Somebody's `>o` for a station the bot's batch never carries.
  state.observations['1000'] = {
    observation: observation({ station: 1000, tempF: 70 }),
    timestampMinutes: P.nowMinutes,
    receivedAt: P.now,
    batchSize: 1,
    lastBatchMinutes: null,
    source: 0,
  }
  // The next hourly batch, without Llano (1929).
  for (const [index, tempF] of P.stations.slice(1)) {
    state.observations[String(index)] = {
      observation: observation({ station: index, tempF }),
      timestampMinutes: P.nowMinutes + 58,
      receivedAt: P.now,
      batchSize: P.stations.length - 1,
      lastBatchMinutes: P.nowMinutes + 58,
      source: 0,
    }
  }

  const held = readingsOf(state, P.place(P.austin))
  const reading = (index) => held.find((one) => one.index === index)
  assert.ok(reading(202).isInLatestBatch)
  const dropped = reading(1929)
  assert.ok(dropped.isInFootprint, 'still in the area it was reported in an hour ago')
  assert.ok(!dropped.isInLatestBatch, 'a bare `>o` would come back without it')
  const answered = reading(1000)
  assert.ok(!answered.isInFootprint)
  assert.ok(!answered.isInLatestBatch)
})

test('the list leads with the station the Now card is showing', () => {
  const place = P.place(P.austin)
  const held = readingsOf(P.state(), place)
  const index = WeatherPrimaryStation.index(WeatherPrimaryStation.pick({ readings: held, place }))
  assert.ok(index != null)
  const moved = [...held.slice(1), held[0]]
  assert.equal(WeatherStations.ordered(moved, { leading: index })[0].index, index)
  assert.equal(WeatherStations.ordered(moved, { leading: index }).length, held.length)
  assert.deepEqual(WeatherStations.ordered(held, { leading: null }), held)
})

test('downtown Austin leads with Camp Mabry, not the first station in the batch', () => {
  const primary = primaryOf(P.state(), P.place(P.austin))
  assert.equal(primary.kind, 'reading')
  assert.equal(primary.value.station.icao, 'KATT')
  assert.ok(!primary.value.isStale)
  assert.ok((primary.value.distanceKilometres ?? 99) < 10)
})

test('stale readings in reach are still offered, marked stale', () => {
  const primary = primaryOf(P.state({ observationsAgo: 3 * 3600 }), P.place(P.austin))
  assert.equal(primary.kind, 'reading')
  assert.ok(primary.value.isStale)
})

test('a reading five hours old is still the weather here, and over twelve it is not', () => {
  // 2026-10-16: "No current conditions for Austin, TX" while the phone held Camp Mabry from five
  // hours before. Up to twelve hours the page shows it, marked stale; past that it asks.
  const stale = primaryOf(P.state({ observationsAgo: 5 * 3600 }), P.place(P.austin))
  assert.equal(stale.kind, 'reading')
  assert.ok(stale.value.isStale && !stale.value.isTooOld)
  assert.equal(WeatherConditions.make({ primary: stale, nearbyStation: null }).kind, 'reading')

  const old = primaryOf(P.state({ observationsAgo: 13 * 3600 }), P.place(P.austin))
  assert.ok(old.value.isTooOld)
  const conditions = WeatherConditions.make({ primary: old, nearbyStation: null })
  assert.deepEqual(conditions, WeatherConditions.ask({ icao: old.value.station.icao, kilometres: old.value.distanceKilometres }))
})

test('Dallas gets the nearest station named, not a reading', () => {
  const primary = primaryOf(P.state(), P.place(P.dallas))
  assert.equal(primary.kind, 'noneNearby')
  assert.equal(primary.nearest.station.icao, 'KTPL')
})

test('no observations and no place are their own states', () => {
  assert.deepEqual(primaryOf(botState({ botID: P.botID }), P.place(P.austin)), WeatherPrimaryStation.noObservations)
  assert.deepEqual(primaryOf(P.state(), null), WeatherPrimaryStation.noPlace)
})

// MARK: - Forecast rows

const calendarTimeZone = P.timeZone

function dateAt(day, hour) {
  // 2026-09-<day> <hour>:00 America/Chicago, which was CDT (UTC−5) all month.
  return Date.UTC(2026, 8, day, hour + 5, 0, 0)
}

const liveForecast = P.dailyForecast({
  point: 103,
  issuedMinutes: Math.floor(dateAt(14, 19) / 60000) + 52,
  temps: [[102, 77], [100, 78], [98, 75], [97, 73], [98, 74], [99, 76], [96, 81]],
})

test('the live daily forecast reads as days, not tonight at a hundred degrees', () => {
  const rows = WeatherForecastRows.rows({ for: liveForecast, now: dateAt(14, 23), timeZone: calendarTimeZone })
  assert.equal(rows.length, 7)
  assert.deepEqual(rows[0].label, WeatherForecastRowLabel.today)
  assert.equal(rows[0].highF, 102)
  assert.equal(rows[0].lowF, 77)
  assert.deepEqual(rows[1].label, WeatherForecastRowLabel.tomorrow)
  assert.equal(rows[1].highF, 100)
  assert.equal(rows[1].lowF, 78)
  assert.deepEqual(rows[2].label, WeatherForecastRowLabel.day(dateAt(16, 0)))
})

test('an evening issue that starts tomorrow is labelled tomorrow', () => {
  // Spec §7 (revision 3): entry i is the issue date plus `first / 2 + i` days.
  const evening = { ...liveForecast, first_period: 2 }
  const rows = WeatherForecastRows.rows({ for: evening, now: dateAt(14, 23), timeZone: calendarTimeZone })
  assert.equal(rows.length, 7)
  assert.deepEqual(rows[0].label, WeatherForecastRowLabel.tomorrow)
  assert.equal(rows[0].highF, 102)
  assert.deepEqual(rows[1].label, WeatherForecastRowLabel.day(dateAt(16, 0)))
})

test("next morning yesterday's day is gone", () => {
  const rows = WeatherForecastRows.rows({ for: liveForecast, now: dateAt(15, 8), timeZone: calendarTimeZone })
  assert.equal(rows.length, 6)
  assert.deepEqual(rows[0].label, WeatherForecastRowLabel.today)
  assert.equal(rows[0].highF, 100)
})

const specForecast = {
  point: 102,
  issued_min: Math.floor(dateAt(14, 15) / 60000),
  first_period: 1,
  periods: [
    period({ lowF: 73, popPercent: 20, sky: MeshWXSky.scattered, windMph: 5 }),
    period({ highF: 93, popPercent: 40, sky: MeshWXSky.broken, thunder: true, windMph: 10 }),
    period({ lowF: 72, popPercent: 30, sky: MeshWXSky.broken, windy: true, windMph: 25 }),
    period({ highF: 90, popPercent: 60, sky: MeshWXSky.rain, windMph: 20 }),
  ],
}

test('spec periods pair each day with its night and keep every hazard', () => {
  const rows = WeatherForecastRows.rows({ for: specForecast, now: dateAt(14, 20), timeZone: calendarTimeZone })
  assert.deepEqual(rows.map((row) => row.label), [
    WeatherForecastRowLabel.tonight,
    WeatherForecastRowLabel.tomorrow,
    WeatherForecastRowLabel.day(dateAt(16, 0)),
  ])
  assert.equal(rows[0].lowF, 73)
  assert.equal(rows[0].highF, null)
  assert.ok(rows[0].isNightIcon)
  const tomorrow = rows[1]
  assert.equal(tomorrow.highF, 93)
  assert.equal(tomorrow.lowF, 72)
  assert.ok(tomorrow.thunder && tomorrow.windy, "the day's thunder and the night's wind both reach the row")
  assert.equal(tomorrow.popPercent, 40)
  assert.ok(!tomorrow.popIsNight)
  assert.equal(tomorrow.windMph, 25)
  assert.equal(tomorrow.sky, MeshWXSky.broken)
})

test('after midnight last night is still tonight until six', () => {
  const rows = WeatherForecastRows.rows({ for: specForecast, now: dateAt(15, 1), timeZone: calendarTimeZone })
  assert.deepEqual(rows[0].label, WeatherForecastRowLabel.tonight)
  const later = WeatherForecastRows.rows({ for: specForecast, now: dateAt(15, 7), timeZone: calendarTimeZone })
  assert.deepEqual(later[0].label, WeatherForecastRowLabel.today)
  assert.equal(later[0].highF, 93)
})

test('a night with the higher rain chance says so', () => {
  const forecast = {
    point: 1,
    issued_min: Math.floor(dateAt(14, 5) / 60000),
    first_period: 0,
    periods: [period({ highF: 90, popPercent: 10 }), period({ lowF: 70, popPercent: 70, thunder: true })],
  }
  const row = WeatherForecastRows.rows({ for: forecast, now: dateAt(14, 9), timeZone: calendarTimeZone })[0]
  assert.equal(row.popPercent, 70)
  assert.ok(row.popIsNight)
  assert.ok(row.thunder)
})

// MARK: - Forecast card and other places

test('downtown Austin gets the Camp Mabry forecast the bot sent', () => {
  const card = WeatherForecastCard.make({
    states: P.states(),
    place: P.place(P.austin),
    tables,
    now: P.now,
    timeZone: P.timeZone,
  })
  assert.equal(card.kind, 'forecast')
  assert.equal(card.value.point.index, 103)
  assert.deepEqual(card.value.source, { kind: 'placePoint' })
  assert.equal(card.value.layout, 'days')
  assert.equal(card.value.rows[0].highF, 102)
})

test("Round Rock is not answered with Austin's forecast from twenty kilometres away", () => {
  const card = WeatherForecastCard.make({
    states: P.states(),
    place: P.place(P.roundRock),
    tables,
    now: P.now,
    timeZone: P.timeZone,
  })
  assert.equal(card.kind, 'missing')
  assert.notEqual(card.point.index, 103)
  assert.ok(
    Math.abs(
      card.kilometres - WeatherGeo.kilometres(P.roundRock, { latitude: card.point.lat, longitude: card.point.lon }),
    ) < 0.001,
  )
  assert.ok(card.kilometres <= WeatherForecastCard.pointReachKilometres)
})

test("a forecast knows its point's distance from the place, and whether this phone asked", () => {
  const card = WeatherForecastCard.make({
    states: P.states(),
    place: P.place(P.austin),
    tables,
    now: P.now,
    timeZone: P.timeZone,
  })
  assert.equal(card.kind, 'forecast')
  const point = { latitude: card.value.point.lat, longitude: card.value.point.lon }
  assert.ok(Math.abs(card.value.kilometres - WeatherGeo.kilometres(P.austin, point)) < 0.001)
  // The fixture's forecasts came off the channel; nothing here asked for them.
  assert.equal(WeatherForecastCard.isOwn(card.value), false)
})

test('a point standing in for the place measures from the place, not from the point it replaced', () => {
  // Round Rock's own point holds nothing, so a forecast within 10 km may stand in for it.
  const state = P.state()
  const roundRockPoint = tables.nearestPoint({ toLat: P.roundRock.latitude, lon: P.roundRock.longitude })
  assert.ok(roundRockPoint != null)
  delete state.forecasts[String(roundRockPoint.index)]
  const card = WeatherForecastCard.make({
    states: { [String(P.botID)]: state },
    place: P.place(P.roundRock),
    tables,
    now: P.now,
    timeZone: P.timeZone,
  })
  if (card.kind !== 'forecast' || card.value.source.kind !== 'nearbyPoint') {
    // Camp Mabry is more than 10 km from Round Rock, so this is `missing`; the distance the card
    // carries is still the place's own.
    return
  }
  assert.ok(Math.abs(card.value.kilometres - card.value.source.kilometres) < 0.001)
})

test('no place is its own state', () => {
  assert.deepEqual(
    WeatherForecastCard.make({ states: P.states(), place: null, tables, now: P.now, timeZone: P.timeZone }),
    WeatherForecastCard.noPlace,
  )
})

test("New York and San Juan are other people's places, newest first", () => {
  const others = WeatherOtherPlace.make({ states: P.states(), excludingPoint: 103, tables, now: P.now })
  assert.deepEqual(others.map((one) => one.point.index), [304, 1010])
})

test("a forecast this phone asked for is not someone else's place", () => {
  const state = P.state()
  state.forecasts['304'].requestedHere = true
  const others = WeatherOtherPlace.make({
    states: { [String(P.botID)]: state },
    excludingPoint: 103,
    tables,
    now: P.now,
  })
  assert.deepEqual(others.map((one) => one.point.index), [1010])
})

// The compass and the distance helper the rules lean on, kept honest against `MeshWXGeo`.
test('the screen geometry is the MeshWX geometry', () => {
  assert.equal(
    WeatherGeo.kilometres(P.austin, P.dallas),
    MeshWXGeo.distanceKilometres({
      fromLat: P.austin.latitude,
      fromLon: P.austin.longitude,
      toLat: P.dallas.latitude,
      toLon: P.dallas.longitude,
    }),
  )
  assert.equal(WeatherGeo.direction({ from: P.austin, to: P.dallas }), MeshWXCompass.northNorthEast)
})
