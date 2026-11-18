// Port of MC1ServicesTests/Weather/WeatherAlertNotifierTests.swift (docs/PORTING.md).
//
// The alert notification rules (docs/MESHWX_UI.md §16): what reaches the user, what only
// replaces what is already there, what sounds again, and what is taken away.
//
// Nothing here touches a notification centre: the poster is a recorder, so every rule is a
// value comparison rather than a screenshot of a lock screen.
//
// The decision rules themselves live under `Screen/` in the Swift and so belong to
// `src/screen/`, which this layer may not import; they are injected, and
// `helpers/weather-alert-rules.js` is the copy these tests run against. The suites below that
// read only the gate or the placement therefore pin the **contract the notifier needs**; the
// screen engineer's own tests of those types are theirs.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MeshWXTables } from '../src/meshwx/index.js'
import { nodeBundleLoader } from '../src/meshwx/nodeLoader.js'
import { t } from '../src/l10n.js'
import {
  DefaultsWeatherAlertPostLedger,
  DefaultsWeatherAlertWatchStore,
  WeatherAlertDefaultCopy,
  WeatherAlertNotificationCopyRegistry,
  WeatherAlertNotifier,
  WeatherBotState,
  WeatherLastPositionStore,
  WeatherSavedPlacesStore,
  WeatherStateReducer,
  WeatherStoredWarning,
  identityKey,
  weatherAlertSubscriptions
} from '../src/weather/index.js'
import {
  WeatherAlertGate,
  WeatherAlertNotificationRules as Rules,
  WeatherAlertPlacement,
  WeatherSavedPlaces,
  alertRules,
  myLocationID,
  savedPlaceID,
  uncertainty
} from './helpers/weather-alert-rules.js'
import * as F from './helpers/weather-fixtures.js'

const tables = await MeshWXTables.load(nodeBundleLoader())

// MARK: - Fixtures

/** A square of about 11 km a side around 30.00, -97.00. */
const polygon = [[30.05, -97.05], [30.05, -96.95], [29.95, -96.95], [29.95, -97.05]]

/** Inside the polygon. */
const here = (watched = true) => savedPlace({
  label: 'Austin, TX', latitude: 30.0, longitude: -97.0, isWatched: watched
})
/** About 34 km west of the polygon's edge: near, never here. */
const nearby = (watched = true) => savedPlace({
  label: 'Round Rock, TX', latitude: 30.0, longitude: -97.4, isWatched: watched
})
/** Far outside: about 110 km north. */
const faraway = (watched = true) => savedPlace({
  label: 'Waco, TX', latitude: 31.0, longitude: -97.0, isWatched: watched
})

function savedPlace({ label, latitude, longitude, isWatched = false, chosenAt = F.t0 }) {
  return { label, latitude, longitude, zipCode: null, stationIndex: null, chosenAt, isWatched }
}

const eventOf = (vtec) => tables.eventByCode.get(vtec) ?? 0

/**
 * The suite's warning: no tags unless asked for, unlike the shared fixture, because the rank
 * rules read the tornado tag.
 */
function warning({
  vtec,
  etn = 42,
  expiresMinutes = F.t0Minutes + 45,
  tornado = 0,
  floodDamage = 0,
  polygon: shape = polygon,
  areas = null
} = {}) {
  return {
    ...F.warning({ seq: 1, identity: { event: eventOf(vtec), office: 35, etn }, expiresMinutes }),
    tornado,
    flood_damage: floodDamage,
    hail_qin: 0,
    wind_mph: 0,
    polygon: shape,
    areas
  }
}

/** A recorder in place of the notification centre. */
class FakePoster {
  constructor() {
    this.posted = []
    this.removed = []
    this.delivered = new Set()
    this.authorized = true
  }

  async post(notification) {
    this.posted.push(notification)
    this.delivered.add(notification.identifier)
  }

  async remove({ identifiers }) {
    this.removed.push(...identifiers)
    for (const identifier of identifiers) this.delivered.delete(identifier)
  }

  async deliveredIdentifiers() { return this.delivered }

  async isAuthorized() { return this.authorized }

  setAuthorized(value) { this.authorized = value }

  /** The user swiped it away, or opened it. */
  dismiss(identifier) { this.delivered.delete(identifier) }

  get last() { return this.posted.at(-1) ?? null }
}

/** Outlines that are not loaded until the test says so. */
class StubGeometry {
  constructor(loaded) { this.loaded = loaded }
  get isLoaded() { return this.loaded.value }
  distanceKilometres() { return 0 }
  centre() { return null }
}

const box = (value) => ({ value })

function makeHarness({ watch, geometryLoaded = box(true), loadGeometry = async () => {} }) {
  const poster = new FakePoster()
  const watchBox = box(watch)
  const ledgerBox = box({})
  const states = box({})
  const clock = new F.WeatherTestClock()
  const notifier = new WeatherAlertNotifier({
    states: async () => states.value,
    events: () => () => {},
    watchStore: { watch: () => watchBox.value },
    ledger: { posts: () => ledgerBox.value, save: (posts) => { ledgerBox.value = posts } },
    poster,
    geometry: new StubGeometry(geometryLoaded),
    loadGeometry,
    botName: async () => 'WX-AUS',
    tables,
    now: () => clock.now,
    rules: alertRules()
  })
  return { notifier, poster, watch: watchBox, ledger: ledgerBox, states, clock, geometryLoaded }
}

