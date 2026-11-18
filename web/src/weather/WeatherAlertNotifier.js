// Port of MC1Services/Services/Weather/WeatherAlertNotifier.swift (docs/PORTING.md).

import { WeatherAlertNotification, WeatherAlertNotificationCopyRegistry, WeatherAlertNotificationSubject } from './WeatherAlertNotification.js'
import { isWatchEmpty } from './WeatherAlertWatchStore.js'
import { WeatherStateReducer } from './WeatherStateReducer.js'
import { identityKey } from './WeatherBotState.js'

/**
 * Turns the warnings arriving on `#meshwx` into notifications for the places the user watches
 * (docs/MESHWX_UI.md §16).
 *
 * It lives at service lifetime, beside `WeatherService`, and not on the tool's model: warnings
 * are broadcast whether or not the screen exists, the model lives for one visit to the tool, and
 * the whole point is a notification with the tool closed and the app in the background. Nothing
 * here asks the radio for anything — filtering a broadcast costs the mesh no airtime.
 *
 * Nothing is watched until a bell is turned on, so the common case is the first two lines of
 * `apply`: no warning in the message, or nothing watched, and the evaluator reads no state at
 * all.
 *
 * ## What is injected
 *
 * Everything the Swift reaches for directly, plus one thing it does not have to:
 *
 * - `states`: `async () => { [botID]: WeatherBotState }`, read fresh for each message — the
 *   reducer has already applied the warning by the time the event arrives.
 * - `events`: the service's `subscribe(fn) => unsubscribe`, subscribed to by `start()`.
 * - `watchStore`, `ledger`, `poster`, `geometry`, `loadGeometry`, `botName`, `tables`, `now`:
 *   as in Swift. `poster` is the notification mechanism, left as an interface (PORTING.md §7):
 *   `post(notification)`, `remove({ identifiers })`, `deliveredIdentifiers()`, `isAuthorized()`,
 *   all async.
 * - `rules`: **the deviation.** The decision rules the Swift calls straight out of `Screen/`
 *   live in `src/screen/`, and `weather` may not import `screen` (PORTING.md §9). They are
 *   handed over as one object, each entry the screen layer's function of the same name:
 *
 *       placement(warning, { at, geometry, tables })   WeatherAlertPlacement.place
 *       rank(warning, { tables })                      WeatherAlertPriority.rank
 *       delivery({ rank, placement, subscriptions })   WeatherAlertGate.delivery
 *       identifier({ botID, identity, placeID, tables })
 *       threadIdentifier({ placeID })
 *       decide({ warning, rank, placement, delivery, isBacklog, posted, isDelivered, now })
 *       record({ identifier, warning, placeID, botID, coversPlace, sound, posted, now })
 *       pruned(posts, { now })                         WeatherAlertNotificationRules.pruned
 *       watchedPlace({ saved })                        WeatherWatchedPlace.make(saved:)
 *       myLocationPlace(position, { label, now })      WeatherWatchedPlace.myLocation
 *       placeLabel({ near, tables })                   WeatherNames.placeLabel(near:tables:)
 */
export class WeatherAlertNotifier {
  constructor({
    states,
    events,
    watchStore,
    ledger,
    poster,
    geometry,
    loadGeometry = async () => {},
    botName = async () => null,
    tables,
    now,
    rules
  }) {
    this.states = states
    this.events = events
    this.watchStore = watchStore
    this.ledger = ledger
    this.poster = poster
    this.geometry = geometry
    this.loadGeometry = loadGeometry
    this.botName = botName
    this.tables = tables
    this.now = now
    this.rules = rules

    /** What this phone has posted, by request identifier. Loaded once, written on every change. */
    this.posts = {}
    this.isLoaded = false
    this.unsubscribe = null
    /** Bot names as they are looked up, so a night of warnings is one contact read. */
    this.names = {}
    /** Identities waiting on the county and zone outlines, and the message they arrived in. */
    this.awaitingGeometry = []
    this.isLoadingGeometry = false
    /** Work is serialised, as the Swift actor serialises it. */
    this.queue = Promise.resolve()
  }

  // MARK: - Lifecycle

  /** Subscribes to the weather service's events for this connection. */
  start() {
    this.stop()
    this.unsubscribe = this.events((event) => { void this.handle(event) })
  }

  stop() {
    if (this.unsubscribe != null) this.unsubscribe()
    this.unsubscribe = null
  }

  // MARK: - Ingest

  async handle(event) {
    if (event.kind !== 'received') return
    await this.apply({ botID: event.botID, changes: event.changes, isBacklog: event.isBacklog })
  }

  /** Applies one message's changes: what it ended, and what it said. */
  apply({ botID, changes, isBacklog }) {
    return this.#serialised(() => this.#applyUnlocked({ botID, changes, isBacklog }))
  }

