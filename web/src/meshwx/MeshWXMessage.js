// Port of MC1Services/Sources/MeshWX/MeshWXMessage.swift
//
// ============================================================================
// SWIFT FIELD  →  VECTOR KEY, for all eleven message types (PORTING §5)
// ============================================================================
//
// A decoded message is *exactly* the `decoded` object of docs/meshwx_v5_vectors.json:
// snake_case keys, no Swift names. Everything wrapped *around* a message keeps its Swift
// names. This table is the whole mapping; read it before touching a message.
//
// Common header — the first five keys of every decoded message (spec §2.2):
//   MeshWXHeader.seq              → seq          u8, per-bot sequence number
//   MeshWXHeader.bot              → bot          u16, first two bytes of the bot's public key
//   MeshWXHeader.rawType          → type         u8, 1…11 (the high nibble)
//   MeshWXHeader.type             → name         "warning" … "radar", "unknown"
//   MeshWXHeader.flags            → flags        u8, the low nibble, verbatim
//   MeshWXHeader.dataSource       → source       0 unstated, 1 GOES, 2 internet, 3 mixed.
//                                                Present on every type that carries weather;
//                                                absent from cancel, not_available, coverage
//                                                and request, which never state one.
//
// MeshWXAreaRun (a run of UGC numbers, inside `areas` on a warning and on coverage, spec §3):
//   stateIndex                    → state
//   isCounty                      → county
//   start                         → start
//   run                           → run
//
// Type 1, MeshWXWarning (spec §3):
//   identity.event                → event
//   identity.office               → office
//   identity.etn                  → etn
//   expiresMinutes                → expires_min
//   tornado                       → tornado
//   floodSource                   → flood_source
//   floodDamage                   → flood_damage
//   hailQuarterInches             → hail_qin
//   windMph                       → wind_mph
//   isUpdate                      → update
//   polygon                       → polygon        [[lat, lon], …] or null (NOT coordinates)
//   areas                         → areas          [MeshWXAreaRun shape, …] or null
//   issuedMinutes                 → issued_min     absolute Unix minutes, or null
//   issuedBeforeMinutes           → (not carried)  = expires_min − issued_min; see
//                                                  MeshWXWarning.issuedBeforeMinutes()
//   beginsMinutes                 → begins_min     absolute Unix minutes, or null (revision 12);
//                                                  null too when the wire value was not valid
//   beginsBeforeMinutes           → (not carried)  = expires_min − begins_min; see
//                                                  MeshWXWarning.beginsBeforeMinutes()
//
// Type 2, MeshWXCancel (spec §4) — the one type with no `source`:
//   identity.event                → event
//   identity.office               → office
//   identity.etn                  → etn
//   reason                        → reason         the WHOLE flags nibble, 0…15
//
// Type 3, MeshWXDigest (spec §5):
//   nowMinutes                    → now_min
//   feedHealth                    → feed_health
//   entries                       → entries
//     Entry.identity.event        → event
//     Entry.identity.office       → office
//     Entry.identity.etn          → etn
//     Entry.expiresRelativeMinutes→ expires_rel
//     Entry.expiresMinutes        → expires_min
//
// Type 4, MeshWXObservations (spec §6):
//   timestampMinutes              → ts_min
//   stations                      → stations
//     MeshWXStationObservation.stationIndex     → station
//     .tempF                                    → temp_f          null when unknown
//     .dewpointF                                → dewpoint_f      null when unknown
//     .windDirection                            → wind_dir_deg    nibble × 22.5
//                                               → wind_dir        "N", "NNE", …
//     .sky                                      → sky
//     .windMph                                  → wind_mph        null when unknown
//     .gustMph                                  → gust_mph        0 = no gust
//     .visibilityMiles                          → visibility_mi   null when unknown
//     .pressureInHg                             → pressure_inhg   null when unknown
//     .humidityPercent                          → humidity_pct    null when unknown
//     .feelsDeltaF                              → feels_delta_f
//     .ageMinutes                               → age_min         null when the batch says nothing
//
// Type 5, MeshWXForecast (spec §7):
//   pointIndex                    → point
//   issuedMinutes                 → issued_min
//   firstPeriod                   → first_period
//   periods                       → periods
//     MeshWXForecastPeriod.highF  → high_f         null when not given (127 on the wire)
//     .lowF                       → low_f          null when not given
//     .popPercent                 → pop_pct        null when not given
//     .sky                        → sky
//     .thunder / .wintry / .windy / .fog          → thunder / wintry / windy / fog
//     .windDirection              → wind_dir_deg + wind_dir
//     .windMph                    → wind_mph       already 0, 5, 10 … 75
//
// Type 6, MeshWXText (spec §8):
//   subject                       → subject
//   group                         → group
//   index                         → idx
//   total                         → total
//   text                          → text
//   wasCut                        → cut
//
// Type 7, MeshWXNotAvailable (spec §9) — no `source`:
//   requestCode                   → request_code   ASCII code of the request's first letter
//   requestLetter                 → request        that letter
//   reason                        → reason
//
// Type 8, MeshWXCoverage (spec §10) — no `source`:
//   latitude                      → lat
//   longitude                     → lon
//   radiusKilometres              → radius_km
//   stationCap                    → stations       a CAP, not a list: an integer
//   officeIndices                 → offices
//   areas                         → areas          [MeshWXAreaRun shape, …]
//   areasCut                      → zones_cut
//   officesCut                    → offices_cut
//
// Type 9, MeshWXRequest (spec §11) — no `source`:
//   seq                           → seq
//   botID                         → bot
//   senderPrefix                  → sender         12 lower-case hex characters, not bytes
//   timestamp                     → ts             Unix SECONDS (every other time is minutes)
//   text                          → text
//
// Type 10, MeshWXAreaSweep (spec §12):
//   builtMinutes                  → built_min
//   group                         → group
//   index                         → idx
//   total                         → total
//   wasCut                        → cut
//   includesAdvisories            → advisories
//   isScoped                      → scoped         revision 10: bit 7 of the `total` byte
//   scope                         → scope          revision 10: the state indices the packet's
//                                                  `event = 0` entries name; [] on every packet
//                                                  of a national sweep and on packets 1… of a
//                                                  scoped one, which carry no scope entries
//   entries                       → entries        ALERT entries only; the scope is lifted out
//     Entry.event                 → event
//     Entry.stateIndex            → state
//     Entry.isCounty              → county         bit 0 of the wire byte, NOT bit 7
//     Entry.start                 → start
//     Entry.run                   → run            carried less one in six bits
//
// Type 11, MeshWXRadar (spec §13, revision 11) — the types are in MeshWXRadar.js:
//   takenMinutes                  → taken_min      the time printed on the radar picture
//   south                         → south          i8, whole degrees
//   west                          → west           i16, whole degrees
//   zoom                          → zoom           0…3, from the `shape` byte's low two bits
//   product                       → product        the mosaic's index in `v5.radar.products`
//   isCoarse                      → coarse         flags bit 0: a 16 × 16 grid, not 32 × 32
//   (flags bit 1)                 → partial        the four `bounds` bytes are present
//   bounds                        → bounds         [row0, row1, col0, col1] or null
//   (derived from `coarse`)       → size           16 or 32, cells along one side
//   cells                         → rows           `size` strings of the digits 0-3, north row
//                                                  first, west column first. A cell outside
//                                                  `bounds` is 0 and means UNKNOWN, not dry.
//
// ============================================================================

