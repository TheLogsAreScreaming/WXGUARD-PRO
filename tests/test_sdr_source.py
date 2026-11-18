"""SDRSource: the goestools output directory as the bot's EMWIN feed."""

import asyncio
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from meshcore_weather.emwin.fetcher import InternetSource, SDRSource, parse_emwin_file

FIX = Path(__file__).parent / "fixtures" / "swpc"


def _name(ts: datetime, awips: str, seq: int = 1) -> str:
    return f"A_WOXX20KWNP{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_{seq:06d}-1-{awips}.TXT"


def _write(root: Path, ts: datetime, awips: str, body: bytes, seq: int = 1, age_s: float = 10) -> Path:
    d = root / f"{ts:%Y-%m-%d}"
    d.mkdir(exist_ok=True)
    p = d / _name(ts, awips, seq)
    p.write_bytes(body)
    os.utime(p, (time.time() - age_s, time.time() - age_s))
    return p


def test_scan_picks_up_fresh_files_and_skips_old_and_unsettled(tmp_path):
    now = datetime.now(timezone.utc)
    body = (FIX / "WATA20US_20260914_1551Z.txt").read_bytes()
    fresh = _write(tmp_path, now - timedelta(minutes=5), "WATA20US", body)
    _write(tmp_path, now - timedelta(hours=13), "WATA20US", body, seq=2)   # expired
    _write(tmp_path, now - timedelta(minutes=1), "ALTEF3US", body, seq=3, age_s=0)  # still being written
    (tmp_path / "notes.txt").write_text("ignored")
    (tmp_path / "2026-01-01").mkdir()                                       # old day dir, never scanned
    src = SDRSource(root=tmp_path)
    assert src.scan() == 1
    prods = asyncio.run(src.fetch_products())
    assert [p["filename"] for p in prods] == [fresh.name]
    assert prods[0]["awips_id"] == "WATA20US" and prods[0]["station"] == "KWNP"
    assert "\r\r\n" in prods[0]["raw_text"], "bodies must keep EMWIN line endings"
    # Second scan: the unsettled file has settled, nothing else is new
    os.utime(fresh.parent / _name(now - timedelta(minutes=1), "ALTEF3US", 3), (time.time() - 5,) * 2)
    assert src.scan() == 1
    assert src.scan() == 0


def test_expiry_drops_products_as_time_passes(tmp_path):
    now = datetime.now(timezone.utc)
    body = (FIX / "ALTEF3US_20260914_1106Z.txt").read_bytes()
    _write(tmp_path, now - timedelta(hours=11), "ALTEF3US", body)
    src = SDRSource(root=tmp_path)
    assert src.scan(now=now) == 1
    assert src.scan(now=now + timedelta(hours=2)) == 0
    assert asyncio.run(src.fetch_products()) == []


def test_start_creates_a_missing_directory(tmp_path, caplog):
    # The cleanup once removed the empty root after a long outage and the bot
    # ran with no watcher at all (tests/test_feed_health.py has the rest).
    src = SDRSource(root=tmp_path / "missing")
    with caplog.at_level("WARNING"):
        asyncio.run(src.start())
    asyncio.run(src.stop())
    assert (tmp_path / "missing").is_dir()
    assert any("creating it" in r.message for r in caplog.records)


def test_parse_emwin_file_is_shared_with_zip_path():
    p = parse_emwin_file("A_WOXX20KWNP141551_C_KWIN_20260914155132_374891-1-WATA20US.TXT", "WOXX20 KWNP 141551\r\r\nWATA20")
    assert p["product_id"] == "WOXX20" and p["station"] == "KWNP" and p["awips_id"] == "WATA20US"
    assert p["timestamp"] == datetime(2026, 9, 14, 15, 51, 32, tzinfo=timezone.utc)
    assert p["source"] == ""                    # a caller that does not say


def test_each_source_stamps_its_own_products(tmp_path):
    """The wire's source field is only as honest as this stamp (spec 2.3)."""
    now = datetime.now(timezone.utc)
    body = (FIX / "WATA20US_20260914_1551Z.txt").read_bytes()
    _write(tmp_path, now - timedelta(minutes=5), "WATA20US", body)
    src = SDRSource(root=tmp_path)
    src.scan()
    assert [p["source"] for p in asyncio.run(src.fetch_products())] == ["sdr"]

    net = InternetSource()
    p = net._parse_emwin_file(
        "A_WOXX20KWNP141551_C_KWIN_20260914155132_374891-1-WATA20US.TXT", "WOXX20 KWNP"
    )
    assert p["source"] == "internet"


# What the internet fill takes, kept beside the dish's files and read back at a
# restart, is tests/test_fill.py's.
