// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherAlertRulesTests.swift
//
// Alert order, dedupe across bots, folding and the requests the alert buttons send, plus the
// coverage and forecast-reach rules that keep a far-away answer from reading as local.

import test from 'node:test'
import assert from 'node:assert/strict'

import { MeshWXCompass, MeshWXGeo, MeshWXSky } from '../src/meshwx/index.js'
import { WeatherRequest } from '../src/weather/WeatherRequest.js'
import {
  WeatherAlertFolding,
  WeatherAlertItems,
  WeatherAlertPlacement,
  WeatherAlertRequests,
  WeatherAlertStatus,
  WeatherCoverage,
  WeatherForecastCard,
  WeatherForecastRows,
  WeatherUpdatePlan,
} from '../src/screen/index.js'
import {
  areaRun,
  botState,
  digest,
  identityKey,
  loadTables,
  period,
  UnloadedGeometry,
  warning,
  WeatherPhoneFixture as P,
} from './helpers/screen-fixture.js'

const tables = await loadTables()

const svw42 = { event: 3, office: 35, etn: 42 }
const svw43 = { event: 3, office: 35, etn: 43 }

/** A box about 13 km across centred on `latitude` over central Austin's longitude. */
function box(latitude) {
  return [
    [latitude + 0.05, -97.8], [latitude + 0.05, -97.68],
    [latitude - 0.05, -97.68], [latitude - 0.05, -97.8],
  ]
}

function stored({ event, etn, minutes = 60, polygonAt = P.austin.latitude, areas = null, receivedAgo = 0 }) {
  return {
    warning: warning({
      event,
      etn,
      expiresMinutes: Math.floor((P.now / 1000 + minutes * 60) / 60),
      polygon: polygonAt == null ? null : box(polygonAt),
      areas,
    }),
    receivedAt: P.now - receivedAgo * 1000,
    updateCount: 0,
    seq: null,
    issuedAt: null,
    source: 0,
  }
}

function stateWith(warnings, bot = P.botID) {
  const state = botState({ botID: bot })
  for (const one of warnings) {
    state.warnings[identityKey({ event: one.warning.event, office: one.warning.office, etn: one.warning.etn })] = one
  }
  return state
}

function items(states, { place = P.place(P.austin), geometry = UnloadedGeometry } = {}) {
  return WeatherAlertItems.make({ states, place, geometry, tables, now: P.now })
}

function status(states, { place }) {
  const coverage = WeatherCoverage.make({ states, tables, now: P.now })
  return WeatherAlertStatus.evaluate({
    place,
    coverage,
    states,
    items: items(states, { place }),
    isRadioConnected: true,
    sessionStartedAt: P.now - 7200 * 1000,
    tables,
    now: P.now,
  })
}

function listOnly(mutate = () => {}) {
  const state = botState({ botID: P.botID })
  state.digest = {
    digest: digest({ nowMinutes: P.nowMinutes - 20, feedHealth: 3, entries: [] }),
    receivedAt: P.now - 1190 * 1000,
  }
  mutate(state)
  return { [String(P.botID)]: state }
}

const heatZone = [areaRun({ stateIndex: 42, isCounty: false, start: 192, run: 1 })]

// MARK: - Coverage unknown

test('a list with no station batch behind it never reads as calm', () => {
  // WX-AUS's list reaching a phone in Dallas, before any station batch has shown where WX-AUS
  // reports: the list says nothing about Dallas.
  assert.deepEqual(status(listOnly(), { place: P.place(P.dallas, { label: 'Dallas, TX' }) }), WeatherAlertStatus.coverageUnknown)
  assert.deepEqual(status(listOnly(), { place: P.place(P.austin) }), WeatherAlertStatus.coverageUnknown)
})

test('with coverage unknown the rows are still there', () => {
  const states = listOnly((state) => {
    state.warnings['3.35.42'] = stored({ event: 3, etn: 42 })
  })
  assert.ok(items(states).some((item) => item.placement.kind === 'here'))
  assert.deepEqual(status(states, { place: P.place(P.austin) }), WeatherAlertStatus.coverageUnknown)
})

// MARK: - Order

