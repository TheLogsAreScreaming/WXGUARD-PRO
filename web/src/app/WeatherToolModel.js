// Port of MC1/Views/Tools/Weather/WeatherToolModel.swift (docs/PORTING.md).

import { t } from '../l10n.js'
import { MeshWXGeometry, MeshWXTables, MeshWXWarningIdentity } from '../meshwx/index.js'
import {
  DefaultsWeatherAlertWatchStore,
  WeatherAlertNotificationTap,
  WeatherBot,
  WeatherLastPositionStore,
  WeatherPartsKind,
  WeatherRequest,
  WeatherRequestOutcome,
  WeatherSavedPlacesStore,
  WeatherService,
  WeatherTextAssembly,
} from '../weather/index.js'
import {
  WeatherAlertMapPicture,
  WeatherAlertRequests,
  WeatherAreaSelection,
  WeatherAreaSelectionStore,
  WeatherAreaSweepCost,
  WeatherPage,
  WeatherPages,
  WeatherPartsOffer,
  WeatherRequestLog,
  WeatherRequestLogEntry,
  WeatherRequestStatus,
  WeatherSavedPlace,
  WeatherSavedPlaces,
  WeatherSavedPlacesEdit,
  WeatherScreenSnapshot,
  WeatherSettledOutcome,
  WeatherTrafficSummary,
  WeatherUpdatePlan,
  WeatherUpdateRuns,
} from '../screen/index.js'
import { WeatherAlertNotificationRouting } from './WeatherAlertNotificationRouting.js'
import { WeatherAnswerNote, WeatherCopy, WeatherPlaceState } from './WeatherCopy.js'
import { WeatherReferenceNames } from './WeatherReferenceNames.js'
import { WeatherFormatting } from './WeatherFormatting.js'
import { WeatherDefaults } from './WeatherHost.js'
import { WeatherRequestLogStore } from './WeatherRequestLogStore.js'
import {
  WeatherBuildRequest,
  WeatherPageBuild,
  WeatherPlaceInput,
  WeatherScreenBuilder,
  WeatherScreenContext,
} from './WeatherScreenBuilder.js'

/**
 * Long-lived work the model owns, keyed by name, so starting one kind of work cancels the last of
 * that kind. Cancelled when the model goes, which is when the visit to the tool ends.
 *
 * Swift holds `Task`s; JS holds anything with a `cancel()` — a timer handle or a running async
 * step that checks its own flag.
 */
export class WeatherTaskHolder {
  constructor() {
    this.tasks = new Map()
  }

  replace(key, task) {
    this.tasks.get(key)?.cancel()
    this.tasks.set(key, task)
    return task
  }

  cancel(key) {
    this.tasks.get(key)?.cancel()
    this.tasks.delete(key)
  }

  cancelAll() {
    for (const task of this.tasks.values()) task.cancel()
    this.tasks.clear()
  }
}

/** What Places asked for, applied once its sheet has gone. */
export const WeatherPlacePickerAction = Object.freeze({
  place(value) {
    return { kind: 'place', value }
  },
  currentLocation: Object.freeze({ kind: 'currentLocation' }),
  /**
   * A weather station found by its airport code: it opens **that station's screen and nothing
   * else** (docs/MESHWX_UI.md §12, §3.1 U-3).
   *
   * It used to do three things at once — push the station, save a place, and make that place a
   * page — so typing KAUS produced a second page called "Austin" beside the one already there,
   * and TJSJ produced a page called "Eleanor Roosevelt". An airport code is a question about a
   * station, not a place someone wants to keep.
   */
  station({ index }) {
    return { kind: 'station', index }
  },
})

/**
 * A station screen to push, **and the page it was asked for from** (docs/MESHWX_UI.md §13).
 *
 * The page travels with the request. Without it the pager pushed whatever page it happened to be
 * on by the time the destination was built, which for a notification tap is the page being
 * switched *away* from: the tap selects the alert's own page and sets the alert in the same
 * turn, so a destination that reads "the page the pager is on" can be one page behind.
 */
export const WeatherStationTarget = Object.freeze({
  make({ pageID, index }) {
    return { pageID, index }
  },
})

/**
 * An alert to push, and the page it is to be judged against — "Covers Austin" is a sentence
 * about one place, and the map is framed on it.
 */
export const WeatherAlertTarget = Object.freeze({
  make({ pageID, identity }) {
    return { pageID, identity }
  },
})

/**
 * One page's own screen: the build made for that page, and the model behind it
 * (docs/MESHWX_UI.md §13).
 *
 * Every screen reached from a page is handed one of these rather than the model, so what it
 * shows is the place it was opened from and never whichever page the pager has since landed on.
 * The build is read back by page id while the model still holds it, so an answer that arrives
 * with a detail screen open shows on it.
 */
export class WeatherPageScreen {
  constructor({ model, opened }) {
    this.model = model
    /**
     * The build this screen was opened with, and what it falls back to if the page's build is
     * evicted from under a pushed screen.
     */
    this.opened = opened
  }

  get pageID() {
    return WeatherPageBuild.pageID(this.opened)
  }

  get build() {
    return this.model.build({ for: this.pageID }) ?? this.opened
  }

  get snapshot() {
    return this.build.snapshot
  }

  get context() {
    return this.build.context
  }

  get place() {
    return this.snapshot.place
  }

  get now() {
    return this.model.now
  }

  /** The place's name, "Austin, TX" — the one label every screen uses (§3.1 U-12). */
  get placeName() {
    const place = this.snapshot.place
    return place == null ? null : WeatherFormatting.placeName(place.label)
  }

  /**
   * The bot **this page** would ask. What a screen shows may have come from another one, and
   * then it is named from the item (`WeatherToolModel.botName`), not from here.
   */
  get sourceName() {
    const source = this.snapshot.source
    if (source == null) return t('weather.bot.generic')
    return WeatherFormatting.botName({ botID: source.botID, bot: source.bot })
  }

  // MARK: - Update (§11), per page

  get plan() {
    return this.model.plan({ for: this.pageID })
  }

  get isUpdating() {
    return this.model.isUpdating({ pageID: this.pageID })
  }

  get updateRequests() {
    return this.model.updateRequests({ pageID: this.pageID })
  }

  get updateStatusText() {
    return this.model.updateStatusText({ pageID: this.pageID })
  }

  // MARK: - Requests derived from this page's place

  /** The state storm reports and rainfall ask for on this page. */
  get reportState() {
    return this.model.reportState({ for: this.pageID })
  }

  alertsRequest({ for: status }) {
    return this.model.alertsRequest({ for: status, in: this.context })
  }

  get missingWarnings() {
    return this.context.sourceState?.missingFromDigest ?? []
  }

  get missingWarningsRequest() {
    return this.model.missingWarningsRequest({ in: this.context })
  }

  get missingNotAvailable() {
    return this.model.missingNotAvailable({ in: this.context })
  }
}

/**
 * The Weather tool's model: gathers the inputs, builds one `WeatherScreenSnapshot` **per page**
 * on defined triggers, and holds what the service does not — the place, request outcomes, and the
 * transient notices.
 *
 * ## Observing it
 *
 * `model.subscribe(fn) → unsubscribe`, fired at most once per animation frame (per microtask
 * under Node) whenever anything a screen can read has changed. That is the port of `@Observable`:
 * every property below is a plain property, read through the model, and every path that changes
 * one ends in the notify.
 *
 * ## Deviations from the Swift (docs/PORTING.md)
 *
 * - `AppState` is `WeatherHost`, one documented interface. `attach`, `appear`,
 *   `scenePhaseChanged`, `contactsChanged`, `channelSyncChanged`, `locationSampleChanged` and
 *   `authorizationChanged` are all still here, and the host's one `subscribe` calls them.
 * - The web's `WeatherService` exists from boot, connected or not, so the Swift's second path —
 *   reading the state file with no services — is gone, and with it `cachedOfflineStates` and
 *   `clearReceivedWeather`'s file branch.
 * - `WeatherPreferenceStore` was not in the port: the chosen bot is one value under
 *   `weather.preferredBotID` in the same synchronous defaults the other stores use.
 * - `Calendar`/`Locale` are `timeZone` (an IANA id) and `locale`, injected.
 * - The accessibility announcement is not `AccessibilityNotification`: a settled request sets
 *   `announcement`, which a screen renders into an `aria-live` region (PORTING §7 — the rule is
 *   ported, the iOS mechanism is not).
 * - Every timer is injected and cancellable, and `stop()` clears all of them.
 */
export class WeatherToolModel {
  /** Coalescing window for the rebuild, in seconds. */
  static debounce = 0.15
  /** How often the clock and the page are refreshed, in seconds. */
  static tick = 30
  /**
   * How old a neighbour's build may be before the next build of the page on screen refreshes it
   * too. Short enough that a swipe lands on current ages, long enough that a busy channel does
   * not rebuild three pages a second.
   */
  static neighbourFreshFor = 15
  static locatingWindow = 5
  /** A fix older than this is refreshed on "Back to my location". */
  static staleFixAge = 5 * 60

