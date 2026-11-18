"""MeshWX v5 wire codec — reference encoder and decoder.

This module is the reference implementation of ``docs/MeshWX_v5_Spec.md``.
It is deliberately dependency-free (standard library only, nothing from
``meshcore_weather``) so that an app developer can read it top to bottom and
port it to Swift, Kotlin or C without chasing imports.

Every v5 message is the ``data`` field of one MeshCore ``GRP_DATA`` packet on
the ``#meshwx`` channel with ``data_type = 0xFF10``.  ``data`` is at most 165
bytes and every message fits in one packet; only Text and Area sweep answers
span several, and each of their packets carries its own group, index and
total.  The encoders here build at most 157 (``MAX_SEND``); the decoders take
anything up to 165 (``MAX_DATA``), the transport's limit.

Every type but one travels bot -> app.  Request (type 9, spec 11) is the
app's `>` request flooded on the same channel: the bot decodes it and never
sends one.

Layout of the 4-byte common header::

    offset 0  u8   seq    per-bot sequence number, wraps 255 -> 0
    offset 1  u16  bot    first two bytes of the bot's public key, LE
    offset 3  u8   type   high nibble = message type, low nibble = flags

Bits 2-3 of the flags nibble are the same field in every type but Cancel:
the data source (``SOURCE_*``), where the weather in this
message came from.  Cancel spends its whole nibble on a reason code and is
the one exception.

All multi-byte integers are little-endian.  Times are Unix minutes
(``seconds // 60``) as u32.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

__all__ = [
    "DATA_TYPE",
    "MAX_DATA",
    "MAX_SEND",
    "HEADER_SIZE",
    "TYPE_WARNING",
    "TYPE_CANCEL",
    "TYPE_DIGEST",
    "TYPE_OBS",
    "TYPE_FORECAST",
    "TYPE_TEXT",
    "TYPE_NOT_AVAILABLE",
    "TYPE_COVERAGE",
    "TYPE_REQUEST",
    "TYPE_AREA_SWEEP",
    "TYPE_RADAR",
    "TYPE_NAMES",
    "SUBJECT_WARNING",
    "SUBJECT_AFD",
    "SUBJECT_SPACE",
    "SUBJECT_STORM_REPORTS",
    "SUBJECT_RAINFALL",
    "SUBJECT_METAR",
    "SUBJECT_HWO",
    "SUBJECT_NOWCAST",
    "SUBJECT_GENERAL",
    "REASON_NO_DATA",
    "REASON_UNKNOWN_LOCATION",
    "REASON_UNSUPPORTED",
    "REASON_BOT_ERROR",
    "REASON_RATE_LIMITED",
    "CANCEL_CANCELLED",
    "CANCEL_EXPIRED",
    "CANCEL_UPGRADED",
    "TAG_TORNADO_NONE",
    "TAG_TORNADO_POSSIBLE",
    "TAG_TORNADO_RADAR_INDICATED",
    "TAG_TORNADO_OBSERVED",
    "FLOOD_SOURCE_NONE",
    "FLOOD_SOURCE_RADAR",
    "FLOOD_SOURCE_RADAR_AND_GAUGE",
    "FLOOD_SOURCE_OBSERVED",
    "FLOOD_DAMAGE_NONE",
    "FLOOD_DAMAGE_CONSIDERABLE",
    "FLOOD_DAMAGE_CATASTROPHIC",
    "FLAG_WARNING_UPDATE",
    "FLAG_WARNING_ISSUED",
    "FLAG_OBS_AGES",
    "FLAG_COVERAGE_ZONES_CUT",
    "FLAG_COVERAGE_OFFICES_CUT",
    "FLAG_TEXT_CUT",
    "FLAG_SWEEP_CUT",
    "FLAG_SWEEP_ADVISORIES",
    "FLAG_RADAR_COARSE",
    "FLAG_RADAR_PARTIAL",
    "SOURCE_MASK",
    "SOURCE_SHIFT",
    "SOURCE_UNSTATED",
    "SOURCE_GOES",
    "SOURCE_INTERNET",
    "SOURCE_MIXED",
    "MAX_TEXT_BYTES",
    "MAX_TEXT_CHUNKS",
    "MAX_POLYGON_VERTICES",
    "MAX_AREA_RUNS",
    "MAX_DIGEST_ENTRIES",
    "MAX_STATIONS",
    "MAX_STATIONS_WITH_AGES",
    "MAX_ISSUED_BEFORE_EXPIRY",
    "MAX_BEGINS_BEFORE_EXPIRY",
    "OBS_AGE_STEP_MIN",
    "OBS_AGE_MAX_MIN",
    "MAX_PERIODS",
    "MAX_COVERAGE_OFFICES",
    "MAX_COVERAGE_RUNS",
    "REQUEST_SENDER_BYTES",
    "REQUEST_BOT_ANY",
    "MAX_REQUEST_TEXT",
    "MIN_REQUEST_SIZE",
    "MAX_SWEEP_PACKETS",
    "MAX_SWEEP_ENTRIES_PER_PACKET",
    "MAX_SWEEP_ENTRIES",
    "MAX_SWEEP_RUN",
    "MAX_SWEEP_START",
    "SWEEP_SCOPED_BIT",
    "SWEEP_TOTAL_MASK",
    "SWEEP_SCOPE_EVENT",
    "MAX_SWEEP_SCOPE_STATES",
    "RADAR_GRID",
    "RADAR_COARSE_GRID",
    "MAX_RADAR_ZOOM",
    "RADAR_LOOP_WINDOW_MIN",
    "RADAR_LOOP_MAX_FRAMES",
    "RADAR_LOOP_MIN_SPACING_MIN",
    "MAX_RADAR_PRODUCT",
    "RADAR_LEVELS_DBZ",
    "RADAR_REQUEST_LETTER",
    "Header",
    "Request",
    "encode_header",
    "encode_warning",
    "encode_cancel",
    "encode_digest",
    "encode_obs",
    "encode_forecast",
    "encode_coverage",
    "encode_text",
    "text_chunks",
    "encode_not_available",
    "encode_request",
    "decode_request",
    "encode_area_sweep",
    "sweep_packets",
    "encode_radar",
    "radar_tile",
    "radar_coarsen",
    "decode",
    "areas_from_ugcs",
    "wind_dir_nibble",
    "nibble_to_compass",
    "pack_source",
    "unpack_source",
]

# --------------------------------------------------------------------------
# Transport constants (spec 2)
# --------------------------------------------------------------------------

#: MeshCore ``data_type`` carrying a v5 message (development range).
DATA_TYPE = 0xFF10

#: Largest ``data`` payload the transport accepts, in bytes, and so what a
#: decoder must take.
MAX_DATA = 165

#: Largest ``data`` payload a bot sends, in bytes; every encoder here refuses
#: more.  A bot confirms delivery by hearing a repeater pass its packet on, and
#: the companion firmware pushes a heard packet to the bot only when the raw
#: packet plus 3 bytes fits its 172-byte frame (MAX_FRAME_SIZE, MyMesh.cpp).
#: With the 3-byte data type and length in front, 157 bytes encrypt to 160 and
#: a repeater's copy is 167 raw bytes, reported; 158 to 165 encrypt to 176 and
#: the copy is 183, never reported.
MAX_SEND = 157

#: Size of the common header.
HEADER_SIZE = 4

# Message types (high nibble of the type byte), spec 2.2.
TYPE_WARNING = 1
TYPE_CANCEL = 2
TYPE_DIGEST = 3
TYPE_OBS = 4
TYPE_FORECAST = 5
TYPE_TEXT = 6
TYPE_NOT_AVAILABLE = 7
TYPE_COVERAGE = 8
#: App -> bot: a `>` request flooded on #meshwx (spec 11).  It is
#: the only type an app sends; the bot never transmits one.
TYPE_REQUEST = 9
#: The national picture of active alerts, as runs of UGC numbers the phone
#: draws on its own bundled outlines (spec 12).  Request only.
TYPE_AREA_SWEEP = 10
#: Radar (spec 13): one tile of a radar picture, as a quadtree of 2-bit
#: levels.
TYPE_RADAR = 11

TYPE_NAMES = {
    TYPE_WARNING: "warning",
    TYPE_CANCEL: "cancel",
    TYPE_DIGEST: "digest",
    TYPE_OBS: "observations",
    TYPE_FORECAST: "forecast",
    TYPE_TEXT: "text",
    TYPE_NOT_AVAILABLE: "not_available",
    TYPE_COVERAGE: "coverage",
    TYPE_REQUEST: "request",
    TYPE_AREA_SWEEP: "area_sweep",
    TYPE_RADAR: "radar",
}

# Text subjects (spec 8).
SUBJECT_WARNING = 0
SUBJECT_AFD = 1
SUBJECT_SPACE = 2
SUBJECT_STORM_REPORTS = 3
SUBJECT_RAINFALL = 4
SUBJECT_METAR = 5
SUBJECT_HWO = 6
SUBJECT_NOWCAST = 7
SUBJECT_GENERAL = 8

# Not-available reasons (spec 9).
REASON_NO_DATA = 0
REASON_UNKNOWN_LOCATION = 1
REASON_UNSUPPORTED = 2
REASON_BOT_ERROR = 3
REASON_RATE_LIMITED = 4

# Cancel flags nibble (spec 4).  Distinct from the not-available reasons.
CANCEL_CANCELLED = 0
CANCEL_EXPIRED = 1
CANCEL_UPGRADED = 2

# Warning tag byte, bits 7-6 (spec 3).
TAG_TORNADO_NONE = 0
TAG_TORNADO_POSSIBLE = 1
TAG_TORNADO_RADAR_INDICATED = 2
TAG_TORNADO_OBSERVED = 3

# Warning tag byte, bits 5-4.
FLOOD_SOURCE_NONE = 0
FLOOD_SOURCE_RADAR = 1
FLOOD_SOURCE_RADAR_AND_GAUGE = 2
FLOOD_SOURCE_OBSERVED = 3

# Warning tag byte, bits 3-2.
FLOOD_DAMAGE_NONE = 0
FLOOD_DAMAGE_CONSIDERABLE = 1
FLOOD_DAMAGE_CATASTROPHIC = 2

# Warning tag byte, bits 1-0 (structural, set by the encoder).
_TAG_POLYGON = 0x02
_TAG_AREAS = 0x01

#: Warning flags nibble, bit 0: this identity was already sent.
FLAG_WARNING_UPDATE = 0x1

# Warning flags nibble, bit 1: the issue time follows the polygon and the area
# list (spec 3.4).  The bit lives in the flags nibble and not in the
# tag byte because that byte has no spare bit: 7-6 tornado, 5-4 flood source,
# 3-2 flood damage, 1 polygon, 0 areas.
FLAG_WARNING_ISSUED = 0x2

#: Observations flags nibble, bit 0: per-station ages follow the station
#: records (spec 6.1).
FLAG_OBS_AGES = 0x1

# Coverage flags nibble (spec 10).  A set bit means the list on the wire is
# shorter than what the bot really covers, so absence proves nothing.
FLAG_COVERAGE_ZONES_CUT = 0x1
FLAG_COVERAGE_OFFICES_CUT = 0x2

#: Text flags nibble, bit 0 (spec 8): the product was longer
#: than eight chunks and the tail was dropped.  It is set on *every* chunk of
#: a cut reply, so losing the last packet does not lose the fact.
FLAG_TEXT_CUT = 0x1

# Area sweep flags nibble (spec 12).
#: Bit 0: entries were dropped because the sweep did not fit in eight packets.
#: Set on *every* packet of the sweep, for the same reason the Text cut flag is.
FLAG_SWEEP_CUT = 0x1
#: Bit 1: advisories (VTEC significance Y and S) are in this sweep as well as
#: warnings and watches.  Clear means the sweep is warnings and watches only,
#: so an area absent from it may still hold an advisory.
FLAG_SWEEP_ADVISORIES = 0x2

# Radar flags nibble (spec 13).
#: Bit 0: the grid is 16 x 16, not 32 x 32, because the finer picture did not
#: fit one packet.  Each coarse cell is the highest of the four it replaces.
FLAG_RADAR_COARSE = 0x1
#: Bit 1: four `bounds` bytes follow the fixed fields.  The radar picture
#: covers only those rows and columns; every cell outside is unknown, not dry.
FLAG_RADAR_PARTIAL = 0x2

# --------------------------------------------------------------------------
# Data source (flags nibble bits 2-3, spec 2.3)
# --------------------------------------------------------------------------
#
# Where the weather data in this message came from.  The two bits are free in
# every type except Cancel (type 2), whose whole nibble is a reason code
# (spec 4) — a Cancel never carries a source and a reader must never take one
# out of it.  0 reads as "unstated": the absence of a claim, never a claim
# of absence.

#: The two bits of the flags nibble that carry the source.
SOURCE_MASK = 0x0C
#: How far to shift the source into the flags nibble.
SOURCE_SHIFT = 2

#: Not stated: no claim, or a message not built from a weather product
#: (Request, Not available, Coverage).
SOURCE_UNSTATED = 0
#: Received off the GOES satellite by the bot's own dish.
SOURCE_GOES = 1
#: Fetched from the NWS over the internet: its EMWIN feed or its web services.
SOURCE_INTERNET = 2
#: Built from products of both kinds.
SOURCE_MIXED = 3

# Counts and limits.  They are what fits in MAX_SEND, so they are what a bot
# sends; a decoder reads by each message's own counts, up to MAX_DATA.
MAX_TEXT_BYTES = MAX_SEND - 8  # 149
MAX_TEXT_CHUNKS = 8
MIN_POLYGON_VERTICES = 3
MAX_POLYGON_VERTICES = 30
MAX_AREA_RUNS = 30
# 10 + 6 x 25 = 160: the one message allowed past MAX_SEND. An app reads a
# digest of exactly 25 entries as "may have been cut" and keeps the warnings
# past its end; cut at 24, a released app would read the cut list as whole
# and drop warnings that are still active. So a full digest stays at 25 until
# the apps read 24 as full, and only CoreScope can confirm it was carried.
MAX_DIGEST_ENTRIES = 25
# 9 + 11 x 13 = 152; a 14th station would make 163.
MAX_STATIONS = 13
# The age nibbles (one per station, packed two to a byte) do not fit beside a
# full batch: 9 + 11 x 13 + 7 is 159.  Twelve stations with their ages are
# 147 (spec 6.1).
MAX_STATIONS_WITH_AGES = 12
#: One age nibble step, in minutes.
OBS_AGE_STEP_MIN = 10
#: The largest age a nibble carries: 15 steps, read as "150 minutes or more".
OBS_AGE_MAX_MIN = 15 * OBS_AGE_STEP_MIN
#: The largest issue-to-expiry gap the u16 carries (45.5 days), saturating.
MAX_ISSUED_BEFORE_EXPIRY = 0xFFFF
# The start, as minutes before `expires`; always below the issue time's value.
MAX_BEGINS_BEFORE_EXPIRY = 0xFFFF
MAX_PERIODS = 14
# Coverage: both maxima at once are 14 + 22 + 1 + 120 = 157 bytes, inside
# one packet, so a full office list never costs a zone run or the reverse.
# The offices gave up the room: a bot's runs are cut far more often.
MAX_COVERAGE_OFFICES = 22
MAX_COVERAGE_RUNS = 30
# Request (spec 11): six bytes of the sender's public key — the prefix a DM
# identifies the same phone by — then the sender's own Unix seconds, then the
# `>` text, which ends the packet.
REQUEST_SENDER_BYTES = 6
#: `bot` in a Request: every bot on the channel answers it.
REQUEST_BOT_ANY = 0xFFFF
MAX_REQUEST_TEXT = 40
#: Header + sender + ts + the one `>` byte a request cannot do without.
MIN_REQUEST_SIZE = HEADER_SIZE + REQUEST_SENDER_BYTES + 4 + 1   # 15

# Area sweep (spec 12).  Seven fixed bytes after the header, then 4-byte
# entries: 11 + 36 x 4 = 155, inside the 157-byte send limit with two to
# spare.  A decoder reads whatever whole entries a packet holds.
MAX_SWEEP_PACKETS = 8
MAX_SWEEP_ENTRIES_PER_PACKET = 36
#: The whole sweep's ceiling, 288 runs.  Past it the least severe are dropped
#: and the cut flag says so.
MAX_SWEEP_ENTRIES = MAX_SWEEP_PACKETS * MAX_SWEEP_ENTRIES_PER_PACKET
#: The longest run one entry carries: six bits hold `run - 1`.
MAX_SWEEP_RUN = 64
#: The largest UGC number one entry starts at: ten bits.
MAX_SWEEP_START = 1023

# Scoped sweeps (spec 12.3).  A sweep may cover a few states
# instead of the country, and says which in its own entries.
#: `total` bit 7: this sweep covers only the states its scope entries name.
#: It is on *every* packet, so a phone that lost packet 0 still knows it is
#: not looking at the country.
SWEEP_SCOPED_BIT = 0x80
#: What is left of `total` once the scoped bit is out of it: 1 to 8 packets.
SWEEP_TOTAL_MASK = 0x0F
#: The event code of a scope entry.  No event has code 0, which is what makes
#: the entry tellable from an alert; the rest of it reads `XXZ000`, the
#: Weather Service's own way of writing "all of state XX".
SWEEP_SCOPE_EVENT = 0
#: The most states one request may name, and so the most scope entries a
#: sweep carries: 15 codes are 30 bytes, which fits the 40-byte request text.
MAX_SWEEP_SCOPE_STATES = 15

# Radar (spec 13).
#: Cells along one side of a tile, and of a coarse one.
RADAR_GRID = 32
RADAR_COARSE_GRID = 16
#: A tile spans 2 ** (zoom + 1) degrees: 2, 4, 8, 16.
MAX_RADAR_ZOOM = 3
#: `>radar ... loop` (spec 13.5): the pictures of the last hour,
#: at least 10 minutes apart, at most five of them, the newest included.
RADAR_LOOP_WINDOW_MIN = 60
RADAR_LOOP_MAX_FRAMES = 5
RADAR_LOOP_MIN_SPACING_MIN = 10
#: `product` is six bits beside the zoom.
MAX_RADAR_PRODUCT = 63
#: Level 1 starts at the first, level 2 at the second, level 3 at the third.
RADAR_LEVELS_DBZ = (20, 35, 50)
#: The Not-available letter of `>radar`.  Not `r`: that is `>rain`, and a
#: refusal has to say which of the two it refuses.
RADAR_REQUEST_LETTER = "x"

# Sentinels.
_TEMP_UNKNOWN = -128
_U8_UNKNOWN = 255
_FORECAST_TEMP_UNKNOWN = 127
_SKY_OTHER = 15

_COMPASS = (
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
)


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Header:
    """The decoded 4-byte common header."""

    seq: int
    bot: int
    type: int
    flags: int

    def as_dict(self) -> dict:
        return {
            "seq": self.seq,
            "bot": self.bot,
            "type": self.type,
            "name": TYPE_NAMES.get(self.type, "unknown"),
            "flags": self.flags,
        }


def _check_header(seq: int, bot: int, mtype: int, flags: int) -> None:
    if not (0 <= seq <= 255):
        raise ValueError(f"seq must be 0..255, got {seq}")
    if not (0 <= bot <= 0xFFFF):
        raise ValueError(f"bot must be 0..65535, got {bot}")
    if not (0 <= mtype <= 15):
        raise ValueError(f"type must be 0..15, got {mtype}")
    if not (0 <= flags <= 15):
        raise ValueError(f"flags must be 0..15, got {flags}")


def _check_size(data: bytes, what: str, limit: int | None = None) -> bytes:
    """Every encoder ends here, so nothing it builds is over ``MAX_SEND``
    (the Digest alone passes ``MAX_DATA``; see ``MAX_DIGEST_ENTRIES``)."""
    limit = MAX_SEND if limit is None else limit
    if len(data) > limit:
        raise ValueError(
            f"{what} is {len(data)} bytes, over the {limit}-byte send limit"
        )
    return data


def _u8(value: int, name: str) -> int:
    if not (0 <= value <= 255):
        raise ValueError(f"{name} must be 0..255, got {value}")
    return value


def _u16(value: int, name: str) -> int:
    if not (0 <= value <= 0xFFFF):
        raise ValueError(f"{name} must be 0..65535, got {value}")
    return value


def _u32(value: int, name: str) -> int:
    if not (0 <= value <= 0xFFFFFFFF):
        raise ValueError(f"{name} must be 0..4294967295, got {value}")
    return value


def _pack_i24(value: int, name: str) -> bytes:
    """Three-byte little-endian two's complement."""
    if not (-(1 << 23) <= value < (1 << 23)):
        raise ValueError(f"{name} does not fit in i24: {value}")
    return (value & 0xFFFFFF).to_bytes(3, "little")


