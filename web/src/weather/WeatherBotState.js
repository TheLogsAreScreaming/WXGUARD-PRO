// Port of MC1Services/Services/Weather/WeatherBotState.swift (docs/PORTING.md).
//
// Every record below wraps a *decoded wire object* (PORTING.md §5): `stored.warning` is the
// `decoded` JSON of a Warning message, so Swift `stored.warning.expiresMinutes` is
// `stored.warning.expires_min`, `observation.stationIndex` is `observation.station`, and an area
// run is `{ state, county, start, run }`. Everything around the message keeps the Swift names.
//
// `source` is the spec's number (0 unstated, 1 GOES, 2 internet, 3 mixed). A type that carries no
// weather product — Cancel, Coverage, Not available, Request — never states one, and the decoded
// object simply has no `source` key, which reads as unstated.

import {
  MeshWXDataSource,
  MeshWXFeedHealth,
  MeshWXPresentation,
  MeshWXWarningIdentity,
  MeshWXWire
} from '../meshwx/index.js'

/** `MeshWXDataSource.unstated`: not a fourth kind of source, and never a claim on screen. */
export const UNSTATED_SOURCE = MeshWXDataSource.unstated

/**
 * The one `unbundledForecasts` slot for a bot-chosen forecast nobody here asked for (spec §7,
 * revision 10).
 *
 * A forecast with point `0xFFFF` says which weather, never which place: the coordinate lives in
 * the *question*, and somebody else's question never reached this phone. One slot, because
 * holding fifty of them would be holding fifty forecasts of nowhere. It is listed on the Cached
 * screen — the channel did carry it — and it is never any place's forecast.
 */
export const UNASKED_FORECAST_KEY = '?'

/** The wire's clock: Unix minutes (`seconds / 60`) as u32 (spec §1.3), as a `Date` in ms. */
export function dateFromUnixMinutes(minutes) {
  return minutes * 60_000
}

/** The identity triple of any decoded object that carries `event`, `office` and `etn`. */
export function identityOf(value) {
  return MeshWXWarningIdentity.of(value)
}

/** `"3.35.42"` — the dictionary key of PORTING.md §3. */
export function identityKey(identity) {
  return MeshWXWarningIdentity.key(identity)
}

// MARK: - Stored records

/**
 * A warning as the app holds it: the last message received for its identity, and when.
 *
 * - `receivedAt`: phone clock. It orders this warning against a digest (a list built before the
 *   warning arrived cannot speak for it); it is never shown as the warning's age.
 * - `updateCount`: how many times a later message replaced this identity (spec §3).
 * - `seq`: the `seq` of the message this copy came in, so a late resend can be told apart from an
 *   older message. Null in state saved before copies carried one.
 * - `issuedAt`: when NWS issued the product (spec §3, revision 5), resolved once from the message
 *   that carried it. Null for a warning from a bot older than revision 5. Stored rather than read
 *   back off the warning because a digest may later extend the expiry and the instant a warning
 *   was issued never moves.
 * - `source`: where the bot got this warning (spec §2.2, revision 7).
 * - `beginsAt`: when the product takes effect, where that is later than its issuance (spec §3,
 *   revision 12). Null for a product in effect from issuance and for one from a bot older than
 *   revision 12. Stored and resolved once, exactly like `issuedAt` and for the same reason: the
 *   wire says it as minutes before the expiry, a digest can extend the expiry, and a start read
 *   back against the new one would walk forward.
 */
export const WeatherStoredWarning = {
  make({
    warning, receivedAt, updateCount = 0, seq = null, issuedAt = null, source = UNSTATED_SOURCE,
    beginsAt = null
  }) {
    return { warning, receivedAt, updateCount, seq, issuedAt, source, beginsAt }
  },

  /**
   * A record read back from persisted JSON. `source` arrived with revision 7, so a state file
   * written before it reads as unstated rather than failing: the warning is still the last one
   * the bot sent. `beginsAt` arrived with revision 12 and reads the same way, as no start: what
   * the phone believed when it saved.
   */
  decode(json) {
    return {
      warning: json.warning,
      receivedAt: json.receivedAt,
      updateCount: json.updateCount ?? 0,
      seq: json.seq ?? null,
      issuedAt: json.issuedAt ?? null,
      source: json.source ?? UNSTATED_SOURCE,
      beginsAt: json.beginsAt ?? null
    }
  },

  identity(stored) { return identityOf(stored.warning) },

  /** The absolute expiry, from the wire's Unix minutes. */
  expiresAt(stored) { return dateFromUnixMinutes(stored.warning.expires_min) },

  /** Spec §3: "treat as expired when passed", judged by the phone's clock. */
  isExpired(stored, { at }) { return WeatherStoredWarning.expiresAt(stored) <= at }
}

