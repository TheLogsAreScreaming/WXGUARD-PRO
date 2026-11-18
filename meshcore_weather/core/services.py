"""Product services: the single implementation of "what is the weather at
this location" used by the text commands, the scheduler, and on-demand
requests.

Each service takes the WeatherStore and a resolved location dict (from
`geodata.resolver.resolve`) and returns a canonical object. Rendering to
text lives in `core.render_text`; rendering to bytes uses the packers in
`protocol.meshwx` via the `to_bytes()` helpers here.
"""

from __future__ import annotations

import re

import dataclasses
import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from meshcore_weather.geodata.names import place_name
from meshcore_weather.parser.pfm import TZ_ABBR_OFFSET, PFMPoint, downsample_to_daily, parse_pfm
from meshcore_weather.parser.weather import EMWINProduct, WeatherStore
from meshcore_weather.protocol.encoders import parse_metar, metar_observed_at
from meshcore_weather.protocol.meshwx import (
    LOC_STATION,
    LOC_ZONE,
    pack_forecast,
    pack_observation,
)

logger = logging.getLogger(__name__)

# An observation older than this is not "current".
OBS_MAX_AGE_MIN = 120
# ...but it is still the weather as last seen: when nothing nearby is current
# the newest report up to this old is served with its age rather than nothing
# (owner, 2026-10-16: "Woodcreek: 70/49 20%" read as complete with no
# observation at all and a five-hour-old forecast).
OBS_STALE_MAX_AGE_MIN = 720
# A forecast point farther than this is not "your" forecast.
FORECAST_MAX_KM = 80.0
# A forecast is issued about every 12 hours. One older than this is a copy
# kept through a missed issuance (emwin/retention.py), and the text reply says
# when it was issued.
FORECAST_CURRENT_HOURS = 13
# A station farther than this is not "your" observation (Guam's nearest
# entry in stations.json was Hawaii, 5,966 km away).
STATION_MAX_KM = 150.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# -- Observation ------------------------------------------------------------------


@dataclass
class Observation:
    station: str
    distance_km: float
    observed_at: datetime          # UTC, product receive time (METAR line has only hh:mm)
    obs_utc_min: int               # minutes since midnight UTC from the METAR itself
    temp_f: int
    dewpoint_f: int | None         # None: the METAR did not carry the group (parse_metar)
    wind_dir_deg: int | None       # None also for a variable (VRB) wind
    wind_speed_mph: int | None
    wind_gust_mph: int
    visibility_mi: float | None
    pressure_inhg: float | None
    sky_code: int | None
    raw: str
    stale: bool = False            # older than OBS_MAX_AGE_MIN: shown with its age, never as current

    @property
    def age_min(self) -> int:
        return max(0, int((datetime.now(timezone.utc) - self.observed_at).total_seconds() / 60))

    def to_bytes(self, loc_type: int | None = None, loc_id=None) -> bytes:
        return pack_observation(
            loc_type if loc_type is not None else LOC_STATION,
            loc_id if loc_id is not None else self.station,
            timestamp_utc_min=self.obs_utc_min,
            temp_f=self.temp_f,
            dewpoint_f=self.dewpoint_f,
            wind_dir_deg=self.wind_dir_deg,
            sky_code=self.sky_code,
            wind_speed_mph=self.wind_speed_mph,
            wind_gust_mph=self.wind_gust_mph,
            visibility_mi=self.visibility_mi,
            pressure_inhg=self.pressure_inhg,
        )


