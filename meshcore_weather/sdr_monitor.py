"""Turn the goestools dashboard's numbers into log lines for the console,
into the `sat` reply, and (with MCW_STATUS_CHANNEL set) into the status
channel's lines, which every poll hands to status_channel.StatusReporter.

Polls the dashboard every few seconds and logs (under the "satellite"
category) only what an operator would want to see scroll by: lock gained or
lost, a per-minute summary whenever packets were dropped, and goesrecv /
goesproc service changes. Never raises; a dashboard that is down is logged
once and retried quietly.

The dashboard (deploy/goes-dashboard/dashboard.py) listens to goesrecv's
stats sockets. Its `stats` cover the last second only; `history` is one row
per second, [t, vit_avg, packets, drops, rs_sum]. `sat` reads the last
minute of `history` from the newest sample, so a question costs no request.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from meshcore_weather.config import settings

logger = logging.getLogger("meshcore_weather.sdr")

POLL_S = 10
NOTES_S = 60          # the operator's notices (the dashboard's /api/notes), for `status`
STALE_S = 120          # an older sample is not "now"
WINDOW_S = 60


class SdrMonitor:
    def __init__(self, url: str | None = None, status=None, feed=None):
        self.url = (url or settings.sdr_dashboard_url).rstrip("/")
        # The status channel (status_channel.StatusReporter) is told what every
        # poll found, with the EMWIN source for the backup and lag conditions.
        # Without one nothing goes on the air from here.
        self.status = status
        self.feed = feed
        self._task: asyncio.Task | None = None
        self._locked: bool | None = None
        self._services: dict = {}
        self._reachable: bool | None = None
        self._minute_drops = 0         # sampled: `drops` is one second per poll
        self._minute_vit: list[int] = []
        self._minute_start: float | None = None
        self.last_state: dict | None = None
        self.last_at: float | None = None
        self.notes: list[dict] = []        # the operator's notices up, as the dashboard last said
        self._notes_at = 0.0

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        async with httpx.AsyncClient(timeout=5.0) as client:
            while True:
                await self.poll(client)
                await asyncio.sleep(POLL_S)

    async def poll(self, client: httpx.AsyncClient) -> None:
        """One dashboard sample: the loop's tick, or the CLI's on demand."""
        now = time.time()
        state = None
        try:
            r = await client.get(self.url + "/api/state")
            r.raise_for_status()
            state = r.json()
            self.observe(state, now)
            if self._reachable is False:
                logger.info("receiver dashboard reachable again at %s", self.url)
            self._reachable = True
        except Exception as e:
            if self._reachable is not False:
                logger.warning("receiver dashboard unreachable (%s): %s", self.url, e)
            self._reachable = False
        if self._reachable and now - self._notes_at >= NOTES_S:
            self._notes_at = now
            try:
                r = await client.get(self.url + "/api/notes")
                r.raise_for_status()
                self.notes = list(r.json().get("up") or [])
            except Exception as e:      # an older dashboard has none; the last ones known stand
                logger.debug("receiver dashboard notes: %s", e)
        if self.status is not None:
            try:
                await self.status.tick(now, state, self._reachable is True, self.feed)
            except Exception:
                logger.exception("status channel")

    def observe(self, state: dict, now: float | None = None) -> None:
        """Feed one dashboard sample; emits log lines on changes."""
        now = now or time.time()
        self.last_state, self.last_at = state, now
        if self._minute_start is None:
            self._minute_start = now
        st = state.get("stats") or {}
        locked = bool(st.get("locked"))
        if self._locked is None:
            logger.info("receiver %s (vit %s, gain %.1f, mode %s)",
                        "locked" if locked else "NOT locked", st.get("vit_avg"), float(st.get("gain") or 0), state.get("mode"))
        elif locked != self._locked:
            (logger.info if locked else logger.warning)("receiver %s (vit %s)", "locked" if locked else "LOST LOCK", st.get("vit_avg"))
        self._locked = locked

        services = (state.get("status") or {}).get("services") or {}
        for name, val in services.items():
            old = self._services.get(name)
            if old is not None and old != val:
                (logger.warning if val != "active" else logger.info)("%s is %s (was %s)", name, val, old)
        self._services = dict(services)

        self._minute_drops += int(st.get("drops") or 0)
        if st.get("vit_avg") is not None:
            self._minute_vit.append(int(st["vit_avg"]))
        if now - self._minute_start >= 60:
            if self._minute_drops:
                vit = sum(self._minute_vit) // max(1, len(self._minute_vit))
                logger.warning("receiver dropped %d packets in the last minute (vit avg %d)", self._minute_drops, vit)
            self._minute_drops = 0
            self._minute_vit = []
            self._minute_start = now

    def report(self, now: float | None = None, emwin_mtime: float | None = None,
               lag_min: int | None = None, brief: bool = False) -> str:
        """The `sat` line from the last sample. No I/O."""
        return receiver_line(self.last_state, self.last_at, now or time.time(), emwin_mtime, lag_min, brief)


def quality(vit: int, drop_pct: float) -> str:
    """goestools' guide: vit ~100 runs for hours without drops, ~400 gets every
    packet but is fragile, ~1000 sporadic packets, ~2000 no signal. The
    dashboard shows under 200 green, under 600 amber. A dropped packet loses
    the EMWIN file it carried; this dish's baseline is about 0.5%."""
    if vit < 200 and drop_pct < 1:
        return "good"
    if vit < 600 and drop_pct < 5:
        return "fair"
    return "poor"