/**
 * A warning ended by a cancel that says it was upgraded (spec §4, flag 2).
 *
 * The replacement follows in its own message. Until it arrives, or a later digest settles
 * what is active, the phone knows the area is under *something* worse and must not report
 * it as clear — which is what simply deleting the identity would do if the replacement was
 * lost.
 */
export const WeatherPendingUpgrade = {
  make({ warning, cancelledAt }) { return { warning, cancelledAt } }
}

export const WeatherStoredDigest = {
  make({ digest, receivedAt }) { return { digest, receivedAt } },

  /**
   * When the bot built the list, on the bot's clock (spec §5 `now`). Ages are measured from
   * this, never from receipt: a digest drained from the radio's queue eight hours late is
   * eight hours old.
   */
  builtAt(stored) { return dateFromUnixMinutes(stored.digest.now_min) },

  /**
   * Spec §5: minutes since the bot last received a product from its home office, in units of
   * four minutes, capped. Quiet or never received; either withholds calm.
   */
  isFeedStale(stored) {
    return MeshWXPresentation.isFeedStale({ feedHealth: stored.digest.feed_health })
  },

  /** What `feed_health` says, split so a quiet office is not worded as a broken feed. */
  feed(stored) {
    return MeshWXFeedHealth.make({ feedHealth: stored.digest.feed_health })
  }
}

/**
 * The bot's own statement of what it carries (spec §10), and when it arrived.
 *
 * The message carries no time of its own: it says what the bot covers at the moment it is sent,
 * so its age is receipt. It does not go stale either — it is broadcast every three hours, and a
 * statement from yesterday is still what the bot said about itself, which is the only evidence
 * there is for "is this place in its area".
 */
export const WeatherStoredCoverage = {
  make({ coverage, receivedAt }) { return { coverage, receivedAt } }
}

/**
 * One station's latest reading, stamped with the time that station measured it.
 *
 * - `observation`: one element of a batch's `stations` array (`{ station, temp_f, …, age_min }`).
 * - `timestampMinutes`: this station's own report time in Unix minutes: the batch's `ts_min` less
 *   the station's age (spec §6.1). For a batch from a bot older than revision 5, which states no
 *   ages, it is the batch time — all such a batch says about any of its stations.
 * - `batchSize`: stations in the batch this reading came in. The bot's scheduled broadcast covers
 *   its area; a batch of one is the answer to somebody's single-station request, which says
 *   nothing about where the bot's coverage is.
 * - `lastBatchMinutes`: the `ts_min` of the newest multi-station batch that named this station —
 *   the batch's own time, not this station's report time — whether or not that batch carried the
 *   reading held now. It is the evidence that the station is in the bot's area
 *   (docs/MESHWX_UI.md §6). Null for a station only ever seen in a batch of one.
 */