import { MeshWXWire } from './MeshWXWire.js';
// MeshWXGeo lives in MeshWXTables.swift, so it lives in MeshWXTables.js (PORTING §2). That
// makes this import cyclic; it is safe because neither module touches the other at evaluation
// time — only inside function bodies.
import { MeshWXGeo } from './MeshWXTables.js';
// Same story for the Request's own `encode()`, which lives on the value in Swift.
import { request as encodeRequest } from './MeshWXEncoder.js';

// MARK: - Shared scalars

/** Round half to even — Swift's `.toNearestOrEven`, Python's `round()`. */
export function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const COMPASS_ABBREVIATIONS = Object.freeze([
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]);

/**
 * A 16-point compass direction, as carried in a wind nibble (spec §6, §7): the raw nibble
 * 0…15, with the Swift case names as constants.
 *
 * The wire spends four bits on direction, so a station reporting 157° and one reporting 163°
 * are the same value on air. Keeping the nibble as the model (rather than the degrees it was
 * rounded from) is what makes a decode/re-encode round trip byte-identical; `degrees()`
 * reconstructs the centre of the sector for a compass rose.
 */
export const MeshWXCompass = Object.freeze({
  north: 0,
  northNorthEast: 1,
  northEast: 2,
  eastNorthEast: 3,
  east: 4,
  eastSouthEast: 5,
  southEast: 6,
  southSouthEast: 7,
  south: 8,
  southSouthWest: 9,
  southWest: 10,
  westSouthWest: 11,
  west: 12,
  westNorthWest: 13,
  northWest: 14,
  northNorthWest: 15,

  abbreviations: COMPASS_ABBREVIATIONS,

  /** Never fails: the nibble is masked, and all 16 values are defined. */
  make({ nibble, degrees }) {
    if (nibble != null) return nibble & 0x0f;
    return MeshWXCompass.fromDegrees(degrees);
  },

  /**
   * Degrees true to the nearest sector, the reference's `wind_dir_nibble`.
   *
   * Spec §6: direction 0 with speed 0 means calm, so a null heading maps to north and the
   * *speed* is what tells the caller there was no wind.
   */
  fromDegrees(degrees) {
    if (degrees == null || !Number.isFinite(degrees)) return 0;
    // Wrap before rounding so a bearing of 3600° or −45° cannot overflow; JS `%` keeps the
    // sign of the dividend exactly as Swift's `truncatingRemainder` does, hence the fold below.
    const wrapped = degrees % 360;
    const sector = roundHalfToEven(wrapped / 22.5);
    return (((sector % 16) + 16) % 16) & 0x0f;
  },

  /** Centre of the sector, in degrees true. */
  degrees(nibble) {
    return (nibble & 0x0f) * 22.5;
  },

  /**
   * The NWS abbreviation: `"N"`, `"NNE"`, … Not localised on purpose; these are symbols, and
   * the app shows them as-is the way an aviation report does.
   */
  abbreviation(nibble) {
    return COMPASS_ABBREVIATIONS[nibble & 0x0f];
  },
});