  constructor({
    host,
    tables = MeshWXTables.shared,
    geometry = MeshWXGeometry.shared,
    locale = undefined,
    timeZone = undefined,
    now = () => Date.now(),
    setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: unschedule = (id) => globalThis.clearTimeout(id),
    scheduleNotify = defaultScheduleNotify,
    builder = WeatherScreenBuilder,
    defaults = null,
    savedPlacesStore = null,
    watchStore = null,
    requestLogStore = null,
    lastPositionStore = null,
    areaSelectionStore = null,
    tap = WeatherAlertNotificationTap.shared,
  }) {
    this.host = host
    this.tables = tables
    this.geometry = geometry
    this.locale = locale
    this.timeZone = timeZone
    this.clock = now
    this.schedule = schedule
    this.unschedule = unschedule
    this.scheduleNotify = scheduleNotify
    this.builder = builder
    this.tap = tap

    /**
     * Where the device-local lists live. One store, read and written through
     * `WeatherSavedPlacesStore.apply`, so every edit lands on the list the browser actually holds
     * (docs/MESHWX_UI.md §3.1 U-1).
     */
    this.defaults = defaults ?? host.defaults ?? new WeatherDefaults({ kv: host.kv })
    this.savedPlacesStore =
      savedPlacesStore ?? new WeatherSavedPlacesStore({ defaults: this.defaults, places: WeatherSavedPlaces })
    this.watchStore =
      watchStore ?? new DefaultsWeatherAlertWatchStore({ defaults: this.defaults, places: WeatherSavedPlaces })
    this.requestLogStore =
      requestLogStore ?? new WeatherRequestLogStore({ defaults: this.defaults, now: this.clock })
    this.lastPositionStore = lastPositionStore ?? new WeatherLastPositionStore({ defaults: this.defaults })
    /** Which areas the alert map asks for, held on the device (docs/MESHWX_UI.md §17). */
    this.areaSelectionStore =
      areaSelectionStore ?? new WeatherAreaSelectionStore({ defaults: this.defaults })

    // MARK: - Published

    /**
     * One build per page, keyed by page id: the page the pager is on and the two it can be swiped
     * to next (docs/MESHWX_UI.md §13). Nothing beyond those is kept — a page further away cannot
     * be reached without passing one of them, and it is rebuilt by the time it is.
     */
    this.builds = {}
    this.placeState = WeatherPlaceState.needsPermission
    this.searchedPlace = null
    /**
     * The places kept in Places, in the order Places holds them. Held on the device, not for the
     * visit (docs/MESHWX_UI.md §5); each is a page of the pager, after My location.
     */
    this.savedPlaces = []
    /**
     * The page the pager is on. Kept for the visit, so a pushed screen and a reflow both come back
     * to the place the user was looking at.
     */
    this.selectedPageID = WeatherPage.myLocationID
    /**
     * Whose Update run is on the air and what each page's last one asked for. One run at a time,
     * and the spinner and the caption belong to the page that started it.
     */
    this.updateRuns = WeatherUpdateRuns.make()
    /**
     * A station screen Places asked to open, pushed once the sheet has gone. Set by picking an
     * airport code, which names a station rather than a town (docs/MESHWX_UI.md §12).
     */
    this.stationToOpen = null
    /** An alert screen a tapped notification asked for, pushed the same way (§16). */
    this.alertToOpen = null
    /**
     * Which warnings the device is to be told about, and whether its own position is watched.
     * Nothing is on until the user turns a bell on.
     */
    this.subscriptions = { watchesMyLocation: false, notifiesOtherWarnings: false, notifiesTornadoNearby: false }
    /**
     * Set by a bell tapped while the browser has notifications turned off, so the screen can say
     * so and offer its settings rather than turning on a bell that would never ring.
     */
    this.showsNotificationsDenied = false
    /**
     * When this visit saw the radio go: the notifications screen says since when nothing can
     * arrive, and only when it actually knows.
     */
    this.radioDisconnectedAt = null
    /**
     * The label last resolved for the device's own place. Kept while a searched place is on
     * screen, so the picker's "My location" row can name it instead of saying the app is locating
     * when nothing is (docs/MESHWX_UI.md §12).
     */
    this.currentLocationLabel = null
    /** Requests on the air, as the service's events report them. Builds never write this. */
    this.pending = []
    /**
     * A request's last outcome, keyed by its `>` line, each `{ outcome, at, request }`. The
     * `request` is the one addition to the Swift's `[WeatherRequest: WeatherSettledOutcome]`: a
     * JS key is a string, and `notAvailableIdentities` needs the request back out.
     */
    this.outcomes = {}
    this.answerNotes = {}
    /**
     * What this device has put on the air, newest first, and how each request ended
     * (docs/MESHWX_UI.md §12). Kept across visits: the answers were broadcast to everyone, so only
     * the asking is this app's to remember.
     */
    this.requestLog = []
    /** The request refused inside the five-second spacing, while its notice shows. */
    this.rateLimitedRequest = null
    this.preferredBotID = null
    /**
     * The link the weather transport provides of its own, when it has one. Only a bridge to a real
     * bot does: it is a live connection to that one bot with no radio in it at all, so while it is
     * there the radio reads as connected and the bot it names is announced, though no contact
     * carries its advert. Null over a radio, always.
     */
    this.transportLink = null
    this.isAddingChannel = false
    /**
     * The connect-time channel sync has finished for the connected radio. Until then the app's
     * channel table may be empty, and "#meshwx isn't set up" would be a guess.
     */
    this.isChannelSyncDone = false
    this.now = 0
    this.errorMessage = null
    /**
     * The state storm reports and rainfall ask for, per page, when the user changed it this visit.
     * Picking Texas on one page never sends `>storm TX` for another place's page.
     */
    this.reportStateOverrides = {}
    /** A pick from the place picker, applied when its sheet has closed. */
    this.pendingPlaceAction = null
    /**
     * Why the pull that just happened sent nothing, while it is worth saying
     * (docs/MESHWX_UI.md §3.1 U-6). A gesture that silently does nothing reads as broken.
     */
    this.blockedPullNotice = null
    /** Bumped with every blocked pull, so the haptic fires again on a second one. */
    this.blockedPullCount = 0
    /** The last position the app knows, read back from where the notifier reads it. */
    this.myLocationPosition = null
    /** 'notDetermined' | 'authorized' | 'denied' | 'unsupported'. */
    this.notificationsAuthorization = 'notDetermined'
    /** What a settled request would have VoiceOver say: `{ text, id }`, for an `aria-live` region. */
    this.announcement = null

    // MARK: - Private

    this.holder = null
    this.listeners = new Set()
    this.isNotifyScheduled = false
    this.cancelNotify = null
    this.hostUnsubscribe = null
    this.locationUnsubscribe = null
    this.serviceUnsubscribe = null
    this.trafficUnsubscribe = null
    this.subscribedService = null
    this.hasSubscribed = false
    this.placeSample = null
    /**
     * The device's own newest fix, whatever place is on screen: Places names it and shows what is
     * held for it even while a saved place is showing.
     */
    this.latestSample = null
    this.locatingUntil = null
    this.isSceneActive = true
    this.isRebuildScheduled = false
    this.isBuilding = false
    this.isBuildingNeighbours = false
    this.needsAnotherBuild = false
    this.hasRequestedGeometry = false
    this.hasStartedLocation = false
    this.fingerprints = {}
    this.inFlightByWire = new Map()
    /** Per page, so swiping back does not repeat the 35,000-place label lookup. */
    this.placeFacts = {}
    this.stationTowns = {}
    this.announcementCount = 0
    this.lastContacts = null
    this.lastChannels = null
    this.lastRadioConnected = null
    this.lastVisible = null
  }

  // MARK: - Observation

  /** Registers an observer. Returns the function that unregisters it. */
  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Every mutation path ends here; the notify itself is coalesced. */
  changed() {
    if (this.isNotifyScheduled) return
    this.isNotifyScheduled = true
    this.cancelNotify = this.scheduleNotify(() => {
      this.isNotifyScheduled = false
      this.cancelNotify = null
      for (const fn of [...this.listeners]) fn(this)
    })
  }

  // MARK: - Derived

  /** One page's build, while it is held. */
  build({ for: pageID }) {
    return this.builds[pageID] ?? null
  }

  /** One page as a screen: what every drill-in is handed. Null until that page's first build lands. */
  screen({ for: pageID }) {
    const build = this.builds[pageID]
    return build == null ? null : new WeatherPageScreen({ model: this, opened: build })
  }

  /** The page the pager is on, as a screen. */
  get currentScreen() {
    return this.screen({ for: this.selectedPageID })
  }

  /**
   * The page the pager is on. For the screens that are about the *visit* rather than about a
   * page — Places and the notifications screen — and for the pending bar, which speaks for the
   * one radio. A screen reached from a page reads its own `WeatherPageScreen` instead.
   */
  get snapshot() {
    return this.builds[this.selectedPageID]?.snapshot ?? null
  }

  get context() {
    return this.builds[this.selectedPageID]?.context ?? WeatherScreenContext.make()
  }

  /** The bot the page the pager is on would ask. */
  get sourceName() {
    const source = this.snapshot?.source
    if (source == null) return t('weather.bot.generic')
    return WeatherFormatting.botName({ botID: source.botID, bot: source.bot })
  }

  /**
   * The name of the bot something actually came from: an item carries its own `botID`, and a
   * screen that shows somebody's item names that bot rather than the one this page would ask.
   */
  botName(botID) {
    const bots = this.builds[this.selectedPageID]?.context.bots ?? Object.values(this.builds)[0]?.context.bots ?? []
    return WeatherFormatting.botName({
      botID,
      bot: bots.find((bot) => WeatherBot.botID(bot) === botID) ?? null,
    })
  }

  /** The place's name, "Austin, TX", for the page the pager is on. */
  get placeName() {
    const place = this.snapshot?.place
    return place == null ? null : WeatherFormatting.placeName(place.label)
  }

  get isRadioConnected() {
    return this.host.isRadioConnected === true
  }

  /** The requests being sent, in the order they were started. */
  get inFlight() {
    return [...this.inFlightByWire.values()]
  }

  /** The request the pending bar speaks for: one on the air, else one being sent. */
  get activeRequest() {
    return this.pending[0]?.request ?? this.inFlight[0] ?? null
  }

  /** The last time any weather radio was heard live, not drained from your radio's queue. */
  get liveHeardAt() {
    const heard = this.context.botRows.map((row) => row.lastLiveHeardAt).filter((one) => one != null)
    return heard.length === 0 ? null : Math.max(...heard)
  }

  /** The pages the pager swipes through: My location, then the saved places in Places' order. */
  get pages() {
    return WeatherPages.make({ saved: this.savedPlaces })
  }

