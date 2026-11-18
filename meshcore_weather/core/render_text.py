"""Text renderings of core objects for the DM path.

Every function returns ONE string meant to fit a single MeshCore DM
(target <= 120 characters, hard cap 160). The same objects feed the
binary encoders, so what a human reads and what an app decodes come from
the same parse.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timezone
from zoneinfo import ZoneInfo

from meshcore_weather.config import settings
from meshcore_weather.core.services import (
    OBS_MAX_AGE_MIN,
    Forecast,
    Observation,
    forecast_point_near,
)
from meshcore_weather.core.vtec_names import short_name
from meshcore_weather.geodata.names import place_name
from meshcore_weather.protocol.encoders import metar_observed_at

# One MeshCore text message. The firmware clips a channel message at 160
# bytes of "name: text" (plus 5 bytes of header), so with a name like
# WX-AUS about 147 characters of text survive; a DM has a similar budget.
# Everything rendered here aims below that so nothing is ever cut mid-word.
MAX_DM = 147

_SKY = {0: "clear", 1: "few", 2: "sct", 3: "bkn", 4: "ovc", 5: "fog", 6: "smoke",
        7: "haze", 8: "rain", 9: "snow", 10: "tstm", 11: "drzl", 12: "mist",
        13: "squall", 14: "sand", 15: "wx"}
_DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
         "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


# Times are shown in the place's own zone, not the bot's: a Texas bot
# answering "warn NY" says 8:00AM EDT, not 7:00AM. The abbreviation is
# added only when the zone differs from the bot's.
_STATE_TZ = {
    "AL": "America/Chicago", "AK": "America/Anchorage", "AZ": "America/Phoenix", "AR": "America/Chicago",
    "CA": "America/Los_Angeles", "CO": "America/Denver", "CT": "America/New_York", "DE": "America/New_York",
    "DC": "America/New_York", "FL": "America/New_York", "GA": "America/New_York", "HI": "Pacific/Honolulu",
    "ID": "America/Boise", "IL": "America/Chicago", "IN": "America/Indiana/Indianapolis", "IA": "America/Chicago",
    "KS": "America/Chicago", "KY": "America/New_York", "LA": "America/Chicago", "ME": "America/New_York",
    "MD": "America/New_York", "MA": "America/New_York", "MI": "America/Detroit", "MN": "America/Chicago",
    "MS": "America/Chicago", "MO": "America/Chicago", "MT": "America/Denver", "NE": "America/Chicago",
    "NV": "America/Los_Angeles", "NH": "America/New_York", "NJ": "America/New_York", "NM": "America/Denver",
    "NY": "America/New_York", "NC": "America/New_York", "ND": "America/Chicago", "OH": "America/New_York",
    "OK": "America/Chicago", "OR": "America/Los_Angeles", "PA": "America/New_York", "RI": "America/New_York",
    "SC": "America/New_York", "SD": "America/Chicago", "TN": "America/Chicago", "TX": "America/Chicago",
    "UT": "America/Denver", "VT": "America/New_York", "VA": "America/New_York", "WA": "America/Los_Angeles",
    "WV": "America/New_York", "WI": "America/Chicago", "WY": "America/Denver", "PR": "America/Puerto_Rico",
    "VI": "America/Puerto_Rico", "GU": "Pacific/Guam", "MP": "Pacific/Guam", "AS": "Pacific/Pago_Pago",
}


def _tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.timezone)
    except Exception:
        return ZoneInfo("UTC")


def tz_for_state(state: str | None) -> ZoneInfo:
    name = _STATE_TZ.get((state or "").upper())
    if not name:
        return _tz()
    try:
        return ZoneInfo(name)
    except Exception:
        return _tz()


def tz_for_loc(loc: dict | None) -> ZoneInfo:
    zones = (loc or {}).get("zones") or []
    return tz_for_state(zones[0][:2]) if zones else _tz()


def _local(dt: datetime, tz: ZoneInfo | None = None) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(tz or _tz())


def _clock(dt: datetime, tz: ZoneInfo | None = None) -> str:
    """'4:45PM' in the given zone (bot's zone by default), with the zone's
    abbreviation when it is not the bot's own."""
    l = _local(dt, tz)
    out = l.strftime("%I:%M%p").lstrip("0")
    if tz is not None and tz.key != _tz().key:
        out += " " + l.strftime("%Z")
    return out


def _when(dt: datetime, tz: ZoneInfo | None = None) -> str:
    """'4:45PM' if today, else 'Mon 4:45PM'."""
    l = _local(dt, tz)
    today = datetime.now(timezone.utc).astimezone(tz or _tz()).date()
    if l.date() == today:
        return _clock(dt, tz)
    return f"{l.strftime('%a')} {_clock(dt, tz)}"


def _dir(deg: int) -> str:
    return _DIRS[int((deg + 11.25) // 22.5) % 16]


def _cap(s: str) -> str:
    """Kept for its callers: replies are no longer trimmed here. The pager
    (core/pages.py) cuts a long reply into numbered pages that "more" walks."""
    return s


def _title(name: str | None) -> str:
    """'HEAT ADV' -> 'Heat Adv'; keeps short all-caps tokens like 'SVR' readable."""
    if not name:
        return "?"
    return " ".join(w.capitalize() for w in name.split())


def fit_list(head: str, items: list[str], cap: int = MAX_DM, sep: str = "; ", tail: str = "") -> str:
    """head + every item + tail. Nothing is dropped: a reply longer than one
    message is paged by core/pages.py on these separators, and "more" fetches
    the next page. `cap` is accepted for its callers and ignored."""
    return head + sep.join(items) + tail


def _group(items: list[str]) -> list[str]:
    """Collapse repeats in order: [a, b, a] -> ['a x2', 'b']."""
    counts: dict[str, int] = {}
    for it in items:
        counts[it] = counts.get(it, 0) + 1
    return [f"{k} x{n}" if n > 1 else k for k, n in counts.items()]


def place_label(loc: dict) -> str:
    """'Round Rock, TX' plus a warning when the name was ambiguous."""
    name = loc.get("name", "?")
    amb = loc.get("ambiguous") or []
    if amb:
        return f"{name} (also {'/'.join(amb[:3])}; add state)"
    return name


def _conditions(ob: Observation, full: bool = True) -> str:
    """'95F dp70 S12g17 bkn 10mi 30.01'. A group the METAR did not carry is
    left out rather than shown as a made-up value; a variable wind is VRB."""
    wind = ""
    if ob.wind_speed_mph == 0:
        wind = "calm"
    elif ob.wind_speed_mph is not None:
        wind = f"{'VRB' if ob.wind_dir_deg is None else _dir(ob.wind_dir_deg)}{ob.wind_speed_mph}"
    if wind and ob.wind_gust_mph:
        wind += f"g{ob.wind_gust_mph}"
    bits = [f"{ob.temp_f}F", None if ob.dewpoint_f is None else f"dp{ob.dewpoint_f}", wind,
            None if ob.sky_code is None else _SKY.get(ob.sky_code, "wx")]
    if full:
        bits += [None if ob.visibility_mi is None else f"{ob.visibility_mi}mi",
                 None if ob.pressure_inhg is None else f"{ob.pressure_inhg:.2f}"]
    return " ".join(x for x in bits if x)


def _age(minutes: int) -> str:
    """'5h', '45min': how old a report is, in the unit that fits a DM."""
    return f"{minutes // 60}h" if minutes >= 60 else f"{minutes}min"


def _station(ob: Observation) -> str:
    """'KAUS 12km', or 'KAUS 12km, 5h old' for a report that is not current:
    the weather as last seen is worth more than a blank, but only labelled."""
    where = f"{ob.station} {ob.distance_km:.0f}km"
    return f"{where}, {_age(ob.age_min)} old" if ob.stale else where


def observation(loc: dict, ob: Observation | None) -> str:
    if ob is None:
        return _cap(f"{place_label(loc)}: no current obs within 12h of nearby stations")
    if ob.stale:
        # Up to twelve hours old, so the day matters: 'Thu 9:53PM', not a
        # clock reading that would pass for today's.
        return _cap(
            f"{place_label(loc)} {_when(ob.observed_at, tz_for_loc(loc))} ({_station(ob)}): "
            + _conditions(ob)
        )
    hh, mm = divmod(ob.obs_utc_min, 60)
    obs_dt = datetime.now(timezone.utc).replace(hour=hh, minute=mm, second=0, microsecond=0)
    return _cap(
        f"{place_label(loc)} {_clock(obs_dt, tz_for_loc(loc))} ({_station(ob)}): "
        + _conditions(ob)
    )


def forecast(loc: dict, fc: Forecast | None, days: int = 5) -> str:
    if fc is None:
        # A point nearby with nothing held for it is a forecast the dish
        # missed, not a place NWS does not forecast for (2026-10-01: Lockhart).
        if loc.get("lat") is not None and forecast_point_near(loc["lat"], loc["lon"]):
            return _cap(f"{place_label(loc)}: no recent forecast received")
        return _cap(f"{place_label(loc)}: no forecast point within 80km")
    # A copy kept through a missed issuance says when it was issued, and gives
    # what days fit one packet: four at most, fewer when the place's label is
    # long ("Round Rock, TX 78664 (Georgetown Airport 21km, ...)" went to two
    # pages on 2026-10-01).
    issued = f", issued {_when(fc.issued_at, tz_for_loc(loc))}" if fc.stale and fc.issued_at else ""
    if issued:
        days = min(days, 4)
    parts = []
    for i, p in enumerate(fc.periods[:days]):
        day = "?"
        if fc.start_date is not None:
            from datetime import timedelta
            day = (fc.start_date + timedelta(days=p["period_id"])).strftime("%a")
        seg = f"{day} {p['high_f']}/{p['low_f']}"
        if p.get("precip_pct", 0) >= 20:
            seg += f" {p['precip_pct']}%"
        sky = p.get("sky_code", 0)
        if sky >= 8:
            seg += f" {_SKY.get(sky, '')}"
        parts.append(seg)
    head = f"{place_label(loc)} ({fc.point_name.split('-')[0].strip()} {fc.distance_km:.0f}km{issued}):"
    while issued and len(parts) > 1 and len((head + " " + " | ".join(parts)).encode()) > MAX_DM:
        parts.pop()
    return _cap(head + " " + " | ".join(parts))


def event_label(w: dict) -> str:
    """'Flash Flood Wrn', 'Air Quality Alert': a warning's name for a reply."""
    if w.get("event_name"):
        return _title(w["event_name"])
    return _title(short_name(w.get("vtec_phenomenon"), w.get("vtec_significance")))


def _until(w: dict, tz: ZoneInfo) -> str:
    """'til 7:15PM', or 'until further notice' for a warning NWS gave no end
    (VTEC 000000T0000Z): its wire expiry is invented and never shown."""
    if w.get("until_further_notice"):
        return "until further notice"
    return f"til {_when(w['expires_at'], tz)}"


def warnings(loc: dict, ws: list[dict]) -> str:
    if not ws:
        return _cap(f"No active warnings for {place_label(loc)}")
    items = []
    tz = tz_for_loc(loc)
    for w in ws:
        name = event_label(w)
        exp = w.get("expires_at")
        onset = w.get("onset_at")
        now = datetime.now(timezone.utc)
        if onset and onset > now:
            end = "until further notice" if w.get("until_further_notice") else _when(exp, tz)
            items.append(f"{name} {_when(onset, tz)}-{end}")
        else:
            items.append(f"{name} {_until(w, tz)}")
    head = f"{len(ws)} active, {place_label(loc)}: " if len(ws) > 1 else f"{place_label(loc)}: "
    return fit_list(head, items)


def summary(loc: dict, ob: Observation | None, ws: list[dict], fc: Forecast | None,
            now: datetime | None = None) -> str:
    """The 'wx <place>' reply: warnings first, then obs, then tomorrow.

    What is old says so. "Woodcreek, TX 78676: !Wind Adv til 7:00PM | 70/49
    20%" (2026-10-16) read as complete while the forecast was five hours old
    and the observation had been left out for being over two hours old; now
    the observation comes with its age and the forecast with its issue time.

    The forecast's first day is named when it is not today at the place:
    Taunton MA showed Tuesday's 59/44 bare on Saturday (2026-10-17), read as
    today's, when the first three days had not been parsed.
    """
    bits = []
    if ws:
        w = ws[0]
        bits.append(f"!{event_label(w)} {_until(w, tz_for_loc(loc))}")
    if ob:
        bits.append(f"{_conditions(ob, full=False)} ({_station(ob)})")
    if fc and fc.periods:
        p = fc.periods[0]
        seg = f"{p['high_f']}/{p['low_f']}"
        if fc.start_date is not None:
            today = (now or datetime.now(UTC)).astimezone(tz_for_loc(loc)).date()
            if fc.start_date.date() != today:
                seg = f"{fc.start_date:%a} {seg}"
        if p.get("precip_pct", 0) >= 20:
            seg += f" {p['precip_pct']}%"
        if fc.stale and fc.issued_at:
            seg += f" fc issued {_when(fc.issued_at, tz_for_loc(loc))}"
        bits.append(seg)
    if not bits:
        return _cap(f"{place_label(loc)}: no data yet")
    return _cap(f"{place_label(loc)}: " + " | ".join(bits))


# -- Request-only products ------------------------------------------------------------


def outlook(loc: dict, ol) -> str:
    if ol is None:
        return _cap(f"{place_label(loc)}: no hazardous weather outlook on file")
    age = max(0, int((datetime.now(timezone.utc) - ol.issued_at).total_seconds() / 3600))
    body = ol.summary_text().replace("\n", " ")
    return _cap(f"{place_label(loc)} HWO ({age}h ago): {body}")


_LSR_SHORT = {
    "Non-Tstm Wnd Gst": "Wind", "Tstm Wnd Gst": "T-Wind", "Tstm Wnd Dmg": "Wind Dmg",
    "Funnel Cloud": "Funnel", "Flash Flood": "FlashFld", "Heavy Rain": "HvyRain",
    "Marine Tstm Wind": "Marine Wind", "Non-Tstm Wnd Dmg": "Wind Dmg",
}
_LSR_DIST_RE = re.compile(r"^\d+\s+[NSEW]{1,3}\s+", re.I)


def storm_reports(label: str, sr, state: str | None = None) -> str:
    """'16 storm reports NY: FlashFld Little Falls, Paterson NJ x3; Hail 1.00 Albany +9 more'."""
    if sr is None or not sr.entries:
        return _cap(f"No storm reports {label}")
    items = []
    for e in sr.entries:
        ev = e["event"]
        for k, v in _LSR_SHORT.items():
            ev = ev.replace(k, v)
        town = place_name(_LSR_DIST_RE.sub("", " ".join(e["location"].split())).strip())
        st = (e.get("state") or "").strip().upper()
        where = f"{town} {st}" if st and state and st != state.upper() else town
        mag = f" {' '.join(str(e['mag']).split())}" if str(e.get("mag") or "").strip() else ""
        items.append(f"{ev}{mag} {where}")
    return fit_list(f"{len(sr.entries)} storm reports {label}: ", _group(items))


def nowcast(loc: dict, nc) -> str:
    if nc is None:
        return _cap(f"{place_label(loc)}: no short-term forecast on file")
    return _cap(f"{place_label(loc)} NOW ({nc.wfo}): " + " ".join(nc.body().split()))


def raw_metar(loc: dict, found) -> str:
    if not found:
        return _cap(f"{place_label(loc)}: no METAR within 12h from nearby stations")
    icao, km, line = found
    # A report over two hours old is served when nothing is current
    # (services.raw_metar_for) and says so: its own DDHHMMZ group is easy to
    # misread as recent.
    now = datetime.now(UTC)
    observed = metar_observed_at(line, now)
    age = max(0, int((now - observed).total_seconds() // 60)) if observed else 0
    old = f"{_age(age)} old" if age > OBS_MAX_AGE_MIN else ""
    if km == 0:
        return _cap(f"METAR ({old}) {line}" if old else f"METAR {line}")
    return _cap(f"METAR ({icao} {km:.0f}km{', ' + old if old else ''}) {line}")


def taf(loc: dict, tf) -> str:
    if tf is None:
        return _cap(f"{place_label(loc)}: no TAF for nearby stations")
    head = "" if tf.distance_km == 0 else f"({tf.station} {tf.distance_km:.0f}km) "
    return _cap(head + tf.text)


def _every(minutes: int) -> str:
    """'3 h', '90 min'."""
    return f"{minutes // 60} h" if minutes and minutes % 60 == 0 else f"{minutes} min"


def coverage(facts: dict, digest_minutes: int = 180) -> str:
    """What the bot covers, in words: the area and how far it reaches, the
    NWS offices in it, how many stations the hourly batch carries, and how
    often the active-warning list goes out.

    `facts` is v5_builders.coverage_facts(), the same numbers the Coverage
    message puts on the wire (spec 10). The bot states this itself because an
    app that infers it from the stations and warnings it happens to have heard
    gets it wrong: one phone was told WX-AUS might not carry alerts for Travis
    County, the bot's own home, because the only warning active at that moment
    came from a neighbouring office.
    """
    zones = facts.get("zones") or []
    centre = facts.get("center")
    radius = int(facts.get("radius_km") or 0)
    where = facts.get("place") or (f"{centre[0]:.2f},{centre[1]:.2f}" if centre else "")
    if zones and radius and where:
        parts = [f"Coverage: {len(zones)} NWS zones within {radius} km of {where}"]
    elif zones:
        parts = [f"Coverage: {len(zones)} NWS zones" + (f" around {where}" if where else "")]
    else:
        parts = ["Coverage: no area filter, so this bot carries everything its feed brings"]
    if facts.get("offices"):
        parts.append("offices " + ", ".join(facts["offices"]))
    cap = int(facts.get("stations") or 0)
    parts.append(f"up to {cap} stations hourly" if cap else "no station observations")
    parts.append(f"alert list every {_every(digest_minutes)}" if digest_minutes
                 else "alert list off")
    return "; ".join(parts)


def rain(label: str, ro) -> str:
    if ro is None or not ro.cities:
        return _cap(f"No rain reported {label}")
    items = [f"{place_name(c['name'])} {c['rain_text'].lower()} {c['temp_f']}F" for c in ro.cities]
    return fit_list(f"Rain {label} ({len(ro.cities)}): ", items)


_RADAR_LEVELS = {1: "light", 2: "moderate", 3: "heavy"}


def radar(loc: dict, taken: datetime, facts: dict | None, now: datetime | None = None) -> str:
    """The `radar` reply: what the newest radar picture shows at a place.

    `facts` is `radar.tiles.describe()`; None means the bot holds no picture
    for the place. The picture's own time leads, with its age, because a radar
    picture is 10 to 25 minutes old by the time anyone reads it and the rain
    has moved since."""
    label = place_label(loc)
    if facts is None:
        return f"{label}: no recent radar picture for this area"
    now = now or datetime.now(timezone.utc)
    age = max(0, int((now - taken).total_seconds() // 60))
    head = f"Radar {_clock(taken, tz_for_loc(loc))} ({age} min old), {label}: "
    here, nearest, heavy = facts.get("here"), facts.get("nearest"), facts.get("heavy")
    if here is None:
        return head + "the picture does not reach this place"
    parts = [f"{_RADAR_LEVELS[here]} precipitation here" if here else "dry here"]
    if nearest is not None and not here:
        level, km, bearing = nearest
        parts.append(f"nearest precipitation {km:.0f} km {bearing}, {_RADAR_LEVELS[level]}")
    if heavy is not None:
        parts.append(f"heavy {heavy[1]:.0f} km {heavy[2]}")
    if not here and nearest is None:
        parts = ["no precipitation on the picture (220 km across)"]
    return head + ". ".join(p if i == 0 else p[0].upper() + p[1:] for i, p in enumerate(parts))

