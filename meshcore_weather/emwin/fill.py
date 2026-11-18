"""The internet fill: the bot's one backup, with one rule.

The feed is the dish (SDRSource), or NOAA's EMWIN bundles on a bot without
one (InternetSource). A product the feed has not delivered within a grace of
being issued, 2 minutes for a warning and 15 for anything else
(`fill_grace_warning_min`, `fill_grace_min`), is taken from NWS over the
internet instead:

- **Text products** (forecasts, discussions, warnings, watches, statements,
  climate and river products) from api.weather.gov, which lists every NWS
  text product within about a minute of issue. One listing a minute of the
  types the bot reads (FILL_TYPES) says what was issued; the text of a
  product is fetched only once its grace is up and the feed still has not
  brought it. Matched by WMO heading, office and minute (`key`): over
  06:00-06:30Z on 2026-10-19 the API listed every product of those types the
  dish received, and the dish's copies all matched by that key.
- **Airport reports and forecasts** from NWS's own feeds on tgftp (DS.metar,
  DS.tafst): a file every five minutes with every report. The API has
  neither. Each file is read once its grace is up, and of the reports in it
  for stations the bot knows (its station table), those whose station has
  nothing as new from the feed (or from the fill already) are taken, as one
  product. Decided report by report, by station and time: on 2026-10-19 the
  dish's bundles came anywhere from 3 minutes to 3 hours late, and one fresh
  bundle had said every station was current, so KAUS 1553Z never came. A
  file counts as filling in only when the feed missed most of what it
  carries of it; stations EMWIN does not carry at all (some 200 of the
  table's, military fields mostly) are taken but never count.
- **Radar** from radar.weather.gov's standard mosaics: the pictures EMWIN
  carries, same size and same base map (94% of pixels the same between a dish
  frame and a web frame two hours apart, the rest echoes and the time). While
  a region's newest picture on the feed is older than `fill_radar_grace_min`,
  the web's newest is taken every five minutes. The radar reader times each
  picture from its own printed corner, as for the dish's.

Why one rule (2026-10-19): there were two backups. The dish's took NOAA's
internet bundles after 10 minutes of silence, but those are the uplink's own
queue, as late as the dish when NOAA fell behind on Oct 17-18; and NWS's METAR
feed came on when EMWIN ran 30 minutes late, for current conditions only,
while forecasts and warnings still came hours late. This covers both: a
silent dish means nothing arrives and everything is filled after its grace; a
late uplink means only what is late is filled.

The fill takes nothing the feed brought in time, so a bot whose dish works
uses the internet for one listing a minute and for whatever the dish dropped.
A product the feed delivers after the fill took it is a duplicate, and the
source drops it (`filled`); its arrival still counts towards how late the
uplink runs. Filled products say "internet" (spec 2.3, revision 7).
"""

from __future__ import annotations

import asyncio
import email.utils
import logging
import re
import time
import zlib
from collections import Counter, deque
from datetime import UTC, datetime, timedelta

import httpx

from meshcore_weather.config import settings
from meshcore_weather.emwin import nws_metar
from meshcore_weather.emwin.retention import WARNING_TYPES

logger = logging.getLogger(__name__)

# The product types the bot reads, by AWIPS type: everything a reply, a
# broadcast or the warning engine looks at (protocol/warnings.py
# _WARNING_PRODUCT_TYPES, emwin/retention.py WARNING_TYPES, core/services.py).
# Airport reports and forecasts come from the NWS feeds instead.
WARNING_FILL_TYPES = set(WARNING_TYPES) | {"TOR", "SVR", "SVS", "SPS", "FFW", "FFS", "FLW", "FLS", "FFA", "FLA",
                                           "WSW", "NPW", "RFW", "FWW", "MWW", "MWS", "SMW", "DSW", "EWW", "SQW",
                                           "CFW", "RVA", "WCN", "HLS", "TCV", "TSU", "AQA", "SWO"}
