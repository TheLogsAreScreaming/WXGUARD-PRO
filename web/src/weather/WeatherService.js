// Port of MC1Services/Services/Weather/WeatherService.swift (docs/PORTING.md).
//
// `SessionWeatherTransport` is not here: it is the radio implementation of the transport, and
// `src/link/` holds those (PORTING.md §9). This file holds the protocol's contract, the link
// value, the error, and the service.

import {
  MeshWXAreaRun, MeshWXEncoder, MeshWXGeo, MeshWXRadar, MeshWXRadarTile, MeshWXTables, MeshWXWire,
  decode as decodeMessage
} from '../meshwx/index.js'
import { WeatherBot } from './WeatherBot.js'
import { WeatherChannel } from './WeatherChannel.js'
import {
  WeatherEvent,
  WeatherPendingRequest,
  WeatherRequestError,
  WeatherRequestOutcome,
  WeatherRequestTransportKind,
  WeatherSessionInfo
} from './WeatherEvent.js'
import { WeatherRequest } from './WeatherRequest.js'
import {
  UNASKED_FORECAST_KEY,
  WeatherBotState,
  WeatherStoredForecast,
  WeatherTextAssembly,
  dateFromUnixMinutes,
  identityKey
} from './WeatherBotState.js'
import { WeatherStateReducer } from './WeatherStateReducer.js'
import { WeatherTextMatch, identityFromString } from './WeatherTextMatch.js'
import { WeatherTrafficEntry, WeatherTrafficLog } from './WeatherTrafficLog.js'

// MARK: - Transport

/**
 * A link a transport provides *of its own*, for a transport that is not a radio.
 *
 * Over Bluetooth there is none: whether weather can be asked for follows the radio, which is
 * the app's business and not the transport's. The bot bridge is the other case — a connection
 * straight to one real bot, with no radio anywhere — and it says so here, naming the bot it
 * speaks for: the tool then treats the radio as connected and that bot as announced, though no
 * advert of its ever reached this phone.
 */
export const WeatherTransportLink = Object.freeze({
  /** The transport has a live link to this bot. */
  up({ bot }) { return { kind: 'up', bot } },

  /** The bot the link speaks for. */
  bot(link) { return link.bot },

  /**
   * `bots` with this link's bot added, unless one of them already carries its id: a real
   * contact for the same bot stays the one the screen uses, advert position and all.
   */
  announcing(link, bots) {
    const id = WeatherBot.botID(link.bot)
    return bots.some((bot) => WeatherBot.botID(bot) === id) ? bots : [...bots, link.bot]
  }
})

/**
 * Why a request could not go out on the channel, so the service can fall back to the DM.
 *
 * Not a failure the user is told about: a radio that cannot flood a datagram can still send
 * the DM of spec §14, and the fallback is silent (docs/MESHWX.md, "Requests").
 *
 * `kind` is `'channelRequestsUnavailable'`: this radio cannot put a Request datagram on
 * `#meshwx` — firmware older than the command (v1.15.0), no slot carrying the channel, or no
 * public key of its own to name a sender by. `reason` is for the log, never for the screen.
 */
export class WeatherTransportError extends Error {
  constructor(kind, reason) {
    super(`${kind}(${reason})`)
    this.name = 'WeatherTransportError'
    this.kind = kind
    this.reason = reason
  }

  static channelRequestsUnavailable(reason) {
    return new WeatherTransportError('channelRequestsUnavailable', reason)
  }
}

/**
 * What the weather service needs from a radio: channel datagrams in both directions, a DM going
 * out, and a way to tell which slot is `#meshwx`. Narrow on purpose so tests can drive the
 * service with a fake. Duck-typed — `src/link/` holds the implementations:
 *
 *   subscribeDatagrams(fn) -> unsubscribe
 *       `fn` receives a `ChannelDatagram`: `{ channelIndex, pathLength, dataType, data, snr }`,
 *       `data` a `Uint8Array`. Replaces the Swift `datagramEvents()` stream; every event kind
 *       other than a channel datagram is the transport's to filter out.
 *   subscribeAcknowledgements(fn) -> unsubscribe
 *       `fn` receives one delivery-confirmation code as a `Uint8Array`: the recipient's radio
 *       received a DM this radio sent.
 *   async sendRequest({ to, text, timestamp, attempt }) -> Uint8Array
 *       A plain-text DM to a public key with `timestamp` (ms) and `attempt` on the wire as
 *       given, returning the ACK code the radio expects back for this transmission. A resend
 *       passes the first send's timestamp with the next attempt.
 *   async sendChannelRequest({ text, botID, timestamp, seq })
 *       -> { channelIndex, dataType, data } | void
 *       The same `>` text as a Request datagram, flooded on `#meshwx` (spec §11). Nothing comes
 *       back from the air: a datagram has no acknowledgement — the answer on the channel is the
 *       acknowledgement. A transport that builds the datagram itself returns it, so the traffic
 *       log holds the bytes that actually went out; one that only forwards the text (the bridge,
 *       the replay) returns nothing and the service encodes the Request it stands for. Throws
 *       `WeatherTransportError` with kind `channelRequestsUnavailable` when this radio cannot
 *       send one at all, which is the service's cue to fall back to the DM ladder.
 *   async resetPath({ to })
 *       Forgets the route the radio holds to a public key, so the next DM goes out by flood.
 *   async channelSecret({ at }) -> Uint8Array | null
 *       The 16-byte secret of a channel slot, or null when it cannot be read.
 *   async isDrainingBacklog() -> boolean
 *       Whether the radio's message queue is being drained right now. A datagram delivered
 *       meanwhile is backlog: it can be hours old, and it says nothing about whether the bot is
 *       in range now.
 *   async linkState() -> WeatherTransportLink | null
 *       The link this transport provides of its own, or null — which is the answer over a radio.
 */

// MARK: - Service

/**
 * Listens to the MeshWX weather bots on `#meshwx`, keeps one `WeatherBotState` per bot, and
 * sends the app's `>` requests with the spec's etiquette (docs/MESHWX.md, spec §19).
 *
 * Per connection, like every service in the container — the datagram stream belongs to the
 * session — but the *state* is not: it is loaded from and saved to a store shared across
 * connections, because a warning belongs to a place, not to the radio that heard it.
 *
 * Observers use `subscribe(fn) -> unsubscribe` (PORTING.md §3); `fn` is called with a
 * `WeatherEvent`. Registration is synchronous, so nothing yielded after the call is dropped.
 *
 * Deviations from the Swift:
 *
 * - Swift's `ingest` is overloaded on datagram and message. JS has no overloads, so the datagram
 *   one is `ingestDatagram`; `ingest` keeps the message, which is the one tests and previews
 *   feed traffic through.
 * - Durations are `TimeInterval` seconds, not `Duration` (PORTING.md §3). The scheduler is
 *   injected and takes milliseconds, like `setTimeout`.
 * - The actor is a promise queue: `ingest`, `send`, `clearState` and the retry timer are
 *   serialised, so no two of them interleave. `acknowledge` is not — it takes no `await`, and in
 *   Swift it reaches the actor while a send is suspended, which is what makes a confirmation
 *   that lands before the send returns count.
 */