test('here first, then priority over placement, and what just expired last', () => {
  const states = {
    [String(P.botID)]: stateWith([
      stored({ event: 1, etn: 9, minutes: -5 }), // Tornado Warning here, expired
      stored({ event: 14, etn: 5, minutes: 30, polygonAt: null, areas: heatZone }), // Heat Advisory, outlines loading
      stored({ event: 1, etn: 12, polygonAt: 30.57 }), // Tornado Warning ~28 km north
      stored({ event: 3, etn: 44, minutes: 90 }), // Severe Thunderstorm Warning here
    ]),
  }
  const order = items(states).map((item) => `${item.identity.event}.${item.identity.etn}`)
  assert.deepEqual(order, ['3.44', '1.12', '14.5', '1.9'])
})

test("of two bots' copies the active one wins, then the later expiry", () => {
  const expiredButNewer = stored({ event: 3, etn: 42, minutes: -5, receivedAgo: 0 })
  const active = stored({ event: 3, etn: 42, minutes: 30, receivedAgo: 3600 })
  const longer = stored({ event: 3, etn: 42, minutes: 60, receivedAgo: 7200 })

  const pair = items({ 1: stateWith([expiredButNewer], 0x0001), 2: stateWith([active], 0x0002) })[0]
  assert.deepEqual(pair.kind, { kind: 'active' })
  assert.equal(pair.warning.expires_min, active.warning.expires_min)
  assert.deepEqual(pair.botIDs, [0x0001, 0x0002])

  const three = items({
    1: stateWith([expiredButNewer], 0x0001),
    2: stateWith([active], 0x0002),
    3: stateWith([longer], 0x0003),
  })
  assert.equal(three.length, 1)
  assert.equal(three[0].warning.expires_min, longer.warning.expires_min)
})

// Spec §3, revision 12: an alert carries its start from the stored copy, and a copy from a bot
// that said nothing about the start does not make a watch read as begun. The start changes
// nothing about where it sorts or whether it covers the place (docs/MESHWX_UI.md §3.1 U-49).
test("an alert carries its start, from another bot's copy when the shown one has none", () => {
  const begins = P.now + 10 * 3600 * 1000
  const upcoming = { ...stored({ event: 3, etn: 42, minutes: 58 * 60 }), beginsAt: begins }
  const silent = stored({ event: 3, etn: 42, minutes: 58 * 60 + 30 }) // later expiry: the shown copy

  const one = items({ [String(P.botID)]: stateWith([upcoming]) })[0]
  assert.equal(one.beginsAt, begins)
  assert.equal(one.placement.kind, 'here')
  assert.deepEqual(one.kind, { kind: 'active' }, 'a watch that has not started is still an alert about the place')

  const two = items({ 1: stateWith([upcoming], 0x0001), 2: stateWith([silent], 0x0002) })[0]
  assert.equal(two.warning.expires_min, silent.warning.expires_min, 'the later expiry is the copy shown')
  assert.equal(two.beginsAt, begins, "the other bot's start stands in")

  assert.equal(items({ [String(P.botID)]: stateWith([silent]) })[0].beginsAt, null)

  // Order is untouched: the start does not move a row.
  const withStart = items({ [String(P.botID)]: stateWith([upcoming, stored({ event: 1, etn: 12, polygonAt: 30.57 })]) })
  const without = items({
    [String(P.botID)]: stateWith([stored({ event: 3, etn: 42, minutes: 58 * 60 }), stored({ event: 1, etn: 12, polygonAt: 30.57 })]),
  })
  assert.deepEqual(withStart.map((item) => item.identity), without.map((item) => item.identity))
})

test('an upgrade marker stands in only when no bot holds the warning', () => {
  const copy = stored({ event: 3, etn: 42 })
  const marker = { warning: copy.warning, cancelledAt: P.now - 600 * 1000 }
  for (const [markerBot, warningBot] of [[0x0001, 0xfffe], [0xfffe, 0x0001]]) {
    const markerState = botState({ botID: markerBot })
    markerState.pendingUpgrades['3.35.42'] = marker
    const listed = items({ [String(markerBot)]: markerState, [String(warningBot)]: stateWith([copy], warningBot) })
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0].kind, { kind: 'active' })
  }

  const early = botState({ botID: 0x0001 })
  early.pendingUpgrades['3.35.42'] = marker
  const late = botState({ botID: 0x0002 })
  late.pendingUpgrades['3.35.42'] = { warning: copy.warning, cancelledAt: P.now - 60 * 1000 }
  const markers = items({ 1: early, 2: late })
  assert.deepEqual(markers[0].kind, { kind: 'upgradedAwaitingReplacement', cancelledAt: P.now - 60 * 1000 })
  assert.deepEqual(markers[0].botIDs, [0x0001, 0x0002])
})

