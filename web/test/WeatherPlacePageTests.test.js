// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherPlacePageTests.swift
//
// The rules the place page is built from, as the owner's answers of 16 September stated them
// (docs/MESHWX_UI.md §3.2): the pages and their order, when a reading is good enough to be the
// weather here, which alert the banner names, when the radio row turns orange, and what a Places
// row shows.

import test from 'node:test'
import assert from 'node:assert/strict'

import { MeshWXCompass, MeshWXSky } from '../src/meshwx/index.js'
import {
  WeatherAlertItemKind,
  WeatherAlertPlacement,
  WeatherAlertStatus,
  WeatherConditions,
  WeatherCoverage,
  WeatherNearbyStation,
  WeatherPage,
  WeatherPages,
  WeatherPlaceRowReading,
  WeatherPrimaryStation,
  WeatherRadioRow,
  WeatherSavedPlace,
  WeatherSavedPlaces,
  WeatherStationReading,
  WeatherStations,
  WeatherWarningBanner,
} from '../src/screen/index.js'
import {
  botState,
  digest,
  loadTables,
  observation,
  warning,
  WeatherPhoneFixture as P,
} from './helpers/screen-fixture.js'

const tables = await loadTables()
const now = P.now

function saved(label, { lat = 30.5083, lon = -97.6789, watched = false, minutesAgo = 0 } = {}) {
  return WeatherSavedPlace.make({
    label,
    latitude: lat,
    longitude: lon,
    chosenAt: now - minutesAgo * 60 * 1000,
    isWatched: watched,
  })
}

// MARK: - The pager (answer 12)

test("my location is always the first page, and the saved places follow in Places' order", () => {
  const places = [saved('Austin, TX', { lat: 30.27, lon: -97.74 }), saved('Round Rock, TX'), saved('Llano, TX', { lat: 30.75, lon: -98.67 })]
  const pages = WeatherPages.make({ saved: places })
  assert.equal(pages.length, 4)
  assert.deepEqual(pages[0], WeatherPage.myLocation)
  assert.equal(WeatherPage.id(pages[0]), 'here')
  assert.deepEqual(pages.slice(1).map((page) => WeatherPage.label(page)), ['Austin, TX', 'Round Rock, TX', 'Llano, TX'])
})

test('with nothing saved there is still my location', () => {
  // With no place saved and no permission there is still a page: it is the one that offers to ask
  // for a fix, and nothing asks first.
  assert.deepEqual(WeatherPages.make({ saved: [] }), [WeatherPage.myLocation])
})

test('a page whose place was removed leaves the pager on my location', () => {
  const pages = WeatherPages.make({ saved: [saved('Austin, TX', { lat: 30.27, lon: -97.74 })] })
  const austin = WeatherPage.id(pages[1])
  assert.equal(WeatherPages.selection(austin, { in: pages }), austin)
  assert.equal(WeatherPages.selection(austin, { in: [WeatherPage.myLocation] }), 'here')
  assert.equal(WeatherPages.selection('here', { in: pages }), 'here')
})

test('dragging a place in Places moves its page', () => {
  const list = [saved('A'), saved('B'), saved('C'), saved('D')]
  const labels = (places) => places.map((place) => place.label)

  // Down: the first row lands before the row that was fourth.
  assert.deepEqual(labels(WeatherSavedPlaces.moving({ fromOffsets: [0], toOffset: 3, in: list })), ['B', 'C', 'A', 'D'])
  // Up: the third row lands at the front.
  assert.deepEqual(labels(WeatherSavedPlaces.moving({ fromOffsets: [2], toOffset: 0, in: list })), ['C', 'A', 'B', 'D'])
  // To the end.
  assert.deepEqual(labels(WeatherSavedPlaces.moving({ fromOffsets: [1], toOffset: 4, in: list })), ['A', 'C', 'D', 'B'])
  // Two rows at once keep their own order.
  assert.deepEqual(labels(WeatherSavedPlaces.moving({ fromOffsets: [0, 1], toOffset: 4, in: list })), ['C', 'D', 'A', 'B'])
  // A drag that changes nothing changes nothing.
  assert.deepEqual(labels(WeatherSavedPlaces.moving({ fromOffsets: [1], toOffset: 1, in: list })), ['A', 'B', 'C', 'D'])
  assert.deepEqual(labels(WeatherSavedPlaces.moving({ fromOffsets: [], toOffset: 2, in: list })), ['A', 'B', 'C', 'D'])
})

