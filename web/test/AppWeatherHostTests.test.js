// The web's own half of the port: the model driven through `WeatherHost` with a real
// `WeatherService` over the fake radio, and the two device-local stores the Swift gets from
// `UserDefaults`.
//
// The Swift has no counterpart for these — `AppState` is the app, and `UserDefaults` is
// synchronous — so they are not ports of Swift cases but the tests that keep the substitutions
// honest (`src/app/WeatherHost.js`).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MeshWXGeometry, MeshWXTables } from '../src/meshwx/index.js'
import {
  InMemoryWeatherStateStore,
  WeatherChannel,
  WeatherRequest,
  WeatherService,
} from '../src/weather/index.js'
import { WeatherPage, WeatherRequestLog, WeatherSavedPlace, WeatherUpdatePlan } from '../src/screen/index.js'
import {
  FakeWeatherHost,
  WeatherDefaults,
  WeatherRequestLogStore,
  WeatherToolModel,
} from '../src/app/index.js'
import * as W from './helpers/weather-fixtures.js'
import * as F from './helpers/app-fixture.js'

await F.loadTables()
MeshWXGeometry.configure(() => Promise.resolve(null))

/** The bot as a contact the radio has collected, which is where `WeatherBot.bots` reads it. */
const contact = {
  publicKey: W.botPublicKey,
  name: 'WX-AUS',
  latitude: 30.27,
  longitude: -97.74,
  lastAdvertTimestamp: Math.floor(W.t0 / 1000) - 60,
}

async function harness({ connected = true } = {}) {
  const clock = new W.WeatherTestClock()
  const transport = await W.makeTransport()
  const service = new WeatherService({
    transport,
    store: new InMemoryWeatherStateStore(),
    now: () => clock.now,
    stationIndex: (icao) => (icao === 'KAUS' ? 202 : null),
    tables: MeshWXTables.shared,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    decode: W.fixtureDecode,
  })
  await service.startEventMonitoring()
  const defaults = new WeatherDefaults()
  const host = new FakeWeatherHost({
    weatherService: service,
    isRadioConnected: connected,
    radioSessionStartedAt: clock.now,
    contacts: [contact],
    channels: [{ index: 3, name: '#meshwx', secret: await WeatherChannel.secret() }],
    defaults,
  })
  const model = new WeatherToolModel({
    host,
    tables: MeshWXTables.shared,
    geometry: MeshWXGeometry.shared,
    locale: F.locale,
    timeZone: F.timeZone,
    now: () => clock.now,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    defaults,
  })
  await model.start()
  await clock.advance(1)
  return { clock, transport, service, host, model, defaults }
}

