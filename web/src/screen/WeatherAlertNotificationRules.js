// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherAlertNotificationRules.swift

import { MeshWXFloodDamage, MeshWXWarningIdentity } from '../meshwx/index.js'
import { WeatherStateReducer } from '../weather/index.js'
import { WeatherAlertGate } from './WeatherAlertWatch.js'
import { WeatherAlertRequests } from './WeatherAlertRequests.js'

// MARK: - What was posted

/**
 * One notification this phone has posted: the warning it stands for, the place it was posted for,
 * and what the user was last told about it.
 *
 * `{ identifier, identity, placeID, botID, tornado, floodDamage, expiresMinutes, coversPlace,
 * postedAt, alertedAt, alertedExpiresMinutes }`.
 *
 * Kept between launches. A repeat of a warning must replace its notification silently rather than
 * sound again, and the phone can be relaunched between the two (docs/MESHWX_UI.md §16).
 *
 * - `botID`: the bot whose copy was posted first. A second bot holding the same warning updates
 *   this notification rather than posting a second one.
 * - `coversPlace`: whether the warning covered the place, as against being near it.
 * - `alertedAt` / `alertedExpiresMinutes`: the last post the user could hear, and the expiry it
 *   named. An extension sounds again only once it is 20 minutes past this, and only against the
 *   time the user was actually told.
 */
export const WeatherAlertPost = Object.freeze({
  make({
    identifier,
    identity,
    placeID,
    botID,
    tornado,
    floodDamage,
    expiresMinutes,
    coversPlace,
    postedAt,
    alertedAt,
    alertedExpiresMinutes,
  }) {
    return {
      identifier,
      identity,
      placeID,
      botID,
      tornado,
      floodDamage,
      expiresMinutes,
      coversPlace,
      postedAt,
      alertedAt,
      alertedExpiresMinutes,
    }
  },

  id(post) {
    return post.identifier
  },

  expiresAt(post) {
    return post.expiresMinutes * 60000
  },
})

/** What one arriving warning should do to the notification standing for it at one watched place. */
export const WeatherAlertNotificationDecision = Object.freeze({
  /**
   * Nothing reaches the user: not watched, not covered, not severe enough, already expired, or a
   * repeat of something the user has already dismissed.
   */
  none: Object.freeze({ kind: 'none' }),
  /**
   * Post it. `sound` is false for a silent replacement and for the rank-6 toggle; `isLate` marks a
   * warning drained from the radio's queue at connect.
   */
  post({ sound, isLate }) {
    return { kind: 'post', sound, isLate }
  },
  /**
   * Take the delivered notification away: the warning was cancelled, removed by a list, or no
   * longer covers this place.
   */
  remove: Object.freeze({ kind: 'remove' }),
})

// MARK: - Rules

/**
 * The rules for turning warnings into notifications (docs/MESHWX_UI.md §16), as pure functions:
 * the evaluator does the I/O, this decides.
 */
