"""JSON routes: the EMWIN product browser, the broadcast log and its
counters, the bot's channel names, and the broadcast schedule (CRUD, run now)."""

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from meshcore_weather.activity import activity_log
from meshcore_weather.portal.sse import sse_response
from meshcore_weather.schedule.models import (
    BUILTIN_IDS,
    DEFAULT_INTERVAL,
    INTERVAL_CHOICES,
    BroadcastJob,
    LOCATION_TYPES,
    PRODUCT_TYPES,
    RADAR_LEVELS,
    is_builtin,
)

router = APIRouter()


def _get_scheduler(request: Request):
    """Return the bot's active Scheduler instance or raise 503."""
    bot = request.app.state.bot
    broadcaster = getattr(bot, "_broadcaster", None)
    if broadcaster is None or not hasattr(broadcaster, "scheduler"):
        raise HTTPException(503, "broadcasts are off: no data channel configured")
    return broadcaster.scheduler


# -- EMWIN product browser --

@router.get("/products/filters")
async def product_filters(request: Request) -> JSONResponse:
    """Return distinct filter values for the product browser dropdowns."""
    bot = request.app.state.bot
    types = sorted({p.product_type for p in bot.store._products.values()})
    offices = sorted({p.office for p in bot.store._products.values() if p.office})
    states = sorted({p.state for p in bot.store._products.values() if p.state})
    return JSONResponse({"types": types, "offices": offices, "states": states})


@router.get("/products")
async def list_products(
    request: Request,
    type: str = Query(""),
    office: str = Query(""),
    state: str = Query(""),
    q: str = Query(""),
    limit: int = Query(100, ge=1, le=500),
) -> JSONResponse:
    """List ingested EMWIN products with optional filters."""
    bot = request.app.state.bot
    results = []
    q_lower = q.lower().strip()

    for prod in sorted(bot.store._products.values(), key=lambda p: p.timestamp, reverse=True):
        if type and prod.product_type != type:
            continue
        if office and prod.office != office:
            continue
        if state and prod.state != state:
            continue
        if q_lower and q_lower not in prod.raw_text.lower():
            continue
        preview = ""
        for line in prod.raw_text.splitlines():
            line = line.strip()
            if line and not line.startswith("$$"):
                preview = line[:120]
                break
        results.append({
            "filename": prod.filename,
            "emwin_id": prod.emwin_id,
            "product_type": prod.product_type,
            "office": prod.office,
            "state": prod.state,
            "timestamp": prod.timestamp.isoformat(),
            "preview": preview,
        })
        if len(results) >= limit:
            break

    return JSONResponse({"products": results, "count": len(results), "limit": limit})


@router.get("/products/{filename}")
async def get_product(request: Request, filename: str) -> JSONResponse:
    """Get the full raw text of a specific product."""
    bot = request.app.state.bot
    prod = bot.store._products.get(filename)
    if not prod:
        raise HTTPException(404, "Product not found")
    return JSONResponse({
        "filename": prod.filename,
        "emwin_id": prod.emwin_id,
        "product_type": prod.product_type,
        "office": prod.office,
        "state": prod.state,
        "timestamp": prod.timestamp.isoformat(),
        "raw_text": prod.raw_text,
    })


# -- Broadcast log (binary side: jobs, app requests, beacons) --

@router.get("/activity")
async def get_activity(
    limit: int = Query(100, ge=1, le=500),
) -> JSONResponse:
    """Return the most recent broadcast-log entries."""
    return JSONResponse({"events": activity_log.recent(limit)})


@router.get("/activity/stream")
async def activity_stream():
    """SSE stream of broadcast-log entries as they happen."""
    async def items():
        async for event in activity_log.subscribe():
            yield event.to_dict()
    return sse_response(items())


@router.get("/stats")
async def get_stats() -> JSONResponse:
    """Messages and bytes sent on the data channel over the standard windows."""
    return JSONResponse({"stats": [activity_log.stats(w) for w in (5, 15, 60, 360, 1440)]})


# -- Channel names --

