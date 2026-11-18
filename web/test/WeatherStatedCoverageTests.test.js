// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherStatedCoverageTests.swift
//
// The bot's own coverage statement (spec §10) deciding in, out and unknown, the station footprint
// still deciding for a bot that has not stated one, and the single office claim the statement
// supports (docs/MESHWX_UI.md §3.1 I-B18, §7.4).

import test from 'node:test'
import assert from 'node:assert/strict'

import { MeshWXCoverage } from '../src/meshwx/index.js'
import {
  WeatherAlertItems,
  WeatherAlertStatus,
  WeatherCoverage,
  WeatherCoverageVerdict,
} from '../src/screen/index.js'
import {
  botState,
  coverageMessage,
  digest,
  loadedAreas,
  loadedGeometry,
  loadGeometry,
  loadTables,
  WeatherPhoneFixture as P,
} from './helpers/screen-fixture.js'

const tables = await loadTables()
// The outlines are parsed lazily and a verdict that needs them reads "unknown" until they are
// there, so the suite loads them first — which is what the screen does on the way in.
await loadGeometry()
const geometry = loadedGeometry()
const areas = loadedAreas()

/** San Saba: in WX-AUS's stated zones (TXZ155) but 140 km out, past both the stated circle and
 * the hull of the stations it reports. */
const sanSaba = { latitude: 31.1552, longitude: -98.8176 }
/** Temple: inside the stated zones (TXZ158) and in the station footprint, but forecast by NWS
 * Fort Worth rather than Austin/San Antonio. */
const temple = { latitude: 31.1, longitude: -97.34 }

function coverageOf(states) {
  return WeatherCoverage.make({ states, tables, now: P.now, areas })
}

/** The owner's phone with a fresh, complete list, and the bot's statement where given. */
function listening(statement) {
  let state = P.state()
  state.digest = {
    digest: digest({ nowMinutes: P.nowMinutes - 20, feedHealth: 3, entries: [] }),
    receivedAt: P.now - 1190 * 1000,
  }
  if (statement != null) state = P.stating(statement, { on: state })
  return { [String(P.botID)]: state }
}

function statusOf(states, { place }) {
  const items = WeatherAlertItems.make({ states, place, geometry, tables, now: P.now })
  return WeatherAlertStatus.evaluate({
    place,
    coverage: coverageOf(states),
    states,
    items,
    isRadioConnected: true,
    sessionStartedAt: P.now - 7200 * 1000,
    tables,
    now: P.now,
  })
}

const listAsOf = WeatherAlertStatus.clear({ asOf: (P.nowMinutes - 20) * 60000 })

function place(coordinate, label) {
  return P.place(coordinate, { label })
}

// MARK: - In, out and unknown

test("the bot's own statement puts Austin inside and Dallas outside", () => {
  const coverage = coverageOf({ [String(P.botID)]: P.stating(P.statement) })
  assert.equal(WeatherCoverage.verdict(coverage, { for: place(P.austin, 'Austin, TX') }), WeatherCoverageVerdict.inside)
  assert.deepEqual([...WeatherCoverage.botIDs(coverage, { covering: P.austin })], [P.botID])
  assert.equal(WeatherCoverage.verdict(coverage, { for: place(P.dallas, 'Dallas, TX') }), WeatherCoverageVerdict.outside)
  assert.ok(!WeatherCoverage.contains(coverage, P.dallas))
})

test('a stated zone counts though the place is past the stated circle and the stations', () => {
  // The statement outranks the footprint: a zone the bot lists is covered though its stations
  // never reach there, which is the case the hull got wrong.
  assert.ok(!MeshWXCoverage.circleContains(P.statement, sanSaba))
  const there = place(sanSaba, 'San Saba, TX')
  assert.equal(WeatherCoverage.verdict(coverageOf(P.states()), { for: there }), WeatherCoverageVerdict.outside, 'the hull alone')
  assert.equal(
    WeatherCoverage.verdict(coverageOf({ [String(P.botID)]: P.stating(P.statement) }), { for: there }),
    WeatherCoverageVerdict.inside,
  )
  assert.deepEqual(statusOf(listening(null), { place: there }), WeatherAlertStatus.outOfCoverage)
  assert.deepEqual(statusOf(listening(P.statement), { place: there }), listAsOf)
})

test('a bot that states no area filter carries everywhere its feed does', () => {
  // `n` = 0 and `k` = 0: no area filter at all, so no place is outside it.
  const everything = coverageMessage({ latitude: 0, longitude: 0, radiusKilometres: 0, stationCap: 14, officeIndices: [], areas: [] })
  assert.ok(MeshWXCoverage.hasNoAreaFilter(everything))
  const coverage = coverageOf({ [String(P.botID)]: P.stating(everything) })
  assert.equal(WeatherCoverage.verdict(coverage, { for: place(P.dallas, 'Dallas, TX') }), WeatherCoverageVerdict.inside)
  assert.equal(WeatherCoverage.verdict(coverage, { for: place(P.austin, 'Austin, TX') }), WeatherCoverageVerdict.inside)
})

