"""Radar tiles cut from the Weather Service mosaics the dish receives.

EMWIN carries a national radar picture and fourteen regional ones as GIFs, a
new one of each every 15 minutes.  `picture` turns one into precipitation
levels, `tiles` cuts the 32 x 32 tile a phone asked for out of it, and
`source` finds the newest picture on disk.  Spec section 13 (revision 11).

Nothing here runs until somebody asks: a request decodes one GIF, which is
cached until a newer one arrives.
"""

from meshcore_weather.radar.picture import RadarPicture, read_picture
from meshcore_weather.radar.source import RadarSource
from meshcore_weather.radar.tiles import (
    RadarTile,
    Frame,
    cut_tile,
    describe,
    load_frames,
    tile_span,
)

__all__ = [
    "RadarPicture",
    "RadarSource",
    "RadarTile",
    "Frame",
    "cut_tile",
    "describe",
    "load_frames",
    "read_picture",
    "tile_span",
]