  /**
   * A complete reply to this very request, owned by this device and under five minutes old:
   * asking again would have the bot rebuild the same reply on everyone's airtime (spec §19), so
   * the answer stands in for the button.
   */
  freshOwnedReply({ for: request }) {
    if (WeatherRequest.expectedReply(request).kind !== 'text') return null
    return (
      this.snapshot?.texts.find((item) =>
        WeatherToolModel.isFreshOwnedReply(item.assembly, { for: request, now: this.now }),
      ) ?? null
    )
  }

  static isFreshOwnedReply(assembly, { for: request, now }) {
    return (
      assembly.request != null &&
      WeatherRequest.isEqual(assembly.request, request) &&
      WeatherTextAssembly.isComplete(assembly) &&
      (now - assembly.lastReceivedAt) / 1000 < WeatherService.recentAnswerWindow
    )
  }

  // MARK: - Lifecycle

  /**
   * Starts the visit: reads the device-local stores, subscribes to the host and to location, and
   * starts the clock. Idempotent, and awaited because the stores hydrate from IndexedDB.
   */
  async start() {
    if (this.holder != null) {
      await this.attach()
      return this
    }
    this.holder = new WeatherTaskHolder()
    await this.defaults.hydrate?.()
    this.preferredBotID = this.defaults.get('weather.preferredBotID')
    this.adopt(this.savedPlacesStore.places)
    this.subscriptions = this.watchStore.subscriptions
    this.requestLog = this.requestLogStore.entries
    this.now = this.clock()
    this.isChannelSyncDone = this.host.isChannelSyncDone === true
    this.notificationsAuthorization = this.host.notifications?.authorization ?? 'unsupported'
    this.lastContacts = this.host.contacts
    this.lastChannels = this.host.channels
    this.lastRadioConnected = this.host.isRadioConnected
    this.lastVisible = this.host.isVisible !== false
    this.isSceneActive = this.lastVisible
    // The app's notification copy, and where a tapped notification goes. Installed here because
    // the tool is what a tap opens and the poster reaches the model through the host; a shell
    // that can bring the tool forward itself calls `install({ open })`, which replaces this.
    if (!WeatherAlertNotificationRouting.isInstalled) {
      WeatherAlertNotificationRouting.install({ tap: this.tap, notifications: this.host.notifications ?? null })
    }
    this.hostUnsubscribe = this.host.subscribe(() => this.hostChanged())
    this.locationUnsubscribe = this.host.location?.subscribe((service) =>
      this.locationSampleChanged(service.latestSample),
    )
    this.startTicking()
    await this.attach()
    this.appear()
    this.changed()
    return this
  }

  /**
   * Binds to the current service. Safe to repeat, and never undone by a disappearance.
   *
   * The Swift's `attach(appState:)`: it is what notices the services being replaced, and what
   * dates a disconnection.
   */
  async attach() {
    const service = this.host.weatherService ?? null
    // Only a disconnection this visit is dated: with the tool opened after one, the app does not
    // know when the radio went, and the row says so without inventing a time.
    if (!this.host.isRadioConnected) {
      if (this.hasSubscribed && this.radioDisconnectedAt == null) this.radioDisconnectedAt = this.clock()
    } else {
      this.radioDisconnectedAt = null
    }
    if (!this.hasSubscribed || service !== this.subscribedService) {
      this.hasSubscribed = true
      this.subscribedService = service
      this.subscribeToService(service)
      this.pending = service == null ? [] : service.pendingRequests()
      // Asked before the first build: a transport that is its own link says so from the start, so
      // the tool is never briefly "connect your radio" over a bridge that is up.
      this.transportLink = service == null ? null : await service.transportLink()
    } else {
      // On the phone the service is rebuilt per connection, so asking once per service is enough.
      // Here the service outlives its links (a radio, then the bridge, then the recording): the
      // link is the connection's and is asked again with it, without holding up this build.
      void this.refreshTransportLink()
    }
    this.scheduleRebuild()
    this.changed()
  }

  /**
   * The place is decided on arrival: a searched place stays; otherwise the device's fix, or up to
   * five seconds of "Locating…" when authorized with no fix yet. Coming back from a pushed screen
   * keeps the place unless there is a meaningfully newer fix.
   */
  appear() {
    const location = this.host.location
    this.latestSample = WeatherToolModel.sample(location?.latestSample ?? null)
    if (this.searchedPlace == null) {
      if (
        this.latestSample != null &&
        (this.placeSample == null ||
          WeatherToolModel.isMeaningfulChange({ from: this.placeSample, to: this.latestSample }))
      ) {
        this.placeSample = this.latestSample
      }
      if (this.isLocationAuthorized) {
        this.requestFixIfStale()
        if (this.placeSample == null) this.startLocating(WeatherToolModel.locatingWindow)
      }
    }
    this.takeTappedAlert()
    this.updatePlaceState()
    this.scheduleRebuild()
    this.changed()
  }

  /** Ends the visit: every timer, subscription and running step goes. */
  stop() {
    this.holder?.cancelAll()
    this.holder = null
    this.cancelNotify?.()
    this.cancelNotify = null
    this.isNotifyScheduled = false
    this.hostUnsubscribe?.()
    this.hostUnsubscribe = null
    this.locationUnsubscribe?.()
    this.locationUnsubscribe = null
    this.serviceUnsubscribe?.()
    this.serviceUnsubscribe = null
    this.trafficUnsubscribe?.()
    this.trafficUnsubscribe = null
    this.subscribedService = null
    this.hasSubscribed = false
  }

  /**
   * The host changed. One subscription stands in for the Swift's half-dozen `onChange`s, so this
   * is where the change is sorted into which of them it was.
   */
  hostChanged() {
    if (this.holder == null) return
    const visible = this.host.isVisible !== false
    if (visible !== this.lastVisible) {
      this.lastVisible = visible
      this.scenePhaseChanged(visible)
    }
    if (this.host.isChannelSyncDone !== this.isChannelSyncDone) {
      this.channelSyncChanged({ isDone: this.host.isChannelSyncDone === true })
    }
    if (this.host.contacts !== this.lastContacts || this.host.channels !== this.lastChannels) {
      this.lastContacts = this.host.contacts
      this.lastChannels = this.host.channels
      this.contactsChanged()
    }
    if (
      this.host.weatherService !== this.subscribedService ||
      this.host.isRadioConnected !== this.lastRadioConnected
    ) {
      this.lastRadioConnected = this.host.isRadioConnected
      void this.attach()
      return
    }
    this.scheduleRebuild()
    this.changed()
  }

  startTicking() {
    this.holder?.replace(
      'tick',
      this.every(WeatherToolModel.tick, () => this.tickFired()),
    )
  }

  tickFired() {
    this.now = this.clock()
    this.scheduleRebuild()
    this.refreshTransportLinkIfNeeded()
    this.changed()
  }

  /** The transport's link as it is now; rebuilds only when it names another bot, or none. */
  async refreshTransportLink() {
    const service = this.host.weatherService
    const link = service == null ? null : await service.transportLink().catch(() => null)
    const botOf = (value) => (value?.bot == null ? null : WeatherBot.botID(value.bot))
    if (botOf(link) === botOf(this.transportLink) && (link == null) === (this.transportLink == null)) return
    this.transportLink = link
    this.scheduleRebuild()
    this.changed()
  }

  /**
   * Asks again for the transport's own link while there is none: a bot bridge may have come up
   * after this visit started, and its bot is what the tool would then ask. Over a radio the answer
   * is null every time.
   */
  refreshTransportLinkIfNeeded() {
    const service = this.host.weatherService
    if (this.transportLink != null || service == null) return
    this.holder?.replace(
      'transportLink',
      this.task(async (state) => {
        const link = await service.transportLink()
        if (state.cancelled || link == null) return
        this.transportLink = link
        this.scheduleRebuild()
        this.changed()
      }),
    )
  }

  /** No tick while the page is hidden; a refresh as soon as it is visible again. */
  scenePhaseChanged(isVisible) {
    if (this.holder == null) return
    if (isVisible === this.isSceneActive) return
    this.isSceneActive = isVisible
    if (isVisible) {
      this.now = this.clock()
      // A notification tapped while the tool was already open brings the page forward without
      // bringing this root back.
      this.takeTappedAlert()
      this.startTicking()
      this.scheduleRebuild()
    } else {
      this.holder?.cancel('tick')
    }
    this.changed()
  }

  contactsChanged() {
    this.scheduleRebuild()
  }

  channelSyncChanged({ isDone }) {
    if (isDone === this.isChannelSyncDone) return
    this.isChannelSyncDone = isDone
    this.scheduleRebuild()
    this.changed()
  }

  // MARK: - Events

  subscribeToService(service) {
    this.serviceUnsubscribe?.()
    this.serviceUnsubscribe = null
    this.trafficUnsubscribe?.()
    this.trafficUnsubscribe = null
    if (service == null) return
    this.serviceUnsubscribe = service.subscribe((event) => {
      void this.handle(event, service)
    })
    // The traffic screen is a chat, so it has to move as the channel does — and a datagram the
    // service ignored (another phone's request, a body the codec refuses) fires nothing else.
    // `changed()` is coalesced, so a burst of packets is still one repaint.
    this.trafficUnsubscribe = service.trafficLog?.subscribe?.(() => this.changed()) ?? null
  }

