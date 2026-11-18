"""The radar tile over a bot's own area, and what it shows there, for the
scheduled radar broadcast (spec 15).

The area is a circle around the home point. The tile is the narrowest one on
the wire's lattice (spec 13.1) that holds the whole circle, so one packet per
picture covers it and every phone in range files it as it files an answer.
"""

from __future__ import annotations

import math

from meshcore_weather.protocol.v5 import MAX_RADAR_ZOOM
from meshcore_weather.radar.tiles import RadarTile, _bearing, _km, tile_span

KM_PER_DEG = 111.2
ZOOM_WORDS = ("Local", "Regional", "Wide", "Widest")      # the apps' names for zoom 0-2, and 3
LEVEL_WORDS = ("none", "light", "moderate", "heavy")
# A dry area, by the weakest level that counts.
RADAR_DRY = {1: "no precipitation", 2: "nothing moderate or heavier", 3: "nothing heavy"}


def area_tile(lat: float, lon: float, km: float) -> "tuple[int, int, int] | None":
    """`(south, west, zoom)` of the narrowest tile holding the circle of `km`
    around a point, the one centred nearest it when several do. None when even
    the widest tile cannot, or every tile that could crosses the antimeridian
    (the packet cannot carry a west edge below -180)."""
    dlat = km / KM_PER_DEG
    poleward = min(89.0, abs(lat) + dlat)
    dlon = km / (KM_PER_DEG * math.cos(math.radians(poleward)))
    for zoom in range(MAX_RADAR_ZOOM + 1):
        step, span = 1 << zoom, tile_span(zoom)
        # Edges are half-open on the north and east (spec 13.1).
        souths = [s * step for s in range(math.floor((lat + dlat - span) / step), math.ceil((lat - dlat) / step) + 1)
                  if s * step <= lat - dlat and lat + dlat < s * step + span and -90 <= s * step <= 90 - span]
        wests = [w * step for w in range(math.floor((lon + dlon - span) / step), math.ceil((lon - dlon) / step) + 1)
                 if w * step <= lon - dlon and lon + dlon < w * step + span and -180 <= w * step <= 179]
        if souths and wests:
            south = min(souths, key=lambda s: abs(s + step - lat))
            west = min(wests, key=lambda w: abs(w + step - lon))
            return south, west, zoom
    return None


def describe_tile(south: int, west: int, zoom: int) -> str:
    """`Regional tile (4°): 28°N to 32°N, 100°W to 96°W`."""
    span = tile_span(zoom)

    def deg(v: int, pos: str, neg: str) -> str:
        return f"{abs(v)}°{pos if v >= 0 else neg}"
    return (f"{ZOOM_WORDS[zoom]} tile ({span}°): {deg(south, 'N', 'S')} to {deg(south + span, 'N', 'S')}, "
            f"{deg(west, 'E', 'W')} to {deg(west + span, 'E', 'W')}")


def judge(tile: RadarTile, lat: float, lon: float, km: float, min_level: int) -> dict:
    """What a tile shows within `km` of a point.

    `known` is how many of the circle's cells the picture reaches; `strongest`
    the highest level among them; `cells` how many are at `min_level` or more;
    `here` the level of the point's own cell (None outside the picture);
    `nearest` the `(level, km, bearing)` of the closest other counted cell."""
    n = len(tile.rows)
    span = tile_span(tile.zoom)
    cell = span / n
    r0, r1, c0, c1 = tile.bounds if tile.bounds is not None else (0, n - 1, 0, n - 1)
    own = (min(n - 1, max(0, int((tile.south + span - lat) // cell))),
           min(n - 1, max(0, int((lon - tile.west) // cell))))
    here = tile.rows[own[0]][own[1]] if r0 <= own[0] <= r1 and c0 <= own[1] <= c1 else None
    known = strongest = cells = 0
    nearest = None
    for r in range(n):
        clat = tile.south + span - (r + 0.5) * cell
        for c in range(n):
            clon = tile.west + (c + 0.5) * cell
            d = _km(lat, lon, clat, clon)
            if (d > km and (r, c) != own) or not (r0 <= r <= r1 and c0 <= c <= c1):
                continue
            known += 1
            level = tile.rows[r][c]
            strongest = max(strongest, level)
            if level >= min_level:
                cells += 1
                if (r, c) != own and (nearest is None or d < nearest[1]):
                    nearest = (level, d, _bearing(lat, lon, clat, clon))
    return {"known": known, "strongest": strongest, "cells": cells, "here": here, "nearest": nearest}


def in_words(found: dict, km: float, min_level: int = 1) -> str:
    """`moderate precipitation within 120 km of home, nearest 40 km NW`, or
    `heavy precipitation within 60 km of home; light over home`."""
    head = f"{LEVEL_WORDS[found['strongest']]} precipitation within {km:g} km of home"
    if (found["here"] or 0) >= min_level:
        return f"{head}; {LEVEL_WORDS[found['here']]} over home"
    _level, d, bearing = found["nearest"]
    return f"{head}, nearest {d:.0f} km {bearing}"
