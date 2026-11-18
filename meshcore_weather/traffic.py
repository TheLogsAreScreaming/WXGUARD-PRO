"""What the text bot sees and says.

Every request that reaches the bot on the request channel or by DM, every
reply it sends, and every request it decides not to answer (and why) is
kept here: a ring of events for the live consoles (admin portal and the
public dashboard), rolling request/reply counters, and a small set of
lifetime counters that survive restarts.

The public view redacts: channel traffic is public by nature (anyone on
#meshwx sees it), so it is shown as-is; DMs are private, so a DM shows
only the parsed command and the reply length, never the sender or the
text; admin and console traffic is not shown at all.
"""

from __future__ import annotations

import asyncio
import json
import logging
import statistics
import time
from collections import deque
from pathlib import Path
from threading import Lock

logger = logging.getLogger(__name__)

# kind -> (direction, shown on the public page)
KINDS = {
    "channel_in": ("in", True),      # text on the request channel
    "dm_in": ("in", True),           # a DM (public view: command only)
    "dm_copy": ("in", False),        # a sender's app sent an earlier DM request again (never public)
    "data_request": ("in", True),    # an app's `>` request
    "peer": ("in", True),            # another WX-* bot's message, ignored
    "advert": ("in", True),          # a node adverted (we learned/refreshed a contact)
    "reply_dm": ("out", True),       # our DM reply
    "reply_channel": ("out", True),  # our reply on the channel (flood)
    "reply_data": ("out", True),     # our answer to an app request: v5 datagrams on the channel (flood)
    "advert_out": ("out", True),     # our own advert
    "dropped": ("out", True),        # a request we did not answer, with reason
    "dm_failed": ("out", True),      # DM send failed
    "link_test": ("out", False),     # portal link test datagram (never public)
    "admin": ("in", False),          # admin DM command (never public)
    "console": ("in", False),        # portal console (never public)
}

# An app's datagram request is a request like a chat one: before 2026-10-18 it
# was left out while its answer (reply_data) counted as a reply, so a day of
# app use read "1 request, 40 replies", the last request "21 h ago".
REQUEST_KINDS = ("channel_in", "dm_in", "data_request")
REPLY_KINDS = ("reply_dm", "reply_channel", "reply_data")

_FLUSH_EVERY_S = 60
# Saved beside the counters so the rolling windows, the reply latency and the
# live feed outlive a restart: a week of tally rows and the newest events.
_KEEP_TALLY_S = 7 * 86400
_KEEP_EVENTS = 300


def _empty_counters() -> dict:
    return {"requests": 0, "replies": 0, "dropped": 0, "chars_sent": 0,
            "by_command": {}, "by_transport": {"channel": 0, "dm": 0}}


