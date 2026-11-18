// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherAlerts.swift

import {
  MeshWXCompass,
  MeshWXFloodDamage,
  MeshWXGeometry,
  MeshWXSeverity,
  MeshWXTornadoTag,
  MeshWXWarningIdentity,
} from '../meshwx/index.js'
import { WeatherStateReducer, WeatherStoredDigest, WeatherStoredWarning } from '../weather/index.js'
import { WeatherGeo } from './WeatherGeo.js'
import { WeatherCoverage, WeatherCoverageVerdict } from './WeatherCoverage.js'
import { WeatherPlaceKind } from './WeatherPlace.js'

/**
 * A decoded warning carries its polygon as the vectors write it, `[[lat, lon], …]`
 * (docs/PORTING.md §5); the geometry helpers take `{ latitude, longitude }` rings.
 */
function ring(polygon) {
  return (polygon ?? []).map(([latitude, longitude]) => ({ latitude, longitude }))
}

/**
 * `WeatherStateReducer.identityOrder` as a JS comparator. The Swift is a `(lhs, rhs) -> Bool`
 * "lhs sorts first" predicate; a port of it may return that boolean or a comparator number, and
 * both read correctly here.
 */
export function identityOrder(lhs, rhs) {
  const answer = WeatherStateReducer.identityOrder(lhs, rhs)
  if (typeof answer === 'boolean') return answer ? -1 : WeatherStateReducer.identityOrder(rhs, lhs) ? 1 : 0
  return answer
}

// MARK: - Placement

/** Where an alert sits relative to the place (docs/MESHWX_UI.md §7.1). */
export const WeatherAlertPlacement = Object.freeze({
  nearKilometres: 50,
  /**
   * An area the bundle has no outline for counts as possibly-here when its centroid is this
   * close, or when it has no centroid either.
   */
  unoutlinedReachKilometres: 150,

  /** Its polygon or one of its areas contains the place or passes within the place's uncertainty. */
  here: Object.freeze({ kind: 'here' }),
  /** Within 50 km; the direction is from the place towards the alert. */
  near({ kilometres, direction }) {
    return { kind: 'near', kilometres, direction }
  },
  /** It names areas and the outlines are still loading. */
  checking: Object.freeze({ kind: 'checking' }),
  /**
   * Nothing to measure against: no polygon and no outline for an area that could be close.
   * Never read as "not here".
   */
  unplaced: Object.freeze({ kind: 'unplaced' }),
  elsewhere: Object.freeze({ kind: 'elsewhere' }),

  /** Whether the alert is a row on the card rather than a count in the footer. */
  isCardRow(placement) {
    return placement.kind !== 'elsewhere'
  },

  /**
   * The order among alerts of the same priority below *here*: an alert that may be here before
   * one known to be near, before one known to be elsewhere.
   */
  sortOrder(placement) {
    switch (placement.kind) {
      case 'here':
        return 0
      case 'checking':
      case 'unplaced':
        return 1
      case 'near':
        return 2
      default:
        return 3
    }
  },

  place(warning, { at: place, geometry, tables }) {
    const point = place.coordinate
    const radius = place.uncertaintyKilometres

    const polygon = ring(warning.polygon)
    if (polygon.length >= 3) {
      // Storm-based products: the polygon is the warning; the county list is only what lies
      // under it.
      const distance = MeshWXGeometry.distanceKilometres({ from: point, to: polygon })
      return WeatherAlertPlacement.classify({
        distance,
        radius,
        from: point,
        towards: WeatherGeo.centre({ of: polygon }),
      })
    }

    const areas = tables.namedAreas({ for: warning })
    if (areas.length === 0) return WeatherAlertPlacement.unplaced
    if (!geometry.isLoaded) return WeatherAlertPlacement.checking

    let nearest = null
    let unoutlinedWithinReach = false
    for (const area of areas) {
      const distance = geometry.distanceKilometres({ from: point, toArea: area.ugc })
      if (distance != null) {
        if (nearest == null || distance < nearest.distance) nearest = { distance, ugc: area.ugc }
      } else if (area.lat != null && area.lon != null) {
        const centroid = { latitude: area.lat, longitude: area.lon }
        if (WeatherGeo.kilometres(point, centroid) <= WeatherAlertPlacement.unoutlinedReachKilometres) {
          unoutlinedWithinReach = true
        }
      } else {
        unoutlinedWithinReach = true
      }
    }
    if (nearest != null && nearest.distance <= radius) return WeatherAlertPlacement.here
    if (unoutlinedWithinReach) return WeatherAlertPlacement.unplaced
    if (nearest == null) return WeatherAlertPlacement.unplaced
    return WeatherAlertPlacement.classify({
      distance: nearest.distance,
      radius,
      from: point,
      towards: geometry.centre({ ofArea: nearest.ugc }),
    })
  },

  classify({ distance, radius, from, towards }) {
    if (distance <= radius) return WeatherAlertPlacement.here
    if (distance <= WeatherAlertPlacement.nearKilometres) {
      return WeatherAlertPlacement.near({
        kilometres: distance,
        direction: towards == null ? MeshWXCompass.north : WeatherGeo.direction({ from, to: towards }),
      })
    }
    return WeatherAlertPlacement.elsewhere
  },
})

