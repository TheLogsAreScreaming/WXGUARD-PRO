// Port of MC1Services/Tests/MeshWXTests/MeshWXCodecTests.swift
//
// Everything the eighteen vectors do not reach: the failure paths, the chunker, and the UGC run
// packing.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  decode,
  decodeHeader,
  encode,
  bytesToHex,
  hexToBytes,
  MeshWXWire,
  MeshWXWarningIdentity,
  MeshWXForecast,
  MeshWXNotAvailable,
  MeshWXHeader,
  MeshWXDataSource,
  MeshWXDecodeError,
  MeshWXEncodeError,
  MeshWXEncoder,
  MeshWXAreaRun,
  MeshWXCompass,
  MeshWXCoverage,
  MeshWXStationObservation,
  MeshWXObservations,
  MeshWXForecastPeriod,
  MeshWXWarning,
  MeshWXRequest,
  MeshWXAreaSweep,
  MeshWXSky,
  MeshWXTextSubject,
  MeshWXCancelReason,
  MeshWXNotAvailableReason,
} from '../src/meshwx/index.js';
import { sharedTables } from './helpers/meshwx-vectors.js';

const bytes = (...values) => Uint8Array.from(values.flat());

function truncated(what, need, have) {
  return (error) => {
    assert.ok(error instanceof MeshWXDecodeError, `not a MeshWXDecodeError: ${error}`);
    assert.equal(error.kind, 'truncated');
    assert.equal(error.what, what);
    assert.equal(error.need, need);
    assert.equal(error.have, have);
    return true;
  };
}

const encodeError = (kind) => (error) => {
  assert.ok(error instanceof MeshWXEncodeError, `not a MeshWXEncodeError: ${error}`);
  if (kind != null) assert.equal(error.kind, kind);
  return true;
};

