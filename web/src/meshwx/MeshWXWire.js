// Port of MC1Services/Sources/MeshWX/MeshWXWire.swift
//
// Transport constants and limits of the MeshWX v5 wire format (spec §2).
//
// Every v5 message is the `data` field of one MeshCore `GRP_DATA` packet on the
// `#meshwx` channel. The app never sees the encrypted frame around it: the companion
// radio hands up `(data_type, data)` and anything whose `data_type` is not
// `MeshWXWire.dataType` is not ours.
//
// The numbers here are not style preferences — they are the reason a message fits in
// one LoRa packet. A 165-byte datagram is already ~600 ms of airtime at SF7, and the
// bot repeats a packet it did not hear echoed, so an encoder that quietly overruns a
// limit costs the whole channel, not just the sender.

/** Transport constants and limits (spec §2). */
export const MeshWXWire = Object.freeze({
  /** MeshCore `data_type` carrying a v5 message (development range, spec §2.1). */
  dataType: 0xff10,

  /** Largest `data` payload the transport accepts, in bytes. */
  maxData: 165,

  /**
   * Largest `data` payload a bot sends since 1 October 2026 (spec §2). A bot confirms a send by
   * hearing a repeater's copy, and the companion firmware reports a heard packet only up to 169 raw
   * bytes: 157 bytes of data echo as 167, 158 to 165 as 183. Decoders still take `maxData`, which
   * older bots filled.
   */
  maxSend: 157,

  /** Size of the common header (spec §2.2). */
  headerSize: 4,

  // MARK: Per-message fixed sizes
  //
  // The decoder needs these before it knows how long the variable part is, so they are
  // named rather than inlined as magic offsets.

  warningFixedSize: 15,
  /** The issue time a revision 5 warning appends after the polygon and the areas (spec §3). */
  warningIssuedSize: 2,
  /**
   * The start a revision 12 warning appends after the issue time (spec §3). There is no flag for
   * it — the nibble is full — so it is found by length: present when this many bytes remain.
   */
  warningBeginsSize: 2,
  cancelSize: 8,
  digestFixedSize: 10,
  digestEntrySize: 6,
  observationsFixedSize: 9,
  observationStationSize: 11,
  forecastFixedSize: 12,
  forecastPeriodSize: 5,
  textFixedSize: 8,
  notAvailableSize: 6,
  /**
   * Header, centre, radius, station cap and the office count, before the offices themselves
   * and the counted run list (spec §10).
   */
  coverageFixedSize: 14,
  /** Header, the sender's key prefix and the request's own time, before the text (spec §11). */
  requestFixedSize: 14,
  /** Header, the build time, and the three assembly bytes, before the entries (spec §12). */
  areaSweepFixedSize: 11,
  areaSweepEntrySize: 4,

  // MARK: Counts and limits (spec §3, §5, §6, §7, §8)

  /**
   * Text bytes one chunk can carry: the packet budget minus the 8-byte text header. A bot since
   * 1 October 2026 sends at most `maxSend - 8`, 149.
   */
  maxTextBytes: 157,
  /** Chunks one reply may be split into. */
  maxTextChunks: 8,
  minPolygonVertices: 3,
  maxPolygonVertices: 30,
  maxAreaRuns: 30,
  maxDigestEntries: 25,
  /**
   * A Digest this long may have been cut (spec §5): it lists the warnings that expire soonest, so
   * a warning expiring at or after its last entry may simply not have fitted. A bot before
   * 1 October 2026 cut at `maxDigestEntries`; one under the 157-byte `maxSend` holds 24
   * (`10 + 6 × 24` is 154). A whole list of 24 read as maybe cut only keeps an ended warning until
   * it expires or the next digest, which is the safe side.
   */
  digestMayBeCutAt: 24,
  /** Stations one Observations batch may carry: 14 from a bot before 1 October 2026, 13 since. */
  maxStations: 14,
  /**
   * Stations one batch may carry when it also carries the per-station ages (spec §6.1). A full
   * batch is already 163 bytes and the nibbles cost `ceil(n / 2)` more, so 14 with ages is 170
   * and does not fit: the bot drops the farthest station — the list is nearest first — and never
   * the ages, because a batch honest about some stations and silent about the rest is worse than
   * one that says nothing. Not enforced separately; the packet budget is what refuses the 14th.
   */
  maxStationsWithAges: 13, // 12 from a bot since 1 October 2026
  maxPeriods: 14,
  /**
   * Offices one Coverage message may list (spec §10). 24 offices and 30 runs together are 159
   * bytes, so a full list of either never costs the other one; past it the bot cuts and says so.
   * A bot since 1 October 2026 lists at most 22, to stay inside `maxSend`.
   */
  maxCoverageOffices: 24,
  /**
   * Bytes of the sender's public key a Request carries: the same six-byte prefix a DM
   * identifies the phone by, so one phone's DM and its datagram are one sender (spec §11).
   */
  requestSenderPrefixSize: 6,
  /**
   * UTF-8 bytes a Request's text may take (spec §11). Well under the packet budget: the whole
   * §14 grammar fits, and a request is not the place to spend airtime.
   */
  maxRequestTextBytes: 40,
  /**
   * Entries one Area sweep packet carries (spec §12): `(165 − 11) / 4` is 38, and the packet
   * budget is what the cap is made of. What a decoder reads; see `areaSweepEntriesSent`.
   */
  maxAreaSweepEntries: 38,
  /**
   * Entries a bot puts in one sweep packet since 1 October 2026: `(157 − 11) / 4` is 36. What the
   * cost of the next sweep is counted in.
   */
  areaSweepEntriesSent: 36,
  /**
   * Packets one sweep may be split into (spec §12), the same ceiling a Text reply has. Eight
   * packets is the whole country's worth of airtime, which is why the screen never asks by itself.
   */
  maxAreaSweepPackets: 8,
  /**
   * Consecutive UGC numbers one sweep entry may cover: the run field is six bits, carried less
   * one, so 1 to 64.
   */
  maxAreaSweepRun: 64,
  /** The largest UGC number a sweep entry may start at: the start field is ten bits. */
  maxAreaSweepStart: 0x03ff,

  // MARK: Sentinels (spec §6, §7)
  //
  // Every optional field on the wire spends its whole range except one value; there is
  // no separate presence bitmap. Decoders must map the sentinel back to null or a
  // reading of "−128 °F in Austin" ships to the user.

  /** Observation temperature/dewpoint: unknown. */
  temperatureUnknown: -128,
  /**
   * Forecast high/low: not given for this entry — half of a whole day missing at the edge of the
   * forecast window (spec §7, revision 3), not a night; a revision 1 day/night period carried one.
   */
  forecastTemperatureNotGiven: 127,
  /** Wind speed, visibility, pressure, humidity: unknown. */
  unsignedUnknown: 255,
  /** Forecast point index: the bot resolved a place that has no bundled point. */
  unbundledPoint: 0xffff,

  // MARK: Revision 5 times (spec §3, §6.1)
  //
  // Both are trailing blocks announced by a flags-nibble bit, so a decoder written before
  // revision 5 stops after the field it knows and reads the same message it always did.

  /** One age nibble step, in minutes. */
  observationAgeStepMinutes: 10,
  /**
   * The largest age a nibble carries: 15 steps. It is a saturation, not a reading — 150 means
   * "150 minutes or more" — so a station at this value is reported as at least that old.
   */
  observationAgeSaturatedMinutes: 150,
  /**
   * The largest issue-to-expiry gap the u16 carries (45.5 days). Saturated rather than wrapped:
   * at this value the product was issued *at or before* `expires − 65535`.
   */
  issuedBeforeSaturatedMinutes: 0xffff,
  /**
   * The largest start-to-expiry gap the u16 carries (revision 12), saturated as the issue time's
   * is. A start is only a start when it is strictly between the issuance and the expiry
   * (`0 < begins_before < issued_before`), so a saturated value never passes the decoder.
   */
  beginsBeforeSaturatedMinutes: 0xffff,

  // MARK: Warning tag byte (spec §3)

  tagPolygon: 0x02,
  tagAreas: 0x01,

  /** Warning flags nibble, bit 0: this identity was already sent. */
  flagWarningUpdate: 0x1,
  /**
   * Warning flags nibble, bit 1: the issue time follows the polygon and the area list (spec §3,
   * revision 5). In the flags nibble rather than in the tag byte because that byte has no spare
   * bit: 7-6 tornado, 5-4 flood source, 3-2 flood damage, 1 polygon, 0 areas.
   */
  flagWarningIssued: 0x2,

  // MARK: Observations flags nibble (spec §6.1)

  /** Bit 0: the per-station ages follow the station records. */
  flagObservationAges: 0x1,

  // MARK: Coverage flags nibble (spec §10)
  //
  // Both mean "this list is incomplete", never "this place is not covered". They are the reason
  // the message can be read as a denial at all: with them clear the lists are the whole area.

  /** Bit 0: the zone runs were cut. */
  flagCoverageZonesCut: 0x1,
  /** Bit 1: the office list was cut. */
  flagCoverageOfficesCut: 0x2,

  // MARK: Text flags nibble (spec §8)

  /**
   * Bit 0: the product was longer than `maxTextChunks` chunks of `maxTextBytes` and the bot
   * dropped the tail (spec §8, revision 7). The bot sets it on *every* chunk of a cut reply,
   * not only the last: a phone missing the last chunk would otherwise be the one phone that
   * cannot tell a reply with a hole in it from one that ends early on purpose.
   */
  flagTextCut: 0x1,

  // MARK: Data source (spec §2.2, revision 7)
  //
  // Bits 3-2 of the flags nibble, on every type that carries weather. The one exception is a
  // Cancel, whose *whole* nibble is a reason code (`MeshWXCancelReason`): bits 3-2 there are
  // part of the reason and say nothing about where anything came from.

  /** Flags bits 3-2: where the weather in the message came from (`MeshWXDataSource`). */
  flagDataSourceMask: 0x0c,
  /** How far down in the nibble `flagDataSourceMask` sits. */
  flagDataSourceShift: 2,

  /** Area run state byte, bit 7: the run numbers counties, not forecast zones. */
  areaCountyBit: 0x80,

  // MARK: Area sweep entry (spec §12)
  //
  // A sweep entry is a Warning's area run squeezed from four bytes of state-plus-u16-plus-run
  // into four bytes that also carry the event, which is what lets one packet name 38 runs
  // instead of a warning's 30. The state and kind therefore sit the *other* way round from a
  // Warning's run byte: `state << 1 | kind`, not `kind << 7 | state`. Two layouts for the same
  // two fields is a trap worth naming rather than a constant worth sharing.

  /** Sweep entry byte 1, bit 0: the numbers are counties (`C`), not forecast zones (`Z`). */
  sweepCountyBit: 0x1,
  /** How far up byte 1 the state index sits. */
  sweepStateShift: 1,
  /** Bits 0-9 of a sweep entry's u16: the first UGC number in the run. */
  sweepStartMask: 0x03ff,
  /** Bits 10-15 of a sweep entry's u16: the run length, less one. */
  sweepRunShift: 10,

  // MARK: Area sweep flags nibble (spec §12)

  /**
   * Bit 0: entries were dropped to fit, so an area absent from the sweep may still be under
   * an alert. Never read a gap in a cut sweep as clear weather.
   */
  flagSweepCut: 0x1,
  /**
   * Bit 1: advisories are in this sweep, not only warnings and watches. Clear means the wider
   * scope was not asked for, **not** that no advisory is active anywhere.
   */
  flagSweepAdvisories: 0x2,

  // MARK: Scoped Area sweep (spec revision 10, §12)
  //
  // Revision 10 lets a sweep cover a few states instead of the country, because defaulting to
  // sending everything is what made the map cost eight packets whoever tapped it: "have a way for
  // the user to select which areas they want to request the warnings for. One, a few, or all.
  // That way we don't default to sending everything" (owner, 20 September 2026).
  //
  // The scope rides on the wire twice over, and each copy answers a different question. Bit 7 of
  // `total` says *that* the sweep is scoped, and it is set on **every** packet, so a phone that
  // lost packet 0 still knows it is not looking at the country. The scope entries in packet 0 say
  // *which* states, and a state named there with no alert entries is the answer "nothing active
  // at that level here" — which is the reason the scope is on the wire at all.

  /**
   * A sweep entry's event code 0: not an alert but a scope entry naming a state (spec §12,
   * revision 10). No event has code 0, which is what lets one entry shape carry both.
   */
  sweepScopeEvent: 0,
  /**
   * `total` byte, bit 7: this sweep covers only the states its scope entries name. Set on every
   * packet of a scoped sweep, never on a national one.
   */
  sweepScopedBit: 0x80,
  /** `total` byte, bits 0-3: the packet count, 1 to 8. The high bits are flags, not count. */
  sweepTotalMask: 0x0f,
  /**
   * States one `>wmap` may name (spec §14, revision 10). Fifteen two-letter codes run together
   * are 30 bytes, and `>wmap all ` is 10 more: exactly the 40-byte request budget.
   */
  maxSweepScopeStates: 15,
  /**
   * How long the bot keeps the transmitted bytes of a multi-packet answer for `>part`
   * (spec §12/§14, revision 10). Seconds.
   */
  partsCacheSeconds: 600,

  // MARK: Radar (spec revision 11, §13)
  //
  // A radar answer is one packet, always. Everything below is what makes that true: a fixed
  // lattice so two phones asking about the same storm ask for the same tile, two bits a cell,
  // and a quadtree that spends nothing on the dry half of the picture. When even that does not
  // fit, the bot halves the grid rather than splitting the answer — there is no `>part` for
  // radar, because half a radar picture is a picture of somewhere else.

  /** Radar flags nibble, bit 0: the grid is 16 × 16, not 32 × 32 (spec §13). */
  radarCoarseBit: 0x01,
  /**
   * Radar flags nibble, bit 1: the four `bounds` bytes follow the fixed fields. The picture
   * covers only those rows and columns; every cell outside them is **unknown**, and is level 0
   * on the wire because the wire has no fifth level. Never draw one as dry.
   */
  radarPartialBit: 0x02,
  /** Cells along one side of a tile. */
  radarGrid: 32,
  /** Cells along one side of a coarse tile: each cell the highest of the four it replaces. */
  radarCoarseGrid: 16,
  /** A tile spans `2^(zoom + 1)` degrees: 2, 4, 8, 16. */
  maxRadarZoom: 3,
  /** `product` is six bits beside the zoom in the `shape` byte. */
  maxRadarProduct: 63,
  /**
   * The Not-available letter of `>radar` (spec §13, §9). **Not** `r`: that is `>rain`, and a
   * refusal has to say which of the two it refuses. The one request whose letter is not its
   * first letter, which is why `WeatherRequest.requestLetter` has a case for it.
   */
  radarRequestLetter: 'x',
  /** Header, `taken`, `south`, `west` and `shape`, before the optional bounds and the cells. */
  radarFixedSize: 12,
  /** `row0`, `row1`, `col0`, `col1`, u8 each, inclusive, in this packet's own grid. */
  radarBoundsSize: 4,
  /** `shape` byte, bits 0-1: the zoom. Bits 2-7 are the product index. */
  radarZoomMask: 0x03,
  /** How far up the `shape` byte the product index sits. */
  radarProductShift: 2,

  // MARK: Radar loops (spec revision 13, §13.5)
  //
  // The last hour of a tile, as ordinary Radar packets: nothing new on the wire but one word in
  // the request, and the `taken` of each packet says which picture it is.

  /** The most frames a loop answer has, the newest included: an hour at 15-minute steps. */
  radarLoopMaxFrames: 5,
  /** How far back a loop reaches from its newest picture. Minutes. */
  radarLoopWindowMinutes: 60,
  /** The bot skips a picture taken less than this after the last one it picked. Minutes. */
  radarLoopMinSpacingMinutes: 10,
  /** Held pictures one `loop` request may list, as UTC `HHMM` (protocol.json `held_max`). */
  radarLoopHeldMax: 5,
});

