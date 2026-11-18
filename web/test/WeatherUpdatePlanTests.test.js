// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherUpdatePlanTests.swift
//
// What one tap on Update asks for, branch by branch (docs/MESHWX_UI.md §11).

import test from 'node:test'
import assert from 'node:assert/strict'

import { MeshWXGeo, MeshWXSky } from '../src/meshwx/index.js'
import { WeatherBot, WeatherRequest, WeatherSessionInfo } from '../src/weather/index.js'
import {
  WeatherConditions,
  WeatherCoverage,
  WeatherNearbyStation,
  WeatherSavedPlace,
  WeatherSavedPlaces,
  WeatherScreenSnapshot,
  WeatherStations,
  WeatherUpdatePlan,
} from '../src/screen/index.js'
import {
  botState,
  digest,
  loadedGeometry,
  loadGeometry,
  loadTables,
  observation,
  WeatherPhoneFixture as P,
} from './helpers/screen-fixture.js'

const tables = await loadTables()
// A stated zone list is read against the place's own UGCs, and a place with none cannot be placed
// — which is unknown, not outside. The outlines are parsed lazily, so the suite loads them first,
// as the screen does on the way in.
await loadGeometry()
const geometry = loadedGeometry()

const wxAus = WeatherBot.make({
  publicKey: new Uint8Array([0x1d, 0x04, ...new Array(30).fill(0x55)]),
  name: 'WX-AUS',
  latitude: 0,
  longitude: 0,
  lastAdvert: null,
})

function snapshotOf(state, { place, now = P.now }) {
  return WeatherScreenSnapshot.make(
    WeatherScreenSnapshot.Inputs.make({
      states: { [String(P.botID)]: state },
      bots: [wxAus],
      preferredBotID: null,
      place,
      isRadioConnected: true,
      firmwareSupportsWeather: true,
      firmwareVersion: 'v1.15.0',
      hasWeatherChannel: true,
      session: WeatherSessionInfo.make({ startedAt: now - 3600 * 1000 }),
      now,
      timeZone: P.timeZone,
    }),
    { geometry, tables },
  )
}

/** A bundled station as the screen builder hands it over: its distance from the place. */
function nearby(icao, coordinate) {
  if (coordinate == null) return null
  const station = tables.station({ icao })
  if (station == null) return null
  return WeatherNearbyStation.make({
    icao,
    name: station.name,
    kilometres: MeshWXGeo.distanceKilometres({
      fromLat: coordinate.latitude,
      fromLon: coordinate.longitude,
      toLat: station.lat,
      toLon: station.lon,
    }),
  })
}

/**
 * `askedCoverage`: the coverage step has its own tests below, so everything else is read with it
 * already asked rather than repeating one more step in every expectation.
 */
function plan(
  state,
  { place = P.place(P.austin), county = null, zone = null, nearbyStation = null, askedCoverage = true, now = P.now } = {},
) {
  return WeatherUpdatePlan.make({
    snapshot: snapshotOf(state, { place, now }),
    sourceState: state,
    placeCountyUGC: county,
    placeZoneUGC: zone,
    nearbyStation: nearbyStation == null ? null : nearby(nearbyStation, place?.coordinate ?? null),
    coverageAlreadyAsked: askedCoverage,
    tables,
    now,
  })
}

/** A list built `builtMinutesAgo` before now and received then too, unless `receivedAt` says otherwise. */
function withDigest(state, { builtMinutesAgo, receivedAt = null, entries = [] }) {
  return {
    ...state,
    digest: {
      digest: digest({ nowMinutes: P.nowMinutes - builtMinutesAgo, feedHealth: 3, entries }),
      receivedAt: receivedAt ?? P.now - builtMinutesAgo * 60 * 1000,
    },
  }
}

const items = (one) => WeatherUpdatePlan.items(one)

// MARK: - Alerts

test('with no list held the plan asks for one', () => {
  const built = plan(P.state())
  assert.equal(built.steps[0].item, 'alerts')
  assert.deepEqual(built.steps[0].request, WeatherRequest.digest)
  assert.equal(built.currentAsOf, null)
})

