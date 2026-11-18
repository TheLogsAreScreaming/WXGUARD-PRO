"""What the dashboard's EMWIN tab reads besides the history: the product browser's index
and the outlines the warnings map is drawn on.

The index is the file names alone. goesproc names each product after its WMO heading,
the EMWIN uplink's stamp and its AWIPS id
(A_FXUS64KEWX181724_C_KWIN_20261018172411_720145-2-AFDEWXTX.TXT), and the file's mtime
is when it reached the dish. That is about 20,000 products a day; a scan every 30 s
lists the newest day directories and stats only the names it has not seen. A text
search reads the files themselves, newest first, within a time budget.

The base map is Natural Earth's 1:50m states and countries, which goestools ships on
the Pi, thinned once at startup: no outside map service.
"""
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone

NAME_RE = re.compile(r"^([AZ])_([A-Z]{4})(\d{2})([A-Z0-9]{4})(\d{6})([A-Z]{3})?_C_([A-Z]{4})_(\d{14})_(\d+)-(\d)-([A-Z0-9]+)\.(\w+)$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
KEEP_S = 48 * 3600
TEXT_CAP = 256 * 1024

# What a product is, by its AWIPS type (the first three letters of its AWIPS id), else by
# its WMO heading. The kinds are the browser's chips.
WARNING_TYPES = {"TOR", "SVR", "SVS", "SPS", "FFW", "FFS", "FLW", "FLS", "FFA", "FLA", "WSW", "NPW", "RFW", "FWW",
                 "MWW", "MWS", "SMW", "DSW", "EWW", "SQW", "CFW", "WCN", "WOU", "SEL", "HLS", "TCV", "TSU", "AQA",
                 "CAE", "CEM", "EVI", "LAE", "SAW", "WWP"}
TYPE_KINDS = {
    **{t: "Warnings" for t in WARNING_TYPES},
    **{t: "Forecasts" for t in ("ZFP", "PFM", "SFT", "CCF", "AFM", "FWF", "REC", "SRF", "PFW", "TAF", "FWS", "SFP",
                               "RFD", "FWM", "TAV", "SCS", "NFD", "NOW", "FWL", "AFP")},
    **{t: "Discussions" for t in ("AFD", "SWO", "HWO", "PMD", "TWD", "TWO", "QPF", "QPS", "FXC", "MIM", "SWP",
                                 "SCD", "TCD", "TCP", "TCM", "TCU", "PWO", "FWO")},
    **{t: "Observations" for t in ("SAH", "MTR", "RWR", "RWS", "OSO", "SPE", "SYN", "TWB", "ADA", "LSR", "OBS", "STA")},
    **{t: "Rivers" for t in ("RVA", "RVS", "RVF", "RVD", "RVM", "RVR", "RR1", "RR2", "RR3", "RR4", "RR5", "RR6",
                            "RR7", "RR8", "RR9", "RRA", "RRM", "RRS", "HYD", "HYM", "ESF", "HMD", "FLN", "FFH", "FFG")},
    **{t: "Marine" for t in ("CWF", "OFF", "NSH", "HSF", "OMR", "GLF", "MRP", "SMF", "CWS", "GLS", "TID", "CGR")},
    **{t: "Climate" for t in ("CLI", "CLM", "CF6", "CMM", "CLA", "STP", "TPT", "RTP", "RER")},
}
TT_KINDS = {"WW": "Warnings", "WF": "Warnings", "WU": "Warnings", "WG": "Warnings", "WH": "Warnings",
            "WO": "Warnings", "WT": "Warnings", "WS": "Warnings", "FP": "Forecasts", "FT": "Forecasts",
            "FX": "Discussions", "AC": "Discussions", "SA": "Observations", "SP": "Observations",
            "AS": "Observations", "SR": "Rivers", "FG": "Rivers", "FZ": "Marine", "CD": "Climate",
            "CX": "Climate", "CS": "Climate"}
KINDS = ["Warnings", "Forecasts", "Discussions", "Observations", "Rivers", "Marine", "Climate", "Images", "Other"]
IMAGE_EXTS = {"GIF", "JPG", "JPEG", "PNG"}

TYPE_NAMES = {
    "AFD": "Area Forecast Discussion", "ZFP": "Zone Forecasts", "PFM": "Point Forecast Matrices",
    "SFT": "State Forecast Table", "AFM": "Area Forecast Matrices", "CCF": "City Forecasts", "NOW": "Short Term Forecast",
    "HWO": "Hazardous Weather Outlook", "SPS": "Special Weather Statement", "NPW": "Non-Precipitation Warnings",
    "WSW": "Winter Weather Message", "TOR": "Tornado Warning", "SVR": "Severe Thunderstorm Warning",
    "SVS": "Severe Weather Statement", "FFW": "Flash Flood Warning", "FFS": "Flash Flood Statement",
    "FLW": "Flood Warning", "FLS": "Flood Statement", "FFA": "Flood Watch", "RFW": "Red Flag Warning",
    "FWF": "Fire Weather Forecast", "CFW": "Coastal Hazard Message", "MWW": "Marine Weather Message",
    "SMW": "Special Marine Warning", "MWS": "Marine Weather Statement", "WCN": "Watch County Notification",
    "WOU": "Watch Outline Update", "SEL": "Severe Storm Watch", "SAW": "Watch Approximate Area",
    "SWO": "Storm Prediction Center Outlook", "HLS": "Hurricane Local Statement", "TCV": "Tropical Watches and Warnings",
    "TWO": "Tropical Weather Outlook", "TWD": "Tropical Weather Discussion", "TCD": "Tropical Cyclone Discussion",
    "TCP": "Tropical Cyclone Advisory", "TCM": "Tropical Cyclone Forecast Advisory", "AQA": "Air Quality Alert",
    "LSR": "Local Storm Report", "PNS": "Public Information Statement", "RWR": "Regional Weather Roundup",
    "SAH": "Airport Reports (METAR)", "MTR": "Airport Report (METAR)", "TAF": "Airport Forecast (TAF)",
    "CWF": "Coastal Waters Forecast", "OFF": "Offshore Forecast", "NSH": "Nearshore Marine Forecast",
    "HSF": "High Seas Forecast", "SRF": "Surf Forecast", "REC": "Recreational Forecast",
    "RVA": "Hydrologic Summary", "RVS": "Hydrologic Statement", "RVF": "River Forecast", "RVD": "River Data",
    "ESF": "Hydrologic Outlook", "HYD": "Rainfall Report", "RTP": "Temperature and Precipitation Summary",
    "CLI": "Daily Climate Report", "CLM": "Monthly Climate Report", "CF6": "Preliminary Climate Data",
    "OSO": "Surface Observations", "PMD": "Prognostic Discussion", "QPF": "Rainfall Forecast",
    "ADM": "Administrative Message", "OBS": "Observations", "TID": "Tide Report", "RER": "Record Event Report",
    "FFH": "Flash Flood Guidance", "FFG": "Flash Flood Guidance", "MIS": "Miscellaneous", "TST": "Test Message", "FTM": "Radar Outage Notice", "SCS": "Selected Cities Summary",
    "AQI": "Air Quality Index", "MIM": "Marine Interpretation", "RRM": "Hydrologic Data", "RRS": "Hydrologic Data",
}
# WMO originators whose office code is not their last three letters.
CCCC_OFFICE = {"TJSJ": "SJU"}


def classify(tt: str, awips: str, ext: str) -> str:
    if ext.upper() in IMAGE_EXTS:
        return "Images"
    return TYPE_KINDS.get(awips[:3]) or TT_KINDS.get(tt[:2]) or "Other"


def office_of(cccc: str) -> str:
    return CCCC_OFFICE.get(cccc, cccc[1:] if len(cccc) == 4 else cccc)


def _stamp(s: str) -> int | None:
    try:
        return int(datetime.strptime(s, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


class ProductIndex:
    """roots: {source: (directory, published prefix)}. A product's id is its path under
    that prefix ("emwin/2026-10-18/A_...TXT", "inet/2026-10-16/A_...TXT"), which is also
    where the dashboard's /img/ route serves it.

    Each product is kept as one small tuple (file name, day directory, received, size,
    kind, office) and everything else is read back out of the name when a search returns
    it: two days are ~65,000 products, and full dicts cost the Pi 87 MB."""

    def __init__(self, roots: dict, offices: dict | None = None, keep_s: int = KEEP_S):
        self.roots = roots
        self.offices = offices or {}
        self.keep_s = keep_s
        self.lock = threading.Lock()
        self.entries: dict = {}            # file name -> (file, dir key, received, size, kind, office)
        self.dirs: dict = {}               # dir key ("emwin/2026-10-18") -> (absolute directory, source)
        self.newest_first: list = []
        self.seen: dict = {}               # dir key -> names already looked at
        self.scanned_at = 0.0

    def scan(self, now: float | None = None) -> int:
        """Index what is new in the newest three day directories of each root; forget what
        is past keep_s. Returns how many products were added."""
        now = now or time.time()
        added = []
        live = set()
        for src, (root, prefix) in self.roots.items():
            try:
                days = sorted(d for d in os.listdir(root) if DAY_RE.match(d))[-3:]
            except OSError:
                continue
            for day in days:
                key = sys.intern(f"{prefix}/{day}")
                path = os.path.join(root, day)
                self.dirs[key] = (path, src)
                live.add(key)
                seen = self.seen.setdefault(key, set())
                try:
                    with os.scandir(path) as it:
                        for e in it:
                            name = e.name
                            if name in seen:
                                continue
                            try:
                                st = e.stat()
                            except OSError:
                                continue
                            if now - st.st_mtime < 5:      # goesproc may still be writing it
                                continue
                            seen.add(name)
                            m = NAME_RE.match(name)
                            if m:
                                tt, cccc, awips, ext = m.group(2), m.group(4), m.group(11), m.group(12)
                                added.append((name, key, int(st.st_mtime), st.st_size,
                                              classify(tt, awips, ext), sys.intern(office_of(cccc))))
                except OSError:
                    continue
        with self.lock:
            for ent in added:
                old = self.entries.get(ent[0])
                # The same product off the dish and from the internet backup: the dish's copy.
                if old is None or self.dirs[old[1]][1] != "sdr":
                    self.entries[ent[0]] = ent
            cutoff = now - self.keep_s
            for name in [n for n, e in self.entries.items() if e[2] < cutoff or e[1] not in live]:
                del self.entries[name]
            for key in [k for k in self.seen if k not in live]:
                del self.seen[key]
                self.dirs.pop(key, None)
            self.newest_first = sorted(self.entries.values(), key=lambda e: e[2], reverse=True)
            self.scanned_at = now
        return len(added)

    def start(self, every_s: int = 30):
        def run():
            while True:
                try:
                    self.scan()
                except Exception as e:  # noqa: BLE001
                    print("product index:", e, file=sys.stderr, flush=True)
                time.sleep(every_s)
        threading.Thread(target=run, daemon=True).start()

    def _path(self, ent) -> str:
        return os.path.join(self.dirs[ent[1]][0], ent[0])

    def describe(self, ent) -> dict:
        """One product for the page, read back out of its name."""
        name, key, received, size, kind, office = ent
        m = NAME_RE.match(name)
        _k, tt, aa, cccc, ddhhmm, bbb, _s, stamp, _seq, prio, awips, ext = m.groups()
        return {"id": f"{key}/{name}", "file": name, "src": self.dirs[key][1], "received": received, "size": size,
                "wmo": f"{tt}{aa} {cccc} {ddhhmm}" + (f" {bbb}" if bbb else ""), "awips": awips, "office": office,
                "office_name": self.offices.get(office, ""), "kind": kind, "name": TYPE_NAMES.get(awips[:3], awips),
                "filed": _stamp(stamp), "priority": int(prio), "ext": ext.upper()}

    def _meta(self, ent) -> str:
        m = NAME_RE.match(ent[0])
        return f"{TYPE_NAMES.get(m.group(11)[:3], '')} {m.group(11)} {m.group(2)}{m.group(3)} {m.group(4)} {self.offices.get(ent[5], '')}".lower()

    def images(self, awips_ids) -> dict:
        """AWIPS id -> [(id, filed, received)] of the images with those ids, oldest filed first.
        An image's WMO heading has the hour on a 12-hour clock (the 00:30Z radar frame is
        headed 1230), so its time is the EMWIN stamp."""
        want = set(awips_ids)
        with self.lock:
            rows = [e for e in self.newest_first if e[4] == "Images"]
        out: dict = {}
        for e in rows:
            m = NAME_RE.match(e[0])
            if m and m.group(11) in want:
                out.setdefault(m.group(11), []).append((f"{e[1]}/{e[0]}", _stamp(m.group(8)), e[2]))
        for frames in out.values():
            frames.sort(key=lambda f: (f[1] or 0, f[2]))
        return out

    def get(self, pid: str = "", name: str = ""):
        """An entry by id ("emwin/2026-10-18/A_...TXT") or by bare file name, else None."""
        with self.lock:
            if pid:
                key, _, name = pid.rpartition("/")
                ent = self.entries.get(name)
                return ent if ent and ent[1] == key else None
            return self.entries.get(name)

    def read(self, ent) -> str:
        """A product's text for the reader: line endings made plain, at most TEXT_CAP."""
        with open(self._path(ent), "rb") as f:
            raw = f.read(TEXT_CAP + 1)
        text = raw[:TEXT_CAP].decode("utf-8", errors="replace").replace("\r\r\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
        text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text).strip("\n")
        return text + ("\n\n[cut at 256 KB]" if len(raw) > TEXT_CAP else "")

    def search(self, q: str = "", kind: str = "", office: str = "", limit: int = 100, text: bool = True,
               budget_s: float = 1.5) -> dict:
        """Newest first. Every word of `q` must be in the product's name, AWIPS id, WMO
        heading or office, or else `q` as a phrase in its text (text products only, read
        newest first until `budget_s` is spent; line breaks count as spaces)."""
        with self.lock:
            rows = self.newest_first
        words = [w for w in q.lower().split() if w]
        phrase = " ".join(words)
        office = office.upper()
        pool = [e for e in rows if (not kind or e[4] == kind) and (not office or e[5] == office)]
        text_hits: set = set()
        scanned, partial = 0, False
        if not words:
            hits = pool[:limit]
        else:
            hits, rest = [], []
            for e in pool:
                (hits if all(w in self._meta(e) for w in words) else rest).append(e)
            hits = hits[:limit]
            if text and len(hits) < limit:
                t0 = time.monotonic()
                for e in rest:
                    if not e[0].endswith(".TXT"):
                        continue
                    if time.monotonic() - t0 > budget_s:
                        partial = True
                        break
                    scanned += 1
                    try:
                        with open(self._path(e), "rb") as f:
                            body = f.read(TEXT_CAP).decode("utf-8", errors="replace").lower()
                    except OSError:
                        continue
                    if phrase in " ".join(body.split()):
                        text_hits.add(e[0])
                        hits.append(e)
                        if len(hits) >= limit:
                            partial = True
                            break
                hits.sort(key=lambda e: e[2], reverse=True)
        offices: dict = {}
        kinds: dict = {}
        for e in rows:
            offices[e[5]] = offices.get(e[5], 0) + 1
            kinds[e[4]] = kinds.get(e[4], 0) + 1
        return {
            "total": len(rows), "matched": len(hits), "text_scanned": scanned, "text_partial": partial,
            "products": [self.describe(e) | {"hit": "text" if e[0] in text_hits else "name"} for e in hits],
            "offices": sorted([[o, self.offices.get(o, ""), n] for o, n in offices.items()],
                              key=lambda x: (x[1] == "", x[1] or x[0])),
            "kinds": [[k, kinds.get(k, 0)] for k in KINDS],
            "oldest": rows[-1][2] if rows else None,
        }


# ----------------------------------------------------------------------------- radar and charts
# EMWIN's radar mosaics, by AWIPS id, every 15-20 minutes.
RADAR_REGIONS = [
    ("RADREFUS", "United States"), ("RADSTHPL", "Southern Plains"), ("RADRCKST", "Southern Rockies"),
    ("RADSMSVY", "Southern Mississippi Valley"), ("RADSTHES", "Southeast"), ("RADNTHES", "Northeast"),
    ("RADGRTLK", "Great Lakes"), ("RADUMSVY", "Upper Mississippi Valley"), ("RADRCKNT", "Northern Rockies"),
    ("RADPACNW", "Pacific Northwest"), ("RADPACSW", "Pacific Southwest"), ("RADALLAK", "Alaska"),
    ("RADALLHI", "Hawaii"), ("RADALLPR", "Puerto Rico"), ("RADALLGU", "Guam"),
]
# (id, name, who makes it, group, source, key): EMWIN charts by AWIPS id, HRIT's NWS channel
# charts by the name goesproc gives them (20261018T220045Z_USA_latest.gif).
CHARTS = [
    ("usa", "Surface analysis", "NWS (WPC, OPC, NHC)", "Weather", "hrit", "USA"),
    ("fronts", "Fronts and weather forecast", "WPC", "Weather", "emwin", "MOD96FBW"),
    ("severe", "Severe storm outlook, day 1", "SPC", "Weather", "emwin", "MODDY1US"),
    ("rain", "Rain forecast, 24 hours", "WPC", "Weather", "emwin", "MODQP1US"),
    ("flash", "Flash flood risk, day 1", "WPC", "Weather", "emwin", "MOD94SUS"),
    ("rivers", "River flood outlook", "WPC", "Weather", "emwin", "GPHJ88US"),
    ("pacific", "Pacific surface analysis", "OPC", "Marine and tropics", "emwin", "NPSA01US"),
    ("carib", "Caribbean surface analysis", "NHC", "Marine and tropics", "emwin", "CSA001US"),
    ("atl48", "Tropical Atlantic, 48 h forecast", "NHC", "Marine and tropics", "hrit", "atlsfc48"),
    ("atlsea", "Tropical Atlantic sea state", "NHC", "Marine and tropics", "hrit", "atlsea"),
]
NWS_RE = re.compile(r"^(\d{8}T\d{6}Z)_([A-Za-z0-9]+)_latest(?:BW)?\.(?:gif|png|jpg)$")


def hrit_charts(nws_root: str, prefix: str = "nws", keep_s: int = KEEP_S, now: float | None = None) -> dict:
    """goesproc's NWS-channel charts of the last two days: name -> [(id, made, received)]."""
    now = now or time.time()
    out: dict = {}
    try:
        days = sorted(d for d in os.listdir(nws_root) if DAY_RE.match(d))[-3:]
    except OSError:
        return out
    for day in days:
        try:
            with os.scandir(os.path.join(nws_root, day)) as it:
                for e in it:
                    m = NWS_RE.match(e.name)
                    if not m:
                        continue
                    received = int(e.stat().st_mtime)
                    if now - received > keep_s:
                        continue
                    made = int(datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp())
                    out.setdefault(m.group(2), []).append((f"{prefix}/{day}/{e.name}", made, received))
        except OSError:
            continue
    for frames in out.values():
        frames.sort(key=lambda f: (f[1], f[2]))
    return out


def radar_and_charts(index: ProductIndex, nws_root: str, radar_hours: int = 12) -> dict:
    """Every radar region and chart that has a frame, each frame [id, made, received], oldest
    made first. A frame made twice (NOAA sends some again) is listed once. Radar keeps the
    `radar_hours` before each region's newest frame (the longest loop is 8 h); charts keep
    the two days, to step back through."""
    emwin = index.images([a for a, _ in RADAR_REGIONS] + [c[5] for c in CHARTS if c[4] == "emwin"])
    hrit = hrit_charts(nws_root)

    def frames(rows, hours=None):
        newest = max((r[1] or 0 for r in rows), default=0)
        out, seen = [], set()
        for pid, made, received in rows:
            if made is None or made // 60 in seen or (hours and made < newest - hours * 3600):
                continue
            seen.add(made // 60)
            out.append([pid, made, received])
        return out
    return {
        "radar": [{"id": a, "name": n, "frames": frames(emwin[a], radar_hours)} for a, n in RADAR_REGIONS if emwin.get(a)],
        "charts": [{"id": cid, "name": n, "by": by, "group": g, "source": src, "frames": frames(fr)}
                   for cid, n, by, g, src, key in CHARTS if (fr := (hrit if src == "hrit" else emwin).get(key))],
    }


# ----------------------------------------------------------------------------- base map
def _thin(ring: list, tol: float) -> list:
    """Douglas-Peucker on one closed ring, in degrees, then rounded to 0.01."""
    if len(ring) <= 4:
        return [[round(x, 2), round(y, 2)] for x, y in ring]
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = ring[a], ring[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        far, far_d = -1, tol
        for i in range(a + 1, b):
            px, py = ring[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm if (dx or dy) else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > far_d:
                far, far_d = i, d
        if far > 0:
            keep[far] = True
            stack += [(a, far), (far, b)]
    out = []
    for i, k in enumerate(keep):
        if k:
            p = [round(ring[i][0], 2), round(ring[i][1], 2)]
            if not out or p != out[-1]:
                out.append(p)
    return out


def _rings(geom: dict, tol: float) -> list:
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    out = []
    for poly in polys:
        for ring in poly:
            r = _thin(ring, tol)
            if len(r) >= 4:
                out.append(r)
    return out


# US territories outside North America in Natural Earth's continents.
_US_PACIFIC = {"GUM", "MNP", "ASM"}


def basemap(ne_dir: str) -> dict:
    """{"states": [{"id": "TX", "rings": [...]}], "land": [rings]}: the US states, and the
    rest of North America plus the Pacific territories as plain land around them."""
    out = {"states": [], "land": []}
    try:
        with open(os.path.join(ne_dir, "ne_50m_admin_1_states_provinces_lakes.json")) as f:
            for feat in json.load(f)["features"]:
                p = feat["properties"]
                if p.get("adm0_a3") == "USA":
                    out["states"].append({"id": p.get("postal"), "rings": _rings(feat["geometry"], 0.02)})
        with open(os.path.join(ne_dir, "ne_50m_admin_0_countries_lakes.json")) as f:
            for feat in json.load(f)["features"]:
                p = feat["properties"]
                a3 = p.get("ADM0_A3")
                if a3 != "USA" and (p.get("CONTINENT") == "North America" or a3 in _US_PACIFIC):
                    out["land"] += _rings(feat["geometry"], 0.05 if a3 not in _US_PACIFIC else 0.01)
    except (OSError, ValueError, KeyError) as e:
        out["error"] = f"base map unavailable ({e.__class__.__name__})"
    return out
