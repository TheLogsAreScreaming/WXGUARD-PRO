"""InfluxDB line protocol for weather readings, and the push to a write URL.

One line per reading:

    wxguard_weather,station=KAUS temp_f=72,dewpoint_f=55,... 1763042400

The timestamp is the observation's own time in seconds, so pushing the same
reading twice writes the same point (InfluxDB overwrites it) and a history
built from the pushes is the stations' real history, not the bot's polling
times. The push adds `precision=s` to the URL unless the user's URL already
names a precision.
"""

from __future__ import annotations

import logging
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from meshcore_weather.metrics.readings import Reading

logger = logging.getLogger(__name__)

MEASUREMENT = "wxguard_weather"


def _escape_tag(value: str) -> str:
    """Tag keys and values: commas, equals signs and spaces are escaped."""
    return value.replace("\\", "\\\\").replace(",", r"\,").replace("=", r"\=").replace(" ", r"\ ")


def _escape_measurement(value: str) -> str:
    return value.replace("\\", "\\\\").replace(",", r"\,").replace(" ", r"\ ")


def _field_value(v: float) -> str:
    # Floats are written without a type suffix; whole numbers stay floats
    # (72.0 -> "72.0") so a field never flips between int and float, which
    # InfluxDB rejects as a type conflict.
    return repr(float(v))


def to_line(reading: Reading, measurement: str = MEASUREMENT, extra_tags: dict[str, str] | None = None) -> str:
    """One reading as one line of line protocol (no trailing newline)."""
    tags = {"station": reading.station, **(extra_tags or {})}
    tag_text = ",".join(f"{_escape_tag(k)}={_escape_tag(v)}" for k, v in sorted(tags.items()) if v)
    fields = ",".join(f"{_escape_tag(k)}={_field_value(v)}" for k, v in sorted(reading.values.items()))
    ts = int(reading.observed_at.timestamp())
    return f"{_escape_measurement(measurement)},{tag_text} {fields} {ts}"


def to_lines(readings: list[Reading], measurement: str = MEASUREMENT,
             extra_tags: dict[str, str] | None = None) -> str:
    return "\n".join(to_line(r, measurement, extra_tags) for r in readings if r.values)


def write_url(url: str) -> str:
    """The user's URL with `precision=s` added when it names none."""
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    if not any(k == "precision" for k, _ in query):
        query.append(("precision", "s"))
    return urlunsplit(parts._replace(query=urlencode(query)))


def auth_headers(token: str) -> dict[str, str]:
    """InfluxDB 2/3 takes `Authorization: Token <t>`. A token that already
    names its scheme (`Bearer x`, `Basic x`) is sent as it is."""
    token = (token or "").strip()
    if not token:
        return {}
    if " " in token:
        return {"Authorization": token}
    return {"Authorization": f"Token {token}"}


class InfluxPusher:
    """Pushes new readings to a write endpoint. Remembers, per station, the
    newest observation it delivered, so each observation goes once; a push
    that fails is tried again with the next round."""

    def __init__(self, url: str, token: str = "", timeout: float = 10.0,
                 client: httpx.AsyncClient | None = None, extra_tags: dict[str, str] | None = None):
        self.url = write_url(url)
        self._headers = {"Content-Type": "text/plain; charset=utf-8", **auth_headers(token)}
        self._timeout = timeout
        self._client = client
        self._extra_tags = extra_tags or {}
        self._sent: dict[str, float] = {}
        self.last_error: str = ""
        self.points_sent: int = 0

    def pending(self, readings: list[Reading]) -> list[Reading]:
        return [r for r in readings if r.observed_at.timestamp() > self._sent.get(r.station, 0.0)]

    async def push(self, readings: list[Reading]) -> int:
        """Send what is new; returns how many points went. Never raises."""
        todo = self.pending(readings)
        if not todo:
            return 0
        body = to_lines(todo, extra_tags=self._extra_tags)
        try:
            if self._client is not None:
                resp = await self._client.post(self.url, content=body, headers=self._headers,
                                               timeout=self._timeout)
            else:
                async with httpx.AsyncClient(follow_redirects=True) as client:
                    resp = await client.post(self.url, content=body, headers=self._headers,
                                             timeout=self._timeout)
        except httpx.HTTPError as e:
            self.last_error = f"{type(e).__name__}: {e}"
            logger.warning("InfluxDB push failed (%s); will retry", self.last_error)
            return 0
        if resp.status_code >= 300:
            self.last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            logger.warning("InfluxDB push refused (%s); will retry", self.last_error)
            return 0
        for r in todo:
            self._sent[r.station] = max(self._sent.get(r.station, 0.0), r.observed_at.timestamp())
        self.last_error = ""
        self.points_sent += len(todo)
        return len(todo)
