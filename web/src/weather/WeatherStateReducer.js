// Port of MC1Services/Services/Weather/WeatherStateReducer.swift (docs/PORTING.md).
//
// Deviation from the Swift: Swift takes `state` `inout` and returns the changes. JS reducers stay
// pure (PORTING.md §3), so every entry point here returns the new state:
//
//   apply(message, { to, receivedAt, areaCentre }) -> { state, changes }
//   pruneExpired(state, { expiredBefore })        -> { state, expired }
//   dropFutureTimes(state, { now })               -> state
//   prunePendingUpgrades(state, { olderThan })    -> state
//   pruneTexts(state, { receivedBefore, limit })  -> state
//   pruneForecasts(state, { receivedBefore, limit }) -> state
//
// The message is the decoded wire object (PORTING.md §5): `message.seq`, `message.bot`,
// `message.type`, `message.flags`, `message.name` for the payload kind, `message.source` for the
// header's data source, and the payload's own fields flat on the same object.

import {
  MeshWXAreaRun, MeshWXCoverage, MeshWXGeo, MeshWXRadar, MeshWXRadarTile, MeshWXWire
} from '../meshwx/index.js'
import {
  UNASKED_FORECAST_KEY,
  UNSTATED_SOURCE,
  WeatherAreaSweepAssembly,
  WeatherPendingUpgrade,
  WeatherSeenMessage,
  WeatherStoredCoverage,
  WeatherStoredDigest,
  WeatherStoredForecast,
  WeatherStoredObservation,
  WeatherStoredRadarTile,
  WeatherStoredWarning,
  WeatherTextAssembly,
  dateFromUnixMinutes,
  identityKey,
  identityOf
} from './WeatherBotState.js'

/** Spec §4: the cancel reason that says the warning was upgraded, not simply ended. */
const CANCEL_REASON_UPGRADED = 2

/**
 * What applying one message did to a bot's state. The UI re-reads state on any change; the
 * cases exist so tests can pin every rule in spec §2.4 and §3–§8 individually.
 */
export const WeatherStateChange = Object.freeze({
  /**
   * A copy of a message already accepted — the same `seq` and the same content: the bot's
   * second transmission of an unechoed packet, or a copy delivered late. Nothing else in the
   * message is looked at.
   */
  duplicate({ seq }) { return { kind: 'duplicate', seq } },
  /** `seq` skipped ahead: at least one message was missed. */
  sequenceGap({ expected, received }) { return { kind: 'sequenceGap', expected, received } },
  /**
   * `seq` fell further behind than reordering explains, or repeated the newest `seq` with new
   * content: the bot's counter started again. A revision 2 bot picks a random start every time
   * it starts; a revision 3 bot saves its counter, so this is rare from one. A new stream starts
   * at this message, which is applied normally; what went out around the restart is unknown, so
   * it counts as a gap.
   */
  sequenceRestart({ last, received }) { return { kind: 'sequenceRestart', last, received } },
  /**
   * A `seq` a little behind the newest accepted one and not a known copy: a late resend or a
   * reordered delivery. It is applied where it cannot undo something newer, and the gap it
   * reveals asks for a digest.
   */
  outOfOrder({ seq }) { return { kind: 'outOfOrder', seq } },
  warningStored(identity, { replacedExisting }) {
    return { kind: 'warningStored', value: identity, replacedExisting }
  },
  /** A held warning ended. `reason` is the cancel's, or null when a digest omitted it. */
  warningRemoved(identity, { reason }) {
    return { kind: 'warningRemoved', value: identity, reason }
  },
  /** A cancel for an identity the app never held; nothing to remove. */
  cancelForUnknown(identity) { return { kind: 'cancelForUnknown', value: identity } },
  digestApplied({ missing, removed }) { return { kind: 'digestApplied', missing, removed } },
  /**
   * The digest was built before the one already held — a late drain from the radio's queue —
   * so it changed nothing.
   */
  digestIgnoredOlder({ builtMinutes }) { return { kind: 'digestIgnoredOlder', builtMinutes } },
  observationsStored({ stations }) { return { kind: 'observationsStored', stations } },
  forecastStored({ point }) { return { kind: 'forecastStored', point } },
  /** The held forecast for that point was issued later than this one; kept the held one. */
  forecastIgnoredOlder({ point }) { return { kind: 'forecastIgnoredOlder', point } },
  textChunkStored({ group, index, isComplete }) {
    return { kind: 'textChunkStored', group, index, isComplete }
  },
  /** The bot stated what it carries (spec §10); it replaces any statement held. */
  coverageStored: Object.freeze({ kind: 'coverageStored' }),
  /**
   * A statement that arrived out of order behind one already held: the held one came in a
   * message the bot sent later, so it stands.
   */
  coverageIgnoredOlder: Object.freeze({ kind: 'coverageIgnoredOlder' }),
  /** One packet of a national area sweep landed (spec §12). */
  areaSweepStored({ group, index, isComplete }) {
    return { kind: 'areaSweepStored', group, index, isComplete }
  },
  /**
   * The sweep was built before the one already held — a late drain from the radio's queue — so
   * it changed nothing.
   */
  areaSweepIgnoredOlder({ builtMinutes }) { return { kind: 'areaSweepIgnoredOlder', builtMinutes } },
  /**
   * A radar frame landed (spec §13). `value` is the lattice square it is of. Since revision 13 an
   * older picture of a square is a frame of its loop and lands here too.
   */
  radarStored(tile, { takenMinutes }) { return { kind: 'radarStored', value: tile, takenMinutes } },
  /**
   * The coarse half of a picture already held fine, or a picture too far behind everything else
   * held to be kept. Either way nothing on screen changes.
   */
  radarIgnoredOlder({ takenMinutes }) { return { kind: 'radarIgnoredOlder', takenMinutes } },
  notAvailable(notAvailable) { return { kind: 'notAvailable', value: notAvailable } },
  /**
   * The message's own time — a digest's `now`, a batch's `ts`, a forecast's issue, a sweep's
   * build, a picture's `taken`, a warning's issue — is more than `futureTolerance` ahead of the
   * phone's clock. No bot sends that honestly: every one of them is a time something already
   * happened. A digest, batch, forecast, sweep or picture is dropped whole, because kept it would
   * stand as "newest" over everything real until the clock caught up — one digest stamped
   * `0xFFFFFF00` would make every real digest "older", and its empty list would end every warning
   * held. A
   * warning is still stored, without the issue time (it is still a warning), and the change
   * comes before its `warningStored`.
   */
  futureTimeRejected({ minutes }) { return { kind: 'futureTimeRejected', minutes } },
  unknownType({ rawType }) { return { kind: 'unknownType', rawType } }
})

/**
 * Pure state transitions for one bot. No clock, no I/O, no tables: every input is in the
 * arguments, which is what makes each spec rule a one-line test.
 */