/** Puts a warning in the bot's state and hands the notifier the change the reducer reported. */
async function deliver(
  message, harness, { botID = F.botID, isBacklog = false, replacedExisting = false, beginsAt = null } = {}
) {
  const key = String(botID)
  const state = harness.states.value[key] ?? WeatherBotState.make({ botID })
  const identity = { event: message.event, office: message.office, etn: message.etn }
  const existing = state.warnings[identityKey(identity)]
  state.warnings[identityKey(identity)] = WeatherStoredWarning.make({
    warning: message,
    receivedAt: harness.clock.now,
    updateCount: existing == null ? 0 : existing.updateCount + 1,
    beginsAt
  })
  harness.states.value[key] = state
  await harness.notifier.apply({
    botID,
    changes: [{
      kind: 'warningStored', value: identity, replacedExisting: replacedExisting || existing != null
    }],
    isBacklog
  })
}

async function cancel(message, harness, { botID = F.botID } = {}) {
  const identity = { event: message.event, office: message.office, etn: message.etn }
  delete harness.states.value[String(botID)]?.warnings?.[identityKey(identity)]
  await harness.notifier.apply({
    botID, changes: [{ kind: 'warningRemoved', value: identity, reason: 0 }], isBacklog: false
  })
}

describe('Weather alert notifier', () => {
  // MARK: - The gate

  it('storm warnings covering the place notify with sound; watches and advisories never do', () => {
    const off = weatherAlertSubscriptions(null)
    // Ranks 0-5 are the six storm warnings, 6 every other warning, 7-9 watches, advisories and
    // statements.
    for (let rank = 0; rank <= 5; rank += 1) {
      assert.equal(
        WeatherAlertGate.delivery({ rank, placement: WeatherAlertPlacement.here, subscriptions: off }),
        'sound'
      )
    }
    assert.equal(
      WeatherAlertGate.delivery({ rank: 6, placement: WeatherAlertPlacement.here, subscriptions: off }),
      null
    )
    for (let rank = 7; rank <= 9; rank += 1) {
      assert.equal(
        WeatherAlertGate.delivery({ rank, placement: WeatherAlertPlacement.here, subscriptions: off }),
        null
      )
    }
  })

  it('the other-warnings toggle adds rank 6, silently, and nothing else', () => {
    const on = weatherAlertSubscriptions({ notifiesOtherWarnings: true })
    assert.equal(
      WeatherAlertGate.delivery({ rank: 6, placement: WeatherAlertPlacement.here, subscriptions: on }),
      'silent'
    )
    for (let rank = 7; rank <= 9; rank += 1) {
      assert.equal(
        WeatherAlertGate.delivery({ rank, placement: WeatherAlertPlacement.here, subscriptions: on }),
        null
      )
    }
    // Only where it covers: a rank-6 warning one county over is still a dashboard row.
    assert.equal(
      WeatherAlertGate.delivery({
        rank: 6,
        placement: WeatherAlertPlacement.near({ kilometres: 20, direction: 'north' }),
        subscriptions: on
      }),
      null
    )
  })

  it('nearby is the tornado toggle\'s alone, and only for tornado and extreme wind', () => {
    const near = WeatherAlertPlacement.near({ kilometres: 20, direction: 'north' })
    const off = weatherAlertSubscriptions(null)
    const on = weatherAlertSubscriptions({ notifiesTornadoNearby: true })
    assert.equal(WeatherAlertGate.delivery({ rank: 0, placement: near, subscriptions: off }), null)
    assert.equal(WeatherAlertGate.delivery({ rank: 0, placement: near, subscriptions: on }), 'sound')
    assert.equal(WeatherAlertGate.delivery({ rank: 1, placement: near, subscriptions: on }), 'sound')
    for (let rank = 2; rank <= 9; rank += 1) {
      assert.equal(WeatherAlertGate.delivery({ rank, placement: near, subscriptions: on }), null)
    }
  })

  it('a place the phone cannot place is never read as here', () => {
    const all = weatherAlertSubscriptions({ notifiesOtherWarnings: true, notifiesTornadoNearby: true })
    for (const placement of [
      WeatherAlertPlacement.checking, WeatherAlertPlacement.unplaced, WeatherAlertPlacement.elsewhere
    ]) {
      for (let rank = 0; rank <= 9; rank += 1) {
        assert.equal(WeatherAlertGate.delivery({ rank, placement, subscriptions: all }), null)
      }
    }
  })

  // MARK: - Opt-in

  it('with no bell on, a tornado warning covering a saved place notifies nothing', async () => {
    const h = makeHarness({
      watch: { places: [], myLocation: null, subscriptions: weatherAlertSubscriptions(null) }
    })
    await deliver(warning({ vtec: 'TO.W', tornado: 2 }), h)
    assert.deepStrictEqual(h.poster.posted, [])
    assert.deepStrictEqual(h.ledger.value, {})
  })

  it('a saved place that is merely saved is not watched', async () => {
    const defaults = memoryDefaults()
    new WeatherSavedPlacesStore({ defaults, places: WeatherSavedPlaces }).places = [here(false)]
    const store = new DefaultsWeatherAlertWatchStore({ defaults, places: WeatherSavedPlaces })
    assert.deepStrictEqual(store.watch().places, [])

    const h = makeHarness({ watch: store.watch() })
    await deliver(warning({ vtec: 'TO.W' }), h)
    assert.deepStrictEqual(h.poster.posted, [])
  })

  // MARK: - Posting

  it('a tornado warning covering a watched place is posted with sound, named and timed', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'TO.W', tornado: 2 }), h)

    const posted = h.poster.last
    assert.notEqual(posted, null)
    assert.equal(posted.sound, true)
    assert.equal(posted.content.title, 'Tornado Warning')
    assert.equal(posted.content.subtitle, t('weather.alerts.source', 'WX-AUS'))
    assert.ok(posted.content.body.startsWith('Austin · until '))
    assert.ok(posted.content.body.endsWith(
      `· ${t('weather.tag.tornado', t('weather.tornadoTag.radarIndicated'))}`
    ))
    assert.ok(posted.identifier.startsWith('wx-4C7A-TO.W.EWX.42@'))
    assert.equal(posted.threadIdentifier, Rules.threadIdentifier({ placeID: savedPlaceID(here()) }))
    assert.equal(Object.keys(h.ledger.value).length, 1)
  })

  // Revision 12: a warning that has not started says so, from its start until its end, and a
  // notification never counts down (docs/MESHWX_UI.md §3.1 U-49).
  it('a warning that has not started is posted from its start until its end', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(
      warning({ vtec: 'TO.W', expiresMinutes: F.t0Minutes + 4896, tornado: 2 }), h,
      { beginsAt: (F.t0Minutes + 2016) * 60_000 }
    )
    const posted = h.poster.last
    assert.notEqual(posted, null)
    assert.ok(posted.content.body.startsWith('Austin · from '), posted.content.body)
    assert.ok(posted.content.body.includes(' until '), posted.content.body)
    assert.ok(!posted.content.body.includes('left'), posted.content.body)
  })

  // The fallback's words, on fixed clocks: the app's `alertWindow` without the countdown.
  it('the fallback names a start and an end the way the app does', () => {
    // Tuesday 29 September 2026, 09:24 in Austin: the Flood Watch of the owner's report.
    const now = 1_790_691_840 * 1000
    const begins = now + 2016 * 60_000 // Wednesday 19:00
    const expires = now + 4896 * 60_000 // Friday 19:00
    for (const [locale, want] of [
      ['en-GB', ['from Wed 19:00 until Fri 19:00', 'until Fri 19:00', 'until 19:00']],
      ['en-US', ['from Wed 7:00 PM until Fri 7:00 PM', 'until Fri 7:00 PM', 'until 7:00 PM']]
    ]) {
      const window = (moment) => WeatherAlertDefaultCopy.window({
        beginsAt: begins, expiresAt: expires, now: moment, timeZone: 'America/Chicago', locale
      }).replace(/\u202f/g, ' ')
      assert.equal(window(now), want[0], `${locale}, Tuesday morning`)
      assert.equal(window(begins), want[1], `${locale}, Wednesday 19:00`)
      assert.equal(window(expires - 12 * 3_600_000), want[2], `${locale}, Friday 07:00`)
    }
  })

  it('a warning that covers one watched place and not another posts once, for that one', async () => {
    const h = makeHarness({ watch: watchOf([here(), faraway()]) })
    await deliver(warning({ vtec: 'SV.W' }), h)
    assert.equal(h.poster.posted.length, 1)
    assert.equal(h.poster.posted[0].placeID, savedPlaceID(here()))
  })

  it('two places under the same warning each get their own notification, threaded apart', async () => {
    const wide = [[30.4, -97.6], [30.4, -96.8], [29.8, -96.8], [29.8, -97.6]]
    const h = makeHarness({ watch: watchOf([here(), nearby()]) })
    await deliver(warning({ vtec: 'SV.W', polygon: wide }), h)
    assert.equal(h.poster.posted.length, 2)
    assert.equal(new Set(h.poster.posted.map((entry) => entry.threadIdentifier)).size, 2)
  })

  it('a rank-6 warning arrives only with its toggle, and without a sound', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'FL.W' }), h)
    assert.deepStrictEqual(h.poster.posted, [])

    h.watch.value = watchOf([here()], { notifiesOtherWarnings: true })
    await deliver(warning({ vtec: 'FL.W', etn: 43 }), h)
    assert.equal(h.poster.posted.length, 1)
    assert.equal(h.poster.posted[0].sound, false)
  })

  // Not in the Swift's tests, but its rule: the subject carries the stored start, and when the
  // copy being notified came from a bot that said nothing about one, another bot's start stands
  // in — a bot older than revision 12 saying nothing is not a bot saying the warning has begun.
  it('the subject carries the stored start, or another bot\'s', async () => {
    const seen = []
    WeatherAlertNotificationCopyRegistry.install({
      get myLocationLabel() { return WeatherAlertDefaultCopy.myLocationLabel },
      content(subject, options) {
        seen.push(subject)
        return WeatherAlertDefaultCopy.content(subject, options)
      }
    })
    try {
      const h = makeHarness({ watch: watchOf([here()], { notifiesOtherWarnings: true }) })
      const beginsAt = F.t0 + 600 * 60_000
      await deliver(warning({ vtec: 'FL.W', expiresMinutes: F.t0Minutes + 3000 }), h, { beginsAt })
      assert.equal(h.poster.posted.length, 1)
      assert.equal(seen.at(-1).beginsAt, beginsAt)

      await deliver(warning({ vtec: 'FL.W', etn: 43 }), h)
      assert.equal(seen.at(-1).beginsAt, null, 'in effect from issuance')

      // The same flood warning from a second bot that says nothing about its start.
      const other = makeHarness({ watch: watchOf([here()], { notifiesOtherWarnings: true }) })
      const river = warning({ vtec: 'FL.W', etn: 44, expiresMinutes: F.t0Minutes + 3000 })
      other.states.value[String(F.botID + 1)] = WeatherBotState.make({ botID: F.botID + 1 })
      other.states.value[String(F.botID + 1)].warnings[identityKey(river)] = WeatherStoredWarning.make({
        warning: river, receivedAt: other.clock.now, beginsAt
      })
      await deliver(river, other)
      assert.equal(other.poster.posted.length, 1)
      assert.equal(seen.at(-1).beginsAt, beginsAt, "the other bot's start stands in")
    } finally {
      WeatherAlertNotificationCopyRegistry.install(null)
    }
  })

  it('a tornado warning nearby arrives only with its toggle, and says how far', async () => {
    const h = makeHarness({ watch: watchOf([nearby()]) })
    await deliver(warning({ vtec: 'TO.W', tornado: 3 }), h)
    assert.deepStrictEqual(h.poster.posted, [])

    h.watch.value = watchOf([nearby()], { notifiesTornadoNearby: true })
    await deliver(warning({ vtec: 'TO.W', etn: 43, tornado: 3 }), h)
    const posted = h.poster.last
    assert.notEqual(posted, null)
    assert.equal(posted.sound, true)
    assert.ok(posted.content.body.includes('of Round Rock'))
    assert.ok(posted.content.body.includes('km'))
  })

  it('a watch covering the place stays on the dashboard', async () => {
    const h = makeHarness({
      watch: watchOf([here()], { notifiesOtherWarnings: true, notifiesTornadoNearby: true })
    })
    await deliver(warning({ vtec: 'TO.A' }), h)
    await deliver(warning({ vtec: 'SV.A', etn: 43 }), h)
    assert.deepStrictEqual(h.poster.posted, [])
  })

  // MARK: - Repeats, updates and escalations

  it('a repeat replaces the notification silently, under the same identifier', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'SV.W' }), h)
    await h.clock.advance(5 * 60)
    await deliver(warning({ vtec: 'SV.W' }), h, { replacedExisting: true })

    assert.equal(h.poster.posted.length, 2)
    assert.equal(h.poster.posted[0].identifier, h.poster.posted[1].identifier)
    assert.equal(h.poster.posted[0].sound, true)
    assert.equal(h.poster.posted[1].sound, false)
  })

  it('a repeat of a notification the user has dismissed is not put back', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'SV.W' }), h)
    h.poster.dismiss(h.poster.posted[0].identifier)
    await h.clock.advance(5 * 60)
    await deliver(warning({ vtec: 'SV.W' }), h, { replacedExisting: true })
    assert.equal(h.poster.posted.length, 1)
  })

  it('a rising tornado tag sounds again, dismissed or not', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'SV.W', tornado: 1 }), h)
    h.poster.dismiss(h.poster.posted[0].identifier)
    await h.clock.advance(60)
    await deliver(warning({ vtec: 'SV.W', tornado: 2 }), h, { replacedExisting: true })

    assert.equal(h.poster.posted.length, 2)
    assert.equal(h.poster.posted[1].sound, true)
  })

  it('flood damage reaching catastrophic sounds again', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'FF.W', floodDamage: 1 }), h)
    await h.clock.advance(60)
    await deliver(warning({ vtec: 'FF.W', floodDamage: 2 }), h, { replacedExisting: true })
    assert.equal(h.poster.last.sound, true)
  })

  it('an extension sounds again only once the last sounding post is 20 minutes old', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'SV.W' }), h)

    await h.clock.advance(10 * 60)
    await deliver(
      warning({ vtec: 'SV.W', expiresMinutes: F.t0Minutes + 90 }), h, { replacedExisting: true }
    )
    assert.equal(h.poster.last.sound, false)

    await h.clock.advance(15 * 60)
    await deliver(
      warning({ vtec: 'SV.W', expiresMinutes: F.t0Minutes + 150 }), h, { replacedExisting: true }
    )
    assert.equal(h.poster.last.sound, true)
  })

  it('a warning that grows to cover the place sounds, after saying it was nearby', async () => {
    const wide = [[30.4, -97.6], [30.4, -96.8], [29.8, -96.8], [29.8, -97.6]]
    const h = makeHarness({ watch: watchOf([nearby()], { notifiesTornadoNearby: true }) })
    await deliver(warning({ vtec: 'TO.W' }), h)
    const identifier = h.poster.posted[0].identifier
    h.poster.dismiss(identifier)
    await h.clock.advance(60)
    await deliver(warning({ vtec: 'TO.W', polygon: wide }), h, { replacedExisting: true })

    assert.equal(h.poster.posted.length, 2)
    assert.equal(h.poster.posted[1].sound, true)
    assert.equal(h.poster.posted[1].identifier, identifier)
    assert.ok(h.poster.posted[1].content.body.startsWith('Round Rock · until '))
  })

  it('an update that no longer covers the place takes its notification away', async () => {
    const elsewhere = [[31.05, -97.05], [31.05, -96.95], [30.95, -96.95], [30.95, -97.05]]
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'SV.W' }), h)
    const identifier = h.poster.posted[0].identifier
    await h.clock.advance(60)
    await deliver(warning({ vtec: 'SV.W', polygon: elsewhere }), h, { replacedExisting: true })

    assert.deepStrictEqual(h.poster.removed, [identifier])
    assert.deepStrictEqual(h.ledger.value, {})
  })

  // MARK: - Endings

  it('a cancellation removes the delivered notification and posts no all-clear', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    const message = warning({ vtec: 'SV.W' })
    await deliver(message, h)
    const identifier = h.poster.posted[0].identifier
    await cancel(message, h)

    assert.deepStrictEqual(h.poster.removed, [identifier])
    assert.equal(h.poster.posted.length, 1)
    assert.deepStrictEqual(h.ledger.value, {})
  })

  it('a warning a list drops is removed too', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    const message = warning({ vtec: 'SV.W' })
    await deliver(message, h)
    const identity = { event: message.event, office: message.office, etn: message.etn }
    delete h.states.value[String(F.botID)].warnings[identityKey(identity)]
    await h.notifier.apply({
      botID: F.botID,
      changes: [{ kind: 'digestApplied', missing: [], removed: [identity] }],
      isBacklog: false
    })
    assert.equal(h.poster.removed.length, 1)
  })

  // Spec §5, 17 October 2026, end to end through the reducer: WX-AUS answered somebody's
  // `>w TXC201` for a watched Houston place, and its next digest — which lists only its own area —
  // used to end the warning and take the notification down with it.
  it("a list from a bot whose area does not reach the warning leaves its notification standing", async () => {
    const houston = savedPlace({ label: 'Houston, TX', latitude: 29.76, longitude: -95.37, isWatched: true })
    const h = makeHarness({ watch: watchOf([houston]) })
    const square = [[29.81, -95.42], [29.81, -95.32], [29.71, -95.32], [29.71, -95.42]]
    const message = { ...warning({ vtec: 'SV.W', polygon: square }), office: 51 }
    let state = WeatherStateReducer.apply(F.coverage({ seq: 1 }), { to: WeatherBotState.make({ botID: F.botID }), receivedAt: h.clock.now }).state
    state = WeatherStateReducer.apply(message, { to: state, receivedAt: h.clock.now }).state
    h.states.value[String(F.botID)] = state
    await h.notifier.apply({
      botID: F.botID,
      changes: [{ kind: 'warningStored', value: { event: message.event, office: 51, etn: message.etn }, replacedExisting: false }],
      isBacklog: false
    })
    assert.equal(h.poster.posted.length, 1)

    await h.clock.advance(10 * 60)
    const applied = WeatherStateReducer.apply(
      F.digest({ seq: 3, nowMinutes: F.t0Minutes + 10, entries: [] }), { to: state, receivedAt: h.clock.now }
    )
    h.states.value[String(F.botID)] = applied.state
    await h.notifier.apply({ botID: F.botID, changes: applied.changes, isBacklog: false })
    assert.deepStrictEqual(h.poster.removed, [])
  })

  it("one bot's list leaves a notification another bot's copy still holds", async () => {
    const otherBot = 0x1234
    const h = makeHarness({ watch: watchOf([here()]) })
    const message = warning({ vtec: 'SV.W' })
    await deliver(message, h)
    await deliver(message, h, { botID: otherBot })
    const identity = { event: message.event, office: message.office, etn: message.etn }
    const dropped = async (botID) => {
      delete h.states.value[String(botID)].warnings[identityKey(identity)]
      await h.notifier.apply({
        botID, changes: [{ kind: 'digestApplied', missing: [], removed: [identity] }], isBacklog: false
      })
    }
    await dropped(F.botID)
    assert.deepStrictEqual(h.poster.removed, [], 'the other bot still holds it')
    await dropped(otherBot)
    assert.equal(h.poster.removed.length, 1, 'no bot holds it now')
  })

  it('a warning only listed in the digest, never received, notifies nothing', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await h.notifier.apply({
      botID: F.botID,
      changes: [{ kind: 'digestApplied', missing: [F.svw42], removed: [] }],
      isBacklog: false
    })
    assert.deepStrictEqual(h.poster.posted, [])
  })

  it('an expired warning is never posted, and nothing is scheduled for an expiry', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'TO.W', expiresMinutes: F.t0Minutes - 1 }), h)
    assert.deepStrictEqual(h.poster.posted, [])
  })

  // MARK: - Backlog

  it("a storm warning drained from the radio's queue says it arrived late", async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(warning({ vtec: 'TO.W', tornado: 2 }), h, { isBacklog: true })
    const posted = h.poster.last
    assert.notEqual(posted, null)
    assert.equal(posted.sound, true)
    assert.ok(posted.content.body.endsWith(t('weather.notifications.late')))
  })

  it('a backlog warning that has already expired notifies nothing', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    await deliver(
      warning({ vtec: 'TO.W', expiresMinutes: F.t0Minutes - 10 }), h, { isBacklog: true }
    )
    assert.deepStrictEqual(h.poster.posted, [])
  })

  it('a backlog warning below the storm ranks notifies nothing, toggle or not', async () => {
    const h = makeHarness({ watch: watchOf([here()], { notifiesOtherWarnings: true }) })
    await deliver(warning({ vtec: 'FL.W' }), h, { isBacklog: true })
    assert.deepStrictEqual(h.poster.posted, [])
  })

  // MARK: - My location

  it('my location is matched against the stored position, however old it is', async () => {
    // Three hours old: still the last position the app knows, and the only one it has.
    const position = {
      latitude: 30.0, longitude: -97.0, horizontalAccuracy: 50, timestamp: F.t0 - 3 * 3_600_000
    }
    const h = makeHarness({
      watch: {
        places: [],
        myLocation: position,
        subscriptions: weatherAlertSubscriptions({ watchesMyLocation: true })
      }
    })
    await deliver(warning({ vtec: 'TO.W' }), h)

    const posted = h.poster.last
    assert.notEqual(posted, null)
    assert.equal(posted.placeID, myLocationID)
    assert.equal(posted.sound, true)
  })

  it('with my location watched and no position held, nothing is matched against nowhere', async () => {
    const h = makeHarness({
      watch: {
        places: [],
        myLocation: null,
        subscriptions: weatherAlertSubscriptions({ watchesMyLocation: true })
      }
    })
    await deliver(warning({ vtec: 'TO.W' }), h)
    assert.deepStrictEqual(h.poster.posted, [])
  })

  it('an old position is matched with the uncertainty its age has earned', () => {
    const fresh = uncertainty({ accuracyMetres: 50, age: 60 })
    const old = uncertainty({ accuracyMetres: 50, age: 3 * 3600 })
    assert.ok(fresh < 1)
    assert.equal(old, 25.5)
  })

  // MARK: - Two bots

  it('two bots holding one warning post one notification, not two', async () => {
    const otherBot = 0x1234
    const h = makeHarness({ watch: watchOf([here()]) })
    const message = warning({ vtec: 'SV.W' })
    await deliver(message, h)
    await h.clock.advance(60)
    await deliver(message, h, { botID: otherBot })

    assert.equal(h.poster.posted.length, 2)
    assert.equal(new Set(h.poster.posted.map((entry) => entry.identifier)).size, 1)
    assert.equal(h.poster.posted[1].sound, false)
  })

  // MARK: - Outlines

  it('a warning with no polygon waits for the outlines rather than being called not here', async () => {
    const loaded = box(false)
    const h = makeHarness({
      watch: watchOf([here()]),
      geometryLoaded: loaded,
      loadGeometry: async () => { loaded.value = true }
    })
    // The area run is what a zone-coded warning carries; with no outlines it can only be
    // "checking", which notifies nothing until they load.
    await deliver(
      warning({
        vtec: 'TO.W', polygon: null, areas: [{ state: 42, county: true, start: 453, run: 1 }]
      }),
      h
    )
    assert.deepStrictEqual(h.poster.posted, [])

    // The load runs in its own task; the retry follows it.
    await h.notifier.queue
    await F.flush()
    assert.equal(h.poster.posted.length, 1)
    assert.equal(loaded.value, true)
  })

  it('an update the phone cannot place yet leaves the notification standing', async () => {
    const loaded = box(true)
    const h = makeHarness({ watch: watchOf([here()]), geometryLoaded: loaded })
    await deliver(warning({ vtec: 'TO.W' }), h)
    assert.equal(h.poster.posted.length, 1)

    // The update carries areas instead of a polygon and the outlines have gone away: "checking"
    // is not "not here", so nothing is taken down and nothing is posted again.
    loaded.value = false
    await h.clock.advance(60)
    await deliver(
      warning({
        vtec: 'TO.W', polygon: null, areas: [{ state: 42, county: true, start: 453, run: 1 }]
      }),
      h,
      { replacedExisting: true }
    )
    await h.notifier.queue
    await F.flush()
    assert.deepStrictEqual(h.poster.removed, [])
    assert.equal(h.poster.posted.length, 1)
  })

  // MARK: - Permission

  it('with notifications denied, nothing is posted and nothing is recorded as posted', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    h.poster.setAuthorized(false)
    await deliver(warning({ vtec: 'TO.W' }), h)
    assert.deepStrictEqual(h.poster.posted, [])
    assert.deepStrictEqual(h.ledger.value, {})
  })

  // MARK: - Persistence

  it('what was posted survives a relaunch, so a repeat is still silent', async () => {
    const h = makeHarness({ watch: watchOf([here()]) })
    const message = warning({ vtec: 'SV.W' })
    await deliver(message, h)
    assert.equal(Object.keys(h.ledger.value).length, 1)

    // A second notifier over the same ledger and the same state: the phone was relaunched.
    const poster = new FakePoster()
    const identifier = h.poster.posted[0].identifier
    await poster.post(h.poster.posted[0])
    const reborn = new WeatherAlertNotifier({
      states: async () => h.states.value,
      events: () => () => {},
      watchStore: { watch: () => h.watch.value },
      ledger: { posts: () => h.ledger.value, save: (posts) => { h.ledger.value = posts } },
      poster,
      geometry: new StubGeometry(h.geometryLoaded),
      botName: async () => 'WX-AUS',
      tables,
      now: () => h.clock.now,
      rules: alertRules()
    })
    await h.clock.advance(5 * 60)
    const identity = { event: message.event, office: message.office, etn: message.etn }
    h.states.value[String(F.botID)].warnings[identityKey(identity)] = WeatherStoredWarning.make({
      warning: message, receivedAt: h.clock.now, updateCount: 1
    })
    await reborn.apply({
      botID: F.botID,
      changes: [{ kind: 'warningStored', value: identity, replacedExisting: true }],
      isBacklog: false
    })

    assert.equal(poster.posted.length, 2)
    assert.equal(poster.posted[1].identifier, identifier)
    assert.equal(poster.posted[1].sound, false)
  })
})

