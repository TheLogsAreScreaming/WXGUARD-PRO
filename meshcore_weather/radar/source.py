"""The newest radar picture of each product, from the dish's EMWIN directory.

goesproc writes radar GIFs next to the text products, under
`<dir>/YYYY-MM-DD/`, named `Z_<wmo>_C_KWIN_<received>_<seq>-3-<PRODUCT>.GIF`.
Nothing is decoded until a request needs it. Decoded pictures are kept, the
most recently used first, so a loop (spec 13.5) asked for twice does not decode
its hour twice.
"""

from __future__ import annotations

import logging
import os
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from meshcore_weather.radar.picture import RadarPicture, read_picture, received_time

logger = logging.getLogger(__name__)

#: How long one listing of the directory is trusted.  A day's folder holds
#: some 27,000 files, so a burst of requests shares one scan.
SCAN_TTL_S = 30
#: A damaged newest file falls back to the ones before it, this many deep.
FALLBACK_DEPTH = 3
#: Decoded pictures kept: an hour of one product is five, and a picture is
#: about 350 KB of levels.
DECODED_KEEP = 24
#: A picture reaches the dish 2 to 34 minutes after its time, so the files of
#: an hour of pictures were received over the hour and this much more.
RECEIVE_SLACK_MIN = 45


class RadarSource:
    """`root` is the dish's directory; `extra_roots` are read the same way (the
    internet fill's folder, whose pictures carry the web's time as their stamp)."""

    def __init__(self, root: "str | Path", extra_roots: "list[str | Path] | None" = None):
        self.root = Path(root).expanduser()
        self.roots = [self.root] + [Path(r).expanduser() for r in extra_roots or []]
        self._listing: "dict[str, list[tuple[datetime, Path]]]" = {}
        self._listed_at = 0.0
        self._decoded: "OrderedDict[Path, RadarPicture]" = OrderedDict()
        self._bad: "set[Path]" = set()

    @property
    def available(self) -> bool:
        return self.root.is_dir()

    def _scan(self, now: datetime) -> None:
        if time.monotonic() - self._listed_at < SCAN_TTL_S and self._listing:
            return
        found: "dict[str, list[tuple[datetime, Path]]]" = {}
        settle = time.time() - 2          # goesproc may still be writing the newest
        for root, day in ((r, d) for r in self.roots for d in (now, now - timedelta(days=1))):
            folder = root / day.strftime("%Y-%m-%d")
            try:
                entries = os.scandir(folder)
            except OSError:
                continue
            with entries:
                for entry in entries:
                    name = entry.name
                    if not name.upper().endswith(".GIF") or "-RAD" not in name.upper():
                        continue
                    received = received_time(name)
                    if received is None:
                        continue
                    try:
                        if entry.stat().st_mtime > settle:
                            continue
                    except OSError:
                        continue
                    product = name.rsplit("-", 1)[-1][:-4].upper()
                    found.setdefault(product, []).append((received, Path(entry.path)))
        for files in found.values():
            files.sort(reverse=True)
        self._listing = found
        self._listed_at = time.monotonic()

    def _read(self, path: Path, product: str) -> "RadarPicture | None":
        if path in self._bad:
            return None
        held = self._decoded.get(path)
        if held is not None:
            self._decoded.move_to_end(path)
            return held
        picture = read_picture(path, product)
        if picture is None:
            self._bad.add(path)
            return None
        self._decoded[path] = picture
        while len(self._decoded) > DECODED_KEEP:
            self._decoded.popitem(last=False)
        return picture

    def newest(self, product: str, now: "datetime | None" = None) -> "RadarPicture | None":
        """The newest readable picture of a product, decoded, or None."""
        now = now or datetime.now(timezone.utc)
        self._scan(now)
        for _, path in self._listing.get(product, [])[:FALLBACK_DEPTH]:
            picture = self._read(path, product)
            if picture is not None:
                return picture
        return None

    def older(self, product: str, newest: RadarPicture, minutes: int,
              now: "datetime | None" = None) -> "list[RadarPicture]":
        """The readable pictures of a product received before `newest`, newest
        received first, from files received up to `minutes` (plus the time a
        picture takes to reach the dish) before it.  Decodes what it returns."""
        now = now or datetime.now(timezone.utc)
        self._scan(now)
        limit = newest.received - timedelta(minutes=minutes + RECEIVE_SLACK_MIN)
        out = []
        for received, path in self._listing.get(product, []):
            if path == newest.path or received > newest.received:
                continue
            if received < limit:
                break
            picture = self._read(path, product)
            if picture is not None:
                out.append(picture)
        return out

    def status(self, now: "datetime | None" = None) -> dict:
        """Newest file per product, for the portal.  Decodes nothing."""
        now = now or datetime.now(timezone.utc)
        self._scan(now)
        return {
            product: {"file": files[0][1].name, "received": files[0][0].isoformat(),
                      "age_min": int((now - files[0][0]).total_seconds() // 60)}
            for product, files in sorted(self._listing.items()) if files
        }