/** Sky condition code (spec §18.6, `protocol.json` `sky_codes`). */
export const MeshWXSky = Object.freeze({
  clear: 0,
  few: 1,
  scattered: 2,
  broken: 3,
  overcast: 4,
  fog: 5,
  smoke: 6,
  haze: 7,
  rain: 8,
  snow: 9,
  thunderstorm: 10,
  drizzle: 11,
  mist: 12,
  squall: 13,
  sandOrDust: 14,
  /**
   * In an observation: the report had no cloud or weather group, so the sky is unknown
   * (spec §6, revision 3).
   */
  other: 15,

  /** Never fails: the nibble is masked, and all 16 values are defined. */
  make({ nibble }) {
    return nibble & 0x0f;
  },
});

/**
 * A polygon vertex, `{ latitude, longitude }` in plain degrees. The shape `MeshWXGeometry`
 * speaks; a decoded warning's `polygon` is `[[lat, lon], …]` instead (PORTING §5), which
 * `MeshWXWarning.polygonCoordinates()` converts.
 */
export const MeshWXCoordinate = Object.freeze({
  make({ latitude, longitude }) {
    return { latitude, longitude };
  },
});

// MARK: - Warning

/**
 * The key a warning is stored under (spec §2.4), `{ event, office, etn }`.
 *
 * Not `seq`: the bot re-sends a warning whenever its expiry, tags or area change, with a fresh
 * sequence number every time. An app that keys by anything else ends up with the same storm
 * listed twice.
 */
export const MeshWXWarningIdentity = Object.freeze({
  make({ event, office, etn }) {
    return { event, office, etn };
  },

  /**
   * The dictionary key of PORTING §3: decimal numbers joined by dots, `"3.35.42"`. Use it
   * everywhere a warning is stored, never `seq`.
   */
  key(identity) {
    return `${identity.event}.${identity.office}.${identity.etn}`;
  },

  /**
   * The identity of anything that carries one: a decoded warning, a cancel, or a digest entry
   * — all three spell it `event` / `office` / `etn`.
   */
  of(warning) {
    return { event: warning.event, office: warning.office, etn: warning.etn };
  },

  /** `"3.35.42"` back to an identity, or null when the key is not three decimal numbers. */
  parse(key) {
    const parts = String(key).split('.');
    if (parts.length !== 3) return null;
    const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : null));
    if (numbers.some((value) => value == null)) return null;
    return { event: numbers[0], office: numbers[1], etn: numbers[2] };
  },
});

/** Tornado tag, bits 7-6 of the warning tag byte (spec §3). */
export const MeshWXTornadoTag = Object.freeze({
  none: 0,
  possible: 1,
  radarIndicated: 2,
  observed: 3,
});

/** Flood source tag, bits 5-4 of the warning tag byte (spec §3). */
export const MeshWXFloodSource = Object.freeze({
  none: 0,
  radar: 1,
  radarAndGauge: 2,
  observed: 3,
});

/**
 * Flood damage tag, bits 3-2 of the warning tag byte (spec §3).
 *
 * Only three values are defined; `reserved` exists so the two-bit field always decodes rather
 * than throwing on a byte from a newer bot.
 */
export const MeshWXFloodDamage = Object.freeze({
  none: 0,
  considerable: 1,
  catastrophic: 2,
  reserved: 3,
});

/**
 * One run of consecutive UGC numbers in the same state and of the same kind (spec §3), as the
 * decoded `{ state, county, start, run }`.
 *
 * `TXZ191`…`TXZ194` is one run, not four entries: a winter storm covering twenty zones is the
 * difference between fitting in a packet and not.
 */
