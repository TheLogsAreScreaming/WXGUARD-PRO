// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherAreaSweepCost.swift

import { MeshWXTables, MeshWXWire } from '../meshwx/index.js'
import { WeatherAreaSelection } from './WeatherAreaSelection.js'

/**
 * What one tap on the alert map would spend, in packets, said in plain words before it is spent
 * (docs/MESHWX_UI.md §17).
 *
 * The map is the only request in the grammar whose cost is stated on the button, because it is
 * the only one that can be eight packets broadcast to everyone listening. The figure does not
 * have to be right — it has to be honest and never wildly low, which is why every branch below
 * is either measured from a sweep this phone actually received or a deliberately blunt rule of
 * thumb.
 */
export const WeatherAreaSweepCost = Object.freeze({
  /**
   * With nothing held: states per packet. Blunt on purpose — four average states' runs and their
   * four scope entries fit one packet comfortably, and a phone that has never seen a sweep has
   * nothing better to say.
   */
  statesPerPacket: 4,
  /**
   * With nothing held, for the whole country. Measured against the bot's live products on
   * 2026-09-20: warnings and watches were 148 runs, five packets at 36 to a packet; with
   * advisories 263 runs, eight. Eight is the ceiling and a busy day reaches it.
   */
  nationalPackets: 5,
  nationalPacketsWithAdvisories: 8,

  /**
   * `packets({ for: selection, advisories, held })` → the number under the button.
   *
   * - **The whole country**: the last national sweep at this level, which is the only honest
   *   figure there is, else 5 (8 with advisories).
   * - **A few states**: `ceil((entries in those states + states) / 36)`, at least 1. The scope
   *   entries count toward the 36 a bot puts in a packet (spec §12), which is why the state count
   *   is in the numerator — fifteen states cost almost half a packet before any weather does.
   * - **A few states with nothing national held**: one packet per four states, at least one.
   *
   * The entry count is read from the whole picture rather than from the national part alone.
   * The picture is by construction the newest word on every state (`WeatherAlertMapPicture`), so
   * for a selection it is a better estimate of what a fresh sweep would carry than the national
   * sweep on its own — and where no scoped sweep has ever arrived the two are the same number.
   *
   * `held` is a `WeatherAlertMapPicture`; `tables` names the scope's state indices, exactly as
   * everywhere else in this layer.
   */
  packets({ for: selection, advisories, held, tables = MeshWXTables.shared }) {
    const national = held?.parts?.find((part) => !part.isScoped) ?? null
    if (WeatherAreaSelection.asksWholeCountry(selection)) {
      // Only a sweep taken at the same level says what this level costs: a narrow map says
      // nothing about how much more the advisories would add.
      if (national != null && national.includesAdvisories === advisories && national.totalPackets > 0) {
        return national.totalPackets
      }
      return advisories
        ? WeatherAreaSweepCost.nationalPacketsWithAdvisories
        : WeatherAreaSweepCost.nationalPackets
    }

    const count = selection.states.length
    if (national == null) {
      return Math.max(1, Math.ceil(count / WeatherAreaSweepCost.statesPerPacket))
    }
    const wanted = new Set(selection.states)
    const states = tables?.states ?? []
    let entries = 0
    for (const entry of held.entries ?? []) {
      const code = states[entry.state]
      if (code != null && wanted.has(code)) entries += 1
    }
    return Math.max(1, Math.ceil((entries + count) / MeshWXWire.areaSweepEntriesSent))
  },
})