// MARK: - Priority

/**
 * The fixed order alerts are listed in (docs/MESHWX_UI.md §7.2). Severity from the significance
 * letter alone would put a tornado warning behind a flood advisory that expires sooner.
 */
export const WeatherAlertPriority = Object.freeze({
  /**
   * Lower is more urgent. `rank(warning, { tables })` for a warning; `rank({ event, tables })`
   * for one known only by its identity, as though it carried no tags (the two Swift overloads).
   */
  rank(first, second) {
    if (second === undefined) {
      return rankOf(first.tables.vtec({ for: first.event }) ?? '', MeshWXFloodDamage.none, MeshWXTornadoTag.none)
    }
    return rankOf(
      second.tables.vtec({ for: first.event }) ?? '',
      first.flood_damage ?? MeshWXFloodDamage.none,
      first.tornado ?? MeshWXTornadoTag.none,
    )
  },

  isTornadoWarning(warning, { tables }) {
    return tables.vtec({ for: warning.event }) === 'TO.W'
  },
})

function rankOf(vtec, floodDamage, tornado) {
  switch (vtec) {
    case 'TO.W':
      return 0
    case 'EW.W':
      return 1
    case 'FF.W':
      return floodDamage === MeshWXFloodDamage.catastrophic ? 2 : 4
    case 'SV.W':
      return tornado !== MeshWXTornadoTag.none ? 3 : 5
    default:
      // A `MeshWXSeverity` is its Swift case name as a string (docs/PORTING.md §3).
      switch (MeshWXSeverity.make({ vtec })) {
        case 'warning':
          return 6
        case 'watch':
          return 7
        case 'advisory':
          return 8
        case 'statement':
          return 9
        default:
          return 10
      }
  }
}

// MARK: - Items

/** What kind of row an alert is. */
export const WeatherAlertItemKind = Object.freeze({
  active: Object.freeze({ kind: 'active' }),
  /** Cancelled as upgraded; the replacement has not been received. */
  upgradedAwaitingReplacement({ cancelledAt }) {
    return { kind: 'upgradedAwaitingReplacement', cancelledAt }
  },
  /**
   * Covered the place and passed its expiry in the last 15 minutes with no update: kept, because
   * a phone clock ahead of the bot's would otherwise end it early.
   */
  expiredRecently: Object.freeze({ kind: 'expiredRecently' }),
})

/**
 * One alert as the screen lists it: the union across bots, placed and ranked.
 * `{ identity, warning, kind, placement, rank, botIDs, receivedAt, beginsAt }`.
 *
 * `beginsAt` is when it takes effect (spec §3, revision 12), from the stored copy rather than
 * recomputed from the wire's expiry-relative field. Null when it is in effect from its issuance —
 * or the bot did not say — which is every warning before revision 12. A start still ahead is what
 * makes an alert read "from Wed 19:00 until Fri 19:00" instead of counting down to an end that has
 * not begun; it changes nothing about where the alert sorts or whether it covers the place.
 */
export const WeatherAlertItem = Object.freeze({
  Kind: WeatherAlertItemKind,

  make({ identity, warning, kind, placement, rank, botIDs, receivedAt, beginsAt = null }) {
    return { identity, warning, kind, placement, rank, botIDs, receivedAt, beginsAt }
  },

  id(item) {
    return item.identity
  },

  expiresAt(item) {
    return item.warning.expires_min * 60000
  },
})