test('a list inside its three-hour cadence is not asked for again', () => {
  assert.ok(!items(plan(withDigest(P.state(), { builtMinutesAgo: 20 }))).includes('alerts'))
})

test('a list older than three hours and a quarter is asked for again', () => {
  assert.equal(items(plan(withDigest(P.state(), { builtMinutesAgo: 194 }))).includes('alerts'), false)
  const old = plan(withDigest(P.state(), { builtMinutesAgo: 200 }))
  assert.deepEqual(old.steps.map((step) => step.request), [WeatherRequest.digest])
})

test('an old list the channel delivered a minute ago is held back, not called current', () => {
  // Airtime etiquette (spec §19): the channel delivered it a minute ago, so the bot would only
  // rebuild the same answer. Not current either, so nothing claims it is.
  const built = plan(withDigest(P.state(), { builtMinutesAgo: 200, receivedAt: P.now - 60 * 1000 }))
  assert.ok(WeatherUpdatePlan.isEmpty(built))
  assert.deepEqual(built.justReceived, ['alerts'])
  assert.equal(built.currentAsOf, null)
})

test('a gap asks for a list however fresh the held one is', () => {
  // A gap says what was missed came *after* whatever was received, so the five-minute rule never
  // holds the request back (§3.1 R-3).
  const state = withDigest(P.state(), { builtMinutesAgo: 20, receivedAt: P.now - 30 * 1000 })
  state.needsDigest = true
  const built = plan(state)
  assert.deepEqual(built.steps.map((step) => step.request), [WeatherRequest.digest])
  assert.deepEqual(built.justReceived, [])
})

test('a warning the list named that never arrived is asked for by identity', () => {
  const identity = { event: 14, office: 35, etn: 3 }
  const state = withDigest(P.state(), { builtMinutesAgo: 20 })
  state.missingFromDigest = [identity]
  assert.deepEqual(plan(state).steps.map((step) => step.request), [WeatherRequest.warning({ identity: 'HT.Y.EWX.3' })])
})

// MARK: - Outside the bot's area

test("outside the area the place's zone and county are asked for by name", () => {
  const built = plan(P.state(), {
    place: P.place(P.dallas, { label: 'Dallas, TX' }),
    county: 'TXC113',
    zone: 'TXZ103',
    nearbyStation: 'KDAL',
  })
  assert.deepEqual(built.steps.map((step) => step.item), ['alerts', 'areaAlerts', 'areaAlerts', 'readings', 'forecast'])
  assert.deepEqual(built.steps[1].request, WeatherRequest.warningsTouching({ ugc: 'TXZ103' }))
  assert.deepEqual(built.steps[2].request, WeatherRequest.warningsTouching({ ugc: 'TXC113' }))
  assert.deepEqual(built.steps[3].request, WeatherRequest.observation({ station: 'KDAL' }))
})

test('inside the area nothing is asked by county', () => {
  const built = plan(withDigest(P.state(), { builtMinutesAgo: 20 }), { county: 'TXC453', zone: 'TXZ192' })
  assert.ok(!items(built).includes('areaAlerts'))
})

// MARK: - Readings

test('a reading inside the hour is left alone', () => {
  assert.ok(!items(plan(P.state())).includes('readings'))
})

test('a missed hourly batch asks for the batch the bot would send now', () => {
  const built = plan(P.state({ observationsAgo: 75 * 60 }))
  assert.ok(built.steps.some((step) => step.request.kind === 'observations'))
})

test('a station outside the newest batch is asked for by its code', () => {
  // A station the bot has dropped from its batch, or one held from somebody's single-station
  // answer, cannot be refreshed by a bare `>o`.
  const station = tables.station({ at: 194 })
  assert.ok(station != null)
  const state = botState({
    botID: P.botID,
    lastHeardAt: P.now - 75 * 60 * 1000,
    lastLiveHeardAt: P.now - 75 * 60 * 1000,
    observations: {
      194: {
        observation: observation({ station: 194, tempF: 88, sky: MeshWXSky.few }),
        timestampMinutes: P.nowMinutes - 75,
        receivedAt: P.now - 75 * 60 * 1000,
        batchSize: 1,
        lastBatchMinutes: null,
        source: 0,
      },
    },
  })
  const built = plan(state)
  assert.ok(built.steps.some((step) => step.request.kind === 'observation' && step.request.station === station.icao))
})