export const WeatherStateReducer = {
  /** How many accepted messages count as "already seen". */
  duplicateWindow: 16,
  /**
   * After this long without hearing the bot, a repeated `seq` is a new message that wrapped
   * around, not a copy. Seconds.
   */
  duplicateWindowReset: 6 * 60 * 60,
  /**
   * How far behind the newest accepted `seq` a message may be and still be the same stream
   * arriving out of order. The bot resends an unechoed packet once, 8–10 s later, while other
   * packets go out every 2 s, so a resend lands a handful of places back. Anything further
   * behind is a restart: a revision 2 bot starts its counter at a random value every time it
   * starts (revision 3 saves it, and saves past a batch before sending it).
   */
  reorderWindow: 32,
  /**
   * A digest speaks only for warnings that arrived before it was built. Arrival is on the
   * phone's clock and building on the bot's, so a margin absorbs the difference between the two
   * clocks and the minute the bot truncates `now` to. Nothing else: the bot keeps no answer
   * cache (spec §14, revision 2), so a digest is built when it is sent. Seconds.
   */
  digestMargin: 2 * 60,
  /**
   * How long a cancel is remembered, so a late copy of the warning it ended is not stored again.
   * Seconds.
   */
  recentCancelRetention: 60 * 60,
  /**
   * How far ahead of the phone's clock a time on the wire may be and still be a time (spec
   * §17.5, 17 October 2026). Every time a bot sends is something that already happened, so this
   * only absorbs a bot's clock and the phone's disagreeing — and the bot truncating to the minute.
   * Seconds.
   */
  futureTolerance: 15 * 60,
  /**
   * The furthest ahead an expiry is believed, from when the warning was heard (spec §17.5). A
   * product in force until further notice reaches the phone with an expiry the bot invented 12
   * hours ahead (spec §3), re-sent as it moves, and every real product ends well inside this; an
   * expiry past it is clamped here, so a forged or corrupt one cannot pin a warning to the screen
   * for years. Measured from receipt rather than from the issue time: the until-further-notice
   * flood warning keeps its original issue time, and a cap from that would end a warning the
   * bot still says is in force. Seconds.
   */
  warningHorizon: 14 * 24 * 60 * 60,
  /**
   * How far past a bot's stated circle the centre of a county may lie and the county still reach
   * into it (`touchesCoverage`). The bot covers every county whose outline meets the circle; the
   * phone has only the county's centre, so the margin is half a county of the plains. Where it is
   * short the error is the safe one: a watch the list was not speaking for ends by its cancel or
   * its expiry instead of by the list. Kilometres.
   */
  countyReachKilometres: 25,
  /**
   * For a statement with no circle (an area made of states or offices): how near a warning must
   * come to the centre of a stated area to touch it (`touchesCoverage`). Kilometres.
   */
  areaReachKilometres: 25,
  /**
   * How recently a held warning must have arrived for its `seq` to be compared with a late one:
   * `seq` wraps, so an old copy's number says nothing about order. Seconds.
   */
  reorderRecency: 10 * 60,

  /**
   * Applies `message` (already known to be from `state.botID`) and reports what changed.
   *
   * Out of order, a message is applied unless it could roll back something newer: a warning is
   * stored only when this identity is neither held (the held copy came in a newer message) nor
   * cancelled in the last hour (the warning was sent before its cancel); a cancel always applies,
   * because an ETN is never reissued; a digest goes through the same build-time check as any
   * other; observations, forecasts and text already keep the newest by their own times; a
   * coverage statement has no time of its own, so it yields to one already held.
   */
  apply(message, { to, receivedAt, areaCentre = null }) {
    const seq = message.seq
    const fingerprint = WeatherStateReducer.fingerprint(message)
    const isLongSilence = to.lastHeardAt != null
      && (receivedAt - to.lastHeardAt) / 1000 > WeatherStateReducer.duplicateWindowReset
    const seen = isLongSilence ? [] : to.recentMessages
    if (seen.some((entry) => WeatherSeenMessage.isCopy(entry, { seq, fingerprint }))) {
      return { state: to, changes: [WeatherStateChange.duplicate({ seq })] }
    }

    const state = {
      ...to,
      recentMessages: [...seen],
      warnings: { ...to.warnings },
      pendingUpgrades: { ...to.pendingUpgrades },
      recentCancels: { ...to.recentCancels },
      missingFromDigest: [...to.missingFromDigest],
      observations: { ...to.observations },
      forecasts: { ...to.forecasts },
      unbundledForecasts: { ...(to.unbundledForecasts ?? {}) },
      texts: { ...to.texts },
      areaSweeps: [...(to.areaSweeps ?? [])],
      radarTiles: [...(to.radarTiles ?? [])]
    }

    const changes = []
    let isOutOfOrder = false
    if (state.lastSeq != null) {
      const lastSeq = state.lastSeq
      const forward = (seq - lastSeq) & 0xff
      // After a long silence nothing about the old `seq` can be trusted: anything but the next
      // number is a gap.
      const place = isLongSilence && forward !== 1 ? 'ahead' : position(forward)
      switch (place) {
        case 'next':
          state.lastSeq = seq
          break
        case 'ahead':
          changes.push(WeatherStateChange.sequenceGap({ expected: (lastSeq + 1) & 0xff, received: seq }))
          markGap(state, receivedAt)
          state.lastSeq = seq
          break
        case 'behind':
          isOutOfOrder = true
          changes.push(WeatherStateChange.outOfOrder({ seq }))
          markGap(state, receivedAt)
          break
        default:
          changes.push(WeatherStateChange.sequenceRestart({ last: lastSeq, received: seq }))
          markGap(state, receivedAt)
          state.lastSeq = seq
          state.recentMessages = []
          break
      }
    } else {
      state.lastSeq = seq
    }
    state.recentMessages.push(WeatherSeenMessage.make({ seq, fingerprint }))
    if (state.recentMessages.length > WeatherStateReducer.duplicateWindow) {
      state.recentMessages = state.recentMessages.slice(-WeatherStateReducer.duplicateWindow)
    }
    state.lastHeardAt = Math.max(state.lastHeardAt ?? receivedAt, receivedAt)
    state.recentCancels = Object.fromEntries(
      Object.entries(state.recentCancels).filter(
        ([, at]) => (receivedAt - at) / 1000 < WeatherStateReducer.recentCancelRetention
      )
    )

    // Where the bot got what it is about to say (spec §2.2, revision 7). It rides on the header,
    // so every `store` below is handed it rather than digging it out of a body that does not
    // carry it. Unstated for a bot older than revision 7, and for a Cancel always.
    const source = message.source ?? UNSTATED_SOURCE

    // A message whose own time is in the future is not stored as the newest of anything (spec
    // §17.5). A warning's is its issue time, and that one costs only the issue time.
    const ownMinutes = messageMinutes(message)
    if (ownMinutes != null && WeatherStateReducer.isAhead(ownMinutes, { of: receivedAt })) {
      changes.push(WeatherStateChange.futureTimeRejected({ minutes: ownMinutes }))
      if (message.name !== 'warning') return { state, changes }
    }

    switch (message.name) {
      case 'warning':
        if (!(isOutOfOrder && wouldRollBack(message, { seq, state, receivedAt }))) {
          changes.push(storeWarning(
            WeatherStateReducer.cappedWarning(message, { receivedAt }),
            { state, receivedAt, seq, source }
          ))
        }
        break
      case 'cancel':
        changes.push(removeWarning(message, { state, receivedAt, isOutOfOrder }))
        break
      case 'digest':
        changes.push(applyDigest(message, { state, receivedAt, areaCentre }))
        break
      case 'observations':
        changes.push(storeObservations(message, { state, receivedAt, source }))
        break
      case 'forecast':
        changes.push(storeForecast(message, { state, receivedAt, source }))
        break
      case 'text':
        changes.push(storeText(message, { state, receivedAt, source }))
        break
      case 'coverage':
        changes.push(storeCoverage(message, { state, receivedAt, isOutOfOrder }))
        break
      case 'area_sweep':
        changes.push(storeAreaSweep(message, { state, receivedAt, source }))
        break
      case 'radar':
        changes.push(storeRadar(message, { state, receivedAt, source }))
        break
      case 'not_available':
        changes.push(WeatherStateChange.notAvailable(message))
        break
      case 'request':
        // Another phone's `>` request, heard because requests are flooded on `#meshwx` now (spec
        // §11). `WeatherService.ingest` drops one before it ever reaches here: it is somebody
        // else's question, it is not the bot, and nothing in it is this bot's state.
        break
      default:
        changes.push(WeatherStateChange.unknownType({ rawType: message.type }))
        break
    }
    return { state, changes }
  },

  /**
   * FNV-1a over the message's content: the same for the bot's byte-identical resend, and
   * different for a new message that reuses a `seq` after a restart.
   *
   * Deviation: Swift hashes the re-encoded wire bytes. A decoded message here is JSON
   * (PORTING.md §5), so this hashes a canonical rendering of that JSON — key order normalised —
   * which is the same for two byte-identical packets and different for two different ones. It
   * also keeps the reducer free of the codec, so a pure state rule needs no encoder. The value
   * is a 16-character lower-case hex string rather than a `UInt64`, because state is persisted as
   * JSON and a `BigInt` is not JSON-serialisable (PORTING.md §3, rule 4).
   */
  fingerprint(message) {
    if (message == null) return null
    let hash = 0xcbf29ce484222325n
    const prime = 0x100000001b3n
    const mask = 0xffffffffffffffffn
    const text = canonicalJSON(message)
    for (let index = 0; index < text.length; index += 1) {
      // The canonical rendering is ASCII apart from message text, which is hashed by code unit.
      hash ^= BigInt(text.charCodeAt(index))
      hash = (hash * prime) & mask
    }
    return hash.toString(16).padStart(16, '0')
  },

  /**
   * Drops warnings that expired before `expiredBefore`, returning what went. Expiry is judged at
   * read time everywhere else; this exists so persisted state does not grow without bound.
   */
  pruneExpired(state, { expiredBefore }) {
    const expired = Object.values(state.warnings)
      .filter((stored) => WeatherStoredWarning.isExpired(stored, { at: expiredBefore }))
      .map((stored) => identityOf(stored.warning))
      .sort(WeatherStateReducer.identityOrder)
    if (expired.length === 0) return { state, expired }
    const warnings = { ...state.warnings }
    for (const identity of expired) delete warnings[identityKey(identity)]
    return { state: { ...state, warnings }, expired }
  },

  // MARK: - Times ahead of the phone's clock (spec §17.5)

  /** Whether a wire time in Unix minutes is more than `futureTolerance` ahead of `of` (ms). */
  isAhead(minutes, { of: now }) {
    return dateFromUnixMinutes(minutes) > now + WeatherStateReducer.futureTolerance * 1000
  },

  /**
   * A warning as the phone may believe it, heard at `receivedAt`: an issue time ahead of the
   * clock is dropped, and the start with it, since both ride on the same expiry; an expiry past
   * `warningHorizon` is clamped to it; and a start that no longer falls before the expiry goes.
   * The same object when nothing needed changing.
   */
  cappedWarning(warning, { receivedAt }) {
    const ceiling = Math.floor(receivedAt / 60_000) + WeatherStateReducer.warningHorizon / 60
    let issued = warning.issued_min ?? null
    let begins = warning.begins_min ?? null
    if (issued != null && WeatherStateReducer.isAhead(issued, { of: receivedAt })) {
      issued = null
      begins = null
    }
    const expires = Math.min(warning.expires_min, ceiling)
    if (begins != null && begins >= expires) begins = null
    if (expires === warning.expires_min && issued === (warning.issued_min ?? null)
      && begins === (warning.begins_min ?? null)) {
      return warning
    }
    return { ...warning, expires_min: expires, issued_min: issued, begins_min: begins }
  },

  /**
   * Takes out of persisted state anything stamped ahead of `now`: state saved before the phone
   * checked (spec §17.5). A digest built in the future is forgotten with the list it named — or
   * it would go on turning every real digest away as older — and so are readings, forecasts,
   * sweeps and radar pictures from the future, which would go on standing as the newest. A held
   * warning keeps its place, capped as `cappedWarning` would have capped it on arrival.
   */
  dropFutureTimes(state, { now }) {
    const ahead = (minutes) => minutes != null && WeatherStateReducer.isAhead(minutes, { of: now })
    let next = state
    const change = (patch) => { next = { ...next, ...patch } }
    if (next.digest != null && ahead(next.digest.digest.now_min)) {
      change({ digest: null, missingFromDigest: [] })
    }
    const observations = {}
    let observationsChanged = false
    for (const [key, stored] of Object.entries(next.observations ?? {})) {
      if (ahead(stored.timestampMinutes)) { observationsChanged = true; continue }
      if (ahead(stored.lastBatchMinutes)) {
        observationsChanged = true
        observations[key] = { ...stored, lastBatchMinutes: null }
        continue
      }
      observations[key] = stored
    }
    if (observationsChanged) change({ observations })
    for (const field of ['forecasts', 'unbundledForecasts']) {
      const held = next[field] ?? {}
      const kept = Object.fromEntries(
        Object.entries(held).filter(([, stored]) => !ahead(stored.forecast.issued_min))
      )
      if (Object.keys(kept).length !== Object.keys(held).length) change({ [field]: kept })
    }
    const sweeps = (next.areaSweeps ?? []).filter((sweep) => !ahead(sweep.builtMinutes))
    if (sweeps.length !== (next.areaSweeps ?? []).length) change({ areaSweeps: sweeps })
    const tiles = (next.radarTiles ?? []).filter((stored) => !ahead(stored.radar.taken_min))
    if (tiles.length !== (next.radarTiles ?? []).length) change({ radarTiles: tiles })

    const warnings = {}
    let warningsChanged = false
    const futureAt = now + WeatherStateReducer.futureTolerance * 1000
    for (const [key, stored] of Object.entries(next.warnings ?? {})) {
      const warning = WeatherStateReducer.cappedWarning(stored.warning, { receivedAt: now })
      // The start rides on the issue time (spec §3), so it goes with one from the future.
      const issuedAt = stored.issuedAt != null && stored.issuedAt > futureAt ? null : stored.issuedAt
      let beginsAt = issuedAt == null && stored.issuedAt != null ? null : stored.beginsAt
      if (beginsAt != null && beginsAt >= dateFromUnixMinutes(warning.expires_min)) beginsAt = null
      if (warning === stored.warning && issuedAt === stored.issuedAt && beginsAt === stored.beginsAt) {
        warnings[key] = stored
        continue
      }
      warningsChanged = true
      warnings[key] = { ...stored, warning, issuedAt, beginsAt }
    }
    if (warningsChanged) change({ warnings })
    return next
  },

  // MARK: - What a digest speaks for (spec §5, 17 October 2026)

  /**
   * Whether this bot's digest speaks for a held warning, so that its absence from the list
   * ends it. A bot answers a place-named `>w` anywhere in the country (spec §14), but its
   * digest lists only what is active in its own coverage, so a warning the phone fetched from it
   * for a place outside that coverage is absent from every digest it will ever send — and is not
   * over. With the bot's own complete statement of its area held (Coverage, spec §10), a digest
   * ends only what touches that area; a warning outside it ends by its expiry, its cancel, or a
   * fresh answer. Without a complete statement nothing says where the area stops, and the digest
   * speaks for everything, as it always did.
   *
   * `areaCentre({ state, county, number })` is the bundle's centre of one county or zone,
   * `{ latitude, longitude }` or null; without it a county is judged by the stated runs alone.
   */
  digestSpeaksFor(warning, { coverage, areaCentre = null }) {
    if (coverage == null || !MeshWXCoverage.isComplete(coverage)) return true
    return WeatherStateReducer.touchesCoverage(warning, coverage, { areaCentre })
  },

  /**
   * Whether a warning's area touches a bot's stated coverage, by the bot's own rule (its
   * `_in_coverage`): a zone it lists; for a product without a polygon (a watch by county), a
   * county it covers; for a storm-based warning, the polygon against the circle — the counties
   * on such a warning are only the ones its polygon crosses, so they do not count on their own.
   *
   * The statement lists zones, not the counties the bot derives from its circle, so a county is
   * judged by its centre against the circle, `countyReachKilometres` generous. A statement
   * without a circle is an area of states or offices, and there the warning must come within
   * `areaReachKilometres` of a stated area's centre. Nothing here ever reads an office: WX-AUS
   * lists HGX because a few Houston zones reach its circle, and Houston is not in its area.
   */
  touchesCoverage(warning, coverage, { areaCentre = null } = {}) {
    if (MeshWXCoverage.hasNoAreaFilter(coverage)) return true
    const polygon = warning.polygon ?? []
    const hasPolygon = polygon.length >= 3
    const runs = warning.areas ?? []
    const stated = coverage.areas ?? []
    for (const run of runs) {
      if (run.county && hasPolygon) continue
      if (stated.some((one) => runsOverlap(run, one))) return true
    }
    const counties = hasPolygon ? [] : centresOf(runs.filter((run) => run.county), areaCentre)
    const centre = MeshWXCoverage.centre(coverage)
    if (centre != null && coverage.radius_km > 0) {
      if (hasPolygon) return polygonReaches(polygon, centre, coverage.radius_km)
      const reach = coverage.radius_km + WeatherStateReducer.countyReachKilometres
      if (counties.some((point) => kilometres(point, centre) <= reach)) return true
    }
    if (!hasPolygon && counties.length === 0) return false
    const statedCentres = centresOf(stated, areaCentre)
    const reach = WeatherStateReducer.areaReachKilometres
    if (hasPolygon) return statedCentres.some((point) => polygonReaches(polygon, point, reach))
    return counties.some((county) => statedCentres.some((point) => kilometres(county, point) <= reach))
  },

  /**
   * Forgets upgrade markers older than `olderThan`: long enough that the replacement, if it was
   * ever sent, has been listed by a digest or has itself expired.
   */
  prunePendingUpgrades(state, { olderThan }) {
    return {
      ...state,
      pendingUpgrades: Object.fromEntries(
        Object.entries(state.pendingUpgrades).filter(([, pending]) => pending.cancelledAt >= olderThan)
      )
    }
  },

  // MARK: - Retention
  //
  // Answers on `#meshwx` reach every phone, so a phone that never asks for anything still
  // accumulates other people's replies and other people's forecasts. Readings have had an age
  // and a ceiling from the start (`WeatherService.trim`); these give texts and forecasts the
  // same treatment, so the cache cannot grow for ever — while what a screen would actually show
  // survives both rules, however old it is.

  /**
   * Drops text replies received before `receivedBefore`, then caps what is left at `limit`,
   * newest kept. What the screens can still show (`shownTextGroups`) survives both.
   */
  pruneTexts(state, { receivedBefore, limit }) {
    const shown = WeatherStateReducer.shownTextGroups(state)
    let kept = Object.fromEntries(
      Object.entries(state.texts).filter(
        ([group, assembly]) => shown.has(group) || assembly.lastReceivedAt >= receivedBefore
      )
    )
    if (Object.keys(kept).length > limit) {
      const room = Math.max(0, limit - shown.size)
      const spare = Object.keys(kept)
        .filter((group) => !shown.has(group))
        .sort((lhs, rhs) => {
          const left = kept[lhs].lastReceivedAt
          const right = kept[rhs].lastReceivedAt
          return left !== right ? right - left : Number(lhs) - Number(rhs)
        })
        .slice(0, room)
      const survivors = new Set([...shown, ...spare])
      kept = Object.fromEntries(Object.entries(kept).filter(([group]) => survivors.has(group)))
    }
    return { ...state, texts: kept }
  },

  /**
   * The text groups a screen can still put on the page (docs/MESHWX_UI.md §12): the newest
   * reply on each subject, which is what a product screen falls back to when nobody here asked,
   * and the newest reply on each subject that answered a request of this phone's, which is what
   * it shows first. At most two per subject, so this can never hold the cache open.
   *
   * Returns the `state.texts` keys, not the group bytes, because the keys are what the caller
   * filters on.
   */
  shownTextGroups(state) {
    const newest = new Map()
    const newestOwn = new Map()
    for (const [key, assembly] of Object.entries(state.texts)) {
      const held = newest.get(assembly.subject)
      if (held == null || state.texts[held].lastReceivedAt < assembly.lastReceivedAt) {
        newest.set(assembly.subject, key)
      }
      if (assembly.request == null) continue
      const own = newestOwn.get(assembly.subject)
      if (own == null || state.texts[own].lastReceivedAt < assembly.lastReceivedAt) {
        newestOwn.set(assembly.subject, key)
      }
    }
    return new Set([...newest.values(), ...newestOwn.values()])
  },

  /**
   * Drops forecasts received before `receivedBefore`, then caps what is left at `limit`. The
   * place's own forecast (`shownForecastPoints`) survives both, and under the ceiling the
   * forecasts this phone asked for outlast the ones the channel happened to carry.
   */
  pruneForecasts(state, { receivedBefore, limit }) {
    const shown = WeatherStateReducer.shownForecastPoints(state)
    let kept = Object.fromEntries(
      Object.entries(state.forecasts).filter(
        ([point, stored]) => shown.has(point) || stored.receivedAt >= receivedBefore
      )
    )
    if (Object.keys(kept).length > limit) {
      const room = Math.max(0, limit - shown.size)
      const spare = Object.keys(kept)
        .filter((point) => !shown.has(point))
        .sort((lhs, rhs) => {
          const left = kept[lhs]
          const right = kept[rhs]
          if (left.requestedHere !== right.requestedHere) return left.requestedHere ? -1 : 1
          if (left.receivedAt !== right.receivedAt) return right.receivedAt - left.receivedAt
          return Number(lhs) - Number(rhs)
        })
        .slice(0, room)
      const survivors = new Set([...shown, ...spare])
      kept = Object.fromEntries(Object.entries(kept).filter(([point]) => survivors.has(point)))
    }
    return { ...state, forecasts: kept }
  },

  // MARK: - Area sweeps
  //
  // Revision 10 can hold several, and every one of them is up to eight packets somebody on the
  // channel paid for. The rules below are about *truth*, not about space: a sweep is dropped only
  // when another sweep says everything it says, more recently.

  /** At most this many sweeps per bot, however new they are (docs/MESHWX.md "State"). */
  maxAreaSweeps: 8,

  /**
   * The sweeps worth holding, newest first (docs/MESHWX.md "State"):
   *
   * - A **national** sweep drops every sweep older than it. It is the newest word on every state
   *   there is, so nothing older can say anything it does not.
   * - A **scoped** sweep drops older scoped sweeps whose scope it fully contains — and only
   *   those. A sweep of Texas says nothing about Oklahoma, and it never drops a national sweep,
   *   which is still the only word on the other forty-nine states.
   * - At most `maxAreaSweeps` survive.
   *
   * A scoped sweep whose packet 0 never arrived has an unknown scope. It can neither be dropped
   * as contained (nothing is known to contain it) nor drop anything (it is known to contain
   * nothing), which is the honest reading of "I am not the country and I cannot say what I am".
   *
   * Order is by the **bot's** build time, not by arrival: a backlog drained at connect is an
   * hour old whenever the phone heard it.
   */
  retainAreaSweeps(sweeps) {
    const ordered = [...sweeps].sort((lhs, rhs) => {
      if (lhs.builtMinutes !== rhs.builtMinutes) return rhs.builtMinutes - lhs.builtMinutes
      if (lhs.lastReceivedAt !== rhs.lastReceivedAt) return rhs.lastReceivedAt - lhs.lastReceivedAt
      return lhs.group - rhs.group
    })
    const kept = []
    for (const sweep of ordered) {
      const isSaidAlready = kept.some((newer) => {
        if (!newer.isScoped) return true
        if (!sweep.isScoped) return false
        const outer = newer.scope
        const inner = sweep.scope
        if (outer == null || inner == null) return false
        return inner.every((state) => outer.includes(state))
      })
      if (!isSaidAlready) kept.push(sweep)
    }
    return kept.slice(0, WeatherStateReducer.maxAreaSweeps)
  },

  // MARK: - Radar tiles
  //
  // Revision 11, §13, and revision 13's frames. One entry per square and picture, and they are
  // cheap to hold and expensive to fetch — one packet each, request only — so the rules here drop
  // a frame only when it is either superseded by the same picture finer or too old to keep.

  /**
   * Frames one bot may hold at once, oldest `taken` dropped. Twelve until revision 13 made the
   * list one entry per picture: an hour's loop is five frames, so forty is eight squares' loops.
   */
  maxRadarTiles: 40,
  /**
   * How far behind the bot's clock a picture may be and still be kept. Minutes.
   *
   * Well past the two hours `WeatherRadarPick` will draw one within, on purpose: a tile past
   * that is not shown, but it is still the last radar this phone has of that square, and the
   * Cached screen says so.
   */
  radarRetentionMinutes: 3 * 60,

  /**
   * The tiles worth holding, newest `taken` first (docs/MESHWX.md "State").
   *
   * "The bot clock" is read off the pictures themselves — the newest `taken` held — because a
   * Radar message carries no other clock, and the phone's own is the wrong one to judge a
   * backlog by: a tile drained from the radio's queue is as old as its picture says it is,
   * whenever the phone heard it. A tile more than `radarRetentionMinutes` behind that goes, and
   * then the list is capped.
   *
   * A detail tile (zoom −1) of revision 13's first build goes first, before it can stand for the
   * bot's clock: that level was removed, and nothing draws one (`WeatherStoredRadarTile.isKept`).
   */
  retainRadarTiles(tiles) {
    const ordered = tiles.filter(WeatherStoredRadarTile.isKept).sort((lhs, rhs) => {
      const left = lhs.radar.taken_min
      const right = rhs.radar.taken_min
      if (left !== right) return right - left
      if (lhs.receivedAt !== rhs.receivedAt) return rhs.receivedAt - lhs.receivedAt
      return MeshWXRadarTile.key(lhs.tile) < MeshWXRadarTile.key(rhs.tile) ? -1 : 1
    })
    if (ordered.length === 0) return ordered
    const newest = ordered[0].radar.taken_min
    return ordered
      .filter((stored) => newest - stored.radar.taken_min <= WeatherStateReducer.radarRetentionMinutes)
      .slice(0, WeatherStateReducer.maxRadarTiles)
  },

  // MARK: - Bot-chosen forecasts

  /**
   * Bot-chosen forecasts one bot may hold at once, oldest dropped (docs/MESHWX.md "State"). Twelve is a
   * pocketful of places asked about by coordinate; past that the oldest question is the one
   * nobody has come back to.
   */
  maxUnbundledForecasts: 12,

  /** The newest `maxUnbundledForecasts` by receipt, ties broken by key so two equal maps agree. */
  retainUnbundledForecasts(held) {
    const keys = Object.keys(held)
    if (keys.length <= WeatherStateReducer.maxUnbundledForecasts) return held
    const kept = new Set(
      keys
        .sort((lhs, rhs) => {
          const left = held[lhs].receivedAt
          const right = held[rhs].receivedAt
          return left !== right ? right - left : (lhs < rhs ? -1 : 1)
        })
        .slice(0, WeatherStateReducer.maxUnbundledForecasts)
    )
    return Object.fromEntries(Object.entries(held).filter(([key]) => kept.has(key)))
  },

  /**
   * The forecast the Forecast card is holding open: the newest this phone asked for, which is
   * the place's own (docs/MESHWX_UI.md §9). One point, so this too is bounded.
   */
  shownForecastPoints(state) {
    let own = null
    for (const [point, stored] of Object.entries(state.forecasts)) {
      if (!stored.requestedHere) continue
      if (own == null) { own = point; continue }
      const held = state.forecasts[own]
      const isLater = held.receivedAt !== stored.receivedAt
        ? held.receivedAt < stored.receivedAt
        : Number(own) < Number(point)
      if (isLater) own = point
    }
    return new Set(own == null ? [] : [own])
  },

  /**
   * Whether two warnings cover shared ground: a common county or zone, or overlapping polygon
   * boxes. Deliberately generous — a false "yes" only clears an upgrade marker a little early
   * when the office issues something nearby, a false "no" keeps it until the next digest.
   */
  areasOverlap(lhs, rhs) {
    const lhsKeys = areaKeys(lhs)
    for (const key of areaKeys(rhs)) {
      if (lhsKeys.has(key)) return true
    }
    // The bounding boxes of the two polygons. Computed here rather than through
    // `MeshWXGeometry.Box`, which is a nested Swift type with no settled JS spelling; the rule is
    // four min/max comparisons either way.
    const lhsBox = boundingBox(lhs.polygon)
    const rhsBox = boundingBox(rhs.polygon)
    if (lhsBox == null || rhsBox == null) return false
    return lhsBox.minLatitude <= rhsBox.maxLatitude && rhsBox.minLatitude <= lhsBox.maxLatitude
      && lhsBox.minLongitude <= rhsBox.maxLongitude && rhsBox.minLongitude <= lhsBox.maxLongitude
  },

  /**
   * Deterministic order for identity lists in change records and pruning. A comparator, where
   * Swift has the `<` predicate `sorted(by:)` wants.
   */
  identityOrder(lhs, rhs) {
    if (lhs.event !== rhs.event) return lhs.event - rhs.event
    if (lhs.office !== rhs.office) return lhs.office - rhs.office
    return lhs.etn - rhs.etn
  }
}