test('a new place goes to the front and the rest keep the order they were dragged into', () => {
  const dragged = WeatherSavedPlaces.moving({ fromOffsets: [2], toOffset: 0, in: [saved('A'), saved('B'), saved('C')] })
  const list = WeatherSavedPlaces.remember(saved('D', { lat: 31, lon: -97 }), { in: dragged })
  assert.deepEqual(list.map((place) => place.label), ['D', 'C', 'A', 'B'])
})

// MARK: - A good reading (answer 11)

function reading({ kilometres, icao, minutesAgo }) {
  const station = tables.station({ icao })
  const minutes = Math.floor((now / 1000 - minutesAgo * 60) / 60)
  const stored = {
    observation: observation({ station: 0, tempF: 86, sky: MeshWXSky.few }),
    timestampMinutes: minutes,
    receivedAt: now - minutesAgo * 60 * 1000,
    batchSize: 1,
    lastBatchMinutes: null,
    source: 0,
  }
  // `isStale` is two hours (`MeshWXPresentation.observationStaleAfterMinutes`), `isTooOld` twelve
  // (`observationShownForMinutes`).
  const isStale = now / 60000 - minutes > 120
  const isTooOld = now / 60000 - minutes > 720
  return WeatherStationReading.make({
    index: tables.stationIndex({ forICAO: icao }),
    station,
    stored,
    botID: P.botID,
    distanceKilometres: kilometres,
    direction: null,
    isStale,
    isTooOld,
    isInFootprint: true,
    isInLatestBatch: true,
  })
}

const nearby = WeatherNearbyStation.make({ icao: 'KAQO', name: 'Llano Municipal Airport', kilometres: 4 })

test('a reading within the threshold and not stale is the weather here', () => {
  const good = reading({ kilometres: WeatherConditions.goodReadingKilometres - 1, icao: 'KATT', minutesAgo: 20 })
  assert.deepEqual(WeatherConditions.make({ primary: WeatherPrimaryStation.reading(good), nearbyStation: nearby }), WeatherConditions.reading(good))
  // The threshold itself is inside it.
  const edge = reading({ kilometres: WeatherConditions.goodReadingKilometres, icao: 'KATT', minutesAgo: 20 })
  assert.deepEqual(WeatherConditions.make({ primary: WeatherPrimaryStation.reading(edge), nearbyStation: nearby }), WeatherConditions.reading(edge))
})

test('a reading from too far away is no temperature, and the ask names the nearest station', () => {
  const far = reading({ kilometres: 60, icao: 'KATT', minutesAgo: 20 })
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(far), nearbyStation: nearby }),
    WeatherConditions.ask({ icao: 'KAQO', kilometres: 4 }),
  )
  // With no nearer station there is nothing worth a packet: its answer would come back from 60 km
  // and the page would refuse it again.
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(far), nearbyStation: null }),
    WeatherConditions.noStation({ nearest: far }),
  )
})

// MARK: - 25 to 40 km: shown under the station's name (§3.1 U-2a)

test('a fresh reading between 25 and 40 km is shown under its station', () => {
  // Wimberley: San Marcos is 25.5 km off. Fresh, it is shown — attributed, never as the town's.
  const off = reading({ kilometres: 25.5, icao: 'KHYI', minutesAgo: 20 })
  const same = WeatherNearbyStation.make({ icao: 'KHYI', name: 'San Marcos', kilometres: 25.5 })
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(off), nearbyStation: same }),
    WeatherConditions.nearby(off, { nearer: null }),
  )
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(off), nearbyStation: null }),
    WeatherConditions.nearby(off, { nearer: null }),
  )
  assert.deepEqual(
    WeatherConditions.readingOf(WeatherConditions.make({ primary: WeatherPrimaryStation.reading(off), nearbyStation: same })),
    off,
  )
  // The edge is inside.
  const edge = reading({ kilometres: WeatherConditions.labelledReadingKilometres, icao: 'KHYI', minutesAgo: 20 })
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(edge), nearbyStation: null }),
    WeatherConditions.nearby(edge, { nearer: null }),
  )
})

test('an attributed reading carries a nearer station worth asking about', () => {
  const off = reading({ kilometres: 30, icao: 'KATT', minutesAgo: 20 })
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(off), nearbyStation: nearby }),
    WeatherConditions.nearby(off, { nearer: nearby }),
  )
  // A "nearer" one past 40 km could never be shown, so it is not worth a packet.
  const tooFar = WeatherNearbyStation.make({ icao: 'KAQO', name: 'Llano', kilometres: 45 })
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(off), nearbyStation: tooFar }),
    WeatherConditions.nearby(off, { nearer: null }),
  )
})