export const WeatherAlertItems = Object.freeze({
  expiredHold: 15 * 60,

  /**
   * Every alert held by any bot, one item per identity, placed against the place and sorted.
   *
   * Two bots can hold different copies of one warning (spec §20). The copy shown is the one still
   * active over one that has expired — a bot that heard the extension beats one that did not —
   * then the one with the later expiry. An upgrade marker stands in only when no bot holds a copy
   * of the warning at all.
   *
   * Order: anything *here* first, then by priority whatever the placement — a Tornado Warning
   * 20 km away above a Heat Advisory whose outlines are still loading — then checking/unplaced
   * before near before elsewhere, then the soonest expiry. A covering alert that just expired
   * comes last: it is a note about what ended, not something to act on.
   *
   * With no place, placement is `elsewhere` for everything — the card lists them without claiming
   * any is here.
   */
  make({ states, place, geometry, tables, now }) {
    const candidates = new Map()
    // Bot order fixed, so which copy wins a full tie does not depend on dictionary order.
    const botIDs = Object.keys(states)
      .map(Number)
      .sort((lhs, rhs) => lhs - rhs)

    for (const botID of botIDs) {
      const state = states[String(botID)]
      if (state == null) continue
      for (const stored of Object.values(state.warnings ?? {})) {
        let kind
        if (!WeatherStoredWarning.isExpired(stored, { at: now })) {
          kind = WeatherAlertItemKind.active
        } else if ((now - WeatherStoredWarning.expiresAt(stored)) / 1000 <= WeatherAlertItems.expiredHold) {
          kind = WeatherAlertItemKind.expiredRecently
        } else {
          continue
        }
        const key = MeshWXWarningIdentity.key(WeatherStoredWarning.identity(stored))
        const held = candidates.get(key)
        if (held == null) {
          // `anyBeginsAt`: the start from the first bot, in bot order, whose copy states one. The
          // shown copy's own wins below; this stands in when that copy came from a bot that said
          // nothing (revision 12).
          candidates.set(key, { stored, kind, botIDs: new Set([botID]), anyBeginsAt: stored.beginsAt ?? null })
          continue
        }
        held.botIDs.add(botID)
        held.anyBeginsAt = held.anyBeginsAt ?? stored.beginsAt ?? null
        if (prefers(stored, kind, held.stored, held.kind)) {
          held.stored = stored
          held.kind = kind
        }
      }
    }

    const markers = new Map()
    for (const botID of botIDs) {
      const state = states[String(botID)]
      if (state == null) continue
      for (const [key, pending] of Object.entries(state.pendingUpgrades ?? {})) {
        if (candidates.has(key)) continue
        const stored = WeatherStoredWarning.make({
          warning: pending.warning,
          receivedAt: pending.cancelledAt,
          beginsAt: pending.warning.begins_min == null ? null : pending.warning.begins_min * 60000,
        })
        const kind = WeatherAlertItemKind.upgradedAwaitingReplacement({ cancelledAt: pending.cancelledAt })
        const held = markers.get(key)
        if (held == null) {
          markers.set(key, { stored, kind, botIDs: new Set([botID]) })
          continue
        }
        held.botIDs.add(botID)
        if (pending.cancelledAt > held.stored.receivedAt) {
          held.stored = stored
          held.kind = kind
        }
      }
    }
    for (const [key, marker] of markers) if (!candidates.has(key)) candidates.set(key, marker)

    const items = []
    for (const candidate of candidates.values()) {
      const placement =
        place == null
          ? WeatherAlertPlacement.elsewhere
          : WeatherAlertPlacement.place(candidate.stored.warning, { at: place, geometry, tables })
      // An expired alert is only worth a row where it mattered.
      if (candidate.kind.kind === 'expiredRecently' && placement.kind !== 'here') continue
      items.push(
        WeatherAlertItem.make({
          identity: WeatherStoredWarning.identity(candidate.stored),
          warning: candidate.stored.warning,
          kind: candidate.kind,
          placement,
          rank: WeatherAlertPriority.rank(candidate.stored.warning, { tables }),
          botIDs: [...candidate.botIDs].sort((lhs, rhs) => lhs - rhs),
          receivedAt: candidate.stored.receivedAt,
          // The shown copy's start, else another bot's: a start is a fact about the product, and a
          // copy from a bot older than revision 12 saying nothing is not a copy saying it began.
          beginsAt: candidate.stored.beginsAt ?? candidate.anyBeginsAt ?? null,
        }),
      )
    }

    return items.sort((lhs, rhs) => {
      const lhsExpired = lhs.kind.kind === 'expiredRecently'
      const rhsExpired = rhs.kind.kind === 'expiredRecently'
      if (lhsExpired !== rhsExpired) return rhsExpired ? -1 : 1
      const lhsHere = lhs.placement.kind === 'here'
      const rhsHere = rhs.placement.kind === 'here'
      if (lhsHere !== rhsHere) return lhsHere ? -1 : 1
      if (lhs.rank !== rhs.rank) return lhs.rank - rhs.rank
      const lhsOrder = WeatherAlertPlacement.sortOrder(lhs.placement)
      const rhsOrder = WeatherAlertPlacement.sortOrder(rhs.placement)
      if (lhsOrder !== rhsOrder) return lhsOrder - rhsOrder
      const lhsExpires = WeatherAlertItem.expiresAt(lhs)
      const rhsExpires = WeatherAlertItem.expiresAt(rhs)
      if (lhsExpires !== rhsExpires) return lhsExpires - rhsExpires
      if (lhs.identity.etn !== rhs.identity.etn) return lhs.identity.etn - rhs.identity.etn
      return identityOrder(lhs.identity, rhs.identity)
    })
  },
})