def observation_for(
    store: WeatherStore, loc: dict, max_age_min: int = OBS_MAX_AGE_MIN,
    stale_max_age_min: int = OBS_STALE_MAX_AGE_MIN,
) -> Observation | None:
    """Latest fresh METAR from the nearest station THAT ACTUALLY REPORTS.

    Walks the resolver's distance-ranked station list and returns the first
    one with a METAR newer than `max_age_min`. A silent AWOS next door never
    hides a reporting airport a few km further away.

    When no station has a fresh report, the newest one up to
    `stale_max_age_min` old is returned instead, flagged `stale`, so the
    reply says "63F ... (KAUS 12km, 5h old)" rather than leaving the
    observation out and reading as if the forecast were the whole story.
    """
    now = datetime.now(timezone.utc)
    candidates = loc.get("stations") or ([(loc["station"], loc.get("station_km") or 0.0)] if loc.get("station") else [])
    newest_stale: tuple[datetime, str, float, str] | None = None
    for icao, km in candidates:
        if km > STATION_MAX_KM:
            break
        raw = store._find_metar_raw(icao)
        if not raw:
            continue
        text, ts = raw
        # The product's time is when the collective arrived, the same for every
        # station in it; the report's own DDHHMMZ group is when it was taken.
        ts = metar_observed_at(text, ts) or ts
        if (now - ts) > timedelta(minutes=max_age_min):
            # Not current; remembered as the stand-in if nothing nearer is.
            if (now - ts) <= timedelta(minutes=stale_max_age_min) and (
                    newest_stale is None or ts > newest_stale[0]):
                newest_stale = (ts, icao, float(km), text)
            continue
        fields = parse_metar(text)
        if not fields:
            continue
        return Observation(
            station=icao,
            distance_km=float(km),
            observed_at=ts,
            raw=text,
            **fields,
        )
    if newest_stale is not None:
        ts, icao, km, text = newest_stale
        fields = parse_metar(text)
        if fields:
            return Observation(
                station=icao,
                distance_km=km,
                observed_at=ts,
                raw=text,
                stale=True,
                **fields,
            )
    return None


# -- Forecast ---------------------------------------------------------------------


@dataclass
class Forecast:
    point_name: str
    point_zone: str
    distance_km: float
    issued_at: datetime | None
    source: str                        # "PFM"
    periods: list[dict] = field(default_factory=list)   # pack_forecast period dicts
    start_date: datetime | None = None                    # local date of period 0
    wfo: str = ""
    stale: bool = False                # issued more than FORECAST_CURRENT_HOURS ago

    @property
    def issued_hours_ago(self) -> int:
        if not self.issued_at:
            return 0
        return max(0, int((datetime.now(timezone.utc) - self.issued_at).total_seconds() / 3600))

    def to_bytes(self, loc_type: int | None = None, loc_id=None) -> bytes:
        return pack_forecast(
            loc_type if loc_type is not None else LOC_ZONE,
            loc_id if loc_id is not None else self.point_zone,
            issued_hours_ago=self.issued_hours_ago,
            periods=self.periods,
        )


# Parsed PFM cache: product filename -> list[PFMPoint]. PFMs are 30 KB of
# fixed-column text and every request would otherwise re-parse them.
_pfm_cache: dict[str, list[PFMPoint]] = {}


def _parsed_pfm(prod: EMWINProduct) -> list[PFMPoint]:
    pts = _pfm_cache.get(prod.filename)
    if pts is None:
        try:
            pts = parse_pfm(prod.raw_text)
        except Exception as exc:
            logger.warning("PFM %s failed to parse: %s", prod.emwin_id, exc)
            pts = []
        if len(_pfm_cache) > 200:
            _pfm_cache.clear()
        _pfm_cache[prod.filename] = pts
    return pts


def nearest_pfm_point(
    store: WeatherStore, lat: float, lon: float, max_km: float = FORECAST_MAX_KM,
) -> tuple[PFMPoint, EMWINProduct, float] | None:
    """Nearest PFM forecast point across every PFM product in the store,
    newest product per office. Zone equality is NOT required: Kyle gets San
    Marcos Airport (12 km) even though that point is filed under Caldwell."""
    newest: dict[str, EMWINProduct] = {}
    for prod in store._products.values():
        if prod.product_type != "PFM":
            continue
        cur = newest.get(prod.emwin_id)
        if cur is None or prod.timestamp > cur.timestamp:
            newest[prod.emwin_id] = prod
    best: tuple[PFMPoint, EMWINProduct, float] | None = None
    for prod in newest.values():
        for pt in _parsed_pfm(prod):
            d = _haversine_km(lat, lon, pt.lat, pt.lon)
            if d <= max_km and (best is None or d < best[2]):
                best = (pt, prod, d)
    return best