// The saved list's own rules for bells (docs/MESHWX_UI.md §5, §16), as far as the stores this
// layer owns reach.
describe('Weather watched places', () => {
  it('the subscriptions a phone has never touched are all off', () => {
    const decoded = weatherAlertSubscriptions({})
    assert.equal(decoded.watchesMyLocation, false)
    assert.equal(decoded.notifiesOtherWarnings, false)
    assert.equal(decoded.notifiesTornadoNearby, false)
  })

  it('bells and toggles come back from the store they were written to', () => {
    const defaults = memoryDefaults()
    const places = new WeatherSavedPlacesStore({ defaults, places: WeatherSavedPlaces })
    places.places = [
      savedPlace({ label: 'Austin, TX', latitude: 30.1, longitude: -97, chosenAt: 100_000, isWatched: true }),
      savedPlace({ label: 'Waco, TX', latitude: 30.05, longitude: -97, chosenAt: 50_000 })
    ]
    const store = new DefaultsWeatherAlertWatchStore({ defaults, places: WeatherSavedPlaces })
    store.subscriptions = { watchesMyLocation: true, notifiesOtherWarnings: true }
    new WeatherLastPositionStore({ defaults }).position = {
      latitude: 30, longitude: -97, horizontalAccuracy: 20, timestamp: 100_000
    }

    const watch = store.watch()
    assert.deepStrictEqual(watch.places.map((place) => place.label), ['Austin, TX'])
    assert.equal(watch.subscriptions.notifiesOtherWarnings, true)
    assert.equal(watch.myLocation.latitude, 30)

    // Turning My location off deletes the position with it.
    store.subscriptions = { notifiesOtherWarnings: true }
    assert.equal(store.watch().myLocation, null)
    assert.equal(new WeatherLastPositionStore({ defaults }).position, null)
  })

  it('the ledger keeps what it was handed and forgets a post six hours past its expiry', () => {
    const defaults = memoryDefaults()
    const ledger = new DefaultsWeatherAlertPostLedger({ defaults })
    assert.deepStrictEqual(ledger.posts(), {})
    const post = Rules.record({
      identifier: 'wx-4C7A-SV.W.EWX.42@at:30.000,-97.000',
      warning: warning({ vtec: 'SV.W' }),
      placeID: 'at:30.000,-97.000',
      botID: F.botID,
      coversPlace: true,
      sound: true,
      posted: null,
      now: F.t0
    })
    ledger.save({ [post.identifier]: post })
    assert.deepStrictEqual(ledger.posts(), { [post.identifier]: post })
    assert.deepStrictEqual(Rules.pruned(ledger.posts(), { now: F.t0 }), { [post.identifier]: post })
    assert.deepStrictEqual(
      Rules.pruned(ledger.posts(), { now: F.t0 + 7 * 3_600_000 }), {}
    )
  })
})

