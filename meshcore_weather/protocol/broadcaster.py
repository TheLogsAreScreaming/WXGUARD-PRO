"""The app side of the bot: scheduled v5 broadcasts (owned Scheduler) and
answers to `>` requests.

A request is a DM (or a channel line) that starts with `>` and uses the
same words a person would: `>w`, `>w SV.W.EWX.42`, `>o KAUS`, `>f 102`,
`>afd EWX`. The answer is never a DM: it goes out on the data channel as
v5 messages so every app in range gets it (docs/MeshWX_v5_Spec.md §14).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from meshcore_weather.config import settings
from meshcore_weather.geodata import resolver
from meshcore_weather.meshcore.radio import MeshcoreRadio
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol.coverage import Coverage
from meshcore_weather.protocol.warnings import extract_active_warnings

logger = logging.getLogger(__name__)

# The defaults of the operator's limits (config.py, set on the portal and
# applied live): every check below reads `settings`, never these.
PER_SENDER_S = 2.0               # settings.app_sender_gap_s
PER_HOUR = 240                   # settings.app_packets_per_hour; packets, not requests: a `>w` can be 7
# Told "busy" (Not available, reason 4) once the hour's packets are spent, at
# most this often per radio: the app shows it instead of waiting for nothing.
BUSY_REPLY_PER_SENDER_S = 60.0
MAX_WARNINGS_PER_REQUEST = 6
# `>wmap` is the one answer that can take eight packets at once, so it gets a
# limit of its own on top of everything else: one sweep of the same ground
# every 5 minutes across ALL senders (spec 12). Since revision 10 "the same
# ground" is per state, so the window is kept per state as well as nationally.
# It is never scheduled; it only ever answers. The name is the portal's: its
# limits panel reads this constant, `_last_sweep` and `_last_sweep_state` to
# show when the next sweep may go out.
SWEEP_COOLDOWN_S = 300.0            # settings.sweep_window_s; one sweep per state per 5 min, whoever asks (owner, 2026-09-20)

# `>radar` (spec 13, revision 11): one packet, so the hourly budget is limit
# enough, with one exception. The same tile cut from the same picture is the
# same bytes, and everyone in range already got them: inside this window the
# answer is the 6-byte Not available instead. It is keyed on the picture's own
# time as well as the tile, so a newer picture is never held back by an older.
RADAR_COOLDOWN_S = 300.0            # settings.radar_window_s

# `>part` (spec 12/8.1, revision 10): the packets of the last few multi-packet
# answers, kept so a phone that heard 4 of 7 can ask for the other 3 instead of
# the whole map again. Eight answers is more than a busy minute produces, and
# ten minutes is longer than a phone waits before it gives up on an assembly.
PARTS_CACHE_S = 600.0
PARTS_CACHE_GROUPS = 8
# One resend of the same packet every 30 s, whoever asks: ten phones that all
# missed packet 3 of one sweep cost one packet, not ten.
PART_RESEND_FLOOR_S = 30.0          # settings.part_resend_floor_s


class PartsCache:
    """The transmitted bytes of the last few multi-packet answers.

    Keyed by the `group` a packet actually went out with, which is why this is
    filled at transmission and not where the answer was built: `group` is the
    seq the first packet took from the radio, and nothing knows it until then.
    """

    def __init__(self, groups: int = PARTS_CACHE_GROUPS, seconds: float = PARTS_CACHE_S,
                 floor: float | None = None):
        self._max_groups = groups
        self._seconds = seconds
        self._fixed_floor = floor              # None: the operator's setting, read each time
        # group byte -> {"at": when the first packet went out, "type": message
        # type, "packets": {idx: bytes}, "sent": {idx: when it was last resent}}
        self._groups: dict[int, dict] = {}

    def remember(self, group: int, idx: int, data: bytes, mtype: int = 0,
                 now: float | None = None) -> None:
        now = time.time() if now is None else now
        self._expire(now)
        held = self._groups.get(group)
        if held is None:
            held = self._groups[group] = {"at": now, "type": mtype,
                                          "packets": {}, "sent": {}}
            # The newest few answers, by when they started going out.
            for old in sorted(self._groups, key=lambda g: self._groups[g]["at"])[:-self._max_groups]:
                del self._groups[old]
        held["packets"][idx] = bytes(data)

    @property
    def _floor(self) -> float:
        return self._fixed_floor if self._fixed_floor is not None else float(settings.part_resend_floor_s)

    def lookup(self, group: int, indexes: list[int], now: float | None = None
               ) -> tuple[list[bytes], list[int], list[int]]:
        """What `>part` can answer with: (packets, indexes inside the resend
        floor, indexes this bot does not hold)."""
        now = time.time() if now is None else now
        self._expire(now)
        held = self._groups.get(group)
        if held is None:
            return [], [], list(indexes)
        packets, waiting, unknown = [], [], []
        for idx in indexes:
            data = held["packets"].get(idx)
            if data is None:
                unknown.append(idx)
            elif now - held["sent"].get(idx, 0.0) < self._floor:
                waiting.append(idx)
            else:
                packets.append(data)
        return packets, waiting, unknown

    def stamp(self, group: int, indexes: list[int], now: float | None = None) -> None:
        """Start the 30 s floor on the packets that just went out again."""
        now = time.time() if now is None else now
        held = self._groups.get(group)
        if held is None:
            return
        for idx in indexes:
            if idx in held["packets"]:
                held["sent"][idx] = now

    def kind(self, group: int) -> str:
        """What sort of answer this group was, for the log's wording. The
        request does not carry it and the packets do not need it."""
        held = self._groups.get(group)
        return v5.TYPE_NAMES.get((held or {}).get("type"), "answer")

    def clear_floors(self) -> None:
        """Let every held packet be asked for again now. The packets stay:
        dropping them would close this gate, not open it."""
        for held in self._groups.values():
            held["sent"].clear()

    def status(self, now: float | None = None) -> dict:
        """What the portal's limits card shows: how much is held, how old the
        oldest answer is, and when the next resend is allowed."""
        now = time.time() if now is None else now
        self._expire(now)
        sent = [t for held in self._groups.values() for t in held["sent"].values()
                if now - t < self._floor]
        return {
            "groups": len(self._groups),
            "packets": sum(len(h["packets"]) for h in self._groups.values()),
            "oldest_age_s": int(now - min((h["at"] for h in self._groups.values()), default=now)),
            "waiting": len(sent),
            "opens_in_s": int(max((self._floor - (now - t) for t in sent), default=0)),
        }

    def _expire(self, now: float) -> None:
        for group in [g for g, h in self._groups.items() if now - h["at"] > self._seconds]:
            del self._groups[group]


class AppResponder:
    def __init__(self, store: WeatherStore, radio: MeshcoreRadio,
                 render_text: Callable[[str, str], str | None] | None = None,
                 ready: asyncio.Event | None = None):
        from meshcore_weather.schedule.scheduler import Scheduler
        self.store = store
        self.radio = radio
        # Set when the bot's product backlog is in. While it is not, requests
        # are answered Not available and the scheduler broadcasts nothing.
        self._ready = ready
        # The scheduler fills the cache as it stamps packets and hands them to
        # the radio, which is the only place a group is known (spec 12).
        self._parts = PartsCache()
        self._scheduler = Scheduler(store=store, radio=radio, ready=ready, parts=self._parts)
        self._render_text = render_text          # the text bot's renderer, for narrative products
        self._last_by_sender: dict[str, float] = {}
        # When each answer packet went out, the last hour of them. Unbounded:
        # the budget can be raised live, and a bounded deque would then stop
        # counting below it.
        self._sent: deque[float] = deque()
        self._busy_told: dict[str, float] = {}
        # When the last national Area sweep actually went on air, and whether
        # it carried advisories. Not when one was asked for: a sweep that was
        # built and never sent must not lock the next five minutes out (7C).
        self._last_sweep = 0.0
        self._last_sweep_advisories = False
        # state code -> (when a sweep last covered it, with advisories or not).
        # A national sweep covers every state; a scoped one covers its own.
        self._last_sweep_state: dict[str, tuple[float, bool]] = {}
        # (south, west, zoom, taken_min) -> when that radar tile last went on
        # air, as an answer or as the scheduled radar broadcast: one dict, the
        # scheduler's.
        self._last_radar: dict[tuple[int, int, int, int], float] = self._scheduler.radar_on_air
        # packet bytes -> (tile, picture, frame), from the thread that cut the
        # tile to the coroutine that sends it, for the audit line (radar/audit.py).
        self._radar_cut: dict[bytes, tuple] = {}

    @property
    def scheduler(self):
        return self._scheduler

    @property
    def coverage(self) -> Coverage:
        return self._scheduler.coverage

    def reload_coverage(self) -> None:
        self._scheduler.reload_coverage()

    async def start(self) -> None:
        await self._scheduler.start()

    async def stop(self) -> None:
        await self._scheduler.stop()

    # -- requests --

    @staticmethod
    def is_request(text: str) -> bool:
        return text.strip().startswith(">")

    async def handle_request(self, text: str, sender_key: str, ev: dict | None = None,
                             not_before: float = 0.0) -> str:
        """Answer one `>` request. Returns a short outcome for the log.
        Nothing goes out before `not_before` (time.monotonic; see
        main.reply_not_before)."""
        now = time.time()
        if now - self._last_by_sender.get(sender_key, 0.0) < settings.app_sender_gap_s:
            return "rate limited"
        while self._sent and now - self._sent[0] > 3600:
            self._sent.popleft()
        self._last_by_sender[sender_key] = now
        parts = text.strip()[1:].split(None, 1)
        cmd = (parts[0] if parts else "").lower()
        arg = parts[1].strip() if len(parts) > 1 else ""
        # A bot that has just restarted holds no products yet. Every answer
        # would be an empty one, and an app files "nothing active here" as the
        # truth, so it is told "no data yet" instead (reason 0, spec 9).
        # One 6-byte packet, off the hourly budget: the app's own retry a
        # minute later then still gets a real answer.
        if self._ready is not None and not self._ready.is_set():
            seq = b.SeqCounter()
            msg = b.not_available(seq.next(), self._scheduler.bot_id(), cmd, v5.REASON_NO_DATA)
            await self._scheduler.transmit([msg], f"not ready for {text.strip()[:24]!r}", not_before=not_before)
            return "starting up"
        # Before building: an answer that will not be sent must cost nothing
        # but the 6-byte "busy" that says so, which is off the budget. Until
        # 2026-10-01 this was silence, and an app waited on an answer that was
        # never coming. A radar refusal stays silent: reason 4 under `x` means
        # "this picture went out minutes ago", which would not be true.
        if len(self._sent) >= settings.app_packets_per_hour:
            logger.warning("App request budget spent this hour; %r told busy", text)
            if cmd == "radar" or now - self._busy_told.get(sender_key, 0.0) < BUSY_REPLY_PER_SENDER_S:
                return "hourly budget spent"
            self._busy_told[sender_key] = now
            if len(self._busy_told) > 500:
                self._busy_told = {k: v for k, v in self._busy_told.items() if now - v < BUSY_REPLY_PER_SENDER_S}
            msg = b.not_available(b.SeqCounter().next(), self._scheduler.bot_id(), cmd, v5.REASON_RATE_LIMITED)
            await self._scheduler.transmit([msg], f"busy for {text.strip()[:24]!r}", ev=ev, not_before=not_before)
            return "hourly budget spent, told busy"
        # Scratch numbering: Scheduler.transmit stamps the real seq on air.
        seq, bot = b.SeqCounter(), self._scheduler.bot_id()
        # `>part` sends bytes that already went out once, so it neither builds
        # an answer nor lets the stamping step touch `group`. It also has a
        # silence of its own (below), which `_answer` has no way to say.
        if cmd == "part":
            return await self._resend_parts(arg, seq, bot, now, ev, not_before)
        try:
            if cmd == "radar":
                # Decoding a GIF is a few hundred milliseconds on a Pi, which is
                # too long to keep the radio's loop waiting.
                msgs = await asyncio.get_running_loop().run_in_executor(
                    None, self._radar_answer, arg, seq, bot)
            else:
                msgs = self._answer(cmd, arg, seq, bot)
        except Exception:
            logger.exception("App request %r failed", text)
            msgs = [b.not_available(seq.next(), bot, cmd, v5.REASON_BOT_ERROR)]
        if not msgs:
            msgs = [b.not_available(seq.next(), bot, cmd, v5.REASON_NO_DATA)]
        n, nbytes = await self._scheduler.transmit(msgs, f"app request {text.strip()[:24]!r}", ev=ev,
                                                   not_before=not_before)
        self._sent.extend([now] * n)
        # The five-minute window starts when the sweep went out, so it is
        # stamped here and only when the radio took at least one packet. Only
        # `>wmap` starts it: a `>part` that happens to resend sweep packets is
        # not a new sweep, and the packets it resends carry a scope of their
        # own that says nothing about now.
        if n and cmd == "wmap" and msgs[0][3] >> 4 == v5.TYPE_AREA_SWEEP:
            self._stamp_sweep(v5.decode(msgs[0]))
        if cmd == "radar":
            # Every tile the radio took starts its own five minutes: a loop's
            # frames are pictures everyone listening now holds.
            for msg in msgs[:n]:
                if msg[3] >> 4 != v5.TYPE_RADAR:
                    continue
                self._stamp_radar(v5.decode(msg), now)
                cut = self._radar_cut.pop(msg, None)
                if cut is not None:
                    from meshcore_weather.radar import audit
                    audit.record(request=text, sender=sender_key, tile=cut[0], picture=cut[1],
                                 frame=cut[2], packet=msg, now=now)
        self._radar_cut.clear()
        return f"{n} packet(s), {nbytes} B"

    async def _resend_parts(self, arg: str, seq: b.SeqCounter, bot: int,
                            now: float, ev: dict | None, not_before: float = 0.0) -> str:
        """`>part <group> <idx>[,<idx>…]`: the named packets of a multi-packet
        answer again, identical but for a fresh `seq` (spec 12, revision 10).

        Three outcomes. Nothing held under that group, or none of the indexes
        in it: Not available, letter `p`, reason 0 — the phone should ask for
        the whole answer again. Every index held but inside its 30 s floor:
        silence, because another phone has just been sent those same bytes and
        this one is about to hear them. Otherwise the packets go out.
        """
        ask = b.parse_parts_request(arg)
        if ask is None:
            logger.info("Could not read a `>part` request: %r", arg)
            return await self._send_not_available(seq, bot, "p", v5.REASON_NO_DATA, now, ev, not_before)
        group, indexes = ask
        packets, waiting, unknown = self._parts.lookup(group, indexes)
        if not packets and not waiting:
            logger.info("`>part` for group %d: %s not held", group, unknown)
            return await self._send_not_available(seq, bot, "p", v5.REASON_NO_DATA, now, ev, not_before)
        if not packets:
            # Not an error: the answer is already on the air for everyone.
            logger.info("`>part` for group %d: %s resent inside the last %.0fs; sending nothing",
                        group, waiting, self._parts._floor)
            return "already resent"
        n, nbytes = await self._scheduler.transmit(
            packets,
            f"app request '>part {group} {','.join(str(i) for i in indexes)}'"
            f" ({self._parts.kind(group)})",
            ev=ev, keep_groups=True, not_before=not_before)
        self._sent.extend([now] * n)
        # Stamped once the radio took something, the way the sweep window is.
        # A batch the radio refused outright leaves the floor open, so the
        # phone's next ask is answered rather than met with silence.
        if n:
            self._parts.stamp(group, indexes)
        return f"{n} packet(s), {nbytes} B"

    async def _send_not_available(self, seq: b.SeqCounter, bot: int, letter: str,
                                  reason: int, now: float, ev: dict | None, not_before: float = 0.0) -> str:
        msg = b.not_available(seq.next(), bot, letter, reason)
        n, nbytes = await self._scheduler.transmit(
            [msg], f"not available for {letter!r}", ev=ev, not_before=not_before)
        self._sent.extend([now] * n)
        return f"{n} packet(s), {nbytes} B"

    # -- radar (spec 13) --

    @staticmethod
    def _radar_key(radar: dict) -> tuple[int, int, int, int]:
        return radar["south"], radar["west"], radar["zoom"], radar["taken_min"]

    def _stamp_radar(self, radar: dict, now: float) -> None:
        self._last_radar[self._radar_key(radar)] = now
        for key in [k for k, t in self._last_radar.items() if now - t > settings.radar_window_s]:
            del self._last_radar[key]

    def radar_cooldowns(self, now: float | None = None) -> list[dict]:
        """Tiles still inside their window, for the portal's limits card."""
        now = time.time() if now is None else now
        return [{"south": k[0], "west": k[1], "zoom": k[2], "taken_min": k[3],
                 "remaining_s": max(0, int(settings.radar_window_s - (now - t)))}
                for k, t in sorted(self._last_radar.items()) if now - t < settings.radar_window_s]

    def clear_radar_cooldowns(self) -> None:
        self._last_radar.clear()

    def _radar_answer(self, arg: str, seq: b.SeqCounter, bot: int) -> list[bytes]:
        """`>radar [place] [z<n>] [loop [HHMM ...]]`: one tile of the newest
        radar picture, or the last hour of it (spec 13, 13.5)."""
        from meshcore_weather.radar import service as radar_service
        radar = radar_service.shared()
        if not radar.available:
            return [b.not_available(seq.next(), bot, "radar", v5.REASON_UNSUPPORTED)]
        parsed = b.parse_radar_request(arg)
        if parsed is None:
            return [b.not_available(seq.next(), bot, "radar", v5.REASON_UNKNOWN_LOCATION)]
        place, zoom, held = parsed
        lat = lon = None
        if not place:
            home = self._scheduler.context().home
            if home is not None:
                lat, lon = home
        elif (coord := b.parse_latlon(place)) is not None:
            lat, lon = coord
        else:
            loc = resolver.resolve(place)
            if loc:
                lat, lon = loc.get("lat"), loc.get("lon")
        if lat is None or lon is None:
            return [b.not_available(seq.next(), bot, "radar", v5.REASON_UNKNOWN_LOCATION)]
        lat, lon = float(lat), float(lon)
        if held is None:
            found = radar.tile_for(lat, lon, zoom)
            frames = [found] if found is not None else []
        else:
            frames = radar.loop_for(lat, lon, zoom)
        if not frames:
            return [b.not_available(seq.next(), bot, "radar", v5.REASON_NO_DATA)]
        msgs, skipped = [], False
        for tile, picture, frame in frames:
            taken_min = int(picture.taken.timestamp() // 60)
            key = (tile.south, tile.west, tile.zoom, taken_min)
            if held is not None and taken_min % 1440 in held:
                skipped = True
                continue
            if time.time() - self._last_radar.get(key, 0.0) < settings.radar_window_s:
                logger.info("Radar tile %s asked for again inside the %.0fs window; left out",
                            key, settings.radar_window_s)
                skipped = True
                continue
            msg = b.radar_message(seq.next(), bot, tile, picture, frame)
            if msg is None:
                continue
            self._radar_cut[msg] = (tile, picture, frame)
            logger.info("Radar tile %d,%d z%d from %s taken %s: %d wet cells, %d B%s",
                        tile.south, tile.west, tile.zoom, frame.id, picture.taken.strftime("%H:%MZ"),
                        tile.wet, len(msg), " (coarse)" if msg[3] & v5.FLAG_RADAR_COARSE else "")
            msgs.append(msg)
        if msgs:
            return msgs
        return [b.not_available(seq.next(), bot, "radar",
                                v5.REASON_RATE_LIMITED if skipped else v5.REASON_NO_DATA)]

    def _stamp_sweep(self, sweep: dict) -> None:
        """Record what a sweep just covered, so the next request for the same
        ground inside five minutes is refused and one for other states is not.

        The states come from the packet itself rather than from the request:
        the bytes on the air are what other phones heard, which is what the
        cooldown is really about.
        """
        b.tables.load()
        at, advisories = time.time(), bool(sweep.get("advisories"))
        if sweep.get("scoped"):
            codes = [b.tables.states[i] for i in sweep.get("scope") or []
                     if i < len(b.tables.states)]
        else:
            codes = list(b.tables.states)
            self._last_sweep = at
            self._last_sweep_advisories = advisories
        for code in codes:
            self._last_sweep_state[code] = (at, advisories)

    def _sweep_is_cooling(self, states: list[str], advisories: bool, now: float) -> bool:
        """Was this ground covered in the last five minutes, at this level or
        a higher one? A national request asks about the country, so only a
        national sweep answers it: two scoped sweeps do not add up to one."""
        if not states:
            return (now - self._last_sweep < settings.sweep_window_s
                    and (self._last_sweep_advisories or not advisories))
        for code in states:
            at, had_advisories = self._last_sweep_state.get(code, (0.0, False))
            if now - at >= settings.sweep_window_s or (advisories and not had_advisories):
                return False        # this one has not been covered: build it
        return True

    def _answer(self, cmd: str, arg: str, seq: b.SeqCounter, bot: int) -> list[bytes]:
        ctx = self._scheduler.context()
        # Every message aggregated from many products states the store-wide
        # source; the ones built from a single product take that product's
        # own (spec 2.3).
        store_source = self.store.products_source()
        if cmd == "d":
            active = extract_active_warnings(self.store, coverage=self.coverage)
            return [b.digest_message(seq.next(), bot, active,
                                     b.feed_health(self.store, ctx.home_offices),
                                     source=store_source)]

        # `>cov` describes the bot itself, not a place, so coverage never
        # filters it and the answer is always one packet (spec 10).
        if cmd == "cov":
            msg = b.coverage_message(seq.next(), bot, self.coverage, ctx.home, ctx.radius_km)
            return [msg] if msg else []

        if cmd == "w":
            active = extract_active_warnings(self.store, coverage=None if arg else self.coverage)
            active = [w for w in active if b.warning_identity(w) is not None]
            # A watch can name more counties than one packet carries: the
            # ones asked about, or else the bot's own, are kept first.
            keep = self.coverage.zones | self.coverage.counties
            if arg:
                ident = b.parse_identity(arg)
                if ident is not None:
                    active = [w for w in active if b.warning_identity(w) == ident]
                else:
                    ugc = arg.upper()
                    if len(ugc) != 6:
                        return [b.not_available(seq.next(), bot, "w", v5.REASON_UNKNOWN_LOCATION)]
                    active = [w for w in active if ugc in (w.get("ugcs") or [])]
                    keep = {ugc}
                if not active:
                    return [b.not_available(seq.next(), bot, "w", v5.REASON_NO_DATA)]
            active.sort(key=lambda w: w.get("onset_unix_min") or 0, reverse=True)
            out = [m for w in active[:MAX_WARNINGS_PER_REQUEST]
                   if (m := b.warning_message(seq.next(), bot, w, update=True, keep=keep))]
            if not arg:
                out.append(b.digest_message(seq.next(), bot, active,
                                            b.feed_health(self.store, ctx.home_offices),
                                            source=store_source))
            return out

        # `>wmap [all] [states]`: the picture as an Area sweep (spec 12). Up to
        # eight packets in one answer, so it carries limits nothing else needs:
        # never scheduled, one sweep per state every 5 minutes across all
        # senders, and only started when the whole sweep still fits in the
        # hour's budget. A request inside either limit is answered with the
        # 6-byte Not available rather than silence, because this is the one
        # request an app is told to wait on. Coverage does not filter it: the
        # point is ground the bot does not itself cover.
        if cmd == "wmap":
            parsed = b.parse_sweep_request(arg)
            if parsed is None:
                logger.info("Could not read the states in `>wmap %s`", arg.strip())
                return [b.not_available(seq.next(), bot, cmd, v5.REASON_UNKNOWN_LOCATION)]
            advisories, states = parsed
            if self._sweep_is_cooling(states, advisories, time.time()):
                logger.info("Area sweep of %s asked for inside the %.0fs window; rate limited",
                            " ".join(states) or "the country", settings.sweep_window_s)
                return [b.not_available(seq.next(), bot, cmd, v5.REASON_RATE_LIMITED)]
            # A national sweep is eight packets until it is built, so it is
            # refused before the work; a scoped one is usually one or two, so
            # it is built first and measured against what the hour has left.
            if not states and len(self._sent) + v5.MAX_SWEEP_PACKETS > settings.app_packets_per_hour:
                logger.info("Area sweep needs %d packets and %d remain this hour; rate limited",
                            v5.MAX_SWEEP_PACKETS, settings.app_packets_per_hour - len(self._sent))
                return [b.not_available(seq.next(), bot, cmd, v5.REASON_RATE_LIMITED)]
            msgs = b.area_sweep_messages(seq, bot, self.store, advisories=advisories,
                                         states=states, source=store_source)
            if states and len(self._sent) + len(msgs) > settings.app_packets_per_hour:
                logger.info("Area sweep of %s is %d packets and %d remain this hour; rate limited",
                            " ".join(states), len(msgs), settings.app_packets_per_hour - len(self._sent))
                return [b.not_available(seq.next(), bot, cmd, v5.REASON_RATE_LIMITED)]
            return msgs

        if cmd == "wt":
            ident = b.parse_identity(arg)
            if ident is None:
                return [b.not_available(seq.next(), bot, "w", v5.REASON_UNKNOWN_LOCATION)]
            for w in extract_active_warnings(self.store, coverage=None):
                if b.warning_identity(w) == ident:
                    text = " ".join(x for x in (w.get("headline"), w.get("description")) if x)
                    return b.text_messages(seq, bot, v5.SUBJECT_WARNING,
                                           text or "No narrative available.",
                                           source=WeatherStore.product_source(w))
            return [b.not_available(seq.next(), bot, "w", v5.REASON_NO_DATA)]

        if cmd == "o":
            if arg:
                if b.tables.station(arg) is None:
                    return [b.not_available(seq.next(), bot, "o", v5.REASON_UNKNOWN_LOCATION)]
                # That station, or the nearest one within 40 km that reports.
                msg = b.station_obs_message(seq.next(), bot, self.store, arg)
                return [msg] if msg else []
            stations = b.coverage_stations(ctx.home, ctx.radius_km, self.store)
            msg = b.obs_message(seq.next(), bot, self.store, stations) if stations else None
            return [msg] if msg else []

        if cmd == "f":
            lat = lon = point = None
            if not arg and ctx.home is not None:
                lat, lon = ctx.home
            # `>f 35.687,-105.938`: a coordinate, answered through the same
            # path a resolved place takes, so a phone that knows of no bundled
            # point near it can still ask (spec 14, revision 10). `point`
            # stays None: the answer carries the bundle index of the point the
            # bot actually used, or 0xFFFF when it is not in the bundle.
            elif (coord := b.parse_latlon(arg)) is not None:
                lat, lon = coord
            elif arg.isdigit() and len(arg) <= 4:      # a point index; 5 digits is a ZIP
                b.tables.load()
                try:
                    point = int(arg)
                    p = b.tables.points[point]
                    lat, lon = p[2], p[3]
                except (IndexError, ValueError):
                    return [b.not_available(seq.next(), bot, "f", v5.REASON_UNKNOWN_LOCATION)]
            elif arg:
                loc = resolver.resolve(arg)
                if not loc:
                    return [b.not_available(seq.next(), bot, "f", v5.REASON_UNKNOWN_LOCATION)]
                lat, lon = loc.get("lat"), loc.get("lon")
            if lat is None:
                return [b.not_available(seq.next(), bot, "f", v5.REASON_UNKNOWN_LOCATION)]
            msg = b.forecast_message(seq.next(), bot, self.store, float(lat), float(lon), point=point)
            return [msg] if msg else []

        if cmd == "afd":
            wfo = (arg or "").upper() or next(iter(ctx.home_offices), "")
            prod = None
            for p in sorted(self.store._products.values(), key=lambda p: p.timestamp, reverse=True):
                if p.product_type == "AFD" and p.office == wfo:
                    prod = p
                    break
            if prod is None:
                return [b.not_available(seq.next(), bot, "a", v5.REASON_NO_DATA)]
            return b.text_messages(seq, bot, v5.SUBJECT_AFD, _afd_body(prod.raw_text),
                                   source=self.store.product_source(prod))

        if cmd in ("metar", "taf"):
            return self._station_report(cmd, arg, seq, bot, ctx.home, store_source)

        if cmd == "hwo":
            from meshcore_weather.core import services
            loc = resolver.resolve(arg) if arg else (resolver.resolve_by_coords(*ctx.home) if ctx.home else None)
            if not loc:
                return [b.not_available(seq.next(), bot, cmd, v5.REASON_UNKNOWN_LOCATION)]
            ol = services.outlook_for(self.store, loc)
            # `Outlook` holds the product, not its text: reading `ol.raw_text`
            # here meant every `>hwo` fell through to Not available, however
            # many outlooks the store held.
            text = ol.summary_text() if ol else None
            if not text:
                return [b.not_available(seq.next(), bot, cmd, v5.REASON_NO_DATA)]
            return b.text_messages(seq, bot, v5.SUBJECT_HWO, text,
                                   source=self.store.product_source(ol.product))

        # `>sat` is always Text, "not reporting" included: that is the answer.
        if cmd in ("space", "storm", "rain", "sat"):
            subject = {"space": v5.SUBJECT_SPACE, "storm": v5.SUBJECT_STORM_REPORTS,
                       "rain": v5.SUBJECT_RAINFALL, "sat": v5.SUBJECT_GENERAL}[cmd]
            text = self._render_text(cmd, arg) if self._render_text else None
            # `>sat` describes the bot's own receiver, not a weather product,
            # so it states no source (spec 2.3).
            source = v5.SOURCE_UNSTATED if cmd == "sat" else store_source
            return b.text_messages(seq, bot, subject, text, source=source) if text else []

        return [b.not_available(seq.next(), bot, cmd, v5.REASON_UNSUPPORTED)]

    def _station_report(self, cmd: str, arg: str, seq: b.SeqCounter, bot: int,
                        home: tuple[float, float] | None,
                        source: int = v5.SOURCE_UNSTATED) -> list[bytes]:
        """`>metar` / `>taf`. A request that names a station gets that
        station's own report, starting `METAR <ICAO>` / `TAF <ICAO>`, or Not
        available: the app files the text under the ICAO it asked for, so a
        neighbour's report would land on the wrong airport. A place or ZIP gets
        the nearest reporting station, labelled with its ICAO and distance.

        `source` is the store-wide one: a METAR line is pulled out of a
        collective by text and the record does not carry its product back
        here, so the honest statement is the one about the bot's feed
        (spec 2.3)."""
        from meshcore_weather.core import render_text, services
        icao = arg.upper()
        resolver.load()
        if len(icao) == 4 and icao.isalnum() and (b.tables.station(icao) is not None or icao in resolver._stations):
            if cmd == "metar":
                raw = self.store._find_metar_raw(icao)
                fresh = raw and datetime.now(timezone.utc) - raw[1] <= timedelta(minutes=b.OBS_MAX_AGE_MIN)
                text = f"METAR {raw[0]}" if fresh else None
            else:
                text = services.station_taf(self.store, icao)
            if not text:
                return [b.not_available(seq.next(), bot, cmd, v5.REASON_NO_DATA)]
            return b.text_messages(seq, bot, v5.SUBJECT_METAR, text, source=source)
        loc = resolver.resolve(arg) if arg else (resolver.resolve_by_coords(*home) if home else None)
        if not loc:
            return [b.not_available(seq.next(), bot, cmd, v5.REASON_UNKNOWN_LOCATION)]
        if cmd == "metar":
            found = services.raw_metar_for(self.store, loc)
            text = render_text.raw_metar(loc, found) if found else None
        else:
            tf = services.taf_for(self.store, loc)
            text = render_text.taf(loc, tf) if tf else None
            if tf is not None:
                source = self.store.product_source(tf.product)   # this one does carry it
        return b.text_messages(seq, bot, v5.SUBJECT_METAR, text, source=source) if text else []


def _afd_body(raw: str, limit: int = 4000) -> str:
    """The forecast discussion without its product header.

    This does not cut for the air. It used to stop at 1200 characters, which
    landed mid-word as often as not; `v5_builders.text_messages` now trims at
    a sentence and flags the reply as cut, which is the honest version of the
    same thing. `limit` only bounds the work for a runaway product.
    """
    lines = raw.splitlines()
    start = 0
    for i, line in enumerate(lines[:30]):
        if line.strip().startswith(".") and "DISCUSSION" not in line.upper():
            start = i
            break
    body = " ".join(l.strip() for l in lines[start:] if l.strip() and not l.strip().startswith("$$"))
    return body[:limit]