FILL_TYPES = WARNING_FILL_TYPES | {"AFD", "ZFP", "PFM", "SFT", "RWR", "LSR", "CLI"}

# radar.weather.gov's standard mosaic for each EMWIN radar product. Puerto
# Rico's EMWIN picture is the San Juan radar's (99% the same), not "CARIB".
RIDGE = {"RADREFUS": "CONUS", "RADSTHPL": "SOUTHPLAINS", "RADRCKST": "SOUTHROCKIES",
         "RADSMSVY": "SOUTHMISSVLY", "RADSTHES": "SOUTHEAST", "RADNTHES": "NORTHEAST",
         "RADGRTLK": "CENTGRLAKES", "RADUMSVY": "UPPERMISSVLY", "RADRCKNT": "NORTHROCKIES",
         "RADPACNW": "PACNORTHWEST", "RADPACSW": "PACSOUTHWEST", "RADALLAK": "ALASKA",
         "RADALLHI": "HAWAII", "RADALLPR": "TJUA", "RADALLGU": "GUAM"}

LIST_WINDOW = timedelta(minutes=40)     # each listing: products issued in the last 40 minutes
FIRST_LOOKBACK = timedelta(hours=6)     # ... and after a start, the last six hours, in half hours
LIST_LIMIT = 500                        # the API's most per answer; a full one is split in two
FETCH_PER_POLL = 60                     # product texts per poll, warnings first
OBS_EVERY = timedelta(minutes=5)        # the NWS feeds write a file every five minutes
OBS_FILE_MIN = 10                       # an airport file counts as filling in with at least this many of the feed's stations
RADAR_EVERY = timedelta(minutes=5)
KEEP = timedelta(hours=26)              # what was decided, for the counts and to decide once
ACTIVE_FILLS = 5                        # products filled in the last 30 minutes for it to count as filling in

_NAME_KEY_RE = re.compile(r"^A_([A-Z]{4}\d{2})([A-Z0-9]{4})(\d{6})")
_NAME_ID_RE = re.compile(r"_C_[A-Z]{4}_(\d{14})_\d+-\d-([A-Z0-9]{8})\.(TXT|GIF)$", re.IGNORECASE)
_UGC_STATE_RE = re.compile(r"^([A-Z]{2})[ZC]\d{3}", re.MULTILINE)


def key_of_name(name: str) -> tuple[str, str, str] | None:
    """(WMO heading, office, issue DDHHMM) of a text product's file name."""
    m = _NAME_KEY_RE.match(name)
    return m.groups() if m else None


def stamp_of_name(name: str) -> datetime | None:
    m = _NAME_ID_RE.search(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=UTC)
    except ValueError:
        return None


def grace(product_type: str) -> timedelta:
    minutes = settings.fill_grace_warning_min if product_type in WARNING_FILL_TYPES else settings.fill_grace_min
    return timedelta(minutes=minutes)


class IdBook:
    """The 8-character EMWIN id (AFDEWXTX) for a product's 6-character AWIPS id
    (AFDEWX). The store reads type, office and state out of it, and NWS's text
    carries only the six: the state is learned from the feed's own file names
    (some 2,200 ids a day), else is the state the office's products usually
    name, else the product's first UGC line, else US."""

    def __init__(self):
        self.ids: dict[str, str] = {}
        self.office_states: dict[str, Counter] = {}

    def learn(self, name: str) -> None:
        m = _NAME_ID_RE.search(name)
        k = key_of_name(name)
        if not m or not k:
            return
        eid = m.group(2).upper()
        self.ids.setdefault(eid[:6], eid)
        self.office_states.setdefault(k[1], Counter())[eid[6:]] += 1

    def emwin_id(self, awips: str, office: str, text: str) -> str:
        awips = awips.upper()
        if awips in self.ids:
            return self.ids[awips]
        states = self.office_states.get(office)
        if states:
            state = states.most_common(1)[0][0]
        else:
            m = _UGC_STATE_RE.search(text)
            state = m.group(1) if m else "US"
        return (awips + state)[:8].ljust(8, "X")


