// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherAlertRequests.swift

import { MeshWXWarningIdentity } from '../meshwx/index.js'
import { WeatherRequest } from '../weather/index.js'
import { identityOrder, WeatherAlertPriority } from './WeatherAlerts.js'

/**
 * A Swift `Set<MeshWXWarningIdentity>` as identity keys. The caller may pass identities (an array
 * or a `Set` of them, docs/PORTING.md §3 "sets are arrays without duplicates when persisted") or
 * the `"event.office.etn"` keys themselves.
 */
function keySet(identities) {
  const keys = new Set()
  for (const one of identities ?? []) {
    keys.add(typeof one === 'string' ? one : MeshWXWarningIdentity.key(one))
  }
  return keys
}

/**
 * Which request an alerts button sends (docs/MESHWX_UI.md §7.4, §12).
 *
 * Decided from the *source* bot's state alone: the bot the request goes to is the one whose gaps,
 * missing identities and upgrade markers the request can repair. Another bot's list says nothing
 * about what this one would send back.
 */
export const WeatherAlertRequests = Object.freeze({
  /**
   * "Ask for alerts" under a missed-messages status line.
   *
   * - An upgrade whose replacement never came: `>w <county>` for the place's county; with no
   *   place, the county the upgraded warning covered; else `>w`. Upgrades are storm-based
   *   warnings, and those carry county codes.
   * - Warnings the list named that never arrived: one of them by identity, per tap
   *   (`missingWarnings`).
   * - A gap with nothing known to be missing: `>d`, the list that says what is active.
   */
  missedMessages({ source, placeCountyUGC, placeOffice, notAvailable = [], tables }) {
    if (Object.keys(source.pendingUpgrades ?? {}).length > 0) {
      if (placeCountyUGC != null) return WeatherRequest.warningsTouching({ ugc: placeCountyUGC })
      const upgrade = newestUpgrade(source)
      const areas = upgrade == null ? [] : tables.namedAreas({ for: upgrade.warning })
      const area = areas.find((one) => one.isCounty) ?? areas[0]
      if (area?.ugc != null) return WeatherRequest.warningsTouching({ ugc: area.ugc })
      return WeatherRequest.activeWarnings
    }
    return (
      WeatherAlertRequests.missingWarnings({ source, placeOffice, notAvailable, tables }) ?? WeatherRequest.digest
    )
  },

  /**
   * The one request for the warnings a list named that this phone does not hold ("Listed, not
   * received · Ask"), or null when nothing is missing.
   *
   * One warning per tap, by identity: `>w <county>` never finds a zone-coded watch or advisory,
   * and `>w` and `>w <county>` stop at six, so asking by area can leave the list unfinished
   * however often it is tapped. The most important goes first: the higher `WeatherAlertPriority`
   * rank, then the place's own office, then identity order. An identity the bot has said it does
   * not have since this list arrived (`notAvailable`) is passed over; once all have been, `>d`
   * asks for a list that no longer names them. With none the bundle can spell, `>w`.
   */
  missingWarnings({ source, placeOffice, notAvailable = [], tables }) {
    const missing = source.missingFromDigest ?? []
    if (missing.length === 0) return null
    const spellable = []
    for (const identity of missing) {
      const text = WeatherAlertRequests.identityString(identity, { tables })
      if (text != null) spellable.push({ identity, text })
    }
    if (spellable.length === 0) return WeatherRequest.activeWarnings
    const refused = keySet(notAvailable)
    let next = null
    for (const candidate of spellable) {
      if (refused.has(MeshWXWarningIdentity.key(candidate.identity))) continue
      if (
        next == null ||
        WeatherAlertRequests.isAskedBefore(candidate.identity, next.identity, { placeOffice, tables })
      ) {
        next = candidate
      }
    }
    return next == null ? WeatherRequest.digest : WeatherRequest.warning({ identity: next.text })
  },

  /** The order missing warnings are asked for in: priority, then the place's office, then identity. */
  isAskedBefore(lhs, rhs, { placeOffice, tables }) {
    const lhsRank = WeatherAlertPriority.rank({ event: lhs.event, tables })
    const rhsRank = WeatherAlertPriority.rank({ event: rhs.event, tables })
    if (lhsRank !== rhsRank) return lhsRank < rhsRank
    const lhsHome = placeOffice != null && tables.officeCode(lhs.office) === placeOffice
    const rhsHome = placeOffice != null && tables.officeCode(rhs.office) === placeOffice
    if (lhsHome !== rhsHome) return lhsHome
    return identityOrder(lhs, rhs) < 0
  },

  /**
   * `SV.W.EWX.42`: an identity as the bot's `>w` and `>wt` requests spell it (spec §14), or null
   * when the bundle cannot name the event or the office.
   */
  identityString(identity, { tables }) {
    const vtec = tables.vtec({ for: identity.event })
    const office = tables.officeCode(identity.office)
    if (vtec == null || office == null) return null
    return `${vtec}.${office}.${identity.etn}`
  },

  /**
   * The identity an `event.office.etn` string names, read case-insensitively; null for anything
   * the tables cannot resolve.
   */
  identity({ from, tables }) {
    const parts = from
      .trim()
      .toUpperCase()
      .split('.')
      .filter((part) => part.length > 0)
    if (parts.length !== 4) return null
    if (!/^\d+$/.test(parts[3])) return null
    const etn = Number(parts[3])
    if (etn > 0xffff) return null
    // `MeshWXTables.eventByCode` is the Swift's `[String: UInt8]`; the MeshWX layer holds it as a
    // `Map`, so read it either way rather than assume one.
    const code = `${parts[0]}.${parts[1]}`
    const event = typeof tables.eventByCode?.get === 'function' ? tables.eventByCode.get(code) : tables.eventByCode?.[code]
    if (event == null) return null
    const officePosition = tables.offices.indexOf(parts[2])
    if (officePosition < 0 || officePosition > 0xff) return null
    return { event, office: officePosition, etn }
  },
})

/**
 * The most recently cancelled upgrade, ties broken by identity so the pick does not depend on
 * dictionary order.
 */
function newestUpgrade(state) {
  let best = null
  for (const pending of Object.values(state.pendingUpgrades ?? {})) {
    if (best == null) {
      best = pending
      continue
    }
    if (pending.cancelledAt !== best.cancelledAt) {
      if (pending.cancelledAt > best.cancelledAt) best = pending
      continue
    }
    if (identityOrder(MeshWXWarningIdentity.of(pending.warning), MeshWXWarningIdentity.of(best.warning)) < 0) best = pending
  }
  return best
}