/**
 * Whether one bot's copy of a warning should be shown over another's: active over expired, then
 * the later expiry, then the later message.
 */
function prefers(stored, kind, held, heldKind) {
  const isActive = kind.kind === 'active'
  const heldIsActive = heldKind.kind === 'active'
  if (isActive !== heldIsActive) return isActive
  if (stored.warning.expires_min !== held.warning.expires_min) {
    return stored.warning.expires_min > held.warning.expires_min
  }
  return stored.receivedAt > held.receivedAt
}

// MARK: - Folding

/**
 * The alerts card's rows (docs/MESHWX_UI.md §7.3): at most `limit`, plus "N more".
 *
 * The dangerous ones are never folded, wherever they are: the six storm warnings at the top of the
 * priority order (rank 0–5), and an upgrade whose replacement has not arrived — the replacement is
 * worse than what it replaced, and this row is all the phone has of it. Only other items past the
 * limit fold. Order is kept.
 */
export const WeatherAlertFolding = Object.freeze({
  /**
   * Tornado, Extreme Wind, catastrophic Flash Flood, tornado-tagged Severe Thunderstorm, Flash
   * Flood and Severe Thunderstorm Warnings.
   */
  neverFoldedRank: 5,

  fold(items, { limit = 2, tables }) {
    const rows = items.filter(
      (item, offset) => offset < limit || WeatherAlertFolding.isNeverFolded(item, { tables }),
    )
    return { rows, folded: items.length - rows.length }
  },

  isNeverFolded(item, { tables }) {
    if (item.kind.kind === 'upgradedAwaitingReplacement') return true
    return WeatherAlertPriority.rank(item.warning, { tables }) <= WeatherAlertFolding.neverFoldedRank
  },
})

// MARK: - Status line

/**
 * The one line that says what the alerts card can and cannot claim (docs/MESHWX_UI.md §7.4).
 * Evaluated top to bottom; the first condition that holds wins.
 */