/**
 * The eleven structured message types (spec §2.2, high nibble of the type byte), as
 * `caseName → raw number`.
 *
 * Types 12-15 are free for third-party experiments, so this is deliberately not
 * exhaustive over the nibble: a decoded header keeps the byte and receivers ignore what
 * they do not know.
 */
export const MeshWXMessageType = Object.freeze({
  warning: 1,
  cancel: 2,
  digest: 3,
  observations: 4,
  forecast: 5,
  text: 6,
  notAvailable: 7,
  /** Spec revision 4, §10: what the bot carries, stated by the bot. */
  coverage: 8,
  /**
   * Spec revision 6, §11: an app's `>` request, flooded on `#meshwx` as a datagram. The one
   * type this app *sends*; another phone's, heard on the channel, is not ours to act on.
   */
  request: 9,
  /**
   * Spec revision 9, §12: every area in the country under an alert, in one sweep of at most
   * eight packets.
   */
  areaSweep: 10,
  /**
   * Spec revision 11, §13: one tile of a radar picture, as a quadtree of 2-bit levels. The
   * number revision 2 reserved "for a future structured product". Request only — nothing
   * broadcasts radar on a schedule.
   */
  radar: 11,
});

/**
 * Wire type number → the name the reference decoder puts in `name` (spec §2.2), which is
 * snake_case and *not* the Swift case name: type 7 is `not_available`, type 10 `area_sweep`.
 */
