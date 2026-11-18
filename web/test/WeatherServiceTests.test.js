// Port of MC1ServicesTests/Weather/WeatherServiceTests.swift (docs/PORTING.md).
//
// The service's contract with the radio and with the spec's etiquette (§14, §19): what it
// accepts, what it sends, what settles a request, and what it never sends twice.
//
// Where the Swift shortens a timeout to 40 ms and waits for real, this drives the injected
// clock, so the production 15 s and 10 s are the numbers under test.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MeshWXTables } from '../src/meshwx/index.js'
import { nodeBundleLoader } from '../src/meshwx/nodeLoader.js'
import {
  WeatherBot,
  InMemoryWeatherStateStore,
  WeatherReplyKind,
  WeatherRequest,
  WeatherRequestError,
  WeatherRequestOutcome,
  WeatherService,
  WeatherStateReducer,
  WeatherTransportLink
} from '../src/weather/index.js'
import * as F from './helpers/weather-fixtures.js'

const tables = await MeshWXTables.load(nodeBundleLoader())

const other = {
  publicKey: Uint8Array.from([0x02, 0x01, ...new Array(30).fill(0x22)]),
  name: 'WX-SAT',
  latitude: 29.4,
  longitude: -98.5,
  lastAdvert: null
}

/**
 * @param channelRequests whether the fake radio can flood a Request datagram (spec §11).
 *   **False by default**, so every test below that is about the DM ladder drives the ladder;
 *   the channel path is a section of its own and asks for it.
 */
async function makeHarness({ channelRequests = false } = {}) {
  const transport = await F.makeTransport({ channelRequestsSupported: channelRequests })
  const store = new InMemoryWeatherStateStore()
  const clock = new F.WeatherTestClock()
  const service = new WeatherService({
    transport,
    store,
    now: () => clock.now,
    stationIndex: (icao) => (icao === 'KAUS' ? 202 : null),
    tables,
    setTimeout: (fn, milliseconds) => clock.setTimeout(fn, milliseconds),
    clearTimeout: (id) => clock.clearTimeout(id),
    decode: F.fixtureDecode
  })
  return { transport, store, clock, service, events: F.collectEvents(service) }
}

const isAlreadyReceived = (outcome) => outcome?.kind === 'alreadyReceived'