test('stale readings the channel delivered a minute ago are held back', () => {
  const state = P.state({ observationsAgo: 75 * 60 })
  for (const key of Object.keys(state.observations)) {
    state.observations[key] = { ...state.observations[key], receivedAt: P.now - 60 * 1000 }
  }
  const built = plan(state)
  assert.ok(!items(built).includes('readings'))
  assert.ok(built.justReceived.includes('readings'))
})

test('with nothing held at all the batch is asked for', () => {
  const state = botState({ botID: P.botID, lastHeardAt: P.now })
  const built = plan(state)
  assert.deepEqual(built.steps.map((step) => step.request), [
    WeatherRequest.digest,
    WeatherRequest.observations,
    WeatherRequest.forecast({ point: 103 }),
  ])
})

// MARK: - A reading from 25 to 40 km (docs/MESHWX_UI.md §3.1 U-2a)

/** Wimberley, TX as saved on Rafael's phone. Its nearest station, San Marcos (KHYI), is 25.5 km
 * away: half a kilometre past the "weather here" threshold. */
const wimberley = { latitude: 29.9974, longitude: -98.0986 }

/** One KHYI reading, `minutesAgo` old, in a batch with one other station. */
function sanMarcos(minutesAgo) {
  const khyi = tables.stationIndex({ forICAO: 'KHYI' })
  const kaus = tables.stationIndex({ forICAO: 'KAUS' })
  const timestampMinutes = Math.floor((P.now / 1000 - minutesAgo * 60) / 60)
  const receivedAt = P.now - minutesAgo * 60 * 1000
  const entry = (index, tempF, windMph) => ({
    observation: observation({ station: index, tempF, sky: MeshWXSky.few, windMph }),
    timestampMinutes,
    receivedAt,
    batchSize: 2,
    lastBatchMinutes: timestampMinutes,
    source: 0,
  })
  return botState({
    botID: P.botID,
    lastHeardAt: receivedAt,
    lastLiveHeardAt: receivedAt,
    observations: { [String(khyi)]: entry(khyi, 79, 4), [String(kaus)]: entry(kaus, 78, 3) },
  })
}

test('a fresh reading 25.5 km off is shown attributed, and Update has nothing to ask', () => {
  // The field report: the answer came back and the page threw it away, while Update called
  // everything current. Now the page shows it under San Marcos' name, and Update agrees.
  const place = P.place(wimberley, { kind: 'searched', label: 'Wimberley, TX' })
  const state = sanMarcos(20)
  const station = nearby('KHYI', wimberley)
  assert.ok(station != null)
  assert.ok(station.kilometres > WeatherConditions.goodReadingKilometres)
  assert.ok(station.kilometres < WeatherConditions.labelledReadingKilometres)

  const snap = snapshotOf(state, { place })
  const conditions = WeatherConditions.make({ primary: snap.primaryStation, nearbyStation: station })
  assert.equal(conditions.kind, 'nearby')
  assert.equal(conditions.value.station.icao, 'KHYI')
  assert.equal(conditions.nearer, null)

  assert.ok(!items(plan(state, { place, nearbyStation: 'KHYI' })).includes('readings'))
})

test('an attributed reading that missed its batch is asked for again', () => {
  // Past an hourly batch it is asked for again, exactly as a reading here would be.
  const place = P.place(wimberley, { kind: 'searched', label: 'Wimberley, TX' })
  const built = plan(sanMarcos(80), { place, nearbyStation: 'KHYI' })
  const readings = built.steps.filter((step) => step.item === 'readings').map((step) => step.request)
  assert.equal(readings.length, 1)
  assert.ok(
    readings[0].kind === 'observations' ||
      (readings[0].kind === 'observation' && readings[0].station === 'KHYI'),
  )
})

test('with no station within 40 km the plan asks for no reading', () => {
  // Dallas, holding only the Austin-area fixture readings, 290 km away, and no bundled station
  // offered: the verdict is no station, and the plan agrees.
  const place = P.place(P.dallas, { kind: 'searched', label: 'Dallas, TX' })
  const snap = snapshotOf(P.state(), { place })
  const conditions = WeatherConditions.make({ primary: snap.primaryStation, nearbyStation: null })
  assert.equal(conditions.kind, 'noStation')
  assert.ok(!items(plan(P.state(), { place })).includes('readings'))
})