export const MeshWXAreaRun = Object.freeze({
  make({ state, county = false, start, run }) {
    return { state, county, start, run };
  },

  /** The UGC numbers this run covers. */
  numbers(areaRun) {
    if (!(areaRun.run > 0)) return [];
    const out = [];
    for (let offset = 0; offset < areaRun.run; offset += 1) {
      out.push((areaRun.start + offset) & 0xffff);
    }
    return out;
  },

  /**
   * Expand to UGC strings (`"TXC453"`, `"TXZ191"`) using `index.json` `states`.
   *
   * Returns an empty array when the state index is not in the table: an older bundle decoding a
   * newer bot's traffic should lose the *names*, never the message.
   */
  ugcCodes(areaRun, { states }) {
    if (areaRun.state >= states.length) return [];
    const state = states[areaRun.state];
    const kind = areaRun.county ? 'C' : 'Z';
    return MeshWXAreaRun.numbers(areaRun).map(
      (number) => `${state}${kind}${MeshWXAreaRun.ugcDigits(number)}`,
    );
  },

  /**
   * UGC numbers are three digits, zero padded. Anything wider is out of spec but is rendered
   * verbatim rather than truncated.
   */
  ugcDigits(number) {
    return String(number).padStart(3, '0');
  },

  /**
   * Whether this run covers a UGC code (`"TXZ192"`, `"TXC453"`), read against `index.json`
   * `states`. False for a malformed code and for one whose state the bundle does not know: an
   * old bundle loses the *match*, and a caller must not read that as "not covered".
   */
  covers(areaRun, { ugc, states }) {
    const key = MeshWXAreaRun.key({ forUGC: ugc, states });
    if (key == null) return false;
    if (key.state !== areaRun.state || key.county !== areaRun.county) return false;
    return key.number >= areaRun.start && key.number < areaRun.start + areaRun.run;
  },

  /**
   * Split a UGC code into the fields a run carries, or null when it is malformed or its state
   * is not in `index.json` `states`.
   */
  key({ forUGC, states }) {
    const code = String(forUGC).trim().toUpperCase();
    if (code.length !== 6) return null;
    const kind = code[2];
    if (kind !== 'C' && kind !== 'Z') return null;
    if (!/^[0-9]{3}$/.test(code.slice(3))) return null;
    // Only bits 6-0 carry the state, so an index past 127 has no run to match.
    const index = states.indexOf(code.slice(0, 2));
    if (index < 0 || index > 127) return null;
    return { state: index, county: kind === 'C', number: Number(code.slice(3)) };
  },

  /**
   * Turn NWS UGC codes into runs — the reference's `areas_from_ugcs`.
   *
   * Codes whose state is not in `states` are skipped (the bundle is append-only, so an unknown
   * state means an old bundle, not a bad product). Duplicates collapse, the result is sorted by
   * `(state, kind, number)`, and consecutive numbers merge into runs of at most 255.
   */
  runs({ fromUGCs, states }) {
    // The wire spends only bits 6-0 on the state, so an index past 127 has no encoding; the
    // table is append-only and 78 long, so this is a guard, not a case.
    const index = new Map();
    states.forEach((code, position) => {
      if (position <= 127 && !index.has(code)) index.set(code, position);
    });

    const seen = new Map();
    for (const raw of fromUGCs) {
      const ugc = String(raw).trim().toUpperCase();
      if (ugc.length !== 6) continue;
      const kind = ugc[2];
      if (kind !== 'C' && kind !== 'Z') continue;
      if (!/^[0-9]+$/.test(ugc.slice(3))) continue;
      const number = Number(ugc.slice(3));
      if (!Number.isFinite(number) || number > 0xffff) continue;
      const state = index.get(ugc.slice(0, 2));
      if (state == null) continue;
      const county = kind === 'C';
      seen.set(`${state}.${county ? 1 : 0}.${number}`, { state, county, number });
    }

    // Python's tuple ordering, where False sorts before True.
    const sorted = [...seen.values()].sort((left, right) => {
      if (left.state !== right.state) return left.state - right.state;
      const leftKind = left.county ? 1 : 0;
      const rightKind = right.county ? 1 : 0;
      if (leftKind !== rightKind) return leftKind - rightKind;
      return left.number - right.number;
    });

    const out = [];
    for (const key of sorted) {
      const last = out[out.length - 1];
      if (
        last != null
        && last.state === key.state
        && last.county === key.county
        && last.start + last.run === key.number
        && last.run < 255
      ) {
        last.run += 1;
        continue;
      }
      out.push({ state: key.state, county: key.county, start: key.number, run: 1 });
    }
    return out;
  },
});