test('a stale reading between 25 and 40 km is shown under its station, with its age', () => {
  // Owner decision 2026-10-16: up to twelve hours old a reading is the weather as last seen, not
  // "No current conditions".
  const stale = reading({ kilometres: 30, icao: 'KATT', minutesAgo: 8 * 60 })
  assert.ok(stale.isStale && !stale.isTooOld)
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(stale), nearbyStation: null }),
    WeatherConditions.nearby(stale, { nearer: null }),
  )
})

test('a reading between 25 and 40 km over twelve hours old asks about its own station', () => {
  const old = reading({ kilometres: 30, icao: 'KATT', minutesAgo: 13 * 60 })
  assert.ok(old.isTooOld)
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(old), nearbyStation: null }),
    WeatherConditions.ask({ icao: 'KATT', kilometres: 30 }),
  )
})

test('with nothing held and every station past 40 km there is nothing to ask', () => {
  const far = reading({ kilometres: 190, icao: 'KTPL', minutesAgo: 20 })
  const distant = WeatherNearbyStation.make({ icao: 'KAQO', name: 'Llano', kilometres: 55 })
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.noneNearby({ nearest: far }), nearbyStation: distant }),
    WeatherConditions.noStation({ nearest: far }),
  )
})

test('a stale reading near the place is still the weather here, up to twelve hours', () => {
  // 2026-10-16: the page said "No current conditions for Austin, TX" while the phone held Camp
  // Mabry from five hours before. It now shows that reading, and its foot line says how old it is.
  const stale = reading({ kilometres: 6, icao: 'KATT', minutesAgo: 5 * 60 })
  assert.ok(stale.isStale && !stale.isTooOld)
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(stale), nearbyStation: nearby }),
    WeatherConditions.reading(stale),
  )
  // The edge is inside.
  const edge = reading({ kilometres: 6, icao: 'KATT', minutesAgo: 12 * 60 })
  assert.ok(!edge.isTooOld)
  assert.equal(WeatherConditions.make({ primary: WeatherPrimaryStation.reading(edge), nearbyStation: nearby }).kind, 'reading')
})

test('a reading near the place over twelve hours old asks about its own station', () => {
  const old = reading({ kilometres: 6, icao: 'KATT', minutesAgo: 13 * 60 })
  assert.ok(old.isTooOld)
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.reading(old), nearbyStation: nearby }),
    WeatherConditions.ask({ icao: old.station.icao, kilometres: 6 }),
  )
})

test('a nearer station silent for a day does not hide one that reported five hours ago', () => {
  const silent = reading({ kilometres: 4, icao: 'KATT', minutesAgo: 25 * 60 })
  const stale = reading({ kilometres: 11, icao: 'KAUS', minutesAgo: 5 * 60 })
  const place = P.place(P.austin)
  const primary = WeatherPrimaryStation.pick({ readings: [silent, stale], place })
  assert.deepEqual(primary, WeatherPrimaryStation.reading(stale))
  // Fresh still beats stale, wherever it is in reach.
  const fresh = reading({ kilometres: 20, icao: 'KEDC', minutesAgo: 20 })
  assert.deepEqual(WeatherPrimaryStation.pick({ readings: [silent, stale, fresh], place }), WeatherPrimaryStation.reading(fresh))
})

test('nothing in reach asks about the nearest bundled station, and nothing at all waits for the batch', () => {
  const far = reading({ kilometres: 190, icao: 'KTPL', minutesAgo: 20 })
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.noneNearby({ nearest: far }), nearbyStation: nearby }),
    WeatherConditions.ask({ icao: 'KAQO', kilometres: 4 }),
  )
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.noneNearby({ nearest: far }), nearbyStation: null }),
    WeatherConditions.noStation({ nearest: far }),
  )
  // Nothing has ever arrived: the hourly batch fills this in, and one packet brings all of it.
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.noObservations, nearbyStation: nearby }),
    WeatherConditions.noneYet,
  )
  assert.deepEqual(
    WeatherConditions.make({ primary: WeatherPrimaryStation.noPlace, nearbyStation: nearby }),
    WeatherConditions.noPlace,
  )
})

// MARK: - The banner (answer 7)

function alert({ event, rank, placement, etn, expiresInMinutes, kind = WeatherAlertItemKind.active }) {
  const expires = Math.floor((now / 1000 + expiresInMinutes * 60) / 60)
  return {
    identity: { event, office: 35, etn },
    warning: warning({ event, etn, expiresMinutes: expires }),
    kind,
    placement,
    rank,
    botIDs: [P.botID],
    receivedAt: now,
  }
}