def _now() -> datetime:
    return datetime.now(timezone.utc)


def forecast_for(store: WeatherStore, loc: dict, max_days: int = 7,
                 now: datetime | None = None) -> Forecast | None:
    found = nearest_pfm_point(store, loc["lat"], loc["lon"])
    if not found:
        return None
    pt, prod, km = found
    now = now or _now()
    # A forecast kept through a missed issuance starts on a day that has gone
    # by: those days are left out, so the first one is always today or later
    # at the point. One just issued has none to leave out.
    today = pt.local_date(now)
    daily = [d for d in downsample_to_daily(pt, max_days=max_days + 3) if d.local_date >= today]
    daily = [dataclasses.replace(d, day_offset=i) for i, d in enumerate(daily[:max_days])]
    if not daily:
        return None
    issued = pt.issue_time or prod.timestamp
    # Period 0's date comes from the downsampler itself, so labels can never
    # drift from the numbers (Minneapolis showed Tuesday's 70/51 under "Mon"
    # when Monday was a partial day, 2026-09-14).
    start = datetime.combine(daily[0].local_date, datetime.min.time())
    return Forecast(
        point_name=pt.name,
        point_zone=pt.zone,
        distance_km=round(km, 1),
        issued_at=issued,
        source="PFM",
        periods=[p.to_encoder_dict() for p in daily],
        start_date=start,
        wfo=pt.wfo or prod.office,
        stale=issued is not None and now - issued > timedelta(hours=FORECAST_CURRENT_HOURS),
    )


_forecast_points: list | None = None


def forecast_point_near(lat: float, lon: float, max_km: float = FORECAST_MAX_KM) -> str | None:
    """The name of the nearest NWS forecast point within `max_km`, from the
    fixed list every client ships (client_data/pfm_points.json), whether or
    not a forecast for it is held. It tells "no point near here" apart from
    "no forecast received for the point near here"."""
    global _forecast_points
    if _forecast_points is None:
        import json
        from pathlib import Path
        path = Path(__file__).resolve().parent.parent / "client_data" / "pfm_points.json"
        _forecast_points = json.loads(path.read_text())["points"]
    best = None
    for name, _wfo, plat, plon, _zone in _forecast_points:
        d = _haversine_km(lat, lon, plat, plon)
        if d <= max_km and (best is None or d < best[1]):
            best = (name, d)
    return best[0] if best else None


# -- Warnings ---------------------------------------------------------------------


def warnings_for(store: WeatherStore, loc: dict, all_active: list[dict] | None = None) -> list[dict]:
    """Active warnings that apply to the location: any whose UGC list
    includes the location's zone, any without a polygon whose UGC list
    includes the location's county (a tornado or severe thunderstorm watch
    names counties only), and any whose storm-based polygon contains the
    point. A storm-based warning's counties are only the ones its polygon
    touches, so for one the polygon decides. Uses the pyIEM extractor (the
    same one the broadcasts use)."""
    from meshcore_weather.geodata import resolver
    from meshcore_weather.protocol.coverage import _point_in_polygon
    from meshcore_weather.protocol.warnings import extract_active_warnings

    if all_active is None:
        all_active = extract_active_warnings(store, coverage=None)
    zone = loc["zones"][0] if loc.get("zones") else ""
    lat, lon = loc.get("lat"), loc.get("lon")
    county: str | None = None
    out = []
    for w in all_active:
        ugcs = set(w.get("ugcs") or w.get("zones") or [])
        if zone and zone in ugcs:
            out.append(w)
            continue
        has_polygon = len(w.get("vertices") or []) >= 3
        if not has_polygon:
            if lat is not None and county is None and any(u[2:3] == "C" for u in ugcs):
                county = resolver.county_for_point(lat, lon) or ""
            if county and county in ugcs:
                out.append(w)
            continue
        if lat is not None and _point_in_polygon(lat, lon, w["vertices"]):
            out.append(w)
    # Most urgent first: warnings, then watches, then advisories; sooner expiry first.
    sev_rank = {"W": 0, "A": 1, "Y": 2, "S": 3}
    out.sort(key=lambda w: (sev_rank.get(w.get("vtec_significance") or "S", 3), w["expires_at"]))
    return out


