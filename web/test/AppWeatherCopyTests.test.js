// Port of MC1Tests/Views/Tools/Weather/WeatherCopyTests.swift (docs/PORTING.md).
//
// The sentences of docs/MESHWX_UI.md §7.4, §10 and §11, as the implementation reviews worded them.
//
// Seven of the Swift suite's cases are not here: they test `WeatherAreaMapCopy`,
// `WeatherAreaMapScope`, `WeatherAreaMapList` and `WeatherAreaMapDrawing`, which live in
// `WeatherAreaMapView.swift` and so belong to `src/ui` (docs/PORTING.md §2). The two that also
// exercise `WeatherCopy` — a refused sweep, and the sweep's name in the request log — are here.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MeshWXCompass, MeshWXDataSource, MeshWXNotAvailableReason } from '../src/meshwx/index.js'
import { t } from '../src/l10n.js'
import { WeatherPartsKind, WeatherRequest, WeatherRequestOutcome } from '../src/weather/index.js'
import {
  WeatherAlertFolding,
  WeatherRadarAge,
  WeatherAlertItems,
  WeatherAlertPlacement,
  WeatherAlertStatus,
  WeatherAreaGeometry,
  WeatherForecastRowLabel,
  WeatherPlaceRowReading,
  WeatherRequestStatus,
  WeatherScreenBanner,
  WeatherStateList,
} from '../src/screen/index.js'
import {
  WeatherAnswerNote, WeatherCopy, WeatherFormatting, WeatherReferenceNames,
} from '../src/app/index.js'
import * as F from './helpers/app-fixture.js'

const tables = await F.loadTables()
await F.loadGeometry()
const geometry = WeatherAreaGeometry.shared()

function status(one, { place = F.austin, area = null, source = 'WX-AUS' } = {}) {
  const line = WeatherCopy.alertStatus(one, {
    source,
    place,
    areaName: area,
    now: F.now,
    timeZone: F.timeZone,
    locale: F.locale,
  })
  return line == null ? null : { ...line, text: F.plain(line.text) }
}

function request(one, { for: asked = null, answer = null, source = 'WX-AUS' } = {}) {
  return F.plain(
    WeatherCopy.requestStatus(one, {
      source,
      request: asked,
      answer,
      now: F.now,
      timeZone: F.timeZone,
      locale: F.locale,
    }),
  )
}

const settled = (outcome, at) => WeatherRequestStatus.settled(outcome, { at })