export class WeatherService {
  /** Spec §14 / §19: one request per sender every five seconds. Seconds. */
  static requestSpacing = 5
  /** Spec §14: wait up to 15 s before retrying, once. Seconds. */
  static answerTimeout = 15
  /**
   * Spec §11 / §19: a Request datagram is waited on for 10 s, then sent once more — the same
   * bytes, same `ts`, same `seq` — and never a third time. Shorter than the DM's 15 s because
   * a flood needs no route: an answer that is coming arrives in one to three seconds.
   */
  static channelAnswerTimeout = 10
  /**
   * The attempt that goes out by flood after a route reset, and the last one: attempts 0 and 1
   * ride the stored route, attempt 2 rides every repeater. Three sends, 45 s, then the request
   * is settled as unanswered (docs/MESHWX.md, "Requests").
   */
  static floodAttempt = 2
  /**
   * Spec §19: do not re-request something received in the last five minutes. Airtime etiquette
   * only: the bot keeps no cache and rebuilds every answer (spec §14, revision 2). Seconds.
   */
  static recentAnswerWindow = 5 * 60
  /**
   * The bot answers `>f <index>` with the forecast for that point's coordinates, which may come
   * from a nearby point up to this far away.
   */
  static forecastSubstituteKilometres = 80
  /**
   * The bot answers `>o <ICAO>` for a station with no fresh report with the nearest station
   * within this distance of it that has one, as a batch of one under that station's own index
   * (spec §6, revision 8): Dayton's nearest bundled station, Wright-Patterson AFB, never reports.
   */
  static observationSubstituteKilometres = 40
  /** Retention for finished text replies and forecasts per bot, newest kept. */
  static maxTextsPerBot = 24
  static maxForecastsPerBot = 24
  /**
   * How long a text reply and a forecast are kept, whoever asked for them: the same treatment
   * readings get, so the channel's answers to other people cannot pile up for ever. Seconds.
   */
  static textRetention = 48 * 60 * 60
  static forecastRetention = 48 * 60 * 60
  /**
   * A station is forgotten once it has neither been in one of the bot's scheduled batches nor
   * been heard at all for this long: twice the footprint window (§6), so a bot quiet for a night
   * keeps its area, while somebody's `>o KJFK` from last week does not linger as a reading.
   */
  static observationRetention = 48 * 60 * 60
  /**
   * A ceiling whatever the times say. The spec's batch is at most 14 stations, so this is room
   * for a bot's own area several times over plus everything anyone asked about.
   */
  static maxObservationsPerBot = 64
  /** Expired warnings linger this long before pruning, so a screen can still say what just ended. */
  static expiredWarningRetention = 60 * 60
  /** Upgrade markers older than this are forgotten. */
  static pendingUpgradeRetention = 6 * 60 * 60
  /**
   * Confirmations that matched no pending request, newest last. One can reach the service while
   * the send that expects it is still coming back from the radio, before its code is known; it
   * is taken once the code is. Chat DMs' confirmations pass through here too, so only the last
   * few are kept — the radio itself tracks only its last eight expected codes.
   */
  static unmatchedAcknowledgementLimit = 8
  /**
   * Slots proven *not* to be `#meshwx` are rechecked after this long rather than remembered for
   * the session: the channel prompt writes `#meshwx` into a slot, and a session-long "no" for
   * that slot would drop every weather packet that followed. Seconds.
   */
  static foreignSlotRecheck = 60

  constructor({
    transport,
    store,
    trafficLog = new WeatherTrafficLog(),
    now = () => Date.now(),
    answerTimeout = WeatherService.answerTimeout,
    channelAnswerTimeout = WeatherService.channelAnswerTimeout,
    stationIndex = (icao) => MeshWXTables.shared.stationIndex({ forICAO: icao }),
    tables = MeshWXTables.shared,
    setTimeout: schedule = globalThis.setTimeout.bind(globalThis),
    clearTimeout: unschedule = globalThis.clearTimeout.bind(globalThis),
    identity = identityFromString,
    decode = decodeMessage
  }) {
    this.transport = transport
    this.store = store
    /**
     * Every datagram that went past on the weather slot and every Request datagram this device
     * sent (docs/MESHWX_UI.md §17). Written here because this is the one place both directions
     * pass through; read by the Channel traffic screen and by nothing else.
     */
    this.trafficLog = trafficLog
    this.now = now
    this.answerTimeout = answerTimeout
    this.channelAnswerTimeout = channelAnswerTimeout
    this.stationIndex = stationIndex
    this.tables = tables
    this.schedule = schedule
    this.unschedule = unschedule
    this.identity = identity
    this.decode = decode
    /** The bundle's centre of a county or zone, for what a digest speaks for (spec §5). */
    this.areaCentre = WeatherService.areaCentres(tables)

    this.states = {}
    this.isLoaded = false
    this.session = WeatherSessionInfo.make()
    /** Per session: slots proven to be `#meshwx`, by secret. */
    this.weatherSlots = new Set()
    /** Slots proven not to be `#meshwx`, and when. */
    this.foreignSlotsCheckedAt = new Map()
    this.unmatchedAcknowledgements = []
    /** id -> { request, timer } */
    this.pending = new Map()
    this.lastSendAt = null
    /**
     * This phone's own request counter (spec §11): one more for every **new** channel request,
     * repeated on its resend, and wrapping 255 to 0. Informational to the bot, which keys copies
     * on the timestamp; it is how a listener on the channel could tell two requests apart.
     */
    this.nextRequestSeq = 0
    /**
     * An answer anyone on the channel has already received, for the five-minute rule. Filled
     * on ingest — not when this phone's own request settles — so twenty phones tapping after a
     * siren send one request between them, not twenty.
     *
     * Only from a message the reducer applied and that was heard live. A duplicate, a list older
     * than the one held, a late warning the reducer set aside, or anything drained from the
     * radio's queue at connect says nothing about what the bot would answer now.
     */
    this.lastAnswers = new Map()

    this.listeners = new Set()
    this.queue = Promise.resolve()
    this.datagramChain = Promise.resolve()
    this.datagramUnsubscribe = null
    this.acknowledgementUnsubscribe = null
  }

  // MARK: Events

  /**
   * Registers an observer. Returns the function that unregisters it. Re-subscribe per
   * connection: the container is rebuilt.
   */
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Ends every subscription; called from the container's tear-down. */
  finishEvents() {
    this.listeners.clear()
  }