def _unpack_i24(data: bytes, off: int) -> int:
    raw = int.from_bytes(data[off:off + 3], "little")
    return raw - (1 << 24) if raw & 0x800000 else raw


def _need(data: bytes, end: int, what: str) -> None:
    if len(data) < end:
        raise ValueError(
            f"truncated {what}: need {end} bytes, have {len(data)}"
        )


def wind_dir_nibble(deg) -> int:
    """Degrees true -> 16-point compass nibble (0 N, 4 E, 8 S, 12 W).

    ``None`` means calm or unknown and maps to 0 (spec 6: "0 with speed 0 =
    calm").
    """
    if deg is None:
        return 0
    return int(round(float(deg) / 22.5)) % 16


def nibble_to_compass(n: int) -> str:
    """16-point compass nibble -> ``"N"``, ``"NNE"``, ..."""
    return _COMPASS[int(n) & 0x0F]


def pack_source(source: int, flags: int = 0) -> int:
    """Put a data source into a flags nibble, keeping the other bits.

    ``flags`` is the type's own nibble (the Warning's update bit, the Text
    cut bit, ...); the result is the nibble that goes on the wire.  Never
    call this for a Cancel: type 2 spends its whole nibble on a reason code
    (spec 4).
    """
    if not (0 <= source <= 3):
        raise ValueError(f"source must be 0..3, got {source}")
    if not (0 <= flags <= 15):
        raise ValueError(f"flags must be 0..15, got {flags}")
    return (flags & ~SOURCE_MASK & 0x0F) | (source << SOURCE_SHIFT)


