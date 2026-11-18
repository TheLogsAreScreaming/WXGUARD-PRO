// Port of MC1Services/Sources/MeshWX/MeshWXEncoder.swift
//
// Encodes v5 datagrams (spec §3-§8).
//
// The app does not run a bot, so why encode at all? Because a codec that is only ever exercised
// in one direction drifts: the eighteen official vectors are a round trip, and the app's own
// tests need to fabricate a tornado warning without waiting for one.
//
// Rounding follows the reference's Python `round()` — half to *even* — everywhere the reference
// rounds. It matters in exactly one place (a polygon delta landing on an exact half), and
// matching it is cheaper than reasoning about when it cannot happen.
//
// Every parameter that in Swift is a `MeshWXWarning`, `MeshWXStationObservation`,
// `MeshWXForecastPeriod`, `MeshWXAreaRun` or `MeshWXAreaSweep.Entry` is here the *decoded*
// object of the vectors (PORTING §5): snake_case keys.

import { MeshWXWire, MeshWXMessageType } from './MeshWXWire.js';
import { roundHalfToEven, MeshWXCompass } from './MeshWXMessage.js';
import { MeshWXRadarBounds } from './MeshWXRadar.js';

/**
 * Why a value could not be put on the wire.
 *
 * The encoder is strict where the decoder is lenient. Nothing here is a user's input — it is
 * either the app fabricating traffic for a test or a future bot implementation, and a silently
 * clamped field would be a protocol bug that only shows up as a wrong number on someone else's
 * screen.
 *
 * `kind` is one of `outOfRange`, `oversize`, `badCount`, `partialObservationAges`,
 * `polygonDeltaTooLarge`, `textTooLong`, `codePointTooLarge`, `emptyRequest`,
 * `radarCellOutsideBounds`, `radarBoundsOutsideGrid`.
 */
export class MeshWXEncodeError extends Error {
  constructor(kind, details = {}, message = kind) {
    super(message);
    this.name = 'MeshWXEncodeError';
    this.kind = kind;
    Object.assign(this, details);
  }

  /** A field was outside the range its wire type can hold. */
  static outOfRange({ field, value }) {
    return new MeshWXEncodeError(
      'outOfRange', { field, value }, `${field} is out of range: ${value}`,
    );
  }

  /** The datagram was over `MeshWXWire.maxData`. */
  static oversize({ what, bytes }) {
    return new MeshWXEncodeError(
      'oversize', { what, bytes },
      `${what} is ${bytes} bytes, over the ${MeshWXWire.maxData}-byte limit`,
    );
  }

  /** A repeated field had the wrong number of elements (vertices, runs, periods…). */
  static badCount({ what, count, allowed }) {
    return new MeshWXEncodeError(
      'badCount', { what, count, allowed },
      `${what} needs ${allowed[0]}…${allowed[1]} entries, got ${count}`,
    );
  }

  /**
   * Some stations in a batch carried an age and some did not. The ages are all or nothing
   * (spec §6.1): a batch that told the truth about a few stations and left the rest to be
   * guessed at would be worse than one that says nothing.
   */
  static partialObservationAges({ known, stations }) {
    return new MeshWXEncodeError(
      'partialObservationAges', { known, stations },
      `per-station ages must cover every station in the batch or none: ${known} of ${stations}`,
    );
  }

  /**
   * A polygon vertex was more than ±32.767° from the previous one, so the 0.001° delta does not
   * fit in an i16. Re-anchor or split the polygon.
   */
  static polygonDeltaTooLarge({ vertex, axis, degrees }) {
    return new MeshWXEncodeError(
      'polygonDeltaTooLarge', { vertex, axis, degrees },
      `polygon vertex ${vertex} ${axis} delta ${degrees} deg does not fit in i16`,
    );
  }

  /**
   * A Radar tile carried an echo in a cell its own `bounds` say the picture never covered
   * (spec §13). Outside the bounds a cell is *unknown* and is encoded as level 0, so a wet cell
   * out there is a tile that contradicts itself and there is no way to put it on the wire.
   */
  static radarCellOutsideBounds({ row, col }) {
    return new MeshWXEncodeError(
      'radarCellOutsideBounds', { row, col },
      `radar cell ${row},${col} is outside the bounds and is not dry`,
    );
  }

  /** A Radar tile's `bounds` named rows or columns its own grid does not have (spec §13). */
  static radarBoundsOutsideGrid({ row0, row1, col0, col1, size }) {
    return new MeshWXEncodeError(
      'radarBoundsOutsideGrid', { row0, row1, col0, col1, size },
      `radar bounds ${row0},${row1},${col0},${col1} are not inside a ${size} x ${size} grid`,
    );
  }

  /** Text needed more than `MeshWXWire.maxTextChunks` chunks. */
  static textTooLong({ chunks }) {
    return new MeshWXEncodeError(
      'textTooLong', { chunks },
      `text needs ${chunks} chunks, over the ${MeshWXWire.maxTextChunks}-chunk limit`,
    );
  }

  /**
   * A single code point was wider than a whole chunk (not reachable with UTF-8, kept so the
   * chunker has no unreachable trap).
   */
  static codePointTooLarge() {
    return new MeshWXEncodeError(
      'codePointTooLarge', {}, 'a single code point exceeds the chunk size',
    );
  }

  /** A not-available or request string had no letter after the `>` prefix. */
  static emptyRequest() {
    return new MeshWXEncodeError('emptyRequest', {}, "nothing after the '>' prefix");
  }
}

// MARK: - Little-endian appenders (spec §1.3)

class Writer {
  constructor() {
    this.bytes = [];
  }