/**
 * Where a `seq` falls against the newest accepted one, from `forward = seq − last` mod 256:
 * 1 is the next message; 2…128 is ahead, past a gap; 224…255 is behind by at most
 * `reorderWindow`, out of order. 129…223 is behind by more than reordering explains, and 0 —
 * which only gets this far when the content differs from the message accepted under that
 * `seq` — is the newest `seq` again with something new in it: both are a restart.
 */
function position(forward) {
  if (forward === 1) return 'next'
  if (forward >= 2 && forward <= 128) return 'ahead'
  if (forward >= 0xff - WeatherStateReducer.reorderWindow + 1) return 'behind'
  return 'restart'
}

/**
 * Whether a warning arriving out of order would undo something newer: its identity was cancelled
 * in the last hour (the warning went out before its cancel), or the held copy came in a message
 * sent after this one (a `seq` up to `reorderWindow` ahead, received recently). A held copy
 * from an earlier message is older, so the bot's late resend of an update replaces it; so does
 * one saved before copies carried a `seq`.
 */
function wouldRollBack(warning, { seq, state, receivedAt }) {
  const key = identityKey(warning)
  if (state.recentCancels[key] != null) return true
  const held = state.warnings[key]
  if (held == null || held.seq == null) return false
  const heldAhead = (held.seq - seq) & 0xff
  return heldAhead >= 1 && heldAhead <= WeatherStateReducer.reorderWindow
    && (receivedAt - held.receivedAt) / 1000 < WeatherStateReducer.reorderRecency
}

