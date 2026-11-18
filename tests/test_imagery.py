"""The dashboard's imagery viewer listing (deploy/goes-dashboard/imagery.py): goesproc's
pictures by satellite, sector and channel. The image tree is faked."""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy" / "goes-dashboard"))
import imagery  # noqa: E402

T0 = 1792382400   # 2026-10-19 04:00:00Z


def _frame(root: Path, sub: str, t: int, arrived: float) -> str:
    day = time.strftime("%Y-%m-%d", time.gmtime(t))
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(t))
    sat, sector, chan = sub.split("/")
    d = root / sub / day
    d.mkdir(parents=True, exist_ok=True)
    name = f"{sat.upper()}_{sector.upper()}_{chan.upper().replace('_ENHANCED', '_enhanced')}_{stamp}.jpg"
    (d / name).write_bytes(b"\xff\xd8")
    os.utime(d / name, (arrived, arrived))
    return f"{sub}/{day}/{name}"


def test_the_listing_groups_frames_by_sector_and_channel_in_the_viewers_order(tmp_path):
    for k in range(8):                                        # meso 1 every 15 min for two hours
        _frame(tmp_path, "goes19/m1/ch13_enhanced", T0 - k * 900, T0 - k * 900 + 300)
    _frame(tmp_path, "goes19/m1/fc", T0, T0 + 300)
    old = _frame(tmp_path, "goes19/fd/ch13", T0 - 30 * 3600, T0)   # past the day
    _frame(tmp_path, "goes18/fd/ch13", T0 - 3600, T0)
    d = imagery.listing(str(tmp_path), hours=24, now=T0 + 600)
    assert [s["id"] for s in d["sectors"]] == ["goes19-m1", "goes18-fd"]   # the full disk's one frame is too old
    m1 = d["sectors"][0]
    assert [c["id"] for c in m1["channels"]] == ["fc", "ch13_enhanced"]
    enh = m1["channels"][1]
    assert enh["name"] == "Enhanced IR" and enh["every_min"] == 15 and len(enh["frames"]) == 8
    assert enh["frames"][-1][0] == T0 and enh["frames"][0][0] < enh["frames"][-1][0]
    assert enh["frames"][-1][1].startswith("goes19/m1/ch13_enhanced/2026-10-19/GOES19_M1_CH13_enhanced_20261019T040000Z")
    assert d["sectors"][1]["satellite"].startswith("GOES-18")
    assert old not in imagery.recent(d, 24)
    assert len(imagery.recent(d, 1)) == 5      # the hour before 04:10: enhanced at 03:15 ... 04:00, and fc