  u8(value) {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value) {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  i8(value) {
    return this.u8(value < 0 ? value + 0x100 : value);
  }

  i16(value) {
    return this.u16(value < 0 ? value + 0x10000 : value);
  }

  u32(value) {
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
    return this;
  }

  i24(value, field) {
    if (!(value >= -(1 << 23) && value < 1 << 23)) {
      throw MeshWXEncodeError.outOfRange({ field, value });
    }
    const raw = value & 0xff_ffff;
    this.bytes.push(raw & 0xff, (raw >>> 8) & 0xff, (raw >>> 16) & 0xff);
    return this;
  }

  push(values) {
    for (const value of values) this.bytes.push(value & 0xff);
    return this;
  }

  done(what) {
    if (this.bytes.length > MeshWXWire.maxData) {
      throw MeshWXEncodeError.oversize({ what, bytes: this.bytes.length });
    }
    return Uint8Array.from(this.bytes);
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

function requireRange(value, low, high, field) {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw MeshWXEncodeError.outOfRange({ field, value });
  }
  return value;
}

function writeHeader(writer, { seq, bot, rawType, flags }) {
  requireRange(rawType, 0, 15, 'type');
  requireRange(flags, 0, 15, 'flags');
  writer.u8(seq).u16(bot).u8((rawType << 4) | flags);
  return writer;
}

/** Pack the 4-byte common header. */
export function header({ seq, bot, type, flags = 0 }) {
  return writeHeader(new Writer(), { seq, bot, rawType: type, flags }).done('header');
}

function sourceBits(source) {
  return (requireRange(source, 0, 3, 'source') & 0x3) << MeshWXWire.flagDataSourceShift;
}

// MARK: - Warning (type 1, spec §3)

function normalisedVertex(vertex) {
  if (Array.isArray(vertex)) return { latitude: vertex[0], longitude: vertex[1] };
  return vertex;
}

function encodePolygon(polygon) {
  const count = polygon.length;
  if (count < MeshWXWire.minPolygonVertices || count > MeshWXWire.maxPolygonVertices) {
    throw MeshWXEncodeError.badCount({
      what: 'polygon vertices',
      count,
      allowed: [MeshWXWire.minPolygonVertices, MeshWXWire.maxPolygonVertices],
    });
  }
  const anchor = normalisedVertex(polygon[0]);
  const latAnchor = roundHalfToEven(anchor.latitude * 10000);
  const lonAnchor = roundHalfToEven(anchor.longitude * 10000);

  const writer = new Writer();
  writer.u8(count);
  writer.i24(latAnchor, 'polygon lat0');
  writer.i24(lonAnchor, 'polygon lon0');

  // Deltas run against the *reconstructed* previous vertex, never against the caller's
  // originals: that is what stops a 30-vertex chain from accumulating a quarter-mile of drift
  // by the time a decoder walks it.
  let previousLat = latAnchor / 10000;
  let previousLon = lonAnchor / 10000;
  for (let position = 1; position < count; position += 1) {
    const vertex = normalisedVertex(polygon[position]);
    const deltaLat = roundHalfToEven((vertex.latitude - previousLat) * 1000);
    const deltaLon = roundHalfToEven((vertex.longitude - previousLon) * 1000);
    for (const [value, axis] of [[deltaLat, 'lat'], [deltaLon, 'lon']]) {
      if (value < -32768 || value > 32767) {
        throw MeshWXEncodeError.polygonDeltaTooLarge({
          vertex: position, axis, degrees: value / 1000,
        });
      }
    }
    writer.i16(deltaLat).i16(deltaLon);
    previousLat += deltaLat / 1000;
    previousLon += deltaLon / 1000;
  }
  return writer.bytes;
}

/**
 * The counted run list of spec §3. A warning sets the tag bit only when it has runs, so an empty
 * list has no encoding there; a Coverage message counts them the same way but may legitimately
 * carry none (`k` = 0, spec §10), hence `allowingEmpty`.
 */
function encodeAreas(areas, { what = 'area runs', allowingEmpty = false } = {}) {
  const low = allowingEmpty ? 0 : 1;
  if (areas.length < low || areas.length > MeshWXWire.maxAreaRuns) {
    throw MeshWXEncodeError.badCount({
      what, count: areas.length, allowed: [low, MeshWXWire.maxAreaRuns],
    });
  }
  const writer = new Writer();
  writer.u8(areas.length);
  for (const area of areas) {
    if (!(area.state >= 0 && area.state <= 127)) {
      throw MeshWXEncodeError.outOfRange({ field: 'state index', value: area.state });
    }
    if (!(area.run >= 1 && area.run <= 255)) {
      throw MeshWXEncodeError.outOfRange({ field: 'run length', value: area.run });
    }
    writer.u8((area.county ? MeshWXWire.areaCountyBit : 0) | area.state);
    writer.u16(requireRange(area.start, 0, 0xffff, 'area start'));
    writer.u8(area.run);
  }
  return writer.bytes;
}

/**
 * Encode a Warning.
 *
 * `polygon` is `[[lat, lon], …]` (a decoded warning's own shape) or `[{ latitude, longitude }, …]`;
 * `areas` are decoded `{ state, county, start, run }` runs. `issuedMinutes` is when the product
 * was issued, in Unix minutes: it goes on the wire as the minutes between that and
 * `expiresMinutes` (u16, two bytes rather than four), saturating at
 * `MeshWXWire.issuedBeforeSaturatedMinutes`; a warning issued after its own expiry, which no
 * real product is, encodes as 0 rather than failing. The two bytes are appended last so that a
 * decoder written before revision 5 stops after the area list and never sees them.
 *
 * `beginsMinutes` is when the product takes effect (revision 12), in Unix minutes. It goes on the
 * wire under the bot's own conditions: only after an issue time, and only when
 * `0 < begins_before < issued_before` — a start strictly between the issuance and the expiry.
 * Otherwise nothing is written, which is how a product in effect from issuance reads. There is no
 * flag for it (the nibble is full): a decoder finds the two bytes by length.
 */
export function warning({
  seq,
  bot,
  identity,
  expiresMinutes,
  tornado = 0,
  floodSource = 0,
  floodDamage = 0,
  hailQuarterInches = 0,
  windMph = 0,
  polygon = null,
  areas = null,
  isUpdate = false,
  issuedMinutes = null,
  beginsMinutes = null,
  source = 0,
}) {
  let tags = ((requireRange(tornado, 0, 3, 'tornado') << 6)
    | (requireRange(floodSource, 0, 3, 'flood_source') << 4)
    | (requireRange(floodDamage, 0, 3, 'flood_damage') << 2)) & 0xff;
  // An empty array is "no polygon", matching Python's truthiness test: a zero-vertex polygon
  // has no encoding, and setting the bit would promise bytes that follow.
  const hasPolygon = (polygon ?? []).length > 0;
  const hasAreas = (areas ?? []).length > 0;
  if (hasPolygon) tags |= MeshWXWire.tagPolygon;
  if (hasAreas) tags |= MeshWXWire.tagAreas;

  let flags = isUpdate ? MeshWXWire.flagWarningUpdate : 0;
  if (issuedMinutes != null) flags |= MeshWXWire.flagWarningIssued;
  flags |= sourceBits(source);

  const writer = new Writer();
  writeHeader(writer, { seq, bot, rawType: MeshWXMessageType.warning, flags });
  writer.u8(requireRange(identity.event, 0, 255, 'event'));
  writer.u8(requireRange(identity.office, 0, 255, 'office'));
  writer.u16(requireRange(identity.etn, 0, 0xffff, 'etn'));
  writer.u32(requireRange(expiresMinutes, 0, 0xffff_ffff, 'expires_min'));
  writer.u8(tags);
  writer.u8(requireRange(hailQuarterInches, 0, 255, 'hail_qin'));
  writer.u8(requireRange(windMph, 0, 255, 'wind_mph'));

  if (hasPolygon) writer.push(encodePolygon(polygon));
  if (hasAreas) writer.push(encodeAreas(areas));
  // Last of all, so a revision 4 decoder stops after the area list (spec §3). The gap saturates
  // rather than wrapping, and a product issued after its own expiry — which no real one is —
  // encodes as 0 rather than failing the message over a bad clock.
  if (issuedMinutes != null) {
    const issuedBefore = Math.max(
      0, Math.min(MeshWXWire.issuedBeforeSaturatedMinutes, expiresMinutes - issuedMinutes),
    );
    writer.u16(issuedBefore);
    // Revision 12: the start, after the issue time and never without one. Saturated the same
    // way, and written only when it is a start after issuance and before the expiry.
    if (beginsMinutes != null) {
      const beginsBefore = Math.max(
        0,
        Math.min(
          MeshWXWire.beginsBeforeSaturatedMinutes,
          expiresMinutes - requireRange(beginsMinutes, 0, 0xffff_ffff, 'begins_min'),
        ),
      );
      if (beginsBefore > 0 && beginsBefore < issuedBefore) writer.u16(beginsBefore);
    }
  }
  return writer.done('warning');
}

// MARK: - Cancel (type 2, spec §4)

/**
 * Encode a Cancel. `reason` rides in the flags nibble (spec §4: 0 cancelled, 1 expired early,
 * 2 upgraded).
 *
 * A Cancel takes no `source`, and this is the one type that never will: the *whole* nibble is
 * the reason code, so bits 2-3 of a Cancel are part of a number an app already reads. Reason 4
 * is not "cancelled, from the internet"; it is reason 4.
 */
export function cancel({ seq, bot, identity, reason = 0 }) {
  const writer = new Writer();
  writeHeader(writer, {
    seq, bot, rawType: MeshWXMessageType.cancel, flags: requireRange(reason, 0, 15, 'reason'),
  });
  writer.u8(requireRange(identity.event, 0, 255, 'event'));
  writer.u8(requireRange(identity.office, 0, 255, 'office'));
  writer.u16(requireRange(identity.etn, 0, 0xffff, 'etn'));
  return writer.done('cancel');
}

// MARK: - Digest (type 3, spec §5)

/**
 * Entries carry an *absolute* expiry; the wire gets `expires − now`, clamped into a u16
 * (spec §5). A warning already expired when the digest was built encodes as 0 rather than
 * wrapping to 18 hours.
 *
 * `entries` are `{ identity, expiresMinutes }`.
 */
export function digest({ seq, bot, nowMinutes, feedHealth, entries, source = 0 }) {
  if (entries.length > MeshWXWire.maxDigestEntries) {
    throw MeshWXEncodeError.badCount({
      what: 'digest entries', count: entries.length, allowed: [0, MeshWXWire.maxDigestEntries],
    });
  }
  const writer = new Writer();
  writeHeader(writer, {
    seq, bot, rawType: MeshWXMessageType.digest, flags: sourceBits(source),
  });
  writer.u32(requireRange(nowMinutes, 0, 0xffff_ffff, 'now_min'));
  writer.u8(requireRange(feedHealth, 0, 255, 'feed_health'));
  writer.u8(entries.length);
  for (const entry of entries) {
    const relative = Math.min(0xffff, Math.max(0, entry.expiresMinutes - nowMinutes));
    writer.u8(requireRange(entry.identity.event, 0, 255, 'event'));
    writer.u8(requireRange(entry.identity.office, 0, 255, 'office'));
    writer.u16(requireRange(entry.identity.etn, 0, 0xffff, 'etn'));
    writer.u16(relative);
  }
  return writer.done('digest');
}

// MARK: - Observations (type 4, spec §6)

/**
 * One station's age as a 10-minute step, 0…15, rounding half up — the reference's `_age_nibble`.
 * To the nearest step rather than down, which keeps the error symmetric: a reading is never
 * presented as more than 4 minutes fresher than it is. 15 is a saturation, so anything past 150
 * minutes clamps to "150 or more" instead of wrapping.
 */
function ageNibble(minutes) {
  const step = MeshWXWire.observationAgeStepMinutes;
  return Math.max(0, Math.min(15, Math.floor((Math.round(minutes) + step / 2) / step)));
}

/**
 * The per-station age block: one nibble each, two stations to a byte, station `i` in the low
 * nibble of byte `i / 2` when `i` is even and the high nibble when it is odd. An odd station
 * count leaves the last high nibble as 0 padding (spec §6.1).
 */
function encodeAges(ages) {
  const block = new Array(Math.floor((ages.length + 1) / 2)).fill(0);
  ages.forEach((age, index) => {
    const nibble = ageNibble(age);
    const slot = Math.floor(index / 2);
    block[slot] |= index % 2 === 0 ? nibble : nibble << 4;
  });
  return block;
}

/**
 * `(inHg − 29.00) × 100`, so the byte covers 29.00 to 31.54 inHg. Sea-level pressure outside
 * that window does not happen outside a hurricane eye, and 255 is taken.
 */
function pressureByte(inHg) {
  if (inHg == null) return MeshWXWire.unsignedUnknown;
  const raw = roundHalfToEven((inHg - 29.0) * 100);
  if (!(raw >= 0 && raw <= 254)) {
    throw MeshWXEncodeError.outOfRange({ field: 'pressure_inhg', value: raw });
  }
  return raw;
}

function signedByte(value, sentinel, field) {
  const resolved = value == null ? sentinel : Math.round(value);
  requireRange(resolved, -128, 127, field);
  return resolved < 0 ? resolved + 256 : resolved;
}

function unsignedByte(value, sentinel, field) {
  const resolved = value == null ? sentinel : Math.round(value);
  return requireRange(resolved, 0, 255, field);
}

/**
 * Encode an Observations batch (1…14 stations, 11 bytes each), the stations in decoded shape.
 *
 * A station carrying `age_min` — how many minutes older than `timestampMinutes` its own report
 * is — puts the batch into the revision 5 form: flags nibble bit 0 set and a trailing block of
 * age nibbles. The ages are all or nothing, so a batch where only some stations know their age
 * is refused rather than sent with the rest guessed at; and because the block costs
 * `ceil(n / 2)` bytes on top of an already 163-byte full batch, 14 stations with ages do not fit
 * in one packet (see `MeshWXWire.maxStationsWithAges`).
 */
export function observations({ seq, bot, timestampMinutes, stations, source = 0 }) {
  const count = stations.length;
  if (count < 1 || count > MeshWXWire.maxStations) {
    throw MeshWXEncodeError.badCount({
      what: 'observation stations', count, allowed: [1, MeshWXWire.maxStations],
    });
  }
  const ages = stations.map((station) => station.age_min ?? null);
  const known = ages.filter((age) => age != null);
  if (known.length !== 0 && known.length !== count) {
    throw MeshWXEncodeError.partialObservationAges({ known: known.length, stations: count });
  }
  const hasAges = known.length === count;

  const writer = new Writer();
  writeHeader(writer, {
    seq,
    bot,
    rawType: MeshWXMessageType.observations,
    flags: (hasAges ? MeshWXWire.flagObservationAges : 0) | sourceBits(source),
  });
  writer.u32(requireRange(timestampMinutes, 0, 0xffff_ffff, 'ts_min'));
  writer.u8(count);
  for (const station of stations) {
    writer.u16(requireRange(station.station, 0, 0xffff, 'station'));
    writer.u8(signedByte(station.temp_f, MeshWXWire.temperatureUnknown, 'temp_f'));
    writer.u8(signedByte(station.dewpoint_f, MeshWXWire.temperatureUnknown, 'dewpoint_f'));
    writer.u8(
      (MeshWXCompass.fromDegrees(station.wind_dir_deg) << 4) | ((station.sky ?? 15) & 0x0f),
    );
    writer.u8(unsignedByte(station.wind_mph, MeshWXWire.unsignedUnknown, 'wind_mph'));
    writer.u8(unsignedByte(station.gust_mph, 0, 'gust_mph'));
    writer.u8(unsignedByte(station.visibility_mi, MeshWXWire.unsignedUnknown, 'visibility_mi'));
    writer.u8(pressureByte(station.pressure_inhg ?? null));
    writer.u8(unsignedByte(station.humidity_pct, MeshWXWire.unsignedUnknown, 'humidity_pct'));
    writer.u8(signedByte(station.feels_delta_f, 0, 'feels_delta_f'));
  }
  if (hasAges) writer.push(encodeAges(known));
  return writer.done('observations');
}

// MARK: - Forecast (type 5, spec §7)

/** Encode a point Forecast (1…14 periods, 5 bytes each), the periods in decoded shape. */
export function forecast({ seq, bot, pointIndex, issuedMinutes, firstPeriod, periods, source = 0 }) {
  if (periods.length < 1 || periods.length > MeshWXWire.maxPeriods) {
    throw MeshWXEncodeError.badCount({
      what: 'forecast periods', count: periods.length, allowed: [1, MeshWXWire.maxPeriods],
    });
  }
  const writer = new Writer();
  writeHeader(writer, {
    seq, bot, rawType: MeshWXMessageType.forecast, flags: sourceBits(source),
  });
  writer.u16(requireRange(pointIndex, 0, 0xffff, 'point'));
  writer.u32(requireRange(issuedMinutes, 0, 0xffff_ffff, 'issued_min'));
  writer.u8(requireRange(firstPeriod, 0, 255, 'first_period'));
  writer.u8(periods.length);
  for (const period of periods) {
    let condition = (period.sky ?? 15) & 0x0f;
    if (period.thunder) condition |= 0x10;
    if (period.wintry) condition |= 0x20;
    if (period.windy) condition |= 0x40;
    if (period.fog) condition |= 0x80;
    // Speed is a nibble of 5 mph steps; 15 means "75 or more", so clamping up is the spec's own
    // behaviour rather than a lossy shortcut.
    const speedNibble = period.wind_mph == null
      ? 0
      : Math.min(15, roundHalfToEven(period.wind_mph / 5));
    writer.u8(signedByte(period.high_f, MeshWXWire.forecastTemperatureNotGiven, 'high_f'));
    writer.u8(signedByte(period.low_f, MeshWXWire.forecastTemperatureNotGiven, 'low_f'));
    writer.u8(unsignedByte(period.pop_pct, MeshWXWire.unsignedUnknown, 'pop_pct'));
    writer.u8(condition);
    writer.u8((MeshWXCompass.fromDegrees(period.wind_dir_deg) << 4) | speedNibble);
  }
  return writer.done('forecast');
}

// MARK: - Coverage (type 8, spec §10)

/**
 * The app never sends this — only a bot states its own coverage — but the vector round trip and
 * the coverage tests both need the bytes, and a codec exercised in one direction drifts.
 *
 * The offices go out in the order given: the bot sends them ascending, and sorting them here
 * would hide a caller that did not rather than reproduce what arrived.
 */
export function coverage({
  seq,
  bot,
  latitude,
  longitude,
  radiusKilometres,
  stationCap,
  officeIndices,
  areas,
  areasCut = false,
  officesCut = false,
}) {
  if (officeIndices.length > MeshWXWire.maxCoverageOffices) {
    throw MeshWXEncodeError.badCount({
      what: 'coverage offices',
      count: officeIndices.length,
      allowed: [0, MeshWXWire.maxCoverageOffices],
    });
  }
  let flags = 0;
  if (areasCut) flags |= MeshWXWire.flagCoverageZonesCut;
  if (officesCut) flags |= MeshWXWire.flagCoverageOfficesCut;

  const writer = new Writer();
  writeHeader(writer, { seq, bot, rawType: MeshWXMessageType.coverage, flags });
  writer.i24(roundHalfToEven(latitude * 10000), 'coverage lat');
  writer.i24(roundHalfToEven(longitude * 10000), 'coverage lon');
  writer.u16(requireRange(radiusKilometres, 0, 0xffff, 'radius_km'));
  writer.u8(requireRange(stationCap, 0, 255, 'stations'));
  writer.u8(officeIndices.length);
  for (const office of officeIndices) writer.u8(requireRange(office, 0, 255, 'office'));
  writer.push(encodeAreas(areas, { what: 'coverage runs', allowingEmpty: true }));
  return writer.done('coverage');
}

// MARK: - Text (type 6, spec §8)

/**
 * Encode one Text chunk.
 *
 * `wasCut` says the reply ran past `MeshWXWire.maxTextChunks` and the bot dropped the tail
 * (spec §8, revision 7). Every chunk of a cut reply carries it, not only the last.
 */
export function text({
  seq, bot, subject, group, index, total, text: body, wasCut = false, source = 0,
}) {
  if (total < 1 || total > MeshWXWire.maxTextChunks) {
    throw MeshWXEncodeError.badCount({
      what: 'text total', count: total, allowed: [1, MeshWXWire.maxTextChunks],
    });
  }
  if (!(index < total)) {
    throw MeshWXEncodeError.outOfRange({ field: 'text index', value: index });
  }
  const encoded = TEXT_ENCODER.encode(body);
  if (encoded.length > MeshWXWire.maxTextBytes) {
    throw MeshWXEncodeError.oversize({ what: 'text chunk', bytes: encoded.length });
  }
  const writer = new Writer();
  writeHeader(writer, {
    seq,
    bot,
    rawType: MeshWXMessageType.text,
    flags: (wasCut ? MeshWXWire.flagTextCut : 0) | sourceBits(source),
  });
  writer.u8(requireRange(subject, 0, 255, 'subject'));
  writer.u8(requireRange(group, 0, 255, 'group'));
  writer.u8(index);
  writer.u8(total);
  writer.push(encoded);
  return writer.done('text');
}

/**
 * Split a reply into Text chunks.
 *
 * Chunks never split a UTF-8 code point — an accented place name cut in half is two unreadable
 * chunks, not one — carry at most 157 text bytes, share `group = seqStart`, and take consecutive
 * sequence numbers wrapping 255 → 0.
 *
 * `wasCut` says the caller already dropped the product's tail to make it fit (spec §8,
 * revision 7). Marked on every chunk, because a reader missing the last one still has to know
 * the reply is short of the product. The cutting itself is the bot's, at a sentence boundary;
 * this never truncates on its own — past `MeshWXWire.maxTextChunks` it still throws.
 */
export function textChunks({ seqStart, bot, subject, text: body, wasCut = false, source = 0 }) {
  requireRange(seqStart, 0, 255, 'seq');
  requireRange(bot, 0, 0xffff, 'bot');
  const encoded = TEXT_ENCODER.encode(body);
  const parts = [];
  let position = 0;
  while (position < encoded.length || parts.length === 0) {
    let end = Math.min(position + MeshWXWire.maxTextBytes, encoded.length);
    // Back off to a code point boundary: continuation bytes are 0b10xxxxxx.
    while (end > position && end < encoded.length && (encoded[end] & 0xc0) === 0x80) end -= 1;
    if (!(end > position || position >= encoded.length)) throw MeshWXEncodeError.codePointTooLarge();
    parts.push(encoded.subarray(position, end));
    position = end;
  }
  if (parts.length > MeshWXWire.maxTextChunks) {
    throw MeshWXEncodeError.textTooLong({ chunks: parts.length });
  }
  return parts.map((part, offset) => text({
    seq: (seqStart + offset) & 0xff,
    bot,
    subject,
    group: seqStart,
    index: offset,
    total: parts.length,
    text: TEXT_DECODER.decode(part),
    wasCut,
    source,
  }));
}

// MARK: - Not available (type 7, spec §9)

/**
 * Encode a Not-available reply.
 *
 * `request` is the request string (`">f round rock tx"`) or just its first letter; only the
 * ASCII code of that letter goes on the wire. Pass `requestCode` instead to give the byte.
 *
 * No `source`: there is no weather product behind a Not available, so its source bits stay
 * unstated.
 */
export function notAvailable({ seq, bot, request, requestCode, reason }) {
  let code = requestCode;
  if (code == null) {
    const stripped = String(request ?? '').replace(/^>+/, '').replace(/^\s+/, '');
    if (stripped.length === 0) throw MeshWXEncodeError.emptyRequest();
    code = stripped.codePointAt(0);
    if (code > 127) throw MeshWXEncodeError.emptyRequest();
  }
  const writer = new Writer();
  writeHeader(writer, { seq, bot, rawType: MeshWXMessageType.notAvailable, flags: 0 });
  writer.u8(requireRange(code, 0, 255, 'request'));
  writer.u8(requireRange(reason, 0, 255, 'reason'));
  return writer.done('not_available');
}

// MARK: - Request (type 9, spec §11)

function senderBytes(senderPrefix) {
  const bytes = typeof senderPrefix === 'string'
    ? (/^[0-9a-fA-F]*$/.test(senderPrefix) && senderPrefix.length % 2 === 0
      ? Uint8Array.from(
        senderPrefix.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16),
      )
      : null)
    : Uint8Array.from(senderPrefix);
  if (bytes == null || bytes.length !== MeshWXWire.requestSenderPrefixSize) {
    throw MeshWXEncodeError.badCount({
      what: 'request sender',
      count: bytes == null ? -1 : bytes.length,
      allowed: [MeshWXWire.requestSenderPrefixSize, MeshWXWire.requestSenderPrefixSize],
    });
  }
  return bytes;
}

/**
 * The app's own `>` request, as the datagram it is flooded on `#meshwx` as (spec §11).
 *
 * The one message this app transmits, so this is the one encoder whose output goes on the air
 * rather than into a test. Strict about all three variable things — a six-byte key prefix, a
 * non-empty text that starts with `>`, and 40 bytes of it at most — because a request the bot
 * cannot parse is silence, and silence is what the datagram exists to fix.
 *
 * - `seq`: the **sender's** counter, repeated on a resend.
 * - `bot`: the bot asked; `MeshWXRequest.anyBot` asks them all.
 * - `senderPrefix`: the first six bytes of this phone's public key, as bytes or 12 hex chars.
 * - `timestamp`: Unix seconds on the sender's clock; a resend repeats it.
 * - `text`: the §14 request, starting with `>`.
 */
export function request({ seq, bot, senderPrefix, timestamp, text: body }) {
  const sender = senderBytes(senderPrefix);
  const encoded = TEXT_ENCODER.encode(body);
  if (!String(body).startsWith('>') || encoded.length <= 1) throw MeshWXEncodeError.emptyRequest();
  if (encoded.length > MeshWXWire.maxRequestTextBytes) {
    throw MeshWXEncodeError.oversize({ what: 'request text', bytes: encoded.length });
  }
  const writer = new Writer();
  writeHeader(writer, { seq, bot, rawType: MeshWXMessageType.request, flags: 0 });
  writer.push(sender);
  writer.u32(requireRange(timestamp, 0, 0xffff_ffff, 'ts'));
  writer.push(encoded);
  return writer.done('request');
}

// MARK: - Area sweep (type 10, spec §12)

/**
 * One packet of a national sweep. The app never sends one — only a bot builds them — but the
 * shared vectors are a round trip, and the map's tests need a sweep of Montana without waiting
 * for a blizzard.
 *
 * Every field is bounded and every bound is checked rather than masked: `state << 1 | kind` puts
 * the state one bit from the kind, and a state index of 128 silently truncated would move every
 * area in the packet to another state's outlines.
 */
export function areaSweep({
  seq,
  bot,
  builtMinutes,
  group,
  index,
  total,
  entries,
  wasCut = false,
  includesAdvisories = false,
  isScoped = false,
  scope = [],
  source = 0,
}) {
  if (total < 1 || total > MeshWXWire.maxAreaSweepPackets) {
    throw MeshWXEncodeError.badCount({
      what: 'area sweep total', count: total, allowed: [1, MeshWXWire.maxAreaSweepPackets],
    });
  }
  if (!(index < total)) {
    throw MeshWXEncodeError.outOfRange({ field: 'area sweep index', value: index });
  }
  const states = scope ?? [];
  if (states.length > MeshWXWire.maxSweepScopeStates) {
    throw MeshWXEncodeError.badCount({
      what: 'area sweep scope', count: states.length, allowed: [0, MeshWXWire.maxSweepScopeStates],
    });
  }
  // Spec §12, revision 10: the scope entries "count toward the 38 per packet". They are entries
  // like any other on the wire, so the packet budget is the same budget.
  if (states.length + entries.length > MeshWXWire.maxAreaSweepEntries) {
    throw MeshWXEncodeError.badCount({
      what: 'area sweep entries',
      count: states.length + entries.length,
      allowed: [0, MeshWXWire.maxAreaSweepEntries],
    });
  }

  let flags = wasCut ? MeshWXWire.flagSweepCut : 0;
  if (includesAdvisories) flags |= MeshWXWire.flagSweepAdvisories;
  flags |= sourceBits(source);

  const writer = new Writer();
  writeHeader(writer, { seq, bot, rawType: MeshWXMessageType.areaSweep, flags });
  writer.u32(requireRange(builtMinutes, 0, 0xffff_ffff, 'built_min'));
  writer.u8(requireRange(group, 0, 255, 'group'));
  writer.u8(index);
  // Bit 7 rides on the count byte, so a national sweep encodes to exactly the bytes it always
  // did and a scoped one is one bit different (spec §12, revision 10).
  writer.u8(total | (isScoped ? MeshWXWire.sweepScopedBit : 0));
  // The scope first, as the decoder lifted it: `XXZ000` — event 0, kind zone, start 0, run 1.
  for (const state of states) {
    if (!(state >= 0 && state <= 127)) {
      throw MeshWXEncodeError.outOfRange({ field: 'sweep scope state index', value: state });
    }
    writer.u8(MeshWXWire.sweepScopeEvent);
    writer.u8(state << MeshWXWire.sweepStateShift);
    writer.u16(0);
  }
  for (const entry of entries) {
    if (!(entry.state >= 0 && entry.state <= 127)) {
      throw MeshWXEncodeError.outOfRange({ field: 'sweep state index', value: entry.state });
    }
    if (!(entry.start >= 0 && entry.start <= MeshWXWire.maxAreaSweepStart)) {
      throw MeshWXEncodeError.outOfRange({ field: 'sweep start', value: entry.start });
    }
    if (!(entry.run >= 1 && entry.run <= MeshWXWire.maxAreaSweepRun)) {
      throw MeshWXEncodeError.outOfRange({ field: 'sweep run', value: entry.run });
    }
    writer.u8(requireRange(entry.event, 0, 255, 'event'));
    writer.u8((entry.state << MeshWXWire.sweepStateShift) | (entry.county ? MeshWXWire.sweepCountyBit : 0));
    writer.u16(((entry.run - 1) << MeshWXWire.sweepRunShift) | entry.start);
  }
  return writer.done('area sweep');
}

// MARK: - Radar (type 11, spec §13)

/**
 * The cells as a quadtree, most significant bit first, padded with zero bits to the end of the
 * last byte.
 *
 * Greedy and uniform-first: a square all of one level costs one bit and two, whatever its size,
 * so the dry half of a picture is nearly free and the squall line is where the bytes go. The
 * order of the four children — north-west, north-east, south-west, south-east — is the wire's,
 * and reversing any two of them would still round trip through this file alone, which is why
 * the vectors are the test and not a round trip.
 */
function packRadarCells(rows) {
  const bits = [];
  const put = (value, width) => {
    for (let shift = width - 1; shift >= 0; shift -= 1) bits.push((value >> shift) & 1);
  };

  const node = (row, col, size) => {
    const first = rows[row][col];
    if (size === 1) {
      put(first, 2);
      return;
    }
    let isUniform = true;
    for (let y = row; y < row + size && isUniform; y += 1) {
      for (let x = col; x < col + size; x += 1) {
        if (rows[y][x] !== first) { isUniform = false; break; }
      }
    }
    if (isUniform) {
      put(0, 1);
      put(first, 2);
      return;
    }
    put(1, 1);
    const half = size / 2;
    node(row, col, half);
    node(row, col + half, half);
    node(row + half, col, half);
    node(row + half, col + half, half);
  };

  node(0, 0, rows.length);
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index]) out[index >> 3] |= 1 << (7 - (index & 7));
  }
  return out;
}