// Not in the Swift, where `Screen/` is the same module. Here the notifier takes its decision
// rules as an injected object because `weather` may not import `screen`, so one test wires the
// real `src/screen/` exports in and checks the whole sentence comes out — proof that the
// stand-in above is describing the same contract.
describe('Weather alert notifier over the screen layer', () => {
  it('the screen rules drop straight into the notifier', async () => {
    const S = await import('../src/screen/index.js')
    const saved = S.WeatherSavedPlace.make({
      label: 'Austin, TX', latitude: 30.0, longitude: -97.0, chosenAt: F.t0, isWatched: true
    })
    const message = warning({ vtec: 'TO.W', tornado: 2 })
    const identity = { event: message.event, office: message.office, etn: message.etn }
    const state = WeatherBotState.make({ botID: F.botID })
    state.warnings[identityKey(identity)] = WeatherStoredWarning.make({
      warning: message, receivedAt: F.t0
    })

    const poster = new FakePoster()
    let ledger = {}
    const notifier = new WeatherAlertNotifier({
      states: async () => ({ [String(F.botID)]: state }),
      events: () => () => {},
      watchStore: {
        watch: () => S.WeatherAlertWatch.make({
          places: [saved], subscriptions: weatherAlertSubscriptions(null)
        })
      },
      ledger: { posts: () => ledger, save: (posts) => { ledger = posts } },
      poster,
      geometry: new StubGeometry(box(true)),
      botName: async () => 'WX-AUS',
      tables,
      now: () => F.t0,
      rules: {
        placement: S.WeatherAlertPlacement.place,
        rank: S.WeatherAlertPriority.rank,
        delivery: S.WeatherAlertGate.delivery,
        identifier: S.WeatherAlertNotificationRules.identifier,
        threadIdentifier: S.WeatherAlertNotificationRules.threadIdentifier,
        decide: S.WeatherAlertNotificationRules.decide,
        record: S.WeatherAlertNotificationRules.record,
        pruned: S.WeatherAlertNotificationRules.pruned,
        watchedPlace: S.WeatherWatchedPlace.make,
        myLocationPlace: S.WeatherWatchedPlace.myLocation,
        placeLabel: S.WeatherNames.placeLabel
      }
    })

    await notifier.apply({
      botID: F.botID,
      changes: [{ kind: 'warningStored', value: identity, replacedExisting: false }],
      isBacklog: false
    })

    assert.equal(poster.posted.length, 1)
    const posted = poster.posted[0]
    assert.equal(posted.identifier, 'wx-4C7A-TO.W.EWX.42@at:30.000,-97.000')
    assert.equal(posted.threadIdentifier, 'wx-place-at:30.000,-97.000')
    assert.equal(posted.sound, true)
    assert.equal(posted.content.title, 'Tornado Warning')
    assert.equal(posted.content.subtitle, t('weather.alerts.source', 'WX-AUS'))
    assert.ok(posted.content.body.startsWith('Austin · until '))
    assert.deepStrictEqual(Object.keys(ledger), [posted.identifier])
  })
})