def product_from_api(item: dict, text: str, book: IdBook) -> dict | None:
    """One api.weather.gov product as a product dict, named and laid out like
    the dish's file (`\\r\\r\\n` lines, which is what pyIEM and the parsers are
    used to) under the center tag NWSA."""
    lines = text.replace("\r", "").split("\n")
    while lines and (not lines[0].strip() or lines[0].strip().isdigit()):   # the "000" sequence line
        lines.pop(0)
    if len(lines) < 2:
        return None
    head = lines[0].split()
    awips = lines[1].strip()
    if len(head) < 3 or not re.fullmatch(r"[A-Z0-9]{4,6}", awips) or not re.fullmatch(r"\d{6}", head[2]):
        return None
    ttaaii, cccc, ddhhmm = head[0], head[1], head[2]
    try:
        issued = datetime.fromisoformat(item["issuanceTime"]).astimezone(UTC)
    except (KeyError, ValueError):
        return None
    code = item.get("productCode") or awips[:3]
    eid = book.emwin_id(awips, cccc, text)
    seq = zlib.crc32(str(item.get("id", "")).encode()) % 1000000
    prio = 1 if code in WARNING_FILL_TYPES else 2
    return {
        "product_id": ttaaii,
        "station": cccc,
        "awips_id": eid,
        "timestamp": issued,
        "raw_text": "\r\r\n".join(lines).strip(),
        "filename": f"A_{ttaaii}{cccc}{ddhhmm}_C_NWSA_{issued:%Y%m%d%H%M%S}_{seq}-{prio}-{eid}.TXT",
        "source": "internet",
    }


