// Port of MC1Services/Services/Weather/WeatherRequest.swift (docs/PORTING.md).

import { MeshWXRadarTile, MeshWXWire } from '../meshwx/index.js'

/**
 * The MeshWX v5 request grammar (spec §14), one case per line of the table, with the text
 * the bot parses and the answer the app should wait for.
 *
 * Requests are plain text starting with `>`. The bot takes them as a DM or as text on
 * `#meshwx`; the app sends a DM, which only the addressed bot can read, so exactly one bot
 * answers (spec §14, §20, revision 2). The same words without the prefix are what people type
 * in the bot's chat and get a text reply for; the prefix is what turns the answer into v5
 * messages on `#meshwx` for every listening app. Identities and codes are carried as the
 * strings the bot expects (`SV.W.EWX.42`, `TXC453`, `KAUS`, `EWX`); the caller renders them
 * from the bundle tables, so this type stays free of the wire tables and of anything the UI
 * would have to localise.
 *
 * A Swift enum with associated values is `{ kind, …labels }` (PORTING.md §3). The constant
 * cases are frozen values on this namespace, the rest are builders.
 */
export const WeatherRequest = Object.freeze({
  /** `>d` — the active-warning digest. */
  digest: Object.freeze({ kind: 'digest' }),
  /** `>w` — every active warning in coverage (at most 6, newest first), then a digest. */
  activeWarnings: Object.freeze({ kind: 'activeWarnings' }),
  /**
   * `>w SV.W.EWX.42` — one warning by identity (`event.office.etn`), or Not available. No
   * digest follows.
   */
  warning({ identity }) { return { kind: 'warning', identity } },
  /**
   * `>w TXC453` / `>w TXZ192` — every active warning whose area list names that county or zone
   * exactly (at most 6). No digest follows. Storm-based warnings carry county codes, most other
   * products zone codes, so a county finds no watch or advisory (spec §14).
   */
  warningsTouching({ ugc }) { return { kind: 'warningsTouching', ugc } },
  /** `>wt SV.W.EWX.42` — a warning's narrative as text, subject 0. */
  warningText({ identity }) { return { kind: 'warningText', identity } },
  /** `>o` — observations for the coverage stations: a batch of one when only one reported. */
  observations: Object.freeze({ kind: 'observations' }),
  /** `>o KAUS` — one station. */
  observation({ station }) { return { kind: 'observation', station } },
  /** `>f` — the forecast for the bot's home point. */
  homeForecast: Object.freeze({ kind: 'homeForecast' }),
  /**
   * `>f 102` — the forecast for a bundled point index. It comes back under that index when the
   * forecast is at the point's coordinates (spec §7, revision 3; a revision 2 bot could use
   * another index with the same coordinates); a nearby point within 80 km carries its own
   * index, and a place with no bundled point `0xFFFF`.
   */
  forecast({ point }) { return { kind: 'forecast', point } },
  /**
   * `>f round rock tx` — the forecast for a place the bot resolves (the reply's `point` may
   * be `0xFFFF`, in which case the request itself is the label).
   */
  forecastForPlace(place) { return { kind: 'forecastForPlace', value: place } },
  /** `>afd EWX` — the office's forecast discussion, text subject 1. */
  forecastDiscussion({ office }) { return { kind: 'forecastDiscussion', office } },
  /** `>space` — space weather, text subject 2. */
  spaceWeather: Object.freeze({ kind: 'spaceWeather' }),
  /** `>storm TX` — storm reports, text subject 3. */
  stormReports({ state }) { return { kind: 'stormReports', state } },
  /** `>rain TX` — rainfall totals, text subject 4. */
  rainfall({ state }) { return { kind: 'rainfall', state } },
  /** `>metar KAUS` — the raw METAR, text subject 5. */
  metar({ station }) { return { kind: 'metar', station } },
  /** `>taf KAUS` — the raw TAF, text subject 5. */
  taf({ station }) { return { kind: 'taf', station } },
  /** `>hwo` — the hazardous weather outlook, text subject 6. */
  hazardousOutlook: Object.freeze({ kind: 'hazardousOutlook' }),
  /**
   * `>cov` — what the bot carries, stated by the bot (spec §10, §14). The statement otherwise
   * arrives only on the three-hourly broadcast, so a phone that has just opened the tool cannot
   * tell "outside the area" from "nothing said yet" until one does — and withholds both the
   * check and the out-of-area requests meanwhile (docs/MESHWX_UI.md §6, §11.1).
   */
  coverage: Object.freeze({ kind: 'coverage' }),
  /**
   * `>wmap` / `>wmap all` / `>wmap TXOK` / `>wmap all TXOK` — every area under an alert in the
   * states asked for, as an Area sweep of at most eight packets (spec §12).
   *
   * The most expensive request in the grammar, and the only one whose cost is stated on the
   * button before it is spent (docs/MESHWX_UI.md §17). `includesAdvisories` sends `>wmap all`,
   * which widens the sweep from warnings and watches to advisories as well — more shaded, and
   * more of the eight packets used.
   *
   * `states` is empty for the whole country, as in revision 9. Anything else is up to fifteen
   * two-letter codes: revision 10 added them because the map defaulted to the country however
   * little of it anybody was looking at — "that way we don't default to sending everything"
   * (owner, 20 September 2026). They are always sent compact and upper case, sorted, so the
   * longest selection fits the 40-byte request budget and so two phones asking for the same two
   * states send the same bytes.
   */
  areaSweep({ includesAdvisories, states = [] }) {
    return { kind: 'areaSweep', includesAdvisories, states: WeatherRequest.sweepStates(states) }
  },
  /**
   * `>part 212 1,4,6` — the packets of a multi-packet answer that never arrived (spec §12,
   * revision 10). `group` is the `group` byte of an Area sweep or of a Text reply, and the bot
   * keeps the transmitted bytes of its last eight multi-packet answers for ten minutes under it,
   * so what comes back is the same bytes with a new `seq`.
   *
   * Never automatic and never on a timer: "'4 of 7 parts arrived': should allow me to
   * re-request the missing data" (owner, 20 September 2026) is an offer, and `WeatherPartsOffer`
   * decides when it is on the screen at all.
   *
   * `of` is the `WeatherPartsKind` the group belongs to. The bot's cache is keyed by the group
   * byte alone, across sweeps and texts alike, so the kind never reaches the wire — it is for
   * the log's wording only.
   */
  parts({ group, indexes, of }) {
    return { kind: 'parts', group, indexes: WeatherRequest.partIndexes(indexes), of }
  },
  /**
   * `>f 35.687,-105.938` — the forecast for a coordinate, answered with the nearest point the
   * bot *holds a forecast for* (spec §7, revision 10).
   *
   * The bundle's point list was built from one day's products and has no point at all for nine
   * offices, so the app asked for nothing while the bot held a forecast fifteen kilometres away:
   * "Forecast works in chat (`forecast santa fe nm`) but not in the app. I thought we were using
   * the same engine" (owner, 20 September 2026). This asks the same engine the chat asks.
   */
  forecastAt({ latitude, longitude }) { return { kind: 'forecastAt', latitude, longitude } },
  /**
   * `>radar 30.270,-97.740` / `>radar 30.270,-97.740 z2` — one tile of a radar picture around a
   * coordinate (spec §13, revision 11). One packet, always.
   *
   * The coordinate is written the way `>f <lat>,<lon>` writes one, and the zoom is left off at 0
   * because that is the form the bot's own grammar table leads with: `z0` would be the same
   * request in bytes nobody else sends. The answer is the tile whose *centre* is nearest the
   * coordinate on the fixed lattice (`MeshWXRadarTile.containing`), which is what lets one
   * answer serve everybody in a town rather than one phone each.
   *
   * Request only, and never on a timer: revision 11 ships with no scheduled radar at all.
   */
  radar({ latitude, longitude, zoom = 0 }) { return { kind: 'radar', latitude, longitude, zoom } },
  /**
   * `>radar 30.270,-97.740 loop` / `>radar 30.270,-97.740 z1 loop 2353 2338` — the pictures of
   * the last hour for one tile, oldest first, one packet each (spec §13.5, revision 13).
   *
   * `held` is the `taken` minutes of the frames this phone already holds for that tile
   * (`WeatherRadarLoop.held`), so the bot leaves them out. They go on the wire as UTC `HHMM`,
   * newest first, as many as keep the request within its 40 bytes: a held picture left off the
   * list is sent again, which costs a packet and breaks nothing. Never on a timer, and never
   * played without asking: "Ask for the last hour" is a tap, with its cost stated first.
   */
  radarLoop({ latitude, longitude, zoom = 0, held = [] }) {
    return { kind: 'radarLoop', latitude, longitude, zoom, held: [...held] }
  },

  // MARK: - The scope and the indexes, normalised once
  //
  // Both are lists the caller assembles from a picker or from a hole in an assembly, and both end
  // up in the wire text, in the dictionary key and in the answer slot. Normalising them here is
  // what makes those three agree: two taps that mean the same thing are one request, and the
  // five-minute rule, the pending list and the log all recognise it as one.

  /** Upper case, sorted, no duplicates, nothing blank: the form `>wmap` always sends. */
  sweepStates(states) {
    const seen = new Set()
    for (const state of states ?? []) {
      const code = String(state).trim().toUpperCase()
      if (code.length > 0) seen.add(code)
    }
    return [...seen].sort()
  },

  /**
   * The states a request asks for, read tolerantly.
   *
   * A request persisted before revision 10 — in the request log, in a text assembly, in a
   * settled outcome — has no `states` at all, and an area sweep without one is the national
   * sweep it was when it was written.
   */
  areaSweepStates(request) {
    return request.states ?? []
  },

  /** Ascending, no duplicates: the order a hole in an assembly is read in anyway. */
  partIndexes(indexes) {
    const seen = new Set()
    for (const index of indexes ?? []) seen.add(Number(index))
    return [...seen].sort((lhs, rhs) => lhs - rhs)
  },

  /**
   * `35.687` — the three decimals `>f <lat>,<lon>` sends (spec §7, revision 10).
   *
   * Three decimals is about 110 m, finer than any place this app can name and coarse enough that
   * the same town twice is the same request. Trailing zeros are kept, so the text is a function
   * of the number and not of how it was written.
   */
  coordinateText(value) {
    return Number(value).toFixed(3)
  },

  /** `"35.687,-105.938"` — the coordinate exactly as the wire wrote it, for a dictionary key. */
  coordinateKey({ latitude, longitude }) {
    return `${WeatherRequest.coordinateText(latitude)},${WeatherRequest.coordinateText(longitude)}`
  },

  /** The DM body, exactly as the bot parses it. */
  wireText(request) {
    switch (request.kind) {
      case 'digest': return '>d'
      case 'activeWarnings': return '>w'
      case 'warning': return `>w ${request.identity}`
      case 'warningsTouching': return `>w ${request.ugc}`
      case 'warningText': return `>wt ${request.identity}`
      case 'observations': return '>o'
      case 'observation': return `>o ${request.station}`
      case 'homeForecast': return '>f'
      case 'forecast': return `>f ${request.point}`
      case 'forecastForPlace': return `>f ${request.value}`
      case 'forecastDiscussion': return `>afd ${request.office}`
      case 'spaceWeather': return '>space'
      case 'stormReports': return `>storm ${request.state}`
      case 'rainfall': return `>rain ${request.state}`
      case 'metar': return `>metar ${request.station}`
      case 'taf': return `>taf ${request.station}`
      case 'hazardousOutlook': return '>hwo'
      case 'coverage': return '>cov'
      case 'areaSweep': {
        // `>wmap`, `>wmap all`, `>wmap TXOK`, `>wmap all TXOK`. Compact and upper case: fifteen
        // codes are 30 bytes, and `>wmap all ` is the other 10 of the 40-byte budget (spec §14).
        const states = WeatherRequest.areaSweepStates(request).join('')
        const level = request.includesAdvisories ? '>wmap all' : '>wmap'
        return states.length === 0 ? level : `${level} ${states}`
      }
      case 'parts': return `>part ${request.group} ${WeatherRequest.partIndexes(request.indexes).join(',')}`
      case 'forecastAt':
        return `>f ${WeatherRequest.coordinateText(request.latitude)},${WeatherRequest.coordinateText(request.longitude)}`
      case 'radar':
        return WeatherRequest.radarText(request)
      case 'radarLoop':
        return WeatherRequest.radarLoopText(request)
      default: throw new Error(`WeatherRequest: unknown kind ${request.kind}`)
    }
  },

  /**
   * `>radar <lat>,<lon>` at zoom 0, `… z2` otherwise. Zoom 0 sends nothing after the place: it is
   * the default, and "anything else after the place is part of the place" (spec revision 11,
   * §13). The longest this can be is `>radar -30.270,-197.740 z3`, 26 bytes of the 40-byte
   * request budget (spec §11).
   */
  radarText({ latitude, longitude, zoom = 0 }) {
    const base = `>radar ${WeatherRequest.coordinateKey({ latitude, longitude })}`
    return (zoom ?? 0) > 0 ? `${base} z${zoom}` : base
  },

  /**
   * `>radar 30.270,-97.740 [z<n>] loop [HHMM …]` (spec revision 13, §13.5): the held pictures'
   * UTC hour and minute, **newest first**, as many as fit the 40-byte request and never more than
   * `MeshWXWire.radarLoopHeldMax`. `>radar 30.270,-97.740 loop` is 26 bytes, so two always fit
   * there; a southern, western coordinate at a wider zoom leaves room for one. The newest go
   * first because they are the ones a phone is likeliest to hold; a held picture left off is sent
   * again, which costs a packet and breaks nothing.
   */
  radarLoopText({ latitude, longitude, zoom = 0, held = [] }) {
    let text = `${WeatherRequest.radarText({ latitude, longitude, zoom })} loop`
    const newestFirst = [...new Set((held ?? []).map(Number))].sort((lhs, rhs) => rhs - lhs)
    for (const minutes of newestFirst.slice(0, MeshWXWire.radarLoopHeldMax)) {
      const next = `${text} ${WeatherRequest.utcHourMinute(minutes)}`
      // ASCII throughout, so characters are bytes.
      if (next.length > MeshWXWire.maxRequestTextBytes) break
      text = next
    }
    return text
  },

  /**
   * `"2353"`: a picture's `taken` (Unix minutes) as the loop request writes it, UTC hour and
   * minute. Minutes alone would not do: at 15-minute steps the newest picture and the one an hour
   * before it end in the same two digits.
   */
  utcHourMinute(takenMinutes) {
    const ofDay = ((Math.trunc(takenMinutes) % 1440) + 1440) % 1440
    return `${String(Math.floor(ofDay / 60)).padStart(2, '0')}${String(ofDay % 60).padStart(2, '0')}`
  },

  /**
   * The letter a Not-available reply echoes back (spec §9): the ASCII code of the
   * request's first letter after `>`.
   *
   * `>radar` is the one exception, and it is `x` (spec §13, revision 11). `r` is already
   * `>rain`, and a refusal names no argument: with both sharing a letter, a phone waiting for a
   * radar tile and a phone waiting for rainfall totals would each take the other's refusal.
   */
  requestLetter(request) {
    if (request.kind === 'radar' || request.kind === 'radarLoop') return MeshWXWire.radarRequestLetter
    // `wireText` always starts with `>` followed by a lowercase ASCII letter.
    return WeatherRequest.wireText(request)[1]
  },

  /** What the bot sends back when it can serve the request. */
  expectedReply(request) {
    switch (request.kind) {
      case 'digest': return WeatherReplyKind.digest
      case 'activeWarnings': return WeatherReplyKind.warnings
      case 'warning': return WeatherReplyKind.warning({ identity: request.identity })
      case 'warningsTouching': return WeatherReplyKind.warningsTouching({ ugc: request.ugc })
      case 'warningText': return WeatherReplyKind.text({ subject: WeatherTextSubjectCode.warningNarrative })
      case 'observations': return WeatherReplyKind.observations({ station: null })
      case 'observation': return WeatherReplyKind.observations({ station: request.station })
      case 'homeForecast': return WeatherReplyKind.forecast({ point: null })
      case 'forecast': return WeatherReplyKind.forecast({ point: request.point })
      case 'forecastForPlace': return WeatherReplyKind.forecast({ point: null })
      case 'forecastDiscussion': return WeatherReplyKind.text({ subject: WeatherTextSubjectCode.forecastDiscussion })
      case 'spaceWeather': return WeatherReplyKind.text({ subject: WeatherTextSubjectCode.spaceWeather })
      case 'stormReports': return WeatherReplyKind.text({ subject: WeatherTextSubjectCode.stormReports })
      case 'rainfall': return WeatherReplyKind.text({ subject: WeatherTextSubjectCode.rainfall })
      case 'metar': case 'taf': return WeatherReplyKind.text({ subject: WeatherTextSubjectCode.metarTaf })
      case 'hazardousOutlook': return WeatherReplyKind.text({ subject: WeatherTextSubjectCode.hazardousOutlook })
      case 'coverage': return WeatherReplyKind.coverage
      case 'areaSweep': return WeatherReplyKind.areaSweep
      case 'parts': return WeatherReplyKind.parts({ group: request.group })
      // The bot picks the point, so there is none to check the answer against here: it comes
      // back under a bundled index near the coordinate, or under `0xFFFF`. `WeatherService`
      // measures the distance, which needs the tables this type stays free of.
      case 'forecastAt': return WeatherReplyKind.forecast({ point: null })
      // The tile is worked out here rather than waited for, because the lattice is fixed: the
      // answer to this coordinate is one named square of the earth, whoever sends it. A loop is
      // settled the same way, by its first frame; the rest keep flowing into state.
      case 'radar':
      case 'radarLoop':
        return WeatherReplyKind.radar({
          tile: MeshWXRadarTile.containing({
            latitude: request.latitude, longitude: request.longitude, zoom: request.zoom ?? 0
          })
        })
      default: throw new Error(`WeatherRequest: unknown kind ${request.kind}`)
    }
  },

  /**
   * Whether another bot's message carrying exactly what was asked for settles it.
   *
   * Only the addressed bot answers a DM (spec §20, revision 2), so this is not about who
   * answers: another bot's broadcast, or its answer to somebody else, can carry the very thing
   * asked for — the forecast for point 102, the reading for KAUS, warning SV.W.EWX.42, the
   * discussion for EWX — and then there is nothing left to wait for. What describes one bot's
   * area (the alert list, the coverage batch, the outlook, the home forecast) and a place the
   * bot resolves for itself settle only from the bot asked.
   *
   * A narrative names its event and areas but not its office or tracking number, so only the
   * bot asked can vouch that the text is for the warning asked about. A coverage statement
   * describes the bot that sent it and nothing else. A sweep is one bot's reading of the
   * country — what it carries, and how far its own feed reaches — and a second bot's sweep may
   * be cut somewhere else entirely.
   *
   * Revision 10's two are the same story. `>part` asks one bot to replay bytes out of *its own*
   * cache, keyed by a group byte that means nothing to anybody else. `>f <lat>,<lon>` is a point
   * the bot chooses for itself out of what it holds, so another bot's forecast for a coordinate
   * it happened to be asked about is not this question's answer.
   */
  acceptsAnswerFromAnyBot(request) {
    switch (request.kind) {
      case 'forecast': case 'forecastDiscussion': case 'stormReports': case 'rainfall':
      case 'metar': case 'taf': case 'observation': case 'warning': case 'spaceWeather':
        return true
      // Revision 11's radar is the clearest case of all: the tile is a named square of the
      // earth on a fixed lattice, and two bots cutting it from the same national mosaic are
      // sending the same picture. "Another bot's Radar for the same tile settles it too."
      case 'radar': case 'radarLoop':
        return true
      default:
        return false
    }
  },

  /** Structural equality, which Swift gets from `Hashable`. */
  isEqual(lhs, rhs) {
    if (lhs == null || rhs == null) return lhs === rhs
    return WeatherRequest.key(lhs) === WeatherRequest.key(rhs)
  },

  /** A stable string for using a request as a dictionary key (PORTING.md §3). */
  key(request) {
    switch (request.kind) {
      case 'warning': case 'warningText': return `${request.kind}:${request.identity}`
      case 'warningsTouching': return `${request.kind}:${request.ugc}`
      case 'observation': case 'metar': case 'taf': return `${request.kind}:${request.station}`
      case 'forecast': return `${request.kind}:${request.point}`
      case 'forecastForPlace': return `${request.kind}:${request.value}`
      case 'forecastDiscussion': return `${request.kind}:${request.office}`
      case 'stormReports': case 'rainfall': return `${request.kind}:${request.state}`
      case 'areaSweep':
        // The selection is part of the identity: a sweep of Texas is not the answer to a tap on
        // Oklahoma, and the five-minute rule keys on this.
        return `${request.kind}:${request.includesAdvisories ? 'all' : 'narrow'}:${WeatherRequest.areaSweepStates(request).join('')}`
      case 'parts':
        // Not the kind: the bot's parts cache is keyed by the group byte alone, across sweeps and
        // texts alike (spec §12), so two `>part 212 1` are one request whatever they are called.
        return `${request.kind}:${request.group}:${WeatherRequest.partIndexes(request.indexes).join(',')}`
      case 'forecastAt': return `${request.kind}:${WeatherRequest.coordinateKey(request)}`
      // The coordinate, not the tile: two coordinates on one tile are one *answer*, which is
      // what the service's answer slot is keyed by, but they are two questions — and the
      // pending list, the log and the five-second spacing all key on the question asked.
      case 'radar': return `${request.kind}:${WeatherRequest.coordinateKey(request)}:z${request.zoom ?? 0}`
      // The held list too, as the Swift's synthesised `Hashable` compares it: the same square
      // asked for while holding other pictures is other bytes on the air.
      case 'radarLoop':
        return `${request.kind}:${WeatherRequest.coordinateKey(request)}:z${request.zoom ?? 0}:${(request.held ?? []).join(',')}`
      default: return request.kind
    }
  }
})