export const WeatherStoredObservation = {
  make({
    observation,
    timestampMinutes,
    receivedAt,
    batchSize = 1,
    lastBatchMinutes = null,
    source = UNSTATED_SOURCE
  }) {
    return { observation, timestampMinutes, receivedAt, batchSize, lastBatchMinutes, source }
  },

  decode(json) {
    const batchSize = json.batchSize ?? 1
    return {
      observation: json.observation,
      timestampMinutes: json.timestampMinutes,
      receivedAt: json.receivedAt,
      batchSize,
      // A file written before the batch was remembered separately: a reading that came in a batch
      // is its own evidence, which is exactly what the app read from `batchSize` then.
      lastBatchMinutes: json.lastBatchMinutes ?? (batchSize > 1 ? json.timestampMinutes : null),
      source: json.source ?? UNSTATED_SOURCE
    }
  },

  /**
   * When this station measured what it reported — the *as of* time (spec §18.1), never when the
   * packet arrived.
   */
  observedAt(stored) { return dateFromUnixMinutes(stored.timestampMinutes) },

  /** When this station was last in one of the bot's scheduled batches, on the bot's clock. */
  lastBatchAt(stored) {
    return stored.lastBatchMinutes == null ? null : dateFromUnixMinutes(stored.lastBatchMinutes)
  },

  isStale(stored, { at }) {
    return MeshWXPresentation.isObservationStale({
      timestampMinutes: stored.timestampMinutes,
      now: MeshWXPresentation.unixMinutes({ for: at })
    })
  },

  /** Past `MeshWXPresentation.observationShownForMinutes`: too old to show even with its age. */
  isTooOld(stored, { at }) {
    return MeshWXPresentation.isObservationTooOld({
      timestampMinutes: stored.timestampMinutes,
      now: MeshWXPresentation.unixMinutes({ for: at })
    })
  }
}

export const WeatherStoredForecast = {
  make({ forecast, receivedAt, requestLabel = null, requestedHere = false, source = UNSTATED_SOURCE }) {
    return { forecast, receivedAt, requestLabel, requestedHere, source }
  },

  decode(json) {
    return {
      forecast: json.forecast,
      receivedAt: json.receivedAt,
      requestLabel: json.requestLabel ?? null,
      requestedHere: json.requestedHere ?? false,
      source: json.source ?? UNSTATED_SOURCE
    }
  },

  issuedAt(stored) { return dateFromUnixMinutes(stored.forecast.issued_min) },

  isStale(stored, { at }) {
    return MeshWXPresentation.isForecastStale({
      issuedMinutes: stored.forecast.issued_min,
      now: MeshWXPresentation.unixMinutes({ for: at })
    })
  },

  /** `point == 0xFFFF`: a place the bot resolved for itself, with no bundled point. */
  isUnbundledPoint(forecast) { return forecast.point === MeshWXWire.unbundledPoint }
}

/**
 * A text reply being reassembled by `(bot, group)` in `idx` order (spec §8).
 *
 * A chunk the bot transmits a second time — the same bytes, when no repeater echoed the first —
 * carries the *original* group byte, so it merges into the same assembly and fills the hole.
 * Asking again gets a reply built afresh (the bot keeps no cache), under a new group byte.
 *
 * `chunks` is keyed by the chunk index as a string (PORTING.md §3); absent indexes never arrived.
 * `wasCut` is spec §8 revision 7: any chunk said the product was longer than 8 packets and the
 * bot dropped the tail. Not the same claim as a hole in `orderedChunks` — a hole is a chunk the
 * air ate, and asking again may fill it.
 */
export const WeatherTextAssembly = {
  make({
    subject,
    group,
    total,
    chunks = {},
    firstReceivedAt,
    lastReceivedAt,
    request = null,
    source = UNSTATED_SOURCE,
    wasCut = false
  }) {
    return { subject, group, total, chunks, firstReceivedAt, lastReceivedAt, request, source, wasCut }
  },

  decode(json) {
    return {
      subject: json.subject,
      group: json.group,
      total: json.total,
      chunks: json.chunks ?? {},
      firstReceivedAt: json.firstReceivedAt,
      lastReceivedAt: json.lastReceivedAt,
      request: json.request ?? null,
      // Both arrived with revision 7. A reply saved before them is still the reply that was
      // received; it just says nothing about where it came from or whether it was cut.
      source: json.source ?? UNSTATED_SOURCE,
      wasCut: json.wasCut ?? false
    }
  },

  missingIndexes(assembly) {
    const missing = []
    for (let index = 0; index < assembly.total; index += 1) {
      if (assembly.chunks[String(index)] == null) missing.push(index)
    }
    return missing
  },

  isComplete(assembly) {
    return assembly.total > 0 && WeatherTextAssembly.missingIndexes(assembly).length === 0
  },

  /**
   * The chunks in order, null where one never arrived, so the view can place its own
   * "missing part" marker.
   */
  orderedChunks(assembly) {
    const ordered = []
    for (let index = 0; index < assembly.total; index += 1) {
      ordered.push(assembly.chunks[String(index)] ?? null)
    }
    return ordered
  }
}

