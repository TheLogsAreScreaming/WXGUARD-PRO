"""Active warnings and watches as map outlines, for the public dashboard (goes.digitaino.com).

The map shows what the bot would answer with: every active event of
`extract_active_warnings`, drawn as its storm-based polygon when it has one,
else as the zones and counties on its UGC line merged into one outline. The
outlines are the app bundle's (client_data/zones.geojson, which has the marine
zones too, and counties.geojson), simplified to about half a kilometre once at
first use, so the page needs no outside map service. The area this bot answers
for comes along as one more outline.

Read-only and public: everything here is in the NWS products themselves.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from meshcore_weather.core.vtec_names import long_name

logger = logging.getLogger(__name__)

CLIENT_DATA = Path(__file__).resolve().parent.parent / "client_data"
TOLERANCE = 0.005          # degrees, ~0.5 km: invisible at state scale, still a county's shape up close
DIGITS = 3                 # coordinates on the wire
CACHE_S = 60               # one build a minute however many viewers
MIN_AREA = 2e-4            # square degrees, ~2 km2: smaller islands and holes are left out

# The NWS hazard-map colours for the products without VTEC (pyIEM has the rest).
_COLORS = {"SPS": "#FFE4B5", "AQA": "#808080"}
_FALLBACK_COLOR = "#9AA3AD"
# Marine UGC prefixes: the water, since the bundle names land zones only.
_WATERS = {"AN": "Atlantic waters", "AM": "Atlantic waters", "GM": "Gulf waters", "PZ": "Pacific waters",
           "PK": "Alaska waters", "PH": "Hawaii waters", "PM": "Marianas waters", "PS": "Samoa waters",
           "LM": "Lake Michigan", "LS": "Lake Superior", "LH": "Lake Huron", "LE": "Lake Erie",
           "LO": "Lake Ontario", "LC": "Lake St. Clair", "SL": "St. Lawrence River"}
# Drawn on top and listed first: warnings, then watches, then advisories and
# statements; within warnings the life-threatening ones lead.
_SIG_RANK = {"W": 0, "A": 1, "Y": 2, "S": 3}
_LEAD = ["TO", "EW", "SV", "FF", "SQ", "TS", "HU", "SS", "TR", "BZ", "IS", "WS", "HW", "FL", "CF"]

_shapes: dict | None = None
_names: dict | None = None
_shapes_lock = threading.Lock()
_outlines: dict = {}       # an event's area -> its outline, while the event lasts
_outlines_used: set = set()
_cache: dict = {"t": 0.0, "data": None}
_cache_lock = threading.Lock()


def load_shapes(paths: list[Path] | None = None) -> dict:
    """UGC code -> simplified shapely geometry, zones and counties alike. Built once."""
    global _shapes
    with _shapes_lock:
        if _shapes is not None and paths is None:
            return _shapes
        from shapely import make_valid
        from shapely.geometry import shape
        out: dict = {}
        for path in paths or [CLIENT_DATA / "zones.geojson", CLIENT_DATA / "counties.geojson"]:
            try:
                features = json.loads(Path(path).read_text()).get("features", [])
            except (OSError, ValueError) as exc:
                logger.warning("Map outlines unavailable from %s (%s)", path, exc)
                continue
            for feat in features:
                code = (feat.get("properties") or {}).get("code")
                try:
                    geom = shape(feat["geometry"])
                    if not geom.is_valid:
                        geom = make_valid(geom)
                    out[code] = geom.simplify(TOLERANCE, preserve_topology=True)
                except Exception:   # noqa: BLE001 - one bad outline costs only that area
                    continue
            del features
        if paths is None:
            _shapes = out
            logger.info("Map outlines loaded: %d zones and counties", len(out))
        return out


def area_names() -> dict:
    """UGC code -> place name, for the list beside the map ("Travis, Hays and 3 more")."""
    global _names
    if _names is None:
        names: dict = {}
        for fname in ("zones.json", "counties.json"):
            try:
                for code, z in json.loads((CLIENT_DATA / fname).read_text()).items():
                    if z.get("name"):
                        names[code] = " ".join(z["name"].split())
            except (OSError, ValueError, AttributeError):
                pass
        _names = names
    return _names


def outline(w: dict, shapes: dict):
    """(geometry or None, UGCs with no outline). A storm-based warning is its own
    polygon; its counties only say which ones the polygon touches."""
    from shapely import make_valid
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    vertices = w.get("vertices") or []
    if len(vertices) >= 3:
        poly = Polygon([(lon, lat) for lat, lon in vertices])
        return (poly if poly.is_valid else make_valid(poly)), 0
    ugcs = w.get("ugcs") or w.get("zones") or []
    parts = [shapes[u] for u in ugcs if u in shapes]
    missing = len(ugcs) - len(parts)
    if not parts:
        return None, missing
    # Each outline was simplified on its own, so neighbours no longer share an edge
    # exactly; growing them a hair before the merge and shrinking after closes the cracks.
    merged = unary_union([p.buffer(TOLERANCE, quad_segs=2) for p in parts]).buffer(-TOLERANCE, quad_segs=2)
    return merged.simplify(TOLERANCE, preserve_topology=True), missing


def rings(geom) -> list[list[list[float]]]:
    """Every ring of a (multi)polygon, holes included: the page fills them even-odd.
    Slivers under MIN_AREA go (the barrier islands and marsh of a coastal zone were
    nine rings in ten and half the bytes), except a polygon's only part."""
    from shapely.geometry import Polygon
    polys = []
    stack = [geom]
    while stack:
        g = stack.pop()
        if g.geom_type == "Polygon":
            polys.append(g)
        elif hasattr(g, "geoms"):                       # multipolygons, collections out of make_valid
            stack += list(g.geoms)
    if not polys:
        return []
    keep = [p for p in polys if p.area >= MIN_AREA] or [max(polys, key=lambda p: p.area)]
    out = []
    for poly in keep:
        for i, ring in enumerate([poly.exterior, *poly.interiors]):
            if i and Polygon(ring).area < MIN_AREA:
                continue
            pts = [[round(x, DIGITS), round(y, DIGITS)] for x, y in ring.coords]
            if len(pts) >= 4:
                out.append(pts)
    return out