export const WeatherAlertStatus = Object.freeze({
  /** Three hours between scheduled lists, plus a quarter of an hour for a late broadcast. */
  listFreshFor: 3 * 60 * 60 + 15 * 60,

  noPlace: Object.freeze({ kind: 'noPlace' }),
  /**
   * The place is outside every bot's area, on the bots' own complete statements (spec §10) or,
   * for a bot that has stated nothing, on its station footprint.
   */
  outOfCoverage: Object.freeze({ kind: 'outOfCoverage' }),
  /** No alert list from any bot covering the place. */
  notChecked: Object.freeze({ kind: 'notChecked' }),
  /**
   * The bot has never received anything from its home office (`feed_health` 255): new alerts may
   * not reach it at all.
   */
  feedNeverReceived: Object.freeze({ kind: 'feedNeverReceived' }),
  radioOffline({ listAsOf }) {
    return { kind: 'radioOffline', listAsOf }
  },
  missedMessages: Object.freeze({ kind: 'missedMessages' }),
  listOld({ asOf }) {
    return { kind: 'listOld', asOf }
  },
  locationOld({ since }) {
    return { kind: 'locationOld', since }
  },
  /**
   * No bot's evidence places this place: none has stated its coverage or sent a multi-station
   * batch in the last day, a statement's lists were cut, or the outlines have not loaded.
   */
  coverageUnknown: Object.freeze({ kind: 'coverageUnknown' }),
  /**
   * A bot answering for the place states its offices, with the office-cut flag clear, and the
   * place's forecast office is not among them.
   */
  officeMayNotBeCovered({ office }) {
    return { kind: 'officeMayNotBeCovered', office }
  },
  /** Alerts here, near, still being placed, or unplaceable: the rows say it. */
  rowsSpeak: Object.freeze({ kind: 'rowsSpeak' }),
  /**
   * Nothing from the bot's home office for over four hours (spec §5). Normal for a quiet office
   * overnight and also what a broken feed looks like, so it withholds "none" and the check without
   * saying anything is wrong; below every status that asks for something.
   */
  feedQuiet({ minutesSinceProduct }) {
    return { kind: 'feedQuiet', minutesSinceProduct }
  },
  noneHere({ elsewhere, asOf }) {
    return { kind: 'noneHere', elsewhere, asOf }
  },
  /** The green check: no alert received, and this phone would have received one. */
  clear({ asOf }) {
    return { kind: 'clear', asOf }
  },

  evaluate({ place, coverage, states, items, isRadioConnected, sessionStartedAt, tables, now }) {
    if (place == null) return WeatherAlertStatus.noPlace
    // Only a bot's own complete statement (spec §10), or its station footprint where it has
    // stated nothing, can put a place outside an area. A list the bot had to cut means "not
    // listed", which is `unknown` and lands on `coverageUnknown` below.
    const verdict = WeatherCoverage.verdict(coverage, { for: place })
    if (verdict === WeatherCoverageVerdict.outside) return WeatherAlertStatus.outOfCoverage

    // Where no bot's area is known to cover the place, every bot's list is considered, which is
    // enough to say what is wrong with the list — but never enough for calm (`coverageUnknown`).
    const covering = WeatherCoverage.botIDs(coverage, { covering: place })
    const relevant = Object.keys(states)
      .map(Number)
      .sort((lhs, rhs) => lhs - rhs)
      .filter((botID) => covering.size === 0 || covering.has(botID))
      .map((botID) => states[String(botID)])

    let digest = null
    for (const state of relevant) {
      if (state.digest == null) continue
      if (digest == null || WeatherStoredDigest.builtAt(digest) < WeatherStoredDigest.builtAt(state.digest)) {
        digest = state.digest
      }
    }
    if (digest == null) return WeatherAlertStatus.notChecked

    const feed = WeatherStoredDigest.feed(digest)
    const builtAt = WeatherStoredDigest.builtAt(digest)
    if (feed.kind === 'neverReceived') return WeatherAlertStatus.feedNeverReceived
    if (!isRadioConnected) return WeatherAlertStatus.radioOffline({ listAsOf: builtAt })
    if (
      relevant.some(
        (state) =>
          state.needsDigest ||
          (state.missingFromDigest ?? []).length > 0 ||
          Object.keys(state.pendingUpgrades ?? {}).length > 0,
      )
    ) {
      return WeatherAlertStatus.missedMessages
    }
    const listedBeforeSession = sessionStartedAt == null ? true : digest.receivedAt < sessionStartedAt
    if ((now - builtAt) / 1000 > WeatherAlertStatus.listFreshFor || listedBeforeSession) {
      return WeatherAlertStatus.listOld({ asOf: builtAt })
    }
    if (place.kind === WeatherPlaceKind.lastKnown && place.locatedAt != null) {
      return WeatherAlertStatus.locationOld({ since: place.locatedAt })
    }
    if (verdict === WeatherCoverageVerdict.unknown) return WeatherAlertStatus.coverageUnknown

    // The office claim rests on the bot's own coverage message and nothing weaker
    // (docs/MESHWX_UI.md §3.1 I-B18): stated offices, the office-cut flag clear, and the place's
    // office not among them. The offices a bot has *shown* are whichever products happen to be
    // active this hour — the weather, not the coverage.
    const office = WeatherCoverage.uncarriedOffice(coverage, { for: place })
    if (office != null) return WeatherAlertStatus.officeMayNotBeCovered({ office })

    if (items.some((item) => WeatherAlertPlacement.isCardRow(item.placement))) return WeatherAlertStatus.rowsSpeak
    if (feed.kind === 'quiet') return WeatherAlertStatus.feedQuiet({ minutesSinceProduct: feed.minutes })
    const elsewhere = items.filter((item) => item.placement.kind === 'elsewhere').length
    if (elsewhere > 0) return WeatherAlertStatus.noneHere({ elsewhere, asOf: builtAt })
    return WeatherAlertStatus.clear({ asOf: builtAt })
  },

  /**
   * Whether a warning shows that the bot carries its issuer's forecast office. A national centre's
   * product covers many offices' areas and shows none of them. Nor does a tornado or severe
   * thunderstorm watch under office 0: a revision 2 bot, whose bundle had no Storm Prediction
   * Center, sent its watches as office 0, which reads as Albuquerque.
   *
   * Not what `officeMayNotBeCovered` rests on: since spec revision 4 a bot states its offices
   * itself (`WeatherCoverage.uncarriedOffice`), which is evidence, and the offices seen on
   * warnings are not.
   */
  showsOffice(identity, { tables }) {
    if (tables.isNationalCentre(identity.office)) return false
    if (identity.office === 0) {
      const vtec = tables.vtec({ for: identity.event })
      if (vtec === 'TO.A' || vtec === 'SV.A') return false
    }
    return true
  },
})