# -- Hazardous Weather Outlook ----------------------------------------------------


@dataclass
class Outlook:
    zone: str
    product: EMWINProduct

    @property
    def issued_at(self) -> datetime:
        return self.product.timestamp

    def summary_text(self) -> str:
        return hwo_summary(self.product.raw_text)

    def to_bytes(self) -> bytes | None:
        from meshcore_weather.protocol.encoders import encode_hwo
        issued_min = self.product.timestamp.hour * 60 + self.product.timestamp.minute
        return encode_hwo(self.zone, self.product.raw_text, issued_min)


def outlook_for(store: WeatherStore, loc: dict) -> Outlook | None:
    """Latest HWO covering the location's zone: first by the zone's office,
    then any HWO whose UGC line lists the zone."""
    from meshcore_weather.parser.weather import _expand_zone_ranges
    zones = loc.get("zones") or []
    if not zones:
        return None
    zone = zones[0]
    hwo = store._find_any_orig("HWO", store._build_origs(loc))
    if hwo is None:
        loc_zones = set(zones)
        for prod in store._products.values():
            if prod.product_type != "HWO":
                continue
            if loc_zones & _expand_zone_ranges(prod.raw_text):
                if hwo is None or prod.timestamp > hwo.timestamp:
                    hwo = prod
    return Outlook(zone=zone, product=hwo) if hwo else None


def hwo_summary(text: str) -> str:
    """Compact the Day 1 / Days 2-7 sections of an HWO into one string."""
    import re
    parts: list[str] = []
    collecting = False
    for line in text.splitlines():
        s = line.strip()
        if s.startswith(".DAY"):
            section = s.lstrip(".").strip()
            section = (section.replace("DAYS TWO THROUGH SEVEN...", "D2-7:")
                              .replace("DAY ONE...", "Today:"))
            parts.append(section)
            collecting = True
            continue
        if s.startswith(".SPOTTER") or s.startswith("$$") or s.startswith("&&"):
            if collecting:
                break
            continue
        if not collecting or not s:
            continue
        if re.match(r"^[A-Z]{2}[ZC]\d{3}", s) or re.match(r"^\d{3,4}\s+(AM|PM)\s+\w+", s):
            continue
        if s.startswith("See the Graphical") or s.startswith("http"):
            continue
        if re.match(r"^(RISK|AREA|ONSET|DISCUSSION)\.\.\.", s):
            s = s.replace("...", ": ", 1).rstrip(".")
        parts.append(s)
    if not parts:
        return "No hazards identified."
    out: list[str] = []
    for p in parts:
        if p.endswith(":"):
            out.append(("\n" if out else "") + p)
        elif out and out[-1].endswith(":"):
            out.append(" " + p)
        else:
            out.append(" " + p if out else p)
    return "".join(out)


# -- Local Storm Reports ------------------------------------------------------------


@dataclass
class StormReports:
    zone: str
    state: str
    entries: list[dict] = field(default_factory=list)   # time, event, location, mag, state

    def to_bytes(self) -> bytes | None:
        from meshcore_weather.protocol.encoders import encode_lsr_reports, now_utc_minutes
        return encode_lsr_reports(self.zone, self.entries, now_utc_minutes())


