// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherScreenSnapshot.swift

import { MeshWXTables } from '../meshwx/index.js'
import {
  WeatherBot,
  WeatherRequest,
  WeatherService,
  WeatherStoredDigest,
  WeatherStoredForecast,
  WeatherStoredObservation,
  WeatherTransportLink,
} from '../weather/index.js'
import { WeatherAlertItems, WeatherAlertStatus } from './WeatherAlerts.js'
import { WeatherAlertRequests } from './WeatherAlertRequests.js'
import { WeatherCache, WeatherHeard } from './WeatherChannelHistory.js'
import { WeatherConditions } from './WeatherConditions.js'
import { WeatherCoverage, WeatherCoverageVerdict } from './WeatherCoverage.js'
import { WeatherForecastCard, WeatherOtherPlace } from './WeatherForecastRows.js'
import { WeatherPage } from './WeatherPages.js'
import { WeatherRadarCard, WeatherRadarPick } from './WeatherRadar.js'
import { WeatherPrimaryStation, WeatherStations } from './WeatherStations.js'

/**
 * Why nothing can be asked of a bot right now. Shown in place of a request button, so a tap is
 * never a wait for an answer that cannot come (docs/MESHWX_UI.md §3 A2, §11).
 */
export const WeatherRequestBlock = Object.freeze({
  radioOffline: 'radioOffline',
  firmwareTooOld: 'firmwareTooOld',
  channelMissing: 'channelMissing',
  noBot: 'noBot',
  /**
   * A bot heard on the channel whose advert the radio has not collected: its key, which a DM
   * needs, is unknown.
   */
  botNotAnnounced: 'botNotAnnounced',
})

/** A request's last outcome and when it came: `{ outcome, at }`. */
export const WeatherSettledOutcome = Object.freeze({
  make({ outcome, at }) {
    return { outcome, at }
  },
})

/** A request's state as any button for it shows it (docs/MESHWX_UI.md §11). */
export const WeatherRequestStatus = Object.freeze({
  /** How long an outcome stays under its button. */
  outcomeLifetime: 5 * 60,

  idle: Object.freeze({ kind: 'idle' }),
  blocked(value) {
    return { kind: 'blocked', value }
  },
  pending({ attempt, sentAt }) {
    return { kind: 'pending', attempt, sentAt }
  },
  /** Another request is on the air; one at a time (spec §19). */
  waitingForOther: Object.freeze({ kind: 'waitingForOther' }),
  settled(value, { at }) {
    return { kind: 'settled', value, at }
  },

  /**
   * `outcomes` is the Swift `[WeatherRequest: WeatherSettledOutcome]`, keyed by the request's
   * `>` line (`WeatherRequest.wireText`), which is what makes it a string key (docs/PORTING.md §3).
   */
  resolve({ request, block, pending, outcomes, now }) {
    const wire = WeatherRequest.wireText(request)
    const mine = pending.find((one) => WeatherRequest.wireText(one.request) === wire)
    if (mine != null) return WeatherRequestStatus.pending({ attempt: mine.attempt, sentAt: mine.sentAt })
    if (block != null) return WeatherRequestStatus.blocked(block)
    if (pending.length > 0) return WeatherRequestStatus.waitingForOther
    const settled = outcomes[wire]
    if (settled != null && (now - settled.at) / 1000 < WeatherRequestStatus.outcomeLifetime) {
      return WeatherRequestStatus.settled(settled.outcome, { at: settled.at })
    }
    return WeatherRequestStatus.idle
  },
})

/**
 * A text reply held from some bot, and whether this phone asked for it: `{ botID, assembly }`.
 */
export const WeatherTextItem = Object.freeze({
  make({ botID, assembly }) {
    return { botID, assembly }
  },

  /**
   * Answered this phone's request. Otherwise somebody else on the channel asked, and the subject
   * is all that is known about what they asked for.
   */
  isOwn(item) {
    return (item.assembly.request ?? null) != null
  },

  id(item) {
    return `${item.botID}-${item.assembly.group}`
  },
})