/**
 * The time a message states for itself, which a future one must not be (spec §17.5): null for a
 * message with none (Cancel, Text, Coverage, Not available) and for a warning without an issue
 * time. A warning's expiry is in the future by nature and is capped instead (`cappedWarning`).
 */
function messageMinutes(message) {
  switch (message.name) {
    case 'digest': return message.now_min
    case 'observations': return message.ts_min
    case 'forecast': return message.issued_min
    case 'area_sweep': return message.built_min
    case 'radar': return message.taken_min
    case 'warning': return message.issued_min ?? null
    default: return null
  }
}

/** Two area runs of one kind in one state that share a number. */
function runsOverlap(lhs, rhs) {
  return lhs.state === rhs.state && lhs.county === rhs.county
    && lhs.start < rhs.start + rhs.run && rhs.start < lhs.start + lhs.run
}

/** The bundle centres of every county or zone in `runs`, those it knows. */
function centresOf(runs, areaCentre) {
  if (areaCentre == null) return []
  const out = []
  for (const run of runs) {
    for (const number of MeshWXAreaRun.numbers(run)) {
      const point = areaCentre({ state: run.state, county: run.county, number })
      if (point != null) out.push(point)
    }
  }
  return out
}

function kilometres(lhs, rhs) {
  return MeshWXGeo.distanceKilometres({
    fromLat: lhs.latitude, fromLon: lhs.longitude, toLat: rhs.latitude, toLon: rhs.longitude
  })
}