class TrafficLog:
    def __init__(self, maxlen: int = 1000, path: Path | None = None):
        self._events: deque[dict] = deque(maxlen=maxlen)
        # Compact tally for the rolling windows: (ts, kind, command, sender, chars)
        self._tally: deque[tuple] = deque(maxlen=20000)
        self._lock = Lock()
        self._subs: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._seq = 0
        self._started = time.time()
        self._path = path
        self._last_flush = 0.0
        self._dirty = False
        self._recent_dirty = False
        self.lifetime = _empty_counters()
        self.lifetime["since"] = self._started
        self._load()
        self._load_recent()

    # -- persistence ---------------------------------------------------------------

    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            d = json.loads(self._path.read_text())
            base = _empty_counters()
            for k in base:
                if k in d:
                    base[k] = d[k]
            base["since"] = float(d.get("since") or self._started)
            self.lifetime = base
        except Exception as e:      # a corrupt file is not worth a crash
            logger.warning("Ignoring traffic stats file %s: %s", self._path, e)

    def _recent_path(self) -> Path | None:
        return self._path.with_name("traffic_recent.json") if self._path else None

    def _load_recent(self) -> None:
        path = self._recent_path()
        if not path or not path.exists():
            return
        try:
            d = json.loads(path.read_text())
            cut = time.time() - _KEEP_TALLY_S
            tally = [tuple(r) for r in d.get("tally") or []
                     if isinstance(r, list) and len(r) == 5 and isinstance(r[0], (int, float))
                     and r[0] >= cut and r[1] in KINDS]
            events = []
            for ev in (d.get("events") or [])[-_KEEP_EVENTS:]:
                if (isinstance(ev, dict) and ev.get("kind") in KINDS and isinstance(ev.get("id"), int)
                        and isinstance(ev.get("t"), (int, float))):
                    ev["dir"], ev["_public"] = KINDS[ev["kind"]]
                    events.append(ev)
            # Ids only go up: a feed holding id N takes a lower id for an update of an old line.
            seq = max([int(d.get("seq") or 0)] + [ev["id"] for ev in events])
        except Exception as e:      # corrupt: the windows start empty, the counters stand
            logger.warning("Ignoring traffic recent file %s: %s", path, e)
            return
        self._tally.extend(tally)
        self._events.extend(events)
        self._seq = seq

    @staticmethod
    def _at_rest(ev: dict) -> dict:
        """An event as written to disk: the admin view without the text of
        anything sent or received by DM, which stays in memory only."""
        out = TrafficLog.to_admin(ev)
        if ev.get("transport") == "dm" or (ev["kind"] == "dropped" and ev.get("transport") != "channel"):
            out["text"] = None
        return out

    def flush(self, force: bool = False) -> None:
        if not self._path or not (self._dirty or self._recent_dirty):
            return
        now = time.time()
        if not force and now - self._last_flush < _FLUSH_EVERY_S:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._lock:
                files = [(self._path, json.dumps(self.lifetime))]
                if self._recent_dirty:
                    cut = now - _KEEP_TALLY_S
                    files.append((self._recent_path(), json.dumps({
                        "seq": self._seq,
                        "tally": [list(r) for r in self._tally if r[0] >= cut],
                        "events": [self._at_rest(ev) for ev in list(self._events)[-_KEEP_EVENTS:]],
                    }, default=str)))
                self._dirty = self._recent_dirty = False
            for path, data in files:
                tmp = path.with_suffix(".tmp")
                tmp.write_text(data)
                tmp.replace(path)
            self._last_flush = now
        except Exception as e:
            self._dirty = self._recent_dirty = True
            logger.warning("Could not write traffic stats: %s", e)

    # -- recording -----------------------------------------------------------------

    def record(self, kind: str, *, sender: str | None = None, key: str | None = None,
               text: str | None = None, command: str | None = None, location: str | None = None,
               transport: str | None = None, hops: int | None = None, chars: int | None = None,
               reason: str | None = None, ok: bool | None = None, req: dict | None = None) -> dict:
        """Append one event and push it to live subscribers. Returns the
        event so a later reply/drop can refer to it (and be timed from it)."""
        if kind not in KINDS:
            raise ValueError(f"unknown traffic kind {kind!r}")
        direction, public = KINDS[kind]
        if transport is None:
            transport = {"channel_in": "channel", "reply_channel": "channel", "peer": "channel",
                         "reply_data": "channel_data",
                         "dm_in": "dm", "dm_copy": "dm", "reply_dm": "dm", "dm_failed": "dm",
                         "admin": "dm"}.get(kind)
        now = time.time()
        ms = None
        if req is not None and "_t0" in req:
            ms = int((time.monotonic() - req["_t0"]) * 1000)
        if command is None and req is not None:
            command, location = req.get("command"), req.get("location")
        if sender is None and req is not None:
            sender = req.get("sender")
        if key is None and req is not None:
            key = req.get("key")
        ev = {"id": 0, "t": now, "kind": kind, "dir": direction, "transport": transport,
              "sender": sender, "key": (key or None) and str(key)[:12], "text": text,
              "command": command, "location": location, "hops": hops, "chars": chars,
              "ms": ms, "reason": reason, "ok": ok, "req_id": req["id"] if req else None,
              "delivery": None, "_t0": time.monotonic(), "_public": public}
        with self._lock:
            self._seq += 1
            ev["id"] = self._seq
            self._events.append(ev)
            self._tally.append((now, kind, command, sender if transport == "channel" else key, chars or 0))
            self._count(kind, command, transport, chars)
            self._recent_dirty = True
            subs, loop = list(self._subs), self._loop
        if subs and loop is not None:
            for q in subs:
                try:
                    loop.call_soon_threadsafe(self._offer, q, ev)
                except RuntimeError:
                    pass
        self.flush()
        return ev

    def _count(self, kind: str, command: str | None, transport: str | None, chars: int | None) -> None:
        lt = self.lifetime
        if kind in REQUEST_KINDS:
            lt["requests"] += 1
            if transport in lt["by_transport"]:
                lt["by_transport"][transport] += 1
            self._dirty = True
        elif kind in REPLY_KINDS:
            lt["replies"] += 1
            lt["chars_sent"] += chars or 0
            if command:
                lt["by_command"][command] = lt["by_command"].get(command, 0) + 1
            self._dirty = True
        elif kind == "dropped":
            lt["dropped"] += 1
            self._dirty = True

    def update(self, ev: dict | None, push: bool = False, **fields) -> None:
        """Fill in what was learned after the event was recorded (the parsed
        command of a request, a DM that turned out to be an admin command,
        a reply whose DM failed, the delivery outcome). With push=True the
        event is sent to live subscribers again (same id) so a feed can
        redraw its line."""
        if ev is None:
            return
        with self._lock:
            new_kind = fields.get("kind")
            if new_kind and new_kind != ev["kind"]:
                if new_kind not in KINDS:
                    raise ValueError(f"unknown traffic kind {new_kind!r}")
                old_kind = ev["kind"]
                if old_kind in REQUEST_KINDS and new_kind not in REQUEST_KINDS:
                    self.lifetime["requests"] -= 1
                    tr = ev.get("transport")
                    if tr in self.lifetime["by_transport"]:
                        self.lifetime["by_transport"][tr] -= 1
                elif old_kind in REPLY_KINDS and new_kind not in REPLY_KINDS:
                    self.lifetime["replies"] -= 1
                    self.lifetime["chars_sent"] -= ev.get("chars") or 0
                    cmd = ev.get("command")
                    if cmd and self.lifetime["by_command"].get(cmd):
                        self.lifetime["by_command"][cmd] -= 1
                if (old_kind in REQUEST_KINDS) != (new_kind in REQUEST_KINDS) or \
                        (old_kind in REPLY_KINDS) != (new_kind in REPLY_KINDS):
                    self._tally = deque((row for row in self._tally if row[1] != old_kind or row[0] != ev["t"]),
                                        maxlen=self._tally.maxlen)
                    self._dirty = True
                ev["dir"], ev["_public"] = KINDS[new_kind]
            for k, v in fields.items():
                if k in ev:
                    ev[k] = v
            self._recent_dirty = True
            subs, loop = list(self._subs), self._loop
        if push and subs and loop is not None:
            for q in subs:
                try:
                    loop.call_soon_threadsafe(self._offer, q, ev)
                except RuntimeError:
                    pass

    @staticmethod
    def _offer(q: asyncio.Queue, ev: dict) -> None:
        try:
            q.put_nowait(ev)
        except asyncio.QueueFull:
            pass

    # -- reading -------------------------------------------------------------------

    @staticmethod
    def to_public(ev: dict) -> dict | None:
        """The event as the public page may show it, or None to hide it."""
        if not ev.get("_public"):
            return None
        out = {k: v for k, v in ev.items() if not k.startswith("_") and k != "key"}
        if ev.get("transport") == "dm":
            out["sender"] = None
            out["text"] = None
        if ev["kind"] == "dropped" and ev.get("transport") != "channel":
            out["sender"] = None
            out["text"] = None
        return out

    @staticmethod
    def to_admin(ev: dict) -> dict:
        return {k: v for k, v in ev.items() if not k.startswith("_")}

    def recent(self, n: int = 200, public: bool = False, kinds: tuple[str, ...] | None = None,
               since_id: int = 0) -> list[dict]:
        with self._lock:
            evs = list(self._events)
        out = []
        for ev in evs:
            if ev["id"] <= since_id:
                continue
            if kinds and ev["kind"] not in kinds:
                continue
            row = self.to_public(ev) if public else self.to_admin(ev)
            if row is not None:
                out.append(row)
        return out[-n:]

    def stats(self) -> dict:
        now = time.time()
        with self._lock:
            tally = list(self._tally)
            lifetime = json.loads(json.dumps(self.lifetime))
            latencies = [ev["ms"] for ev in self._events if ev["kind"] in REPLY_KINDS and ev.get("ms") is not None]
            last_req = max((ev["t"] for ev in self._events if ev["kind"] in REQUEST_KINDS), default=None)
            last_reply = max((ev["t"] for ev in self._events if ev["kind"] in REPLY_KINDS), default=None)
        windows = {}
        for label, secs in (("1h", 3600), ("24h", 86400), ("7d", 7 * 86400)):
            cut = now - secs
            w = {"requests": 0, "replies": 0, "dropped": 0, "chars_sent": 0, "senders": 0,
                 "by_command": {}, "channel_replies": 0, "dm_replies": 0, "app_replies": 0}
            senders = set()
            for ts, kind, command, sender, chars in tally:
                if ts < cut:
                    continue
                if kind in REQUEST_KINDS:
                    w["requests"] += 1
                    if sender:
                        senders.add(sender)
                elif kind in REPLY_KINDS:
                    w["replies"] += 1
                    w["chars_sent"] += chars
                    w[{"reply_channel": "channel_replies", "reply_data": "app_replies"}.get(kind, "dm_replies")] += 1
                    if command:
                        w["by_command"][command] = w["by_command"].get(command, 0) + 1
                elif kind == "dropped":
                    w["dropped"] += 1
            w["senders"] = len(senders)
            windows[label] = w
        lat = {"median_ms": None, "p90_ms": None, "n": len(latencies)}
        if latencies:
            latencies.sort()
            lat["median_ms"] = int(statistics.median(latencies))
            lat["p90_ms"] = int(latencies[min(len(latencies) - 1, int(len(latencies) * 0.9))])
        return {"started": self._started, "lifetime": lifetime, "windows": windows,
                "latency": lat, "last_request_at": last_req, "last_reply_at": last_reply}

    async def subscribe(self, public: bool = False):
        """Async generator of new events (admin or public view)."""
        self._loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        with self._lock:
            self._subs.add(q)
        try:
            while True:
                ev = await q.get()
                row = self.to_public(ev) if public else self.to_admin(ev)
                if row is not None:
                    yield row
        finally:
            with self._lock:
                self._subs.discard(q)

    def install(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop


def _default_path() -> Path | None:
    try:
        from meshcore_weather.config import settings
        return Path(settings.data_dir) / "traffic_stats.json"
    except Exception:
        return None


traffic_log = TrafficLog(path=_default_path())