/**
 * The answer a request expects, used to pair a pending request with the message that
 * settles it. Where the request names a station, point, warning or area the answer is checked
 * against it; `null` accepts any.
 */
export const WeatherReplyKind = Object.freeze({
  digest: Object.freeze({ kind: 'digest' }),
  /** `>w`: warning messages followed by a digest; either settles. */
  warnings: Object.freeze({ kind: 'warnings' }),
  /** `>w SV.W.EWX.42`: that warning. No digest follows (spec §14). */
  warning({ identity }) { return { kind: 'warning', identity } },
  /** `>w TXC453`: a warning whose area list names that county or zone. No digest follows. */
  warningsTouching({ ugc }) { return { kind: 'warningsTouching', ugc } },
  observations({ station }) { return { kind: 'observations', station } },
  forecast({ point }) { return { kind: 'forecast', point } },
  text({ subject }) { return { kind: 'text', subject } },
  /**
   * `>cov`: the bot's statement of its area. It carries no argument to check it against —
   * a statement is about whichever bot sent it.
   */
  coverage: Object.freeze({ kind: 'coverage' }),
  /**
   * `>wmap`: a packet of the area sweep. The scope asked for is not checked against the answer:
   * a bot that will not widen to advisories answers the narrow sweep, and one that trims the
   * state list still answers the tap — the sweep's own flag and scope say what arrived.
   */
  areaSweep: Object.freeze({ kind: 'areaSweep' }),
  /**
   * `>part <group> <idx>…`: a resent packet of the answer stamped with that group byte, sweep or
   * text alike. The indexes are not here — the group is what identifies the answer, and the
   * service checks the index against the request it is settling (spec §12, revision 10).
   */
  parts({ group }) { return { kind: 'parts', group } },
  /**
   * `>radar <lat>,<lon>`: a Radar message for that `MeshWXRadarTile` (spec §13, revision 11).
   *
   * Checked against the tile and against nothing else. Not the picture's time — "a Radar message
   * for that tile from the bot asked settles the request whatever its `taken`", because a bot
   * with nothing newer than the picture it already sent answers with that one, and a phone that
   * went on waiting for a fresher one would wait for the next quarter of an hour.
   */
  radar({ tile }) { return { kind: 'radar', tile } }
})

/**
 * What a `>part` request is asking for a piece of (spec §12, revision 10).
 *
 * Nothing on the wire carries it: the bot's cache is keyed by the group byte alone. It is here
 * so the request log and the pending bar can say "the alert map" or "the forecast discussion"
 * rather than "group 212", which is the only reason the app remembers what it asked about.
 */
export const WeatherPartsKind = Object.freeze({
  areaSweep: Object.freeze({ kind: 'areaSweep' }),
  /** A Text reply, by its subject (spec §8), so the log can name the product. */
  text({ subject }) { return { kind: 'text', subject } }
})

/**
 * Text subjects on the wire (spec §8), kept as raw codes here so this file needs no
 * table; the decoded message's `subject` is the same number (PORTING.md §5).
 */
export const WeatherTextSubjectCode = Object.freeze({
  warningNarrative: 0,
  forecastDiscussion: 1,
  spaceWeather: 2,
  stormReports: 3,
  rainfall: 4,
  metarTaf: 5,
  hazardousOutlook: 6,
  nowcast: 7,
  general: 8
})
