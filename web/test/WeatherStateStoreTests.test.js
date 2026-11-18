// Port of MC1ServicesTests/Weather/WeatherStateStoreTests.swift (docs/PORTING.md).
//
// The Swift store writes a file; this one writes one blob through an injected async key-value
// store, so the file-path tests become storage-key tests and "the one instance per file" becomes
// "the one instance per (storage, key)".

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  KeyValueWeatherStateStore,
  WeatherBotState,
  WeatherStateReducer,
  WeatherStoredCoverage,
  WeatherStoredWarning,
  identityKey
} from '../src/weather/index.js'
import * as F from './helpers/weather-fixtures.js'

/** An in-process stand-in for the browser's IndexedDB wrapper. */
function makeStorage() {
  const rows = new Map()
  return {
    rows,
    async get(key) { return rows.has(key) ? JSON.parse(rows.get(key)) : null },
    async set(key, value) { rows.set(key, JSON.stringify(value)) },
    async delete(key) { rows.delete(key) }
  }
}

describe('Weather state store', () => {
  it('every caller of a key gets the one store', () => {
    const storage = makeStorage()
    const other = makeStorage()
    assert.equal(
      KeyValueWeatherStateStore.shared({ storage }), KeyValueWeatherStateStore.shared({ storage })
    )
    assert.notEqual(
      KeyValueWeatherStateStore.shared({ storage }), KeyValueWeatherStateStore.shared({ storage: other })
    )
    assert.notEqual(
      new KeyValueWeatherStateStore({ storage }), KeyValueWeatherStateStore.shared({ storage })
    )
  })

  // Forty writers each adding one bot: with load-then-save from separate callers some would be
  // lost; `modify` keeps every one.
  it('concurrent edits through modify are all kept', async () => {
    const storage = makeStorage()
    const store = KeyValueWeatherStateStore.shared({ storage })
    await Promise.all(Array.from({ length: 40 }, (_, index) => {
      const botID = index + 1
      return KeyValueWeatherStateStore.shared({ storage }).modify((states) => {
        states[String(botID)] = WeatherBotState.make({ botID })
        return states
      })
    }))
    assert.equal(Object.keys(await store.load()).length, 40)
  })

  it('live hearing round-trips, and a blob from before it decodes with it absent', () => {
    const state = WeatherBotState.make({ botID: 7 })
    state.lastHeardAt = 1_000_000_000

    const old = JSON.parse(JSON.stringify(state))
    delete old.lastLiveHeardAt
    assert.equal(WeatherBotState.decode(old).lastLiveHeardAt, null)

    state.lastLiveHeardAt = 999_000_000
    assert.deepStrictEqual(WeatherBotState.decode(JSON.parse(JSON.stringify(state))), state)
  })

  // Spec §3, revision 5. A blob written before the app could read the issue time — or one
  // holding a warning from a bot that does not send it — is still the last picture the bot sent.
  it("a warning's issue time round-trips, and a blob from before it decodes with it absent", () => {
    const state = WeatherBotState.make({ botID: 7 })
    const issued = 1_789_436_700 * 1000
    const warning = F.warning({ seq: 1 })
    state.warnings[identityKey(warning)] = WeatherStoredWarning.make({
      warning, receivedAt: 1_789_440_000 * 1000, seq: 1
    })

    const old = JSON.parse(JSON.stringify(state))
    assert.equal(old.warnings[identityKey(warning)].issuedAt, null)
    const fromOldBlob = WeatherBotState.decode(old)
    assert.equal(fromOldBlob.warnings[identityKey(warning)].issuedAt, null)
    assert.deepStrictEqual(fromOldBlob, state)

    state.warnings[identityKey(warning)].issuedAt = issued
    const decoded = WeatherBotState.decode(JSON.parse(JSON.stringify(state)))
    assert.deepStrictEqual(decoded, state)
    assert.equal(decoded.warnings[identityKey(warning)].issuedAt, issued)
  })

  // Spec §3, revision 12. State saved before the phone could read a warning's start decodes with
  // no start: in effect from issuance, which is what the phone believed when it saved.
  it("a warning's start round-trips, and a blob from before revision 12 decodes with it absent", () => {
    const state = WeatherBotState.make({ botID: 7 })
    const warning = F.warning({ seq: 1 })
    state.warnings[identityKey(warning)] = WeatherStoredWarning.make({
      warning, receivedAt: 1_789_440_000 * 1000, seq: 1, issuedAt: 1_789_436_700 * 1000
    })

    const old = JSON.parse(JSON.stringify(state))
    delete old.warnings[identityKey(warning)].beginsAt
    delete old.warnings[identityKey(warning)].warning.begins_min
    const fromOldBlob = WeatherBotState.decode(old)
    assert.equal(fromOldBlob.warnings[identityKey(warning)].beginsAt, null)
    assert.equal(fromOldBlob.warnings[identityKey(warning)].issuedAt, 1_789_436_700 * 1000)

    const begins = 1_789_556_000 * 1000
    state.warnings[identityKey(warning)].beginsAt = begins
    const decoded = WeatherBotState.decode(JSON.parse(JSON.stringify(state)))
    assert.deepStrictEqual(decoded, state)
    assert.equal(decoded.warnings[identityKey(warning)].beginsAt, begins)
  })

  // Spec §10. A blob written before the bot could state its coverage is still the last picture
  // it sent: the field decodes as absent, which falls back to the station footprint.
  it('a coverage statement round-trips, and a blob from before it decodes with it absent', () => {
    const state = WeatherBotState.make({ botID: 7 })

    const old = JSON.parse(JSON.stringify(state))
    assert.equal(old.coverage, null)
    assert.equal(WeatherBotState.decode(old).coverage, null)

    state.coverage = WeatherStoredCoverage.make({
      coverage: F.austinCoverage, receivedAt: 1_789_000_000 * 1000
    })
    const decoded = WeatherBotState.decode(JSON.parse(JSON.stringify(state)))
    assert.deepStrictEqual(decoded, state)
    assert.equal(decoded.coverage.coverage.radius_km, 120)
  })
})

describe('Weather digest margin', () => {
  // The bot keeps no answer cache (spec §14, revision 2): a list is built when it is sent, so
  // the margin only absorbs the phone's and the bot's clocks disagreeing and the minute `now` is
  // truncated to.
  it('a list built within two minutes of a gap leaves the gap open', () => {
    let state = WeatherBotState.make({ botID: F.botID })
    const apply = (message, receivedAt) => {
      state = WeatherStateReducer.apply(message, { to: state, receivedAt }).state
    }
    apply(F.warning({ seq: 1 }), F.t0)
    apply(F.observations({ seq: 3, stations: [[202, 88]] }), F.t0 + 60_000)
    assert.equal(state.needsDigest, true)

    // `>d` answered at once, with a list built in the gap's own minute.
    apply(
      F.digest({ seq: 4, nowMinutes: F.t0Minutes + 1, entries: [[F.svw42, 45]] }), F.t0 + 70_000
    )
    assert.equal(state.needsDigest, true)
    assert.equal(state.digest.digest.now_min, F.t0Minutes + 1)

    // Built four minutes after t0, three after the gap: it was built after it.
    apply(
      F.digest({ seq: 5, nowMinutes: F.t0Minutes + 4, entries: [[F.svw42, 45]] }), F.t0 + 240_000
    )
    assert.equal(state.needsDigest, false)
  })
})