@router.post("/settings/channels")
async def set_channels(request: Request) -> JSONResponse:
    """Change the bot's text and data channel names.

    Applied live when the radio is up (the slot is renamed in place, or an
    existing slot with that name is reused, or a free slot is created),
    kept in memory otherwise so the next radio connect uses them, and
    persisted to .env either way.

    The two roles may name the same channel — in v5 they do: one #meshwx
    slot carries the text conversation and the binary datagrams.
    """
    from meshcore_weather.config import settings
    from meshcore_weather.portal.routes.admin import _write_env

    body = await request.json()
    body.pop("discover_channel", None)   # accepted and ignored: the discovery channel is gone
    wanted = {
        "text": body.get("text_channel", "").strip(),
        "data": body.get("data_channel", "").strip(),
    }
    if not wanted["text"]:
        raise HTTPException(400, "text_channel is required")
    for role, val in wanted.items():
        if val and not val.startswith("#") and not val.isdigit():
            raise HTTPException(400, f"{role} channel must start with '#' or be a numeric index")

    bot = request.app.state.bot
    radio = bot.radio
    applied: dict[str, int | None] = {}
    if radio.connected:
        for role in ("text", "data"):
            try:
                applied[role] = await radio.assign_role(role, wanted[role])
            except ValueError as e:
                raise HTTPException(400, str(e))
            except Exception as e:
                raise HTTPException(500, f"radio error on {role} channel: {e}")
        # A data channel that appeared just now needs the broadcaster started.
        if applied.get("data") is not None and bot._broadcaster is None:
            await bot._after_radio_connected()
    else:
        settings.meshcore_channel = wanted["text"]
        settings.meshwx_channel = wanted["data"]

    _write_env({
        "MCW_MESHCORE_CHANNEL": wanted["text"],
        "MCW_MESHWX_CHANNEL": wanted["data"],
    })
    return JSONResponse({
        "ok": True,
        "applied": radio.connected,
        "slots": applied if radio.connected else None,
        "text_channel": wanted["text"], "data_channel": wanted["data"],
        "note": "Applied on the node now" if radio.connected else "Saved; applied when the radio connects",
    })


# -- Broadcast schedule --

@router.post("/actions/broadcast")
async def run_due_jobs(request: Request) -> JSONResponse:
    """Run every enabled job whose interval has elapsed. A job that is not
    due sends nothing; use /schedule/jobs/{id}/run-now to force one."""
    scheduler = _get_scheduler(request)
    sent = await scheduler.tick()
    return JSONResponse({"ok": True, "messages_sent": sent})


# What each product is and which location types its builder understands
# (schedule/executor.py). Every PRODUCT_TYPES entry must appear here.
PRODUCT_INFO = {
    "warnings":     {"label": "Warnings",      "desc": "Every active warning in coverage, sent when it appears or materially changes, with cancels; life-safety warnings once more about two minutes later", "locations": ["coverage"]},
    "digest":       {"label": "Digest",        "desc": "The list of active warnings and their expiry, so apps can recover what they missed", "locations": ["coverage"]},
    "observations": {"label": "Observations",  "desc": "Current conditions for the stations around home in one packet, or one station", "locations": ["coverage", "station"]},
    "forecast":     {"label": "Forecast",      "desc": "Seven-day point forecast for home or another place", "locations": ["city", "pfm_point", "coverage"]},
    "coverage":     {"label": "Coverage",      "desc": "What this bot covers: centre, radius, NWS offices and zones, so apps never guess its area", "locations": ["coverage"]},
    "radar":        {"label": "Radar",         "desc": "The radar tile over the area at each new picture while there is precipitation in it, and once more when it clears", "locations": ["coverage"]},
}

LOCATION_INFO = {
    "coverage":  {"label": "Coverage area", "desc": "The bot's own area, around its home point"},
    "city":      {"label": "Place",         "desc": "A city and state, ZIP code or lat,lon, resolved when the job runs"},
    "station":   {"label": "Station",       "desc": "One airport by its ICAO code"},
    "pfm_point": {"label": "Forecast point", "desc": "An index into the bundle's forecast points"},
}