/** A watch, warning or advisory (type 1, spec §3). */
export const MeshWXWarning = Object.freeze({
  make({
    identity,
    expiresMinutes,
    tornado = 0,
    floodSource = 0,
    floodDamage = 0,
    hailQuarterInches = 0,
    windMph = 0,
    isUpdate = false,
    polygon = null,
    areas = null,
    issuedMinutes = null,
    beginsMinutes = null,
    source = 0,
    seq = 0,
    bot = 0,
    flags = null,
  }) {
    const nibble = flags ?? (
      (isUpdate ? MeshWXWire.flagWarningUpdate : 0)
      | (issuedMinutes == null ? 0 : MeshWXWire.flagWarningIssued)
      | ((source & 0x3) << MeshWXWire.flagDataSourceShift)
    );
    return {
      seq,
      bot,
      type: 1,
      name: 'warning',
      flags: nibble,
      event: identity.event,
      office: identity.office,
      etn: identity.etn,
      expires_min: expiresMinutes,
      tornado,
      flood_source: floodSource,
      flood_damage: floodDamage,
      hail_qin: hailQuarterInches,
      wind_mph: windMph,
      update: isUpdate,
      source,
      polygon,
      areas,
      issued_min: issuedMinutes,
      begins_min: beginsMinutes,
    };
  },

  /**
   * Minutes between the NWS product's own issuance and `expires_min`, exactly as the wire
   * carries it (spec §3, revision 5); null when the message carried no issue time.
   *
   * The vector JSON resolves the two bytes to an absolute time, so this subtracts them back.
   * The wire value is what keeps the saturation readable — 65535 means "45.5 days or more",
   * which an absolute time alone cannot say.
   */
  issuedBeforeMinutes(warning) {
    if (warning.issued_min == null) return null;
    return (warning.expires_min - warning.issued_min) & 0xffff;
  },

  /**
   * When NWS issued the product, in Unix minutes: `expires − issued_before` (spec §3). Null
   * when the warning carries no issue time — a bot older than revision 5.
   *
   * This is the product's own header time, kept across continuations, so an SVS update does not
   * restamp a warning as newly issued. It is never when the bot read the file and never when
   * the phone heard the packet (spec §18.1): a radio out of range for three hours must still
   * say *issued 1:29 PM*.
   */
  issuedMinutes(warning) {
    return warning.issued_min ?? null;
  },

  /**
   * The gap ran past the u16 and saturated (spec §3), so `issuedMinutes` is a ceiling: the
   * product was issued 45.5 days before its expiry *or more*.
   */
  isIssueTimeSaturated(warning) {
    return MeshWXWarning.issuedBeforeMinutes(warning) === MeshWXWire.issuedBeforeSaturatedMinutes;
  },

  /**
   * Minutes between the moment the product takes effect and `expires_min`, exactly as the wire
   * carries it (spec §3, revision 12); null when the message carried no start, or one that was
   * not strictly between the issuance and the expiry — the decoder drops those, so an invalid
   * value never reaches anything that shows it.
   *
   * The twin of `issuedBeforeMinutes`: the vector JSON resolves the two bytes to an absolute
   * time, so this subtracts them back.
   */
  beginsBeforeMinutes(warning) {
    if (warning.begins_min == null) return null;
    return (warning.expires_min - warning.begins_min) & 0xffff;
  },

  /**
   * When the product takes effect, in Unix minutes: `expires − begins_before` (spec §3,
   * revision 12). Null when it is in effect from issuance, which is also what every bot before
   * revision 12 says.
   *
   * A watch issued on Tuesday morning for Wednesday evening is in the air two days before it is
   * in effect; without this the phone can only show it as in effect now.
   */
  beginsMinutes(warning) {
    return warning.begins_min ?? null;
  },

  /**
   * Hail tag in inches, or null when there is no tag. The *number* is returned, not a string,
   * because the unit and the decimal separator are the app's to localise.
   */
  hailInches(warning) {
    return warning.hail_qin === 0 ? null : warning.hail_qin / 4;
  },

  /**
   * The polygon as `MeshWXCoordinate`s, the shape `MeshWXGeometry` speaks. Null when the
   * product carried none. (An addition: the decoded `polygon` is `[[lat, lon], …]` per
   * PORTING §5, while the geometry module works in `{ latitude, longitude }`.)
   */
  polygonCoordinates(warning) {
    if (warning.polygon == null) return null;
    return warning.polygon.map(([latitude, longitude]) => ({ latitude, longitude }));
  },
});

// MARK: - Cancel

/**
 * Why a warning ended early (spec §4, the cancel flags nibble).
 *
 * **The one type whose flags nibble is not shared.** Since revision 7 bits 3-2 of every other
 * type's nibble carry `MeshWXDataSource`; a Cancel spends the *whole* nibble on this reason, so
 * reason 12 is 12 and never "mixed". `MeshWXHeader.dataSource()` returns `unstated` for a
 * Cancel for that reason, and a Cancel's nibble is decoded and re-encoded exactly as it was
 * before revision 7.
 */
export const MeshWXCancelReason = Object.freeze({
  cancelled: 0,
  expiredEarly: 1,
  /** A replacement warning follows; do not tell the user the weather improved. */
  upgraded: 2,

  make({ rawValue }) {
    return rawValue & 0x0f;
  },
});

/** A warning ended before its stored expiry (type 2, spec §4). Remove the identity. */
export const MeshWXCancel = Object.freeze({
  make({ identity, reason = 0, seq = 0, bot = 0 }) {
    return {
      seq,
      bot,
      type: 2,
      name: 'cancel',
      flags: reason & 0x0f,
      event: identity.event,
      office: identity.office,
      etn: identity.etn,
      reason: reason & 0x0f,
    };
  },
});

// MARK: - Digest

/**
 * Everything active in the bot's coverage (type 3, spec §5).
 *
 * This is the recovery mechanism: an identity here that the app does not hold is one `>w` away,
 * and an identity the app holds that is *absent* has ended.
 */