test('only an alert covering the place earns the banner', () => {
  const near = alert({ event: 14, rank: 0, placement: WeatherAlertPlacement.near({ kilometres: 8, direction: MeshWXCompass.north }), etn: 1, expiresInMinutes: 40 })
  const checking = alert({ event: 14, rank: 0, placement: WeatherAlertPlacement.checking, etn: 2, expiresInMinutes: 40 })
  const elsewhere = alert({ event: 14, rank: 0, placement: WeatherAlertPlacement.elsewhere, etn: 3, expiresInMinutes: 40 })
  assert.equal(WeatherWarningBanner.make([near, checking, elsewhere]), null)
  assert.equal(WeatherWarningBanner.make([]), null)
})

test('the banner names the most important one covering the place and counts the rest', () => {
  const advisory = alert({ event: 30, rank: 8, placement: WeatherAlertPlacement.here, etn: 1, expiresInMinutes: 200 })
  const tornado = alert({ event: 14, rank: 0, placement: WeatherAlertPlacement.here, etn: 2, expiresInMinutes: 40 })
  const flood = alert({ event: 4, rank: 4, placement: WeatherAlertPlacement.here, etn: 3, expiresInMinutes: 90 })
  const banner = WeatherWarningBanner.make([advisory, tornado, flood])
  assert.deepEqual(banner.item, tornado)
  assert.equal(banner.more, 2)
})

test('a live alert leads a recently expired one, whatever their ranks', () => {
  const expiredTornado = alert({
    event: 14, rank: 0, placement: WeatherAlertPlacement.here, etn: 1, expiresInMinutes: -3,
    kind: WeatherAlertItemKind.expiredRecently,
  })
  const liveAdvisory = alert({ event: 30, rank: 8, placement: WeatherAlertPlacement.here, etn: 2, expiresInMinutes: 200 })
  assert.deepEqual(WeatherWarningBanner.make([expiredTornado, liveAdvisory]).item, liveAdvisory)
  assert.deepEqual(WeatherWarningBanner.make([expiredTornado]).item, expiredTornado)
})

test('equal ranks are led by the soonest expiry', () => {
  const later = alert({ event: 4, rank: 4, placement: WeatherAlertPlacement.here, etn: 1, expiresInMinutes: 120 })
  const sooner = alert({ event: 4, rank: 4, placement: WeatherAlertPlacement.here, etn: 2, expiresInMinutes: 30 })
  assert.deepEqual(WeatherWarningBanner.make([later, sooner]).item, sooner)
})

// MARK: - The radio row (answer 10)

function source() {
  return { botID: P.botID, bot: null, lastHeardAt: now - 120 * 1000, lastLiveHeardAt: now - 120 * 1000 }
}

function radioState(listMinutesAgo) {
  const state = botState({ botID: P.botID })
  if (listMinutesAgo == null) return state
  const built = Math.floor((now / 1000 - listMinutesAgo * 60) / 60)
  state.digest = {
    digest: digest({ nowMinutes: built, feedHealth: 0, entries: [] }),
    receivedAt: now - listMinutesAgo * 60 * 1000,
  }
  return state
}

test('a fresh list heard recently is not orange', () => {
  const row = WeatherRadioRow.make({ source: source(), state: radioState(20), now })
  assert.equal(row.listIsOld, false)
  assert.equal(row.missedMessages, false)
  assert.equal(WeatherRadioRow.needsAttention(row), false)
  assert.equal(row.heardAt, now - 120 * 1000)
})

test('an old list, a missed message and no list at all are all orange', () => {
  assert.ok(WeatherRadioRow.needsAttention(WeatherRadioRow.make({ source: source(), state: radioState(200), now })))
  assert.ok(WeatherRadioRow.make({ source: source(), state: radioState(null), now }).listIsOld)
  assert.ok(WeatherRadioRow.needsAttention(WeatherRadioRow.make({ source: source(), state: radioState(null), now })))
  assert.ok(WeatherRadioRow.needsAttention(WeatherRadioRow.make({ source: source(), state: null, now })))

  const gap = radioState(20)
  gap.needsDigest = true
  const row = WeatherRadioRow.make({ source: source(), state: gap, now })
  assert.ok(row.missedMessages)
  assert.equal(row.listIsOld, false)
  assert.ok(WeatherRadioRow.needsAttention(row))

  const missing = radioState(20)
  missing.missingFromDigest = [{ event: 14, office: 35, etn: 3 }]
  assert.ok(WeatherRadioRow.needsAttention(WeatherRadioRow.make({ source: source(), state: missing, now })))
})

