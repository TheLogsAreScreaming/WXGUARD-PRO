// Port of MC1ServicesTests/Weather/WeatherRequestTests.swift (docs/PORTING.md).
//
// The request grammar is the one part of the protocol the app *sends*, so every line of the
// spec §14 table is pinned here byte for byte.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MeshWXWire } from '../src/meshwx/index.js'
import { WeatherPartsKind, WeatherReplyKind, WeatherRequest } from '../src/weather/index.js'

const R = WeatherRequest

describe('WeatherRequest', () => {
  it("every request renders the spec's wire text", () => {
    const expected = [
      [R.digest, '>d'],
      [R.activeWarnings, '>w'],
      [R.warning({ identity: 'SV.W.EWX.42' }), '>w SV.W.EWX.42'],
      [R.warningsTouching({ ugc: 'TXC453' }), '>w TXC453'],
      [R.warningsTouching({ ugc: 'TXZ192' }), '>w TXZ192'],
      [R.warningText({ identity: 'SV.W.EWX.42' }), '>wt SV.W.EWX.42'],
      [R.observations, '>o'],
      [R.observation({ station: 'KAUS' }), '>o KAUS'],
      [R.homeForecast, '>f'],
      [R.forecast({ point: 102 }), '>f 102'],
      [R.forecastForPlace('round rock tx'), '>f round rock tx'],
      [R.forecastDiscussion({ office: 'EWX' }), '>afd EWX'],
      [R.spaceWeather, '>space'],
      [R.stormReports({ state: 'TX' }), '>storm TX'],
      [R.rainfall({ state: 'TX' }), '>rain TX'],
      [R.metar({ station: 'KAUS' }), '>metar KAUS'],
      [R.taf({ station: 'KAUS' }), '>taf KAUS'],
      [R.hazardousOutlook, '>hwo'],
      [R.coverage, '>cov'],
      [R.areaSweep({ includesAdvisories: false }), '>wmap'],
      [R.areaSweep({ includesAdvisories: true }), '>wmap all'],
      // Revision 10.
      [R.areaSweep({ includesAdvisories: false, states: ['TX', 'OK'] }), '>wmap OKTX'],
      [R.areaSweep({ includesAdvisories: true, states: ['tx', 'ok'] }), '>wmap all OKTX'],
      [R.parts({ group: 212, indexes: [1, 4, 6], of: WeatherPartsKind.areaSweep }), '>part 212 1,4,6'],
      [R.forecastAt({ latitude: 35.687, longitude: -105.938 }), '>f 35.687,-105.938'],
      // Revision 11.
      [R.radar({ latitude: 30.27, longitude: -97.74 }), '>radar 30.270,-97.740'],
      [R.radar({ latitude: 30.27, longitude: -97.74, zoom: 2 }), '>radar 30.270,-97.740 z2']
    ]
    for (const [request, text] of expected) {
      assert.equal(R.wireText(request), text)
    }
  })

  // Spec §9 lists the letters a Not-available reply can carry: w, o, f, a, s, r, m, t, h, d.
  it('request letters are the first letter after the prefix', () => {
    assert.equal(R.requestLetter(R.digest), 'd')
    assert.equal(R.requestLetter(R.activeWarnings), 'w')
    assert.equal(R.requestLetter(R.warningText({ identity: 'SV.W.EWX.42' })), 'w')
    assert.equal(R.requestLetter(R.observation({ station: 'KAUS' })), 'o')
    assert.equal(R.requestLetter(R.forecastForPlace('austin tx')), 'f')
    assert.equal(R.requestLetter(R.forecastDiscussion({ office: 'EWX' })), 'a')
    assert.equal(R.requestLetter(R.spaceWeather), 's')
    assert.equal(R.requestLetter(R.stormReports({ state: 'TX' })), 's')
    assert.equal(R.requestLetter(R.rainfall({ state: 'TX' })), 'r')
    assert.equal(R.requestLetter(R.metar({ station: 'KAUS' })), 'm')
    assert.equal(R.requestLetter(R.taf({ station: 'KAUS' })), 't')
    assert.equal(R.requestLetter(R.hazardousOutlook), 'h')
    assert.equal(R.requestLetter(R.coverage), 'c')
    // The sweep rides on `w` like every other warning request, so a refusal for it comes back
    // under the same letter (spec §9).
    assert.equal(R.requestLetter(R.areaSweep({ includesAdvisories: false })), 'w')
    assert.equal(R.requestLetter(R.areaSweep({ includesAdvisories: true })), 'w')
    // Revision 11's exception, and the only one: `>radar` is refused under `x`, because `r` is
    // already `>rain` and a refusal names no argument (spec §13).
    assert.equal(R.requestLetter(R.radar({ latitude: 30.27, longitude: -97.74 })), 'x')
    assert.equal(R.requestLetter(R.radar({ latitude: 30.27, longitude: -97.74, zoom: 3 })), 'x')
  })

  // Spec §10: a statement describes the bot that sent it, so another bot's — or another
  // bot's answer to somebody else — says nothing about this one's area.
  it('only the bot asked can answer for its own area', () => {
    assert.equal(R.acceptsAnswerFromAnyBot(R.coverage), false)
    assert.equal(R.acceptsAnswerFromAnyBot(R.observations), false)
    assert.equal(R.acceptsAnswerFromAnyBot(R.observation({ station: 'KAUS' })), true)
    // Spec §12: a sweep is one bot's reading of the country, cut where its own feed runs out.
    assert.equal(R.acceptsAnswerFromAnyBot(R.areaSweep({ includesAdvisories: false })), false)
    assert.equal(R.acceptsAnswerFromAnyBot(R.areaSweep({ includesAdvisories: true })), false)
    // Spec §13: a tile is a named square of the earth cut from a national mosaic, so another
    // bot's picture of it is this question's answer.
    assert.equal(R.acceptsAnswerFromAnyBot(R.radar({ latitude: 30.27, longitude: -97.74 })), true)
  })

  it('expected replies carry the station, point and subject the request named', () => {
    assert.deepStrictEqual(R.expectedReply(R.digest), WeatherReplyKind.digest)
    assert.deepStrictEqual(R.expectedReply(R.activeWarnings), WeatherReplyKind.warnings)
    // Only the bare `>w` ends with a digest; the other two are that warning, or warnings naming
    // that area.
    assert.deepStrictEqual(
      R.expectedReply(R.warning({ identity: 'SV.W.EWX.42' })),
      WeatherReplyKind.warning({ identity: 'SV.W.EWX.42' })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.warningsTouching({ ugc: 'TXZ192' })),
      WeatherReplyKind.warningsTouching({ ugc: 'TXZ192' })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.observations), WeatherReplyKind.observations({ station: null })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.observation({ station: 'KAUS' })),
      WeatherReplyKind.observations({ station: 'KAUS' })
    )
    assert.deepStrictEqual(R.expectedReply(R.homeForecast), WeatherReplyKind.forecast({ point: null }))
    assert.deepStrictEqual(
      R.expectedReply(R.forecast({ point: 102 })), WeatherReplyKind.forecast({ point: 102 })
    )
    // A place is resolved by the bot; the point that comes back may even be 0xFFFF.
    assert.deepStrictEqual(
      R.expectedReply(R.forecastForPlace('round rock tx')), WeatherReplyKind.forecast({ point: null })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.warningText({ identity: 'x' })), WeatherReplyKind.text({ subject: 0 })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.forecastDiscussion({ office: 'EWX' })), WeatherReplyKind.text({ subject: 1 })
    )
    assert.deepStrictEqual(R.expectedReply(R.spaceWeather), WeatherReplyKind.text({ subject: 2 }))
    assert.deepStrictEqual(
      R.expectedReply(R.stormReports({ state: 'TX' })), WeatherReplyKind.text({ subject: 3 })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.rainfall({ state: 'TX' })), WeatherReplyKind.text({ subject: 4 })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.metar({ station: 'KAUS' })), WeatherReplyKind.text({ subject: 5 })
    )
    assert.deepStrictEqual(
      R.expectedReply(R.taf({ station: 'KAUS' })), WeatherReplyKind.text({ subject: 5 })
    )
    assert.deepStrictEqual(R.expectedReply(R.hazardousOutlook), WeatherReplyKind.text({ subject: 6 }))
    assert.deepStrictEqual(R.expectedReply(R.coverage), WeatherReplyKind.coverage)
    // Both scopes expect the same answer: the sweep's own flag says which one arrived.
    assert.deepStrictEqual(
      R.expectedReply(R.areaSweep({ includesAdvisories: false })), WeatherReplyKind.areaSweep
    )
    assert.deepStrictEqual(
      R.expectedReply(R.areaSweep({ includesAdvisories: true })), WeatherReplyKind.areaSweep
    )
    // Revision 11: the tile is worked out from the coordinate, because the lattice is fixed.
    assert.deepStrictEqual(
      R.expectedReply(R.radar({ latitude: 30.27, longitude: -97.74 })),
      WeatherReplyKind.radar({ tile: { south: 29, west: -99, zoom: 0 } })
    )
  })

  // Two scopes are two requests: one on the air must not settle the other's button, and the
  // request log has to be able to say which one was asked for.
  it('the two map scopes are distinct requests', () => {
    assert.equal(
      R.isEqual(R.areaSweep({ includesAdvisories: false }), R.areaSweep({ includesAdvisories: true })),
      false
    )
    assert.notDeepStrictEqual(
      R.areaSweep({ includesAdvisories: false }), R.areaSweep({ includesAdvisories: true })
    )
  })

  // MARK: - Revision 10

  /**
   * The compact upper-case sorted form is what makes two taps that mean the same thing one
   * request: the wire text, the key and the answer slot are all built from it, so a selection of
   * "tx, ok" and one of "OK TX" are recognised as the same question by every one of them.
   */
  it('a sweep selection is normalised once, for the wire and for the key alike', () => {
    const one = R.areaSweep({ includesAdvisories: false, states: ['tx', 'OK', 'tx'] })
    const other = R.areaSweep({ includesAdvisories: false, states: [' ok ', 'Tx'] })
    assert.deepStrictEqual(one.states, ['OK', 'TX'])
    assert.equal(R.wireText(one), R.wireText(other))
    assert.equal(R.isEqual(one, other), true)
    assert.equal(R.key(one), 'areaSweep:narrow:OKTX')

    // A different selection is a different request, whatever the level.
    assert.equal(R.isEqual(one, R.areaSweep({ includesAdvisories: false, states: ['TX'] })), false)
    assert.equal(R.isEqual(one, R.areaSweep({ includesAdvisories: false })), false)
  })

  /**
   * A request written into the log, into a text assembly or into a settled outcome before
   * revision 10 has no `states` at all, and an area sweep without one was the national sweep it
   * was when it was written.
   */
  it('an area sweep persisted before revision 10 reads as national', () => {
    const old = { kind: 'areaSweep', includesAdvisories: true }
    assert.deepStrictEqual(R.areaSweepStates(old), [])
    assert.equal(R.wireText(old), '>wmap all')
    assert.equal(R.key(old), 'areaSweep:all:')
    assert.equal(R.isEqual(old, R.areaSweep({ includesAdvisories: true })), true)
  })

  it('part indexes are ascending and without duplicates', () => {
    const request = R.parts({ group: 7, indexes: [6, 1, 4, 1], of: WeatherPartsKind.text({ subject: 1 }) })
    assert.deepStrictEqual(request.indexes, [1, 4, 6])
    assert.equal(R.wireText(request), '>part 7 1,4,6')
    assert.equal(R.requestLetter(request), 'p')
    assert.deepStrictEqual(R.expectedReply(request), WeatherReplyKind.parts({ group: 7 }))
    assert.equal(R.acceptsAnswerFromAnyBot(request), false, 'only the bot asked holds that cache')
  })

  /**
   * "The kind is for the log's wording only." The bot's parts cache is keyed by the group byte
   * alone, across sweeps and texts alike, so two `>part 212 1` are one request whatever this
   * phone calls them — which is what the identical wire text already says.
   */
  it('the parts kind is not part of the request identity', () => {
    const sweep = R.parts({ group: 212, indexes: [1], of: WeatherPartsKind.areaSweep })
    const text = R.parts({ group: 212, indexes: [1], of: WeatherPartsKind.text({ subject: 0 }) })
    assert.equal(R.wireText(sweep), R.wireText(text))
    assert.equal(R.isEqual(sweep, text), true)
  })

  it('a coordinate forecast is three decimals, and its own key', () => {
    const santaFe = R.forecastAt({ latitude: 35.687, longitude: -105.938 })
    assert.equal(R.wireText(santaFe), '>f 35.687,-105.938')
    assert.equal(R.requestLetter(santaFe), 'f')
    // Trailing zeros are kept: the text is a function of the number, not of how it was written.
    assert.equal(R.wireText(R.forecastAt({ latitude: 30, longitude: -97.5 })), '>f 30.000,-97.500')
    // Rounded to the wire's precision, so the same town twice is the same request.
    assert.equal(R.key(R.forecastAt({ latitude: 35.6871, longitude: -105.9384 })), R.key(santaFe))
    assert.deepStrictEqual(R.expectedReply(santaFe), WeatherReplyKind.forecast({ point: null }))
    assert.equal(R.acceptsAnswerFromAnyBot(santaFe), false)
  })

  // MARK: - Revision 11

  /**
   * Spec §13: the zoom is left off at 0, because that is the form the bot's grammar leads with
   * and `z0` would be the same request in bytes nobody else sends. The longest `>radar` there
   * is, `>radar -30.270,-197.740 z3`, is 26 of the 40 bytes a Request datagram carries (§11).
   */
  it('a radar request is a coordinate and, past zoom 0, a width', () => {
    const austin = R.radar({ latitude: 30.27, longitude: -97.74 })
    assert.equal(R.wireText(austin), '>radar 30.270,-97.740')
    assert.equal(R.wireText(R.radar({ latitude: 30.27, longitude: -97.74, zoom: 0 })), R.wireText(austin))
    for (const zoom of [1, 2, 3]) {
      assert.equal(
        R.wireText(R.radar({ latitude: 30.27, longitude: -97.74, zoom })),
        `>radar 30.270,-97.740 z${zoom}`
      )
    }
    const longest = R.wireText(R.radar({ latitude: -30.27, longitude: -197.74, zoom: 3 }))
    assert.equal(longest, '>radar -30.270,-197.740 z3')
    assert.ok(new TextEncoder().encode(longest).length <= MeshWXWire.maxRequestTextBytes)
  })

  /**
   * Two coordinates on one tile are one *answer* — that is what the service's slot is keyed by —
   * but two questions: the pending list, the log and the five-second spacing all key on what was
   * asked, and a width is part of the question.
   */
  it('a radar request is keyed by the coordinate and the width', () => {
    const austin = R.radar({ latitude: 30.27, longitude: -97.74 })
    assert.equal(R.key(austin), 'radar:30.270,-97.740:z0')
    assert.equal(R.isEqual(austin, R.radar({ latitude: 30.2701, longitude: -97.7404 })), true)
    assert.equal(R.isEqual(austin, R.radar({ latitude: 30.27, longitude: -97.74, zoom: 1 })), false)
    assert.equal(R.isEqual(austin, R.radar({ latitude: 30.51, longitude: -97.68 })), false)
  })

  // MARK: - Revision 13

  /** 2026-09-20 23:38 and 23:53 UTC, as Unix minutes: the pictures of the vectors' squall line. */
  const at2338 = 29832458
  const at2353 = at2338 + 15

  /**
   * "No `z-1`": the detail level of revision 13's first draft was removed, and a radar ask is
   * zoom 0 to 3 again. A zoom below 0 writes nothing after the place, which is the zoom 0 form,
   * and expects the zoom 0 tile, as the lattice clamps it. The reply is the tile alone, as the
   * Swift's `.radar(tile:)` is: there is no fallback square to be settled by.
   */
  it('there is no detail level: no z-1 on the wire, and the reply is the tile alone', () => {
    const dallas = R.radar({ latitude: 32.78, longitude: -96.8, zoom: -1 })
    assert.equal(R.wireText(dallas), '>radar 32.780,-96.800')
    assert.equal(R.wireText(R.radarLoop({ latitude: 32.78, longitude: -96.8, zoom: -1 })), '>radar 32.780,-96.800 loop')
    assert.deepStrictEqual(
      R.expectedReply(dallas), WeatherReplyKind.radar({ tile: { south: 32, west: -98, zoom: 0 } })
    )
    assert.deepStrictEqual(Object.keys(WeatherReplyKind.radar({ tile: { south: 32, west: -98, zoom: 0 } })), ['kind', 'tile'])
    // A loop is settled the same way, by its first frame.
    assert.deepStrictEqual(
      R.expectedReply(R.radarLoop({ latitude: 32.78, longitude: -96.8, zoom: 1, held: [at2338] })),
      R.expectedReply(R.radar({ latitude: 32.78, longitude: -96.8, zoom: 1 }))
    )
  })

  /**
   * The `request_radar_loop` vector: the held pictures as UTC `HHMM`, **newest first**, whatever
   * order the caller held them in. Minutes alone would not do: at 15-minute steps the newest
   * picture and the one an hour before it end in the same two digits.
   */
  it('the last hour lists the pictures held as UTC HHMM, newest first', () => {
    assert.equal(R.utcHourMinute(at2338), '2338')
    assert.equal(R.utcHourMinute(at2353), '2353')
    assert.equal(R.utcHourMinute(at2338 + 22), '0000', 'midnight UTC')
    assert.equal(R.utcHourMinute(at2338 + 30), '0008')

    const austin = R.radarLoop({ latitude: 30.27, longitude: -97.74, held: [at2338, at2353] })
    assert.equal(R.wireText(austin), '>radar 30.270,-97.740 loop 2353 2338')
    assert.equal(R.wireText(R.radarLoop({ latitude: 30.27, longitude: -97.74 })), '>radar 30.270,-97.740 loop')
    assert.equal(
      R.wireText(R.radarLoop({ latitude: 30.27, longitude: -97.74, zoom: 1, held: [at2338 + 30] })),
      '>radar 30.270,-97.740 z1 loop 0008'
    )
    assert.equal(
      R.wireText(R.radarLoop({ latitude: 30.27, longitude: -97.74, zoom: 3, held: [at2353] })),
      '>radar 30.270,-97.740 z3 loop 2353'
    )
    // The same picture twice (two bots' copies) is listed once.
    assert.equal(
      R.wireText(R.radarLoop({ latitude: 30.27, longitude: -97.74, held: [at2353, at2353] })),
      '>radar 30.270,-97.740 loop 2353'
    )
  })

  /**
   * "A request is at most 40 bytes, and that limit stays. The app lists its held pictures newest
   * first, as many as fit." `>radar 30.270,-97.740 loop` is 26 bytes, so two always fit there; a
   * held picture left off is sent again, which costs a packet and breaks nothing.
   */
  it('the last hour lists only as many held pictures as fit in 40 bytes', () => {
    const hour = [0, 15, 30, 45].map((ago) => at2353 - ago)
    const austin = R.wireText(R.radarLoop({ latitude: 30.27, longitude: -97.74, held: hour }))
    assert.equal(austin, '>radar 30.270,-97.740 loop 2353 2338')
    assert.equal(austin.length, 36, 'a third would be 41')

    const west = R.wireText(R.radarLoop({ latitude: 30.27, longitude: -100.74, zoom: 1, held: hour }))
    assert.equal(west, '>radar 30.270,-100.740 z1 loop 2353 2338')
    assert.equal(west.length, MeshWXWire.maxRequestTextBytes, 'exactly the budget')

    const longest = R.wireText(R.radarLoop({ latitude: -30.27, longitude: -197.74, zoom: 3, held: hour }))
    assert.equal(longest, '>radar -30.270,-197.740 z3 loop 2353', 'the newest kept')

    // The shortest coordinate fits three, and never more than the five the loop can hold.
    const shortest = R.wireText(R.radarLoop({ latitude: 0, longitude: 0, held: hour }))
    assert.equal(shortest, '>radar 0.000,0.000 loop 2353 2338 2323')
    for (const text of [austin, west, longest, shortest]) {
      assert.ok(new TextEncoder().encode(text).length <= MeshWXWire.maxRequestTextBytes, text)
    }
  })

  /**
   * A loop is refused under `x` like any radar ask and settled by any bot's frame of the square.
   * Its key is the Swift's synthesised `Hashable`: the coordinate, the width and the held list,
   * because the same square asked for while holding other pictures is other bytes on the air.
   */
  it('the last hour is an x request, keyed by the coordinate, the width and what is held', () => {
    const loop = R.radarLoop({ latitude: 30.27, longitude: -97.74, held: [at2353] })
    assert.equal(R.requestLetter(loop), 'x')
    assert.equal(R.acceptsAnswerFromAnyBot(loop), true)
    assert.equal(R.key(loop), `radarLoop:30.270,-97.740:z0:${at2353}`)
    assert.equal(R.isEqual(loop, R.radarLoop({ latitude: 30.2701, longitude: -97.74, held: [at2353] })), true)
    assert.equal(R.isEqual(loop, R.radarLoop({ latitude: 30.27, longitude: -97.74, held: [] })), false)
    assert.equal(R.isEqual(loop, R.radarLoop({ latitude: 30.27, longitude: -97.74, zoom: 1, held: [at2353] })), false)
    assert.equal(R.isEqual(loop, R.radar({ latitude: 30.27, longitude: -97.74 })), false)
    // Plain data: it survives the request log's JSON.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(loop)), loop)
  })
})
