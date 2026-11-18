// Port of MC1ServicesTests/Weather/WeatherTrafficTests.swift (docs/PORTING.md).
//
// Owner, 20 September 2026: *"A way to see all the GRP_DATA traffic on a channel like we do a
// chat."* So what is pinned here is that the log is the *channel's* traffic and not this app's
// opinion of it: a duplicate, somebody else's request, a datagram of another type and one the
// codec refuses all get a row.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MeshWXEncoder, MeshWXTables, MeshWXWire, bytesToHex } from '../src/meshwx/index.js'
import { nodeBundleLoader } from '../src/meshwx/nodeLoader.js'
import { t } from '../src/l10n.js'
import { WeatherCopy, WeatherReferenceNames } from '../src/app/index.js'
import {
  InMemoryWeatherStateStore,
  WeatherChannel,
  WeatherRequest,
  WeatherService,
  WeatherTrafficEntry,
  WeatherTrafficLog
} from '../src/weather/index.js'
import { WeatherNames, WeatherTrafficSummary } from '../src/screen/index.js'
import * as F from './helpers/weather-fixtures.js'

const tables = await MeshWXTables.load(nodeBundleLoader())

const BOT = 0x4c7a
const SENDER = Uint8Array.from([0x0a, 0x1b, 0x2c, 0x03, 0x04, 0x05])

/** A real datagram, so the log and the summary read the bytes a radio would deliver. */
function datagram(data, { channelIndex = 3, dataType = MeshWXWire.dataType, snr = 6.5, pathLength = 2 } = {}) {
  return { channelIndex, pathLength, dataType, data, snr }
}

const observations = (seq = 1) => MeshWXEncoder.observations({
  seq,
  bot: BOT,
  timestampMinutes: 29_823_893,
  stations: [
    { station: 202, temp_f: 90, dewpoint_f: 70, wind_dir_deg: 180, sky: 0, wind_mph: 5, gust_mph: 0, visibility_mi: 10, pressure_inhg: 29.9, humidity_pct: 50, feels_delta_f: 0 },
    { station: 203, temp_f: 88, dewpoint_f: 69, wind_dir_deg: 180, sky: 0, wind_mph: 5, gust_mph: 0, visibility_mi: 10, pressure_inhg: 29.9, humidity_pct: 50, feels_delta_f: 0 }
  ]
})