export const WeatherAlertNotificationRules = Object.freeze({
  /** A repeat sounds again on an extension only once the last sounding post is this old. */
  escalationQuietPeriod: 20 * 60,
  /**
   * An expiry is only "extended" past the minute the wire truncates to and the two clocks'
   * disagreement — the same margin a digest is judged by.
   */
  get extensionMargin() {
    return WeatherStateReducer.digestMargin
  },
  /**
   * A post is forgotten this long after the warning it stands for expired. Nothing is scheduled
   * for an expiry; this only keeps the ledger from growing.
   */
  postRetention: 6 * 60 * 60,

  /**
   * `wx-4C7A-SV.W.EWX.42@zip:78701`: the bot, the identity as the bot itself spells it (spec §14),
   * and the place it was posted for — one notification per warning per watched place. The bot is
   * the one that delivered the copy first; another bot's copy of the same warning updates this
   * identifier instead of posting its own.
   */
  identifier({ botID, identity, placeID, tables }) {
    const name =
      WeatherAlertRequests.identityString(identity, { tables }) ??
      `${identity.event}.${identity.office}.${identity.etn}`
    return `wx-${botID.toString(16).toUpperCase().padStart(4, '0')}-${name}@${placeID}`
  },

  /**
   * Notifications for one place are threaded together, so a night of warnings for Austin is one
   * group rather than a column.
   */
  threadIdentifier({ placeID }) {
    return `wx-place-${placeID}`
  },

  /**
   * What to do with one warning at one watched place.
   *
   * - `delivery`: what the gate allows for this rank and placement, null for nothing.
   * - `rank`: `WeatherAlertPriority.rank`, for the backlog rule.
   * - `isBacklog`: the message was drained from the radio's queue at connect. It is hours old and
   *   says nothing about now, so it notifies only while the warning is still active and only for a
   *   storm warning — and says it arrived late.
   * - `posted`: what this phone has already told the user about this warning at this place.
   * - `isDelivered`: the notification is still in Notification Center. A repeat of one the user has
   *   dismissed or opened is not put back, but an escalation is.
   */
  decide({ warning, rank, placement, delivery, isBacklog, posted, isDelivered, now }) {
    const expiresAt = warning.expires_min * 60000
    // An expired warning never notifies, live or late. What was already posted stays: it names its
    // own end time, and taking it away would read as an all-clear.
    if (expiresAt <= now) return WeatherAlertNotificationDecision.none
    // The phone cannot place this one — the outlines are still loading, or the bundle has no
    // outline for its areas. That is never read as "not here", so it neither posts nor takes away
    // what an earlier message did post (§7.1).
    if (placement.kind === 'checking' || placement.kind === 'unplaced') return WeatherAlertNotificationDecision.none
    const coversPlace = placement.kind === 'here'
    // The gate closed on a warning already posted — the update no longer covers this place, or the
    // user turned the toggle off — so what stands is no longer true for it.
    if (delivery == null) {
      return posted == null ? WeatherAlertNotificationDecision.none : WeatherAlertNotificationDecision.remove
    }
    if (isBacklog && rank > WeatherAlertGate.stormWarningRank) return WeatherAlertNotificationDecision.none

    if (posted == null) {
      return WeatherAlertNotificationDecision.post({ sound: delivery === 'sound', isLate: isBacklog })
    }
    if (WeatherAlertNotificationRules.isEscalation({ warning, coversPlace, posted, now })) {
      return WeatherAlertNotificationDecision.post({ sound: delivery === 'sound', isLate: isBacklog })
    }
    // A repeat or an update replaces what is on screen, silently. One the user has already
    // dismissed or opened is not brought back for that.
    if (!isDelivered) return WeatherAlertNotificationDecision.none
    return WeatherAlertNotificationDecision.post({ sound: false, isLate: isBacklog })
  },

  /**
   * Whether a repeat of a warning is worth sounding again for:
   *
   * - the tornado tag rose (possible → radar indicated → observed);
   * - flood damage reached catastrophic;
   * - it now covers the place, where the user was only told it was near;
   * - or its expiry was extended, and the user was last told more than 20 minutes ago.
   *
   * Everything else is the same warning said again, which replaces the notification in silence.
   */
  isEscalation({ warning, coversPlace, posted, now }) {
    if (warning.tornado > posted.tornado) return true
    if (warning.flood_damage === MeshWXFloodDamage.catastrophic && posted.floodDamage !== MeshWXFloodDamage.catastrophic) {
      return true
    }
    // Near became here: the reason the user asked to hear about tornadoes nearby was this moment.
    // Not in the owner's list of escalations, and it is one (docs/MESHWX_UI.md §3.1 N-6).
    if (coversPlace && !posted.coversPlace) return true
    const extended =
      warning.expires_min * 60000 >
      posted.alertedExpiresMinutes * 60000 + WeatherAlertNotificationRules.extensionMargin * 1000
    return extended && (now - posted.alertedAt) / 1000 > WeatherAlertNotificationRules.escalationQuietPeriod
  },

  /** The record left by a post, from the one it replaces. */
  record({ identifier, warning, placeID, botID, coversPlace, sound, posted, now }) {
    return WeatherAlertPost.make({
      identifier,
      identity: MeshWXWarningIdentity.of(warning),
      placeID,
      botID,
      tornado: warning.tornado,
      floodDamage: warning.flood_damage,
      expiresMinutes: warning.expires_min,
      coversPlace,
      postedAt: now,
      alertedAt: sound ? now : (posted?.alertedAt ?? now),
      alertedExpiresMinutes: sound ? warning.expires_min : (posted?.alertedExpiresMinutes ?? warning.expires_min),
    })
  },

  /**
   * Posts for warnings that ended long enough ago that no repeat can follow. Nothing is removed
   * from Notification Center by this: it is only what the phone stops remembering.
   */
  pruned(posts, { now }) {
    const kept = {}
    for (const [identifier, post] of Object.entries(posts)) {
      if ((now - WeatherAlertPost.expiresAt(post)) / 1000 < WeatherAlertNotificationRules.postRetention) {
        kept[identifier] = post
      }
    }
    return kept
  },
})
