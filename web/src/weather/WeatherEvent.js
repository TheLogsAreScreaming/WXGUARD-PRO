// Port of MC1Services/Services/Weather/WeatherEvent.swift (docs/PORTING.md).

/**
 * How a request went out (spec §11, §14). Both carry the same `>` text and both are answered
 * on `#meshwx`; what differs is whether a stored route has to be right.
 *
 * - `channel`: a Request datagram, flooded on `#meshwx`. The normal path since spec revision 6:
 *   no route to go stale, and no acknowledgement either — the answer is the acknowledgement.
 * - `dm`: a DM to the bot's public key, the ladder of spec §14. The fallback, for a radio that
 *   cannot send channel datagrams at all.
 */
export const WeatherRequestTransportKind = Object.freeze({
  channel: 'channel',
  dm: 'dm'
})

/**
 * A request the app has on the air, waiting for the bot's answer on `#meshwx`.
 *
 * `{ id, request, botID, botPublicKey, sentAt, transportKind, attempt, timestamp, seq,
 *    ackCodes, botRadioReceived }`
 *
 * - `sentAt`, `timestamp`: milliseconds (PORTING.md §3).
 * - `attempt`: 0 for the first transmission, 1 for the one retry spec §14 allows; on the DM
 *   ladder 2 is the flood after the route is forgotten. A channel request never goes past 1
 *   (spec §11: send once, once more after 10 s, never a third time).
 * - `timestamp`: the timestamp on the wire, the same for every transmission: with attempt 0 then
 *   1 the retry is one message sent again to the bot's radio, and the same request to the bot. A
 *   Request datagram carries it as its `ts`, which is exactly what makes a resend a copy.
 * - `seq`: the sender's own sequence number, on a channel request only (spec §11), repeated on
 *   the resend. 0 and meaningless for a DM.
 * - `ackCodes`: the ACK codes the radio expects back, one per transmission, each a lower-case
 *   hex string of the `Uint8Array` the transport returned. Empty for a channel request: a
 *   datagram has no acknowledgement. (Swift holds a `Set<Data>`; PORTING.md §3 makes a persisted
 *   or boundary-crossing set an array of strings, and hex is how `Data` reads.)
 * - `botRadioReceived`: the radio confirmed (an ACK for either transmission) that the bot's radio
 *   received the request. Says nothing about the answer, and never true for a channel request.
 */
export const WeatherPendingRequest = {
  make({
    id = globalThis.crypto.randomUUID(),
    request,
    botID,
    botPublicKey,
    sentAt,
    transportKind = WeatherRequestTransportKind.dm,
    attempt = 0,
    timestamp = null,
    seq = 0,
    ackCodes = [],
    botRadioReceived = false
  }) {
    return {
      id,
      request,
      botID,
      botPublicKey,
      sentAt,
      transportKind,
      attempt,
      timestamp: timestamp ?? sentAt,
      seq,
      ackCodes,
      botRadioReceived
    }
  }
}

/** How a request ended. */
export const WeatherRequestOutcome = Object.freeze({
  /** The expected answer arrived and is in state. */
  answered: Object.freeze({ kind: 'answered' }),
  /**
   * Nothing was sent: the same answer — to this phone or anyone else on the channel — arrived
   * at `receivedAt`, within the last five minutes. The bot keeps no cache: asking again would
   * have it rebuild and re-transmit what this phone already holds, on everyone's airtime (spec
   * §19). `receivedAt` is the phone's clock; `contentAsOf` is what the answer was as of on the
   * bot's clock where the message says — a list's build time, a batch's observation time, a
   * forecast's issue time — and null for a warning or a text.
   */
  alreadyReceived({ receivedAt, contentAsOf = null }) {
    return { kind: 'alreadyReceived', receivedAt, contentAsOf }
  },
  /** The bot said it cannot serve this (spec §9). `value` is the wire's reason code. */
  notAvailable(reason) { return { kind: 'notAvailable', value: reason } },
  /**
   * No answer. `botWasHeard`: the bot was heard live after the request went out, so it is in
   * range and the answer was lost, or the bot dropped the request — the request is not
   * repeated into a busy channel. Otherwise nothing came from the bot through one retry: it may
   * be out of range, or busy. The bot drops requests silently past one per sender every five
   * seconds, 60 answer packets an hour across everyone, and for a DM 40 replies per sender an
   * hour (spec §14, §9, revision 3); the app cannot tell that from range. A backlog drained
   * from the radio's queue meanwhile does not count as hearing it.
   *
   * `botRadioReceived`: the radio confirmed that the bot's radio received the request (an ACK
   * for either transmission), so range is not why no answer reached this phone — the bot may be
   * busy, or its answer was lost. False when nothing confirmed it, which is not proof it did not
   * arrive: a confirmation can be lost too.
   */
  timedOut({ botWasHeard, botRadioReceived = false }) {
    return { kind: 'timedOut', botWasHeard, botRadioReceived }
  },
  /** The radio refused the DM (no such contact, not connected, …). */
  failed(reason) { return { kind: 'failed', value: reason } }
})

/**
 * Why a request could not be sent now. `kind` is `'rateLimited'` (spec §19: at most one request
 * every five seconds, `retryAfter` in seconds) or `'transport'` (`reason`).
 */
export class WeatherRequestError extends Error {
  constructor(kind, { retryAfter = null, reason = null } = {}) {
    super(kind === 'rateLimited' ? `rateLimited(${retryAfter})` : `transport(${reason})`)
    this.name = 'WeatherRequestError'
    this.kind = kind
    this.retryAfter = retryAfter
    this.reason = reason
  }

  static rateLimited({ retryAfter }) {
    return new WeatherRequestError('rateLimited', { retryAfter })
  }

  static transport(reason) {
    return new WeatherRequestError('transport', { reason })
  }
}

/**
 * What the service knows about the current radio session, for the claims a screen may make:
 * "no alerts" needs a session that was listening when the alert list arrived, and a channel
 * prompt must not appear while `#meshwx` is plainly delivering.
 */
export const WeatherSessionInfo = {
  make({ startedAt = null, lastChannelDatagramAt = null, foreignDatagramsIgnored = 0 } = {}) {
    return { startedAt, lastChannelDatagramAt, foreignDatagramsIgnored }
  }
}

/**
 * What `WeatherService` tells its observers. Coarse on purpose: a consumer re-reads the
 * bot's state on `received`; the change list is for logging and for anything that wants to
 * react to one rule (a new warning, a completed text).
 */
export const WeatherEvent = Object.freeze({
  stateLoaded: Object.freeze({ kind: 'stateLoaded' }),
  /**
   * `isBacklog`: the message was drained from the radio's queue at connect rather than heard
   * live, so it can be hours old. The alert notifier says so and only notifies for a warning
   * that is still active (docs/MESHWX_UI.md §16).
   */
  received({ botID, message, changes, isBacklog }) {
    return { kind: 'received', botID, message, changes, isBacklog }
  },
  requestSent(request) { return { kind: 'requestSent', value: request } },
  /** The radio confirmed that the bot's radio received a pending request. */
  requestReceivedByBotRadio(request) {
    return { kind: 'requestReceivedByBotRadio', value: request }
  },
  requestSettled(request, outcome) {
    return { kind: 'requestSettled', value: request, value2: outcome }
  }
})