/**
 * One tile of a radar picture (spec §13, revision 11).
 *
 * `rows` is the grid, north row first, west column first, each cell 0-3: `MeshWXWire.radarGrid`
 * rows of that many for a fine tile, `radarCoarseGrid` for a coarse one, and **which it is is
 * what sets the coarse flag** — there is no separate argument, because a 16 × 16 grid sent
 * without the flag would be read as the north-west quarter of the tile.
 *
 * `bounds` is `{ row0, row1, col0, col1 }` or the four-element wire array, inclusive, in this
 * grid's own numbering: the part of the tile the picture covers. Cells outside it must be level
 * 0, and a level outside them is refused rather than dropped, because on the wire that cell
 * means *unknown* and an echo there is a contradiction the receiver cannot see.
 *
 * Throws `oversize` when a fine tile does not fit the packet. The bot's answer to that is to
 * coarsen and encode again; nothing in the app ever encodes one at all, but the vectors are a
 * round trip and a test needs a squall line without waiting for one.
 */
export function radar({
  seq,
  bot,
  takenMinutes,
  south,
  west,
  zoom,
  product,
  rows,
  bounds = null,
  source = 0,
}) {
  const grid = rows.map((row) => (typeof row === 'string'
    ? [...row].map((digit) => digit.charCodeAt(0) - 48)
    : [...row]));
  const size = grid.length;
  if (size !== MeshWXWire.radarGrid && size !== MeshWXWire.radarCoarseGrid) {
    throw MeshWXEncodeError.badCount({
      what: 'radar rows', count: size, allowed: [MeshWXWire.radarCoarseGrid, MeshWXWire.radarGrid],
    });
  }
  for (const row of grid) {
    if (row.length !== size) {
      throw MeshWXEncodeError.badCount({ what: 'radar row', count: row.length, allowed: [size, size] });
    }
    for (const level of row) {
      if (!(level >= 0 && level <= 3)) {
        throw MeshWXEncodeError.outOfRange({ field: 'radar level', value: level });
      }
    }
  }
  requireRange(zoom, 0, MeshWXWire.maxRadarZoom, 'zoom');
  requireRange(product, 0, MeshWXWire.maxRadarProduct, 'product');
  requireRange(south, -90, 90, 'south');
  requireRange(west, -180, 179, 'west');

  let flags = size === MeshWXWire.radarCoarseGrid ? MeshWXWire.radarCoarseBit : 0;
  let box = null;
  if (bounds != null) {
    box = Array.isArray(bounds)
      ? { row0: bounds[0], row1: bounds[1], col0: bounds[2], col1: bounds[3] }
      : bounds;
    if (!MeshWXRadarBounds.isValid(box, { size })) {
      throw MeshWXEncodeError.radarBoundsOutsideGrid({ ...box, size });
    }
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (grid[row][col] !== 0 && !MeshWXRadarBounds.contains(box, { row, col })) {
          throw MeshWXEncodeError.radarCellOutsideBounds({ row, col });
        }
      }
    }
    flags |= MeshWXWire.radarPartialBit;
  }
  flags |= sourceBits(source);

  const writer = new Writer();
  writeHeader(writer, { seq, bot, rawType: MeshWXMessageType.radar, flags });
  writer.u32(requireRange(takenMinutes, 0, 0xffff_ffff, 'taken_min'));
  writer.i8(south);
  writer.i16(west);
  writer.u8((product << MeshWXWire.radarProductShift) | zoom);
  if (box != null) for (const value of MeshWXRadarBounds.array(box)) writer.u8(value);
  writer.push(packRadarCells(grid));
  return writer.done('radar');
}

