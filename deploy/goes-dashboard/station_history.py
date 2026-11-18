"""Seven days of station history for the goes.digitaino.com dashboard.

dashboard.py feeds it three things: goesrecv's per-second stats (Stats.history), every frame
goesrecv decodes (its packet publisher, port 5004, counted per virtual channel by VcCounter),
and, once a minute, the EMWIN file names goesproc and the bot's internet backup wrote
(Arrivals). Recorder turns a minute of that into one row per table and writes it to one SQLite
file in one transaction, so the SD card sees one small write a minute; rows older than
KEEP_DAYS go once an hour.

It also keeps the station's events (lock lost and regained, restarts, pointing sessions, the
bot's internet backup and its NWS current-conditions feed, EMWIN running late), opened when a
condition starts and closed when it ends, and predicts when the sun passes near the satellite as
seen from the dish (the daily midday dip in early October and early March).

Nothing here imports pynng, so it runs in tests without goesrecv.
"""

import collections
import datetime as dt
import math
import os
import re
import sqlite3
import statistics
import threading
import time
from zoneinfo import ZoneInfo

KEEP_DAYS = 7
KWIN_RE = re.compile(r"_C_KWIN_(\d{14})_")
DATE_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FILL_VC = 63

# What each virtual channel carries, where that is known. ABI bands go out on the VC of their
# band number; EMWIN on 20-22; DCS on 32 (NOAA's notice of 2026-06-03 put DCS-HRIT files there).
# Anything else is shown as not identified, with the packet IDs it carried.
VC_NAMES = {0: "Admin messages", 20: "EMWIN", 21: "EMWIN", 22: "EMWIN", 32: "DCS (sensor platforms)",
            FILL_VC: "Fill (idle frames)"}
ABI_BANDS = {1: "blue visible", 2: "red visible", 3: "veggie", 4: "cirrus", 5: "snow/ice", 6: "cloud particle",
             7: "shortwave IR", 8: "upper water vapor", 9: "mid water vapor", 10: "lower water vapor",
             11: "cloud-top phase", 12: "ozone", 13: "clean IR", 14: "IR", 15: "dirty IR", 16: "CO2"}


def vc_name(vc: int) -> str | None:
    if vc in VC_NAMES:
        return VC_NAMES[vc]
    if vc in ABI_BANDS:
        return f"ABI {vc:02d} · {ABI_BANDS[vc]}"
    return None