  async handle(event, service) {
    switch (event.kind) {
      case 'stateLoaded':
      case 'received':
        this.scheduleRebuild()
        break
      case 'requestSent':
      case 'requestReceivedByBotRadio': {
        const entry = event.value
        this.pending = [...this.pending.filter((one) => one.id !== entry.id), entry]
        this.pending = service.pendingRequests()
        this.changed()
        break
      }
      case 'requestSettled': {
        const entry = event.value
        const outcome = event.value2
        const wire = WeatherRequest.wireText(entry.request)
        this.now = this.clock()
        this.pending = this.pending.filter((one) => one.id !== entry.id)
        this.outcomes = {
          ...this.outcomes,
          [wire]: { ...WeatherSettledOutcome.make({ outcome, at: this.now }), request: entry.request },
        }
        this.settleRequestLog({ id: entry.id, outcome })
        if (outcome.kind === 'answered') {
          const before = this.fingerprints[wire]
          if (before != null) {
            delete this.fingerprints[wire]
            const after = WeatherToolModel.fingerprint(entry.request, {
              sourceBotID: entry.botID,
              states: await service.allStates(),
              tables: this.tables,
            })
            this.answerNotes[wire] =
              after?.value === before.value ? WeatherAnswerNote.unchanged(before.kind) : WeatherAnswerNote.changed
          }
        }
        this.pending = service.pendingRequests()
        this.announce(entry.request)
        this.scheduleRebuild()
        this.changed()
        break
      }
      default:
        break
    }
  }

  announce(request) {
    const text = this.statusText({ for: request })
    if (text == null) return
    this.announcementCount += 1
    this.announcement = { text, id: this.announcementCount }
  }

  // MARK: - Rebuild

  /**
   * Coalesces a burst of triggers into one build 150 ms later; a trigger during a build runs
   * one more build after it.
   */
  scheduleRebuild() {
    if (this.holder == null) return
    if (this.isBuilding) {
      this.needsAnotherBuild = true
      return
    }
    if (this.isRebuildScheduled) return
    this.isRebuildScheduled = true
    this.holder.replace(
      'rebuild',
      this.after(WeatherToolModel.debounce, () => {
        void this.rebuild()
      }),
    )
  }

  /**
   * Builds the page the pager is on, then its neighbours. Drains a trigger that arrived during
   * the build on **every** exit, including the ones that build nothing.
   */
  async rebuild() {
    this.isRebuildScheduled = false
    try {
      if (this.holder == null) return
      this.isBuilding = true
      // The page as it is now: the user can swipe while the build runs, and the snapshot that
      // comes back belongs to the page it was asked about, not to wherever the pager has landed.
      const pageID = this.selectedPageID
      const request = this.buildRequest({ pageID })
      const result = await this.builder.build(request)
      this.apply(result, { for: request, isSelected: pageID === this.selectedPageID })
      this.buildNeighbours()
    } finally {
      this.isBuilding = false
      if (this.needsAnotherBuild) {
        this.needsAnotherBuild = false
        this.scheduleRebuild()
      }
    }
  }

  /**
   * The two pages a swipe can reach next, built so the page they are swiped to is already there.
   * This is what closes the window in which the title named one place and the screen still held
   * another's (docs/MESHWX_UI.md §13).
   */
  buildNeighbours() {
    // One neighbour run at a time, never cancelled and restarted: a busy channel rebuilds the
    // page on screen several times a second, and a pre-build that was started over every time
    // would never finish. What it misses, the next rebuild picks up.
    if (this.isBuildingNeighbours) return
    const wanted = WeatherPages.neighbours({ of: this.selectedPageID, in: this.pages }).filter((pageID) => {
      const built = this.builds[pageID]
      if (built == null) return true
      // Kept fresh as well as warm: a neighbour built ten minutes ago and swiped to would show
      // ten-minute-old ages for as long as its rebuild takes.
      return (this.now - built.snapshot.now) / 1000 >= WeatherToolModel.neighbourFreshFor
    })
    if (wanted.length === 0) return
    const requests = wanted.map((pageID) => this.buildRequest({ pageID }))
    this.isBuildingNeighbours = true
    this.holder?.replace(
      'neighbours',
      this.task(async (state) => {
        try {
          for (const request of requests) {
            if (state.cancelled) return
            const result = await this.builder.build(request)
            if (state.cancelled) return
            this.apply(result, { for: request, isSelected: false })
          }
        } finally {
          this.isBuildingNeighbours = false
        }
      }),
    )
  }

  /**
   * What one page is built from. Everything but the place is the visit's; the place is the
   * page's own, which is why a build can be asked for a page the pager is not on.
   */
  buildRequest({ pageID }) {
    return WeatherBuildRequest.make({
      weatherService: this.host.weatherService ?? null,
      preferredBotID: this.preferredBotID,
      pageID,
      place: this.placeInput({ for: pageID }),
      isRadioConnected: this.host.isRadioConnected === true,
      // With a link of its own the transport is the connection, whatever Bluetooth is doing:
      // the build treats the radio as connected and the link's bot as announced.
      transportLink: this.transportLink,
      isChannelSyncDone: this.isChannelSyncDone,
      firmwareSupportsWeather: this.host.firmwareSupportsWeather ?? null,
      firmwareVersion: this.host.firmwareVersion ?? '',
      now: this.clock(),
      timeZone: this.timeZone,
      locale: this.locale,
      contacts: this.host.contacts ?? [],
      channels: this.host.channels ?? [],
      placeFacts: this.placeFacts[pageID] ?? null,
      stationTowns: this.stationTowns,
      tables: this.tables,
      geometry: this.geometry,
    })
  }

  /**
   * The place a page answers for: the saved place it *is*, or the device's own fix for My
   * location. Read from the pages rather than from `searchedPlace`, so a page the pager is not
   * on can be built.
   */
  placeInput({ for: pageID }) {
    const saved = this.savedPlaces.find((one) => WeatherSavedPlace.id(one) === pageID)
    if (saved != null) return WeatherPlaceInput.searched(WeatherSavedPlace.place(saved))
    if (pageID === WeatherPage.myLocationID && this.placeSample != null) {
      return WeatherPlaceInput.location(this.placeSample)
    }
    if (pageID === this.selectedPageID && this.searchedPlace != null) {
      return WeatherPlaceInput.searched(this.searchedPlace)
    }
    return WeatherPlaceInput.none
  }

  /**
   * @param isSelected this build is the page the pager is on. Only that one moves the clock, the
   *   place state and the label Places shows for the device's own position; a neighbour built in
   *   the background changes nothing the user is looking at.
   */
  apply(result, { for: request, isSelected }) {
    this.builds = { ...this.builds, [request.pageID]: result.page }
    this.evictDistantBuilds()
    if (isSelected) this.now = result.page.snapshot.now
    this.placeFacts[request.pageID] = result.placeFacts
    if (request.place.kind === 'location' && result.placeFacts.label != null) {
      this.currentLocationLabel = result.placeFacts.label
    }
    this.stationTowns = result.stationTowns
    if (isSelected) this.updatePlaceState()

    if (result.page.context.needsGeometry && !this.hasRequestedGeometry) {
      this.hasRequestedGeometry = true
      this.holder?.replace(
        'geometry',
        this.task(async (state) => {
          await this.geometry.preload()
          if (state.cancelled) return
          this.scheduleRebuild()
        }),
      )
    }
    this.changed()
  }

  /**
   * Three builds are kept: the page on screen and the two a swipe can reach. The place facts are
   * kept for every page — they are small, they are what makes swiping back free, and they are
   * keyed by the place they were computed for, so a place that moves recomputes them anyway.
   */
  evictDistantBuilds() {
    const keep = new Set(WeatherPages.neighbours({ of: this.selectedPageID, in: this.pages }))
    keep.add(this.selectedPageID)
    this.builds = Object.fromEntries(Object.entries(this.builds).filter(([pageID]) => keep.has(pageID)))
  }

  // MARK: - Place

  get isLocationAuthorized() {
    return this.host.location?.authorization === 'authorized'
  }

  /**
   * The Swift's `AppState.requestPhoneFixIfStale()`. The browser's only path to a fix that cannot
   * raise a prompt is the watch `LocationService.start()` sets up when permission is already
   * granted, so that is what this is — started once per visit.
   */
  requestFixIfStale() {
    if (this.hasStartedLocation || this.host.location == null) return
    this.hasStartedLocation = true
    void this.host.location.start()
  }

  locationSampleChanged(rawSample) {
    if (this.holder == null) return
    const sample = WeatherToolModel.sample(rawSample)
    this.latestSample = sample
    this.changed()
    if (this.searchedPlace != null || sample == null) return
    if (this.placeSample != null && !WeatherToolModel.isMeaningfulChange({ from: this.placeSample, to: sample })) {
      return
    }
    this.placeSample = sample
    this.endLocating()
    this.scheduleRebuild()
  }

  authorizationChanged() {
    if (this.holder == null) return
    if (this.isLocationAuthorized && this.searchedPlace == null && this.placeSample == null) {
      this.requestFixIfStale()
      this.startLocating(WeatherToolModel.locatingWindow)
    }
    this.updatePlaceState()
    this.changed()
  }

  // MARK: - Pages (§4)

  /**
   * The page on screen, swiped to or picked in Places.
   *
   * It never reorders the list: pages moving under a swiping finger is exactly what a "newest
   * first" sort would do. Changing page sends nothing — Update and the pull say what they would
   * ask for (docs/MESHWX_UI.md §3.1 O-1, overturned).
   */
  showPage(id) {
    const pages = this.pages
    const resolved = WeatherPages.selection(id, { in: pages })
    const page = pages.find((one) => WeatherPage.id(one) === resolved) ?? WeatherPage.myLocation
    const wasOn = this.selectedPageID
    this.selectedPageID = resolved
    const saved = WeatherPage.savedPlace(page)
    if (saved != null) {
      const place = WeatherSavedPlace.place(saved)
      if (wasOn === resolved && JSON.stringify(this.searchedPlace) === JSON.stringify(place)) {
        this.changed()
        return
      }
      this.searchedPlace = place
      this.endLocating()
    } else {
      if (wasOn === resolved && this.searchedPlace == null) {
        this.changed()
        return
      }
      this.searchedPlace = null
      if (this.latestSample != null) this.placeSample = this.latestSample
      // Swiping back to My location never asks for permission: only a tap does (§16).
      if (this.isLocationAuthorized) {
        this.requestFixIfStale()
        if (this.placeSample == null) this.startLocating(WeatherToolModel.locatingWindow)
      }
      this.updatePlaceState()
    }
    this.scheduleRebuild()
    this.changed()
  }

