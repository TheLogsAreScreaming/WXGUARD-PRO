"""In-memory event console for the admin portal.

Every log record the process emits is kept in a ring (with a category
derived from the logger name: satellite, radio, bot) and pushed to SSE
subscribers, so the browser can watch the receiver, the radio and the bot
in one stream and filter by source.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from threading import Lock

_LINES: deque[dict] = deque(maxlen=2000)
_LOCK = Lock()
_INSTALLED = False
_SUBSCRIBERS: set[asyncio.Queue] = set()
_LOOP: asyncio.AbstractEventLoop | None = None
_SEQ = 0

CATEGORIES = ("satellite", "radio", "bot")


def category_for(logger_name: str) -> str:
    n = logger_name
    if n == "meshcore" or n.startswith("meshcore.") or ".meshcore." in n or n.endswith(".radio"):
        return "radio"
    if ".emwin" in n or ".parser" in n or ".sdr" in n or n.startswith("pyiem"):
        return "satellite"
    return "bot"


class RingHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        global _SEQ
        try:
            msg = self.format(record)
        except Exception:
            return
        with _LOCK:
            _SEQ += 1
            line = {"id": _SEQ, "t": record.created, "level": record.levelname,
                    "logger": record.name, "cat": category_for(record.name), "msg": msg}
            _LINES.append(line)
            subs = list(_SUBSCRIBERS)
            loop = _LOOP
        if subs and loop is not None:
            for q in subs:
                try:
                    loop.call_soon_threadsafe(_offer, q, line)
                except RuntimeError:
                    pass


def _offer(q: asyncio.Queue, line: dict) -> None:
    try:
        q.put_nowait(line)
    except asyncio.QueueFull:
        pass


def install(loop: asyncio.AbstractEventLoop | None = None) -> None:
    global _INSTALLED, _LOOP
    if loop is not None:
        _LOOP = loop
    if _INSTALLED:
        return
    h = RingHandler()
    h.setFormatter(logging.Formatter("%(message)s"))
    logging.getLogger().addHandler(h)
    _INSTALLED = True


_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


def _matches(line: dict, cat: str | None, level: str | None, q: str | None) -> bool:
    if cat and cat != "all" and line["cat"] != cat:
        return False
    if level and level.upper() in _LEVELS and _LEVELS.index(line["level"]) < _LEVELS.index(level.upper()):
        return False
    if q and q.lower() not in line["msg"].lower():
        return False
    return True


def tail(n: int = 200, level: str | None = None, cat: str | None = None, q: str | None = None) -> list[dict]:
    with _LOCK:
        lines = list(_LINES)
    return [l for l in lines if _matches(l, cat, level, q)][-n:]


def counts(window_s: int = 3600) -> dict:
    """Lines per category and warnings/errors in the window (for the chips)."""
    cutoff = time.time() - window_s
    out = {c: 0 for c in CATEGORIES}
    out["problems"] = 0
    # Errors alone: the Overview's attention list. Warnings are mostly the
    # dish's dropped-packet notes, a minute apart, so they cannot ask for anyone.
    out["errors"] = 0
    with _LOCK:
        for l in _LINES:
            if l["t"] < cutoff:
                continue
            out[l["cat"]] = out.get(l["cat"], 0) + 1
            if l["level"] in ("WARNING", "ERROR", "CRITICAL"):
                out["problems"] += 1
            if l["level"] in ("ERROR", "CRITICAL"):
                out["errors"] += 1
    return out


async def subscribe():
    """Async generator of new lines. Register the loop the first time."""
    global _LOOP
    _LOOP = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    with _LOCK:
        _SUBSCRIBERS.add(q)
    try:
        while True:
            yield await q.get()
    finally:
        with _LOCK:
            _SUBSCRIBERS.discard(q)