/**
 * Which page a snapshot was built for (docs/MESHWX_UI.md §4, §13): `{ pageID, place }`.
 *
 * The tool is a pager of places, and one snapshot at a time means "the snapshot" is whichever page
 * was built last: that is how a forecast discussion opened from Round Rock came back naming
 * Austin's office. The page travels *inside* the value instead, so a screen reached from a page is
 * handed that page's own build and every claim it makes is about that place.
 */
export const WeatherPageKey = Object.freeze({
  make({ pageID = WeatherPage.myLocationID, place = null } = {}) {
    return { pageID, place }
  },
})

/** The banner above everything (docs/MESHWX_UI.md §10). */
export const WeatherScreenBanner = Object.freeze({
  firmwareTooOld({ version }) {
    return { kind: 'firmwareTooOld', version }
  },
  channelMissing: Object.freeze({ kind: 'channelMissing' }),
  noBotHeard: Object.freeze({ kind: 'noBotHeard' }),
})

/**
 * Everything the Weather screen shows for **one page**, computed in one pass from the service's
 * state and the phone's situation. Views read this and nothing else (docs/MESHWX_UI.md §13).
 *
 * A snapshot is
 * `{ page, place, banner, source, knownBotIDs, coverage, alerts, alertStatus, readings,
 * primaryStation, forecast, radar, radarTiles, otherPlaces, texts, heard, cache, requestBlock,
 * sourceQuietSince, now }`.
 */