/**
 * Whether a polygon (`[latitude, longitude]` pairs) comes within `radius` kilometres of a point:
 * the point is inside it, or one of its edges passes that close. On a flat projection around the
 * point, which over a warning's few tens of kilometres is far inside the margins used.
 */
function polygonReaches(polygon, point, radius) {
  const cosLatitude = Math.cos((point.latitude * Math.PI) / 180)
  const planar = polygon.map(([latitude, longitude]) => {
    let east = longitude - point.longitude
    if (east > 180) east -= 360
    else if (east < -180) east += 360
    return { x: east * 111.32 * cosLatitude, y: (latitude - point.latitude) * 110.574 }
  })
  let inside = false
  for (let index = 0, previous = planar.length - 1; index < planar.length; previous = index, index += 1) {
    const a = planar[index]
    const b = planar[previous]
    if ((a.y > 0) !== (b.y > 0) && a.x + ((b.x - a.x) * -a.y) / (b.y - a.y) > 0) inside = !inside
  }
  if (inside) return true
  for (let index = 0; index < planar.length; index += 1) {
    if (segmentDistance(planar[index], planar[(index + 1) % planar.length]) <= radius) return true
  }
  return false
}

/** The distance from the origin to the segment `a`–`b`. */
function segmentDistance(a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const along = length === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / length))
  return Math.hypot(a.x + along * dx, a.y + along * dy)
}

