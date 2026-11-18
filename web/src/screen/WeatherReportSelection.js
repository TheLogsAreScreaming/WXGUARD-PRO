// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherReportSelection.swift

import { WeatherRequest } from '../weather/index.js'

/** Two `WeatherRequest` values are the same request when they are the same `>` line (spec §14). */
function sameRequest(lhs, rhs) {
  if (lhs == null || rhs == null) return lhs == null && rhs == null
  return WeatherRequest.wireText(lhs) === WeatherRequest.wireText(rhs)
}

/**
 * Which held text reply a product's screen shows (docs/MESHWX_UI.md §12, §14 Q5).
 *
 * A text chunk carries its subject and nothing else, so "the newest forecast discussion" is the
 * newest discussion *anybody* asked for — the office is not in it. Picking by subject alone is how
 * a page for Round Rock came to show the discussion this phone had asked Fort Worth for: same
 * subject, different place, and the header said so while the blurb above it said otherwise.
 *
 * So the page's own request decides. A reply this phone asked for is shown only when it answered
 * **this page's** request, argument and all. Anything else is only ever shown as somebody else's:
 * a reply nobody here asked for could be about anywhere, and for a product asked for by area it is
 * labelled as exactly that rather than presented as this place's.
 */
export const WeatherReportSelection = Object.freeze({
  /**
   * The reply a product screen shows, and what can honestly be said about it:
   * `{ item, isOwn, isUnknownArea }`.
   *
   * - `isOwn`: it answered a request of this phone's for what this page asks about.
   * - `isUnknownArea`: nobody here asked for it and the product is asked for by area, so which
   *   office or state it is about is not known — only that the subject matches.
   */
  Choice: Object.freeze({
    make({ item, isOwn, isUnknownArea }) {
      return { item, isOwn, isUnknownArea }
    },
  }),

  /**
   * - `request`: what this page would ask for — `>afd EWX`, `>storm TX`. Null when the page has no
   *   place to build one from, and then only an overheard reply can be shown.
   * - `isByArea`: the product's argument names an office or a state (`WeatherReportProduct`).
   *   `>hwo` and `>space` take none: they are the bot's products, and an overheard one is the same
   *   product this page would have asked for.
   */
  choose({ texts, subject, request, isByArea }) {
    const newestFirst = texts
      .filter((item) => item.assembly.subject === subject)
      .sort((lhs, rhs) => rhs.assembly.lastReceivedAt - lhs.assembly.lastReceivedAt)
    if (request != null) {
      const own = newestFirst.find((item) => sameRequest(item.assembly.request ?? null, request))
      if (own != null) return WeatherReportSelection.Choice.make({ item: own, isOwn: true, isUnknownArea: false })
    }
    // An own reply to a *different* argument belongs to another page and is never borrowed:
    // showing Fort Worth's discussion on an Austin page is the bug, not a fallback.
    const overheard = newestFirst.find((item) => (item.assembly.request ?? null) == null)
    if (overheard == null) return null
    return WeatherReportSelection.Choice.make({ item: overheard, isOwn: false, isUnknownArea: isByArea })
  },
})
