"""Airport reports and forecasts from NWS's own text feeds, for the internet fill.

EMWIN (the dish, and NOAA's internet bundles of the same broadcast) can fall
hours behind its own uplink queue. On 2026-10-17/18 everything it carried
arrived 2 to 3.5 h after KWIN filed it, while the same METARs were on NWS's
ordinary text feed on tgftp within minutes: KATT 181651Z was in DS.metar's
sn.0190.txt, written 16:55Z, and the dish still had nothing newer than
181051Z at 17:11Z.

That feed (`nws_metar_url`) is a directory of rolling files, one about every
five minutes, each a run of single-station bulletins:

    ####018000072####
    SAUS44 KEWX 181651
    MTRATT
    METAR KATT 181651Z AUTO VRB03KT 10SM CLR 19/05 A3039 RMK AO2 SLP287
    T01940050 $

Each file is repacked as one hourly collective in the layout the store already
reads (`WeatherStore._find_metar_raw`): one report per line ending in "=",
under a `SAHOURLY` name. The store takes a station's report from the newest
product it is in, so a fresher NWS report wins over the dish's and the dish's
wins again once EMWIN catches up. The products say "internet", which is where
they came from.

The airport forecasts are the same kind of feed (`nws_taf_url`, DS.tafst):
bulletins of `TAF PABI 191400Z ...`, kept as they are under a `TAFALLUS`
name, which is what the TAF replies look in.

The internet fill (emwin/fill.py) decides report by report: a file's reports
are read once its grace is up, and a product is made of those whose station
the feed has nothing as new for (`metar_entries`, `taf_entries`). The fill
learns what the feed has from the feed's own bundles (`station_times`).
"""

import logging
import re
import zlib
from datetime import UTC, datetime, timedelta

import httpx

logger = logging.getLogger(__name__)

# `<td><a href="sn.0190.txt">sn.0190.txt</a></td><td align="right">18-Oct-2026 16:55  </td>`;
# the listing's times are UTC.
_LISTING_RE = re.compile(r'href="(sn\.\d{4}\.txt)".*?(\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2})')
_SEPARATOR_RE = re.compile(r"^#{4}\d+#{4}$")
_REPORT_RE = re.compile(r"^(?:(?:METAR|SPECI)\s+)?([A-Z0-9]{4}\s+(?:COR\s+)?\d{6}Z.*)$")
# A report's station and time ("KAUS 191553Z", "SPECI KAUS COR 191612Z"), and
# a forecast's ("TAF KAUS 191720Z", "TAF AMD PABI ...", or "KAUS 191254Z" under
# a "TAF AMD" line of its own, as the dish's bundles have it).
_STATION_TIME_RE = {
    "SAH": re.compile(r"^(?:(?:METAR|SPECI)\s+)?([A-Z][A-Z0-9]{3})\s+(?:COR\s+)?(\d{2})(\d{2})(\d{2})Z\b"),
    "TAF": re.compile(r"^(?:TAF\s+)?(?:(?:AMD|COR)\s+)?([A-Z][A-Z0-9]{3})\s+(\d{2})(\d{2})(\d{2})Z\b"),
}

# A first poll takes this much of the feed: every station reports at least
# hourly, so the last 75 minutes hold each one's latest.
FIRST_WINDOW = timedelta(minutes=75)
# At most this many files a poll, so a long outage does not turn into one
# burst of downloads: the 00Z file alone is ~570 KB.
MAX_FILES_PER_POLL = 20


def parse_listing(html: str) -> list[tuple[str, datetime]]:
    """(file name, written at) for every feed file in the directory page."""
    out = []
    for name, when in _LISTING_RE.findall(html):
        try:
            out.append((name, datetime.strptime(when, "%d-%b-%Y %H:%M").replace(tzinfo=UTC)))
        except ValueError:
            continue
    return out


