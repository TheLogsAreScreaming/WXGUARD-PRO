"""EMWIN product sources: NOAA's internet bundles (InternetSource), or the
goestools output directory fed by a GOES satellite receiver (SDRSource).
Whichever is the feed, the internet fill (emwin/fill.py) takes from NWS what
the feed has not delivered within a grace of being issued.

InternetSource takes NOAA's bundles (_NoaaBundles): the last hour's bundle
first, then the 2-minute one every poll, the hour's again after any fetch
that failed and every half hour regardless; the file-name dedup makes a
product that comes twice cost nothing. Products are held for their retention
(emwin/retention.py: 12 hours, warnings and forecasts longer).

The EMWIN ZIP bundles use the same file names and bodies as the GOES
satellite downlink, so the parser cannot tell the two apart.
"""

import asyncio
import io
import json
import logging
import os
import random
import re
import shutil
import statistics
import threading
import time
import zipfile
from abc import ABC, abstractmethod
from collections import deque
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import httpx

from meshcore_weather import __version__
from meshcore_weather.config import settings
from meshcore_weather.emwin import nws_metar
from meshcore_weather.emwin.fill import InternetFill, key_of_name, stamp_of_name
from meshcore_weather.emwin.retention import is_expired, longest_hours, max_age_hours

logger = logging.getLogger(__name__)

EMWIN_FILENAME_RE = re.compile(
    r"A_(\w{4,6})(\w{4})(\d{6,8})_C_[A-Z]{4}_\d+_\d+-\d+-(\w+)\.TXT",
    re.IGNORECASE,
)

EMWIN_TS_RE = re.compile(r"_(\d{14})_")

# The dish's own files carry the uplink's station tag and, after it, the
# product's creation time: `..._C_KWIN_20261016095401_...`. A file written by
# anything else (a disabled backup once left `_C_INET_` files in the dish's
# directory) is a product, but not a sign of life from the dish.
KWIN_TS_RE = re.compile(r"_C_KWIN_(\d{14})_")

# While the internet is the feed (InternetSource, or the dish's backup), the
# last-hour bundle is taken again this often, and after any fetch that
# failed: NOAA's server answered a truncated ZIP or 403 one to three times an
# hour during the Oct 14-16 outage, and 200 with 0 bytes twice on Oct 17 at
# 20:24Z, and each failed 2-minute bundle used to be lost for good.
HOUR_BUNDLE_EVERY_S = 1800

# A fetch that hangs gives up after this (per read, 5 s to connect): the
# 2-minute bundle is ~43 KB, and a WAN that hung used to hold a poll a minute.
FETCH_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

# NOAA refusing (403), throttling (429) or failing (5xx): the internet source
# waits twice as long after each such answer, up to this, and goes back to
# the poll interval at the first bundle that comes in whole. Every wait is
# moved by up to POLL_JITTER either way, so bots started together (a power
# cut, a release) do not poll in step.
BACKOFF_MAX_S = 900
POLL_JITTER = 0.10

PROJECT_URL = "https://github.com/digitaino/meshwx"


def user_agent() -> str:
    """How the bot names itself to NOAA's server: the project, its version
    and, when MCW_OPERATOR_CONTACT is set, whom to ask, so an administrator
    who sees the traffic can write before blocking it. (httpx sent
    "python-httpx/x" before, which says nothing.)"""
    contact = "".join(c for c in (getattr(settings, "operator_contact", "") or "")
                      if " " <= c <= "~" and c not in "()").strip()
    return f"meshcore-weather/{__version__} (+{PROJECT_URL}{'; ' + contact if contact else ''})"


def read_bundle(data: bytes, source: str = "internet") -> list[dict]:
    """An EMWIN ZIP bundle (zips inside zips allowed) -> product dicts."""
    products = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for name in zf.namelist():
                if name.lower().endswith(".zip"):
                    try:
                        products.extend(read_bundle(zf.read(name), source))
                    except Exception:
                        pass
                elif name.lower().endswith(".txt"):
                    try:
                        raw_text = zf.read(name).decode("utf-8", errors="replace").strip()
                        if raw_text:
                            prod = parse_emwin_file(name, raw_text, source=source)
                            if prod:
                                products.append(prod)
                    except Exception:
                        pass
    except zipfile.BadZipFile:
        logger.warning("Invalid ZIP data")
    return products


class EMWINSource(ABC):
    @abstractmethod
    async def fetch_products(self) -> list[dict]:
        ...

    @abstractmethod
    async def start(self) -> None:
        ...

    @abstractmethod
    async def stop(self) -> None:
        ...


CACHE_FILE = Path(settings.data_dir) / "emwin_cache" / "products.jsonl"