export const MeshWXDigest = Object.freeze({
  Entry: Object.freeze({
    make({ identity, expiresRelativeMinutes, expiresMinutes }) {
      return {
        event: identity.event,
        office: identity.office,
        etn: identity.etn,
        expires_rel: expiresRelativeMinutes,
        expires_min: expiresMinutes,
      };
    },
  }),

  make({ nowMinutes, feedHealth, entries, source = 0, seq = 0, bot = 0 }) {
    return {
      seq,
      bot,
      type: 3,
      name: 'digest',
      flags: (source & 0x3) << MeshWXWire.flagDataSourceShift,
      now_min: nowMinutes,
      feed_health: feedHealth,
      entries,
      source,
    };
  },
});

// MARK: - Observations

/** One METAR station's current conditions (spec §6, 21 bytes on the wire). */
export const MeshWXStationObservation = Object.freeze({
  make({
    station,
    temp_f = null,
    dewpoint_f = null,
    wind_dir_deg = 0,
    sky = MeshWXSky.other,
    wind_mph = null,
    gust_mph = 0,
    visibility_mi = null,
    pressure_inhg = null,
    humidity_pct = null,
    feels_delta_f = 0,
    age_min = null,
  }) {
    const nibble = MeshWXCompass.fromDegrees(wind_dir_deg);
    return {
      station,
      temp_f,
      dewpoint_f,
      wind_dir_deg: MeshWXCompass.degrees(nibble),
      wind_dir: MeshWXCompass.abbreviation(nibble),
      sky,
      wind_mph,
      gust_mph,
      visibility_mi,
      pressure_inhg,
      humidity_pct,
      feels_delta_f,
      age_min,
    };
  },

  /** Apparent temperature, or null when the temperature itself is unknown. */
  feelsLikeF(station) {
    return station.temp_f == null ? null : station.temp_f + station.feels_delta_f;
  },

  /**
   * The age nibble saturated (spec §6.1): this report is 150 minutes old *or more*. The bot
   * admits stations up to 120 minutes old, so a saturated station is one whose report aged
   * further while the batch waited.
   */
  isAgeSaturated(station) {
    return station.age_min === MeshWXWire.observationAgeSaturatedMinutes;
  },
});

/** A batch of current conditions (type 4, spec §6). */
export const MeshWXObservations = Object.freeze({
  make({ timestampMinutes, stations, source = 0, seq = 0, bot = 0 }) {
    const hasAges = stations.length > 0 && stations.every((entry) => entry.age_min != null);
    return {
      seq,
      bot,
      type: 4,
      name: 'observations',
      flags: (hasAges ? MeshWXWire.flagObservationAges : 0)
        | ((source & 0x3) << MeshWXWire.flagDataSourceShift),
      ts_min: timestampMinutes,
      stations,
      source,
    };
  },

  /**
   * Whether this batch carries per-station ages. All or nothing (spec §6.1): the flag means
   * every station in the batch has one.
   */
  carriesAges(observations) {
    return observations.stations.length > 0
      && observations.stations.every((station) => station.age_min != null);
  },

  /**
   * One station's own report time, in Unix minutes: the batch `ts` less its age (spec §6.1).
   *
   * The batch time itself for a batch without ages, which is all such a batch says — and what
   * an app had to show under every reading before revision 5, wrong about most of them.
   */
  reportMinutes(observations, { for: station }) {
    return observations.ts_min - (station.age_min ?? 0);
  },
});

// MARK: - Forecast

/** One forecast period (spec §7, 5 bytes on the wire). */
export const MeshWXForecastPeriod = Object.freeze({
  make({
    high_f = null,
    low_f = null,
    pop_pct = null,
    sky = MeshWXSky.other,
    thunder = false,
    wintry = false,
    windy = false,
    fog = false,
    wind_dir_deg = 0,
    wind_mph = 0,
  }) {
    const nibble = MeshWXCompass.fromDegrees(wind_dir_deg);
    return {
      high_f,
      low_f,
      pop_pct,
      sky,
      thunder,
      wintry,
      windy,
      fog,
      wind_dir_deg: MeshWXCompass.degrees(nibble),
      wind_dir: MeshWXCompass.abbreviation(nibble),
      wind_mph,
    };
  },
});

/** A point forecast (type 5, spec §7). */
export const MeshWXForecast = Object.freeze({
  make({ pointIndex, issuedMinutes, firstPeriod, periods, source = 0, seq = 0, bot = 0 }) {
    return {
      seq,
      bot,
      type: 5,
      name: 'forecast',
      flags: (source & 0x3) << MeshWXWire.flagDataSourceShift,
      point: pointIndex,
      issued_min: issuedMinutes,
      first_period: firstPeriod,
      periods,
      source,
    };
  },

  /** True when the bot could not name a bundled point for the request. */
  isUnbundledPoint(forecast) {
    return forecast.point === MeshWXWire.unbundledPoint;
  },
});

// MARK: - Text

/**
 * What a text reply is about (spec §8).
 *
 * These are the v5 subjects from `protocol.json` `v5.text_subjects`, which are *not* the legacy
 * top-level `text_subjects` in the same file (that table is v3/v4 and its numbering differs).
 */