def reports_in(text: str) -> list[str]:
    """Every METAR/SPECI report in one feed file, each on one line ending "=".

    Bulletins are split at the `####...####` lines; a report starts at a line
    that opens with a station and a DDHHMMZ group (after an optional METAR or
    SPECI) and runs until "=" or the next report. Wrapped lines are joined."""
    reports: list[str] = []
    current: str | None = None

    def close() -> None:
        nonlocal current
        if current:
            reports.append(current.rstrip("= ") + "=")
        current = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line or _SEPARATOR_RE.match(line):
            close()
            continue
        m = _REPORT_RE.match(line)
        if m:
            close()
            current = m.group(1)
        elif current is not None:
            current += " " + line
        if current is not None and current.endswith("="):
            close()
    close()
    return reports


def _when(near: datetime, day: str, hour: str, minute: str) -> datetime | None:
    """A DDHHMM group as a time, in `near`'s month unless that lands more than
    an hour after `near` (the previous month's, then)."""
    year, month = near.year, near.month
    for _ in range(2):
        try:
            when = near.replace(year=year, month=month, day=int(day), hour=int(hour), minute=int(minute),
                                second=0, microsecond=0)
        except ValueError:
            when = None
        if when is not None and when <= near + timedelta(hours=1):
            return when
        year, month = (year, month - 1) if month > 1 else (year - 1, 12)
    return None


def station_times(text: str, near: datetime, kind: str) -> list[tuple[str, datetime]]:
    """(station, time) of every airport report ("SAH") or forecast ("TAF") in
    a bulletin or bundle, the times resolved near `near` (when it was made)."""
    rx, out = _STATION_TIME_RE[kind], []
    for line in text.splitlines():
        m = rx.match(line.strip())
        if m:
            when = _when(near, *m.groups()[1:])
            if when is not None:
                out.append((m.group(1), when))
    return out


def metar_entries(text: str, written: datetime) -> list[tuple[str, datetime, str]]:
    """(station, observed at, report) for every report in a METAR feed file."""
    out = []
    for report in reports_in(text):
        st = station_times(report, written, "SAH")
        if st:
            out.append((*st[0], report))
    return out


def bulletins(text: str) -> list[str]:
    """A feed file's bulletins, split at the `####...####` lines, each with
    its own line ends."""
    out, current = [], []
    for ln in text.replace("\r", "").split("\n"):
        if _SEPARATOR_RE.match(ln.strip()):
            out.append("\n".join(current).strip())
            current = []
        else:
            current.append(ln.rstrip())
    out.append("\n".join(current).strip())
    return [b for b in out if b]


def taf_entries(text: str, written: datetime) -> list[tuple[str, datetime, str]]:
    """(station, issued at, bulletin) for every TAF in a TAF feed file. A
    bulletin is the unit kept; one holding several TAFs comes once for each."""
    return [(station, when, b) for b in bulletins(text) for station, when in station_times(b, written, "TAF")]


def metar_file(text: str, written: datetime, sequence: int) -> dict | None:
    """One METAR feed file as a product, or None when it holds no report."""
    reports = reports_in(text)
    return collective(reports, written, sequence) if reports else None


def taf_file(text: str, written: datetime, sequence: int) -> dict | None:
    """One TAF feed file as a product: its bulletins as they are, under a
    TAFALLUS name, or None when it holds no TAF."""
    return taf_collective(bulletins(text), written, sequence)


def taf_collective(parts: list[str], written: datetime, sequence: int) -> dict | None:
    """TAF bulletins as one TAFALLUS product (a bulletin repeated in the file
    once), or None when none holds a TAF."""
    # Between two bulletins a blank line: where a TAF ends.
    lines = [ln for b in dict.fromkeys(parts) for ln in (*b.split("\n"), "")]
    if not any(ln.lstrip().startswith("TAF") for ln in lines):
        return None
    ddhhmm = f"{written:%d%H%M}"
    body = "\r\r\n".join(["FTUS99 NWSF " + ddhhmm, "TAFALLUS", *lines]).strip()
    return {
        "product_id": "FTUS99",
        "station": "NWSF",
        "awips_id": "TAFALLUS",
        "timestamp": written,
        "raw_text": body,
        "filename": f"A_FTUS99NWSF{ddhhmm}_C_NWSF_{written:%Y%m%d%H%M%S}_{sequence}-2-TAFALLUS.TXT",
        "source": "internet",
    }