function markGap(state, date) {
  state.needsDigest = true
  state.gapDetectedAt = Math.max(state.gapDetectedAt ?? date, date)
}

// MARK: - Warnings

function storeWarning(warning, { state, receivedAt, seq, source }) {
  // Spec §2.4: keyed by identity, not by seq — a known identity is replaced either way,
  // whether or not the bot set the update flag.
  const identity = identityOf(warning)
  const key = identityKey(identity)
  const existing = state.warnings[key]
  state.warnings[key] = WeatherStoredWarning.make({
    warning,
    receivedAt,
    updateCount: existing == null ? 0 : existing.updateCount + 1,
    seq,
    // Spec §3: the issue time is the product's own, kept across continuations, so an identity's
    // issuance never moves. A replacement that does not carry one — an older bot, or a message
    // sent before the bot spoke revision 5 — therefore leaves what is already known alone
    // rather than erasing it.
    issuedAt: warning.issued_min != null
      ? dateFromUnixMinutes(warning.issued_min)
      : (existing?.issuedAt ?? null),
    source,
    // Spec §3, revision 12: the start, resolved once on arrival for the same reason as the issue
    // time — a digest may extend the expiry it is stated against. A later copy without one (a
    // second bot older than revision 12) does not erase it.
    beginsAt: warning.begins_min != null
      ? dateFromUnixMinutes(warning.begins_min)
      : (existing?.beginsAt ?? null)
  })
  state.missingFromDigest = state.missingFromDigest.filter((held) => identityKey(held) !== key)
  // The replacement for an upgraded warning comes from the same office over the same
  // ground. Anything else from that office leaves the marker in place.
  state.pendingUpgrades = Object.fromEntries(
    Object.entries(state.pendingUpgrades).filter(
      ([, pending]) => !(pending.warning.office === warning.office
        && WeatherStateReducer.areasOverlap(pending.warning, warning))
    )
  )
  return WeatherStateChange.warningStored(identity, { replacedExisting: existing != null })
}

function removeWarning(cancel, { state, receivedAt, isOutOfOrder }) {
  const identity = identityOf(cancel)
  const key = identityKey(identity)
  state.missingFromDigest = state.missingFromDigest.filter((held) => identityKey(held) !== key)
  state.recentCancels[key] = receivedAt
  const removed = state.warnings[key]
  if (removed == null) return WeatherStateChange.cancelForUnknown(identity)
  delete state.warnings[key]
  if (cancel.reason === CANCEL_REASON_UPGRADED) {
    // Out of order, the replacement may already be held from a newer message; a marker would
    // then ask for something that has arrived.
    const replacementHeld = isOutOfOrder && Object.values(state.warnings).some(
      (stored) => stored.warning.office === removed.warning.office
        && WeatherStateReducer.areasOverlap(stored.warning, removed.warning)
    )
    if (!replacementHeld) {
      state.pendingUpgrades[key] = WeatherPendingUpgrade.make({
        warning: removed.warning, cancelledAt: receivedAt
      })
    }
  }
  return WeatherStateChange.warningRemoved(identity, { reason: cancel.reason })
}

function areaKeys(warning) {
  const keys = new Set()
  for (const run of warning.areas ?? []) {
    for (let offset = 0; offset < run.run; offset += 1) {
      keys.add(`${run.state}:${run.county ? 1 : 0}:${(run.start + offset) & 0xffff}`)
    }
  }
  return keys
}

/** The min/max of a decoded polygon, which is a list of `[latitude, longitude]` pairs. */
function boundingBox(polygon) {
  if (polygon == null || polygon.length === 0) return null
  let minLatitude = polygon[0][0]
  let maxLatitude = polygon[0][0]
  let minLongitude = polygon[0][1]
  let maxLongitude = polygon[0][1]
  for (const [latitude, longitude] of polygon) {
    minLatitude = Math.min(minLatitude, latitude)
    maxLatitude = Math.max(maxLatitude, latitude)
    minLongitude = Math.min(minLongitude, longitude)
    maxLongitude = Math.max(maxLongitude, longitude)
  }
  return { minLatitude, maxLatitude, minLongitude, maxLongitude }
}