export const WeatherScreenSnapshot = Object.freeze({
  Banner: WeatherScreenBanner,

  /** Set when the source bot has not been heard live for 90 minutes: it may not answer. */
  quietAfter: 90 * 60,

  /**
   * The bot requests go to and the screen names:
   * `{ botID, bot, lastHeardAt, lastLiveHeardAt }`. `bot` is null for a bot heard on the channel
   * without an advert; `lastLiveHeardAt` is the last message heard live, not drained from the
   * radio's queue.
   */
  Source: Object.freeze({
    make({ botID, bot = null, lastHeardAt = null, lastLiveHeardAt = null }) {
      return { botID, bot, lastHeardAt, lastLiveHeardAt }
    },
    /**
     * Who a request goes to: the announced bot, or, for one only ever heard on the channel, a
     * stand-in carrying the two bytes a Request datagram needs (`WeatherBot.heardOnly`). `bot`
     * stays null for such a source, so it is still named "Weather radio 041D".
     */
    requestBot(source) {
      return source.bot ?? WeatherBot.heardOnly({ botID: source.botID })
    },
  }),

  /**
   * What one build reads. `timeZone` is an IANA id in place of the Swift's `Calendar`
   * (docs/PORTING.md); `transportLink` is a link the weather transport provides of its own
   * (`WeatherTransportLink`): the DEBUG bridge to a real bot, which is a live connection without
   * any radio. When there is one, the radio reads as connected here and the link's bot as
   * announced, whatever the phone's Bluetooth is doing. Null over a radio, which is every build
   * that is not a bridged one.
   *
   * `firmwareSupportsWeather` is null when no radio has ever been seen, so no firmware claim can
   * be made.
   */
  Inputs: Object.freeze({
    make({
      states,
      bots,
      preferredBotID = null,
      place = null,
      pageID = WeatherPage.myLocationID,
      isRadioConnected,
      transportLink = null,
      firmwareSupportsWeather,
      firmwareVersion,
      hasWeatherChannel,
      session,
      now,
      timeZone,
    }) {
      return {
        states,
        bots,
        preferredBotID,
        place,
        pageID,
        isRadioConnected,
        transportLink,
        firmwareSupportsWeather,
        firmwareVersion,
        hasWeatherChannel,
        session,
        now,
        timeZone,
      }
    },
  }),

  make(rawInputs, { geometry, tables = MeshWXTables.shared }) {
    const inputs = { ...rawInputs }
    // A transport with a link of its own is the connection: the DEBUG bridge talks to one real bot
    // over HTTP, so requests are not blocked on this phone's Bluetooth and the bot it names is
    // announced although no advert of its ever reached the radio. Over a radio the link is null
    // and none of this runs.
    if (inputs.transportLink != null) {
      inputs.isRadioConnected = true
      // The firmware claim is about **the transport that carries the request**, and over a bridge
      // that is not the radio: a phone paired with an old radio (the simulator's mock is firmware
      // 8) had Update disabled with "Your radio's firmware can't ask for weather" while the bridge
      // beside it was answering (docs/MESHWX_UI.md §3.1 U-20).
      inputs.firmwareSupportsWeather = true
      inputs.bots = WeatherTransportLink.announcing(inputs.transportLink, inputs.bots)
    }
    const now = inputs.now
    const coverage = WeatherCoverage.make({ states: inputs.states, tables, now })
    const radarTiles = WeatherRadarPick.tiles({ states: inputs.states })
    const source = WeatherScreenSnapshot.pickSource(inputs, { coverage })

    let banner = null
    if (inputs.firmwareSupportsWeather === false) {
      banner = WeatherScreenBanner.firmwareTooOld({ version: inputs.firmwareVersion })
    } else if (inputs.isRadioConnected && !inputs.hasWeatherChannel && inputs.session.lastChannelDatagramAt == null) {
      banner = WeatherScreenBanner.channelMissing
    } else if (source == null) {
      banner = WeatherScreenBanner.noBotHeard
    }

    let requestBlock = null
    if (!inputs.isRadioConnected) {
      requestBlock = WeatherRequestBlock.radioOffline
    } else if (banner?.kind === 'firmwareTooOld') {
      requestBlock = WeatherRequestBlock.firmwareTooOld
    } else if (banner?.kind === 'channelMissing') {
      requestBlock = WeatherRequestBlock.channelMissing
    } else if (source != null) {
      // A bot heard but never seen to advertise can still be asked: a Request datagram names it
      // by the two bytes its own packets carry (spec §11). Only a radio that cannot send one
      // needs the DM, and only the DM needs the whole key an advert brings.
      requestBlock = source.bot == null && inputs.firmwareSupportsWeather !== true
        ? WeatherRequestBlock.botNotAnnounced : null
    } else {
      requestBlock = WeatherRequestBlock.noBot
    }

    const alerts = WeatherAlertItems.make({ states: inputs.states, place: inputs.place, geometry, tables, now })
    const readings = WeatherStations.readings({
      states: inputs.states,
      coverage,
      place: inputs.place,
      tables,
      now,
    })
    const primaryStation = WeatherPrimaryStation.pick({ readings, place: inputs.place })
    const forecast = WeatherForecastCard.make({
      states: inputs.states,
      place: inputs.place,
      tables,
      now,
      timeZone: inputs.timeZone,
    })
    // The point the page's own forecast is for, so the picker does not offer it back as
    // "somebody else's place". Null when the bot chose the point and there is no bundled index
    // to exclude (spec §7, revision 10).
    const placePoint =
      forecast.kind === 'forecast'
        ? (forecast.value.point?.index ?? null)
        : forecast.kind === 'missing'
          ? (forecast.point?.index ?? null)
          : null

    const texts = []
    for (const [key, state] of Object.entries(inputs.states)) {
      for (const assembly of Object.values(state.texts ?? {})) {
        texts.push(WeatherTextItem.make({ botID: Number(key), assembly }))
      }
    }
    texts.sort((lhs, rhs) => rhs.assembly.lastReceivedAt - lhs.assembly.lastReceivedAt)

    const known = new Set(Object.keys(inputs.states).map(Number))
    for (const bot of inputs.bots) known.add(WeatherBot.botID(bot))

    return {
      page: WeatherPageKey.make({ pageID: inputs.pageID, place: inputs.place }),
      place: inputs.place ?? null,
      banner,
      source,
      knownBotIDs: [...known].sort((lhs, rhs) => lhs - rhs),
      coverage,
      alerts,
      alertStatus: WeatherAlertStatus.evaluate({
        place: inputs.place ?? null,
        coverage,
        states: inputs.states,
        items: alerts,
        isRadioConnected: inputs.isRadioConnected,
        sessionStartedAt: inputs.session.startedAt ?? null,
        tables,
        now,
      }),
      // The station the Now card names leads the list its own link opens.
      readings: WeatherStations.ordered(readings, { leading: WeatherPrimaryStation.index(primaryStation) }),
      primaryStation,
      forecast,
      // The radar tiles are read across every bot, not from the source alone: a tile is a named
      // square of the earth cut from a national mosaic, so the bot next door's picture of this
      // place is this place's picture (spec §13, revision 11). The ask still goes to the source,
      // which is what the card's own `tile` is for.
      radar: WeatherRadarCard.make({ place: inputs.place ?? null, tiles: radarTiles, now }),
      // The same list, kept: the radar screen's Local / Regional / Wide control asks what is
      // held for each width in turn (`WeatherRadarCard.width`), and a pushed screen reads the
      // page's snapshot and never the service's state (§13).
      radarTiles,
      otherPlaces: WeatherOtherPlace.make({ states: inputs.states, excludingPoint: placePoint, tables, now }),
      texts,
      heard: WeatherHeard.make({ states: inputs.states, now }),
      cache: WeatherCache.make({ states: inputs.states, readings, alerts, tables }),
      requestBlock,
      sourceQuietSince:
        source?.lastLiveHeardAt != null && (now - source.lastLiveHeardAt) / 1000 > WeatherScreenSnapshot.quietAfter
          ? source.lastLiveHeardAt
          : null,
      now,
    }
  },

  /**
   * The user's pick; else an advertised bot that covers the place; else the advertised bot heard
   * most recently; else any advertised bot; else the heard-only bot heard most recently.
   */
  pickSource(inputs, { coverage }) {
    const lastHeard = (botID) => inputs.states[String(botID)]?.lastHeardAt ?? -Infinity
    const source = (botID) =>
      WeatherScreenSnapshot.Source.make({
        botID,
        bot: inputs.bots.find((bot) => WeatherBot.botID(bot) === botID) ?? null,
        lastHeardAt: inputs.states[String(botID)]?.lastHeardAt ?? null,
        lastLiveHeardAt: inputs.states[String(botID)]?.lastLiveHeardAt ?? null,
      })
    const heardMostRecently = (botIDs) => {
      let best = null
      for (const botID of [...botIDs].sort((lhs, rhs) => lhs - rhs)) {
        if (best == null || lastHeard(best) < lastHeard(botID)) best = botID
      }
      return best
    }

    const advertised = new Set(inputs.bots.map((bot) => WeatherBot.botID(bot)))
    const heard = Object.keys(inputs.states).map(Number)

    if (
      inputs.preferredBotID != null &&
      (advertised.has(inputs.preferredBotID) || inputs.states[String(inputs.preferredBotID)] != null)
    ) {
      return source(inputs.preferredBotID)
    }
    if (inputs.place != null) {
      const covering = [...WeatherCoverage.botIDs(coverage, { covering: inputs.place.coordinate })].filter((botID) =>
        advertised.has(botID),
      )
      const best = heardMostRecently(covering)
      if (best != null) return source(best)
    }
    const known = heardMostRecently([...advertised].filter((botID) => inputs.states[String(botID)] != null))
    if (known != null) return source(known)
    if (inputs.bots.length > 0) return source(WeatherBot.botID(inputs.bots[0]))
    const anyHeard = heardMostRecently(heard)
    if (anyHeard != null) return source(anyHeard)
    return null
  },
})