def unpack_source(flags: int) -> int:
    """Read the data source back out of a flags nibble.

    A nibble from a Cancel is a reason code and this must not be applied to
    it.
    """
    return (int(flags) & SOURCE_MASK) >> SOURCE_SHIFT


def _sky(value) -> int:
    """Sky code, ``None`` -> 15 (other)."""
    if value is None:
        return _SKY_OTHER
    return _u8(int(value), "sky") & 0x0F


# --------------------------------------------------------------------------
# Header (spec 2.2)
# --------------------------------------------------------------------------


def encode_header(seq: int, bot: int, mtype: int, flags: int = 0) -> bytes:
    """Pack the 4-byte common header."""
    _check_header(seq, bot, mtype, flags)
    return struct.pack("<BHB", seq, bot, (mtype << 4) | flags)


def _decode_header(data: bytes) -> Header:
    _need(data, HEADER_SIZE, "header")
    seq, bot, tb = struct.unpack_from("<BHB", data, 0)
    return Header(seq=seq, bot=bot, type=tb >> 4, flags=tb & 0x0F)


# --------------------------------------------------------------------------
# Warning (type 1, spec 3)
# --------------------------------------------------------------------------


def encode_warning(
    seq: int,
    bot: int,
    *,
    event: int,
    office: int,
    etn: int,
    expires_min: int,
    tornado: int = 0,
    flood_source: int = 0,
    flood_damage: int = 0,
    hail_qin: int = 0,
    wind_mph: int = 0,
    polygon: "list[tuple[float, float]] | None" = None,
    areas: "list[tuple[int, bool, int, int]] | None" = None,
    update: bool = False,
    issued_min: "int | None" = None,
    begins_min: "int | None" = None,
    source: int = SOURCE_UNSTATED,
) -> bytes:
    """Encode a Warning.

    ``polygon`` is a list of ``(lat, lon)`` in degrees; the first vertex is
    absolute at 0.0001 deg and the rest are deltas at 0.001 deg.  ``areas`` is
    a list of ``(state_index, is_county, start, run)`` runs of UGC numbers.
    ``hail_qin`` is the hail tag in quarter inches (4 = 1.00 in).

    ``source`` says where the product came from (spec 2.3); it rides in
    bits 2-3 of the flags nibble.

    ``issued_min`` is when the product was issued, in Unix minutes.  It goes
    on the wire as the minutes between the issue time and ``expires_min``
    (u16, two bytes rather than four), saturating at
    ``MAX_ISSUED_BEFORE_EXPIRY``; a warning issued after its own expiry, which
    no real product is, encodes as 0 rather than failing.  The two bytes come
    after the area list.

    ``begins_min`` is when the product takes effect.  It goes on
    the wire only when there is an issue time and the start is later than it:
    two more bytes after the issue time, as minutes before ``expires_min``.
    There is no flag for it (the nibble is full), so a decoder finds it by
    length.  A product in effect from its
    issuance carries no start.
    """
    if not (0 <= tornado <= 3):
        raise ValueError(f"tornado tag must be 0..3, got {tornado}")
    if not (0 <= flood_source <= 3):
        raise ValueError(f"flood_source must be 0..3, got {flood_source}")
    if not (0 <= flood_damage <= 3):
        raise ValueError(f"flood_damage must be 0..3, got {flood_damage}")

    tags = (tornado << 6) | (flood_source << 4) | (flood_damage << 2)
    if polygon:
        tags |= _TAG_POLYGON
    if areas:
        tags |= _TAG_AREAS

    flags = FLAG_WARNING_UPDATE if update else 0
    if issued_min is not None:
        flags |= FLAG_WARNING_ISSUED
    flags = pack_source(source, flags)

    out = bytearray(encode_header(seq, bot, TYPE_WARNING, flags))
    out += struct.pack(
        "<BBHIBBB",
        _u8(event, "event"),
        _u8(office, "office"),
        _u16(etn, "etn"),
        _u32(expires_min, "expires_min"),
        tags,
        _u8(hail_qin, "hail_qin"),
        _u8(wind_mph, "wind_mph"),
    )

    if polygon:
        out += _encode_polygon(polygon)
    if areas:
        out += _encode_areas(areas)
    if issued_min is not None:
        before = _u32(expires_min, "expires_min") - _u32(issued_min, "issued_min")
        issued_before = max(0, min(MAX_ISSUED_BEFORE_EXPIRY, before))
        out += struct.pack("<H", issued_before)
        if begins_min is not None and _u32(begins_min, "begins_min") > issued_min:
            begins_before = max(0, min(MAX_BEGINS_BEFORE_EXPIRY, expires_min - begins_min))
            # Only a start strictly between the issuance and the expiry is one.
            if 0 < begins_before < issued_before:
                out += struct.pack("<H", begins_before)

    return _check_size(bytes(out), "warning")


def _encode_polygon(polygon) -> bytes:
    n = len(polygon)
    if not (MIN_POLYGON_VERTICES <= n <= MAX_POLYGON_VERTICES):
        raise ValueError(
            f"polygon needs {MIN_POLYGON_VERTICES}..{MAX_POLYGON_VERTICES} "
            f"vertices, got {n}"
        )
    lat0, lon0 = polygon[0]
    lat0_i = int(round(float(lat0) * 10000))
    lon0_i = int(round(float(lon0) * 10000))
    out = bytearray()
    out.append(n)
    out += _pack_i24(lat0_i, "polygon lat0")
    out += _pack_i24(lon0_i, "polygon lon0")

    # Deltas are taken against the *reconstructed* previous vertex so that a
    # decoder walking the chain never accumulates drift.
    prev_lat = lat0_i / 10000.0
    prev_lon = lon0_i / 10000.0
    for i, (lat, lon) in enumerate(polygon[1:], start=1):
        dlat = int(round((float(lat) - prev_lat) * 1000))
        dlon = int(round((float(lon) - prev_lon) * 1000))
        for value, axis in ((dlat, "lat"), (dlon, "lon")):
            if not (-32768 <= value <= 32767):
                raise ValueError(
                    f"polygon vertex {i} {axis} delta {value / 1000.0:+.3f} deg "
                    f"does not fit in i16 at 0.001 deg resolution "
                    f"(max +/-32.767 deg); split the polygon or re-anchor it"
                )
        out += struct.pack("<hh", dlat, dlon)
        prev_lat += dlat / 1000.0
        prev_lon += dlon / 1000.0
    return bytes(out)


