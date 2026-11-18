"""The internet source (emwin/fetcher.py InternetSource): the feed of every
bot without a dish, against a fake NOAA server (httpx.MockTransport).

The cases are the ones NOAA's server gave on 2026-10-14..17: truncated
bodies, invalid ZIPs and 403s one to three times an hour, and 200 with 0
bytes. Each used to lose its 2-minute window for good; now the hour's bundle
makes it good at the next poll. And the cache file, which used to be
rewritten whole (~100 MB) on the event loop after every poll."""

import io
import json
import os
import threading
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from meshcore_weather import __version__
from meshcore_weather.config import settings
from meshcore_weather.emwin import fetcher
from meshcore_weather.emwin.fetcher import (
    BACKOFF_MAX_S,
    FETCH_TIMEOUT,
    HOUR_BUNDLE_EVERY_S,
    InternetSource,
    SDRSource,
    user_agent,
)

FIX = Path(__file__).parent / "fixtures" / "swpc"
BODY = (FIX / "WATA20US_20260914_1551Z.txt").read_bytes()
ALERT = (FIX / "ALTEF3US_20260914_1106Z.txt").read_bytes()

HOUR = settings.emwin_base_url
MIN2 = settings.emwin_poll_url


def _name(ts: datetime, awips: str = "WATA20US", seq: int = 1) -> str:
    return f"A_WOXX20KWNP{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_{seq:06d}-1-{awips}.TXT"