export const MeshWXTypeNames = Object.freeze({
  1: 'warning',
  2: 'cancel',
  3: 'digest',
  4: 'observations',
  5: 'forecast',
  6: 'text',
  7: 'not_available',
  8: 'coverage',
  9: 'request',
  10: 'area_sweep',
  11: 'radar',
});

/**
 * Where the weather in a message came from (spec §2.2, revision 7: flags bits 3-2).
 *
 * A bot with a dish reads its products off the GOES satellite broadcast; a bot on a wire fetches
 * them from NOAA; a bot with both fills the gaps in a satellite product from the internet and
 * says so. The difference is worth a line on screen because the two paths fail differently: a
 * dish loses products to rain fade in exactly the weather this app is for, and an internet feed
 * is only ever as current as the bot's last successful poll.
 *
 * `unstated` is not a fourth kind of source. It is every bot older than revision 7, and every
 * message with no weather product behind it, so nothing on screen may read it as a claim.
 */
export const MeshWXDataSource = Object.freeze({
  /** Not stated: a bot older than revision 7, or a message not built from a weather product. */
  unstated: 0,
  /** Received off the GOES satellite by the bot's own dish. */
  goesSatellite: 1,
  /** Fetched from NOAA over the internet. */
  internet: 2,
  /** Built from products of both kinds. */
  mixed: 3,

  /** Every case, in raw order, for a test or a picker that iterates them. */
  allCases: Object.freeze([0, 1, 2, 3]),

  /** Never fails: the field is two bits wide and all four values are defined. */
  make({ bits }) {
    return bits & 0x3;
  },

  /** This source's place in a flags nibble, ready to be ORed into one. */
  flagBits(source) {
    return (source & 0x3) << MeshWXWire.flagDataSourceShift;
  },
});

