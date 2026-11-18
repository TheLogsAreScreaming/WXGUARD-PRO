// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherPartsOffer.swift

import { WeatherAreaSweepAssembly, WeatherPartsKind, WeatherRequest, WeatherTextAssembly } from '../weather/index.js'

/**
 * Whether the screen offers to ask for the packets of an answer that never arrived, and which
 * request that tap would send (spec §12, revision 10).
 *
 * Owner, 20 September 2026: *"'4 of 7 parts arrived': should allow me to re-request the missing
 * data."* An **offer**, never automatic — a resend costs one packet of shared airtime per part,
 * and a screen that fetched them because it was opened would spend the channel on a swipe.
 *
 * Two times bound the offer, and each of them is a different mistake being avoided:
 *
 * - **At least 15 s since the newest packet.** The bot resends a packet nothing echoed, 8-10 s
 *   later, of its own accord. Offering before that has had its chance asks for a packet that is
 *   already on the air.
 * - **At most 10 minutes since the first packet.** `PARTS_CACHE_S` is 600: past it the bot no
 *   longer holds the bytes, and `>part` would come back Not available. After that the ordinary
 *   ask — the whole map, the whole report — is the only offer there is.
 */
export const WeatherPartsOffer = Object.freeze({
  /** The bot's own echo resend has had its chance. Seconds. */
  settleSeconds: 15,
  /** `MeshWXWire.partsCacheSeconds`: past this the bot no longer holds the bytes. Seconds. */
  windowSeconds: 600,

  /**
   * The request that would fetch the holes, or null when there is nothing to offer.
   *
   * `assembly` is a `WeatherAreaSweepAssembly` or a `WeatherTextAssembly`; `kind` is the
   * `WeatherPartsKind` that says which, and travels into the request so the log can name what
   * was asked about.
   */
  make({ assembly, kind, now }) {
    if (assembly == null || kind == null) return null
    const missing = WeatherPartsOffer.missingIndexes({ assembly, kind })
    if (missing.length === 0) return null
    if ((now - assembly.lastReceivedAt) / 1000 < WeatherPartsOffer.settleSeconds) return null
    if ((now - assembly.firstReceivedAt) / 1000 > WeatherPartsOffer.windowSeconds) return null
    return WeatherRequest.parts({ group: assembly.group, indexes: missing, of: kind })
  },

  /** The holes in either kind of assembly, ascending. */
  missingIndexes({ assembly, kind }) {
    if (assembly == null) return []
    return kind?.kind === WeatherPartsKind.areaSweep.kind
      ? WeatherAreaSweepAssembly.missingIndexes(assembly)
      : WeatherTextAssembly.missingIndexes(assembly)
  },
})