def parse_lsr_entries(text: str) -> list[dict]:
    """Individual reports from an LSR product.

    The NWS LSR layout is fixed-width, two lines per report:
      cols 0-11 time | 12-28 event | 29-52 city location | 53- lat/lon
      cols 0-11 date | 12-28 magnitude | 29-47 county | 48-49 ST | 53- source
    Splitting on runs of spaces is not safe: a 16-character event
    ("Non-Tstm Wnd Gst") leaves a single space before the location, which
    hid every Billings wind report on 2026-09-14. Columns first, then a
    loose split as the fallback for products with odd spacing.
    """
    import re
    entries = []
    lines = [l.rstrip() for l in text.splitlines()]
    time_re = re.compile(r"^\d{4} [AP]M$")
    latlon_re = re.compile(r"^\d{1,3}\.\d{2}[NS]\s+\d{1,3}\.\d{2}[EW]")
    date_re = re.compile(r"^\d{2}/\d{2}/\d{4}$")

    def line1(line: str):
        t, ev, loc, ll = line[0:12].strip(), line[12:29].strip(), line[29:53].strip(), line[53:].strip()
        if time_re.match(t) and ev and latlon_re.match(ll):
            return t, ev, loc
        parts = re.split(r"\s{2,}", line.strip())
        if len(parts) >= 4 and time_re.match(parts[0]) and latlon_re.match(parts[-1]):
            return parts[0], parts[1], " ".join(parts[2:-1])
        return None

    def line2(line: str):
        d, mag, county, st = line[0:12].strip(), line[12:29].strip(), line[29:48].strip(), line[48:50].strip()
        if date_re.match(d) and re.match(r"^[A-Z]{2}$", st):
            return d, mag, county, st
        p2 = re.split(r"\s{2,}", line.strip())
        if len(p2) >= 3 and date_re.match(p2[0]):
            k = next((n for n, tok in enumerate(p2) if n >= 2 and re.match(r"^[A-Z]{2}$", tok)), None)
            if k is not None:
                return p2[0], " ".join(p2[1:k - 1]).strip(), p2[k - 1], p2[k]
        return None

    for i, line in enumerate(lines):
        first = line1(line)
        if not first:
            continue
        t, ev, loc = first
        entry = {"time": t, "event": ev, "location": loc, "mag": "", "state": "", "county": "", "date": ""}
        for j in range(i + 1, min(i + 3, len(lines))):
            if not lines[j].strip():
                continue
            second = line2(lines[j])
            if second:
                entry["date"], entry["mag"], entry["county"], entry["state"] = second
            break
        entries.append(entry)
    return entries


def product_state(prod: EMWINProduct) -> str:
    """State a warning-type product actually affects: the first UGC line's
    prefix (offices near borders issue for neighbouring states)."""
    import re
    for line in prod.raw_text.splitlines()[:25]:
        m = re.match(r"^([A-Z]{2})[ZC]\d{3}", line.strip())
        if m:
            return m.group(1)
    return prod.state


# Hours from UTC for each zone abbreviation a product header carries (one
# table, parser/pfm.py). The header's abbreviation is mixed case on Guam
# ("1015 PM ChST Sat Oct 17 2026"): the pattern read only capitals, so every
# Guam storm report was taken as UTC and fell outside the six-hour window.
_TZ_ABBR_OFFSET = {k.upper(): v for k, v in TZ_ABBR_OFFSET.items()}
_LSR_HDR_RE = re.compile(r"^\d{3,4} [AP]M ([A-Za-z]{3,4}) \w{3} \w{3} \d{1,2} \d{4}", re.M)
LSR_RECENT_HOURS = 6