/**
 * The decoded 4-byte common header (spec §2.2), as `{ seq, bot, type, name, flags }` — the
 * same five keys every decoded message starts with.
 *
 * `bot` is the first two bytes of the bot's public key, which is how an app keeps state per bot
 * when two of them cover the same place (spec §20). `seq` is per-bot and wraps; a gap in it is
 * the cue to ask for a digest, and a repeat of `(bot, seq)` is the bot's own "nobody repeated me"
 * retransmission and must be dropped (spec §2.4).
 */
export const MeshWXHeader = Object.freeze({
  make({ seq, bot, type, rawType, flags = 0 }) {
    const raw = (rawType ?? type ?? 0) & 0x0f;
    return {
      seq: seq & 0xff,
      bot: bot & 0xffff,
      type: raw,
      name: MeshWXTypeNames[raw] ?? 'unknown',
      flags: flags & 0x0f,
    };
  },

  /**
   * Where the weather in this message came from (spec §2.2, revision 7), read off flags bits
   * 3-2. `MeshWXDataSource.unstated` for a bot older than revision 7 and for the types that
   * carry no weather product — Not available, Coverage and Request always send 0.
   *
   * A Cancel never carries it: its whole nibble is a `MeshWXCancelReason`, so reason 12 would
   * otherwise read as "mixed". Unstated is the only honest answer for one.
   */
  dataSource(header) {
    if (header.type === MeshWXMessageType.cancel) return MeshWXDataSource.unstated;
    return (header.flags & MeshWXWire.flagDataSourceMask) >> MeshWXWire.flagDataSourceShift;
  },
});

// MARK: - Hex

/**
 * Parse a lower- or upper-case hex string into bytes. Throws on an odd length or a non-hex
 * digit, so a malformed fixture fails loudly instead of decoding garbage.
 */
export function hexToBytes(hex) {
  const text = String(hex);
  if (text.length % 2 !== 0) throw new TypeError(`hex has an odd length: ${text.length}`);
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const pair = text.slice(index * 2, index * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) throw new TypeError(`not hex: ${pair}`);
    out[index] = Number.parseInt(pair, 16);
  }
  return out;
}

/** Lower-case hex without separators, the form the vectors use. */
export function bytesToHex(bytes) {
  let out = '';
  const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
}