// MARK: - Forecast

test('a forecast issued over twelve hours ago is asked for again', () => {
  const state = withDigest(P.state(), { builtMinutesAgo: 20 })
  state.forecasts = {
    ...state.forecasts,
    103: {
      forecast: P.dailyForecast({ point: 103, issuedMinutes: P.nowMinutes - 13 * 60, temps: [[90, 70]] }),
      receivedAt: P.now - 13 * 3600 * 1000,
      requestLabel: null,
      requestedHere: true,
      source: 0,
    },
  }
  assert.deepEqual(plan(state).steps.map((step) => step.request), [WeatherRequest.forecast({ point: 103 })])
})

test('a forecast the channel delivered a minute ago is held back', () => {
  const state = withDigest(P.state(), { builtMinutesAgo: 20 })
  state.forecasts = {
    ...state.forecasts,
    103: {
      forecast: P.dailyForecast({ point: 103, issuedMinutes: P.nowMinutes - 13 * 60, temps: [[90, 70]] }),
      receivedAt: P.now - 60 * 1000,
      requestLabel: null,
      requestedHere: true,
      source: 0,
    },
  }
  const built = plan(state)
  assert.ok(WeatherUpdatePlan.isEmpty(built))
  assert.deepEqual(built.justReceived, ['forecast'])
})

test("nothing held for the place's point asks for it", () => {
  const state = withDigest(P.state(), { builtMinutesAgo: 20 })
  state.forecasts = {}
  assert.deepEqual(plan(state).steps.map((step) => step.request), [WeatherRequest.forecast({ point: 103 })])
})

// MARK: - Coverage

test('a bot that has stated nothing is asked what it covers, last', () => {
  // §14 Q4: without the bot's statement the phone cannot tell "outside the area" from "nothing
  // said yet", so it withholds both the check and the out-of-area requests — for up to three
  // hours, until the next broadcast. One packet buys the difference, and it goes last.
  const state = botState({ botID: P.botID, lastHeardAt: P.now })
  const built = plan(state, { askedCoverage: false })
  assert.deepEqual(built.steps.map((step) => step.item), ['alerts', 'readings', 'forecast', 'coverage'])
  assert.deepEqual(built.steps[built.steps.length - 1].request, WeatherRequest.coverage)
})

test('a statement already held is never asked for again', () => {
  // A statement does not go stale — it describes the bot, not an hour (§6).
  assert.ok(!items(plan(P.stating(P.statement), { askedCoverage: false })).includes('coverage'))
})

test('asking once is enough for the visit', () => {
  // One packet: a bot that did not answer must not be asked again on every tap.
  assert.ok(!items(plan(P.state())).includes('coverage'))
})

test('a planned coverage step is not something current', () => {
  // "Everything is current" is a claim about the weather held. A statement carries no time, and a
  // plan with something to send never makes the claim anyway.
  const built = plan(withDigest(P.state(), { builtMinutesAgo: 20 }), { askedCoverage: false })
  assert.deepEqual(built.steps.map((step) => step.request), [WeatherRequest.coverage])
  assert.equal(built.currentAsOf, null)
})

// MARK: - Nothing to ask for

test('with everything current the plan is empty and names the oldest content time', () => {
  // "Everything is current" is true only as of the oldest thing it was checked against — here the
  // forecast, issued three and a half hours ago.
  const built = plan(withDigest(P.state(), { builtMinutesAgo: 20 }))
  assert.ok(WeatherUpdatePlan.isEmpty(built))
  assert.deepEqual(built.justReceived, [])
  assert.equal(built.currentAsOf, (P.nowMinutes - 208) * 60000)
})

test('with no place only the alert list is planned', () => {
  assert.deepEqual(plan(P.state(), { place: null }).steps.map((step) => step.item), ['alerts'])
})

