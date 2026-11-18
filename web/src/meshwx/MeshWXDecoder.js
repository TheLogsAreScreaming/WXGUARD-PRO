// Port of MC1Services/Sources/MeshWX/MeshWXDecoder.swift
//
// Decodes one v5 datagram (spec §3-§8) into exactly the `decoded` object of
// docs/meshwx_v5_vectors.json (PORTING §5): snake_case keys, `null` for an absent optional.
//
// A decoder is the one place in a radio app that must never trap: the bytes come off the air,
// a neighbour's firmware may be older or newer, and the type nibble has eight values reserved
// for products that do not exist yet. So every length is checked before it is read, an unknown
// type yields just the header with `name: "unknown"` rather than an error (the header still
// decoded, and `(bot, seq)` tracking depends on it), and nothing here can throw by accident.

import { MeshWXWire, MeshWXMessageType, MeshWXTypeNames, MeshWXHeader } from './MeshWXWire.js';
import { MeshWXCompass } from './MeshWXMessage.js';

/**
 * Why a v5 datagram could not be decoded.
 *
 * Every case names what was being read and how far the bytes got, because the only diagnostic
 * an app has for a bad packet is the log line: the radio is gone by then and the bot will not
 * repeat itself on request.
 *
 * `kind` is `'truncated'` (with `what`, `need`, `have`), `'badUTF8'`, `'radarTreeTruncated'` or
 * `'radarBoundsOutsideGrid'`.
 */
export class MeshWXDecodeError extends Error {
  constructor(kind, details = {}) {
    let message;
    if (kind === 'truncated') {
      message = `truncated ${details.what}: need ${details.need} bytes, have ${details.have}`;
    } else if (kind === 'radarTreeTruncated') {
      message = `the radar quadtree ran out of bits after ${details.bits}`;
    } else if (kind === 'radarBoundsOutsideGrid') {
      message = `radar bounds ${details.row0},${details.row1},${details.col0},${details.col1}`
        + ` are not inside a ${details.size} x ${details.size} grid`;
    } else {
      message = 'text is not valid UTF-8';
    }
    super(message);
    this.name = 'MeshWXDecodeError';
    this.kind = kind;
    Object.assign(this, details);
  }

  /** `MeshWXDecodeError.truncated(what:need:have:)`. */
  static truncated({ what, need, have }) {
    return new MeshWXDecodeError('truncated', { what, need, have });
  }

  /**
   * A Text chunk's body was not valid UTF-8 (a chunk boundary in the wrong place, or a
   * corrupted packet that still passed the frame MAC).
   */
  static badUTF8() {
    return new MeshWXDecodeError('badUTF8', {});
  }

  /**
   * A Radar tile's quadtree ran out of bits before the grid was complete (spec §13).
   *
   * A half-read tree leaves the rest of the grid at level 0 — which on a radar picture reads as
   * "no rain here", the one wrong answer that looks exactly like a right one. `bits` is how far
   * the reader got.
   */
  static radarTreeTruncated({ bits }) {
    return new MeshWXDecodeError('radarTreeTruncated', { bits });
  }

  /**
   * A partial Radar tile named rows or columns its own grid does not have (spec §13).
   *
   * The one place this decoder refuses a body it could read the bytes of. It has to: every cell
   * outside `bounds` is *unknown*, and bounds that do not describe a run of this grid's rows
   * would have the screen read a level off a cell the picture never covered — a dry reading
   * where there is no reading at all.
   */
  static radarBoundsOutsideGrid({ row0, row1, col0, col1, size }) {
    return new MeshWXDecodeError('radarBoundsOutsideGrid', { row0, row1, col0, col1, size });
  }
}

// MARK: - Primitives
//
// Little-endian everywhere (spec §1.3), two's complement for signed. Hand-rolled rather than
// DataView because these run on arbitrary offsets into a received buffer and the byte order
// must be the wire's, not the CPU's.

