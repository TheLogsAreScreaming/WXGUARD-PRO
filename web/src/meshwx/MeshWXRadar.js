// Port of MC1Services/Sources/MeshWX/MeshWXRadar.swift
//
// Radar (type 11, spec §13, revision 11): one tile of a radar picture, and the lattice the
// tiles sit on.
//
// The picture itself is the decoded wire object (PORTING §5) — `taken_min`, `south`, `west`,
// `zoom`, `product`, `coarse`, `partial`, `bounds`, `size`, `rows` — and `MeshWXRadar` is the
// namespace of functions over it. `rows` is `size` strings of the digits 0-3, north row first,
// west column first, exactly as the vectors print them.
//
// Two things here are worth naming rather than inlining wherever they are needed:
//
// - **The lattice.** Tiles sit on a lattice of half their span so that every phone can use a
//   tile any phone asked for: two people in the same town ask for the same square, and one
//   answer serves them both on a shared channel. The rounding is spelled out in integers and
//   `Math.floor(x / step + 0.5)` rather than a rounding function, because a tie has to fall the
//   same way in Python, Swift and JavaScript or the two clients ask for different tiles.
// - **Unknown is not dry.** A partial tile's cells outside `bounds` are level 0 on the wire,
//   because the wire has no fifth level, and they mean *the picture does not reach here*.
//   Everything that reads a cell goes through `MeshWXRadar.isKnown` or gets `null`.

import { MeshWXWire, MeshWXMessageType } from './MeshWXWire.js';

/**
 * A cell's level (spec §13): the **strongest** echo in the cell, never the average — a
 * thunderstorm core is smaller than a cell, and averaging it away is the one thing a radar
 * picture on a phone must not do.
 *
 * The thresholds are in `protocol.json` `v5.radar.levels_dbz` (20, 35, 50 dBZ), not here: a bot
 * one revision ahead may classify differently, and the bundle is what says how it did.
 */
export const MeshWXRadarLevel = Object.freeze({
  none: 0,
  light: 1,
  moderate: 2,
  heavy: 3,

  /** Every case, in raw order, for a legend or a test that iterates them. */
  allCases: Object.freeze([0, 1, 2, 3]),

  /** Never fails: the field is two bits wide and all four values are defined. */
  make({ raw }) {
    return raw & 0x3;
  },

  /** Anything above `none`: precipitation of some kind, which is what a summary counts. */
  isWet(level) {
    return level > MeshWXRadarLevel.none;
  },
});

/**
 * The part of a tile a partial picture covers (spec §13): `{ row0, row1, col0, col1 }`,
 * inclusive, in that packet's own grid — 0-31, or 0-15 when coarse.
 *
 * On the wire and in a decoded message this is the four-element array `bounds`, or null when
 * the picture covers the whole tile.
 */
export const MeshWXRadarBounds = Object.freeze({
  make({ row0, row1, col0, col1 }) {
    return { row0, row1, col0, col1 };
  },

  /** The decoded `bounds` array as a bounds value, or null when the tile is whole. */
  of(radar) {
    const bounds = radar?.bounds;
    if (bounds == null) return null;
    return { row0: bounds[0], row1: bounds[1], col0: bounds[2], col1: bounds[3] };
  },

  /** The four bytes, in wire order, as the decoded message carries them. */
  array(bounds) {
    return [bounds.row0, bounds.row1, bounds.col0, bounds.col1];
  },

  contains(bounds, { row, col }) {
    return row >= bounds.row0 && row <= bounds.row1 && col >= bounds.col0 && col <= bounds.col1;
  },

  /** Whether the four numbers describe a run of rows and columns inside a `size` grid. */
  isValid(bounds, { size }) {
    return bounds.row0 >= 0 && bounds.row0 <= bounds.row1 && bounds.row1 < size
      && bounds.col0 >= 0 && bounds.col0 <= bounds.col1 && bounds.col1 < size;
  },
});

/**
 * One square of the lattice: `{ south, west, zoom }`, all whole degrees and 0-3 (spec §13).
 *
 * Hashable and Codable in Swift, so here it is plain data with `key` for a dictionary and
 * `isEqual` for the comparisons that Swift gets from `==` (PORTING §3).
 */