  #yield(event) {
    for (const listener of [...this.listeners]) listener(event)
  }

  // MARK: Lifecycle

  /**
   * Subscribes to channel datagrams. Called before the message polling service drains the
   * firmware queue, so datagrams queued while the phone was away are seen too — and marked as
   * backlog.
   */
  async startEventMonitoring() {
    return this.#serialised(() => this.#startEventMonitoringUnlocked())
  }

  async #startEventMonitoringUnlocked() {
    await this.#loadIfNeededUnlocked()
    this.#stopStreams()
    this.session = WeatherSessionInfo.make({ startedAt: this.now() })
    this.weatherSlots = new Set()
    this.foreignSlotsCheckedAt = new Map()
    this.unmatchedAcknowledgements = []
    this.acknowledgementUnsubscribe = this.transport.subscribeAcknowledgements((code) => {
      this.acknowledge(code)
    })
    this.datagramUnsubscribe = this.transport.subscribeDatagrams((datagram) => {
      // Each datagram is marked live or backlog as it arrives, not when ingest reaches it: ingest
      // can wait on a radio round trip for the slot check, and by then the drain may be over and
      // a queued datagram would read as live.
      const stamped = Promise.resolve(this.transport.isDrainingBacklog())
      this.datagramChain = this.datagramChain.then(async () => {
        const isBacklog = await stamped
        await this.ingestDatagram(datagram, { isBacklog })
      }, () => undefined)
    })
  }

  stopEventMonitoring() {
    this.#stopStreams()
    this.session = { ...this.session, startedAt: null }
    for (const id of [...this.pending.keys()]) {
      this.#settle(id, WeatherRequestOutcome.failed('disconnected'))
    }
  }

  #stopStreams() {
    if (this.datagramUnsubscribe != null) this.datagramUnsubscribe()
    this.datagramUnsubscribe = null
    if (this.acknowledgementUnsubscribe != null) this.acknowledgementUnsubscribe()
    this.acknowledgementUnsubscribe = null
  }

  /** Loads persisted state once. Safe to call repeatedly. */
  async loadIfNeeded() {
    return this.#serialised(() => this.#loadIfNeededUnlocked())
  }

  async #loadIfNeededUnlocked() {
    if (this.isLoaded) return
    this.isLoaded = true
    try {
      this.states = await this.store.load()
    } catch {
      this.states = {}
    }
    // Beside the state, from the same storage under its own key. A log that cannot be read is an
    // empty log; nothing about the weather depends on it.
    try { await this.trafficLog.load() } catch { /* ignored */ }
    const now = this.now()
    for (const key of Object.keys(this.states)) {
      let state = this.states[key]
      state = WeatherStateReducer.pruneExpired(state, {
        expiredBefore: now - WeatherService.expiredWarningRetention * 1000
      }).state
      state = WeatherStateReducer.prunePendingUpgrades(state, {
        olderThan: now - WeatherService.pendingUpgradeRetention * 1000
      })
      // Saved before the phone turned away times from the future (spec §17.5): a digest stamped
      // ahead of the clock would otherwise go on refusing every real one as older.
      state = WeatherStateReducer.dropFutureTimes(state, { now })
      this.states[key] = state
    }
    this.#yield(WeatherEvent.stateLoaded)
  }

  // MARK: State

  async allStates() {
    return this.#serialised(async () => {
      await this.#loadIfNeededUnlocked()
      return this.states
    })
  }

  async state({ for: botID }) {
    return this.#serialised(async () => {
      await this.#loadIfNeededUnlocked()
      return this.states[String(botID)] ?? null
    })
  }

  pendingRequests() {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .sort((lhs, rhs) => lhs.sentAt - rhs.sentAt)
  }

  sessionInfo() {
    return this.session
  }

  /**
   * The transport's own link, for the tool. Null over a radio, where the connection is the app's
   * to report; a bot bridge names the bot it talks to.
   */
  async transportLink() {
    return this.transport.linkState()
  }

  /**
   * Forgets everything held for one bot, with every answer it gave and every answer any bot
   * gave: a forecast or warning slot filled by another bot would otherwise still answer for
   * data the user just cleared.
   */
  async clearState({ for: botID }) {
    return this.#serialised(async () => {
      await this.#loadIfNeededUnlocked()
      delete this.states[String(botID)]
      for (const [slot, record] of [...this.lastAnswers]) {
        if (record.botID == null || record.botID === botID) this.lastAnswers.delete(slot)
      }
      await this.#persist()
    })
  }

  // MARK: Ingest

  /**
   * Decodes and applies one datagram. Anything that is not a v5 message on the `#meshwx` slot
   * is ignored (spec §2.1: "ignore any `data_type` other than 0xFF10"; `0xFF10` is in the
   * development range, so another application may use it on another channel).
   *
   * The reader is the codec's `decode`, injected at construction so a test can feed datagrams
   * without the codec; it throws on bytes it cannot read.
   */
  async ingestDatagram(datagram, { isBacklog = false } = {}) {
    return this.#serialised(async () => {
      if (!(await this.#isWeatherSlot(datagram.channelIndex))) {
        // Counted only for a v5 datagram: another application's traffic on another channel is
        // not a MeshWX message that went astray (spec §2.1).
        if (datagram.dataType === MeshWXWire.dataType) {
          this.session = {
            ...this.session,
            foreignDatagramsIgnored: this.session.foreignDatagramsIgnored + 1
          }
        }
        return null
      }
      // Logged before anything is read: the screen is the channel's traffic, not this app's
      // opinion of it, so a datagram of another `data_type` and one the codec refuses both get a
      // row (docs/MESHWX_UI.md §17). `isDuplicate` is filled in once the reducer has spoken.
      const row = this.#logDatagram(datagram, { isBacklog })
      if (datagram.dataType !== MeshWXWire.dataType) return null
      let message
      try {
        message = this.decode(datagram.data)
      } catch {
        return null
      }
      if (message?.name === 'request') {
        // Another phone asking the bot something, heard because requests are flooded on the
        // channel now (spec §11). It is not from a bot, so it is not the bot's `seq` and not the
        // bot being heard; its answer will arrive as a message of its own, for everyone. Dropped
        // here rather than in the reducer so nothing about it can reach state — but it is on the
        // channel, so it stays on the traffic screen.
        return null
      }
      this.session = { ...this.session, lastChannelDatagramAt: this.now() }
      const changes = await this.#ingestUnlocked(message, { isBacklog })
      if (row != null && changes.some((change) => change.kind === 'duplicate')) {
        this.#markTrafficDuplicate(row)
      }
      return changes
    })
  }

  // MARK: Channel traffic (docs/MESHWX_UI.md §17)

  /** One row for a datagram the radio delivered. Never throws: a log is not worth a dropped packet. */
  #logDatagram(datagram, { isBacklog }) {
    try {
      const at = this.now()
      return this.trafficLog.record(WeatherTrafficEntry.fromDatagram({
        id: this.trafficLog.nextID(at), at, datagram, isBacklog
      }))
    } catch {
      return null
    }
  }

  /** One row for a Request datagram this device put on the air. */
  #logSentRequest(request, { botID, timestamp, seq, sent }) {
    try {
      const at = this.now()
      // The transport hands back the bytes it sent where it can. The bridge and the replay
      // transport send the `>` text itself and have no datagram to hand over, so the Request
      // they stand for is encoded here: the same seq, bot and text, with this radio's own key
      // unknown and therefore zero.
      const data = sent?.data ?? MeshWXEncoder.request({
        seq,
        bot: botID,
        senderPrefix: new Uint8Array(MeshWXWire.requestSenderPrefixSize),
        timestamp: Math.floor(timestamp / 1000),
        text: WeatherRequest.wireText(request)
      })
      return this.trafficLog.record(WeatherTrafficEntry.fromDatagram({
        id: this.trafficLog.nextID(at),
        at,
        direction: WeatherTrafficEntry.sent,
        datagram: {
          channelIndex: sent?.channelIndex ?? null,
          dataType: sent?.dataType ?? MeshWXWire.dataType,
          data,
          // A request is flooded (spec §11), and nothing comes back to measure: a datagram has
          // no acknowledgement and no signal report of its own.
          snr: null,
          pathLength: 0xff
        }
      }))
    } catch {
      return null
    }
  }

  #markTrafficDuplicate(row) {
    try { this.trafficLog.update(row.id, { isDuplicate: true }) } catch { /* ignored */ }
  }

  async #isWeatherSlot(index) {
    if (this.weatherSlots.has(index)) return true
    const checkedAt = this.foreignSlotsCheckedAt.get(index)
    if (checkedAt != null && (this.now() - checkedAt) / 1000 < WeatherService.foreignSlotRecheck) {
      return false
    }
    const secret = await this.transport.channelSecret({ at: index })
    if (secret == null) {
      // Unreadable: accept, and ask again next time. Dropping a tornado warning because a
      // channel read timed out is the worse error of the two.
      return true
    }
    const expected = await WeatherChannel.secret()
    if (bytesEqual(secret, expected)) {
      this.weatherSlots.add(index)
      this.foreignSlotsCheckedAt.delete(index)
      return true
    }
    this.foreignSlotsCheckedAt.set(index, this.now())
    return false
  }

  /**
   * Applies an already-decoded message: the reducer, then request settlement, then
   * persistence. Public so tests and previews can feed traffic without a radio.
   *
   * `isBacklog`: the message was drained from the radio's queue rather than heard live. It
   * changes state like any other — a warning is a warning — but proves nothing about now: it
   * answers nothing for the five-minute rule and does not count as hearing the bot.
   */
  async ingest(message, { isBacklog = false } = {}) {
    return this.#serialised(() => this.#ingestUnlocked(message, { isBacklog }))
  }

  async #ingestUnlocked(message, { isBacklog }) {
    // Somebody else's request (spec §11). Not a bot, not an answer, not a `seq` of the bot's:
    // nothing about it is state, and the reducer must never see one.
    if (message.name === 'request') return []
    await this.#loadIfNeededUnlocked()
    const botID = message.bot
    const key = String(botID)
    const receivedAt = this.now()
    const before = this.states[key] ?? WeatherBotState.make({ botID })
    const { state: applied, changes } = WeatherStateReducer.apply(message, {
      to: before, receivedAt, areaCentre: this.areaCentre
    })
    let state = applied

    const isDuplicate = changes.some((change) => change.kind === 'duplicate')
    if (!isDuplicate && !isBacklog) {
      state = { ...state, lastLiveHeardAt: Math.max(state.lastLiveHeardAt ?? receivedAt, receivedAt) }
    }
    this.states[key] = state
    if (isDuplicate) {
      // A duplicate changes nothing and settles nothing.
      this.#yield(WeatherEvent.received({ botID, message, changes, isBacklog }))
      return changes
    }

    const settled = this.#settlePending(message, { from: botID })
    if (!isBacklog) {
      this.#recordAnswer(message, { changes, settled, from: botID, at: receivedAt })
    }
    this.#yield(WeatherEvent.received({ botID, message, changes, isBacklog }))
    await this.#persist()
    return changes
  }

  /**
   * Fills the answer slots a live message fills — keyed off the reducer's changes, so only what
   * it applied counts. Runs after settlement: a text reply becomes an answer only once this
   * phone owns it.
   */
  #recordAnswer(message, { changes, settled, from: botID, at: receivedAt }) {
    const fill = (slotBotID, key, contentAsOf = null) => {
      this.lastAnswers.set(answerSlotKey(slotBotID, key), { botID: slotBotID, key, receivedAt, contentAsOf })
    }
    for (const change of changes) {
      if (change.kind === 'digestApplied' && message.name === 'digest') {
        // `>w <area>` reads the list's slot itself, and only for an area the list speaks for
        // (`#answerSlots`): a list says nothing about a county outside the bot's area.
        const builtAt = dateFromUnixMinutes(message.now_min)
        fill(botID, 'digest', builtAt)
        fill(botID, 'activeWarnings', builtAt)
      } else if (change.kind === 'warningStored' && message.name === 'warning') {
        fill(botID, 'activeWarnings')
        // `>w <area>` by the area asked: a warning for one county is no answer about another.
        // Every code the warning names, and the code this phone asked about when the warning
        // settled its request — the bot may have cut the list that would have named it.
        const named = this.tables?.namedAreas?.({ for: message }) ?? []
        const codes = new Set(named.map((area) => area.ugc.toUpperCase()))
        for (const request of settled) {
          if (request.kind === 'warningsTouching') codes.add(request.ugc.toUpperCase())
        }
        for (const ugc of codes) fill(botID, warningsTouchingSlot(ugc))
        fill(null, `warning.${identityKey(change.value)}`)
      } else if (change.kind === 'observationsStored' && message.name === 'observations'
        && change.stations.length > 0) {
        const observedAt = dateFromUnixMinutes(message.ts_min)
        // A single station is usually somebody's `>o KJFK`, but the answer to this phone's own
        // `>o` is a batch of one when only one station reported.
        if (message.stations.length > 1 || settled.some((request) => request.kind === 'observations')) {
          fill(botID, 'coverageObservations', observedAt)
        }
        // Each station's slot carries that station's own report time (spec §6.1): a reading two
        // hours behind the batch must not look two hours fresher than it is.
        for (const station of change.stations) {
          const held = message.stations.find((entry) => entry.station === station)
          const reported = held == null ? message.ts_min : (message.ts_min - (held.age_min ?? 0)) >>> 0
          fill(null, `station.${station}`, dateFromUnixMinutes(reported))
        }
      } else if (change.kind === 'forecastStored' && message.name === 'forecast'
        && !WeatherStoredForecast.isUnbundledPoint(message)) {
        fill(null, `forecast.${change.point}`, dateFromUnixMinutes(message.issued_min))
      } else if (change.kind === 'areaSweepStored' && message.name === 'area_sweep') {
        // Filled on the *first* packet, not on the last: the seven that follow are already on
        // the air, and a second phone tapping between them must not add eight more.
        //
        // Which slot depends on what the sweep covers, not on what anybody asked for. A national
        // sweep fills the national slot from any of its packets; a scoped one can only be named
        // by its packet 0, which is the packet that carries the scope entries — and a scoped
        // sweep whose packet 0 this phone missed fills nothing, because a sweep this phone
        // cannot name is not evidence that anybody's question was answered.
        const scope = message.scoped === true
          ? (message.idx === 0 ? this.#sweepScopeCodes(message) : null)
          : NATIONAL_SWEEP_SCOPE
        if (scope != null) fill(botID, sweepSlot(scope), dateFromUnixMinutes(message.built_min))
      } else if (change.kind === 'radarStored' && message.name === 'radar'
        && this.#isNewestRadarFrame(message)) {
        // Keyed by the tile and filled for **any** bot, because that is how a radar answer is
        // paired: the lattice square is the question, and two bots cutting it from the same
        // national mosaic send the same picture. The content time is the picture's own `taken`,
        // never receipt — a forty-minute-old picture that arrived a minute ago is forty minutes
        // old, and the bot will refuse to re-send it for five of them anyway (spec §13, reason 4).
        //
        // Only by the newest frame of the square (revision 13): an older frame from somebody's
        // loop is not the answer to "the picture of this square", and filling the slot with it
        // would turn the next ask for a newer picture into "already received" an hour back.
        fill(null, radarSlot(change.value), dateFromUnixMinutes(message.taken_min))
      } else if (change.kind === 'coverageStored' && message.name === 'coverage') {
        // No content time: the statement describes the bot, not an hour (spec §10), so the
        // five-minute rule runs from receipt alone and nothing claims it is "as of" anything.
        fill(botID, 'coverage')
      } else if (change.kind === 'textChunkStored' && message.name === 'text') {
        // Complete, so a reply still missing a part can be asked for again (spec §8).
        const assembly = this.states[String(botID)]?.texts?.[String(change.group)]
        if (assembly != null && assembly.request != null && WeatherTextAssembly.isComplete(assembly)) {
          fill(botID, `text.${WeatherRequest.key(assembly.request)}`)
        }
      }
    }
  }

  /**
   * A scoped sweep's scope as the request that would ask for it writes it: upper case, sorted,
   * run together. The same normalisation `WeatherRequest.areaSweep` applies, so the slot a sweep
   * fills and the slot a tap looks in are the same string.
   *
   * A state index the bundle cannot name is dropped — an older bundle decoding a newer bot's
   * sweep should lose the *names*, never the message — and a scope with any such index therefore
   * never matches a selection it does not genuinely cover.
   */
  #sweepScopeCodes(message) {
    const table = this.tables?.states ?? []
    const codes = []
    for (const index of message.scope ?? []) {
      const code = table[index]
      if (code != null) codes.push(String(code).toUpperCase())
    }
    return [...new Set(codes)].sort().join('')
  }

  /**
   * Whether a radar frame just stored is the newest held of its square across every bot
   * (revision 13): the one a `>radar` for that square would be answered with. Since `radarTiles`
   * holds frames, an older picture from somebody's loop is stored beside the newest rather than
   * ignored, and it is not what the square's answer slot means.
   */
  #isNewestRadarFrame(message) {
    const tile = MeshWXRadar.tile(message)
    for (const state of Object.values(this.states)) {
      for (const stored of state?.radarTiles ?? []) {
        if (MeshWXRadarTile.isEqual(stored.tile, tile) && stored.radar.taken_min > message.taken_min) return false
      }
    }
    return true
  }

  // MARK: Requests

  /**
   * Sends a request to a bot, or answers it from what the channel already delivered.
   *
   * **Channel first** (spec §11): the request goes out as a datagram flooded on `#meshwx`,
   * because a DM rides one stored route and fails silently once that route has gone stale. The
   * DM ladder of §14 is the fallback, for a radio that cannot send a datagram at all.
   *
   * Returns the pending request now on the air, or null when this phone received the answer in
   * the last five minutes and asking again would only spend airtime (a
   * `requestSettled(_, alreadyReceived)` event is emitted). Throws `WeatherRequestError` with
   * kind `rateLimited` inside the five-second spacing, `transport` when the radio refuses.
   */
  async send(request, { to: bot }) {
    return this.#serialised(() => this.#sendUnlocked(request, { to: bot }))
  }

  async #sendUnlocked(request, { to: bot }) {
    await this.#loadIfNeededUnlocked()
    const botID = WeatherBot.botID(bot)
    const sentAt = this.now()

    // The newest of the slots that would answer this: for everything but an area sweep there is
    // at most one, and for one of those a national sweep can answer a scoped tap.
    let answer = null
    for (const slot of this.#answerSlots(request, { botID })) {
      const held = this.lastAnswers.get(slot)
      if (held != null && (answer == null || held.receivedAt > answer.receivedAt)) answer = held
    }
    if (answer != null
      && (sentAt - answer.receivedAt) / 1000 < WeatherService.recentAnswerWindow
      && !this.#answerLeavesSomethingOutstanding(request, { answer, botID, now: sentAt })) {
      const served = WeatherPendingRequest.make({
        request, botID, botPublicKey: bot.publicKey, sentAt
      })
      this.#yield(WeatherEvent.requestSettled(
        served,
        WeatherRequestOutcome.alreadyReceived({
          receivedAt: answer.receivedAt, contentAsOf: answer.contentAsOf
        })
      ))
      return null
    }

    if (this.lastSendAt != null) {
      const elapsed = (sentAt - this.lastSendAt) / 1000
      if (elapsed < WeatherService.requestSpacing) {
        throw WeatherRequestError.rateLimited({ retryAfter: WeatherService.requestSpacing - elapsed })
      }
    }

    // Claim the slot before the await so a second caller inside the window is refused even
    // while this request is still going out.
    this.lastSendAt = sentAt

    // One wire timestamp and one seq for the request's life: the resend repeats both, which is
    // what makes it a copy rather than a second request.
    const seq = this.nextRequestSeq
    try {
      const sent = await this.transport.sendChannelRequest({
        text: WeatherRequest.wireText(request), botID, timestamp: sentAt, seq
      })
      this.#logSentRequest(request, { botID, timestamp: sentAt, seq, sent })
      this.nextRequestSeq = (this.nextRequestSeq + 1) & 0xff
      const entry = WeatherPendingRequest.make({
        request,
        botID,
        botPublicKey: bot.publicKey,
        sentAt,
        transportKind: WeatherRequestTransportKind.channel,
        timestamp: sentAt,
        seq
      })
      this.pending.set(entry.id, { request: entry, timer: null })
      this.#armTimer(entry.id)
      this.#yield(WeatherEvent.requestSent(entry))
      return this.pending.get(entry.id)?.request ?? entry
    } catch (error) {
      // Read structurally, not with `instanceof`: the transport is duck-typed and lives in
      // another module, so its copy of `WeatherTransportError` need not be this one's class for
      // the fallback to be right.
      if (error?.kind !== 'channelRequestsUnavailable') {
        throw WeatherRequestError.transport(String(error?.message ?? error))
      }
      // This radio cannot flood a datagram: no v1.15.0 firmware, no `#meshwx` slot, or no key
      // of its own. The DM still works, and the bot still answers it (spec §11).
      // Unless the bot was only ever heard and never seen to advertise: a DM needs its whole
      // key, and two bytes of it are all its packets carry.
      if (!WeatherBot.isAnnounced(bot)) {
        throw WeatherRequestError.transport('this radio cannot send a channel request, and the weather radio has not announced itself for a direct message')
      }
    }

    const entry = WeatherPendingRequest.make({
      request,
      botID,
      botPublicKey: bot.publicKey,
      sentAt,
      transportKind: WeatherRequestTransportKind.dm,
      timestamp: sentAt
    })
    let ackCode
    try {
      ackCode = await this.transport.sendRequest({
        to: bot.publicKey, text: WeatherRequest.wireText(request), timestamp: entry.timestamp, attempt: 0
      })
    } catch (error) {
      throw WeatherRequestError.transport(String(error?.message ?? error))
    }
    const code = hex(ackCode)
    entry.ackCodes = [...entry.ackCodes, code]
    this.pending.set(entry.id, { request: entry, timer: null })
    this.#armTimer(entry.id)
    this.#yield(WeatherEvent.requestSent(entry))
    this.#takeEarlyAcknowledgement(code, entry.id)
    return this.pending.get(entry.id)?.request ?? entry
  }

  /**
   * The answer slots that would settle a request from what the channel already carried, newest
   * match wins. Empty for a request nothing already received can answer.
   *
   * Almost every request has exactly one. The exceptions are revision 10's:
   *
   * - An **area sweep** is keyed by its **selection**, so a sweep of Texas does not stand in for
   *   a tap on Oklahoma. A sweep of the whole country did cover Oklahoma, so the national slot
   *   answers a scoped tap as well. The two levels still share a slot, as they did before
   *   revision 10: a phone that has just been handed the narrow map of a place is not helped by
   *   spending three more packets on the wider one within five minutes of it, and the map says
   *   which level it is showing.
   * - `>part` has **none**: it asks for bytes that never arrived. "A `>part` request is never
   *   refused by the app's five-minute 'already answered' rule" (spec §12, revision 10) — the
   *   rule exists so the channel is not asked to rebuild an answer it just sent, and the whole
   *   point here is that this phone did not get it.
   * - `>f <lat>,<lon>` has none either: the point is the bot's to choose and this phone cannot
   *   know which held forecast a fresh question would come back as.
   */
  #answerSlots(request, { botID }) {
    const one = (slot) => (slot == null ? [] : [slot])
    switch (request.kind) {
      case 'digest': return one(answerSlotKey(botID, 'digest'))
      case 'observations': return one(answerSlotKey(botID, 'coverageObservations'))
      case 'observation': {
        const index = this.stationIndex(request.station)
        return index == null ? [] : one(answerSlotKey(null, `station.${index}`))
      }
      case 'forecast': return one(answerSlotKey(null, `forecast.${request.point}`))
      case 'activeWarnings': return one(answerSlotKey(botID, 'activeWarnings'))
      case 'warningsTouching': {
        // The area's own slot, and the bot's list where the list speaks for the area: one with
        // no complete statement of the bot's coverage held, or one inside it (spec §5).
        const slots = [answerSlotKey(botID, warningsTouchingSlot(request.ugc))]
        if (this.#digestSpeaksFor(request.ugc, { botID })) slots.push(answerSlotKey(botID, 'digest'))
        return slots
      }
      case 'warning': {
        const named = this.identity({ from: request.identity, tables: this.tables })
        return named == null ? [] : one(answerSlotKey(null, `warning.${identityKey(named)}`))
      }
      case 'warningText': case 'forecastDiscussion': case 'spaceWeather': case 'stormReports':
      case 'rainfall': case 'metar': case 'taf': case 'hazardousOutlook':
        return one(answerSlotKey(botID, `text.${WeatherRequest.key(request)}`))
      case 'coverage': return one(answerSlotKey(botID, 'coverage'))
      case 'areaSweep': {
        const states = WeatherRequest.areaSweepStates(request).join('')
        const scopes = states.length === 0 ? [NATIONAL_SWEEP_SCOPE] : [states, NATIONAL_SWEEP_SCOPE]
        return scopes.map((scope) => answerSlotKey(botID, sweepSlot(scope)))
      }
      case 'radar': {
        // The tile, from any bot: the same square cut from the same mosaic is the same picture,
        // and the bot refuses to send one twice inside five minutes in any case (spec §13,
        // reason 4). Two places on one tile therefore share the slot, which is the whole point
        // of the lattice — one answer for a town, not one per phone.
        const tile = MeshWXRadarTile.containing({
          latitude: request.latitude, longitude: request.longitude, zoom: request.zoom
        })
        return one(answerSlotKey(null, radarSlot(tile)))
      }
      // None for the last hour (revision 13): the slot says when the newest picture of the
      // square arrived, which says nothing about the older ones a loop asks for. The ask lists
      // what this phone holds, and the bot leaves out whatever went on the air in the last five
      // minutes, so asking twice costs the channel nothing it has just carried.
      case 'radarLoop': return []
      case 'parts': case 'forecastAt': return []
      default: return []
    }
  }

  /**
   * Whether the bot's digest speaks for one county or zone (`WeatherStateReducer.digestSpeaksFor`).
   * A code the bundle cannot read is one nothing can say it speaks for.
   */
  #digestSpeaksFor(ugc, { botID }) {
    const key = MeshWXAreaRun.key({ forUGC: ugc, states: this.tables?.states ?? [] })
    if (key == null) return false
    const area = { areas: [{ state: key.state, county: key.county, start: key.number, run: 1 }], polygon: null }
    return WeatherStateReducer.digestSpeaksFor(area, {
      coverage: this.states[String(botID)]?.coverage?.coverage ?? null,
      areaCentre: this.areaCentre
    })
  }

  /**
   * Whether an alert request goes out although its answer arrived in the last five minutes,
   * because that answer cannot speak for what the addressed bot's state has outstanding now:
   *
   * - A gap detected after the answer arrived: what was missed came later, and only a new
   *   answer can say what it was.
   * - A gap at or before an answer built too soon after it to clear it (a list inside
   *   `WeatherStateReducer.digestMargin` of the gap, including the list whose own `seq`
   *   revealed it), once a list built now would. Before then a new list could not clear it
   *   either, and would carry nothing the one just received does not.
   * - For `>w` and `>w <area>`: a warning a list named that never arrived, or an upgrade whose
   *   replacement never came. Whatever arrived evidently did not carry it.
   */
  #answerLeavesSomethingOutstanding(request, { answer, botID, now }) {
    switch (request.kind) {
      case 'digest': case 'activeWarnings': case 'warningsTouching': case 'warning': break
      default: return false
    }
    const state = this.states[String(botID)]
    if (state == null) return false
    if (state.needsDigest && state.gapDetectedAt != null) {
      const gap = state.gapDetectedAt
      if (gap > answer.receivedAt) return true
      const margin = WeatherStateReducer.digestMargin * 1000
      if (answer.contentAsOf != null && gap >= answer.contentAsOf - margin && now >= gap + margin) {
        return true
      }
    }
    switch (request.kind) {
      // `>d` is where asking for missing warnings one at a time ends, once the bot has said it
      // has none of them, so it must not wait out the five minutes either.
      case 'digest': case 'activeWarnings': case 'warningsTouching':
        return state.missingFromDigest.length > 0 || Object.keys(state.pendingUpgrades).length > 0
      default:
        return false
    }
  }

  #armTimer(id) {
    const entry = this.pending.get(id)
    if (entry == null) return
    if (entry.timer != null) this.unschedule(entry.timer)
    // A flood is answered in one to three seconds or not at all; a DM may still be finding its
    // way along a route (spec §19: 10 s for a datagram, 15 s for a DM).
    const timeout = entry.request.transportKind === WeatherRequestTransportKind.channel
      ? this.channelAnswerTimeout
      : this.answerTimeout
    entry.timer = this.schedule(() => this.#serialised(() => this.#handleTimeout(id)), timeout * 1000)
  }

  async #handleTimeout(id) {
    const entry = this.pending.get(id)
    if (entry == null) return
    // Heard since the **first** send (the wire timestamp is the first send's time): a bot that
    // answered somebody else while this request was on its second or third try was in range for
    // the whole of it, and "heard but didn't answer" is the honest label for that.
    const botWasHeard = this.#wasHeardLive({ botID: entry.request.botID, since: entry.request.timestamp })
    if (entry.request.transportKind === WeatherRequestTransportKind.channel) {
      await this.#handleChannelTimeout(id, { entry, botWasHeard })
      return
    }
    const attempt = entry.request.attempt
    // What the next send is, or null to stop asking:
    //
    // - Attempt 0 unheard and unconfirmed → attempt 1, the same DM along the same route, into
    //   silence.
    // - Attempt 0 **confirmed** by the bot's radio but unanswered → attempt 1 too: the request
    //   arrived, its answer may not have, and the bot answers a copy from its cache for one
    //   packet. Never a flood for a confirmed request: the route works.
    // - Attempt 0 unconfirmed while the bot **was** heard, or attempt 1 unconfirmed → the route
    //   is the suspect, not the range. Forget it and send attempt 2 by flood, once (the chat
    //   rule, D5). The field log of 16 September had seven requests in six minutes that never
    //   reached a bot which was on the air and answering others.
    // - Attempt 2, or a confirmed request past attempt 0 → done.
    let next = null
    const confirmed = entry.request.botRadioReceived
    if (attempt === 0 && !confirmed && !botWasHeard) next = 1
    else if (attempt === 0 && confirmed && !botWasHeard) next = 1
    else if ((attempt === 0 && !confirmed && botWasHeard) || (attempt === 1 && !confirmed)) {
      next = WeatherService.floodAttempt
    }
    if (next == null) {
      this.#settle(id, WeatherRequestOutcome.timedOut({ botWasHeard, botRadioReceived: confirmed }))
      return
    }
    if (next === WeatherService.floodAttempt) {
      // A reset that fails still leaves the send worth making: on the route it has is no worse
      // than not asking again at all.
      try { await this.transport.resetPath({ to: entry.request.botPublicKey }) } catch { /* ignored */ }
      if (!this.pending.has(id)) return
    }
    const sentAt = this.now()
    this.pending.set(id, {
      ...this.pending.get(id),
      request: { ...this.pending.get(id).request, attempt: next, sentAt }
    })
    let ackCode
    try {
      this.lastSendAt = sentAt
      // The first send's timestamp and text again: to the bot's radio the same message, to the
      // bot (the same text from one sender within two minutes is one request) the same request,
      // which it answers again from its cache once its last answer is 12 s gone.
      ackCode = await this.transport.sendRequest({
        to: entry.request.botPublicKey,
        text: WeatherRequest.wireText(entry.request.request),
        timestamp: entry.request.timestamp,
        attempt: next
      })
    } catch (error) {
      this.#settle(id, WeatherRequestOutcome.failed(String(error?.message ?? error)))
      return
    }
    // Answered while the resend was going out. Otherwise update the entry in place: a
    // confirmation of an earlier send may have landed meanwhile.
    const live = this.pending.get(id)
    if (live == null) return
    const code = hex(ackCode)
    live.request = { ...live.request, ackCodes: [...live.request.ackCodes, code] }
    this.#yield(WeatherEvent.requestSent(live.request))
    this.#takeEarlyAcknowledgement(code, id)
    this.#armTimer(id)
  }

  /**
   * The datagram's etiquette (spec §11, §19): send once, send the same bytes once more after
   * 10 s, never a third time.
   *
   * The resend repeats the first send's `ts`, `seq` and text exactly, so to the bot it is a
   * copy of one request and not a second one — answered again only once its last answer is 12 s
   * gone, so a resend can never double the airtime of an answer. Nothing here waits on a
   * confirmation: a datagram has none, which is why `botRadioReceived` is always false for one.
   */
  async #handleChannelTimeout(id, { entry, botWasHeard }) {
    if (entry.request.attempt !== 0) {
      this.#settle(id, WeatherRequestOutcome.timedOut({ botWasHeard, botRadioReceived: false }))
      return
    }
    const sentAt = this.now()
    this.pending.set(id, { ...entry, request: { ...entry.request, attempt: 1, sentAt } })
    try {
      this.lastSendAt = sentAt
      const sent = await this.transport.sendChannelRequest({
        text: WeatherRequest.wireText(entry.request.request),
        botID: entry.request.botID,
        timestamp: entry.request.timestamp,
        seq: entry.request.seq
      })
      // The resend is the same bytes again, and the traffic screen shows it as the second
      // transmission it is rather than hiding it as a copy of something the reader already saw.
      this.#logSentRequest(entry.request.request, {
        botID: entry.request.botID, timestamp: entry.request.timestamp, seq: entry.request.seq, sent
      })
    } catch (error) {
      this.#settle(id, WeatherRequestOutcome.failed(String(error?.message ?? error)))
      return
    }
    // Answered while the resend was going out.
    const live = this.pending.get(id)
    if (live == null) return
    this.#yield(WeatherEvent.requestSent(live.request))
    this.#armTimer(id)
  }

  /**
   * Live only: a backlog drained from the radio's queue after the request went out is stamped
   * with the drain time, and says nothing about whether the bot can hear this phone now.
   */
  #wasHeardLive({ botID, since }) {
    const heard = this.states[String(botID)]?.lastLiveHeardAt
    if (heard == null) return false
    return heard > since
  }

  // MARK: Confirmations

  /**
   * Takes one of the radio's delivery confirmations: the pending request expecting the code,
   * from either transmission, was received by the bot's radio. `code` is the `Uint8Array` the
   * radio pushed.
   */
  acknowledge(code) {
    const text = hex(code)
    for (const [id, entry] of this.pending) {
      if (entry.request.ackCodes.includes(text)) {
        this.#markReceivedByBotRadio(id)
        return
      }
    }
    this.unmatchedAcknowledgements.push(text)
    if (this.unmatchedAcknowledgements.length > WeatherService.unmatchedAcknowledgementLimit) {
      this.unmatchedAcknowledgements.shift()
    }
  }

  /** A confirmation that reached the service before the send expecting it came back. */
  #takeEarlyAcknowledgement(code, id) {
    const index = this.unmatchedAcknowledgements.indexOf(code)
    if (index < 0) return
    this.unmatchedAcknowledgements.splice(index, 1)
    this.#markReceivedByBotRadio(id)
  }

  #markReceivedByBotRadio(id) {
    const entry = this.pending.get(id)
    if (entry == null || entry.request.botRadioReceived) return
    entry.request = { ...entry.request, botRadioReceived: true }
    this.#yield(WeatherEvent.requestReceivedByBotRadio(entry.request))
  }

  #settle(id, outcome) {
    const entry = this.pending.get(id)
    if (entry == null) return
    this.pending.delete(id)
    if (entry.timer != null) this.unschedule(entry.timer)
    this.#yield(WeatherEvent.requestSettled(entry.request, outcome))
  }

  /** Pairs an incoming message with the requests waiting on it; returns the requests it answered. */
  #settlePending(message, { from: botID }) {
    const waiting = [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => request.botID === botID
        || WeatherRequest.acceptsAnswerFromAnyBot(request.request))
      .sort((lhs, rhs) => lhs.sentAt - rhs.sentAt)
    if (waiting.length === 0) return []

    if (message.name === 'not_available') {
      // One refusal answers the oldest request with that letter — and only a request to the
      // bot that refused.
      const match = waiting.find((request) => request.botID === botID
        && WeatherRequest.requestLetter(request.request) === message.request)
      if (match != null) {
        this.#settle(match.id, WeatherRequestOutcome.notAvailable(message.reason))
      }
      return []
    }

    const answered = []
    for (const request of waiting) {
      if (!this.#answers(message, { request, from: botID })) continue
      this.#markAnswered(request, { by: message, from: botID })
      this.#settle(request.id, WeatherRequestOutcome.answered)
      answered.push(request.request)
    }
    return answered
  }

  /**
   * Whether a message answers a request: its kind and what it names, and for a text reply, its
   * words (`WeatherTextMatch`) read over every chunk of the reply received so far.
   */
  #answers(message, { request, from: botID }) {
    const fromAddressedBot = request.botID === botID
    // `>part` is not a question about the weather, so none of the rules below apply to it: the
    // bot replays the packets it was asked for, identical bytes with a new `seq`, and the one
    // thing that matters is that this is one of them. "It settles as answered when any asked-for
    // index arrives from the bot asked" (spec §12, revision 10) — one packet, not all of them,
    // because the resends go out one at a time and the offer is gone as soon as the first lands.
    if (request.request.kind === 'parts') {
      const isTheAnswer = WeatherService.reply(message, {
        satisfies: WeatherRequest.expectedReply(request.request),
        fromAddressedBot,
        stationIndex: this.stationIndex,
        tables: this.tables,
        identity: this.identity
      })
      if (!isTheAnswer) return false
      return WeatherRequest.partIndexes(request.request.indexes).includes(message.idx)
    }
    const satisfies = WeatherService.reply(message, {
      satisfies: WeatherRequest.expectedReply(request.request),
      fromAddressedBot,
      stationIndex: this.stationIndex,
      tables: this.tables,
      identity: this.identity
    })
    if (!satisfies) return false
    // `>f <lat>,<lon>` expects "a forecast", because the point is the bot's to choose (spec §7,
    // revision 10). What keeps somebody else's forecast from settling it is the coordinate: a
    // bundled point the bot picked is checked against the one asked about, and an answer the bot
    // chose no bundled point for can only have been chosen for a question that was asked — and
    // only the bot asked is listened to for either.
    if (request.request.kind === 'forecastAt' && message.name === 'forecast') {
      if (!fromAddressedBot) return false
      if (WeatherStoredForecast.isUnbundledPoint(message)) return true
      const answered = this.tables.point({ at: message.point })
      if (answered == null) return false
      return MeshWXGeo.distanceKilometres({
        fromLat: request.request.latitude,
        fromLon: request.request.longitude,
        toLat: answered.lat,
        toLon: answered.lon
      }) <= WeatherService.forecastSubstituteKilometres
    }
    if (message.name !== 'text') return true
    const assembly = this.states[String(botID)]?.texts?.[String(message.group)]
    if (assembly == null) return false
    return WeatherTextMatch.matches(request.request, {
      assembly, states: this.states, tables: this.tables, identity: this.identity
    })
  }

  /**
   * Records on the stored answer that this phone asked for it: the channel is shared, and a
   * forecast or a text reply is otherwise indistinguishable from one somebody else requested.
   */
  #markAnswered(request, { by: message, from: botID }) {
    const key = String(botID)
    const state = this.states[key]
    if (state == null) return
    if (message.name === 'forecast' && WeatherStoredForecast.isUnbundledPoint(message)) {
      // A point the bot chose for itself comes back as `0xFFFF` and says nothing about where it
      // is for (spec §7). The reducer parked it in the slot for questions nobody here asked;
      // this phone did ask, so it moves under the question — the coordinate exactly as the wire
      // wrote it for `>f <lat>,<lon>`, the place string for `>f round rock tx` — and that is how
      // the Forecast card finds it again.
      const held = state.unbundledForecasts?.[UNASKED_FORECAST_KEY]
      if (held == null) return
      const unbundled = { ...state.unbundledForecasts }
      if (request.request.kind === 'forecastAt') {
        // The question was a coordinate, so the answer is filed under it and the Forecast card
        // can measure a place against it.
        delete unbundled[UNASKED_FORECAST_KEY]
        unbundled[WeatherRequest.coordinateKey(request.request)] = {
          ...held, requestedHere: true, requestLabel: null
        }
      } else if (request.request.kind === 'forecastForPlace') {
        // `>f round rock tx`: the bot resolved a name, and the request is the answer's only
        // label (spec §7). There is no coordinate to file it under and none to measure, so it
        // stays in the slot for answers that belong to no place on this phone — which is exactly
        // where a bot-chosen forecast has always lived.
        unbundled[UNASKED_FORECAST_KEY] = {
          ...held, requestedHere: true, requestLabel: request.request.value
        }
      } else {
        return
      }
      this.states[key] = {
        ...state,
        unbundledForecasts: WeatherStateReducer.retainUnbundledForecasts(unbundled)
      }
    } else if (message.name === 'forecast') {
      const point = String(message.point)
      const held = state.forecasts[point]
      if (held == null) return
      this.states[key] = {
        ...state,
        forecasts: { ...state.forecasts, [point]: { ...held, requestedHere: true } }
      }
    } else if (message.name === 'text') {
      const group = String(message.group)
      const held = state.texts[group]
      if (held == null) return
      // A `>part` fills a hole in a reply; it does not become the reply's request. The tap that
      // fetched the product is what the screen names it by, and a reply this phone only patched
      // was still somebody else's question.
      if (request.request.kind === 'parts') return
      this.states[key] = {
        ...state,
        texts: { ...state.texts, [group]: { ...held, request: request.request } }
      }
    } else if (message.name === 'area_sweep') {
      // Only if this sweep is still held: retention may have dropped it as saying nothing a
      // newer one does not, and then the map on screen is not this request's answer.
      const index = (state.areaSweeps ?? []).findIndex(
        (one) => one.group === message.group && one.builtMinutes === message.built_min
      )
      if (index < 0) return
      // A `>part` does not make the sweep this phone's: it fills a hole in one, and whoever's
      // tap fetched the sweep is still the request it answered.
      if (request.request.kind === 'parts') return
      const sweeps = [...state.areaSweeps]
      sweeps[index] = { ...sweeps[index], request: request.request }
      this.states[key] = { ...state, areaSweeps: sweeps }
    }
  }

  /**
   * Whether a message is the answer a request expects. Static and injectable so the pairing
   * rules are testable without a service. For text this checks the subject only; the service
   * also reads the words (`WeatherTextMatch`) before a reply settles anything.
   *
   * `fromAddressedBot`: the message came from the bot the request went to. A request that only
   * its own bot can settle never reaches here with another bot's message
   * (`WeatherRequest.acceptsAnswerFromAnyBot`); a forecast uses it to accept a substituted point
   * only from the bot that chose it.
   */
  static reply(message, { satisfies: kind, fromAddressedBot, stationIndex, tables, identity = identityFromString }) {
    if (kind.kind === 'digest' && message.name === 'digest') return true
    if (kind.kind === 'warnings' && (message.name === 'warning' || message.name === 'digest')) {
      // `>w` answers with warnings then a digest. Either first message settles the request; the
      // rest keep flowing into state regardless.
      return true
    }
    if (kind.kind === 'warning' && message.name === 'warning') {
      // An identity the tables cannot read matches nothing; a Not available or the timeout
      // settles it instead.
      const named = identity({ from: kind.identity, tables })
      return named != null && identityKey(named) === identityKey(message)
    }
    if (kind.kind === 'warningsTouching' && message.name === 'warning') {
      // The bot matches the code exactly against the product's own area list (spec §14), but
      // cuts the list it sends to 30, 12 or 6 runs, or drops it, to fit one packet. From the bot
      // asked, a warning whose list may have been cut can be the answer without naming the code.
      const named = tables.namedAreas({ for: message })
      if (named.some((area) => area.ugc.toUpperCase() === kind.ugc.toUpperCase())) return true
      if (!fromAddressedBot) return false
      return [0, 6, 12, MeshWXWire.maxAreaRuns].includes(message.areas?.length ?? 0)
    }
    if (kind.kind === 'observations' && message.name === 'observations') {
      // `>o` is answered by the bot's batch whatever its size: one station when only one reported.
      if (kind.station == null) return true
      const index = stationIndex(kind.station)
      if (index == null) return fromAddressedBot
      if (message.stations.some((entry) => entry.station === index)) return true
      // The named station had nothing fresh, so the bot sent the nearest one that did (spec §6,
      // revision 8). Only from the bot asked, only alone: somebody else's batch that happens to
      // hold a neighbour is not this request's answer.
      if (!fromAddressedBot || message.stations.length !== 1) return false
      const asked = tables.station({ icao: kind.station })
      const answered = tables.station({ at: message.stations[0].station })
      if (asked == null || answered == null) return false
      return MeshWXGeo.distanceKilometres({
        fromLat: asked.lat, fromLon: asked.lon, toLat: answered.lat, toLon: answered.lon
      }) <= WeatherService.observationSubstituteKilometres
    }
    if (kind.kind === 'forecast' && message.name === 'forecast') {
      if (kind.point == null) return true
      if (message.point === kind.point) return true
      // The bot forecasts the point's coordinates: what comes back may be a nearby point within
      // 80 km under its own index, a place with no bundled point, or — from a revision 2 bot —
      // another index with the same coordinates.
      if (!fromAddressedBot) return false
      if (WeatherStoredForecast.isUnbundledPoint(message)) return true
      const asked = tables.point({ at: kind.point })
      const answered = tables.point({ at: message.point })
      if (asked == null || answered == null) return false
      return MeshWXGeo.distanceKilometres({
        fromLat: asked.lat, fromLon: asked.lon, toLat: answered.lat, toLon: answered.lon
      }) <= WeatherService.forecastSubstituteKilometres
    }
    if (kind.kind === 'text' && message.name === 'text') return message.subject === kind.subject
    if (kind.kind === 'coverage' && message.name === 'coverage') {
      // Nothing to check it against: a statement is about the bot that sent it, and only the
      // bot asked can answer this one (`acceptsAnswerFromAnyBot`).
      return true
    }
    if (kind.kind === 'areaSweep' && message.name === 'area_sweep') {
      // The first packet of the sweep settles the tap; the other seven keep flowing into state,
      // exactly as `>w`'s warnings do after its first message. Only the bot asked reaches here.
      //
      // The scope asked for is deliberately not checked: a bot that will not widen to advisories
      // answers the narrow sweep, and one that trims the state list still answered the tap. The
      // sweep's own flag and scope say what arrived, which is what the map reads.
      return true
    }
    if (kind.kind === 'radar' && message.name === 'radar') {
      // The tile and nothing else. Not `taken`: a bot with nothing newer answers with the
      // picture it already sent, and a phone that went on waiting for a fresher one would wait
      // out the quarter of an hour until the next picture is made. Not the bot either — this is
      // one of the requests any bot's answer settles (`acceptsAnswerFromAnyBot`), because the
      // lattice square is a square of the earth and the mosaic behind it is the same mosaic.
      return MeshWXRadarTile.isEqual(MeshWXRadar.tile(message), kind.tile)
    }
    if (kind.kind === 'parts' && (message.name === 'area_sweep' || message.name === 'text')) {
      // The bot replays the bytes it stamped with that group byte, whichever kind of answer they
      // came from: its cache is keyed by the group alone (spec §12, revision 10). Only the bot
      // asked holds that cache, so only it can answer. Which packet arrived is the caller's to
      // check against the indexes asked for.
      return fromAddressedBot && message.group === kind.group
    }
    return false
  }

  /**
   * The bundle's centre of one county or zone, `{ latitude, longitude }`, from the area-run
   * fields `{ state, county, number }`; null for an area the bundle does not know. What the
   * reducer judges a county against a bot's stated circle with (spec §5).
   */
  static areaCentres(tables) {
    return ({ state, county, number }) => {
      const code = tables?.stateCode?.(state)
      if (code == null) return null
      const ugc = `${code}${county ? 'C' : 'Z'}${MeshWXAreaRun.ugcDigits(number)}`
      const area = county ? tables.county(ugc) : tables.zone(ugc)
      if (area?.lat == null || area?.lon == null) return null
      return { latitude: area.lat, longitude: area.lon }
    }
  }

  // MARK: Persistence

  async #persist() {
    const now = this.now()
    for (const key of Object.keys(this.states)) {
      let state = this.states[key]
      state = WeatherStateReducer.pruneExpired(state, {
        expiredBefore: now - WeatherService.expiredWarningRetention * 1000
      }).state
      state = WeatherStateReducer.prunePendingUpgrades(state, {
        olderThan: now - WeatherService.pendingUpgradeRetention * 1000
      })
      state = WeatherService.trim(state, { now })
      this.states[key] = state
    }
    try {
      await this.store.save(this.states)
    } catch { /* a cache that cannot be written is still a cache */ }
  }

  /**
   * Keeps the per-bot collections bounded: every answer the channel carries is kept, whoever
   * asked, so all three have both an age and a ceiling — and what a screen is showing survives
   * both (`WeatherStateReducer`).
   */
  static trim(state, { now }) {
    let trimmed = WeatherStateReducer.pruneTexts(state, {
      receivedBefore: now - WeatherService.textRetention * 1000, limit: WeatherService.maxTextsPerBot
    })
    trimmed = WeatherStateReducer.pruneForecasts(trimmed, {
      receivedBefore: now - WeatherService.forecastRetention * 1000,
      limit: WeatherService.maxForecastsPerBot
    })
    // The reducer already keeps one reading per station; what grows is the number of stations,
    // one for every `>o <ICAO>` anyone on the channel has ever asked for. A station goes once it
    // has neither been in one of this bot's scheduled batches nor been heard at all in the
    // window — a reading nothing on screen would use, and no evidence of the bot's area either.
    const cutoff = now - WeatherService.observationRetention * 1000
    let observations = Object.fromEntries(
      Object.entries(trimmed.observations).filter(([, stored]) => {
        const lastBatchAt = stored.lastBatchMinutes == null
          ? Number.NEGATIVE_INFINITY
          : dateFromUnixMinutes(stored.lastBatchMinutes)
        return lastBatchAt >= cutoff || stored.receivedAt >= cutoff
      })
    )
    if (Object.keys(observations).length > WeatherService.maxObservationsPerBot) {
      // The bot's own area first, newest batch down: it outlives answers to one-off questions.
      const keep = new Set(
        Object.keys(observations)
          .sort((lhs, rhs) => {
            const left = observations[lhs]
            const right = observations[rhs]
            const leftBatch = left.lastBatchMinutes ?? 0
            const rightBatch = right.lastBatchMinutes ?? 0
            if (leftBatch !== rightBatch) return rightBatch - leftBatch
            if (left.receivedAt !== right.receivedAt) return right.receivedAt - left.receivedAt
            return Number(lhs) - Number(rhs)
          })
          .slice(0, WeatherService.maxObservationsPerBot)
      )
      observations = Object.fromEntries(
        Object.entries(observations).filter(([station]) => keep.has(station))
      )
    }
    return { ...trimmed, observations }
  }

  #serialised(work) {
    const run = this.queue.then(work, work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

/** `AnswerSlot`: the bot the answer must come from (null for any), and the answer key. */
function answerSlotKey(botID, key) {
  return `${botID == null ? '*' : botID}|${key}`
}

/**
 * The scope half of an area sweep's answer key for a sweep of the whole country. A literal
 * rather than the empty string, so "the country" and "no states I could name" are never one key.
 */
const NATIONAL_SWEEP_SCOPE = '*'

/** `areaSweep.TXOK` — the selection, as both sides of the rule spell it. */
function sweepSlot(scope) {
  return `areaSweep.${scope}`
}

/** `warningsTouching.TXC453` — one `>w <area>`, by the code asked, upper case. */
function warningsTouchingSlot(ugc) {
  return `warningsTouching.${String(ugc).toUpperCase()}`
}

/** `radar.32,-98,0` — the lattice square, as both sides of the rule spell it (spec §13). */
function radarSlot(tile) {
  return `radar.${MeshWXRadarTile.key(tile)}`
}

/** `Data` is a `Uint8Array`; hex strings are lower case without separators (PORTING.md §3). */
export function hex(bytes) {
  if (bytes == null) return ''
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesEqual(lhs, rhs) {
  if (lhs == null || rhs == null || lhs.length !== rhs.length) return false
  for (let index = 0; index < lhs.length; index += 1) {
    if (lhs[index] !== rhs[index]) return false
  }
  return true
}