// MARK: - Folding

test('storm warnings and unfinished upgrades are never folded, anything else past two is', () => {
  const tornadoes = items({ [String(P.botID)]: stateWith([1, 2, 3].map((etn) => stored({ event: 1, etn }))) })
  assert.equal(WeatherAlertFolding.fold(tornadoes, { tables }).rows.length, 3)

  const storms = items({ [String(P.botID)]: stateWith([1, 2, 3].map((etn) => stored({ event: 3, etn }))) })
  const foldedStorms = WeatherAlertFolding.fold(storms, { tables })
  assert.equal(foldedStorms.rows.length, 3)
  assert.equal(foldedStorms.folded, 0)

  const heat = items({ [String(P.botID)]: stateWith([1, 2, 3].map((etn) => stored({ event: 14, etn }))) })
  const foldedHeat = WeatherAlertFolding.fold(heat, { tables })
  assert.equal(foldedHeat.rows.length, 2)
  assert.equal(foldedHeat.folded, 1)

  const mixed = items({
    [String(P.botID)]: stateWith([
      stored({ event: 14, etn: 1 }),
      stored({ event: 14, etn: 2 }),
      stored({ event: 25, etn: 3 }),
      stored({ event: 1, etn: 4, polygonAt: 30.57 }),
    ]),
  })
  const foldedMixed = WeatherAlertFolding.fold(mixed, { tables })
  assert.deepEqual(foldedMixed.rows.map((row) => row.identity.etn), [3, 1, 4], 'the near Tornado Warning stays, in its place')
  assert.equal(foldedMixed.folded, 1)

  const upgraded = stateWith([1, 2].map((etn) => stored({ event: 14, etn })))
  const advisory = stored({ event: 14, etn: 9, minutes: 120 })
  upgraded.pendingUpgrades['14.35.9'] = { warning: advisory.warning, cancelledAt: P.now }
  const foldedUpgrade = WeatherAlertFolding.fold(items({ [String(P.botID)]: upgraded }), { tables })
  assert.ok(foldedUpgrade.rows.some((row) => row.identity.etn === 9))
  assert.equal(foldedUpgrade.folded, 0)
})

// MARK: - Requests

function missedMessages(source, { county, office = 'EWX' }) {
  return WeatherAlertRequests.missedMessages({ source, placeCountyUGC: county, placeOffice: office, tables })
}

test('missed messages ask for the list, one missing warning, or the county under an upgrade', () => {
  const gap = botState({ botID: P.botID })
  gap.needsDigest = true
  assert.deepEqual(missedMessages(gap, { county: 'TXC453' }), WeatherRequest.digest)

  const one = { ...gap, missingFromDigest: [svw42] }
  assert.deepEqual(missedMessages(one, { county: 'TXC453' }), WeatherRequest.warning({ identity: 'SV.W.EWX.42' }))

  // `>w <county>` would miss zone-coded warnings and stop at six: one identity per tap instead.
  const several = { ...one, missingFromDigest: [svw43, svw42] }
  assert.deepEqual(missedMessages(several, { county: 'TXC453' }), WeatherRequest.warning({ identity: 'SV.W.EWX.42' }))
  assert.deepEqual(missedMessages(several, { county: null }), WeatherRequest.warning({ identity: 'SV.W.EWX.42' }))

  // Upgrades are storm-based warnings, which carry county codes.
  const hays = warning({
    event: 3,
    etn: 43,
    expiresMinutes: P.nowMinutes + 30,
    areas: [areaRun({ stateIndex: 42, isCounty: true, start: 209, run: 1 })],
  })
  const upgraded = { ...one, pendingUpgrades: { '3.35.43': { warning: hays, cancelledAt: P.now } } }
  assert.deepEqual(missedMessages(upgraded, { county: 'TXC453' }), WeatherRequest.warningsTouching({ ugc: 'TXC453' }))
  assert.deepEqual(missedMessages(upgraded, { county: null }), WeatherRequest.warningsTouching({ ugc: 'TXC209' }))

  const unplacedUpgrade = botState({ botID: P.botID })
  unplacedUpgrade.pendingUpgrades['3.35.43'] = {
    warning: warning({ event: 3, etn: 43, expiresMinutes: P.nowMinutes + 30 }),
    cancelledAt: P.now,
  }
  assert.deepEqual(missedMessages(unplacedUpgrade, { county: null }), WeatherRequest.activeWarnings)
})

