"""The HRIT tab's imagery viewer: every picture goesproc wrote in the last day, by satellite,
sector and channel, for the loops the page plays.

goesproc files each one as <satellite>/<sector>/<channel>/<UTC day>/
GOES19_M1_CH13_enhanced_20261019T042125Z.jpg, the time being the start of the scan. A
listing is the newest two day directories of some twenty channels: cheap enough to redo
every half minute.
"""
import os
import re
from datetime import datetime, timezone

DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FRAME_RE = re.compile(r"_(\d{8}T\d{6})Z\.(?:jpg|png)$")

# (directory under the image root, name, satellite)
SECTORS = [
    ("goes19/fd", "Full disk", "GOES-19"),
    ("goes19/m1", "Meso 1", "GOES-19"),
    ("goes19/m2", "Meso 2", "GOES-19"),
    ("goes18/fd", "GOES-18 full disk", "GOES-18, relayed by GOES-19"),
]
# goesproc's channel directories, in the order the viewer offers them: name and what it shows.
CHANNELS = {
    "fc": ("False colour", "Visible and infrared blended into a natural-looking picture. Dark at night."),
    "ch13_enhanced": ("Enhanced IR", "Clean IR coloured by cloud-top temperature, so storm tops stand out."),
    "ch13": ("Clean IR", "Cloud-top temperature, day and night."),
    "ch02": ("Red visible", "Daytime clouds, fog and smoke at the finest detail. Dark at night."),
    "ch07": ("Shortwave IR", "Night fog, low cloud and fires."),
    "ch08": ("Upper water vapour", "Moisture high in the atmosphere: jet streams and dry slots."),
    "ch09": ("Mid water vapour", "Moisture in the middle levels."),
    "ch14": ("Longwave IR", "Like clean IR, a little more sensitive to moisture."),
    "ch15": ("Dirty IR", "Low-level moisture and dust."),
}


def frame_time(name: str) -> int | None:
    m = FRAME_RE.search(name)
    if not m:
        return None
    return int(datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc).timestamp())


def _cadence(times: list) -> int | None:
    """The usual minutes between frames: the median gap."""
    gaps = sorted(b - a for a, b in zip(times, times[1:]) if b > a)
    return round(gaps[len(gaps) // 2] / 60) if gaps else None


def listing(img_root: str, hours: int = 24, now: float | None = None) -> dict:
    """{"sectors": [{id, name, satellite, channels: [{id, name, help, every_min, frames}]}]},
    frames being [taken, path under img_root, received], oldest first, within `hours`."""
    import time
    now = now or time.time()
    cutoff = now - hours * 3600
    sectors = []
    for sdir, sname, sat in SECTORS:
        base = os.path.join(img_root, sdir)
        try:
            found = set(os.listdir(base))
        except OSError:
            continue
        chans = []
        for cid in [c for c in CHANNELS if c in found] + sorted(c for c in found if c not in CHANNELS):
            frames = []
            cdir = os.path.join(base, cid)
            try:
                days = sorted(d for d in os.listdir(cdir) if DAY_RE.match(d))[-2:]
            except OSError:
                continue
            for day in days:
                try:
                    with os.scandir(os.path.join(cdir, day)) as it:
                        for e in it:
                            t = frame_time(e.name)
                            if t is None or t < cutoff:
                                continue
                            try:
                                received = int(e.stat().st_mtime)
                            except OSError:
                                continue
                            frames.append([t, f"{sdir}/{cid}/{day}/{e.name}", received])
                except OSError:
                    continue
            if not frames:
                continue
            frames.sort()
            name, help_ = CHANNELS.get(cid, (cid.upper(), ""))
            chans.append({"id": cid, "name": name, "help": help_, "every_min": _cadence([f[0] for f in frames]),
                          "frames": frames})
        if chans:
            sectors.append({"id": sdir.replace("/", "-"), "name": sname, "satellite": sat, "channels": chans})
    return {"t": int(now), "hours": hours, "sectors": sectors}


def recent(listing_: dict, hours: float) -> list:
    """Paths of every frame taken in the last `hours`: the ones worth making loop frames for ahead."""
    cutoff = listing_["t"] - hours * 3600
    return [f[1] for s in listing_["sectors"] for c in s["channels"] for f in c["frames"] if f[0] >= cutoff]