  async #applyUnlocked({ botID, changes, isBacklog }) {
    const stored = []
    const ended = []
    const unlisted = []
    let listArrived = false
    for (const change of changes) {
      switch (change.kind) {
        case 'warningStored':
          stored.push(change.value)
          break
        case 'warningRemoved':
          ended.push(change.value)
          break
        case 'digestApplied':
          // A warning the list no longer carries has ended; one it never named was never received
          // and has no geometry, so it stays the dashboard's row and notifies nothing.
          unlisted.push(...change.removed)
          listArrived = true
          break
        default:
          break
      }
    }
    if (stored.length === 0 && ended.length === 0 && !listArrived) return
    this.#loadIfNeeded()
    if (unlisted.length > 0) {
      // One bot's list speaks for that bot's copy (spec §5): a warning another bot still holds
      // is still that bot's to end, by its own list, its cancel or the expiry.
      const states = await this.states()
      ended.push(...unlisted.filter((identity) => !isHeldByAnyBot(identity, states)))
    }
    if (ended.length > 0) await this.#withdraw(ended)

    const watch = this.watchStore.watch()
    if (isWatchEmpty(watch)) return
    // A list extends expiries, and the notification is the thing saying "until": re-read what has
    // already been posted. It announces nothing new — a warning is announced by its own message.
    const identities = new Map()
    for (const identity of stored) identities.set(identityKey(identity), identity)
    if (listArrived) {
      for (const post of Object.values(this.posts)) {
        identities.set(identityKey(post.identity), post.identity)
      }
    }
    if (identities.size === 0) return
    if (!(await this.poster.isAuthorized())) return