// MARK: - Digest

function applyDigest(digest, { state, receivedAt, areaCentre }) {
  if (state.digest != null && digest.now_min < state.digest.digest.now_min) {
    return WeatherStateChange.digestIgnoredOlder({ builtMinutes: digest.now_min })
  }
  const speaksBefore = dateFromUnixMinutes(digest.now_min) - WeatherStateReducer.digestMargin * 1000
  const listed = new Set(digest.entries.map((entry) => identityKey(entry)))
  // A full list is sorted soonest expiry first and cut (at 25 by older bots, 24 under the send
  // limit), so it says nothing about a warning expiring at or after its last entry: that one may
  // be among the cut (ties included, since the cut can fall between equal expiries).
  const horizon = digest.entries.length >= MeshWXWire.digestMayBeCutAt
    ? Math.max(...digest.entries.map((entry) => entry.expires_min))
    : null
  // The list speaks only for the bot's own area (spec §5, 17 October 2026): what the bot stated
  // about itself, when it stated all of it.
  const coverage = state.coverage?.coverage ?? null
  const speaksFor = (warning) => WeatherStateReducer.digestSpeaksFor(warning, { coverage, areaCentre })

  // Spec §5: "an identity the app holds that is absent from the digest has ended" — for
  // identities the list could have known about.
  const removed = Object.values(state.warnings)
    .filter((stored) => !listed.has(identityKey(stored.warning))
      && stored.receivedAt < speaksBefore
      && !(horizon != null && stored.warning.expires_min >= horizon)
      && speaksFor(stored.warning))
    .map((stored) => identityOf(stored.warning))
    .sort(WeatherStateReducer.identityOrder)
  for (const identity of removed) delete state.warnings[identityKey(identity)]
  // The list's expiries are believed no further ahead than a warning's own (`cappedWarning`).
  const ceiling = Math.floor(receivedAt / 60_000) + WeatherStateReducer.warningHorizon / 60

  const missing = []
  for (const entry of digest.entries) {
    const key = identityKey(entry)
    const held = state.warnings[key]
    if (held == null) {
      missing.push(identityOf(entry))
      continue
    }
    // The digest's expiry is absolute (`now + rel`). It replaces the held one when the list
    // is newer than the warning message; otherwise it may only extend it.
    const expires = Math.min(entry.expires_min, ceiling)
    const replaces = held.receivedAt < speaksBefore
    if (held.warning.expires_min !== expires && (replaces || expires > held.warning.expires_min)) {
      state.warnings[key] = { ...held, warning: { ...held.warning, expires_min: expires } }
    }
  }

  // A marker outside the bot's area is not the list's to settle, for the same reason.
  state.pendingUpgrades = Object.fromEntries(
    Object.entries(state.pendingUpgrades).filter(
      ([, pending]) => pending.cancelledAt >= speaksBefore || !speaksFor(pending.warning)
    )
  )
  if (state.gapDetectedAt != null) {
    if (state.gapDetectedAt < speaksBefore) {
      state.needsDigest = false
      state.gapDetectedAt = null
    }
  } else {
    state.needsDigest = false
  }
  state.digest = WeatherStoredDigest.make({ digest, receivedAt })
  state.missingFromDigest = missing
  return WeatherStateChange.digestApplied({ missing, removed })
}

// MARK: - Observations and forecasts

/**
 * One station's own report time, in Unix minutes: the batch `ts` less its age (spec §6.1). The
 * batch time itself for a batch without ages, which is all such a batch says.
 */
function reportMinutes(batch, station) {
  return (batch.ts_min - (station.age_min ?? 0)) >>> 0
}

function storeObservations(batch, { state, receivedAt, source }) {
  const stored = []
  // More than one station is the bot's scheduled report, and the only thing that says where the
  // bot reports (docs/MESHWX_UI.md §6). A single-station answer to somebody's `>o KATT` carries
  // the newer reading and takes its place, but leaves that evidence as it found it.
  const isScheduled = batch.stations.length > 1
  for (const observation of batch.stations) {
    // Spec §6.1: each station is stamped with its *own* report time, the batch `ts` less the
    // age it states, so "as of", staleness and the comparison below are per station rather than
    // per batch.
    const observedMinutes = reportMinutes(batch, observation)
    const key = String(observation.station)
    const held = state.observations[key]
    // The batch's own time, not the station's: this is membership of a scheduled broadcast.
    const lastBatchMinutes = isScheduled
      ? Math.max(batch.ts_min, held?.lastBatchMinutes ?? 0)
      : (held?.lastBatchMinutes ?? null)
    // A reading older than what is held — a batch drained late from the radio's queue, a late
    // copy, or a station whose report this batch carries at a greater age than the last one did
    // — must not roll that station back. That it was in a scheduled batch still counts.
    if (held != null && held.timestampMinutes > observedMinutes) {
      if (lastBatchMinutes !== held.lastBatchMinutes) {
        state.observations[key] = { ...held, lastBatchMinutes }
      }
      continue
    }
    state.observations[key] = WeatherStoredObservation.make({
      observation,
      timestampMinutes: observedMinutes,
      receivedAt,
      batchSize: batch.stations.length,
      lastBatchMinutes,
      source
    })
    stored.push(observation.station)
  }
  return WeatherStateChange.observationsStored({ stations: stored })
}

function storeForecast(forecast, { state, receivedAt, source }) {
  if (WeatherStoredForecast.isUnbundledPoint(forecast)) {
    // A point the bot chose for itself (spec §7). It arrives here knowing only *which weather*,
    // never *which place* — the coordinate was in the question, and the reducer does not see
    // questions. So it lands in the one slot for questions nobody here asked, and `WeatherService`
    // moves it under the coordinate it asked for when it settles a `forecastAt` of this phone's.
    state.unbundledForecasts[UNASKED_FORECAST_KEY] = WeatherStoredForecast.make({
      forecast, receivedAt, requestLabel: null, requestedHere: false, source
    })
    state.unbundledForecasts = WeatherStateReducer.retainUnbundledForecasts(state.unbundledForecasts)
    return WeatherStateChange.forecastStored({ point: forecast.point })
  }
  const key = String(forecast.point)
  const held = state.forecasts[key]
  if (held != null && held.forecast.issued_min > forecast.issued_min) {
    return WeatherStateChange.forecastIgnoredOlder({ point: forecast.point })
  }
  // Whether this phone asked about a bundled point survives the bot's next scheduled issue of it.
  state.forecasts[key] = WeatherStoredForecast.make({
    forecast,
    receivedAt,
    requestLabel: null,
    requestedHere: held?.requestedHere ?? false,
    source
  })
  return WeatherStateChange.forecastStored({ point: forecast.point })
}

// MARK: - Text

