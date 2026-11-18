"""One EMWIN radar GIF, as precipitation levels.

The pictures are drawn for people: a banner, a map with roads and county
lines over it, warning polygons, a colour scale, and the time in the corner.
Everything here is about reading that back as numbers without being fooled by
the drawing.

- **dBZ.**  The GIF palette is rebuilt for every picture, so no colour table
  can be shipped.  The picture carries its own: the scale along the bottom,
  -30 dBZ at x = 36 and 2.38 px per dBZ.  The 256 palette entries are
  classified once against it and the image is mapped through the result.
- **Furniture.**  Roads, borders and labels sit in the same pixels of every
  picture, so a mask per product (`scripts/radar_calibrate.py`) removes them.
  It matters: the roads are drawn in the scale's own 58 dBZ red.
- **Warning polygons** are drawn in colours the scale also uses, but their
  strokes are edged in black.  A black pixel the mask does not explain is a
  polygon edge; grown three pixels it covers the stroke.  The echo under a
  stroke is lost, which is acceptable: the app draws the polygon itself.
- **Time.**  The valid time is printed in the corner and nowhere else.  The
  ten digits are always drawn the same way, so they are matched against
  stored shapes.  It is worth the trouble: a picture is anywhere from 2 to 34
  minutes old when the dish receives it, and the file name cannot say which.

Masked pixels are -1, "cannot tell", and the tile cutter fills them from their
neighbours.  Pixels are never guessed dry.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from meshcore_weather.protocol.v5 import RADAR_LEVELS_DBZ

logger = logging.getLogger(__name__)

HERE = Path(__file__).resolve().parent

#: Rows of banner above the map and of colour scale below it, in every product.
BANNER_PX = 24
LEGEND_PX = 22
#: The colour scale: its row, measured up from the bottom, and where -30 dBZ
#: and one dBZ fall along it.
_SCALE_ROW_FROM_BOTTOM = 20
_SCALE_X0, _SCALE_X1 = 24, 330
_SCALE_MINUS30_X = 36.0
_SCALE_PX_PER_DBZ = 2.38
#: A palette colour further than this from every colour of the scale is not
#: an echo.  RGB distance.
_MAX_COLOUR_DISTANCE = 40.0
#: A picture whose black lines match the mask less well than this was drawn on
#: a different map: the calibration no longer applies.
_MIN_LINE_MATCH = 0.7

# The stamp after the center tag: KWIN (EMWIN) or NWSR (the internet fill's
# copy from radar.weather.gov, stamped with the picture's Last-Modified).
_KWIN_RE = re.compile(r"_C_(?:KWIN|NWSR)_(\d{14})_")
_WMO_RE = re.compile(r"^Z_\w{6}\w{4}(\d{2})(\d{2})(\d{2})_")


@dataclass
class RadarPicture:
    product: str
    path: Path
    received: datetime          # the KWIN stamp: when EMWIN sent it
    taken: datetime             # the picture's own time
    taken_is_printed: bool      # False: the corner could not be read, `taken` is the issue time
    levels: np.ndarray          # int8, (height, width): -1 cannot tell, 0 dry, 1 to 3
    frame_ok: bool              # the black lines are where the mask says
    line_match: float = 1.0     # how much of the mask's black lines this picture draws, 0 to 1


_digits: "tuple[list[str], np.ndarray, tuple[int, int], int] | None" = None


def _stamp_digits():
    global _digits
    if _digits is None:
        doc = json.loads((HERE / "stamp_digits.json").read_text())
        names = sorted(doc["digits"])
        shapes = np.stack([np.array(doc["digits"][d], dtype=np.float32) for d in names])
        _digits = (names, shapes, tuple(doc["rows"]), int(doc["width"]))
    return _digits


def read_stamp(grey: np.ndarray) -> "list[tuple[int, int]]":
    """Every `HH:MM` printed in the corner, rightmost first, from the picture
    as 8-bit grey.

    Every digit shape is slid along the legend strip, and four matches spaced
    like `HH:MM` (7 px between digits, 11 across the colon) with a colon
    between the pairs are a time.  The colon is checked, not assumed: the date
    is printed just to the left in the same digits, and `09/21/2026` reads as
    `09:21` to anything that only counts spacing.  A slash is a stroke through
    the gap, a colon is two dots with nothing between them.

    Rightmost first because whatever else is in the strip is to the left of
    the time, except in Puerto Rico's picture, which prints a local time after
    the UTC one; the caller takes the first that is plausible, and a local
    time four hours off never is.
    """
    names, shapes, (row0, row1), width = _stamp_digits()
    height = grey.shape[0]
    band = grey[height - LEGEND_PX + row0:height - LEGEND_PX + row1, :].astype(np.float32)
    hits: "dict[int, str]" = {}
    for x in range(330, band.shape[1] - width + 1):
        patch = band[:, x:x + width]
        if patch.max() < 150:
            continue
        err = np.abs(shapes - patch).mean(axis=(1, 2))
        order = np.argsort(err)
        if err[order[0]] < 18 and err[order[1]] > err[order[0]] + 2:
            hits[x] = names[order[0]]
    found = []
    for x in sorted(hits, reverse=True):
        if not all(x + k in hits for k in (7, 18, 25)):
            continue
        gap = band[:, x + 14:x + 18].max(axis=1)
        colon = (gap[4:6].max() >= 130 and gap[9:11].max() >= 130
                 and gap[6:9].max() < 110 and gap[0:4].max() < 110)
        hour = int(hits[x] + hits[x + 7])
        minute = int(hits[x + 18] + hits[x + 25])
        if colon and hour < 24 and minute < 60:
            found.append((hour, minute))
    return found


def received_time(name: str) -> "datetime | None":
    m = _KWIN_RE.search(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def issue_time(name: str, received: datetime) -> datetime:
    """The WMO header time of an EMWIN image.

    EMWIN writes the hour of an *image's* header on a 12-hour clock
    (`201145` received at 23:46), so the hour is only trusted modulo 12: the
    answer is the latest time not after `received` with that minute and that
    hour-of-twelve.  Without a header it is `received` itself.
    """
    m = _WMO_RE.match(name)
    if not m:
        return received
    hour12, minute = int(m.group(2)) % 12, int(m.group(3))
    t = (received + timedelta(minutes=2)).replace(second=0, microsecond=0)
    for _ in range(12 * 60 + 2):
        if t.minute == minute and t.hour % 12 == hour12:
            return t
        t -= timedelta(minutes=1)
    return received


def _taken(grey: np.ndarray, name: str, received: datetime) -> "tuple[datetime, bool]":
    for hour, minute in read_stamp(grey):
        t = received.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if t > received + timedelta(minutes=2):
            t -= timedelta(days=1)
        # A picture is 2 to 34 minutes old on arrival.  A time outside that
        # was misread, and a plausible wrong time is worse than a late one.
        if timedelta(minutes=-2) <= received - t <= timedelta(minutes=45):
            return t, True
    return issue_time(name, received), False


def _palette_levels(palette: np.ndarray, scale: "list[tuple[np.ndarray, float]]") -> np.ndarray:
    """Level of each palette entry: -1 cannot tell, 0 dry, 1 to 3."""
    colours = np.stack([c for c, _ in scale]).astype(np.float32)
    dbz = np.array([d for _, d in scale], dtype=np.float32)
    out = np.full(len(palette), -1, dtype=np.int8)
    for i, (r, g, b) in enumerate(palette.astype(np.int16)):
        if r > 225 and g > 225 and b > 225:
            out[i] = 0                                  # land
        elif abs(r - 194) < 14 and abs(g - 234) < 14 and abs(b - 240) < 14:
            out[i] = 0                                  # water
        elif abs(r - g) < 10 and abs(g - b) < 10:
            continue                                    # black and greys: lines and labels
        else:
            d = np.sqrt(((colours - (r, g, b)) ** 2).sum(axis=1))
            j = int(np.argmin(d))
            if d[j] <= _MAX_COLOUR_DISTANCE:
                out[i] = sum(1 for edge in RADAR_LEVELS_DBZ if dbz[j] >= edge)
    return out


_masks: "dict[str, tuple[np.ndarray, np.ndarray]]" = {}


def _mask(product: str) -> "tuple[np.ndarray, np.ndarray] | None":
    """(furniture grown one pixel, black lines) for a product, or None."""
    if product not in _masks:
        path = HERE / "masks" / f"{product}.png"
        if not path.exists():
            return None
        raw = Image.open(path).convert("L")
        grown = np.asarray(raw.point(lambda v: 255 if v else 0).filter(ImageFilter.MaxFilter(3))) > 0
        _masks[product] = (grown, np.asarray(raw) == 255)
    return _masks[product]


def read_picture(path: "str | Path", product: str) -> "RadarPicture | None":
    """Decode one radar GIF.  None when it is not one, is damaged, or has no mask."""
    path = Path(path)
    received = received_time(path.name)
    masks = _mask(product)
    if received is None or masks is None:
        return None
    furniture, lines = masks
    try:
        with Image.open(path) as im:
            im.load()
            if im.mode != "P" or (im.height, im.width) != furniture.shape:
                logger.warning("radar: %s is %s %sx%s, not the picture the mask was made for",
                               path.name, im.mode, im.width, im.height)
                return None
            index = np.asarray(im).copy()
            palette = np.array(im.getpalette(), dtype=np.uint8).reshape(-1, 3)
            grey = np.asarray(im.convert("L"))
    except Exception as e:   # a GIF that lost packets on the way down
        logger.info("radar: cannot read %s (%s)", path.name, e)
        return None
    if len(palette) < 256:
        palette = np.vstack([palette, np.zeros((256 - len(palette), 3), dtype=np.uint8)])
    height = index.shape[0]

    scale = []
    row = height - _SCALE_ROW_FROM_BOTTOM
    for x in range(_SCALE_X0, _SCALE_X1):
        colour = palette[index[row, x]]
        if int(colour.sum()) >= 60:
            scale.append((colour, -30.0 + (x - _SCALE_MINUS30_X) / _SCALE_PX_PER_DBZ))
    if len(scale) < 200:
        logger.warning("radar: %s has no colour scale where one is expected", path.name)
        return None

    levels = _palette_levels(palette, scale)[index]
    rgb = palette.astype(np.int16)
    black = ((rgb[:, 0] < 70) & (rgb[:, 1] < 70) & (rgb[:, 2] < 70))[index]
    line_match = float(black[lines].mean()) if lines.any() else 0.0

    stroke = black & ~furniture
    stroke[:BANNER_PX] = False
    stroke[height - LEGEND_PX:] = False
    stroke = np.asarray(Image.fromarray(stroke.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(7))) > 0

    levels[furniture | stroke] = -1
    levels[:BANNER_PX] = -1
    levels[height - LEGEND_PX:] = -1

    taken, printed = _taken(grey, path.name, received)
    return RadarPicture(
        product=product, path=path, received=received, taken=taken,
        taken_is_printed=printed, levels=levels, frame_ok=line_match >= _MIN_LINE_MATCH,
        line_match=round(line_match, 3),
    )
