// Port of MC1Services/Tests/MeshWXTests/MeshWXVectorTests.swift
//
// Conformance against the bot's own wire vectors (spec revision 9).
//
// The kit's own bar: "your decoder is correct when it turns every `hex` into the matching
// `decoded` JSON, and your encoder reproduces the same `hex`." Both halves run here — no
// round-trip-only shortcut, because a codec that is wrong in both directions round-trips
// perfectly.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  decode,
  encode,
  hexToBytes,
  bytesToHex,
  MeshWXWire,
  MeshWXMessageType,
  MeshWXTypeNames,
  MeshWXCoverage,
  MeshWXObservations,
  MeshWXStationObservation,
  MeshWXWarning,
  MeshWXRequest,
  MeshWXEncoder,
  MeshWXAreaSweep,
  MeshWXRadar,
  MeshWXRadarTile,
} from '../src/meshwx/index.js';
import { WeatherRequest } from '../src/weather/index.js';
import { vectors, fileCount, vector, requestDigestHex, sharedTables } from './helpers/meshwx-vectors.js';

describe('MeshWX vectors', () => {
  let tables;
  before(async () => { tables = await sharedTables(); });

  /**
   * Every vector in the file reaches the tests below. No fixed count, since the bot adds
   * vectors.
   */
  test('fixtureIsPresent', () => {
    assert.ok(fileCount > 0, 'the vector file did not load');
    assert.equal(vectors.length, fileCount, 'a vector the fixture cannot read');
    assert.equal(new Set(vectors.map((v) => v.name)).size, fileCount, 'vector names are unique');
    // Revision 2's whole-day forecast.
    assert.ok(vectors.some((v) => v.name === 'forecast_seven_days'));
    // Revision 4's coverage statement: WX-AUS's real 39-byte message.
    assert.ok(vectors.some((v) => v.name === 'coverage_wx_aus'));
    // Revision 5's two times, each beside the revision 4 form of the same message.
    assert.ok(vectors.some((v) => v.name === 'observations_three_stations_ages'));
    assert.ok(vectors.some((v) => v.name === 'severe_thunderstorm_warning_issued'));
    // Revision 10's three: the scoped sweep, and the two new request texts.
    assert.ok(vectors.some((v) => v.name === 'area_sweep_scoped_packet0'));
    assert.ok(vectors.some((v) => v.name === 'request_parts'));
    assert.ok(vectors.some((v) => v.name === 'request_forecast_at'));
    // Revision 11's four: a real tile, a coarse and partial one, the request and the refusal.
    assert.ok(vectors.some((v) => v.name === 'radar_tile'));
    assert.ok(vectors.some((v) => v.name === 'radar_tile_coarse_partial'));
    assert.ok(vectors.some((v) => v.name === 'request_radar'));
    assert.ok(vectors.some((v) => v.name === 'not_available_radar'));
    // Revision 12's one: a watch issued a day and a half before it takes effect.
    assert.ok(vectors.some((v) => v.name === 'warning_upcoming_watch'));
    // Revision 13's one: the loop ask. The three detail vectors of its first draft went with the
    // detail level (type 12), and none may come back without a type to decode them as.
    assert.ok(vectors.some((v) => v.name === 'request_radar_loop'));
    for (const name of ['radar_detail_tile', 'radar_detail_coarse_partial', 'request_radar_detail']) {
      assert.ok(!vectors.some((v) => v.name === name), `${name} was removed with the detail level`);
    }
    assert.ok(vectors.every((v) => v.decoded?.type !== 12), 'type 12 is free again');
  });

  describe('decodesToTheDocumentedFields', () => {
    for (const entry of vectors) {
      test(entry.name, () => {
        const data = hexToBytes(entry.hex);
        const message = decode(data);
        const want = entry.decoded;

        // Header, for every type.
        assert.equal(message.seq, want.seq);
        assert.equal(message.bot, want.bot);
        assert.equal(message.type, want.type);
        assert.equal(message.flags, want.flags);
        assert.equal(message.name, MeshWXTypeNames[want.type]);
        assert.notEqual(message.name, 'unknown', `vector ${entry.name} decoded as an unknown type`);

        // PORTING §5: the decoded message *is* the vector's object, so one deep comparison is
        // the field-by-field check the Swift spells out per type — polygon vertices included,
        // exactly and not within a tolerance, because the wire is a fixed-point grid and the
        // decoder reconstructs it in integers.
        assert.deepStrictEqual(message, want);
      });
    }
  });

  /**
   * Spec §10: WX-AUS's real message is 39 bytes — 14 fixed, four offices, five runs — and it
   * says the bot covers its own home county, which is what the app used to get wrong.
   */
  test('theCoverageVectorIsTheMessageTheSpecDescribes', () => {
    const entry = vector('coverage_wx_aus');
    assert.ok(entry);
    const data = hexToBytes(entry.hex);
    assert.equal(data.length, 39);
    const statement = decode(data);
    assert.equal(statement.type, MeshWXMessageType.coverage);
    assert.deepStrictEqual(
      MeshWXCoverage.centre(statement), { latitude: 30.2672, longitude: -97.7431 },
    );
    assert.equal(statement.radius_km, 120);
    // 13, not 14: from revision 5 WX-AUS's hourly batch carries the per-station ages, and the
    // nibble block costs it its farthest station (spec §6.1).
    assert.equal(statement.stations, 13);
    assert.ok(MeshWXCoverage.isComplete(statement));
    assert.ok(!MeshWXCoverage.hasNoAreaFilter(statement));

    assert.deepStrictEqual(
      statement.offices.map((index) => tables.officeCode(index)), ['EWX', 'FWD', 'HGX', 'SJT'],
    );
    assert.equal(statement.areas.length, 5);
    const states = tables.states;
    assert.ok(MeshWXCoverage.covers(statement, { ugc: 'TXZ192', states }), "Travis, the bot's own county");
    assert.ok(MeshWXCoverage.covers(statement, { ugc: 'TXZ155', states }));
    assert.ok(MeshWXCoverage.covers(statement, { ugc: 'TXZ225', states }));
    assert.ok(!MeshWXCoverage.covers(statement, { ugc: 'TXZ198', states }), 'between two runs');
    assert.ok(!MeshWXCoverage.covers(statement, { ugc: 'TXZ226', states }), 'one past the last run');
  });

  /**
   * Spec §6.1: the revision 5 batch is the revision 4 one with two bytes of nibbles appended and
   * one flag bit set — 0, 20 and 110 minutes as 0x20, 0x0b — which is the whole compatibility
   * claim, and the reason an old decoder reads the new bytes unchanged.
   */
  test('theAgesVectorIsTheOldBatchWithANibbleBlockAppended', () => {
    const oldBytes = hexToBytes(vector('observations_three_stations').hex);
    const newBytes = hexToBytes(vector('observations_three_stations_ages').hex);
    assert.equal(oldBytes.length, 42);
    assert.equal(newBytes.length, 44, 'three stations cost ceil(3 / 2) = 2 bytes');
    // Past the header — a different seq and the new flag bit — the two are byte for byte the
    // same until the block the old message does not have.
    assert.deepStrictEqual(
      newBytes.subarray(4, oldBytes.length), oldBytes.subarray(4),
    );
    assert.deepStrictEqual(newBytes.subarray(newBytes.length - 2), Uint8Array.from([0x20, 0x0b]));

    const batch = decode(newBytes);
    assert.notEqual(batch.flags & MeshWXWire.flagObservationAges, 0);
    assert.ok(MeshWXObservations.carriesAges(batch));
    assert.deepStrictEqual(batch.stations.map((s) => s.age_min), [0, 20, 110]);
    // Each station's own time, which is what "as of" reads (spec §18.1). The newest is the batch
    // time itself, and the oldest is nearly two hours behind it.
    assert.deepStrictEqual(
      batch.stations.map((s) => MeshWXObservations.reportMinutes(batch, { for: s })),
      [29_823_893, 29_823_873, 29_823_783],
    );
    assert.deepStrictEqual(
      batch.stations.map((s) => MeshWXStationObservation.isAgeSaturated(s)),
      [false, false, false],
    );

    const oldBatch = decode(oldBytes);
    assert.ok(!MeshWXObservations.carriesAges(oldBatch));
    assert.ok(oldBatch.stations.every((s) => s.age_min === null));
    // Without the ages every station reads as the batch time, which is all that message says.
    assert.ok(oldBatch.stations.every(
      (s) => MeshWXObservations.reportMinutes(oldBatch, { for: s }) === 29_823_893,
    ));
  });

  /**
   * Spec §3: the same severe thunderstorm warning, 53 bytes rather than 51, with the issue time
   * as the last two bytes — 21 minutes before the expiry — and flags nibble bit 1 set.
   */
  test('theIssuedVectorIsTheOldWarningWithTwoTrailingBytes', () => {
    const oldBytes = hexToBytes(vector('severe_thunderstorm_warning_polygon').hex);
    const newBytes = hexToBytes(vector('severe_thunderstorm_warning_issued').hex);
    assert.equal(oldBytes.length, 51);
    assert.equal(newBytes.length, 53);
    assert.deepStrictEqual(newBytes.subarray(4, oldBytes.length), oldBytes.subarray(4));
    assert.deepStrictEqual(
      newBytes.subarray(newBytes.length - 2), Uint8Array.from([0x15, 0x00]),
      '21 minutes, little-endian',
    );

    const warning = decode(newBytes);
    assert.notEqual(warning.flags & MeshWXWire.flagWarningIssued, 0);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(warning), 21);
    assert.equal(MeshWXWarning.issuedMinutes(warning), warning.expires_min - 21);
    assert.equal(MeshWXWarning.issuedMinutes(warning), 29_823_924);
    assert.ok(!MeshWXWarning.isIssueTimeSaturated(warning));
    // The polygon and the areas are untouched: the time went on the end, not into them.
    assert.equal(warning.polygon.length, 6);
    assert.equal(warning.areas.length, 2);

    const oldWarning = decode(oldBytes);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(oldWarning), null);
    assert.equal(MeshWXWarning.issuedMinutes(oldWarning), null);
  });

  /**
   * Spec §3, revision 12: FA.A.EWX.8, issued at `NOW`, takes effect 2016 minutes later
   * (33 h 36 min) and expires 4896 minutes after issuance. The start is the last two bytes —
   * 2880 minutes before the expiry — after the issue time, with no flag bit of its own.
   */
  test('theUpcomingWatchVectorCarriesItsStartAfterTheIssueTime', () => {
    const entry = vector('warning_upcoming_watch');
    assert.ok(entry);
    const data = hexToBytes(entry.hex);
    assert.equal(data.length, 28);
    assert.deepStrictEqual(data.subarray(data.length - 4), Uint8Array.from([0x20, 0x13, 0x40, 0x0b]),
      '4896 then 2880, little-endian');

    const watch = decode(data);
    assert.deepStrictEqual({ event: watch.event, office: watch.office, etn: watch.etn }, { event: 10, office: 35, etn: 8 });
    assert.equal(tables.vtec({ for: watch.event }), 'FA.A');
    assert.equal(tables.officeCode(watch.office), 'EWX');
    assert.equal(watch.flags & MeshWXWire.flagWarningIssued, MeshWXWire.flagWarningIssued);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(watch), 4896);
    assert.equal(MeshWXWarning.beginsBeforeMinutes(watch), 2880);
    assert.equal(MeshWXWarning.issuedMinutes(watch), 29_823_900);
    assert.equal(MeshWXWarning.beginsMinutes(watch), 29_823_900 + 2016, '33 h 36 min after issuance');
    assert.equal(watch.begins_min, entry.decoded.begins_min);
    assert.equal(watch.expires_min, 29_823_900 + 4896);
    assert.deepStrictEqual(encode(watch), data);

    // What a revision 11 app saw: the same message ending at the issue time.
    const old = decode(data.subarray(0, data.length - 2));
    assert.equal(old.begins_min, null);
    assert.equal(old.issued_min, watch.issued_min);

    // Every other warning vector says it was in effect from issuance.
    for (const other of vectors) {
      if (other.decoded.type !== MeshWXMessageType.warning || other.name === entry.name) continue;
      assert.equal(other.decoded.begins_min, null, other.name);
      assert.equal(decode(hexToBytes(other.hex)).begins_min, null, other.name);
    }
  });

  /**
   * Spec §11: the app's own `>d`, as the sixteen bytes the spec prints — the one message this
   * app transmits, so the encoder's output is checked against the publisher's hex byte for byte
   * in both directions.
   */
  test('theRequestVectorIsTheSixteenBytesTheSpecPrints', () => {
    const want = hexToBytes(requestDigestHex);
    assert.deepStrictEqual(want, Uint8Array.from([
      0x01, 0x1d, 0x04, 0x90, 0x01, 0x02, 0x03, 0x04,
      0x05, 0x06, 0x60, 0x0b, 0xac, 0x6a, 0x3e, 0x64,
    ]));
    assert.equal(want.length, 16);

    const request = MeshWXRequest.make({
      seq: 1,
      botID: 0x041d,
      senderPrefix: Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
      timestamp: 1_789_660_000,
      text: '>d',
    });
    assert.deepStrictEqual(MeshWXRequest.encode(request), want);
    assert.deepStrictEqual(MeshWXEncoder.request({
      seq: 1,
      bot: 0x041d,
      senderPrefix: Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
      timestamp: 1_789_660_000,
      text: '>d',
    }), want);

    const message = decode(want);
    assert.equal(message.seq, 1);
    assert.equal(message.bot, 0x041d);
    assert.equal(message.type, 9);
    assert.equal(message.name, 'request');
    assert.equal(message.flags, 0);
    assert.deepStrictEqual(message, request);
    // The header fields ride on the body too, and a re-encode takes them from the header.
    assert.deepStrictEqual(encode(message), want);
  });

  describe('reEncodesToTheSameBytes', () => {
    for (const entry of vectors) {
      test(entry.name, () => {
        assert.equal(bytesToHex(encode(decode(hexToBytes(entry.hex)))), entry.hex);
      });
    }
  });

  /**
   * Spec §12: where the vector prints them, a sweep entry's codes are checked against the
   * publisher's own expansion rather than against this implementation's arithmetic. The
   * published file prints no `ugcs` key today, so this also proves the sweep's runs expand to
   * the codes the spec's worked example names.
   */
  /**
   * Spec §12, revision 10. The publisher's own scoped packet, read against the note it carries:
   * "`total` is 0x81: bit 7 scoped, one packet. The first two entries are the scope, Oklahoma and
   * Texas; Oklahoma has no alert entry, which says it is clear at this level."
   *
   * That last clause is the whole reason the scope is on the wire, so it is what this pins: a
   * state named in the scope with nothing in `entries` is an answer, not a silence.
   */
  test('theScopedSweepVectorNamesAStateWithNothingActive', () => {
    const entry = vector('area_sweep_scoped_packet0');
    assert.ok(entry);
    const data = hexToBytes(entry.hex);
    assert.equal(data[10], 0x81, 'bit 7 scoped, one packet');

    const sweep = decode(data);
    assert.equal(sweep.scoped, true);
    assert.equal(sweep.total, 1, 'the count is the low nibble, never the whole byte');
    assert.deepStrictEqual(
      sweep.scope.map((index) => tables.states[index]), ['OK', 'TX'],
    );
    assert.ok(sweep.entries.every((one) => one.event !== 0), 'entries are alert entries only');
    assert.ok(sweep.entries.every((one) => tables.states[one.state] === 'TX'));
    // Oklahoma is in the scope and in nothing else: nothing is active there at this level.
    const oklahoma = tables.states.indexOf('OK');
    assert.ok(sweep.scope.includes(oklahoma));
    assert.ok(!sweep.entries.some((one) => one.state === oklahoma));
    assert.equal(bytesToHex(encode(sweep)), entry.hex);
  });

  /**
   * Spec §14, revision 10: the two new `>` lines, as the publisher prints them. The app sends
   * these, so the encoder's bytes are checked against the publisher's hex in both directions.
   */
  test('theRevisionTenRequestVectorsRoundTrip', () => {
    for (const [name, text] of [['request_parts', '>part 212 1,4,6'], ['request_forecast_at', '>f 35.687,-105.938']]) {
      const entry = vector(name);
      assert.ok(entry, name);
      const want = hexToBytes(entry.hex);
      const message = decode(want);
      assert.equal(message.name, 'request');
      assert.equal(message.text, text);
      assert.deepStrictEqual(MeshWXEncoder.request({
        seq: message.seq,
        bot: message.bot,
        senderPrefix: hexToBytes(message.sender),
        timestamp: message.ts,
        text: message.text,
      }), want);
    }
  });

  /**
   * Spec §13, revision 11: the publisher's own tile, a real one — Dallas under the squall line
   * of 20 September 2026, 131 bytes for a thousand cells.
   *
   * The two claims worth pinning beyond the deep comparison every vector already gets: the
   * lattice really does put this tile under the coordinate that was asked about, and the cells
   * are the picture the bot cut rather than an arrangement that happens to round trip.
   */
  test('theRadarTileVectorIsTheTileTheSpecDescribes', () => {
    const entry = vector('radar_tile');
    assert.ok(entry);
    const data = hexToBytes(entry.hex);
    assert.equal(data.length, 131);

    const radar = decode(data);
    assert.equal(radar.type, MeshWXMessageType.radar);
    assert.equal(radar.taken_min, 29832458, '2026-09-20 23:38 UTC, printed on the picture');
    assert.equal(radar.source, 1, 'off the dish');
    assert.equal(radar.coarse, false);
    assert.equal(radar.partial, false);
    // `>radar 32.780,-96.800` is the request vector, and this is the tile it answers.
    assert.deepStrictEqual(
      MeshWXRadarTile.containing({ latitude: 32.78, longitude: -96.8, zoom: 0 }),
      MeshWXRadar.tile(radar),
    );
    assert.equal(tables.radarProduct({ at: radar.product }), 'RADSTHPL');
    // The bot's own count over this tile: a squall line, not a washout.
    assert.equal(MeshWXRadar.wetCells(radar), 380);
    assert.equal(MeshWXRadar.level(radar, { row: 19, col: 19 }), 1, 'light rain over Dallas');
    assert.equal(bytesToHex(encode(radar)), entry.hex);
  });

  /**
   * The coarse and partial form, which is the whole of revision 11's answer to a picture that
   * does not fit: half the detail, never half the answer. Its bounds say the southern rows are
   * outside the radar picture, and a cell there is unknown rather than dry.
   */
  test('theCoarsePartialRadarVectorSaysWhereThePictureStops', () => {
    const entry = vector('radar_tile_coarse_partial');
    assert.ok(entry);
    const radar = decode(hexToBytes(entry.hex));
    assert.equal(radar.coarse, true);
    assert.equal(radar.size, 16);
    assert.deepStrictEqual(radar.bounds, [0, 9, 0, 15]);
    assert.ok(MeshWXRadar.isKnown(radar, { row: 9, col: 0 }));
    assert.ok(!MeshWXRadar.isKnown(radar, { row: 10, col: 0 }), 'below the picture, not dry');
    // Every cell outside the bounds is level 0 on the wire, as the spec requires.
    for (let row = 10; row < 16; row += 1) {
      assert.equal(radar.rows[row], '0'.repeat(16));
    }
    assert.equal(bytesToHex(encode(radar)), entry.hex);
  });

  /**
   * Spec §13: `>radar` is refused with letter `x`, not `r` — `r` is `>rain`, and a refusal names
   * no argument, so the letter is the only thing that says which of the two was refused.
   */
  test('theRadarRequestAndItsRefusalUseTheLetterX', () => {
    const request = decode(hexToBytes(vector('request_radar').hex));
    assert.equal(request.name, 'request');
    assert.equal(request.text, '>radar 32.780,-96.800');
    assert.equal(
      WeatherRequest.wireText(WeatherRequest.radar({ latitude: 32.78, longitude: -96.8 })),
      request.text,
      "the app's own request is the publisher's bytes",
    );

    const refusal = decode(hexToBytes(vector('not_available_radar').hex));
    assert.equal(refusal.name, 'not_available');
    assert.equal(refusal.request, MeshWXWire.radarRequestLetter);
    assert.equal(refusal.request_code, 0x78);
    assert.equal(refusal.reason, 4, 'this tile of this picture went out in the last five minutes');
    assert.equal(
      WeatherRequest.requestLetter(WeatherRequest.radar({ latitude: 32.78, longitude: -96.8 })),
      refusal.request,
    );
    assert.notEqual(WeatherRequest.requestLetter(WeatherRequest.rainfall({ state: 'TX' })), refusal.request);
  });

  /** Revision 13's ask is the app's own bytes: `loop` with the held times newest first. */
  test('theRevision13RequestIsTheAppsOwnText', () => {
    const loop = decode(hexToBytes(vector('request_radar_loop').hex));
    const taken2338 = decode(hexToBytes(vector('radar_tile').hex)).taken_min;
    assert.equal(
      WeatherRequest.wireText(WeatherRequest.radarLoop({
        latitude: 30.27, longitude: -97.74, held: [taken2338, taken2338 + 15],
      })),
      loop.text,
    );
    assert.equal(
      WeatherRequest.requestLetter(WeatherRequest.radarLoop({ latitude: 30.27, longitude: -97.74 })),
      MeshWXWire.radarRequestLetter,
    );
  });

  test('sweepEntriesExpandToTheirUGCCodes', () => {
    const sweep = decode(hexToBytes(vector('area_sweep_national_packet1').hex));
    const states = tables.states;
    assert.deepStrictEqual(
      MeshWXAreaSweep.Entry.ugcCodes(sweep.entries[0], { states }),
      ['TXC100', 'TXC101', 'TXC102', 'TXC103', 'TXC104',
        'TXC105', 'TXC106', 'TXC107', 'TXC108', 'TXC109'],
    );
    for (const entry of sweep.entries) {
      const codes = MeshWXAreaSweep.Entry.ugcCodes(entry, { states });
      assert.equal(codes.length, entry.run);
    }
  });
});
