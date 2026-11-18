#!/home/digitaino/goes/venv/bin/python3
"""GOES-19 ground-station dashboard for mesh-wx.

Live goesrecv stats (nanomsg pub sockets 6001/6002/5002) pushed to the browser via
server-sent events every 500 ms, latest imagery + EMWIN files from goesproc, Pi health,
and a "pointing" mode that swaps the dongle over to an rtl_power SNR meter.
Runs as goes-dashboard.service on http://0.0.0.0:8080
"""
import collections
import hashlib
import ipaddress
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))   # dashboard.html and station_history.py live beside it
sys.path.insert(0, "/home/digitaino/goes")
sys.path.insert(0, HERE)
import pynng  # noqa: E402
import signal_monitor  # noqa: E402  (pointing-mode Monitor class)
import station_history  # noqa: E402  (7-day history, events, sun predictions)
import emwin_tab  # noqa: E402  (product browser index, warnings base map, radar and charts)
import imagery  # noqa: E402  (the HRIT imagery viewer's frames)

HOME = "/home/digitaino"
IMG_ROOT = f"{HOME}/goes-images"
THUMB_DIR = f"{HOME}/goes/thumbs"
THUMB_MAX, THUMB_KEEP = 2000, 1600  # thumbnail cache: once past MAX files, drop the oldest down to KEEP
THUMB_SIZES = (640, 1080)            # the image grid's tiles; the viewer's loop frames
SSE_MAX = 24                       # concurrent /events viewers; each costs a thread and two JSON dumps per second
SSE_CLIENTS, SSE_LOCK = 0, threading.Lock()
PORT = int(os.environ.get("PORT", "8080"))
# The mesh weather bot's admin portal (meshcore-weather.service). Only its
# read-only public bundle is proxied here; the portal itself stays LAN-only.
BOT_URL = os.environ.get("BOT_URL", "http://127.0.0.1:8081")
# Where the bot keeps the products it fetched over the internet while the dish was silent.
INET_DIR = os.environ.get("BOT_EMWIN_INTERNET_DIR", f"{HOME}/meshcore-weather/data/emwin_internet")
os.makedirs(THUMB_DIR, exist_ok=True)


def clean(o):
    """Replace NaN/inf (invalid in JSON) with null, recursively."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o


def sh(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception as e:  # noqa: BLE001
        return f"error: {e}"


DATE_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def recent_files(root, days=2, ext=None):
    """(path, mtime, size) of every file in the newest `days` date directories
    (YYYY-MM-DD; goesproc and the bot both file by UTC day) of each product under
    root. The product tree above the dates is a handful of directories, so only
    those day directories get listed and stat'ed; the recursive glob this replaces
    stat'ed every file ever received, every 5 s."""
    out = []
    for cur, dirs, _ in os.walk(root):
        dated = sorted(d for d in dirs if DATE_DIR.match(d))
        dirs[:] = [d for d in dirs if d not in dated]
        for d in dated[-days:]:
            try:
                with os.scandir(os.path.join(cur, d)) as it:
                    for e in it:
                        if e.is_file() and (ext is None or e.name.endswith(ext)):
                            st = e.stat()
                            out.append((e.path, st.st_mtime, st.st_size))
            except OSError:
                pass
    return out


def throttled():
    """The firmware's throttle flags as a hex string: "0x0" is clean; bit 0 under-voltage
    now, bit 2 throttled now, bits 16/18 the same has happened since boot. Some kernels
    expose it in sysfs; this Pi's does not, so vcgencmd is the working fallback."""
    try:
        return hex(int(open("/sys/devices/platform/soc/soc:firmware/get_throttled").read().strip(), 16))
    except (OSError, ValueError):
        pass
    out = sh(["vcgencmd", "get_throttled"])  # "throttled=0x50005"
    return out.split("=", 1)[1] if out.startswith("throttled=0x") else None


