// Port of MC1Services/Sources/MC1Services/Services/Weather/Screen/WeatherTrafficSummary.swift
//
// One line for one datagram on the channel traffic screen (docs/MESHWX_UI.md §17). The entry and
// the log itself are in `src/weather/` — `WeatherService` writes them and may not import this
// layer — and this is the half that needs the tables and the words.

import {
  MeshWXCancelReason, MeshWXNotAvailableReason, MeshWXRadar, MeshWXTables, MeshWXTextSubject,
  MeshWXWire, decode, hexToBytes,
} from '../meshwx/index.js'
import { t } from '../l10n.js'
import { WeatherTrafficEntry } from '../weather/index.js'
import { WeatherStateList } from './WeatherAreaSelection.js'
import { WeatherNames } from './WeatherNames.js'

/**
 * What a bubble on the traffic timeline says: `{ title, detail }`, `detail` null when there is
 * nothing more to say.
 *
 * "Observations · 13 stations", "Alert map · part 3 of 7 · 38 areas", "Request from 0A1B2C ·
 * `>o KAUS`", "Not available · f · unknown location". The title is *what kind of message it is*
 * and the detail is what this one carries, so a screenful of them scans down the left.
 *
 * Built from the row's own bytes, not from anything held: the screen is the traffic, and a
 * message the app dropped — a duplicate, somebody else's request, a body the codec refuses —
 * has to read the same as one it kept.
 *
 * `stateName` turns a two-letter code into the state's name for a scoped sweep. It is injected
 * because the names are proper nouns the bundle does not carry, and the table that holds them
 * (`WeatherReferenceNames`) is in `src/app`, which this layer may not import (docs/PORTING.md
 * §9). Without it a scoped sweep reads as its codes, which is what the wire says anyway.
 */