# What an operator can add. The five built-in broadcasts are already there.
ADD_KINDS = {
    "forecast": {"label": "Forecast for a place", "product": "forecast", "location_type": "city",
                 "field": "Place", "placeholder": "City and state, ZIP code, or lat,lon",
                 "desc": "Seven days of forecast for one more place, besides home."},
    "station":  {"label": "Observations from one airport", "product": "observations", "location_type": "station",
                 "field": "Airport", "placeholder": "4-letter ICAO code",
                 "desc": "One airport's current conditions in a packet of its own, for a station outside the hourly batch."},
    "radar":    {"label": "Radar while there is precipitation", "product": "radar", "location_type": "coverage",
                 "desc": "The radar tile over your area, one packet per picture while there is precipitation near home, "
                         "and one more when it clears. Nothing while it is dry."},
}


@router.get("/schedule/meta")
async def schedule_meta() -> JSONResponse:
    """Metadata for the broadcast forms: what can be added, the interval
    choices per product, and labels for every product and location."""
    return JSONResponse({
        "products": sorted(PRODUCT_TYPES),
        "location_types": sorted(LOCATION_TYPES),
        "product_info": PRODUCT_INFO,
        "location_info": LOCATION_INFO,
        "kinds": ADD_KINDS,
        "interval_choices": {k: list(v) for k, v in INTERVAL_CHOICES.items()},
        "default_interval": DEFAULT_INTERVAL,
        "radar_levels": RADAR_LEVELS,
        "radius_km": _radius_km(),
    })


def _radius_km() -> int:
    from meshcore_weather.config import settings
    return int(settings.home_radius_km or 0)


def _home_name() -> str:
    from meshcore_weather.config import settings
    return (settings.home_cities or "").split(",")[0].strip()


def _station_name(icao: str) -> str:
    """`KDFW Dallas/Ft Worth International AP, TX`, cased as the bot's replies are."""
    from meshcore_weather.geodata import resolver
    from meshcore_weather.geodata.names import title_case
    resolver.load()
    st = resolver._stations.get(icao) or {}
    name = title_case(st.get("n") or "")
    if name.endswith(" Ap"):                         # "...INTERNATIONAL AP": the airport, not a word
        name = name[:-3] + " AP"
    return f"{icao} {name}, {st['s']}" if name and st.get("s") else f"{icao} {name}".strip()