def _encode_areas(
    areas, minimum: int = 1, maximum: int = MAX_AREA_RUNS
) -> bytes:
    """A counted list of UGC runs: ``k``, then 4 bytes per run (spec 3).

    Shared by the Warning's area list, which must carry at least one run when
    the tag bit says it is there, and by Coverage, where an empty list is a
    legitimate answer (spec 10).
    """
    k = len(areas)
    if not (minimum <= k <= maximum):
        raise ValueError(f"area list needs {minimum}..{maximum} runs, got {k}")
    out = bytearray()
    out.append(k)
    for state, is_county, start, run in areas:
        if not (0 <= state <= 127):
            raise ValueError(f"state index must be 0..127, got {state}")
        if not (1 <= run <= 255):
            raise ValueError(f"run length must be 1..255, got {run}")
        out += struct.pack(
            "<BHB",
            (0x80 if is_county else 0) | state,
            _u16(start, "area start"),
            run,
        )
    return bytes(out)


def _decode_warning(data: bytes, hdr: Header) -> dict:
    _need(data, 15, "warning")
    event, office, etn, expires, tags, hail, wind = struct.unpack_from(
        "<BBHIBBB", data, 4
    )
    out = hdr.as_dict()
    out.update(
        event=event,
        office=office,
        etn=etn,
        expires_min=expires,
        tornado=(tags >> 6) & 0x3,
        flood_source=(tags >> 4) & 0x3,
        flood_damage=(tags >> 2) & 0x3,
        hail_qin=hail,
        wind_mph=wind,
        update=bool(hdr.flags & FLAG_WARNING_UPDATE),
        source=unpack_source(hdr.flags),
        polygon=None,
        areas=None,
        issued_min=None,
        begins_min=None,
    )

    off = 15
    if tags & _TAG_POLYGON:
        _need(data, off + 1, "polygon count")
        n = data[off]
        off += 1
        _need(data, off + 6 + 4 * (n - 1), "polygon")
        lat = _unpack_i24(data, off) / 10000.0
        lon = _unpack_i24(data, off + 3) / 10000.0
        off += 6
        points = [[round(lat, 4), round(lon, 4)]]
        for _ in range(n - 1):
            dlat, dlon = struct.unpack_from("<hh", data, off)
            off += 4
            lat += dlat / 1000.0
            lon += dlon / 1000.0
            points.append([round(lat, 4), round(lon, 4)])
        out["polygon"] = points

    if tags & _TAG_AREAS:
        out["areas"], off = _decode_areas(data, off)

    # The issue time, as minutes before `expires`, after the variable blocks.
    if hdr.flags & FLAG_WARNING_ISSUED:
        _need(data, off + 2, "warning issue time")
        issued_before = struct.unpack_from("<H", data, off)[0]
        out["issued_min"] = expires - issued_before
        off += 2
        # The start, found by length.  Anything after it is left alone.
        if len(data) >= off + 2:
            begins_before = struct.unpack_from("<H", data, off)[0]
            if 0 < begins_before < issued_before:
                out["begins_min"] = expires - begins_before
            off += 2

    return out


def _decode_areas(data: bytes, off: int) -> "tuple[list[dict], int]":
    """Read a counted list of UGC runs, returning it and the new offset."""
    _need(data, off + 1, "area count")
    k = data[off]
    off += 1
    _need(data, off + 4 * k, "area runs")
    runs = []
    for _ in range(k):
        state, start, run = struct.unpack_from("<BHB", data, off)
        off += 4
        runs.append(
            {
                "state": state & 0x7F,
                "county": bool(state & 0x80),
                "start": start,
                "run": run,
            }
        )
    return runs, off


# --------------------------------------------------------------------------
# Cancel (type 2, spec 4)
# --------------------------------------------------------------------------


def encode_cancel(
    seq: int, bot: int, *, event: int, office: int, etn: int, reason: int = 0
) -> bytes:
    """Encode a Cancel.  ``reason`` rides in the flags nibble (spec 4:
    0 cancelled, 1 expired early, 2 upgraded).

    A Cancel takes no ``source``, and this is the one type that never will:
    the *whole* nibble is the reason code, so bits 2-3 of a Cancel are part
    of a number an app already reads (spec 4).  Reason 4 is not "cancelled,
    from the internet"; it is reason 4.
    """
    if not (0 <= reason <= 15):
        raise ValueError(f"cancel reason must be 0..15, got {reason}")
    out = encode_header(seq, bot, TYPE_CANCEL, reason) + struct.pack(
        "<BBH",
        _u8(event, "event"),
        _u8(office, "office"),
        _u16(etn, "etn"),
    )
    return _check_size(out, "cancel")


def _decode_cancel(data: bytes, hdr: Header) -> dict:
    _need(data, 8, "cancel")
    event, office, etn = struct.unpack_from("<BBH", data, 4)
    out = hdr.as_dict()
    out.update(event=event, office=office, etn=etn, reason=hdr.flags)
    return out


# --------------------------------------------------------------------------
# Digest (type 3, spec 5)
# --------------------------------------------------------------------------


def encode_digest(
    seq: int,
    bot: int,
    *,
    now_min: int,
    feed_health: int,
    entries: "list[tuple[int, int, int, int]]",
    source: int = SOURCE_UNSTATED,
) -> bytes:
    """Encode a Digest.

    ``entries`` are ``(event, office, etn, expires_min)`` with an *absolute*
    expiry; the wire carries ``expires_rel = expires_min - now_min`` clamped
    into a u16.

    ``source`` describes the whole list, which is aggregated from many
    products: ``SOURCE_MIXED`` when they did not all arrive the same way
    (spec 2.3).
    """
    if len(entries) > MAX_DIGEST_ENTRIES:
        raise ValueError(
            f"digest holds at most {MAX_DIGEST_ENTRIES} entries, "
            f"got {len(entries)}"
        )
    out = bytearray(encode_header(seq, bot, TYPE_DIGEST, pack_source(source)))
    out += struct.pack(
        "<IBB",
        _u32(now_min, "now_min"),
        _u8(feed_health, "feed_health"),
        len(entries),
    )
    for event, office, etn, expires_min in entries:
        rel = max(0, int(expires_min) - int(now_min))
        rel = min(rel, 0xFFFF)
        out += struct.pack(
            "<BBHH",
            _u8(event, "event"),
            _u8(office, "office"),
            _u16(etn, "etn"),
            rel,
        )
    return _check_size(bytes(out), "digest", MAX_DATA)


def _decode_digest(data: bytes, hdr: Header) -> dict:
    _need(data, 10, "digest")
    now, feed_health, count = struct.unpack_from("<IBB", data, 4)
    _need(data, 10 + 6 * count, "digest entries")
    entries = []
    off = 10
    for _ in range(count):
        event, office, etn, rel = struct.unpack_from("<BBHH", data, off)
        off += 6
        entries.append(
            {
                "event": event,
                "office": office,
                "etn": etn,
                "expires_rel": rel,
                "expires_min": now + rel,
            }
        )
    out = hdr.as_dict()
    out.update(
        now_min=now,
        feed_health=feed_health,
        entries=entries,
        source=unpack_source(hdr.flags),
    )
    return out


# --------------------------------------------------------------------------
# Observations (type 4, spec 6)
# --------------------------------------------------------------------------


def _i8_or(value, sentinel: int, name: str) -> int:
    if value is None:
        return sentinel
    v = int(round(float(value)))
    if not (-128 <= v <= 127):
        raise ValueError(f"{name} must be -128..127, got {v}")
    return v


def _u8_or(value, sentinel: int, name: str) -> int:
    if value is None:
        return sentinel
    v = int(round(float(value)))
    if not (0 <= v <= 255):
        raise ValueError(f"{name} must be 0..255, got {v}")
    return v