# ----------------------------------------------------------------------------- goesrecv stats
class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.demod = {}
        self.frames = collections.deque(maxlen=4000)      # (t, ok, vit, rs)
        self.history = collections.deque(maxlen=1800)     # per-second: [t, vit_avg, packets, drops, rs]
        self.current = {}
        self.totals = {"packets": 0, "drops": 0, "rs_errors": 0}
        self.lock_since = None
        self.last_ok = 0
        self.const = []
        self.const_wanted = 0
        self.decoder_msgs = 0
        self.last_msg = 0
        for fn in (self.run_demod, self.run_decoder, self.run_const, self.summarize):
            threading.Thread(target=fn, daemon=True).start()

    def _sub(self, port):
        s = pynng.Sub0(recv_timeout=2000)
        s.subscribe(b"")
        s.dial(f"tcp://127.0.0.1:{port}", block=False)
        return s

    def run_demod(self):
        s = self._sub(6001)
        while True:
            try:
                d = json.loads(s.recv())
                with self.lock:
                    self.demod = d
                    self.last_msg = time.time()
            except pynng.Timeout:
                pass
            except Exception:  # noqa: BLE001
                time.sleep(1)

    def run_decoder(self):
        s = self._sub(6002)
        while True:
            try:
                d = json.loads(s.recv())
                ok = 1 if d.get("ok") else 0
                rs = d.get("reed_solomon_errors", -1)
                with self.lock:
                    self.frames.append((time.time(), ok, d.get("viterbi_errors", 0), rs))
                    self.decoder_msgs += 1
                    self.last_msg = time.time()
                    if ok:
                        self.totals["packets"] += 1
                        if rs > 0:
                            self.totals["rs_errors"] += rs
                    else:
                        self.totals["drops"] += 1
            except pynng.Timeout:
                pass
            except Exception:  # noqa: BLE001
                time.sleep(1)

    def run_const(self):
        # symbol samples (complex<float>) after clock recovery; only drain while someone is watching
        s = None
        while True:
            if self.const_wanted < time.time() - 5:
                if s is not None:
                    s.close()
                    s = None
                time.sleep(0.5)
                continue
            if s is None:
                s = self._sub(5002)
            try:
                m = s.recv()  # complex<int8_t> pairs (I,Q), one per symbol
                n = min(len(m) // 2, 600)
                with self.lock:
                    self.const = list(struct.unpack(f"<{2*n}b", m[:2 * n]))
                time.sleep(0.4)  # ~2 constellation frames per second; pub/sub drops the rest
            except pynng.Timeout:
                with self.lock:
                    self.const = []
            except Exception:  # noqa: BLE001
                time.sleep(1)

    def summarize(self):
        while True:
            time.sleep(1)
            now = time.time()
            with self.lock:
                recent = [f for f in self.frames if f[0] > now - 1]
                ok = [f for f in recent if f[1]]
                vit_avg = sum(f[2] for f in recent) / len(recent) if recent else None
                packets, drops = len(ok), len(recent) - len(ok)
                rs = sum(f[3] for f in ok if f[3] > 0)
                if packets:
                    self.last_ok = now
                    if self.lock_since is None:
                        self.lock_since = now
                elif now - self.last_ok > 3:
                    self.lock_since = None
                self.history.append([round(now), None if vit_avg is None else round(vit_avg), packets, drops, rs])
                self.current = {
                    "vit_avg": None if vit_avg is None else round(vit_avg),
                    "packets": packets, "drops": drops, "rs_sum": rs,
                    "locked": bool(self.lock_since), "lock_since": self.lock_since,
                    "freq": self.demod.get("frequency"), "gain": self.demod.get("gain"),
                    "omega": self.demod.get("omega"),
                    "feed_alive": now - self.last_msg < 5,
                    "totals": dict(self.totals),
                }

    def snapshot(self, with_const):
        with self.lock:
            d = dict(self.current)
            if with_const:
                self.const_wanted = time.time()
                d["const"] = self.const
            return d

    def history_list(self):
        with self.lock:
            return list(self.history)


# ----------------------------------------------------------------------------- system / files status
class Status:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = {}
        self.files, self.files_at = {}, 0.0            # file counts + listings, refreshed at most every 20 s
        self.watchdog = {"restarts": 0, "last": None}  # goesrecv alive-but-dead restarts, see watch_goesrecv
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        while True:
            try:
                self.refresh()
            except Exception as e:  # noqa: BLE001
                with self.lock:
                    self.data = {"error": str(e)}
            time.sleep(5)

    def refresh(self):
        svc = sh(["systemctl", "is-active", "goesrecv", "goesproc", "goes-monitor"]).split("\n")
        services = dict(zip(["goesrecv", "goesproc", "goes-monitor"], svc))
        try:
            temp = int(open("/sys/class/thermal/thermal_zone0/temp").read()) / 1000
        except Exception:  # noqa: BLE001
            temp = None
        du = shutil.disk_usage(HOME)
        up = sh(["systemctl", "show", "goesrecv", "-p", "ActiveEnterTimestampMonotonic", "--value"])
        up_s = None if not up.isdigit() else int(time.clock_gettime(time.CLOCK_MONOTONIC) - int(up) / 1e6)
        self.watch_goesrecv(services.get("goesrecv"), up_s)
        thr = throttled()
        # The probes above are cheap and run every 5 s; the directory scans every 20 s
        # (they used to walk and stat all ~40k received files on every cycle).
        if time.time() - self.files_at >= 20:
            self.files, self.files_at = self.scan_files(), time.time()
        with self.lock:
            self.data = {"services": services, "temp": temp, "disk_free_gb": round(du.free / 1e9, 1),
                         "disk_used_pct": round(100 * (du.total - du.free) / du.total),
                         **self.files,
                         "host": sh(["hostname"]), "load": open("/proc/loadavg").read().split()[0],
                         "goesrecv_up_s": up_s, "throttled": thr, "watchdog": dict(self.watchdog),
                         "time": int(time.time())}

    def scan_files(self):
        """File counts plus the newest imagery and EMWIN products: the expensive part
        of the status (a directory walk and two days' worth of stats)."""
        today = time.strftime("%Y-%m-%d", time.gmtime())  # goesproc's day directories are UTC dates
        counts = {}
        for cat in ("emwin", "goes19", "goes18", "dcs", "nws", "text"):
            counts[cat] = sum(len(f) for _, _, f in os.walk(f"{IMG_ROOT}/{cat}"))
        counts["emwin_today"] = sum(len(f) for _, _, f in os.walk(f"{IMG_ROOT}/emwin/{today}"))
        imgs = recent_files(f"{IMG_ROOT}/goes19", ext=".jpg") + recent_files(f"{IMG_ROOT}/goes18", ext=".jpg")
        imgs.sort(key=lambda f: f[1], reverse=True)
        latest_imgs = [{"path": os.path.relpath(p, IMG_ROOT), "name": os.path.basename(p),
                        "mtime": int(m), "size": s} for p, m, s in imgs[:12]]
        em = [(p, m, s, "sat") for p, m, s in recent_files(f"{IMG_ROOT}/emwin")]
        # While the bot's internet backup is carrying the mesh, list its products
        # too, tagged "net", so this panel does not sit on the dish's last files.
        bot = globals().get("BOT")
        backup = ((bot.get().get("feed") or {}).get("internet_backup") or {}) if bot else {}
        inet_today = 0
        if backup.get("on"):
            em += [(p, m, s, "net") for p, m, s in recent_files(INET_DIR)]
            today_inet = f"{INET_DIR}/{today}"
            inet_today = len(os.listdir(today_inet)) if os.path.isdir(today_inet) else 0
        em.sort(key=lambda f: f[1], reverse=True)
        latest_emwin = [{"path": ("inet/" + os.path.relpath(p, INET_DIR)) if src == "net" else os.path.relpath(p, IMG_ROOT),
                         "name": os.path.basename(p), "src": src,
                         "mtime": int(m), "size": s} for p, m, s, src in em[:15]]
        counts["emwin_inet_today"] = inet_today
        counts["internet_backup_on"] = bool(backup.get("on"))
        return {"counts": counts, "latest_images": latest_imgs, "latest_emwin": latest_emwin}

    def watch_goesrecv(self, active, up_s):
        """goesrecv can sit 'active' with the dongle wedged: up for hours, not one packet
        decoded in 10 min. A restart re-opens the dongle (and re-asserts the bias tee);
        goesproc's nanomsg subscriber simply reconnects. Never while pointing (goesrecv
        is stopped on purpose then), never while it is already (re)starting, and at most
        once per 30 min so a real signal loss does not turn into a restart loop."""
        now = time.time()
        if active != "active" or up_s is None or up_s < 600:
            return
        if self.watchdog["last"] and now - self.watchdog["last"] < 1800:
            return
        hist = [h for h in STATS.history_list() if h[0] > now - 600]  # per second: [t, vit, packets, drops, rs]
        if len(hist) < 540 or any(h[2] for h in hist):               # need the full 10 min of history, all at 0 packets
            return
        with MODE.lock:  # serialised with the pointing-mode switches
            if MODE.mode != "receive":
                return
            self.watchdog = {"restarts": self.watchdog["restarts"] + 1, "last": int(now)}
            print(time.strftime("%Y-%m-%d %H:%M:%S"), f"watchdog: goesrecv active for {up_s} s but no packets in 10 min,"
                  f" restarting it ({self.watchdog['restarts']} so far)", file=sys.stderr, flush=True)
            sh(["sudo", "-n", "systemctl", "restart", "goesrecv"])

    def get(self):
        with self.lock:
            return dict(self.data)


# ----------------------------------------------------------------------------- mode switching
class Mode:
    def __init__(self):
        self.mode = "receive"
        self.monitor = None
        self.lock = threading.Lock()
        self.msg = ""

    def point(self, gain=40.0):
        with self.lock:
            if self.mode == "point" and self.monitor:
                return
            sh(["sudo", "-n", "systemctl", "stop", "goesproc", "goesrecv"])
            time.sleep(1.5)
            self.monitor = signal_monitor.Monitor(gain=gain, bias=True)
            self.monitor.start()
            self.mode = "point"
            self.msg = "goesrecv stopped; rtl_power meter running (bias tee on)"

    def receive(self):
        with self.lock:
            if self.monitor:
                self.monitor.terminate()
                self.monitor = None
            sh(["pkill", "-x", "rtl_power"])  # exact process name only
            time.sleep(1)
            sh(["sudo", "-n", "systemctl", "start", "goesrecv", "goesproc"])
            self.mode = "receive"
            self.msg = "goesrecv + goesproc running"

    def set_gain(self, gain):
        with self.lock:
            if self.monitor:
                self.monitor.restart(gain=gain)

    def meter(self):
        with self.lock:
            return self.monitor.snapshot() if self.monitor else None


STATS = Stats()
MODE = Mode()      # before STATUS: its refresh thread consults MODE (watchdog) from the first cycle
STATUS = Status()


# ----------------------------------------------------------------------------- mesh weather bot
class Bot:
    """Read-only view of the mesh weather bot for the public page: identity,
    how to reach it, request/reply counters and the redacted traffic feed.
    Fetched from the bot's portal on the Pi at most every 3 s no matter how
    many browsers are watching; when the bot is down the page says so."""

    def __init__(self):
        self.lock = threading.Lock()
        self.fetch_lock = threading.Lock()  # single-flight: concurrent cache misses make one request, the rest reuse it
        self.data = {"online": False, "error": "not fetched yet"}
        self.fetched = 0.0

    def fresh(self):
        with self.lock:
            return dict(self.data) if time.time() - self.fetched < 3 else None

    def get(self):
        d = self.fresh()
        if d is not None:
            return d
        with self.fetch_lock:
            d = self.fresh()  # another request fetched while we waited for the lock
            if d is not None:
                return d
            try:
                with urllib.request.urlopen(f"{BOT_URL}/api/public/bot?n=60", timeout=3) as r:
                    d = json.loads(r.read())
                d["online"] = True
                d["error"] = None
            except Exception as e:  # noqa: BLE001  (bot stopped, portal restarting)
                d = {"online": False, "error": f"bot not reachable ({e.__class__.__name__})"}
            with self.lock:
                self.data = d
                self.fetched = time.time()
            return dict(d)


BOT = Bot()


# ----------------------------------------------------------------------------- 7-day history
# Where the station is, for the sun predictions and the aim shown on the page; the defaults are
# this dish in Austin. MAG_DECL turns the true azimuth into a compass reading.
STATION_LAT = float(os.environ.get("STATION_LAT", "30.27"))
STATION_LON = float(os.environ.get("STATION_LON", "-97.74"))
SAT_LON = float(os.environ.get("SAT_LON", "-75.2"))
STATION_TZ = os.environ.get("STATION_TZ", "America/Chicago")
MAG_DECL = float(os.environ.get("MAG_DECL", "2.6"))


def station_chain():
    """The receiver chain for the page, read from goesrecv's own config (frequency, rate, gain,
    bias tee) plus the hardware names, which the config only has in a comment."""
    out = {"satellite": os.environ.get("STATION_SATELLITE", "GOES-19 (GOES-East)"), "sat_lon": SAT_LON,
           "lna": os.environ.get("STATION_LNA", "SAWbird+ GOES LNA"), "radio": os.environ.get("STATION_RADIO", "RTL-SDR (R820T)")}
    try:
        import tomllib
        with open(f"{HOME}/goes/goesrecv.conf", "rb") as f:
            rtl = tomllib.load(f).get("rtlsdr", {})
        out.update(freq_mhz=rtl.get("frequency", 0) / 1e6, sample_msps=rtl.get("sample_rate", 0) / 1e6,
                   gain_db=rtl.get("gain"), bias_tee=bool(rtl.get("bias_tee")))
    except (OSError, ValueError, ImportError):
        pass
    return out


HIST_VC = station_history.VcCounter()


def run_vcdus():
    """Every frame goesrecv decodes (its packet publisher), counted per virtual channel. While
    the dish is being aimed goesrecv is stopped and this simply waits for it to come back."""
    s = pynng.Sub0(recv_timeout=2000)
    s.subscribe(b"")
    s.dial("tcp://127.0.0.1:5004", block=False)
    while True:
        try:
            HIST_VC.feed(s.recv())
        except pynng.Timeout:
            pass
        except Exception:  # noqa: BLE001
            time.sleep(1)


HISTORY = station_history.Recorder(
    station_history.Store(os.environ.get("HISTORY_DB", f"{HOME}/goes/history.db")),
    HIST_VC,
    station_history.Arrivals({"sdr": f"{IMG_ROOT}/emwin", "inet": INET_DIR}),
    station_history.SunPredictor(STATION_LAT, STATION_LON, SAT_LON, STATION_TZ, MAG_DECL),
    seconds=STATS.history_list, locked_now=lambda: STATS.current.get("locked"), demod=lambda: dict(STATS.demod),
    mode=lambda: MODE.mode, status=STATUS.get, bot_feed=lambda: (BOT.get() or {}).get("feed"),
    emwin_root=f"{IMG_ROOT}/emwin")
CHAIN = station_chain()
threading.Thread(target=run_vcdus, daemon=True).start()
HISTORY.start()


# ----------------------------------------------------------------------------- EMWIN tab
# Office names for the product browser (pyIEM's NWS office table plus the national centres).
try:
    with open(os.path.join(HERE, "offices.json")) as f:
        OFFICES = json.load(f)
except (OSError, ValueError):
    OFFICES = {}
PRODUCTS = emwin_tab.ProductIndex({"sdr": (f"{IMG_ROOT}/emwin", "emwin"), "inet": (INET_DIR, "inet")}, offices=OFFICES)
PRODUCTS.start()
NE_DIR = os.environ.get("NE_DIR", f"{HOME}/goes/goestools/share/goestools/ne")


class Cached:
    """A JSON body fetched or built at most every `ttl` s however many viewers ask, with an
    ETag so a browser that has it gets a 304. Single-flight like Bot. Until `ready()` says
    the data behind it is there (the product index's first scan), nothing is kept."""

    def __init__(self, make, ttl, ready=None):
        self.make, self.ttl, self.ready = make, ttl, ready
        self.lock = threading.Lock()
        self.body, self.etag, self.at = None, None, 0.0

    def get(self):
        with self.lock:
            if self.body is None or time.time() - self.at >= self.ttl:
                try:
                    body = json.dumps(clean(self.make()), separators=(",", ":")).encode()
                except Exception as e:  # noqa: BLE001  (bot restarting, outlines missing)
                    if self.body is not None:     # keep serving the last good one, and retry after ttl
                        self.at = time.time()
                        return self.body, self.etag
                    body = json.dumps({"error": f"{e.__class__.__name__}: {e}"[:200]}).encode()
                etag = '"' + hashlib.md5(body).hexdigest()[:16] + '"'
                if self.ready is not None and not self.ready():
                    return body, etag
                self.body, self.etag, self.at = body, etag, time.time()
            return self.body, self.etag


def fetch_warnings():
    # The bot's first build after a restart parses every warning product and loads the
    # outlines: up to a minute on the Pi. Later ones come out of its own one-minute cache.
    with urllib.request.urlopen(f"{BOT_URL}/api/public/warnings", timeout=90) as r:
        d = json.loads(r.read())
    for w in d.get("warnings", []):
        w["office_name"] = OFFICES.get(w.get("office"), "")
    return d


WARNINGS = Cached(fetch_warnings, 60)
BASEMAP = Cached(lambda: emwin_tab.basemap(NE_DIR), 365 * 86400)
RADAR = Cached(lambda: emwin_tab.radar_and_charts(PRODUCTS, f"{IMG_ROOT}/nws"), 30, ready=lambda: PRODUCTS.scanned_at > 0)
IMAGERY_LIST = {"t": 0.0, "d": None}


def imagery_listing():
    """The last day of imagery, listed at most every 30 s (the viewer's API and the frame warmer share it)."""
    if IMAGERY_LIST["d"] is None or time.time() - IMAGERY_LIST["t"] >= 30:
        IMAGERY_LIST.update(d=imagery.listing(IMG_ROOT, 24), t=time.time())
    return IMAGERY_LIST["d"]


IMAGERY = Cached(imagery_listing, 30)


def warm_loop_frames():
    """Make the viewer's 1080 px frames for the last six hours as the pictures arrive, so a loop
    plays at once: a few seconds of work an hour, against ~5 s for a cold 12-frame full-disk loop."""
    while True:
        try:
            for rel in imagery.recent(imagery_listing(), 6):
                thumb_for(rel, 1080)
        except Exception as e:  # noqa: BLE001
            print("loop frames:", e, file=sys.stderr, flush=True)
        time.sleep(60)


def prune_thumbs():
    """Keep the thumbnail cache bounded: past THUMB_MAX files, drop the oldest down to
    THUMB_KEEP. Only called right after a new thumbnail was written, so normally it is
    one listing of a few hundred names."""
    try:
        with os.scandir(THUMB_DIR) as it:
            entries = [e for e in it if e.is_file()]
        if len(entries) <= THUMB_MAX:
            return
        entries.sort(key=lambda e: e.stat().st_mtime)
        for e in entries[:len(entries) - THUMB_KEEP]:
            os.remove(e.path)
    except OSError:  # a parallel request pruning the same files; the next write retries
        pass


def thumb_for(rel, size=640):
    src = os.path.join(IMG_ROOT, rel)
    if not os.path.isfile(src):
        return None
    key = hashlib.md5(f"{rel}:{os.path.getmtime(src)}:{size}".encode()).hexdigest()
    out = f"{THUMB_DIR}/{key}.jpg"
    if not os.path.exists(out):
        tmp = f"{out}.{threading.get_ident()}.tmp"  # written aside then renamed: a parallel request never serves a half file
        try:
            from PIL import Image
            with Image.open(src) as im:
                im.draft("RGB", (size, size))  # libjpeg decodes a 5424 px full disk at 1/8 or 1/4 scale, not full size
                im.thumbnail((size, size))
                im.convert("RGB").save(tmp, "JPEG", quality=80)
            os.replace(tmp, out)
        except Exception:  # noqa: BLE001
            try:
                os.remove(tmp)
            except OSError:
                pass
            return src
        prune_thumbs()
    return out


threading.Thread(target=warm_loop_frames, daemon=True).start()

HTML_PATH = os.path.join(HERE, "dashboard.html")
HTML = open(HTML_PATH, "rb").read() if os.path.exists(HTML_PATH) else b"dashboard.html missing"


def is_lan_address(ip: str) -> bool:
    """Loopback or a private range (RFC 1918, link-local, IPv6 ULA), IPv4-mapped included.
    A string prefix test here once let public 172.2.x.x and 172.200+.x.x in as LAN."""
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_loopback or addr.is_private


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30  # socket timeout: idle keep-alive and half-open connections are reaped instead of parking a thread

    def log_message(self, *a):
        pass

    def is_public(self):
        """True for anything arriving through the Cloudflare tunnel (or from outside the LAN):
        such viewers get a read-only dashboard and every control endpoint is refused."""
        if "Cf-Ray" in self.headers or "Cf-Connecting-Ip" in self.headers or "CF-Connecting-IP" in self.headers:
            return True
        return not is_lan_address(self.client_address[0])

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in {"Cache-Control": "no-store", **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype, cache="max-age=3600"):
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            return self._send(404, b"not found", "text/plain")
        self._send(200, body, ctype, {"Cache-Control": cache})

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        p = unquote(u.path)
        if p == "/":
            return self._send(200, HTML, "text/html; charset=utf-8")
        if p == "/api/state":
            return self._send(200, json.dumps(clean(self.state(True))).encode(), "application/json")
        if p == "/api/history":
            return self._send(200, json.dumps(STATS.history_list()).encode(), "application/json")
        if p == "/api/bot":
            return self._send(200, json.dumps(clean(BOT.get())).encode(), "application/json")
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        if p == "/api/notes":
            # The operator's notes up now; with all=1 also those ended in the last two weeks.
            now = time.time()
            d = {"now": now, "up": HISTORY.notes.up(now)}
            if qs.get("all"):
                d["recent"] = HISTORY.notes.recent(now)
            return self._send(200, json.dumps(d).encode(), "application/json")
        if p in ("/api/hrit", "/api/emwin"):
            try:
                hours = int(qs.get("hours", "168"))
            except ValueError:
                hours = 168
            d = HISTORY.hrit(hours) if p == "/api/hrit" else HISTORY.emwin(hours)
            if p == "/api/hrit":
                d = dict(d, station=CHAIN)
            return self._send(200, json.dumps(clean(d)).encode(), "application/json")
        if p == "/api/products":
            try:
                limit = max(1, min(200, int(qs.get("limit", "100"))))
            except ValueError:
                limit = 100
            d = PRODUCTS.search(qs.get("q", "")[:100], qs.get("kind", ""), qs.get("office", "")[:4], limit,
                                text=qs.get("text", "1") != "0")
            return self._send(200, json.dumps(d).encode(), "application/json")
        if p == "/api/product":
            ent = PRODUCTS.get(pid=qs.get("id", ""), name=qs.get("name", ""))
            if ent is None:
                return self._send(404, b'{"error":"no such product in the last two days"}', "application/json")
            d = {"product": PRODUCTS.describe(ent)}
            if d["product"]["ext"] == "TXT":
                try:
                    d["text"] = PRODUCTS.read(ent)
                except OSError:
                    return self._send(404, b'{"error":"the file is gone"}', "application/json")
            return self._send(200, json.dumps(d).encode(), "application/json")
        if p in ("/api/warnings", "/api/basemap", "/api/radar", "/api/imagery"):
            body, etag = {"/api/warnings": WARNINGS, "/api/basemap": BASEMAP, "/api/radar": RADAR,
                          "/api/imagery": IMAGERY}[p].get()
            cache = "max-age=86400" if p == "/api/basemap" else "no-cache"
            if self.headers.get("If-None-Match") == etag:
                return self._send(304, b"", "application/json", {"ETag": etag, "Cache-Control": cache})
            return self._send(200, body, "application/json", {"ETag": etag, "Cache-Control": cache})
        if p == "/events":
            return self.sse()
        if p.startswith("/img/") or p.startswith("/thumb/"):
            rel = os.path.normpath(p.split("/", 2)[2])
            if rel.startswith("..") or os.path.isabs(rel):
                return self._send(403, b"no", "text/plain")
            if rel.startswith("inet/"):
                full = os.path.join(INET_DIR, rel[5:])  # the bot's internet-backup products
            else:
                full = os.path.join(IMG_ROOT, rel)
            if p.startswith("/thumb/"):
                size = int(qs.get("s", "640")) if qs.get("s", "640").isdigit() else 640
                full = thumb_for(rel, size if size in THUMB_SIZES else 640) or full
            ext = full.rsplit(".", 1)[-1].lower()
            ctype = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
                     "txt": "text/plain; charset=utf-8"}.get(ext, "application/octet-stream")
            return self._file(full, ctype)
        self._send(404, b"not found", "text/plain")

    def do_POST(self):  # noqa: N802
        if self.is_public():
            return self._send(403, b'{"error":"read-only"}', "application/json")
        p = urlparse(self.path).path
        if p == "/mode/point":
            threading.Thread(target=MODE.point, daemon=True).start()
        elif p == "/mode/receive":
            threading.Thread(target=MODE.receive, daemon=True).start()
        elif p.startswith("/meter/gain/"):
            try:
                MODE.set_gain(float(p.rsplit("/", 1)[1]))
            except ValueError:
                pass
        elif p == "/meter/resetpeak":
            m = MODE.monitor
            if m:
                with m.lock:
                    m.peak = None
                    m.history.clear()
        elif p == "/notes":
            # A note for the public, from the bot's admin portal on localhost:
            # {"title", "detail", "level": info|warn|bad, "hours": None for until ended}.
            n = int(self.headers.get("Content-Length") or 0)
            if n > 65536:
                return self._send(413, b'{"error":"too long"}', "application/json", {"Connection": "close"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
                note = HISTORY.notes.add(time.time(), body.get("title"), body.get("detail"),
                                         body.get("level") or "info", body.get("hours"))
            except (ValueError, TypeError, AttributeError) as e:
                return self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")
            HISTORY.forget()
            return self._send(200, json.dumps({"ok": True, "note": note}).encode(), "application/json")
        elif m := re.fullmatch(r"/notes/(\d+)/(end|delete)", p):
            done = HISTORY.notes.end(int(m[1]), time.time()) if m[2] == "end" else HISTORY.notes.delete(int(m[1]))
            if not done:
                return self._send(404, b'{"error":"no such note up"}', "application/json")
            HISTORY.forget()
        else:
            return self._send(404, b"not found", "text/plain")
        self._send(200, b'{"ok":true}', "application/json")

    def state(self, full):
        d = {"mode": MODE.mode, "mode_msg": MODE.msg, "t": time.time(), "control": not self.is_public()}
        if MODE.mode == "receive":
            d["stats"] = STATS.snapshot(with_const=True)
        else:
            d["meter"] = MODE.meter()
        if full:
            d["status"] = STATUS.get()
            d["history"] = STATS.history_list()[-900:]
        return d

    def sse(self):
        global SSE_CLIENTS
        with SSE_LOCK:
            if SSE_CLIENTS >= SSE_MAX:
                return self._send(503, b"too many live viewers right now, try again in a minute\n", "text/plain",
                                  {"Retry-After": "60"})
            SSE_CLIENTS += 1
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            n = 0
            while True:
                d = self.state(full=(n % 10 == 0))
                self.wfile.write(f"data: {json.dumps(clean(d))}\n\n".encode())
                self.wfile.flush()
                n += 1
                time.sleep(0.5)
        except OSError:  # reset, broken pipe or the 30 s socket timeout: the viewer is gone
            return
        finally:
            self.close_connection = True
            with SSE_LOCK:
                SSE_CLIENTS -= 1


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64  # listen backlog; the default of 5 drops bursts of viewers reconnecting through the tunnel

    def handle_error(self, request, client_address):
        """Peers going away mid-request (resets, broken pipes, the idle timeout) are routine
        on a public site and used to fill the journal with tracebacks; anything else still
        gets the standard traceback."""
        if isinstance(sys.exception(), (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    # default state is receiving: if a previous pointing session left goesrecv stopped, bring it back
    if sh(["systemctl", "is-active", "goesrecv"]) != "active":
        sh(["sudo", "-n", "systemctl", "start", "goesrecv", "goesproc"])
    srv = Server(("0.0.0.0", PORT), Handler)
    print(f"GOES dashboard on http://0.0.0.0:{PORT}", flush=True)
    srv.serve_forever()