describe('Weather tool model over a host', () => {
  it('builds the page it is on from the host, and names the bot the contacts carry', async () => {
    const { model } = await harness()
    assert.notEqual(model.snapshot, null)
    assert.equal(model.snapshot.page.pageID, WeatherPage.myLocationID)
    assert.equal(model.sourceName, 'WX-AUS')
    // Connected, firmware fine, #meshwx present and the bot announced: nothing blocks a request.
    assert.equal(model.snapshot.requestBlock, null)
    assert.equal(model.context.channelSlot, 3)
    model.stop()
  })

  it('fires one coalesced change however many mutations a turn makes', async () => {
    const { model, clock } = await harness()
    let fired = 0
    const unsubscribe = model.subscribe(() => {
      fired += 1
    })
    model.setReportState('TX', { forPageID: WeatherPage.myLocationID })
    model.setReportState('PR', { forPageID: WeatherPage.myLocationID })
    model.beginRequest(WeatherRequest.digest)
    assert.equal(fired, 0)
    await W.flush()
    assert.equal(fired, 1)
    model.endRequest(WeatherRequest.digest)
    await W.flush()
    assert.equal(fired, 2)
    unsubscribe()
    model.endRequest(WeatherRequest.digest)
    await clock.advance(0)
    assert.equal(fired, 2)
    model.stop()
  })

  it('sends a request, logs it, and records the answer as new', async () => {
    const { model, transport, clock } = await harness()
    await model.send(WeatherRequest.digest)
    await W.flush()
    assert.equal(transport.channelSent.length, 1)
    assert.equal(transport.channelSent[0].text, '>d')
    assert.equal(model.pending.length, 1)
    assert.equal(model.requestLog.length, 1)
    assert.equal(model.requestLog[0].outcome, null)
    assert.equal(model.status({ for: WeatherRequest.digest }).kind, 'pending')

    transport.deliver(W.datagram(W.digest({ seq: 1, nowMinutes: W.t0Minutes })))
    await clock.advance(1)
    await W.flush()

    assert.equal(model.pending.length, 0)
    assert.equal(model.status({ for: WeatherRequest.digest }).kind, 'settled')
    assert.equal(model.requestLog[0].outcome, 'answered')
    // A list where there was none is not "nothing new".
    assert.deepEqual(model.answerNotes['>d'], { kind: 'changed' })
    assert.notEqual(model.announcement, null)
    model.stop()
  })

  it('an answer that changed nothing says so', async () => {
    const { model, transport, clock } = await harness()
    transport.deliver(W.datagram(W.digest({ seq: 1, nowMinutes: W.t0Minutes })))
    await clock.advance(1)
    await W.flush()

    // Past the five-minute window, so the request goes out rather than being served from the
    // channel (spec §19).
    await clock.advance(6 * 60)
    await model.send(WeatherRequest.digest)
    await W.flush()
    // The same list again: the same `now_min`, so nothing the phone holds has moved.
    transport.deliver(W.datagram(W.digest({ seq: 2, nowMinutes: W.t0Minutes })))
    await clock.advance(1)
    await W.flush()
    assert.deepEqual(model.answerNotes['>d'], { kind: 'unchanged', value: 'other' })
    model.stop()
  })

  it('a disconnected radio blocks every request and is dated once it is seen to go', async () => {
    const { model, host, clock } = await harness()
    const wentAt = clock.now
    host.change({ isRadioConnected: false })
    await clock.advance(1)
    await W.flush()
    assert.equal(model.radioDisconnectedAt, wentAt)
    assert.equal(model.snapshot.requestBlock, 'radioOffline')
    assert.deepEqual(model.status({ for: WeatherRequest.digest }), { kind: 'blocked', value: 'radioOffline' })
    model.stop()
  })

  it('stop clears every timer the visit armed', async () => {
    const { model, clock } = await harness()
    model.noteBlockedPull('nothing to ask for')
    assert.ok(clock.timers.size > 0)
    model.stop()
    // The tick, the debounce and the notice are all gone; nothing the model armed is left.
    assert.equal(clock.timers.size, 0)
  })

  it('the channel banner goes through the host, and its error is already user facing', async () => {
    const { model, host } = await harness()
    host.channelError = 'No free channel slot. Remove a channel in Chats to make room.'
    await model.addChannel()
    assert.equal(model.errorMessage, 'No free channel slot. Remove a channel in Chats to make room.')
    assert.equal(model.isAddingChannel, false)

    host.channelError = null
    model.errorMessage = null
    await model.addChannel()
    assert.equal(host.addedChannels, 1)
    assert.equal(model.errorMessage, null)
    model.stop()
  })

  // A snapshot carries `coverage`, which holds the whole `MeshWXTables` and the outlines, so
  // nothing here ever hands one to `assert.equal`/`deepEqual` against a mismatched value: the
  // failure message alone would serialise the 35,000-place bundle. Identity and small fields only.
  it('a page hands every drill-in its own build, and keeps it when the page is evicted', async () => {
    const { model, clock } = await harness()
    const screen = model.currentScreen
    assert.ok(screen != null)
    assert.equal(screen.pageID, WeatherPage.myLocationID)
    assert.equal(screen.sourceName, 'WX-AUS')
    assert.ok(screen.snapshot === model.snapshot)
    assert.ok(screen.context === model.context)
    assert.equal(screen.updateRequests.length, 0)
    assert.equal(screen.isUpdating, false)
    assert.equal(screen.placeName, null)

    // Four saved places, then a swipe to the far end of the pager: only the page on screen and
    // its two neighbours are kept, so My location's build is evicted — and the screen opened from
    // it still answers for that page (docs/MESHWX_UI.md §13).
    for (const [label, latitude] of [['A', 31], ['B', 32], ['C', 33], ['D', 34]]) {
      model.pick(WeatherSavedPlace.make({ label, latitude, longitude: -97.7, chosenAt: clock.now }))
    }
    // `remember` puts the newest first, so the pager reads: My location, D, C, B, A.
    assert.deepEqual(model.pages.map((page) => WeatherPage.label(page)), [null, 'D', 'C', 'B', 'A'])
    model.showPage(model.pages[4] && WeatherSavedPlace.id(WeatherPage.savedPlace(model.pages[4])))
    await clock.advance(1)
    assert.equal(model.build({ for: WeatherPage.myLocationID }) == null, true)
    assert.equal(screen.pageID, WeatherPage.myLocationID)
    assert.ok(screen.snapshot != null)
    assert.equal(screen.snapshot.page.pageID, WeatherPage.myLocationID)
    model.stop()
  })

  it('one Update run at a time, five seconds apart, and the caption is that page own', async () => {
    const { model, transport, clock } = await harness()
    // A reading batch and no alert list: the plan is the list, then what the bot covers.
    transport.deliver(
      W.datagram(W.observations({ seq: 1, timestampMinutes: W.t0Minutes, stations: [[202, 88]] })),
    )
    await clock.advance(1)
    await W.flush()

    const plan = model.plan({ for: WeatherPage.myLocationID })
    assert.deepEqual(WeatherUpdatePlan.items(plan), ['alerts', 'readings'])

    model.update(plan, { pageID: WeatherPage.myLocationID })
    await W.flush()
    assert.equal(model.isUpdating({ pageID: WeatherPage.myLocationID }), true)
    assert.equal(model.isUpdating({ pageID: 'at:32.777,-96.797' }), false)
    assert.equal(transport.channelSent.length, 1)
    assert.equal(transport.channelSent[0].text, '>d')
    assert.equal(model.updateStatusText({ pageID: WeatherPage.myLocationID }), 'Asking WX-AUS…')
    // A second run is refused rather than replacing the first.
    model.update(plan, { pageID: 'at:32.777,-96.797' })
    assert.equal(model.isUpdating({ pageID: 'at:32.777,-96.797' }), false)

    // The service refuses a second request inside the window, so the steps are queued (spec §19).
    await clock.advance(5)
    await W.flush()
    assert.deepEqual(transport.channelSent.map((one) => one.text), ['>d', '>o'])
    await clock.advance(30)
    await W.flush()
    assert.equal(model.isUpdating({ pageID: WeatherPage.myLocationID }), false)
    model.stop()
  })

  it('the saved list and the chosen bot survive the visit, through one synchronous store', async () => {
    const { model, defaults } = await harness()
    const town = WeatherSavedPlace.make({
      label: 'Round Rock, TX',
      latitude: 30.5,
      longitude: -97.7,
      chosenAt: W.t0,
    })
    model.pick(town)
    model.selectBot(W.botID)
    assert.deepEqual(defaults.get('weather.savedPlaces').map(WeatherSavedPlace.id), [
      WeatherSavedPlace.id(town),
    ])
    assert.equal(defaults.get('weather.preferredBotID'), W.botID)
    assert.equal(model.selectedPageID, WeatherSavedPlace.id(town))
    model.stop()
  })
})