export const MeshWXRadarTile = Object.freeze({
  make({ south, west, zoom }) {
    return { south, west, zoom };
  },

  /**
   * The tile that answers a coordinate: the one whose **centre** is the nearest lattice point,
   * so the place asked about is never closer than a quarter of the span to an edge (55 km at
   * zoom 0). The lattice step is half the span, `2^zoom` degrees, and `south` and `west` come
   * out whole at every zoom.
   *
   * `Math.floor(value / step + 0.5)` and not a rounding function: a tie has to fall the same way
   * here as in the bot's Python and the app's Swift, or two clients asking about the same place
   * ask for two different tiles and the channel pays for both.
   *
   * The zoom is clamped to 0…`maxRadarZoom`, so the −1 of revision 13's removed detail level
   * comes back as a zoom 0 tile.
   */
  containing({ latitude, longitude, zoom }) {
    // Clamped, as the Swift does: this is the lattice, not a request, and every caller wants a
    // tile back. The encoder is where a zoom of 4 is a failure.
    const level = Math.min(Math.max(Math.trunc(zoom) || 0, 0), MeshWXWire.maxRadarZoom);
    const step = 1 << level;
    const origin = (value) => Math.floor(value / step + 0.5) * step - step;
    return { south: origin(latitude), west: origin(longitude), zoom: level };
  },

  /** `2^(zoom + 1)` degrees on each side: 2, 4, 8, 16. */
  spanDegrees(tile) {
    return 2 << tile.zoom;
  },

  north(tile) {
    return tile.south + MeshWXRadarTile.spanDegrees(tile);
  },

  east(tile) {
    return tile.west + MeshWXRadarTile.spanDegrees(tile);
  },

  /**
   * Whether the coordinate is on this tile.
   *
   * **Half-open on the north and on the east**, `[south, north)` and `[west, east)`, so two
   * tiles of the same width never both claim a point on the degree between them. The three
   * codebases were split on this for a day — the app and this port read `(south, north]`, the
   * bot's `describe()` read it off the row index — and on 20 September 2026 all three were
   * settled on the Swift's rule, which is this one.
   *
   * Tiles of *different* widths do still overlap (the lattice step is half the span), so this
   * is "is the place on this square", never a partition of the earth.
   */
  contains(tile, { latitude, longitude }) {
    return latitude >= tile.south && latitude < MeshWXRadarTile.north(tile)
      && longitude >= tile.west && longitude < MeshWXRadarTile.east(tile);
  },

  /** One cell's width in degrees, for a grid of `size` cells a side. */
  cellDegrees(tile, { size }) {
    return size > 0 ? MeshWXRadarTile.spanDegrees(tile) / size : 0;
  },

  /**
   * The square of the earth one cell covers: `{ south, west, north, east }`.
   *
   * Row 0 is the **northern** row and column 0 the western one (spec §13), which is the picture's
   * own order and the opposite of latitude's, so the row arithmetic counts down from the top.
   */
  cellBox(tile, { row, col, size }) {
    const cell = MeshWXRadarTile.cellDegrees(tile, { size });
    const north = MeshWXRadarTile.north(tile) - row * cell;
    const west = tile.west + col * cell;
    return { south: north - cell, west, north, east: west + cell };
  },

  /** The middle of one cell, which is what a distance or a bearing is measured to. */
  cellCentre(tile, { row, col, size }) {
    const box = MeshWXRadarTile.cellBox(tile, { row, col, size });
    return { latitude: (box.south + box.north) / 2, longitude: (box.west + box.east) / 2 };
  },

  /**
   * The cell a coordinate falls in, `{ row, col }`, or null when it is not on this tile.
   *
   * `contains` decides whether the coordinate is on the square at all, and the row and column
   * are then **clamped** into the grid: a coordinate a hair inside the northern edge otherwise
   * lands on row −0 through floating point, and an index out of range here would be an index
   * into somebody's cell array.
   */
  cell(tile, { latitude, longitude, size }) {
    if (!(size > 0) || !MeshWXRadarTile.contains(tile, { latitude, longitude })) return null;
    const cell = MeshWXRadarTile.cellDegrees(tile, { size });
    const row = Math.floor((MeshWXRadarTile.north(tile) - latitude) / cell);
    const col = Math.floor((longitude - tile.west) / cell);
    const inside = (value) => Math.min(Math.max(value, 0), size - 1);
    return { row: inside(row), col: inside(col) };
  },

  /** `"32,-98,0"` — the dictionary key of PORTING §3, and what two tiles are compared by. */
  key(tile) {
    return `${tile.south},${tile.west},${tile.zoom}`;
  },

  isEqual(lhs, rhs) {
    if (lhs == null || rhs == null) return lhs === rhs;
    return MeshWXRadarTile.key(lhs) === MeshWXRadarTile.key(rhs);
  },
});

/**
 * One tile of a radar picture (type 11, spec §13), as the decoded wire object.
 *
 * `taken` is the time printed on the radar picture — not when the bot received it and not when
 * it sent it. It is the only clock a radar message carries, and everything on screen that says
 * how old the picture is says it from this.
 */