def kwin_time(name: str) -> float | None:
    """When NOAA's EMWIN server made a product, from its file name, as unix seconds."""
    m = KWIN_RE.search(name)
    if not m:
        return None
    try:
        return dt.datetime.strptime(m.group(1), "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc).timestamp()
    except ValueError:
        return None


def pct(values, q):
    """The q-th percentile (0-100) of a non-empty list, by nearest rank."""
    s = sorted(values)
    return s[min(len(s) - 1, max(0, round(q / 100 * (len(s) - 1))))]


# ----------------------------------------------------------------------------- virtual channels
class VcCounter:
    """Frames and lost frames per virtual channel, from the VCDUs goesrecv publishes.

    A VCDU starts with a 6-byte header: the VCID is the low 6 bits of byte 1, bytes 2-4 count
    that channel's frames. A jump in the count is that many frames lost on the way (the same
    test goesproc logs as "VCDU drop"). Jumps of 100,000 or more are a counter reset, not loss.
    The first frame of the M_PDU names the packet (APID) it starts, kept as a hint at what a
    channel carries."""

    def __init__(self):
        self.lock = threading.Lock()
        self.frames = collections.Counter()
        self.lost = collections.Counter()
        self.last_count: dict[int, int] = {}
        self.last_seen: dict[int, float] = {}
        self.apids: dict[int, collections.Counter] = collections.defaultdict(collections.Counter)

    def feed(self, vcdu: bytes, now: float | None = None) -> None:
        if len(vcdu) < 8:
            return
        vc = vcdu[1] & 0x3F
        count = int.from_bytes(vcdu[2:5], "big")
        with self.lock:
            self.frames[vc] += 1
            prev = self.last_count.get(vc)
            if prev is not None:
                gap = (count - prev - 1) % (1 << 24)
                if 0 < gap < 100_000:
                    self.lost[vc] += gap
            self.last_count[vc] = count
            self.last_seen[vc] = now or time.time()
            if vc != FILL_VC:
                fhp = ((vcdu[6] & 0x07) << 8) | vcdu[7]
                if fhp < 0x7FE and 8 + fhp + 2 <= len(vcdu):
                    p = 8 + fhp
                    apid = ((vcdu[p] & 0x07) << 8) | vcdu[p + 1]
                    if apid != 0x7FF:   # idle packet
                        self.apids[vc][apid] += 1

    def take(self) -> dict[int, tuple[int, int]]:
        """This minute's (frames, lost) per channel, and start the next minute at zero."""
        with self.lock:
            out = {vc: (self.frames[vc], self.lost[vc]) for vc in set(self.frames) | set(self.lost)}
            self.frames.clear()
            self.lost.clear()
            for c in self.apids.values():          # keep the hints from going stale or growing
                for apid, n in c.items():
                    c[apid] = n // 2
                for apid in [a for a, n in c.items() if n == 0]:
                    del c[apid]
            return out

    def info(self) -> dict[int, dict]:
        with self.lock:
            return {vc: {"last_seen": self.last_seen.get(vc), "apids": [a for a, _ in self.apids[vc].most_common(3)]}
                    for vc in set(self.last_seen)}


# ----------------------------------------------------------------------------- EMWIN arrivals
class Arrivals:
    """The EMWIN files written since the last poll, under each root's newest two UTC day folders.

    Only names are listed each minute; only new names are stat'ed. The first poll learns what is
    already there without counting it (that is history, filled in once by backfill())."""

    def __init__(self, roots: dict[str, str]):
        self.roots = roots               # {"sdr": goesproc's emwin/, "inet": the bot's emwin_internet/}
        self.seen: dict[str, set[str]] = {}
        self.primed = False

    def _days(self, root: str) -> list[str]:
        try:
            return [os.path.join(root, d) for d in sorted(d for d in os.listdir(root) if DATE_DIR.match(d))[-2:]]
        except OSError:
            return []

    def poll(self) -> dict:
        out = {"sdr": 0, "inet": 0, "lags": [], "families": collections.Counter()}
        keep = set()
        for kind, root in self.roots.items():
            for d in self._days(root):
                keep.add(d)
                try:
                    names = set(os.listdir(d))
                except OSError:
                    continue
                if d not in self.seen and not self.primed:
                    self.seen[d] = names
                    continue
                new = names - self.seen.get(d, set())
                self.seen[d] = names
                for n in new:
                    out[kind] += 1
                    if kind == "sdr":
                        if n[:2] in ("A_", "Z_"):
                            out["families"][n[2:4]] += 1
                        made = kwin_time(n)
                        try:
                            mt = os.stat(os.path.join(d, n)).st_mtime
                        except OSError:
                            continue
                        if made is not None:
                            out["lags"].append(max(0.0, (mt - made) / 60))
        self.seen = {d: s for d, s in self.seen.items() if d in keep}
        self.primed = True
        return out


def backfill(root: str, now: float, days: int = 3, kinds: collections.Counter | None = None) -> list[tuple]:
    """emwin rows (minute, files, inet, lag median, lag count) rebuilt from the dish's files on
    disk, for a store that has none yet: their write times and names say when each came and how
    late. Minutes from the last two are left to the live recorder. `kinds`, when given, gets
    (hour, WMO family) counts."""
    per_min: dict[int, list[float]] = collections.defaultdict(list)
    counts: collections.Counter = collections.Counter()
    try:
        dirs = sorted(d for d in os.listdir(root) if DATE_DIR.match(d))[-days:]
    except OSError:
        return []
    for d in dirs:
        try:
            with os.scandir(os.path.join(root, d)) as it:
                for e in it:
                    try:
                        mt = e.stat().st_mtime
                    except OSError:
                        continue
                    m = int(mt // 60 * 60)
                    if m >= now - 120 or m < now - KEEP_DAYS * 86400:
                        continue
                    counts[m] += 1
                    if kinds is not None and e.name[:2] in ("A_", "Z_"):
                        kinds[(m // 3600 * 3600, e.name[2:4])] += 1
                    made = kwin_time(e.name)
                    if made is not None:
                        per_min[m].append(max(0.0, (mt - made) / 60))
        except OSError:
            continue
    return [(m, counts[m], 0, statistics.median(per_min[m]) if per_min[m] else None, len(per_min[m]))
            for m in sorted(counts)]


# ----------------------------------------------------------------------------- the sun and the satellite
class SunPredictor:
    """When the sun passes near the satellite as seen from the dish.

    A small dish sees the sun's radio noise when it sits within several degrees of the
    satellite: a dip every day around local noon for a few weeks either side of the equinoxes,
    worst when the sun is dead centre (Oct 5 and Mar 7-8 for GOES-19 from Austin)."""

    def __init__(self, lat: float, lon: float, sat_lon: float, tz: str, mag_decl: float = 0.0):
        self.lat, self.lon, self.sat_lon, self.tz, self.mag_decl = lat, lon, sat_lon, ZoneInfo(tz), mag_decl
        self.az, self.el = self._satellite()
        self._cache: dict[dt.date, tuple[float, float]] = {}

    def _satellite(self) -> tuple[float, float]:
        R, r = 6378.137, 42164.0
        phi, dl = math.radians(self.lat), math.radians(self.sat_lon - self.lon)
        cosb = math.cos(phi) * math.cos(dl)
        el = math.degrees(math.atan((cosb - R / r) / math.sqrt(1 - cosb ** 2)))
        az = (180 - math.degrees(math.atan2(math.tan(dl), math.sin(phi)))) % 360
        return az, el

    def sun(self, t: float) -> tuple[float, float]:
        """Sun elevation and azimuth (degrees) at unix time t; low precision, ~0.1 degree."""
        n = (t - 946728000) / 86400                       # days since 2000-01-01 12:00 UTC
        L = (280.46 + 0.9856474 * n) % 360
        g = math.radians((357.528 + 0.9856003 * n) % 360)
        lam = math.radians(L + 1.915 * math.sin(g) + 0.02 * math.sin(2 * g))
        eps = math.radians(23.439 - 4e-7 * n)
        ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
        dec = math.asin(math.sin(eps) * math.sin(lam))
        ha = math.radians(((18.697374558 + 24.06570982441908 * n) % 24) * 15 + self.lon) - ra
        phi = math.radians(self.lat)
        alt = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(ha))
        az = math.atan2(math.sin(ha), math.cos(ha) * math.sin(phi) - math.tan(dec) * math.cos(phi))
        return math.degrees(alt), (math.degrees(az) + 180) % 360

    def separation(self, t: float) -> float:
        e2, a2 = (math.radians(v) for v in self.sun(t))
        e1, a1 = math.radians(self.el), math.radians(self.az)
        c = math.sin(e1) * math.sin(e2) + math.cos(e1) * math.cos(e2) * math.cos(a1 - a2)
        return math.degrees(math.acos(max(-1.0, min(1.0, c))))

    def closest(self, day: dt.date) -> tuple[float, float]:
        """(degrees, unix time) of the day's closest approach, searched 8 AM to 4 PM local."""
        if day in self._cache:
            return self._cache[day]
        start = dt.datetime(day.year, day.month, day.day, 8, tzinfo=self.tz).timestamp()
        best = min((self.separation(start + k * 600), start + k * 600) for k in range(49))
        lo = best[1] - 600
        best = min((self.separation(lo + k * 30), lo + k * 30) for k in range(41))
        self._cache[day] = best
        return best

    def predictions(self, now: float, horizon_days: int = 400, near: float = 5.0, centre: float = 3.0) -> dict:
        """Today's closest approach, and the next windows of days the sun comes within `near`
        degrees, counting only windows that reach `centre` (the tail of one that is ending is
        today's line, not a window to come)."""
        today = dt.datetime.fromtimestamp(now, self.tz).date()
        sep, at = self.closest(today)
        windows, cur = [], None
        for k in range(horizon_days):
            day = today + dt.timedelta(days=k)
            s, t = self.closest(day)
            if s < near:
                if cur is None:
                    cur = {"start": day.isoformat(), "best": s, "best_at": t, "end": day.isoformat()}
                cur["end"] = day.isoformat()
                if s < cur["best"]:
                    cur["best"], cur["best_at"] = s, t
            elif cur is not None:
                if cur["best"] < centre:
                    windows.append(cur)
                cur = None
                if len(windows) == 2:
                    break
        if cur is not None and cur["best"] < centre and len(windows) < 2:
            windows.append(cur)
        for w in windows:
            w["best"] = round(w["best"], 1)
            w["best_at"] = int(w["best_at"])
        return {"satellite": {"az": round(self.az, 1), "el": round(self.el, 1),
                              "compass": round((self.az - self.mag_decl) % 360)},
                "today": {"closest_deg": round(sep, 1), "at": int(at)}, "windows": windows}


# ----------------------------------------------------------------------------- the store
SCHEMA = """
CREATE TABLE IF NOT EXISTS signal (t INTEGER PRIMARY KEY, vit_med REAL, vit_lo REAL, vit_hi REAL,
    packets INTEGER, drops INTEGER, rs INTEGER, locked REAL, freq REAL, gain REAL, mode TEXT);
CREATE TABLE IF NOT EXISTS vc (t INTEGER, vc INTEGER, frames INTEGER, lost INTEGER, PRIMARY KEY (t, vc));
CREATE TABLE IF NOT EXISTS emwin (t INTEGER PRIMARY KEY, files INTEGER, inet INTEGER, lag_med REAL, lag_n INTEGER);
CREATE TABLE IF NOT EXISTS emwin_kind (t INTEGER, kind TEXT, n INTEGER, PRIMARY KEY (t, kind));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, t_end INTEGER, kind TEXT,
    level TEXT, title TEXT, detail TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS events_t ON events (t);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""

# This week's events, from the receiver and bot logs and NOAA's reply, so the first install
# opens with them instead of an empty list. Times are UTC.
SEED_EVENTS = [
    ("2026-10-15T09:00", "2026-10-15T17:00", "lock", "bad", "No lock", "The receiver decoded nothing for 8 hours."),
    ("2026-10-16T15:00", "2026-10-16T19:00", "emwin_late", "warn", "EMWIN up to 7 h 27 min late",
     "NOAA replayed a backlog after maintenance at the uplink site; 6,911 products came in one hour."),
    ("2026-10-16T15:48", None, "restart", "info", "goesrecv and goesproc restarted", ""),
    ("2026-10-17T18:00", None, "emwin_late", "bad", "EMWIN fell behind",
     "Products arriving 1 to 5 hours after NOAA made them."),
    ("2026-10-18T17:42", "2026-10-19T01:16", "nws_metar", "info", "Current conditions from NWS, switched on by hand", ""),
    ("2026-10-18T17:55", None, "note", "info", "NOAA confirmed the EMWIN delay",
     "Connection failures between NWS and the NESDIS uplink site since maintenance there on Friday."),
    ("2026-10-19T01:17", None, "nws_metar", "info", "Current conditions from NWS, switched on automatically",
     "EMWIN was 5 h 34 min late."),
]


def _iso(s):
    return None if s is None else int(dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc).timestamp())


class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.RLock()     # reentrant: event checks read inside the minute's write
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        if self.meta("created") is None:
            with self.tx():
                for t, t_end, kind, level, title, detail in SEED_EVENTS:
                    self.db.execute("INSERT INTO events (t, t_end, kind, level, title, detail, source) VALUES (?,?,?,?,?,?,?)",
                                    (_iso(t), _iso(t_end), kind, level, title, detail, "seed"))
                self.set_meta("created", str(int(time.time())))

    class _Tx:
        def __init__(self, store):
            self.s = store

        def __enter__(self):
            self.s.lock.acquire()
            self.s.db.execute("BEGIN")
            return self.s.db

        def __exit__(self, et, ev, tb):
            try:
                self.s.db.execute("ROLLBACK" if et else "COMMIT")
            finally:
                self.s.lock.release()

    def tx(self):
        return Store._Tx(self)

    def meta(self, k):
        with self.lock:
            r = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r[0] if r else None

    def set_meta(self, k, v):
        self.db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, v))

    def rows(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def prune(self, now: float) -> None:
        cut = int(now - KEEP_DAYS * 86400)
        with self.tx() as db:
            for table in ("signal", "vc", "emwin", "emwin_kind"):
                db.execute(f"DELETE FROM {table} WHERE t < ?", (cut,))
            # events: two weeks, but never a note still up
            db.execute("DELETE FROM events WHERE COALESCE(t_end, t) < ? AND NOT (kind = 'note' AND t_end IS NULL)",
                       (cut - 7 * 86400,))


# ----------------------------------------------------------------------------- one minute at a time
def summarize_signal(seconds: list, locked_now: bool) -> dict | None:
    """A minute of Stats.history rows ([t, vit_avg, packets, drops, rs]) as one signal row.
    Viterbi is the median of the seconds that decoded something, with the 10th and 90th
    percentiles as its spread; locked is the share of seconds that decoded a packet."""
    if not seconds:
        return None
    vits = [s[1] for s in seconds if s[1] is not None and s[2]]
    return {"vit_med": statistics.median(vits) if vits else None,
            "vit_lo": pct(vits, 10) if vits else None, "vit_hi": pct(vits, 90) if vits else None,
            "packets": sum(s[2] for s in seconds), "drops": sum(s[3] for s in seconds),
            "rs": sum(s[4] for s in seconds),
            "locked": (sum(1 for s in seconds if s[2]) / len(seconds)) if seconds else (1.0 if locked_now else 0.0)}


def fmt_span(seconds: float) -> str:
    m = int(seconds // 60)
    return f"{m} min" if m < 120 else f"{m // 60} h {m % 60:02d} min"


class Notes:
    """What the operator tells the public, written from the bot's admin portal (wx-admin):
    an event of kind "note" and source "operator", up from `t` until `t_end` (None: until
    ended by hand). The page shows those up now above every tab, and every note in the
    events list with the rest. Notes written into the seed history are not the operator's
    and are never shown as up."""

    LEVELS = ("info", "warn", "bad")
    TITLE_MAX, DETAIL_MAX, HOURS_MAX = 120, 600, 14 * 24

    def __init__(self, store: Store):
        self.store = store

    def _rows(self, where, args):
        rows = self.store.rows("SELECT id, t, t_end, level, title, detail FROM events WHERE kind='note' AND source='operator' "
                               f"AND {where} ORDER BY t DESC LIMIT 50", args)
        return [{"id": r[0], "t": r[1], "t_end": r[2], "level": r[3], "title": r[4], "detail": r[5]} for r in rows]

    def up(self, now: float) -> list[dict]:
        return self._rows("t <= ? AND (t_end IS NULL OR t_end > ?)", (int(now), int(now)))

    def recent(self, now: float) -> list[dict]:
        """Up now, and those that ended in the last two weeks: the editor's list."""
        return self._rows("COALESCE(t_end, ?) >= ?", (int(now), int(now - 14 * 86400)))

    def add(self, now: float, title: str, detail: str = "", level: str = "info", hours: float | None = None) -> dict:
        title, detail = " ".join(str(title or "").split()), str(detail or "").strip()
        if not title:
            raise ValueError("a note needs a headline")
        if len(title) > self.TITLE_MAX or len(detail) > self.DETAIL_MAX:
            raise ValueError(f"a headline is at most {self.TITLE_MAX} characters, the details {self.DETAIL_MAX}")
        if level not in self.LEVELS:
            raise ValueError("level is one of " + ", ".join(self.LEVELS))
        if hours is not None and not 0 < float(hours) <= self.HOURS_MAX:
            raise ValueError(f"a note is up for at most {self.HOURS_MAX} hours, or until it is ended")
        t_end = None if hours is None else int(now + float(hours) * 3600)
        with self.store.tx() as db:
            cur = db.execute("INSERT INTO events (t, t_end, kind, level, title, detail, source) VALUES (?,?,?,?,?,?,?)",
                             (int(now), t_end, "note", level, title, detail, "operator"))
        return {"id": cur.lastrowid, "t": int(now), "t_end": t_end, "level": level, "title": title, "detail": detail}

    def end(self, note_id: int, now: float) -> bool:
        """Take a note down now; it stays in the events list."""
        with self.store.tx() as db:
            cur = db.execute("UPDATE events SET t_end=? WHERE id=? AND kind='note' AND source='operator' "
                             "AND (t_end IS NULL OR t_end > ?)", (int(now), int(note_id), int(now)))
        return cur.rowcount > 0

    def delete(self, note_id: int) -> bool:
        """Gone from the page and the events list both: for a note posted by mistake."""
        with self.store.tx() as db:
            cur = db.execute("DELETE FROM events WHERE id=? AND kind='note' AND source='operator'", (int(note_id),))
        return cur.rowcount > 0


class Events:
    """Opens an event when a condition starts and closes it when it ends. A restart of the
    dashboard picks up an event still open in the store (seeded ones too: EMWIN was already
    late at install); one whose condition is gone by then is closed at the first look."""

    LATE_ON, LATE_OFF, LATE_HOLD = 30, 10, 3600     # minutes late, minutes late, seconds on time
    # A condition back within this many seconds continues its event: a restart of the bot
    # reports its backups off for a minute, which split one NWS spell in two on Oct 18.
    REJOIN_S = 600
    # The title a condition's event gets when it ends, by kind.
    CLOSED = {"pointing": "Pointing mode for {}", "lock": "No lock for {}",
              "inet_backup": "Internet backup for {}", "nws_metar": "Current conditions from NWS for {}",
              "fill": "Internet filled in for {}"}

    def __init__(self, store: Store):
        self.store = store
        self.prev: dict = {}
        self.ok_since: float | None = None

    def _open(self, kind):
        r = self.store.rows("SELECT id, t, title FROM events WHERE kind=? AND t_end IS NULL ORDER BY t DESC LIMIT 1", (kind,))
        return r[0] if r else None

    def _start(self, db, now, kind, level, title, detail=""):
        db.execute("INSERT INTO events (t, kind, level, title, detail, source) VALUES (?,?,?,?,?,?)",
                   (int(now), kind, level, title, detail, "live"))

    def _condition(self, db, now, kind, active, level, title, detail=""):
        row = self._open(kind)
        if active and row is None:
            back = self.store.rows("SELECT id FROM events WHERE kind=? AND t_end >= ? ORDER BY t_end DESC LIMIT 1",
                                   (kind, int(now - self.REJOIN_S)))
            if back:
                db.execute("UPDATE events SET t_end=NULL, title=? WHERE id=?", (title, back[0][0]))
            else:
                self._start(db, now, kind, level, title, detail)
        elif not active and row is not None:
            closed = self.CLOSED.get(kind)
            db.execute("UPDATE events SET t_end=?, title=COALESCE(?, title) WHERE id=?",
                       (int(now), closed.format(fmt_span(now - row[1])) if closed else None, row[0]))

    def mend(self, db) -> int:
        """Join events of one kind that a gap under REJOIN_S split (recorded before rejoining
        existed); returns how many were folded in. Only an event recorded live is folded into
        the one before it: two written by hand (the NWS feed on by hand, then automatic, on
        Oct 18) stay two."""
        folded = 0
        for kind, closed in self.CLOSED.items():
            rows = self.store.rows("SELECT id, t, t_end, title, source FROM events WHERE kind=? ORDER BY t", (kind,))
            keep = None
            for r in rows:
                if keep and keep[2] is not None and r[4] == "live" and r[1] - keep[2] <= self.REJOIN_S:
                    t_end = r[2]
                    title = r[3] if t_end is None else closed.format(fmt_span(t_end - keep[1]))
                    db.execute("UPDATE events SET t_end=?, title=? WHERE id=?", (t_end, title, keep[0]))
                    db.execute("DELETE FROM events WHERE id=?", (r[0],))
                    keep = (keep[0], keep[1], t_end, title)
                    folded += 1
                else:
                    keep = r
        return folded

    def _late(self, db, now, lag_30):
        """EMWIN running late: on at LATE_ON minutes, off after LATE_HOLD at LATE_OFF or less.
        The title carries the worst delay seen, kept in meta so a restart does not forget it."""
        row = self._open("emwin_late")
        if lag_30 >= self.LATE_ON:
            self.ok_since = None
            peak = max(lag_30, float(self.store.meta("late_peak") or 0))
            self.store.set_meta("late_peak", str(peak))
            title, level = f"EMWIN up to {fmt_span(peak * 60)} late", "bad" if peak >= 120 else "warn"
            if row is None:
                self._start(db, now, "emwin_late", level, title, "Products arriving late from NOAA.")
            else:
                db.execute("UPDATE events SET title=?, level=? WHERE id=?", (title, level, row[0]))
        elif row is not None and lag_30 <= self.LATE_OFF:
            self.ok_since = self.ok_since or now
            if now - self.ok_since >= self.LATE_HOLD:
                db.execute("UPDATE events SET t_end=? WHERE id=?", (int(now), row[0]))
                self.store.set_meta("late_peak", "0")
                self.ok_since = None
        else:
            self.ok_since = None

    def observe(self, db, now: float, *, locked: float | None, mode: str, up_s: int | None, watchdog: int,
                lag_30: float | None, fill: dict | None = None, backup_on: bool | None = None,
                nws: dict | None = None) -> None:
        """One minute's look at the station; writes inside the caller's transaction. `fill` is
        the bot's internet fill; `backup_on` and `nws` are the two backups it replaced (bots
        from before 2026-10-19)."""
        if mode == "point":
            self._condition(db, now, "pointing", True, "info", "Pointing mode", "The dish was being aimed; reception paused.")
        else:
            self._condition(db, now, "pointing", False, "info", "")
            if locked is not None:
                self._condition(db, now, "lock", locked == 0, "bad", "No lock", "The receiver is decoding nothing.")
        prev_up = self.prev.get("up_s")
        if up_s is not None and prev_up is not None and up_s < prev_up - 30:
            by_watchdog = watchdog > self.prev.get("watchdog", watchdog)
            self._start(db, now, "restart", "warn" if by_watchdog else "info",
                        "Watchdog restarted goesrecv" if by_watchdog else "goesrecv restarted",
                        "No packets for 10 minutes." if by_watchdog else "")
        if fill is not None:
            # The fill replaced both backups: whichever was still open ends here.
            backup_on, nws = False, {"on": False}
            self._condition(db, now, "fill", bool(fill.get("active")), "warn",
                            "Internet filling in for the feed", fill.get("reason") or "")
        if backup_on is not None:
            self._condition(db, now, "inet_backup", backup_on, "warn", "Dish silent: products over the internet",
                            "The bot's internet backup is on.")
        if nws is not None:
            self._condition(db, now, "nws_metar", bool(nws.get("on")), "info",
                            "Current conditions from NWS over the internet", nws.get("reason") or "")
        if lag_30 is not None:
            self._late(db, now, lag_30)
        self.prev.update(up_s=up_s, watchdog=watchdog)


class Recorder:
    """The minute loop: reads what dashboard.py collected, writes it, notes events."""

    def __init__(self, store: Store, vc: VcCounter, arrivals: Arrivals, sun: SunPredictor,
                 seconds, locked_now, demod, mode, status, bot_feed, emwin_root: str):
        self.store, self.vc, self.arrivals, self.sun = store, vc, arrivals, sun
        self.seconds, self.locked_now, self.demod, self.mode, self.status, self.bot_feed = (
            seconds, locked_now, demod, mode, status, bot_feed)
        self.events = Events(store)
        self.notes = Notes(store)
        self.emwin_root = emwin_root
        self.cache: dict = {}
        self.cache_lock = threading.Lock()

    def forget(self) -> None:
        """The pages' cached answers, after a note changed the events list."""
        with self.cache_lock:
            self.cache.clear()

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        if not self.store.rows("SELECT 1 FROM emwin LIMIT 1"):
            kinds: collections.Counter = collections.Counter()
            rows = backfill(self.emwin_root, time.time(), kinds=kinds)
            with self.store.tx() as db:
                db.executemany("INSERT OR IGNORE INTO emwin (t, files, inet, lag_med, lag_n) VALUES (?,?,?,?,?)", rows)
                db.executemany("INSERT OR IGNORE INTO emwin_kind (t, kind, n) VALUES (?,?,?)",
                               [(t, k, n) for (t, k), n in kinds.items()])
        with self.store.tx() as db:
            self.events.mend(db)
        self.arrivals.poll()          # learn what is on disk now; the next poll counts what is new
        self.vc.take()
        last_prune = 0.0
        while True:
            time.sleep(60 - time.time() % 60 + 1)
            try:
                self.minute(time.time())
                if time.time() - last_prune > 3600:
                    self.store.prune(time.time())
                    last_prune = time.time()
            except Exception as e:  # noqa: BLE001  (the dashboard must outlive a bad minute)
                print("history: minute failed:", repr(e), flush=True)

    def minute(self, now: float) -> None:
        t = int(now // 60 * 60) - 60                        # the minute that just ended
        secs = [s for s in self.seconds() if t <= s[0] < t + 60]
        sig = summarize_signal(secs, self.locked_now())
        vcs = self.vc.take()
        arr = self.arrivals.poll()
        demod = self.demod() or {}
        mode = self.mode()
        st = self.status() or {}
        feed = self.bot_feed() or {}
        # The bot's delay (median of its last 50 arrivals) when it has one, so the events say what
        # the page's cards say; the history's own 30-minute figure otherwise.
        bot_lag = feed.get("lag_min") if isinstance(feed, dict) else None
        lag_30 = bot_lag if bot_lag is not None else self._lag_30(t, arr)
        with self.store.tx() as db:
            if sig is not None and mode == "receive":
                db.execute("INSERT OR REPLACE INTO signal VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                           (t, sig["vit_med"], sig["vit_lo"], sig["vit_hi"], sig["packets"], sig["drops"], sig["rs"],
                            sig["locked"], demod.get("frequency"), demod.get("gain"), mode))
            db.executemany("INSERT OR REPLACE INTO vc VALUES (?,?,?,?)", [(t, vc, f, lost) for vc, (f, lost) in vcs.items()])
            db.execute("INSERT OR REPLACE INTO emwin VALUES (?,?,?,?,?)",
                       (t, arr["sdr"], arr["inet"], statistics.median(arr["lags"]) if arr["lags"] else None, len(arr["lags"])))
            db.executemany("INSERT INTO emwin_kind (t, kind, n) VALUES (?,?,?) ON CONFLICT (t, kind) DO UPDATE SET n = n + excluded.n",
                           [(t // 3600 * 3600, k, n) for k, n in arr["families"].items()])
            feed = feed if isinstance(feed, dict) else {}
            ib = feed.get("internet_backup")
            self.events.observe(db, now, locked=None if sig is None or mode != "receive" else sig["locked"], mode=mode,
                                up_s=st.get("goesrecv_up_s"), watchdog=(st.get("watchdog") or {}).get("restarts", 0),
                                lag_30=lag_30, fill=feed.get("fill"),
                                backup_on=None if ib is None else bool(ib.get("on")), nws=feed.get("nws_metar"))
        with self.cache_lock:
            self.cache.clear()

    def _lag_30(self, t, arr) -> float | None:
        """The median delay of what arrived over the last 30 minutes, weighted by arrivals."""
        rows = self.store.rows("SELECT lag_med, lag_n FROM emwin WHERE t > ? AND lag_med IS NOT NULL", (t - 1800,))
        pts = [(r[0], r[1]) for r in rows]
        if arr["lags"]:
            pts.append((statistics.median(arr["lags"]), len(arr["lags"])))
        n = sum(w for _, w in pts)
        if n < 20:
            return None
        acc = 0
        for v, w in sorted(pts):
            acc += w
            if acc >= n / 2:
                return v
        return None

    # -- what the page reads ------------------------------------------------------
    def _cached(self, key, build, ttl=30):
        now = time.time()
        with self.cache_lock:
            hit = self.cache.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        val = build()
        with self.cache_lock:
            self.cache[key] = (now, val)
        return val

    def events_list(self, now: float) -> list[dict]:
        rows = self.store.rows("SELECT t, t_end, kind, level, title, detail, source FROM events WHERE COALESCE(t_end, ?) >= ? "
                               "ORDER BY t DESC LIMIT 60", (int(now), int(now - KEEP_DAYS * 86400)))
        return [{"t": r[0], "t_end": r[1], "kind": r[2], "level": r[3], "title": r[4], "detail": r[5], "source": r[6]}
                for r in rows]

    def hrit(self, hours: int) -> dict:
        hours = max(1, min(KEEP_DAYS * 24, int(hours)))
        return self._cached(("hrit", hours), lambda: self._hrit(hours, time.time()))

    def _hrit(self, hours: int, now: float) -> dict:
        since = int(now - hours * 3600)
        bucket = max(60, hours * 3600 // 720 // 60 * 60)
        groups = collections.defaultdict(list)
        for r in self.store.rows("SELECT t, vit_med, vit_lo, vit_hi, packets, drops, locked FROM signal WHERE t >= ? ORDER BY t", (since,)):
            groups[r[0] // bucket * bucket].append(r)
        signal = []
        for k in sorted(groups):
            g = groups[k]
            meds = [r[1] for r in g if r[1] is not None]
            signal.append([k, statistics.median(meds) if meds else None,
                           min((r[2] for r in g if r[2] is not None), default=None),
                           max((r[3] for r in g if r[3] is not None), default=None),
                           sum(r[4] or 0 for r in g), sum(r[5] or 0 for r in g),
                           round(sum(r[6] or 0 for r in g) / len(g), 3)])
        info = self.vc.info()
        hour = self.store.rows("SELECT vc, SUM(frames), SUM(lost), COUNT(DISTINCT t) FROM vc WHERE t >= ? GROUP BY vc", (int(now - 3600),))
        minutes = max([r[3] for r in hour], default=0) or 1
        vcs = [{"vc": r[0], "name": vc_name(r[0]), "frames_per_min": round(r[1] / minutes, 1),
                "lost_pct": round(100 * r[2] / (r[1] + r[2]), 2) if r[1] + r[2] else None,
                "last_seen": (info.get(r[0]) or {}).get("last_seen"), "apids": (info.get(r[0]) or {}).get("apids", [])}
               for r in sorted(hour)]
        first = self.store.rows("SELECT MIN(t) FROM signal")[0][0]
        return {"now": now, "hours": hours, "bucket_s": bucket, "signal": signal, "recorded_since": first,
                "vc": vcs, "vc_minutes": minutes if hour else 0, "events": self.events_list(now),
                "sun": self.sun.predictions(now)}

    def emwin(self, hours: int) -> dict:
        hours = max(1, min(KEEP_DAYS * 24, int(hours)))
        return self._cached(("emwin", hours), lambda: self._emwin(hours, time.time()), ttl=60)

    def _emwin(self, hours: int, now: float) -> dict:
        since = int(now - hours * 3600) // 3600 * 3600
        groups = collections.defaultdict(list)
        for r in self.store.rows("SELECT t, files, inet, lag_med, lag_n FROM emwin WHERE t >= ? ORDER BY t", (since,)):
            groups[r[0] // 3600 * 3600].append(r)
        hourly = []
        for k in sorted(groups):
            g = groups[k]
            lags = [(r[3], r[4]) for r in g if r[3] is not None and r[4]]
            hourly.append([k, sum(r[1] for r in g), sum(r[2] for r in g), _weighted_median(lags)])
        last30 = self.store.rows("SELECT SUM(files), SUM(inet) FROM emwin WHERE t >= ?", (int(now - 3600),))[0]
        lag_now = self._lag_30(int(now // 60 * 60), {"lags": []})
        first = self.store.rows("SELECT MIN(t) FROM emwin")[0][0]
        return {"now": now, "hours": hours, "hourly": hourly, "recorded_since": first,
                "last_hour": {"files": last30[0] or 0, "inet": last30[1] or 0},
                "lag_now": None if lag_now is None else round(lag_now, 1),
                "kinds_24h": [[k, n] for k, n in self.store.rows(
                    "SELECT kind, SUM(n) FROM emwin_kind WHERE t >= ? GROUP BY kind ORDER BY SUM(n) DESC LIMIT 14",
                    (int(now - 86400) // 3600 * 3600,))],
                "events": [e for e in self.events_list(now)
                                                               if e["kind"] in ("emwin_late", "fill", "inet_backup", "nws_metar", "note", "lock")]}


def _weighted_median(pairs: list[tuple[float, int]]) -> float | None:
    n = sum(w for _, w in pairs)
    if not n:
        return None
    acc = 0
    for v, w in sorted(pairs):
        acc += w
        if acc >= n / 2:
            return round(v, 1)
    return None