  /**
   * A place from Places: kept on the device, and shown.
   *
   * A place already on the list **keeps its position** (`WeatherSavedPlaces.remember`). Tapping
   * Round Rock to look at it is not a request to reorder the pager, and moving it to the front
   * silently overwrote an order the user had dragged into place (docs/MESHWX_UI.md §3.1 U-4).
   */
  pick(saved) {
    const chosen = { ...saved, chosenAt: this.clock() }
    this.write(WeatherSavedPlacesEdit.remember(chosen))
    this.showPage(WeatherSavedPlace.id(chosen))
  }

  /** Swiped away in Places. Its page goes with it — and its bell: they are one row. */
  removeSavedPlace({ id }) {
    this.write(WeatherSavedPlacesEdit.remove({ id }))
    if (this.selectedPageID === id) this.showPage(WeatherPage.myLocationID)
  }

  /**
   * Dragged in Places. The pages follow the list, so the dots and the sheet always agree.
   *
   * The drag is turned into the order it produced, **by id**: the list on the device may hold a
   * place this sheet was never shown, and an index would then move somebody else's row.
   */
  moveSavedPlaces({ fromOffsets, toOffset }) {
    const moved = WeatherSavedPlaces.moving({ fromOffsets, toOffset, in: this.savedPlaces })
    this.write(WeatherSavedPlacesEdit.reorder({ ids: moved.map(WeatherSavedPlace.id) }))
  }

  /**
   * The one way the saved list changes (docs/MESHWX_UI.md §3.1 U-1).
   *
   * The edit is **applied to the list the store holds**, never to this model's copy. The model's
   * copy is empty until `start` has read the store, and a pick in that window used to persist a
   * one-place list over everything saved: on a real phone four places became one, renamed and
   * moved to an airport's coordinates. `WeatherSavedPlacesStore.apply` also refuses any write
   * that would drop a place nobody asked to drop.
   */
  write(edit) {
    this.adopt(this.savedPlacesStore.apply(edit))
  }

  /**
   * The saved list as the pages now stand.
   *
   * Every path that changes it comes through here — a bell, a removal, a drag, a pick, and the
   * re-read the notifications screen does on every appearance. A selection left pointing at a
   * page that is gone is a page that can never be built, which is a spinner that never ends on
   * *every* page until the next swipe.
   */
  adopt(places) {
    if (JSON.stringify(places) === JSON.stringify(this.savedPlaces)) return
    this.savedPlaces = places
    this.healSelection()
    this.changed()
  }

  /**
   * Resolves the selection through the pages and writes it back. Nothing else ever leaves
   * `selectedPageID` naming a page that is not there.
   */
  healSelection() {
    const resolved = WeatherPages.selection(this.selectedPageID, { in: this.pages })
    if (resolved === this.selectedPageID) return
    this.showPage(resolved)
  }

  // MARK: - Alert notifications (§16)

  /**
   * The device's own position is watched. The position itself is whatever fix the app last took,
   * which can be hours old; every row that shows it shows its age.
   */
  get isMyLocationWatched() {
    return this.subscriptions.watchesMyLocation
  }

  /** The saved places with their bell on. */
  get watchedPlaces() {
    return this.savedPlaces.filter((place) => place.isWatched)
  }

  get isWatchingAnything() {
    return this.isMyLocationWatched || this.watchedPlaces.length > 0
  }

  isWatched({ placeID }) {
    return this.savedPlaces.find((one) => WeatherSavedPlace.id(one) === placeID)?.isWatched ?? false
  }

  /**
   * Turns one saved place's bell on or off. It adds and removes no row: the pages are exactly
   * what they were before the tap.
   */
  async setWatch(isOn, { forPlaceID }) {
    if (isOn && !(await this.ensureNotificationPermission())) return
    this.write(WeatherSavedPlacesEdit.watch(isOn, { id: forPlaceID }))
  }

  /**
   * Turns the bell on My location on or off. The fix the tool already holds is written as the
   * starting position: the store keeps one only while this is on, so there is none to read.
   */
  async setMyLocationWatch(isOn) {
    if (isOn && !(await this.ensureNotificationPermission())) return
    this.applySubscriptions({ ...this.subscriptions, watchesMyLocation: isOn })
    const sample = this.latestSample ?? this.placeSample
    if (isOn && sample != null) {
      this.lastPositionStore.record({
        latitude: sample.latitude,
        longitude: sample.longitude,
        horizontalAccuracy: sample.horizontalAccuracy,
        timestamp: sample.timestamp,
        places: WeatherSavedPlaces,
      })
    }
    this.myLocationPosition = isOn ? this.lastPositionStore.position : null
    this.changed()
  }

  setOtherWarnings(isOn) {
    this.applySubscriptions({ ...this.subscriptions, notifiesOtherWarnings: isOn })
  }

  setTornadoNearby(isOn) {
    this.applySubscriptions({ ...this.subscriptions, notifiesTornadoNearby: isOn })
  }

  applySubscriptions(updated) {
    this.subscriptions = updated
    this.watchStore.subscriptions = updated
    this.changed()
  }

  /**
   * Re-reads what is watched and what the browser allows: the screens that show it are opened and
   * left, and permission can change in the browser's own settings while the page is away.
   */
  async refreshWatchState() {
    this.subscriptions = this.watchStore.subscriptions
    // Through the same door as every other change: the re-read can bring back a list this visit
    // has already changed, and the page on screen must survive it.
    this.adopt(this.savedPlacesStore.places)
    this.myLocationPosition = this.subscriptions.watchesMyLocation ? this.lastPositionStore.position : null
    this.notificationsAuthorization = this.host.notifications?.authorization ?? 'unsupported'
    if (this.notificationsAuthorization !== 'denied') this.showsNotificationsDenied = false
    this.changed()
  }

  /**
   * The one moment notification permission is asked for: the user turning on their first bell
   * (docs/MESHWX_UI.md §16). Never on opening the tool, and a bell the browser would silence is
   * not turned on — the screen says so instead.
   */
  async ensureNotificationPermission() {
    const notifications = this.host.notifications
    const status = notifications?.authorization ?? 'unsupported'
    this.notificationsAuthorization = status
    if (status === 'authorized') {
      this.changed()
      return true
    }
    if (status === 'notDetermined') {
      const granted = (await notifications.request()) === true
      this.notificationsAuthorization = granted ? 'authorized' : 'denied'
      this.showsNotificationsDenied = !granted
      this.changed()
      return granted
    }
    this.showsNotificationsDenied = true
    this.changed()
    return false
  }

  /**
   * The alert a tapped notification asked for, if the tap is recent and this is the screen it
   * was waiting for (docs/MESHWX_UI.md §16).
   *
   * The notification was raised for one watched place, and it says so: the pager goes to that
   * place's page first, so "Covers Austin" and the map's framing are computed for the place the
   * warning was matched against rather than for whatever page happened to be open.
   */
  takeTappedAlert() {
    const target = this.tap?.take({ now: this.clock() })
    if (target == null) return
    const wanted = WeatherPages.pageID({ forWatchedPlaceID: target.placeID })
    const pageID = this.pages.some((page) => WeatherPage.id(page) === wanted) ? wanted : this.selectedPageID
    if (pageID !== this.selectedPageID) this.showPage(pageID)
    // The page goes with the alert. Selecting the page and naming the alert happen in one turn,
    // so a destination that read "the page the pager is on" could be built against the page being
    // left (docs/MESHWX_UI.md §3.1 U-18).
    this.alertToOpen = WeatherAlertTarget.make({ pageID, identity: target.identity })
    this.changed()
  }

  /** Back to the device's location; a stale fix is refreshed, with "Locating…" meanwhile. */
  backToMyLocation() {
    this.selectedPageID = WeatherPage.myLocationID
    this.searchedPlace = null
    if (this.latestSample != null) this.placeSample = this.latestSample
    if (this.isLocationAuthorized) {
      const isStale =
        this.placeSample == null ||
        (this.clock() - this.placeSample.timestamp) / 1000 > WeatherToolModel.staleFixAge
      if (isStale) {
        this.requestFixIfStale()
        this.startLocating(WeatherToolModel.locatingWindow)
      }
    }
    this.updatePlaceState()
    this.scheduleRebuild()
    this.changed()
  }

  /**
   * Applies the picker's pick. Returns true when it needs "Use my location", which may ask for
   * permission: the caller decides whether that is safe now.
   */
  applyPendingPlaceAction({ isLocationAuthorized }) {
    const action = this.pendingPlaceAction
    if (action == null) return false
    this.pendingPlaceAction = null
    switch (action.kind) {
      case 'place':
        this.pick(action.value)
        return false
      case 'currentLocation':
        if (!isLocationAuthorized) {
          this.changed()
          return true
        }
        this.backToMyLocation()
        return false
      default:
        // The station's screen, over the page the user was already on. No page is added, the pager
        // does not move, and nothing is saved (docs/MESHWX_UI.md §3.1 U-3).
        this.stationToOpen = WeatherStationTarget.make({ pageID: this.selectedPageID, index: action.index })
        this.changed()
        return false
    }
  }

  /**
   * A pull the radio cannot answer: the reason, in the bar at the bottom, for a few seconds.
   *
   * Long enough to read and short enough not to become furniture — the reason is already in the
   * caption at the top of the list, and this is only the gesture admitting it did nothing.
   */
  noteBlockedPull(reason) {
    this.blockedPullNotice = reason
    this.blockedPullCount += 1
    const count = this.blockedPullCount
    this.holder?.replace(
      'blockedPull',
      this.after(4, () => {
        if (this.blockedPullCount !== count) return
        this.blockedPullNotice = null
        this.changed()
      }),
    )
    this.changed()
  }