def _bundle(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, body in files.items():
            zf.writestr(name, body)
    return buf.getvalue()


class FakeNoaa:
    """tgftp: each url answers its bundle, unless a one-off answer is queued
    (bytes = 200 with that body, int = that status, an exception class =
    raised). Every request is recorded."""

    def __init__(self, bundles: dict[str, bytes]):
        self.bundles = dict(bundles)
        self.next: list = []
        self.asked: list[str] = []
        self.agents: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.asked.append(url)
        self.agents.append(request.headers.get("user-agent", ""))
        if self.next:
            what = self.next.pop(0)
            if isinstance(what, int):
                return httpx.Response(what)
            if isinstance(what, type):
                raise what("from the fake", request=request)
            return httpx.Response(200, content=what)
        if url not in self.bundles:
            return httpx.Response(404)
        return httpx.Response(200, content=self.bundles[url])


@pytest.fixture
def interval(monkeypatch):
    monkeypatch.setattr(settings, "emwin_poll_interval", 60)
    monkeypatch.setattr(settings, "operator_contact", "")
    return 60


def _source(tmp_path: Path, noaa: FakeNoaa) -> InternetSource:
    src = InternetSource(cache_file=tmp_path / "emwin_cache" / "products.jsonl")
    src._client = src._make_client(httpx.MockTransport(noaa))
    src._cache_loaded = True          # as after start(): an empty cache, read
    return src


def _lines(path: Path) -> list[str]:
    return path.read_text().splitlines()


# -- which bundle, when -----------------------------------------------------------


async def test_the_hour_bundle_first_then_the_2_minute_one_and_the_hour_every_half_hour(tmp_path, interval):
    now = datetime.now(timezone.utc)
    a, b, c = now - timedelta(minutes=50), now - timedelta(minutes=30), now - timedelta(minutes=1)
    noaa = FakeNoaa({HOUR: _bundle({_name(a, seq=1): BODY, _name(b, "ALTEF3US", 2): ALERT}),
                     MIN2: _bundle({_name(b, "ALTEF3US", 2): ALERT, _name(c, seq=3): BODY})})
    src = _source(tmp_path, noaa)
    try:
        assert await src.poll_once(now) == 2 and noaa.asked == [HOUR]
        assert await src.poll_once(now) == 1 and noaa.asked[-1] == MIN2
        assert await src.poll_once(now) == 0 and noaa.asked[-1] == MIN2      # the same bundle: nothing twice
        src._hour_fetched -= HOUR_BUNDLE_EVERY_S                           # half an hour on
        assert await src.poll_once(now) == 0 and noaa.asked[-1] == HOUR
        assert await src.poll_once(now) == 0 and noaa.asked[-1] == MIN2
        prods = await src.fetch_products()
        assert len(prods) == 3 and {p["source"] for p in prods} == {"internet"}
        assert src.last_ok == now and src.last_error is None
    finally:
        await src._client.aclose()


FAILURES = [
    (403, "403 Forbidden"),
    (429, "429 Too Many Requests"),
    (500, "500 Internal Server Error"),
    (503, "503 Service Unavailable"),
    (httpx.ReadTimeout, "timeout"),
    (httpx.ConnectError, "ConnectError"),
    (b"", "0 bytes"),                                    # 2026-10-17 20:24Z, twice
    (b"<html>Service unavailable</html>", "invalid zip"),
    ("truncated", "invalid zip"),                        # 2026-10-14..16
    (_bundle({}), "empty bundle"),
]


@pytest.mark.parametrize("answer,said", FAILURES, ids=[s for _, s in FAILURES])
async def test_a_failed_fetch_is_on_record_and_made_good_by_the_hour_bundle(tmp_path, interval, answer, said):
    now = datetime(2026, 10, 17, 20, 24, tzinfo=timezone.utc)
    a, lost = now - timedelta(minutes=40), now - timedelta(minutes=1)
    noaa = FakeNoaa({HOUR: _bundle({_name(a): BODY}), MIN2: _bundle({_name(lost, seq=2): BODY})})
    src = _source(tmp_path, noaa)
    try:
        assert await src.poll_once(now) == 1
        if answer == "truncated":
            whole = noaa.bundles[MIN2]
            answer = whole[: len(whole) // 2]
        noaa.next.append(answer)
        assert await src.poll_once(now) is None and noaa.asked[-1] == MIN2
        assert src.last_error == f"{said} at 20:24Z" and src.last_error_at == now
        assert src.last_ok == now                                       # from the first fetch
        # The next poll takes the hour's bundle, which has the lost product.
        noaa.bundles[HOUR] = _bundle({_name(a): BODY, _name(lost, seq=2): BODY})
        later = now + timedelta(minutes=1)
        assert await src.poll_once(later) == 1 and noaa.asked[-1] == HOUR
        assert src.last_error is None and src.last_error_at is None and src.last_ok == later
        assert await src.poll_once(later) == 0 and noaa.asked[-1] == MIN2
    finally:
        await src._client.aclose()


async def test_a_failed_first_fetch_is_tried_again_with_the_hour_bundle(tmp_path, interval):
    now = datetime.now(timezone.utc)
    noaa = FakeNoaa({HOUR: _bundle({_name(now - timedelta(minutes=5)): BODY})})
    noaa.next.append(b"")
    src = _source(tmp_path, noaa)
    try:
        assert await src.poll_once(now) is None
        assert await src.poll_once(now) == 1 and noaa.asked == [HOUR, HOUR]
    finally:
        await src._client.aclose()


# -- backoff and jitter -------------------------------------------------------------


async def test_refusals_back_off_exponentially_up_to_15_minutes_and_a_bundle_resets(tmp_path, interval):
    now = datetime.now(timezone.utc)
    noaa = FakeNoaa({HOUR: _bundle({_name(now - timedelta(minutes=5)): BODY}),
                     MIN2: _bundle({_name(now - timedelta(minutes=1), seq=2): BODY})})
    src = _source(tmp_path, noaa)
    try:
        assert src.poll_wait_s(jitter=False) == 60
        waits = []
        for status in (403, 429, 503, 500, 403, 403):
            noaa.next.append(status)
            assert await src.poll_once(now) is None
            waits.append(src.poll_wait_s(jitter=False))
        assert waits == [120, 240, 480, 900, 900, 900]
        assert waits[-1] == BACKOFF_MAX_S
        # A bundle that comes in whole: back to the interval.
        assert await src.poll_once(now) == 1 and noaa.asked[-1] == HOUR
        assert src.poll_wait_s(jitter=False) == 60

        # What is not a refusal (a timeout, 0 bytes, a broken ZIP) is made
        # good by the hour bundle but does not slow the polling down.
        for answer in (httpx.ReadTimeout, b"", b"junk", httpx.ConnectError, 404):
            noaa.next.append(answer)
            assert await src.poll_once(now) is None
            assert src.poll_wait_s(jitter=False) == 60, answer
    finally:
        await src._client.aclose()


def test_the_backoff_never_waits_less_than_the_interval(monkeypatch):
    monkeypatch.setattr(settings, "emwin_poll_interval", 1200)
    src = InternetSource(cache_file=Path("/nonexistent/products.jsonl"))
    src._refusals = 3
    assert src.poll_wait_s(jitter=False) == 1200


def test_every_wait_is_jittered_by_ten_percent(interval):
    src = InternetSource(cache_file=Path("/nonexistent/products.jsonl"))
    src._rng.seed(7)
    waits = [src.poll_wait_s() for _ in range(500)]
    assert all(54 <= w <= 66 for w in waits)
    assert max(waits) > 64 and min(waits) < 56          # it does move, both ways
    src._refusals = 9
    waits = [src.poll_wait_s() for _ in range(500)]
    assert all(810 <= w <= 990 for w in waits)


# -- how the bot names itself ---------------------------------------------------------


async def test_requests_name_the_bot_and_its_operator(tmp_path, interval, monkeypatch):
    base = f"meshcore-weather/{__version__} (+https://github.com/digitaino/meshwx)"
    assert user_agent() == base
    noaa = FakeNoaa({HOUR: _bundle({_name(datetime.now(timezone.utc)): BODY})})
    src = _source(tmp_path, noaa)
    try:
        await src.poll_once()
        assert noaa.agents == [base]
        assert src._client.timeout == FETCH_TIMEOUT == httpx.Timeout(10.0, connect=5.0)
    finally:
        await src._client.aclose()

    monkeypatch.setattr(settings, "operator_contact", "wx-ops@example.org")
    assert user_agent() == f"meshcore-weather/{__version__} (+https://github.com/digitaino/meshwx; wx-ops@example.org)"
    # Nothing that could break the header or the parentheses gets through.
    monkeypatch.setattr(settings, "operator_contact", " ops@example.org\r\nX-Evil: 1 (é) ")
    assert user_agent().endswith("; ops@example.orgX-Evil: 1)")
    # The internet fill goes out under the same name.
    fill = SDRSource(root=tmp_path).fill
    client = fill._http()
    try:
        assert client.headers["user-agent"] == user_agent() and client.timeout == FETCH_TIMEOUT
    finally:
        await fill.stop()


# -- how late the products are --------------------------------------------------------


async def test_the_lag_comes_from_the_2_minute_bundle_not_the_hours_catch_up(tmp_path, interval):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    # The hour bundle at start: products up to 50 minutes old, which is
    # catch-up, not lateness. They set the newest creation time only.
    noaa = FakeNoaa({HOUR: _bundle({_name(now - timedelta(minutes=50 - i), seq=i): BODY for i in range(6)})})
    src = _source(tmp_path, noaa)
    try:
        assert await src.poll_once(now) == 6
        assert src.feed_lag_min is None and len(src._lag_samples) == 0
        assert src.newest_product_ts == now - timedelta(minutes=45)
        # NOAA replaying a backlog (2026-10-16): the 2-minute bundle carries
        # products created five hours ago. Four are not enough to go by.
        old = now - timedelta(hours=5)
        noaa.bundles[MIN2] = _bundle({_name(old - timedelta(minutes=i), seq=10 + i): BODY for i in range(4)})
        assert await src.poll_once(now) == 4 and src.feed_lag_min is None
        noaa.bundles[MIN2] = _bundle({_name(old - timedelta(minutes=4), seq=20): BODY})
        assert await src.poll_once(now) == 1 and 298 <= src.feed_lag_min <= 302
        assert src.newest_product_ts == now - timedelta(minutes=45)         # the replay is older
        # Current products outnumbering the late ones bring it down.
        noaa.bundles[MIN2] = _bundle({_name(now - timedelta(seconds=30 + i), seq=30 + i): BODY for i in range(9)})
        assert await src.poll_once(now) == 9 and src.feed_lag_min < 2
        assert src.newest_product_ts == now - timedelta(seconds=30)
    finally:
        await src._client.aclose()


# -- the cache file -------------------------------------------------------------------


async def test_each_poll_appends_what_it_brought_and_nothing_else(tmp_path, interval):
    now = datetime.now(timezone.utc)
    noaa = FakeNoaa({HOUR: _bundle({_name(now - timedelta(minutes=40), seq=1): BODY,
                                    _name(now - timedelta(minutes=20), "ALTEF3US", 2): ALERT}),
                     MIN2: _bundle({_name(now - timedelta(minutes=1), seq=3): BODY})})
    src = _source(tmp_path, noaa)
    try:
        await src.poll_once(now)
        path = src.cache_file
        first = path.read_bytes()
        inode = path.stat().st_ino
        assert len(_lines(path)) == 2
        await src.poll_once(now)
        assert len(_lines(path)) == 3 and path.read_bytes().startswith(first)
        assert path.stat().st_ino == inode                                # appended, not replaced
        size = path.stat().st_size
        await src.poll_once(now)                                          # nothing new: nothing written
        assert path.stat().st_size == size
        assert json.loads(_lines(path)[-1])["filename"] == _name(now - timedelta(minutes=1), seq=3)
    finally:
        await src._client.aclose()


async def test_cache_writes_run_off_the_event_loop(tmp_path, interval, monkeypatch):
    now = datetime.now(timezone.utc)
    noaa = FakeNoaa({HOUR: _bundle({_name(now): BODY})})
    src = _source(tmp_path, noaa)
    threads = []
    write = src._write_cache

    def spy(new, live):
        threads.append(threading.current_thread())
        return write(new, live)

    monkeypatch.setattr(src, "_write_cache", spy)
    try:
        await src.poll_once(now)
        assert threads and threading.main_thread() not in threads
    finally:
        await src._client.aclose()


def _old_cache(path: Path, now: datetime, live: int, expired: int) -> list[str]:
    """A cache file as the old whole-file save wrote it (before revision 7
    there was no "source" field)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    names = []
    with open(path, "w") as f:
        for i in range(live + expired):
            ts = now - timedelta(minutes=10 + i) if i < live else now - timedelta(hours=13 + i)
            name = _name(ts, seq=100 + i)
            names.append(name)
            f.write(json.dumps({"product_id": "WOXX20", "station": "KWNP", "awips_id": "WATA20US",
                                "timestamp": ts.isoformat(), "raw_text": BODY.decode(), "filename": name}) + "\n")
    return names[:live]


async def test_the_file_is_rewritten_as_the_live_products_once_it_has_doubled(tmp_path, interval, monkeypatch):
    monkeypatch.setattr(fetcher, "CACHE_COMPACT_SLACK", 0)
    now = datetime.now(timezone.utc)
    path = tmp_path / "emwin_cache" / "products.jsonl"
    live = _old_cache(path, now, live=3, expired=6)
    new = _name(now - timedelta(minutes=1), seq=1)
    noaa = FakeNoaa({HOUR: _bundle({new: BODY})})
    src = InternetSource(cache_file=path)
    src._client = src._make_client(httpx.MockTransport(noaa))
    try:
        src._load_cache()
        assert len(src._products) == 3 and src._cache_lines == 9
        # 9 lines + 1 new > 2 x 4 live: the whole file, as the live products.
        assert await src.poll_once(now) == 1
        assert sorted(json.loads(x)["filename"] for x in _lines(path)) == sorted([*live, new])
        assert src._cache_lines == 4 and not path.with_name("products.jsonl.tmp").exists()
        # From there on it appends again.
        noaa.bundles[MIN2] = _bundle({_name(now, seq=2): BODY})
        assert await src.poll_once(now) == 1 and len(_lines(path)) == 5 and src._cache_lines == 5
    finally:
        await src._client.aclose()
    again = InternetSource(cache_file=path)
    again._load_cache()
    assert len(again._products) == 5 and {p["source"] for p in again._products.values()} == {"internet"}


def test_the_old_cache_format_loads(tmp_path):
    now = datetime.now(timezone.utc)
    path = tmp_path / "products.jsonl"
    live = _old_cache(path, now, live=4, expired=2)
    src = InternetSource(cache_file=path)
    src._load_cache()
    assert sorted(src._products) == sorted(live)
    prod = src._products[live[0]]
    assert prod["source"] == "internet" and prod["timestamp"] == now - timedelta(minutes=10)
    assert src.newest_product_ts == (now - timedelta(minutes=10)).replace(microsecond=0)
    assert src._cache_loaded and not src._cache_torn


async def test_a_torn_or_garbled_line_costs_that_line_only(tmp_path, interval):
    """A crash in an append leaves half a line at the end. The old loader
    stopped at the first bad line and lost everything after it."""
    now = datetime.now(timezone.utc)
    path = tmp_path / "products.jsonl"
    names = _old_cache(path, now, live=2, expired=0)
    text = path.read_text().splitlines(keepends=True)
    path.write_text(text[0] + '{"filename": "garbled\n' + text[1] + text[1][:40])
    noaa = FakeNoaa({HOUR: _bundle({_name(now - timedelta(minutes=1), seq=9): BODY})})
    src = InternetSource(cache_file=path)
    src._client = src._make_client(httpx.MockTransport(noaa))
    try:
        src._load_cache()
        assert sorted(src._products) == sorted(names) and src._cache_torn
        assert await src.poll_once(now) == 1
    finally:
        await src._client.aclose()
    # The append started on a line of its own: the new product loads, and
    # only the two bad lines are lost.
    again = InternetSource(cache_file=path)
    again._load_cache()
    assert len(again._products) == 3 and not again._cache_torn


@pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="root reads anything")
async def test_a_cache_it_could_not_read_is_never_overwritten(tmp_path, interval, monkeypatch):
    monkeypatch.setattr(fetcher, "CACHE_COMPACT_SLACK", 0)
    now = datetime.now(timezone.utc)
    path = tmp_path / "products.jsonl"
    _old_cache(path, now, live=0, expired=5)
    before = path.read_bytes()
    path.chmod(0)
    noaa = FakeNoaa({HOUR: _bundle({_name(now, seq=1): BODY})})
    src = InternetSource(cache_file=path)
    src._client = src._make_client(httpx.MockTransport(noaa))
    try:
        src._load_cache()
        assert not src._cache_loaded
        assert await src.poll_once(now) == 1                    # the feed goes on regardless
        assert len(src._unsaved) == 1 and not src._cache_dirty  # kept for the next append
    finally:
        await src._client.aclose()
        path.chmod(0o644)
    assert path.read_bytes() == before


async def test_a_failed_write_is_made_good_by_rewriting_the_file(tmp_path, interval, monkeypatch):
    now = datetime.now(timezone.utc)
    noaa = FakeNoaa({HOUR: _bundle({_name(now - timedelta(minutes=5), seq=1): BODY}),
                     MIN2: _bundle({_name(now, seq=2): BODY})})
    src = _source(tmp_path, noaa)
    write = src._write_cache
    calls = []

    def flaky(new, live):
        calls.append(live is not None)
        return None if len(calls) == 1 else write(new, live)    # the disk was full once

    monkeypatch.setattr(src, "_write_cache", flaky)
    try:
        await src.poll_once(now)
        assert src._cache_dirty and len(src._unsaved) == 1
        await src.poll_once(now)
        assert calls == [False, True]                            # then the whole file
        assert len(_lines(src.cache_file)) == 2 and not src._cache_dirty and not src._unsaved
    finally:
        await src._client.aclose()


async def test_start_and_stop_keep_the_products_and_a_short_start_writes_nothing(tmp_path, interval, monkeypatch):
    now = datetime.now(timezone.utc)
    path = tmp_path / "products.jsonl"
    names = _old_cache(path, now, live=2, expired=0)
    before = path.read_bytes()
    # Stopped before it ever started: the file is left as it was.
    await InternetSource(cache_file=path).stop()
    assert path.read_bytes() == before

    noaa = FakeNoaa({HOUR: _bundle({_name(now - timedelta(minutes=3), seq=7): BODY})})
    src = InternetSource(cache_file=path)
    src._client = src._make_client(httpx.MockTransport(noaa))
    await src.start()
    try:
        assert noaa.asked == [HOUR] and len(await src.fetch_products()) == 3
        assert src._poll_task is not None and not src._poll_task.done()
    finally:
        await src.stop()
    assert src._client is None and src._poll_task.done()
    assert path.read_bytes().startswith(before) and len(_lines(path)) == 3
    again = InternetSource(cache_file=path)
    again._load_cache()
    assert set(again._products) == {*names, _name(now - timedelta(minutes=3), seq=7)}
