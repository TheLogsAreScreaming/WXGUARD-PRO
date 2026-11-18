#!/usr/bin/env python3
"""Calibrate the EMWIN radar mosaics: where each picture sits on the earth, and
which of its pixels are map furniture.

    scripts/radar_calibrate.py SAMPLES_DIR [PRODUCT ...]

SAMPLES_DIR holds a few dozen `*-RAD*.GIF` per product, spread over two or
three days (any depth of sub-directories; the dish's own `emwin/YYYY-MM-DD/`
tree works as it is).  Writes `meshcore_weather/radar/products.json` and one
mask per product under `meshcore_weather/radar/masks/`.

Nothing here runs on the bot.  Run it again when the Weather Service changes
the pictures, which the bot notices by itself (`RadarPicture.frame_ok`).

How the frame is found.  The pictures carry no georeference, but they draw
state lines and coasts in black, in the same place every time.  Between the
banner and the legend, x is linear in longitude and y is linear in Mercator
latitude, so four numbers place a picture: its west, east, north and south
edges.  They are fitted by laying the bundled state outlines over the black
pixels and minimising the mean distance from an outline point to the nearest
black pixel.  A good fit is under one pixel.

How the furniture is found.  A pixel that is not background (white land, pale
blue water) in six pictures out of ten is a road, a border or a label, not
weather.  Those are masked, and the black ones among them are remembered too:
they are what `frame_ok` checks a new picture against.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "meshcore_weather" / "radar"
BASEMAP = REPO / "web" / "assets" / "basemap.json"

BANNER_PX = 24
LEGEND_PX = 22

# Wire order (spec 13 `product`, protocol.json v5.radar.products).  Append only.
# name, rough centre lon/lat and the range of longitude span to search.
PRODUCTS = {
    "RADREFUS": ("United States", -96, 37, (45, 75)),
    "RADSTHPL": ("Southern Plains", -100, 32, (10, 24)),
    "RADRCKST": ("Southern Rockies", -111, 33, (10, 24)),
    "RADRCKNT": ("Northern Rockies", -108, 43, (10, 24)),
    "RADPACSW": ("Pacific Southwest", -120, 36, (10, 24)),
    "RADPACNW": ("Pacific Northwest", -120, 43, (10, 24)),
    "RADUMSVY": ("Upper Mississippi Valley", -96, 43, (10, 24)),
    "RADSMSVY": ("Southern Mississippi Valley", -90, 32, (10, 24)),
    "RADGRTLK": ("Great Lakes", -84.5, 42, (10, 24)),
    "RADNTHES": ("Northeast", -73.5, 43, (10, 24)),
    "RADSTHES": ("Southeast", -83, 30, (10, 24)),
    "RADALLAK": ("Alaska", -151, 62, (25, 80)),
    "RADALLHI": ("Hawaii", -157.5, 20.5, (5, 16)),
    "RADALLPR": ("Puerto Rico", -66, 18, (3, 10)),
    "RADALLGU": ("Guam", 145, 14.5, (3, 14)),
}
#: A fit worse than this many pixels is not shipped: the product stays in the
#: list, so its wire index never moves, but the bot will not cut tiles from it.
MAX_FIT_PX = 1.2


def merc(lat):
    return np.degrees(np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)))


def border_points(step: float = 0.02) -> np.ndarray:
    bm = json.loads(BASEMAP.read_text())
    scale = bm["scale"]
    pts = []
    for state in bm["states"]:
        for ring in state["rings"]:
            a = np.array(ring, dtype=float).reshape(-1, 2) / scale
            for p, q in zip(a[:-1], a[1:]):
                n = max(1, int(np.hypot(*(q - p)) / step))
                t = np.linspace(0, 1, n, endpoint=False)[:, None]
                pts.append(p + (q - p) * t)
    return np.vstack(pts)


def load(samples: Path, product: str) -> np.ndarray:
    files = sorted(samples.rglob(f"*-{product}.GIF"))
    if len(files) < 12:
        raise SystemExit(f"{product}: {len(files)} pictures under {samples}; 12 or more are needed")
    return np.stack([np.asarray(Image.open(f).convert("RGB")).astype(np.int16) for f in files])


def static_layers(stack: np.ndarray):
    r, g, b = stack[..., 0], stack[..., 1], stack[..., 2]
    white = (r > 225) & (g > 225) & (b > 225)
    water = (abs(r - 194) < 14) & (abs(g - 234) < 14) & (abs(b - 240) < 14)
    black = (r < 70) & (g < 70) & (b < 70)
    furniture = (~(white | water)).mean(0) >= 0.6
    lines = black.mean(0) >= 0.6
    height = stack.shape[1]
    for layer in (furniture, lines):
        layer[:BANNER_PX] = False
        layer[height - LEGEND_PX:] = False
    return furniture, lines


def score(frame, dist, height, pts, cap=8.0):
    west, east, north, south = frame
    top, bottom = BANNER_PX, height - LEGEND_PX
    x = (pts[:, 0] - west) / (east - west) * 600
    y = top + (merc(north) - merc(pts[:, 1])) / (merc(north) - merc(south)) * (bottom - top)
    ok = (x >= 0) & (x < 599) & (y >= top) & (y < bottom - 1)
    if ok.sum() < 200:
        return 1e9
    return float(np.minimum(dist[y[ok].astype(int), x[ok].astype(int)], cap).mean())


def refine(frame, dist, height, pts, free=(0, 1, 2, 3)):
    frame = list(frame)
    current = score(frame, dist, height, pts)
    step = 0.5
    while step > 0.0005:
        improved = False
        for i in free:
            for sign in (1, -1):
                trial = frame[:]
                trial[i] += sign * step
                s = score(trial, dist, height, pts)
                if s < current - 1e-7:
                    frame, current, improved = trial, s, True
        if not improved:
            step /= 2
    return current, frame


def fit(product: str, stack: np.ndarray, lines: np.ndarray, all_pts: np.ndarray):
    _, clon, clat, (smin, smax) = PRODUCTS[product]
    height = stack.shape[1]
    dist = ndimage.distance_transform_edt(~lines)
    pts = all_pts[(abs(all_pts[:, 0] - clon) < smax) & (abs(all_pts[:, 1] - clat) < smax)]
    rng = np.random.default_rng(1)
    sample = pts[rng.choice(len(pts), min(len(pts), 4000), replace=False)]
    starts = []
    for _ in range(60000):
        span = rng.uniform(smin, smax)
        lat_span = span * (height - BANNER_PX - LEGEND_PX) / 600 / rng.uniform(0.95, 1.6)
        cx, cy = clon + rng.uniform(-6, 6), clat + rng.uniform(-6, 6)
        frame = (cx - span / 2, cx + span / 2, cy + lat_span / 2, cy - lat_span / 2)
        starts.append((score(frame, dist, height, sample), frame))
    starts.sort(key=lambda s: s[0])
    best = min((refine(frame, dist, height, pts) for _, frame in starts[:25]), key=lambda r: r[0])
    err, frame = best
    # The Weather Service cuts its pictures on whole degrees of longitude.
    snapped = [round(v) if abs(v - round(v)) < 0.03 else v for v in frame[:2]] + frame[2:]
    if snapped != frame:
        err, frame = refine(snapped, dist, height, pts, free=(2, 3))
    return err, frame


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    samples = Path(sys.argv[1])
    wanted = sys.argv[2:] or list(PRODUCTS)
    pts = border_points()
    path = OUT / "products.json"
    known = {p["id"]: p for p in json.loads(path.read_text())["products"]} if path.exists() else {}
    (OUT / "masks").mkdir(parents=True, exist_ok=True)
    for product in wanted:
        stack = load(samples, product)
        furniture, lines = static_layers(stack)
        err, (west, east, north, south) = fit(product, stack, lines, pts)
        mask = np.zeros(furniture.shape, dtype=np.uint8)
        mask[furniture] = 128
        mask[lines] = 255
        Image.fromarray(mask, "L").save(OUT / "masks" / f"{product}.png", optimize=True)
        known[product] = {
            "id": product,
            "name": PRODUCTS[product][0],
            "size": [int(stack.shape[2]), int(stack.shape[1])],
            "west": round(west, 3), "east": round(east, 3),
            "north": round(north, 3), "south": round(south, 3),
            "fit_px": round(err, 3),
            "calibrated": err <= MAX_FIT_PX,
            "pictures": int(stack.shape[0]),
        }
        print(known[product], flush=True)
    doc = {
        "version": 1,
        "note": "Written by scripts/radar_calibrate.py. x is linear in longitude and y in Mercator "
                "latitude between the banner and the legend. The order is the wire's product index.",
        "banner_px": BANNER_PX,
        "legend_px": LEGEND_PX,
        "products": [known[p] for p in PRODUCTS if p in known],
    }
    path.write_text(json.dumps(doc, indent=1) + "\n")


if __name__ == "__main__":
    main()