  /** The one path that may ask for location permission: the user's tap. */
  async useMyLocation() {
    const location = this.host.location
    if (location == null) return
    this.selectedPageID = WeatherPage.myLocationID
    this.searchedPlace = null
    if (this.latestSample != null) this.placeSample = this.latestSample
    this.startLocating(45)
    this.scheduleRebuild()
    this.changed()
    const fix = WeatherToolModel.sample(await location.request())
    if (fix != null) {
      this.latestSample = fix
      if (this.searchedPlace == null) this.placeSample = fix
    }
    this.endLocating()
    this.scheduleRebuild()
    this.changed()
  }

  /** "Update location" for a last-known place. */
  updateLocation() {
    if (!this.isLocationAuthorized) return
    void this.host.location.request()
    this.startLocating(WeatherToolModel.locatingWindow)
  }

  startLocating(seconds) {
    this.locatingUntil = this.clock() + seconds * 1000
    this.updatePlaceState()
    this.holder?.replace(
      'locating',
      this.after(seconds, () => this.endLocating()),
    )
    this.changed()
  }

  endLocating() {
    this.locatingUntil = null
    this.holder?.cancel('locating')
    this.updatePlaceState()
    this.changed()
  }

  updatePlaceState() {
    const location = this.host.location
    if (location == null) return
    if (this.searchedPlace != null) {
      this.placeState = WeatherPlaceState.resolved
    } else if (this.locatingUntil != null && this.locatingUntil > this.clock()) {
      this.placeState = WeatherPlaceState.locating
    } else if (this.placeSample != null) {
      this.placeState = this.snapshot?.place != null ? WeatherPlaceState.resolved : WeatherPlaceState.locating
    } else if (location.authorization === 'denied') {
      this.placeState = WeatherPlaceState.denied
    } else if (location.authorization === 'notDetermined') {
      this.placeState = WeatherPlaceState.needsPermission
    } else {
      this.placeState = WeatherPlaceState.unavailable
    }
  }

  /** A fix with a usable coordinate, or null: the port of `CLLocationCoordinate2DIsValid`. */
  static sample(fix) {
    if (fix == null) return null
    const { latitude, longitude } = fix
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
    return {
      latitude,
      longitude,
      horizontalAccuracy: fix.horizontalAccuracy ?? -1,
      timestamp: fix.timestamp,
    }
  }

  /**
   * A new fix replaces the place's only when it says something new: a minute newer, half a
   * kilometre away, or far more accurate. A survey stream delivering a fix a second would
   * otherwise rebuild the screen every second.
   */
  static isMeaningfulChange({ from: old, to: fresh }) {
    if ((fresh.timestamp - old.timestamp) / 1000 >= 60) return true
    const moved = distanceKilometres(old, fresh)
    if (moved >= 0.5) return true
    return (
      fresh.horizontalAccuracy >= 0 &&
      (old.horizontalAccuracy < 0 || fresh.horizontalAccuracy < old.horizontalAccuracy / 2)
    )
  }

  // MARK: - Requests

  status({ for: request }) {
    return WeatherToolModel.status({
      for: request,
      snapshot: this.snapshot,
      pending: this.pending,
      inFlight: this.inFlight,
      outcomes: this.outcomes,
      now: this.now,
    })
  }

  /**
   * A request's status from the model's parts. Only a missing snapshot means no bot is known yet:
   * a snapshot whose `requestBlock` is null can be asked.
   */
  static status({ for: request, snapshot, pending, inFlight, outcomes, now }) {
    const effective = [...pending]
    const onAir = new Set(pending.map((one) => WeatherRequest.wireText(one.request)))
    for (const sending of inFlight) {
      const wire = WeatherRequest.wireText(sending)
      if (onAir.has(wire)) continue
      effective.push({ request: sending, botID: 0, botPublicKey: new Uint8Array(0), sentAt: now, attempt: 0 })
    }
    const block = snapshot == null ? 'noBot' : snapshot.requestBlock
    return WeatherRequestStatus.resolve({ request, block, pending: effective, outcomes, now })
  }

  /**
   * @param source the bot the screen asking is talking to. The page the pager is on by default,
   *   which is what the pending bar speaks for; a screen with a page of its own names that page's
   *   bot.
   */
  statusText({ for: request, source = null }) {
    if (this.rateLimitedRequest != null && WeatherRequest.isEqual(this.rateLimitedRequest, request)) {
      return t('weather.request.rateLimited')
    }
    return WeatherCopy.requestStatus(this.status({ for: request }), {
      source: source ?? this.sourceName,
      request,
      answer: this.answerNotes[WeatherRequest.wireText(request)] ?? null,
      now: this.now,
      timeZone: this.timeZone,
      locale: this.locale,
    })
  }

  /**
   * @param queued part of an Update run. The one-at-a-time rule is for buttons a user taps; a
   *   planned run keeps its own five-second spacing and would otherwise refuse every step after
   *   the first while the first is still on the air.
   */
  async send(request, { queued = false } = {}) {
    const service = this.host.weatherService
    const source = this.snapshot?.source ?? null
    // The announced bot, or a stand-in for one only heard on the channel (`heardOnly`).
    const bot = source == null ? null : WeatherScreenSnapshot.Source.requestBot(source)
    if (service == null || bot == null) return
    const status = this.status({ for: request })
    switch (status.kind) {
      case 'idle':
      case 'settled':
        break
      case 'waitingForOther':
        if (queued) break
        return
      default:
        return
    }
    const wire = WeatherRequest.wireText(request)
    const botID = WeatherBot.botID(bot)
    this.beginRequest(request)
    const token = newToken()
    const before = WeatherToolModel.fingerprint(request, {
      sourceBotID: botID,
      states: await service.allStates(),
      tables: this.tables,
    })
    if (before != null) {
      this.recordFingerprint({ token, value: before.value, kind: before.kind }, { for: request })
    }
    try {
      const entry = await service.send(request, { to: bot })
      if (entry != null) {
        if (!this.pending.some((one) => one.id === entry.id)) this.pending = [...this.pending, entry]
        this.recordRequest({ id: entry.id, request, botID, at: entry.sentAt })
      } else {
        this.clearFingerprint({ for: request, token })
      }
    } catch (error) {
      this.clearFingerprint({ for: request, token })
      if (error?.name === 'WeatherRequestError' && error.kind === 'rateLimited') {
        this.rateLimitedRequest = request
        this.holder?.replace(
          'rateLimit',
          this.after(WeatherService.requestSpacing, () => {
            if (this.rateLimitedRequest == null || !WeatherRequest.isEqual(this.rateLimitedRequest, request)) return
            this.rateLimitedRequest = null
            this.changed()
          }),
        )
      } else if (error?.name === 'WeatherRequestError') {
        this.now = this.clock()
        this.outcomes = {
          ...this.outcomes,
          [wire]: {
            ...WeatherSettledOutcome.make({ outcome: WeatherRequestOutcome.failed(error.reason), at: this.now }),
            request,
          },
        }
        // Nothing reached the air, but the user did ask: the log says the radio would not send it.
        this.recordRequest({
          id: newToken(),
          request,
          botID,
          at: this.now,
          outcome: WeatherRequestLogEntry.Outcome.refused,
        })
      } else {
        this.now = this.clock()
        this.outcomes = {
          ...this.outcomes,
          [wire]: {
            ...WeatherSettledOutcome.make({
              outcome: WeatherRequestOutcome.failed(String(error?.message ?? error)),
              at: this.now,
            }),
            request,
          },
        }
      }
    }
    this.endRequest(request)
  }

  /**
   * Marks a request as being sent, before the first suspension, and clears what its button last
   * said.
   */
  beginRequest(request) {
    const wire = WeatherRequest.wireText(request)
    this.inFlightByWire.set(wire, request)
    delete this.outcomes[wire]
    delete this.answerNotes[wire]
    this.rateLimitedRequest = null
    this.changed()
  }

  endRequest(request) {
    this.inFlightByWire.delete(WeatherRequest.wireText(request))
    this.changed()
  }

  // MARK: - Request log (§12)

  /**
   * Records a request this device has just put on the air. Only what actually went out: an answer
   * the five-minute rule served from the channel spent no airtime and was nobody's request.
   */
  recordRequest({ id, request, botID, at, outcome = null }) {
    this.requestLog = WeatherRequestLog.recording(
      WeatherRequestLogEntry.make({ id, request, botID, sentAt: at, outcome }),
      { in: this.requestLog, now: this.clock() },
    )
    this.requestLogStore.entries = this.requestLog
    this.changed()
  }

  /**
   * Fills in how a request ended. `alreadyReceived` never gets here with a logged id: nothing
   * was sent, so nothing was recorded.
   */
  settleRequestLog({ id, outcome }) {
    let settled
    switch (outcome.kind) {
      case 'answered': settled = WeatherRequestLogEntry.Outcome.answered; break
      case 'timedOut': settled = WeatherRequestLogEntry.Outcome.noAnswer; break
      case 'notAvailable': settled = WeatherRequestLogEntry.Outcome.notAvailable; break
      case 'failed': settled = WeatherRequestLogEntry.Outcome.refused; break
      default: return
    }
    const updated = WeatherRequestLog.settling({ id, outcome: settled, in: this.requestLog })
    if (JSON.stringify(updated) === JSON.stringify(this.requestLog)) return
    this.requestLog = updated
    this.requestLogStore.entries = updated
    this.changed()
  }

  recordFingerprint(fingerprint, { for: request }) {
    this.fingerprints[WeatherRequest.wireText(request)] = fingerprint
  }

  /** Clears a fingerprint only if it is the one this call recorded. */
  clearFingerprint({ for: request, token }) {
    const wire = WeatherRequest.wireText(request)
    if (this.fingerprints[wire]?.token !== token) return
    delete this.fingerprints[wire]
  }