// MARK: - Update runs

/**
 * Which page's Update run is on the air, and what each page's last run asked for
 * (docs/MESHWX_UI.md §11.1, §13): `{ runningPageID, requestsByPage }`.
 *
 * Two rules, and they are the same rule from two sides. **Per page**: a run belongs to the page
 * that started it, so one place's requests never narrate another place's caption and a page being
 * swiped past does not spin because its neighbour is asking for something. **One at a time**:
 * there is one radio and one queue, so a pull and a tap cannot both be running — the second is
 * refused rather than replacing the first, whose own cleanup would otherwise put the live run's
 * spinner out.
 *
 * The Swift's `mutating` methods return the new value here (docs/PORTING.md §3); `begin` also has
 * a `Bool` to give back, so it returns `{ runs, started }`.
 */
export const WeatherUpdateRuns = Object.freeze({
  make() {
    return { runningPageID: null, requestsByPage: {} }
  },

  /** `isRunning(runs)` for any run at all; `isRunning(runs, { pageID })` for one page's. */
  isRunning(runs, options) {
    if (options === undefined) return runs.runningPageID != null
    return runs.runningPageID === options.pageID
  },

  requests(runs, { pageID }) {
    return runs.requestsByPage[pageID] ?? []
  },

  /**
   * Starts a run for one page. `started` is false when another run is already going, and then
   * nothing is changed: the page that asked second simply does not send.
   */
  begin(runs, { pageID, requests }) {
    if (runs.runningPageID != null || requests.length === 0) return { runs, started: false }
    const unique = []
    const seen = new Set()
    for (const request of requests) {
      const wire = WeatherRequest.wireText(request)
      if (seen.has(wire)) continue
      seen.add(wire)
      unique.push(request)
    }
    return {
      runs: { runningPageID: pageID, requestsByPage: { ...runs.requestsByPage, [pageID]: unique } },
      started: true,
    }
  },

  /**
   * Ends that page's run. A run that is no longer the one going ends nothing: a cancelled task's
   * cleanup must not clear the live run's spinner.
   */
  end(runs, { pageID }) {
    if (runs.runningPageID !== pageID) return runs
    return { ...runs, runningPageID: null }
  },
})

