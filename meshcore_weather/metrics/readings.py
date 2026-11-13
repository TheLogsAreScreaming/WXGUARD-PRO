"""The weather readings the bot holds, as plain numbers for the exporters.

The bot does not have sensors of its own: its readings are the METAR
observations that arrive in the EMWIN feed (product type SAH, or any product
that carries METAR lines). This module finds the newest observation per
station in the store and decodes it with the bot's one METAR decoder
(protocol.encoders.parse_metar), so the exported numbers are the same ones
the mesh replies carry.

Nothing here touches the network; influx.py and prometheus.py turn these
readings into their own formats.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from meshcore_weather.protocol.encoders import metar_observed_at, parse_metar

_METAR_LINE_RE = re.compile(r"^(?:(?:METAR|SPECI)\s+)?([A-Z][A-Z0-9]{3})\s+(?:COR\s+)?\d{6}Z")

# Numeric fields exported for every reading, with their units. A field the
# METAR did not carry (no altimeter, a missing dewpoint) is left out of the
# reading rather than sent as a made-up zero.
FIELDS: dict[str, str] = {
    "temp_f": "degrees Fahrenheit",
    "dewpoint_f": "degrees Fahrenheit",
    "wind_dir_deg": "degrees true",
    "wind_speed_mph": "miles per hour",
    "wind_gust_mph": "miles per hour",
    "visibility_mi": "statute miles",
    "pressure_inhg": "inches of mercury",
}


@dataclass(frozen=True)
class Reading:
    """One station's observation: when it was taken and its numbers."""

    station: str
    observed_at: datetime
    values: dict[str, float]


def parse_station_list(text: str) -> set[str] | None:
    """`KAUS, KSAT kdfw` -> {"KAUS", "KSAT", "KDFW"}; empty -> None (all)."""
    names = {s.strip().upper() for s in re.split(r"[\s,]+", text or "") if s.strip()}
    return names or None


def _metar_lines(text: str):
    for line in text.splitlines():
        stripped = line.strip().rstrip("=").strip()
        m = _METAR_LINE_RE.match(stripped)
        if m:
            if stripped.startswith(("METAR ", "SPECI ")):
                stripped = stripped.split(None, 1)[1]
            yield m.group(1), stripped


def latest_readings(
    store,
    stations: set[str] | None = None,
    max_age: timedelta = timedelta(hours=3),
    limit: int = 300,
    now: datetime | None = None,
) -> list[Reading]:
    """The newest decodable observation per station, newest station first.

    `stations` limits the result to those ICAO ids (None = every station in
    the feed, up to `limit`). Observations older than `max_age` are dropped:
    an exporter should not keep re-reporting a station that went quiet.
    """
    now = now or datetime.now(UTC)
    best: dict[str, tuple[datetime, str]] = {}
    for prod in list(store._products.values()):
        if prod.product_type != "SAH" and "METAR" not in prod.raw_text[:200]:
            continue
        for station, line in _metar_lines(prod.raw_text):
            if stations is not None and station not in stations:
                continue
            when = metar_observed_at(line, prod.timestamp) or prod.timestamp
            if now - when > max_age:
                continue
            held = best.get(station)
            if held is None or when > held[0]:
                best[station] = (when, line)

    readings: list[Reading] = []
    for station, (when, line) in best.items():
        fields = parse_metar(line)
        if not fields:
            continue
        values = {k: float(fields[k]) for k in FIELDS if fields.get(k) is not None}
        if values:
            readings.append(Reading(station=station, observed_at=when, values=values))
    readings.sort(key=lambda r: (-r.observed_at.timestamp(), r.station))
    return readings[:limit]