export const MeshWXRadar = Object.freeze({
  Level: MeshWXRadarLevel,
  Bounds: MeshWXRadarBounds,
  Tile: MeshWXRadarTile,

  /**
   * Build the decoded shape from the Swift's own field names, for a test or a fabricated tile.
   *
   * `cells` is the Swift's row-major `[UInt8]`, `size * size` of them; `rows` is the decoded
   * form, one string of digits per row. Either may be given — they are the same grid — and
   * `rows` is what comes back out.
   */
  make({
    takenMinutes,
    south,
    west,
    zoom,
    product,
    bounds = null,
    cells = null,
    rows = null,
    source = 0,
    seq = 0,
    bot = 0,
  }) {
    const grid = rowStrings({ cells, rows });
    const size = grid.length;
    const isCoarse = size === MeshWXWire.radarCoarseGrid;
    const boundsArray = bounds == null
      ? null
      : (Array.isArray(bounds) ? [...bounds] : MeshWXRadarBounds.array(bounds));
    return {
      seq,
      bot,
      type: MeshWXMessageType.radar,
      name: 'radar',
      flags: (isCoarse ? MeshWXWire.radarCoarseBit : 0)
        | (boundsArray == null ? 0 : MeshWXWire.radarPartialBit)
        | ((source & 0x3) << MeshWXWire.flagDataSourceShift),
      taken_min: takenMinutes,
      south,
      west,
      zoom,
      product,
      coarse: isCoarse,
      partial: boundsArray != null,
      bounds: boundsArray,
      size,
      rows: grid,
      source,
    };
  },

  /** Cells along one side: 16 when coarse, else 32. */
  size(radar) {
    return radar.size ?? (radar.coarse === true ? MeshWXWire.radarCoarseGrid : MeshWXWire.radarGrid);
  },

  /** The lattice square this picture is of. */
  tile(radar) {
    return { south: radar.south, west: radar.west, zoom: radar.zoom };
  },

  /** The level in one cell, 0-3, or null when the row and column are off the grid. */
  level(radar, { row, col }) {
    const size = MeshWXRadar.size(radar);
    if (row < 0 || row >= size || col < 0 || col >= size) return null;
    return radar.rows[row].charCodeAt(col) - 48;
  },

  /**
   * Whether the picture does **not** reach this cell: true only outside a partial tile's
   * `bounds`, where the level is 0 and means *unknown* rather than dry. A whole tile knows
   * every cell it has.
   */
  isUnknown(radar, { row, col }) {
    if (radar.partial !== true || radar.bounds == null) return false;
    return !MeshWXRadarBounds.contains(MeshWXRadarBounds.of(radar), { row, col });
  },

  /** The other way round, for the readers that ask before they believe a zero. */
  isKnown(radar, { row, col }) {
    return !MeshWXRadar.isUnknown(radar, { row, col });
  },

  /** The grid as rows of numbers, for anything that would otherwise index into the strings. */
  cellRows(radar) {
    return radar.rows.map((row) => [...row].map((digit) => digit.charCodeAt(0) - 48));
  },

  /** How many cells carry precipitation — what the traffic row counts. */
  wetCells(radar) {
    let total = 0;
    for (const row of radar.rows) {
      for (let col = 0; col < row.length; col += 1) {
        if (row.charCodeAt(col) > 48) total += 1;
      }
    }
    return total;
  },
});

/**
 * `cells` (flat, row-major) or `rows` (strings, or arrays of numbers) as the decoded `rows`.
 * Throws on a grid that is neither 32 × 32 nor 16 × 16, because the size is what the coarse
 * flag is read from and a grid of any other width has no flag to describe it.
 */
function rowStrings({ cells, rows }) {
  if (rows != null) {
    const grid = rows.map((row) => (typeof row === 'string' ? row : row.map((one) => one & 0x3).join('')));
    requireGrid(grid);
    return grid;
  }
  if (cells == null) throw new TypeError('MeshWXRadar.make needs cells or rows');
  const size = Math.round(Math.sqrt(cells.length));
  const grid = [];
  for (let row = 0; row < size; row += 1) {
    let text = '';
    for (let col = 0; col < size; col += 1) text += String(cells[row * size + col] & 0x3);
    grid.push(text);
  }
  requireGrid(grid);
  return grid;
}

function requireGrid(rows) {
  const size = rows.length;
  if (size !== MeshWXWire.radarGrid && size !== MeshWXWire.radarCoarseGrid) {
    throw new TypeError(
      `a radar grid is ${MeshWXWire.radarGrid} or ${MeshWXWire.radarCoarseGrid} rows, got ${size}`,
    );
  }
  for (const row of rows) {
    if (row.length !== size) throw new TypeError(`a radar grid is square: a row of ${row.length} in ${size}`);
    if (!/^[0-3]*$/.test(row)) throw new TypeError(`a radar level must be 0…3: "${row}"`);
  }
}