def _age_nibble(age_min) -> int:
    """One station's age as a 10-minute step, 0..15, rounding half up.

    Rounding to the nearest step rather than down keeps the error symmetric:
    a report is never shown as more than 4 minutes fresher than it is.
    """
    steps = (int(round(float(age_min))) + OBS_AGE_STEP_MIN // 2) // OBS_AGE_STEP_MIN
    return max(0, min(15, steps))


def _encode_ages(ages) -> bytes:
    """The per-station age block: one nibble each, two stations to a byte,
    station i in the low nibble of byte i // 2 when i is even and the high
    nibble when it is odd.  An odd station count leaves the last high nibble 0.
    """
    block = bytearray((len(ages) + 1) // 2)
    for i, age in enumerate(ages):
        nib = _age_nibble(age)
        block[i // 2] |= (nib << 4) if i % 2 else nib
    return bytes(block)


def encode_obs(
    seq: int,
    bot: int,
    *,
    ts_min: int,
    stations: "list[dict]",
    source: int = SOURCE_UNSTATED,
) -> bytes:
    """Encode an Observations batch (1..13 stations, 11 bytes each).

    A station carrying ``age_min`` — how many minutes older than ``ts_min``
    its own report is — puts the batch into the form with ages: flags nibble
    bit 0 set and a trailing block of age nibbles.  The ages are all or
    nothing, so a batch where only some stations know their age is refused
    rather than sent with the rest guessed at; and because the block costs
    ``ceil(n / 2)`` bytes on top of an already 152-byte full batch, 13
    stations with ages do not fit in one packet (see ``MAX_STATIONS_WITH_AGES``).

    ``source`` describes the batch, which is aggregated from many products:
    ``SOURCE_MIXED`` when they did not all arrive the same way (spec 2.3).
    """
    n = len(stations)
    if not (1 <= n <= MAX_STATIONS):
        raise ValueError(f"observations need 1..{MAX_STATIONS} stations, got {n}")
    ages = [s.get("age_min") for s in stations]
    known = [a is not None for a in ages]
    if any(known) and not all(known):
        raise ValueError(
            "per-station ages must cover every station in the batch or none: "
            f"{sum(known)} of {n} carry age_min"
        )
    out = bytearray(
        encode_header(
            seq,
            bot,
            TYPE_OBS,
            pack_source(source, FLAG_OBS_AGES if all(known) else 0),
        )
    )
    out += struct.pack("<IB", _u32(ts_min, "ts_min"), n)
    for s in stations:
        pressure = s.get("pressure_inhg")
        if pressure is None:
            pressure_b = _U8_UNKNOWN
        else:
            pressure_b = int(round((float(pressure) - 29.00) * 100))
            if not (0 <= pressure_b <= 254):
                raise ValueError(
                    f"pressure_inhg {pressure} out of encodable range "
                    f"29.00..31.54 inHg"
                )
        out += struct.pack(
            "<HbbBBBBBBb",
            _u16(int(s["station"]), "station"),
            _i8_or(s.get("temp_f"), _TEMP_UNKNOWN, "temp_f"),
            _i8_or(s.get("dewpoint_f"), _TEMP_UNKNOWN, "dewpoint_f"),
            (wind_dir_nibble(s.get("wind_dir_deg")) << 4) | _sky(s.get("sky")),
            _u8_or(s.get("wind_mph"), _U8_UNKNOWN, "wind_mph"),
            _u8_or(s.get("gust_mph"), 0, "gust_mph"),
            _u8_or(s.get("visibility_mi"), _U8_UNKNOWN, "visibility_mi"),
            pressure_b,
            _u8_or(s.get("humidity_pct"), _U8_UNKNOWN, "humidity_pct"),
            _i8_or(s.get("feels_delta_f"), 0, "feels_delta_f"),
        )
    if all(known):
        out += _encode_ages(ages)
    return _check_size(bytes(out), "observations")


def _decode_obs(data: bytes, hdr: Header) -> dict:
    _need(data, 9, "observations")
    ts, n = struct.unpack_from("<IB", data, 4)
    _need(data, 9 + 11 * n, "observation stations")

    # The age nibbles sit after the station records.
    ages: "list[int | None]" = [None] * n
    if hdr.flags & FLAG_OBS_AGES:
        base = 9 + 11 * n
        _need(data, base + (n + 1) // 2, "observation ages")
        for i in range(n):
            byte = data[base + i // 2]
            ages[i] = ((byte >> 4) if i % 2 else (byte & 0x0F)) * OBS_AGE_STEP_MIN

    stations = []
    off = 9
    for i in range(n):
        (
            station,
            temp,
            dewpoint,
            dir_sky,
            wind,
            gust,
            vis,
            pressure,
            humidity,
            feels,
        ) = struct.unpack_from("<HbbBBBBBBb", data, off)
        off += 11
        nib = dir_sky >> 4
        stations.append(
            {
                "station": station,
                "temp_f": None if temp == _TEMP_UNKNOWN else temp,
                "dewpoint_f": None if dewpoint == _TEMP_UNKNOWN else dewpoint,
                "wind_dir_deg": nib * 22.5,
                "wind_dir": nibble_to_compass(nib),
                "sky": dir_sky & 0x0F,
                "wind_mph": None if wind == _U8_UNKNOWN else wind,
                "gust_mph": gust,
                "visibility_mi": None if vis == _U8_UNKNOWN else vis,
                "pressure_inhg": (
                    None
                    if pressure == _U8_UNKNOWN
                    else round(29.00 + pressure / 100.0, 2)
                ),
                "humidity_pct": None if humidity == _U8_UNKNOWN else humidity,
                "feels_delta_f": feels,
                # Minutes this station's own report is older than `ts_min`;
                # None when the batch carries no ages.
                "age_min": ages[i],
            }
        )
    out = hdr.as_dict()
    out.update(ts_min=ts, stations=stations, source=unpack_source(hdr.flags))
    return out


# --------------------------------------------------------------------------
# Forecast (type 5, spec 7)
# --------------------------------------------------------------------------


def encode_forecast(
    seq: int,
    bot: int,
    *,
    point: int,
    issued_min: int,
    first_period: int,
    periods: "list[dict]",
    source: int = SOURCE_UNSTATED,
) -> bytes:
    """Encode a point Forecast (1..14 periods, 5 bytes each).

    ``source`` is where the PFM or ZFP this was rendered from came from
    (spec 2.3).
    """
    n = len(periods)
    if not (1 <= n <= MAX_PERIODS):
        raise ValueError(f"forecast needs 1..{MAX_PERIODS} periods, got {n}")
    out = bytearray(encode_header(seq, bot, TYPE_FORECAST, pack_source(source)))
    out += struct.pack(
        "<HIBB",
        _u16(point, "point"),
        _u32(issued_min, "issued_min"),
        _u8(first_period, "first_period"),
        n,
    )
    for p in periods:
        cond = _sky(p.get("sky"))
        if p.get("thunder"):
            cond |= 0x10
        if p.get("wintry"):
            cond |= 0x20
        if p.get("windy"):
            cond |= 0x40
        if p.get("fog"):
            cond |= 0x80
        speed = p.get("wind_mph")
        speed_nib = 0 if speed is None else min(15, int(round(float(speed) / 5)))
        out += struct.pack(
            "<bbBBB",
            _i8_or(p.get("high_f"), _FORECAST_TEMP_UNKNOWN, "high_f"),
            _i8_or(p.get("low_f"), _FORECAST_TEMP_UNKNOWN, "low_f"),
            _u8_or(p.get("pop_pct"), _U8_UNKNOWN, "pop_pct"),
            cond,
            (wind_dir_nibble(p.get("wind_dir_deg")) << 4) | speed_nib,
        )
    return _check_size(bytes(out), "forecast")


def _decode_forecast(data: bytes, hdr: Header) -> dict:
    _need(data, 12, "forecast")
    point, issued, first, n = struct.unpack_from("<HIBB", data, 4)
    _need(data, 12 + 5 * n, "forecast periods")
    periods = []
    off = 12
    for _ in range(n):
        high, low, pop, cond, wind = struct.unpack_from("<bbBBB", data, off)
        off += 5
        nib = wind >> 4
        periods.append(
            {
                "high_f": None if high == _FORECAST_TEMP_UNKNOWN else high,
                "low_f": None if low == _FORECAST_TEMP_UNKNOWN else low,
                "pop_pct": None if pop == _U8_UNKNOWN else pop,
                "sky": cond & 0x0F,
                "thunder": bool(cond & 0x10),
                "wintry": bool(cond & 0x20),
                "windy": bool(cond & 0x40),
                "fog": bool(cond & 0x80),
                "wind_dir_deg": nib * 22.5,
                "wind_dir": nibble_to_compass(nib),
                "wind_mph": (wind & 0x0F) * 5,
            }
        )
    out = hdr.as_dict()
    out.update(
        point=point,
        issued_min=issued,
        first_period=first,
        periods=periods,
        source=unpack_source(hdr.flags),
    )
    return out


# --------------------------------------------------------------------------
# Coverage (type 8, spec 10)
# --------------------------------------------------------------------------


def encode_coverage(
    seq: int,
    bot: int,
    *,
    lat: float,
    lon: float,
    radius_km: int = 0,
    stations: int = 0,
    offices: "list[int] | None" = None,
    areas: "list[tuple[int, bool, int, int]] | None" = None,
    zones_cut: bool = False,
    offices_cut: bool = False,
) -> bytes:
    """Encode a Coverage message: what the bot carries, stated by the bot.

    ``lat`` and ``lon`` are the coverage centre in degrees, ``radius_km`` the
    circle around it (0 = no circle), ``stations`` the most stations one
    hourly Observations packet may carry (0 = none).  ``offices`` are indices
    into ``index.json`` ``offices``; ``areas`` are the same ``(state_index,
    is_county, start, run)`` runs a Warning's area list uses.  A cut flag says
    that list is shorter than what the bot really covers, so a code missing
    from it means "not stated", never "not covered".

    Coverage takes no ``source``: it describes the bot's own configuration,
    not a weather product, so its source bits stay ``SOURCE_UNSTATED``.
    """
    offices = list(offices or [])
    areas = list(areas or [])
    if len(offices) > MAX_COVERAGE_OFFICES:
        raise ValueError(
            f"coverage holds at most {MAX_COVERAGE_OFFICES} offices, "
            f"got {len(offices)}"
        )
    flags = (FLAG_COVERAGE_ZONES_CUT if zones_cut else 0) | (
        FLAG_COVERAGE_OFFICES_CUT if offices_cut else 0
    )
    out = bytearray(encode_header(seq, bot, TYPE_COVERAGE, flags))
    out += _pack_i24(int(round(float(lat) * 10000)), "coverage lat")
    out += _pack_i24(int(round(float(lon) * 10000)), "coverage lon")
    out += struct.pack(
        "<HBB",
        _u16(int(radius_km), "radius_km"),
        _u8(int(stations), "stations"),
        len(offices),
    )
    for office in offices:
        out.append(_u8(int(office), "office"))
    out += _encode_areas(areas, minimum=0, maximum=MAX_COVERAGE_RUNS)
    return _check_size(bytes(out), "coverage")


def _decode_coverage(data: bytes, hdr: Header) -> dict:
    _need(data, 14, "coverage")
    lat = _unpack_i24(data, 4) / 10000.0
    lon = _unpack_i24(data, 7) / 10000.0
    radius, stations, n = struct.unpack_from("<HBB", data, 10)
    _need(data, 14 + n, "coverage offices")
    offices = list(data[14:14 + n])
    areas, _end = _decode_areas(data, 14 + n)
    out = hdr.as_dict()
    out.update(
        lat=round(lat, 4),
        lon=round(lon, 4),
        radius_km=radius,
        stations=stations,
        offices=offices,
        areas=areas,
        zones_cut=bool(hdr.flags & FLAG_COVERAGE_ZONES_CUT),
        offices_cut=bool(hdr.flags & FLAG_COVERAGE_OFFICES_CUT),
    )
    return out


# --------------------------------------------------------------------------
# Text (type 6, spec 8)
# --------------------------------------------------------------------------


def encode_text(
    seq: int,
    bot: int,
    *,
    subject: int,
    group: int,
    idx: int,
    total: int,
    text: str,
    source: int = SOURCE_UNSTATED,
    cut: bool = False,
) -> bytes:
    """Encode one Text chunk.

    ``cut`` says the product was longer than eight chunks and the tail was
    dropped (spec 8).  It belongs on *every* chunk of the
    reply, not just the last one: a phone that loses the last packet must
    still know it is not holding the whole product.
    """
    if not (1 <= total <= MAX_TEXT_CHUNKS):
        raise ValueError(f"total must be 1..{MAX_TEXT_CHUNKS}, got {total}")
    if not (0 <= idx < total):
        raise ValueError(f"idx must be 0..{total - 1}, got {idx}")
    body = text.encode("utf-8") if isinstance(text, str) else bytes(text)
    if len(body) > MAX_TEXT_BYTES:
        raise ValueError(
            f"text chunk is {len(body)} bytes, over the "
            f"{MAX_TEXT_BYTES}-byte limit"
        )
    flags = pack_source(source, FLAG_TEXT_CUT if cut else 0)
    out = encode_header(seq, bot, TYPE_TEXT, flags) + struct.pack(
        "<BBBB",
        _u8(subject, "subject"),
        _u8(group, "group"),
        idx,
        total,
    ) + body
    return _check_size(out, "text")


def text_chunks(
    seq_start: int,
    bot: int,
    *,
    subject: int,
    text: str,
    source: int = SOURCE_UNSTATED,
    cut: bool = False,
) -> "list[bytes]":
    """Split ``text`` into Text messages.

    Chunks never split a UTF-8 code point, carry at most 149 text bytes,
    share ``group = seq_start & 0xFF``, and use consecutive sequence numbers
    starting at ``seq_start`` (wrapping 255 -> 0).

    ``text`` must already fit in ``MAX_TEXT_CHUNKS`` chunks; this function
    refuses to guess where to cut, because only the caller knows where a
    sentence ends (see ``v5_builders.text_messages``).  ``cut`` records that
    the caller did the cutting, and goes on every chunk.
    """
    _check_header(seq_start, bot, TYPE_TEXT, 0)
    body = text.encode("utf-8")
    parts: "list[bytes]" = []
    pos = 0
    while pos < len(body) or not parts:
        end = min(pos + MAX_TEXT_BYTES, len(body))
        # Back off to a UTF-8 code point boundary: continuation bytes are
        # 0b10xxxxxx.
        while end > pos and end < len(body) and (body[end] & 0xC0) == 0x80:
            end -= 1
        if end == pos and pos < len(body):
            raise ValueError("a single code point exceeds the chunk size")
        parts.append(body[pos:end])
        pos = end
    if len(parts) > MAX_TEXT_CHUNKS:
        raise ValueError(
            f"text needs {len(parts)} chunks, over the "
            f"{MAX_TEXT_CHUNKS}-chunk limit ({MAX_TEXT_CHUNKS * MAX_TEXT_BYTES}"
            f" bytes of UTF-8)"
        )
    group = seq_start & 0xFF
    total = len(parts)
    return [
        encode_text(
            (seq_start + i) & 0xFF,
            bot,
            subject=subject,
            group=group,
            idx=i,
            total=total,
            text=part.decode("utf-8"),
            source=source,
            cut=cut,
        )
        for i, part in enumerate(parts)
    ]


def _decode_text(data: bytes, hdr: Header) -> dict:
    _need(data, 8, "text")
    subject, group, idx, total = struct.unpack_from("<BBBB", data, 4)
    out = hdr.as_dict()
    out.update(
        subject=subject,
        group=group,
        idx=idx,
        total=total,
        text=data[8:].decode("utf-8"),
        # Set on every chunk of a reply whose tail was dropped.
        cut=bool(hdr.flags & FLAG_TEXT_CUT),
        source=unpack_source(hdr.flags),
    )
    return out


# --------------------------------------------------------------------------
# Not available (type 7, spec 9)
# --------------------------------------------------------------------------


def encode_not_available(seq: int, bot: int, *, request: str, reason: int) -> bytes:
    """Encode a Not-available reply.

    ``request`` is the request string (or just its first letter); the wire
    carries the ASCII code of that first letter.

    No ``source``: there is no weather product behind a Not available, so
    its source bits stay ``SOURCE_UNSTATED``.
    """
    if not request:
        raise ValueError("request must not be empty")
    letter = request.lstrip(">").lstrip()
    if not letter:
        raise ValueError("request has no letter after the '>' prefix")
    code = ord(letter[0])
    if not (0 <= code <= 255):
        raise ValueError(f"request letter {letter[0]!r} is not ASCII")
    out = encode_header(seq, bot, TYPE_NOT_AVAILABLE) + struct.pack(
        "<BB", code, _u8(reason, "reason")
    )
    return _check_size(out, "not_available")


def _decode_not_available(data: bytes, hdr: Header) -> dict:
    _need(data, 6, "not_available")
    code, reason = struct.unpack_from("<BB", data, 4)
    out = hdr.as_dict()
    out.update(request=chr(code), request_code=code, reason=reason)
    return out


# --------------------------------------------------------------------------
# Request (type 9, spec 11) — app -> bot, the only message a bot receives
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Request:
    """One decoded Request datagram.

    ``sender_prefix`` is the first six bytes of the sender's public key as 12
    lower-case hex characters: exactly the prefix a DM from the same phone
    carries, so a request by datagram and one by DM are one sender to the
    bot's limits and its copy rule (spec 11).
    """

    seq: int
    bot: int
    sender_prefix: str
    ts: int
    text: str
    flags: int = 0

    def as_dict(self) -> dict:
        return {
            "seq": self.seq,
            "bot": self.bot,
            "type": TYPE_REQUEST,
            "name": TYPE_NAMES[TYPE_REQUEST],
            "flags": self.flags,
            "sender": self.sender_prefix,
            "ts": self.ts,
            "text": self.text,
        }

    @property
    def for_any_bot(self) -> bool:
        return self.bot == REQUEST_BOT_ANY


def _sender_bytes(sender_prefix) -> bytes:
    """The six sender bytes, from raw bytes or from 12 hex characters."""
    if isinstance(sender_prefix, str):
        try:
            sender_prefix = bytes.fromhex(sender_prefix)
        except ValueError as exc:
            raise ValueError(f"sender is not hex: {sender_prefix!r}") from exc
    sender_prefix = bytes(sender_prefix)
    if len(sender_prefix) != REQUEST_SENDER_BYTES:
        raise ValueError(
            f"sender must be {REQUEST_SENDER_BYTES} bytes, got {len(sender_prefix)}"
        )
    return sender_prefix


def encode_request(
    seq: int,
    bot: int,
    sender_prefix,
    ts: int,
    text: str,
) -> bytes:
    """Encode an app's Request datagram (spec 11).

    ``sender_prefix`` is six bytes of the sender's public key (or the same
    twelve hex characters), ``ts`` the sender's own Unix seconds — repeated on
    a resend, which is what makes it a copy — and ``text`` the `>` request of
    section 14.  Nothing here is ever sent by the bot; it exists so the
    decoder has a matching encoder and the test vectors can be built.

    No ``source``: a request carries no weather, so its source bits stay
    ``SOURCE_UNSTATED``.
    """
    sender = _sender_bytes(sender_prefix)
    body = text.encode("utf-8")
    if not body.startswith(b">"):
        raise ValueError(f"a request must start with '>', got {text!r}")
    if len(body) > MAX_REQUEST_TEXT:
        raise ValueError(
            f"request text is {len(body)} bytes, over the {MAX_REQUEST_TEXT}-byte limit"
        )
    out = (
        encode_header(seq, bot, TYPE_REQUEST)
        + sender
        + struct.pack("<I", _u32(ts, "ts"))
        + body
    )
    return _check_size(out, "request")


def decode_request(data: bytes) -> Request:
    """Decode a Request datagram, or raise ``ValueError``.

    Everything the spec calls a shape is checked here, because this is the one
    message the bot takes from strangers: the length, the type nibble, the
    sender's six bytes, and a text that is valid UTF-8, starts with `>` and is
    at most 40 bytes.  The flags nibble is reserved and ignored.
    """
    if isinstance(data, str):
        data = bytes.fromhex(data)
    data = bytes(data)
    if len(data) < MIN_REQUEST_SIZE:
        raise ValueError(
            f"truncated request: need {MIN_REQUEST_SIZE} bytes, have {len(data)}"
        )
    hdr = _decode_header(data)
    if hdr.type != TYPE_REQUEST:
        raise ValueError(f"not a request: type {hdr.type}")
    sender = data[HEADER_SIZE:HEADER_SIZE + REQUEST_SENDER_BYTES]
    off = HEADER_SIZE + REQUEST_SENDER_BYTES
    (ts,) = struct.unpack_from("<I", data, off)
    raw = data[off + 4:]
    if len(raw) > MAX_REQUEST_TEXT:
        raise ValueError(
            f"request text is {len(raw)} bytes, over the {MAX_REQUEST_TEXT}-byte limit"
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"request text is not UTF-8: {exc}") from exc
    if not text.startswith(">"):
        raise ValueError(f"a request must start with '>', got {text[:8]!r}")
    return Request(seq=hdr.seq, bot=hdr.bot, sender_prefix=sender.hex(), ts=ts,
                   text=text, flags=hdr.flags)


def _decode_request(data: bytes, hdr: Header) -> dict:
    return decode_request(data).as_dict()


# --------------------------------------------------------------------------
# Area sweep (type 10, spec 12) — the national picture, in runs
# --------------------------------------------------------------------------
#
# One entry is one run of consecutive UGC numbers in one state, under one
# event code: four bytes for anything from a single county to 64 of them.
# The phone already ships every outline (`zones.geojson`, `counties.geojson`),
# so the mesh carries numbers and the phone draws the map.
#
#     0  event   the event code Warning uses (section 3), the most severe
#                event covering this run
#     1  state << 1 | kind   state index in bits 1-7, kind in bit 0:
#                0 = forecast zone (Z), 1 = county (C)
#     2  u16 LE  bits 0-9 `start` (the UGC number), bits 10-15 `run - 1`
#
# Note this is NOT the Warning area run of section 3: that one spends a whole
# byte on `run` and flags a county in bit 7 of the state byte.  A sweep entry
# carries an event code the Warning run does not, and pays for it by capping
# the run at 64.
#
# The scope: a sweep may cover a few states rather than the country.  `total` bit 7 says so on every packet, and packet 0 begins with
# one entry per state named — event 0, zone kind, start 0, run 1, which is
# `XXZ000`, "all of state XX".  A state in the scope with no alert entry is
# an answer: nothing is active there at this level.  The decoder lifts those
# entries out into `scope` so `entries` is alerts alone.


def encode_area_sweep(
    seq: int,
    bot: int,
    *,
    built_min: int,
    group: int,
    idx: int,
    total: int,
    entries: "list[tuple[int, int, bool, int, int]]",
    cut: bool = False,
    advisories: bool = False,
    source: int = SOURCE_UNSTATED,
    scope: "list[int]" = (),
    scoped: bool = False,
) -> bytes:
    """Encode one packet of an Area sweep.

    ``entries`` are ``(event, state_index, is_county, start, run)``.  ``group``
    is the same value on every packet of one sweep — the ``seq`` its first
    packet went out with, exactly as Text does it (spec 8) — so a phone
    reassembles by ``(bot, group)`` and never mixes two sweeps.

    ``cut`` says entries were dropped because the sweep did not fit in
    ``MAX_SWEEP_PACKETS`` packets, and belongs on *every* packet: a phone that
    loses the last one must still know it is not holding the whole picture.
    ``advisories`` says advisories (VTEC significance Y and S) are included;
    without it the sweep is warnings and watches only.

    ``scope`` is the state indices this sweep covers (spec 12.3).
    They go out as one entry each, ahead of the alert entries and counting
    toward the 36 a packet holds, and they belong on packet 0 alone.
    ``scoped`` sets ``total`` bit 7 and belongs on *every* packet, so a phone
    that lost packet 0 still knows it is not looking at the country; passing a
    scope implies it.
    """
    if not (1 <= total <= MAX_SWEEP_PACKETS):
        raise ValueError(f"total must be 1..{MAX_SWEEP_PACKETS}, got {total}")
    if not (0 <= idx < total):
        raise ValueError(f"idx must be 0..{total - 1}, got {idx}")
    scope = list(scope)
    scoped = bool(scoped or scope)
    if len(scope) > MAX_SWEEP_SCOPE_STATES:
        raise ValueError(
            f"a sweep names at most {MAX_SWEEP_SCOPE_STATES} states, "
            f"got {len(scope)}"
        )
    # The scope entries are entries: they are what the packet spends its room
    # on before an alert gets any.
    entries = [
        (SWEEP_SCOPE_EVENT, state, False, 0, 1) for state in scope
    ] + list(entries)
    if len(entries) > MAX_SWEEP_ENTRIES_PER_PACKET:
        raise ValueError(
            f"a sweep packet holds at most {MAX_SWEEP_ENTRIES_PER_PACKET} "
            f"entries, got {len(entries)} (scope included)"
        )
    flags = (FLAG_SWEEP_CUT if cut else 0) | (
        FLAG_SWEEP_ADVISORIES if advisories else 0
    )
    out = bytearray(
        encode_header(seq, bot, TYPE_AREA_SWEEP, pack_source(source, flags))
    )
    out += struct.pack(
        "<IBBB",
        _u32(built_min, "built_min"),
        _u8(group, "group"),
        idx,
        total | (SWEEP_SCOPED_BIT if scoped else 0),
    )
    for event, state, is_county, start, run in entries:
        if not (0 <= state <= 127):
            raise ValueError(f"state index must be 0..127, got {state}")
        if not (0 <= start <= MAX_SWEEP_START):
            raise ValueError(
                f"sweep start must be 0..{MAX_SWEEP_START}, got {start}"
            )
        if not (1 <= run <= MAX_SWEEP_RUN):
            raise ValueError(
                f"sweep run must be 1..{MAX_SWEEP_RUN}, got {run}"
            )
        out += struct.pack(
            "<BBH",
            _u8(event, "event"),
            (state << 1) | (1 if is_county else 0),
            start | ((run - 1) << 10),
        )
    return _check_size(bytes(out), "area_sweep")


def sweep_packets(
    seq_start: int,
    bot: int,
    *,
    built_min: int,
    entries: "list[tuple[int, int, bool, int, int]]",
    cut: bool = False,
    advisories: bool = False,
    source: int = SOURCE_UNSTATED,
    scope: "list[int]" = (),
) -> "list[bytes]":
    """Split an ordered entry list into Area sweep packets.

    Entries arrive most severe first (the caller's ordering, spec 12), so
    anything past the sweep's room is the least severe and is dropped here
    with ``cut`` set on every packet.  Packets share
    ``group = seq_start & 0xFF`` and take consecutive sequence numbers from
    ``seq_start``, wrapping 255 -> 0.

    ``scope`` names the states a scoped sweep covers.  Its entries ride on
    packet 0 and cost that packet the room they take, so a scoped sweep holds
    ``MAX_SWEEP_ENTRIES - len(scope)`` alert entries.  A scope with no alert
    entries at all is still one packet: "nothing is active in these states"
    is the answer, and the reason the scope is on the wire.
    """
    _check_header(seq_start, bot, TYPE_AREA_SWEEP, 0)
    scope = list(scope)
    entries = list(entries)
    room = MAX_SWEEP_ENTRIES - len(scope)
    if len(entries) > room:
        entries = entries[:room]
        cut = True
    if not entries and not scope:
        return []
    first = entries[:MAX_SWEEP_ENTRIES_PER_PACKET - len(scope)]
    rest = entries[len(first):]
    chunks = [first] + [
        rest[i:i + MAX_SWEEP_ENTRIES_PER_PACKET]
        for i in range(0, len(rest), MAX_SWEEP_ENTRIES_PER_PACKET)
    ]
    group = seq_start & 0xFF
    total = len(chunks)
    return [
        encode_area_sweep(
            (seq_start + i) & 0xFF,
            bot,
            built_min=built_min,
            group=group,
            idx=i,
            total=total,
            entries=chunk,
            cut=cut,
            advisories=advisories,
            source=source,
            scope=scope if i == 0 else (),
            scoped=bool(scope),
        )
        for i, chunk in enumerate(chunks)
    ]


def _decode_area_sweep(data: bytes, hdr: Header) -> dict:
    _need(data, 11, "area_sweep")
    built, group, idx, total = struct.unpack_from("<IBBB", data, 4)
    # Whole entries only.  A trailing part of one is read as padding and
    # dropped: both shipping clients already ignore it, and the alternative —
    # throwing away 37 good runs over three stray bytes — serves nobody.
    entries = []
    off = 11
    for _ in range((len(data) - 11) // 4):
        event, state, packed = struct.unpack_from("<BBH", data, off)
        off += 4
        entries.append(
            {
                "event": event,
                "state": state >> 1,
                "county": bool(state & 0x1),
                "start": packed & 0x3FF,
                "run": (packed >> 10) + 1,
            }
        )
    # The scope entries lead, and no alert carries event 0, so the run of them
    # at the front is the scope.  They come out of `entries`: a caller drawing
    # the map wants alerts, and "which states is this about" is a different
    # question with its own answer (spec 12.3).
    scope = []
    while entries and entries[0]["event"] == SWEEP_SCOPE_EVENT:
        scope.append(entries.pop(0)["state"])
    out = hdr.as_dict()
    out.update(
        built_min=built,
        group=group,
        idx=idx,
        total=total & SWEEP_TOTAL_MASK,
        entries=entries,
        scoped=bool(total & SWEEP_SCOPED_BIT),
        scope=scope,
        cut=bool(hdr.flags & FLAG_SWEEP_CUT),
        advisories=bool(hdr.flags & FLAG_SWEEP_ADVISORIES),
        source=unpack_source(hdr.flags),
    )
    return out


# --------------------------------------------------------------------------
# Radar (type 11, spec 13) -- one tile of a radar picture
# --------------------------------------------------------------------------


def radar_tile(lat: float, lon: float, zoom: int = 0) -> "tuple[int, int]":
    """The tile that answers a coordinate: ``(south, west)`` in whole degrees.

    Tiles sit on a lattice of half their span so that every phone can use a
    tile any phone asked for, and the one chosen is the one whose *centre* is
    nearest, so the place asked about is never closer than a quarter of the
    span to an edge.  ``floor(x / step + 0.5)`` and not ``round``: a tie must
    fall the same way in every language a client is written in.
    """
    if not (0 <= zoom <= MAX_RADAR_ZOOM):
        raise ValueError(f"zoom must be 0..{MAX_RADAR_ZOOM}, got {zoom}")
    step = 1 << zoom

    def origin(value: float) -> int:
        centre = int((value / step + 0.5) // 1) * step
        return centre - step

    return origin(lat), origin(lon)


def radar_coarsen(rows: "list[list[int]]") -> "list[list[int]]":
    """A 32 x 32 grid as 16 x 16: each cell the highest of the four it covers."""
    n = len(rows) // 2
    return [
        [
            max(rows[2 * r][2 * c], rows[2 * r][2 * c + 1],
                rows[2 * r + 1][2 * c], rows[2 * r + 1][2 * c + 1])
            for c in range(n)
        ]
        for r in range(n)
    ]


class _BitWriter:
    def __init__(self) -> None:
        self.bits: "list[int]" = []

    def put(self, value: int, width: int) -> None:
        for shift in range(width - 1, -1, -1):
            self.bits.append((value >> shift) & 1)

    def bytes(self) -> bytes:
        bits = self.bits + [0] * (-len(self.bits) % 8)
        return bytes(
            sum(bit << (7 - i) for i, bit in enumerate(bits[o:o + 8]))
            for o in range(0, len(bits), 8)
        )


class _BitReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, width: int) -> int:
        value = 0
        for _ in range(width):
            byte = self.pos >> 3
            if byte >= len(self.data):
                raise ValueError("radar: the quadtree runs past the end of the packet")
            value = (value << 1) | ((self.data[byte] >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return value


def _radar_pack(rows: "list[list[int]]") -> bytes:
    out = _BitWriter()

    def node(r: int, c: int, size: int) -> None:
        first = rows[r][c]
        if size == 1:
            out.put(first, 2)
            return
        if all(rows[y][x] == first for y in range(r, r + size) for x in range(c, c + size)):
            out.put(0, 1)
            out.put(first, 2)
            return
        out.put(1, 1)
        half = size // 2
        node(r, c, half)                 # north-west
        node(r, c + half, half)          # north-east
        node(r + half, c, half)          # south-west
        node(r + half, c + half, half)   # south-east

    node(0, 0, len(rows))
    return out.bytes()


def _radar_unpack(data: bytes, size: int) -> "list[list[int]]":
    rows = [[0] * size for _ in range(size)]
    bits = _BitReader(data)

    def node(r: int, c: int, span: int) -> None:
        if span == 1:
            rows[r][c] = bits.take(2)
            return
        if bits.take(1) == 0:
            level = bits.take(2)
            for y in range(r, r + span):
                for x in range(c, c + span):
                    rows[y][x] = level
            return
        half = span // 2
        node(r, c, half)
        node(r, c + half, half)
        node(r + half, c, half)
        node(r + half, c + half, half)

    node(0, 0, size)
    return rows


def encode_radar(
    seq: int,
    bot: int,
    *,
    taken_min: int,
    south: int,
    west: int,
    zoom: int,
    product: int,
    rows: "list[list[int]]",
    bounds: "tuple[int, int, int, int] | None" = None,
    source: int = SOURCE_UNSTATED,
) -> bytes:
    """Encode one Radar tile.  Raises ``ValueError`` when it does not fit.

    ``rows`` is the grid, north row first, west column first, each cell a
    level 0 to 3; 32 rows of 32 for a fine tile, 16 of 16 for a coarse one,
    and the coarse flag follows from which it is.  A caller whose fine grid
    does not fit catches the error and sends ``radar_coarsen(rows)``, which
    always does.

    ``bounds`` is ``(row0, row1, col0, col1)``, inclusive, in this grid's own
    numbering: the part of the tile the radar picture covers.  Cells outside
    it must be level 0 on the wire and mean unknown, never dry.
    """
    size = len(rows)
    if size not in (RADAR_GRID, RADAR_COARSE_GRID) or any(len(r) != size for r in rows):
        raise ValueError(f"rows must be {RADAR_GRID} x {RADAR_GRID} or {RADAR_COARSE_GRID} x {RADAR_COARSE_GRID}")
    if any(not (0 <= v <= 3) for r in rows for v in r):
        raise ValueError("a radar level must be 0..3")
    if not (0 <= zoom <= MAX_RADAR_ZOOM):
        raise ValueError(f"zoom must be 0..{MAX_RADAR_ZOOM}, got {zoom}")
    if not (0 <= product <= MAX_RADAR_PRODUCT):
        raise ValueError(f"product must be 0..{MAX_RADAR_PRODUCT}, got {product}")
    if not (-90 <= south <= 90):
        raise ValueError(f"south must be -90..90, got {south}")
    if not (-180 <= west <= 179):
        raise ValueError(f"west must be -180..179, got {west}")
    flags = FLAG_RADAR_COARSE if size == RADAR_COARSE_GRID else 0
    extra = b""
    if bounds is not None:
        row0, row1, col0, col1 = bounds
        if not (0 <= row0 <= row1 < size and 0 <= col0 <= col1 < size):
            raise ValueError(f"bounds {bounds} are not inside a {size} x {size} grid")
        if any(
            rows[r][c]
            for r in range(size)
            for c in range(size)
            if not (row0 <= r <= row1 and col0 <= c <= col1)
        ):
            raise ValueError("a cell outside the bounds must be level 0")
        flags |= FLAG_RADAR_PARTIAL
        extra = bytes(bounds)
    out = (
        encode_header(seq, bot, TYPE_RADAR, pack_source(source, flags))
        + struct.pack("<IbhB", _u32(taken_min, "taken_min"), south, west, (product << 2) | zoom)
        + extra
        + _radar_pack(rows)
    )
    return _check_size(out, "radar")


def _decode_radar(data: bytes, hdr: Header) -> dict:
    _need(data, 13, "radar")
    taken, south, west, shape = struct.unpack_from("<IbhB", data, 4)
    coarse = bool(hdr.flags & FLAG_RADAR_COARSE)
    partial = bool(hdr.flags & FLAG_RADAR_PARTIAL)
    size = RADAR_COARSE_GRID if coarse else RADAR_GRID
    off = 12
    bounds = None
    if partial:
        _need(data, off + 4 + 1, "radar bounds")
        bounds = list(data[off:off + 4])
        off += 4
        row0, row1, col0, col1 = bounds
        if not (row0 <= row1 < size and col0 <= col1 < size):
            raise ValueError(f"radar: bounds {bounds} are not inside a {size} x {size} grid")
    rows = _radar_unpack(data[off:], size)
    out = hdr.as_dict()
    out.update(
        taken_min=taken,
        south=south,
        west=west,
        zoom=shape & 0x03,
        product=shape >> 2,
        coarse=coarse,
        partial=partial,
        bounds=bounds,
        size=size,
        rows=["".join(str(v) for v in row) for row in rows],
        source=unpack_source(hdr.flags),
    )
    return out


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------

_DECODERS = {
    TYPE_WARNING: _decode_warning,
    TYPE_CANCEL: _decode_cancel,
    TYPE_DIGEST: _decode_digest,
    TYPE_OBS: _decode_obs,
    TYPE_FORECAST: _decode_forecast,
    TYPE_TEXT: _decode_text,
    TYPE_NOT_AVAILABLE: _decode_not_available,
    TYPE_COVERAGE: _decode_coverage,
    TYPE_REQUEST: _decode_request,
    TYPE_AREA_SWEEP: _decode_area_sweep,
    TYPE_RADAR: _decode_radar,
}


def decode(data: bytes) -> dict:
    """Decode one v5 message into a plain dict.

    Field names and units follow the spec.  An unknown message type yields
    just the header with ``name = "unknown"``; truncated input raises
    ``ValueError``.
    """
    if isinstance(data, str):
        data = bytes.fromhex(data)
    data = bytes(data)
    hdr = _decode_header(data)
    handler = _DECODERS.get(hdr.type)
    if handler is None:
        return hdr.as_dict()
    return handler(data, hdr)


# --------------------------------------------------------------------------
# UGC helper
# --------------------------------------------------------------------------


def areas_from_ugcs(
    ugcs: "list[str]", states: "list[str]"
) -> "list[tuple[int, bool, int, int]]":
    """Turn NWS UGC codes into area runs.

    ``"TXC453"`` is Travis county, ``"TXZ191"`` is forecast zone 191.  Codes
    whose state is not in ``states`` are skipped.  The result is sorted by
    ``(state index, county flag, number)`` and consecutive numbers of the same
    state and kind are merged into runs of at most 255.
    """
    index = {code: i for i, code in enumerate(states)}
    seen = set()
    for raw in ugcs:
        ugc = str(raw).strip().upper()
        if len(ugc) != 6 or ugc[2] not in ("C", "Z") or not ugc[3:].isdigit():
            continue
        state = index.get(ugc[:2])
        if state is None:
            continue
        seen.add((state, ugc[2] == "C", int(ugc[3:])))

    runs: "list[list]" = []
    for state, is_county, number in sorted(seen):
        if runs:
            last = runs[-1]
            if (
                last[0] == state
                and last[1] == is_county
                and last[2] + last[3] == number
                and last[3] < 255
            ):
                last[3] += 1
                continue
        runs.append([state, is_county, number, 1])
    return [(s, c, start, run) for s, c, start, run in runs]
