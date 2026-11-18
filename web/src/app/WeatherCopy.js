// Port of MC1/Views/Tools/Weather/WeatherCopy.swift (docs/PORTING.md).

import { t } from '../l10n.js'
import {
  MeshWXCompass,
  MeshWXDataSource,
  MeshWXGeo,
  MeshWXNotAvailableReason,
  MeshWXRadarLevel,
  MeshWXRadarTile,
  MeshWXTables,
  MeshWXTextSubject,
  MeshWXWarning,
} from '../meshwx/index.js'
import {
  WeatherAlertItem,
  WeatherAlertRequests,
  WeatherForecastCard,
  WeatherNames,
  WeatherRadarRefusal,
  WeatherRadarSummary,
  WeatherTrafficSummary,
  WeatherUpdatePlan,
} from '../screen/index.js'
import { WeatherRequest } from '../weather/index.js'
import { WeatherFormatting } from './WeatherFormatting.js'
import { WeatherReferenceNames } from './WeatherReferenceNames.js'

/** Where the screen stands on finding a place, for the header and the empty cards. */
export const WeatherPlaceState = Object.freeze({
  resolved: 'resolved',
  /** Waiting for a fix: up to five seconds on arrival, or after "Back to my location". */
  locating: 'locating',
  /** Location permission never asked: only "Use my location" may ask. */
  needsPermission: 'needsPermission',
  denied: 'denied',
  /** Authorized, and no fix came. */
  unavailable: 'unavailable',
})

/** What an answer did to what the phone holds, for the confirmation under its button. */
export const WeatherAnswerNoteKind = Object.freeze({
  forecast: 'forecast',
  readings: 'readings',
  other: 'other',
})

/** `{ kind: 'changed' }` or `{ kind: 'unchanged', value: WeatherAnswerNoteKind }`. */
export const WeatherAnswerNote = Object.freeze({
  Kind: WeatherAnswerNoteKind,

  changed: Object.freeze({ kind: 'changed' }),
  unchanged(value) {
    return { kind: 'unchanged', value }
  },
})

/** What the alert status line says, and the one thing it offers: `{ text, action, caption }`. */
export const WeatherAlertStatusLineAction = Object.freeze({
  askForAlerts: 'askForAlerts',
  updateLocation: 'updateLocation',
})

export const WeatherAlertStatusLine = Object.freeze({
  Action: WeatherAlertStatusLineAction,

  make({ text, action = null, caption = null }) {
    return { text, action, caption }
  },
})

/**
 * The sentences the Weather screen is built from (docs/MESHWX_UI.md §7.4, §10, §11), each a
 * pure function of the snapshot's values.
 *
 * Swift's trailing `calendar:`/`locale:` pair is `timeZone` (an IANA id) and `locale` here
 * (docs/PORTING.md); both may be left out, and the runtime's own are used.
 */