function storeText(chunk, { state, receivedAt, source }) {
  const key = String(chunk.group)
  const held = state.texts[key]
  let assembly
  if (held != null && held.subject === chunk.subject && held.total === chunk.total) {
    assembly = { ...held, chunks: { ...held.chunks } }
  } else {
    // A different subject or chunk count under the same group byte is a new reply that
    // happens to reuse the byte (it wraps with `seq`); start over.
    assembly = WeatherTextAssembly.make({
      subject: chunk.subject,
      group: chunk.group,
      total: chunk.total,
      firstReceivedAt: receivedAt,
      lastReceivedAt: receivedAt
    })
  }
  assembly.chunks[String(chunk.idx)] = chunk.text
  assembly.lastReceivedAt = receivedAt
  // Spec §8, revision 7: the bot sets the cut flag on *every* chunk of a cut reply, so any
  // chunk saying so is the reply saying so — which is what makes the mark survive the one chunk
  // that never arrived.
  assembly.wasCut = assembly.wasCut || chunk.cut === true
  // One reply is built from one product, so the chunks agree. If a resend somehow disagrees,
  // this chunk is the newest word on it — but a chunk that states nothing (an older bot, or a
  // message with no product behind it) never erases a source already stated.
  if (source !== UNSTATED_SOURCE) assembly.source = source
  state.texts[key] = assembly
  return WeatherStateChange.textChunkStored({
    group: chunk.group, index: chunk.idx, isComplete: WeatherTextAssembly.isComplete(assembly)
  })
}

// MARK: - Coverage

/**
 * Spec §10: what the bot says about itself, newest first. The message carries no time of its
 * own — it describes the bot at the moment it is sent — so receipt is the only order there is,
 * and out of order the statement already held came in a message the bot sent later.
 */
function storeCoverage(coverage, { state, receivedAt, isOutOfOrder }) {
  if (isOutOfOrder && state.coverage != null) return WeatherStateChange.coverageIgnoredOlder
  state.coverage = WeatherStoredCoverage.make({ coverage, receivedAt })
  return WeatherStateChange.coverageStored
}

// MARK: - Area sweep

/**
 * Spec §12: the packets of one sweep share a `group` and assemble like Text chunks.
 *
 * The assembly a packet belongs to is found by its **`group`**, not by being the newest thing
 * held. That is what makes revision 10's `>part` work at all: the bot answers it with the named
 * packets again, identical bytes except a new `seq` in byte 0, and a sweep built ten minutes ago
 * is by then behind whatever else arrived. Keyed on "the newest sweep" the resent packet would
 * be dropped as older than what is held — the one outcome that turns "4 of 7 parts arrived" into
 * "4 of 7 parts arrived, for ever".
 *
 * A packet whose `group` names an assembly with a different build time or packet count is the
 * bot sending a fresh sweep that reused the byte (it wraps with `seq`), so that one starts over.
 * Two builds never merge into one assembly: merging draws this hour's Texas beside last hour's
 * Montana, which is the one output a map must never produce.
 *
 * Which sweeps survive is `retainAreaSweeps`, applied here on every store. A packet whose
 * assembly does not survive it changed nothing — a backlog drained from the radio at connect,
 * repainting the country as it was an hour ago — and says so.
 */
function storeAreaSweep(sweep, { state, receivedAt, source }) {
  const sweeps = state.areaSweeps
  const heldIndex = sweeps.findIndex((one) => one.group === sweep.group
    && one.builtMinutes === sweep.built_min && one.total === sweep.total)
  const held = heldIndex < 0 ? null : sweeps[heldIndex]

  let assembly
  if (held != null) {
    assembly = { ...held, packets: { ...held.packets } }
  } else {
    assembly = WeatherAreaSweepAssembly.make({
      builtMinutes: sweep.built_min,
      group: sweep.group,
      total: sweep.total,
      firstReceivedAt: receivedAt,
      lastReceivedAt: receivedAt,
      // Bit 7 of the `total` byte is on every packet of a scoped sweep, so this is settled by
      // whichever packet arrives first (spec §12, revision 10).
      isScoped: sweep.scoped === true,
      // Scoped and packet 0 not yet held is "not the country, and I cannot say what": null.
      scope: sweep.scoped === true ? null : []
    })
  }
  assembly.packets[String(sweep.idx)] = sweep.entries
  assembly.lastReceivedAt = receivedAt
  // Set on every packet of a cut sweep (spec §12), so any packet saying so is the sweep saying
  // so — which is what makes the mark survive the packet that never arrived.
  assembly.wasCut = assembly.wasCut || sweep.cut === true
  // The level is one sweep's, so the packets agree; a packet that says advisories are in it is
  // taken at its word, and one that does not never narrows a level already stated.
  assembly.includesAdvisories = assembly.includesAdvisories || sweep.advisories === true
  if (sweep.scoped === true) assembly.isScoped = true
  if (!assembly.isScoped) {
    assembly.scope = []
  } else if (sweep.idx === 0) {
    // Only packet 0 carries the scope entries. Until it arrives the scope stays unknown, and a
    // later packet must never write an empty list over it: "no states named in this packet" is
    // not "no states".
    assembly.scope = [...(sweep.scope ?? [])]
  } else {
    assembly.scope = assembly.scope ?? null
  }
  if (source !== UNSTATED_SOURCE) assembly.source = source

  const merged = heldIndex < 0 ? [assembly, ...sweeps] : sweeps.map(
    (one, index) => (index === heldIndex ? assembly : one)
  )
  state.areaSweeps = WeatherStateReducer.retainAreaSweeps(merged)
  if (!state.areaSweeps.includes(assembly)) {
    return WeatherStateChange.areaSweepIgnoredOlder({ builtMinutes: sweep.built_min })
  }
  return WeatherStateChange.areaSweepStored({
    group: sweep.group, index: sweep.idx, isComplete: WeatherAreaSweepAssembly.isComplete(assembly)
  })
}

// MARK: - Radar

/**
 * Spec §13, revision 13: one frame per lattice square **and picture**, `(tile, taken)`.
 *
 * Until revision 13 a square held one picture and a newer one replaced it. Now a different
 * `taken` is another frame, older or newer — an older one is a frame of the square's loop, sent
 * because somebody asked for the last hour — and only the same `taken` arriving again replaces
 * what is held. Then revision 11's second rule stands: a **coarse** tile never replaces a fine
 * one of the same `taken`. The coarse tile is the same picture at half the detail, sent because
 * somebody's request could not fit the finer one in a packet, and taking it would throw away
 * detail this phone already has.
 *
 * A frame is stored however old it is; `retainRadarTiles` is what decides whether it survives,
 * and `WeatherRadarPick` and `WeatherRadarLoop` whether it is drawn.
 */
function storeRadar(radar, { state, receivedAt, source }) {
  const tile = MeshWXRadar.tile(radar)
  const key = MeshWXRadarTile.key(tile)
  const held = state.radarTiles.find(
    (one) => MeshWXRadarTile.key(one.tile) === key && one.radar.taken_min === radar.taken_min
  ) ?? null
  if (held != null && radar.coarse === true && held.radar.coarse !== true) {
    return WeatherStateChange.radarIgnoredOlder({ takenMinutes: radar.taken_min })
  }

  const stored = WeatherStoredRadarTile.make({ tile, radar, receivedAt, source })
  const merged = held == null
    ? [stored, ...state.radarTiles]
    : state.radarTiles.map((one) => (one === held ? stored : one))
  state.radarTiles = WeatherStateReducer.retainRadarTiles(merged)
  if (!state.radarTiles.includes(stored)) {
    // Older than everything else held by more than the retention window: a backlog drained at
    // connect, a picture of a morning that is over.
    return WeatherStateChange.radarIgnoredOlder({ takenMinutes: radar.taken_min })
  }
  return WeatherStateChange.radarStored(tile, { takenMinutes: radar.taken_min })
}

/** JSON with every object's keys in sorted order, so two equal values render identically. */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`
}