describe('WeatherTrafficLog', () => {
  it('is a ring of three hundred, oldest first', () => {
    const log = new WeatherTrafficLog()
    for (let index = 0; index < 305; index += 1) {
      log.record(WeatherTrafficEntry.make({ id: String(index), at: index }))
    }
    assert.equal(log.entries().length, WeatherTrafficLog.limit)
    assert.equal(log.entries()[0].id, '5', 'the five oldest fell out')
    assert.equal(log.entries()[299].id, '304', 'newest last: the timeline reads downwards')
  })

  it('fills in what a row could not know when it was written', () => {
    const log = new WeatherTrafficLog()
    const row = log.record(WeatherTrafficEntry.make({ id: 'a', at: 1 }))
    assert.equal(row.isDuplicate, false)
    assert.equal(log.update('a', { isDuplicate: true }).isDuplicate, true)
    assert.equal(log.entries()[0].isDuplicate, true)
    assert.equal(log.update('missing', { isDuplicate: true }), null)
  })

  it('tells its observers, and empties on Clear', () => {
    const log = new WeatherTrafficLog()
    let changes = 0
    const unsubscribe = log.subscribe(() => { changes += 1 })
    log.record(WeatherTrafficEntry.make({ id: 'a', at: 1 }))
    log.clear()
    assert.equal(changes, 2)
    assert.deepStrictEqual(log.entries(), [])
    unsubscribe()
    log.record(WeatherTrafficEntry.make({ id: 'b', at: 2 }))
    assert.equal(changes, 2)
  })

  it('is kept between visits, under its own key beside the state', async () => {
    const values = new Map()
    const storage = {
      async get(key) { return values.get(key) ?? null },
      async set(key, value) { values.set(key, JSON.parse(JSON.stringify(value))) },
      async delete(key) { values.delete(key) }
    }
    const log = new WeatherTrafficLog({ storage })
    await log.load()
    log.record(WeatherTrafficEntry.make({ id: 'a', at: 1, hex: 'abcd' }))
    await log.flush()
    assert.equal(WeatherTrafficLog.key, 'weather.traffic')
    assert.equal(values.get('weather.traffic').length, 1)

    const again = new WeatherTrafficLog({ storage })
    await again.load()
    assert.equal(again.entries()[0].hex, 'abcd')

    again.clear()
    await again.flush()
    assert.equal(values.has('weather.traffic'), false, 'an empty log leaves no blob behind')
  })

  it('reads the header off the bytes, and says nothing it cannot read', () => {
    const data = observations(17)
    const entry = WeatherTrafficEntry.fromDatagram({
      id: 'a', at: 1, datagram: datagram(data), isBacklog: true
    })
    assert.equal(entry.direction, 'received')
    assert.equal(entry.isBacklog, true)
    assert.equal(entry.botID, BOT)
    assert.equal(entry.seq, 17)
    assert.equal(entry.type, 4)
    assert.equal(entry.length, data.length)
    assert.equal(entry.snr, 6.5)
    assert.equal(entry.pathLength, 2)
    assert.equal(entry.hex, bytesToHex(data))

    // Another application's datagram on the same slot: the type is all that can be said.
    const foreign = WeatherTrafficEntry.fromDatagram({
      id: 'b', at: 2, datagram: datagram(Uint8Array.from([1, 2, 3]), { dataType: 0x1234 })
    })
    assert.equal(foreign.botID, null)
    assert.equal(foreign.seq, null)
    assert.equal(foreign.dataType, 0x1234)
    assert.equal(foreign.hex, '010203')
  })
})