// Two types this layer owns that the Swift suites do not reach: the saved list's refusal rule,
// which the Swift exercises from `Screen/WeatherUpdatePlanTests` (the screen engineer's file),
// and the notification tap, which has no Swift test at all.
describe('Weather saved places and the notification tap', () => {
  it('a write that would drop a place nobody asked to drop is refused outright', () => {
    const defaults = memoryDefaults()
    const austin = savedPlace({ label: 'Austin, TX', latitude: 30.1, longitude: -97, chosenAt: 100_000 })
    const waco = savedPlace({ label: 'Waco, TX', latitude: 31.0, longitude: -97, chosenAt: 50_000 })
    const store = new WeatherSavedPlacesStore({ defaults, places: WeatherSavedPlaces })
    store.places = [austin, waco]

    // A screen writing back a list it loaded a second ago, or before the model had started: on a
    // real phone this deleted four saved places (docs/MESHWX_UI.md §3.1 U-1).
    const stale = new WeatherSavedPlacesStore({
      defaults,
      places: { ...WeatherSavedPlaces, apply: () => [] }
    })
    assert.deepStrictEqual(
      stale.apply({ kind: 'watch', value: true, id: savedPlaceID(austin) }).map((p) => p.label),
      ['Austin, TX', 'Waco, TX']
    )
    assert.equal(store.places.length, 2, 'and nothing was written')

    // Only a remove may take a row out.
    assert.deepStrictEqual(
      store.apply({ kind: 'remove', id: savedPlaceID(waco) }).map((place) => place.label),
      ['Austin, TX']
    )
    // A bell adds no row, so the list keeps its length.
    assert.equal(store.apply({ kind: 'watch', value: true, id: savedPlaceID(austin) }).length, 1)
    assert.deepStrictEqual(store.watched.map((place) => place.label), ['Austin, TX'])
  })

  it('a tapped notification is read back once, and only while it is recent', async () => {
    const { WeatherAlertNotification, WeatherAlertNotificationTap } =
      await import('../src/weather/index.js')
    const tap = new WeatherAlertNotificationTap()
    const notification = WeatherAlertNotification.make({
      identifier: 'wx-4C7A-SV.W.EWX.42@at:30.000,-97.000',
      threadIdentifier: 'wx-place-at:30.000,-97.000',
      content: { title: 't', subtitle: 's', body: 'b' },
      sound: true,
      identity: F.svw42,
      botID: F.botID,
      placeID: 'at:30.000,-97.000'
    })

    tap.receive({ userInfo: { type: 'somethingElse' }, at: F.t0 })
    assert.equal(tap.pending, null)

    tap.receive({ userInfo: WeatherAlertNotification.userInfo(notification), at: F.t0 })
    assert.deepStrictEqual(tap.pending.identity, F.svw42)
    assert.equal(tap.pending.botID, F.botID)
    assert.equal(tap.pending.placeID, 'at:30.000,-97.000')

    // A tap opens one screen, once.
    assert.deepStrictEqual(tap.take({ now: F.t0 + 1000 }).identity, F.svw42)
    assert.equal(tap.take({ now: F.t0 + 1000 }), null)

    // And only while it is recent: ten minutes is the ceiling.
    tap.receive({ userInfo: WeatherAlertNotification.userInfo(notification), at: F.t0 })
    assert.equal(tap.take({ now: F.t0 + 11 * 60_000 }), null)
  })
})

function watchOf(places, subscriptions = null) {
  return { places, myLocation: null, subscriptions: weatherAlertSubscriptions(subscriptions) }
}

/** The synchronous key-value store `WeatherSavedPlacesStore` and the watch store take. */
function memoryDefaults() {
  const rows = new Map()
  return {
    get(key) { return rows.has(key) ? JSON.parse(rows.get(key)) : null },
    set(key, value) {
      if (value == null) rows.delete(key)
      else rows.set(key, JSON.stringify(value))
    }
  }
}