def _describe(job: BroadcastJob, store, others: list[BroadcastJob], check: bool = True) -> dict:
    """What a job's location means in words, and what is wrong with it.

    `errors` stop a save; `notes` are worth knowing but the job can still be
    saved (a station that is quiet today, a forecast the feed has not brought
    yet). `check` looks the place up in the feed too; the job list skips it."""
    from meshcore_weather.config import settings
    from meshcore_weather.core import services
    from meshcore_weather.geodata import resolver
    from meshcore_weather.protocol import v5_builders as b
    errors: list[str] = []
    notes: list[str] = []
    label = LOCATION_INFO.get(job.location_type, {}).get("label", job.location_type)
    loc = job.location_id.strip()
    if job.product == "observations" and job.location_type == "coverage":
        label = f"Stations within {float(settings.home_radius_km or 0):g} km of home"
    if job.product == "radar":
        _describe_radar(job, check, errors, notes)
        km = job.within_km or _radius_km()
        label = f"{RADAR_LEVELS[job.min_level or 1]} within {km} km of home"
        if any(o.product == "radar" for o in others):
            errors.append("There is already a radar broadcast. Edit that one.")
    if job.product == "forecast":
        lat = lon = None
        if job.location_type == "pfm_point":
            b.tables.load()
            try:
                i = int(loc)
                if i < 0:
                    raise IndexError
                p = b.tables.points[i]
                label, lat, lon = f"{p[0]} (forecast point {i})", p[2], p[3]
            except (ValueError, IndexError):
                errors.append(f"Forecast point {loc!r} is not in the bundle.")
        elif job.location_type == "coverage" or loc.lower() == "home":
            home = _home_name()
            label = f"Home ({home})" if home else "Home"
            if not home:
                errors.append("The bot has no home city. Set one in Settings first.")
        elif not loc:
            errors.append("Name a place.")
        else:
            coord = b.parse_latlon(loc)
            if coord:
                lat, lon = coord
                label = f"{lat:.3f}, {lon:.3f}"
            else:
                found = resolver.resolve(loc)
                if not found:
                    errors.append(f"No place called {loc!r}. Try a city and state, a ZIP code or lat,lon.")
                else:
                    lat, lon, label = found.get("lat"), found.get("lon"), found.get("name") or loc
        if check and lat is not None and lon is not None and store is not None:
            near = services.nearest_pfm_point(store, float(lat), float(lon))
            if near is None:
                notes.append("The feed has no forecast within 80 km of it yet; nothing goes out until it does.")
            else:
                pt, _prod, km = near
                i = b.tables.point_index(pt.lat, pt.lon, name=pt.name)
                where = b.tables.points[i][0] if i != 0xFFFF else pt.name
                notes.append(f"Forecast from {where}, {km:.0f} km away.")
    elif job.product == "observations" and job.location_type == "station":
        icao = loc.upper()
        if b.tables.station(icao) is None:
            errors.append(f"{icao or 'That'} is not a station apps know. Use the airport's 4-letter ICAO code.")
        else:
            label = _station_name(icao)
            raw = store._find_metar_raw(icao) if (check and store is not None) else None
            from datetime import datetime, timezone
            if check and (not raw or (datetime.now(timezone.utc) - raw[1]).total_seconds() > 7200):
                notes.append(f"{icao} has no report from the last 2 hours; nothing goes out until it reports.")
            if check and store is not None and icao in b.coverage_stations(
                    resolver.home(), float(settings.home_radius_km or 0), store):
                notes.append(f"{icao} is already in the hourly observations batch.")
    for o in others:
        if (o.product == job.product and o.location_type == job.location_type
                and o.location_id.strip().lower() == loc.lower() and job.location_type != "coverage"):
            errors.append(f"There is already a broadcast for this: {o.name}.")
            break
    return {"label": label, "errors": errors, "notes": notes}


def _describe_radar(job: BroadcastJob, check: bool, errors: list[str], notes: list[str]) -> None:
    from meshcore_weather.geodata import resolver
    from meshcore_weather.radar import area
    from meshcore_weather.radar import service as radar_service
    home = resolver.home()
    km = job.within_km or _radius_km()
    if home is None:
        errors.append("The bot has no home city. Set one in Settings first.")
        return
    if km <= 0:
        errors.append("Give a distance from home.")
        return
    where = area.area_tile(home[0], home[1], km)
    if where is None:
        errors.append(f"No radar tile holds {km} km around home. Choose a shorter distance.")
        return
    if check:
        if not radar_service.shared().available:
            errors.append("This bot has no radar pictures: they come down the satellite dish, and it has none.")
            return
        notes.append(f"{area.describe_tile(*where)}. One packet per picture, at most 157 B.")


