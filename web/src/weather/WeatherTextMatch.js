// Port of MC1Services/Services/Weather/WeatherTextMatch.swift (docs/PORTING.md).

import { WeatherRequest } from './WeatherRequest.js'
import { WeatherTextAssembly, identityKey } from './WeatherBotState.js'

/**
 * Whether a text reply is the answer to one particular request.
 *
 * A text chunk carries its subject and nothing else (spec §8): somebody else's `>storm OK`, a
 * TAF when this phone asked for the METAR (both are subject 5), or another warning's narrative
 * all arrive looking like the reply this phone is waiting for. The request's argument has to be
 * read back out of the words, and a reply that does not show it neither settles the request nor
 * becomes this phone's.
 *
 * The keys, per request, as the bot words its replies (spec §14, revision 3, and vector
 * `text_warning_narrative_chunk0`):
 * - `>metar KAUS`: the first chunk opens `METAR KAUS` and names the station in its first words
 *   (`SPECI`, or the station followed by a `DDHHMMZ` time, are accepted too). The bot never
 *   answers with another station's report; without one it sends Not available `m`.
 * - `>taf KAUS`: the first chunk opens `TAF KAUS` (an amendment `TAF KAUS AMD`) and names the
 *   station in its first words; without one, Not available `t`.
 * - `>wt SV.W.EWX.42`: the first chunk names the event ("SEVERE THUNDERSTORM WARNING"), and when
 *   the warning is held with named areas, the text names one of them. The text carries neither
 *   the office nor the tracking number.
 * - `>storm TX`, `>rain TX`: the state code as an upper-case word. The kit has no sample of
 *   either reply, so this is a best guess (docs/MESHWX_UI.md §14).
 * - `>afd`, `>space`, `>hwo`: the subject alone. Space weather and the outlook take no argument;
 *   the discussion's office has no key the kit shows.
 *
 * Evaluated on every chunk against everything received so far, so a reply whose key lies in a
 * chunk that arrives later settles when that chunk does.
 */
export const WeatherTextMatch = {
  /**
   * `states` is the service's per-bot state, keyed by bot id as a string. `identity` is the
   * `event.office.etn` reader, injectable only so the screen layer's
   * `WeatherAlertRequests.identity` can be substituted for it — the two take the same
   * `{ from, tables }`, so it is a straight hand-off. See `identityFromString` below for why
   * there is a copy of it in this layer at all.
   */
  matches(request, { assembly, states, tables, identity = identityFromString }) {
    const expected = WeatherRequest.expectedReply(request)
    if (expected.kind !== 'text' || assembly.subject !== expected.subject) return false

    switch (request.kind) {
      case 'metar': {
        const lead = leadWords(assembly)
        if (lead == null) return false
        const station = request.station.toUpperCase()
        const opensAsMETAR = lead[0] === 'METAR' || lead[0] === 'SPECI'
          || (lead[0] === station && lead[1] != null && isObservationTime(lead[1]))
        return opensAsMETAR && lead.slice(0, 3).includes(station)
      }

      case 'taf': {
        const lead = leadWords(assembly)
        if (lead == null) return false
        return lead[0] === 'TAF' && lead.includes(request.station.toUpperCase())
      }

      case 'warningText': {
        const named = identity({ from: request.identity, tables })
        if (named == null) return false
        const eventName = tables.eventName({ for: named.event })?.long
        const lead = assembly.chunks['0']
        if (eventName == null || lead == null) return false
        if (!WeatherTextMatch.containsWord(eventName, { in: lead, caseInsensitive: true })) return false
        const held = WeatherTextMatch.heldWarning(named, { in: states })
        const areaNames = held == null
          ? []
          : tables.namedAreas({ for: held }).map((area) => area.name).filter((name) => name != null)
        if (areaNames.length === 0) return true
        const text = WeatherTextMatch.joinedText(assembly)
        return areaNames.some((name) => WeatherTextMatch.containsWord(name, { in: text, caseInsensitive: true }))
      }

      case 'stormReports':
      case 'rainfall':
        return WeatherTextMatch.containsWord(request.state.toUpperCase(), {
          in: WeatherTextMatch.joinedText(assembly), caseInsensitive: false
        })

      default:
        return true
    }
  },

  /**
   * The warning an identity names, from whichever bot holds it (lowest bot id first, so the
   * answer does not depend on dictionary order), or the upgrade marker it left.
   */
  heldWarning(identity, { in: states }) {
    const key = identityKey(identity)
    const botIDs = Object.keys(states).map(Number).sort((lhs, rhs) => lhs - rhs)
    for (const botID of botIDs) {
      const held = states[String(botID)]?.warnings?.[key]
      if (held != null) return held.warning
    }
    for (const botID of botIDs) {
      const pending = states[String(botID)]?.pendingUpgrades?.[key]
      if (pending != null) return pending.warning
    }
    return null
  },

  /**
   * The chunks received so far in order. Neighbouring chunks join directly — the bot splits on
   * bytes, mid-word — and a missing chunk becomes a space so its neighbours cannot fuse into a
   * word neither contains.
   */
  joinedText(assembly) {
    return WeatherTextAssembly.orderedChunks(assembly).map((chunk) => chunk ?? ' ').join('')
  },

  containsWord(word, { in: text, caseInsensitive }) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9])${escapeForRegExp(word)}(?![A-Za-z0-9])`,
      caseInsensitive ? 'i' : ''
    )
    return pattern.test(text)
  }
}

/**
 * The identity an `event.office.etn` string names, read case-insensitively; null for anything
 * the tables cannot resolve.
 *
 * Deviation: the Swift calls `WeatherAlertRequests.identity(from:tables:)`, which lives under
 * `Screen/` and therefore in `src/screen/` — a layer this one may not import (PORTING.md §9,
 * `weather` never imports `screen`). The rule is four lookups against the bundle tables, so it
 * lives here; `WeatherTextMatch.matches` and `WeatherService` both accept an override so the
 * screen layer's copy can be injected instead.
 */
export function identityFromString({ from, tables }) {
  const parts = from.trim().toUpperCase().split('.')
  if (parts.length !== 4) return null
  if (!/^\d+$/.test(parts[3])) return null
  const etn = Number(parts[3])
  if (etn > 0xffff) return null
  const event = tables.eventByCode.get(`${parts[0]}.${parts[1]}`)
  if (event == null) return null
  const office = tables.offices.indexOf(parts[2])
  if (office < 0 || office > 0xff) return null
  return { event, office, etn }
}

/** `SV.W.EWX.42`: an identity as the bot's `>w` and `>wt` requests spell it (spec §14). */
export function identityString(identity, { tables }) {
  const vtec = tables.vtec({ for: identity.event })
  const office = tables.officeCode(identity.office)
  if (vtec == null || office == null) return null
  return `${vtec}.${office}.${identity.etn}`
}

/** The first four words of chunk 0, upper-cased; null until chunk 0 has arrived. */
function leadWords(assembly) {
  const lead = assembly.chunks['0']
  if (lead == null) return null
  return lead.toUpperCase().split(/\s+/).filter((word) => word.length > 0).slice(0, 4)
}

/** `150051Z`: a METAR's day-hour-minute group. */
function isObservationTime(word) {
  return word.length === 7 && word.endsWith('Z') && /^[0-9]{6}$/.test(word.slice(0, 6))
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
