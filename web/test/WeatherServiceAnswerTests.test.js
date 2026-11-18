// Port of MC1ServicesTests/Weather/WeatherServiceAnswerTests.swift (docs/PORTING.md).
//
// What counts as an answer: the request flow from send to settlement, the five-minute rule's
// slots and what fills them, backlog drained at connect versus traffic heard live, and which
// text replies are this phone's.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MeshWXTables } from '../src/meshwx/index.js'
import { nodeBundleLoader } from '../src/meshwx/nodeLoader.js'
import {
  InMemoryWeatherStateStore,
  WeatherPartsKind,
  WeatherRequest,
  WeatherRequestError,
  WeatherRequestOutcome,
  WeatherService,
  dateFromUnixMinutes
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
 * The fake radio cannot flood a Request datagram here (spec §11), so every request in this
 * suite goes out as the DM of §14 and the assertions on `transport.sent` still read the send
 * they were written for. The channel path has its own section in `WeatherServiceTests`.
 */
async function makeHarness() {
  const transport = await F.makeTransport({ channelRequestsSupported: false })
  const clock = new F.WeatherTestClock()
  const service = new WeatherService({
    transport,
    store: new InMemoryWeatherStateStore(),
    now: () => clock.now,
    stationIndex: (icao) => (icao === 'KAUS' ? 202 : null),
    tables,
    setTimeout: (fn, milliseconds) => clock.setTimeout(fn, milliseconds),
    clearTimeout: (id) => clock.clearTimeout(id),
    decode: F.fixtureDecode
  })
  return { transport, clock, service, events: F.collectEvents(service) }
}

describe('WeatherService answers', () => {
  // MARK: - Request flow

  it('a request is sent, waits as pending, and settles as answered', async () => {
    const h = await makeHarness()
    const log = []
    h.service.subscribe((event) => {
      if (event.kind === 'requestSent') log.push(`sent ${WeatherRequest.wireText(event.value.request)}`)
      if (event.kind === 'requestSettled') {
        log.push(`settled ${WeatherRequest.wireText(event.value.request)} ${event.value2.kind}`)
      }
    })
    const pending = await h.service.send(WeatherRequest.digest, { to: F.bot })
    assert.deepStrictEqual(h.service.pendingRequests().map((entry) => entry.id), [pending.id])
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.text), ['>d'])

    await h.clock.advance(3)
    await h.service.ingest(F.digest({ seq: 1, entries: [] }))
    assert.deepStrictEqual(log, ['sent >d', 'settled >d answered'])
    assert.deepStrictEqual(h.service.pendingRequests(), [])
  })

  it('a second request inside five seconds is refused with the time left', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.digest, { to: F.bot })
    await h.clock.advance(3)
    await assert.rejects(
      () => h.service.send(WeatherRequest.observations, { to: F.bot }),
      (error) => error instanceof WeatherRequestError
        && error.kind === 'rateLimited'
        && Math.abs(error.retryAfter - 2) < 0.001
    )
    assert.equal(h.transport.sent.length, 1)
  })

  // MARK: - Slots

  it('an answer served from the channel says what it is as of', async () => {
    const h = await makeHarness()
    await h.service.ingest(
      F.observations({ seq: 1, timestampMinutes: F.t0Minutes - 7, stations: [[202, 88], [860, 84]] })
    )
    await h.service.ingest(
      F.forecast({ seq: 2, point: 102, issuedMinutes: F.t0Minutes - 30, bot: 0x0102 })
    )
    await h.service.ingest(F.digest({ seq: 3, nowMinutes: F.t0Minutes - 2, entries: [] }))
    await h.clock.advance(60)

    assert.equal(await h.service.send(WeatherRequest.observations, { to: F.bot }), null)
    assert.equal(await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot }), null)
    assert.equal(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
    assert.deepStrictEqual(F.settlements(h.events).map(([, outcome]) => outcome), [
      WeatherRequestOutcome.alreadyReceived({
        receivedAt: F.t0, contentAsOf: dateFromUnixMinutes(F.t0Minutes - 7)
      }),
      WeatherRequestOutcome.alreadyReceived({
        receivedAt: F.t0, contentAsOf: dateFromUnixMinutes(F.t0Minutes - 30)
      }),
      WeatherRequestOutcome.alreadyReceived({
        receivedAt: F.t0, contentAsOf: dateFromUnixMinutes(F.t0Minutes - 2)
      })
    ])
    assert.deepStrictEqual(h.transport.sent, [])
  })

  it("a station's slot is as of that station's own report, not the batch's", async () => {
    const h = await makeHarness()
    // Revision 5 (spec §6.1): KAUS filed 40 minutes before the newest station in the batch.
    await h.service.ingest(F.observations({
      seq: 1, timestampMinutes: F.t0Minutes - 7, stations: [[202, 88], [860, 84]], ages: [40, 0]
    }))
    await h.clock.advance(60)

    assert.equal(
      await h.service.send(WeatherRequest.observation({ station: 'KAUS' }), { to: F.bot }), null
    )
    assert.equal(await h.service.send(WeatherRequest.observations, { to: F.bot }), null)
    assert.deepStrictEqual(F.settlements(h.events).map(([, outcome]) => outcome), [
      WeatherRequestOutcome.alreadyReceived({
        receivedAt: F.t0, contentAsOf: dateFromUnixMinutes(F.t0Minutes - 7 - 40)
      }),
      WeatherRequestOutcome.alreadyReceived({
        receivedAt: F.t0, contentAsOf: dateFromUnixMinutes(F.t0Minutes - 7)
      })
    ])
    assert.deepStrictEqual(h.transport.sent, [])
  })

  it('a list older than the one held answers nothing, in order or late', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 10, nowMinutes: F.t0Minutes, entries: [] }))
    await h.clock.advance(6 * 60)

    const older = await h.service.ingest(F.digest({ seq: 11, nowMinutes: F.t0Minutes - 30, entries: [] }))
    assert.ok(older.some((change) => change.kind === 'digestIgnoredOlder'
      && change.builtMinutes === F.t0Minutes - 30))
    assert.notEqual(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)

    await h.clock.advance(6 * 60)
    const late = await h.service.ingest(F.digest({ seq: 5, nowMinutes: F.t0Minutes - 20, entries: [] }))
    assert.deepStrictEqual(late.map((change) => change.kind), ['outOfOrder', 'digestIgnoredOlder'])
    assert.notEqual(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
  })

  it('a late warning the reducer set aside answers nothing', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.cancel({ seq: 10, identity: F.svw42 }))
    await h.service.ingest(F.warning({ seq: 8, identity: F.svw42 }))
    const { identityKey } = await import('../src/weather/index.js')
    const state = await h.service.state({ for: F.botID })
    assert.equal(state.warnings[identityKey(F.svw42)], undefined)
    assert.notEqual(
      await h.service.send(WeatherRequest.warning({ identity: 'SV.W.EWX.42' }), { to: F.bot }), null
    )
  })

  it('a warning from any bot answers a request for that warning', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw42, bot: 0x0102 }))
    assert.equal(
      await h.service.send(WeatherRequest.warning({ identity: 'SV.W.EWX.42' }), { to: F.bot }), null
    )
    assert.equal(
      await h.service.send(WeatherRequest.warning({ identity: 'sv.w.ewx.42' }), { to: F.bot }), null
    )
    assert.notEqual(
      await h.service.send(WeatherRequest.warning({ identity: 'SV.W.EWX.43' }), { to: F.bot }), null
    )
  })

  it('a list from the bot answers its warnings requests while nothing is outstanding', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 1, entries: [] }))
    assert.equal(await h.service.send(WeatherRequest.activeWarnings, { to: F.bot }), null)
    assert.equal(
      await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC453' }), { to: F.bot }), null
    )
    assert.notEqual(
      await h.service.send(WeatherRequest.activeWarnings, { to: other }), null,
      "another bot's list is not this one's"
    )
  })

  // `>w <area>` is keyed by the code asked (spec §14): one county's answer is not another's.
  it('a warning answers a request for the areas it names, and not for any other', async () => {
    const h = await makeHarness()
    // The suite's warning names Travis County, TXC453.
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw42 }))
    assert.equal(
      await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC453' }), { to: F.bot }), null
    )
    assert.equal(
      await h.service.send(WeatherRequest.warningsTouching({ ugc: 'txc453' }), { to: F.bot }), null
    )
    assert.notEqual(
      await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC201' }), { to: F.bot }), null,
      "a warning for Travis County says nothing about Harris County's"
    )
  })

  // The bot may cut a warning's area list to fit it in a packet (spec §3), so the answer to this
  // phone's own `>w <area>` need not name the area; it still answers it.
  it('the answer to this phone\'s own area request fills that area, whatever its list names', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC209' }), { to: F.bot })
    await h.clock.advance(2)
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw43, areas: [] }))
    assert.equal(F.settlements(h.events).length, 1)
    await h.clock.advance(30)
    assert.equal(
      await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC209' }), { to: F.bot }), null
    )
  })

  // Spec §5, 17 October 2026: the list speaks for the bot's own area, and with the bot's
  // complete statement held that is the area its answer to `>w <area>` stands for.
  it("with the bot's area stated, its list answers area requests inside it and not outside", async () => {
    const h = await makeHarness()
    await h.service.ingest(F.coverage({ seq: 1 }))
    await h.service.ingest(F.digest({ seq: 2, entries: [] }))
    for (const ugc of ['TXZ192', 'TXC453']) {
      assert.equal(
        await h.service.send(WeatherRequest.warningsTouching({ ugc }), { to: F.bot }), null, ugc
      )
    }
    assert.notEqual(
      await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC201' }), { to: F.bot }), null,
      "Houston is not in WX-AUS's area, so WX-AUS's list is no answer about it"
    )
  })

  // The list itself is what shows a warning never arrived; asking again is the repair.
  it("warnings requests are sent while the bot's list names a warning this phone lacks", async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 1, entries: [[F.svw43, 30]] }))
    await h.service.ingest(F.warning({ seq: 2, identity: F.svw42 }))
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(state.missingFromDigest, [F.svw43])
    assert.notEqual(
      await h.service.send(WeatherRequest.warningsTouching({ ugc: 'TXC453' }), { to: F.bot }), null
    )
  })

  // Asking for missing warnings one at a time ends in `>d` once the bot has said it has none of
  // them; that last ask must not wait out the five minutes behind the list it wants replaced.
  it("a list request is sent while the bot's list names a warning this phone lacks", async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 1, entries: [[F.svw43, 30]] }))
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(state.missingFromDigest, [F.svw43])
    assert.notEqual(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
  })

  it('only a complete reply this phone asked for answers a text request', async () => {
    const h = await makeHarness()
    await h.service.ingest(
      F.text({ seq: 1, subject: 6, group: 1, index: 0, total: 1, text: 'outlook' })
    )
    assert.notEqual(
      await h.service.send(WeatherRequest.hazardousOutlook, { to: F.bot }), null,
      "somebody else's reply is not an answer"
    )

    await h.service.ingest(
      F.text({ seq: 2, subject: 6, group: 2, index: 0, total: 1, text: 'outlook' })
    )
    assert.equal(F.settlements(h.events).length, 1)
    await h.clock.advance(30)
    assert.equal(await h.service.send(WeatherRequest.hazardousOutlook, { to: F.bot }), null)
  })

  // MARK: - Coverage

  // Spec §10, §14: `>cov` asks a bot what it carries. The statement carries no time of its
  // own, so the five-minute rule runs from receipt and the answer names nothing it is "as of".
  it('a statement answers the request that asked for it, and fills its slot', async () => {
    const h = await makeHarness()
    const pending = await h.service.send(WeatherRequest.coverage, { to: F.bot })
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.text), ['>cov'])

    await h.clock.advance(2)
    await h.service.ingest(F.coverage({ seq: 1 }))
    let settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.equal(settled[0][0].id, pending.id)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
    const state = await h.service.state({ for: F.botID })
    assert.equal(state.coverage.coverage.radius_km, 120)

    await h.clock.advance(30)
    assert.equal(await h.service.send(WeatherRequest.coverage, { to: F.bot }), null)
    settled = F.settlements(h.events)
    assert.equal(settled.length, 2)
    assert.deepStrictEqual(
      settled[1][1],
      WeatherRequestOutcome.alreadyReceived({ receivedAt: F.t0 + 2000, contentAsOf: null })
    )
  })

  // A statement describes whichever bot sent it, so another bot's settles nothing here.
  it("another bot's statement is not this bot's", async () => {
    const h = await makeHarness()
    await h.service.ingest(F.coverage({ seq: 1, bot: 0x0102 }))
    assert.notEqual(await h.service.send(WeatherRequest.coverage, { to: F.bot }), null)
  })

  it('clearing a bot forgets the answers any bot gave', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.forecast({ seq: 1, point: 102, bot: 0x0102 }))
    assert.equal(await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot }), null)
    await h.service.clearState({ for: F.botID })
    assert.notEqual(await h.service.send(WeatherRequest.forecast({ point: 102 }), { to: F.bot }), null)
  })

  // MARK: - Area sweep (spec §12)

  // `>wmap` is answered by the sweep's **first** packet — the other seven are already on the
  // air — and the slot it fills is what stops the next phone spending eight more.
  it('the first sweep packet answers the map request and fills its slot', async () => {
    const h = await makeHarness()
    const pending = await h.service.send(
      WeatherRequest.areaSweep({ includesAdvisories: false }), { to: F.bot }
    )
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.text), ['>wmap'])

    await h.clock.advance(2)
    await h.service.ingest(
      F.areaSweep({ seq: 1, group: 1, index: 0, total: 3, entries: [F.texasSweepEntry] })
    )
    let settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.equal(settled[0][0].id, pending.id)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
    // The sweep the tap produced is marked as this phone's, even though it is still arriving.
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(
      state.areaSweeps[0].request, WeatherRequest.areaSweep({ includesAdvisories: false })
    )

    // A narrow national sweep answers a wide national tap: a sweep that covered the country
    // covered it, and the level the bot actually sent is what the map reads off the sweep.
    await h.clock.advance(30)
    assert.equal(
      await h.service.send(WeatherRequest.areaSweep({ includesAdvisories: true }), { to: F.bot }), null
    )
    settled = F.settlements(h.events)
    assert.equal(settled.length, 2)
    assert.deepStrictEqual(
      settled[1][1],
      WeatherRequestOutcome.alreadyReceived({
        receivedAt: F.t0 + 2000, contentAsOf: dateFromUnixMinutes(F.t0Minutes)
      })
    )
  })

  // MARK: - Revision 10

  /**
   * "slots keyed so two different state selections are different requests". A sweep of Texas is
   * not the answer to a tap on Oklahoma, however recently it went out.
   */
  it('a sweep of one selection does not answer a tap on another', async () => {
    const h = await makeHarness()
    const texas = tables.states.indexOf('TX')
    const oklahoma = tables.states.indexOf('OK')
    await h.service.ingest(F.areaSweep({
      seq: 1, group: 1, index: 0, total: 1, scope: [texas], entries: [F.texasSweepEntry]
    }))

    await h.clock.advance(10)
    assert.equal(
      await h.service.send(
        WeatherRequest.areaSweep({ includesAdvisories: false, states: ['TX'] }), { to: F.bot }
      ),
      null,
      'Texas was just delivered',
    )
    await h.clock.advance(10)
    assert.notEqual(
      await h.service.send(
        WeatherRequest.areaSweep({ includesAdvisories: false, states: ['OK'] }), { to: F.bot }
      ),
      null,
      'nothing said anything about Oklahoma',
    )

    // ...and a sweep of the whole country did cover Oklahoma.
    await h.clock.advance(10)
    await h.service.ingest(F.areaSweep({ seq: 2, group: 2, index: 0, total: 1, entries: [] }))
    await h.clock.advance(10)
    assert.equal(
      await h.service.send(
        WeatherRequest.areaSweep({ includesAdvisories: false, states: ['OK'] }), { to: F.bot }
      ),
      null,
    )
    void oklahoma
  })

  /**
   * A scoped sweep whose packet 0 this phone missed cannot be named, so it is evidence of
   * nothing: the scope entries are in packet 0 and nowhere else.
   */
  it('a scoped sweep whose packet 0 was missed fills no slot', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.areaSweep({
      seq: 1, group: 1, index: 1, total: 2, isScoped: true, entries: [F.texasSweepEntry]
    }))
    await h.clock.advance(10)
    assert.notEqual(
      await h.service.send(
        WeatherRequest.areaSweep({ includesAdvisories: false, states: ['TX'] }), { to: F.bot }
      ),
      null,
    )
  })

  /**
   * Spec §12, revision 10: "A `>part` request is never refused by the app's five-minute 'already
   * answered' rule." The rule exists so the channel is not asked to rebuild an answer it just
   * sent, and the whole point of `>part` is that this phone did not get it.
   */
  it('a parts request is never held back by the five-minute rule', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.areaSweep({ seq: 1, group: 1, index: 0, total: 3, entries: [] }))
    const parts = WeatherRequest.parts({
      group: 1, indexes: [1, 2], of: WeatherPartsKind.areaSweep
    })
    await h.clock.advance(10)
    const pending = await h.service.send(parts, { to: F.bot })
    assert.notEqual(pending, null)
    assert.deepStrictEqual(h.transport.sent.map((one) => one.text), ['>part 1 1,2'])

    // And again immediately after one has been answered: still nothing held back.
    await h.service.ingest(F.areaSweep({ seq: 2, group: 1, index: 1, total: 3, entries: [] }))
    await h.clock.advance(10)
    assert.notEqual(
      await h.service.send(
        WeatherRequest.parts({ group: 1, indexes: [2], of: WeatherPartsKind.areaSweep }), { to: F.bot }
      ),
      null,
    )
  })

  /** "It settles as answered when any asked-for index arrives from the bot asked." */
  it('one asked-for packet settles a parts request, and another bot\'s does not', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.areaSweep({ seq: 1, group: 1, index: 0, total: 3, entries: [] }))
    await h.clock.advance(10)
    const pending = await h.service.send(
      WeatherRequest.parts({ group: 1, indexes: [1, 2], of: WeatherPartsKind.areaSweep }), { to: F.bot }
    )

    // Not this: a packet of another group, and another bot's packet of the right one.
    await h.service.ingest(F.areaSweep({ seq: 2, group: 9, index: 1, total: 3, entries: [] }))
    await h.service.ingest(F.areaSweep({
      seq: 1, group: 1, index: 1, total: 3, entries: [], bot: 0x0102
    }))
    assert.equal(h.service.pendingRequests().length, 1)

    // The resent packet: the same group and build time, a fresh seq.
    await h.service.ingest(F.areaSweep({
      seq: 40, group: 1, index: 1, total: 3, entries: [F.texasSweepEntry]
    }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.equal(settled[0][0].id, pending.id)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)

    // The sweep keeps the request that fetched it: a `>part` fills a hole, it does not own one.
    const state = await h.service.state({ for: F.botID })
    assert.equal(state.areaSweeps[0].request, null)
  })

  /**
   * `>f <lat>,<lon>`: the bot chooses the point, so the answer is paired by the bot asked and
   * then by distance from the coordinate — or by having no bundled point at all, which only a
   * question that was asked can produce.
   */
  it('a coordinate forecast is paired by the bot asked and the distance', async () => {
    const h = await makeHarness()
    const austin = tables.point({ at: 102 })
    assert.notEqual(austin, null)
    const request = WeatherRequest.forecastAt({ latitude: austin.lat, longitude: austin.lon })
    await h.service.send(request, { to: F.bot })
    assert.deepStrictEqual(h.transport.sent.map((one) => one.text), [WeatherRequest.wireText(request)])

    // Another bot's answer is not this question's: the point is one bot's choice out of what it
    // holds.
    await h.service.ingest(F.forecast({ seq: 1, point: 102, bot: 0x0102 }))
    assert.equal(h.service.pendingRequests().length, 1)

    await h.service.ingest(F.forecast({ seq: 1, point: 102 }))
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.answered)
  })

  it('a coordinate forecast is not settled by a forecast for somewhere else', async () => {
    const h = await makeHarness()
    // A coordinate in Montana, answered with Austin's point: 1,800 km is not a substitution.
    await h.service.send(WeatherRequest.forecastAt({ latitude: 46.9, longitude: -110.4 }), { to: F.bot })
    await h.service.ingest(F.forecast({ seq: 1, point: 102 }))
    assert.equal(h.service.pendingRequests().length, 1)
  })

  /**
   * The answer to a coordinate is filed under the coordinate asked about, which is the only
   * thing that says where it is for: a `0xFFFF` forecast knows which weather, never which place.
   */
  it('a bot-chosen answer is filed under the coordinate that was asked', async () => {
    const h = await makeHarness()
    const request = WeatherRequest.forecastAt({ latitude: 35.687, longitude: -105.938 })
    await h.service.send(request, { to: F.bot })
    await h.service.ingest(F.forecast({ seq: 1, point: 0xffff }))
    assert.deepStrictEqual(h.service.pendingRequests(), [])

    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(Object.keys(state.unbundledForecasts), ['35.687,-105.938'])
    assert.equal(state.unbundledForecasts['35.687,-105.938'].requestedHere, true)
    assert.equal(state.forecasts['65535'], undefined, 'never under an index no place has')
  })

  it('a bot-chosen answer nobody here asked for stays in the one unasked slot', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.forecast({ seq: 1, point: 0xffff }))
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(Object.keys(state.unbundledForecasts), ['?'])
    assert.equal(state.unbundledForecasts['?'].requestedHere, false)
  })

  // Spec §12: a sweep is cut where the sending bot's own feed runs out.
  it("another bot's sweep does not answer this bot's map request", async () => {
    const h = await makeHarness()
    await h.service.ingest(F.areaSweep({
      seq: 1, group: 1, index: 0, total: 1, entries: [F.texasSweepEntry], bot: 0x0102
    }))
    assert.notEqual(
      await h.service.send(WeatherRequest.areaSweep({ includesAdvisories: false }), { to: F.bot }), null
    )
  })

  // MARK: - Radar (spec §13, revision 11)

  /**
   * "A Radar message for that tile from the bot asked settles the request whatever its `taken`."
   * A bot with nothing newer answers with the picture it already sent, and a phone that went on
   * waiting for a fresher one would wait out the quarter of an hour until the next is made.
   */
  it('a radar tile settles the request for its square, however old the picture', async () => {
    const h = await makeHarness()
    const pending = await h.service.send(
      WeatherRequest.radar({ latitude: 30.27, longitude: -97.74 }), { to: F.bot }
    )
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.text), ['>radar 30.270,-97.740'])
    assert.equal(pending.request.kind, 'radar')

    // The tile Austin's coordinate falls on, with a picture forty minutes old.
    await h.service.ingest(F.radar({
      seq: 1, south: 29, west: -99, zoom: 0, takenMinutes: F.t0Minutes - 40
    }))
    assert.deepStrictEqual(
      F.settlements(h.events).map(([, outcome]) => outcome), [WeatherRequestOutcome.answered]
    )
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(state.radarTiles.map((one) => one.tile), [{ south: 29, west: -99, zoom: 0 }])
  })

  /** A tile of another square, or of another width, is not the answer to this question. */
  it('a tile of another square leaves the request on the air', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.radar({ latitude: 30.27, longitude: -97.74 }), { to: F.bot })
    await h.service.ingest(F.radar({ seq: 1, south: 32, west: -98, zoom: 0 }))
    assert.equal(h.service.pendingRequests().length, 1, 'that is Dallas')
    await h.service.ingest(F.radar({ seq: 2, south: 28, west: -100, zoom: 1 }))
    assert.equal(h.service.pendingRequests().length, 1, 'that is the wider tile')
    await h.service.ingest(F.radar({ seq: 3, south: 29, west: -99, zoom: 0 }))
    assert.equal(h.service.pendingRequests().length, 0)
  })

  /** "Another bot's Radar for the same tile settles it too (the picture is the same picture)." */
  it("another bot's picture of the same square settles the request", async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.radar({ latitude: 30.27, longitude: -97.74 }), { to: F.bot })
    await h.service.ingest(F.radar({ seq: 1, south: 29, west: -99, zoom: 0, bot: 0x0102 }))
    assert.deepStrictEqual(
      F.settlements(h.events).map(([, outcome]) => outcome), [WeatherRequestOutcome.answered]
    )
  })

  /**
   * Spec §13: the refusal comes back under `x`, not `r`. With both sharing a letter a phone
   * waiting for a radar tile and one waiting for rainfall totals would take each other's.
   */
  it('a refusal under x settles the radar request and nothing else', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.rainfall({ state: 'TX' }), { to: F.bot })
    await h.clock.advance(6)
    await h.service.send(WeatherRequest.radar({ latitude: 30.27, longitude: -97.74 }), { to: F.bot })

    await h.service.ingest(F.notAvailable({ seq: 1, letter: 'x', reason: 2 }))
    assert.deepStrictEqual(
      F.settlements(h.events).map(([entry, outcome]) => [entry.request.kind, outcome]),
      [['radar', WeatherRequestOutcome.notAvailable(2)]]
    )
    assert.equal(h.service.pendingRequests().length, 1, '`>rain` is still waiting')

  })

  /**
   * The three reasons a radar refusal carries reach the caller as they arrived (docs/MESHWX_UI.md §18.3), so a
   * screen can tell "no recent picture for this area", "does not receive radar pictures" and
   * "sent this picture a few minutes ago" apart. The app reads none of them as the others: the
   * second is about the bot for good, and the other two are about this minute.
   */
  it('reasons 0, 2 and 4 come back as themselves', async () => {
    for (const reason of [0, 2, 4]) {
      const h = await makeHarness()
      await h.service.send(WeatherRequest.radar({ latitude: 30.27, longitude: -97.74 }), { to: F.bot })
      await h.service.ingest(F.notAvailable({ seq: 1, letter: 'x', reason }))
      assert.deepStrictEqual(
        F.settlements(h.events).map(([, outcome]) => outcome),
        [WeatherRequestOutcome.notAvailable(reason)]
      )
    }
  })

  /**
   * The slot is the *tile*, from any bot: two places on one square are one answer, which is what
   * the lattice is for. The bot refuses to re-send the same picture for five minutes anyway
   * (reason 4), so asking again would spend a packet to be told so.
   */
  it('a tile received in the last five minutes answers a second place on it', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.radar({
      seq: 1, south: 29, west: -99, zoom: 0, takenMinutes: F.t0Minutes - 5
    }))
    await h.clock.advance(60)

    // Buda is 25 km down the road from Austin and on the same zoom 0 tile, 29N to 31N and
    // 99W to 97W: one answer for the whole town and its neighbours, which is what the lattice
    // is for.
    assert.equal(
      await h.service.send(WeatherRequest.radar({ latitude: 30.085, longitude: -97.842 }), { to: F.bot }),
      null
    )
    assert.deepStrictEqual(F.settlements(h.events).map(([, outcome]) => outcome), [
      WeatherRequestOutcome.alreadyReceived({
        receivedAt: F.t0, contentAsOf: dateFromUnixMinutes(F.t0Minutes - 5)
      })
    ])
    assert.deepStrictEqual(h.transport.sent, [])

    // A wider tile of the same place is another square and another question.
    assert.notEqual(
      await h.service.send(WeatherRequest.radar({ latitude: 30.27, longitude: -97.74, zoom: 2 }), { to: F.bot }),
      null
    )
  })

  // MARK: - The last hour (revision 13)

  /**
   * `>radar <place> loop HHMM…`: the held pictures go on the wire newest first, and the first
   * frame of the answer settles the ask, as any Radar message for the tile does. The rest keep
   * landing in state as frames.
   */
  it('the last hour goes out with the pictures held, and its first frame settles it', async () => {
    const h = await makeHarness()
    const held = [F.t0Minutes - 15, F.t0Minutes]
    const pending = await h.service.send(
      WeatherRequest.radarLoop({ latitude: 30.27, longitude: -97.74, held }), { to: F.bot }
    )
    assert.equal(pending.request.kind, 'radarLoop')
    const hhmm = (minutes) => WeatherRequest.utcHourMinute(minutes)
    assert.deepStrictEqual(
      h.transport.sent.map((entry) => entry.text),
      [`>radar 30.270,-97.740 loop ${hhmm(F.t0Minutes)} ${hhmm(F.t0Minutes - 15)}`]
    )
    // Oldest first, one packet each.
    await h.service.ingest(F.radar({ seq: 1, south: 29, west: -99, zoom: 0, takenMinutes: F.t0Minutes - 45 }))
    assert.deepStrictEqual(
      F.settlements(h.events).map(([, outcome]) => outcome), [WeatherRequestOutcome.answered]
    )
    await h.service.ingest(F.radar({ seq: 2, south: 29, west: -99, zoom: 0, takenMinutes: F.t0Minutes - 30 }))
    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(
      state.radarTiles.map((one) => F.t0Minutes - one.radar.taken_min), [30, 45], 'two frames of one square'
    )
  })

  /** A loop's refusal comes back under `x` like any radar refusal, worded by its reason. */
  it('a refusal under x settles the last hour', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.radarLoop({ latitude: 30.27, longitude: -97.74 }), { to: F.bot })
    await h.service.ingest(F.notAvailable({ seq: 1, letter: 'x', reason: 4 }))
    assert.deepStrictEqual(
      F.settlements(h.events).map(([entry, outcome]) => [entry.request.kind, outcome]),
      [['radarLoop', WeatherRequestOutcome.notAvailable(4)]]
    )
  })

  /**
   * The five-minute slot says when the square's newest picture arrived. A loop asks for the older
   * ones, so a picture received a minute ago does not answer it; and an older frame landing does
   * not answer the next ask for a newer picture either.
   */
  it('the last hour is not answered by the slot, and an older frame does not fill it', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.radar({ seq: 1, south: 29, west: -99, zoom: 0, takenMinutes: F.t0Minutes - 5 }))
    await h.clock.advance(60)
    assert.notEqual(
      await h.service.send(WeatherRequest.radarLoop({ latitude: 30.27, longitude: -97.74 }), { to: F.bot }),
      null,
      'a loop is never "already received"'
    )

    const other = await makeHarness()
    await other.service.ingest(F.radar({ seq: 1, south: 29, west: -99, zoom: 0, takenMinutes: F.t0Minutes - 5 }))
    await other.clock.advance(6 * 60)
    // Somebody's loop: an older frame of the same square, heard now.
    await other.service.ingest(F.radar({ seq: 2, south: 29, west: -99, zoom: 0, takenMinutes: F.t0Minutes - 20 }))
    await other.clock.advance(60)
    assert.notEqual(
      await other.service.send(WeatherRequest.radar({ latitude: 30.27, longitude: -97.74 }), { to: F.bot }),
      null,
      'the newest picture arrived six minutes ago, and the frame since is older'
    )
  })

  // MARK: - Backlog

  it('a backlog message updates state but answers nothing and is not hearing the bot', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.digest({ seq: 1, entries: [] }), { isBacklog: true })
    const state = await h.service.state({ for: F.botID })
    assert.notEqual(state.digest, null)
    assert.equal(state.lastHeardAt, h.clock.now)
    assert.equal(state.lastLiveHeardAt, null)
    assert.notEqual(await h.service.send(WeatherRequest.digest, { to: F.bot }), null)
  })

  it('datagrams delivered while the radio drains its queue are backlog, later ones live', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    h.transport.setDrainingBacklog(true)
    h.transport.deliver(F.datagram(F.observations({ seq: 1, stations: [[202, 88], [860, 84]] })))
    await F.flush()
    let state = await h.service.state({ for: F.botID })
    assert.equal(Object.keys(state.observations).length, 2)
    assert.equal(state.lastLiveHeardAt, null)
    assert.notEqual(
      await h.service.send(WeatherRequest.observations, { to: F.bot }), null,
      'a drained batch is no answer'
    )

    h.transport.setDrainingBacklog(false)
    await h.clock.advance(10)
    h.transport.deliver(F.datagram(F.observations({ seq: 2, stations: [[202, 89], [860, 85]] })))
    await F.flush()
    state = await h.service.state({ for: F.botID })
    assert.equal(state.lastLiveHeardAt, h.clock.now)
    assert.deepStrictEqual(h.service.pendingRequests(), [])
    assert.equal(await h.service.send(WeatherRequest.observations, { to: F.bot }), null)
  })

  it('a backlog drained after a request does not stop the retry', async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.spaceWeather, { to: F.bot })
    await h.clock.advance(1)
    await h.service.ingest(
      F.observations({ seq: 1, stations: [[202, 88], [860, 84]] }), { isBacklog: true }
    )
    // Backlog is not "heard": the resend goes along the route, and the flood follows it.
    await h.clock.advance(45)
    assert.deepStrictEqual(h.transport.sent.map((entry) => entry.attempt), [0, 1, 2])
    const settled = F.settlements(h.events)
    assert.equal(settled.length, 1)
    assert.deepStrictEqual(settled[0][1], WeatherRequestOutcome.timedOut({ botWasHeard: false }))
  })

  // MARK: - Text ownership

  it("a METAR request is settled only by that station's METAR, a TAF only by its TAF", async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.metar({ station: 'KAUS' }), { to: F.bot })
    await h.service.ingest(F.text({
      seq: 1, subject: 5, group: 1, index: 0, total: 1,
      text: 'TAF KAUS 150520Z 1506/1612 17008KT P6SM SCT025'
    }))
    await h.service.ingest(F.text({
      seq: 2, subject: 5, group: 2, index: 0, total: 1,
      text: 'METAR KATT 150551Z 16006KT 10SM CLR 29/21 A3001'
    }))
    assert.equal(h.service.pendingRequests().length, 1)
    let state = await h.service.state({ for: F.botID })
    assert.equal(state.texts['1'].request, null)
    assert.equal(state.texts['2'].request, null)

    await h.service.ingest(F.text({
      seq: 3, subject: 5, group: 3, index: 0, total: 1,
      text: 'METAR KAUS 150551Z 17007KT 10SM FEW250 30/21 A3000'
    }))
    assert.equal(F.settlements(h.events).length, 1)
    state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(state.texts['3'].request, WeatherRequest.metar({ station: 'KAUS' }))

    await h.clock.advance(6)
    await h.service.send(WeatherRequest.taf({ station: 'KAUS' }), { to: F.bot })
    await h.service.ingest(F.text({
      seq: 4, subject: 5, group: 4, index: 0, total: 1,
      text: 'KAUS 150651Z 17007KT 10SM FEW250 30/21 A3000'
    }))
    assert.equal(h.service.pendingRequests().length, 1, 'a raw METAR is not the TAF')
    await h.service.ingest(F.text({
      seq: 5, subject: 5, group: 5, index: 0, total: 1,
      text: 'TAF AMD KAUS 150640Z 1507/1612 17008KT P6SM SCT025'
    }))
    assert.equal(F.settlements(h.events).length, 2)
    state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(state.texts['5'].request, WeatherRequest.taf({ station: 'KAUS' }))
  })

  it("storm reports for another state neither settle nor become this phone's", async () => {
    const h = await makeHarness()
    await h.service.send(WeatherRequest.stormReports({ state: 'TX' }), { to: F.bot })
    await h.service.ingest(F.text({
      seq: 1, subject: 3, group: 1, index: 0, total: 1,
      text: '0210 HAIL 3 SW TULSA TULSA OK 1.00 INCH'
    }))
    assert.equal(h.service.pendingRequests().length, 1)
    const state = await h.service.state({ for: F.botID })
    assert.equal(state.texts['1'].request, null)
    await h.service.ingest(F.text({
      seq: 2, subject: 3, group: 2, index: 0, total: 1,
      text: '0115 TSTM WND DMG 2 N AUSTIN TRAVIS TX'
    }))
    assert.equal(F.settlements(h.events).length, 1)
  })

  // The kit's own narrative (vectors `text_warning_narrative_chunk0` and `_chunk1`), for a
  // storm warning over Travis County.
  it('a warning narrative is claimed by its event and area, from the bot asked, whatever the chunk order', async () => {
    const h = await makeHarness()
    await h.service.ingest(F.warning({ seq: 1, identity: F.svw42 }))
    await h.service.send(WeatherRequest.warningText({ identity: 'SV.W.EWX.42' }), { to: F.bot })

    await h.service.ingest(F.text({
      seq: 2, group: 2, index: 0, total: 1,
      text: 'FLASH FLOOD WARNING FOR CENTRAL BEXAR COUNTY UNTIL 300 AM CDT.'
    }))
    await h.service.ingest(F.text({
      seq: 3, group: 3, index: 0, total: 1,
      text: 'SEVERE THUNDERSTORM WARNING FOR NORTHERN KERR COUNTY UNTIL 200 AM CDT.'
    }))
    const chunk0 = 'SEVERE THUNDERSTORM WARNING FOR NORTHEASTERN HAYS AND SOUTHWESTERN TRAVIS '
      + 'COUNTIES UNTIL 145 AM CDT. At 1257 AM a severe thunderstorm was near Dripping Sprin'
    const chunk1 = 'gs, moving east at 40 mph. HAZARD: 60 mph gusts and quarter size hail. '
      + 'SOURCE: Radar indicated.'
    await h.service.ingest(F.text({ seq: 9, group: 9, index: 0, total: 2, text: chunk0, bot: 0x0102 }))
    assert.equal(
      h.service.pendingRequests().length, 1, "another bot cannot vouch for this bot's warning"
    )

    await h.service.ingest(F.text({ seq: 24, group: 23, index: 1, total: 2, text: chunk1 }))
    assert.equal(h.service.pendingRequests().length, 1, 'the second chunk alone names nothing')
    await h.service.ingest(F.text({ seq: 23, group: 23, index: 0, total: 2, text: chunk0 }))
    assert.equal(F.settlements(h.events).length, 1)

    const state = await h.service.state({ for: F.botID })
    assert.deepStrictEqual(
      state.texts['23'].request, WeatherRequest.warningText({ identity: 'SV.W.EWX.42' })
    )
    assert.equal(state.texts['2'].request, null)
    assert.equal(state.texts['3'].request, null)
  })
})
