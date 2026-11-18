// Port of MC1Services/Tests/MeshWXTests/MeshWXRadarTests.swift, and of the bot's own
// tests/test_radar.py (the lattice and codec halves of it; the GIF reading is the bot's).
//
// Radar, type 11, spec §13, revision 11. The lattice cases below are the reference's
// parametrised list value for value: two clients that round a tie differently ask for two
// different tiles, and the channel pays for both.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshWXDecodeError,
  MeshWXEncodeError,
  MeshWXEncoder,
  MeshWXMessageType,
  MeshWXRadar,
  MeshWXRadarBounds,
  MeshWXRadarLevel,
  MeshWXRadarTile,
  MeshWXWire,
  bytesToHex,
  decode,
  encode,
} from '../src/meshwx/index.js';

const BOT = 0x4c7a;
/** 2026-09-20 23:38 UTC, the minute printed on the fixture pictures. */
const TAKEN_MIN = 29832458;

/** A grid of `size` rows with `cells` (`[row, col, level]`) set and everything else dry. */
function rows(size, cells = []) {
  const grid = Array.from({ length: size }, () => new Array(size).fill(0));
  for (const [row, col, level] of cells) grid[row][col] = level;
  return grid;
}

function tile({ size = 32, cells = [], ...options } = {}) {
  return MeshWXEncoder.radar({
    seq: 1,
    bot: BOT,
    takenMinutes: TAKEN_MIN,
    south: 29,
    west: -99,
    zoom: 0,
    product: 1,
    rows: rows(size, cells),
    ...options,
  });
}

/**
 * A deterministic pseudo-random source.
 *
 * Deviation from the reference, which seeds Python's Mersenne Twister with 11: no two languages
 * agree on a generator's output, so the *cases* cannot be ported, only the property they check
 * — that every grid round trips, and that a 16 × 16 always fits where a 32 × 32 may not.
 */