test('a cut list can only say unknown, never outside', () => {
  // The whole point of the message: a list the bot had to cut means "not listed", never "not
  // covered", so it can withhold the check but never deny the place.
  const dallas = place(P.dallas, 'Dallas, TX')
  const zonesCut = { ...P.statement, zones_cut: true }
  const cut = coverageOf({ [String(P.botID)]: P.stating(zonesCut) })
  assert.equal(WeatherCoverage.verdict(cut, { for: place(P.austin, 'Austin, TX') }), WeatherCoverageVerdict.inside, 'a listed run still counts')
  assert.equal(WeatherCoverage.verdict(cut, { for: dallas }), WeatherCoverageVerdict.unknown)

  const officesCut = { ...P.statement, offices_cut: true }
  assert.equal(
    WeatherCoverage.verdict(coverageOf({ [String(P.botID)]: P.stating(officesCut) }), { for: dallas }),
    WeatherCoverageVerdict.unknown,
  )

  assert.deepEqual(statusOf(listening(zonesCut), { place: dallas }), WeatherAlertStatus.coverageUnknown)
  assert.deepEqual(statusOf(listening(P.statement), { place: dallas }), WeatherAlertStatus.outOfCoverage)
})

test('with nothing stated the station footprint still decides, and nothing at all is unknown', () => {
  const heard = coverageOf(P.states())
  assert.equal(WeatherCoverage.verdict(heard, { for: place(P.austin, 'Austin, TX') }), WeatherCoverageVerdict.inside)
  assert.equal(WeatherCoverage.verdict(heard, { for: place(P.dallas, 'Dallas, TX') }), WeatherCoverageVerdict.outside)

  const silent = coverageOf({ [String(P.botID)]: botState({ botID: P.botID }) })
  assert.equal(WeatherCoverage.verdict(silent, { for: place(P.austin, 'Austin, TX') }), WeatherCoverageVerdict.unknown)
  assert.ok(WeatherCoverage.isEmpty(silent))

  const stripped = {}
  for (const [key, state] of Object.entries(listening(null))) stripped[key] = { ...state, observations: {} }
  assert.deepEqual(statusOf(stripped, { place: place(P.austin, 'Austin, TX') }), WeatherAlertStatus.coverageUnknown)
})

test("one bot's outside never speaks for another bot's area", () => {
  const dallasBot = P.stating(
    coverageMessage({
      latitude: 32.7767,
      longitude: -96.797,
      radiusKilometres: 50,
      stationCap: 0,
      officeIndices: [40],
      areas: [],
    }),
    { on: botState({ botID: 0x0102 }) },
  )
  const both = coverageOf({ [String(P.botID)]: P.stating(P.statement), '258': dallasBot })
  assert.equal(WeatherCoverage.verdict(both, { for: place(P.dallas, 'Dallas, TX') }), WeatherCoverageVerdict.inside)
  assert.deepEqual([...WeatherCoverage.botIDs(both, { covering: P.dallas })], [0x0102])
  assert.equal(WeatherCoverage.verdict(both, { for: place(P.austin, 'Austin, TX') }), WeatherCoverageVerdict.inside)
  assert.deepEqual([...WeatherCoverage.botIDs(both, { covering: P.austin })], [P.botID])
})

// MARK: - The office claim

test('the office claim fires only on a stated, uncut office list that omits the place\'s office', () => {
  // It takes the bot's own complete office list and nothing weaker: the offices seen on active
  // warnings are the weather, not the coverage (docs/MESHWX_UI.md §3.1 I-B18).
  const there = place(temple, 'Temple, TX')
  assert.deepEqual(
    [...WeatherCoverage.placeOffices(coverageOf({ [String(P.botID)]: P.stating(P.statement) }), { for: there })],
    ['FWD'],
  )

  // EWX alone, though the zone runs still cover Bell County.
  const austinOnly = { ...P.statement, offices: [35] }
  assert.equal(WeatherCoverage.uncarriedOffice(coverageOf({ [String(P.botID)]: P.stating(austinOnly) }), { for: there }), 'FWD')
  assert.deepEqual(statusOf(listening(austinOnly), { place: there }), WeatherAlertStatus.officeMayNotBeCovered({ office: 'FWD' }))

  // The same list, cut: an office absent from it may still be carried.
  const cut = { ...austinOnly, offices_cut: true }
  assert.equal(WeatherCoverage.uncarriedOffice(coverageOf({ [String(P.botID)]: P.stating(cut) }), { for: there }), null)
  assert.deepEqual(statusOf(listening(cut), { place: there }), listAsOf)

  // The real statement carries Fort Worth, so there is nothing to say.
  assert.equal(
    WeatherCoverage.uncarriedOffice(coverageOf({ [String(P.botID)]: P.stating(P.statement) }), { for: there }),
    null,
  )
  assert.deepEqual(statusOf(listening(P.statement), { place: there }), listAsOf)

  // Nothing stated: a bot that has only been heard from is no evidence against an office.
  assert.equal(WeatherCoverage.uncarriedOffice(coverageOf(P.states()), { for: there }), null)
  assert.deepEqual(statusOf(listening(null), { place: there }), listAsOf)
})

test('an office any answering bot carries is never called uncarried', () => {
  const there = place(temple, 'Temple, TX')
  const austinOnly = { ...P.statement, offices: [35] }
  const fortWorth = { ...P.statement, offices: [40] }

  const both = coverageOf({
    [String(P.botID)]: P.stating(austinOnly),
    '258': P.stating(fortWorth, { on: botState({ botID: 0x0102 }) }),
  })
  assert.equal(WeatherCoverage.uncarriedOffice(both, { for: there }), null)
  assert.equal(
    WeatherCoverage.uncarriedOffice(coverageOf({ [String(P.botID)]: P.stating(austinOnly) }), { for: there }),
    'FWD',
  )
})