/**
 * An area sweep being reassembled by `(bot, group)` in `idx` order (spec §12).
 *
 * Revision 9 held one per bot, because a sweep was always the whole country and two pictures of
 * one country are not two things to hold. Revision 10 lets a sweep cover a few states, so a phone
 * can hold last hour's country *and* this minute's Texas and be right about both — and
 * `WeatherBotState.areaSweeps` holds several, with `WeatherStateReducer.retainAreaSweeps` as the
 * only rule that drops one.
 *
 * What still never happens is merging two builds into one assembly: a newer `builtMinutes` under
 * a new `group` is its own assembly, because merging would draw half of this hour's country over
 * half of last hour's, which is the one output a map must never produce.
 *
 * Held whether or not it is complete. Eight packets on a shared channel is the most expensive
 * answer in the protocol, and a sweep missing its last packet is still forty states' worth of
 * map — so a partial one is kept, drawn, and labelled as partial, with `WeatherPartsOffer`
 * offering to fetch the hole.
 *
 * - `isScoped`: bit 7 of the `total` byte, set on every packet, so this is known even when
 *   packet 0 never arrived.
 * - `scope`: `[]` for a national sweep; the state indices packet 0's scope entries named when it
 *   is scoped and packet 0 is held; **null** when it is scoped and packet 0 is missing — which
 *   is "this is not the country and I cannot tell you what it is", never "the country".
 */
export const WeatherAreaSweepAssembly = {
  make({
    builtMinutes,
    group,
    total,
    packets = {},
    firstReceivedAt,
    lastReceivedAt,
    wasCut = false,
    includesAdvisories = false,
    isScoped = false,
    scope = [],
    source = UNSTATED_SOURCE,
    request = null
  }) {
    return {
      builtMinutes, group, total, packets, firstReceivedAt, lastReceivedAt,
      wasCut, includesAdvisories, isScoped, scope, source, request
    }
  },

  decode(json) {
    const isScoped = json.isScoped ?? false
    return {
      builtMinutes: json.builtMinutes,
      group: json.group,
      total: json.total,
      packets: json.packets ?? {},
      firstReceivedAt: json.firstReceivedAt,
      lastReceivedAt: json.lastReceivedAt,
      wasCut: json.wasCut ?? false,
      includesAdvisories: json.includesAdvisories ?? false,
      // Revision 10. A sweep saved before them was the whole country, which is what a cleared
      // flag and an empty scope say; `null` for a scoped one whose packet 0 was never held
      // survives the round trip through JSON as itself.
      isScoped,
      scope: json.scope !== undefined ? json.scope : (isScoped ? null : []),
      source: json.source ?? UNSTATED_SOURCE,
      request: json.request ?? null
    }
  },

  /**
   * Whether this sweep is the newest word on a state — which it can only be when it names it.
   * A national sweep names every state; a scoped one whose packet 0 is missing names none, so
   * it wins nothing and its entries are all it contributes.
   */
  coversState(assembly, { state }) {
    if (!assembly.isScoped) return true
    return (assembly.scope ?? []).includes(state)
  },

  /** When the bot built it, on the bot's clock. */
  builtAt(assembly) { return dateFromUnixMinutes(assembly.builtMinutes) },

  missingIndexes(assembly) {
    const missing = []
    for (let index = 0; index < assembly.total; index += 1) {
      if (assembly.packets[String(index)] == null) missing.push(index)
    }
    return missing
  },

  isComplete(assembly) {
    return assembly.total > 0 && WeatherAreaSweepAssembly.missingIndexes(assembly).length === 0
  },

  receivedPacketCount(assembly) { return Object.keys(assembly.packets).length },

  /**
   * Every entry received, in packet order then in the order the bot sent them — most severe
   * first (spec §12), which is also the order the map lays its tints down in.
   */
  entries(assembly) {
    return Object.keys(assembly.packets)
      .map(Number)
      .sort((lhs, rhs) => lhs - rhs)
      .flatMap((index) => assembly.packets[String(index)] ?? [])
  }
}