test('the order is always alerts, then readings, then forecast', () => {
  const state = botState({ botID: P.botID, lastHeardAt: P.now })
  assert.deepEqual(plan(state).steps.map((step) => step.item), ['alerts', 'readings', 'forecast'])
})

// MARK: - Weather saved places

function savedPlace(label, { lat = 30.5, lon = -97.7, minutesAgo = 0 } = {}) {
  return WeatherSavedPlace.make({
    label,
    latitude: lat,
    longitude: lon,
    chosenAt: P.now - minutesAgo * 60 * 1000,
  })
}

test('the newest choice leads the list', () => {
  const list = WeatherSavedPlaces.remember(savedPlace('Austin, TX', { lat: 30.27, lon: -97.74 }), {
    in: [savedPlace('Round Rock, TX', { minutesAgo: 10 })],
  })
  assert.deepEqual(list.map((place) => place.label), ['Austin, TX', 'Round Rock, TX'])
})

test('picking a saved place again keeps its place in the order', () => {
  // **Picking a place already on the list does not move it** (docs/MESHWX_UI.md §3.1 U-4). The
  // list is the pager's order, and the user drags it into the order they want.
  const old = savedPlace('Round Rock, TX', { minutesAgo: 60 })
  let list = [savedPlace('Austin, TX', { lat: 30.27, lon: -97.74, minutesAgo: 10 }), old]
  const again = { ...old, chosenAt: P.now }
  list = WeatherSavedPlaces.remember(again, { in: list })
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((place) => place.label), ['Austin, TX', 'Round Rock, TX'])
  assert.equal(list[1].chosenAt, P.now)
})

test('identity comes from the ZIP, the station, or the point', () => {
  // A ZIP, a station and a town are told apart by what they are, not by their label.
  const zip = WeatherSavedPlace.make({ label: 'Austin, TX 78701', latitude: 30.27, longitude: -97.74, zipCode: '78701', chosenAt: P.now })
  const otherZip = WeatherSavedPlace.make({ label: 'Austin, TX 78702', latitude: 30.26, longitude: -97.71, zipCode: '78702', chosenAt: P.now })
  const station = WeatherSavedPlace.make({
    label: 'Austin, TX',
    latitude: 30.32,
    longitude: -97.76,
    searchedAs: 'airportCode',
    stationIndex: 194,
    chosenAt: P.now,
  })
  assert.notEqual(WeatherSavedPlace.id(zip), WeatherSavedPlace.id(otherZip))
  assert.equal(WeatherSavedPlace.id(station), 'station:194')
  assert.equal(
    WeatherSavedPlace.id(savedPlace('Austin, TX', { lat: 30.2672, lon: -97.7431 })),
    WeatherSavedPlace.id(savedPlace('Austin', { lat: 30.2674, lon: -97.7429 })),
  )
})

test('the list stops at a dozen, dropping the oldest', () => {
  let list = []
  for (let index = 0; index < 15; index += 1) {
    list = WeatherSavedPlaces.remember(savedPlace(`Place ${index}`, { lat: 30 + index / 10, minutesAgo: 15 - index }), {
      in: list,
    })
  }
  assert.equal(list.length, WeatherSavedPlaces.limit)
  assert.equal(list[0].label, 'Place 14')
  assert.ok(!list.some((place) => place.label === 'Place 0'))
})

test('removing takes the row out and leaves the rest in order', () => {
  const list = [savedPlace('Austin, TX', { lat: 30.27, lon: -97.74 }), savedPlace('Round Rock, TX', { minutesAgo: 10 })]
  const left = WeatherSavedPlaces.removing(WeatherSavedPlace.id(list[0]), { from: list })
  assert.deepEqual(left.map((place) => place.label), ['Round Rock, TX'])
})

test('a saved place answers as a searched place with a town\'s radius', () => {
  const place = WeatherSavedPlace.place(savedPlace('Round Rock, TX'))
  assert.equal(place.kind, 'searched')
  assert.equal(place.uncertaintyKilometres, 5)
  assert.equal(WeatherSavedPlace.from(place, { at: P.now }).label, 'Round Rock, TX')
})