export const MeshWXTextSubject = Object.freeze({
  warningNarrative: 0,
  forecastDiscussion: 1,
  spaceWeather: 2,
  stormReports: 3,
  rainfall: 4,
  metarOrTAF: 5,
  hazardousOutlook: 6,
  nowcast: 7,
  general: 8,

  make({ rawValue }) {
    return rawValue & 0xff;
  },
});

/**
 * One chunk of a narrative reply (type 6, spec §8).
 *
 * Reassemble by `(bot, group)` in `idx` order. A chunk that never arrives leaves a hole: show
 * the partial text with a marker rather than nothing, because a warning narrative with one
 * paragraph missing is still worth reading.
 */
export const MeshWXText = Object.freeze({
  make({ subject, group, index, total, text, wasCut = false, source = 0, seq = 0, bot = 0 }) {
    return {
      seq,
      bot,
      type: 6,
      name: 'text',
      flags: (wasCut ? MeshWXWire.flagTextCut : 0)
        | ((source & 0x3) << MeshWXWire.flagDataSourceShift),
      subject,
      group,
      idx: index,
      total,
      text,
      cut: wasCut,
      source,
    };
  },
});

// MARK: - Not available

/** Why the bot could not serve a request (spec §9). */
export const MeshWXNotAvailableReason = Object.freeze({
  noData: 0,
  unknownLocation: 1,
  unsupported: 2,
  botError: 3,
  /** Try later; do not retry immediately or the next request is refused too. */
  rateLimited: 4,

  make({ rawValue }) {
    return rawValue & 0xff;
  },
});

/** The bot declining a request (type 7, spec §9). */
export const MeshWXNotAvailable = Object.freeze({
  make({ requestCode, reason, seq = 0, bot = 0 }) {
    return {
      seq,
      bot,
      type: 7,
      name: 'not_available',
      flags: 0,
      request: String.fromCharCode(requestCode),
      request_code: requestCode,
      reason,
    };
  },

  /** The request's first letter. */
  requestLetter(notAvailable) {
    return String.fromCharCode(notAvailable.request_code);
  },
});

// MARK: - Coverage

/**
 * What a bot carries, stated by the bot (type 8, spec §10).
 *
 * The only thing an app may read a bot's area from. Inferring it from the stations in the hourly
 * batches and from the offices of whatever warnings happened to be active told a real phone that
 * WX-AUS "may not carry alerts for Travis County" — the bot's own home county — because the one
 * warning active that minute came from a neighbouring office. The stations are recomputed every
 * hour and warnings come and go; neither describes coverage. This does.
 *
 * Read a cut list as incomplete, **never** as a denial: with `zones_cut` or `offices_cut` set,
 * an absence means "not listed", and nothing may be called outside the area on the strength of
 * it. With both clear the lists are the whole area, which is what lets an app say a place is
 * outside at all.
 */
export const MeshWXCoverage = Object.freeze({
  make({
    latitude,
    longitude,
    radiusKilometres,
    stationCap,
    officeIndices,
    areas,
    areasCut = false,
    officesCut = false,
    seq = 0,
    bot = 0,
  }) {
    return {
      seq,
      bot,
      type: 8,
      name: 'coverage',
      flags: (areasCut ? MeshWXWire.flagCoverageZonesCut : 0)
        | (officesCut ? MeshWXWire.flagCoverageOfficesCut : 0),
      lat: latitude,
      lon: longitude,
      radius_km: radiusKilometres,
      stations: stationCap,
      offices: officeIndices,
      areas,
      zones_cut: areasCut,
      offices_cut: officesCut,
    };
  },

  /**
   * The centre of the coverage circle, or null when the bot stated none: its area came from
   * states or offices rather than a circle, and 0,0 is the non-position an advert carries
   * (spec §1), not the Gulf of Guinea.
   */
  centre(coverage) {
    return coverage.lat === 0 && coverage.lon === 0 && coverage.radius_km === 0
      ? null
      : { latitude: coverage.lat, longitude: coverage.lon };
  },

  /**
   * Whether the stated circle contains a point.
   *
   * False when no circle was stated — which is not "outside": a bot without a centre still
   * covers whatever its runs list, so callers must go on to `covers()`.
   */
  circleContains(coverage, point) {
    const centre = MeshWXCoverage.centre(coverage);
    if (centre == null || !(coverage.radius_km > 0)) return false;
    const distance = MeshWXGeo.distanceKilometres({
      fromLat: centre.latitude,
      fromLon: centre.longitude,
      toLat: point.latitude,
      toLon: point.longitude,
    });
    return distance <= coverage.radius_km;
  },

  /** Whether a stated run covers a UGC code. */
  covers(coverage, { ugc, states }) {
    return coverage.areas.some((run) => MeshWXAreaRun.covers(run, { ugc, states }));
  },

  /**
   * `n` = 0 and `k` = 0 with neither list cut: the operator set no area filter at all, so the
   * bot carries every product its feed does and no place is outside it (spec §10). That is an
   * answer, not an empty message.
   */
  hasNoAreaFilter(coverage) {
    return coverage.offices.length === 0
      && coverage.areas.length === 0
      && MeshWXCoverage.isComplete(coverage);
  },

  /** Whether both lists are whole. Only a complete statement can put a place outside the area. */
  isComplete(coverage) {
    return !coverage.zones_cut && !coverage.offices_cut;
  },
});