def parse_emwin_file(filename: str, raw_text: str, source: str = "") -> dict | None:
    """Filename + body -> product dict. Shared by the zip and directory sources.

    `source` is how the bot got the file — "sdr" off its own GOES dish,
    "internet" from NOAA — and rides through the store onto the wire
    (spec 2.3, revision 7). Each source stamps its own products; a caller
    that does not say leaves it unstated.
    """
    product_id = "UNKNOWN"
    station = "UNKNOWN"
    awips_id = ""

    m = EMWIN_FILENAME_RE.search(filename)
    if m:
        product_id = m.group(1)
        station = m.group(2)
        awips_id = m.group(4)

    if product_id == "UNKNOWN":
        for line in raw_text.splitlines()[:5]:
            parts = line.strip().split()
            if len(parts) >= 2 and len(parts[0]) >= 4 and parts[0].isalnum():
                product_id = parts[0]
                station = parts[1]
                break

    # Extract timestamp from filename
    ts = datetime.now(timezone.utc)
    m_ts = EMWIN_TS_RE.search(filename)
    if m_ts:
        try:
            ts = datetime.strptime(m_ts.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    return {
        "product_id": product_id,
        "station": station,
        "awips_id": awips_id,
        "timestamp": ts,
        "raw_text": raw_text,
        "filename": filename,
        "source": source,
    }


# The internet source's cache file is a journal: each poll appends the
# products it brought, and the file is rewritten as the live products alone
# once it holds more than CACHE_COMPACT_FACTOR lines per live product plus
# CACHE_COMPACT_SLACK. At the dish's measured 21.6 files a minute that is an
# append of ~85 KB a minute and a rewrite about twice a day; the whole store
# (~100 MB) used to be rewritten on the event loop after every poll.
CACHE_COMPACT_FACTOR = 2
CACHE_COMPACT_SLACK = 2000


def _cache_line(prod: dict) -> str:
    rec = dict(prod)
    rec["timestamp"] = rec["timestamp"].isoformat()
    return json.dumps(rec) + "\n"


def _feed_kind(name: str) -> str | None:
    """What the fill asks the feed's newest of: US airport-report bundles
    ("SAH"), airport forecasts ("TAF"), or a radar product (its AWIPS id)."""
    upper = name.upper()
    if upper.endswith("-SAHOURLY.TXT") and upper.startswith("A_SAUS"):
        return "SAH"
    if upper.endswith("-TAFALLUS.TXT"):
        return "TAF"
    if upper.endswith(".GIF") and "-RAD" in upper:
        return upper.rsplit("-", 1)[-1][:-4]
    return None


class _LagTracker:
    """How late the feed runs, from the creation time in each product's name
    against when it arrived. A class using this sets `_lag_samples` and
    `newest_product_ts`."""

    # -- how late the products are ----------------------------------------------

    @property
    def feed_lag_min(self) -> int | None:
        """How far behind the uplink is running, in minutes: the median over
        the last 50 products that arrived fresh, once there are five to go
        by. Only arrivals in the last hour count: a feed that has gone quiet
        says nothing about how late the uplink runs now, and the lag of a
        replay that has ended must not be reported as current."""
        since = time.time() - 3600
        # The newest 50 by arrival, not the last 50 appended: the startup
        # scan reads day folders in no particular order, and the replayed
        # files of an older folder read last would pass for the current lag
        # ("~5h behind" at a restart on 17 Oct while the feed ran 22 min late).
        recent = sorted((s for s in self._lag_samples if s[0] >= since), reverse=True)[:50]
        if len(recent) < 5:
            return None
        return int(statistics.median(lag for _, lag in recent))

    def _note_created(self, name: str) -> datetime | None:
        """The creation time in a product's name, kept when it is the newest."""
        m = KWIN_TS_RE.search(name)
        if not m:
            return None
        try:
            created = datetime.strptime(m.group(1) + "+0000", "%Y%m%d%H%M%S%z")    # the name's time is UTC
        except ValueError:
            return None
        if self.newest_product_ts is None or created > self.newest_product_ts:
            self.newest_product_ts = created
        return created

    def _note_lag(self, name: str, mtime: float, wall: float) -> None:
        """A product that arrived at `mtime`: how long after its creation."""
        created = self._note_created(name)
        if created is None:
            return
        # The backlog at start is days of files in no particular order; only
        # what arrived in the last hour says anything about now.
        if mtime >= wall - 3600:
            self._lag_samples.append((mtime, max(0.0, (mtime - created.timestamp()) / 60)))


class _FillHost:
    """What a source tells the internet fill about its feed: which text
    products it holds (by WMO heading, office and minute), the newest of the
    kinds the fill watches, each station's newest airport report and forecast,
    and what each source does with what the fill takes (`fill_take`)."""

    fill_radar = False

    def _init_fill(self) -> None:
        self.fill = InternetFill(self)
        self._feed_keys: dict[tuple, float] = {}      # key -> when the feed's copy arrived (unix)
        self._feed_newest: dict[str, datetime] = {}
        # "SAH" / "TAF" -> station -> the time of the newest report / forecast the feed brought
        self._feed_reports: dict[str, dict[str, datetime]] = {"SAH": {}, "TAF": {}}

    def _feed_saw(self, name: str, arrived: float | None = None) -> bool:
        """One of the feed's own products, arrived at `arrived` (now when not
        said): learn its id, note it. False when it is the feed's late copy of
        one the fill already took, to be dropped."""
        self.fill.learn(name)
        if self.fill.is_duplicate(name):
            return False
        stamp = stamp_of_name(name)
        k = key_of_name(name)
        if k:
            self._feed_keys[k] = arrived if arrived is not None else time.time()
        kind = _feed_kind(name)
        if kind and stamp and (kind not in self._feed_newest or stamp > self._feed_newest[kind]):
            self._feed_newest[kind] = stamp
        return True

    def _feed_read(self, name: str, text: str) -> None:
        """The body of one of the feed's own products: for an airport report
        or forecast bundle, each station's newest is noted for the fill."""
        kind = _feed_kind(name)
        if kind not in self._feed_reports or not text:
            return
        newest = self._feed_reports[kind]
        for station, when in nws_metar.station_times(text, stamp_of_name(name) or datetime.now(UTC), kind):
            if station not in newest or when > newest[station]:
                newest[station] = when

    def _forget_feed_keys(self, now: datetime) -> None:
        cutoff = now.timestamp() - 2 * 86400
        self._feed_keys = {k: t for k, t in self._feed_keys.items() if t >= cutoff}
        old = now - timedelta(days=2)
        for kind, newest in self._feed_reports.items():
            self._feed_reports[kind] = {s: t for s, t in newest.items() if t >= old}

    def fill_feed_has(self, key: tuple) -> bool:
        return key in self._feed_keys

    def fill_feed_arrived(self, key: tuple) -> float | None:
        """When the feed's copy came (unix), or None."""
        return self._feed_keys.get(key)

    def fill_feed_newest(self, kind: str) -> datetime | None:
        return self._feed_newest.get(kind)

    def fill_feed_report(self, kind: str, station: str) -> datetime | None:
        """The time of the newest airport report ("SAH") or forecast ("TAF")
        for a station that the feed brought, or None when it brought none."""
        return self._feed_reports[kind].get(station)


class _NoaaBundles(_LagTracker):
    """NOAA's internet bundles, as InternetSource takes them.

    The first fetch is the last hour's bundle (`emwin_base_url`), then the
    2-minute one (`emwin_poll_url`) at every poll. A fetch that fails (no
    answer, an error status, a timeout, 0 bytes, not a ZIP — a truncated one
    is not — or a ZIP with no product in it) is made good by the hour's
    bundle at the next poll, and the hour's is taken every
    HOUR_BUNDLE_EVERY_S regardless. Products are keyed by file name, so a
    bundle taken twice holds nothing twice.

    A class using this sets `_client`, `_hour_fetched`, `_refetch_hour`,
    `_get_error`, `_get_status`, `_lag_samples` and `newest_product_ts`, and
    says what a failed fetch leaves on record (`_fetch_failed`).
    """

    _net_label = "EMWIN internet"          # how its log lines start

    def _make_client(self, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
        # `transport` is for tests (httpx.MockTransport); the bot passes none.
        return httpx.AsyncClient(timeout=FETCH_TIMEOUT, headers={"User-Agent": user_agent()},
                                 transport=transport)

    async def _get(self, url: str) -> bytes | None:
        if self._client is None:
            self._client = self._make_client()
        try:
            resp = await self._client.get(url)
            resp.raise_for_status()
            return resp.content
        except httpx.TimeoutException:
            self._get_error = "timeout"
        except httpx.HTTPStatusError as e:
            self._get_status = e.response.status_code
            self._get_error = f"{e.response.status_code} {e.response.reason_phrase}".strip()
        except httpx.HTTPError as e:
            self._get_error = type(e).__name__
        logger.warning("%s: %s (%s)", self._net_label, self._get_error, url)
        return None

    def _bundle_url(self, mono: float) -> str:
        """The bundle the next fetch takes."""
        hour_due = self._hour_fetched is None or mono - self._hour_fetched >= HOUR_BUNDLE_EVERY_S
        return settings.emwin_base_url if self._refetch_hour or hour_due else settings.emwin_poll_url

    def _bundle_done(self, url: str, ok: bool, mono: float) -> None:
        if not ok:
            self._refetch_hour = True              # make it good with the hour bundle next time
        elif url == settings.emwin_base_url:
            self._hour_fetched = mono
            self._refetch_hour = False

    async def _read_internet(self, url: str, now: datetime) -> list[dict] | None:
        """The bundle at `url` as product dicts, or None when the fetch failed."""
        self._get_error = None
        self._get_status = None
        data = await self._get(url)
        if not data:
            # 200 with 0 bytes: twice on 2026-10-17 at 20:24Z.
            what = self._get_error or ("0 bytes" if data is not None else "no response")
        elif not zipfile.is_zipfile(io.BytesIO(data)):
            what = "invalid zip"
        else:
            products = await asyncio.get_running_loop().run_in_executor(None, read_bundle, data, "internet")
            if products:
                return products
            what = "empty bundle"
        if self._get_error is None:                # _get has said its own
            logger.warning("%s: %s (%s)", self._net_label, what, url)
        self._fetch_failed(what, now)
        return None

    def _fetch_failed(self, what: str, now: datetime) -> None:
        raise NotImplementedError


class InternetSource(_FillHost, _NoaaBundles, EMWINSource):
    """NOAA's EMWIN bundles over the internet: the feed of every bot without
    a dish.

    **Fetching.** The hour's bundle at start, then the 2-minute bundle every
    `emwin_poll_interval`, with the hour's again after any failed fetch and
    every half hour (_NoaaBundles). When NOAA answers 403, 429 or 5xx the
    wait doubles with each such answer, up to BACKOFF_MAX_S, until a bundle
    comes in whole; every wait is moved by up to ±POLL_JITTER. Requests name
    the bot and its operator (`user_agent`).

    **Health**, under SDRSource's names where they mean the same:
    `feed_lag_min` (median minutes between a product's creation and its
    arrival in the 2-minute bundle; the hour's bundle is catch-up and does
    not count), `newest_product_ts`, `last_ok` (the last fetch that brought
    a product) and `last_error` / `last_error_at` ("403 Forbidden at
    14:03Z", until a bundle comes in whole).

    **The cache file** (data/emwin_cache/products.jsonl, one product per
    line) lets a restart answer at once. Each poll appends what it brought,
    in the executor; the file is rewritten as the live products, through a
    temp file and os.replace, only once it has grown to twice their number
    (CACHE_COMPACT_FACTOR). A line torn by a crash is skipped at load.
    """

    _net_label = "EMWIN internet"

    def __init__(self, cache_file: Path | None = None):
        self.cache_file = Path(cache_file) if cache_file is not None else \
            Path(settings.data_dir) / "emwin_cache" / "products.jsonl"
        self._client: httpx.AsyncClient | None = None
        self._products: dict[str, dict] = {}  # keyed by filename for dedup
        self._poll_task: asyncio.Task | None = None
        self._running = False
        self._rng = random.Random()
        # The fetching (_NoaaBundles)
        self._hour_fetched: float | None = None       # monotonic time the hour bundle last came in whole
        self._refetch_hour = False                    # a fetch failed: take the hour bundle next
        self._get_error: str | None = None            # what the last _get ran into, for the record
        self._get_status: int | None = None           # ... and the HTTP status NOAA answered with
        self._refusals = 0                            # 403/429/5xx in a row: the backoff
        # Health
        self.last_ok: datetime | None = None          # last fetch that brought a product
        self.last_error: str | None = None            # "403 Forbidden at 14:03Z", until a bundle comes in whole
        self.last_error_at: datetime | None = None
        self.newest_product_ts: datetime | None = None  # the newest creation time NOAA gave us
        self._lag_samples: deque[tuple[float, float]] = deque(maxlen=1000)   # (arrival, minutes behind)
        # The cache file
        self._cache_lock = threading.Lock()
        self._unsaved: list[dict] = []    # taken, not yet on the file
        self._cache_lines = 0             # lines in the file, live or not
        self._cache_loaded = False        # it was read: only then may it be rewritten
        self._cache_dirty = False         # a write failed: rewrite it whole next time
        self._cache_torn = False          # it ends mid-line (a crash in an append)
        self._init_fill()

    async def start(self) -> None:
        if self._client is None:
            self._client = self._make_client()
        self._running = True

        # Restore cached products from disk. In a thread: it is thousands of
        # JSON lines, and the radio is already listening by now (main.py
        # loads the backlog behind the radio).
        await asyncio.get_running_loop().run_in_executor(None, self._load_cache)

        # The first fetch is the last hour's bundle, for the time the bot was down.
        try:
            await self.poll_once()
        except Exception:
            logger.exception("Error in the first EMWIN fetch")

        self._poll_task = asyncio.create_task(self._poll_loop())
        logger.info(
            "EMWIN source started (%d products, polling every %ds)",
            len(self._products),
            settings.emwin_poll_interval,
        )

    async def stop(self) -> None:
        self._running = False
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        if self._client is None:
            return          # never started
        # Every product went to the file as it came; this is only what a
        # cancelled poll or a failed write left over.
        if self._unsaved or self._cache_dirty:
            await self._persist()
        await self.fill.stop()
        await self._client.aclose()
        self._client = None
        logger.info("EMWIN source stopped (%d products in store)", len(self._products))

    # -- polling ----------------------------------------------------------------

    def poll_wait_s(self, jitter: bool = True) -> float:
        """Seconds to the next poll: the interval, doubled for each refusal
        in a row up to BACKOFF_MAX_S, moved by up to ±POLL_JITTER."""
        interval = max(1.0, float(settings.emwin_poll_interval))
        wait = interval
        if self._refusals:
            wait = min(interval * 2 ** min(self._refusals, 16), max(float(BACKOFF_MAX_S), interval))
        if jitter:
            wait *= self._rng.uniform(1 - POLL_JITTER, 1 + POLL_JITTER)
        return wait

    async def _poll_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self.poll_wait_s())
            try:
                await self.poll_once()
            except Exception:
                logger.exception("Error polling EMWIN data")

    async def poll_once(self, now: datetime | None = None) -> int | None:
        """One fetch of the bundle due, into the store and onto the cache
        file. Returns how many products were new, or None when it failed."""
        now = now or datetime.now(UTC)
        mono = time.monotonic()
        url = self._bundle_url(mono)
        new = await self._fetch(url, now)
        self._bundle_done(url, new is not None, mono)
        if new is not None:
            self._refusals = 0
        elif self._get_status is not None and (self._get_status in (403, 429) or self._get_status >= 500):
            self._refusals += 1
            logger.warning("EMWIN internet: NOAA answered %s; waiting ~%.0f s before the next poll",
                           self._get_error, self.poll_wait_s(jitter=False))
        try:
            await self.fill.poll(now)
        except Exception:
            logger.exception("Error in the internet fill")
        self._expire_old(now)
        self._forget_feed_keys(now)
        if new:
            logger.info("Poll: +%d new products (%d total)", len(new), len(self._products))
        await self._persist()
        return None if new is None else len(new)

    async def _fetch(self, url: str, now: datetime) -> list[dict] | None:
        """The bundle at `url` into the store: the products that were new,
        or None when the fetch failed."""
        products = await self._read_internet(url, now)
        if products is None:
            return None
        new = self._take(products, now, fresh=url != settings.emwin_base_url)
        self.last_error = self.last_error_at = None
        if new:
            self.last_ok = now
        return new

    def _fetch_failed(self, what: str, now: datetime) -> None:
        self.last_error = f"{what} at {now:%H:%MZ}"
        self.last_error_at = now

    def _take(self, products: list[dict], now: datetime, fresh: bool) -> list[dict]:
        """Hold the products not held yet. `fresh`: they came in the
        2-minute bundle, so their arrival says how late the uplink runs; the
        hour's bundle is catch-up and says nothing about that."""
        wall = now.timestamp()
        new: list[dict] = []
        for prod in products:
            name = prod.get("filename") or ""
            if not name or name in self._products:
                continue
            if is_expired((prod.get("awips_id") or "")[:3], prod["timestamp"], now):
                continue
            if fresh:
                self._note_lag(name, wall, wall)
            else:
                self._note_created(name)
            if not self._feed_saw(name, wall):
                continue                # the fill took it already: this copy is late
            self._feed_read(name, prod.get("raw_text") or "")
            self._products[name] = prod
            new.append(prod)
        self._unsaved.extend(new)
        return new

    def fill_take(self, products: list[dict], kind: str) -> int:
        """What the internet fill took: held, and onto the cache file like the rest."""
        new = []
        for prod in products:
            name = prod.get("filename") or ""
            if not name or name in self._products or "raw_text" not in prod:
                continue
            self._products[name] = prod
            new.append(prod)
        self._unsaved.extend(new)
        return len(new)

    def _expire_old(self, now: datetime | None = None) -> None:
        """Remove products past their retention (warnings keep longer)."""
        now = now or datetime.now(UTC)
        before = len(self._products)
        self._products = {
            k: v for k, v in self._products.items()
            if not is_expired((v.get("awips_id") or "")[:3], v.get("timestamp") or now, now)
        }
        removed = before - len(self._products)
        if removed:
            logger.debug("Expired %d old products", removed)

    # -- the cache file -----------------------------------------------------------

    async def _persist(self) -> None:
        """What came since the last write onto the cache file, off the event
        loop: appended, or the file rewritten as the live products once it
        has more than CACHE_COMPACT_FACTOR lines per live product (expired
        and torn lines only go then)."""
        compact = self._cache_loaded and (
            self._cache_dirty
            or self._cache_lines + len(self._unsaved)
            > CACHE_COMPACT_FACTOR * len(self._products) + CACHE_COMPACT_SLACK)
        if not compact and not self._unsaved:
            return
        new, self._unsaved = self._unsaved, []
        live = list(self._products.values()) if compact else None
        lines = await asyncio.get_running_loop().run_in_executor(None, self._write_cache, new, live)
        if lines is None:
            # Kept for the next write, as long as they are held: a file that
            # cannot be written for days must not hold every product ever taken.
            self._unsaved = [p for p in new + self._unsaved if p.get("filename") in self._products]
            self._cache_dirty = self._cache_loaded
        elif live is not None:
            self._cache_lines, self._cache_dirty = lines, False
        else:
            self._cache_lines += lines

    def _write_cache(self, new: list[dict], live: list[dict] | None) -> int | None:
        """In the executor: append `new`, or with `live` rewrite the file as
        exactly those (temp file, fsync, os.replace: a crash leaves the old
        file or the new one, never half of one). Returns the lines written,
        None when it could not."""
        path = self.cache_file
        tmp = path.with_name(path.name + ".tmp")
        with self._cache_lock:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                if live is not None:
                    with open(tmp, "w", encoding="utf-8") as f:
                        f.writelines(_cache_line(p) for p in live)
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(tmp, path)
                    self._cache_torn = False
                    logger.info("EMWIN cache: rewrote %s with the %d live products", path, len(live))
                    return len(live)
                with open(path, "a", encoding="utf-8") as f:
                    if self._cache_torn:
                        f.write("\n")          # the torn line stays one bad line, not two
                        self._cache_torn = False
                    f.writelines(_cache_line(p) for p in new)
                return len(new)
            except OSError as e:
                logger.warning("EMWIN cache: could not write %s: %s", path, e)
            except Exception:
                logger.exception("EMWIN cache: could not write %s", path)
            if live is not None:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    logger.debug("EMWIN cache: could not remove %s", tmp)
            return None

    def _load_cache(self) -> None:
        """Products from the cache file, at start (in the executor). The old
        whole-file saves and the journal are the same format, one product
        per line; an expired line, a file name already loaded and a torn or
        garbled line are skipped, and the rest still load."""
        path = self.cache_file
        now = datetime.now(UTC)
        count = lines = bad = 0
        last = ""
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for raw in f:
                    lines += 1
                    last = raw
                    if not raw.strip():
                        continue
                    try:
                        rec = json.loads(raw)
                        ts = datetime.fromisoformat(rec["timestamp"])
                        fname = rec.get("filename") or ""
                    except (ValueError, KeyError, TypeError, AttributeError):
                        bad += 1
                        continue
                    rec["timestamp"] = ts if ts.tzinfo else ts.replace(tzinfo=UTC)
                    # This cache is only ever this source's own products, so a
                    # line written before revision 7 is still an internet one.
                    rec.setdefault("source", "internet")
                    if not fname or fname in self._products \
                            or is_expired((rec.get("awips_id") or "")[:3], rec["timestamp"], now):
                        continue
                    self._products[fname] = rec
                    self._note_created(fname)
                    if KWIN_TS_RE.search(fname):
                        self._feed_saw(fname)
                        self._feed_read(fname, rec.get("raw_text") or "")
                    else:                       # an earlier run's fill
                        self.fill.restore(fname, rec.get("raw_text") or "")
                    count += 1
        except FileNotFoundError:
            pass
        except OSError as e:
            # Not loaded, so never rewritten: what is in it may still be read next time.
            logger.warning("EMWIN cache: could not read %s: %s", path, e)
            return
        self._cache_lines = lines
        self._cache_torn = bool(last) and not last.endswith("\n")
        self._cache_loaded = True
        if bad:
            logger.warning("EMWIN cache: skipped %d unreadable line(s) in %s", bad, path)
        if count:
            logger.info("Restored %d products from cache", count)

    def _parse_emwin_file(self, filename: str, raw_text: str) -> dict | None:
        return parse_emwin_file(filename, raw_text, source="internet")

    async def fetch_products(self) -> list[dict]:
        return list(self._products.values())


# Product types worth a console line when they arrive from the dish.
_NOTABLE = {"TOR", "SVR", "SVS", "FFW", "FFS", "FLW", "FLS", "NPW", "WSW", "MWW", "SMW",
            "SPS", "CFW", "RFW", "EWW", "HLS", "TCV", "WOU", "WCN", "SEL", "ALT", "WAR", "WAT"}


class SDRSource(_FillHost, _LagTracker, EMWINSource):
    """EMWIN products from the goestools output directory on disk.

    goesproc's `emwin` handler writes every product as its own file under
    `<sdr_emwin_dir>/YYYY-MM-DD/`, named exactly like the internet bundle
    (`A_<WMO><stn><ddhhmm>_C_KWIN_<ts>_<seq>-N-<AWIPS>.TXT`), with the same
    `\\r\\r\\n` bodies. So this source is a directory watcher and nothing
    more: scan the date directories that can still hold products younger
    than `emwin_max_age_hours`, read each new file as bytes (text mode
    would turn `\\r\\r\\n` into blank lines and break pyIEM), and hand it to
    the same parser the zip path uses. No network, no cache file: the
    files on disk are the cache.

    **The internet fill** (emwin/fill.py) takes from NWS what the dish has
    not brought within its grace. What it takes is written under
    `fallback_root` in day folders like the dish's (radar pictures too), so a
    restart keeps it; that folder is scanned with the dish's and pruned the
    same way. A dish file that comes after the fill took the same product
    (same WMO heading, office and minute) is not held twice.

    **How late the products are.** goesproc writes a file the moment it comes
    off the air, so the file's mtime against the creation time in its name is
    how far behind the uplink is running: on 2026-10-16 NOAA replayed a
    backlog for ten hours and every product arrived five to ten hours old,
    on the dish and on the internet alike, while every file was "17 s old".
    `feed_lag_min` is the median over the last 50 of the dish's files, of
    those written in the last hour.
    """

    def __init__(self, root: Path | None = None, fallback_root: Path | None = None):
        self.root = Path(root or settings.sdr_emwin_dir).expanduser()
        # The production source keeps what the fill takes next to the bot's
        # other data; a source pointed somewhere else (a test) keeps nothing
        # on disk unless it is given a folder for it.
        if fallback_root is None and root is None:
            fallback_root = Path(settings.data_dir) / "emwin_internet"
        self.fallback_root = Path(fallback_root).expanduser() if fallback_root else None
        self.fill_radar = self.fallback_root is not None
        self._products: dict[str, dict] = {}
        self._seen: set[str] = set()
        self._poll_task: asyncio.Task | None = None
        self._running = False
        self._seen_initial = False
        self.newest_mtime: float | None = None    # newest file the DISH wrote, for `sat`
        self._lag_samples: deque[tuple[float, float]] = deque(maxlen=1000)   # (mtime, minutes behind), per file
        self.newest_product_ts: datetime | None = None         # the newest creation time the dish gave us
        self._init_fill()

    async def start(self) -> None:
        if not self.root.is_dir():
            # The cleanup used to remove an emwin/ root left empty by a long
            # outage, and the bot then ran with no directory to watch. goesproc
            # writes into a directory that already exists just the same.
            logger.warning("SDR EMWIN directory %s does not exist (MCW_SDR_EMWIN_DIR); creating it "
                           "so the watcher can run", self.root)
            self.root.mkdir(parents=True, exist_ok=True)
        self._running = True
        added = await asyncio.get_running_loop().run_in_executor(None, self.scan)
        logger.info("SDR source: %d products on disk under %s", added, self.root)
        self._poll_task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        self._running = False
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        await self.fill.stop()

    async def _poll_loop(self) -> None:
        while self._running:
            await asyncio.sleep(settings.sdr_poll_interval)
            try:
                new = await asyncio.get_running_loop().run_in_executor(None, self.scan)
                if new:
                    logger.info("SDR source: +%d new products (%d total)", new, len(self._products))
            except Exception:
                logger.exception("Error scanning SDR EMWIN directory")
            try:
                await self.fill.poll()
            except Exception:
                logger.exception("Error in the internet fill")

    def dish_quiet_min(self, now: float | None = None) -> float:
        """Minutes since the dish last wrote a file this source took in."""
        if self.newest_mtime is None:
            return float("inf")
        return ((now or time.time()) - self.newest_mtime) / 60

    # `feed_lag_min` (the median over the dish's last 50 files written in the
    # last hour) is _LagTracker's.

    # -- what the internet fill took ------------------------------------------------

    def fill_take(self, products: list[dict], kind: str) -> int:
        """Hold what the fill took and write each one down so that a restart
        keeps it: text and airport files as text, radar pictures as the GIF
        they are (the radar reader finds them in the same day folders)."""
        added = 0
        notable: list[str] = []
        now = datetime.now(timezone.utc)
        for prod in products:
            name = prod.get("filename") or ""
            if not name or name in self._products:
                continue
            if self.fallback_root is not None:
                folder = self.fallback_root / f"{prod['timestamp']:%Y-%m-%d}"
                try:
                    folder.mkdir(parents=True, exist_ok=True)
                    data = prod["bytes"] if "bytes" in prod else prod["raw_text"].encode("utf-8")
                    (folder / name).write_bytes(data)
                except OSError as e:
                    logger.warning("Internet fill: could not keep %s on disk: %s", name, e)
            self._seen.add(name)
            added += 1
            if "raw_text" not in prod:
                continue                # a radar picture: on disk for the radar reader, not a text product
            self._products[name] = prod
            if (prod.get("awips_id") or "")[:3] in _NOTABLE:
                notable.append(prod["awips_id"])
        if notable:
            logger.info("EMWIN (internet fill): %s%s", " ".join(notable[:10]),
                        f" +{len(notable) - 10} more" if len(notable) > 10 else "")
        self._prune_fallback(now)
        return added

    def _prune_fallback(self, now: datetime) -> None:
        """Day folders of filled products no product can still come from."""
        if self.fallback_root is None or not self.fallback_root.is_dir():
            return
        keep = set(d.name for d in self._candidate_dirs(now, self.fallback_root))
        for d in self.fallback_root.iterdir():
            if d.is_dir() and d.name not in keep:
                shutil.rmtree(d, ignore_errors=True)

    # -- the directories -------------------------------------------------------

    def _candidate_dirs(self, now: datetime, root: "Path | None" = None) -> list[Path]:
        """Date directories that can still contain unexpired products."""
        root = root or self.root
        cutoff_day = (now - timedelta(hours=longest_hours() + 24)).date()
        dirs = []
        if not root.is_dir():
            return dirs
        for d in root.iterdir():
            if not d.is_dir():
                continue
            try:
                day = datetime.strptime(d.name, "%Y-%m-%d").date()
            except ValueError:
                continue
            if day >= cutoff_day:
                dirs.append(d)
        return sorted(dirs)

    def scan(self, now: datetime | None = None) -> int:
        """Pick up new .TXT files, drop expired ones. Returns the number added.
        The dish's radar GIFs are only noted: the fill asks how new they are."""
        now = now or datetime.now(timezone.utc)
        oldest = now - timedelta(hours=longest_hours())
        wall = now.timestamp()
        settle = wall - 2                     # skip files goesproc may still be writing
        added = 0
        notable: list[str] = []
        # The fill's folder first: what it took is then known before the
        # dish's late copies of the same products come up.
        folders = []
        if self.fallback_root is not None:
            folders += [(d, "internet") for d in self._candidate_dirs(now, self.fallback_root)]
        folders += [(d, "sdr") for d in self._candidate_dirs(now)]
        for d, source in folders:
            with os.scandir(d) as it:
                for entry in it:
                    name = entry.name
                    if name in self._seen:
                        continue
                    upper = name.upper()
                    if not upper.endswith(".TXT"):
                        if upper.endswith(".GIF") and source == "sdr" and "-RAD" in upper:
                            self._seen.add(name)
                            self._feed_saw(name, wall)
                        continue
                    m_ts = EMWIN_TS_RE.search(name)
                    if m_ts:
                        try:
                            ts = datetime.strptime(m_ts.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
                        except ValueError:
                            ts = None
                        ptype = name.rsplit("-", 1)[-1][:3].upper()
                        if ts is not None and (ts < oldest or ts < now - timedelta(hours=max_age_hours(ptype))):
                            self._seen.add(name)      # too old, never look again
                            continue
                    if source == "internet":
                        # What an earlier run's fill took (or the old NOAA-bundle
                        # backup's), known before any dish copy comes up.
                        self.fill.restore(name)
                    try:
                        st = entry.stat()
                    except OSError:
                        continue
                    if st.st_mtime > settle:
                        continue
                    dish = source == "sdr" and "_C_KWIN_" in upper
                    if dish:
                        self.newest_mtime = max(self.newest_mtime or 0.0, st.st_mtime)
                        self._note_lag(name, st.st_mtime, wall)
                        if not self._feed_saw(name, st.st_mtime):
                            self._seen.add(name)      # the fill took it already: this copy is late
                            continue
                    try:
                        raw = Path(entry.path).read_bytes().decode("utf-8", errors="replace").strip()
                    except OSError:
                        continue
                    self._seen.add(name)
                    if not raw:
                        continue
                    if dish:
                        self._feed_read(name, raw)
                    elif source == "internet":
                        self.fill.restore(name, raw)       # what it took, report by report
                    prod = parse_emwin_file(name, raw, source=source)
                    if prod:
                        self._products[name] = prod
                        added += 1
                        if (prod.get("awips_id") or "")[:3] in _NOTABLE:
                            notable.append(prod["awips_id"])
        if notable and self._seen_initial:
            logger.info("EMWIN: %s%s", " ".join(notable[:10]), f" +{len(notable) - 10} more" if len(notable) > 10 else "")
        self._seen_initial = True      # the first scan is the backlog, not news
        # Expire
        before = len(self._products)
        self._products = {k: v for k, v in self._products.items()
                          if not is_expired((v.get("awips_id") or "")[:3], v["timestamp"], now)}
        if before != len(self._products):
            logger.debug("SDR source: expired %d products", before - len(self._products))
        self._forget_feed_keys(now)
        return added

    # `_note_lag` (one of the dish's files: how long after its creation it
    # was written) is _LagTracker's.

    async def fetch_products(self) -> list[dict]:
        return list(self._products.values())


def _span(delta: timedelta) -> str:
    m = int(delta.total_seconds() // 60)
    return f"{m} min" if m < 120 else f"{m // 60} h {m % 60:02d} min"


def create_source() -> EMWINSource:
    if settings.emwin_source == "sdr":
        return SDRSource()
    return InternetSource()