// MARK: - Update

/** What a step is for, in the order the steps are sent. One word each on the button's caption. */
export const WeatherUpdatePlanItem = Object.freeze({
  /** The bot's own alert list, or the one warning it named that never arrived. */
  alerts: 'alerts',
  /**
   * The place's county and zone, for a place outside the bot's area: the bot serves place-named
   * requests nationwide, so it can still be asked about them by name.
   */
  areaAlerts: 'areaAlerts',
  readings: 'readings',
  forecast: 'forecast',
  /**
   * What the bot carries, from the bot itself (`>cov`): the one thing that tells "outside the
   * area" from "nothing said yet", and otherwise a three-hour wait.
   */
  coverage: 'coverage',
})

/**
 * What one tap on **Update** would ask the weather radio for (docs/MESHWX_UI.md §11):
 * `{ steps, justReceived, currentAsOf }`, a step being `{ item, request }`.
 *
 * The screen has one request control, and it says what it will send before it sends it. The plan
 * is the minimal set that would repair what the phone is actually missing, read from the held
 * state rather than from thresholds hidden inside the cards: the alert list when none is held, it
 * is past its three-hour cadence, or a gap is outstanding; the readings when the last hourly batch
 * was missed; the forecast when none is held or it was issued over twelve hours ago. Nothing at
 * all is asked for what the channel delivered in the last five minutes, which is airtime etiquette
 * rather than a claim about the bot (spec §19).
 *
 * - `justReceived`: left out only because the channel delivered the answer in the last five
 *   minutes — there is nothing to ask for, but the phone is not current either.
 * - `currentAsOf`: with nothing to ask for and nothing just received, the oldest of the content
 *   times the plan checked — the time "everything is current" is true as of, on the bot's clock.
 *   Null when the phone holds none of them.
 */