def _lsr_entry_time(entry: dict, tz_abbr: str | None) -> datetime | None:
    """UTC time of one report from its line-2 date, line-1 time and the
    product's timezone abbreviation."""
    d, tm = entry.get("date"), entry.get("time")
    if not d or not tm:
        return None
    try:
        local = datetime.strptime(f"{d} {tm}", "%m/%d/%Y %I%M %p")
    except ValueError:
        return None
    off = _TZ_ABBR_OFFSET.get((tz_abbr or "").upper())
    if off is None:
        logger.debug("Storm report header zone %r unknown; read as UTC", tz_abbr)
        off = 0
    return (local - timedelta(hours=off)).replace(tzinfo=timezone.utc)


def storm_reports_for(store: WeatherStore, loc: dict | None = None, state: str | None = None,
                      limit: int = 16, max_age_hours: int = LSR_RECENT_HOURS) -> StormReports | None:
    """Deduplicated LSR reports for a state (the location's state by default)
    whose report time is within `max_age_hours`, newest report first.

    LSR products are re-issued as next-day summaries, so a product received
    an hour ago can describe yesterday morning; the report's own timestamp
    is what makes it current (checked against IEM on 2026-09-14)."""
    if state is None:
        zones = (loc or {}).get("zones") or []
        if not zones:
            return None
        state = zones[0][:2]
        zone = zones[0]
    else:
        zone = f"{state}Z000"
    state = state.upper()
    now = datetime.now(timezone.utc)
    seen: set[str] = set()
    entries: list[dict] = []
    for prod in sorted(store._products.values(), key=lambda p: p.timestamp, reverse=True):
        if prod.product_type != "LSR":
            continue
        if prod.state != state and product_state(prod) != state:
            continue
        m = _LSR_HDR_RE.search(prod.raw_text.replace("\r", ""))
        tz_abbr = m.group(1) if m else None
        for e in parse_lsr_entries(prod.raw_text):
            if e.get("state") and e["state"] != state:
                continue
            when = _lsr_entry_time(e, tz_abbr)
            if when is None or when < now - timedelta(hours=max_age_hours) or when > now + timedelta(hours=1):
                continue
            key = f"{e['date']}_{e['time']}_{e['event']}_{e['location']}"
            if key in seen:
                continue
            seen.add(key)
            e["at"] = when
            entries.append(e)
    entries.sort(key=lambda e: e["at"], reverse=True)
    entries = entries[:limit]
    return StormReports(zone=zone, state=state, entries=entries) if entries else None


# -- Nowcast (NOW) ----------------------------------------------------------------


@dataclass
class Nowcast:
    wfo: str
    product: EMWINProduct

    def body(self) -> str:
        from meshcore_weather.protocol.encoders import _extract_now_body
        return _extract_now_body(self.product.raw_text)

    def to_bytes(self) -> list[bytes]:
        from meshcore_weather.protocol.encoders import encode_nowcast
        return encode_nowcast(self.wfo, self.product.raw_text) or []


def nowcast_for(store: WeatherStore, loc: dict) -> Nowcast | None:
    prod = store._find_any_orig("NOW", store._build_origs(loc))
    return Nowcast(wfo=prod.office, product=prod) if prod else None


# -- Raw METAR / TAF ------------------------------------------------------------------


def raw_metar_for(store: WeatherStore, loc: dict, max_age_min: int = OBS_MAX_AGE_MIN,
                  stale_max_age_min: int = OBS_STALE_MAX_AGE_MIN) -> tuple[str, float, str] | None:
    """(station, km, raw METAR line) from the nearest reporting station.

    With nothing current, the newest report up to `stale_max_age_min` old,
    as `observation_for` does: the line carries its own DDHHMMZ time and
    `render_text.raw_metar` says how old it is.

    A station asked for by name (`metar KLAX`: it is the location, 0 km) is
    answered with its own report while it has one up to `stale_max_age_min`
    old, never a neighbour's newer one: a METAR is one airport's, and the
    reply says how old it is. On 2026-10-19 "metar KLAX" got Hawthorne's."""
    now = datetime.now(timezone.utc)
    newest_stale: tuple[datetime, str, float, str] | None = None
    for icao, km in loc.get("stations") or []:
        if km > STATION_MAX_KM:
            break
        raw = store._find_metar_raw(icao)
        if not raw:
            continue
        # The report's own time, not its collective's (`observation_for`).
        ts = metar_observed_at(raw[0], raw[1]) or raw[1]
        if (now - ts) <= timedelta(minutes=max_age_min):
            return icao, float(km), raw[0]
        if (now - ts) <= timedelta(minutes=stale_max_age_min) and km == 0:
            return icao, 0.0, raw[0]
        if (now - ts) <= timedelta(minutes=stale_max_age_min) and (
                newest_stale is None or ts > newest_stale[0]):
            newest_stale = (ts, icao, float(km), raw[0])
    if newest_stale is not None:
        return newest_stale[1], newest_stale[2], newest_stale[3]
    return None