test('the list goes old on the same cadence the alert status uses', () => {
  const justInside = WeatherAlertStatus.listFreshFor / 60 - 1
  assert.equal(WeatherRadioRow.make({ source: source(), state: radioState(justInside), now }).listIsOld, false)
  assert.ok(WeatherRadioRow.make({ source: source(), state: radioState(justInside + 2), now }).listIsOld)
})

// MARK: - A Places row (answer 9)

function fixtureReadings({ observationsAgo } = {}) {
  const states = P.states(P.state(observationsAgo == null ? {} : { observationsAgo }))
  return WeatherStations.readings({
    states,
    coverage: WeatherCoverage.make({ stations: [] }),
    place: null,
    tables,
    now,
  })
}

test('a places row holds the nearest reading, its condition and whether it is stale', () => {
  const row = WeatherPlaceRowReading.make({ readings: fixtureReadings(), at: P.austin, now })
  assert.equal(WeatherPlaceRowReading.isEmpty(row), false)
  assert.notEqual(row.tempF, null)
  assert.equal(row.sky, MeshWXSky.few)
  assert.equal(row.isStale, false)
  assert.notEqual(row.observedAt, null)
})

test('a stale reading is shown in the row with its age, exactly as the page shows it', () => {
  // **One rule for the row and the page** (docs/MESHWX_UI.md §3.1 U-2). Places once read "86°
  // Partly cloudy · 3 h old" beside a page that said "No current conditions", one tap apart; now
  // both show a reading up to twelve hours old, and both say how old it is.
  const row = WeatherPlaceRowReading.make({ readings: fixtureReadings({ observationsAgo: 8 * 3600 }), at: P.austin, now })
  assert.equal(WeatherPlaceRowReading.isEmpty(row), false)
  assert.notEqual(row.tempF, null)
  assert.equal(row.isStale, true)
})

test('a reading over twelve hours old is no good for the row, exactly as it is no good for the page', () => {
  const row = WeatherPlaceRowReading.make({ readings: fixtureReadings({ observationsAgo: 13 * 3600 }), at: P.austin, now })
  assert.ok(WeatherPlaceRowReading.isEmpty(row))
  assert.equal(row.tempF, null)
})

test("a reading beyond the page's reach is no good for the row", () => {
  const readings = fixtureReadings()
  // A point between the page's 40 km and the readings' own 80 km reach: the band where the row
  // used to show a temperature the page refused to.
  let between = null
  for (let offset = 0.1; offset <= 1.5 + 1e-9; offset += 0.05) {
    const coordinate = { latitude: P.austin.latitude + offset, longitude: P.austin.longitude }
    const near = WeatherStations.nearestReading({ in: readings, to: coordinate })
    if (near != null && near.kilometres > WeatherConditions.labelledReadingKilometres) {
      between = coordinate
      break
    }
  }
  assert.ok(between != null, 'the fixture should hold a reading between 40 km and 80 km of somewhere north of Austin')
  assert.ok(WeatherPlaceRowReading.isEmpty(WeatherPlaceRowReading.make({ readings, at: between, now })))
})

test("a reading between 25 and 40 km is the row's, under its station", () => {
  const readings = fixtureReadings()
  let band = null
  for (let offset = 0.1; offset <= 1.5 + 1e-9; offset += 0.02) {
    const coordinate = { latitude: P.austin.latitude + offset, longitude: P.austin.longitude }
    const near = WeatherStations.nearestReading({ in: readings, to: coordinate })
    if (
      near != null &&
      near.kilometres > WeatherConditions.goodReadingKilometres &&
      near.kilometres <= WeatherConditions.labelledReadingKilometres
    ) {
      band = coordinate
      break
    }
  }
  assert.ok(band != null, 'the fixture should hold a reading between 25 km and 40 km of somewhere north of Austin')
  const row = WeatherPlaceRowReading.make({ readings, at: band, now })
  assert.ok(!WeatherPlaceRowReading.isEmpty(row))
  assert.notEqual(row.tempF, null)
  assert.ok(row.attributedStation != null && row.attributedStation.length > 0)
  // Within 25 km it is the town's own, with no station named.
  assert.equal(WeatherPlaceRowReading.make({ readings, at: P.austin, now }).attributedStation, null)
})

test('a place with nothing in reach holds nothing', () => {
  const readings = fixtureReadings()
  const row = WeatherPlaceRowReading.make({ readings, at: P.dallas, now })
  assert.ok(WeatherPlaceRowReading.isEmpty(row))
  assert.equal(row.tempF, null)
  assert.ok(WeatherPlaceRowReading.isEmpty(WeatherPlaceRowReading.make({ readings: [], at: P.austin, now })))
})