function randoms(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('MeshWXRadarTile', () => {
  /** The reference's own parametrised list (`test_the_tile_for_a_coordinate`). */
  test('theTileForACoordinate', () => {
    const cases = [
      [30.27, -97.74, 0, { south: 29, west: -99 }],      // Austin: centre 30, -98
      [32.78, -96.80, 0, { south: 32, west: -98 }],      // Dallas: centre 33, -97
      [30.5, -97.5, 0, { south: 30, west: -98 }],        // a tie rounds up, in every language
      [-0.4, 0.4, 0, { south: -1, west: -1 }],           // across the equator and Greenwich
      [30.27, -97.74, 1, { south: 28, west: -100 }],     // step 2
      [30.27, -97.74, 2, { south: 28, west: -100 }],     // step 4: centre 32, -96
      [30.27, -97.74, 3, { south: 24, west: -104 }],     // step 8: centre 32, -96
      [18.22, -66.59, 0, { south: 17, west: -68 }],      // Puerto Rico
    ];
    for (const [latitude, longitude, zoom, want] of cases) {
      assert.deepStrictEqual(
        MeshWXRadarTile.containing({ latitude, longitude, zoom }),
        { ...want, zoom },
        `${latitude},${longitude} z${zoom}`,
      );
    }
  });

  /**
   * The whole point of putting the lattice at half the span: the place asked about is never
   * nearer than a quarter of the tile to an edge, so the storm coming at it is on the picture.
   */
  test('aPlaceIsNeverNearTheEdgeOfItsTile', () => {
    const places = [[30.27, -97.74], [47.61, -122.33], [25.76, -80.19], [64.84, -147.72], [-33.9, 151.2]];
    for (let zoom = 0; zoom <= MeshWXWire.maxRadarZoom; zoom += 1) {
      for (const [latitude, longitude] of places) {
        const square = MeshWXRadarTile.containing({ latitude, longitude, zoom });
        const span = MeshWXRadarTile.spanDegrees(square);
        assert.equal(span, 2 << zoom);
        for (const [value, edge] of [[latitude, square.south], [longitude, square.west]]) {
          assert.ok(value - edge >= span / 4 && value - edge <= (3 * span) / 4,
            `${value} is ${value - edge} into a ${span}° tile`);
        }
      }
    }
  });

  // The lattice clamps, as the Swift does; the encoder is where a zoom of 4 is refused.
  test('zoomOutOfRangeIsClamped', () => {
    assert.deepEqual(MeshWXRadarTile.containing({ latitude: 30.27, longitude: -97.74, zoom: 4 }),
      MeshWXRadarTile.containing({ latitude: 30.27, longitude: -97.74, zoom: 3 }));
    assert.deepEqual(MeshWXRadarTile.containing({ latitude: 30.27, longitude: -97.74, zoom: -1 }),
      { south: 29, west: -99, zoom: 0 });
  });

  /**
   * Row 0 is the northern row and column 0 the western one (spec §13), which is the picture's
   * order and the opposite of latitude's.
   */
  test('cellsAreNumberedFromTheNorthWestCorner', () => {
    const square = MeshWXRadarTile.make({ south: 32, west: -98, zoom: 0 });
    assert.equal(MeshWXRadarTile.north(square), 34);
    assert.equal(MeshWXRadarTile.east(square), -96);

    const first = MeshWXRadarTile.cellBox(square, { row: 0, col: 0, size: 32 });
    assert.deepStrictEqual(first, { south: 34 - 1 / 16, west: -98, north: 34, east: -98 + 1 / 16 });
    const last = MeshWXRadarTile.cellBox(square, { row: 31, col: 31, size: 32 });
    assert.deepStrictEqual(last, { south: 32, west: -96 - 1 / 16, north: 32 + 1 / 16, east: -96 });

    // A coarse cell is twice as wide, and the corner cells still sit in the corners.
    assert.deepStrictEqual(
      MeshWXRadarTile.cellBox(square, { row: 0, col: 0, size: 16 }),
      { south: 34 - 1 / 8, west: -98, north: 34, east: -98 + 1 / 8 },
    );
  });

  test('aCoordinateFindsItsCell', () => {
    const square = MeshWXRadarTile.make({ south: 32, west: -98, zoom: 0 });
    assert.ok(MeshWXRadarTile.contains(square, { latitude: 32.78, longitude: -96.8 }));
    assert.deepStrictEqual(
      MeshWXRadarTile.cell(square, { latitude: 32.78, longitude: -96.8, size: 32 }),
      { row: 19, col: 19 },
    );
    // The centre of that cell, which is what a distance is measured to.
    const centre = MeshWXRadarTile.cellCentre(square, { row: 19, col: 19, size: 32 });
    assert.ok(Math.abs(centre.latitude - 32.78125) < 1e-9);
    assert.ok(Math.abs(centre.longitude - -96.78125) < 1e-9);

    // Off the square in each direction.
    assert.equal(MeshWXRadarTile.cell(square, { latitude: 35, longitude: -97, size: 32 }), null);
    assert.equal(MeshWXRadarTile.cell(square, { latitude: 33, longitude: -99, size: 32 }), null);
    assert.ok(!MeshWXRadarTile.contains(square, { latitude: 33, longitude: -95.9 }));

    // The edges: half-open on the north and on the east, so the southern and western edges are
    // on the tile and the other two belong to the neighbours. A place on a whole degree has to
    // read the same here, in the app and in the DM the bot sends, and on 20 September 2026 all
    // three were settled on this rule.
    assert.ok(!MeshWXRadarTile.contains(square, { latitude: 34, longitude: -98 }));
    assert.ok(MeshWXRadarTile.contains(square, { latitude: 32, longitude: -98 }));
    assert.ok(!MeshWXRadarTile.contains(square, { latitude: 33, longitude: -96 }));
    // The southern row is row 31, not a row 32 off the end of the grid: the index is clamped
    // after the division, because an index out of range here would be an index into a cell array.
    assert.deepStrictEqual(
      MeshWXRadarTile.cell(square, { latitude: 32, longitude: -98, size: 32 }), { row: 31, col: 0 },
    );
  });

  test('tilesAreComparedByTheirThreeNumbers', () => {
    const square = MeshWXRadarTile.make({ south: 32, west: -98, zoom: 0 });
    assert.equal(MeshWXRadarTile.key(square), '32,-98,0');
    assert.ok(MeshWXRadarTile.isEqual(square, { south: 32, west: -98, zoom: 0 }));
    assert.ok(!MeshWXRadarTile.isEqual(square, { south: 32, west: -98, zoom: 1 }));
    assert.ok(!MeshWXRadarTile.isEqual(square, null));
  });
});

describe('MeshWXRadar codec', () => {
  /** Spec §13: an all-dry tile is three bits, so a clear picture is thirteen bytes. */
  test('aDryTileIsOneByteOfCells', () => {
    const data = MeshWXEncoder.radar({
      seq: 7,
      bot: BOT,
      takenMinutes: TAKEN_MIN,
      south: 29,
      west: -99,
      zoom: 0,
      product: 1,
      rows: rows(32),
      source: 1,
    });
    assert.equal(data.length, 13);
    assert.equal(data[3], (MeshWXMessageType.radar << 4) | 0x4, 'type 11, flags 0x4 = source 1');
    assert.equal(data[12], 0, 'split bit 0, level 00, then padding');

    const out = decode(data);
    assert.equal(out.name, 'radar');
    assert.equal(out.size, 32);
    assert.equal(out.coarse, false);
    assert.equal(out.partial, false);
    assert.deepStrictEqual(
      [out.south, out.west, out.zoom, out.product], [29, -99, 0, 1],
    );
    assert.equal(out.taken_min, TAKEN_MIN);
    assert.equal(out.source, 1);
    assert.equal(out.bounds, null);
    assert.deepStrictEqual(out.rows, new Array(32).fill('0'.repeat(32)));
  });

  /**
   * One heavy cell in the north-west corner of a 16 × 16 tile: split at 16, 8, 4 and 2,
   * north-west first each time. The reference's `test_the_quadtree_bit_order`, which is the one
   * test that would catch two children swapped — a round trip through this file alone would not.
   */
  test('theQuadtreeBitOrder', () => {
    const data = tile({
      size: 16, cells: [[0, 0, 3]], takenMinutes: 1, south: 0, west: 0, product: 0, source: 0,
    });
    assert.ok((data[3] & MeshWXWire.radarCoarseBit) !== 0);
    let bits = '';
    for (const byte of data.subarray(12)) bits += byte.toString(2).padStart(8, '0');
    // 16: split. 8 NW: split. 4 NW: split. 2 NW: split, then the cells 11 00 00 00.
    // Then the three dry 2-squares, 4-squares and 8-squares, each `0 00`.
    assert.ok(bits.startsWith(`1111${'11000000'}${'000'.repeat(9)}`));
    assert.ok([...bits.slice(4 + 8 + 27)].every((bit) => bit === '0'), 'the tail is padding');
    assert.equal(decode(data).rows[0], `3${'0'.repeat(15)}`);
  });

  test('everyGridRoundTrips', () => {
    const random = randoms(11);
    let done = 0;
    for (let round = 0; round < 300; round += 1) {
      const size = random() < 0.5 ? 16 : 32;
      const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => {
        if (random() >= 0.15) return 0;
        const pick = random();
        return pick < 0.5 ? 1 : (pick < 0.75 ? 2 : 3);
      }));
      let data;
      try {
        data = MeshWXEncoder.radar({
          seq: 1, bot: BOT, takenMinutes: 5, south: -10, west: 170, zoom: 3, product: 14, rows: grid,
        });
      } catch (error) {
        assert.ok(error instanceof MeshWXEncodeError);
        assert.equal(size, 32, 'a coarse tile always fits');
        continue;
      }
      const out = decode(data);
      assert.deepStrictEqual(out.rows, grid.map((row) => row.join('')));
      assert.deepStrictEqual(
        [out.south, out.west, out.zoom, out.product, out.size], [-10, 170, 3, 14, size],
      );
      assert.equal(bytesToHex(encode(out)), bytesToHex(data), 're-encode is byte-identical');
      done += 1;
    }
    assert.ok(done > 100, `${done} grids fitted a packet`);
  });

  /**
   * The claim the whole design rests on: whatever the picture, the 16 × 16 form fits one packet,
   * so the bot never has to split a radar answer and there is no `>part` for one.
   */
  test('theWorstCoarseTileStillFits', () => {
    const grid = Array.from({ length: 16 }, (_, row) => Array.from(
      { length: 16 }, (__, col) => (row * 7 + col * 3) % 4,
    ));
    const data = MeshWXEncoder.radar({
      seq: 1,
      bot: BOT,
      takenMinutes: 5,
      south: 0,
      west: 0,
      zoom: 0,
      product: 0,
      rows: grid,
      bounds: [0, 15, 0, 15],
    });
    assert.ok(data.length <= MeshWXWire.maxData, `${data.length} bytes`);
  });

  test('partialTilesCarryTheirBoundsAndNothingOutsideThem', () => {
    const data = tile({
      size: 16,
      cells: [[2, 3, 1], [9, 11, 2]],
      takenMinutes: 5,
      south: 24,
      west: -100,
      zoom: 1,
      bounds: { row0: 0, row1: 9, col0: 0, col1: 15 },
      source: 0,
    });
    assert.equal(data[3] & 0x3, MeshWXWire.radarCoarseBit | MeshWXWire.radarPartialBit);
    assert.deepStrictEqual([...data.subarray(12, 16)], [0, 9, 0, 15]);

    const out = decode(data);
    assert.deepStrictEqual(out.bounds, [0, 9, 0, 15]);
    assert.deepStrictEqual(MeshWXRadarBounds.of(out), { row0: 0, row1: 9, col0: 0, col1: 15 });
    // Inside the bounds the picture answers; outside it there is no reading at all, which is
    // not the same as level 0 and must never be drawn as one.
    assert.ok(MeshWXRadar.isKnown(out, { row: 9, col: 15 }));
    assert.ok(!MeshWXRadar.isKnown(out, { row: 10, col: 0 }));
    assert.equal(MeshWXRadar.level(out, { row: 2, col: 3 }), MeshWXRadarLevel.light);
    assert.equal(MeshWXRadar.level(out, { row: 9, col: 11 }), MeshWXRadarLevel.moderate);

    // An echo where the picture does not reach is a contradiction the receiver cannot see.
    assert.throws(() => tile({
      size: 16, cells: [[12, 3, 1]], south: 24, west: -100, zoom: 1, bounds: [0, 9, 0, 15],
    }), MeshWXEncodeError);
  });

  test('boundsOutsideTheGridAreRefusedInBothDirections', () => {
    assert.throws(() => tile({ size: 16, bounds: [0, 16, 0, 15] }), MeshWXEncodeError);
    assert.throws(() => tile({ size: 16, bounds: [9, 2, 0, 15] }), MeshWXEncodeError);

    // And on the way in: a partial tile naming rows its own grid has not would have the screen
    // read a level off a cell the picture never covered.
    const data = tile({ size: 16, bounds: [0, 9, 0, 15] });
    const bad = Uint8Array.from(data);
    bad[13] = 15 + 1;
    assert.throws(() => decode(bad), (error) => error instanceof MeshWXDecodeError
      && error.kind === 'radarBoundsOutsideGrid');
  });

  /**
   * Spec §13: "A decoder rejects a packet whose bits run out before the tree is complete; bits
   * left over after it are padding." The two halves of one rule, and the reason for it is that a
   * half-read tree leaves the rest of the grid at level 0 — which reads as clear weather.
   */
  test('aCutOffTreeIsRefusedAndPaddingIsNot', () => {
    const data = tile({ cells: [[5, 5, 2], [20, 9, 1]] });
    assert.throws(() => decode(data.subarray(0, data.length - 2)), (error) => error instanceof MeshWXDecodeError
      && error.kind === 'radarTreeTruncated');

    const padded = Uint8Array.from([...data, 0]);
    assert.deepStrictEqual(decode(padded).rows, decode(data).rows);
  });

  test('aTruncatedFixedPartIsRefusedBeforeTheCells', () => {
    const data = tile({});
    assert.throws(() => decode(data.subarray(0, 12)), MeshWXDecodeError);
    const partial = tile({ size: 16, bounds: [0, 9, 0, 15] });
    assert.throws(() => decode(partial.subarray(0, 16)), MeshWXDecodeError);
  });

  test('theEncoderRefusesWhatTheWireCannotCarry', () => {
    assert.throws(() => tile({ zoom: 4 }), MeshWXEncodeError);
    // Zoom −1 was the detail level of revision 13's first draft, removed before release.
    assert.throws(() => tile({ zoom: -1 }), MeshWXEncodeError);
    assert.throws(() => tile({ product: 64 }), MeshWXEncodeError);
    assert.throws(() => tile({ west: 180 }), MeshWXEncodeError);
    assert.throws(() => tile({ south: 91 }), MeshWXEncodeError);
    assert.throws(() => tile({ size: 8 }), MeshWXEncodeError);
    assert.throws(() => tile({ cells: [[0, 0, 4]] }), MeshWXEncodeError);
  });

  test('theValueTypesReadTheDecodedMessage', () => {
    const out = decode(tile({ cells: [[0, 0, 1], [31, 31, 3]], south: 32, west: -98 }));
    assert.deepStrictEqual(MeshWXRadar.tile(out), { south: 32, west: -98, zoom: 0 });
    assert.equal(MeshWXRadar.size(out), 32);
    assert.equal(MeshWXRadar.wetCells(out), 2);
    assert.equal(MeshWXRadar.level(out, { row: 0, col: 0 }), MeshWXRadarLevel.light);
    assert.equal(MeshWXRadar.level(out, { row: 31, col: 31 }), MeshWXRadarLevel.heavy);
    assert.equal(MeshWXRadar.level(out, { row: 32, col: 0 }), null);
    assert.ok(MeshWXRadar.isKnown(out, { row: 0, col: 0 }), 'a whole tile knows every cell');
    assert.equal(MeshWXRadar.cellRows(out)[31][31], 3);
    assert.ok(MeshWXRadarLevel.isWet(MeshWXRadarLevel.light));
    assert.ok(!MeshWXRadarLevel.isWet(MeshWXRadarLevel.none));
  });

  /** `MeshWXRadar.make` builds the decoded shape from the Swift's own field names. */
  test('makeBuildsTheDecodedShapeFromSwiftNames', () => {
    const grid = rows(16, [[1, 2, 3]]);
    const built = MeshWXRadar.make({
      takenMinutes: TAKEN_MIN,
      south: 24,
      west: -100,
      zoom: 1,
      product: 1,
      bounds: { row0: 0, row1: 9, col0: 0, col1: 15 },
      cells: grid.flat(),
      source: 1,
      seq: 41,
      bot: BOT,
    });
    assert.equal(built.name, 'radar');
    assert.equal(built.coarse, true, 'a 16-row grid is what the coarse flag means');
    assert.equal(built.partial, true);
    assert.deepStrictEqual(built.bounds, [0, 9, 0, 15]);
    assert.equal(built.size, 16);
    assert.equal(built.rows[1], '0030000000000000');
    // Built by hand or decoded off the air, it is the same object.
    assert.deepStrictEqual(decode(encode(built)), built);
  });

  /**
   * Revision 13 as amended: the detail tile (type 12) was built, tried and removed before any
   * release, and type 12 is free again. A packet of that type is an unknown type like 13 to 15:
   * its header is kept for `(bot, seq)` and its body is never read as a picture.
   */
  test('radarDetailIsAnUnknownTypeAgain', () => {
    assert.equal(MeshWXMessageType.radarDetail, undefined);
    const data = Uint8Array.from(tile({ cells: [[3, 4, 2]], source: 1 }));
    data[3] = (12 << 4) | (data[3] & 0x0f);
    assert.deepStrictEqual(decode(data), { seq: 1, bot: BOT, type: 12, name: 'unknown', flags: data[3] & 0x0f });
  });
});
