// Port of MC1Tests/Views/Tools/Weather/WeatherFormattingTests.swift (docs/PORTING.md).
//
// Units, durations and names as the Weather screen writes them (docs/MESHWX_UI.md). Same cases,
// same numbers; the Swift's `Calendar` and `Locale` are the IANA id and the BCP 47 tag.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readFileSync } from 'node:fs'

import { setStrings } from '../src/l10n.js'
import { MeshWXCompass, MeshWXSky, MeshWXWarning, MeshWXWindReading } from '../src/meshwx/index.js'
import { WeatherNames } from '../src/screen/index.js'
import { WeatherAlertNotificationSubject } from '../src/weather/index.js'
import { WeatherAlertNotificationCopyImpl, WeatherFormatting, WeatherReferenceNames } from '../src/app/index.js'
import * as F from './helpers/app-fixture.js'

const tables = await F.loadTables()

const clock = (offsetSeconds) =>
  F.plain(
    WeatherFormatting.clockTime(F.now + offsetSeconds * 1000, {
      now: F.now,
      timeZone: F.timeZone,
      locale: F.locale,
    }),
  )

describe('Weather formatting', () => {
  // MARK: - Durations

  it('durations use the largest unit that fits', () => {
    assert.equal(WeatherFormatting.duration({ seconds: 40 }), '40 s')
    assert.equal(WeatherFormatting.duration({ seconds: 150 }), '2 min')
    assert.equal(WeatherFormatting.duration({ seconds: 3 * 3600 + 1200 }), '3 h')
    assert.equal(WeatherFormatting.duration({ seconds: 3 * 86_400 }), '3 d')
  })

  it('ages read as ago and old, with just now for a few seconds', () => {
    assert.equal(WeatherFormatting.ago(F.now - 2000, { now: F.now }), 'just now')
    assert.equal(WeatherFormatting.ago(F.now - 40_000, { now: F.now }), '40 s ago')
    assert.equal(WeatherFormatting.ago(F.now - 120_000, { now: F.now }), '2 min ago')
    assert.equal(WeatherFormatting.age(F.now - 3 * 3600 * 1000, { now: F.now }), '3 h old')
  })

  it('time left switches to hours at sixty minutes', () => {
    assert.equal(WeatherFormatting.timeLeft({ minutes: 40 }), '40 min')
    assert.equal(WeatherFormatting.timeLeft({ minutes: 80 }), '1 h 20 min')
    assert.equal(WeatherFormatting.timeLeft({ minutes: 120 }), '2 h')
  })

  it('a quiet feed is minutes under an hour, then whole hours', () => {
    assert.equal(WeatherFormatting.quietDuration({ minutes: 45 }), '45 min')
    assert.equal(WeatherFormatting.quietDuration({ minutes: 300 }), '5 h')
  })

  it('times today and soon are clock times', () => {
    assert.equal(clock(-18 * 60), '11:02 PM')
    // 12:40 AM tomorrow: a warning ending after midnight still reads as a time.
    assert.equal(clock(80 * 60), '12:40 AM')
  })

  it('a past time on another day never passes for today', () => {
    assert.equal(clock(-26 * 3600), 'yesterday 9:20 PM')
    const older = clock(-3 * 86_400)
    assert.ok(older.startsWith('Sep 11') && older.endsWith('11:20 PM') && !older.includes('2026'), older)
    const later = clock(20 * 3600)
    assert.ok(later.startsWith('Sep 15') && later.endsWith('7:20 PM'), later)
  })

  // MARK: - Distance

  it('distances are whole kilometres with a compass point', () => {
    assert.equal(WeatherFormatting.kilometres(3.2), '3 km')
    assert.equal(WeatherFormatting.kilometres(0.3), 'under 1 km')
    assert.equal(WeatherFormatting.distance(25.4, { direction: MeshWXCompass.north }), '25 km N')
    assert.equal(WeatherFormatting.distance(40, { direction: MeshWXCompass.northWest }), '40 km NW')
  })

  it('directions point from the place towards the target', () => {
    const austin = { latitude: 30.27, longitude: -97.74 }
    assert.equal(
      WeatherFormatting.direction({ from: austin, to: { latitude: 30.77, longitude: -97.74 } }),
      MeshWXCompass.north,
    )
    assert.equal(
      WeatherFormatting.direction({ from: austin, to: { latitude: 30.27, longitude: -98.74 } }),
      MeshWXCompass.west,
    )
  })

  // MARK: - Names

  it('a radio heard without an advert is named by its hex id', () => {
    assert.equal(WeatherFormatting.botName({ botID: 0x041d, bot: null }), 'Weather radio 041D')
  })

  it('a name starting a sentence is capitalised', () => {
    assert.equal(WeatherFormatting.sentenceStart('the weather radio'), 'The weather radio')
    assert.equal(WeatherFormatting.sentenceStart('WX-AUS'), 'WX-AUS')
  })

  // **One label per place** (docs/MESHWX_UI.md §3.1 U-12). The label a place carries is the name
  // it is shown by everywhere — the title bar, Places, every sentence that names it — and the
  // state stays on, because it is what tells two Austins apart.
  it('a place is named the same way everywhere', () => {
    assert.equal(WeatherFormatting.placeName('Round Rock, TX'), 'Round Rock, TX')
    assert.equal(WeatherFormatting.placeName('this location'), 'this location')
    assert.equal(WeatherFormatting.placeName(' Austin, TX '), 'Austin, TX')
  })

  it('firmware versions drop the v and a trailing zero', () => {
    assert.equal(WeatherFormatting.firmwareVersion('v1.14.0'), '1.14')
    assert.equal(WeatherFormatting.firmwareVersion('1.14.2'), '1.14.2')
    assert.equal(WeatherFormatting.firmwareVersion('dev'), 'dev')
  })

  // A forecast point is named by `WeatherNames.pointLabel`, the one function every site that
  // names one calls (docs/MESHWX_UI.md §3.1 U-25).
  it('forecast points read as places, by the one function that names them', () => {
    assert.equal(WeatherNames.pointState('Austin Camp Mabry-Travis TX'), 'TX')
    assert.equal(WeatherNames.pointState('Luis Munoz Marin International Airport-San Juan'), null)
    assert.equal(WeatherNames.pointLabel('Central Park-New York NY'), 'Central Park, NY')
    assert.equal(
      WeatherNames.pointLabel('Luis Munoz Marin International Airport-San Juan'),
      'Luis Munoz Marin International Airport',
    )
    assert.equal(WeatherNames.pointLabel('10 Mile Boxcars'), '10 Mile Boxcars')
  })

  it('an area named twice is listed once', () => {
    const runs = [
      { state: 42, county: true, start: 453, run: 1 },
      { state: 42, county: true, start: 209, run: 1 },
      { state: 42, county: true, start: 453, run: 1 },
    ]
    const areas = tables.namedAreas({ for: runs })
    assert.equal(areas.length, 3)
    assert.deepEqual(
      WeatherFormatting.uniqueAreas(areas).map((area) => area.ugc),
      ['TXC453', 'TXC209'],
    )
    assert.equal(WeatherFormatting.shortAreaName(areas[0]), 'Travis County')
  })

  it('offices are named by city and unknown ones by code', () => {
    assert.equal(WeatherReferenceNames.officeName('EWX'), 'NWS Austin/San Antonio')
    assert.equal(WeatherReferenceNames.officeName('FWD'), 'NWS Fort Worth')
    assert.equal(WeatherReferenceNames.officeName('ZZZ'), 'NWS ZZZ')
    assert.equal(WeatherReferenceNames.officeName('WNS'), 'Storm Prediction Center')
    assert.equal(WeatherReferenceNames.officeName('NHC'), 'National Hurricane Center')
    assert.equal(WeatherReferenceNames.stateName('TX'), 'Texas')
  })

  // Spec §6 (revision 3): whole miles rounded down, so 1/2SM arrives as 0.
  it('visibility under a mile reads under 1 mi, not 0', () => {
    assert.equal(WeatherFormatting.visibility({ miles: 0, locale: 'en-US' }), 'under 1 mi')
    assert.equal(WeatherFormatting.visibility({ miles: 10, locale: 'en-US' }), '10 mi')
  })

  // MARK: - Wind, pressure, tags

  it('a reported wind reads as direction, speed and gust', () => {
    const gusty = F.observation({ station: 0, windDegrees: 157.5, windMph: 12, gustMph: 21 })
    assert.equal(WeatherFormatting.wind(MeshWXWindReading.make({ observation: gusty })), 'SSE 12 gusting 21')
    const steady = F.observation({ station: 0, windDegrees: 180, windMph: 10, gustMph: 0 })
    assert.equal(WeatherFormatting.wind(MeshWXWindReading.make({ observation: steady })), 'S 10')
  })

  it('zero speed is calm and an unreported wind has no text', () => {
    const calm = F.observation({ station: 0, windDegrees: 0, windMph: 0, gustMph: 0 })
    assert.equal(WeatherFormatting.wind(MeshWXWindReading.make({ observation: calm })), 'calm')
    const missing = F.observation({ station: 0, windDegrees: 0, windMph: null })
    assert.equal(WeatherFormatting.wind(MeshWXWindReading.make({ observation: missing })), null)
  })

  it('pressure is two decimals of inches of mercury', () => {
    assert.equal(WeatherFormatting.pressure({ inchesOfMercury: 29.92, locale: F.locale }), '29.92')
  })

  it('tags read as the spec words them, on one line', () => {
    const subject = F.warning({
      event: 3,
      office: 1,
      etn: 42,
      expiresMinutes: 29_500_030,
      tornado: 2,
      floodDamage: 1,
      hailQuarterInches: 4,
      windMph: 60,
    })
    assert.deepEqual(WeatherFormatting.tagTexts({ for: subject, locale: F.locale }), [
      'Tornado: radar indicated',
      'Flash flood damage: considerable',
      'Hail 1.00 in',
      'Wind 60 mph',
    ])
    assert.equal(
      WeatherFormatting.tagLine({ for: subject, locale: F.locale }),
      'Tornado: radar indicated · Flash flood damage: considerable · Hail 1.00 in · Wind 60 mph',
    )
  })

  it('every sky code but other has a word', () => {
    for (let sky = 0; sky <= 15; sky += 1) {
      assert.equal(WeatherFormatting.condition(sky) == null, sky === MeshWXSky.other, `sky ${sky}`)
    }
  })

  it('the night icon runs from seven in the evening to six in the morning', () => {
    // 2026-09-14 in America/Chicago, which is UTC-5 that day.
    const at = (hour) => Date.UTC(2026, 8, 14, hour + 5, 0, 0)
    assert.equal(WeatherFormatting.isNight(at(23), { timeZone: F.timeZone }), true)
    assert.equal(WeatherFormatting.isNight(at(5), { timeZone: F.timeZone }), true)
    assert.equal(WeatherFormatting.isNight(at(12), { timeZone: F.timeZone }), false)
  })
})