describe('Weather copy', () => {
  // MARK: - Alert status line (§7.4)

  it('no place and out of coverage say what cannot be known', () => {
    assert.equal(
      status(WeatherAlertStatus.noPlace, { place: null })?.text,
      'Choose a place to see which alerts cover it',
    )
    assert.equal(
      status(WeatherAlertStatus.outOfCoverage, { place: F.dallas })?.text,
      "Dallas, TX is outside WX-AUS's area, so alerts there are unknown.",
    )
  })

  it('no alert list yet says the phone cannot tell, and offers to ask', () => {
    const line = status(WeatherAlertStatus.notChecked)
    assert.equal(
      line?.text,
      "This phone hasn't received WX-AUS's alert list yet, so it can't tell whether any alerts are active. The list comes every 3 hours.",
    )
    assert.equal(line?.action, 'askForAlerts')
  })

  it('a quiet home office says it may be normal, never that alerts may not arrive, and has no button', () => {
    const line = status(WeatherAlertStatus.feedQuiet({ minutesSinceProduct: 300 }))
    assert.equal(
      line?.text,
      "WX-AUS hasn't had anything from its home Weather Service office for 5 h. That's normal on a quiet night, but its feed could also be down.",
    )
    assert.equal(line?.action, null)
  })

  it('a feed that never delivered says new alerts may not reach you, with no button', () => {
    const line = status(WeatherAlertStatus.feedNeverReceived)
    assert.equal(
      line?.text,
      "WX-AUS hasn't received anything from the Weather Service. New alerts may not reach you.",
    )
    assert.equal(line?.action, null)
  })

  it('an unknown area says the station report has not come, with no button', () => {
    const line = status(WeatherAlertStatus.coverageUnknown)
    assert.equal(
      line?.text,
      "WX-AUS hasn't sent its station report yet, so the area it covers isn't known. It comes about every hour.",
    )
    assert.equal(line?.action, null)
    assert.ok(
      status(WeatherAlertStatus.coverageUnknown, { source: 'the weather radio' })?.text.startsWith(
        "The weather radio hasn't",
      ),
    )
  })

  it('a generic source is capitalised where it starts a sentence', () => {
    assert.equal(
      status(WeatherAlertStatus.feedNeverReceived, { source: 'the weather radio' })?.text,
      "The weather radio hasn't received anything from the Weather Service. New alerts may not reach you.",
    )
  })

  it('offline says your radio is not connected and names the list time', () => {
    const line = status(WeatherAlertStatus.radioOffline({ listAsOf: F.elevenOhTwo }))
    assert.equal(line?.text, "Your radio isn't connected. Last alert list as of 11:02 PM.")
    assert.equal(line?.caption, 'Connect your radio to ask WX-AUS')
  })

  it('missed messages and an old list ask for alerts', () => {
    assert.equal(
      status(WeatherAlertStatus.missedMessages)?.text,
      'This phone missed messages from WX-AUS. Some alerts may be missing.',
    )
    assert.equal(status(WeatherAlertStatus.missedMessages)?.action, 'askForAlerts')
    assert.equal(
      status(WeatherAlertStatus.listOld({ asOf: F.eightOhTwo }))?.text,
      'Last alert list as of 8:02 PM.',
    )
    assert.equal(status(WeatherAlertStatus.listOld({ asOf: F.eightOhTwo }))?.action, 'askForAlerts')
  })

  it('an old location offers to update it', () => {
    const line = status(WeatherAlertStatus.locationOld({ since: F.now - 3 * 3600 * 1000 }))
    assert.equal(line?.text, 'Your location is 3 h old.')
    assert.equal(line?.action, 'updateLocation')
  })

  it('an office the radio has not shown names the county and office', () => {
    assert.equal(
      status(WeatherAlertStatus.officeMayNotBeCovered({ office: 'FWD' }), { area: 'Bell County' })?.text,
      'WX-AUS may not carry alerts for Bell County (NWS Fort Worth).',
    )
    assert.equal(
      status(WeatherAlertStatus.officeMayNotBeCovered({ office: 'FWD' }))?.text,
      'WX-AUS may not carry alerts for Austin, TX (NWS Fort Worth).',
    )
  })

  it('rows speak for themselves', () => {
    assert.equal(status(WeatherAlertStatus.rowsSpeak), null)
  })

  // Answer 13: nothing about alerts on a quiet day. No check, no "none for your location", no
  // status line — the honesty moved to the radio row and the radio page.
  it('a quiet day says nothing at all', () => {
    assert.equal(status(WeatherAlertStatus.noneHere({ elsewhere: 2, asOf: F.elevenOhTwo })), null)
    assert.equal(
      status(WeatherAlertStatus.noneHere({ elsewhere: 2, asOf: F.elevenOhTwo }), { place: F.roundRock }),
      null,
    )
    assert.equal(status(WeatherAlertStatus.clear({ asOf: F.elevenOhTwo })), null)
  })

  // MARK: - Request status (§11)

  it('idle says nothing and blocks replace the button', () => {
    assert.equal(request(WeatherRequestStatus.idle), null)
    assert.equal(request(WeatherRequestStatus.blocked('radioOffline')), 'Connect your radio to ask WX-AUS')
    assert.equal(
      request(WeatherRequestStatus.blocked('botNotAnnounced')),
      "Can't ask until it announces itself",
    )
    assert.equal(
      request(WeatherRequestStatus.blocked('firmwareTooOld')),
      "Your radio's firmware can't ask for weather",
    )
    assert.equal(request(WeatherRequestStatus.blocked('channelMissing')), 'Add #meshwx to your radio to ask')
    assert.notEqual(request(WeatherRequestStatus.blocked('noBot')), null)
  })

  it('pending, retrying, flooding and waiting', () => {
    // No duration in the pending line: a channel request settles within 20 s, the DM fallback
    // within 45 s, and one number would be wrong for the other.
    assert.equal(request(WeatherRequestStatus.pending({ attempt: 0, sentAt: F.now })), 'Asking WX-AUS…')
    assert.equal(request(WeatherRequestStatus.pending({ attempt: 1, sentAt: F.now })), 'Asking again…')
    // The DM ladder's third send, after the route was forgotten.
    assert.equal(request(WeatherRequestStatus.pending({ attempt: 2, sentAt: F.now })), 'Asking again by flood…')
    assert.equal(request(WeatherRequestStatus.waitingForOther), 'Waiting for another answer…')
  })

  it('every answer confirms, and one that changed nothing says so', () => {
    const at = F.now - 60_000
    assert.equal(request(settled(WeatherRequestOutcome.answered, at)), 'WX-AUS answered at 11:19 PM')
    assert.equal(
      request(settled(WeatherRequestOutcome.answered, at), { answer: WeatherAnswerNote.changed }),
      'WX-AUS answered at 11:19 PM',
    )
    assert.equal(
      request(settled(WeatherRequestOutcome.answered, at), { answer: WeatherAnswerNote.unchanged('other') }),
      'WX-AUS answered at 11:19 PM · nothing new',
    )
  })

  it('an unchanged forecast or reading never reads as up to date', () => {
    const at = F.now
    assert.equal(
      request(settled(WeatherRequestOutcome.answered, at), { answer: WeatherAnswerNote.unchanged('forecast') }),
      'No newer forecast from WX-AUS',
    )
    assert.equal(
      request(settled(WeatherRequestOutcome.answered, at), { answer: WeatherAnswerNote.unchanged('readings') }),
      'No newer readings from WX-AUS',
    )
  })

  it('an answer the channel already delivered names its age and what it was as of', () => {
    const receivedAt = F.now - 40_000
    const already = (contentAsOf) =>
      settled(WeatherRequestOutcome.alreadyReceived({ receivedAt, contentAsOf }), F.now)
    assert.equal(request(already(null), { for: WeatherRequest.spaceWeather }), 'Received 40 s ago')
    assert.equal(
      request(already(F.elevenOhTwo), { for: WeatherRequest.digest }),
      'Received 40 s ago · list as of 11:02 PM',
    )
    assert.equal(
      request(already(F.elevenOhTwo), { for: WeatherRequest.activeWarnings }),
      'Received 40 s ago · list as of 11:02 PM',
    )
    assert.equal(
      request(already(F.elevenOhTwo), { for: WeatherRequest.observations }),
      'Received 40 s ago · readings as of 11:02 PM',
    )
    assert.equal(
      request(already(F.eightOhTwo), { for: WeatherRequest.forecast({ point: 103 }) }),
      'Received 40 s ago · issued 8:02 PM',
    )
    assert.equal(
      request(already(F.eightOhTwo), { for: WeatherRequest.metar({ station: 'KAUS' }) }),
      'Received 40 s ago',
    )
  })

  it('an answer this phone already holds stands in for its button', () => {
    assert.equal(
      F.plain(
        WeatherCopy.ownedReply({
          source: 'WX-AUS',
          at: F.elevenOhTwo,
          now: F.now,
          timeZone: F.timeZone,
          locale: F.locale,
        }),
      ),
      'WX-AUS answered at 11:02 PM',
    )
  })

  // Out of range, one request per sender every five seconds, and 60 answers an hour all end in
  // silence (spec §9): the copy allows for all three.
  it('timeouts allow for range and a busy radio, and name the time', () => {
    const at = F.now + 6 * 60 * 1000
    assert.equal(
      request(settled(WeatherRequestOutcome.timedOut({ botWasHeard: false }), at)),
      'No answer at 11:26 PM. WX-AUS may be out of range or busy.',
    )
    assert.equal(
      request(settled(WeatherRequestOutcome.timedOut({ botWasHeard: true }), at)),
      "WX-AUS was heard but didn't answer at 11:26 PM. It may be busy.",
    )
  })

  // The bot's radio confirmed the request, so the copy leaves out range: the bot may be busy, or
  // its answer was lost. Unconfirmed keeps "may be out of range or busy".
  it("a timeout the bot's radio confirmed says the request arrived", () => {
    const at = F.now + 6 * 60 * 1000
    const received =
      'WX-AUS received the request, but no answer reached this phone by 11:26 PM. It may be busy, or its answer was lost.'
    assert.equal(
      request(settled(WeatherRequestOutcome.timedOut({ botWasHeard: false, botRadioReceived: true }), at)),
      received,
    )
    assert.equal(
      request(settled(WeatherRequestOutcome.timedOut({ botWasHeard: true, botRadioReceived: true }), at)),
      received,
    )
    assert.equal(
      request(settled(WeatherRequestOutcome.timedOut({ botWasHeard: false, botRadioReceived: false }), at)),
      'No answer at 11:26 PM. WX-AUS may be out of range or busy.',
    )
  })

  it('an ask for one missing warning names it', () => {
    assert.equal(
      WeatherCopy.askAlertsTitle({ for: WeatherRequest.warning({ identity: 'TO.W.EWX.30' }), tables }),
      'Ask for Tornado Warning',
    )
    assert.equal(WeatherCopy.askAlertsTitle({ for: WeatherRequest.digest, tables }), 'Ask for alerts')
    assert.equal(
      WeatherCopy.askAlertsTitle({ for: WeatherRequest.warningsTouching({ ugc: 'TXC453' }), tables }),
      'Ask for alerts',
    )
  })

  it('refusals name the radio and a failed send names your radio', () => {
    const notAvailable = (reason) => settled(WeatherRequestOutcome.notAvailable(reason), F.now)
    assert.equal(
      request(notAvailable(MeshWXNotAvailableReason.noData)),
      'WX-AUS has no data for that yet',
    )
    assert.equal(
      request(notAvailable(MeshWXNotAvailableReason.unknownLocation)),
      "WX-AUS didn't recognize that place",
    )
    assert.equal(request(notAvailable(MeshWXNotAvailableReason.unsupported)), "WX-AUS can't do that")
    assert.equal(request(notAvailable(MeshWXNotAvailableReason.botError)), 'WX-AUS had an error')
    assert.equal(
      request(notAvailable(MeshWXNotAvailableReason.rateLimited)),
      'WX-AUS is busy, try again in a few minutes',
    )
    assert.equal(
      request(notAvailable(MeshWXNotAvailableReason.noData), { source: 'the weather radio' }),
      'The weather radio has no data for that yet',
    )
    assert.equal(
      request(settled(WeatherRequestOutcome.failed('disconnected'), F.now)),
      "Your radio couldn't send this at 11:20 PM.",
    )
  })

  it('a quiet radio caption names when it was last heard', () => {
    assert.equal(
      F.plain(
        WeatherCopy.quietCaption({
          source: 'WX-AUS',
          since: F.eightOhTwo,
          now: F.now,
          timeZone: F.timeZone,
          locale: F.locale,
        }),
      ),
      'WX-AUS not heard since 8:02 PM — it may not answer',
    )
  })

  // MARK: - The radio row (§10)

  const radioRow = (row, source = 'WX-AUS') =>
    F.plain(WeatherCopy.radioRow(row, { source, now: F.now, timeZone: F.timeZone, locale: F.locale }))

  it('the radio row names the radio, when it was heard, and how old the list is', () => {
    assert.equal(
      radioRow({
        heardAt: F.now - 120_000,
        listBuiltAt: F.eightOhTwo,
        missedMessages: false,
        listIsOld: false,
      }),
      'WX-AUS · heard 2 min ago · alerts as of 8:02 PM',
    )
  })

  // The row never leaves the alert list out: with none held it says so, because the page above
  // it now says nothing about alerts at all.
  it('no list and nothing heard are both said, not left out', () => {
    assert.equal(
      radioRow({ heardAt: null, listBuiltAt: null, missedMessages: false, listIsOld: true }),
      'WX-AUS · not heard yet · no alert list yet',
    )
  })

  // MARK: - The temperature block (§8)

  it("the one line under the temperature is the station, the distance and the reading's own time", () => {
    assert.equal(
      F.plain(
        WeatherCopy.conditionsSource({
          stationName: 'Austin-Camp Mabry',
          kilometres: 6.2,
          observedAt: F.now - 2 * 60 * 1000,
          now: F.now,
          timeZone: F.timeZone,
          locale: F.locale,
        }),
      ),
      'Austin-Camp Mabry · 6 km · as of 11:18 PM',
    )
    // No place, no distance: the time still stands, because the reading has one of its own.
    assert.equal(
      F.plain(
        WeatherCopy.conditionsSource({
          stationName: 'Llano Municipal Airport',
          kilometres: null,
          observedAt: F.now - 2 * 60 * 1000,
          now: F.now,
          timeZone: F.timeZone,
          locale: F.locale,
        }),
      ),
      'Llano Municipal Airport · as of 11:18 PM',
    )
  })

  // From 25 to 40 km the reading is shown, but under its station: the station and distance lead,
  // above the number, and the line at the foot keeps only the time (§3.1 U-2a).
  it('a reading from 25 to 40 km names its station above the number and its time below', () => {
    assert.equal(
      F.plain(WeatherCopy.nearbyReadingLead({ stationName: 'San Marcos', kilometres: 25.51 })),
      'Nearest report: San Marcos, 26 km away',
    )
    assert.equal(
      F.plain(WeatherCopy.nearbyReadingLead({ stationName: 'San Marcos', kilometres: null })),
      'Nearest report: San Marcos',
    )
    assert.equal(
      F.plain(
        WeatherCopy.conditionsSource({
          stationName: null,
          kilometres: null,
          observedAt: F.now - 2 * 60 * 1000,
          now: F.now,
          timeZone: F.timeZone,
          locale: F.locale,
        }),
      ),
      'As of 11:18 PM',
    )
  })

  // Owner decision 2026-10-16: a reading two to twelve hours old is shown rather than replaced by
  // "No current conditions", and the foot line ends with its age so it never passes for current.
  it('a stale reading says how old it is at the end of the line under the temperature', () => {
    const observedAt = F.now - (5 * 60 + 2) * 60 * 1000
    const line = (options) => F.plain(WeatherCopy.conditionsSource({
      observedAt, now: F.now, timeZone: F.timeZone, locale: F.locale, ...options,
    }))
    assert.equal(
      line({ stationName: 'Austin-Camp Mabry', kilometres: 6.2, isStale: true }),
      'Austin-Camp Mabry · 6 km · as of 6:18 PM · 5 h old',
    )
    assert.equal(line({ stationName: null, kilometres: null, isStale: true }), 'As of 6:18 PM · 5 h old')
    // A current reading's line is unchanged.
    assert.equal(line({ stationName: 'Austin-Camp Mabry', kilometres: 6.2 }), 'Austin-Camp Mabry · 6 km · as of 6:18 PM')
  })

  // No good reading means no temperature at all — only the ask, and the code it would spend
  // airtime on (answer 11).
  it("no good reading names the place, the radio and the station's code", () => {
    assert.equal(
      WeatherCopy.conditionsAsk({ placeName: 'Llano', source: 'WX-AUS', icao: 'KAQO' }),
      'No current conditions for Llano. Pull down to ask WX-AUS for KAQO.',
    )
  })

  // MARK: - Places rows (§12)

  it('a places row is the temperature and the condition, aged when stale and a dash when empty', () => {
    const fresh = WeatherPlaceRowReading.make({
      tempF: 86,
      sky: 3,
      observedAt: F.now - 12 * 60 * 1000,
      isStale: false,
    })
    assert.equal(F.plain(WeatherCopy.placeRow(fresh, { now: F.now, locale: F.locale })), '86° Mostly cloudy')

    const stale = { ...fresh, observedAt: F.now - 3 * 3600 * 1000, isStale: true }
    assert.equal(
      F.plain(WeatherCopy.placeRow(stale, { now: F.now, locale: F.locale })),
      '86° Mostly cloudy · 3 h old',
    )

    assert.equal(WeatherCopy.placeRow(WeatherPlaceRowReading.make({}), { now: F.now, locale: F.locale }), '—')

    // From 25 to 40 km the page names the station, so the row does too.
    const attributed = { ...fresh, attributedStation: 'San Marcos' }
    assert.equal(
      F.plain(WeatherCopy.placeRow(attributed, { now: F.now, locale: F.locale })),
      '86° Mostly cloudy · San Marcos',
    )
  })

  it('banners speak of your radio', () => {
    assert.equal(
      WeatherCopy.banner(WeatherScreenBanner.firmwareTooOld({ version: 'v1.14.0' })),
      'Your radio has firmware 1.14. Weather needs MeshCore 1.15 or newer.',
    )
    assert.equal(WeatherCopy.banner(WeatherScreenBanner.channelMissing), "#meshwx isn't set up on your radio.")
    assert.equal(
      WeatherCopy.banner(WeatherScreenBanner.noBotHeard),
      'No weather radio heard yet. They appear as nodes named like WX-AUS.',
    )
  })

  // MARK: - Alert rows (§7.3)

  const items = (warnings, place = F.austin) =>
    WeatherAlertItems.make({ states: F.statesHolding(warnings), place, geometry, tables, now: F.now })

  it('the card folds after two rows, but never a storm warning', () => {
    const tornadoes = items([
      F.storedWarning({ event: 1, etn: 1, polygonAt: 30.2672 }),
      F.storedWarning({ event: 1, etn: 2, polygonAt: 30.2672 }),
      F.storedWarning({ event: 1, etn: 3, polygonAt: 30.2672 }),
    ])
    const unfolded = WeatherAlertFolding.fold(tornadoes, { tables })
    assert.equal(unfolded.rows.length, 3)
    assert.equal(unfolded.folded, 0)

    // Heat Advisory.
    const advisories = items([
      F.storedWarning({ event: 14, etn: 11, polygonAt: 30.2672 }),
      F.storedWarning({ event: 14, etn: 12, polygonAt: 30.2672 }),
      F.storedWarning({ event: 14, etn: 13, polygonAt: 30.2672 }),
    ])
    const folded = WeatherAlertFolding.fold(advisories, { tables })
    assert.equal(folded.rows.length, 2)
    assert.equal(folded.folded, 1)
  })

  it('the covers line says here, how far, or that it cannot tell', () => {
    assert.equal(WeatherCopy.coversLine(WeatherAlertPlacement.here, { placeName: 'Austin' }), 'Covers Austin')
    assert.equal(
      WeatherCopy.coversLine(
        WeatherAlertPlacement.near({ kilometres: 25, direction: MeshWXCompass.north }),
        { placeName: 'Austin' },
      ),
      "Doesn't cover Austin (25 km N)",
    )
    assert.equal(
      WeatherCopy.coversLine(WeatherAlertPlacement.elsewhere, { placeName: 'Austin' }),
      "Doesn't cover Austin",
    )
    assert.equal(
      WeatherCopy.coversLine(WeatherAlertPlacement.unplaced, { placeName: 'Austin' }),
      'Not sure it covers Austin',
    )
  })

  it('an alert elsewhere says which county and how far', () => {
    // Llano County (TXC299), about 100 km west-northwest of downtown Austin.
    const llano = F.storedWarning({
      event: 3,
      etn: 44,
      polygonAt: 30.75,
      longitude: -98.67,
      areas: [{ state: 42, county: true, start: 299, run: 1 }],
    })
    const located = WeatherCopy.alertLocation(llano.warning, { place: F.austin, tables })
    assert.ok(located?.startsWith('Llano County · '), located)
    assert.ok(located?.includes(' km W'), located)
    assert.equal(WeatherCopy.alertLocation(llano.warning, { place: null, tables }), 'Llano County')
  })

  // MARK: - Forecast (§9)

  it('row labels read against now in the phone calendar', () => {
    // 2026-09-16 00:00 CDT.
    const wednesday = Date.UTC(2026, 8, 16, 5)
    const label = (one) => WeatherCopy.rowLabel(one, { timeZone: F.timeZone, locale: F.locale })
    assert.equal(label(WeatherForecastRowLabel.today), 'Today')
    assert.equal(label(WeatherForecastRowLabel.tonight), 'Tonight')
    assert.equal(label(WeatherForecastRowLabel.tomorrow), 'Tomorrow')
    assert.equal(label(WeatherForecastRowLabel.tomorrowNight), 'Tomorrow night')
    assert.equal(label(WeatherForecastRowLabel.day(wednesday)), 'Wednesday')
    assert.equal(label(WeatherForecastRowLabel.night(wednesday)), 'Wednesday night')
  })

  it('temperatures show what the row carries', () => {
    const degrees = (value) => WeatherFormatting.temperature({ fahrenheit: value, locale: F.locale })
    assert.equal(
      WeatherCopy.temperatures({ highF: 90, lowF: 70, locale: F.locale }),
      `${degrees(90)} / ${degrees(70)}`,
    )
    assert.equal(WeatherCopy.temperatures({ highF: 90, lowF: null, locale: F.locale }), `High ${degrees(90)}`)
    assert.equal(WeatherCopy.temperatures({ highF: null, lowF: 70, locale: F.locale }), `Low ${degrees(70)}`)
    assert.equal(WeatherCopy.temperatures({ highF: null, lowF: null, locale: F.locale }), null)
  })

  it('a missing forecast names a far point, and no point says so', () => {
    const point = tables.point({ at: 103 })
    assert.notEqual(point, null)
    const name = WeatherCopy.pointName(103, { tables })
    assert.equal(
      WeatherCopy.forecastMissing({ placeName: 'Austin', point, kilometres: 4 }),
      'No forecast for Austin yet.',
    )
    assert.equal(
      WeatherCopy.forecastMissing({ placeName: 'Big Spring', point, kilometres: 60 }),
      `No forecast for Big Spring yet. The nearest forecast point is ${name}, 60 km.`,
    )
    // Revision 10: with no bundled point in reach there is still a forecast to ask for — the bot
    // picks the point — so there is nothing to name and the card says only that it has none yet.
    assert.equal(
      WeatherCopy.forecastMissing({ placeName: 'Pago Pago', point: null, kilometres: null }),
      'No forecast for Pago Pago yet.',
    )
    assert.equal(
      WeatherCopy.forecastPointChosenByBot({ source: 'WX-AUS' }),
      'Forecast point chosen by WX-AUS',
    )
  })

  // MARK: - Now (§8)

  // The station screen says each fact once: the name is its headline, the distance is its
  // "from Austin" line, and this is the message the reading arrived in (§3.1 U-8).
  it('the report line names the radio and the message, and nothing the screen already says', () => {
    assert.equal(
      F.plain(
        WeatherCopy.stationReport({
          botName: 'WX-AUS',
          reportedAt: F.now - 2 * 60 * 1000,
          now: F.now,
          timeZone: F.timeZone,
          locale: F.locale,
        }),
      ),
      "in WX-AUS's 11:18 PM report",
    )
  })

  it('no station nearby names the nearest one town, and the link names the area', () => {
    assert.equal(
      WeatherCopy.noStationNearby({ placeName: 'Dallas', nearestTown: 'Temple', kilometres: 190 }),
      'No weather station near Dallas. Nearest: Temple, 190 km.',
    )
    assert.equal(
      WeatherCopy.stationLink({ inArea: 14, total: 14, source: 'WX-AUS' }),
      "14 stations in WX-AUS's area",
    )
    assert.equal(
      WeatherCopy.stationLink({ inArea: 1, total: 1, source: 'WX-AUS' }),
      "1 station in WX-AUS's area",
    )
    // The link promised 14 rows and opened 19: it names every station the screen will show.
    assert.equal(
      WeatherCopy.stationLink({ inArea: 14, total: 19, source: 'WX-AUS' }),
      "19 weather stations, 14 in WX-AUS's area",
    )
    assert.equal(
      WeatherCopy.stationLink({ inArea: 1, total: 3, source: 'WX-AUS' }),
      "3 weather stations, 1 in WX-AUS's area",
    )
    assert.equal(WeatherCopy.stationLink({ inArea: 0, total: 3, source: 'WX-AUS' }), '3 weather stations')
    assert.equal(WeatherCopy.stationLink({ inArea: 0, total: 1, source: 'WX-AUS' }), '1 weather station')
  })

  // MARK: - Where the data came from (§12.1)

  it('the source line names the path the data took, and says nothing when the radio did not', () => {
    assert.equal(WeatherCopy.dataSource(MeshWXDataSource.goesSatellite), 'Via GOES satellite')
    assert.equal(WeatherCopy.dataSource(MeshWXDataSource.internet), 'Via internet')
    assert.equal(WeatherCopy.dataSource(MeshWXDataSource.mixed), 'Via GOES and internet')
    // A radio older than revision 7 has made no claim, and no screen may invent one for it.
    assert.equal(WeatherCopy.dataSource(MeshWXDataSource.unstated), null)
  })

  it('a shortened reply says so, beside the source when there is one', () => {
    assert.equal(
      WeatherCopy.reportFootnote({ source: MeshWXDataSource.goesSatellite, wasCut: false }),
      'Via GOES satellite',
    )
    assert.equal(
      WeatherCopy.reportFootnote({ source: MeshWXDataSource.unstated, wasCut: true }),
      'Shortened for radio',
    )
    assert.equal(
      WeatherCopy.reportFootnote({ source: MeshWXDataSource.internet, wasCut: true }),
      'Via internet · Shortened for radio',
    )
    // Neither fact: no row at all, so a card from an older radio reads exactly as it did.
    assert.equal(WeatherCopy.reportFootnote({ source: MeshWXDataSource.unstated, wasCut: false }), null)
  })

  // MARK: - The national alert map (§17)

  // Reason 4 on a sweep is not the radio being broken and not the radio being busy: somebody
  // else has just spent those eight packets, and this phone is about to be handed the same map.
  it('a refused map reads as another radio having asked, never as an error', () => {
    const refused = settled(
      WeatherRequestOutcome.notAvailable(MeshWXNotAvailableReason.rateLimited),
      F.now,
    )
    assert.equal(
      request(refused, { for: WeatherRequest.areaSweep({ includesAdvisories: false }) }),
      'Another radio asked WX-AUS for the map recently — try again in a few minutes.',
    )
    assert.equal(
      request(refused, { for: WeatherRequest.areaSweep({ includesAdvisories: true }) }),
      'Another radio asked WX-AUS for the map recently — try again in a few minutes.',
    )
    // Every other request keeps the wording it had.
    assert.equal(request(refused, { for: WeatherRequest.digest }), 'WX-AUS is busy, try again in a few minutes')
    assert.equal(
      request(settled(WeatherRequestOutcome.notAvailable(MeshWXNotAvailableReason.botError), F.now), {
        for: WeatherRequest.areaSweep({ includesAdvisories: false }),
      }),
      'WX-AUS had an error',
    )
  })

  // Every tap on this screen is public, and the screen never asks on its own — so the note the
  // ask button carries is the one every other ask button carries.
  it('the map names itself in the request log and says the answer is public', () => {
    assert.equal(
      WeatherCopy.requestName(WeatherRequest.areaSweep({ includesAdvisories: false }), { tables }),
      'National alert map',
    )
    assert.equal(
      WeatherCopy.requestName(WeatherRequest.areaSweep({ includesAdvisories: true }), { tables }),
      'National alert map · with advisories',
    )
    assert.equal(t('weather.request.publicNote'), 'Everyone listening on #meshwx gets the answer.')
  })

  /**
   * Revision 10's three requests in the log. The map can now cover a few states, and "Alert map"
   * twice over — once for Texas and once for the country — is a list nobody can read.
   */
  it('the revision 10 requests name what they asked about', () => {
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.areaSweep({ includesAdvisories: false, states: ['TX', 'OK'] }), { tables },
      ),
      'Alert map · Oklahoma and Texas',
    )
    // Normalised in the row as on the wire: two selections of the same states are one log entry.
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.areaSweep({ includesAdvisories: false, states: ['ok', 'tx'] }), { tables },
      ),
      'Alert map · Oklahoma and Texas',
    )
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.areaSweep({ includesAdvisories: true, states: ['TX'] }), { tables },
      ),
      'Alert map · Texas · with advisories',
    )
    // The map's own name. "Missing parts of National alert map" claims a country the `>part`
    // says nothing about: the group byte is all the wire carries.
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.parts({ group: 212, indexes: [1, 4], of: WeatherPartsKind.areaSweep }), { tables },
      ),
      'Missing parts of Alert map',
    )
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.parts({ group: 212, indexes: [1], of: WeatherPartsKind.text({ subject: 1 }) }),
        { tables },
      ),
      'Missing parts of Forecast discussion',
    )
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.parts({ group: 9, indexes: [1], of: WeatherPartsKind.text({ subject: 3 }) }),
        { tables },
      ),
      'Missing parts of Storm reports',
    )
    // A subject code this build does not know has no name to put in the sentence.
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.parts({ group: 9, indexes: [1], of: WeatherPartsKind.text({ subject: 200 }) }),
        { tables },
      ),
      'Missing parts',
    )
    assert.equal(
      WeatherCopy.requestName(
        WeatherRequest.forecastAt({ latitude: 35.687, longitude: -105.938 }), { tables },
      ),
      'Forecast for 35.687,-105.938',
    )
  })

  /**
   * **One rule for naming a set of states**, wherever one is named: a part of the map, the button
   * that asks for one, the row in the request log, a scoped sweep in the channel traffic.
   *
   * The design writes both joins out ("Texas, Oklahoma · as of 13:40" and "Ask for Texas and
   * Oklahoma"), so the comma folds every pair but the last and the last takes the word. Past
   * three the names are a wall and the count is the fact.
   *
   * `WeatherAreaMapCopy.stateNames` and the ask button call straight through to this, and
   * `src/ui` is not imported by the tests (docs/PORTING.md §2), so this is where the rule is
   * pinned for both.
   */
  it('a set of states is named one way, and counted past three', () => {
    assert.equal(WeatherReferenceNames.stateList([]), '')
    assert.equal(WeatherReferenceNames.stateList(['tx']), 'Texas')
    assert.equal(WeatherReferenceNames.stateList(['OK', 'TX']), 'Oklahoma and Texas')
    assert.equal(
      WeatherReferenceNames.stateList(['NM', 'OK', 'TX']), 'New Mexico, Oklahoma and Texas',
    )
    // Past three the count is the fact.
    assert.equal(WeatherReferenceNames.stateList(['LA', 'NM', 'OK', 'TX']), '4 states')
    // The order given is the order read: a sweep packet's own order is not a sorted selection.
    assert.equal(WeatherReferenceNames.stateList(['TX', 'OK']), 'Texas and Oklahoma')
    // A code no table knows is still the code the radio sent.
    assert.equal(WeatherReferenceNames.stateList(['ZZ']), 'ZZ')
    assert.equal(WeatherStateList.maxNamed, 3)
  })
  // MARK: - Radar (docs/MESHWX_UI.md §18)

  const summary = (here, { nearest = null, heavy = null } = {}) => ({
    here,
    nearest,
    nearestHeavy: heavy,
  })
  const reach = (level, kilometres, bearing) => ({ level, kilometres, bearing })
  const sentences = (one, placeName = 'Austin') =>
    WeatherCopy.radarSummary(one, { placeName }).map(F.plain)

  it('what is overhead is one sentence, and a dry place names the nearest echo', () => {
    assert.deepEqual(sentences(summary(1)), ['Light precipitation at Austin.'])
    assert.deepEqual(sentences(summary(2)), ['Moderate precipitation at Austin.'])
    assert.deepEqual(sentences(summary(3)), ['Heavy precipitation at Austin.'])
    assert.deepEqual(
      sentences(summary(0, { nearest: reach(1, 45.2, MeshWXCompass.northWest) })),
      ['Dry at Austin.', 'Nearest precipitation 45 km NW.'],
    )
    // A separate heavy core is a second sentence, under a dry place and a wet one alike.
    assert.deepEqual(
      sentences(summary(0, {
        nearest: reach(1, 4, MeshWXCompass.west), heavy: reach(3, 80, MeshWXCompass.northWest),
      })),
      ['Dry at Austin.', 'Nearest precipitation 4 km W.', 'Heavy precipitation 80 km NW.'],
    )
    assert.deepEqual(
      sentences(summary(1, { heavy: reach(3, 80, MeshWXCompass.northWest) })),
      ['Light precipitation at Austin.', 'Heavy precipitation 80 km NW.'],
    )
  })

  /**
   * The two sentences that are not about the place's own cell: a picture with nothing on it, and
   * a picture that stops short of the place. The second says that and nothing else — a `nearest`
   * measured from ground the mosaic never covered would be a guess dressed as a measurement.
   */
  it('an empty picture and one that does not reach the place each say so once', () => {
    assert.deepEqual(sentences(summary(0)), ['No precipitation on this picture.'])
    assert.deepEqual(
      sentences(summary(null, { nearest: reach(2, 30, MeshWXCompass.south) })),
      ['This picture does not reach Austin.'],
    )
  })

  const held = (minutesOld) => ({
    stored: { radar: { taken_min: Math.floor(F.now / 60_000) - minutesOld } },
    age: WeatherRadarAge.make({ takenMinutes: Math.floor(F.now / 60_000) - minutesOld, now: F.now }),
  })
  const timeLine = (minutesOld) =>
    F.plain(WeatherCopy.radarTime(held(minutesOld), { now: F.now, timeZone: F.timeZone, locale: F.locale }))

  it("the time line is the picture's own time, how old it is, and the caution", () => {
    assert.equal(timeLine(12), 'Picture from 11:08 PM · 12 min old')
    // From thirty minutes the line says what two missed mosaics mean.
    assert.equal(timeLine(30), 'Picture from 10:50 PM · 30 min old · Precipitation has moved since.')
    // Under a minute the age is left off: "0 s old" reads as a stopwatch, not as a picture. A
    // picture from a radio a minute ahead is the same case, never "-1 min old".
    assert.equal(timeLine(0), 'Picture from 11:20 PM')
    assert.equal(timeLine(-1), 'Picture from 11:21 PM')
  })

  /**
   * Radar is the one request whose refusal carries most of the information: "no recent picture
   * for this area" and "this radio has no dish at all" ask the reader to do entirely different
   * things (docs/MESHWX_UI.md §18.3).
   */
  it('a refused radar tile says which of the four refusals it is', () => {
    const asked = WeatherRequest.radar({ latitude: 30.2672, longitude: -97.7431, zoom: 0 })
    const refused = (reason) =>
      request(settled(WeatherRequestOutcome.notAvailable(reason), F.now), { for: asked })
    assert.equal(refused(MeshWXNotAvailableReason.noData), 'WX-AUS has no recent radar picture for this area.')
    assert.equal(refused(MeshWXNotAvailableReason.unsupported), 'WX-AUS does not receive radar pictures.')
    assert.equal(
      refused(MeshWXNotAvailableReason.rateLimited),
      'WX-AUS sent this picture a few minutes ago and has nothing newer yet.',
    )
    // Reason 1 is the forecast's sentence: the app sends a coordinate, so the radio could not
    // place it at all.
    assert.equal(refused(MeshWXNotAvailableReason.unknownLocation), "WX-AUS didn't recognize that place")
    // Anything else falls back to the wire's own wording rather than inventing a fifth radar one.
    assert.equal(refused(MeshWXNotAvailableReason.botError), 'WX-AUS had an error')
    // And the same reason on another request is untouched.
    assert.equal(
      request(settled(WeatherRequestOutcome.notAvailable(MeshWXNotAvailableReason.noData), F.now)),
      'WX-AUS has no data for that yet',
    )
  })

  it('a radar tile is named by its width and the centre of its square', () => {
    assert.equal(WeatherCopy.radarWidthName(0), 'Local')
    assert.equal(WeatherCopy.radarWidthName(1), 'Regional')
    assert.equal(WeatherCopy.radarWidthName(2), 'Wide')
    // Zoom 3 is on the wire and no screen offers it, so it has no name here.
    assert.equal(WeatherCopy.radarWidthName(3), null)

    // The centre, in the three decimals a request is written in: a square of earth has no name,
    // and its middle is the one thing about it a reader can place on a map.
    assert.equal(WeatherCopy.radarCentre({ south: 29, west: -99, zoom: 0 }), '30.000,-98.000')
    assert.equal(WeatherCopy.radarCentre({ south: 28, west: -100, zoom: 2 }), '32.000,-96.000')
    assert.equal(WeatherCopy.radarCentre({ south: -34, west: 149, zoom: 0 }), '-33.000,150.000')

    assert.equal(
      F.plain(WeatherCopy.channelSubject(
        { kind: 'radar', tile: { south: 29, west: -99, zoom: 0 } }, { tables },
      )),
      'Radar picture · Local · 30.000,-98.000',
    )
    // Which of the fourteen mosaics the square was cut out of, and nothing for an index this
    // bundle is too old to know.
    assert.equal(F.plain(WeatherCopy.radarMosaic(1, { tables })), `Cut from the ${tables.radarProductName({ at: 1 })} mosaic.`)
    assert.equal(WeatherCopy.radarMosaic(200, { tables }), null)
    assert.equal(WeatherCopy.cacheGroup('radarPictures'), 'Radar pictures')
    // The log of this phone's own asks names what was asked about, never the tile it came back as.
    assert.equal(
      F.plain(WeatherCopy.requestName(
        WeatherRequest.radar({ latitude: 30.2672, longitude: -97.7431, zoom: 0 }), { tables },
      )),
      'Radar picture · 30.267,-97.743',
    )
  })

  // MARK: - The last hour (docs/MESHWX_UI.md §18.5)

  /**
   * "One row per tile, its newest time, and '5 pictures' when it holds more than one." The widths
   * are Local, Regional and Wide only: the first draft's Detail (zoom −1) has no name.
   */
  it('a square with frames says how many, and only the three widths have names', () => {
    assert.equal(WeatherCopy.radarWidthName(-1), null)
    // "5 pictures" when the square holds more than one; nothing when it holds one.
    assert.equal(
      F.plain(WeatherCopy.channelSubject(
        { kind: 'radar', tile: { south: 29, west: -99, zoom: 0 }, frames: 5 }, { tables },
      )),
      'Radar picture · Local · 30.000,-98.000 · 5 pictures',
    )
    assert.equal(
      F.plain(WeatherCopy.channelSubject(
        { kind: 'radar', tile: { south: 29, west: -99, zoom: 0 }, frames: 1 }, { tables },
      )),
      'Radar picture · Local · 30.000,-98.000',
    )
  })

  /** "Request rows read 'Radar, last hour'", with the coordinate asked about. */
  it('the last hour is logged by its own name, and refused in the radar words', () => {
    const loop = WeatherRequest.radarLoop({ latitude: 30.2672, longitude: -97.7431, held: [29_832_458] })
    assert.equal(F.plain(WeatherCopy.requestName(loop, { tables })), 'Radar, last hour · 30.267,-97.743')
    const refused = (reason) => request(settled(WeatherRequestOutcome.notAvailable(reason), F.now), { for: loop })
    assert.equal(
      refused(MeshWXNotAvailableReason.rateLimited),
      'WX-AUS sent this picture a few minutes ago and has nothing newer yet.',
    )
    assert.equal(refused(MeshWXNotAvailableReason.noData), 'WX-AUS has no recent radar picture for this area.')
  })

  /** "6:08 PM · 2 of 5", and the loop's cost "Up to 5 packets". */
  it('a frame of the loop says its own time and its place in the loop', () => {
    const frame = { radar: { taken_min: Math.floor(F.now / 60_000) - 45 } }
    assert.equal(
      F.plain(WeatherCopy.radarFrameLine(frame, { index: 2, count: 5, now: F.now, timeZone: F.timeZone, locale: F.locale })),
      '10:35 PM · 2 of 5',
    )
    assert.equal(F.plain(WeatherCopy.radarLoopCost(5)), 'Up to 5 packets')
  })
})