export const WeatherTrafficSummary = Object.freeze({
  make({ entry, tables = MeshWXTables.shared, stateName = (code) => code }) {
    if (entry.dataType !== MeshWXWire.dataType) {
      // Another application's datagram on this channel. Its type is all that can honestly be
      // said about it, and saying it is better than a row that reads as broken MeshWX.
      return {
        title: t('weather.traffic.title.otherData'),
        detail: entry.dataType == null ? null : hexType(entry.dataType),
      }
    }
    let message = null
    try { message = decode(hexToBytes(entry.hex)) } catch { message = null }
    if (message == null) return { title: t('weather.traffic.title.unreadable'), detail: null }
    return WeatherTrafficSummary.describe(message, { entry, tables, stateName })
  },

  describe(message, { entry, tables, stateName = (code) => code }) {
    const join = (...parts) => {
      const kept = parts.filter((one) => one != null && one !== '')
      return kept.length === 0 ? null : kept.join(' · ')
    }
    switch (message.name) {
      case 'warning':
        return {
          title: t('weather.traffic.title.warning'),
          detail: join(eventName(message.event, tables), areaCount(runCount(message.areas))),
        }
      case 'cancel':
        return {
          title: t('weather.traffic.title.cancel'),
          detail: join(eventName(message.event, tables), cancelReasonName(message.reason)),
        }
      case 'digest':
        return {
          title: t('weather.traffic.title.digest'),
          detail: message.entries.length === 1
            ? t('weather.traffic.detail.alertsOne')
            : t('weather.traffic.detail.alerts', message.entries.length),
        }
      case 'observations':
        return {
          title: t('weather.traffic.title.observations'),
          detail: message.stations.length === 1
            ? t('weather.traffic.detail.stationsOne')
            : t('weather.traffic.detail.stations', message.stations.length),
        }
      case 'forecast':
        return {
          title: t('weather.traffic.title.forecast'),
          // `0xFFFF` is not a point, it is "the bot picked one this bundle cannot name" (spec §7,
          // §14.3), so the row says *that* rather than naming a sentinel. Anything
          // else is named through `pointLabel`, the one function a bundle name is shown through
          // (docs/MESHWX_UI.md §3.1 U-25) — never the raw table name.
          detail: message.point === MeshWXWire.unbundledPoint
            ? t('weather.traffic.detail.botPoint')
            : pointName(message.point, tables),
        }
      case 'text':
        return {
          title: t('weather.traffic.title.text'),
          detail: join(
            WeatherTrafficSummary.subjectName(message.subject),
            t('weather.traffic.detail.part', message.idx + 1, message.total),
            message.cut === true ? t('weather.traffic.detail.cut') : null,
          ),
        }
      case 'not_available':
        return {
          title: t('weather.traffic.title.notAvailable'),
          // The letter is the grammar's own echo of what was asked (spec §9), and it is the
          // only thing that says *which* request was refused: a refusal names no argument.
          detail: join(message.request, reasonName(message.reason)),
        }
      case 'coverage':
        // The office count and nothing else. A statement's circle, its zone runs and its station
        // cap are the radio page's subject; this row only has to say what went past.
        return {
          title: t('weather.traffic.title.coverage'),
          detail: officeCount(message.offices?.length ?? 0),
        }
      case 'request':
        return {
          title: entry.direction === WeatherTrafficEntry.sent
            ? t('weather.traffic.title.requestSent')
            : t('weather.traffic.title.request', senderName(message.sender)),
          detail: message.text,
        }
      case 'area_sweep':
        // In the packet's own reading order: which packet it is, what it carries, what the sweep
        // covers, and then the two things that say the answer is smaller than it looks.
        return {
          title: t('weather.traffic.title.areaSweep'),
          detail: join(
            t('weather.traffic.detail.part', message.idx + 1, message.total),
            areaCount(runCount(message.entries)),
            scopeName(message, { tables, stateName }),
            message.cut === true ? t('weather.traffic.detail.cut') : null,
            message.advisories === true ? t('weather.traffic.detail.advisories') : null,
          ),
        }
      case 'radar':
        // "Radar picture · Local · 214 cells with precipitation" (docs/MESHWX_UI.md §18.4). The
        // width rather than the tile's corner: a tile is two degrees, which is 222 km tall
        // everywhere and a different width at every latitude, so the corner would be a number
        // nobody can picture and the width is the thing that was asked for. An older frame of a
        // loop (revision 13) reads like any other picture: the row's own time says which it is.
        return {
          title: t('weather.radar.request.title'),
          detail: join(radarWidthName(message.zoom), wetCellCount(MeshWXRadar.wetCells(message))),
        }
      default:
        return { title: t('weather.traffic.title.unreadable'), detail: hexType(entry.dataType) }
    }
  },

  /**
   * **What a text reply is about, in the one set of words the app has for it.**
   *
   * Every subject is named by the key of the screen that shows that report — the same mapping as
   * Swift's `WeatherCopy.textSubjectName`, which `src/app/WeatherCopy.js` calls through to. A
   * subject the traffic log invented its own words for was a subject the reports screen and the
   * traffic screen disagreed about, which is the whole reason revision 10's three
   * `weather.traffic.subject.*` keys are gone.
   *
   * The last three cases share a name on purpose: a nowcast, a general bulletin and a code this
   * build does not know have no screen of their own, so the bare noun is the honest row.
   */
  subjectName(subject) {
    switch (subject) {
      case MeshWXTextSubject.warningNarrative: return t('weather.alertDetail.fullText')
      case MeshWXTextSubject.forecastDiscussion: return t('weather.reports.discussion.title')
      case MeshWXTextSubject.spaceWeather: return t('weather.reports.space.title')
      case MeshWXTextSubject.stormReports: return t('weather.reports.storms.title')
      case MeshWXTextSubject.rainfall: return t('weather.reports.rainfall.title')
      case MeshWXTextSubject.metarOrTAF: return t('weather.station.airportReports')
      case MeshWXTextSubject.hazardousOutlook: return t('weather.reports.outlook.title')
      default: return t('weather.heard.text')
    }
  },
})