/**
 * One tile of a radar picture as the app holds it (spec §13, revision 11).
 *
 * - `tile`: the lattice square, `{ south, west, zoom }`. It is what the entry is keyed by — the
 *   wire carries the same three numbers, so the square a phone holds and the square another
 *   phone asked for are the same square, and one answer serves both.
 * - `radar`: the decoded Radar message, cells and all.
 * - `receivedAt`: phone clock, for the five-minute rule and for ordering two tiles of the same
 *   picture. Never shown as the picture's age — `radar.taken_min` is, and only it.
 * - `source`: where the bot got the picture (spec §2.2, revision 7). A tile off the dish is 1.
 *
 * One per tile **and picture** since revision 13: an older picture of a square is a frame of its
 * loop and joins the newer one rather than being dropped, and only the same `taken` again
 * replaces what is held. A state written before revision 13 held one per tile, which is a list
 * of frames like any other and reads unchanged.
 *
 * A state written by the first build of revision 13 may also hold **detail tiles**: zoom −1,
 * a 1° square with half-degree edges, decoded from a message type that was tried and removed
 * before any release (docs/MESHWX_UI.md §3.1 U-61). They still load — the edges are plain numbers —
 * and are dropped as they are read (`WeatherBotState.decode`) and by retention
 * (`WeatherStateReducer.retainRadarTiles`), because no width on screen draws one and no lattice
 * reader knows a zoom below 0.
 */
export const WeatherStoredRadarTile = {
  make({ tile, radar, receivedAt, source = UNSTATED_SOURCE }) {
    return { tile, radar, receivedAt, source }
  },

  /** False for a detail tile of the removed zoom −1 level (above), which is not kept. */
  isKept(stored) {
    return !(stored?.tile?.zoom < 0)
  },

  decode(json) {
    return {
      tile: json.tile,
      radar: json.radar,
      receivedAt: json.receivedAt,
      source: json.source ?? UNSTATED_SOURCE
    }
  },

  /** When the radar picture was taken, on the clock printed on the picture itself. */
  takenAt(stored) { return dateFromUnixMinutes(stored.radar.taken_min) }
}

// MARK: - Per-bot state

/**
 * One accepted message in the duplicate window: its `seq`, and a fingerprint of its content so
 * a new message that reuses a `seq` after the bot restarts is not taken for a copy.
 *
 * `fingerprint` is `WeatherStateReducer.fingerprint(message)` as a hex string, or null for an
 * entry from a state file written before fingerprints.
 */
export const WeatherSeenMessage = {
  make({ seq, fingerprint }) { return { seq, fingerprint } },

  /**
   * A copy has the same `seq` and, where both fingerprints are known, the same content. With
   * either unknown the `seq` alone decides, as it did before fingerprints.
   */
  isCopy(seen, { seq, fingerprint }) {
    if (seq !== seen.seq) return false
    if (fingerprint == null || seen.fingerprint == null) return true
    return fingerprint === seen.fingerprint
  }
}

/** Ranks for `MeshWXSeverity`, which `activeWarnings` sorts on (spec §18.2). */
const SEVERITY_RANK = Object.freeze({ warning: 3, watch: 2, advisory: 1, statement: 0 })

/**
 * Everything the app holds for one bot (spec §20: "keep separate state per bot").
 *
 * Dictionaries are string-keyed plain objects (PORTING.md §3): `warnings`, `pendingUpgrades` and
 * `recentCancels` by warning identity (`"event.office.etn"`), `observations` by station index,
 * `forecasts` by bundled point index, `unbundledForecasts` by the coordinate asked for, `texts`
 * by text group. `missingFromDigest` is a list of identity triples, `areaSweeps` a list newest
 * first, `radarTiles` a list newest `taken` first. Every field survives
 * `JSON.parse(JSON.stringify(state))` unchanged.
 */
