"""Cutting the tile a phone asked for out of a radar picture (spec 13).

A tile is 32 x 32 cells over a square of the earth on a fixed lattice
(`v5.radar_tile`).  A cell's level is the strongest echo in it, not the
average: a thunderstorm core is smaller than a cell, and averaging it away is
the one thing a radar picture on a phone must not do.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median_low

from meshcore_weather.protocol.v5 import MAX_RADAR_ZOOM, RADAR_GRID
from meshcore_weather.radar.picture import BANNER_PX, LEGEND_PX, RadarPicture

HERE = Path(__file__).resolve().parent

#: A product may serve a tile it covers at least this much of; less than that
#: and the honest answer is "no picture".
MIN_COVERAGE = 0.25

_COMPASS8 = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


def _merc(lat: float) -> float:
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def tile_span(zoom: int) -> int:
    if not (0 <= zoom <= MAX_RADAR_ZOOM):
        raise ValueError(f"zoom must be 0..{MAX_RADAR_ZOOM}, got {zoom}")
    return 2 << zoom


@dataclass(frozen=True)
class Frame:
    """Where one product's picture sits on the earth (`products.json`)."""

    index: int                  # the wire's `product`
    id: str
    name: str
    width: int
    height: int
    west: float
    east: float
    north: float
    south: float
    calibrated: bool

    @property
    def px_per_degree(self) -> float:
        return self.width / (self.east - self.west)

    def x(self, lon: float) -> float:
        return (lon - self.west) / (self.east - self.west) * self.width

    def y(self, lat: float) -> float:
        top, bottom = BANNER_PX, self.height - LEGEND_PX
        return top + (_merc(self.north) - _merc(lat)) / (_merc(self.north) - _merc(self.south)) * (bottom - top)

    def coverage(self, south: int, west: int, span: int) -> float:
        """The fraction of a tile, by degrees, that lies inside this picture."""
        w = max(0.0, min(self.east, west + span) - max(self.west, west))
        h = max(0.0, min(self.north, south + span) - max(self.south, south))
        return (w * h) / (span * span)


def load_frames(path: "Path | None" = None) -> "list[Frame]":
    doc = json.loads((path or HERE / "products.json").read_text())
    return [
        Frame(
            index=i, id=p["id"], name=p["name"], width=p["size"][0], height=p["size"][1],
            west=p["west"], east=p["east"], north=p["north"], south=p["south"],
            calibrated=bool(p.get("calibrated", True)),
        )
        for i, p in enumerate(doc["products"])
    ]


def candidates(frames: "list[Frame]", south: int, west: int, zoom: int) -> "list[Frame]":
    """The products that could serve a tile, best first.

    A picture that holds the whole tile beats one that holds part of it; among
    those, the finer picture wins, which is what puts a regional mosaic ahead
    of the national one.
    """
    span = tile_span(zoom)
    scored = [(f.coverage(south, west, span), f) for f in frames if f.calibrated]
    scored = [(c, f) for c, f in scored if c >= MIN_COVERAGE]
    scored.sort(key=lambda cf: (-(cf[0] >= 0.999), -round(cf[0], 2) if cf[0] < 0.999 else 0, -cf[1].px_per_degree))
    return [f for _, f in scored]


@dataclass
class RadarTile:
    south: int
    west: int
    zoom: int
    rows: "list[list[int]]"                       # 32 x 32, north row first
    bounds: "tuple[int, int, int, int] | None"    # row0, row1, col0, col1 when part is outside the picture
    wet: int                                      # cells above level 0


def strongest(seen) -> int:
    """A cell's level from the levels of the pixels seen in it: the strongest
    echo, not the average.  One pixel may set a small cell; a large one wants
    two, so a single misread pixel cannot paint a 28 km square red."""
    need = 1 if seen.size < 12 else 2
    for candidate in (3, 2, 1):
        if int((seen >= candidate).sum()) >= need:
            return candidate
    return 0