export const WeatherCopy = Object.freeze({
  AlertStatusLine: WeatherAlertStatusLine,

  // MARK: - Banners (§10)

  banner(banner) {
    switch (banner.kind) {
      case 'firmwareTooOld':
        return t('weather.banner.firmware', WeatherFormatting.firmwareVersion(banner.version))
      case 'channelMissing':
        return t('weather.banner.channelMissing')
      case 'noBotHeard':
        return t('weather.banner.noBot')
      default:
        return ''
    }
  },

  // MARK: - Alert status line (§7.4)

  alertStatus(status, { source, place = null, areaName = null, now, timeZone, locale }) {
    const time = (date) => WeatherFormatting.clockTime(date, { now, timeZone, locale })
    const placeName = place == null ? '' : WeatherFormatting.placeName(place.label)
    const sourceStart = WeatherFormatting.sentenceStart(source)
    const line = (text, options) => WeatherAlertStatusLine.make({ text, ...options })

    switch (status.kind) {
      case 'noPlace':
        return line(t('weather.alertStatus.noPlace'))
      case 'outOfCoverage':
        return line(t('weather.alertStatus.outOfCoverage', placeName, source))
      case 'notChecked':
        return line(t('weather.alertStatus.notChecked', source), {
          action: WeatherAlertStatusLineAction.askForAlerts,
        })
      case 'feedNeverReceived':
        return line(t('weather.alertStatus.feedNone', sourceStart))
      case 'radioOffline':
        return line(t('weather.alertStatus.radioOffline', time(status.listAsOf)), {
          caption: WeatherCopy.requestBlocked('radioOffline', { source }),
        })
      case 'missedMessages':
        return line(t('weather.alertStatus.missedMessages', source), {
          action: WeatherAlertStatusLineAction.askForAlerts,
        })
      case 'listOld':
        return line(t('weather.alertStatus.listOld', time(status.asOf)), {
          action: WeatherAlertStatusLineAction.askForAlerts,
        })
      case 'locationOld':
        return line(t('weather.alertStatus.locationOld', WeatherFormatting.age(status.since, { now })), {
          action: WeatherAlertStatusLineAction.updateLocation,
        })
      case 'coverageUnknown':
        return line(t('weather.alertStatus.coverageUnknown', sourceStart))
      case 'officeMayNotBeCovered':
        return line(
          t(
            'weather.alertStatus.officeNotCovered',
            sourceStart,
            areaName ?? placeName,
            WeatherReferenceNames.officeName(status.office),
          ),
        )
      case 'rowsSpeak':
        return null
      case 'feedQuiet':
        return line(
          t(
            'weather.alertStatus.feedQuiet',
            sourceStart,
            WeatherFormatting.quietDuration({ minutes: status.minutesSinceProduct }),
          ),
        )
      case 'noneHere':
      case 'clear':
        // Nothing is said on a quiet day: no green check, no "none for your location", no status
        // line at all. Silence is still not calm — but the owner put that honesty in the radio row
        // and on the radio page, and a line here would be the reassurance he took out.
        return null
      default:
        return null
    }
  },

  // MARK: - Alert rows (§7.3)

  /** The one line under an alert's name that says where it is or what became of it. */
  alertQualifier(item, { placeName = null, now }) {
    switch (item.kind.kind) {
      case 'upgradedAwaitingReplacement':
        return t('weather.alerts.upgraded')
      case 'expiredRecently':
        return t(
          'weather.alerts.expired',
          WeatherFormatting.duration({ seconds: (now - WeatherAlertItem.expiresAt(item)) / 1000 }),
        )
      default:
        break
    }
    switch (item.placement.kind) {
      case 'near':
        return WeatherFormatting.distance(item.placement.kilometres, { direction: item.placement.direction })
      case 'checking':
        return t('weather.alerts.checking')
      case 'unplaced':
        return placeName == null ? null : t('weather.coverage.unknown', placeName)
      default:
        return null
    }
  },

  /**
   * Where an alert away from the place is: "Llano County · 105 km W" — its first named area,
   * and the distance and direction from the place to the alert's centre. Only the area with no
   * place.
   */
  alertLocation(warning, { place = null, tables = MeshWXTables.shared }) {
    const areas = tables.namedAreas({ for: warning })
    const areaName = areas.length > 0 ? WeatherFormatting.shortAreaName(areas[0]) : null
    const polygon = MeshWXWarning.polygonCoordinates(warning)
    const centre =
      polygon != null && polygon.length >= 3
        ? WeatherCopy.centre(polygon)
        : WeatherCopy.centre(
            areas
              .filter((area) => area.lat != null && area.lon != null)
              .map((area) => ({ latitude: area.lat, longitude: area.lon })),
          )
    let distance = null
    if (place != null && centre != null) {
      const kilometres = MeshWXGeo.distanceKilometres({
        fromLat: place.coordinate.latitude,
        fromLon: place.coordinate.longitude,
        toLat: centre.latitude,
        toLon: centre.longitude,
      })
      distance = WeatherFormatting.distance(kilometres, {
        direction: WeatherFormatting.direction({ from: place.coordinate, to: centre }),
      })
    }
    if (areaName != null && distance != null) return t('weather.alerts.areaDistance', areaName, distance)
    if (areaName != null) return areaName
    return distance
  },

  centre(coordinates) {
    if (coordinates == null || coordinates.length === 0) return null
    const latitude = coordinates.reduce((total, one) => total + one.latitude, 0) / coordinates.length
    const longitude = coordinates.reduce((total, one) => total + one.longitude, 0) / coordinates.length
    return { latitude, longitude }
  },

  /** "Covers Austin" / "Doesn't cover Austin (25 km N)" / "Not sure it covers Austin". */
  coversLine(placement, { placeName }) {
    switch (placement.kind) {
      case 'here':
        return t('weather.coverage.covers', placeName)
      case 'near':
        return t(
          'weather.coverage.near',
          placeName,
          WeatherFormatting.distance(placement.kilometres, { direction: placement.direction }),
        )
      case 'elsewhere':
        return t('weather.coverage.doesNotCover', placeName)
      case 'checking':
        return t('weather.coverage.checking', placeName)
      default:
        return t('weather.coverage.unknown', placeName)
    }
  },

  // MARK: - Requests (§11)

  requestBlocked(block, { source }) {
    switch (block) {
      case 'radioOffline': return t('weather.request.blocked.offline', source)
      case 'firmwareTooOld': return t('weather.request.blocked.firmware')
      case 'channelMissing': return t('weather.request.blocked.channel')
      case 'noBot': return t('weather.request.blocked.noBot')
      case 'botNotAnnounced': return t('weather.request.blocked.notAnnounced')
      default: return t('weather.request.blocked.noBot')
    }
  },

  /**
   * What a button shows for a request's status, or null when the button speaks for itself.
   *
   * - `request`: what was asked, for naming the content time of an answer already received.
   * - `answer`: for an answered request, whether it changed what the phone holds.
   */
  requestStatus(status, { source, request = null, answer = null, now, timeZone, locale }) {
    const time = (date) => WeatherFormatting.clockTime(date, { now, timeZone, locale })
    const sourceStart = WeatherFormatting.sentenceStart(source)
    switch (status.kind) {
      case 'idle':
        return null
      case 'blocked':
        return WeatherCopy.requestBlocked(status.value, { source })
      case 'pending':
        // Attempt 0 on the route, 1 the same again, 2 by flood after the route was forgotten
        // (`WeatherService.floodAttempt`).
        if (status.attempt === 0) return t('weather.request.pending', source)
        if (status.attempt === 1) return t('weather.request.retrying')
        return t('weather.request.flooding')
      case 'waitingForOther':
        return t('weather.request.waiting')
      case 'settled':
        break
      default:
        return null
    }

    const outcome = status.value
    const at = status.at
    switch (outcome.kind) {
      case 'answered':
        if (answer?.kind === 'unchanged') {
          switch (answer.value) {
            case WeatherAnswerNoteKind.forecast: return t('weather.request.noNewerForecast', source)
            case WeatherAnswerNoteKind.readings: return t('weather.request.noNewerReadings', source)
            default: return t('weather.request.answeredNothingNew', sourceStart, time(at))
          }
        }
        return t('weather.request.answeredAt', sourceStart, time(at))
      case 'alreadyReceived': {
        // Receipt says how fresh the copy is; the content time says how fresh the weather is.
        const received = t('weather.request.received', WeatherFormatting.ago(outcome.receivedAt, { now }))
        if (outcome.contentAsOf == null) return received
        const content = WeatherCopy.heldContent(request, { time: time(outcome.contentAsOf) })
        if (content == null) return received
        return t('weather.request.receivedContent', received, content)
      }
      case 'timedOut':
        // The bot's radio confirmed the request, so range is not why no answer came.
        if (outcome.botRadioReceived) return t('weather.request.receivedNoAnswer', sourceStart, time(at))
        return outcome.botWasHeard
          ? t('weather.request.heardNoAnswer', sourceStart, time(at))
          : t('weather.request.noAnswer', time(at), source)
      case 'notAvailable':
        // Radar says which of the four refusals it is in its own words: "no recent picture for
        // this area" and "this bot has no dish at all" ask the reader to do entirely different
        // things, and one "not available" would leave them tapping for ever (docs/MESHWX_UI.md §18.3).
        if (request?.kind === 'radar' || request?.kind === 'radarLoop') {
          return WeatherCopy.radarRefusal(
            WeatherRadarRefusal.make({ reason: outcome.value }), { source: sourceStart },
          )
        }
        // The map's own rate limit is not the radio being busy and is certainly not an error:
        // the sweep is the one answer the whole channel shares, so a refusal means somebody else
        // has just spent those eight packets and this phone is about to be handed the same map
        // (docs/MESHWX_UI.md §17).
        if (outcome.value === MeshWXNotAvailableReason.rateLimited && request?.kind === 'areaSweep') {
          return t('weather.areaMap.busy', source)
        }
        return WeatherCopy.notAvailable(outcome.value, { source: sourceStart })
      case 'failed':
        return t('weather.request.failed', time(at))
      default:
        return null
    }
  },

  /**
   * The wire's reason code, worded. Swift's `MeshWXNotAvailableReason` has an `.other` case; the
   * JS enum keeps the raw byte, so anything outside the five defined codes is `.other`.
   */
  notAvailable(reason, { source }) {
    switch (reason) {
      case MeshWXNotAvailableReason.noData: return t('weather.request.notAvailable.noData', source)
      case MeshWXNotAvailableReason.unknownLocation: return t('weather.request.notAvailable.unknownPlace', source)
      case MeshWXNotAvailableReason.unsupported: return t('weather.request.notAvailable.unsupported', source)
      case MeshWXNotAvailableReason.botError: return t('weather.request.notAvailable.error', source)
      case MeshWXNotAvailableReason.rateLimited: return t('weather.request.notAvailable.busy', source)
      default: return t('weather.request.notAvailable.other', source)
    }
  },

  quietCaption({ source, since, now, timeZone, locale }) {
    return t(
      'weather.request.quiet',
      WeatherFormatting.sentenceStart(source),
      WeatherFormatting.clockTime(since, { now, timeZone, locale }),
    )
  },

  // MARK: - Radar (docs/MESHWX_UI.md §18)

  /**
   * The three widths the radar screen offers, by zoom. Never kilometres: a tile is two degrees,
   * which is 222 km tall everywhere and a different width at every latitude. Zoom 3 exists on the
   * wire and is not offered, so it has no name here rather than a fourth word nothing else says.
   */
  radarWidthName(zoom) {
    switch (zoom) {
      case 0: return t('weather.radar.width.local')
      case 1: return t('weather.radar.width.regional')
      case 2: return t('weather.radar.width.wide')
      default: return null
    }
  },

  /**
   * The tile's centre, in the same three decimals a request is written in — a square of earth
   * has no name, and its middle is the one thing about it a reader can place on a map.
   *
   * The centre and not the south-west corner, because the centre is the point the lattice put
   * the tile around. It is what a cached row and a row of what the channel carried name a tile
   * by: nothing on the wire says who asked for one.
   */
  radarCentre(tile) {
    const half = MeshWXRadarTile.spanDegrees(tile) / 2
    return WeatherRequest.coordinateKey({
      latitude: tile.south + half, longitude: tile.west + half,
    })
  },

  /**
   * "Cut from the Southern Plains mosaic." — which of the fourteen pictures this square came out
   * of. Null for a product index this bundle does not know: a newer radio, not a bad packet, and
   * losing the mosaic's name must not lose the picture.
   */
  radarMosaic(product, { tables = MeshWXTables.shared } = {}) {
    const name = tables.radarProductName({ at: product })
    return name == null ? null : t('weather.radar.mosaic', name)
  },

  /**
   * What the picture says about the place, as the sentences the card and the screen print in
   * order (docs/MESHWX_UI.md §18.3).
   *
   * Three shapes and no fourth:
   *
   * - The picture does not reach the place: that, and **nothing else**. There is a `nearest` in
   *   the summary and it is measured from a place the picture has no reading for, so naming it
   *   would dress a guess up as a measurement — the true nearest echo could be in the part the
   *   mosaic never covered.
   * - Nothing wet anywhere on the tile: one sentence about the picture.
   * - Otherwise what is overhead, then the nearest echo when the place itself is dry, then a
   *   separate heavy core when there is one. The pure layer has already dropped that last one
   *   when it is the cell `nearest` names or when the place is under heavy precipitation.
   */
  radarSummary(summary, { placeName }) {
    const name = placeName ?? ''
    if (summary.here == null) return [t('weather.radar.here.outside', name)]
    if (WeatherRadarSummary.isAllDry(summary)) return [t('weather.radar.none')]

    const lines = []
    switch (summary.here) {
      case MeshWXRadarLevel.light: lines.push(t('weather.radar.here.light', name)); break
      case MeshWXRadarLevel.moderate: lines.push(t('weather.radar.here.moderate', name)); break
      case MeshWXRadarLevel.heavy: lines.push(t('weather.radar.here.heavy', name)); break
      default:
        lines.push(t('weather.radar.here.dry', name))
        if (summary.nearest != null) {
          lines.push(t('weather.radar.nearest', ...WeatherCopy.radarReach(summary.nearest)))
        }
        break
    }
    if (summary.nearestHeavy != null) {
      lines.push(t('weather.radar.nearestHeavy', ...WeatherCopy.radarReach(summary.nearestHeavy)))
    }
    return lines
  },

  /**
   * The two arguments a reach sentence takes: how far, and which way.
   *
   * The tool's own distance formatter and the wire's own compass abbreviation, so a radar
   * sentence reads in the same units and the same letters as every other distance in the app
   * (docs/MESHWX_UI.md §18.3: no second copy of either).
   */
  radarReach(reach) {
    return [
      WeatherFormatting.kilometres(reach.kilometres),
      MeshWXCompass.abbreviation(reach.bearing),
    ]
  },

  /**
   * "Picture from 6:38 PM · 12 min old", and from 30 minutes "· Precipitation has moved since."
   *
   * The age is the **picture's** own, measured from the time printed on it and never from when
   * the packet arrived: a tile drained from the radio's queue an hour late is an hour older than
   * it looks. Under a minute the age is left off rather than shown as "0 s old", which reads as
   * a stopwatch and not as a picture.
   */
  radarTime(picture, { now, timeZone, locale }) {
    const takenAt = picture.stored.radar.taken_min * 60_000
    const parts = [t('weather.radar.time', WeatherFormatting.clockTime(takenAt, { now, timeZone, locale }))]
    if (picture.age.minutes >= 1) {
      parts.push(t('weather.time.old', WeatherFormatting.duration({ seconds: picture.age.minutes * 60 })))
    }
    // The caution the tone alone cannot carry: half an hour is two mosaics, and a reader looking
    // at where a storm was two mosaics ago has to be told that is what they are looking at.
    if (picture.age.isOld) parts.push(t('weather.radar.moved'))
    return parts.join(' · ')
  },

  /**
   * "6:08 PM · 2 of 5" (revision 13): a frame of a loop, by its own time and its place in the
   * loop. Shown in place of the time line while the loop plays or rests on an older frame; the
   * summary sentences go on describing the newest picture.
   */
  radarFrameLine(stored, { index, count, now, timeZone, locale }) {
    const takenAt = stored.radar.taken_min * 60_000
    return t('weather.radar.loop.frame', WeatherFormatting.clockTime(takenAt, { now, timeZone, locale }), index, count)
  },

  /**
   * "Up to 5 packets": what "Ask for the last hour" may spend. "Up to", because the pictures this
   * phone lists as held are left out and an hour may have fewer than five.
   */
  radarLoopCost(packets) {
    return t('weather.radar.loop.cost', packets)
  },

  /** Why the bot would not send a tile, in the ask's own status line (docs/MESHWX_UI.md §18.3). */
  radarRefusal(refusal, { source }) {
    switch (refusal.kind) {
      case 'noPicture': return t('weather.radar.refused.noPicture', source)
      case 'unsupported': return t('weather.radar.refused.unsupported', source)
      case 'sentRecently': return t('weather.radar.refused.recent', source)
      // The forecast's sentence, unchanged: the app sends a coordinate, so a bot that could not
      // place it did not recognise the place, which is the same fact and the same words.
      case 'unknownPlace': return t('weather.request.notAvailable.unknownPlace', source)
      default: return WeatherCopy.notAvailable(refusal.value, { source })
    }
  },

  // MARK: - Forecast (§9)

  rowLabel(label, { timeZone, locale } = {}) {
    const weekday = (date) => weekdayFormatter(locale, timeZone).format(date)
    switch (label.kind) {
      case 'today': return t('weather.forecast.label.today')
      case 'tonight': return t('weather.forecast.label.tonight')
      case 'tomorrow': return t('weather.forecast.label.tomorrow')
      case 'tomorrowNight': return t('weather.forecast.label.tomorrowNight')
      case 'day': return weekday(label.value)
      case 'night': return t('weather.forecast.label.night', weekday(label.value))
      default: return ''
    }
  },

  /** "70% rain tonight" for a paired row whose night carries the rain chance; "30% rain" otherwise. */
  rainChance(row) {
    const pop = row.popPercent
    if (pop == null || !(pop > 0)) return null
    return row.popIsNight && row.highF != null
      ? t('weather.forecast.rainTonight', Math.trunc(pop))
      : t('weather.forecast.rain', Math.trunc(pop))
  },

  /** "Storms · Windy": every hazard flag the row carries. */
  hazards(row) {
    const words = []
    if (row.thunder) words.push(t('weather.forecast.hazard.thunder'))
    if (row.wintry) words.push(t('weather.forecast.hazard.wintry'))
    if (row.windy) words.push(t('weather.forecast.hazard.windy'))
    if (row.fog) words.push(t('weather.forecast.hazard.fog'))
    return words.length === 0 ? null : words.join(' · ')
  },

  /** "102° / 77°", or the one temperature the row carries, labelled. */
  temperatures({ highF = null, lowF = null, locale }) {
    const degrees = (value) => WeatherFormatting.temperature({ fahrenheit: value, locale })
    if (highF != null && lowF != null) return t('weather.forecast.highLow', degrees(highF), degrees(lowF))
    if (highF != null) return t('weather.forecast.high', degrees(highF))
    if (lowF != null) return t('weather.forecast.low', degrees(lowF))
    return null
  },

  /**
   * "No forecast for Austin yet."; with the point more than 10 km off, "No forecast for Big
   * Spring yet. The nearest forecast point is Midland, 60 km."
   */
  forecastMissing({ placeName, point, kilometres }) {
    // Revision 10: with no bundled point in reach there is still a forecast to ask for — the bot
    // picks the point. There is nothing to name, so the card says only that it has none yet.
    if (point == null || !(kilometres > WeatherForecastCard.nearbyPointKilometres)) {
      return t('weather.forecast.missing', placeName)
    }
    return t(
      'weather.forecast.missingFar',
      placeName,
      WeatherNames.pointLabel(point.name),
      WeatherFormatting.kilometres(kilometres),
    )
  },

  /**
   * "Forecast point chosen by WX-AUS", under a forecast the bot picked the point for: there is
   * no bundled point to name, so what the header can honestly say is where it came from.
   */
  forecastPointChosenByBot({ source }) {
    return t('weather.forecast.chosenByBot', source)
  },

  // MARK: - Where the data came from (§12.1)

  /**
   * "Via GOES satellite", "Via internet", "Via GOES and internet" — and **null**
   * when the radio did not say (spec §2.2, revision 7).
   *
   * Null rather than a phrase, because a bot older than revision 7 has made no claim and a screen
   * that filled the silence with one would be inventing provenance. A page fed by such a bot
   * looks exactly as it did.
   */
  dataSource(source) {
    switch (source) {
      case MeshWXDataSource.goesSatellite: return t('weather.source.goes')
      case MeshWXDataSource.internet: return t('weather.source.internet')
      case MeshWXDataSource.mixed: return t('weather.source.mixed')
      default: return null
    }
  },

  /**
   * The last line of a text reply's card: where the product came from, and whether the bot had to
   * drop its tail. Null when it would say neither.
   *
   * The cut is worth its own sentence rather than a marker in the body: a hole in the text is a
   * chunk the air ate and asking again may fill it, while this is the whole reply that bot will
   * ever send for that request (spec §8, revision 7).
   */
  reportFootnote({ source, wasCut }) {
    const parts = [WeatherCopy.dataSource(source), wasCut ? t('weather.reports.cut') : null].filter(
      (one) => one != null,
    )
    return parts.length === 0 ? null : parts.join(' · ')
  },

  // MARK: - Answers already held (§11)

  /**
   * "Ask for Tornado Warning" when the tap asks for one warning by identity, "Ask for alerts"
   * otherwise.
   */
  askAlertsTitle({ for: request, tables = MeshWXTables.shared }) {
    if (request.kind !== 'warning') return t('weather.request.askAlerts')
    const parsed = WeatherAlertRequests.identity({ from: request.identity, tables })
    if (parsed == null) return t('weather.request.askAlerts')
    return t('weather.request.askWarning', WeatherFormatting.eventName(parsed.event, { tables }))
  },

  /**
   * "list as of 3:02 PM", "readings as of 1:13 AM", "issued 7:52 PM": what an answer already
   * received was as of, in the words for what was asked.
   */
  heldContent(request, { time }) {
    if (request == null) return null
    switch (request.kind) {
      case 'digest':
      case 'activeWarnings':
      case 'warning':
      case 'warningsTouching':
        return t('weather.request.contentList', time)
      case 'observations':
      case 'observation':
        return t('weather.request.contentReadings', time)
      case 'forecast':
      case 'forecastForPlace':
      case 'forecastAt':
      case 'homeForecast':
        return t('weather.request.contentIssued', time)
      default:
        return null
    }
  },

  /** "WX-AUS answered at 1:32 AM", in place of a button whose answer this phone already holds. */
  ownedReply({ source, at, now, timeZone, locale }) {
    return t(
      'weather.request.answeredAt',
      WeatherFormatting.sentenceStart(source),
      WeatherFormatting.clockTime(at, { now, timeZone, locale }),
    )
  },

  // MARK: - Update (§11)

  /**
   * "Asking WX-AUS for: alert list, readings" — every tap says what it will spend airtime on
   * before it spends it.
   */
  updateAsks(plan, { source }) {
    return t('weather.update.asks', source, WeatherUpdatePlan.items(plan).map(WeatherCopy.itemName).join(', '))
  },

  itemName(item) {
    switch (item) {
      case 'alerts': return t('weather.update.item.alerts')
      case 'areaAlerts': return t('weather.update.item.areaAlerts')
      case 'readings': return t('weather.update.item.readings')
      case 'forecast': return t('weather.update.item.forecast')
      case 'coverage': return t('weather.update.item.coverage')
      default: return item
    }
  },

  /**
   * "Everything is current · WX-AUS 4:25 PM": true as of the oldest of the things the plan
   * checked, on the bot's clock.
   */
  everythingCurrent({ source, asOf = null, now, timeZone, locale }) {
    if (asOf == null) return t('weather.update.currentUnknown')
    return t('weather.update.current', source, WeatherFormatting.clockTime(asOf, { now, timeZone, locale }))
  },

  /**
   * Nothing to ask for because the channel just delivered it — which is not the same as
   * everything being current (spec §19).
   */
  updateJustReceived({ source }) {
    return t('weather.update.justReceived', WeatherFormatting.sentenceStart(source))
  },

  // MARK: - Now (§8)

  /**
   * "in WX-AUS's 9:40 AM report" — which message a reading arrived in, and nothing else.
   *
   * The station screen already carries the station's name as its headline and its distance from
   * the place on its own line, so `stationSource` said both of them a second and third time
   * ("Austin-Bergstrom International Airport · under 1 km N · in …'s 9:40 AM report", above
   * "under 1 km N from Austin"). This is the part that is not said anywhere else.
   */
  stationReport({ botName, reportedAt, now, timeZone, locale }) {
    return t('weather.now.report', botName, WeatherFormatting.clockTime(reportedAt, { now, timeZone, locale }))
  },

  /** "No weather station near Dallas. Nearest: Temple, 190 km." */
  noStationNearby({ placeName, nearestTown, kilometres = null }) {
    if (kilometres == null) return t('weather.now.noneNearbyUnknown', placeName, nearestTown)
    return t('weather.now.noneNearby', placeName, nearestTown, WeatherFormatting.kilometres(kilometres))
  },

  /**
   * The one line under the temperature: "Camp Mabry · 6 km · as of 8:24 PM" (docs/MESHWX_UI.md
   * §8). The station, how far it is, and when it read — and nothing else on the page unless it
   * is tapped. The radio that carried it is named by the radio row, once, at the foot.
   *
   * With no station name — a reading the block already attributes above its number (§3.1 U-2a)
   * — it is the time alone: "As of 6:56 AM".
   *
   * A stale reading — over two hours old, shown until twelve rather than replaced by "No current
   * conditions" (owner decision 2026-10-16) — ends with its age: "Camp Mabry · 6 km · as of
   * 2:24 PM · 5 h old". The clock time alone reads as recent at a glance; the age cannot.
   */
  conditionsSource({ stationName = null, kilometres = null, observedAt, now, timeZone, locale, isStale = false }) {
    const asOf = t('weather.stations.asOf', WeatherFormatting.clockTime(observedAt, { now, timeZone, locale }))
    const parts = [asOf]
    if (isStale) parts.push(WeatherFormatting.age(observedAt, { now }))
    if (stationName == null) return WeatherFormatting.sentenceStart(parts.join(' · '))
    if (kilometres != null) parts.unshift(WeatherFormatting.kilometres(kilometres))
    return [stationName, ...parts].join(' · ')
  },

  /**
   * A fresh reading too far off to be the weather here, shown anyway under its station: "Nearest
   * report: San Marcos, 26 km away" (docs/MESHWX_UI.md §3.1 U-2a). It sits above the number, so
   * the number is never read as the town's.
   */
  nearbyReadingLead({ stationName, kilometres = null }) {
    if (kilometres == null) return t('weather.now.nearbyReadingUnknown', stationName)
    return t('weather.now.nearbyReading', stationName, WeatherFormatting.kilometres(kilometres))
  },

  /**
   * No reading good enough to be the weather here: the ask, and the station a refresh would
   * spend airtime on — "No current conditions for Llano. Pull down to ask WX-AUS for KAQO."
   *
   * With something blocking every request, the sentence **stops offering the pull**: the gesture
   * cannot send anything, and telling someone to pull while a disconnected radio makes it inert
   * is the app describing a screen it does not have (docs/MESHWX_UI.md §3.1 U-6). It names the
   * station and leaves it there; the reason is already at the top of the list.
   */
  conditionsAsk({ placeName, source, icao, block = null }) {
    if (block != null) return t('weather.conditions.askBlocked', placeName, icao)
    return t('weather.conditions.ask', placeName, source, icao)
  },

  // MARK: - A place with nothing held (§3.1 U-13)

  /** "No weather for Llano yet." */
  emptyPlaceTitle({ placeName }) {
    return t('weather.empty.title', placeName)
  },

  /**
   * What is nearest, in one line: "Nearest station Burnet Municipal Cradock Field Airport, 18 km
   * · Nearest forecast point Burnet Airport, 43 km". Null when neither is in reach — then the
   * action line says so instead.
   *
   * **Both halves name their subject.** The sentence used to code the station and name the point
   * — "Nearest station TJIG, 1 km · Nearest forecast point Luis Munoz Marin International
   * Airport-San Juan, 12 km" — so one clause was for a pilot and the other for a reader
   * (docs/MESHWX_UI.md §3.1 U-27). The airport code is on the station's own screen, which this
   * card's Update opens onto.
   */
  emptyPlaceNearest(empty, { tables = MeshWXTables.shared } = {}) {
    const parts = []
    if (empty.stationICAO != null) {
      const found = tables.station({ icao: empty.stationICAO })
      const station = found == null ? empty.stationICAO : WeatherNames.stationName(found.name)
      parts.push(
        empty.stationKilometres == null
          ? t('weather.empty.stationOnly', station)
          : t('weather.empty.station', station, WeatherFormatting.kilometres(empty.stationKilometres)),
      )
    }
    if (empty.pointName != null) {
      const point = WeatherNames.pointLabel(empty.pointName)
      parts.push(
        empty.pointKilometres == null
          ? t('weather.empty.pointOnly', point)
          : t('weather.empty.point', point, WeatherFormatting.kilometres(empty.pointKilometres)),
      )
    }
    return parts.length === 0 ? null : parts.join(' · ')
  },

  /**
   * The one thing to do about it: ask, or — with nothing in reach to ask about — that there is
   * nothing to ask for.
   *
   * Null when nothing can be asked at all. **The reason is said once on the page** and this is
   * not where: the caption at the top, or the banner when there is one, already carries it, and
   * this card printed a third copy of "Your radio's firmware can't ask for weather" two lines
   * under the second (docs/MESHWX_UI.md §3.1 U-24).
   */
  emptyPlaceAction(empty, { placeName, source, block = null }) {
    if (block != null) return null
    if (empty.stationICAO == null && empty.pointName == null) return t('weather.empty.nothing', placeName)
    return t('weather.empty.ask', source)
  },

  /**
   * "14 stations in WX-AUS's area", or "3 weather stations" when none came in the bot's batch.
   * The link names every row the screen it opens will show: with single-station answers held on
   * top of the batch, "19 weather stations, 14 in WX-AUS's area" — the area count alone promised
   * 14 rows and opened 19.
   */
  stationLink({ inArea, total, source }) {
    if (!(inArea > 0)) {
      return total === 1 ? t('weather.now.stationsOne') : t('weather.now.stations', total)
    }
    if (!(total > inArea)) {
      return inArea === 1
        ? t('weather.now.stationsInAreaOne', source)
        : t('weather.now.stationsInArea', inArea, source)
    }
    return t('weather.now.stationsWithArea', total, inArea, source)
  },

  // MARK: - The radio row (§10)

  /**
   * "WX-AUS · heard 2 min ago · alerts as of 8:02 PM", the row at the foot of every place page.
   * It is the only thing on the page that mentions the alert list, and it never leaves the list
   * out: with none held it says so rather than saying nothing.
   */
  radioRow(row, { source, now, timeZone, locale }) {
    const parts = [source]
    if (row.heardAt != null) {
      parts.push(t('weather.about.heard', WeatherFormatting.ago(row.heardAt, { now })))
    } else {
      parts.push(t('weather.about.notHeard'))
    }
    if (row.listBuiltAt != null) {
      parts.push(
        t('weather.radioRow.alertsAsOf', WeatherFormatting.clockTime(row.listBuiltAt, { now, timeZone, locale })),
      )
    } else {
      parts.push(t('weather.radioRow.noAlertList'))
    }
    return parts.join(' · ')
  },

  // MARK: - Places rows (§12)

  /**
   * "86° Cloudy", and "—" when the place's own page would show no temperature either
   * (docs/MESHWX_UI.md §12, §3.1 U-2). The row and the page ask the same question of the same
   * reading, so they can never disagree about the same town one tap apart.
   */
  placeRow(reading, { now, locale } = {}) {
    if (reading.observedAt == null) return t('weather.picker.noReading')
    const parts = []
    if (reading.tempF != null) {
      parts.push(WeatherFormatting.temperature({ fahrenheit: reading.tempF, locale }))
    }
    if (reading.sky != null) {
      const condition = WeatherFormatting.condition(reading.sky)
      if (condition != null) parts.push(condition)
    }
    let head = parts.join(' ')
    // Shown under its station on the page, so under its station here (§3.1 U-2a).
    if (reading.attributedStation != null && head.length > 0) head += ` · ${reading.attributedStation}`
    if (!reading.isStale) return head.length === 0 ? t('weather.picker.noReading') : head
    const age = WeatherFormatting.age(reading.observedAt, { now })
    return head.length === 0 ? age : `${head} · ${age}`
  },

  // MARK: - The weather radio's page (§12)

  /**
   * What a request asked for, in a few words: for the log of this phone's own requests, and for
   * the rows of what the channel carried. It names what was asked for and never who asked.
   */
  requestName(request, { tables = MeshWXTables.shared } = {}) {
    const withSubject = (name, subject) => t('weather.requestName.withSubject', name, subject)
    switch (request.kind) {
      case 'digest':
        return t('weather.requestName.alertList')
      case 'activeWarnings':
        return t('weather.requestName.activeWarnings')
      case 'warning':
        return WeatherCopy.warningName(request.identity, { tables })
      case 'warningsTouching':
        return t('weather.requestName.areaWarnings', request.ugc)
      case 'warningText':
        return t('weather.requestName.warningText', WeatherCopy.warningName(request.identity, { tables }))
      case 'observations':
        return t('weather.requestName.readings')
      case 'observation':
        return t('weather.requestName.stationReading', request.station)
      case 'homeForecast':
        return t('weather.forecast.titleGeneric')
      case 'forecast':
        return t(
          'weather.requestName.forecast',
          WeatherCopy.pointName(request.point, { tables }) ?? String(request.point),
        )
      case 'forecastForPlace':
        return t('weather.requestName.forecast', request.value)
      case 'forecastDiscussion':
        return withSubject(t('weather.reports.discussion.title'), WeatherReferenceNames.officeName(request.office))
      case 'spaceWeather':
        return t('weather.reports.space.title')
      case 'stormReports':
        return withSubject(t('weather.reports.storms.title'), WeatherReferenceNames.stateName(request.state))
      case 'rainfall':
        return withSubject(t('weather.reports.rainfall.title'), WeatherReferenceNames.stateName(request.state))
      case 'metar':
        return withSubject(t('weather.requestName.metar'), request.station)
      case 'taf':
        return withSubject(t('weather.requestName.taf'), request.station)
      case 'hazardousOutlook':
        return t('weather.reports.outlook.title')
      case 'coverage':
        return t('weather.requestName.coverage')
      case 'areaSweep': {
        // Revision 10: the map can cover a few states, and the log has to say which — "Alert
        // map" twice over, once for Texas and once for the country, is a list nobody can read.
        const states = WeatherRequest.areaSweepStates(request)
        if (states.length === 0) {
          return request.includesAdvisories
            ? t('weather.requestName.areaMapAll')
            : t('weather.requestName.areaMap')
        }
        // Normalised in the row as on the wire, and named the one way a set of states is named:
        // two selections of the same states have to be one row in the log.
        const named = WeatherReferenceNames.stateList(states)
        return request.includesAdvisories
          ? t('weather.requestName.areaMapStatesAll', named)
          : t('weather.requestName.areaMapStates', named)
      }
      case 'parts': {
        const of = WeatherCopy.partsKindName(request.of, { tables })
        return of == null ? t('weather.requestName.partsGeneric') : t('weather.requestName.parts', of)
      }
      case 'forecastAt':
        return t(
          'weather.requestName.forecastAt',
          WeatherRequest.coordinateKey(request),
        )
      // The coordinate asked about, which is the only name this square has here: the tile comes
      // back from the lattice and no place on this phone is claimed to be inside it.
      case 'radar':
        return withSubject(t('weather.radar.request.title'), WeatherRequest.coordinateKey(request))
      // "Radar, last hour · 30.270,-97.740" (revision 13): the same coordinate, and a name that
      // says this ask is for up to five packets rather than one.
      case 'radarLoop':
        return withSubject(t('weather.radar.loop.request.title'), WeatherRequest.coordinateKey(request))
      default:
        return ''
    }
  },

  /**
   * What a `>part` is a piece of, for the log's wording. The kind never reaches the wire — the
   * bot's cache is keyed by the group byte alone (spec §12) — so this is the only place the app
   * remembers what it asked about.
   */
  partsKindName(kind, { tables = MeshWXTables.shared } = {}) {
    void tables
    if (kind == null) return null
    // The map's own name, not the log's name for a request for one: "Missing parts of National
    // alert map" claims a country the `>part` says nothing about (docs/MESHWX_UI.md §12).
    if (kind.kind === 'areaSweep') return t('weather.areaMap.title')
    // A subject code this build does not know has no name to put in the sentence, and "Missing
    // parts of Weather Service text" claims one. The bare noun is the honest row.
    if (!(Number(kind.subject) <= MeshWXTextSubject.general)) return null
    return WeatherCopy.textSubjectName(kind.subject)
  },

  /**
   * "Tornado Warning" for an identity the tables can read; the identity itself when a newer bot
   * names an event this bundle does not have.
   */
  warningName(identity, { tables }) {
    const parsed = WeatherAlertRequests.identity({ from: identity, tables })
    if (parsed == null) return identity
    return WeatherFormatting.eventName(parsed.event, { tables })
  },

  pointName(point, { tables }) {
    const found = tables.point({ at: point })
    return found == null ? null : WeatherNames.pointLabel(found.name)
  },

  /**
   * How one of this phone's requests ended (§12). Four outcomes; which reason the bot gave, and
   * whether its radio confirmed the request, stay under the button that sent it (§11.2).
   */
  requestOutcome(outcome) {
    switch (outcome) {
      case 'answered': return t('weather.requests.answered')
      case 'noAnswer': return t('weather.requests.noAnswer')
      case 'notAvailable': return t('weather.requests.notAvailable')
      case 'refused': return t('weather.requests.refused')
      default: return t('weather.requests.pending')
    }
  },

  /**
   * What one thing on the channel was, in words. A name for the row, never a claim about who
   * asked for it.
   */
  channelSubject(subject, { tables = MeshWXTables.shared } = {}) {
    switch (subject.kind) {
      case 'alertList':
        return t('weather.requestName.alertList')
      case 'warning':
        return WeatherFormatting.eventName(subject.value.event, { tables })
      case 'readings':
        return subject.stations === 1
          ? t('weather.heard.readingsOne')
          : t('weather.heard.readings', subject.stations)
      case 'reading': {
        const station = tables.station({ at: subject.station })
        return station == null ? t('weather.requestName.readings') : WeatherNames.stationName(station.name)
      }
      case 'forecast': {
        // A forecast the bot resolved from a place string has no bundled point, and the request
        // that fetched it is the only name it has (spec §7).
        const name =
          WeatherCopy.pointName(subject.point, { tables }) ?? subject.label ?? String(subject.point)
        return t('weather.requestName.forecast', name)
      }
      case 'text':
        // A chunk carries only its subject: with no request of this phone's behind it, the subject
        // is all the row can say.
        return subject.request != null
          ? WeatherCopy.requestName(subject.request, { tables })
          : WeatherCopy.textSubjectName(subject.subject)
      case 'coverage':
        return t('weather.requestName.coverage')
      // "Radar picture · Local · 30.000,-98.000": the picture, its width and the square it is
      // of, because that is all a held tile is. Who asked for it is not something this phone can
      // know, and the lattice means several people may have. Since revision 13 a square can hold
      // the frames of its last hour, one row still, and "· 5 pictures" when it holds more than one.
      case 'radar':
        return [
          t('weather.radar.request.title'),
          WeatherCopy.radarWidthName(subject.tile.zoom),
          WeatherCopy.radarCentre(subject.tile),
          (subject.frames ?? 1) > 1 ? t('weather.radar.cached.frames', subject.frames) : null,
        ].filter((one) => one != null).join(' · ')
      default:
        return ''
    }
  },

  /**
   * What a text reply is about. One mapping, kept in the pure layer because the channel traffic
   * log names the same nine subjects and cannot reach this one (docs/PORTING.md §9) — and a
   * screen that named a subject its own way is exactly what the traffic log used to do.
   */
  textSubjectName(subject) {
    return WeatherTrafficSummary.subjectName(subject)
  },

  /**
   * "as of 1:13 AM · received 1:14 AM": the content's own time on the bot's clock and when this
   * phone got it. A message that carries no time of its own says only the second (§2).
   */
  channelTimes({ contentAt = null, receivedAt, now, timeZone, locale }) {
    const time = (date) => WeatherFormatting.clockTime(date, { now, timeZone, locale })
    const received = t('weather.reports.received', time(receivedAt))
    if (contentAt == null) return received
    return `${t('weather.stations.asOf', time(contentAt))} · ${received}`
  },

  // MARK: - Web only (§16)
  //
  // Two sentences iOS does not have, because a phone's promise is not a tab's. They live in
  // `strings/web.en.json` under `web.` (docs/PORTING.md §6).

  /**
   * What the notifications screen promises, in place of iOS's `weather.notifications.promise`.
   * A browser only notifies while the page is open: the radio link, the weather service and the
   * alert evaluator are all in the page, so closing the tab ends all three.
   */
  notificationsPromise() {
    return t('web.notifications.promise')
  },

  /** The short form, under a bell. */
  notificationsPageOnly() {
    return t('web.notifications.pageOnly')
  },

  /**
   * Why a bell cannot ring at all, or null when it can be turned on. Takes the authorization
   * `src/platform/notifications.js` reports.
   */
  notificationsUnavailable(authorization) {
    if (authorization === 'denied') return t('web.notifications.denied')
    if (authorization === 'unsupported') return t('web.notifications.unsupported')
    return null
  },

  cacheGroup(group) {
    switch (group) {
      case 'readings': return t('weather.requestName.readings')
      case 'forecasts': return t('weather.cache.forecasts')
      case 'airportReports': return t('weather.cache.airportReports')
      case 'warningNarratives': return t('weather.cache.narratives')
      case 'warningsElsewhere': return t('weather.cache.warningsElsewhere')
      case 'radarPictures': return t('weather.radar.cached.title')
      default: return group
    }
  },
})

const weekdayFormatters = new Map()

function weekdayFormatter(locale, timeZone) {
  const key = `${locale ?? ''}|${timeZone ?? ''}`
  let formatter = weekdayFormatters.get(key)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone })
    weekdayFormatters.set(key, formatter)
  }
  return formatter
}