describe('WeatherTrafficSummary', () => {
  const summary = (data, options = {}) => WeatherTrafficSummary.make({
    entry: WeatherTrafficEntry.fromDatagram({ id: 'x', at: 1, datagram: datagram(data), ...options }),
    tables,
    stateName: WeatherReferenceNames.stateName
  })

  const sweep = (fields) => MeshWXEncoder.areaSweep({
    seq: 2,
    bot: BOT,
    builtMinutes: 29_823_900,
    group: 34,
    index: 2,
    total: 7,
    entries: [{ event: 3, state: 42, county: false, start: 192, run: 6 }],
    ...fields
  })

  it('names the kind and then what this one carries', () => {
    assert.deepStrictEqual(summary(observations()), { title: 'Observations', detail: '2 stations' })

    // Packet numbers are zero-based on the wire (spec §12, §8) and one-based for a reader:
    // nobody counting packets on a screen starts at nought.
    assert.deepStrictEqual(
      summary(sweep()), { title: 'Alert map', detail: 'part 3 of 7 · 6 areas · the whole country' },
    )

    const refusal = MeshWXEncoder.notAvailable({ seq: 3, bot: BOT, request: '>f', reason: 1 })
    assert.deepStrictEqual(summary(refusal), { title: 'Not available', detail: 'f · unknown location' })
  })

  /**
   * A sweep packet says what its sweep covers, whether it was cut to fit, and whether it went as
   * far down the severity list as advisories — in the packet's own reading order.
   */
  it('a sweep packet says what it covers, what was dropped and how far down it went', () => {
    assert.deepStrictEqual(
      summary(sweep({ wasCut: true })),
      { title: 'Alert map', detail: 'part 3 of 7 · 6 areas · the whole country · cut to fit' },
    )
    assert.deepStrictEqual(
      summary(sweep({ includesAdvisories: true })),
      { title: 'Alert map', detail: 'part 3 of 7 · 6 areas · the whole country · with advisories' },
    )
  })

  /**
   * Spec §13, revision 11: "Radar picture · Local · 214 cells with precipitation". The width
   * rather than the tile's corner — a tile is two degrees, which is 222 km tall everywhere and a
   * different width at every latitude, so the corner is a number nobody can picture.
   */
  it('a radar tile says how wide it is and how much of it is wet', () => {
    const rows = Array.from({ length: 32 }, (_, row) => (row < 2 ? '1'.repeat(32) : '0'.repeat(32)))
    const radar = (fields) => MeshWXEncoder.radar({
      seq: 4,
      bot: BOT,
      takenMinutes: 29_832_458,
      south: 32,
      west: -98,
      zoom: 0,
      product: 1,
      rows,
      source: 1,
      ...fields
    })
    assert.deepStrictEqual(
      summary(radar()), { title: 'Radar picture', detail: 'Local · 64 cells with precipitation' },
    )
    assert.deepStrictEqual(
      summary(radar({ zoom: 1, south: 28, west: -100 })),
      { title: 'Radar picture', detail: 'Regional · 64 cells with precipitation' },
    )
    assert.deepStrictEqual(
      summary(radar({ zoom: 2, south: 28, west: -100 })),
      { title: 'Radar picture', detail: 'Wide · 64 cells with precipitation' },
    )
    // Zoom 3 is on the wire and is not offered on screen, so it is left unnamed rather than
    // given a fourth word nothing else in the app says.
    assert.deepStrictEqual(
      summary(radar({ zoom: 3, south: 24, west: -104 })),
      { title: 'Radar picture', detail: '64 cells with precipitation' },
    )
    // A clear picture is a row of its own on the channel, and says nothing about rain.
    assert.deepStrictEqual(
      summary(radar({ rows: Array.from({ length: 32 }, () => '0'.repeat(32)) })),
      { title: 'Radar picture', detail: 'Local' },
    )
    // One wet cell is one cell, not "1 cells".
    const oneCell = Array.from({ length: 32 }, (_, row) => (row === 0 ? `2${'0'.repeat(31)}` : '0'.repeat(32)))
    assert.deepStrictEqual(
      summary(radar({ rows: oneCell })),
      { title: 'Radar picture', detail: 'Local · 1 cell with precipitation' },
    )
    // The refusal of a radar request comes back under `x`, never `r` (which is `>rain`).
    assert.deepStrictEqual(
      summary(MeshWXEncoder.notAvailable({ seq: 5, bot: BOT, request: '>x', reason: 4 })),
      { title: 'Not available', detail: 'x · asked too recently' },
    )
    // Revision 13: an older frame of a loop reads like any picture — its row's own time says
    // which one it is.
    assert.deepStrictEqual(
      summary(radar({ takenMinutes: 29_832_458 - 45 })),
      { title: 'Radar picture', detail: 'Local · 64 cells with precipitation' },
    )
  })

  /**
   * An alert that ended says why, when the bytes name a reason this build knows. A nibble it does
   * not is left to the bytes rather than turned into a claim.
   */
  it('a cancelled alert names its event and its reason', () => {
    const identity = { event: 3, office: 35, etn: 42 }
    const event = tables.eventLabel({ for: 3 })
    const cancel = (reason) => summary(MeshWXEncoder.cancel({ seq: 2, bot: BOT, identity, reason }))
    assert.deepStrictEqual(cancel(0), { title: 'Alert ended', detail: `${event} · cancelled` })
    assert.deepStrictEqual(cancel(1), { title: 'Alert ended', detail: `${event} · expired early` })
    assert.deepStrictEqual(cancel(2), { title: 'Alert ended', detail: `${event} · upgraded` })
    assert.deepStrictEqual(cancel(9), { title: 'Alert ended', detail: event })
  })

  /**
   * **The subject is named by the screen that shows that report**, never by words the traffic log
   * invented for itself — which is what `weather.traffic.subject.*` was, and why it is gone.
   * Nowcast, general and a code this build does not know share the bare noun: they have no screen
   * of their own to be named after.
   */
  it('every text subject is named the way the rest of the app names it', () => {
    const name = (subject) => WeatherTrafficSummary.subjectName(subject)
    assert.equal(name(0), t('weather.alertDetail.fullText'))
    assert.equal(name(1), t('weather.reports.discussion.title'))
    assert.equal(name(2), t('weather.reports.space.title'))
    assert.equal(name(3), t('weather.reports.storms.title'))
    assert.equal(name(4), t('weather.reports.rainfall.title'))
    assert.equal(name(5), t('weather.station.airportReports'))
    assert.equal(name(6), t('weather.reports.outlook.title'))
    assert.equal(name(7), t('weather.heard.text'))
    assert.equal(name(8), t('weather.heard.text'))
    assert.equal(name(200), t('weather.heard.text'))
    // The one mapping: the request log and the traffic log cannot disagree about a subject.
    for (const subject of [0, 1, 2, 3, 4, 5, 6, 7, 8, 200]) {
      assert.equal(WeatherCopy.textSubjectName(subject), name(subject))
    }
    // A chunk that lost its tail says so, after which part of the answer it is.
    const chunk = MeshWXEncoder.text({
      seq: 8, bot: BOT, subject: 3, group: 1, index: 1, total: 2, text: 'x', wasCut: true
    })
    assert.deepStrictEqual(
      summary(chunk),
      { title: 'Text report', detail: `${t('weather.reports.storms.title')} · part 2 of 2 · cut to fit` },
    )
  })

  /**
   * A forecast the bot picked the point for is the whole reason revision 10's `>f <lat>,<lon>`
   * exists, so the row says so rather than reading as a bare "Forecast".
   */
  it('a forecast names its point, or says the bot chose one', () => {
    const forecast = (pointIndex) => summary(MeshWXEncoder.forecast({
      seq: 5,
      bot: BOT,
      pointIndex,
      issuedMinutes: 29_823_900,
      firstPeriod: 0,
      periods: [{ high_f: 90, low_f: null, pop_pct: 10, sky: 0, thunder: false, wintry: false, windy: false, fog: false, wind_dir_deg: 180, wind_mph: 5 }]
    }))
    assert.deepStrictEqual(forecast(0xffff), { title: 'Forecast', detail: 'point chosen by the bot' })
    // Through `pointLabel`, the one function a bundle name is shown through (§3.1 U-25): the
    // table's own "Austin Camp Mabry-Travis TX" is not a name anybody reads.
    assert.equal(forecast(102).detail, WeatherNames.pointLabel(tables.point({ at: 102 }).name))
    assert.equal(forecast(102).detail, 'Austin Bergstrom, TX')
    // A point this bundle has no name for is still the number the radio sent.
    assert.equal(forecast(65_000).detail, '65000')
  })

  /** A coverage statement's one number; the circle and the zone runs are the radio page's. */
  it('a coverage statement counts the offices it names', () => {
    const coverage = (officeIndices) => summary(MeshWXEncoder.coverage({
      seq: 7, bot: BOT, latitude: 30.2672, longitude: -97.7431, radiusKilometres: 120,
      stationCap: 13, officeIndices, areas: []
    }))
    assert.deepStrictEqual(coverage([0, 1]), { title: 'What it covers', detail: '2 offices' })
    assert.deepStrictEqual(coverage([0]), { title: 'What it covers', detail: '1 office' })
    // Nothing to count is no claim, never "0 offices".
    assert.deepStrictEqual(coverage([]), { title: 'What it covers', detail: null })
  })

  it('a request names the phone that asked, and a sent one says it was this device', () => {
    const request = MeshWXEncoder.request({
      seq: 4, bot: BOT, senderPrefix: SENDER, timestamp: 1_789_660_000, text: '>o KAUS'
    })
    assert.deepStrictEqual(
      summary(request), { title: 'Request from 0A1B2C', detail: '>o KAUS' },
    )
    assert.deepStrictEqual(
      summary(request, { direction: WeatherTrafficEntry.sent }),
      { title: 'Request sent', detail: '>o KAUS' },
    )
  })

  /**
   * A scoped packet that is not the one the scope rides on cannot say what it covers, and "no
   * states" must not read as "nothing": its entries are real and are drawn, and which states were
   * asked for is simply not in these bytes (spec §12).
   */
  it('a scoped sweep names the states it covers, or says it cannot tell', () => {
    const scoped = (fields) => MeshWXEncoder.areaSweep({
      seq: 5,
      bot: BOT,
      builtMinutes: 29_823_900,
      group: 34,
      index: 0,
      total: 1,
      isScoped: true,
      entries: [{ event: 3, state: 42, county: false, start: 192, run: 6 }],
      ...fields
    })
    // In the packet's own order: this row is a reading of the bytes, not of a selection.
    assert.deepStrictEqual(
      summary(scoped({ scope: [tables.states.indexOf('TX'), tables.states.indexOf('OK')] })),
      { title: 'Alert map', detail: 'part 1 of 1 · 6 areas · Texas and Oklahoma' },
    )
    assert.deepStrictEqual(
      summary(scoped({ scope: [] })),
      { title: 'Alert map', detail: 'part 1 of 1 · 6 areas · scoped, states not in this packet' },
    )
  })

  /**
   * Every branch, once. `t` throws on an unknown key under test (docs/PORTING.md §6), so this is
   * what keeps a summary the timeline never happened to show from shipping without its words.
   */
  it('every kind of message has words for it', () => {
    const identity = { event: 3, office: 35, etn: 42 }
    const each = [
      MeshWXEncoder.warning({
        seq: 1, bot: BOT, identity, expiresMinutes: 29_823_945,
        areas: [{ state: 42, county: false, start: 192, run: 6 }]
      }),
      MeshWXEncoder.cancel({ seq: 2, bot: BOT, identity, reason: 0 }),
      MeshWXEncoder.digest({
        seq: 3, bot: BOT, nowMinutes: 29_823_900, feedHealth: 0,
        entries: [{ identity, expiresMinutes: 29_823_945 }]
      }),
      observations(4),
      MeshWXEncoder.forecast({
        seq: 5, bot: BOT, pointIndex: 102, issuedMinutes: 29_823_900, firstPeriod: 0,
        periods: [{ high_f: 90, low_f: null, pop_pct: 10, sky: 0, thunder: false, wintry: false, windy: false, fog: false, wind_dir_deg: 180, wind_mph: 5 }]
      }),
      MeshWXEncoder.forecast({
        seq: 6, bot: BOT, pointIndex: 0xffff, issuedMinutes: 29_823_900, firstPeriod: 0,
        periods: [{ high_f: 90, low_f: null, pop_pct: 10, sky: 0, thunder: false, wintry: false, windy: false, fog: false, wind_dir_deg: 180, wind_mph: 5 }]
      }),
      MeshWXEncoder.coverage({
        seq: 7, bot: BOT, latitude: 30.2672, longitude: -97.7431, radiusKilometres: 120,
        stationCap: 13, officeIndices: [0, 1], areas: []
      })
    ]
    for (const data of each) {
      const words = summary(data)
      assert.ok(words.title.length > 0, JSON.stringify(words))
    }
    // Every text subject, and every Not-available reason the spec defines plus one it does not.
    for (let subject = 0; subject <= 9; subject += 1) {
      const chunk = MeshWXEncoder.text({
        seq: 8, bot: BOT, subject, group: 1, index: 0, total: 1, text: 'x'
      })
      assert.ok(summary(chunk).detail.length > 0)
    }
    for (let reason = 0; reason <= 5; reason += 1) {
      const refusal = MeshWXEncoder.notAvailable({ seq: 9, bot: BOT, request: '>d', reason })
      assert.ok(summary(refusal).detail.startsWith('d · '))
    }
  })

  it('a datagram it cannot read still gets a line', () => {
    assert.deepStrictEqual(
      summary(Uint8Array.from([0x01, 0x7a, 0x4c, 0xa0, 0, 0])),
      { title: 'Unreadable', detail: null },
    )
    const foreign = WeatherTrafficSummary.make({
      entry: WeatherTrafficEntry.fromDatagram({
        id: 'x', at: 1, datagram: datagram(Uint8Array.from([1, 2]), { dataType: 0x1234 })
      }),
      tables
    })
    assert.deepStrictEqual(foreign, { title: 'Other data', detail: '0x1234' })
  })
})