describe('MeshWX codec', () => {
  let tables;
  before(async () => { tables = await sharedTables(); });

  // MARK: - Header and unknown types

  test('headerSplitsTheTypeByte', () => {
    // seq 17, bot 0x4c7a, type 1 with the update flag set.
    const header = decodeHeader(bytes(0x11, 0x7a, 0x4c, 0x11));
    assert.equal(header.seq, 17);
    assert.equal(header.bot, 19578);
    assert.equal(header.type, 1);
    assert.equal(header.name, 'warning');
    assert.equal(header.flags, 1);
  });

  test('unknownTypeKeepsTheHeaderAndDropsTheBody', () => {
    // Nibble 13 is in the third-party experimental range (spec §2.2): the bot never sends it, so
    // it must be ignored — but `(bot, seq)` tracking still needs it, which is why this is a
    // decode, not an error. (Nibble 12 is free again too: revision 13's detail tile was removed
    // before release, and `radarDetailIsAnUnknownTypeAgain` pins it.)
    const message = decode(bytes(0x05, 0x7a, 0x4c, 0xd3, 0xaa, 0xbb));
    assert.equal(message.seq, 5);
    assert.equal(message.type, 13);
    assert.equal(message.name, 'unknown');
    assert.equal(message.flags, 3);
    assert.deepStrictEqual(message, { seq: 5, bot: 19578, type: 13, name: 'unknown', flags: 3 });
  });

  test('unknownTypeHasNoEncoding', () => {
    const message = decode(bytes(0x05, 0x7a, 0x4c, 0xd3));
    assert.throws(() => encode(message), encodeError('outOfRange'));
  });

  // MARK: - Truncation

  test('truncatedHeaderThrows', () => {
    assert.throws(() => decode(bytes(0x11, 0x7a, 0x4c)), truncated('header', 4, 3));
  });

  test('truncatedWarningBodyThrows', () => {
    // Type 1 with only 10 of the 15 fixed bytes.
    const short = bytes(0x11, 0x7a, 0x4c, 0x10, 0x03, 0x23, 0x2a, 0x00, 0xc9, 0x13);
    assert.throws(() => decode(short), truncated('warning', 15, 10));
  });

  test('truncatedPolygonThrows', () => {
    // A warning whose tag byte promises a 6-vertex polygon but stops after the anchor.
    const data = bytes(
      [0x11, 0x7a, 0x4c, 0x10, 0x03, 0x23, 0x2a, 0x00, 0xc9, 0x13, 0xc7, 0x01],
      [0x02, 0x00, 0x00], // tags: polygon only
      [0x06], // 6 vertices promised
      [0x30, 0xa8, 0x04, 0xa8, 0x0c, 0xf1], // anchor only
    );
    assert.throws(() => decode(data), (error) => error instanceof MeshWXDecodeError);
  });

  test('truncatedDigestEntriesThrow', () => {
    // count says 3, only one entry follows.
    const data = bytes(
      [0x14, 0x7a, 0x4c, 0x30],
      [0x9c, 0x13, 0xc7, 0x01, 0x07, 0x03],
      [0x03, 0x23, 0x2a, 0x00, 0x2d, 0x00],
    );
    assert.throws(() => decode(data), truncated('digest entries', 28, 16));
  });

  test('truncatedObservationStationsThrow', () => {
    const data = bytes(
      [0x15, 0x7a, 0x4c, 0x40],
      [0x95, 0x13, 0xc7, 0x01, 0x02], // 2 stations promised
      [0xca, 0x00, 0x58, 0x48, 0x73], // 5 bytes of the first
    );
    assert.throws(() => decode(data), (error) => error instanceof MeshWXDecodeError);
  });

  test('badUTF8InTextThrows', () => {
    // 0xFF is never a legal UTF-8 byte.
    const data = bytes(0x17, 0x7a, 0x4c, 0x60, 0x00, 0x17, 0x00, 0x01, 0x48, 0xff, 0x69);
    assert.throws(() => decode(data), (error) => {
      assert.ok(error instanceof MeshWXDecodeError);
      assert.equal(error.kind, 'badUTF8');
      return true;
    });
  });

  test('emptyTextBodyIsValid', () => {
    const message = decode(bytes(0x17, 0x7a, 0x4c, 0x60, 0x08, 0x17, 0x00, 0x01));
    assert.equal(message.name, 'text');
    assert.equal(message.text, '');
    assert.equal(message.subject, MeshWXTextSubject.general);
  });

  // MARK: - Text chunking

  test('chunkingNeverSplitsACodePoint', () => {
    // A 4-byte emoji starting at byte 155: a naive 157-byte cut lands in the middle of it and
    // produces two chunks neither of which is valid UTF-8.
    const filler = 'A'.repeat(155);
    const original = `${filler}😀${'B'.repeat(40)}`;
    assert.equal(new TextEncoder().encode(original).length, 199);

    const chunks = MeshWXEncoder.textChunks({
      seqStart: 200, bot: 19578, subject: MeshWXTextSubject.warningNarrative, text: original,
    });
    assert.equal(chunks.length, 2);
    assert.ok(chunks.every((chunk) => chunk.length <= MeshWXWire.maxData));

    let reassembled = '';
    chunks.forEach((chunk, position) => {
      const message = decode(chunk);
      assert.equal(message.name, 'text', `chunk ${position} is not a text message`);
      // Sequence numbers run on from seqStart and wrap; the group stays put so the receiver can
      // bucket the reply.
      assert.equal(message.seq, 200 + position);
      assert.equal(message.group, 200);
      assert.equal(message.idx, position);
      assert.equal(message.total, 2);
      assert.equal(message.subject, MeshWXTextSubject.warningNarrative);
      reassembled += message.text;
    });
    assert.equal(reassembled, original);

    // The cut backed off the boundary rather than through it: the emoji is whole and leads the
    // second chunk.
    const firstText = decode(chunks[0]);
    assert.equal(firstText.text, filler);
    assert.equal(new TextEncoder().encode(firstText.text).length, 155);
    assert.ok(decode(chunks[1]).text.startsWith('😀'));
  });

  test('chunkSequenceWrapsPast255', () => {
    const chunks = MeshWXEncoder.textChunks({
      seqStart: 254, bot: 1, subject: MeshWXTextSubject.general, text: 'x'.repeat(400),
    });
    assert.equal(chunks.length, 3);
    assert.deepStrictEqual(chunks.map((chunk) => decodeHeader(chunk).seq), [254, 255, 0]);
    // The group is the *first* chunk's seq, so it does not wrap with them.
    assert.deepStrictEqual(chunks.map((chunk) => decode(chunk).group), [254, 254, 254]);
  });

  test('emptyTextStillProducesOneChunk', () => {
    const chunks = MeshWXEncoder.textChunks({
      seqStart: 0, bot: 1, subject: MeshWXTextSubject.general, text: '',
    });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, MeshWXWire.textFixedSize);
  });

  test('textOverEightChunksIsRefused', () => {
    // 8 × 157 = 1256 bytes is the whole budget of a reply.
    assert.throws(() => MeshWXEncoder.textChunks({
      seqStart: 0, bot: 1, subject: MeshWXTextSubject.general, text: 'z'.repeat(1257),
    }), (error) => {
      assert.equal(error.kind, 'textTooLong');
      assert.equal(error.chunks, 9);
      return true;
    });
  });

  test('oversizeTextChunkIsRefused', () => {
    assert.throws(() => MeshWXEncoder.text({
      seq: 0,
      bot: 1,
      subject: MeshWXTextSubject.general,
      group: 0,
      index: 0,
      total: 1,
      text: 'q'.repeat(158),
    }), encodeError('oversize'));
  });

  // MARK: - UGC runs (spec §3)

  const states = ['AL', 'AK', 'AZ', 'TX']; // TX at index 3 for these tests

  test('consecutiveZonesMergeIntoOneRun', () => {
    const runs = MeshWXAreaRun.runs({
      fromUGCs: ['TXZ191', 'TXZ192', 'TXZ193', 'TXZ194', 'TXZ200'], states,
    });
    assert.equal(runs.length, 2);
    assert.deepStrictEqual(runs[0], { state: 3, county: false, start: 191, run: 4 });
    assert.deepStrictEqual(runs[1], { state: 3, county: false, start: 200, run: 1 });
  });

  test('runsExpandBackToTheSameCodes', () => {
    const ugcs = ['TXZ191', 'TXZ192', 'TXZ193', 'TXZ194', 'TXZ200'];
    const runs = MeshWXAreaRun.runs({ fromUGCs: ugcs, states });
    assert.deepStrictEqual(runs.flatMap((run) => MeshWXAreaRun.ugcCodes(run, { states })), ugcs);
  });

  test('countiesAndZonesNeverMergeAcrossKinds', () => {
    // Same state, same numbers, different kind: two runs, counties after zones because the sort
    // puts the zone flag first (matching the reference's tuple ordering).
    const runs = MeshWXAreaRun.runs({ fromUGCs: ['TXC191', 'TXZ191', 'TXZ192'], states });
    assert.equal(runs.length, 2);
    assert.deepStrictEqual(runs[0], { state: 3, county: false, start: 191, run: 2 });
    assert.deepStrictEqual(runs[1], { state: 3, county: true, start: 191, run: 1 });
  });

  test('duplicatesCollapseAndOrderDoesNotMatter', () => {
    const scrambled = MeshWXAreaRun.runs({
      fromUGCs: ['TXZ194', 'TXZ191', 'TXZ192', 'TXZ191', 'TXZ193'], states,
    });
    assert.deepStrictEqual(scrambled, [{ state: 3, county: false, start: 191, run: 4 }]);
  });

  test('unparseableOrUnknownCodesAreSkipped', () => {
    // Wrong length, wrong kind letter, non-numeric tail, and a state this bundle does not carry:
    // an old bundle must lose the area, not the whole warning.
    const runs = MeshWXAreaRun.runs({
      fromUGCs: ['TXZ19', 'TXX191', 'TXZ19A', 'ZZZ191', 'txz192'], states,
    });
    assert.deepStrictEqual(runs, [{ state: 3, county: false, start: 192, run: 1 }]);
  });

  test('expansionWithoutTheStateYieldsNothing', () => {
    // The run is still decodable, it just cannot be named (spec §16, append-only tables).
    const run = { state: 99, county: true, start: 453, run: 1 };
    assert.deepStrictEqual(MeshWXAreaRun.ugcCodes(run, { states }), []);
    assert.deepStrictEqual(MeshWXAreaRun.numbers(run), [453]);
  });

  test('ugcNumbersArePaddedToThreeDigits', () => {
    const run = { state: 3, county: true, start: 7, run: 2 };
    assert.deepStrictEqual(MeshWXAreaRun.ugcCodes(run, { states }), ['TXC007', 'TXC008']);
  });

  // MARK: - Compass rounding

  test('compassRoundsHalvesToEvenLikeTheReference', () => {
    // 348.75° is exactly halfway between sectors 15 and 16; Python's round() takes the even one
    // (16), which folds to 0 — north. Rounding half *up* here would report a north-north-westerly
    // as north-north-west and disagree with the bot.
    assert.equal(MeshWXCompass.fromDegrees(348.75), MeshWXCompass.north);
    assert.equal(MeshWXCompass.fromDegrees(11.25), MeshWXCompass.north);
    assert.equal(MeshWXCompass.fromDegrees(157), MeshWXCompass.southSouthEast);
    assert.equal(MeshWXCompass.fromDegrees(292.5), MeshWXCompass.westNorthWest);
    assert.equal(MeshWXCompass.fromDegrees(360), MeshWXCompass.north);
    assert.equal(MeshWXCompass.fromDegrees(-22.5), MeshWXCompass.northNorthWest);
    assert.equal(MeshWXCompass.fromDegrees(null), MeshWXCompass.north);
    assert.equal(MeshWXCompass.fromDegrees(NaN), MeshWXCompass.north);
  });

  // MARK: - Encoder limits

  const svw = { event: 3, office: 35, etn: 42 };

  test('encoderRefusesOutOfSpecCounts', () => {
    const twoVertices = [[30, -97], [31, -98]];
    assert.throws(() => MeshWXEncoder.warning({
      seq: 0, bot: 1, identity: svw, expiresMinutes: 0, polygon: twoVertices,
    }), encodeError('badCount'));
    assert.throws(() => MeshWXEncoder.observations({
      seq: 0, bot: 1, timestampMinutes: 0, stations: [],
    }), encodeError('badCount'));
    const fifteen = Array.from(
      { length: 15 }, (_, index) => MeshWXStationObservation.make({ station: index }),
    );
    assert.throws(() => MeshWXEncoder.observations({
      seq: 0, bot: 1, timestampMinutes: 0, stations: fifteen,
    }), encodeError('badCount'));
    const entries = Array.from({ length: 26 }, (_, index) => ({
      identity: { event: 3, office: 35, etn: index }, expiresMinutes: 10,
    }));
    assert.throws(() => MeshWXEncoder.digest({
      seq: 0, bot: 1, nowMinutes: 0, feedHealth: 0, entries,
    }), encodeError('badCount'));
  });

  test('polygonDeltaBeyondI16IsRefused', () => {
    // 0.001° resolution caps a hop at ±32.767°; a polygon spanning more than that has to be
    // re-anchored rather than silently wrapped.
    const stretched = [[0, 0], [40, 0], [40, 1]];
    assert.throws(() => MeshWXEncoder.warning({
      seq: 0, bot: 1, identity: svw, expiresMinutes: 0, polygon: stretched,
    }), encodeError('polygonDeltaTooLarge'));
  });

  test('digestClampsRelativeExpiry', () => {
    const identity = { event: 3, office: 35, etn: 1 };
    const data = MeshWXEncoder.digest({
      seq: 1,
      bot: 1,
      nowMinutes: 1000,
      feedHealth: 0,
      entries: [
        { identity, expiresMinutes: 900 }, // already expired: clamps to 0
        { identity, expiresMinutes: 1000 + 70000 }, // past the u16: clamps to 65535
      ],
    });
    const digest = decode(data);
    assert.equal(digest.name, 'digest');
    assert.equal(digest.entries[0].expires_rel, 0);
    assert.equal(digest.entries[0].expires_min, 1000);
    assert.equal(digest.entries[1].expires_rel, 65535);
  });

  test('notAvailableTakesTheFirstLetterOfTheRequest', () => {
    const data = MeshWXEncoder.notAvailable({
      seq: 25, bot: 19578, request: '>f round rock tx', reason: MeshWXNotAvailableReason.unknownLocation,
    });
    assert.equal(bytesToHex(data), '197a4c706601');
    assert.throws(() => MeshWXEncoder.notAvailable({
      seq: 0, bot: 1, request: '>  ', reason: MeshWXNotAvailableReason.noData,
    }), encodeError('emptyRequest'));
  });

  // MARK: - Request (type 9, spec §11)

  test('aRequestRefusesWhatTheBotCouldNotRead', () => {
    const sender = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    // Not six bytes of key: the bot pairs a datagram with the same phone's DMs on this prefix.
    assert.throws(() => MeshWXEncoder.request({
      seq: 0, bot: 1, senderPrefix: sender.subarray(0, 5), timestamp: 1, text: '>d',
    }), (error) => {
      assert.equal(error.kind, 'badCount');
      assert.equal(error.what, 'request sender');
      assert.equal(error.count, 5);
      return true;
    });
    // Not a `>` request, or nothing after the `>`.
    assert.throws(() => MeshWXEncoder.request({
      seq: 0, bot: 1, senderPrefix: sender, timestamp: 1, text: 'd',
    }), encodeError('emptyRequest'));
    assert.throws(() => MeshWXEncoder.request({
      seq: 0, bot: 1, senderPrefix: sender, timestamp: 1, text: '>',
    }), encodeError('emptyRequest'));
    // 41 bytes of text: one past what §11 allows.
    const long = `>f ${'x'.repeat(38)}`;
    assert.throws(() => MeshWXEncoder.request({
      seq: 0, bot: 1, senderPrefix: sender, timestamp: 1, text: long,
    }), (error) => {
      assert.equal(error.kind, 'oversize');
      assert.equal(error.bytes, 41);
      return true;
    });
    assert.doesNotThrow(() => MeshWXEncoder.request({
      seq: 0, bot: 1, senderPrefix: sender, timestamp: 1, text: long.slice(0, -1),
    }));
  });

  test('aRequestRoundTripsItsTextAndTimeWhoeverSentIt', () => {
    // Another phone's request, as it arrives on the channel: the whole grammar of §14 at its
    // longest, to a bot named `0xFFFF` — every bot on the channel.
    const request = MeshWXRequest.make({
      seq: 200,
      botID: MeshWXRequest.anyBot,
      senderPrefix: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
      timestamp: 1_789_660_000,
      text: '>metar round rock tx',
    });
    const data = MeshWXRequest.encode(request);
    assert.equal(data.length, MeshWXWire.requestFixedSize + 20);
    const decoded = decode(data);
    assert.deepStrictEqual(decoded, request);
    assert.equal(decoded.text, '>metar round rock tx');
    assert.deepStrictEqual(encode(decoded), data);
  });

  test('aTruncatedRequestIsRefusedRatherThanReadPastItsEnd', () => {
    // Header plus five of the six sender bytes: one short of the fixed part.
    const short = bytes(0x01, 0x1d, 0x04, 0x90, 0x01, 0x02, 0x03, 0x04, 0x05);
    assert.throws(() => decode(short), truncated('request', 14, 9));
  });

  test('aRequestWithNoTextDecodesAsEmptyRatherThanTrapping', () => {
    // The encoder never makes one, but the bytes can arrive: the packet ends where the text
    // would start.
    const bare = bytes(
      0x01, 0x1d, 0x04, 0x90, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x60, 0x0b, 0xac, 0x6a,
    );
    const decoded = decode(bare);
    assert.equal(decoded.name, 'request');
    assert.equal(decoded.text, '');
    assert.equal(decoded.ts, 1_789_660_000);
  });

  test('observationSentinelsSurviveARoundTrip', () => {
    // Every optional field at its sentinel at once: the case a real station with a dead sensor
    // produces, and the one where an off-by-one in the field order shows up.
    const blank = MeshWXStationObservation.make({
      station: 976,
      wind_dir_deg: MeshWXCompass.degrees(MeshWXCompass.westNorthWest),
      sky: MeshWXSky.thunderstorm,
    });
    const data = MeshWXEncoder.observations({
      seq: 1, bot: 1, timestampMinutes: 29_823_893, stations: [blank],
    });
    const observations = decode(data);
    assert.equal(observations.name, 'observations');
    assert.deepStrictEqual(observations.stations, [blank]);
    assert.equal(MeshWXStationObservation.feelsLikeF(observations.stations[0]), null);
  });

  test('pressureOutsideTheEncodableWindowIsRefused', () => {
    const station = MeshWXStationObservation.make({ station: 1, pressure_inhg: 28.5 });
    assert.throws(() => MeshWXEncoder.observations({
      seq: 0, bot: 1, timestampMinutes: 0, stations: [station],
    }), encodeError('outOfRange'));
  });

  test('forecastWindNibbleSaturatesAtSeventyFive', () => {
    const period = MeshWXForecastPeriod.make({
      wind_dir_deg: MeshWXCompass.degrees(MeshWXCompass.west), wind_mph: 200,
    });
    const data = MeshWXEncoder.forecast({
      seq: 1, bot: 1, pointIndex: 102, issuedMinutes: 0, firstPeriod: 0, periods: [period],
    });
    const forecast = decode(data);
    assert.equal(forecast.name, 'forecast');
    assert.equal(forecast.periods[0].wind_mph, 75);
    assert.equal(
      MeshWXCompass.fromDegrees(forecast.periods[0].wind_dir_deg), MeshWXCompass.west,
    );
  });

  test('warningWithNoPolygonOrAreasClearsBothTagBits', () => {
    const data = MeshWXEncoder.warning({
      seq: 1,
      bot: 1,
      identity: { event: 41, office: 35, etn: 3 },
      expiresMinutes: 29_824_980,
      polygon: [],
      areas: [],
    });
    assert.equal(data.length, MeshWXWire.warningFixedSize);
    const warning = decode(data);
    assert.equal(warning.name, 'warning');
    assert.equal(warning.polygon, null);
    assert.equal(warning.areas, null);
  });

  // MARK: - Per-station ages (spec §6.1, revision 5)

  const station = (index, age = null) => MeshWXStationObservation.make({
    station: index, temp_f: 88, sky: MeshWXSky.few, age_min: age,
  });

  /**
   * Station `i` is the low nibble of byte `i / 2` when `i` is even and the high nibble when it is
   * odd, so an even count fills both nibbles of its last byte and an odd count pads the high one.
   */
  test('agePlacementIsLowNibbleFirstAndAnOddCountPadsTheLastByte', () => {
    const odd = MeshWXEncoder.observations({
      seq: 29,
      bot: 19578,
      timestampMinutes: 29_823_893,
      stations: [station(202, 0), station(860, 20), station(976, 110)],
    });
    assert.equal(odd.length, MeshWXWire.observationsFixedSize + 33 + 2);
    assert.equal(odd[3] & 0x0f, MeshWXWire.flagObservationAges);
    // 0 and 20 share a byte (2 in the high nibble), 110 pads: the vector's own 0x20, 0x0b.
    assert.deepStrictEqual(odd.subarray(odd.length - 2), bytes(0x20, 0x0b));
    assert.deepStrictEqual(decode(odd).stations.map((s) => s.age_min), [0, 20, 110]);

    const even = MeshWXEncoder.observations({
      seq: 30,
      bot: 19578,
      timestampMinutes: 29_823_893,
      stations: [station(202, 10), station(860, 30), station(976, 40), station(1, 150)],
    });
    assert.equal(
      even.length, MeshWXWire.observationsFixedSize + 44 + 2, 'four stations, two bytes',
    );
    assert.deepStrictEqual(even.subarray(even.length - 2), bytes(0x31, 0xf4));
    assert.deepStrictEqual(decode(even).stations.map((s) => s.age_min), [10, 30, 40, 150]);
    assert.deepStrictEqual(encode(decode(even)), even);
  });

  /**
   * The old form: no flag, no block, and every station's age null — which is "the batch does not
   * say", not "this station is the batch time".
   */
  test('aBatchWithoutTheAgesFlagCarriesNoAgesAtAll', () => {
    const data = MeshWXEncoder.observations({
      seq: 21,
      bot: 19578,
      timestampMinutes: 29_823_893,
      stations: [station(202), station(860), station(976)],
    });
    assert.equal(
      data.length, MeshWXWire.observationsFixedSize + 33, 'no block on the end',
    );
    assert.equal(data[3] & 0x0f, 0);
    const batch = decode(data);
    assert.ok(batch.stations.every((s) => s.age_min === null));
    assert.ok(!MeshWXObservations.carriesAges(batch));
    // Every station reads as the batch time, which is all a revision 4 batch states.
    assert.ok(batch.stations.every(
      (s) => MeshWXObservations.reportMinutes(batch, { for: s }) === 29_823_893,
    ));
  });

  /**
   * 15 steps is a saturation, not a reading: it means "150 minutes or more", so anything past it
   * clamps rather than wrapping to a fresh-looking 0.
   */
  test('theAgeNibbleRoundsHalfUpAndSaturatesAtOneHundredAndFifty', () => {
    const data = MeshWXEncoder.observations({
      seq: 1,
      bot: 1,
      timestampMinutes: 1000,
      stations: [
        station(1, 4), station(2, 5), station(3, 144), station(4, 145), station(5, 900),
      ],
    });
    const batch = decode(data);
    assert.deepStrictEqual(batch.stations.map((s) => s.age_min), [0, 10, 140, 150, 150]);
    assert.deepStrictEqual(
      batch.stations.map((s) => MeshWXStationObservation.isAgeSaturated(s)),
      [false, false, false, true, true],
    );
    // A saturated station is at least that old, so its report time is a ceiling.
    assert.equal(
      MeshWXObservations.reportMinutes(batch, { for: batch.stations[4] }), 850,
    );
  });

  /**
   * All or nothing (spec §6.1): a batch honest about two stations and silent about the third
   * would leave the third to be guessed at, which is worse than saying nothing.
   */
  test('aBatchWhereOnlySomeStationsKnowTheirAgeIsRefused', () => {
    assert.throws(() => MeshWXEncoder.observations({
      seq: 1,
      bot: 1,
      timestampMinutes: 1000,
      stations: [station(1, 0), station(2, 20), station(3)],
    }), (error) => {
      assert.equal(error.kind, 'partialObservationAges');
      assert.equal(error.known, 2);
      assert.equal(error.stations, 3);
      return true;
    });
  });

  /**
   * Spec §6.1: 14 stations are 163 bytes and the nibbles cost 7 more, so a full batch with ages
   * does not fit — the ages cost the fourteenth station, never the other way round.
   */
  test('aBatchOfFourteenWithAgesDoesNotFitOnePacket', () => {
    const thirteen = Array.from(
      { length: MeshWXWire.maxStationsWithAges }, (_, index) => station(index, index * 10),
    );
    const data = MeshWXEncoder.observations({
      seq: 1, bot: 1, timestampMinutes: 1000, stations: thirteen,
    });
    assert.equal(data.length, 159);
    assert.ok(data.length <= MeshWXWire.maxData);

    const fourteen = [...thirteen, station(99, 30)];
    assert.throws(() => MeshWXEncoder.observations({
      seq: 1, bot: 1, timestampMinutes: 1000, stations: fourteen,
    }), (error) => {
      assert.equal(error.kind, 'oversize');
      assert.equal(error.what, 'observations');
      assert.equal(error.bytes, 170);
      return true;
    });
    // Without the ages the same fourteen still fit, as they always did.
    const bare = fourteen.map(
      (entry) => MeshWXStationObservation.make({ station: entry.station, sky: MeshWXSky.few }),
    );
    assert.equal(MeshWXEncoder.observations({
      seq: 1, bot: 1, timestampMinutes: 1000, stations: bare,
    }).length, 163);
  });

  test('truncatedAgeBlockThrows', () => {
    // Flags nibble 1 promises the ages; two stations need one byte and none follows.
    const data = bytes(
      [0x1d, 0x7a, 0x4c, 0x41],
      [0x95, 0x13, 0xc7, 0x01, 0x02],
      [0xca, 0x00, 0x58, 0x48, 0x73, 0x0c, 0x15, 0x0a, 0x5c, 0x3b, 0x07],
      [0x5c, 0x03, 0x54, 0x46, 0x01, 0x00, 0x00, 0x0a, 0x5f, 0xff, 0x00],
    );
    assert.throws(() => decode(data), truncated('observation ages', 32, 31));
  });

  // MARK: - Warning issue time (spec §3, revision 5)

  /**
   * The wire carries the gap, not the instant, so the issue time survives a message drained from
   * an offline queue hours late: both ends of the subtraction ride in the same packet.
   */
  test('theIssueTimeIsMinutesBeforeTheExpiryAndSetsItsOwnFlagBit', () => {
    const expires = 29_823_945;
    const data = MeshWXEncoder.warning({
      seq: 28, bot: 19578, identity: svw, expiresMinutes: expires, issuedMinutes: expires - 90,
    });
    assert.equal(data.length, MeshWXWire.warningFixedSize + MeshWXWire.warningIssuedSize);
    assert.equal(data[3] & 0x0f, MeshWXWire.flagWarningIssued);
    const warning = decode(data);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(warning), 90);
    assert.equal(MeshWXWarning.issuedMinutes(warning), expires - 90);
    assert.ok(!MeshWXWarning.isIssueTimeSaturated(warning));
    assert.deepStrictEqual(encode(decode(data)), data);

    // The update bit is bit 0 and the issue time bit 1: both fit in the same nibble.
    const both = MeshWXEncoder.warning({
      seq: 29,
      bot: 19578,
      identity: svw,
      expiresMinutes: expires,
      isUpdate: true,
      issuedMinutes: expires - 5,
    });
    assert.equal(both[3] & 0x0f, 0x3);
    const updated = decode(both);
    assert.ok(updated.update);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(updated), 5);
  });

  test('aWarningWithoutTheIssuedFlagHasNoIssueTime', () => {
    const data = MeshWXEncoder.warning({
      seq: 17, bot: 19578, identity: svw, expiresMinutes: 29_823_945,
    });
    assert.equal(data.length, MeshWXWire.warningFixedSize);
    assert.equal(data[3] & 0x0f, 0);
    const warning = decode(data);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(warning), null);
    assert.equal(MeshWXWarning.issuedMinutes(warning), null);
    assert.ok(!MeshWXWarning.isIssueTimeSaturated(warning));
  });

  /**
   * 65535 minutes is 45.5 days, longer than any NWS product runs from issuance to expiry, so the
   * u16 saturates rather than wrapping — and a product issued after its own expiry, which no real
   * one is, encodes as 0 rather than failing the message.
   */
  test('theIssueTimeSaturatesRatherThanWrapping', () => {
    const expires = 30_000_000;
    const ancient = MeshWXEncoder.warning({
      seq: 1, bot: 1, identity: svw, expiresMinutes: expires, issuedMinutes: expires - 200_000,
    });
    const saturated = decode(ancient);
    assert.equal(
      MeshWXWarning.issuedBeforeMinutes(saturated), MeshWXWire.issuedBeforeSaturatedMinutes,
    );
    assert.ok(MeshWXWarning.isIssueTimeSaturated(saturated));
    assert.equal(
      MeshWXWarning.issuedMinutes(saturated), expires - 65535, 'a ceiling: issued at or before this',
    );
    assert.deepStrictEqual(encode(decode(ancient)), ancient);

    const backwards = MeshWXEncoder.warning({
      seq: 2, bot: 1, identity: svw, expiresMinutes: expires, issuedMinutes: expires + 10,
    });
    const clamped = decode(backwards);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(clamped), 0);
    assert.equal(MeshWXWarning.issuedMinutes(clamped), expires);
  });

  test('truncatedIssueTimeThrows', () => {
    // Flags nibble 2 promises the two bytes; the fixed part stops without them.
    const data = bytes(
      [0x1c, 0x7a, 0x4c, 0x12],
      [0x03, 0x23, 0x2a, 0x00, 0xc9, 0x13, 0xc7, 0x01, 0x00, 0x04, 0x3c],
      [0x15],
    );
    assert.throws(() => decode(data), truncated('warning issue time', 17, 16));
  });

  // MARK: - Warning start (spec §3, revision 12)

  const watch = ({ issued = 29_823_900, begins, expires = 29_823_900 + 4896 } = {}) =>
    MeshWXEncoder.warning({
      seq: 33,
      bot: 19578,
      identity: svw,
      expiresMinutes: expires,
      areas: [{ state: 42, county: false, start: 191, run: 4 }],
      issuedMinutes: issued,
      beginsMinutes: begins,
    });
  const append = (data, tail) => Uint8Array.from([...data, ...tail]);

  /**
   * Two bytes after the issue time, minutes from the start to the expiry, and no flag: the
   * nibble is full, so it is found by the message's length.
   */
  test('theStartIsTwoBytesAfterTheIssueTimeAndNeedsNoFlag', () => {
    const without = watch({ begins: null });
    const withStart = watch({ begins: 29_823_900 + 2016 });
    assert.equal(withStart.length, without.length + MeshWXWire.warningBeginsSize);
    assert.deepStrictEqual(withStart.subarray(0, without.length), without, 'nothing before the start moved');
    assert.deepStrictEqual(withStart.subarray(withStart.length - 2), Uint8Array.from([0x40, 0x0b]),
      '2880 minutes, little-endian');
    assert.equal(withStart[3], without[3], 'the same flags nibble');

    const warning = decode(withStart);
    assert.equal(MeshWXWarning.beginsBeforeMinutes(warning), 2880);
    assert.equal(MeshWXWarning.beginsMinutes(warning), 29_823_900 + 2016);
    assert.equal(warning.begins_min, 29_823_900 + 2016);
    assert.deepStrictEqual(encode(decode(withStart)), withStart);
    const plain = decode(without);
    assert.equal(MeshWXWarning.beginsBeforeMinutes(plain), null);
    assert.equal(MeshWXWarning.beginsMinutes(plain), null);
  });

  /**
   * The bot's own conditions: only with an issue time, and only a start strictly between the
   * issuance and the expiry. A product in effect from issuance carries nothing new.
   */
  test('theEncoderWritesAStartOnlyStrictlyBetweenIssuanceAndExpiry', () => {
    const bare = watch({ begins: null }).length;
    assert.equal(watch({ begins: 29_823_900 }).length, bare, 'in effect from issuance');
    assert.equal(watch({ begins: 29_823_900 - 60 }).length, bare, 'a start before issuance');
    assert.equal(watch({ begins: 29_823_900 + 4896 }).length, bare, 'a start at the expiry');
    assert.equal(watch({ begins: 29_823_900 + 5000 }).length, bare, 'a start after the expiry');
    assert.equal(watch({ begins: 29_823_900 + 1 }).length, bare + 2, 'a minute after issuance is one');
    assert.equal(watch({ begins: 29_823_900 + 4895 }).length, bare + 2, 'a minute before expiry is one');
    // No issue time, no start: the start rides after it and is measured against it.
    assert.equal(
      watch({ issued: null, begins: 29_823_900 + 2016 }).length, watch({ issued: null, begins: null }).length,
    );
    // An issue time that saturated leaves room for a start inside the u16; a start that would
    // saturate too is not below it and stays off the wire.
    const ancient = 29_823_900 + 4896 - 200_000;
    assert.equal(decode(watch({ issued: ancient, begins: 29_823_900 + 4796 })).begins_min, 29_823_900 + 4796);
    assert.equal(watch({ issued: ancient, begins: 29_823_900 + 4896 - 100_000 }).length, bare);
  });

  /**
   * A value that is not a start after issuance is ignored as if absent, so an invalid one never
   * reaches the app: 0, one equal to the issue gap, one beyond it (which is also every saturated
   * value, since the issue gap cannot exceed the u16).
   */
  test('aStartThatIsNotBetweenIssuanceAndExpiryIsIgnored', () => {
    const base = watch({ begins: null });
    for (const bad of [0, 4896, 4897, MeshWXWire.beginsBeforeSaturatedMinutes]) {
      const warning = decode(append(base, [bad & 0xff, bad >> 8]));
      assert.equal(MeshWXWarning.beginsBeforeMinutes(warning), null, `begins_before ${bad}`);
      assert.equal(MeshWXWarning.beginsMinutes(warning), null, `begins_before ${bad}`);
      assert.equal(MeshWXWarning.issuedBeforeMinutes(warning), 4896, 'the issue time is read as before');
    }
  });

  /**
   * Found by length: one stray byte is not a start and is not an error, and bytes after a start
   * belong to a later revision and are left alone.
   */
  test('theStartIsReadOnlyWhenTwoBytesRemainAndLaterBytesAreIgnored', () => {
    const short = decode(append(watch({ begins: null }), [0x40]));
    assert.equal(MeshWXWarning.beginsBeforeMinutes(short), null);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(short), 4896);

    const warning = decode(append(watch({ begins: 29_823_900 + 2016 }), [0x01, 0x02, 0x03]));
    assert.equal(MeshWXWarning.beginsMinutes(warning), 29_823_900 + 2016);

    // Without the issue-time flag the trailing bytes are never read as either time.
    const unflagged = decode(append(watch({ issued: null, begins: null }), [0x40, 0x0b]));
    assert.equal(MeshWXWarning.issuedBeforeMinutes(unflagged), null);
    assert.equal(MeshWXWarning.beginsBeforeMinutes(unflagged), null);
  });

  // MARK: - Coverage (type 8, spec §10)

  /** The two flags are separate bits and each one alone is enough to stop a denial. */
  test('eachCutFlagIsItsOwnBitAndEitherWithholdsCompleteness', () => {
    const runs = [{ state: 42, county: false, start: 155, run: 6 }];
    for (const [areasCut, officesCut, nibble] of [
      [false, false, 0], [true, false, 1], [false, true, 2], [true, true, 3],
    ]) {
      const data = MeshWXEncoder.coverage({
        seq: 9,
        bot: 19578,
        latitude: 30.2672,
        longitude: -97.7431,
        radiusKilometres: 120,
        stationCap: 14,
        officeIndices: [35, 40],
        areas: runs,
        areasCut,
        officesCut,
      });
      assert.equal(data[3] & 0x0f, nibble);
      const statement = decode(data);
      assert.equal(statement.zones_cut, areasCut);
      assert.equal(statement.offices_cut, officesCut);
      assert.equal(MeshWXCoverage.isComplete(statement), !areasCut && !officesCut);
      // A cut list is never the whole area, so it can never be read as "no filter" either.
      assert.ok(!MeshWXCoverage.hasNoAreaFilter(statement));
      assert.deepStrictEqual(encode(decode(data)), data);
    }
  });

  /** `n` = 0 and `k` = 0: no area filter at all, which is an answer, not an empty message. */
  test('noOfficesAndNoRunsMeanNoAreaFilterAtAll', () => {
    const data = MeshWXEncoder.coverage({
      seq: 1,
      bot: 1,
      latitude: 0,
      longitude: 0,
      radiusKilometres: 0,
      stationCap: 0,
      officeIndices: [],
      areas: [],
    });
    assert.equal(
      data.length, MeshWXWire.coverageFixedSize + 1, 'the empty run list is still counted',
    );
    const statement = decode(data);
    assert.ok(MeshWXCoverage.hasNoAreaFilter(statement));
    assert.equal(statement.offices.length, 0);
    assert.equal(statement.areas.length, 0);
    assert.deepStrictEqual(encode(decode(data)), data);
  });

  /**
   * 0,0 with radius 0 is the bot saying it has no centre — the same non-position an advert
   * carries (spec §1) — so the runs are the whole answer.
   */
  test('aStatementWithNoCentreIsReadFromItsRunsAlone', () => {
    const bundleStates = tables.states;
    const runs = [{ state: 42, county: false, start: 186, run: 12 }];
    const data = MeshWXEncoder.coverage({
      seq: 2,
      bot: 1,
      latitude: 0,
      longitude: 0,
      radiusKilometres: 0,
      stationCap: 0,
      officeIndices: [35],
      areas: runs,
    });
    const statement = decode(data);
    assert.equal(MeshWXCoverage.centre(statement), null);
    assert.ok(!MeshWXCoverage.hasNoAreaFilter(statement));
    assert.ok(!MeshWXCoverage.circleContains(statement, { latitude: 0, longitude: 0 }));
    assert.ok(MeshWXCoverage.covers(statement, { ugc: 'TXZ192', states: bundleStates }));
    assert.ok(!MeshWXCoverage.covers(statement, { ugc: 'TXZ198', states: bundleStates }));
    assert.ok(
      !MeshWXCoverage.covers(statement, { ugc: 'TXC192', states: bundleStates }),
      'a county is not the zone of that number',
    );
    assert.deepStrictEqual(encode(decode(data)), data);
  });

  /**
   * A centre with radius 0 states no circle either: the field, not the coordinate, is what says
   * there is one.
   */
  test('theStatedCircleIsKilometresFromTheCentreAndZeroIsNoCircle', () => {
    const austin = { latitude: 30.2672, longitude: -97.7431 };
    const roundRock = { latitude: 30.5083, longitude: -97.6789 };
    const dallas = { latitude: 32.7767, longitude: -96.797 };
    const circle = MeshWXCoverage.make({
      latitude: austin.latitude,
      longitude: austin.longitude,
      radiusKilometres: 120,
      stationCap: 14,
      officeIndices: [35],
      areas: [],
    });
    assert.ok(MeshWXCoverage.circleContains(circle, austin));
    assert.ok(MeshWXCoverage.circleContains(circle, roundRock));
    assert.ok(!MeshWXCoverage.circleContains(circle, dallas));

    const noRadius = { ...circle, radius_km: 0 };
    assert.notEqual(
      MeshWXCoverage.centre(noRadius), null, 'a centre was stated; only the circle was not',
    );
    assert.ok(!MeshWXCoverage.circleContains(noRadius, austin));
  });

  test('truncatedCoverageOfficesAndRunsThrow', () => {
    // 14 fixed bytes saying four offices follow.
    const fixed = bytes(
      [0x1b, 0x7a, 0x4c, 0x80],
      [0x50, 0x9e, 0x04, 0xe9, 0x15, 0xf1, 0x78, 0x00, 0x0e, 0x04],
    );
    assert.throws(() => decode(fixed.subarray(0, 12)), truncated('coverage', 14, 12));

    const twoOffices = bytes([...fixed], [0x23, 0x28]);
    assert.throws(() => decode(twoOffices), truncated('coverage offices', 18, 16));

    // Offices complete, `k` says five runs, one follows. The runs are the warning's own list, so
    // the failure names it.
    const oneRun = bytes([...fixed], [0x23, 0x28, 0x33, 0x71], [0x05, 0x2a, 0x9b, 0x00, 0x06]);
    assert.throws(() => decode(oneRun), truncated('area runs', 39, 23));
  });

  test('coverageRefusesListsPastTheirCaps', () => {
    const runs = [{ state: 42, county: false, start: 155, run: 6 }];
    assert.throws(() => MeshWXEncoder.coverage({
      seq: 0,
      bot: 1,
      latitude: 0,
      longitude: 0,
      radiusKilometres: 0,
      stationCap: 0,
      officeIndices: new Array(25).fill(35),
      areas: runs,
    }), encodeError('badCount'));
    const thirtyOne = Array.from({ length: 31 }, (_, index) => ({
      state: 42, county: false, start: 100 + index * 2, run: 1,
    }));
    assert.throws(() => MeshWXEncoder.coverage({
      seq: 0,
      bot: 1,
      latitude: 0,
      longitude: 0,
      radiusKilometres: 0,
      stationCap: 0,
      officeIndices: [],
      areas: thirtyOne,
    }), encodeError('badCount'));
  });

  /** Spec §10: the two caps are chosen so a full list never costs the other one. */
  test('theFullestCoverageStillFitsOnePacket', () => {
    const offices = Array.from({ length: MeshWXWire.maxCoverageOffices }, (_, index) => index);
    const runs = Array.from({ length: MeshWXWire.maxAreaRuns }, (_, index) => ({
      state: 42, county: false, start: 100 + index * 2, run: 1,
    }));
    const data = MeshWXEncoder.coverage({
      seq: 1,
      bot: 1,
      latitude: 30.2672,
      longitude: -97.7431,
      radiusKilometres: 120,
      stationCap: 14,
      officeIndices: offices,
      areas: runs,
    });
    assert.equal(data.length, 159);
    assert.ok(data.length <= MeshWXWire.maxData);
  });

  // MARK: - Data source (spec §2.2, revision 7)

  /** One message of every type that carries weather, under one source. */
  const weatherMessages = (source) => [
    ['warning', MeshWXEncoder.warning({
      seq: 1, bot: 19578, identity: svw, expiresMinutes: 29_823_945, source,
    })],
    ['digest', MeshWXEncoder.digest({
      seq: 2,
      bot: 19578,
      nowMinutes: 29_823_900,
      feedHealth: 7,
      entries: [{ identity: svw, expiresMinutes: 29_823_945 }],
      source,
    })],
    ['observations', MeshWXEncoder.observations({
      seq: 3,
      bot: 19578,
      timestampMinutes: 29_823_893,
      stations: [station(202, 20), station(860, 40)],
      source,
    })],
    ['forecast', MeshWXEncoder.forecast({
      seq: 4,
      bot: 19578,
      pointIndex: 102,
      issuedMinutes: 29_823_880,
      firstPeriod: 1,
      periods: [MeshWXForecastPeriod.make({
        low_f: 73, pop_pct: 20, sky: MeshWXSky.scattered,
      })],
      source,
    })],
    ['text', MeshWXEncoder.text({
      seq: 5,
      bot: 19578,
      subject: MeshWXTextSubject.forecastDiscussion,
      group: 5,
      index: 0,
      total: 1,
      text: 'AREA FORECAST DISCUSSION',
      source,
    })],
  ];

  /**
   * Every type that carries weather states where it came from, and the statement has to survive a
   * re-encode byte for byte: it rides on the header, so an encoder that took it only from the
   * body would drop it silently.
   */
  describe('theDataSourceRoundTripsOnEveryTypeThatCarriesWeather', () => {
    for (const source of MeshWXDataSource.allCases) {
      test(`source ${source}`, () => {
        for (const [name, data] of weatherMessages(source)) {
          const message = decode(data);
          assert.equal(MeshWXHeader.dataSource(message), source, name);
          assert.deepStrictEqual(encode(message), data, `${name} re-encodes to the same bytes`);
        }
      });
    }
  });

  /**
   * Bits 3-2, which is the one place in the nibble that was free: the update bit and the issue
   * time bit keep bits 0 and 1, and each type's own flags are untouched.
   */
  test('theSourceSitsInBitsThreeAndTwoAndLeavesTheOtherFlagsAlone', () => {
    const expires = 29_823_945;
    const data = MeshWXEncoder.warning({
      seq: 28,
      bot: 19578,
      identity: svw,
      expiresMinutes: expires,
      isUpdate: true,
      issuedMinutes: expires - 90,
      source: MeshWXDataSource.internet,
    });
    // internet = 2, shifted up two: 0b1000, beside the update (0b1) and issued (0b10) bits.
    assert.equal(data[3] & 0x0f, 0b1011);
    const warning = decode(data);
    assert.ok(warning.update);
    assert.equal(MeshWXWarning.issuedBeforeMinutes(warning), 90);
    assert.equal(MeshWXHeader.dataSource(decodeHeader(data)), MeshWXDataSource.internet);

    // And on a batch that also carries the per-station ages (spec §6.1), which own bit 0.
    const batch = MeshWXEncoder.observations({
      seq: 29,
      bot: 19578,
      timestampMinutes: 29_823_893,
      stations: [station(202, 20)],
      source: MeshWXDataSource.mixed,
    });
    assert.equal(batch[3] & 0x0f, 0b1101);
    assert.deepStrictEqual(decode(batch).stations.map((s) => s.age_min), [20]);
    assert.equal(MeshWXHeader.dataSource(decodeHeader(batch)), MeshWXDataSource.mixed);
  });

  /**
   * A bot older than revision 7 sets none of these bits, and that is not a claim: it reads as
   * unstated on every type, and the bytes are the ones it always sent.
   */
  test('aBotThatStatesNothingIsUnstatedRatherThanGoes', () => {
    for (const [name, data] of weatherMessages(MeshWXDataSource.unstated)) {
      assert.equal(data[3] & MeshWXWire.flagDataSourceMask, 0, name);
      assert.equal(
        MeshWXHeader.dataSource(decodeHeader(data)), MeshWXDataSource.unstated, name,
      );
    }
    // The types with no weather product behind them always send 0 (spec §2.2, revision 7).
    const notAvailable = MeshWXEncoder.notAvailable({
      seq: 6, bot: 19578, requestCode: 102, reason: MeshWXNotAvailableReason.noData,
    });
    const coverage = MeshWXEncoder.coverage({
      seq: 7,
      bot: 19578,
      latitude: 30.2672,
      longitude: -97.7431,
      radiusKilometres: 120,
      stationCap: 14,
      officeIndices: [35],
      areas: [],
    });
    const request = MeshWXEncoder.request({
      seq: 8,
      bot: 19578,
      senderPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      timestamp: 1_789_436_700,
      text: '>d',
    });
    for (const data of [notAvailable, coverage, request]) {
      assert.equal(MeshWXHeader.dataSource(decodeHeader(data)), MeshWXDataSource.unstated);
    }
  });

  /**
   * **The Cancel exception.** Its whole nibble is a reason code (spec §4), so reason 12 is 12 and
   * never "mixed": reading bits 3-2 there would invent a source out of the reason a warning
   * ended, and re-encoding what was read would rewrite the reason.
   */
  test('aCancelsNibbleIsStillAllReasonAndStatesNoSource', () => {
    for (let raw = 0; raw <= 15; raw += 1) {
      const reason = MeshWXCancelReason.make({ rawValue: raw });
      const data = MeshWXEncoder.cancel({ seq: 9, bot: 19578, identity: svw, reason });
      const message = decode(data);
      assert.equal(message.flags, raw);
      assert.equal(
        MeshWXHeader.dataSource(message), MeshWXDataSource.unstated, `reason ${raw} is not a source`,
      );
      assert.equal(message.name, 'cancel');
      assert.equal(message.reason, reason);
      assert.equal(message.reason, raw);
      assert.deepStrictEqual(encode(message), data);
    }
  });

  // MARK: - Text cut for the air (spec §8, revision 7)

  /**
   * Bit 0 of a Text's nibble: the product was longer than eight packets and the bot dropped the
   * tail. It sits beside the source bits and survives a re-encode.
   */
  test('theTextCutFlagIsBitZeroAndRoundTrips', () => {
    const cut = MeshWXEncoder.text({
      seq: 5,
      bot: 19578,
      subject: MeshWXTextSubject.forecastDiscussion,
      group: 5,
      index: 3,
      total: 4,
      text: '…SHORT TERM…',
      wasCut: true,
      source: MeshWXDataSource.goesSatellite,
    });
    assert.equal(cut[3] & 0x0f, 0b0101, 'cut on bit 0, GOES on bits 3-2');
    assert.ok(decode(cut).cut);
    assert.equal(MeshWXHeader.dataSource(decodeHeader(cut)), MeshWXDataSource.goesSatellite);
    assert.deepStrictEqual(encode(decode(cut)), cut);

    const whole = MeshWXEncoder.text({
      seq: 6,
      bot: 19578,
      subject: MeshWXTextSubject.forecastDiscussion,
      group: 6,
      index: 0,
      total: 1,
      text: '…SHORT TERM…',
    });
    assert.equal(whole[3] & 0x0f, 0);
    assert.equal(decode(whole).cut, false);
  });

  /**
   * The bot marks *every* chunk, not only the last: a phone that never receives the last one
   * still has to know the reply is short of the product.
   */
  test('aCutReplyMarksEveryChunkOfIt', () => {
    const chunks = MeshWXEncoder.textChunks({
      seqStart: 40,
      bot: 19578,
      subject: MeshWXTextSubject.forecastDiscussion,
      text: 'x'.repeat(400),
      wasCut: true,
      source: MeshWXDataSource.internet,
    });
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) {
      assert.ok(decode(chunk).cut);
      assert.equal(MeshWXHeader.dataSource(decodeHeader(chunk)), MeshWXDataSource.internet);
      assert.deepStrictEqual(encode(decode(chunk)), chunk);
    }
  });

  // MARK: - Area sweep (type 10, spec §12)

  /** Texas zones 192 through 197 under a Severe Thunderstorm Warning, as one entry. */
  const texasZones = { event: 3, state: 42, county: false, start: 192, run: 6 };

  /**
   * The eleven-byte header the contract prints, field by field, before any entry: `built` at
   * offset 4 as u32 LE minutes, then `group`, `idx` and `total`.
   */
  test('theSweepHeaderIsTheElevenBytesTheContractPrints', () => {
    const data = MeshWXEncoder.areaSweep({
      seq: 9,
      bot: 0x4c7a,
      builtMinutes: 29_823_945,
      group: 9,
      index: 0,
      total: 3,
      entries: [texasZones],
    });
    assert.equal(data.length, 15, '11 fixed plus one 4-byte entry');
    assert.deepStrictEqual(
      data.subarray(0, 4), bytes(0x09, 0x7a, 0x4c, 0xa0), 'type 10 in the high nibble',
    );
    assert.deepStrictEqual(
      data.subarray(4, 8), bytes(0xc9, 0x13, 0xc7, 0x01), '29 823 945 minutes, little-endian',
    );
    assert.equal(data[8], 9);
    assert.equal(data[9], 0);
    assert.equal(data[10], 3);

    const sweep = decode(data);
    assert.equal(sweep.built_min, 29_823_945);
    assert.equal(sweep.group, 9);
    assert.equal(sweep.idx, 0);
    assert.equal(sweep.total, 3);
    assert.deepStrictEqual(encode(decode(data)), data);
  });

  /**
   * One entry, byte by byte: the event, then `state << 1 | kind`, then a u16 whose low ten bits
   * are the start and whose high six are the run less one.
   *
   * The state and kind sit the *other* way round from a Warning's area run, which packs the kind
   * into bit 7 and the state into bits 6-0. Two layouts for the same two fields is exactly the
   * kind of thing a round trip alone would never catch.
   */
  test('aSweepEntryPacksTheEventStateKindStartAndRun', () => {
    const data = MeshWXEncoder.areaSweep({
      seq: 1, bot: 0x4c7a, builtMinutes: 0, group: 1, index: 0, total: 1, entries: [texasZones],
    });
    const entry = data.subarray(data.length - 4);
    assert.equal(entry.length, 4);
    assert.deepStrictEqual([...entry], [3, 42 << 1, 0xc0, 0x14]);
    // 0x14C0 = 0b0001_01_00_1100_0000: run − 1 = 5 in bits 10-15, start = 192 in bits 0-9.
    assert.equal(0x14c0 & 0x03ff, 192);
    assert.equal(0x14c0 >> 10, 5);

    const decoded = decode(data).entries;
    assert.deepStrictEqual(decoded, [texasZones]);
    assert.equal(decoded[0].county, false);
    assert.equal(decoded[0].state, 42);
  });

  /** A county entry sets bit 0 and leaves the state where it was. */
  test('theCountyBitIsBitZeroAndDoesNotDisturbTheState', () => {
    const county = { event: 3, state: 42, county: true, start: 453, run: 1 };
    const data = MeshWXEncoder.areaSweep({
      seq: 1, bot: 0x4c7a, builtMinutes: 0, group: 1, index: 0, total: 1, entries: [county],
    });
    assert.equal(data[12], (42 << 1) | 1);
    const decoded = decode(data).entries;
    assert.deepStrictEqual(decoded, [county]);
    assert.equal(decoded[0].state, 42, 'the state survives the kind bit under it');
  });

  /**
   * An entry expands to the UGC codes the run covers — the whole reason the sweep fits in eight
   * packets. A run never crosses a state, so every code carries the same two letters.
   */
  test('anEntryExpandsToItsUGCCodes', () => {
    const bundleStates = tables.states;
    assert.deepStrictEqual(
      MeshWXAreaSweep.Entry.numbers(texasZones), [192, 193, 194, 195, 196, 197],
    );
    assert.deepStrictEqual(
      MeshWXAreaSweep.Entry.ugcCodes(texasZones, { states: bundleStates }),
      ['TXZ192', 'TXZ193', 'TXZ194', 'TXZ195', 'TXZ196', 'TXZ197'],
    );

    const counties = { event: 3, state: 42, county: true, start: 8, run: 3 };
    assert.deepStrictEqual(
      MeshWXAreaSweep.Entry.ugcCodes(counties, { states: bundleStates }),
      ['TXC008', 'TXC009', 'TXC010'],
    );

    // An older bundle decoding a newer bot's sweep loses the names, never the message.
    assert.deepStrictEqual(
      MeshWXAreaSweep.Entry.ugcCodes(
        { event: 3, state: 120, county: false, start: 1, run: 1 }, { states: bundleStates },
      ),
      [],
    );
  });

  /** The run field is six bits carried less one, so it spans 1 to 64 and never 0. */
  test('theRunFieldSpansOneToSixtyFour', () => {
    for (const run of [1, 2, 63, 64]) {
      const entry = { event: 9, state: 26, county: false, start: 1, run };
      const data = MeshWXEncoder.areaSweep({
        seq: 1, bot: 0x4c7a, builtMinutes: 0, group: 1, index: 0, total: 1, entries: [entry],
      });
      const decoded = decode(data).entries;
      assert.deepStrictEqual(decoded, [entry]);
      assert.equal(MeshWXAreaSweep.Entry.numbers(decoded[0]).length, run);
      assert.deepStrictEqual(encode(decode(data)), data);
    }
    // 65 has no encoding, and clamping it would move an area into a state's next county.
    assert.throws(() => MeshWXEncoder.areaSweep({
      seq: 1,
      bot: 0x4c7a,
      builtMinutes: 0,
      group: 1,
      index: 0,
      total: 1,
      entries: [{ event: 9, state: 26, county: false, start: 1, run: 65 }],
    }), encodeError('outOfRange'));
    assert.throws(() => MeshWXEncoder.areaSweep({
      seq: 1,
      bot: 0x4c7a,
      builtMinutes: 0,
      group: 1,
      index: 0,
      total: 1,
      entries: [{ event: 9, state: 26, county: false, start: 1, run: 0 }],
    }), encodeError('outOfRange'));
  });

  /** Ten bits of start: 1023 fits and 1024 does not. */
  test('theStartFieldIsTenBitsWide', () => {
    const edge = { event: 9, state: 5, county: true, start: 1023, run: 1 };
    const data = MeshWXEncoder.areaSweep({
      seq: 1, bot: 0x4c7a, builtMinutes: 0, group: 1, index: 0, total: 1, entries: [edge],
    });
    assert.deepStrictEqual(decode(data).entries, [edge]);
    assert.throws(() => MeshWXEncoder.areaSweep({
      seq: 1,
      bot: 0x4c7a,
      builtMinutes: 0,
      group: 1,
      index: 0,
      total: 1,
      entries: [{ event: 9, state: 5, county: true, start: 1024, run: 1 }],
    }), encodeError('outOfRange'));
  });

  /**
   * The flags nibble: bit 0 cut, bit 1 advisories, bits 3-2 the source — four independent claims
   * in one nibble, each of which has to survive a re-encode.
   */
  test('theSweepFlagsAreCutAdvisoriesAndSource', () => {
    for (const cut of [false, true]) {
      for (const advisories of [false, true]) {
        for (const source of MeshWXDataSource.allCases) {
          const data = MeshWXEncoder.areaSweep({
            seq: 2,
            bot: 0x4c7a,
            builtMinutes: 29_823_945,
            group: 2,
            index: 1,
            total: 2,
            entries: [texasZones],
            wasCut: cut,
            includesAdvisories: advisories,
            source,
          });
          const expected = (cut ? 0x1 : 0) | (advisories ? 0x2 : 0) | (source << 2);
          assert.equal(data[3] & 0x0f, expected);
          const sweep = decode(data);
          assert.equal(sweep.cut, cut);
          assert.equal(sweep.advisories, advisories);
          assert.equal(MeshWXHeader.dataSource(decodeHeader(data)), source);
          assert.deepStrictEqual(encode(decode(data)), data);
        }
      }
    }
  });

  /** 38 entries is what `(165 − 11) / 4` leaves, and the packet budget is what refuses the 39th. */
  test('aPacketCarriesAtMostThirtyEightEntries', () => {
    const entries = Array.from({ length: 38 }, (_, index) => ({
      event: 3, state: 42, county: false, start: index, run: 1,
    }));
    const full = MeshWXEncoder.areaSweep({
      seq: 1, bot: 0x4c7a, builtMinutes: 0, group: 1, index: 0, total: 1, entries,
    });
    assert.equal(full.length, 163);
    assert.ok(full.length <= MeshWXWire.maxData);
    assert.equal(decode(full).entries.length, 38);
    assert.deepStrictEqual(encode(decode(full)), full);

    assert.throws(() => MeshWXEncoder.areaSweep({
      seq: 1,
      bot: 0x4c7a,
      builtMinutes: 0,
      group: 1,
      index: 0,
      total: 1,
      entries: [...entries, texasZones],
    }), encodeError('badCount'));
  });

  /**
   * A sweep is at most eight packets, and `idx` has to be inside `total` — an encoder that let
   * `3 of 2` out would break the assembly on every phone that heard it.
   */
  test('aSweepIsAtMostEightPacketsAndTheIndexIsInsideTheTotal', () => {
    for (const total of [1, 8]) {
      MeshWXEncoder.areaSweep({
        seq: 1,
        bot: 0x4c7a,
        builtMinutes: 0,
        group: 1,
        index: total - 1,
        total,
        entries: [texasZones],
      });
    }
    for (const [index, total] of [[0, 0], [0, 9], [2, 2]]) {
      assert.throws(() => MeshWXEncoder.areaSweep({
        seq: 1, bot: 0x4c7a, builtMinutes: 0, group: 1, index, total, entries: [texasZones],
      }), encodeError());
    }
  });

  /**
   * No entries is a legal packet: a sweep of a quiet country still has to say when it was built
   * and how many packets it is.
   */
  test('anEmptySweepPacketDecodes', () => {
    const data = MeshWXEncoder.areaSweep({
      seq: 1, bot: 0x4c7a, builtMinutes: 29_823_945, group: 1, index: 0, total: 1, entries: [],
    });
    assert.equal(data.length, 11);
    const sweep = decode(data);
    assert.equal(sweep.entries.length, 0);
    assert.equal(sweep.built_min, 29_823_945);
    assert.deepStrictEqual(encode(decode(data)), data);
  });

  /**
   * Under eleven bytes there is no sweep to read; a trailing byte that does not make a whole
   * entry is left alone, the way every other type here tolerates one.
   */
  test('aShortSweepThrowsAndATrailingByteIsIgnored', () => {
    assert.throws(
      () => decode(bytes(0x01, 0x7a, 0x4c, 0xa0, 0, 0, 0, 0, 1, 0)),
      (error) => error instanceof MeshWXDecodeError,
    );
    const data = MeshWXEncoder.areaSweep({
      seq: 1, bot: 0x4c7a, builtMinutes: 0, group: 1, index: 0, total: 1, entries: [texasZones],
    });
    const sweep = decode(bytes([...data], [0xab, 0xcd, 0xef]));
    assert.deepStrictEqual(sweep.entries, [texasZones]);
  });

  // MARK: - Scoped sweeps (spec §12, revision 10)

  /**
   * Bit 7 of the `total` byte, on every packet: "so a phone that lost packet 0 still knows it is
   * not looking at the country". `total & 0x0F` is the count, and nothing above the codec ever
   * has to mask a byte to read one.
   */
  test('theScopedBitRidesOnTheTotalByteAndIsNotPartOfTheCount', () => {
    const data = MeshWXEncoder.areaSweep({
      seq: 1,
      bot: 0x4c7a,
      builtMinutes: 29_823_900,
      group: 34,
      index: 1,
      total: 2,
      isScoped: true,
      entries: [texasZones],
    });
    assert.equal(data[10], 0x82, 'bit 7 set, count 2');
    const sweep = decode(data);
    assert.equal(sweep.total, 2);
    assert.equal(sweep.scoped, true);
    assert.deepStrictEqual(sweep.scope, [], 'a packet past 0 carries no scope entries');
    assert.deepStrictEqual(sweep.entries, [texasZones]);
    assert.deepStrictEqual(encode(sweep), data);
  });

  /**
   * `XXZ000` is the Weather Service's own way of writing "all of state XX": event 0, kind zone,
   * start 0, run 1. The decoder lifts them out of `entries` and the encoder puts them back
   * first, so `entries` is alert entries only and the bytes are unchanged either way.
   */
  test('scopeEntriesAreLiftedOutOfEntriesAndPutBackFirst', () => {
    const data = MeshWXEncoder.areaSweep({
      seq: 1,
      bot: 0x4c7a,
      builtMinutes: 29_823_900,
      group: 34,
      index: 0,
      total: 1,
      isScoped: true,
      scope: [35, 42],
      entries: [texasZones],
    });
    assert.equal(data.length, 11 + 3 * 4, 'two scope entries and one alert entry');
    assert.deepStrictEqual([...data.subarray(11, 15)], [0, 35 << 1, 0, 0]);
    assert.deepStrictEqual([...data.subarray(15, 19)], [0, 42 << 1, 0, 0]);

    const sweep = decode(data);
    assert.deepStrictEqual(sweep.scope, [35, 42]);
    assert.deepStrictEqual(sweep.entries, [texasZones], 'entries are alert entries only');
    assert.deepStrictEqual(encode(sweep), data);
  });

  /** A national sweep encodes to exactly the bytes it always did: no bit, no entries. */
  test('aNationalSweepIsByteIdenticalToTheRevisionNineForm', () => {
    const before = MeshWXEncoder.areaSweep({
      seq: 9, bot: 0x4c7a, builtMinutes: 29_823_945, group: 9, index: 0, total: 3,
      entries: [texasZones],
    });
    const after = MeshWXEncoder.areaSweep({
      seq: 9, bot: 0x4c7a, builtMinutes: 29_823_945, group: 9, index: 0, total: 3,
      entries: [texasZones], isScoped: false, scope: [],
    });
    assert.deepStrictEqual(after, before);
    const sweep = decode(before);
    assert.equal(sweep.scoped, false);
    assert.deepStrictEqual(sweep.scope, []);
  });

  /** Fifteen states, and the scope entries count toward the 38 an entry budget holds. */
  test('theScopeIsBoundedByFifteenStatesAndByThePacketBudget', () => {
    const scope = Array.from({ length: MeshWXWire.maxSweepScopeStates }, (unused, index) => index + 1);
    const ok = MeshWXEncoder.areaSweep({
      seq: 1, bot: 1, builtMinutes: 0, group: 1, index: 0, total: 1, isScoped: true, scope,
      entries: Array.from(
        { length: MeshWXWire.maxAreaSweepEntries - MeshWXWire.maxSweepScopeStates },
        () => texasZones,
      ),
    });
    assert.equal(ok.length, 11 + MeshWXWire.maxAreaSweepEntries * 4);
    assert.equal(ok.length <= MeshWXWire.maxData, true);

    assert.throws(() => MeshWXEncoder.areaSweep({
      seq: 1, bot: 1, builtMinutes: 0, group: 1, index: 0, total: 1, isScoped: true,
      scope: [...scope, 99], entries: [],
    }), (error) => error.kind === 'badCount');

    assert.throws(() => MeshWXEncoder.areaSweep({
      seq: 1, bot: 1, builtMinutes: 0, group: 1, index: 0, total: 1, isScoped: true, scope,
      entries: Array.from(
        { length: MeshWXWire.maxAreaSweepEntries - MeshWXWire.maxSweepScopeStates + 1 },
        () => texasZones,
      ),
    }), (error) => error.kind === 'badCount');
  });

  // MARK: - Revision 10's request texts (spec §14)

  /**
   * The three new `>` lines through the Request encoder that already carried `>d`. The budget is
   * what makes them worth a test: `>wmap all ` and fifteen two-letter codes is exactly 40 bytes,
   * the whole of what a Request's text may take.
   */
  test('theRevisionTenRequestTextsFitTheRequestBudget', () => {
    const sender = bytes(0x01, 0x02, 0x03, 0x04, 0x05, 0x06);
    const send = (text) => decode(MeshWXEncoder.request({
      seq: 1, bot: 0x041d, senderPrefix: sender, timestamp: 1_789_660_000, text,
    }));
    for (const text of ['>part 212 1,4,6', '>f 35.687,-105.938', '>wmap all TXOK']) {
      assert.equal(send(text).text, text);
    }

    const fifteen = 'AKALARAZCACOCTDEFLGAHIIAIDIL';
    const widest = `>wmap all ${fifteen}TX`;
    assert.equal(widest.length, MeshWXWire.maxRequestTextBytes);
    assert.equal(send(widest).text, widest);

    assert.throws(
      () => MeshWXEncoder.request({
        seq: 1, bot: 0x041d, senderPrefix: sender, timestamp: 0, text: `${widest}WY`,
      }),
      (error) => error.kind === 'oversize',
    );
  });

  // MARK: - The JS-only convenience exports
  //
  // Not in the Swift suite: these are the names PORTING §3 and the layer contract add so that
  // other layers can key, parse and hand around values without reading this code.

  test('warningIdentitiesKeyParseAndComeOffAnyMessageThatCarriesOne', () => {
    const identity = { event: 3, office: 35, etn: 42 };
    assert.equal(MeshWXWarningIdentity.key(identity), '3.35.42');
    assert.deepStrictEqual(MeshWXWarningIdentity.parse('3.35.42'), identity);
    assert.equal(MeshWXWarningIdentity.parse('3.35'), null);
    assert.equal(MeshWXWarningIdentity.parse('SV.W.EWX.42'), null);
    assert.equal(MeshWXWarningIdentity.parse('3.35.x'), null);

    // A warning, a cancel and a digest entry all spell it the same way.
    const warning = decode(MeshWXEncoder.warning({
      seq: 1, bot: 1, identity, expiresMinutes: 29_823_945,
    }));
    const cancel = decode(MeshWXEncoder.cancel({ seq: 2, bot: 1, identity }));
    const digest = decode(MeshWXEncoder.digest({
      seq: 3,
      bot: 1,
      nowMinutes: 29_823_900,
      feedHealth: 0,
      entries: [{ identity, expiresMinutes: 29_823_945 }],
    }));
    for (const value of [warning, cancel, digest.entries[0]]) {
      assert.deepStrictEqual(MeshWXWarningIdentity.of(value), identity);
      assert.equal(MeshWXWarningIdentity.key(MeshWXWarningIdentity.of(value)), '3.35.42');
    }
  });

  test('hexHelpersRoundTripAndRefuseNonHex', () => {
    const data = bytes(0x00, 0x0f, 0xa0, 0xff);
    assert.equal(bytesToHex(data), '000fa0ff');
    assert.deepStrictEqual(hexToBytes('000FA0FF'), data);
    assert.throws(() => hexToBytes('abc'), TypeError);
    assert.throws(() => hexToBytes('zz'), TypeError);
  });

  test('theSmallAccessorsOtherLayersReadValuesThrough', () => {
    const warning = decode(bytes(
      [0x11, 0x7a, 0x4c, 0x10, 0x03, 0x23, 0x2a, 0x00, 0xc9, 0x13, 0xc7, 0x01],
      [0x02, 0x00, 0x00, 0x03],
      [0x30, 0xa8, 0x04, 0xa8, 0x0c, 0xf1],
      [0x5a, 0x00, 0x68, 0x01, 0x1a, 0xff, 0xd2, 0x00],
    ));
    assert.deepStrictEqual(MeshWXWarning.polygonCoordinates(warning)[0], {
      latitude: 30.52, longitude: -97.98,
    });
    assert.equal(MeshWXWarning.polygonCoordinates(decode(MeshWXEncoder.warning({
      seq: 0, bot: 0, identity: svw, expiresMinutes: 0,
    }))), null);

    const unbundled = decode(MeshWXEncoder.forecast({
      seq: 0,
      bot: 0,
      pointIndex: MeshWXWire.unbundledPoint,
      issuedMinutes: 0,
      firstPeriod: 0,
      periods: [MeshWXForecastPeriod.make({ high_f: 90, low_f: 70 })],
    }));
    assert.ok(MeshWXForecast.isUnbundledPoint(unbundled));

    const notAvailable = decode(MeshWXEncoder.notAvailable({
      seq: 0, bot: 0, request: '>f 78701', reason: MeshWXNotAvailableReason.unknownLocation,
    }));
    assert.equal(MeshWXNotAvailable.requestLetter(notAvailable), 'f');
    assert.equal(notAvailable.request, 'f');

    const toAll = MeshWXRequest.make({
      seq: 0,
      botID: MeshWXRequest.anyBot,
      senderPrefix: '010203040506',
      timestamp: 1,
      text: '>d',
    });
    assert.ok(MeshWXRequest.isForAnyBot(toAll));
    assert.ok(!MeshWXRequest.isForAnyBot({ ...toAll, bot: 0x041d }));
  });
});