test('a reorder by ids keeps a place the drag never saw', () => {
  // A drag is written back by **id**, so it can be applied to a list that has since grown.
  const austin = savedPlace('Austin, TX', { lat: 30.27, lon: -97.74 })
  const roundRock = savedPlace('Round Rock, TX')
  const llano = savedPlace('Llano, TX', { lat: 30.75, lon: -98.68 })
  const ordered = WeatherSavedPlaces.ordering({
    ids: [WeatherSavedPlace.id(roundRock), WeatherSavedPlace.id(austin)],
    in: [austin, roundRock, llano],
  })
  assert.deepEqual(ordered.map((place) => place.label), ['Round Rock, TX', 'Austin, TX', 'Llano, TX'])
})

test('an id nothing answers to is ignored rather than dropping a row', () => {
  const austin = savedPlace('Austin, TX', { lat: 30.27, lon: -97.74 })
  const ordered = WeatherSavedPlaces.ordering({ ids: ['at:0.000,0.000', WeatherSavedPlace.id(austin)], in: [austin] })
  assert.deepEqual(ordered.map((place) => place.label), ['Austin, TX'])
})

test('a write that drops places nobody asked to drop is refused', () => {
  // The guard `WeatherSavedPlacesStore.apply` enforces (docs/MESHWX_UI.md §3.1 U-1); the store
  // itself is the weather layer's and is tested there.
  const stored = [savedPlace('Austin, TX', { lat: 30.27 }), savedPlace('Llano, TX', { lat: 30.75 })]
  const dropped = WeatherSavedPlaces.dropped([stored[0]], { from: stored })
  assert.deepEqual([...dropped], [WeatherSavedPlace.id(stored[1])])
  assert.equal(WeatherSavedPlaces.dropped(stored, { from: stored }).size, 0)
})

// MARK: - Readings for another place

test('a saved place shows the nearest reading that carries a temperature', () => {
  const states = P.states()
  const readings = WeatherStations.readings({
    states,
    coverage: WeatherCoverage.make({ states, tables, now: P.now }),
    place: P.place(P.dallas, { label: 'Dallas, TX' }),
    tables,
    now: P.now,
  })
  const near = WeatherStations.nearestReading({ in: readings, to: P.austin })
  assert.ok(near != null)
  assert.equal(near.reading.station.icao, 'KATT')
  assert.ok(near.kilometres < 10)
})

test('nothing within reach is nothing held', () => {
  const states = P.states()
  const readings = WeatherStations.readings({
    states,
    coverage: WeatherCoverage.make({ states, tables, now: P.now }),
    place: P.place(P.austin),
    tables,
    now: P.now,
  })
  assert.equal(WeatherStations.nearestReading({ in: readings, to: P.dallas }), null)
})

// MARK: - The update plan and a stated coverage

function dallasPlan(state) {
  const place = P.place(P.dallas, { label: 'Dallas, TX' })
  return WeatherUpdatePlan.make({
    snapshot: snapshotOf(state, { place }),
    sourceState: state,
    placeCountyUGC: 'TXC113',
    placeZoneUGC: 'TXZ103',
    nearbyStation: nearby('KDAL', P.dallas),
    tables,
    now: P.now,
  })
}

test('a complete statement that excludes the place asks by its zone and county', () => {
  const built = dallasPlan(P.stating(P.statement))
  assert.deepEqual(
    built.steps.filter((step) => step.item === 'areaAlerts').map((step) => step.request),
    [WeatherRequest.warningsTouching({ ugc: 'TXZ103' }), WeatherRequest.warningsTouching({ ugc: 'TXC113' })],
  )
})

test('a cut zone list is unknown and asks for nothing by area', () => {
  // A zone list the bot had to cut says "not listed", never "not covered" (spec §10). Unknown
  // spends no airtime.
  const built = dallasPlan(P.stating({ ...P.statement, zones_cut: true }))
  assert.ok(!items(built).includes('areaAlerts'))
  // The rest of the plan is unaffected: the list, the readings and the forecast still stand.
  assert.deepEqual(items(built), ['alerts', 'readings', 'forecast'])
})

test('a bot that has stated nothing and reported nothing asks for nothing by area', () => {
  const bare = botState({ botID: P.botID, lastHeardAt: P.now })
  assert.ok(!items(dallasPlan(bare)).includes('areaAlerts'))
})