    const now = this.now()
    const places = this.#watchedPlaces(watch, { now })
    if (places.length === 0) return
    const states = await this.states()
    const delivered = await this.poster.deliveredIdentifiers()
    let changed = false
    const ordered = [...identities.values()].sort(WeatherStateReducer.identityOrder)
    for (const identity of ordered) {
      const didChange = await this.#evaluate(identity, {
        preferredBotID: botID,
        states,
        places,
        subscriptions: watch.subscriptions,
        isBacklog,
        delivered,
        now
      })
      changed = didChange || changed
    }
    if (changed) this.#persist()
  }

  /** One warning against every watched place. Returns whether anything was posted or removed. */
  async #evaluate(identity, { preferredBotID, states, places, subscriptions, isBacklog, delivered, now }) {
    const held = this.#held(identity, { preferredBotID, in: states })
    if (held == null) return false
    const warning = held.stored.warning
    const rank = this.rules.rank(warning, { tables: this.tables })
    let changed = false
    let needsOutlines = false

    for (const place of places) {
      const placement = this.rules.placement(warning, {
        at: place.place, geometry: this.geometry, tables: this.tables
      })
      if (placement.kind === 'checking') needsOutlines = true
      const posted = Object.values(this.posts).find(
        (post) => identityKey(post.identity) === identityKey(identity) && post.placeID === place.id
      ) ?? null
      const identifier = posted?.identifier ?? this.rules.identifier({
        botID: held.botID, identity, placeID: place.id, tables: this.tables
      })
      const coversPlace = placement.kind === 'here'
      const decision = this.rules.decide({
        warning,
        rank,
        placement,
        delivery: this.rules.delivery({ rank, placement, subscriptions }),
        isBacklog,
        posted,
        isDelivered: delivered.has(identifier),
        now
      })

      if (decision.kind === 'none') continue
      if (decision.kind === 'remove') {
        await this.poster.remove({ identifiers: [identifier] })
        delete this.posts[identifier]
        changed = true
        continue
      }
      const subject = WeatherAlertNotificationSubject.make({
        warning,
        placeLabel: place.place.label,
        placement,
        botName: await this.#name(held.botID),
        isLate: decision.isLate,
        now,
        // Revision 12: the copy's own start, else another bot's, as the alerts list reads it
        // (`WeatherAlertItems.make`): a bot older than revision 12 saying nothing is not a bot
        // saying the watch has begun.
        beginsAt: held.stored.beginsAt ?? firstStatedStart(identity, { in: states })
      })
      await this.poster.post(WeatherAlertNotification.make({
        identifier,
        threadIdentifier: this.rules.threadIdentifier({ placeID: place.id }),
        content: WeatherAlertNotificationCopyRegistry.current.content(subject, { tables: this.tables }),
        sound: decision.sound,
        identity,
        botID: posted?.botID ?? held.botID,
        placeID: place.id
      }))
      this.posts[identifier] = this.rules.record({
        identifier,
        warning,
        placeID: place.id,
        botID: posted?.botID ?? held.botID,
        coversPlace,
        sound: decision.sound,
        posted,
        now
      })
      changed = true
    }

    if (needsOutlines) {
      this.#waitForOutlines({ identity, botID: preferredBotID, isBacklog })
    }
    return changed
  }

  /**
   * Takes down what these warnings had posted. A cancellation removes the notification; nothing
   * takes its place, because "the warning ended" and "the weather is fine" are not the same
   * sentence and this phone can only know the first.
   */
  async #withdraw(identities) {
    const ended = new Set(identities.map(identityKey))
    const identifiers = Object.values(this.posts)
      .filter((post) => ended.has(identityKey(post.identity)))
      .map((post) => post.identifier)
    if (identifiers.length === 0) return
    await this.poster.remove({ identifiers })
    for (const identifier of identifiers) delete this.posts[identifier]
    this.#persist()
  }

  /**
   * The copy of a warning to judge: the bot the message came from, else whichever bot holds one.
   * Bots are read in a fixed order so two holding the same identity give the same answer twice.
   */
  #held(identity, { preferredBotID, in: states }) {
    const key = identityKey(identity)
    const preferred = states[String(preferredBotID)]?.warnings?.[key]
    if (preferred != null) return { botID: preferredBotID, stored: preferred }
    for (const botID of Object.keys(states).map(Number).sort((lhs, rhs) => lhs - rhs)) {
      const stored = states[String(botID)]?.warnings?.[key]
      if (stored != null) return { botID, stored }
    }
    return null
  }

  // MARK: - Places

  /**
   * The watched places, resolved for this moment: the saved ones as they were chosen, and the
   * phone's own position with the uncertainty its age has earned, so a fix from three hours ago
   * is matched generously rather than pretended to be current.
   */
  #watchedPlaces(watch, { now }) {
    const places = watch.places.map((saved) => this.rules.watchedPlace({ saved }))
    if (watch.myLocation != null) {
      const label = this.rules.placeLabel({
        near: { latitude: watch.myLocation.latitude, longitude: watch.myLocation.longitude },
        tables: this.tables
      }) ?? WeatherAlertNotificationCopyRegistry.current.myLocationLabel
      places.push(this.rules.myLocationPlace(watch.myLocation, { label, now }))
    }
    return places
  }

  // MARK: - Outlines

  /**
   * A warning with no polygon is placed by its counties and zones, which are megabytes of GeoJSON
   * loaded on demand. When they are not loaded yet the placement is "checking", which notifies
   * nothing, so the warning is parked and judged again once they are — once, and never in a
   * loop: with the outlines loaded no placement can come back as checking.
   */
  #waitForOutlines(pending) {
    const key = `${identityKey(pending.identity)}|${pending.botID}|${pending.isBacklog}`
    if (this.awaitingGeometry.some((held) => held.key === key)) return
    this.awaitingGeometry.push({ ...pending, key })
    if (this.isLoadingGeometry) return
    this.isLoadingGeometry = true
    void this.#serialised(() => this.#loadOutlinesAndRetry())
  }

  async #loadOutlinesAndRetry() {
    await this.loadGeometry()
    this.isLoadingGeometry = false
    const pending = this.awaitingGeometry
    this.awaitingGeometry = []
    if (!this.geometry.isLoaded || pending.length === 0) return
    const watch = this.watchStore.watch()
    if (isWatchEmpty(watch) || !(await this.poster.isAuthorized())) return
    const now = this.now()
    const places = this.#watchedPlaces(watch, { now })
    if (places.length === 0) return
    const states = await this.states()
    const delivered = await this.poster.deliveredIdentifiers()
    let changed = false
    for (const item of pending) {
      const didChange = await this.#evaluate(item.identity, {
        preferredBotID: item.botID,
        states,
        places,
        subscriptions: watch.subscriptions,
        isBacklog: item.isBacklog,
        delivered,
        now
      })
      changed = didChange || changed
    }
    if (changed) this.#persist()
  }

  // MARK: - Names

  async #name(botID) {
    const held = this.names[String(botID)]
    if (held != null) return held
    const name = await this.botName(botID)
    if (name == null) return null
    this.names[String(botID)] = name
    return name
  }

  // MARK: - Ledger

  #loadIfNeeded() {
    if (this.isLoaded) return
    this.isLoaded = true
    this.posts = this.rules.pruned(this.ledger.posts(), { now: this.now() })
  }

  #persist() {
    this.posts = this.rules.pruned(this.posts, { now: this.now() })
    this.ledger.save(this.posts)
  }

  #serialised(work) {
    const run = this.queue.then(work, work)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * The start stated by the first bot, in bot order, whose copy of `identity` carries one (spec §3,
 * revision 12), or null. The Swift's `states.keys.sorted()` walk.
 */
function firstStatedStart(identity, { in: states }) {
  const key = identityKey(identity)
  const botIDs = Object.keys(states ?? {}).map(Number).sort((lhs, rhs) => lhs - rhs)
  for (const botID of botIDs) {
    const beginsAt = states[String(botID)]?.warnings?.[key]?.beginsAt
    if (beginsAt != null) return beginsAt
  }
  return null
}

/** Whether any bot's state still holds `identity`. */
function isHeldByAnyBot(identity, states) {
  const key = identityKey(identity)
  return Object.values(states ?? {}).some((state) => state?.warnings?.[key] != null)
}