def collective(reports: list[str], written: datetime, sequence: int) -> dict:
    """One feed file's reports as a product dict, named like an EMWIN file
    (`A_<WMO><stn><ddhhmm>_C_<center>_<ts>_<seq>-N-<AWIPS>.TXT`) so the store
    reads its type (SAH) and time from the name as it does the dish's."""
    ddhhmm = f"{written:%d%H%M}"
    body = "\n".join(["SAUS99 NWSF " + ddhhmm, "SAHOURLY", "METAR", *reports])
    return {
        "product_id": "SAUS99",
        "station": "NWSF",
        "awips_id": "SAHOURLY",
        "timestamp": written,
        "raw_text": body,
        "filename": f"A_SAUS99NWSF{ddhhmm}_C_NWSF_{written:%Y%m%d%H%M%S}_{sequence}-2-SAHOURLY.TXT",
        "source": "internet",
    }


class NwsFeed:
    """Polls one feed directory and hands back each new file it is asked for
    (`files`), or each as a product (`poll`; `make`: metar_file or taf_file)."""

    def __init__(self, url: str, make, kind: str = "SAH"):
        self.url = url.rstrip("/") + "/"
        self.make = make
        self.kind = kind
        self._taken: set[tuple[str, datetime]] = set()     # (file, written at) already turned into a product
        self.newest_file: datetime | None = None            # for the log and the portal
        self.last_error: str | None = None

    async def poll(self, client: httpx.AsyncClient, now: datetime | None = None, keep=None) -> list[dict]:
        """`files`, each made into a product dict."""
        products = []
        for when, sequence, text in await self.files(client, now, keep):
            prod = self.make(text, when, sequence)
            if prod is not None:
                products.append(prod)
        return products

    async def files(self, client: httpx.AsyncClient, now: datetime | None = None,
                    keep=None) -> list[tuple[datetime, int, str]]:
        """(written at, sequence, text) of each file of the last FIRST_WINDOW
        not taken yet that `keep(written)` accepts (all, without one), oldest
        first. A failure costs that poll only: the next one takes whatever it
        missed, by the listing. A file `keep` turns down is asked about again
        next time."""
        now = now or datetime.now(UTC)
        try:
            resp = await client.get(self.url)
            resp.raise_for_status()
            listing = parse_listing(resp.text)
        except httpx.HTTPError as e:
            self.last_error = f"{type(e).__name__} at {now:%H:%MZ}"
            logger.warning("NWS %s feed: listing failed (%s)", self.kind, e)
            return []
        since = now - FIRST_WINDOW
        todo = sorted((when, name) for name, when in listing
                      if when >= since and (name, when) not in self._taken and (keep is None or keep(when)))
        files = []
        for when, name in todo[-MAX_FILES_PER_POLL:]:
            try:
                resp = await client.get(self.url + name)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                self.last_error = f"{type(e).__name__} at {now:%H:%MZ}"
                logger.warning("NWS %s feed: %s failed (%s)", self.kind, name, e)
                continue
            self._taken.add((name, when))
            sequence = int(name[3:7]) * 100000 + zlib.crc32(resp.content) % 100000
            files.append((when, sequence, resp.content.decode("latin-1")))
            if self.newest_file is None or when > self.newest_file:
                self.newest_file = when
        # The listing rolls over daily: forget what can no longer come back.
        self._taken = {k for k in self._taken if k[1] >= now - timedelta(hours=26)}
        if files:
            self.last_error = None
        return files
