"""One place that answers "what does the radar show here": the `>radar`
request and the `radar` text command both come through it.

It holds no schedule and no thread.  A question reads the newest picture of
the best product for the tile (cached until a newer file arrives) and cuts the
tile out of it.  Requests and the scheduled radar broadcast ask from worker
threads, so one lock covers the picture cache.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from meshcore_weather.config import settings
from meshcore_weather.protocol import v5
from meshcore_weather.radar.picture import RadarPicture
from meshcore_weather.radar.source import RadarSource
from meshcore_weather.radar.tiles import Frame, RadarTile, candidates, cut_tile, load_frames

logger = logging.getLogger(__name__)

#: A picture older than this is not an answer to "what is out there now".
MAX_AGE_MIN = 60


class RadarService:
    def __init__(self, root: "str | Path | None", frames: "list[Frame] | None" = None,
                 extra_roots: "list[str | Path] | None" = None):
        self.source = RadarSource(root, extra_roots) if root else None
        self.frames = frames if frames is not None else load_frames()
        self._lock = threading.RLock()

    @property
    def available(self) -> bool:
        """Does this bot have anywhere to get radar pictures from at all?"""
        return self.source is not None and self.source.available

    def tile_for(self, lat: float, lon: float, zoom: int = 0, now: "datetime | None" = None
                 ) -> "tuple[RadarTile, RadarPicture, Frame] | None":
        """The tile for a coordinate, from the best picture that can give one."""
        south, west = v5.radar_tile(lat, lon, zoom)
        return self.tile_at(south, west, zoom, now)

    def tile_at(self, south: int, west: int, zoom: int, now: "datetime | None" = None
                ) -> "tuple[RadarTile, RadarPicture, Frame] | None":
        """One tile of the lattice, from the best picture that can give one."""
        if not self.available:
            return None
        now = now or datetime.now(timezone.utc)
        with self._lock:
            for frame in candidates(self.frames, south, west, zoom):
                picture = self.source.newest(frame.id, now)
                if picture is None:
                    continue
                if not picture.frame_ok:
                    logger.warning("radar: %s is not drawn on the map it was calibrated on; "
                                   "run scripts/radar_calibrate.py", picture.path.name)
                    continue
                if now - picture.taken > timedelta(minutes=MAX_AGE_MIN):
                    continue
                tile = cut_tile(picture, frame, south, west, zoom)
                if tile is not None:
                    return tile, picture, frame
        return None

    def loop_for(self, lat: float, lon: float, zoom: int = 0, now: "datetime | None" = None
                 ) -> "list[tuple[RadarTile, RadarPicture, Frame]]":
        """The last hour of one tile (spec 13.5), oldest first, the newest last.

        The newest is what `tile_for` answers; the others are older pictures of
        **the same product**, each at least 10 minutes before the one after it,
        back to an hour before the newest, five at most.  A picture missing from
        the dish is a gap: filling it from another product would change the
        detail in the middle of the loop."""
        with self._lock:
            found = self.tile_for(lat, lon, zoom, now)
            if found is None:
                return []
            tile, newest, frame = found
            frames = [found]
            oldest = newest.taken - timedelta(minutes=v5.RADAR_LOOP_WINDOW_MIN)
            last = newest.taken
            older = sorted(self.source.older(frame.id, newest, v5.RADAR_LOOP_WINDOW_MIN, now),
                           key=lambda p: p.taken, reverse=True)
            for picture in older:
                if len(frames) >= v5.RADAR_LOOP_MAX_FRAMES or picture.taken < oldest:
                    break
                if not picture.frame_ok or picture.taken > last - timedelta(minutes=v5.RADAR_LOOP_MIN_SPACING_MIN):
                    continue
                cut = cut_tile(picture, frame, tile.south, tile.west, tile.zoom)
                if cut is None:
                    continue
                frames.append((cut, picture, frame))
                last = picture.taken
        frames.reverse()
        return frames

    def status(self) -> dict:
        if not self.available:
            return {"available": False, "products": {}}
        calibrated = {f.id for f in self.frames if f.calibrated}
        with self._lock:
            products = self.source.status()
        for name, info in products.items():
            info["calibrated"] = name in calibrated
        return {"available": True, "dir": str(self.source.root), "products": products}


_shared: "RadarService | None" = None


def radar_dir() -> "str | None":
    """Where the radar GIFs are: `MCW_RADAR_DIR`, else the dish's EMWIN
    directory when the dish is the source, else nowhere."""
    if settings.radar_dir:
        return settings.radar_dir
    return settings.sdr_emwin_dir if settings.emwin_source == "sdr" else None


def fill_dir() -> "str | None":
    """Where the internet fill keeps the radar pictures it took (emwin/fill.py):
    beside the dish's, read the same way. Only with the dish as the source."""
    if settings.emwin_source != "sdr" or not settings.fill_enabled:
        return None
    return str(Path(settings.data_dir) / "emwin_internet")


def shared() -> RadarService:
    global _shared
    if _shared is None:
        _shared = RadarService(radar_dir(), extra_roots=[r for r in [fill_dir()] if r])
    return _shared
