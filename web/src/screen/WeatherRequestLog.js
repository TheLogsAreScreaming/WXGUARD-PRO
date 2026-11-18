// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherRequestLog.swift

/**
 * How a request ended, in the four ways worth telling apart. The detail — which reason the bot
 * gave, whether its radio confirmed the request — stays under the button that sent it (§11.2);
 * this is the ledger.
 */
export const WeatherRequestLogOutcome = Object.freeze({
  answered: 'answered',
  /** Nothing came back through the one retry. */
  noAnswer: 'noAnswer',
  /** The bot said it cannot serve this (spec §9). */
  notAvailable: 'notAvailable',
  /** Your own radio would not send it. */
  refused: 'refused',
})

/**
 * One request this phone put on the air, and how it ended (docs/MESHWX_UI.md §12):
 * `{ id, request, botID, sentAt, outcome }`.
 *
 * This phone's own requests and nothing else: the channel's answers say nothing about who asked
 * for them, so the only requests that can honestly be listed are the ones this app sent. An
 * answer served from the five-minute rule is not one — nothing went out — and is not recorded.
 *
 * `id` is the Swift `UUID` as a string.
 */
export const WeatherRequestLogEntry = Object.freeze({
  Outcome: WeatherRequestLogOutcome,

  make({ id, request, botID, sentAt, outcome = null }) {
    return { id, request, botID, sentAt, outcome }
  },
})

/**
 * The log's rules: newest first, a week, and a ceiling.
 *
 * Small and capped on purpose. It exists so a person can see what their own phone has spent
 * shared airtime on — not to build a record of one, and not to outlive the answers it fetched.
 */
export const WeatherRequestLog = Object.freeze({
  limit: 40,
  retention: 7 * 24 * 60 * 60,

  /** The log with a request just sent at its head. */
  recording(entry, { in: list, now }) {
    return WeatherRequestLog.ordered([...list.filter((one) => one.id !== entry.id), entry], { now })
  },

  /**
   * The same log with one request's outcome filled in. A request the log no longer holds — aged
   * out under a phone left open for a week — settles into nothing rather than reappearing.
   */
  settling({ id, outcome, in: list }) {
    return list.map((entry) => (entry.id === id ? { ...entry, outcome } : entry))
  },

  /** Newest first, nothing older than a week, at most `limit` rows. */
  ordered(list, { now, limit = WeatherRequestLog.limit }) {
    return list
      .filter((entry) => (now - entry.sentAt) / 1000 <= WeatherRequestLog.retention)
      .sort((lhs, rhs) => {
        if (lhs.sentAt !== rhs.sentAt) return rhs.sentAt - lhs.sentAt
        return lhs.id < rhs.id ? -1 : lhs.id > rhs.id ? 1 : 0
      })
      .slice(0, limit)
  },
})