def cut_tile(picture: RadarPicture, frame: Frame, south: int, west: int, zoom: int,
             rule=strongest) -> "RadarTile | None":
    """The tile's grid from one picture, or None when none of it is inside.

    `rule` turns the pixels seen in one cell into its level.  The bot always
    uses `strongest`; `scripts/radar_audit.py` passes others to measure what a
    different rule would have sent from the same pictures."""
    n = RADAR_GRID
    span = tile_span(zoom)
    cell = span / n
    top, bottom = BANNER_PX, frame.height - LEGEND_PX
    levels = picture.levels

    # Whole cells inside the picture, as inclusive row and column ranges.
    eps = 1e-9
    rows_in = [r for r in range(n)
               if south + span - r * cell <= frame.north + eps and south + span - (r + 1) * cell >= frame.south - eps]
    cols_in = [c for c in range(n)
               if west + c * cell >= frame.west - eps and west + (c + 1) * cell <= frame.east + eps]
    if not rows_in or not cols_in:
        return None
    row0, row1, col0, col1 = rows_in[0], rows_in[-1], cols_in[0], cols_in[-1]

    ys = [frame.y(south + span - r * cell) for r in range(n + 1)]
    xs = [frame.x(west + c * cell) for c in range(n + 1)]
    grid: "list[list[int | None]]" = [[None] * n for _ in range(n)]
    for r in range(row0, row1 + 1):
        ya = max(top, int(math.floor(ys[r])))
        yb = min(bottom, max(int(math.ceil(ys[r + 1])), ya + 1))
        for c in range(col0, col1 + 1):
            xa = max(0, int(math.floor(xs[c])))
            xb = min(frame.width, max(int(math.ceil(xs[c + 1])), xa + 1))
            box = levels[ya:yb, xa:xb]
            seen = box[box >= 0]
            if seen.size == 0:
                continue
            grid[r][c] = rule(seen)

    # Cells that were all furniture take the middle of their neighbours.
    for _ in range(4):
        holes = [(r, c) for r in range(row0, row1 + 1) for c in range(col0, col1 + 1) if grid[r][c] is None]
        if not holes:
            break
        filled = {}
        for r, c in holes:
            around = [grid[y][x]
                      for y in range(max(row0, r - 1), min(row1, r + 1) + 1)
                      for x in range(max(col0, c - 1), min(col1, c + 1) + 1)
                      if grid[y][x] is not None]
            if around:
                filled[(r, c)] = median_low(around)
        for (r, c), v in filled.items():
            grid[r][c] = v
    rows = [[v or 0 for v in row] for row in grid]

    # A light cell with nothing wet beside it is clutter far more often than rain.
    # A moderate or heavy one is kept: a lone storm is exactly one cell wide.
    lone = [(r, c) for r in range(n) for c in range(n)
            if rows[r][c] == 1 and not any(
                rows[y][x]
                for y in range(max(0, r - 1), min(n, r + 2))
                for x in range(max(0, c - 1), min(n, c + 2))
                if (y, x) != (r, c))]
    for r, c in lone:
        rows[r][c] = 0

    whole = (row0, row1, col0, col1) == (0, n - 1, 0, n - 1)
    return RadarTile(
        south=south, west=west, zoom=zoom, rows=rows,
        bounds=None if whole else (row0, row1, col0, col1),
        wet=sum(1 for row in rows for v in row if v),
    )


def coarse_bounds(bounds: "tuple[int, int, int, int] | None") -> "tuple[int, int, int, int] | None":
    """Bounds of a 32-grid as bounds of the 16-grid made from it.

    A coarse cell is known only when all four cells under it were, so an odd
    edge moves inwards.  None when nothing whole is left.
    """
    if bounds is None:
        return None
    row0, row1, col0, col1 = bounds
    out = ((row0 + 1) // 2, (row1 - 1) // 2, (col0 + 1) // 2, (col1 - 1) // 2)
    return out if out[0] <= out[1] and out[2] <= out[3] else None


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> str:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    deg = math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                  math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)))
    return _COMPASS8[int(((deg + 360) % 360 + 22.5) // 45) % 8]


def describe(tile: RadarTile, lat: float, lon: float) -> dict:
    """What a tile says about one place, for the `radar` text reply.

    `here` is the level over the place, None when the picture does not reach
    it.  `nearest` and `heavy` are `(level, km, bearing)` of the closest wet
    cell other than the place's own and of the closest level 3 cell; `heavy`
    is left out when it is that same cell or the place is already under one.
    """
    n = len(tile.rows)
    span = tile_span(tile.zoom)
    cell = span / n
    # Half-open on the north and east edges, the convention both apps use, so
    # two neighbouring tiles never both claim a point.
    inside = tile.south <= lat < tile.south + span and tile.west <= lon < tile.west + span
    col = min(n - 1, max(0, int((lon - tile.west) // cell)))
    row = min(n - 1, max(0, int((tile.south + span - lat) // cell)))
    if inside and tile.bounds is not None:
        r0, r1, c0, c1 = tile.bounds
        inside = r0 <= row <= r1 and c0 <= col <= c1
    here = tile.rows[row][col] if inside else None
    nearest = heavy = None
    for r in range(n):
        for c in range(n):
            level = tile.rows[r][c]
            if not level or (r, c) == (row, col):
                continue
            clat = tile.south + span - (r + 0.5) * cell
            clon = tile.west + (c + 0.5) * cell
            reach = (level, _km(lat, lon, clat, clon), _bearing(lat, lon, clat, clon), (r, c))
            if nearest is None or reach[1] < nearest[1]:
                nearest = reach
            if level == 3 and (heavy is None or reach[1] < heavy[1]):
                heavy = reach
    if heavy is not None and (here == 3 or (nearest is not None and heavy[3] == nearest[3])):
        heavy = None
    return {
        "here": here,
        "nearest": nearest[:3] if nearest else None,
        "heavy": heavy[:3] if heavy else None,
    }