// MARK: - Request

/**
 * An app's `>` request, flooded on `#meshwx` as a datagram (type 9, spec §11).
 *
 * The one v5 message this app transmits. A DM rides one stored route hop by hop and fails
 * silently once that route has gone stale — the field record of 16 September lost seven requests
 * in six minutes to a bot that was on the air and answering everyone else — while a flood needs
 * no route and costs about what a DM costs by its second try.
 */
export const MeshWXRequest = Object.freeze({
  /** Every bot on the channel, for an app that has not chosen one (spec §11, §20). */
  anyBot: 0xffff,

  make({ seq, botID, senderPrefix, timestamp, text }) {
    return {
      seq,
      bot: botID,
      type: 9,
      name: 'request',
      flags: 0,
      sender: typeof senderPrefix === 'string'
        ? senderPrefix.toLowerCase()
        : [...senderPrefix].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      ts: timestamp,
      text,
    };
  },

  /** True when the request names every bot on the channel rather than one. */
  isForAnyBot(request) {
    return request.bot === MeshWXRequest.anyBot;
  },

  /** The datagram's bytes, header and all — `MeshWXEncoder.request` under the Swift name. */
  encode(request) {
    return encodeRequest({
      seq: request.seq,
      bot: request.bot,
      senderPrefix: request.sender,
      timestamp: request.ts,
      text: request.text,
    });
  },
});

// MARK: - Area sweep

/**
 * One packet of a national area sweep (type 10, spec §12).
 *
 * The sweep is the answer to one question — *where in the country is anything happening?* — and
 * it is the most expensive answer on the channel: up to eight packets, broadcast to everyone
 * listening. Nothing may ask for one on a timer, on appear or on a pull; only a tap.
 *
 * Reassemble by `(bot, group)` in `idx` order exactly as a Text reply is (spec §8). A packet
 * that never arrives leaves a hole: draw the entries that did arrive and say the sweep is
 * partial, because a map of forty states is still worth looking at.
 */
export const MeshWXAreaSweep = Object.freeze({
  /**
   * One run of consecutive UGC numbers in one state, under one event (spec §12).
   *
   * Four bytes for what a Warning spends four bytes on *without* the event, which is the whole
   * point: the country's alerts fit in eight packets because a Winter Weather Advisory over
   * thirty Montana zones is one entry.
   */
  Entry: Object.freeze({
    make({ event, state, county = false, start, run }) {
      return { event, state, county, start, run };
    },

    /** The UGC numbers this entry covers. */
    numbers(entry) {
      return MeshWXAreaRun.numbers(entry);
    },

    /**
     * Expand to UGC strings (`"TXZ192"`, `"TXC453"`) using `index.json` `states`.
     *
     * Empty when the state index is not in the table: an older bundle decoding a newer bot's
     * sweep should lose the *names*, never the message. A run never crosses a state, so every
     * code here carries the same two letters.
     */
    ugcCodes(entry, { states }) {
      return MeshWXAreaRun.ugcCodes(entry, { states });
    },

    /**
     * The same run as a Warning carries it, for anything that already speaks that shape
     * (`MeshWXTables.namedAreas()`, `MeshWXAreaRun.covers()`).
     */
    areaRun(entry) {
      return { state: entry.state, county: entry.county, start: entry.start, run: entry.run };
    },
  }),

  make({
    builtMinutes,
    group,
    index,
    total,
    wasCut = false,
    includesAdvisories = false,
    isScoped = false,
    scope = [],
    entries,
    source = 0,
    seq = 0,
    bot = 0,
  }) {
    return {
      seq,
      bot,
      type: 10,
      name: 'area_sweep',
      flags: (wasCut ? MeshWXWire.flagSweepCut : 0)
        | (includesAdvisories ? MeshWXWire.flagSweepAdvisories : 0)
        | ((source & 0x3) << MeshWXWire.flagDataSourceShift),
      built_min: builtMinutes,
      group,
      idx: index,
      // `total` is the count alone: the scoped bit lives beside it on the wire, and the decoder
      // splits them, so nothing above the codec ever masks a byte to read a packet count.
      total,
      entries,
      cut: wasCut,
      advisories: includesAdvisories,
      scoped: isScoped,
      scope,
      source,
    };
  },

  /**
   * The state indices a scoped sweep's packet 0 names (spec §12, revision 10), or an empty list.
   *
   * A state named here with no alert entries has nothing active at that level: that is an answer,
   * and the reason the scope is on the wire at all. A packet past 0 carries no scope entries, so
   * this says nothing about a sweep whose packet 0 never arrived — `scoped` does.
   */
  scope(sweep) {
    return sweep.scope ?? [];
  },

  /** Whether this packet says its sweep covers only the states its scope names, not the country. */
  isScoped(sweep) {
    return sweep.scoped === true;
  },
});