test('missing warnings are asked for one per tap, the most important first', () => {
  const fortWorth = tables.offices.indexOf('FWD')
  assert.ok(fortWorth >= 0)
  const heat = { event: 14, office: 35, etn: 5 }
  const tornadoFortWorth = { event: 1, office: fortWorth, etn: 20 }
  const tornadoAustin = { event: 1, office: 35, etn: 30 }
  const ask = (state, { office, refused = [] }) =>
    WeatherAlertRequests.missingWarnings({ source: state, placeOffice: office, notAvailable: refused, tables })

  const state = botState({ botID: P.botID })
  assert.equal(ask(state, { office: 'EWX' }), null)
  state.missingFromDigest = [heat, tornadoFortWorth, tornadoAustin]
  // Tornado warnings before the heat advisory; of two, the place's own office's.
  assert.deepEqual(ask(state, { office: 'EWX' }), WeatherRequest.warning({ identity: 'TO.W.EWX.30' }))
  assert.deepEqual(ask(state, { office: 'FWD' }), WeatherRequest.warning({ identity: 'TO.W.FWD.20' }))
  assert.deepEqual(ask(state, { office: null }), WeatherRequest.warning({ identity: 'TO.W.EWX.30' }))

  // What the bot said it lacks is passed over; once all have been, a new list.
  assert.deepEqual(ask(state, { office: 'EWX', refused: [tornadoAustin] }), WeatherRequest.warning({ identity: 'TO.W.FWD.20' }))
  assert.deepEqual(
    ask(state, { office: 'EWX', refused: [tornadoAustin, tornadoFortWorth] }),
    WeatherRequest.warning({ identity: 'HT.Y.EWX.5' }),
  )
  assert.deepEqual(ask(state, { office: 'EWX', refused: [tornadoAustin, tornadoFortWorth, heat] }), WeatherRequest.digest)
  assert.deepEqual(missedMessages(state, { county: 'TXC453' }), WeatherRequest.warning({ identity: 'TO.W.EWX.30' }))

  // Nothing the bundle can spell: the whole list.
  state.missingFromDigest = [{ event: 250, office: 35, etn: 1 }]
  assert.deepEqual(ask(state, { office: 'EWX' }), WeatherRequest.activeWarnings)
})

test('identities render as the bot spells them and read back', () => {
  assert.equal(WeatherAlertRequests.identityString(svw42, { tables }), 'SV.W.EWX.42')
  assert.deepEqual(WeatherAlertRequests.identity({ from: 'sv.w.ewx.42', tables }), svw42)
  assert.equal(WeatherAlertRequests.identity({ from: 'SV.W.EWX', tables }), null)
  assert.equal(WeatherAlertRequests.identity({ from: 'ZZ.W.EWX.42', tables }), null)
  assert.equal(WeatherAlertRequests.identity({ from: 'SV.W.QQQ.42', tables }), null)
  assert.equal(WeatherAlertRequests.identityString({ event: 250, office: 35, etn: 1 }, { tables }), null)
})

// MARK: - Ported from the app's copy tests

test('a near alert carries its distance and direction, a checking one is still a row', () => {
  const near = items({ [String(P.botID)]: stateWith([stored({ event: 3, etn: 21, polygonAt: 30.57 })]) })[0]
  assert.equal(near.placement.kind, 'near')
  assert.ok(near.placement.kilometres > 20 && near.placement.kilometres < 35)
  assert.equal(near.placement.direction, MeshWXCompass.north)

  const checking = items({
    [String(P.botID)]: stateWith([stored({ event: 14, etn: 1, polygonAt: null, areas: heatZone })]),
  })[0]
  assert.deepEqual(checking.placement, WeatherAlertPlacement.checking)
  assert.ok(WeatherAlertPlacement.isCardRow(checking.placement))
})

test('a day row keeps both temperatures and says when the rain is at night', () => {
  // 2026-09-14 05:00 and 09:00 America/Chicago (CDT, UTC−5).
  const issued = Date.UTC(2026, 8, 14, 10, 0, 0)
  const nine = Date.UTC(2026, 8, 14, 14, 0, 0)
  const forecast = {
    point: 1,
    issued_min: Math.floor(issued / 60000),
    first_period: 0,
    periods: [
      period({ highF: 90, popPercent: 10, windy: true, sky: MeshWXSky.other }),
      period({ lowF: 70, popPercent: 70, thunder: true, sky: MeshWXSky.other }),
    ],
  }
  const row = WeatherForecastRows.rows({ for: forecast, now: nine, timeZone: P.timeZone })[0]
  assert.equal(row.highF, 90)
  assert.equal(row.lowF, 70)
  assert.equal(row.popPercent, 70)
  assert.ok(row.popIsNight)
  assert.ok(row.thunder && row.windy)
})