def _airtime_ms(data_len: int, sf: int = 7, bw_khz: float = 62.5, cr: int = 5) -> float:
    """Time on air for one MeshWX packet, RadioLib's LoRa formula with
    MeshCore's 32-symbol preamble (docs/MeshWX_Airtime_Review.md). On air a
    datagram is its data plus 3 bytes, padded to 16 for the cipher, plus 5
    bytes of header, path length, channel hash and MAC."""
    import math
    raw = 5 + 16 * math.ceil((data_len + 3) / 16)
    t_sym = (2 ** sf) / (bw_khz * 1000.0)
    de = 1 if t_sym > 0.016 else 0
    # cr is the radio's 5..8, for coding rates 4/5..4/8: the formula's CR + 4.
    n = 8 + max(math.ceil((8 * raw - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * max(cr, 5), 0)
    return ((32 + 4.25) + n) * t_sym * 1000.0


async def _radio_shape(request: Request) -> tuple[int, float, int]:
    from meshcore_weather.portal.routes.admin import _radio_info_cached
    info = await _radio_info_cached(request.app.state.bot.radio) or {}
    try:
        return int(info.get("radio_sf") or 7), float(info.get("radio_bw") or 62.5), int(info.get("radio_cr") or 5)
    except (TypeError, ValueError):
        return 7, 62.5, 5


def _job_from_body(body: dict, cfg) -> BroadcastJob:
    """A new job from the add form: {kind, place | station, name, interval_minutes, enabled}."""
    kind = ADD_KINDS.get(str(body.get("kind") or ""))
    if kind is None:
        raise HTTPException(400, "Choose what to add: a forecast for a place, one airport's observations or radar.")
    loc = str(body.get("place") or body.get("station") or "").strip()
    if kind["location_type"] == "station":
        loc = loc.upper()
    product = kind["product"]
    interval = body.get("interval_minutes") or DEFAULT_INTERVAL[product]
    try:
        interval = int(interval)
    except (TypeError, ValueError):
        raise HTTPException(400, "The interval must be a number of minutes.")
    if interval not in INTERVAL_CHOICES[product]:
        raise HTTPException(400, f"Choose one of the intervals offered for {PRODUCT_INFO[product]['label'].lower()}.")
    name = str(body.get("name") or "").strip()[:120]
    extra = _radar_fields(body) if product == "radar" else {}
    return BroadcastJob(id="pending", name=name or "pending", product=product,
                        location_type=kind["location_type"], location_id=loc,
                        interval_minutes=interval, enabled=bool(body.get("enabled", True)), **extra)


def _radar_fields(body: dict) -> dict:
    """`min_level` and `within_km` from a form. An empty distance is the
    coverage radius."""
    out: dict = {}
    if "min_level" in body:
        try:
            level = int(body.get("min_level") or 1)
        except (TypeError, ValueError):
            level = 0
        if level not in RADAR_LEVELS:
            raise HTTPException(400, "Choose what counts as precipitation.")
        out["min_level"] = level
    if "within_km" in body:
        raw = body.get("within_km")
        if raw in (None, ""):
            out["within_km"] = None
        else:
            try:
                km = int(float(raw))
            except (TypeError, ValueError):
                km = 0
            if not 1 <= km <= 1000:
                raise HTTPException(400, "The distance from home must be 1 to 1000 km.")
            out["within_km"] = None if km == _radius_km() else km
    return out


def _job_row(scheduler, job: BroadcastJob) -> dict:
    status = scheduler.job_status(job.id)
    desc = _describe(job, scheduler.store, [], check=False)
    choices = list(INTERVAL_CHOICES.get(job.product, ()))
    if job.interval_minutes not in choices:
        choices = sorted(choices + [job.interval_minutes])
    return {
        **job.model_dump(),
        "builtin": is_builtin(job),
        "location_label": desc["label"],
        "product_label": PRODUCT_INFO.get(job.product, {}).get("label", job.product),
        "interval_choices": choices,
        "last_run_unix": status.get("last_run_unix"),
        "last_run_seconds_ago": status.get("last_run_seconds_ago"),
        "next_run_in_seconds": status.get("next_run_in_seconds"),
        "last_result": status.get("last_result"),
        "last_result_seconds_ago": status.get("last_result_seconds_ago"),
        "waiting_since": status.get("waiting_since"),
        "total_runs": status.get("total_runs", 0),
        "total_bytes": status.get("total_bytes", 0),
        "last_bytes": status.get("last_bytes", 0),
        "last_msg_count": status.get("last_msg_count", 0),
    }


@router.get("/schedule/jobs")
async def list_jobs(request: Request) -> JSONResponse:
    """Every broadcast job with what it last did, and the hour's ceiling."""
    from meshcore_weather.schedule.store import LOAD_PROBLEMS
    scheduler = _get_scheduler(request)
    cfg = scheduler.current_config()
    out = [_job_row(scheduler, job) for job in cfg.jobs]
    order = {p: i for i, p in enumerate(BUILTIN_IDS)}      # warnings first, as apps rely on them most
    out.sort(key=lambda j: (not j["builtin"], order.get(j["product"], 9) if j["builtin"] else 0, j["name"].lower()))
    return JSONResponse({
        "jobs": out, "count": len(out), "problems": list(LOAD_PROBLEMS),
        "ceiling": scheduler.ceiling_status(),
        "estimated_per_hour": round(scheduler.scheduled_packets_per_hour(), 1),
    })


@router.post("/schedule/preview")
async def preview_job(request: Request) -> JSONResponse:
    """What a job would send, without sending it: {kind, place | station,
    interval_minutes} for a new one, or {job_id, interval_minutes} for an
    existing one. Says what the place resolves to, what is wrong with it, the
    packets and bytes one run sends, their airtime, and what the schedule as a
    whole would send an hour."""
    scheduler = _get_scheduler(request)
    body = await request.json()
    cfg = scheduler.current_config()
    if body.get("job_id"):
        job = cfg.get_job(str(body["job_id"]))
        if job is None:
            raise HTTPException(404, "No such broadcast.")
        if body.get("interval_minutes"):
            try:
                job = job.model_copy(update={"interval_minutes": int(body["interval_minutes"])})
            except (TypeError, ValueError):
                raise HTTPException(400, "The interval must be a number of minutes.")
        others = [j for j in cfg.jobs if j.id != job.id]
        existing = cfg.get_job(job.id)
    else:
        job = _job_from_body(body, cfg)
        others, existing = list(cfg.jobs), None
    if job.product == "radar":
        job = job.model_copy(update=_radar_fields(body))
    desc = _describe(job, scheduler.store, others)
    built = {"packets": [], "reason": None}
    if not desc["errors"]:
        if job.product == "radar":
            # Reading a radar picture takes a few hundred milliseconds on a Pi.
            from starlette.concurrency import run_in_threadpool
            built = await run_in_threadpool(scheduler.preview, job)
        else:
            built = scheduler.preview(job)
    sizes = built.get("packets") or []
    sf, bw, cr = await _radio_shape(request)
    airtime = sum(_airtime_ms(n, sf, bw, cr) for n in sizes)
    runs_per_hour = 60.0 / job.interval_minutes
    est = scheduler.scheduled_packets_per_hour()
    if existing is not None:
        est -= scheduler.job_packets_per_hour(existing)
    adds = 0.0 if job.product == "warnings" else max(len(sizes), 1) * runs_per_hour
    name = job.name if job.name != "pending" else (
        "Radar" if job.product == "radar" else f"{PRODUCT_INFO[job.product]['label']}: {desc['label']}")
    return JSONResponse({
        "ok": not desc["errors"],
        "label": desc["label"], "name": name,
        "errors": desc["errors"], "notes": desc["notes"],
        "packets": len(sizes), "bytes": sum(sizes),
        "airtime_ms": round(airtime), "runs_per_day": round(24 * runs_per_hour, 2),
        "reason": built.get("reason"), "active_warnings": built.get("active_warnings"),
        "note": built.get("note"), "radar": built.get("radar"), "product": job.product,
        "per_hour": {"cap": scheduler.ceiling_status()["cap"], "others": round(max(est, 0.0), 1),
                     "this": round(adds, 2)},
    })


@router.post("/schedule/jobs")
async def create_job(request: Request) -> JSONResponse:
    """Add a broadcast: {kind: "forecast" | "station" | "radar", place |
    station, name, interval_minutes, enabled, and for radar min_level and
    within_km}. The id is made from the name."""
    from meshcore_weather.schedule.store import new_job_id
    scheduler = _get_scheduler(request)
    body = await request.json()
    cfg = scheduler.current_config()
    job = _job_from_body(body, cfg)
    desc = _describe(job, scheduler.store, list(cfg.jobs))
    if desc["errors"]:
        raise HTTPException(400, " ".join(desc["errors"]))
    name = job.name if job.name != "pending" else (
        "Radar" if job.product == "radar" else f"{PRODUCT_INFO[job.product]['label']}: {desc['label']}")
    job = job.model_copy(update={"id": new_job_id(cfg, name), "name": name})
    cfg.upsert_job(job)
    await scheduler.save_config(cfg)
    return JSONResponse({"ok": True, "job": _job_row(scheduler, job)})


@router.put("/schedule/jobs/{job_id}")
async def update_job(job_id: str, request: Request) -> JSONResponse:
    """Change a job's name, interval or on/off, and radar's level and distance.
    What it sends and for where are fixed: to broadcast something else, add a
    new one."""
    scheduler = _get_scheduler(request)
    body = await request.json()
    cfg = scheduler.current_config()
    job = cfg.get_job(job_id)
    if job is None:
        raise HTTPException(404, f"job {job_id!r} not found")
    update: dict = {}
    if "name" in body:
        name = str(body.get("name") or "").strip()[:120]
        if not name:
            raise HTTPException(400, "Give the broadcast a name.")
        update["name"] = name
    if "interval_minutes" in body:
        try:
            interval = int(body["interval_minutes"])
        except (TypeError, ValueError):
            raise HTTPException(400, "The interval must be a number of minutes.")
        if interval != job.interval_minutes and interval not in INTERVAL_CHOICES.get(job.product, ()):
            raise HTTPException(400, f"Choose one of the intervals offered for {PRODUCT_INFO[job.product]['label'].lower()}.")
        update["interval_minutes"] = interval
    if "enabled" in body:
        update["enabled"] = bool(body["enabled"])
    if job.product == "radar":
        update.update(_radar_fields(body))
        errors = _describe(job.model_copy(update=update), scheduler.store,
                           [j for j in cfg.jobs if j.id != job.id], check=False)["errors"]
        if errors:
            raise HTTPException(400, " ".join(errors))
    job = job.model_copy(update=update)
    cfg.upsert_job(job)
    await scheduler.save_config(cfg)
    return JSONResponse({"ok": True, "job": _job_row(scheduler, job)})


@router.delete("/schedule/jobs/{job_id}")
async def delete_job(job_id: str, request: Request) -> JSONResponse:
    """Delete a broadcast the operator added. The built-in ones can only be
    turned off."""
    scheduler = _get_scheduler(request)
    cfg = scheduler.current_config()
    job = cfg.get_job(job_id)
    if job is None:
        raise HTTPException(404, f"job {job_id!r} not found")
    if is_builtin(job):
        raise HTTPException(400, "Built-in broadcasts can be turned off, not deleted.")
    cfg.delete_job(job_id)
    await scheduler.save_config(cfg)
    return JSONResponse({"ok": True, "deleted": job_id})


@router.post("/schedule/jobs/{job_id}/toggle")
async def toggle_job(job_id: str, request: Request) -> JSONResponse:
    """Flip the `enabled` flag on a job."""
    scheduler = _get_scheduler(request)
    cfg = scheduler.current_config()
    job = cfg.get_job(job_id)
    if job is None:
        raise HTTPException(404, f"job {job_id!r} not found")
    job.enabled = not job.enabled
    cfg.upsert_job(job)
    await scheduler.save_config(cfg)
    return JSONResponse({"ok": True, "id": job_id, "enabled": job.enabled})


@router.post("/schedule/jobs/{job_id}/run-now")
async def run_job_now(job_id: str, request: Request) -> JSONResponse:
    """Run one job now, whatever its interval. Says what it sent, or why it
    sent nothing."""
    scheduler = _get_scheduler(request)
    cfg = scheduler.current_config()
    job = cfg.get_job(job_id)
    if job is None:
        raise HTTPException(404, f"job {job_id!r} not found")
    if not job.enabled:
        raise HTTPException(400, "This broadcast is off. Turn it on first.")
    n_msgs = await scheduler.run_job_now(job_id)
    status = scheduler.job_status(job_id)
    reason = (status.get("last_result") or {}).get("reason")
    if not n_msgs and status.get("waiting_since"):
        reason = "it is waiting for room under the hourly ceiling"
    return JSONResponse({"ok": True, "id": job_id, "messages_sent": n_msgs, "reason": reason})