describe('WeatherDefaults', () => {
  it('reads every key once and answers synchronously afterwards', async () => {
    const stored = new Map([['weather.preferredBotID', 7]])
    const kv = {
      get: async (key) => stored.get(key) ?? null,
      set: async (key, value) => void stored.set(key, value),
      delete: async (key) => void stored.delete(key),
    }
    const defaults = new WeatherDefaults({ kv })
    assert.equal(defaults.get('weather.preferredBotID'), null)
    await defaults.hydrate()
    assert.equal(defaults.get('weather.preferredBotID'), 7)
    defaults.set('weather.preferredBotID', 9)
    // In memory at once, on disk when it gets there.
    assert.equal(defaults.get('weather.preferredBotID'), 9)
    await defaults.flush()
    assert.equal(stored.get('weather.preferredBotID'), 9)
    defaults.set('weather.preferredBotID', null)
    await defaults.flush()
    assert.equal(stored.has('weather.preferredBotID'), false)
  })

  it('a store that will not open leaves the visit working and keeps nothing', async () => {
    const kv = { get: async () => { throw new Error('blocked') }, set: async () => {}, delete: async () => {} }
    const defaults = new WeatherDefaults({ kv })
    await defaults.hydrate()
    assert.equal(defaults.get('weather.savedPlaces'), null)
    defaults.set('weather.savedPlaces', [])
    assert.deepEqual(defaults.get('weather.savedPlaces'), [])
  })
})

describe('WeatherRequestLogStore', () => {
  it('orders what it reads and what it writes, and an unreadable blob is an empty log', () => {
    const defaults = new WeatherDefaults()
    const store = new WeatherRequestLogStore({ defaults, now: () => W.t0 })
    assert.deepEqual(store.entries, [])

    defaults.set(WeatherRequestLogStore.key, 'not a log')
    assert.deepEqual(store.entries, [])

    store.entries = [
      { id: 'a', request: WeatherRequest.digest, botID: 1, sentAt: W.t0 - 1000, outcome: null },
      { id: 'b', request: WeatherRequest.observations, botID: 1, sentAt: W.t0, outcome: 'answered' },
      // Older than the retention: dropped on the way in.
      { id: 'c', request: WeatherRequest.coverage, botID: 1, sentAt: W.t0 - 8 * 24 * 3600 * 1000, outcome: null },
    ]
    assert.deepEqual(store.entries.map((one) => one.id), ['b', 'a'])
    assert.equal(WeatherRequestLog.limit, 40)
  })
})