// MARK: - Forecast reach

/**
 * The one place in the bundle with no forecast point anywhere near it. Revision 10 appended the
 * points for the nine offices the first build missed (ABQ, AFC, BOU, GUM, HFO, PIH, PPG, PQE,
 * PQW), so Santa Fe, Albuquerque, Anchorage and Guam all have one now; American Samoa's nearest
 * is a mountain observatory in Hawaii, four thousand kilometres away.
 */
const pagoPago = { latitude: -14.2756, longitude: -170.702 }

/**
 * Revision 10 removed `.noPointNearby`. "No forecast point near X" was a claim about *this app's
 * table*, made to a user whose bot held a forecast fifteen kilometres away, so a place with a
 * coordinate now always has something to ask for: `>f <lat>,<lon>`, which asks the same engine
 * the bot's chat asks.
 */
test('a place with no point in reach is missing with nothing to name, and asks by coordinate', () => {
  const place = P.place(pagoPago, { label: 'Pago Pago, AS' })
  const card = WeatherForecastCard.make({ states: {}, place, tables, now: P.now, timeZone: P.timeZone })
  assert.equal(card.kind, 'missing')
  assert.equal(card.point, null, 'there is no bundled point worth naming')
  assert.equal(card.kilometres, null)

  const plan = WeatherUpdatePlan.make({
    snapshot: {
      place,
      coverage: WeatherCoverage.make({ states: {}, tables, now: P.now }),
      forecast: card,
      primaryStation: { kind: 'none' },
    },
    sourceState: null,
    tables,
    now: P.now,
  })
  const forecastStep = plan.steps.find((step) => step.item === 'forecast')
  assert.deepStrictEqual(
    forecastStep.request,
    WeatherRequest.forecastAt({ latitude: pagoPago.latitude, longitude: pagoPago.longitude }),
  )
  assert.equal(WeatherRequest.wireText(forecastStep.request), '>f -14.276,-170.702')
})

/**
 * A forecast the bot chose the point for, asked about a coordinate within 25 km of the place, is
 * that place's forecast — and it is labelled as the bot's choice, because no bundled point
 * names it.
 */
test('a bot-chosen forecast asked near the place is the place\'s forecast', () => {
  const place = P.place(pagoPago, { label: 'Pago Pago, AS' })
  const state = botState({ botID: P.botID })
  state.unbundledForecasts['-14.276,-170.702'] = {
    forecast: P.dailyForecast({ point: 0xffff, issuedMinutes: P.nowMinutes - 60, temps: [[88, 76]] }),
    receivedAt: P.now,
    requestLabel: null,
    requestedHere: true,
    source: 0,
  }
  const card = WeatherForecastCard.make({
    states: { [String(P.botID)]: state }, place, tables, now: P.now, timeZone: P.timeZone,
  })
  assert.equal(card.kind, 'forecast')
  assert.equal(card.value.point, null)
  assert.equal(card.value.source.kind, 'chosenByBot')
  assert.ok(card.value.source.kilometres < 1)
  assert.deepStrictEqual(card.value.coordinate, { latitude: -14.276, longitude: -170.702 })
  assert.ok(card.value.rows.length > 0)
})

/**
 * A forecast held for a point the bot chose has no index to ask again by: `>f 65535` means
 * nothing. The coordinate is what fetched it and the coordinate is what refreshes it.
 */