// MARK: - Round trip

/**
 * Re-encode a decoded message, header and all.
 *
 * This is what the vector suite runs: decode every official hex, encode it back, and compare
 * the bytes. An unknown body has no encoding — the decoder kept only the header — so it is
 * refused rather than emitted as a 4-byte stub that would look like a valid message of a type
 * we do not implement.
 *
 * Flags bits 3-2 live on the header, not in any body, so the `source` key is what the encoder
 * reads them back from. A Cancel's nibble is its reason and never this (spec §2.2, revision 7).
 */
export function encode(message) {
  const { seq, bot } = message;
  const source = message.source ?? 0;
  const identity = { event: message.event, office: message.office, etn: message.etn };
  switch (message.type) {
    case MeshWXMessageType.warning:
      return warning({
        seq,
        bot,
        identity,
        expiresMinutes: message.expires_min,
        tornado: message.tornado,
        floodSource: message.flood_source,
        floodDamage: message.flood_damage,
        hailQuarterInches: message.hail_qin,
        windMph: message.wind_mph,
        polygon: message.polygon,
        areas: message.areas,
        isUpdate: message.update,
        // Resolved and subtracted back: `expires − (expires − before)` is the same two bytes,
        // saturation included, so the round trip stays byte-identical.
        issuedMinutes: message.issued_min,
        // Absolute like the issue time, and subtracted back the same way (revision 12).
        beginsMinutes: message.begins_min ?? null,
        source,
      });
    case MeshWXMessageType.cancel:
      return cancel({ seq, bot, identity, reason: message.reason });
    case MeshWXMessageType.digest:
      return digest({
        seq,
        bot,
        nowMinutes: message.now_min,
        feedHealth: message.feed_health,
        entries: message.entries.map((entry) => ({
          identity: { event: entry.event, office: entry.office, etn: entry.etn },
          expiresMinutes: entry.expires_min,
        })),
        source,
      });
    case MeshWXMessageType.observations:
      return observations({
        seq, bot, timestampMinutes: message.ts_min, stations: message.stations, source,
      });
    case MeshWXMessageType.forecast:
      return forecast({
        seq,
        bot,
        pointIndex: message.point,
        issuedMinutes: message.issued_min,
        firstPeriod: message.first_period,
        periods: message.periods,
        source,
      });
    case MeshWXMessageType.text:
      return text({
        seq,
        bot,
        subject: message.subject,
        group: message.group,
        index: message.idx,
        total: message.total,
        text: message.text,
        wasCut: message.cut,
        source,
      });
    case MeshWXMessageType.notAvailable:
      return notAvailable({ seq, bot, requestCode: message.request_code, reason: message.reason });
    case MeshWXMessageType.coverage:
      return coverage({
        seq,
        bot,
        latitude: message.lat,
        longitude: message.lon,
        radiusKilometres: message.radius_km,
        stationCap: message.stations,
        officeIndices: message.offices,
        areas: message.areas,
        areasCut: message.zones_cut,
        officesCut: message.offices_cut,
      });
    case MeshWXMessageType.request:
      return request({
        seq, bot, senderPrefix: message.sender, timestamp: message.ts, text: message.text,
      });
    case MeshWXMessageType.areaSweep:
      return areaSweep({
        seq,
        bot,
        builtMinutes: message.built_min,
        group: message.group,
        index: message.idx,
        total: message.total,
        entries: message.entries,
        wasCut: message.cut,
        includesAdvisories: message.advisories,
        // Revision 10. A message decoded before them — or fabricated by a test that predates
        // them — is a national sweep, which is what these defaults spell.
        isScoped: message.scoped === true,
        scope: message.scope ?? [],
        source,
      });
    case MeshWXMessageType.radar:
      // The coarse and partial flags are not passed: both are read back off the *body* — the
      // grid's own size, and whether there are bounds — so a re-encode cannot disagree with the
      // cells it is encoding.
      return radar({
        seq,
        bot,
        takenMinutes: message.taken_min,
        south: message.south,
        west: message.west,
        zoom: message.zoom,
        product: message.product,
        rows: message.rows,
        bounds: message.bounds,
        source,
      });
    default:
      throw MeshWXEncodeError.outOfRange({ field: 'type', value: message.type });
  }
}

export const MeshWXEncoder = Object.freeze({
  header,
  warning,
  cancel,
  digest,
  observations,
  forecast,
  coverage,
  text,
  textChunks,
  notAvailable,
  request,
  areaSweep,
  radar,
  encode,
});