@dataclass
class Taf:
    station: str
    distance_km: float
    product: EMWINProduct
    text: str          # the station's TAF block, joined on one line

    def to_bytes(self) -> bytes | None:
        from meshcore_weather.protocol.encoders import encode_taf, now_utc_minutes
        hours_ago = max(0, int((now_utc_minutes() - self.product.timestamp.hour * 60
                                - self.product.timestamp.minute) / 60))
        return encode_taf(self.station, self.product.raw_text, hours_ago)


def _taf_block(text: str, station: str) -> str | None:
    import re
    # The dish's "\r\r\n" line ends: splitlines() made a blank line of every
    # "\r", and the blank line ended each TAF after its first line, so every
    # reply lost its FM groups (found 2026-10-19).
    lines = text.replace("\r", "").split("\n")
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith(f"TAF {station}") or s.startswith(f"TAF AMD {station}") or (
            s.startswith(station + " ") and re.match(r"^[A-Z]{4}\s+\d{6}Z", s)
        ):
            block = [s]
            for j in range(i + 1, min(i + 15, len(lines))):
                nxt = lines[j].strip()
                if block[-1].endswith("=") or not nxt or nxt.startswith("=") or nxt.startswith("TAF ") \
                        or re.match(r"^[A-Z]{4}\s+\d{6}Z", nxt):
                    break
                block.append(nxt)
            return " ".join(block)
    return None


def taf_for(store: WeatherStore, loc: dict) -> Taf | None:
    """Latest TAF for the nearest station that has one (TAFs are issued for
    ~700 airports, so the nearest METAR station may not have one)."""
    for icao, km in loc.get("stations") or []:
        if km > STATION_MAX_KM:
            break
        for prod in sorted(store._products.values(), key=lambda p: p.timestamp, reverse=True):
            if prod.product_type != "TAF":
                continue
            block = _taf_block(prod.raw_text, icao)
            if block:
                return Taf(station=icao, distance_km=float(km), product=prod, text=block)
    return None


