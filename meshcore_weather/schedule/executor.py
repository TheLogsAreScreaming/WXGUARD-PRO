"""Job → v5 messages.

The scheduler decides when a job is due; this module decides what it
sends. State that must survive between runs (which warnings were sent
with which fingerprint, pending life-safety repeats) lives in the
ExecutorContext the scheduler owns and persists.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from meshcore_weather.config import settings
from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol.coverage import Coverage
from meshcore_weather.protocol.warnings import extract_active_warnings
from meshcore_weather.schedule.models import BroadcastJob

logger = logging.getLogger(__name__)

REPEAT_AFTER_S = 90          # life-safety warnings go out once more after this
RADAR_LOOK_AGAIN_S = 60      # radar with no new picture yet: look again after this


@dataclass
class ExecutorContext:
    store: WeatherStore
    coverage: Coverage
    seq: b.SeqCounter              # provisional numbers: Scheduler.transmit stamps the seq on air
    bot: int
    # identity string -> {"fp": [...], "expires": min, "event": code, "sent_at": t, "repeat_at": t|None}
    warning_state: dict[str, dict] = field(default_factory=dict)
    home: tuple[float, float] | None = None
    radius_km: float = 0.0
    home_offices: set[str] = field(default_factory=set)
    # set by the warnings builder when a cancel went out: the scheduler
    # sends a digest a minute later
    cancel_sent: bool = False
    # Packets the scheduled-transmission ceiling still allows this hour (the
    # scheduler sets it before the warnings job; None = no ceiling). Life-
    # safety warnings and their repeat go out whatever it says; anything else
    # past it is held back, with its state untouched, for a later tick.
    budget: int | None = None
    held_back: int = 0
    # Why the last job sent nothing, in words for the portal, and what a job
    # that sent something saw (the scheduler clears both before each job).
    reason: str | None = None
    note: str | None = None
    # A job with nothing yet that should be looked at again in this many
    # seconds without counting as a run (radar waiting for a new picture);
    # `quiet` leaves its last result as it was; `idle` says the weather, not
    # something wrong, is why nothing went (radar over a dry area).
    retry_in_s: float | None = None
    quiet: bool = False
    idle: bool = False
    # Send what there is (the portal's Send now), whatever the weather.
    force: bool = False
    # Radar, both owned by the scheduler: what the radar job last judged
    # ({"judged": taken_min, "wet": bool}), and when each tile last went on
    # air, keyed (south, west, zoom, taken_min), which the `>radar` answers share.
    radar_state: dict = field(default_factory=dict)
    radar_on_air: dict = field(default_factory=dict)
    # Set by the radar job when it builds a packet: what to record once the
    # radio takes it. `radar_info` describes the tile, for the portal.
    radar_sent: dict | None = None
    radar_info: dict | None = None


def area_blocked(job: BroadcastJob, ctx: ExecutorContext) -> bool:
    """Coverage fails closed: with a blocked coverage (configuration errors,
    or nothing configured without MCW_COVERAGE=national) the area jobs send
    nothing. The scheduler logs why, once an hour."""
    reason = getattr(ctx.coverage, "blocked", None)
    if reason:
        logger.debug("job %s: nothing sent, coverage blocked (%s)", job.id, reason)
        ctx.reason = f"coverage is not set up: {reason}"
        return True
    return False


def _fp_list(w: dict) -> list:
    return [list(x) if isinstance(x, tuple) else x for x in b.warning_fingerprint(w)]


def _code(w: dict) -> str:
    return w.get("vtec_phenomenon", "") + "." + (w.get("vtec_significance") or "")


def _build_warnings(job: BroadcastJob, ctx: ExecutorContext) -> list[bytes]:
    """New and materially changed warnings, cancels for the ones that
    ended early, and the one repeat life-safety warnings get.

    Under the scheduled-transmission ceiling (`ctx.budget`): tornado, severe
    thunderstorm, flash flood and extreme wind warnings (new, changed, and
    their repeat) always go; the rest go while the budget lasts, in the
    usual order, and what does not fit keeps its state so the next tick
    tries it again."""
    if area_blocked(job, ctx):
        return []
    now = time.time()
    active = [w for w in extract_active_warnings(ctx.store, coverage=ctx.coverage)
              if b.warning_identity(w) is not None]
    keep = ctx.coverage.zones | ctx.coverage.counties   # cut a long area list to these first
    # What would go out, in order: (protected, kind, key, warning, state, fingerprint)
    plans: list[tuple] = []
    seen: set[str] = set()
    for w in active:
        ident = b.warning_identity(w)
        key = b.identity_str(ident)
        seen.add(key)
        fp = _fp_list(w)
        st = ctx.warning_state.get(key)
        protected = _code(w) in b.LIFE_SAFETY
        if st is not None and st.get("fp") == fp:
            if st.get("repeat_at") and now >= st["repeat_at"]:
                plans.append((True, "repeat", key, w, st, fp))   # only life-safety warnings are repeated
            continue
        plans.append((protected, "update" if st is not None else "new", key, w, st, fp))
    # Ended early: still had time left but is no longer active.
    for key in list(ctx.warning_state):
        if key in seen:
            continue
        st = ctx.warning_state[key]
        if st.get("expires", 0) - b.now_min() > 5:
            plans.append((False, "cancel", key, None, st, None))
        else:
            ctx.warning_state.pop(key)              # ran out on its own: nothing to say
    allowed = len(plans)
    if ctx.budget is not None:
        room = ctx.budget - sum(1 for p in plans if p[0])
        allowed_set = set()
        for i, p in enumerate(plans):
            if p[0]:
                allowed_set.add(i)
            elif room > 0:
                allowed_set.add(i)
                room -= 1
        held = len(plans) - len(allowed_set)
        if held:
            ctx.held_back += held
            logger.info("Warnings: %d held back by the scheduled-transmission ceiling", held)
    else:
        allowed_set = set(range(allowed))
    out: list[bytes] = []
    for i, (_protected, kind, key, w, st, fp) in enumerate(plans):
        if i not in allowed_set:
            continue
        if kind == "repeat":
            msg = b.warning_message(ctx.seq.next(), ctx.bot, w, update=False, keep=keep)
            if msg:
                out.append(msg)
                logger.info("Warning %s: life-safety repeat", key)
            st["repeat_at"] = None
        elif kind == "cancel":
            ctx.warning_state.pop(key, None)
            out.append(b.cancel_message(ctx.seq.next(), ctx.bot, (st["event"], st["office"], st["etn"])))
            ctx.cancel_sent = True
            logger.info("Warning %s: cancelled before expiry", key)
        else:
            msg = b.warning_message(ctx.seq.next(), ctx.bot, w, update=st is not None, keep=keep)
            if msg is None:
                continue
            out.append(msg)
            ident = b.warning_identity(w)
            ctx.warning_state[key] = {
                "fp": fp, "expires": b.expires_min(w), "event": ident[0], "office": ident[1], "etn": ident[2],
                "sent_at": now,
                "repeat_at": now + REPEAT_AFTER_S if (_code(w) in b.LIFE_SAFETY and st is None) else None,
            }
            logger.info("Warning %s: %s (%d B)", key, kind, len(msg))
    if not out and not ctx.held_back:
        ctx.reason = "no new or changed warnings" if active else "no warnings active in coverage"
    return out


def _build_digest(job: BroadcastJob, ctx: ExecutorContext) -> list[bytes]:
    if area_blocked(job, ctx):
        return []
    active = extract_active_warnings(ctx.store, coverage=ctx.coverage)
    health = b.feed_health(ctx.store, ctx.home_offices)
    # Aggregated from many products, so it states the store-wide source
    # (spec 2.3). Warnings, observations and forecasts take theirs from the
    # products they were built from, inside the builders.
    return [b.digest_message(ctx.seq.next(), ctx.bot, active, health,
                             source=ctx.store.products_source())]


def _build_observations(job: BroadcastJob, ctx: ExecutorContext) -> list[bytes]:
    if area_blocked(job, ctx):
        return []
    if job.location_type == "station":
        icao = job.location_id.strip().upper()
        if b.tables.station(icao) is None:
            ctx.reason = f"{icao or 'the station'} is not a station apps know"
            return []
        stations = [icao]
    elif ctx.home is None:
        ctx.reason = "the bot has no home point (set the home city in Settings)"
        return []
    else:
        stations = b.coverage_stations(ctx.home, ctx.radius_km, ctx.store)
        if not stations:
            ctx.reason = f"no station within {ctx.radius_km:g} km of home reported in the last 2 hours"
            return []
    msg = b.obs_message(ctx.seq.next(), ctx.bot, ctx.store, stations)
    if not msg:
        ctx.reason = f"{stations[0]} has no report from the last 2 hours" if job.location_type == "station" \
            else "no report could be encoded"
        return []
    return [msg]


def _is_home(location_id: str) -> bool:
    """`home`: the first MCW_HOME_CITIES entry, resolved when the job runs
    (schedule/store.py writes the default forecast job this way)."""
    return location_id.strip().lower() == "home"


def _build_forecast(job: BroadcastJob, ctx: ExecutorContext) -> list[bytes]:
    lat = lon = point = None
    place = job.location_id.strip()
    if job.location_type == "pfm_point":
        b.tables.load()
        try:
            point = int(place)
            if point < 0:
                raise IndexError
            p = b.tables.points[point]
            lat, lon = p[2], p[3]
        except (ValueError, IndexError):
            ctx.reason = f"forecast point {place!r} is not in the bundle"
            return []
    elif job.location_type == "city" and place and not _is_home(place):
        coord = b.parse_latlon(place)
        if coord:
            lat, lon = coord
        else:
            loc = resolver.resolve(place)
            if not loc:
                ctx.reason = f"no place called {place!r}"
                return []
            lat, lon = loc.get("lat"), loc.get("lon")
    elif ctx.home is not None:
        lat, lon = ctx.home
        place = "home"
    if lat is None or lon is None:
        ctx.reason = "the bot has no home point (set the home city in Settings)"
        return []
    msg = b.forecast_message(ctx.seq.next(), ctx.bot, ctx.store, float(lat), float(lon), point=point)
    if not msg:
        ctx.reason = f"no forecast within 80 km of {place} in the feed yet"
        return []
    return [msg]


def _build_coverage(job: BroadcastJob, ctx: ExecutorContext) -> list[bytes]:
    """One packet stating what this bot carries. Broadcast so an app never has
    to guess the bot's area from the stations and warnings it happens to have
    heard: that guess told a real phone WX-AUS might not carry alerts for its
    own home county (spec 10). Not while the coverage is blocked: it would
    state an area the bot is not serving."""
    if area_blocked(job, ctx):
        return []
    msg = b.coverage_message(ctx.seq.next(), ctx.bot, ctx.coverage, ctx.home, ctx.radius_km)
    if not msg:
        ctx.reason = "the bot states neither a centre nor a zone"
        return []
    return [msg]


def _build_radar(job: BroadcastJob, ctx: ExecutorContext) -> list[bytes]:
    """The radar tile over the coverage (spec 15): each new picture while
    there is precipitation within the job's distance of home, one more when it
    has gone, and nothing while it stays dry. Until there is a picture it has
    not judged it looks again every minute, so a picture goes out within a
    minute of reaching the bot."""
    from meshcore_weather.radar import area
    from meshcore_weather.radar import service as radar_service
    if area_blocked(job, ctx):
        return []
    if ctx.home is None:
        ctx.reason = "the bot has no home point (set the home city in Settings)"
        return []
    km = float(job.within_km or ctx.radius_km or 0)
    if km <= 0:
        ctx.reason = "no distance from home is set"
        return []
    where = area.area_tile(ctx.home[0], ctx.home[1], km)
    if where is None:
        ctx.reason = f"no radar tile holds {km:g} km around home"
        return []
    ctx.radar_info = {"tile": area.describe_tile(*where)}
    radar = radar_service.shared()
    if not radar.available:
        ctx.reason = "the bot has no radar pictures: they come down the satellite dish"
        return []
    found = radar.tile_at(*where)
    if found is None:
        ctx.reason = "no radar picture of the area from the last hour"
        ctx.retry_in_s = RADAR_LOOK_AGAIN_S
        return []
    tile, picture, frame = found
    taken = int(picture.taken.timestamp() // 60)
    at = picture.taken.strftime("%H:%MZ")
    ctx.radar_info.update(picture=frame.name, taken=at)
    state = ctx.radar_state
    level = job.min_level or 1
    seen = area.judge(tile, ctx.home[0], ctx.home[1], km, level)
    wet = seen["cells"] > 0
    key = (tile.south, tile.west, tile.zoom, taken)
    on_air = time.time() - ctx.radar_on_air.get(key, 0.0) < settings.radar_window_s
    if not ctx.force:
        if taken <= state.get("judged", -1):
            ctx.retry_in_s, ctx.quiet = RADAR_LOOK_AGAIN_S, True
            return []
        dry = (f"{area.RADAR_DRY[level]} within {km:g} km of home on the {at} picture" if seen["known"]
               else f"the {at} picture does not reach home")
        if not wet and not state.get("wet"):
            state["judged"] = taken
            ctx.reason, ctx.retry_in_s, ctx.idle = dry, RADAR_LOOK_AGAIN_S, bool(seen["known"])
            return []
        if on_air:
            # A `>radar` answer put this very picture on the air minutes ago.
            state.update(judged=taken, wet=wet)
            ctx.reason, ctx.retry_in_s = f"the {at} picture went out as an answer just now", RADAR_LOOK_AGAIN_S
            ctx.idle = True
            return []
    elif on_air:
        ctx.reason = f"the {at} picture went out in the last {settings.radar_window_s // 60 or 1} min"
        return []
    msg = b.radar_message(ctx.seq.next(), ctx.bot, tile, picture, frame)
    if msg is None:
        ctx.reason = f"the {at} picture holds too little of the area to send"
        ctx.retry_in_s = RADAR_LOOK_AGAIN_S
        return []
    ctx.radar_info["now"] = area.in_words(seen, km, level) if wet else "no precipitation left in the area"
    ctx.note = f"{ctx.radar_info['now']} ({at} picture)"
    ctx.radar_sent = {"key": key, "judged": taken, "wet": wet, "cut": (tile, picture, frame)}
    return [msg]


PRODUCT_BUILDERS = {
    "warnings": _build_warnings,
    "digest": _build_digest,
    "observations": _build_observations,
    "forecast": _build_forecast,
    "coverage": _build_coverage,
    "radar": _build_radar,
}


class BroadcastExecutor:
    def run_job(self, job: BroadcastJob, ctx: ExecutorContext) -> list[bytes]:
        builder = PRODUCT_BUILDERS.get(job.product)
        if builder is None:
            logger.warning("job %s: unknown product %r", job.id, job.product)
            return []
        return builder(job, ctx)