function need(bytes, end, what) {
  if (bytes.length < end) {
    throw MeshWXDecodeError.truncated({ what, need: end, have: bytes.length });
  }
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function i16(bytes, offset) {
  const raw = u16(bytes, offset);
  return raw & 0x8000 ? raw - 0x10000 : raw;
}

function u32(bytes, offset) {
  return (
    (bytes[offset]
      | (bytes[offset + 1] << 8)
      | (bytes[offset + 2] << 16)
      | (bytes[offset + 3] << 24)) >>> 0
  );
}

function i24(bytes, offset) {
  const raw = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  return raw & 0x80_0000 ? raw - (1 << 24) : raw;
}

function i8(byte) {
  return byte & 0x80 ? byte - 256 : byte;
}

function signedOrNull(byte, sentinel) {
  const value = i8(byte);
  return value === sentinel ? null : value;
}

function unsignedOrNull(byte) {
  return byte === MeshWXWire.unsignedUnknown ? null : byte;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function utf8(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw MeshWXDecodeError.badUTF8();
  }
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Uint8Array.from(data);
}

function headerOf(bytes) {
  need(bytes, MeshWXWire.headerSize, 'header');
  const typeByte = bytes[3];
  const rawType = typeByte >> 4;
  return {
    seq: bytes[0],
    bot: u16(bytes, 1),
    type: rawType,
    name: MeshWXTypeNames[rawType] ?? 'unknown',
    flags: typeByte & 0x0f,
  };
}

function source(header) {
  return (header.flags & MeshWXWire.flagDataSourceMask) >> MeshWXWire.flagDataSourceShift;
}

// MARK: - Area runs (spec §3), shared by Warning and Coverage

function decodeAreas(bytes, offset) {
  need(bytes, offset + 1, 'area count');
  const count = bytes[offset];
  let cursor = offset + 1;
  need(bytes, cursor + 4 * count, 'area runs');
  const runs = [];
  for (let index = 0; index < count; index += 1) {
    const stateByte = bytes[cursor];
    runs.push({
      state: stateByte & 0x7f,
      county: (stateByte & MeshWXWire.areaCountyBit) !== 0,
      start: u16(bytes, cursor + 1),
      run: bytes[cursor + 3],
    });
    cursor += 4;
  }
  return { runs, offset: cursor };
}

// MARK: - Warning (type 1, spec §3)

/**
 * The anchor vertex is absolute at 0.0001°; every other vertex is a delta at 0.001° against the
 * *reconstructed* previous one.
 *
 * Accumulation happens in whole 0.0001° units rather than in floating point, which is what makes
 * a re-encode reproduce the original deltas: walking the chain in floating point leaves each
 * vertex a few ULPs off the grid, and a later `round(...×1000)` can then land on the wrong side
 * of a half.
 */
function decodePolygon(bytes, offset) {
  need(bytes, offset + 1, 'polygon count');
  const count = bytes[offset];
  let cursor = offset + 1;
  const deltaCount = Math.max(0, count - 1);
  need(bytes, cursor + 6 + 4 * deltaCount, 'polygon');

  let latUnits = i24(bytes, cursor);
  let lonUnits = i24(bytes, cursor + 3);
  cursor += 6;

  const points = [[latUnits / 10000, lonUnits / 10000]];
  for (let index = 0; index < deltaCount; index += 1) {
    // A 0.001° delta is ten 0.0001° units.
    latUnits += i16(bytes, cursor) * 10;
    lonUnits += i16(bytes, cursor + 2) * 10;
    cursor += 4;
    points.push([latUnits / 10000, lonUnits / 10000]);
  }
  return { points, offset: cursor };
}

function decodeWarning(bytes, header) {
  need(bytes, MeshWXWire.warningFixedSize, 'warning');
  const expires = u32(bytes, 8);
  const tags = bytes[12];

  const out = {
    ...header,
    event: bytes[4],
    office: bytes[5],
    etn: u16(bytes, 6),
    expires_min: expires,
    tornado: (tags >> 6) & 0x3,
    flood_source: (tags >> 4) & 0x3,
    flood_damage: (tags >> 2) & 0x3,
    hail_qin: bytes[13],
    wind_mph: bytes[14],
    update: (header.flags & MeshWXWire.flagWarningUpdate) !== 0,
    source: source(header),
    polygon: null,
    areas: null,
    issued_min: null,
    begins_min: null,
  };

  let offset = MeshWXWire.warningFixedSize;
  if (tags & MeshWXWire.tagPolygon) {
    const polygon = decodePolygon(bytes, offset);
    out.polygon = polygon.points;
    offset = polygon.offset;
  }
  if (tags & MeshWXWire.tagAreas) {
    const areas = decodeAreas(bytes, offset);
    out.areas = areas.runs;
    offset = areas.offset;
  }
  // Revision 5 (spec §3): the issue time is the last two bytes, after both variable blocks, so
  // a decoder that does not know the flag stops above and never sees them. It is relative to
  // `expires` rather than absolute, which costs two bytes instead of four on the one message
  // that reaches the packet limit, and cannot drift: both ends of the subtraction ride here.
  if (header.flags & MeshWXWire.flagWarningIssued) {
    need(bytes, offset + MeshWXWire.warningIssuedSize, 'warning issue time');
    const issuedBefore = u16(bytes, offset);
    out.issued_min = expires - issuedBefore;
    offset += MeshWXWire.warningIssuedSize;
    // Revision 12 (spec §3): the start, when the product takes effect later than it was issued.
    // The flags nibble is full, so it is found by length — two more bytes after the issue time —
    // which works because every earlier decoder stops above and GRP_DATA delivers the exact
    // length. Anything after it is a later revision's and is left alone. A value that is not
    // strictly between the issuance and the expiry is not a start after issuance, and is read
    // as absent, so an invalid one never reaches anything that shows it.
    if (bytes.length >= offset + MeshWXWire.warningBeginsSize) {
      const beginsBefore = u16(bytes, offset);
      if (beginsBefore > 0 && beginsBefore < issuedBefore) out.begins_min = expires - beginsBefore;
    }
  }
  return out;
}

// MARK: - Cancel (type 2, spec §4)

function decodeCancel(bytes, header) {
  need(bytes, MeshWXWire.cancelSize, 'cancel');
  return {
    ...header,
    event: bytes[4],
    office: bytes[5],
    etn: u16(bytes, 6),
    // The whole nibble is the reason; a Cancel never carries a data source (spec §2.3).
    reason: header.flags,
  };
}

// MARK: - Digest (type 3, spec §5)

function decodeDigest(bytes, header) {
  need(bytes, MeshWXWire.digestFixedSize, 'digest');
  const now = u32(bytes, 4);
  const feedHealth = bytes[8];
  const count = bytes[9];
  need(
    bytes,
    MeshWXWire.digestFixedSize + MeshWXWire.digestEntrySize * count,
    'digest entries',
  );

  const entries = [];
  let offset = MeshWXWire.digestFixedSize;
  for (let index = 0; index < count; index += 1) {
    const relative = u16(bytes, offset + 4);
    entries.push({
      event: bytes[offset],
      office: bytes[offset + 1],
      etn: u16(bytes, offset + 2),
      expires_rel: relative,
      // `now` is a u32 of minutes since 1970 — around 29.8 million today — so the sum cannot
      // approach the u32 ceiling for another 8000 years.
      expires_min: now + relative,
    });
    offset += MeshWXWire.digestEntrySize;
  }
  return {
    ...header,
    now_min: now,
    feed_health: feedHealth,
    entries,
    source: source(header),
  };
}

// MARK: - Observations (type 4, spec §6)

function decodeObservations(bytes, header) {
  need(bytes, MeshWXWire.observationsFixedSize, 'observations');
  const timestamp = u32(bytes, 4);
  const count = bytes[8];
  const stationsEnd = MeshWXWire.observationsFixedSize
    + MeshWXWire.observationStationSize * count;
  need(bytes, stationsEnd, 'observation stations');

  // Revision 5 (spec §6.1): the age nibbles sit after the station records — station `i` in the
  // low nibble of byte `i / 2` when `i` is even, the high nibble when odd — so a decoder that
  // does not know the flag reads the batch exactly as it always did. Read ahead of the station
  // loop because each station carries its own age.
  const ages = new Array(count).fill(null);
  if (header.flags & MeshWXWire.flagObservationAges) {
    need(bytes, stationsEnd + Math.floor((count + 1) / 2), 'observation ages');
    for (let index = 0; index < count; index += 1) {
      const byte = bytes[stationsEnd + Math.floor(index / 2)];
      const nibble = index % 2 === 0 ? byte & 0x0f : byte >> 4;
      ages[index] = nibble * MeshWXWire.observationAgeStepMinutes;
    }
  }

  const stations = [];
  let offset = MeshWXWire.observationsFixedSize;
  for (let index = 0; index < count; index += 1) {
    const directionAndSky = bytes[offset + 4];
    const pressure = bytes[offset + 8];
    const nibble = directionAndSky >> 4;
    stations.push({
      station: u16(bytes, offset),
      temp_f: signedOrNull(bytes[offset + 2], MeshWXWire.temperatureUnknown),
      dewpoint_f: signedOrNull(bytes[offset + 3], MeshWXWire.temperatureUnknown),
      wind_dir_deg: MeshWXCompass.degrees(nibble),
      wind_dir: MeshWXCompass.abbreviation(nibble),
      sky: directionAndSky & 0x0f,
      wind_mph: unsignedOrNull(bytes[offset + 5]),
      gust_mph: bytes[offset + 6],
      visibility_mi: unsignedOrNull(bytes[offset + 7]),
      // Exact two-decimal reconstruction: 29.00 + raw/100 built from integers is the nearest
      // double to the decimal value, with none of the drift a float add has.
      pressure_inhg: pressure === MeshWXWire.unsignedUnknown ? null : (2900 + pressure) / 100,
      humidity_pct: unsignedOrNull(bytes[offset + 9]),
      feels_delta_f: i8(bytes[offset + 10]),
      // Minutes this station's own report is older than `ts_min`; null when the batch predates
      // revision 5 and does not say.
      age_min: ages[index],
    });
    offset += MeshWXWire.observationStationSize;
  }
  return { ...header, ts_min: timestamp, stations, source: source(header) };
}

// MARK: - Forecast (type 5, spec §7)

function decodeForecast(bytes, header) {
  need(bytes, MeshWXWire.forecastFixedSize, 'forecast');
  const point = u16(bytes, 4);
  const issued = u32(bytes, 6);
  const first = bytes[10];
  const count = bytes[11];
  need(
    bytes,
    MeshWXWire.forecastFixedSize + MeshWXWire.forecastPeriodSize * count,
    'forecast periods',
  );

  const periods = [];
  let offset = MeshWXWire.forecastFixedSize;
  for (let index = 0; index < count; index += 1) {
    const condition = bytes[offset + 3];
    const wind = bytes[offset + 4];
    const nibble = wind >> 4;
    periods.push({
      high_f: signedOrNull(bytes[offset], MeshWXWire.forecastTemperatureNotGiven),
      low_f: signedOrNull(bytes[offset + 1], MeshWXWire.forecastTemperatureNotGiven),
      pop_pct: unsignedOrNull(bytes[offset + 2]),
      sky: condition & 0x0f,
      thunder: (condition & 0x10) !== 0,
      wintry: (condition & 0x20) !== 0,
      windy: (condition & 0x40) !== 0,
      fog: (condition & 0x80) !== 0,
      wind_dir_deg: MeshWXCompass.degrees(nibble),
      wind_dir: MeshWXCompass.abbreviation(nibble),
      wind_mph: (wind & 0x0f) * 5,
    });
    offset += MeshWXWire.forecastPeriodSize;
  }
  return {
    ...header,
    point,
    issued_min: issued,
    first_period: first,
    periods,
    source: source(header),
  };
}

// MARK: - Text (type 6, spec §8)

function decodeText(bytes, header) {
  need(bytes, MeshWXWire.textFixedSize, 'text');
  return {
    ...header,
    subject: bytes[4],
    group: bytes[5],
    idx: bytes[6],
    total: bytes[7],
    text: utf8(bytes.subarray(MeshWXWire.textFixedSize)),
    // Revision 7 (spec §8): the bot ran out of packets and dropped the tail. A decoder
    // written before the flag reads the same chunk it always did, one bit poorer.
    cut: (header.flags & MeshWXWire.flagTextCut) !== 0,
    source: source(header),
  };
}

// MARK: - Not available (type 7, spec §9)

function decodeNotAvailable(bytes, header) {
  need(bytes, MeshWXWire.notAvailableSize, 'not_available');
  return {
    ...header,
    request: String.fromCharCode(bytes[4]),
    request_code: bytes[4],
    reason: bytes[5],
  };
}

// MARK: - Coverage (type 8, spec §10)

function decodeCoverage(bytes, header) {
  need(bytes, MeshWXWire.coverageFixedSize, 'coverage');
  const officeCount = bytes[13];
  const officesEnd = MeshWXWire.coverageFixedSize + officeCount;
  need(bytes, officesEnd, 'coverage offices');
  // The runs are a Warning's area list byte for byte (spec §3), count byte included — except
  // that a coverage message may legitimately carry none, which `decodeAreas` already allows.
  const { runs } = decodeAreas(bytes, officesEnd);
  return {
    ...header,
    lat: i24(bytes, 4) / 10000,
    lon: i24(bytes, 7) / 10000,
    radius_km: u16(bytes, 10),
    stations: bytes[12],
    offices: [...bytes.subarray(MeshWXWire.coverageFixedSize, officesEnd)],
    areas: runs,
    zones_cut: (header.flags & MeshWXWire.flagCoverageZonesCut) !== 0,
    offices_cut: (header.flags & MeshWXWire.flagCoverageOfficesCut) !== 0,
  };
}

// MARK: - Request (type 9, spec §11)

/**
 * Another phone's `>` request, heard because requests are flooded on the channel now.
 *
 * Decoded rather than dropped as an unknown type so the app can *recognise* one and leave it
 * alone: it is somebody else's question, it says nothing about the bot's state, and the answer
 * that follows is a message of its own. No length cap on the text here — the encoder is where
 * the 40 bytes are enforced, and a neighbour's longer request should still read.
 */
function decodeRequest(bytes, header) {
  need(bytes, MeshWXWire.requestFixedSize, 'request');
  const senderEnd = MeshWXWire.headerSize + MeshWXWire.requestSenderPrefixSize;
  const sender = [...bytes.subarray(MeshWXWire.headerSize, senderEnd)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    ...header,
    sender,
    ts: u32(bytes, senderEnd),
    text: utf8(bytes.subarray(MeshWXWire.requestFixedSize)),
  };
}

// MARK: - Area sweep (type 10, spec §12)

/**
 * The entries run to the end of the packet: there is no count byte, because a count would cost
 * the byte that the 38th entry is made of.
 *
 * Whatever does not make a whole four-byte entry is left alone, the way every other type here
 * tolerates trailing bytes. A sweep is a picture of the country and a bot a version ahead
 * appending a field to the end must not cost this phone the thirty-seven entries it can read.
 *
 * Revision 10 adds the scope (spec §12). Two things come out of the same bytes:
 *
 * - `scoped`, from bit 7 of the `total` byte. It is on **every** packet, so a phone that lost
 *   packet 0 still knows it is not looking at the country — which is the whole reason the flag
 *   is not simply "packet 0 carried scope entries".
 * - `scope`, the state indices the leading `event = 0` entries name. They are lifted out of
 *   `entries` here and put back, first, by the encoder, so `entries` is **alert entries only**
 *   and nothing downstream has to remember that event 0 is not an event. Only the leading run is
 *   lifted: the bot sorts them before every alert entry (§12), and stopping at the first alert
 *   entry is what makes the re-encode byte-identical for any input, well formed or not.
 */
function decodeAreaSweep(bytes, header) {
  need(bytes, MeshWXWire.areaSweepFixedSize, 'area sweep');
  const count = Math.floor(
    (bytes.length - MeshWXWire.areaSweepFixedSize) / MeshWXWire.areaSweepEntrySize,
  );

  const scope = [];
  const entries = [];
  let isLeading = true;
  let offset = MeshWXWire.areaSweepFixedSize;
  for (let index = 0; index < count; index += 1) {
    const event = bytes[offset];
    const stateByte = bytes[offset + 1];
    const packed = u16(bytes, offset + 2);
    const state = stateByte >> MeshWXWire.sweepStateShift;
    offset += MeshWXWire.areaSweepEntrySize;
    if (isLeading && event === MeshWXWire.sweepScopeEvent) {
      // `XXZ000`, the Weather Service's own way of writing "all of state XX": kind zone,
      // start 0, run 1. Only the state index carries meaning, and only it is kept.
      scope.push(state);
      continue;
    }
    isLeading = false;
    entries.push({
      event,
      state,
      county: (stateByte & MeshWXWire.sweepCountyBit) !== 0,
      start: packed & MeshWXWire.sweepStartMask,
      // Six bits carried less one, so the field spans 1…64 and never 0: an entry that covered
      // nothing would have no reason to be on the air.
      run: (packed >> MeshWXWire.sweepRunShift) + 1,
    });
  }
  const totalByte = bytes[10];
  return {
    ...header,
    built_min: u32(bytes, 4),
    group: bytes[8],
    idx: bytes[9],
    total: totalByte & MeshWXWire.sweepTotalMask,
    entries,
    cut: (header.flags & MeshWXWire.flagSweepCut) !== 0,
    advisories: (header.flags & MeshWXWire.flagSweepAdvisories) !== 0,
    scoped: (totalByte & MeshWXWire.sweepScopedBit) !== 0,
    scope,
    source: source(header),
  };
}

// MARK: - Radar (type 11, spec §13)

/**
 * The cells, as a quadtree read most significant bit first.
 *
 * `node(size)`: at size 1, two bits of level. Otherwise one bit — `0` and the whole square is
 * one level, two bits of it; `1` and four children follow, north-west, north-east, south-west,
 * south-east. A dry tile is three bits, which is why a clear picture costs 13 bytes.
 *
 * Bits left over after the tree are padding to the end of the last byte and are ignored; bits
 * that run out *before* it are refused, because a half-read tree leaves the rest of the grid at
 * level 0 — which on a radar picture reads as "no rain here", the one wrong answer that looks
 * exactly like a right one.
 */
function decodeRadarCells(bytes, offset, size) {
  const rows = Array.from({ length: size }, () => new Array(size).fill(0));
  let position = 0;

  const take = (width) => {
    let value = 0;
    for (let bit = 0; bit < width; bit += 1) {
      const index = offset + (position >> 3);
      if (index >= bytes.length) throw MeshWXDecodeError.radarTreeTruncated({ bits: position });
      value = (value << 1) | ((bytes[index] >> (7 - (position & 7))) & 1);
      position += 1;
    }
    return value;
  };

  const node = (row, col, span) => {
    if (span === 1) {
      rows[row][col] = take(2);
      return;
    }
    if (take(1) === 0) {
      const level = take(2);
      for (let y = row; y < row + span; y += 1) {
        for (let x = col; x < col + span; x += 1) rows[y][x] = level;
      }
      return;
    }
    const half = span / 2;
    node(row, col, half);
    node(row, col + half, half);
    node(row + half, col, half);
    node(row + half, col + half, half);
  };

  node(0, 0, size);
  return rows.map((row) => row.join(''));
}

/**
 * One tile of a radar picture (spec §13, revision 11).
 *
 * The flags nibble carries both shape bits: coarse says the grid is 16 × 16 rather than 32 × 32
 * — the bot's answer to a picture too busy for one packet, never a second packet — and partial
 * says four `bounds` bytes sit between the fixed fields and the cells.
 */
function decodeRadar(bytes, header) {
  need(bytes, MeshWXWire.radarFixedSize + 1, 'radar');
  const isCoarse = (header.flags & MeshWXWire.radarCoarseBit) !== 0;
  const isPartial = (header.flags & MeshWXWire.radarPartialBit) !== 0;
  const size = isCoarse ? MeshWXWire.radarCoarseGrid : MeshWXWire.radarGrid;
  const shape = bytes[11];

  let offset = MeshWXWire.radarFixedSize;
  let bounds = null;
  if (isPartial) {
    need(bytes, offset + MeshWXWire.radarBoundsSize + 1, 'radar bounds');
    bounds = [...bytes.subarray(offset, offset + MeshWXWire.radarBoundsSize)];
    offset += MeshWXWire.radarBoundsSize;
    const [row0, row1, col0, col1] = bounds;
    if (!(row0 <= row1 && row1 < size && col0 <= col1 && col1 < size)) {
      throw MeshWXDecodeError.radarBoundsOutsideGrid({ row0, row1, col0, col1, size });
    }
  }
  return {
    ...header,
    // The time printed on the radar picture: not when the bot received it, not when it sent it.
    taken_min: u32(bytes, 4),
    south: i8(bytes[8]),
    west: i16(bytes, 9),
    zoom: shape & MeshWXWire.radarZoomMask,
    product: shape >> MeshWXWire.radarProductShift,
    coarse: isCoarse,
    partial: isPartial,
    bounds,
    size,
    rows: decodeRadarCells(bytes, offset, size),
    source: source(header),
  };
}

const DECODERS = {
  [MeshWXMessageType.warning]: decodeWarning,
  [MeshWXMessageType.cancel]: decodeCancel,
  [MeshWXMessageType.digest]: decodeDigest,
  [MeshWXMessageType.observations]: decodeObservations,
  [MeshWXMessageType.forecast]: decodeForecast,
  [MeshWXMessageType.text]: decodeText,
  [MeshWXMessageType.notAvailable]: decodeNotAvailable,
  [MeshWXMessageType.coverage]: decodeCoverage,
  [MeshWXMessageType.request]: decodeRequest,
  [MeshWXMessageType.areaSweep]: decodeAreaSweep,
  [MeshWXMessageType.radar]: decodeRadar,
};

/**
 * Decode one datagram — the `data` field of a `GRP_DATA` packet with
 * `data_type === MeshWXWire.dataType` — into the vector's `decoded` object.
 *
 * Deliberately no upper-bound check: the reference decoder has none, and a bot that one day
 * overruns the 165-byte budget by a byte should still get its text read rather than dropped.
 * The *encoder* enforces the limit, which is where it matters.
 */
export function decode(bytes) {
  const data = toBytes(bytes);
  const header = headerOf(data);
  const handler = DECODERS[header.type];
  if (handler == null) return header;
  return handler(data, header);
}

/**
 * Decode just the 4-byte common header, for dedupe and gap detection before the body is worth
 * parsing: `{ seq, bot, type, name, flags }`.
 */
export function decodeHeader(bytes) {
  return headerOf(toBytes(bytes));
}

export const MeshWXDecoder = Object.freeze({
  decode,
  decodeHeader,
  /** `MeshWXHeader.dataSource`, for a header decoded on its own. */
  dataSource: MeshWXHeader.dataSource,
});