class InternetFill:
    """Owned by a source (`host`), which answers what the feed has:

    - `host.fill_feed_has(key)`: the feed holds the text product with that key;
    - `host.fill_feed_newest(kind)`: the newest feed stamp of a radar product
      (RADSTHPL), or None;
    - `host.fill_feed_report(kind, station)`: the time of the newest airport
      report ("SAH") or forecast ("TAF") the feed brought for a station, or None;
    - `host.fill_take(products, kind)`: hold these ("text", "obs" or "radar"
      products; a radar one carries "bytes" instead of "raw_text"), returning
      how many were new;
    - `host.fill_radar` (bool): the host has somewhere to keep radar pictures.

    and tells it what the feed brought (`learn`) and what an earlier run of
    the fill left on disk (`restore`, with the text of an airport file)."""

    def __init__(self, host, transport: httpx.AsyncBaseTransport | None = None):
        self.host = host
        self.book = IdBook()
        self.filled: dict[tuple, float] = {}           # key -> when the fill took it (duplicates of the feed's are dropped)
        self.decided: dict[tuple, tuple] = {}          # key -> (issued, "feed" | "late" | "fill", type)
        self.pending: dict[tuple, dict] = {}           # listed, waiting for its grace or for the feed
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._listed_once = False
        self._text_next = self._obs_next = self._radar_next = 0.0
        self._feeds = {"SAH": nws_metar.NwsFeed(settings.nws_metar_url, nws_metar.metar_file, "airport report"),
                       "TAF": nws_metar.NwsFeed(settings.nws_taf_url, nws_metar.taf_file, "airport forecast")}
        # "SAH" / "TAF" -> station -> the time of the newest report / forecast the fill took
        self.reports: dict[str, dict[str, datetime]] = {"SAH": {}, "TAF": {}}
        self._radar_seen: dict[str, str] = {}          # product -> the Last-Modified taken
        # (when, "text"/"obs"/"obs reports"/"radar", how many, how many of them count as filling in)
        self.log: deque[tuple[float, str, int, int]] = deque(maxlen=5000)
        self.active_since: datetime | None = None
        self.spell_filled = 0                          # products filled since it last started filling in
        self.last_ok: datetime | None = None
        self.last_error: str | None = None             # the newest of `errors`
        self.errors: dict[str, str] = {}               # part -> its last failure, until that part works again
        self.started = time.time()

    # -- what the feed tells it ---------------------------------------------------

    def learn(self, name: str) -> None:
        self.book.learn(name)

    def restore(self, name: str, text: str = "") -> None:
        """A product an earlier run filled, found on disk at start; with its
        text, an airport file's reports are known taken too."""
        k = key_of_name(name)
        if k:
            self.filled[k] = time.time()
        kind = _airport_kind(name)
        if kind and text:
            took = self.reports[kind]
            for station, when in nws_metar.station_times(text, stamp_of_name(name) or datetime.now(UTC), kind):
                if station not in took or when > took[station]:
                    took[station] = when

    def is_duplicate(self, name: str) -> bool:
        """The feed's copy of a product the fill already took."""
        k = key_of_name(name)
        return k is not None and k in self.filled

    # -- polling --------------------------------------------------------------------

    @property
    def enabled(self) -> bool:
        return bool(settings.fill_enabled)

    async def poll(self, now: datetime | None = None) -> int:
        """Whatever part is due. Returns the products taken."""
        now = now or datetime.now(UTC)
        if not self.enabled:
            # Turned off in a spell: the spell ends here. Returning before
            # _activity left it open for good, and the public page said
            # "filling in from NWS" for a fill that had stopped (19 Oct).
            if self.active_since is not None:
                logger.info("Internet fill: turned off while filling in (for %s)", _span(now - self.active_since))
                self.active_since = None
            return 0
        mono = time.monotonic()
        taken = 0
        for part, due, every, fn in (("text", self._text_next, settings.fill_poll_interval, self._text),
                                     ("obs", self._obs_next, OBS_EVERY.total_seconds(), self._obs),
                                     ("radar", self._radar_next, RADAR_EVERY.total_seconds(), self._radar)):
            if mono < due:
                continue
            setattr(self, f"_{part}_next", mono + every)
            before = self.errors.get(part)
            try:
                taken += await fn(now)
            except Exception as e:  # noqa: BLE001 - one part failing must not stop the others
                self._failed(part, e, now)
                continue
            if self.errors.get(part) == before:
                self.errors.pop(part, None)            # it went through this time
        self._activity(now)
        return taken

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            from meshcore_weather.emwin.fetcher import FETCH_TIMEOUT, user_agent
            self._client = httpx.AsyncClient(timeout=FETCH_TIMEOUT, transport=self._transport,
                                             headers={"User-Agent": user_agent(), "Accept": "application/ld+json"})
        return self._client

    def _failed(self, part: str, e: Exception, now: datetime) -> None:
        if isinstance(e, httpx.HTTPStatusError):
            what = f"{e.response.status_code} {e.response.reason_phrase}".strip()
        elif isinstance(e, httpx.TimeoutException):
            what = "timeout"
        else:
            what = type(e).__name__
        self.last_error = f"{part}: {what} at {now:%H:%MZ}"
        self.errors[part.split()[0]] = self.last_error
        logger.warning("Internet fill (%s): %s", part, what, exc_info=not isinstance(e, httpx.HTTPError))

    def _took(self, kind: str, n: int, now: datetime, counted: int | None = None) -> None:
        """`n` taken, of which `counted` (all, unless said) count as filling in."""
        self.last_ok = now
        if n:
            counted = n if counted is None else min(counted, n)
            self.log.append((now.timestamp(), kind, n, counted))
            if self.active_since is not None:
                self.spell_filled += counted

    # -- text, from api.weather.gov ---------------------------------------------------

    async def _list(self, start: datetime, end: datetime) -> list[dict]:
        url = settings.fill_api_url.rstrip("/") + "/products"
        params = {"type": ",".join(sorted(FILL_TYPES)), "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"), "limit": LIST_LIMIT}
        resp = await self._http().get(url, params=params)
        resp.raise_for_status()
        items = resp.json().get("@graph") or []
        if len(items) >= LIST_LIMIT and end - start > timedelta(minutes=2):
            mid = start + (end - start) / 2
            return await self._list(start, mid) + await self._list(mid, end)
        return items

    async def _text(self, now: datetime) -> int:
        if self._listed_once:
            windows = [(now - LIST_WINDOW, now + timedelta(minutes=5))]
        else:
            t, windows = now - FIRST_LOOKBACK, []
            while t < now:
                windows.append((t, min(t + timedelta(minutes=30), now + timedelta(minutes=5))))
                t += timedelta(minutes=30)
        for a, b in windows:
            for item in await self._list(a, b):
                self._listed(item, now)
        self._listed_once = True
        taken = await self._decide(now)
        self._took("text", taken, now)
        # forget what is past mattering
        cutoff = now - KEEP
        self.decided = {k: v for k, v in self.decided.items() if v[0] >= cutoff}
        self.pending = {k: v for k, v in self.pending.items() if v["issued"] >= cutoff}
        self.filled = {k: v for k, v in self.filled.items() if v >= cutoff.timestamp() - 86400}
        return taken

    def _listed(self, item: dict, now: datetime) -> None:
        try:
            issued = datetime.fromisoformat(item["issuanceTime"]).astimezone(UTC)
            k = (item["wmoCollectiveId"], item["issuingOffice"], f"{issued:%d%H%M}")
        except (KeyError, ValueError, TypeError):
            return
        if k in self.decided or k in self.pending or issued > now + timedelta(minutes=10):
            return          # known, or a clock that is wrong (PTKK lists itself hours ahead)
        code = item.get("productCode") or ""
        if k in self.filled:
            self.decided[k] = (issued, "fill", code)
        elif self.host.fill_feed_has(k):
            self.decided[k] = (issued, self._how_the_feed_did(k, issued, code), code)
        else:
            self.pending[k] = dict(item, issued=issued, code=code)

    def _how_the_feed_did(self, k: tuple, issued: datetime, code: str) -> str:
        """"feed" when its copy came within the grace, "late" when after (but
        before the fill looked, so nothing was taken)."""
        arrived = getattr(self.host, "fill_feed_arrived", lambda k: None)(k)
        if arrived is None or arrived - issued.timestamp() <= grace(code).total_seconds():
            return "feed"
        return "late"

    async def _decide(self, now: datetime) -> int:
        """Each product waiting: the feed has it now, or its grace is up and it is fetched."""
        due = []
        for k, item in list(self.pending.items()):
            if self.host.fill_feed_has(k):
                self.decided[k] = (item["issued"], self._how_the_feed_did(k, item["issued"], item["code"]), item["code"])
                del self.pending[k]
            elif now - item["issued"] >= grace(item["code"]):
                due.append((item["code"] not in WARNING_FILL_TYPES, -item["issued"].timestamp(), k))
        due.sort()
        products = []
        for _, _, k in due[:FETCH_PER_POLL]:
            item = self.pending[k]
            url = settings.fill_api_url.rstrip("/") + "/products/" + str(item.get("id", ""))
            try:
                resp = await self._http().get(url)
                if resp.status_code == 404:          # withdrawn: nothing to take
                    del self.pending[k]
                    continue
                resp.raise_for_status()
                text = resp.json().get("productText") or ""
            except (httpx.HTTPError, ValueError) as e:
                # What came so far is still taken; the rest waits for the next poll.
                self._failed("text", e, now)
                break
            prod = product_from_api(item, text, self.book)
            del self.pending[k]
            if prod is None:
                continue
            self.filled[k] = now.timestamp()
            self.decided[k] = (item["issued"], "fill", item["code"])
            products.append(prod)
        if not products:
            return 0
        n = self.host.fill_take(products, "text")
        notable = [p["awips_id"] for p in products if p["awips_id"][:3] in WARNING_FILL_TYPES]
        logger.info("Internet fill: +%d text products the feed had not brought in time%s", n,
                    f" ({' '.join(notable[:8])}{' ...' if len(notable) > 8 else ''})" if notable else "")
        return n

    # -- airport reports and forecasts, from NWS's tgftp feeds -------------------------

    async def _obs(self, now: datetime) -> int:
        """The NWS files whose grace is up, each read once: of its reports for
        stations the bot knows, those the feed (or the fill) has nothing as new
        for, as one product. Returns the files taken from."""
        due = now - timedelta(minutes=settings.fill_grace_min)
        known = _stations()
        taken = counted = reports = 0
        for kind, feed in self._feeds.items():
            entries, make = _AIRPORT[kind]
            products, bulk, n_reports = [], 0, 0
            for written, sequence, text in await feed.files(self._http(), now, keep=lambda written: written <= due):
                chosen, carried, missed = [], 0, 0
                for station, when, entry in entries(text, written):
                    if station not in known:
                        continue
                    on_feed = self.host.fill_feed_report(kind, station)
                    took = self.reports[kind].get(station)
                    carried += on_feed is not None
                    if (on_feed is not None and on_feed >= when) or (took is not None and took >= when):
                        continue        # the feed brought it or a newer one, or the fill took it already
                    self.reports[kind][station] = when
                    chosen.append(entry)
                    missed += on_feed is not None
                prod = make(list(dict.fromkeys(chosen)), written, sequence) if chosen else None
                if prod is None:
                    continue
                products.append(prod)
                n_reports += len(chosen)
                # Filling in, not mopping up: the feed missed most of what it carries of this file.
                bulk += carried >= OBS_FILE_MIN and 2 * missed >= carried
            if products:
                n = self.host.fill_take(products, "obs")
                taken, counted, reports = taken + n, counted + min(bulk, n), reports + n_reports
                logger.info("Internet fill: +%d %ss from NWS the feed had not brought in time (%d files)",
                            n_reports, feed.kind, n)
        for took in self.reports.values():
            for station in [s for s, t in took.items() if t < now - KEEP]:
                del took[station]
        self._took("obs", taken, now, counted)
        self._took("obs reports", reports, now, 0)
        return taken

    # -- radar, from radar.weather.gov ------------------------------------------------

    async def _radar(self, now: datetime) -> int:
        if not getattr(self.host, "fill_radar", False):
            return 0
        products = []
        for awips, ridge in RIDGE.items():
            newest = self.host.fill_feed_newest(awips)
            if newest is not None and newest >= now - timedelta(minutes=settings.fill_radar_grace_min):
                continue
            url = f"{settings.fill_radar_url.rstrip('/')}/{ridge}_0.gif"
            headers = {"If-Modified-Since": self._radar_seen[awips]} if awips in self._radar_seen else {}
            try:
                resp = await self._http().get(url, headers=headers)
                if resp.status_code == 304:
                    continue
                resp.raise_for_status()
            except httpx.HTTPError as e:          # that region only
                self._failed(f"radar {ridge}", e, now)
                continue
            lastmod = resp.headers.get("Last-Modified")
            try:
                made = email.utils.parsedate_to_datetime(lastmod).astimezone(UTC) if lastmod else now
            except (TypeError, ValueError):
                made = now
            if not resp.content.startswith(b"GIF") or (newest is not None and made <= newest):
                continue
            if lastmod:
                self._radar_seen[awips] = lastmod
            seq = zlib.crc32(resp.content) % 1000000
            products.append({"awips_id": awips, "timestamp": made, "bytes": resp.content, "source": "internet",
                             "filename": f"Z_QATA00KWBC{made:%d%H%M}_C_NWSR_{made:%Y%m%d%H%M%S}_{seq}-3-{awips}.GIF"})
            await asyncio.sleep(0)
        n = self.host.fill_take(products, "radar") if products else 0
        if n:
            logger.info("Internet fill: +%d radar pictures from radar.weather.gov (%s)", n,
                        " ".join(p["awips_id"] for p in products))
        self._took("radar", n, now)
        return n

    # -- what it is doing, for the pages -------------------------------------------------

    def _activity(self, now: datetime) -> None:
        recent = sum(counted for t, _, _, counted in self.log if t >= now.timestamp() - 1800)
        if recent >= ACTIVE_FILLS and self.active_since is None:
            self.active_since = now
            self.spell_filled = recent
            logger.warning("Internet fill: filling in for the feed (%s)", self.reason(now))
        elif recent == 0 and self.active_since is not None:
            logger.info("Internet fill: the feed delivers in time again (filled in for %s)",
                        _span(now - self.active_since))
            self.active_since = None

    def reason(self, now: datetime | None = None) -> str:
        """Why the fill is taking things, in a few words."""
        lag = getattr(self.host, "feed_lag_min", None)
        quiet = getattr(self.host, "dish_quiet_min", None)
        q = quiet(now.timestamp() if now else None) if callable(quiet) else None
        if q is not None and q >= settings.fill_grace_min:
            return "the dish is quiet" if q == float("inf") else f"the dish has been quiet for {_span(timedelta(minutes=q))}"
        if lag is not None and lag >= settings.fill_grace_min:
            return f"EMWIN is running {_span(timedelta(minutes=lag))} late"
        # Said on the mesh's status channel and the public page: plain words, not the bot's own.
        return "some products came late or not at all" if self.active_since else "the feed delivers in time"

    def status(self, now: datetime | None = None) -> dict:
        """The fill for the portal, the public page, `sat` and the status channel (times unix seconds)."""
        now = now or datetime.now(UTC)
        hour = now - timedelta(hours=1)
        # what NWS issued 15 to 75 minutes ago, of the types the bot reads: by now each has been decided
        window = [v for v in self.decided.values() if hour - timedelta(minutes=15) <= v[0] < now - timedelta(minutes=15)]
        in_time = sum(1 for v in window if v[1] == "feed")
        since = now.timestamp() - 3600
        by_kind = Counter()
        for t, kind, n, _ in self.log:
            if t >= since:
                by_kind[kind] += n
        unix = lambda t: int(t.timestamp()) if t else None 
        return {
            "enabled": self.enabled,
            # Off is never filling in, even before the next poll ends the spell.
            "active": self.enabled and self.active_since is not None,
            "since": unix(self.active_since) if self.enabled else None,
            "reason": self.reason(now),
            "grace_min": {"warnings": settings.fill_grace_warning_min, "other": settings.fill_grace_min,
                          "radar": settings.fill_radar_grace_min},
            "last_hour": {"issued": len(window), "in_time": in_time,
                          "in_time_pct": round(100 * in_time / len(window)) if window else None,
                          "text": by_kind["text"], "obs_files": by_kind["obs"], "obs_reports": by_kind["obs reports"],
                          "radar": by_kind["radar"]},
            "waiting": len(self.pending),
            "last_ok": unix(self.last_ok),
            "last_error": self.last_error,
            "errors": dict(self.errors),
        }


# What an airport file is read as, and made into: (entries, product) by kind.
_AIRPORT = {"SAH": (nws_metar.metar_entries, nws_metar.collective),
            "TAF": (nws_metar.taf_entries, nws_metar.taf_collective)}


def _airport_kind(name: str) -> str | None:
    """"SAH" or "TAF" for one of the fill's own airport files, by its name."""
    if "_C_NWSF_" not in name:
        return None
    return "SAH" if name.endswith("-SAHOURLY.TXT") else "TAF" if name.endswith("-TAFALLUS.TXT") else None


def _stations():
    """The bot's station table: the stations a reply can name."""
    from meshcore_weather.geodata import resolver
    resolver.load()
    return resolver._stations


def _span(delta: timedelta) -> str:
    m = int(delta.total_seconds() // 60)
    return f"{m} min" if m < 120 else f"{m // 60} h {m % 60:02d} min"