function runCount(runs) {
  if (runs == null) return 0
  let total = 0
  for (const run of runs) total += run.run ?? 1
  return total
}

function areaCount(count) {
  if (count <= 0) return null
  return count === 1 ? t('weather.traffic.detail.areasOne') : t('weather.traffic.detail.areas', count)
}

/**
 * How wide the tile is, in the three words the radar screen's own control uses (docs/MESHWX_UI.md §18.2):
 * Local, Regional, Wide for zooms 0, 1 and 2. Zoom 3 exists on the wire and is not offered, so a
 * tile at that width is left unnamed rather than given a fourth word nothing else says.
 */
function radarWidthName(zoom) {
  switch (zoom) {
    case 0: return t('weather.radar.width.local')
    case 1: return t('weather.radar.width.regional')
    case 2: return t('weather.radar.width.wide')
    default: return null
  }
}

function wetCellCount(count) {
  if (count <= 0) return null
  return count === 1 ? t('weather.radar.traffic.cellsOne') : t('weather.radar.traffic.cells', count)
}

function officeCount(count) {
  if (count <= 0) return null
  return count === 1 ? t('weather.traffic.detail.officesOne') : t('weather.traffic.detail.offices', count)
}

/**
 * Why an alert ended, when the bytes name a reason this build knows. A nibble it does not is left
 * to the bytes rather than turned into a claim: the bubble then says only that an alert ended.
 */
function cancelReasonName(reason) {
  switch (reason) {
    case MeshWXCancelReason.cancelled: return t('weather.traffic.cancelReason.cancelled')
    case MeshWXCancelReason.expiredEarly: return t('weather.traffic.cancelReason.expiredEarly')
    case MeshWXCancelReason.upgraded: return t('weather.traffic.cancelReason.upgraded')
    default: return null
  }
}

function eventName(event, tables) {
  return tables?.eventLabel?.({ for: event }) ?? String(event)
}

/** "Austin Camp Mabry, TX", or the number for a point this bundle has no name for. */
function pointName(point, tables) {
  const found = tables?.point?.({ at: point })
  return found == null ? String(point) : WeatherNames.pointLabel(found.name)
}

/**
 * What the sweep this packet belongs to covers: the whole country, the states its scope names,
 * or — for a scoped packet that is not the one the scope rides on — that these bytes do not say.
 *
 * "No states" must not read as "nothing". The entries in packets 1… of a scoped sweep are real
 * and are drawn; which states were asked for is simply not in them (spec §12).
 *
 * In the packet's own order, unsorted: this row is a reading of the bytes, not of a selection.
 */
function scopeName(message, { tables, stateName }) {
  if (message.scoped !== true) return t('weather.traffic.detail.national')
  const states = tables?.states ?? []
  const codes = (message.scope ?? []).map((index) => states[index]).filter((one) => one != null)
  if (codes.length === 0) return t('weather.traffic.detail.scopedUnknown')
  return WeatherStateList.of(codes.map((code) => stateName(code)))
}

function reasonName(reason) {
  switch (reason) {
    case MeshWXNotAvailableReason.noData: return t('weather.traffic.reason.noData')
    case MeshWXNotAvailableReason.unknownLocation: return t('weather.traffic.reason.unknownLocation')
    case MeshWXNotAvailableReason.unsupported: return t('weather.traffic.reason.unsupported')
    case MeshWXNotAvailableReason.botError: return t('weather.traffic.reason.botError')
    case MeshWXNotAvailableReason.rateLimited: return t('weather.traffic.reason.rateLimited')
    default: return t('weather.traffic.reason.other')
  }
}

/** The six hex characters a phone is known by on the channel, as the bot's own logs print them. */
function senderName(sender) {
  return String(sender ?? '').slice(0, 6).toUpperCase()
}

function hexType(dataType) {
  if (dataType == null) return null
  return `0x${dataType.toString(16).toUpperCase().padStart(4, '0')}`
}