// MARK: - When an alert applies (docs/MESHWX_UI.md §3.1 U-49)
//
// The two clocks every alert test runs in: the phone's own 12- or 24-hour format comes from the
// locale, so both are fixed here, as are the calendar and the zone — never the machine's.
//
// Intl names a date beyond the week "Oct 6, 9:24 AM" where Foundation says "Oct 6 at 9:24 AM";
// both are the locale's own form of the same fields, and the web's `clockTime` already wrote
// "Sep 13, 8:02 PM" before revision 12, so those expectations are Intl's.
describe('When an alert applies', () => {
  const timeZone = 'America/Chicago'
  const clocks = [
    { name: 'twelveHour', locale: 'en-US', pick: (twelve) => twelve },
    { name: 'twentyFourHour', locale: 'en-GB', pick: (_, twentyFour) => twentyFour },
  ]
  const minutes = (count) => count * 60_000
  const hours = (count) => count * 3_600_000
  const days = (count) => count * 86_400_000

  /** The owner's Flood Watch of 29 September: issued Tuesday 09:24 CDT for Wednesday 19:00 through Friday 19:00. */
  const FloodWatch = Object.freeze({
    issued: 1_790_691_840 * 1000,
    begins: 1_790_691_840 * 1000 + minutes(2016),
    expires: 1_790_691_840 * 1000 + minutes(4896),
  })

  const line = ({ begins, expires, now, countdown = true }, clock) =>
    F.plain(WeatherFormatting.alertWindow({
      beginsAt: begins, expiresAt: expires, now, timeZone, locale: clock.locale, countdown,
    }))
  const alertClock = (date, now, clock) =>
    F.plain(WeatherFormatting.alertClock(date, { now, timeZone, locale: clock.locale }))

  /**
   * The contract's three moments (spec §18.2): the screen that said "until Oct 2 at
   * 19:00 · in 81 h 28 min" on Tuesday morning now says when it starts, and counts down only in
   * its last twelve hours.
   */
  for (const clock of clocks) {
    it(`the flood watch reads from its start, then until its end, then counts down (${clock.name})`, () => {
      const w = FloodWatch
      assert.equal(line({ begins: w.begins, expires: w.expires, now: w.issued + minutes(8) }, clock),
        clock.pick('from Wed 7:00 PM until Fri 7:00 PM', 'from Wed 19:00 until Fri 19:00'))
      assert.equal(line({ begins: w.begins, expires: w.expires, now: w.begins }, clock),
        clock.pick('until Fri 7:00 PM', 'until Fri 19:00'), 'in effect from its start')
      assert.equal(line({ begins: w.begins, expires: w.expires, now: w.expires - hours(12) }, clock),
        clock.pick('until 7:00 PM · 12 h left', 'until 19:00 · 12 h left'), 'Friday 07:00')
    })

    it(`an alert in effect counts down only in its last twelve hours (${clock.name})`, () => {
      const now = F.now // Monday 14 September, 23:20 CDT
      assert.equal(line({ begins: null, expires: now + minutes(21), now }, clock),
        clock.pick('until 11:41 PM · 21 min left', 'until 23:41 · 21 min left'))
      // Just after midnight: within twelve hours, so the time alone.
      assert.equal(line({ begins: null, expires: now + minutes(80), now }, clock),
        clock.pick('until 12:40 AM · 1 h 20 min left', 'until 00:40 · 1 h 20 min left'))
      assert.equal(line({ begins: null, expires: now + minutes(160), now }, clock),
        clock.pick('until 2:00 AM · 2 h 40 min left', 'until 02:00 · 2 h 40 min left'))
      // Exactly twelve hours still counts down, and still names the time alone.
      assert.equal(line({ begins: null, expires: now + hours(12), now }, clock),
        clock.pick('until 11:20 AM · 12 h left', 'until 11:20 · 12 h left'))
      // A minute past twelve hours: the day and the time, no count.
      assert.equal(line({ begins: null, expires: now + hours(12) + minutes(1), now }, clock),
        clock.pick('until Tue 11:21 AM', 'until Tue 11:21'))
      // A part-minute left rounds up, so an alert in effect is never said to have none.
      assert.equal(line({ begins: null, expires: now + 30_000, now }, clock),
        clock.pick('until 11:20 PM · 1 min left', 'until 23:20 · 1 min left'))
      // A start already past is in effect, and reads as if there were none.
      assert.equal(line({ begins: now - hours(1), expires: now + minutes(21), now }, clock),
        line({ begins: null, expires: now + minutes(21), now }, clock))
    })

    it(`nothing counts down to an end that has not begun (${clock.name})`, () => {
      const now = F.now // Monday 23:20
      // Starting just after midnight and ending before dawn: both within twelve hours, times alone.
      assert.equal(line({ begins: now + minutes(70), expires: now + minutes(400), now }, clock),
        clock.pick('from 12:30 AM until 6:00 AM', 'from 00:30 until 06:00'))
      // A start one minute ahead is still ahead.
      assert.equal(line({ begins: now + minutes(1), expires: now + minutes(40), now }, clock),
        clock.pick('from 11:21 PM until 12:00 AM', 'from 23:21 until 00:00'))
    })

    /** Notifications never count down: "40 min left" on a lock screen is stale when it is read. */
    it(`without the countdown an alert ending soon says only when (${clock.name})`, () => {
      const now = F.now
      assert.equal(line({ begins: null, expires: now + minutes(21), now, countdown: false }, clock),
        clock.pick('until 11:41 PM', 'until 23:41'))
      const w = FloodWatch
      assert.equal(line({ begins: w.begins, expires: w.expires, now: w.issued, countdown: false }, clock),
        clock.pick('from Wed 7:00 PM until Fri 7:00 PM', 'from Wed 19:00 until Fri 19:00'))
    })

    /**
     * Today or within twelve hours: the time. The six days after today: the weekday. The seventh —
     * today's weekday again — and beyond: the date.
     */
    it(`an alert's moment is a time, a weekday, then a date (${clock.name})`, () => {
      const now = FloodWatch.issued // Tuesday 29 September, 09:24
      assert.equal(alertClock(now + hours(1), now, clock), clock.pick('10:24 AM', '10:24'))
      // Later today, more than twelve hours on: still today, so the time.
      const tonight = now + hours(14) + minutes(30) // 23:54
      assert.equal(alertClock(tonight, now, clock), clock.pick('11:54 PM', '23:54'))
      // Tomorrow, within twelve hours of a late evening: the time alone.
      const lateEvening = now + hours(12) // 21:24
      assert.equal(alertClock(lateEvening + hours(4), lateEvening, clock), clock.pick('1:24 AM', '01:24'))
      assert.equal(alertClock(now + days(1), now, clock), clock.pick('Wed 9:24 AM', 'Wed 09:24'))
      assert.equal(alertClock(now + days(6), now, clock), clock.pick('Mon 9:24 AM', 'Mon 09:24'))
      // Seven days out, the same weekday as today: the date, never "Tue".
      assert.equal(alertClock(now + days(7), now, clock), clock.pick('Oct 6, 9:24 AM', '6 Oct, 09:24'))
      // Six days and twenty-three hours on is also next Tuesday by the calendar: the date again.
      assert.equal(alertClock(now + days(7) - hours(1), now, clock), clock.pick('Oct 6, 8:24 AM', '6 Oct, 08:24'))
      // Weeks out: the date.
      assert.equal(alertClock(now + days(20), now, clock), clock.pick('Oct 19, 9:24 AM', '19 Oct, 09:24'))
    })

    /**
     * A notification body says when the alert applies the way every screen does, without the
     * countdown (docs/MESHWX_UI.md §3.1 U-49).
     */
    it(`a notification says from and until, and never counts down (${clock.name})`, () => {
      const copy = WeatherAlertNotificationCopyImpl.make({ locale: clock.locale, timeZone })
      const w = FloodWatch
      const watch = MeshWXWarning.make({
        identity: { event: tables.eventByCode.get('FA.A') ?? 0, office: 35, etn: 8 },
        expiresMinutes: w.expires / 60_000,
        areas: [{ state: 42, county: false, start: 191, run: 4 }],
        issuedMinutes: w.issued / 60_000,
        beginsMinutes: w.begins / 60_000,
      })
      const body = (now, beginsAt) => F.plain(copy.content(
        WeatherAlertNotificationSubject.make({
          warning: watch, placeLabel: 'Austin, TX', placement: { kind: 'here' }, botName: 'WX-AUS',
          isLate: false, now, beginsAt,
        }),
        { tables },
      ).body)
      assert.equal(body(w.issued, w.begins),
        clock.pick('Austin, TX · from Wed 7:00 PM until Fri 7:00 PM', 'Austin, TX · from Wed 19:00 until Fri 19:00'))
      assert.equal(body(w.expires - minutes(40), w.begins),
        clock.pick('Austin, TX · until 7:00 PM', 'Austin, TX · until 19:00'))
    })
  }

  /** The 24-hour clock is the locale's, not an English one: German names its own weekday. */
  it('a German phone gets its own weekday and 24-hour clock', () => {
    const text = F.plain(WeatherFormatting.alertClock(FloodWatch.begins, { now: FloodWatch.issued, timeZone, locale: 'de-DE' }))
    assert.ok(text.includes('19:00') && text.startsWith('Mi'), text)
    assert.ok(!text.includes('PM'), text)
  })

  // Not in the Swift: the whole German line, words from the German table, on Intl's German clock.
  it('in German, the German words on the locale’s own clock', () => {
    const strings = (name) => JSON.parse(readFileSync(new URL(`../strings/${name}.json`, import.meta.url), 'utf8'))
    setStrings(strings('de'), strings('en'))
    try {
      const w = FloodWatch
      const german = (options) => F.plain(WeatherFormatting.alertWindow({ ...options, timeZone, locale: 'de' }))
      assert.equal(german({ beginsAt: w.begins, expiresAt: w.expires, now: w.issued }), 'von Mi., 19:00 bis Fr., 19:00')
      assert.equal(german({ beginsAt: w.begins, expiresAt: w.expires, now: w.begins }), 'bis Fr., 19:00')
      assert.equal(german({ beginsAt: w.begins, expiresAt: w.expires, now: w.expires - hours(12) }), 'bis 19:00 · noch 12 h')
      assert.equal(german({ expiresAt: F.now + minutes(80), now: F.now }), 'bis 00:40 · noch 1 h 20 min')
    } finally {
      setStrings(null)
    }
  })
})