test('a stale bot-chosen forecast is refreshed by the coordinate, not by an index', () => {
  const place = P.place(pagoPago, { label: 'Pago Pago, AS' })
  const state = botState({ botID: P.botID })
  state.unbundledForecasts['-14.276,-170.702'] = {
    forecast: P.dailyForecast({
      point: 0xffff, issuedMinutes: P.nowMinutes - 20 * 60, temps: [[88, 76]],
    }),
    receivedAt: P.now - 20 * 60 * 60 * 1000,
    requestLabel: null,
    requestedHere: true,
    source: 0,
  }
  const card = WeatherForecastCard.make({
    states: { [String(P.botID)]: state }, place, tables, now: P.now, timeZone: P.timeZone,
  })
  assert.equal(card.kind, 'forecast')

  const plan = WeatherUpdatePlan.make({
    snapshot: {
      place,
      coverage: WeatherCoverage.make({ states: {}, tables, now: P.now }),
      forecast: card,
      primaryStation: { kind: 'none' },
    },
    sourceState: null,
    tables,
    now: P.now,
  })
  const forecastStep = plan.steps.find((step) => step.item === 'forecast')
  assert.equal(WeatherRequest.wireText(forecastStep.request), '>f -14.276,-170.702')
})

/** Far enough away and it is somebody else's question, whatever the bot chose for it. */
test('a bot-chosen forecast asked far from the place is not its forecast', () => {
  const place = P.place(pagoPago, { label: 'Pago Pago, AS' })
  const state = botState({ botID: P.botID })
  // Honolulu: the same ocean, four thousand kilometres away.
  state.unbundledForecasts['21.307,-157.858'] = {
    forecast: P.dailyForecast({ point: 0xffff, issuedMinutes: P.nowMinutes - 60, temps: [[85, 72]] }),
    receivedAt: P.now,
    requestLabel: null,
    requestedHere: true,
    source: 0,
  }
  // And one nobody here asked about at all, which is never anywhere's forecast.
  state.unbundledForecasts['?'] = {
    forecast: P.dailyForecast({ point: 0xffff, issuedMinutes: P.nowMinutes, temps: [[90, 70]] }),
    receivedAt: P.now,
    requestLabel: 'somewhere else',
    requestedHere: false,
    source: 0,
  }
  const card = WeatherForecastCard.make({
    states: { [String(P.botID)]: state }, place, tables, now: P.now, timeZone: P.timeZone,
  })
  assert.equal(card.kind, 'missing')
})

/**
 * A place whose nearest bundled point is beyond the reach cutoff still asks by coordinate rather
 * than for that point: 213 km away is another landscape's forecast.
 */
test('a point beyond the reach cutoff is not offered even when one is held for it', () => {
  const place = P.place(pagoPago, { label: 'Pago Pago, AS' })
  const nearest = tables.nearestPoint({ toLat: pagoPago.latitude, lon: pagoPago.longitude })
  assert.ok(nearest != null)
  assert.ok(
    MeshWXGeo.distanceKilometres({
      fromLat: pagoPago.latitude,
      fromLon: pagoPago.longitude,
      toLat: nearest.lat,
      toLon: nearest.lon,
    }) > WeatherForecastCard.pointReachKilometres,
  )

  const state = botState({ botID: P.botID })
  state.forecasts[String(nearest.index)] = {
    forecast: P.dailyForecast({ point: nearest.index, issuedMinutes: P.nowMinutes - 60, temps: [[90, 60]] }),
    receivedAt: P.now,
    requestLabel: null,
    requestedHere: false,
    source: 0,
  }
  const held = WeatherForecastCard.make({
    states: { [String(P.botID)]: state },
    place,
    tables,
    now: P.now,
    timeZone: P.timeZone,
  })
  assert.equal(held.kind, 'missing', 'a forecast that far away is somewhere else\'s')
  assert.equal(held.point, null)
})

test('the reach cutoff leaves about one place in five hundred without a point', () => {
  // The cutoff's derivation, re-measured on a fixed sample of the bundle. It was one in a
  // hundred until revision 10 appended the nine offices the first build missed; what is left is
  // the Pacific territories and a handful of places in the mountain west.
  let measured = 0
  let beyond = 0
  for (let index = 0; index < tables.places.length; index += 25) {
    const place = tables.places[index]
    const point = tables.nearestPoint({ toLat: place.lat, lon: place.lon })
    if (point == null) continue
    const kilometres = MeshWXGeo.distanceKilometres({
      fromLat: place.lat,
      fromLon: place.lon,
      toLat: point.lat,
      toLon: point.lon,
    })
    if (kilometres > 1000) continue
    measured += 1
    if (kilometres > WeatherForecastCard.pointReachKilometres) beyond += 1
  }
  assert.ok(measured > 1000)
  const share = beyond / measured
  assert.ok(share > 0 && share < 0.005, `${beyond} of ${measured} beyond ${WeatherForecastCard.pointReachKilometres} km`)
})
