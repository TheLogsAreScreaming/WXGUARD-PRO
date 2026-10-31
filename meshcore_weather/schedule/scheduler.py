"""Broadcast scheduler: when each job runs, and the one place that puts
v5 messages on the data channel (the app responder sends through it too,
so the sequence counter and the spacing are shared).

Each tick: reload the config if the portal changed it, run the jobs that
are due, send what they built with a gap between packets, keep per-job
stats. Warning state (what was sent, with which fingerprint), the next
header seq, when each job last ran and when the node last adverted are
persisted, so a restart neither re-sends every active warning as new, nor
jumps the sequence apps track, nor puts the digest, observations, forecast,
coverage statement and an advert on the air again just because the
process started.

Two more guards for a bot nobody is watching:

- a ceiling on scheduled packets per hour, every job together
  (MCW_SCHEDULED_PACKETS_PER_HOUR). Life-safety warnings and their repeat
  always go and count; past it the other jobs wait (WARNING once an hour,
  and a row on the portal's limits card);
- a per-bot jitter, from the node's public key, on when each periodic job
  first runs after a start, so two bots that boot together do not stay in
  lock-step.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import deque
from pathlib import Path

from meshcore_weather.activity import EventDir, activity_log
from meshcore_weather.config import settings
from meshcore_weather.geodata import resolver
from meshcore_weather.meshcore.radio import MeshcoreRadio
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol.coverage import Coverage
from meshcore_weather.schedule.executor import area_blocked, BroadcastExecutor, ExecutorContext
from meshcore_weather.schedule.models import BroadcastConfig
from meshcore_weather.schedule.store import CONFIG_PATH, load_config, save_config

logger = logging.getLogger(__name__)

TX_SPACING = 2.0                 # seconds between consecutive packets
TICK_INTERVAL_SECONDS = 30
FIRST_TICK_DELAY_S = 15          # settle before the first tick (after the backlog, see _tick_loop)
DIGEST_AFTER_CANCEL_S = 60
# The first run of a periodic job after a start waits up to this long, by a
# fraction taken from the node's key and the job (and at most a quarter of
# the job's interval). The warnings job is not delayed: it sends changes only.
START_JITTER_MAX_S = 300
CEILING_LOG_EVERY_S = 3600
BLOCKED_LOG_EVERY_S = 3600

_STATE_PATH = Path(settings.data_dir) / "warning_state.json"


def load_advert_record() -> dict | None:
    """The last advert this bot's node sent before the restart, as the
    scheduler saved it: {"at": unix time, "key": public key}. main.py hands
    it to the radio before it connects, so a restart does not flood a new
    advert when the last one is recent."""
    try:
        d = json.loads(_STATE_PATH.read_text())
        rec = d.get("advert")
        if isinstance(rec, dict) and isinstance(rec.get("at"), (int, float)):
            return {"at": float(rec["at"]), "key": str(rec.get("key") or "")}
    except (OSError, ValueError, AttributeError, TypeError):
        pass                                     # no file, or not ours to read: advert as usual
    return None


def jitter_fraction(seed: str, job_id: str) -> float:
    """A number in [0, 1) that is the same for this node and job on every
    start, and different between nodes."""
    h = hashlib.sha256(f"{seed}|{job_id}".encode()).digest()
    return int.from_bytes(h[:4], "big") / 2**32


class Scheduler:
    def __init__(self, store: WeatherStore, radio: MeshcoreRadio, ready: asyncio.Event | None = None,
                 parts=None):
        self.store = store
        self.radio = radio
        # Where `>part` reads its packets from (protocol.broadcaster.PartsCache),
        # filled below as each one is stamped and taken by the radio. None for
        # a scheduler nobody asks questions of.
        self._parts = parts
        # Set when the bot's product backlog is in; None when there is nothing
        # to wait for (a test, the CLI). The tick loop holds until then.
        self._ready = ready
        self.executor = BroadcastExecutor()
        self._config: BroadcastConfig = BroadcastConfig()
        self._config_mtime: float = 0.0
        self._config_lock = asyncio.Lock()
        self._last_run: dict[str, float] = {}
        self._last_bytes: dict[str, int] = {}
        self._total_bytes: dict[str, int] = {}
        self._total_runs: dict[str, int] = {}
        self._last_msg_count: dict[str, int] = {}
        # What each job's last run did, kept across restarts for the portal:
        # {"at": unix, "packets": n, "bytes": n, "reason": why nothing went, or None}.
        self._last_result: dict[str, dict] = {}
        # Jobs waiting for room under the ceiling (job id -> since when).
        self._waiting: dict[str, float] = {}
        # The seq the next packet on air gets. Restored from the state file;
        # the clock only seeds a bot that has never saved one.
        self._next_seq = int(time.time()) & 0xFF
        self._tx_lock = asyncio.Lock()
        self._last_tx = 0.0
        self._warning_state: dict[str, dict] = {}
        # The radar job's last judged picture ({"judged": taken_min, "wet": bool}),
        # and when each radar tile last went on air, (south, west, zoom,
        # taken_min) -> unix: the `>radar` answers' five minutes share it, so a
        # tile the schedule just sent is not sent again as an answer, nor the
        # other way round.
        self._radar_state: dict = {}
        self.radar_on_air: dict[tuple[int, int, int, int], float] = {}
        self._digest_due_at: float | None = None
        self._task: asyncio.Task | None = None
        self._running = False
        # Coverage fails closed: until the first build there is none, and a
        # build that raises keeps the last good one (reload_coverage).
        self._coverage: Coverage = Coverage.unavailable("coverage not built yet")
        self._good_coverage: Coverage | None = None
        self._blocked_logged_at = 0.0
        # No job runs before this after a start (job id -> unix time): the
        # per-bot jitter, and what a restored last_run still owes.
        self._hold_until: dict[str, float] = {}
        # The ceiling: when each scheduled packet went out (the last hour),
        # and what it held back.
        self._sched_sent: deque[float] = deque()
        self._ceiling_skips: deque[tuple[float, str, int]] = deque()
        self._ceiling_logged_at = 0.0
        self._ceiling_hit_at = 0.0
        self._home_offices: tuple[tuple[float, float] | None, set[str]] = (None, set())

    # -- lifecycle --

    async def start(self) -> None:
        self.reload_coverage()
        self._load_state()
        await self._reload_config()
        self._plan_start(time.time())
        self._running = True
        self._task = asyncio.create_task(self._tick_loop())
        logger.info("Broadcast scheduler started: %d jobs, tick every %ds", len(self._config.jobs), TICK_INTERVAL_SECONDS)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._save_state()

    # -- coverage and identity --

    def reload_coverage(self) -> None:
        """Build the coverage from the settings. A build that raises keeps
        the last good coverage; with none, the area broadcasts send nothing.
        Never "everything": that is MCW_COVERAGE=national, on purpose."""
        try:
            cov = Coverage.from_config()
        except Exception:
            if self._good_coverage is not None:
                logger.exception("Coverage could not be rebuilt; keeping the last good one (%s)",
                                 self._good_coverage.summary())
                self._coverage = self._good_coverage
            else:
                logger.exception("Coverage could not be built; scheduled warnings, digest and "
                                 "observations send nothing")
                self._coverage = Coverage.unavailable("coverage could not be built (see the log)")
            return
        self._coverage = cov
        if not cov.blocked:
            self._good_coverage = cov

    @property
    def coverage(self) -> Coverage:
        return self._coverage

    @property
    def next_seq(self) -> int:
        return self._next_seq

    def _node(self) -> dict:
        mc = getattr(self.radio, "_mc", None)
        si = getattr(mc, "self_info", None) if mc else None
        return si if isinstance(si, dict) else {}

    def bot_id(self) -> int:
        return b.bot_id(self._node().get("public_key"))

    def _jitter_seed(self) -> str:
        """The node's public key, else its name: what makes this bot's start
        offsets its own."""
        si = self._node()
        return str(si.get("public_key") or si.get("name") or "")

    def context(self) -> ExecutorContext:
        home = None
        try:
            home = resolver.home()
        except Exception:
            pass
        offices = set(self._coverage.sources.get("wfos") or []) if self._coverage else set()
        if not offices and home is not None:
            # resolve_by_coords scans every place (~0.1 s on a laptop, more
            # on a Pi) and the answer only changes with the home: once per home.
            if self._home_offices[0] != home:
                try:
                    loc = resolver.resolve_by_coords(home[0], home[1]) or {}
                    self._home_offices = (home, set(loc.get("wfos") or []))
                except Exception:
                    self._home_offices = (None, set())
            offices = set(self._home_offices[1])
        # A scratch counter: builders number their messages, transmit restamps them.
        return ExecutorContext(store=self.store, coverage=self._coverage, seq=b.SeqCounter(), bot=self.bot_id(),
                               warning_state=self._warning_state, home=home,
                               radius_km=float(settings.home_radius_km or 0), home_offices=offices,
                               radar_state=self._radar_state, radar_on_air=self.radar_on_air)

    # -- warning state and seq persistence --

    def _load_state(self) -> None:
        try:
            if _STATE_PATH.exists():
                d = json.loads(_STATE_PATH.read_text())
                if isinstance(d.get("next_seq"), int):          # absent in files written before revision 3
                    self._next_seq = d["next_seq"] & 0xFF
                self._warning_state = {k: v for k, v in d.get("warnings", {}).items()
                                       if v.get("expires", 0) > b.now_min()}
                now = time.time()
                # When each job last ran (absent before 2026-10-17). A time in
                # the future (a clock set back) counts as now.
                for job_id, t in (d.get("last_run") or {}).items():
                    if isinstance(t, (int, float)) and t > 0:
                        self._last_run[str(job_id)] = min(float(t), now)
                self._sched_sent = deque(sorted(t for t in d.get("sched_sent") or []
                                                if isinstance(t, (int, float)) and 0 <= now - t <= 3600))
                self._last_result = {str(k): v for k, v in (d.get("last_result") or {}).items()
                                     if isinstance(v, dict)}
                if isinstance(d.get("radar"), dict):
                    self._radar_state = d["radar"]
                logger.info("Warning state: %d active identities restored, next seq %d, %d job run times",
                            len(self._warning_state), self._next_seq, len(self._last_run))
        except Exception as e:
            logger.warning("Ignoring warning state file: %s", e)
            self._warning_state = {}

    def _advert_record(self) -> dict | None:
        """When the radio last adverted, and as which key, for the next start."""
        at = getattr(self.radio, "last_advert_at", None)
        if not isinstance(at, (int, float)) or isinstance(at, bool) or at <= 0:
            return load_advert_record()      # nothing new from this radio: keep what was saved
        key = self._node().get("public_key")
        return {"at": float(at), "key": key if isinstance(key, str) else ""}

    def _save_state(self, next_seq: int | None = None) -> None:
        try:
            _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = _STATE_PATH.with_suffix(".tmp")
            seq = self._next_seq if next_seq is None else next_seq
            now = time.time()
            state = {"warnings": self._warning_state, "next_seq": seq,
                     "last_run": {k: v for k, v in self._last_run.items() if v > 0},
                     "sched_sent": [t for t in self._sched_sent if now - t <= 3600],
                     "last_result": self._last_result, "radar": self._radar_state}
            advert = self._advert_record()
            if advert is not None:
                state["advert"] = advert
            tmp.write_text(json.dumps(state))
            tmp.replace(_STATE_PATH)
        except Exception as e:
            logger.warning("Could not write warning state: %s", e)

    def _plan_start(self, now: float) -> None:
        """When each job may first run after this start: not before its
        restored last run plus its interval (a restart is not a reason to
        send the digest again), and a periodic job not before its own offset
        either (up to START_JITTER_MAX_S, from the node key), so bots that
        boot together drift apart and this bot's jobs do not all leave in
        the same tick."""
        seed = self._jitter_seed()
        self._hold_until = {}
        for job in self._config.jobs:
            interval = job.interval_minutes * 60
            due = self._last_run.get(job.id, 0.0) + interval
            if job.product != "warnings":
                span = min(START_JITTER_MAX_S, interval * 0.25)
                due = max(due, now + jitter_fraction(seed, job.id) * span)
            if due > now:
                self._hold_until[job.id] = due
        if self._last_run:
            waiting = sorted((t, j) for j, t in self._hold_until.items())
            logger.info("Restored job run times: %s", ", ".join(f"{j} in {int(t - now)}s" for t, j in waiting)
                        or "every job is due")

    def _due(self, job, now: float) -> bool:
        if now < self._hold_until.get(job.id, 0.0):
            return False
        return now - self._last_run.get(job.id, 0.0) >= job.interval_minutes * 60

    # -- the ceiling on scheduled packets --

    def _sched_used(self, now: float) -> int:
        while self._sched_sent and now - self._sched_sent[0] > 3600:
            self._sched_sent.popleft()
        return len(self._sched_sent)

    def _ceiling_hit(self, job_id: str, held: int, now: float) -> None:
        """Something waited for the ceiling: remember it for the portal, and
        say so in the log once an hour."""
        self._ceiling_hit_at = now
        self._ceiling_skips.append((now, job_id, held))
        while self._ceiling_skips and now - self._ceiling_skips[0][0] > 3600:
            self._ceiling_skips.popleft()
        if now - self._ceiling_logged_at >= CEILING_LOG_EVERY_S:
            self._ceiling_logged_at = now
            logger.warning("Scheduled broadcasts reached their ceiling of %d packets an hour "
                           "(MCW_SCHEDULED_PACKETS_PER_HOUR): job %s waits; life-safety warnings still go out",
                           settings.scheduled_packets_per_hour, job_id)

    def ceiling_status(self, now: float | None = None) -> dict:
        """For the portal: the ceiling, what the last hour used, what waited."""
        now = time.time() if now is None else now
        used = self._sched_used(now)
        cap = settings.scheduled_packets_per_hour
        skips = [s for s in self._ceiling_skips if now - s[0] <= 3600]
        return {"cap": cap, "used": used, "left": max(0, cap - used), "spent": used >= cap,
                "opens_in_s": int(3600 - (now - self._sched_sent[0])) if used >= cap and self._sched_sent else 0,
                "waits_last_hour": len(skips), "jobs_waited": sorted({s[1] for s in skips}),
                "last_hit_at": self._ceiling_hit_at or None}

    def reset_ceiling(self) -> None:
        self._sched_sent.clear()
        self._ceiling_skips.clear()

    # -- config --

    async def _reload_config(self) -> None:
        async with self._config_lock:
            try:
                mtime = CONFIG_PATH.stat().st_mtime if CONFIG_PATH.exists() else 0.0
            except OSError:
                mtime = 0.0
            if mtime != self._config_mtime or not self._config.jobs:
                self._config = load_config()
                self._config_mtime = mtime

    def current_config(self) -> BroadcastConfig:
        return self._config

    async def save_config(self, cfg: BroadcastConfig) -> None:
        async with self._config_lock:
            save_config(cfg)
            self._config = cfg
            try:
                self._config_mtime = CONFIG_PATH.stat().st_mtime
            except OSError:
                pass

    # -- the loop --

    async def _tick_loop(self) -> None:
        # Nothing goes out before the bot's products are in. A digest,
        # observations or a warning list built from the empty store of a bot
        # that restarted 20 seconds ago is wrong on air, and every app that
        # hears it files it as current.
        if self._ready is not None and not self._ready.is_set():
            logger.info("Broadcasts held until the product backlog is loaded")
            await self._ready.wait()
        await asyncio.sleep(FIRST_TICK_DELAY_S)
        while self._running:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Scheduler tick crashed")
            await asyncio.sleep(TICK_INTERVAL_SECONDS)

    async def tick(self) -> int:
        """Run every enabled job whose interval has elapsed. Returns the
        number of packets sent."""
        await self._reload_config()
        ctx = self.context()
        now = time.time()
        sent = 0
        blocked = getattr(self._coverage, "blocked", None)
        if blocked and now - self._blocked_logged_at >= BLOCKED_LOG_EVERY_S:
            self._blocked_logged_at = now
            logger.error("Scheduled warnings, digest, observations and the coverage statement are off: %s", blocked)
        for job in list(self._config.jobs):
            if not job.enabled:
                continue
            if not self._due(job, now):
                continue
            sent += await self._run(job, ctx)
        if ctx.cancel_sent:
            self._digest_due_at = time.time() + DIGEST_AFTER_CANCEL_S
        if self._digest_due_at and time.time() >= self._digest_due_at:
            self._digest_due_at = None
            digest = self._config.get_job("digest")
            if digest is not None and digest.enabled:
                sent += await self._run(digest, ctx)
        if ctx.warning_state is not self._warning_state:
            self._warning_state = ctx.warning_state
        self._save_state()
        return sent

    async def _run(self, job, ctx: ExecutorContext) -> int:
        """Run one job under the ceiling. A job other than warnings that does
        not fit waits, without counting as run, so the next tick tries it
        again; the warnings job runs with the room left (ctx.budget) and its
        builder holds back what does not fit."""
        now = time.time()
        left = settings.scheduled_packets_per_hour - self._sched_used(now)
        if job.product == "warnings":
            ctx.budget, ctx.held_back = left, 0
        elif left <= 0:
            self._ceiling_hit(job.id, 1, now)
            self._waiting.setdefault(job.id, now)
            return 0
        ctx.reason = ctx.note = ctx.retry_in_s = ctx.radar_sent = None
        ctx.quiet = ctx.idle = False
        try:
            if job.product == "radar":
                # Reading a radar picture takes a few hundred milliseconds on a Pi.
                msgs = await asyncio.get_running_loop().run_in_executor(None, self.executor.run_job, job, ctx)
            else:
                msgs = self.executor.run_job(job, ctx)
        except Exception:
            logger.exception("Scheduler: exception running job %s", job.id)
            msgs = []
        finally:
            ctx.budget = None
        if job.product != "warnings" and len(msgs) > left:
            self._ceiling_hit(job.id, len(msgs), now)
            self._waiting.setdefault(job.id, now)
            return 0
        self._waiting.pop(job.id, None)
        if not msgs and ctx.retry_in_s:
            # Nothing yet, and not a run: look again soon, the interval
            # untouched (radar waiting for a picture it has not judged).
            self._hold_until[job.id] = time.time() + ctx.retry_in_s
            if not ctx.quiet:
                self._last_result[job.id] = {"at": time.time(), "packets": 0, "bytes": 0,
                                             "reason": ctx.reason or "nothing to send", "idle": ctx.idle}
            return 0
        if job.product == "warnings" and ctx.held_back:
            self._ceiling_hit(job.id, ctx.held_back, now)
        now = time.time()
        self._last_run[job.id] = now
        self._hold_until.pop(job.id, None)
        self._total_runs[job.id] = self._total_runs.get(job.id, 0) + 1
        if not msgs:
            self._last_msg_count[job.id] = 0
            self._last_bytes[job.id] = 0
            self._last_result[job.id] = {"at": now, "packets": 0, "bytes": 0,
                                         "reason": ctx.reason or "nothing to send"}
            logger.debug("job %s: nothing to send (%s)", job.id, ctx.reason)
            return 0
        n, nbytes = await self.transmit(msgs, f"job {job.id} ({job.product})")
        self._sched_sent.extend([time.time()] * n)
        self._last_msg_count[job.id] = n
        self._last_bytes[job.id] = nbytes
        self._last_result[job.id] = {"at": now, "packets": n, "bytes": nbytes,
                                     "reason": None if n else ("transmit is off" if not settings.tx_enabled
                                                               else "the radio did not take the packets")}
        if n and ctx.note:
            self._last_result[job.id]["note"] = ctx.note
        if n and ctx.radar_sent:
            self._radar_on_air(ctx.radar_sent, msgs[0])
        self._total_bytes[job.id] = self._total_bytes.get(job.id, 0) + nbytes
        activity_log.record(EventDir.OUT, "broadcast",
                            f"Job {job.id}: {n} msg(s), {nbytes}B ({job.product})",
                            {"job_id": job.id, "product": job.product, "messages": n, "bytes": nbytes})
        return n

    def _radar_on_air(self, sent: dict, packet: bytes) -> None:
        """A scheduled radar tile the radio took: it starts the tile's window
        as an answer would, settles the picture, and goes in the audit log."""
        from meshcore_weather.radar import audit
        now = time.time()
        self.radar_on_air[sent["key"]] = now
        for key in [k for k, t in self.radar_on_air.items() if now - t > settings.radar_window_s]:
            del self.radar_on_air[key]
        self._radar_state.update(judged=sent["judged"], wet=sent["wet"])
        tile, picture, frame = sent["cut"]
        audit.record(request="(scheduled)", sender="", tile=tile, picture=picture, frame=frame,
                     packet=packet, now=now)

    async def transmit(self, msgs: list[bytes], label: str, ev: dict | None = None,
                       keep_groups: bool = False, not_before: float = 0.0) -> tuple[int, int]:
        """Send v5 messages on the data channel with spacing. Returns
        (packets sent, bytes).

        One batch at a time, so a request answer and a scheduled tick never
        interleave and packets leave in seq order. The seq is stamped here,
        not by the builders, and a number is used only when the radio took
        the packet: a failed send leaves no gap. The radio's echo resend
        repeats these stamped bytes, same seq.

        `keep_groups` is the `>part` case: these packets went out once
        already, so they take a fresh seq and keep the `group` they were
        assembled under. They are not remembered again either — a resend must
        not extend the ten minutes the original answer is held for.

        `not_before` (time.monotonic): the first packet waits for it, outside
        the lock, so an answer held back for a relayed request keeps no other
        batch waiting (main.reply_not_before)."""
        wait = not_before - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        async with self._tx_lock:
            # Saved past the batch before it starts: killed part-way, the bot comes back ahead of
            # every number it may have put on air (apps see a gap), never behind them (apps would
            # take the next packets for late copies). The save after the batch keeps the real value.
            if msgs:
                self._save_state(next_seq=(self._next_seq + len(msgs)) & 0xFF)
            sent = nbytes = 0
            groups: dict[tuple[int, int], int] = {}
            for msg in msgs:
                wait = self._last_tx + TX_SPACING - time.monotonic()
                if wait > 0:                        # spacing holds across batches too
                    await asyncio.sleep(wait)
                msg = self._stamp(msg, groups, keep_groups=keep_groups)
                try:
                    ok = await self.radio.send_channel_data(msg, ev=ev)
                except Exception:
                    logger.exception("%s: send failed", label)
                    ok = False
                self._last_tx = time.monotonic()
                if ok:
                    self._next_seq = (self._next_seq + 1) & 0xFF
                    sent += 1
                    nbytes += len(msg)
                    if not keep_groups:
                        self._remember_part(msg)
            if msgs:
                self._save_state()
            if sent:
                activity_log.record_send(sent, nbytes)
                logger.info("%s: %d packet(s), %d bytes", label, sent, nbytes)
            return sent, nbytes

    # Where a multi-packet type keeps `group`, `idx` and `total`: Text
    # (spec 8) and the Area sweep (spec 12), which numbers itself the same
    # way from a different offset. The last number is the smallest packet the
    # three fields fit in.
    _GROUP_FIELDS = {v5.TYPE_TEXT: (5, 6, 7, 8), v5.TYPE_AREA_SWEEP: (8, 9, 10, 11)}

    def _stamp(self, msg: bytes, groups: dict[tuple[int, int], int],
               keep_groups: bool = False) -> bytes:
        """Byte 0 = the next seq. A multi-packet reply's group is the seq its
        first packet goes out with (spec 8, 12), so it follows the restamp.

        `keep_groups` leaves `group` alone: a packet resent for `>part` is the
        same packet of the same answer, and a phone reassembles by
        `(bot, group)`. Renumbering it would file packet 3 under a group whose
        other packets nobody ever sent."""
        out = bytearray(msg)
        out[0] = self._next_seq
        mtype = out[3] >> 4
        where = self._GROUP_FIELDS.get(mtype)
        if where is not None and not keep_groups:
            gi, ii, _ti, size = where
            if len(out) >= size:
                key = (mtype, msg[gi])
                if out[ii] == 0:
                    groups[key] = self._next_seq
                out[gi] = groups.get(key, msg[gi])
        return bytes(out)

    def _remember_part(self, msg: bytes) -> None:
        """Keep a packet of a multi-packet answer for `>part`, under the group
        it actually went out with. Answers of one packet are not kept: the
        eight slots are for the answers a phone can lose a piece of."""
        if self._parts is None:
            return
        mtype = msg[3] >> 4
        where = self._GROUP_FIELDS.get(mtype)
        if where is None:
            return
        gi, ii, ti, size = where
        if len(msg) < size:
            return
        total = msg[ti] & (v5.SWEEP_TOTAL_MASK if mtype == v5.TYPE_AREA_SWEEP else 0xFF)
        if total > 1:
            self._parts.remember(msg[gi], msg[ii], msg, mtype=mtype)

    # -- portal --

    def job_status(self, job_id: str) -> dict:
        now = time.time()
        job = self._config.get_job(job_id)
        if job is None:
            return {"job_id": job_id, "found": False}
        last_run = self._last_run.get(job_id, 0.0)
        next_due = max(last_run + job.interval_minutes * 60 if last_run else now,
                       self._hold_until.get(job_id, 0.0))
        return {
            "job_id": job_id, "found": True, "enabled": job.enabled,
            "last_run_unix": last_run if last_run else None,
            "last_run_seconds_ago": int(now - last_run) if last_run else None,
            "next_run_unix": next_due,
            "next_run_in_seconds": max(0, int(next_due - now)),
            "total_runs": self._total_runs.get(job_id, 0),
            "total_bytes": self._total_bytes.get(job_id, 0),
            "last_bytes": self._last_bytes.get(job_id, 0),
            "last_msg_count": self._last_msg_count.get(job_id, 0),
            "last_result": self._last_result.get(job_id),
            # When the job last looked, sent or not: radar looks every minute
            # and counts only a picture sent as a run.
            "last_result_seconds_ago": self._result_age(job_id, now),
            "waiting_since": self._waiting.get(job_id),
        }

    def _result_age(self, job_id: str, now: float) -> int | None:
        at = (self._last_result.get(job_id) or {}).get("at")
        return max(0, int(now - at)) if isinstance(at, (int, float)) else None

    def preview(self, job) -> dict:
        """What `job` would send if it ran now, without sending it or touching
        any state: the packets' sizes, or why it would send nothing. Warnings
        are not built (that would move their state); the answer says how many
        are active in coverage instead."""
        ctx = self.context()
        if job.product == "warnings":
            if area_blocked(job, ctx):
                return {"packets": [], "reason": ctx.reason}
            from meshcore_weather.protocol.warnings import extract_active_warnings
            active = [w for w in extract_active_warnings(self.store, coverage=self._coverage)
                      if b.warning_identity(w) is not None]
            return {"packets": [], "reason": None, "active_warnings": len(active)}
        ctx.warning_state, ctx.radar_state = {}, {}
        try:
            msgs = self.executor.run_job(job, ctx)
        except Exception as exc:
            logger.exception("preview of job %s", job.id)
            return {"packets": [], "reason": f"the bot could not build it: {exc}"}
        return {"packets": [len(m) for m in msgs], "reason": None if msgs else (ctx.reason or "nothing to send"),
                "note": ctx.note, "radar": ctx.radar_info}

    def job_packets_per_hour(self, job) -> float:
        """About how many packets a job sends an hour, from what it sent last
        time (one packet when it has not run yet). Warnings count none: they go
        when the weather says so, and so does radar while it is dry."""
        if not job.enabled or job.product == "warnings":
            return 0.0
        last = self._last_result.get(job.id) or {}
        if job.product == "radar" and last and not last.get("packets"):
            return 0.0
        return (last.get("packets") or 1) * 60.0 / job.interval_minutes

    def scheduled_packets_per_hour(self) -> float:
        return sum(self.job_packets_per_hour(job) for job in self._config.jobs)

    async def run_job_now(self, job_id: str) -> int:
        job = self._config.get_job(job_id)
        if job is None:
            return 0
        ctx = self.context()
        ctx.force = True
        n = await self._run(job, ctx)
        self._save_state()
        return n