export const WeatherBotState = {
  make({ botID }) {
    return {
      botID,
      /** The newest `seq` accepted, for gap detection (spec §2.4). */
      lastSeq: null,
      /**
       * The last few accepted messages, newest last. A copy of any of them is a duplicate however
       * late it arrives; comparing against `lastSeq` alone let a late copy through as a gap and
       * could bring a cancelled warning back.
       */
      recentMessages: [],
      lastHeardAt: null,
      /**
       * The last message heard live from this bot — not drained from the radio's queue at
       * connect. What "the bot is in range" rests on: a backlog is stamped with the drain time,
       * so a bot that went silent hours ago would otherwise look current.
       */
      lastLiveHeardAt: null,
      /**
       * Set on a `seq` gap or an out-of-order message; cleared only by a digest built after the
       * gap was seen — the cue that `>d` would help and that "no alerts" cannot be claimed.
       */
      needsDigest: false,
      /**
       * Phone time the outstanding gap was detected, so a digest built before it — delivered
       * late, or drained from the radio's queue — does not clear it.
       */
      gapDetectedAt: null,
      warnings: {},
      /** Upgraded warnings whose replacement has not been received. */
      pendingUpgrades: {},
      /**
       * Identities cancelled in the last hour, and when. A warning for one of them arriving out
       * of order was sent before its cancel, and is not stored again.
       */
      recentCancels: {},
      digest: null,
      /**
       * Identities the last digest listed that the app does not hold: each is one
       * `>w <identity>` away (spec §5).
       */
      missingFromDigest: [],
      observations: {},
      /** By bundled point index. A forecast for a point the bundle has not is not here. */
      forecasts: {},
      /**
       * Forecasts the bot chose the point for (`point == 0xFFFF`, spec §7), keyed by the
       * coordinate *asked for*, exactly as `>f <lat>,<lon>` wrote it: `"35.687,-105.938"`.
       *
       * They cannot live in `forecasts` because they all share one index and would overwrite
       * each other, and because the index says nothing about where the forecast is for — the
       * question does. One arriving with no `forecastAt` of this phone's pending is somebody
       * else's question and is kept under `"?"`, for the Cached screen only: there is nothing to
       * measure it against, so it is never shown as a place's forecast
       * (docs/MESHWX_UI.md §12, spec revision 10).
       */
      unbundledForecasts: {},
      texts: {},
      /**
       * What the bot says it carries (spec §10). Null until it has said: the station footprint is
       * the fallback then, and nothing the bot has not stated may put a place outside its area.
       */
      coverage: null,
      /**
       * The area sweeps this bot sent (spec §12), complete or partial, **newest first**. Empty
       * until one has been heard — and it never is until somebody on the channel taps for one.
       *
       * Several, since revision 10: a sweep can now cover a few states, so last hour's country
       * and this minute's Texas are both true and both worth holding.
       * `WeatherStateReducer.retainAreaSweeps` is the only thing that drops one.
       */
      areaSweeps: [],
      /**
       * The radar tiles this bot sent (spec §13, revision 11), **newest `taken` first**. Empty
       * until somebody on the channel asks for one: there is no scheduled radar broadcast.
       *
       * One entry per lattice square and picture, `(tile, taken)`, since revision 13: the
       * frames a loop is played from. `WeatherStateReducer.retainRadarTiles` is the only thing
       * that drops one.
       */
      radarTiles: []
    }
  },

  /**
   * State read back from persisted JSON. Fields added after the first release read as absent
   * rather than failing the whole file: a state file from before them is still the last picture
   * the bot sent.
   */
  decode(json) {
    const state = WeatherBotState.make({ botID: json.botID })
    state.lastSeq = json.lastSeq ?? null
    if (Array.isArray(json.recentMessages)) {
      state.recentMessages = json.recentMessages.map(
        (seen) => WeatherSeenMessage.make({ seq: seen.seq, fingerprint: seen.fingerprint ?? null })
      )
    } else {
      // Before fingerprints the duplicate window was bare `seq` values.
      state.recentMessages = (json.recentSeqs ?? []).map(
        (seq) => WeatherSeenMessage.make({ seq, fingerprint: null })
      )
    }
    state.lastHeardAt = json.lastHeardAt ?? null
    state.lastLiveHeardAt = json.lastLiveHeardAt ?? null
    state.needsDigest = json.needsDigest ?? false
    state.gapDetectedAt = json.gapDetectedAt ?? null
    state.warnings = mapValues(json.warnings ?? {}, WeatherStoredWarning.decode)
    state.pendingUpgrades = { ...(json.pendingUpgrades ?? {}) }
    state.recentCancels = { ...(json.recentCancels ?? {}) }
    state.digest = json.digest ?? null
    state.missingFromDigest = json.missingFromDigest ?? []
    state.observations = mapValues(json.observations ?? {}, WeatherStoredObservation.decode)
    state.forecasts = mapValues(json.forecasts ?? {}, WeatherStoredForecast.decode)
    state.unbundledForecasts = mapValues(json.unbundledForecasts ?? {}, WeatherStoredForecast.decode)
    // Before revision 10 a bot-chosen point was kept in `forecasts` under the `0xFFFF` sentinel,
    // where it was never shown as anywhere's forecast because no place has that index. It is the
    // same forecast under the same rule, so it moves to the slot for questions nobody here asked.
    const strandedKey = String(MeshWXWire.unbundledPoint)
    const stranded = state.forecasts[strandedKey]
    if (stranded != null) {
      delete state.forecasts[strandedKey]
      state.unbundledForecasts[UNASKED_FORECAST_KEY] ??= stranded
    }
    state.texts = mapValues(json.texts ?? {}, WeatherTextAssembly.decode)
    // A file written before the bot stated anything, or before the app could read it: absent is
    // "has not said", which falls back to the station footprint rather than failing the file.
    state.coverage = json.coverage ?? null
    // Revision 8, §12. A file written before the app could read a sweep decodes as having none,
    // which is exactly right: nobody had asked for one. A file written between revisions 9 and 10
    // held exactly one, under `areaSweep`: it is lifted into the list rather than dropped, so a
    // map that was on screen before an update is still on screen after it.
    if (Array.isArray(json.areaSweeps)) {
      state.areaSweeps = json.areaSweeps.map(WeatherAreaSweepAssembly.decode)
    } else if (json.areaSweep != null) {
      state.areaSweeps = [WeatherAreaSweepAssembly.decode(json.areaSweep)]
    } else {
      state.areaSweeps = []
    }
    // Revision 11, §13. Absent in a state file written before it is an empty list, which is
    // exactly right: nobody had asked for a radar picture, and none had ever been held. The
    // detail tiles of revision 13's first build (zoom −1) are left behind; every other frame
    // reads as it was written.
    state.radarTiles = (json.radarTiles ?? [])
      .map(WeatherStoredRadarTile.decode)
      .filter(WeatherStoredRadarTile.isKept)
    return state
  },

  /**
   * Warnings not yet expired at `at`, in the spec's display order (§18.2): the most severe
   * first (warnings above watches above advisories), then the soonest expiry. An event the
   * tables cannot rank sorts last.
   *
   * `severity` is `(event) => MeshWXSeverity | null`, as in Swift; the rank table is spelled out
   * here rather than read off the enum, so this module needs nothing of `MeshWXSeverity` but its
   * case names.
   */
  activeWarnings(state, { at, severity }) {
    const rankOf = (event) => {
      const value = severity(event)
      return value == null ? -1 : (SEVERITY_RANK[value] ?? -1)
    }
    return Object.values(state.warnings)
      .filter((stored) => !WeatherStoredWarning.isExpired(stored, { at }))
      .sort((lhs, rhs) => {
        const lhsRank = rankOf(lhs.warning.event)
        const rhsRank = rankOf(rhs.warning.event)
        if (lhsRank !== rhsRank) return rhsRank - lhsRank
        const lhsExpires = WeatherStoredWarning.expiresAt(lhs)
        const rhsExpires = WeatherStoredWarning.expiresAt(rhs)
        if (lhsExpires !== rhsExpires) return lhsExpires - rhsExpires
        return lhs.warning.etn - rhs.warning.etn
      })
  },

  /** The newest reading held, by the time its station measured it (spec §6.1), if any. */
  latestObservationMinutes(state) {
    const minutes = Object.values(state.observations).map((stored) => stored.timestampMinutes)
    return minutes.length === 0 ? null : Math.max(...minutes)
  }
}

function mapValues(object, transform) {
  const result = {}
  for (const [key, value] of Object.entries(object)) result[key] = transform(value)
  return result
}