def shape_of(w: dict, shapes: dict) -> dict:
    """{rings, bbox, missing} for one event, kept while the event's area stays the
    same: the merge is most of the build's time and the areas rarely change."""
    key = (tuple(w.get("ugcs") or w.get("zones") or []), tuple(map(tuple, w.get("vertices") or [])))
    hit = _outlines.get(key)
    if hit is None:
        geom, missing = outline(w, shapes)
        empty = geom is None or geom.is_empty
        hit = {"rings": [] if empty else rings(geom), "missing": missing,
               "bbox": None if empty else [round(v, 2) for v in geom.bounds]}
        _outlines[key] = hit
    _outlines_used.add(key)
    return hit


def _where(ugcs: list[str], names: dict) -> str:
    """"Travis, Hays and 3 more (TX)", or "4 zones · Lake Michigan" for marine zones,
    whose names the bundle does not carry."""
    known = [names[u] for u in ugcs if u in names]
    states = sorted({u[:2] for u in ugcs})
    if not known and states and all(st in _WATERS for st in states):
        waters = ", ".join(dict.fromkeys(_WATERS[st] for st in states))
        return f"{len(ugcs)} marine zone{'s' if len(ugcs) != 1 else ''} · {waters}"
    tail = f" ({', '.join(states)})" if 0 < len(states) <= 3 else ""
    if not known:
        return f"{len(ugcs)} areas{tail}" if len(ugcs) != 1 else f"1 area{tail}"
    if len(known) <= 3 and len(known) == len(ugcs):
        return ", ".join(known[:-1]) + (" and " if len(known) > 1 else "") + known[-1] + tail
    shown = known[:2]
    return f"{', '.join(shown)} and {len(ugcs) - len(shown)} more{tail}"


def _ts(d) -> int | None:
    return int(d.timestamp()) if isinstance(d, datetime) else None