// MARK: - What the service writes

describe('WeatherService channel traffic', () => {
  async function makeHarness() {
    const transport = new F.FakeWeatherTransport({ channelRequestsSupported: true })
    transport.setSecret(await WeatherChannel.secret(), 3)
    const clock = new F.WeatherTestClock()
    const service = new WeatherService({
      transport,
      store: new InMemoryWeatherStateStore(),
      trafficLog: new WeatherTrafficLog(),
      now: () => clock.now,
      tables,
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (id) => clock.clearTimeout(id)
    })
    return { transport, clock, service }
  }

  it('logs every datagram on the slot, decodable or not, duplicate or not', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()

    const batch = observations(17)
    h.transport.deliver(datagram(batch))
    await F.flush()
    // The bot's own "nobody echoed me" retransmission: the same bytes again.
    h.transport.deliver(datagram(batch))
    await F.flush()
    // Another application's datagram, and one whose body the codec refuses.
    h.transport.deliver(datagram(Uint8Array.from([9, 9]), { dataType: 0x1234 }))
    await F.flush()
    h.transport.deliver(datagram(Uint8Array.from([0x12, 0x7a, 0x4c, 0x40, 0x00])))
    await F.flush()

    const rows = h.service.trafficLog.entries()
    assert.equal(rows.length, 4, 'nothing on the slot is left out')
    assert.equal(rows[0].isDuplicate, false)
    assert.equal(rows[1].isDuplicate, true, 'a repeat is shown as one, not hidden')
    assert.equal(rows[2].dataType, 0x1234)
    assert.equal(rows[3].dataType, MeshWXWire.dataType)
    assert.ok(rows.every((row) => row.direction === 'received'))
    assert.ok(rows.every((row) => row.channelIndex === 3))
  })

  it('a datagram on another slot is not on this channel and is not logged', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    h.transport.setSecret(new Uint8Array(16).fill(0x42), 5)
    h.transport.deliver(datagram(observations(), { channelIndex: 5 }))
    await F.flush()
    assert.deepStrictEqual(h.service.trafficLog.entries(), [])
  })

  /**
   * "the bridge and replay transports send text, so log the encoded Request they stand for". The
   * fake radio here is one of those: it takes the text and hands nothing back, so the service
   * encodes the Request itself — the same seq, bot and text, with this radio's own key unknown.
   */
  it('logs the Request datagram this device sends, and its one resend', async () => {
    const h = await makeHarness()
    await h.service.startEventMonitoring()
    const request = WeatherRequest.parts({
      group: 212, indexes: [1, 4], of: { kind: 'areaSweep' }
    })
    await h.service.send(request, { to: F.bot })

    let rows = h.service.trafficLog.entries()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].direction, 'sent')
    assert.equal(rows[0].dataType, MeshWXWire.dataType)
    assert.equal(rows[0].type, 9, 'a Request, type 9')
    assert.equal(rows[0].pathLength, 0xff, 'flooded')
    assert.deepStrictEqual(
      WeatherTrafficSummary.make({ entry: rows[0], tables }),
      { title: 'Request sent', detail: '>part 212 1,4' },
    )

    // Spec §11: waited on for 10 s, then sent once more — the same bytes — and never a third time.
    await h.clock.advance(10)
    rows = h.service.trafficLog.entries()
    assert.equal(rows.length, 2)
    assert.equal(rows[1].hex, rows[0].hex, 'the resend is the same bytes')
  })
})
