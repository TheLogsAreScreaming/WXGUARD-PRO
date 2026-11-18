"""From the product store to v5 messages.

One implementation for both the scheduled broadcasts and the app requests
(the v4 code had two, and they drifted). Everything here returns bytes
ready for `radio.send_channel_data()`, or None when the store has nothing
to say. The wire layouts live in protocol/v5.py; this module only knows
where the numbers come from.
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol.encoders import parse_metar, metar_observed_at

logger = logging.getLogger(__name__)

_CLIENT_DATA = Path(__file__).resolve().parent.parent / "client_data"

# Warnings that get one repeat 90 s after the first send.
LIFE_SAFETY = {"TO.W", "SV.W", "FF.W", "EW.W"}

OBS_MAX_AGE_MIN = 120
# `>o ICAO` with nothing fresh within reach answers with the newest report up
# to this old, so the phone shows the weather as last seen with its age rather
# than "No current conditions" (services.OBS_STALE_MAX_AGE_MIN, owner 2026-10-16).
OBS_STALE_MAX_AGE_MIN = 720
# `>o ICAO` for a station with nothing fresh answers with the nearest station
# within this distance of it that has a report (spec 14, revision 8). The same
# 40 km the app will still show a reading from, attributed to its station.
OBS_SUBSTITUTE_KM = 40.0
MAX_OBS_STATIONS = v5.MAX_STATIONS
# What an hourly batch really carries since revision 5: the per-station ages (spec 6.1)
# do not fit beside 13 stations, so the builder drops the farthest. Coverage states this one.
OBS_STATIONS_WITH_AGES = v5.MAX_STATIONS_WITH_AGES
MAX_DIGEST = v5.MAX_DIGEST_ENTRIES
POINT_MATCH_KM = 1.5


# -- Wire tables (index.json) --------------------------------------------------------


# VTEC office -> the office id index.json lists (see `_Tables.office`).
_OFFICE_ALIASES = {"JSJ": "SJU"}


class _Tables:
    def __init__(self):
        self._loaded = False
        self.offices: list[str] = []
        self.stations: list[str] = []
        self.states: list[str] = []
        self.points: list[list] = []
        self.events: dict[str, int] = {}
        self._office_idx: dict[str, int] = {}
        self._station_idx: dict[str, int] = {}

    def load(self) -> None:
        if self._loaded:
            return
        try:
            idx = json.loads((_CLIENT_DATA / "index.json").read_text())
            self.offices, self.stations, self.states = idx["offices"], idx["stations"], idx["states"]
        except Exception:
            # index.json is generated from these; the same ordering rule
            # keeps a fresh checkout working. wfos.json is already in wire
            # order (sorted WFOs, then the national centres), never re-sort it.
            self.offices = list(json.loads((_CLIENT_DATA / "wfos.json").read_text()))
            self.stations = sorted(json.loads((_CLIENT_DATA / "stations.json").read_text()))
            self.states = json.loads((_CLIENT_DATA / "state_index.json").read_text())["states"]
        self.points = json.loads((_CLIENT_DATA / "pfm_points.json").read_text())["points"]
        self.events = json.loads((_CLIENT_DATA / "protocol.json").read_text()).get("events", {})
        self._office_idx = {c: i for i, c in enumerate(self.offices)}
        self._station_idx = {c: i for i, c in enumerate(self.stations)}
        self._loaded = True

    def office(self, code: str | None) -> int | None:
        """The office byte, or None for a code index.json does not list.

        A VTEC id names the issuing station without its leading letter — KLWX
        is LWX, the office's own id — everywhere but San Juan, which issues as
        TJSJ while the office is SJU. Its warnings therefore had no index at
        all and were dropped before they were ever built: `>w PRZ001` answered
        Not available for Puerto Rico and the US Virgin Islands while a typed
        `warn pr` listed the same heat advisory. It is the one mismatch among
        the 77 offices the feed carried in a day and a half.
        """
        self.load()
        code = (code or "").upper()
        return self._office_idx.get(_OFFICE_ALIASES.get(code, code))

    def office_code(self, idx: int) -> str:
        self.load()
        return self.offices[idx] if 0 <= idx < len(self.offices) else "???"

    def station(self, icao: str) -> int | None:
        self.load()
        return self._station_idx.get(icao.upper())

    def event_code(self, key: str) -> int:
        self.load()
        return int(self.events.get(key, 0))

    def point_index(self, lat: float, lon: float, max_km: float = POINT_MATCH_KM, name: str | None = None) -> int:
        """The bundled PFM point at these coordinates, or 0xFFFF. Some points
        share coordinates (402/454, 1000/1177, 1617/1840), so a point whose
        name matches wins over the nearest; without one the lowest index does."""
        self.load()
        want = " ".join((name or "").split()).upper()
        best, best_km = 0xFFFF, max_km
        for i, p in enumerate(self.points):
            km = _haversine_km(lat, lon, p[2], p[3])
            if km >= max_km:
                continue
            if want and " ".join(str(p[0]).split()).upper() == want:
                return i
            if km < best_km:
                best, best_km = i, km
        return best


tables = _Tables()


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class SeqCounter:
    """Per-bot u8 message counter (wraps). What builders number with it is
    provisional: Scheduler.transmit restamps the seq (and a text reply's
    group) when the packet actually goes on air."""

    def __init__(self, start: int = 0):
        self._n = start & 0xFF

    def next(self) -> int:
        n = self._n
        self._n = (n + 1) & 0xFF
        return n


def bot_id(public_key_hex: str | None) -> int:
    """The `bot` header field: first two bytes of the public key, LE."""
    if not public_key_hex or len(public_key_hex) < 4:
        return 0
    return int.from_bytes(bytes.fromhex(public_key_hex[:4]), "little")


def now_min() -> int:
    return int(time.time() // 60)


# -- Warnings ---------------------------------------------------------------------------

_unknown_offices: set[str] = set()


def warning_identity(w: dict) -> tuple[int, int, int] | None:
    """(event, office index, etn), or None for products without an ETN (SPS)
    and for an office index.json does not list: sent as 0 it would be ABQ."""
    etn = w.get("vtec_etn")
    if etn is None:
        return None
    event = int(w.get("event_code") or 0)
    if not event:
        return None
    office = tables.office(w.get("vtec_office"))
    if office is None:
        code = str(w.get("vtec_office"))
        if code not in _unknown_offices:
            _unknown_offices.add(code)
            logger.warning("Office %s is not in index.json; its warnings are not sent", code)
        return None
    return event, office, int(etn) & 0xFFFF


def identity_str(identity: tuple[int, int, int]) -> str:
    """'SV.W.EWX.42' for logs and the request grammar."""
    tables.load()
    code = next((k for k, v in tables.events.items() if v == identity[0]), str(identity[0]))
    return f"{code}.{tables.office_code(identity[1])}.{identity[2]}"


def parse_identity(text: str) -> tuple[int, int, int] | None:
    """'SV.W.EWX.42' -> (event, office index, etn)."""
    parts = text.strip().upper().split(".")
    if len(parts) != 4 or not parts[3].isdigit():
        return None
    event = tables.event_code(parts[0] + "." + parts[1])
    if not event or parts[2] not in tables.offices:
        return None
    return event, tables.office(parts[2]), int(parts[3]) & 0xFFFF


# The separators a request may put between its arguments: the app sends the
# compact form, people type spaces and commas.
_ARG_SPLIT = re.compile(r"[\s,]+")
# `>f 35.687,-105.938`: two signed decimals and a comma, and nothing else.
# The comma is what tells it from a place, so `>f austin, tx` is still a place.
_LATLON = re.compile(
    r"\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\Z"
)


def parse_sweep_request(arg: str) -> tuple[bool, list[str]] | None:
    """`>wmap [all] [states]` -> (advisories, state codes), None when it
    cannot be read (spec 12, revision 10: Not available reason 1).

    State codes come run together, spaced or comma separated, in any case:
    `TX`, `tx, ok`, `all TXOKLA`. An empty list is the whole country. `ALL` on
    its own is the advisories level and never Alabama plus a stray L, which is
    why it is matched as a whole token; `ALLA` is four characters and so is
    Alabama and Louisiana.
    """
    tables.load()
    known = set(tables.states)
    advisories = False
    codes: list[str] = []
    for token in _ARG_SPLIT.split((arg or "").strip().upper()):
        if not token:
            continue
        if token == "ALL":
            advisories = True
            continue
        if len(token) % 2:
            return None
        for i in range(0, len(token), 2):
            code = token[i:i + 2]
            if code not in known:
                return None
            if code not in codes:
                codes.append(code)
    # More states than a sweep can name is refused rather than quietly cut:
    # a map covering twelve of the fifteen states asked for is a wrong map.
    if len(codes) > v5.MAX_SWEEP_SCOPE_STATES:
        return None
    # Wire order is the state index, so two phones asking for the same states
    # in different words get the same bytes.
    codes.sort(key=tables.states.index)
    return advisories, codes


def parse_parts_request(arg: str) -> tuple[int, list[int]] | None:
    """`>part <group> <idx>[,<idx>…]` -> (group, indexes), None when it cannot
    be read. Decimal, spaces or commas between the indexes."""
    tokens = [t for t in _ARG_SPLIT.split((arg or "").strip()) if t]
    if len(tokens) < 2 or not all(t.isdigit() for t in tokens):
        return None
    group = int(tokens[0])
    indexes = sorted({int(t) for t in tokens[1:]})
    if group > 0xFF or indexes[-1] > 0xFF:
        return None
    return group, indexes


def parse_latlon(arg: str) -> tuple[float, float] | None:
    """`>f <lat>,<lon>` -> the coordinate, None when this is not one.

    Out of range reads as not a coordinate: the caller answers Not available
    reason 1 either way, and a place is never spelled with a comma between two
    numbers."""
    m = _LATLON.match(arg or "")
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return lat, lon


_RADAR_ZOOM = re.compile(r"(?:^|\s)z([0-9])\s*$", re.IGNORECASE)
_RADAR_LOOP = re.compile(r"(?:^|\s)loop((?:\s+[0-9]{4}){0,5})\s*$", re.IGNORECASE)


def parse_radar_request(arg: str) -> "tuple[str, int, list[int] | None] | None":
    """`>radar [place] [z<n>] [loop [HHMM ...]]` -> (place, zoom, held).

    None when the zoom is not 0..3.  `held` is None for a single picture and
    otherwise the pictures the app already holds, as UTC minutes of the day
    (spec 13.5): `loop 2338 2353` is [1418, 1433].  Read from the end: the
    loop, then the zoom, each its own token; anything else is part of the
    place, so `>radar zion il` and `>radar loop tx` are towns."""
    arg = (arg or "").strip()
    held = None
    m = _RADAR_LOOP.search(arg)
    if m:
        held = [int(g[:2]) * 60 + int(g[2:]) for g in m.group(1).split()
                if int(g[:2]) < 24 and int(g[2:]) < 60]
        arg = arg[:m.start()].strip()
    m = _RADAR_ZOOM.search(arg)
    if not m:
        return arg, 0, held
    zoom = int(m.group(1))
    if zoom > v5.MAX_RADAR_ZOOM:
        return None
    return arg[:m.start()].strip(), zoom, held


def radar_message(seq: int, bot: int, tile, picture, frame) -> "bytes | None":
    """One Radar packet for a cut tile: fine when it fits, else coarse.

    None when the tile is partial and no whole coarse cell is inside the
    picture, which leaves nothing honest to send."""
    from meshcore_weather.radar.tiles import coarse_bounds
    common = dict(taken_min=int(picture.taken.timestamp() // 60), south=tile.south, west=tile.west,
                  zoom=tile.zoom, product=frame.index, source=v5.SOURCE_GOES)
    try:
        return v5.encode_radar(seq, bot, rows=tile.rows, bounds=tile.bounds, **common)
    except ValueError:
        pass
    bounds = coarse_bounds(tile.bounds)
    if tile.bounds is not None and bounds is None:
        return None
    rows = v5.radar_coarsen(tile.rows)
    if bounds is not None:
        r0, r1, c0, c1 = bounds
        rows = [[v if r0 <= r <= r1 and c0 <= c <= c1 else 0 for c, v in enumerate(row)]
                for r, row in enumerate(rows)]
    return v5.encode_radar(seq, bot, rows=rows, bounds=bounds, **common)


def expires_min(w: dict) -> int:
    exp = w.get("expires_at")
    if isinstance(exp, datetime):
        return int(exp.timestamp() // 60)
    return now_min() + int(w.get("expiry_minutes") or 60)


def issued_min(w: dict) -> int | None:
    """When the product was issued, in Unix minutes, or None when the extractor
    could not tell.

    This is the EMWIN product's own issuance — pyIEM's `valid`, the MND/WMO
    time in the product text, carried through the VTEC lifecycle replay as
    `EventState.issued_at` (protocol/vtec_events.py) — never the time the bot
    received the file. A phone that was out of range for three hours must still
    be able to say when the warning began.
    """
    issued = w.get("issued_at")
    if isinstance(issued, datetime):
        return int(issued.timestamp() // 60)
    return None


def begins_min(w: dict) -> int | None:
    """When the product takes effect, in Unix minutes, when that is later than
    its issuance, else None (revision 12).

    `onset_at` is the earliest VTEC begin time among the event's active zones
    (protocol/warnings.py, `EventState.onset_at`). A product in effect from
    issuance, a continuation issued after it began, or one whose issue time
    is unknown has no start to send: the wire can only carry one after an
    issue time."""
    onset, issued = w.get("onset_at"), issued_min(w)
    if not isinstance(onset, datetime) or issued is None:
        return None
    start = int(onset.timestamp() // 60)
    return start if start > issued else None


def warning_fingerprint(w: dict) -> tuple:
    """What counts as a material change: expiry changed, tags changed, area
    changed. Wording changes do not. A real expiry counts to the minute (a
    21:00 warning extended to 21:25 must reach the app); an invented one
    (no expiry, or until further notice) moves with the clock, so it only
    counts in 30-minute steps.

    The issue time is deliberately not here. It is a property of the identity,
    not of the current state, and after a restart it is read from whichever
    products are still in the store, so counting it would resend warnings for
    no reason a phone could see.

    The start (revision 12) is here, to the minute, but only when there is one
    to send: a watch moved from Wednesday evening to Wednesday afternoon has
    to reach the phone. A product without one keeps the fingerprint it had
    before revision 12, so the upgrade resends only the warnings that gain a
    start, which are the ones phones have been showing wrongly."""
    exact = isinstance(w.get("expires_at"), datetime) and not w.get("expires_estimated")
    fp = (expires_min(w) if exact else expires_min(w) // 30, int(w.get("hail_qin") or 0),
          int(w.get("wind_mph") or 0),
          int(w.get("tornado_tag") or 0), int(w.get("flood_source") or 0), int(w.get("flood_damage") or 0),
          tuple(sorted(w.get("ugcs") or [])), len(w.get("vertices") or []))
    start = begins_min(w)
    return fp if start is None else fp + (start,)


def _decimate(points: list, n: int) -> list:
    if len(points) <= n:
        return points
    step = (len(points) - 1) / (n - 1)
    return [points[round(i * step)] for i in range(n)]


def _runs_first(areas: list, keep) -> list:
    """The area runs, those naming any UGC in `keep` first, in wire order
    within each group, so a cut to 30 (or 12, or 6) runs keeps the bot's own
    area. County numbers are odd, so each county is a run of its own, and a
    watch over more than 30 counties of one office (LWX's on 2026-10-16: 49
    counties and 14 marine zones, 50 runs) lost every run after the 30th in
    state order, whatever the bot covered. Spec 3 has no flag for a cut area
    list, so this is the most the wire allows."""
    if not keep:
        return areas
    index = {code: i for i, code in enumerate(tables.states)}
    wanted = set()
    for raw in keep:
        ugc = str(raw).upper()
        if len(ugc) == 6 and ugc[2] in ("C", "Z") and ugc[3:].isdigit() and ugc[:2] in index:
            wanted.add((index[ugc[:2]], ugc[2] == "C", int(ugc[3:])))

    def touches(r) -> bool:
        state, is_county, start, run = r
        return any((state, is_county, n) in wanted for n in range(start, start + run))
    return [r for r in areas if touches(r)] + [r for r in areas if not touches(r)]


def warning_message(seq: int, bot: int, w: dict, update: bool = False,
                    source: int | None = None, keep=None) -> bytes | None:
    """One Warning packet. `source` defaults to the source of the product this
    warning was extracted from, which the entry carries (spec 2.3).

    `keep`: UGC codes (the bot's coverage, or the county asked about) whose
    runs survive first when the area list is longer than a packet carries;
    the runs that go out are still in ascending order."""
    ident = warning_identity(w)
    if ident is None:
        return None
    if source is None:
        source = WeatherStore.product_source(w)
    event, office, etn = ident
    polygon = [(float(la), float(lo)) for la, lo in (w.get("vertices") or [])]
    if len(polygon) < 3:
        polygon = []
    tables.load()
    ranked = _runs_first(v5.areas_from_ugcs(list(w.get("ugcs") or []), tables.states), keep)

    def areas(n: int) -> list:
        """The first n runs by rank, back in wire order."""
        return sorted(ranked[:n])

    kwargs = dict(event=event, office=office, etn=etn, expires_min=expires_min(w),
                  tornado=int(w.get("tornado_tag") or 0), flood_source=int(w.get("flood_source") or 0),
                  flood_damage=int(w.get("flood_damage") or 0), hail_qin=int(w.get("hail_qin") or 0),
                  wind_mph=int(w.get("wind_mph") or 0), update=update,
                  issued_min=issued_min(w), begins_min=begins_min(w), source=source)
    # Fit into one packet: shed detail in the order a phone can best do without.
    # The issue time and the start are not in this list: two bytes each, the
    # one what lets the phone say when the warning was issued rather than when
    # the radio heard it, the other whether it is in effect at all, and a
    # vertex costs twice as much (spec 3, revisions 5 and 12).
    attempts = [
        (polygon[:30], areas(30)),
        (_decimate(polygon, 16), areas(30)),
        (_decimate(polygon, 16), areas(12)),
        (_decimate(polygon, 10), areas(6)),
        (_decimate(polygon, 8), []),
        ([], areas(30)),
    ]
    for poly, ar in attempts:
        if not poly and not ar:
            continue
        try:
            return v5.encode_warning(seq, bot, polygon=poly or None, areas=ar or None, **kwargs)
        except ValueError:
            continue
    logger.warning("Warning %s does not fit in one packet even without detail", identity_str(ident))
    return None


def cancel_message(seq: int, bot: int, identity: tuple[int, int, int], reason: int = 0) -> bytes:
    event, office, etn = identity
    return v5.encode_cancel(seq, bot, event=event, office=office, etn=etn, reason=reason)


def digest_message(seq: int, bot: int, active: list[dict], feed_health: int,
                   source: int = v5.SOURCE_UNSTATED) -> bytes:
    """The active-warning digest. It is aggregated from many products, so
    `source` is the store-wide answer its caller got from
    `WeatherStore.products_source()` (spec 2.3)."""
    entries = []
    for w in sorted(active, key=expires_min):
        ident = warning_identity(w)
        if ident is None:
            continue
        entries.append((ident[0], ident[1], ident[2], expires_min(w)))
        if len(entries) >= MAX_DIGEST:
            break
    return v5.encode_digest(seq, bot, now_min=now_min(), feed_health=feed_health, entries=entries,
                            source=source)


def feed_health(store: WeatherStore, offices: set[str]) -> int:
    """Minutes since the newest product from any of the home offices, in
    4-minute units, 255 when nothing was ever received."""
    newest = None
    for prod in store._products.values():
        if prod.office in offices and (newest is None or prod.timestamp > newest):
            newest = prod.timestamp
    if newest is None:
        return 255
    age_min = (datetime.now(timezone.utc) - newest).total_seconds() / 60
    return max(0, min(255, int(age_min // 4)))


# -- Observations -----------------------------------------------------------------------


def coverage_stations(center: tuple[float, float] | None, radius_km: float, store: WeatherStore,
                      limit: int = MAX_OBS_STATIONS) -> list[str]:
    """ICAO stations inside the coverage circle that reported recently,
    nearest first."""
    if center is None:
        return []
    resolver.load()
    now = datetime.now(timezone.utc)
    out: list[tuple[float, str]] = []
    for icao, st in resolver._stations.items():
        try:
            km = _haversine_km(center[0], center[1], st["la"], st["lo"])
        except (KeyError, TypeError):
            continue
        if km > radius_km or tables.station(icao) is None:
            continue
        raw = store._find_metar_raw(icao)
        if not raw or (now - raw[1]) > timedelta(minutes=OBS_MAX_AGE_MIN):
            continue
        out.append((km, icao))
    return [icao for _, icao in sorted(out)[:limit]]


def station_obs_message(seq: int, bot: int, store: WeatherStore, icao: str,
                        source: int | None = None,
                        max_km: float = OBS_SUBSTITUTE_KM) -> bytes | None:
    """`>o ICAO`: that station's own report, or, when it has nothing fresh,
    the nearest station within `max_km` of it that has one (spec 14,
    revision 8). Always a batch of one, under the index of the station that
    actually reported, so the phone files it under the right airport.

    This is what the text path has always done for a place ("the nearest
    station THAT ACTUALLY REPORTS", services.observation_for). The app names
    the station nearest the place from its own bundled list, which cannot
    know that 309 of those 2,237 stations send nothing on the feed: Dayton's
    nearest, Wright-Patterson AFB, never reports, so every `>o KFFO` came back
    Not available while Dayton International, 16.6 km away, reported hourly.
    When nothing within `max_km` has a fresh report, the same walk is made
    again admitting reports up to `OBS_STALE_MAX_AGE_MIN` old: a batch of
    one whose `ts` is that report's own time, so the phone dates it exactly
    and shows it with its age. None only when nothing within `max_km` has
    reported in twelve hours.
    """
    icao = icao.upper()
    resolver.load()
    here = resolver._stations.get(icao)
    near: list[tuple[float, str]] = []
    try:
        lat, lon = here["la"], here["lo"]
    except (KeyError, TypeError):
        lat = lon = None                 # not in stations.json: no neighbours, its own report only
    for other, st in resolver._stations.items():
        if lat is None or other == icao or tables.station(other) is None:
            continue
        try:
            km = _haversine_km(lat, lon, st["la"], st["lo"])
        except (KeyError, TypeError):
            continue
        if km <= max_km:
            near.append((km, other))
    # Nearest first, stopping at the first that answers: each look is a scan
    # of the store, and a dense metro can put a dozen stations in range. A
    # fresh neighbour beats the station's own stale report, as it does for
    # the text path (services.observation_for).
    for max_age_min in (OBS_MAX_AGE_MIN, OBS_STALE_MAX_AGE_MIN):
        msg = obs_message(seq, bot, store, [icao], source=source, max_age_min=max_age_min)
        if msg is not None:
            if max_age_min > OBS_MAX_AGE_MIN:
                logger.info("Observations: %s has nothing fresh within %.0f km; answered with "
                            "its own report, over %d min old", icao, max_km, OBS_MAX_AGE_MIN)
            return msg
        for km, other in sorted(near):
            msg = obs_message(seq, bot, store, [other], source=source, max_age_min=max_age_min)
            if msg is not None:
                logger.info("Observations: %s has nothing fresh; answered with %s, %.0f km from it%s",
                            icao, other, km, "" if max_age_min == OBS_MAX_AGE_MIN else ", not current either")
                return msg
    return None


def _humidity(temp_f: int | None, dew_f: int | None) -> int | None:
    if temp_f is None or dew_f is None:
        return None
    t, d = (temp_f - 32) * 5 / 9, (dew_f - 32) * 5 / 9
    a, b = 17.625, 243.04
    rh = 100 * math.exp(a * d / (b + d)) / math.exp(a * t / (b + t))
    return max(0, min(100, int(round(rh))))


def _feels_delta(temp_f: int | None, rh: int | None, wind_mph: int | None) -> int:
    if temp_f is None:
        return 0
    t = float(temp_f)
    if t >= 80 and rh is not None and rh >= 40:
        hi = (-42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh - 0.00683783 * t * t
              - 0.05481717 * rh * rh + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh
              - 0.00000199 * t * t * rh * rh)
        return int(round(hi - t))
    if t <= 50 and wind_mph and wind_mph >= 3:
        wc = 35.74 + 0.6215 * t - 35.75 * wind_mph ** 0.16 + 0.4275 * t * wind_mph ** 0.16
        return int(round(wc - t))
    return 0


def obs_message(seq: int, bot: int, store: WeatherStore, stations: list[str],
                source: int | None = None, max_age_min: int = OBS_MAX_AGE_MIN) -> bytes | None:
    """One Observations batch, with every station's own age (spec 6).

    The batch's `ts` is the newest METAR in it and each station says how far
    behind that its own report is, so a phone can write "as of 8:24 PM" under
    the right temperature instead of stamping the whole batch with one time
    that is true of one station.

    The ages are all or nothing, and they do not fit beside thirteen stations
    (152 bytes already, 159 with them, over the 157 a bot sends). A full batch
    therefore drops its farthest station — the list arrives nearest first —
    rather than leave the phone to guess which readings the timestamp describes.

    `max_age_min` admits reports up to that old; the hourly batch keeps the
    default. A caller admitting stale reports (`station_obs_message`) gets
    only the stations the age nibble can place honestly: one more than
    `OBS_AGE_MAX_MIN` behind the newest would go out saturated, and the phone
    would date it fresher than it is.

    A batch is aggregated from many products, so `source` defaults to the
    store-wide answer: `mixed` whenever the store holds both kinds (spec
    2.2.1).
    """
    if source is None:
        source = store.products_source()
    now = datetime.now(timezone.utc)
    rows = []
    for icao in stations[:MAX_OBS_STATIONS]:
        idx = tables.station(icao)
        raw = store._find_metar_raw(icao)
        if idx is None or not raw:
            continue
        text, ts = raw
        # The product's time is when the collective arrived, the same for every
        # station in it; the report's own DDHHMMZ group is when it was taken.
        ts = metar_observed_at(text, ts) or ts
        if (now - ts) > timedelta(minutes=max_age_min):
            continue
        f = parse_metar(text)
        if not f:
            continue
        # A group the METAR lacks is None and goes out as the wire's unknown.
        # The pressure byte holds 29.00-31.54 inHg: a deep low or an Alaskan
        # high is unknown rather than an error that loses every station.
        pressure = f["pressure_inhg"]
        if pressure is not None and not 0 <= round((pressure - 29.00) * 100) <= 254:
            pressure = None
        vis = f["visibility_mi"]
        rh = _humidity(f["temp_f"], f["dewpoint_f"])
        row = {
            "station": idx, "temp_f": f["temp_f"], "dewpoint_f": f["dewpoint_f"],
            "wind_dir_deg": f["wind_dir_deg"], "sky": f["sky_code"],
            "wind_mph": f["wind_speed_mph"], "gust_mph": f["wind_gust_mph"] or 0,
            "visibility_mi": None if vis is None else int(vis),      # whole miles, rounded down: 1/2SM is 0
            "pressure_inhg": pressure,
            "humidity_pct": rh, "feels_delta_f": _feels_delta(f["temp_f"], rh, f["wind_speed_mph"]),
        }
        try:
            v5.encode_obs(0, 0, ts_min=0, stations=[row])     # anything else unencodable costs one station
        except ValueError as e:
            logger.warning("Observation %s left out: %s", icao, e)
            continue
        rows.append((row, ts))
    if max_age_min > OBS_MAX_AGE_MIN and rows:
        # Honest ages only: a nibble is 0-150 minutes behind the batch's
        # newest, and 15 means "150 or more" (spec 6.1), which the phone
        # cannot date. Below the rounding edge, never at it.
        newest = max(ts for _, ts in rows)
        limit = timedelta(minutes=v5.OBS_AGE_MAX_MIN - v5.OBS_AGE_STEP_MIN // 2)
        rows = [(row, ts) for row, ts in rows if (newest - ts) < limit]
    if not rows:
        return None
    while True:
        newest = max(ts for _, ts in rows)
        batch = [dict(row, age_min=(newest - ts).total_seconds() / 60) for row, ts in rows]
        try:
            return v5.encode_obs(seq, bot, ts_min=int(newest.timestamp() // 60), stations=batch,
                                 source=source)
        except ValueError:
            if len(rows) == 1:
                raise
            # Only the size can fail here: every row encoded on its own above.
            # The farthest station goes, and `ts` is recomputed in case it was
            # the one holding the newest report.
            rows.pop()
            logger.info("Observations: dropped the farthest station to carry the per-station ages "
                        "(%d stations left)", len(rows))


# -- Forecast ---------------------------------------------------------------------------

_COND_THUNDER, _COND_FROST, _COND_FOG, _COND_HIGH_WIND = 0x01, 0x02, 0x04, 0x08
_COND_FREEZING_RAIN, _COND_HEAVY_SNOW = 0x10, 0x40


def forecast_message(seq: int, bot: int, store: WeatherStore, lat: float, lon: float,
                     point: int | None = None, source: int | None = None) -> bytes | None:
    """`point` is the bundle index a request or job named. The answer carries
    it when the forecast found is at that point's coordinates; a substitute
    point carries its own index, or 0xFFFF.

    `source` defaults to the source of the PFM product this was rendered from
    (spec 2.3)."""
    from meshcore_weather.core import services
    from meshcore_weather.parser.pfm import downsample_to_daily
    found = services.nearest_pfm_point(store, lat, lon)
    if found is None:
        return None
    pt, prod, _km = found
    if source is None:
        source = store.product_source(prod)
    daily = downsample_to_daily(pt, max_days=7)
    # Entries are consecutive days: anything after a missing date is dropped.
    daily = [d for i, d in enumerate(daily) if (d.local_date - daily[0].local_date).days == i]
    if not daily:
        return None
    periods = []
    for d in daily:
        e = d.to_encoder_dict()
        flags = int(e.get("condition_flags") or 0)
        periods.append({
            "high_f": None if e["high_f"] == 127 else e["high_f"],
            "low_f": None if e["low_f"] == 127 else e["low_f"],
            "pop_pct": e.get("precip_pct"), "sky": int(e.get("sky_code") or 0),
            "thunder": bool(flags & _COND_THUNDER),
            # Wintry precipitation only: a frosty but dry night is not a snow icon.
            "wintry": bool(flags & (_COND_FREEZING_RAIN | _COND_HEAVY_SNOW)),
            "windy": bool(flags & _COND_HIGH_WIND), "fog": bool(flags & _COND_FOG),
            "wind_dir_deg": (int(e.get("wind_dir_nibble") or 0) * 22.5), "wind_mph": int(e.get("wind_speed_5mph") or 0) * 5,
        })
    issued = pt.issue_time or prod.timestamp
    # Day ids count from the issue time's local date at the point (spec 7).
    # An evening issuance often has no usable "today", so its first entry is
    # tomorrow: first = 2, or the app labels tomorrow as today.
    first = 2 * max(0, (daily[0].local_date - pt.local_date(issued)).days)
    idx = tables.point_index(pt.lat, pt.lon, name=pt.name)
    if point is not None and 0 <= point < len(tables.points):
        p = tables.points[point]
        if _haversine_km(pt.lat, pt.lon, p[2], p[3]) < POINT_MATCH_KM:
            idx = point               # shared coordinates: answer under the index asked for
    return v5.encode_forecast(seq, bot, point=idx,
                              issued_min=int(issued.timestamp() // 60), first_period=first,
                              periods=periods[:14], source=source)


# -- Coverage ---------------------------------------------------------------------------


def coverage_facts(coverage, home: tuple[float, float] | None = None, radius_km: float = 0,
                   station_cap: int = OBS_STATIONS_WITH_AGES) -> dict:
    """What the bot covers, as the numbers both the Coverage message and the
    `cov` text reply are built from: the centre, the radius, the NWS offices
    and the covered zones as UGC runs.

    A set too big for one packet is cut to the runs that account for the most
    zones and the cut is flagged, so a zone missing from the wire means "not
    stated", never "not covered" (spec 10).
    """
    tables.load()
    resolver.load()
    zones = sorted(coverage.zones) if coverage is not None else []
    sources = (coverage.sources if coverage is not None else None) or {}
    center = (coverage.center if coverage is not None else None) or home
    configured = (coverage.radius_km if coverage is not None else 0) or radius_km or 0
    radius = int(round(float(configured)))
    # A circle is only claimed when there is a centre and zones fell inside it.
    # Without them the runs are the whole statement, and a bot with no centre
    # sends 0,0 — "not stated", the same reading this spec gives an advert.
    if center is None or not zones:
        radius = 0

    # The offices are the ones serving the covered zones, plus any the
    # operator named outright. An office index.json does not list is left out:
    # sent as 0 it would read as ABQ.
    codes = {resolver._zones[z]["w"] for z in zones if z in resolver._zones}
    codes |= {str(w).upper() for w in (sources.get("wfos") or [])}
    all_idx = sorted({i for c in codes if (i := tables.office(c)) is not None})
    offices_cut = len(all_idx) > v5.MAX_COVERAGE_OFFICES
    office_idx = all_idx[:v5.MAX_COVERAGE_OFFICES]

    runs = v5.areas_from_ugcs(zones, tables.states)
    zones_cut = len(runs) > v5.MAX_COVERAGE_RUNS
    if zones_cut:
        # Keep the runs that cover the most zones, then put them back in wire
        # order: the largest true picture the packet can hold.
        runs = sorted(sorted(runs, key=lambda r: -r[3])[:v5.MAX_COVERAGE_RUNS])

    place = None
    for city in (sources.get("cities") or []):
        loc = resolver.resolve(city)
        if loc and loc.get("name"):
            place = loc["name"]
            break
    if place is None and center is not None:
        place = (resolver.resolve_by_coords(center[0], center[1]) or {}).get("name")

    return {
        "center": center,
        "radius_km": min(radius, 0xFFFF),
        "place": place,
        "zones": zones,
        # `offices` is every office, for the text reply, which has no packet to
        # fit; `office_idx` is what the wire carries, cut when it has to be.
        "offices": [tables.office_code(i) for i in all_idx],
        "office_idx": office_idx,
        "areas": runs,
        # The cap, not a live count: the station list is recomputed per batch
        # (spec 6), so a count would describe this hour, not the coverage.
        "stations": station_cap if (center is not None and radius) else 0,
        "zones_cut": zones_cut,
        "offices_cut": offices_cut,
    }


def coverage_message(seq: int, bot: int, coverage, home: tuple[float, float] | None = None,
                     radius_km: float = 0, station_cap: int = OBS_STATIONS_WITH_AGES) -> bytes | None:
    """One Coverage packet, or None when the bot knows neither a centre nor a
    zone and so has nothing to state."""
    f = coverage_facts(coverage, home, radius_km, station_cap)
    if f["center"] is None and not f["areas"]:
        return None
    lat, lon = f["center"] or (0.0, 0.0)
    return v5.encode_coverage(seq, bot, lat=lat, lon=lon, radius_km=f["radius_km"],
                              stations=f["stations"], offices=f["office_idx"], areas=f["areas"],
                              zones_cut=f["zones_cut"], offices_cut=f["offices_cut"])


# -- Area sweep -------------------------------------------------------------------------
#
# The national picture of what is active, as runs of UGC numbers (spec 12).
# The phone already ships every zone and county outline, so the mesh carries
# numbers and the phone draws the map. It is never scheduled and never cheap:
# see AppResponder for the limits that keep it off the air.

#: Most severe first. The same order the bot has always ranked hazards in
#: (`services.warnings_for_location`): warnings, then watches, then
#: advisories and statements, which VTEC treats as one level.
SWEEP_SIG_RANK = {"W": 0, "A": 1, "Y": 2, "S": 3}
#: `>wmap`: warnings and watches.
SWEEP_SIGNIFICANCE = ("W", "A")
#: `>wmap all`: advisories and statements too.
SWEEP_SIGNIFICANCE_ALL = ("W", "A", "Y", "S")

_event_sig: dict[int, str] = {}


def _event_significance(code: int) -> str:
    """The VTEC significance letter behind a wire event code.

    Products without one (SPS, and anything the table writes without a dot)
    rank as advisories, which is what `severity_for` has always called them.
    """
    tables.load()
    if not _event_sig:
        for key, value in tables.events.items():
            _event_sig[int(value)] = key.split(".")[1] if "." in str(key) else "S"
    return _event_sig.get(int(code), "S")


def sweep_significance(w: dict) -> str:
    """One warning's significance letter, defaulting to a statement."""
    sig = str(w.get("vtec_significance") or "S").upper()
    return sig if sig in SWEEP_SIG_RANK else "S"


def sweep_rank(w: dict) -> tuple[int, int]:
    """How a warning competes for an area: most severe first, then the newest
    onset. Two warnings can cover one county and only one event code fits in
    the entry, so the one a phone must draw is the worse of them."""
    return (SWEEP_SIG_RANK[sweep_significance(w)], -int(w.get("onset_unix_min") or 0))


def sweep_entries(active: list[dict], advisories: bool = False) -> list[tuple]:
    """Active warnings -> ordered sweep entries `(event, state, is_county,
    start, run)`.

    Each area keeps the most severe event covering it; each state's numbers
    then collapse into runs of consecutive values under one event, split at
    `MAX_SWEEP_RUN`. The result is ordered most severe first, then by state,
    then by `start`, so a caller that has to cut keeps the worst of it.
    """
    tables.load()
    known = {int(v) for v in tables.events.values()}
    state_index = {code: i for i, code in enumerate(tables.states)}
    allowed = set(SWEEP_SIGNIFICANCE_ALL if advisories else SWEEP_SIGNIFICANCE)

    # (state, is_county, number) -> (rank, event)
    best: dict[tuple[int, bool, int], tuple[tuple[int, int], int]] = {}
    for w in active:
        if sweep_significance(w) not in allowed:
            continue
        event = int(w.get("event_code") or 0)
        if event not in known:
            continue
        rank = sweep_rank(w)
        for raw in (w.get("ugcs") or []):
            ugc = str(raw).strip().upper()
            if len(ugc) != 6 or ugc[2] not in ("C", "Z") or not ugc[3:].isdigit():
                continue
            state = state_index.get(ugc[:2])
            if state is None:
                continue
            number = int(ugc[3:])
            if number > v5.MAX_SWEEP_START:
                continue
            key = (state, ugc[2] == "C", number)
            current = best.get(key)
            if current is None or rank < current[0]:
                best[key] = (rank, event)

    # Consecutive numbers of one state, one kind and one event become a run.
    # The event has to match: an entry carries one code, and a run that mixed
    # two would paint the worse hazard over an area that does not have it.
    runs: list[list] = []
    for state, is_county, number in sorted(best):
        event = best[(state, is_county, number)][1]
        if runs:
            last = runs[-1]
            if (last[0] == event and last[1] == state and last[2] == is_county
                    and last[3] + last[4] == number and last[4] < v5.MAX_SWEEP_RUN):
                last[4] += 1
                continue
        runs.append([event, state, is_county, number, 1])

    runs.sort(key=lambda r: (SWEEP_SIG_RANK.get(_event_significance(r[0]), 3),
                             r[1], r[3], r[2]))
    return [(event, state, is_county, start, run) for event, state, is_county, start, run in runs]


def area_sweep_messages(seq: SeqCounter, bot: int, store: WeatherStore,
                        advisories: bool = False, source: int | None = None,
                        built_min: int | None = None,
                        states: list[str] | None = None) -> list[bytes]:
    """`>wmap`: the active alerts as an Area sweep.

    Coverage never filters it — the point is a picture wider than the bot's
    own area — so it reads the store with `coverage=None`. Empty when nothing
    the tables know is active, which the caller answers as Not available.

    `states` scopes the sweep to those state codes (spec 12, revision 10).
    A scoped sweep names them in its scope entries and carries the alerts of
    those states only, so it is never empty: a state with nothing active is
    answered by its scope entry alone.

    A sweep is aggregated from every product the bot holds, so `source`
    defaults to the store-wide answer (spec 2.3).
    """
    from meshcore_weather.protocol.warnings import extract_active_warnings
    tables.load()
    if source is None:
        source = store.products_source()
    scope = [tables.states.index(code) for code in (states or [])]
    entries = sweep_entries(extract_active_warnings(store, coverage=None),
                            advisories=advisories)
    if scope:
        # Runs never cross a state, so the scope is a filter on the entries
        # rather than on the warnings: a warning over Texas and Oklahoma sent
        # to a Texas sweep contributes its Texas runs and nothing else.
        wanted = set(scope)
        entries = [e for e in entries if e[1] in wanted]
    if not entries and not scope:
        return []
    room = v5.MAX_SWEEP_ENTRIES - len(scope)
    cut = len(entries) > room
    start = seq.next()
    msgs = v5.sweep_packets(start, bot, built_min=now_min() if built_min is None else built_min,
                            entries=entries, cut=cut, advisories=advisories, source=source,
                            scope=scope)
    for _ in msgs[1:]:
        seq.next()
    logger.info("Area sweep%s: %d entries, %d packet(s), %d bytes%s",
                f" of {' '.join(states)}" if states else " (national)",
                min(len(entries), room), len(msgs),
                sum(len(m) for m in msgs),
                f", cut from {len(entries)}" if cut else ", not cut")
    return msgs


# -- Text and errors -------------------------------------------------------------------


_SENTENCE_ENDS = (".", "!", "?")


def _fits(text: str) -> bool:
    """Does this text go out as at most MAX_TEXT_CHUNKS chunks?

    Asked of v5 itself rather than computed here: the chunker backs off to
    UTF-8 code point boundaries, so the answer is not simply the byte count
    over 149.
    """
    try:
        v5.text_chunks(0, 0, subject=0, text=text)
        return True
    except ValueError:
        return False


def fit_text(text: str) -> tuple[str, bool]:
    """Trim `text` to what eight chunks hold, and say whether it was cut.

    The ceiling is real — 8 x 149 bytes — so the only question is where to
    stop. A forecast discussion cut mid-word reads as a transmission fault;
    cut after a full stop it reads as an excerpt, which is what it is. So:
    the last sentence boundary (a `.`, `!` or `?` followed by a space) that
    fits, else the last word boundary, and the cut flag carries the rest of
    the meaning (spec 8). No ellipsis: the flag is the signal and every
    byte is airtime.
    """
    if _fits(text):
        return text, False

    # The longest prefix that fits. The chunker is greedy, so a shorter
    # prefix never needs more chunks and this bisects cleanly.
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _fits(text[:mid]):
            lo = mid
        else:
            hi = mid - 1
    end = lo

    # `end` is short of the whole text (it did not fit), so text[end] exists:
    # it is the first character the cut drops. A boundary sitting exactly
    # there counts, which is why the sentence scan starts at end - 1 and the
    # word scan at end.
    for i in range(end - 1, -1, -1):
        if text[i] in _SENTENCE_ENDS and text[i + 1] == " ":
            return text[:i + 1].rstrip(), True
    for i in range(end, -1, -1):
        if text[i] == " ":
            return text[:i].rstrip(), True
    # One word longer than the whole budget. Nothing to cut on cleanly, and
    # an empty reply helps nobody, so the hard prefix goes out flagged.
    return text[:end].rstrip(), True


def text_messages(seq: SeqCounter, bot: int, subject: int, text: str,
                  source: int = v5.SOURCE_UNSTATED) -> list[bytes]:
    """One reply as Text chunks, numbered from the counter.

    The counter advances exactly once per chunk transmitted, so the caller's
    seq accounting is unchanged whether or not the text had to be cut.
    """
    text = " ".join(text.split())
    body, cut = fit_text(text)
    start = seq.next()
    msgs = v5.text_chunks(start, bot, subject=subject, text=body, source=source, cut=cut)
    for _ in msgs[1:]:
        seq.next()
    return msgs


def request_letter(request: str) -> str:
    """The letter a Not available carries for a request word (spec 9): its
    first, except `radar`, whose `r` was already `rain`'s."""
    word = request.lstrip(">").strip().lower()
    return v5.RADAR_REQUEST_LETTER if word == "radar" else (word[:1] or "?")


def not_available(seq: int, bot: int, request: str, reason: int) -> bytes:
    return v5.encode_not_available(seq, bot, request=request_letter(request), reason=reason)
