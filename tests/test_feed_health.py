"""The EMWIN feed's health (emwin/fetcher.py SDRSource): what counts as the
dish writing, and how far behind the uplink the products run.

The replay of Oct 16 is the case: for ten hours every product arrived hours
after its creation time while every file was seconds old. (The dish's
NOAA-bundle backup these tests also covered was replaced on 2026-10-19 by the
internet fill, tests/test_fill.py.)"""

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from meshcore_weather.emwin.fetcher import SDRSource

FIX = Path(__file__).parent / "fixtures" / "swpc"
BODY = (FIX / "WATA20US_20260914_1551Z.txt").read_bytes()


def _name(ts: datetime, awips: str, seq: int = 1, tag: str = "KWIN") -> str:
    return f"A_WOXX20KWNP{ts:%d%H%M}_C_{tag}_{ts:%Y%m%d%H%M%S}_{seq:06d}-1-{awips}.TXT"


def _write(root: Path, ts: datetime, awips: str, seq: int = 1, age_s: float = 10,
           tag: str = "KWIN", body: bytes = BODY, name: str | None = None) -> Path:
    d = root / f"{ts:%Y-%m-%d}"
    d.mkdir(exist_ok=True)
    p = d / (name or _name(ts, awips, seq, tag))
    p.write_bytes(body)
    os.utime(p, (time.time() - age_s, time.time() - age_s))
    return p


# -- what counts as the dish writing -------------------------------------------


def test_only_the_dishs_own_files_count_as_the_dish_writing(tmp_path):
    now = datetime.now(timezone.utc)
    src = SDRSource(root=tmp_path)
    # A `_C_INET_` file in the dish's directory (a disabled backup once left
    # some) is a product, but no sign of life from the dish.
    _write(tmp_path, now - timedelta(minutes=5), "WATA20US", tag="INET")
    assert src.scan() == 1
    assert src.newest_mtime is None and src.dish_quiet_min() == float("inf")
    assert src.feed_lag_min is None and src.newest_product_ts is None
    _write(tmp_path, now - timedelta(minutes=4), "WATA20US", seq=2)
    assert src.scan() == 1
    assert src.newest_mtime == pytest.approx(time.time() - 10, abs=2)
    assert src.dish_quiet_min() < 1


# -- how far behind the uplink the products run ---------------------------------


def test_lag_is_the_median_over_the_dishs_recent_files(tmp_path):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    src = SDRSource(root=tmp_path)
    # Four files created five hours ago and written just now: a lag, but
    # not yet enough to go by.
    for i in range(4):
        _write(tmp_path, now - timedelta(hours=5, minutes=i), "WATA20US", seq=i, age_s=30 + i)
    assert src.scan() == 4 and src.feed_lag_min is None
    assert src.newest_product_ts == now - timedelta(hours=5)
    # The fifth makes five: ~300 minutes behind.
    _write(tmp_path, now - timedelta(hours=5, minutes=4), "WATA20US", seq=4, age_s=34)
    assert src.scan() == 1 and 298 <= src.feed_lag_min <= 302
    # A current product written now moves the newest creation time, not the
    # median; a file created after it was written (a clock out of step) is
    # not a negative lag.
    _write(tmp_path, now - timedelta(seconds=20), "WATA20US", seq=5, age_s=15)
    _write(tmp_path, now + timedelta(minutes=2), "WATA20US", seq=6, age_s=15)
    src.scan()
    assert src.newest_product_ts == now + timedelta(minutes=2)
    assert 298 <= src.feed_lag_min <= 302 and min(lag for _, lag in src._lag_samples) == 0.0
    # Current files outnumbering the late ones bring it down.
    for i in range(7, 16):
        _write(tmp_path, now - timedelta(seconds=10 * i), "WATA20US", seq=i, age_s=5)
    src.scan()
    assert src.feed_lag_min < 5


def test_the_backlog_at_start_does_not_say_how_late_the_feed_is_now(tmp_path):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    src = SDRSource(root=tmp_path)
    # Files from hours ago, created hours before they were written: the
    # replay of the night. They set the newest creation time and nothing else.
    for i in range(6):
        _write(tmp_path, now - timedelta(hours=8, minutes=i), "WATA20US", seq=i, age_s=3 * 3600 + i)
    assert src.scan() == 6
    assert src.feed_lag_min is None and len(src._lag_samples) == 0
    assert src.newest_product_ts == now - timedelta(hours=8)


def test_a_malformed_name_neither_breaks_the_scan_nor_counts(tmp_path):
    now = datetime.now(timezone.utc)
    src = SDRSource(root=tmp_path)
    _write(tmp_path, now, "WATA20US", name="A_WOXX20KWNP_C_KWIN_NOTATIME_000001-1-WATA20US.TXT")
    _write(tmp_path, now, "WATA20US", name="A_WOXX20KWNP_C_KWIN_20261399999999_000002-1-WATA20US.TXT")
    assert src.scan() == 2                      # both are still products
    assert src.newest_mtime is not None         # written by the dish, by their tag
    assert src.newest_product_ts is None and src.feed_lag_min is None and len(src._lag_samples) == 0


def test_the_lag_of_a_replay_that_has_ended_is_not_reported_as_current(tmp_path):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    src = SDRSource(root=tmp_path)
    for i in range(6):
        _write(tmp_path, now - timedelta(hours=5, minutes=i), "WATA20US", seq=i, age_s=60 + i)
    src.scan()
    assert 298 <= src.feed_lag_min <= 306
    # The dish then goes quiet: an hour on, those samples are history.
    src._lag_samples = type(src._lag_samples)(((m - 3600, lag) for m, lag in src._lag_samples),
                                              maxlen=src._lag_samples.maxlen)
    assert src.feed_lag_min is None


def test_the_lag_is_the_newest_arrivals_not_the_last_read(tmp_path):
    """A restart's scan reads day folders in no set order: late replays read
    last must not stand for the current lag (WX-AUS, 17 Oct: "~5h behind" at
    a restart while the feed ran 22 min late)."""
    import time as _time
    from meshcore_weather.emwin.fetcher import SDRSource

    src = SDRSource(root=tmp_path)
    now = _time.time()
    for i in range(60):                       # fresh, arrived in the last 10 min
        src._lag_samples.append((now - 600 + i * 10, 20.0))
    for i in range(40):                       # replays that arrived 40-50 min ago, read last
        src._lag_samples.append((now - 3000 + i * 15, 300.0))
    assert src.feed_lag_min == 20