export const WeatherUpdatePlan = Object.freeze({
  Item: WeatherUpdatePlanItem,

  Step: Object.freeze({
    make({ item, request }) {
      return { item, request }
    },
  }),

  /**
   * A reading older than this is worth asking about: the batch is hourly, plus ten minutes for a
   * late broadcast.
   */
  readingFreshFor: 70 * 60,
  /** Spec §7: a forecast is issued at least twice a day. */
  forecastFreshFor: 12 * 60 * 60,

  /** Nothing to ask for and nothing held: the plan before the first snapshot is built. */
  empty: Object.freeze({ steps: Object.freeze([]), justReceived: Object.freeze([]), currentAsOf: null }),

  isEmpty(plan) {
    return plan.steps.length === 0
  },

  requests(plan) {
    return plan.steps.map((step) => step.request)
  },

  /** Each item once, in send order: what the caption names. */
  items(plan) {
    const seen = new Set()
    const items = []
    for (const step of plan.steps) {
      if (seen.has(step.item)) continue
      seen.add(step.item)
      items.push(step.item)
    }
    return items
  },

  /**
   * A stale reading the bot's newest batch still carries asks for the batch; anything else asks
   * for that station by code. Being in the bot's area is not enough: the footprint is every
   * multi-station batch of the last day, and a bare `>o` comes back with the batch the bot would
   * send *now* — which cannot refresh a station it has dropped, or one held from somebody's
   * single-station answer to a bot that never lists it.
   */
  readingsRequest({ for: reading }) {
    return reading.isInLatestBatch
      ? WeatherRequest.observations
      : WeatherRequest.observation({ station: reading.station.icao })
  },

  /**
   * Two Swift overloads, told apart by the labels passed.
   *
   * `make({ stationReading, icao, now })` is the plan for one station's own screen
   * (docs/MESHWX_UI.md §12): that station's reading, and nothing else. The station screen answers
   * for a station, so the alert list and the forecast stay with the screen that shows them.
   * `icao` is the station's airport code, for a station no reading has ever arrived for.
   *
   * `make({ snapshot, sourceState, … })` is the plan for a screen:
   *
   * - `sourceState`: the bot the requests would go to. Its gaps and missing identities are the
   *   only ones a request to it can repair (`WeatherAlertRequests`).
   * - `nearbyStation`: the nearest bundled station to the place, which can be asked for by code.
   *   The readings step is read off `WeatherConditions` built with it, so what Update asks for is
   *   always the station the page names (docs/MESHWX_UI.md §3.1 U-2a).
   * - `notAvailable`: identities this bot has already said it does not have, so a tap moves on to
   *   the next one instead of asking again.
   * - `coverageAlreadyAsked`: this phone has already asked this bot what it covers on this visit,
   *   however that ended, so a statement it never sent is not asked for on every tap.
   */
  make(options) {
    if (options.snapshot === undefined) return makeStationPlan(options)
    return makeScreenPlan(options)
  },
})

function makeStationPlan({ stationReading: reading, icao, now }) {
  if (reading == null) {
    if (icao == null) return WeatherUpdatePlan.empty
    return {
      steps: [
        WeatherUpdatePlan.Step.make({
          item: WeatherUpdatePlanItem.readings,
          request: WeatherRequest.observation({ station: icao }),
        }),
      ],
      justReceived: [],
      currentAsOf: null,
    }
  }
  const observedAt = WeatherStoredObservation.observedAt(reading.stored)
  if ((now - observedAt) / 1000 <= WeatherUpdatePlan.readingFreshFor) {
    return { steps: [], justReceived: [], currentAsOf: observedAt }
  }
  if ((now - reading.stored.receivedAt) / 1000 < WeatherService.recentAnswerWindow) {
    return { steps: [], justReceived: [WeatherUpdatePlanItem.readings], currentAsOf: null }
  }
  return {
    steps: [
      WeatherUpdatePlan.Step.make({
        item: WeatherUpdatePlanItem.readings,
        request: WeatherUpdatePlan.readingsRequest({ for: reading }),
      }),
    ],
    justReceived: [],
    currentAsOf: null,
  }
}