def station_taf(store: WeatherStore, icao: str, max_age_h: int = 30) -> str | None:
    """That station's own newest TAF as 'TAF <ICAO> ...', never a neighbour's.
    A TAF covers at most 30 hours, so an older one is not current."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_h)
    for prod in sorted(store._products.values(), key=lambda p: p.timestamp, reverse=True):
        if prod.timestamp < cutoff:
            break
        if prod.product_type != "TAF":
            continue
        block = _taf_block(prod.raw_text, icao)
        if block:
            # Bulletins put "TAF" (and AMD/COR) on the station line or on a
            # line of its own; apps look for "TAF <ICAO>" at the start.
            words = block.split()
            if words and words[0] == "TAF":
                words = words[1:]
            mods = []
            while words and words[0] in ("AMD", "COR"):
                mods.append(words.pop(0))
            if words and words[0] == icao:
                words = words[1:]
            return " ".join(["TAF", icao, *mods, *words])
    return None


# -- Rain observations (RWR) --------------------------------------------------------------


_RAIN_WORDS = {"RAIN", "LGT RAIN", "HVY RAIN", "TSTORM", "T-STORM", "DRIZZLE", "SHOWERS", "SHOWER", "SNOW"}
_SKY_WORDS = _RAIN_WORDS | {"SUNNY", "MOSUNNY", "PTSUNNY", "CLEAR", "MOCLDY", "PTCLDY", "CLOUDY",
                            "FAIR", "FOG", "HAZE", "WINDY", "LGT", "HVY", "N/A", "NOT", "AVBL"}


@dataclass
class RainObs:
    zone: str
    state: str
    cities: list[dict] = field(default_factory=list)   # name, state, rain_text, temp_f

    def to_bytes(self) -> bytes | None:
        from meshcore_weather.protocol.encoders import encode_rain_cities, now_utc_minutes
        return encode_rain_cities(self.zone, self.cities, now_utc_minutes())


_STATE_NAMES = {
    "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR", "CALIFORNIA": "CA", "COLORADO": "CO",
    "CONNECTICUT": "CT", "DELAWARE": "DE", "FLORIDA": "FL", "GEORGIA": "GA", "HAWAII": "HI", "IDAHO": "ID",
    "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA", "KANSAS": "KS", "KENTUCKY": "KY", "LOUISIANA": "LA",
    "MAINE": "ME", "MARYLAND": "MD", "MASSACHUSETTS": "MA", "MICHIGAN": "MI", "MINNESOTA": "MN",
    "MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE", "NEVADA": "NV",
    "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND", "OHIO": "OH", "OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA",
    "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX",
    "UTAH": "UT", "VERMONT": "VT", "VIRGINIA": "VA", "WASHINGTON": "WA", "WEST VIRGINIA": "WV",
    "WISCONSIN": "WI", "WYOMING": "WY", "PUERTO RICO": "PR", "GUAM": "GU",
}


def rain_for(store: WeatherStore, loc: dict | None = None, state: str | None = None) -> RainObs | None:
    """Cities in the RWR roundups currently reporting precipitation, for the
    location's state (or an explicit state)."""
    if state is None:
        zones = (loc or {}).get("zones") or []
        if not zones:
            return None
        state, zone = zones[0][:2], zones[0]
    else:
        state = state.upper()
        zone = f"{state}Z000"
    rainy: list[dict] = []
    seen: set[str] = set()
    for prod in store._products.values():
        if prod.product_type != "RWR" or prod.state != state:
            continue
        in_table = False
        section_ok = True
        for line in prod.raw_text.splitlines():
            s = line.strip()
            if s.startswith("...") and s.endswith("..."):
                # "...OTHER LOCATIONS IN NEW MEXICO..." — a roundup filed under
                # one state often carries a neighbour's stations too.
                named = {abbr for name, abbr in _STATE_NAMES.items() if name in s.upper()}
                section_ok = (state in named) if named else True
                continue
            if "SKY/WX" in s and "TMP" in s:
                in_table = section_ok
                continue
            if not in_table or not s:
                continue
            if s.startswith("$$"):
                in_table = False
                continue
            up = s.upper()
            if not any(k in up for k in _RAIN_WORDS):
                continue
            parts = s.split()
            if parts and parts[0].startswith("*"):
                parts[0] = parts[0][1:]
            city_parts: list[str] = []
            wx = ""
            temp = 60
            for p in parts:
                if p.upper() in _SKY_WORDS:
                    wx = p
                    break
                if p.lstrip("-").isdigit():
                    break
                city_parts.append(p)
            if wx in parts:
                for tp in parts[parts.index(wx) + 1:]:
                    if tp.lstrip("-").isdigit():
                        temp = int(tp)
                        break
            name = place_name(" ".join(city_parts)).strip()
            if not name or name in seen:
                continue
            seen.add(name)
            rainy.append({"name": name, "state": state, "rain_text": wx or "rain", "temp_f": temp})
    return RainObs(zone=zone, state=state, cities=rainy) if rainy else None