def describe(w: dict, shapes: dict, names: dict, in_area: bool) -> dict:
    """One active event for the page: what it is, where, until when, and its outline."""
    phen, sig = w.get("vtec_phenomenon"), w.get("vtec_significance")
    ptype = w.get("product_type") or ""
    if phen and sig:
        from pyiem.nws.vtec import NWS_COLORS
        name = long_name(phen, sig)
        if "." in name or name == f"{phen}{sig}":       # a code the bot's table lacks (TY.W)
            from pyiem.nws.vtec import get_ps_string
            name = get_ps_string(phen, sig)
        color = NWS_COLORS.get(f"{phen}.{sig}", _FALLBACK_COLOR)
        code = f"{phen}.{sig}"
    else:
        name = (w.get("event_name") or "").title() or ("Special Weather Statement" if ptype == "SPS" else ptype)
        color = _COLORS.get(ptype, _FALLBACK_COLOR)
        code = ptype
    shape = shape_of(w, shapes)
    ugcs = list(w.get("ugcs") or w.get("zones") or [])
    lead = _LEAD.index(phen) if phen in _LEAD else len(_LEAD)
    office = (w.get("vtec_office") or "")[-3:]
    return {
        "id": f"{office}.{code}.{w.get('vtec_etn') or w.get('filename')}",
        "name": name,
        "code": code,
        "color": color,
        "rank": _SIG_RANK.get(sig, 3) * 100 + lead,
        "office": office,
        "headline": w.get("headline") or "",
        "where": _where(ugcs, names),
        "issued": _ts(w.get("issued_at")),
        "expires": None if w.get("until_further_notice") else _ts(w.get("expires_at")),
        "storm_based": len(w.get("vertices") or []) >= 3,
        "areas": len(ugcs),
        "missing": shape["missing"],
        "in_area": in_area,
        "product": w.get("filename"),
        "source": w.get("source") or "",
        "bbox": shape["bbox"],
        "rings": shape["rings"],
    }


def coverage_area(coverage, shapes: dict) -> dict | None:
    """The area the bot answers for: its zones merged, plus the centre and radius they came from."""
    if coverage is None or getattr(coverage, "national", False):
        return None
    shape = shape_of({"ugcs": sorted(coverage.zones)}, shapes)
    center = coverage.center
    return {
        "name": coverage.home_name,
        "center": [center[1], center[0]] if center else None,
        "radius_km": coverage.radius_km or None,
        "zones": len(coverage.zones),
        "rings": shape["rings"],
    }


def build(warnings: list[dict], coverage, shapes: dict, names: dict, now: float | None = None) -> dict:
    from meshcore_weather.protocol.warnings import _in_coverage
    area_filter = coverage is not None and not coverage.is_empty() and not getattr(coverage, "national", False)
    out = []
    _outlines_used.clear()
    for w in warnings:
        try:
            out.append(describe(w, shapes, names, area_filter and _in_coverage(w, coverage)))
        except Exception:   # noqa: BLE001 - one odd event must not blank the map
            logger.debug("map entry failed for %s", w.get("filename"), exc_info=True)
    out.sort(key=lambda e: (e["rank"], -(e["issued"] or 0)))
    area = coverage_area(coverage, shapes)
    for key in [k for k in _outlines if k not in _outlines_used]:      # events that ended
        del _outlines[key]
    return {"t": int(now or time.time()), "count": len(out), "warnings": out, "area": area}


def snapshot(store, coverage) -> dict:
    """The public map's data, built at most once a minute (the build is a full warning
    replay plus the outline unions, a second or two on the Pi)."""
    with _cache_lock:
        if _cache["data"] is not None and time.time() - _cache["t"] < CACHE_S:
            return _cache["data"]
        from meshcore_weather.protocol.warnings import extract_active_warnings
        ws = extract_active_warnings(store, coverage=None, now=datetime.now(timezone.utc))
        data = build(ws, coverage, load_shapes(), area_names())
        _cache.update(t=time.time(), data=data)
        return data