function makeScreenPlan({
  snapshot,
  sourceState,
  placeCountyUGC = null,
  placeZoneUGC = null,
  placeOffice = null,
  nearbyStation = null,
  notAvailable = [],
  coverageAlreadyAsked = false,
  tables,
  now,
}) {
  const steps = []
  const justReceived = []
  const currentTimes = []
  const step = (item, request) => steps.push(WeatherUpdatePlan.Step.make({ item, request }))

  /**
   * The channel delivered this in the last five minutes, so asking again would only have the bot
   * rebuild the same answer on everyone's airtime.
   */
  const isJustReceived = (receivedAt) =>
    receivedAt != null && (now - receivedAt) / 1000 < WeatherService.recentAnswerWindow

  // Alerts. A gap, a warning the list named that never arrived, or an upgrade whose replacement
  // never came is outstanding whatever the list's age, and the five-minute rule never holds it
  // back: what was missed came after the answer that was received (§3.1 R-3).
  const outstanding =
    sourceState != null &&
    (sourceState.needsDigest ||
      (sourceState.missingFromDigest ?? []).length > 0 ||
      Object.keys(sourceState.pendingUpgrades ?? {}).length > 0)
  if (sourceState != null && outstanding) {
    step(
      WeatherUpdatePlanItem.alerts,
      WeatherAlertRequests.missedMessages({
        source: sourceState,
        placeCountyUGC,
        placeOffice,
        notAvailable,
        tables,
      }),
    )
  } else if (sourceState?.digest != null) {
    const digest = sourceState.digest
    const builtAt = WeatherStoredDigest.builtAt(digest)
    if ((now - builtAt) / 1000 > WeatherAlertStatus.listFreshFor) {
      if (isJustReceived(digest.receivedAt)) justReceived.push(WeatherUpdatePlanItem.alerts)
      else step(WeatherUpdatePlanItem.alerts, WeatherRequest.digest)
    } else {
      currentTimes.push(builtAt)
    }
  } else {
    // No list held at all: the one thing that says whether anything is active.
    step(WeatherUpdatePlanItem.alerts, WeatherRequest.digest)
  }

  // Outside the bot's area its own list speaks for somewhere else, but the bot answers place-named
  // requests nationwide: the place's zone carries the watches and advisories, its county the
  // storm-based warnings (spec §14).
  //
  // Only a verdict of `outside` — a complete statement, or a footprint, that genuinely excludes
  // the place. "No bot says inside" also covers a zone list the bot had to cut, outlines still
  // loading and a bot that has stated nothing, and spending two nationwide requests on those would
  // be spending airtime on a place that is very likely inside the area.
  if (
    snapshot.place != null &&
    WeatherCoverage.verdict(snapshot.coverage, { for: snapshot.place }) === WeatherCoverageVerdict.outside
  ) {
    for (const ugc of [placeZoneUGC, placeCountyUGC].filter((one) => one != null)) {
      step(WeatherUpdatePlanItem.areaAlerts, WeatherRequest.warningsTouching({ ugc }))
    }
  }

  // Readings: off the page's own verdict, so the page and the packet never disagree. They were
  // worked out twice and drifted — a Wimberley page asked about San Marcos while Update, holding a
  // fresh San Marcos reading, called everything current (docs/MESHWX_UI.md §3.1 U-2a).
  //
  // Two ages, on purpose: the page marks a reading stale after two hours (`isStale`) and stops
  // showing it after twelve (`isTooOld`), but one over `readingFreshFor` has missed an hourly batch
  // and is already worth a packet.
  const refresh = (held) => {
    const observedAt = WeatherStoredObservation.observedAt(held.stored)
    if ((now - observedAt) / 1000 <= WeatherUpdatePlan.readingFreshFor) currentTimes.push(observedAt)
    else if (isJustReceived(held.stored.receivedAt)) justReceived.push(WeatherUpdatePlanItem.readings)
    else step(WeatherUpdatePlanItem.readings, WeatherUpdatePlan.readingsRequest({ for: held }))
  }
  const conditions = WeatherConditions.make({ primary: snapshot.primaryStation, nearbyStation })
  switch (conditions.kind) {
    case 'reading':
      refresh(conditions.value)
      break
    case 'nearby':
      if (conditions.nearer == null) {
        refresh(conditions.value)
      } else {
        // Shown under its station's name, and a nearer station could be the weather here: that one
        // by code. The page keeps what it holds meanwhile.
        step(WeatherUpdatePlanItem.readings, WeatherRequest.observation({ station: conditions.nearer.icao }))
      }
      break
    case 'ask':
      if (snapshot.primaryStation.kind === 'reading' && snapshot.primaryStation.value.station.icao === conditions.icao) {
        // The held station itself, gone stale.
        refresh(snapshot.primaryStation.value)
      } else {
        // Nothing held from it: that one station by code.
        step(WeatherUpdatePlanItem.readings, WeatherRequest.observation({ station: conditions.icao }))
      }
      break
    case 'noneYet':
      step(WeatherUpdatePlanItem.readings, WeatherRequest.observations)
      break
    default:
      // No station close enough for its answer to be shown: a packet would bring back a reading
      // the page refuses.
      break
  }

  // Forecast.
  //
  // Which request depends on whether the bundle has a point worth asking for. It has none for
  // nine offices — the point list was built from one day's products — and before revision 10
  // that was the end of it: the card said "No forecast point near Santa Fe" and Update asked for
  // nothing, while the bot held a forecast fifteen kilometres away. `>f <lat>,<lon>` asks the
  // same engine the bot's chat asks, so a place with a coordinate always has something to ask.
  const forecastRequest = (point) => (point != null
    ? WeatherRequest.forecast({ point })
    : (snapshot.place?.coordinate != null
      ? WeatherRequest.forecastAt({
        latitude: snapshot.place.coordinate.latitude,
        longitude: snapshot.place.coordinate.longitude,
      })
      : null))
  if (snapshot.forecast.kind === 'forecast') {
    const summary = snapshot.forecast.value
    const issuedAt = WeatherStoredForecast.issuedAt(summary.stored)
    if ((now - issuedAt) / 1000 > WeatherUpdatePlan.forecastFreshFor) {
      if (isJustReceived(summary.stored.receivedAt)) justReceived.push(WeatherUpdatePlanItem.forecast)
      else {
        // A forecast held for a point the bot chose has no index to ask again by: `>f 65535`
        // means nothing. The coordinate is what fetched it and the coordinate is what refreshes
        // it.
        const again = forecastRequest(summary.point?.index ?? null)
        if (again != null) step(WeatherUpdatePlanItem.forecast, again)
      }
    } else {
      currentTimes.push(issuedAt)
    }
  } else if (snapshot.forecast.kind === 'missing') {
    const ask = forecastRequest(snapshot.forecast.point?.index ?? null)
    if (ask != null) step(WeatherUpdatePlanItem.forecast, ask)
  }

  // Coverage, last: it is about what the *next* answer can be trusted to mean, not about the
  // weather now, and on shared airtime the weather goes first. One packet, asked while the bot has
  // been heard and has stated nothing, and only until it has been asked once on this visit — a
  // statement does not go stale (§6), so a bot that has made one is never asked again, and one
  // that did not answer is not asked on every tap (§14 Q4).
  if (sourceState != null && sourceState.coverage == null && !coverageAlreadyAsked) {
    step(WeatherUpdatePlanItem.coverage, WeatherRequest.coverage)
  }

  // An upgrade already asks by the place's county, which the out-of-area step would repeat.
  const sent = new Set()
  const unique = steps.filter((one) => {
    const wire = WeatherRequest.wireText(one.request)
    if (sent.has(wire)) return false
    sent.add(wire)
    return true
  })
  return {
    steps: unique,
    justReceived,
    // Only a plan with nothing to ask for and nothing held back can say everything is current.
    currentAsOf:
      unique.length === 0 && justReceived.length === 0 && currentTimes.length > 0 ? Math.min(...currentTimes) : null,
  }
}