  /**
   * What an answer to a request would replace, to tell an answer that changed nothing from one
   * that did. Null for a request whose answer the device does not keep in a comparable form.
   *
   * Swift finalises a `Hasher`; a JS fingerprint is a **string** built from the same fields in the
   * same order (docs/PORTING.md §3: a 64-bit hash that is only ever compared becomes a string
   * key). `value` is that string, or a number where Swift used one.
   */
  static fingerprint(request, { sourceBotID, states, tables = MeshWXTables.shared }) {
    const values = Object.values(states)
    switch (request.kind) {
      case 'forecast': {
        const issued = values
          .map((state) => state.forecasts?.[String(request.point)]?.forecast?.issued_min)
          .filter((one) => one != null)
        return { value: issued.length === 0 ? null : Math.max(...issued), kind: WeatherAnswerNote.Kind.forecast }
      }
      case 'observations': {
        // What a batch would replace: the newest scheduled batch held, whatever single-station
        // answers have since landed on top of individual stations.
        const batches = values.flatMap((state) =>
          Object.values(state.observations ?? {})
            .map((stored) => stored.lastBatchMinutes)
            .filter((one) => one != null),
        )
        return { value: batches.length === 0 ? null : Math.max(...batches), kind: WeatherAnswerNote.Kind.readings }
      }
      case 'observation': {
        const index = tables.stationIndex({ forICAO: request.station })
        if (index == null) return null
        const times = values
          .map((state) => state.observations?.[String(index)]?.timestampMinutes)
          .filter((one) => one != null)
        return { value: times.length === 0 ? null : Math.max(...times), kind: WeatherAnswerNote.Kind.readings }
      }
      case 'digest': {
        const digest = states[String(sourceBotID)]?.digest
        return { value: digest == null ? null : digest.digest.now_min, kind: WeatherAnswerNote.Kind.other }
      }
      case 'activeWarnings':
      case 'warning':
      case 'warningsTouching': {
        const held = values
          .flatMap((state) => Object.values(state.warnings ?? {}))
          .sort((lhs, rhs) => compareIdentity(lhs.warning, rhs.warning))
        const parts = held.map(
          (stored) =>
            `${MeshWXWarningIdentity.key(MeshWXWarningIdentity.of(stored.warning))}:${stored.warning.expires_min}:${stored.updateCount}`,
        )
        parts.push(String(values.reduce((total, state) => total + Object.keys(state.pendingUpgrades ?? {}).length, 0)))
        return { value: parts.join('|'), kind: WeatherAnswerNote.Kind.other }
      }
      default: {
        if (WeatherRequest.expectedReply(request).kind !== 'text') return null
        // Only replies that answered this request: somebody else's reply on the same subject is
        // not an answer to this device.
        const texts = []
        for (const [key, state] of Object.entries(states)) {
          const botID = Number(key)
          for (const assembly of Object.values(state.texts ?? {})) {
            if (assembly.request == null || !WeatherRequest.isEqual(assembly.request, request)) continue
            texts.push({ botID, assembly })
          }
        }
        texts.sort((lhs, rhs) =>
          lhs.botID !== rhs.botID ? lhs.botID - rhs.botID : lhs.assembly.group - rhs.assembly.group,
        )
        if (texts.length === 0) return { value: null, kind: WeatherAnswerNote.Kind.other }
        const value = texts
          .map(
            ({ botID, assembly }) =>
              `${botID}:${assembly.group}:${Object.keys(assembly.chunks ?? {}).length}:${assembly.total}`,
          )
          .join('|')
        return { value, kind: WeatherAnswerNote.Kind.other }
      }
    }
  }

  // MARK: - Request arguments (derived from the place, never from held data)

  /**
   * "Ask for alerts" for the status the card shows, chosen from the source bot's own state.
   *
   * Every one of these takes the page's own context: a `>w <county>` for the county the *page*
   * is in, never for the county of whatever page the pager last built.
   */
  alertsRequest({ for: status, in: context }) {
    if (status.kind !== 'missedMessages' || context.sourceState == null) return WeatherRequest.digest
    return WeatherAlertRequests.missedMessages({
      source: context.sourceState,
      placeCountyUGC: context.placeCounty?.ugc ?? null,
      placeOffice: context.placeOffice,
      notAvailable: this.missingNotAvailable({ in: context }),
      tables: this.tables,
    })
  }

  /**
   * The request for the warnings the list named that never arrived ("Listed, not received ·
   * Ask"): one warning per tap, the most important the bot has not already said it lacks.
   */
  missingWarningsRequest({ in: context }) {
    if (context.sourceState == null) return null
    return WeatherAlertRequests.missingWarnings({
      source: context.sourceState,
      placeOffice: context.placeOffice,
      notAvailable: this.missingNotAvailable({ in: context }),
      tables: this.tables,
    })
  }

  /** Missing warnings the source bot answered "not available" for since its current list arrived. */
  missingNotAvailable({ in: context }) {
    return WeatherToolModel.notAvailableIdentities({
      outcomes: this.outcomes,
      since: context.sourceState?.digest?.receivedAt ?? null,
      tables: this.tables,
    })
  }

  /**
   * The identities of `>w <identity>` requests refused as not available at or after `since`, the
   * arrival of the list that named them: a newer list can name one again, and then it is asked
   * for again.
   *
   * Swift's `Set<MeshWXWarningIdentity>` is an array without duplicates (docs/PORTING.md §3).
   */
  static notAvailableIdentities({ outcomes, since = null, tables = MeshWXTables.shared }) {
    const found = new Map()
    for (const settled of Object.values(outcomes)) {
      const request = settled.request
      if (request == null || request.kind !== 'warning') continue
      if (settled.outcome.kind !== 'notAvailable') continue
      if (settled.at < (since ?? -Infinity)) continue
      const identity = WeatherAlertRequests.identity({ from: request.identity, tables })
      if (identity == null) continue
      found.set(MeshWXWarningIdentity.key(identity), identity)
    }
    return [...found.values()]
  }

  // MARK: - Alert map (§17), channel traffic and the request list
  //
  // Everything these screens read, and nothing else. Each of these is one pure rule
  // called with this page's build and this model's clock, so a screen never assembles state
  // itself — which is how a page came to draw one place's map under another place's name.

  /**
   * The alert map for a page: every sweep the source bot has sent, resolved into one picture
   * (`WeatherAlertMapPicture`). `parts` is one status line each, newest first; `entries` is what
   * to shade; `coversWholeCountry` says whether the card may speak for a state nothing named.
   */
  alertMapPicture({ pageID = this.selectedPageID } = {}) {
    const sweeps = this.builds[pageID]?.context?.sourceState?.areaSweeps ?? []
    return WeatherAlertMapPicture.make({ sweeps, states: this.tables.states, now: this.now })
  }

  /**
   * Which areas the next map should cover, held on the device. Defaults to the state of the
   * page's own place, and to the whole country for a page with no place: a phone that has never
   * touched the picker asks about where it is.
   */
  areaSelection({ pageID = this.selectedPageID } = {}) {
    return this.areaSelectionStore.selection({
      defaultStateCode: this.builds[pageID]?.context?.placeStateCode ?? null,
    })
  }

  /** Keeps a pick from the state picker. */
  setAreaSelection(selection) {
    this.areaSelectionStore.setSelection(selection)
    this.changed()
  }

  /** The request one tap on the ask button would send, for the selection this page is showing. */
  areaSweepRequest({ pageID = this.selectedPageID, includesAdvisories = false } = {}) {
    return WeatherAreaSelection.request(this.areaSelection({ pageID }), { includesAdvisories })
  }

  /**
   * What that tap would spend, in packets, measured against what this phone already holds. The
   * one request in the grammar whose cost is on the button before it is spent.
   */
  areaSweepCost({ pageID = this.selectedPageID, includesAdvisories = false } = {}) {
    return WeatherAreaSweepCost.packets({
      for: this.areaSelection({ pageID }),
      advisories: includesAdvisories,
      held: this.alertMapPicture({ pageID }),
      tables: this.tables,
    })
  }

  /**
   * The `>part` offer for each sweep with a hole in it, keyed by the sweep's group byte as a
   * string, so a status line can find its own. Empty for a sweep whose newest packet is under
   * 15 s old (the bot's own resend has not had its chance) or whose first is over ten minutes
   * old (the bot no longer holds the bytes).
   */
  sweepPartsOffers({ pageID = this.selectedPageID } = {}) {
    const sweeps = this.builds[pageID]?.context?.sourceState?.areaSweeps ?? []
    const offers = {}
    for (const sweep of sweeps) {
      const request = WeatherPartsOffer.make({
        assembly: sweep, kind: WeatherPartsKind.areaSweep, now: this.now,
      })
      if (request != null) offers[String(sweep.group)] = request
    }
    return offers
  }

  /** The same offer for one text reply, for the report screen's "Ask for the missing part". */
  textPartsOffer({ assembly }) {
    if (assembly == null) return null
    return WeatherPartsOffer.make({
      assembly,
      kind: WeatherPartsKind.text({ subject: assembly.subject }),
      now: this.now,
    })
  }

  /**
   * The channel traffic timeline: every datagram on the weather slot and every Request this
   * device sent, **oldest first**, each with the words for its bubble.
   *
   * Owner, 20 September 2026: *"A way to see all the GRP_DATA traffic on a channel like we do a
   * chat."* So it is the traffic, not this app's opinion of it: a duplicate, somebody else's
   * request and a datagram the codec refuses are all here, labelled.
   */
  trafficEntries() {
    const log = this.host?.weatherService?.trafficLog
    if (log == null) return []
    return log.entries().map((entry) => ({
      entry,
      // The state names are handed in: they are proper nouns the bundle does not carry, and the
      // pure layer that words a row may not reach into this one (docs/PORTING.md §9).
      summary: WeatherTrafficSummary.make({
        entry, tables: this.tables, stateName: WeatherReferenceNames.stateName,
      }),
    }))
  }

  /** The screen's Clear action, and nothing else. */
  clearTraffic() {
    this.host?.weatherService?.trafficLog?.clear()
    this.changed()
  }

  /**
   * *Your requests* on the radio page: the newest three, and the whole list behind them.
   *
   * Owner, 20 September 2026: *"Your requests is way too long of a list."* The card shows
   * `newest`; "All requests (27)" pushes `all`.
   */
  get requestLogSplit() {
    return { newest: this.requestLog.slice(0, 3), all: this.requestLog }
  }