describe('WeatherService', () => {
  // MARK: - Ingest

  it('only datagrams with the MeshWX data type are decoded', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()

    h.transport.deliver(F.datagram(F.warning({ seq: 17 }), { dataType: 0xffff }))
    h.transport.deliver(F.datagram(F.warning({ seq: 17 })))
    await F.flush()

    const state = await h.service.state({ for: F.botID })
    assert.equal(Object.keys(state.warnings).length, 1)
    assert.equal(state.lastSeq, 17)
    assert.equal(h.store.saveCount, 1)
    assert.equal(h.service.sessionInfo().lastChannelDatagramAt, h.clock.now)
  })

  it('a datagram on a slot that is not meshwx is ignored and counted', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    h.transport.setSecret(new Uint8Array(16).fill(0x42), 5)
    assert.equal(
      await h.service.ingestDatagram(F.datagram(F.warning({ seq: 1 }), { channelIndex: 5 })), null
    )
    assert.deepStrictEqual(await h.service.allStates(), {})
    assert.equal(h.service.sessionInfo().foreignDatagramsIgnored, 1)
    assert.equal(h.service.sessionInfo().lastChannelDatagramAt, null)
  })

  it('an unreadable slot is accepted rather than dropping weather', async () => {
    const h = await makeHarness()
    assert.notEqual(
      await h.service.ingestDatagram(F.datagram(F.warning({ seq: 1 }), { channelIndex: 9 })), null
    )
    const state = await h.service.state({ for: F.botID })
    assert.equal(Object.keys(state.warnings).length, 1)
  })

  it('a slot that was not meshwx is checked again after a minute', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    h.transport.setSecret(new Uint8Array(16).fill(0x42), 5)
    assert.equal(
      await h.service.ingestDatagram(F.datagram(F.warning({ seq: 1 }), { channelIndex: 5 })), null
    )

    // The user adds #meshwx into slot 5 from the prompt.
    h.transport.setSecret(await (await import('../src/weather/index.js')).WeatherChannel.secret(), 5)
    await h.clock.advance(30)
    assert.equal(
      await h.service.ingestDatagram(F.datagram(F.warning({ seq: 2 }), { channelIndex: 5 })), null
    )
    await h.clock.advance(31)
    assert.notEqual(
      await h.service.ingestDatagram(F.datagram(F.warning({ seq: 3 }), { channelIndex: 5 })), null
    )
  })

  it('a meshwx slot is looked up once per session', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    await h.service.ingestDatagram(F.datagram(F.warning({ seq: 1 })))
    await h.service.ingestDatagram(F.datagram(F.cancel({ seq: 2 })))
    assert.deepStrictEqual(h.transport.secretLookups, [3])
  })

  it('undecodable bytes are dropped without touching state', async () => {
    const h = await makeHarness()
    const truncated = {
      channelIndex: 3, pathLength: 0xff, dataType: 0xff10, data: Uint8Array.from([0x11, 0x7a]), snr: 1
    }
    assert.equal(await h.service.ingestDatagram(truncated), null)
    assert.deepStrictEqual(await h.service.allStates(), {})
  })

  it('a duplicate is reported but not persisted again', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.warning({ seq: 17 }))
    const changes = await h.service.ingest(F.warning({ seq: 17 }))
    assert.deepStrictEqual(changes, [{ kind: 'duplicate', seq: 17 }])
    assert.equal(h.store.saveCount, 1)
  })

  it('state loads from the store once and prunes long-expired warnings', async () => {
    let stale = (await import('../src/weather/index.js')).WeatherBotState.make({ botID: F.botID })
    for (const message of [
      F.warning({ seq: 1, identity: F.svw42, expiresMinutes: F.t0Minutes - 120 }),
      F.warning({ seq: 2, identity: F.svw43, expiresMinutes: F.t0Minutes - 10 })
    ]) {
      stale = WeatherStateReducer.apply(message, { to: stale, receivedAt: F.t0 }).state
    }
    const store = new InMemoryWeatherStateStore({ states: { [String(F.botID)]: stale } })
    const clock = new F.WeatherTestClock()
    const service = new WeatherService({
      transport: await F.makeTransport(), store, now: () => clock.now, tables, decode: F.fixtureDecode
    })

    const loaded = await service.state({ for: F.botID })
    // Expired two hours ago: gone. Expired ten minutes ago: kept for the "just ended" hour.
    const { identityKey } = await import('../src/weather/index.js')
    assert.deepStrictEqual(Object.keys(loaded.warnings), [identityKey(F.svw43)])
  })

  // Spec §17.5: a digest stamped ahead of the clock is refused, and one saved before the phone
  // refused them is dropped when the state is read back, or it would turn every real one away.
  it('a digest from the future is neither applied nor saved, and a saved one is dropped on load', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw42 }))
    const changes = await h.service.ingest(F.digest({ seq: 2, nowMinutes: 0xffffff00, entries: [] }))
    assert.deepStrictEqual(changes.map((change) => change.kind), ['futureTimeRejected'])
    assert.equal(h.store.states[String(F.botID)].digest, null)
    assert.equal(Object.keys(h.store.states[String(F.botID)].warnings).length, 1)

    const { WeatherStoredDigest } = await import('../src/weather/index.js')
    const poisoned = {
      ...h.store.states[String(F.botID)],
      digest: WeatherStoredDigest.make({ digest: F.digest({ seq: 2, nowMinutes: 0xffffff00 }), receivedAt: F.t0 })
    }
    const store = new InMemoryWeatherStateStore({ states: { [String(F.botID)]: poisoned } })
    const clock = new F.WeatherTestClock()
    const service = new WeatherService({
      transport: await F.makeTransport(), store, now: () => clock.now, tables, decode: F.fixtureDecode
    })
    assert.equal((await service.state({ for: F.botID })).digest, null)
    const real = await service.ingest(F.digest({ seq: 3, entries: [[F.svw42, 45]] }))
    assert.deepStrictEqual(real.map((change) => change.kind), ['digestApplied'])
  })

  it('session info records when monitoring started and clears on stop', async () => {
    const h = await makeHarness()
    assert.equal(h.service.sessionInfo().startedAt, null)
    await h.service.startEventMonitoring()
    assert.equal(h.service.sessionInfo().startedAt, h.clock.now)
    h.service.stopEventMonitoring()
    assert.equal(h.service.sessionInfo().startedAt, null)
  })

  // MARK: - Sending

  it("a request goes out as a DM to the bot's key with the spec's text", async () => {
    const h = await makeHarness()
    const pending = await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot })
    assert.deepStrictEqual(pending.request, WeatherRequest.forecast({ point: 102 }))
    assert.equal(pending.botID, F.botID)
    assert.equal(h.transport.sent.length, 1)
    assert.deepStrictEqual(h.transport.sent[0].publicKey, F.botPublicKey)
    assert.equal(h.transport.sent[0].text, '>f 102')
    assert.equal(h.service.pendingRequests().length, 1)
  })

  it('requests are spaced five seconds apart', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.digest, { to: F.bot })
    await h.clock.advance(2)
    await assert.rejects(
      () => h.service.send(WeatherRequest.observations, { to: F.bot }),
      (error) => error instanceof WeatherRequestError && error.kind === 'rateLimited'
    )
    await h.clock.advance(3.1)
    await h.service.send(WeatherRequest.observations, { to: F.bot })
    assert.equal(h.transport.sent.length, 2)
  })

  it('a radio refusal surfaces as a transport error and leaves nothing pending', async () => {
    const h = await makeHarness()
    h.transport.setFailNextSend(true)
    await assert.rejects(
      () => h.service.send(WeatherRequest.digest, { to: F.bot }),
      (error) => error instanceof WeatherRequestError && error.kind === 'transport'
    )
    assert.deepStrictEqual(h.service.pendingRequests(), [])
  })

  // MARK: - Settling

  it('the expected answer settles the request and no other', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot })

    await h.service.ingest(F.forecast({ seq: 1, point: 304 })) // a different point, far away
    await h.service.ingest(F.observations({ seq: 2, stations: [[202, 88], [860, 84]] }))
    assert.equal(h.service.pendingRequests().length, 1)

    await h.service.ingest(F.forecast({ seq: 3, point: 102 }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
    assert.deepStrictEqual(h.service.pendingRequests(), [])
  })

  it('a one-station observation request is settled only by a batch holding that station', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.observation({ station: 'KAUS' }), { to: F.bot })
    await h.service.ingest(F.observations({ seq: 1, stations: [[860, 84]] }))
    assert.equal(h.service.pendingRequests().length, 1)
    await h.service.ingest(F.observations({ seq: 2, stations: [[202, 88]] }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
  })

  it("a coverage observation request is settled by its bot's batch, even a batch of one, and not by another bot's", async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.observations, { to: F.bot })
    await h.service.ingest(F.observations({ seq: 1, stations: [[202, 88], [860, 84]], bot: 0x0102 }))
    assert.equal(h.service.pendingRequests().length, 1)
    // Only one station reported in the bot's area.
    await h.service.ingest(F.observations({ seq: 2, stations: [[202, 88]] }))
    assert.deepStrictEqual(h.service.pendingRequests(), [])
    await h.clock.advance(6)
    assert.equal(
      await h.service.send(WeatherRequest.observations, { to: F.bot }), null,
      "that answer was this phone's `>o`"
    )
  })

  it('a warnings request is settled by the first warning or by the digest that ends the reply', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.activeWarnings, { to: F.bot })
    await h.service.ingest(F.digest({ seq: 1, entries: [] }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][0].request, WeatherRequest.activeWarnings)
  })

  it('a request for one warning is settled only by that warning, with no digest to wait for', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.warning({ identity: 'SV.W.EWX.43' }), { to: F.bot })
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw42 }))
    await h.service.ingest(F.digest({ seq: 2, entries: [[F.svw43, 30]] }))
    assert.equal(h.service.pendingRequests().length, 1)
    await h.service.ingest(F.warning({ seq: 3, identity: F.svw43 }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
  })

  it('an area request is settled only by a warning naming that county or zone', async () => {
    const h = await makeHarness()
    // The fixture's warning names Travis County, TXC453.
    await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC209' }), { to: F.bot })
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw42 }))
    await h.service.ingest(F.digest({ seq: 2, entries: [[F.svw42, 30]] }))
    assert.equal(h.service.pendingRequests().length, 1)
    await h.service.ingest(F.notAvailable({ seq: 3, letter: 'w', reason: 0 }))
    let settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.notAvailable(0))

    await h.clock.advance(6)
    await h.service.send(WeatherRequest.warningsTouching({ ugc: 'txc453' }), { to: other })
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw43, bot: 0x0102 }))
    settled = F.settlements(h.events)
    assert.equal(settled.length, 2)
  })

  // The bot matches the county against the product's full list, then cuts the list it sends to
  // 30, 12 or 6 runs, or drops it, to fit one packet.
  it('a county request takes a warning whose area list may have been cut, only from the bot asked', () => {
    const warningWithRuns = (runs) => F.warning({
      seq: 1,
      areas: runs === 0
        ? null
        : Array.from({ length: runs }, (_, index) => ({
          state: 42, county: true, start: 100 + 2 * index, run: 1
        }))
    })
    const settles = (message, fromAddressedBot) => WeatherService.reply(message, {
      satisfies: WeatherReplyKind.warningsTouching({ ugc: 'TXC209' }),
      fromAddressedBot,
      stationIndex: () => null,
      tables
    })
    for (const runs of [0, 6, 12, 30]) {
      assert.equal(settles(warningWithRuns(runs), true), true, `${runs} runs may be a cut list`)
      assert.equal(settles(warningWithRuns(runs), false), false)
    }
    assert.equal(settles(warningWithRuns(5), true), false, 'a whole list that does not name it')
    assert.equal(settles(F.warning({ seq: 1 }), false), false)
  })

  it('a forecast request takes a nearby or unbundled point from the bot asked, never from another bot', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot })
    // 17 km away, but another bot.
    await h.service.ingest(F.forecast({ seq: 1, point: 103, bot: 0x0102 }))
    // The bot asked, but New York.
    await h.service.ingest(F.forecast({ seq: 2, point: 304 }))
    assert.equal(h.service.pendingRequests().length, 1)
    // Camp Mabry for Bergstrom.
    await h.service.ingest(F.forecast({ seq: 3, point: 103 }))
    assert.deepStrictEqual(h.service.pendingRequests(), [])

    await h.clock.advance(6)
    await h.service.send(WeatherRequest.forecast({ point: 1010 }), { to: F.bot })
    await h.service.ingest(F.forecast({ seq: 1, point: 0xffff, bot: 0x0102 }))
    assert.equal(h.service.pendingRequests().length, 1)
    await h.service.ingest(F.forecast({ seq: 4, point: 0xffff }))
    assert.deepStrictEqual(h.service.pendingRequests(), [])
  })

  // Revision 8: Wright-Patterson (KFFO) never reports, so the bot answers `>o KFFO` with Dayton
  // International (KDAY), 16.6 km away, alone and under KDAY's index.
  it('a station request takes the nearest reporting station, alone, from the bot asked', () => {
    const batch = (icaos) => F.observations({
      seq: 1,
      timestampMinutes: 29_000_000,
      stations: icaos.map((icao) => [tables.stationIndex({ forICAO: icao }), 72])
    })
    const settles = (message, fromAddressedBot = true) => WeatherService.reply(message, {
      satisfies: WeatherReplyKind.observations({ station: 'KFFO' }),
      fromAddressedBot,
      stationIndex: (icao) => tables.stationIndex({ forICAO: icao }),
      tables
    })
    assert.equal(settles(batch(['KFFO'])), true)
    assert.equal(settles(batch(['KDAY'])), true, '16.6 km: the stand-in the bot chose')
    assert.equal(settles(batch(['KDAY']), false), false)
    assert.equal(settles(batch(['KDAY', 'KMGY'])), false, 'a batch that does not name it is somebody else\'s')
    assert.equal(settles(batch(['KCMH'])), false, 'Columbus is about 100 km away')
  })

  it("a text request is settled by its subject's first chunk and remembered on the reply", async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.stormReports({ state: 'TX' }), { to: F.bot })
    await h.service.ingest(
      F.text({ seq: 1, subject: 2, group: 1, index: 0, total: 1, text: 'quiet sun' })
    )
    assert.equal(h.service.pendingRequests().length, 1)
    await h.service.ingest(F.text({
      seq: 2, subject: 3, group: 2, index: 0, total: 2, text: '0115 HAIL 2 N AUSTIN TRAVIS TX'
    }))
    assert.equal(F.settlements(h.events).length, 1)
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(state.texts['2'].request, WeatherRequest.stormReports({ state: 'TX' }))
    assert.equal(state.texts['1'].request, null, "somebody else's space weather is not this phone's")
  })

  it('a not-available reply settles the oldest request with its letter', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.forecastForPlace('nowhere zz'), { to: F.bot })
    await h.clock.advance(6)
    await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot })

    // Not ours.
    await h.service.ingest(F.notAvailable({ seq: 1, letter: 'o', reason: 0 }))
    assert.equal(h.service.pendingRequests().length, 2)

    await h.service.ingest(F.notAvailable({ seq: 2, letter: 'f', reason: 1 }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][0].request, WeatherRequest.forecastForPlace('nowhere zz'))
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.notAvailable(1))
    assert.deepStrictEqual(
      h.service.pendingRequests().map((entry) => entry.request),
      [WeatherRequest.forecast({ point: 102 })]
    )
  })

  it('a not-available from another bot does not refuse the request', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot })
    await h.service.ingest(F.notAvailable({ seq: 1, letter: 'f', reason: 0, bot: 0x0102 }))
    assert.equal(h.service.pendingRequests().length, 1)
  })

  it('a place forecast answered as an unbundled point is labelled with the request', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.forecastForPlace('round rock tx'), { to: F.bot })
    await h.service.ingest(F.forecast({ seq: 1, point: 0xffff }))
    assert.deepStrictEqual(h.service.pendingRequests(), [])
    const state = await h.service.state({ for: F.botID })
    // Revision 10: a point the bot chose is not in `forecasts` under a sentinel index. A name the
    // bot resolved has no coordinate to file it under either, so it stays in the one slot for
    // answers that belong to no place on this phone, with the request as its only label.
    assert.equal(state.forecasts['65535'], undefined)
    assert.equal(state.unbundledForecasts['?'].requestLabel, 'round rock tx')
    assert.equal(state.unbundledForecasts['?'].requestedHere, true)
  })

  it('a forecast is answered by any bot and marked as asked for here', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot })
    await h.service.ingest(F.forecast({ seq: 1, point: 102, bot: 0x0102 }))
    assert.deepStrictEqual(h.service.pendingRequests(), [])
    const state = await h.service.state({ for: 0x0102 })
    assert.equal(state.forecasts['102'].requestedHere, true)
  })

  it('a forecast nobody here asked for is not marked as asked for here', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.forecast({ seq: 1, point: 304 }))
    const state = await h.service.state({ for: F.botID })
    assert.equal(state.forecasts['304'].requestedHere, false)
  })

  it('messages from another bot do not settle a coverage request', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.digest, { to: F.bot })
    await h.service.ingest(F.digest({ seq: 1, entries: [], bot: 0x0102 }))
    assert.equal(h.service.pendingRequests().length, 1)
    assert.equal(Object.keys(await h.service.allStates()).length, 1)
  })

  // MARK: - Five-minute rule and timeouts

  it('an answered request is not re-sent within five minutes', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.digest, { to: F.bot })
    await h.service.ingest(F.digest({ seq: 1, entries: [] }))
    assert.equal(F.settlements(h.events).length, 1)

    await h.clock.advance(4 * 60)
    const second = await h.service.send(WeatherRequest.digest, { to: F.bot })
    assert.equal(second, null)
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 2)
    assert.ok(isAlreadyReceived(settled[1][1]))
    assert.equal(h.transport.sent.length, 1)

    await h.clock.advance(2 * 60)
    const third = await h.service.send(WeatherRequest.digest, { to: F.bot })
    assert.notEqual(third, null)
    assert.equal(h.transport.sent.length, 2)
  })

  // Twenty phones tapping after a siren: whoever's answer arrives first answers everyone.
  it("an alert list somebody else asked for answers this phone's request without sending", async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 1, entries: [] }))
    await h.clock.advance(40)
    assert.equal(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
    assert.deepStrictEqual(h.transport.sent, [])
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    const outcome = settled[0][1]
    assert.equal(outcome.kind, 'alreadyReceived')
    assert.equal(outcome.receivedAt, h.clock.now - 40_000)
    assert.equal(outcome.contentAsOf, F.t0Minutes * 60_000)
  })

  it('an alert list is asked for again when a gap opened after it arrived', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 1, entries: [] }))
    await h.clock.advance(30)
    // seq 2 is lost.
    await h.service.ingest(F.observations({ seq: 3, stations: [[202, 88], [860, 84]] }))
    assert.notEqual(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
  })

  it('a list built too soon after a gap to clear it is asked for again once a new one would', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.observations({ seq: 1, stations: [[202, 88], [860, 84]] }))
    await h.service.ingest(F.observations({ seq: 3, stations: [[202, 88], [860, 84]] }))
    await h.clock.advance(20)
    await h.service.ingest(F.digest({ seq: 4, nowMinutes: F.t0Minutes, entries: [] }))
    assert.equal((await h.service.state({ for: F.botID })).needsDigest, true)
    await h.clock.advance(30)
    assert.equal(
      await h.service.send(WeatherRequest.digest, { to: F.bot }), null,
      'a list built now could not clear the gap either'
    )
    await h.clock.advance(100)
    assert.notEqual(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
  })

  it('a single-station reply answers that station but not the coverage batch', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.observations({ seq: 1, stations: [[202, 88]] }))
    assert.equal(await h.service.send(WeatherRequest.observation({ station: 'KAUS' }), { to: F.bot }), null)
    assert.notEqual(await h.service.send(WeatherRequest.observations, { to: F.bot }), null)
  })

  // Spec §8: a reply with a part missing may be asked for again after 20 s.
  it('a text request whose reply is incomplete is sent again inside the five minutes', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.hazardousOutlook, { to: F.bot })
    await h.service.ingest(
      F.text({ seq: 1, subject: 6, group: 1, index: 0, total: 2, text: 'part one' })
    )
    assert.equal(F.settlements(h.events).length, 1)

    await h.clock.advance(25)
    assert.notEqual(await h.service.send(WeatherRequest.hazardousOutlook, { to: F.bot }), null)
    assert.equal(h.transport.sent.length, 2)
  })

  it('no answer and no sound from the bot means two sends on the route, one by flood, then timed out', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.clock.advance(45)
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.text), ['>space', '>space', '>space'])
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.attempt), [0, 1, 2])
    // The route is forgotten exactly once, before the third send and after the second.
    assert.deepStrictEqual(h.transport.resets, [F.botPublicKey])
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false }))
    assert.equal(settled[0][0].attempt, WeatherService.floodAttempt)
    assert.deepStrictEqual(h.service.pendingRequests(), [])
  })

  it('a bot heard after the request, but not confirming it, is asked once more by flood', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.clock.advance(1)
    await h.service.ingest(F.observations({ seq: 1, stations: [[202, 88], [860, 84]] }))
    // Heard means in range, so a second send along the same route would only add to the noise.
    await h.clock.advance(30)
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.attempt), [0, 2])
    assert.deepStrictEqual(h.transport.resets, [F.botPublicKey])
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: true }))
    assert.equal(h.transport.sent.length, 2)
  })

  it('an answer during the retry window settles without a second transmission', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.service.ingest(F.text({ seq: 1, subject: 2, group: 1, index: 0, total: 1, text: 'quiet' }))
    assert.equal(F.settlements(h.events).length, 1)
    await h.clock.advance(60)
    assert.equal(h.transport.sent.length, 1)
  })

  // MARK: - Retry timestamp and delivery confirmation

  it("every resend carries the first send's timestamp and text, under its own attempt and code", async () => {
    const h = await makeHarness()
    const first = await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.clock.advance(45)
    const sent = h.transport.sent
    assert.deepStrictEqual(sent.map((entry) => entry.attempt), [0, 1, 2])
    assert.deepStrictEqual(sent.map((entry) => entry.text), ['>space', '>space', '>space'])
    assert.deepStrictEqual(
      sent.map((entry) => entry.timestamp), [first.timestamp, first.timestamp, first.timestamp]
    )
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    const request = settled[0][0]
    assert.equal(request.timestamp, first.timestamp)
    assert.ok(request.sentAt > first.timestamp, "a resend's send time moves on; its wire timestamp does not")
    const { hex } = await import('../src/weather/index.js')
    assert.deepStrictEqual(
      [...request.ackCodes].sort(), sent.map((entry) => hex(entry.ackCode)).sort()
    )
    assert.equal(request.ackCodes.length, 3)
  })

  it("a confirmation of the first send marks the request received by the bot's radio", async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    h.transport.acknowledge(h.transport.sent[0].ackCode)
    assert.equal(h.service.pendingRequests()[0].botRadioReceived, true)
    // A confirmed request that gets no answer goes out once more along the route — the bot
    // answers a copy from its cache — and is never flooded: the route provably works.
    await h.clock.advance(30)
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(
      settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false, botRadioReceived: true })
    )
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.attempt), [0, 1])
    assert.deepStrictEqual(h.transport.resets, [])
  })

  it('a confirmation of the retry counts too', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.clock.advance(15)
    const retry = h.transport.sent.at(-1)
    assert.equal(retry.attempt, 1)
    h.transport.acknowledge(retry.ackCode)
    await h.clock.advance(15)
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(
      settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false, botRadioReceived: true })
    )
    // Confirmed on the second send: no flood follows.
    assert.equal(h.transport.sent.length, 2)
    assert.deepStrictEqual(h.transport.resets, [])
  })

  it('a confirmation no request expects marks nothing', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    h.transport.acknowledge(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
    await h.clock.advance(45)
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(
      settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false, botRadioReceived: false })
    )
  })

  it('a confirmation that lands before the send returns still counts', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    h.transport.setConfirmsDuringSend(true)
    const pending = await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    assert.equal(pending.botRadioReceived, true)
    assert.equal(h.service.pendingRequests()[0].botRadioReceived, true)
  })

  it('a confirmed request that is answered settles as answered', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    h.transport.acknowledge(h.transport.sent[0].ackCode)
    assert.equal(h.service.pendingRequests()[0].botRadioReceived, true)
    await h.service.ingest(F.text({ seq: 1, subject: 2, group: 1, index: 0, total: 1, text: 'quiet' }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
    assert.equal(h.transport.sent.length, 1)
  })

  // MARK: - Requests on the channel (spec §11)

  it('a request goes out as a datagram flooded on the channel, not as a DM', async () => {
    const h = await makeHarness({ channelRequests: true })
    const pending = await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot })
    assert.equal(pending.transportKind, 'channel')
    assert.equal(pending.attempt, 0)
    assert.deepStrictEqual(h.transport.sent, [], 'nothing goes out as a DM')
    const flooded = h.transport.channelSent
    assert.equal(flooded.length, 1)
    assert.equal(flooded[0].text, '>f 102')
    assert.equal(flooded[0].botID, F.botID)
    assert.equal(flooded[0].timestamp, pending.timestamp)
    assert.equal(flooded[0].seq, pending.seq)
    // There is no acknowledgement for a datagram, so nothing is ever waiting on one.
    assert.deepStrictEqual(pending.ackCodes, [])
    assert.equal(pending.botRadioReceived, false)
  })

  // Spec §11: one more per **new** request, wrapping; the five-second spacing still applies.
  it('each new request takes the next seq', async () => {
    const h = await makeHarness({ channelRequests: true })
    await h.service.send(WeatherRequest.digest, { to: F.bot })
    await h.clock.advance(5.1)
    await h.service.send(WeatherRequest.observations, { to: F.bot })
    await h.clock.advance(2)
    await assert.rejects(
      () => h.service.send(WeatherRequest.coverage, { to: F.bot }),
      (error) => error instanceof WeatherRequestError && error.kind === 'rateLimited'
    )
    assert.deepStrictEqual(h.transport.channelSent.map((entry) => entry.seq), [0, 1])
    assert.deepStrictEqual(h.transport.channelSent.map((entry) => entry.text), ['>d', '>o'])
  })

  it('no answer means one resend of the same bytes, then timed out', async () => {
    assert.equal(WeatherService.channelAnswerTimeout, 10)
    const h = await makeHarness({ channelRequests: true })
    const first = await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.clock.advance(10)
    const flooded = h.transport.channelSent
    assert.equal(flooded.length, 2)
    // The same bytes: same text, same `ts`, same `seq`.
    assert.deepStrictEqual(flooded.map((entry) => entry.text), ['>space', '>space'])
    assert.deepStrictEqual(flooded.map((entry) => entry.timestamp), [first.timestamp, first.timestamp])
    assert.deepStrictEqual(flooded.map((entry) => entry.seq), [first.seq, first.seq])
    await h.clock.advance(10)
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(
      settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false, botRadioReceived: false })
    )
    assert.equal(settled[0][0].attempt, 1)
    assert.ok(settled[0][0].sentAt >= first.timestamp)
    // Never a third time; never a DM; and no route to forget.
    await h.clock.advance(60)
    assert.equal(h.transport.channelSent.length, 2)
    assert.deepStrictEqual(h.transport.sent, [])
    assert.deepStrictEqual(h.transport.resets, [])
  })

  it('an answer settles a channel request after one send', async () => {
    const h = await makeHarness({ channelRequests: true })
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.service.ingest(F.text({ seq: 1, subject: 2, group: 1, index: 0, total: 1, text: 'quiet' }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
    await h.clock.advance(60)
    assert.equal(h.transport.channelSent.length, 1)
  })

  it('a bot heard while a channel request was out is named in the timeout', async () => {
    const h = await makeHarness({ channelRequests: true })
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.clock.advance(1)
    await h.service.ingest(F.observations({ seq: 1, stations: [[202, 88], [860, 84]] }))
    await h.clock.advance(20)
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(
      settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: true, botRadioReceived: false })
    )
    // Heard or not, a datagram gets its one resend: there is no route to suspect.
    assert.equal(h.transport.channelSent.length, 2)
    assert.deepStrictEqual(h.transport.resets, [])
  })

  // Spec §11: "An app whose radio cannot send channel datagrams keeps using the DM."
  it('a radio that cannot flood a datagram falls back to the DM ladder', async () => {
    const h = await makeHarness({ channelRequests: false })
    const pending = await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    assert.equal(h.transport.channelRequestsRefused, 1, 'the channel is tried first, every time')
    assert.deepStrictEqual(h.transport.channelSent, [])
    assert.equal(pending.transportKind, 'dm')
    // The ladder is untouched: two sends on the route, then the flood after a route reset.
    await h.clock.advance(45)
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.attempt), [0, 1, 2])
    assert.deepStrictEqual(h.transport.resets, [F.botPublicKey])
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false }))
    // The fallback is silent: nothing about it reaches the request's own seq counter.
    assert.equal(h.transport.channelRequestsRefused, 1)
  })

  // Not in the Swift, which has one `WeatherTransportError` type across the package. The web's
  // transports live in `src/link/`, and one of them declares its own copy of the class, so the
  // fallback has to read the error structurally or every request from that radio would fail
  // instead of going out as a DM.
  it("a refusal from another module's copy of the error still falls back to the DM", async () => {
    const h = await makeHarness({ channelRequests: true })
    h.transport.sendChannelRequest = async () => {
      const error = new Error('channelRequestsUnavailable(no slot)')
      error.name = 'WeatherTransportError'
      error.kind = 'channelRequestsUnavailable'
      throw error
    }
    const pending = await h.service.send(WeatherRequest.digest, { to: F.bot })
    assert.equal(pending.transportKind, 'dm')
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.text), ['>d'])
  })

  // A bot only ever heard on the channel has no advert and so no whole key, and a Request
  // datagram needs none: it names the bot by the two bytes every one of its packets carries.
  it('a bot that was heard but never announced is asked by datagram', async () => {
    const h = await makeHarness({ channelRequests: true })
    const heard = WeatherBot.heardOnly({ botID: WeatherBot.botID(F.bot) })
    const pending = await h.service.send(WeatherRequest.digest, { to: heard })
    assert.equal(pending.transportKind, 'channel')
    assert.equal(pending.botID, WeatherBot.botID(F.bot))
    assert.deepStrictEqual(h.transport.channelSent.map((entry) => entry.botID), [WeatherBot.botID(F.bot)])
    assert.deepStrictEqual(h.transport.sent, [], 'and never by DM')
  })

  it('and when the radio cannot send one, it is refused rather than sent to half a key', async () => {
    const h = await makeHarness({ channelRequests: false })
    const heard = WeatherBot.heardOnly({ botID: WeatherBot.botID(F.bot) })
    await assert.rejects(() => h.service.send(WeatherRequest.digest, { to: heard }), /has not announced itself/)
    assert.deepStrictEqual(h.transport.sent, [])
  })

  // Requests are flooded now, so a phone on `#meshwx` hears everybody else's.
  it("another phone's request on the channel changes nothing", async () => {
    const h = await makeHarness({ channelRequests: true })
    await h.service.startEventMonitoring()
    await h.service.send(WeatherRequest.digest, { to: F.bot })

    assert.equal(
      await h.service.ingestDatagram(F.datagram(F.request({ seq: 250, text: '>o KAUS' }))), null
    )
    assert.deepStrictEqual(await h.service.allStates(), {}, 'nothing is stored, and no bot is invented')
    assert.equal(h.service.sessionInfo().lastChannelDatagramAt, null)
    assert.equal(h.service.pendingRequests().length, 1, "somebody's question is not an answer")
    // And it did not count as hearing the bot: the timeout still reads "nothing came back".
    await h.clock.advance(25)
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(
      settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false, botRadioReceived: false })
    )
  })

  // MARK: - The transport's own link

  it('the service passes on a link the transport provides of its own', async () => {
    const h = await makeHarness()
    assert.equal(await h.service.transportLink(), null)
    h.transport.setLink(WeatherTransportLink.up({ bot: F.bot }))
    const link = await h.service.transportLink()
    assert.notEqual(link, null)
    assert.equal(WeatherTransportLink.bot(link).name, 'WX-AUS')
    assert.deepStrictEqual(WeatherTransportLink.bot(link).publicKey, F.botPublicKey)
  })

  it('stopping monitoring fails whatever is still pending', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    await h.service.send(WeatherRequest.digest, { to: F.bot })
    h.service.stopEventMonitoring()
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.failed('disconnected'))
  })

  // MARK: - Retention

  // Readings are kept one per station; what grows is the number of stations.
  it('a station nothing has carried for two days is forgotten', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.observations({ seq: 1, stations: [[202, 88], [860, 84]] }))
    // Somebody's one-off request for a station this bot's batch never carries.
    await h.service.ingest(
      F.observations({ seq: 2, timestampMinutes: F.t0Minutes + 1, stations: [[976, 70]] })
    )
    assert.equal(Object.keys((await h.service.state({ for: F.botID })).observations).length, 3)

    await h.clock.advance(49 * 3600)
    await h.service.ingest(F.observations({
      seq: 3, timestampMinutes: F.t0Minutes + 49 * 60, stations: [[202, 80], [860, 79]]
    }))
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(
      Object.keys(state.observations).map(Number).sort((a, b) => a - b), [202, 860]
    )
  })

  it("readings are capped per bot, the bot's own area first", async () => {
    const h = await makeHarness()
    await h.service.ingest(F.observations({ seq: 1, stations: [[202, 88], [860, 84]] }))
    for (let offset = 0; offset < 70; offset += 1) {
      await h.service.ingest(F.observations({
        seq: (2 + offset) & 0xff,
        // Each an hour or so old, so none of them is ahead of the phone's clock (spec §17.5).
        timestampMinutes: F.t0Minutes - 70 + offset,
        stations: [[1000 + offset, 70]]
      }))
    }
    const state = await h.service.state({ for: F.botID })
    assert.equal(Object.keys(state.observations).length, WeatherService.maxObservationsPerBot)
    assert.notEqual(state.observations['202'], undefined)
    assert.notEqual(
      state.observations['860'], undefined,
      "the bot's own area outlives answers to one-off questions"
    )
  })

  it('clearing a bot forgets its state and its answers', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 1, entries: [] }))
    await h.service.clearState({ for: F.botID })
    assert.equal(await h.service.state({ for: F.botID }), null)
    assert.deepStrictEqual(h.store.states, {})
    assert.notEqual(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
  })
})