def _ago(s: float) -> str:
    s = max(0, round(s))
    if s < 90:
        return f"{s}s"
    m = round(s / 60)
    if m < 90:
        return f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h{m:02d}m" if h < 48 else f"{h // 24}d{h % 24}h"


def _behind(minutes: int) -> str:
    return f"{minutes}m" if minutes < 120 else f"{round(minutes / 60)}h"


def receiver_line(state: dict | None, sampled_at: float | None, now: float,
                  emwin_mtime: float | None = None, lag_min: int | None = None,
                  brief: bool = False) -> str:
    """Lock, signal over the last minute, age of the newest EMWIN file.
    `emwin_mtime` is the bot's own newest file; the sample's counts only while
    the sample is fresh. A stale sample says so, never passes as current.
    `lag_min` is how far behind the uplink is running (SDRSource.feed_lag_min):
    a fresh file is no comfort when every product in it is hours old.
    `brief` leaves out the packet count, for a reply that must fit one message."""
    state = state or {}
    fresh = sampled_at is not None and now - sampled_at <= STALE_S
    off = sampled_at - float(state.get("t") or sampled_at) if fresh else 0.0   # dashboard clock -> ours
    newest = [emwin_mtime] if emwin_mtime else []
    # The dashboard tags what the internet backup wrote "net"; only the
    # dish's own files ("sat", or untagged from an older dashboard) count.
    latest = [e for e in (state.get("status") or {}).get("latest_emwin") or []
              if (e.get("src") or "sat") == "sat"]
    if fresh and latest and latest[0].get("mtime"):
        newest.append(latest[0]["mtime"] + off)
    emwin = f"newest EMWIN {_ago(now - max(newest))} ago" if newest else "no EMWIN file yet"
    if lag_min is not None and lag_min >= 30:
        emwin += f", products ~{_behind(lag_min)} behind"

    if sampled_at is None:
        return f"GOES receiver not reporting (no dashboard reading), {emwin}"
    if not fresh:
        return f"GOES receiver not reporting (last reading {_ago(now - sampled_at)} ago), {emwin}"
    if state.get("mode") == "point":
        return f"GOES receiver in pointing mode, goesrecv stopped, {emwin}"
    st = state.get("stats") or {}
    services = (state.get("status") or {}).get("services") or {}
    t = float(state.get("t") or 0)
    rows = [r for r in state.get("history") or [] if len(r) >= 4 and r[0] > t - WINDOW_S]
    if not st.get("feed_alive") or not rows:
        rx = services.get("goesrecv")
        why = f"goesrecv {rx}" if rx and rx != "active" else "no stats from goesrecv"
        return f"GOES receiver not reporting ({why}), {emwin}"

    drops = sum(r[3] or 0 for r in rows)
    frames = sum(r[2] or 0 for r in rows) + drops
    weighted = [(r[1], (r[2] or 0) + (r[3] or 0)) for r in rows if r[1] is not None]
    n = sum(w for _, w in weighted)
    vit = round(sum(v * w for v, w in weighted) / n) if n else None

    since = st.get("lock_since")
    if not st.get("locked"):
        parts = ["GOES NOT locked"]
    else:
        parts = [f"GOES locked {_ago(now - since - off)}" if since else "GOES locked"]
    if vit is None or not frames:
        parts.append("no packets last min")
    else:
        parts.append(f"signal {quality(vit, 100 * drops / frames)} (vit {vit})")
        if not brief:
            parts.append(f"dropped {drops} of {frames} packets last min")
    proc = services.get("goesproc")
    if proc and proc != "active":
        parts.append(f"goesproc {proc}")
    parts.append(emwin)
    return ", ".join(parts)