  // MARK: - Update (§11)

  /**
   * What one tap on Update on **that page** would ask for, from what the device is actually
   * missing for that place.
   *
   * Empty until the page has a build, which is what disables the button in the swipe window: a
   * tap there would otherwise send the previous place's requests under the new place's name.
   */
  plan({ for: pageID }) {
    const build = this.builds[pageID]
    if (build == null) return WeatherUpdatePlan.empty
    const context = build.context
    return WeatherUpdatePlan.make({
      snapshot: build.snapshot,
      sourceState: context.sourceState,
      placeCountyUGC: context.placeCounty?.ugc ?? null,
      placeZoneUGC: context.placeZoneUGC,
      placeOffice: context.placeOffice,
      nearbyStation: context.nearbyStation,
      notAvailable: this.missingNotAvailable({ in: context }),
      coverageAlreadyAsked: this.hasAskedCoverage,
      tables: this.tables,
      now: this.now,
    })
  }

  /**
   * Whether this device has already asked what the bot covers on this visit, however that ended.
   * One packet: a statement never goes stale, and a bot that did not answer must not be asked
   * again on every tap (docs/MESHWX_UI.md §11.1).
   */
  get hasAskedCoverage() {
    const wire = WeatherRequest.wireText(WeatherRequest.coverage)
    return (
      this.outcomes[wire] != null ||
      this.inFlightByWire.has(wire) ||
      this.pending.some((one) => WeatherRequest.wireText(one.request) === wire)
    )
  }

  /** The same, for one station's own screen, from the page that screen was opened from. */
  updatePlan({ forStation: index, in: snapshot }) {
    return WeatherUpdatePlan.make({
      stationReading: snapshot.readings.find((reading) => reading.index === index) ?? null,
      icao: this.tables.station({ at: index })?.icao ?? null,
      now: this.now,
    })
  }

  /**
   * The requests one page's last run put on the air, and whether that run is still going. Both
   * are per page: one place's requests never narrate another place's caption, and a page being
   * swiped past does not spin because its neighbour is asking for something.
   */
  updateRequests({ pageID }) {
    return WeatherUpdateRuns.requests(this.updateRuns, { pageID })
  }

  isUpdating({ pageID }) {
    return WeatherUpdateRuns.isRunning(this.updateRuns, { pageID })
  }

  /**
   * What that page's Update control says about the run it started: the request on the air, else
   * the last of that run's requests to settle. Null once every outcome has aged out.
   */
  updateStatusText({ pageID }) {
    const requests = this.updateRequests({ pageID })
    if (requests.length === 0) return null
    const wires = new Set(requests.map((one) => WeatherRequest.wireText(one)))
    if (this.rateLimitedRequest != null && wires.has(WeatherRequest.wireText(this.rateLimitedRequest))) {
      return this.statusText({ for: this.rateLimitedRequest })
    }
    const live =
      this.pending.find((one) => wires.has(WeatherRequest.wireText(one.request)))?.request ??
      this.inFlight.find((one) => wires.has(WeatherRequest.wireText(one))) ??
      null
    if (live != null) return this.statusText({ for: live })
    let settled = null
    for (const request of requests) {
      const outcome = this.outcomes[WeatherRequest.wireText(request)]
      if (outcome == null) continue
      if (settled == null || settled.at < outcome.at) settled = { request, at: outcome.at }
    }
    if (settled == null || (this.now - settled.at) / 1000 >= WeatherRequestStatus.outcomeLifetime) return null
    return this.statusText({ for: settled.request })
  }

  /** One tap sends that page's plan, five seconds apart. */
  update(plan, { pageID }) {
    this.startUpdate(plan, { pageID })
  }

  /**
   * Pull-to-refresh: the same planner as the button, awaited so the pull's own spinner lasts as
   * long as the run (docs/MESHWX_UI.md §11.1). With nothing to ask for it sends nothing, and the
   * caption above the list says so.
   */
  async refresh({ pageID }) {
    await this.startUpdate(this.plan({ for: pageID }), { pageID })?.promise
  }

  /**
   * The one Update run there is. A pull and a tap go through the same tracked task, so they can
   * never run at once — and a run already going is never cancelled by the second one, whose
   * cleanup would otherwise clear the live run's spinner.
   */
  startUpdate(plan, { pageID }) {
    if (this.holder == null) return null
    const begun = WeatherUpdateRuns.begin(this.updateRuns, { pageID, requests: WeatherUpdatePlan.requests(plan) })
    if (!begun.started) return null
    this.updateRuns = begun.runs
    this.changed()
    const handle = this.task((state) => this.runUpdate(plan, { pageID, state }))
    this.holder.replace('update', handle)
    return handle
  }

  async runUpdate(plan, { pageID, state }) {
    try {
      const requests = WeatherUpdatePlan.requests(plan)
      for (let offset = 0; offset < requests.length; offset += 1) {
        if (offset > 0) {
          // The service refuses a second request inside the window (spec §14, §19): the steps are
          // queued rather than fired together.
          await this.sleep(WeatherService.requestSpacing)
          if (state.cancelled) return
        }
        await this.sendPlanned(requests[offset], { state })
      }
    } finally {
      this.updateRuns = WeatherUpdateRuns.end(this.updateRuns, { pageID })
      this.changed()
    }
  }

  /**
   * A step refused inside the spacing waits it out once rather than being dropped: another
   * request of the user's own can land between two steps.
   */
  async sendPlanned(request, { state }) {
    await this.send(request, { queued: true })
    if (this.rateLimitedRequest == null || !WeatherRequest.isEqual(this.rateLimitedRequest, request)) return
    await this.sleep(WeatherService.requestSpacing)
    if (state.cancelled) return
    if (this.rateLimitedRequest == null || !WeatherRequest.isEqual(this.rateLimitedRequest, request)) return
    await this.send(request, { queued: true })
  }

  /**
   * The state storm reports and rainfall ask for on one page: the page's own state, or the one
   * the user picked **on that page**. An override is one place's answer to "which state", and
   * carrying it across the pager sent `>storm TX` for a page in Puerto Rico.
   */
  reportState({ for: pageID }) {
    return this.reportStateOverrides[pageID] ?? this.builds[pageID]?.context.placeStateCode ?? null
  }

  setReportState(code, { forPageID }) {
    this.reportStateOverrides[forPageID] = code
    this.changed()
  }

  // MARK: - Bots

  selectBot(botID) {
    this.preferredBotID = botID
    this.defaults.set('weather.preferredBotID', botID)
    this.scheduleRebuild()
    this.changed()
  }

  // MARK: - Channel

  /**
   * Writes `#meshwx` to the first free slot. Only from the banner's confirmation, and only after
   * the channel sync: before it, the app's table is empty and every slot looks free.
   *
   * The Swift reads the slot back off the radio itself; on the web that is the host's
   * `addWeatherChannel`, which throws an already user-facing message.
   */
  async addChannel() {
    if (!this.host.isRadioConnected) return
    if (!this.isChannelSyncDone) {
      this.errorMessage = t('weather.channel.notSynced')
      this.changed()
      return
    }
    this.isAddingChannel = true
    this.changed()
    try {
      await this.host.addWeatherChannel()
    } catch (error) {
      this.errorMessage = String(error?.message ?? error)
    }
    this.isAddingChannel = false
    this.scheduleRebuild()
    this.changed()
  }

  // MARK: - Clear

  /** Forgets everything held for a bot, named when the confirmation was presented. */
  async clearReceivedWeather({ botID }) {
    await this.host.weatherService?.clearState({ for: botID })
    this.outcomes = {}
    this.answerNotes = {}
    this.scheduleRebuild()
    this.changed()
  }

  // MARK: - Timers
  //
  // Every one of them is injected and cancellable, and `stop()` clears all of them.

  /** A one-shot timer as a cancellable handle. */
  after(seconds, fn) {
    const id = this.schedule(() => fn(), seconds * 1000)
    return { cancel: () => this.unschedule(id) }
  }

  /** A repeating timer as a cancellable handle. */
  every(seconds, fn) {
    let id = null
    let cancelled = false
    const arm = () => {
      id = this.schedule(() => {
        if (cancelled) return
        fn()
        arm()
      }, seconds * 1000)
    }
    arm()
    return {
      cancel: () => {
        cancelled = true
        if (id != null) this.unschedule(id)
      },
    }
  }

  sleep(seconds) {
    return new Promise((resolve) => this.schedule(resolve, seconds * 1000))
  }

  /** A running async step with the `Task.isCancelled` flag the Swift checks. */
  task(run) {
    const state = { cancelled: false }
    const handle = {
      state,
      cancel() {
        state.cancelled = true
      },
    }
    handle.promise = Promise.resolve()
      .then(() => run(state))
      .catch(() => undefined)
    return handle
  }
}

// MARK: - Helpers

function compareIdentity(lhs, rhs) {
  if (lhs.event !== rhs.event) return lhs.event - rhs.event
  if (lhs.office !== rhs.office) return lhs.office - rhs.office
  return lhs.etn - rhs.etn
}

function distanceKilometres(from, to) {
  const earthRadius = 6371
  const dLat = ((to.latitude - from.latitude) * Math.PI) / 180
  const dLon = ((to.longitude - from.longitude) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((from.latitude * Math.PI) / 180) *
      Math.cos((to.latitude * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

let tokenCounter = 0

function newToken() {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return globalThis.crypto.randomUUID()
  tokenCounter += 1
  return `token-${tokenCounter}`
}

/**
 * One notify per animation frame in a browser, per microtask elsewhere — which is what Node's
 * test runner gets, so a test observes the change after one `await`.
 */
function defaultScheduleNotify(fn) {
  const raf = globalThis.requestAnimationFrame
  if (typeof raf === 'function') {
    const id = raf(fn)
    return () => globalThis.cancelAnimationFrame?.(id)
  }
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) fn()
  })
  return () => {
    cancelled = true
  }
}
