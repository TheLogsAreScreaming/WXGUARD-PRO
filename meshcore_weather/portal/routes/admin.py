"""Admin API: the overview, the radio, the satellite receiver, the text bot
console, logs, host status, coverage, .env settings, and the request/reply
traffic feed. Everything here is operator-only except /public/bot, the
read-only bundle the goestools dashboard proxies for the public page. The
portal has no login: keep it on the LAN or gate it at the edge (see server.py)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from meshcore_weather.activity import activity_log
from meshcore_weather.config import settings
from meshcore_weather.meshcore.delivery import delivery_tracker, loop_lag
from meshcore_weather.portal import logbuf
from meshcore_weather.portal.sse import sse_response
from meshcore_weather.traffic import KINDS as TRAFFIC_KINDS, traffic_log

router = APIRouter()

logger = logging.getLogger(__name__)

# .env keys the portal may write. Anything else is refused.
ENV_WRITABLE = {
    "MCW_SERIAL_PORT", "MCW_SERIAL_BAUD",
    "MCW_MESHCORE_CHANNEL", "MCW_MESHWX_CHANNEL",
    "MCW_HOME_CITIES", "MCW_HOME_RADIUS_KM", "MCW_HOME_STATES", "MCW_HOME_WFOS",
    "MCW_TIMEZONE", "MCW_TX_ENABLED", "MCW_EMWIN_SOURCE", "MCW_SDR_EMWIN_DIR",
    "MCW_SDR_POLL_INTERVAL", "MCW_SDR_DASHBOARD_URL", "MCW_SDR_DASHBOARD_PUBLIC_URL", "MCW_LOG_LEVEL",
    "MCW_STATUS_CHANNEL", "MCW_FILL_ENABLED", "MCW_FILL_GRACE_WARNING_MIN", "MCW_FILL_GRACE_MIN",
    "MCW_REPLY_MODE", "MCW_CHANNEL_REPLY_MAX_HOPS", "MCW_ADVERT_INTERVAL_HOURS", "MCW_PEER_BOT_PREFIX",
    "MCW_CONTACT_HOUSEKEEPING", "MCW_CONTACT_KEEP_FREE",
    "MCW_RETRANSMIT_MAX", "MCW_ECHO_WINDOW_S", "MCW_RETRANSMIT_PER_HOUR", "MCW_SCOPE_URL", "MCW_SCOPE_MODE",
    "MCW_SCOPE_MIN_OBSERVERS", "MCW_RADIO_ADOPT", "MCW_RADIO_RX_SILENT_MIN", "MCW_RELAYED_REPLY_DELAY_S",
    # Who NOAA's administrators can reach (emwin/fetcher.py User-Agent); read at start.
    "MCW_OPERATOR_CONTACT",
}
# MCW_RADIO_REGION, MCW_COVERAGE=national and MCW_PORTAL_* are deliberately not
# here: where the bot may transmit, whether it floods the whole national feed
# and who may reach this page are set in .env by whoever owns the box.

# The limits on what the bot spends answering (config.py), set on the Text bot
# page's "Limits and cooldowns" card and applied live.
LIMIT_KEYS = ("MCW_APP_PACKETS_PER_HOUR", "MCW_APP_SENDER_GAP_S", "MCW_SWEEP_WINDOW_S", "MCW_RADAR_WINDOW_S",
              "MCW_PART_RESEND_FLOOR_S", "MCW_TEXT_REPLIES_PER_SENDER_PER_HOUR", "MCW_TEXT_REPLIES_PER_HOUR",
              "MCW_STRANGER_REPLIES_PER_HOUR", "MCW_STRANGER_REPLY_GAP_S", "MCW_SCHEDULED_PACKETS_PER_HOUR")
ENV_WRITABLE |= set(LIMIT_KEYS)

# Radio presets an operator can apply with one click. Only the presets of
# MCW_RADIO_REGION are offered, and a frequency outside the region's band is
# refused whichever way it is asked for (meshcore/radio.py).
RADIO_PRESETS = {
    "us_meshcore": {"label": "US MeshCore default", "freq_mhz": 910.525, "bw_khz": 62.5, "sf": 7, "cr": 5,
                    "region": "US"},
    "us_wide": {"label": "US 250 kHz / SF10", "freq_mhz": 910.525, "bw_khz": 250, "sf": 10, "cr": 5,
                "region": "US"},
    "eu_meshcore": {"label": "EU 869.525 MHz", "freq_mhz": 869.525, "bw_khz": 62.5, "sf": 7, "cr": 5,
                    "region": "EU"},
}


def region_presets() -> dict:
    """The presets of the configured radio region."""
    region = (settings.radio_region or "").strip().upper()
    return {k: p for k, p in RADIO_PRESETS.items() if p.get("region") == region}


def config_problems(bot) -> list[dict]:
    """What the configuration gets wrong right now, for the Overview and the
    System page: coverage errors, a node name off the WX-<IATA> convention,
    a refused admin key, a radio outside its region's band, the scheduled
    ceiling reached. Each is {"level": "error" | "warning", "text": ...}."""
    from meshcore_weather.config import frequency_problem, node_name_problem
    out: list[dict] = []
    cov = _coverage_obj(bot)
    if cov is not None:
        out += [{"level": "error", "text": f"Coverage: {e}"} for e in cov.errors]
        if getattr(cov, "unconfigured", False):
            out.append({"level": "error", "text": f"Coverage: {cov.blocked}"})
        out += [{"level": "warning", "text": f"Coverage: {w}"} for w in cov.warnings]
    out += [{"level": "error", "text": r} for r in settings.rejected]
    radio = getattr(bot, "radio", None)
    if radio is not None and getattr(radio, "connected", False):
        mc = getattr(radio, "_mc", None)
        si = getattr(mc, "self_info", None) if mc else None
        si = si if isinstance(si, dict) else {}
        name_problem = node_name_problem(si.get("name")) if si else None
        if name_problem:
            out.append({"level": "warning", "text": name_problem})
        freq = si.get("radio_freq")
        if isinstance(freq, (int, float)):
            fp = frequency_problem(freq, si.get("radio_bw"))
            if fp:
                out.append({"level": "error", "text": f"Radio: {fp}; transmit is off until it is fixed"})
    elif frequency_problem(None):
        out.append({"level": "error", "text": frequency_problem(None)})
    responder = getattr(bot, "_broadcaster", None)
    sched = getattr(responder, "scheduler", None) if responder is not None else None
    if sched is not None and hasattr(sched, "ceiling_status"):
        cs = sched.ceiling_status()
        if cs.get("jobs_waited"):
            out.append({"level": "warning", "text": (
                f"Scheduled broadcasts hit their ceiling of {cs['cap']} packets an hour "
                f"(MCW_SCHEDULED_PACKETS_PER_HOUR); waited: {', '.join(cs['jobs_waited'])}")})
    return out


def _radio(request: Request):
    return request.app.state.bot.radio


def _bot(request: Request):
    return request.app.state.bot


async def _body(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "JSON body required")
    if not isinstance(data, dict):
        raise HTTPException(400, "JSON object required")
    return data


def _write_env(updates: dict[str, str]) -> None:
    """Set keys in ./.env in place (commented or missing keys get appended)."""
    bad = set(updates) - ENV_WRITABLE
    if bad:
        raise HTTPException(400, f"not writable: {', '.join(sorted(bad))}")
    env_path = Path(".env")
    lines = env_path.read_text().splitlines() if env_path.exists() else []
    for key, val in updates.items():
        val = str(val).strip()
        if len(val) > 200 or any(not c.isprintable() for c in val):
            raise HTTPException(400, f"{key}: value must be one printable line")
        for i, line in enumerate(lines):
            if line.startswith(f"{key}=") or line.startswith(f"# {key}="):
                lines[i] = f"{key}={val}" if val != "" else f"# {key}="
                break
        else:
            lines.append(f"{key}={val}")
    env_path.write_text("\n".join(lines) + "\n")


# -- Radio ------------------------------------------------------------------------


@router.get("/radio")
async def radio_state(request: Request) -> JSONResponse:
    radio = _radio(request)
    out = {
        "connected": radio.connected,
        "serial_port": settings.serial_port,
        "serial_baud": settings.serial_baud,
        "tx_enabled": settings.tx_enabled,
        "configured_channels": {
            "text": settings.meshcore_channel,
            "data": settings.meshwx_channel,
        },
        "presets": region_presets(),
        "radio_region": settings.radio_region,
        "region_problem": getattr(radio, "region_problem", None),
        "name_problem": getattr(radio, "name_problem", None),
        "reply_mode": settings.reply_mode,
        "channel_reply_max_hops": settings.channel_reply_max_hops,
        "peer_bots": radio.peer_bots() if radio.connected and hasattr(radio, "peer_bots") else [],
        "housekeeping": {"enabled": settings.contact_housekeeping,
                         "slots": getattr(radio, "max_contacts", settings.contact_slots),
                         "keep_free": settings.contact_keep_free,
                         "last": getattr(radio, "last_housekeeping", None)},
        "device": getattr(radio, "device", {}) or {},
        "info": None,
        "channels": [],
        "error": None,
    }
    if radio.connected:
        try:
            # A node that has stopped answering must not hang the page.
            out["info"] = await asyncio.wait_for(radio.info(), 10)
            out["channels"] = await asyncio.wait_for(radio.list_channels(), 10)
        except asyncio.TimeoutError:
            out["error"] = "the node is not answering (link lost? the bot reconnects on its own)"
        except Exception as e:
            out["error"] = str(e)
    else:
        out["error"] = getattr(_bot(request), "_radio_last_error", None) or "radio not connected"
    return JSONResponse(out)


def _radio_call(request: Request):
    radio = _radio(request)
    if not radio.connected:
        raise HTTPException(503, "radio not connected")
    return radio


async def _run(coro):
    try:
        return await coro
    except ValueError as e:
        raise HTTPException(400, str(e))
    except ConnectionError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(500, f"radio error: {e}")


@router.post("/radio/name")
async def radio_set_name(request: Request) -> JSONResponse:
    body = await _body(request)
    await _run(_radio_call(request).set_name(str(body.get("name", ""))))
    return JSONResponse({"ok": True})


@router.post("/radio/params")
async def radio_set_params(request: Request) -> JSONResponse:
    from meshcore_weather.config import frequency_problem
    body = await _body(request)
    if body.get("preset"):
        p = RADIO_PRESETS.get(body["preset"])
        if not p:
            raise HTTPException(400, "unknown preset")
        if p["region"] != settings.radio_region.strip().upper():
            raise HTTPException(400, f"preset {body['preset']} is for {p['region']}, not MCW_RADIO_REGION="
                                     f"{settings.radio_region}")
        body = {k: v for k, v in p.items() if k in ("freq_mhz", "bw_khz", "sf", "cr")}
    try:
        freq, bw, sf, cr = float(body["freq_mhz"]), float(body["bw_khz"]), int(body["sf"]), int(body["cr"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "freq_mhz, bw_khz, sf and cr are required")
    # Refused before the node is asked (the radio checks again, for any caller).
    problem = frequency_problem(freq, bw)
    if problem:
        raise HTTPException(400, problem)
    await _run(_radio_call(request).set_radio_params(freq, bw, sf, cr))
    return JSONResponse({"ok": True, "freq_mhz": freq, "bw_khz": bw, "sf": sf, "cr": cr})


@router.post("/radio/txpower")
async def radio_set_txpower(request: Request) -> JSONResponse:
    body = await _body(request)
    try:
        dbm = int(body["dbm"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "dbm required")
    await _run(_radio_call(request).set_tx_power(dbm))
    return JSONResponse({"ok": True, "dbm": dbm})


@router.post("/radio/pathhash")
async def radio_set_path_hash(request: Request) -> JSONResponse:
    body = await _body(request)
    try:
        size = int(body["bytes"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "bytes required: 1, 2 or 3")
    now = await _run(_radio_call(request).set_path_hash_size(size))
    return JSONResponse({"ok": True, "bytes": now,
                         "note": f"the node now reports {now} byte{'s' if now != 1 else ''} per hop"})


@router.post("/radio/coords")
async def radio_set_coords(request: Request) -> JSONResponse:
    body = await _body(request)
    try:
        lat, lon = float(body["lat"]), float(body["lon"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "lat and lon required")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "lat/lon out of range")
    await _run(_radio_call(request).set_coords(lat, lon))
    return JSONResponse({"ok": True})


@router.post("/radio/channel")
async def radio_set_channel(request: Request) -> JSONResponse:
    body = await _body(request)
    try:
        idx = int(body["idx"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "idx required")
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "name required (use DELETE to clear a slot)")
    secret = body.get("secret") or None
    role = await _run(_radio_call(request).set_channel_name(idx, name, secret))
    note = None
    if role:
        key = {"text": "MCW_MESHCORE_CHANNEL", "data": "MCW_MESHWX_CHANNEL", "status": "MCW_STATUS_CHANNEL"}[role]
        _write_env({key: name})
        note = f"slot {idx} is the bot's {role} channel; the bot now uses {name}"
    return JSONResponse({"ok": True, "role": role, "note": note,
                         "channels": await _radio_call(request).list_channels()})


@router.delete("/radio/channel/{idx}")
async def radio_clear_channel(request: Request, idx: int) -> JSONResponse:
    await _run(_radio_call(request).clear_channel(idx))
    return JSONResponse({"ok": True, "channels": await _radio_call(request).list_channels()})


@router.post("/radio/advert")
async def radio_advert(request: Request) -> JSONResponse:
    sent = await _run(_radio_call(request).advert_now(flood=True))
    return JSONResponse({"ok": True, "sent": sent,
                         "note": None if sent else "TX is disabled; advert suppressed"})


@router.post("/radio/reboot")
async def radio_reboot(request: Request) -> JSONResponse:
    await _run(_radio_call(request).reboot())
    return JSONResponse({"ok": True, "note": "node rebooting; the bot reconnects on its own"})


@router.post("/radio/tx")
async def radio_tx(request: Request) -> JSONResponse:
    """Flip transmit on or off. Applies immediately and persists to .env."""
    body = await _body(request)
    enabled = bool(body.get("enabled"))
    radio = _radio(request)
    if enabled and radio.connected and hasattr(radio, "band_problem"):
        problem = radio.band_problem()
        if problem:
            raise HTTPException(400, f"transmit stays off: {problem}. Apply a {settings.radio_region} preset first")
    was = settings.tx_enabled
    settings.tx_enabled = enabled
    _write_env({"MCW_TX_ENABLED": "true" if enabled else "false"})
    adverted = False
    if enabled and not was and _radio(request).connected:
        # First thing on air: tell the mesh we exist so phones can DM us.
        try:
            adverted = await _radio(request).advert_now(flood=True)
        except Exception:
            adverted = False
    return JSONResponse({"ok": True, "tx_enabled": enabled, "adverted": adverted,
                         "note": "Transmit on; advert sent" if adverted else None})


@router.post("/radio/housekeep")
async def radio_housekeep(request: Request) -> JSONResponse:
    """Run contact housekeeping now (also runs after every contacts refresh)."""
    radio = _radio_call(request)
    if not settings.contact_housekeeping:
        raise HTTPException(400, "contact housekeeping is off (MCW_CONTACT_HOUSEKEEPING)")
    return JSONResponse({"ok": True, **await _run(radio.housekeep_contacts())})


@router.get("/radio/contacts")
async def radio_contacts(request: Request) -> JSONResponse:
    return JSONResponse({"contacts": await _run(_radio_call(request).contacts())})


# -- Satellite receiver -----------------------------------------------------------


async def _dashboard(path: str, method: str = "GET", body: dict | None = None) -> dict | None:
    url = settings.sdr_dashboard_url.rstrip("/") + path
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.request(method, url, json=body)
            r.raise_for_status()
            return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"ok": True}
    except httpx.HTTPStatusError as e:
        try:
            said = e.response.json().get("error")
        except Exception:
            said = None
        return {"_error": said or str(e), "_status": e.response.status_code}
    except Exception as e:
        return {"_error": str(e)}


async def _feed_stats(bot) -> dict:
    """What the EMWIN feed delivered recently, from the bot's own product list."""
    products = await bot.emwin.fetch_products()
    now = datetime.now(timezone.utc)
    hour_ago = now - timedelta(hours=1)
    last_hour = [p for p in products if p.get("timestamp") and p["timestamp"] > hour_ago]
    newest = max((p["timestamp"] for p in products if p.get("timestamp")), default=None)
    types = Counter((p.get("awips_id") or "")[:3] for p in last_hour)
    warn = sum(n for t, n in types.items() if t in {"TOR", "SVR", "FFW", "SVS", "FFS", "FLW", "FLS", "NPW", "WSW", "MWW", "SMW", "SPS", "CFW", "RFW", "EWW", "HLS", "TCV"})
    return {
        "source": settings.emwin_source,
        "directory": settings.sdr_emwin_dir if settings.emwin_source == "sdr" else None,
        "products_total": len(products),
        "products_last_hour": len(last_hour),
        "warnings_last_hour": warn,
        "newest_age_s": int((now - newest).total_seconds()) if newest else None,
        "top_types_last_hour": types.most_common(12),
        # How far behind the uplink the products run, and the newest creation
        # time the feed has delivered (SDRSource: the dish's; InternetSource:
        # NOAA's 2-minute bundle): a fresh file is not fresh news when NOAA
        # is replaying a backlog.
        "lag_min": getattr(bot.emwin, "feed_lag_min", None),
        "newest_product_at": _unix(getattr(bot.emwin, "newest_product_ts", None)),
        # The internet fill (emwin/fill.py): what it took from NWS because
        # the feed had not brought it within its grace, and why.
        "fill": _fill_status(bot, last_hour),
        # An internet-only bot's own fetches (InternetSource): the last one
        # that brought a product, and what the last failed one ran into
        # ("403 Forbidden at 14:03Z") until a bundle comes in whole.
        "internet": {
            "last_ok": _unix(getattr(bot.emwin, "last_ok", None)),
            "last_error": getattr(bot.emwin, "last_error", None),
        } if settings.emwin_source == "internet" else None,
    }


def _unix(dt: datetime | None) -> int | None:
    return int(dt.timestamp()) if dt else None


def _fill_status(bot, last_hour: list[dict] | None = None) -> dict | None:
    fill = getattr(bot.emwin, "fill", None)
    if fill is None:
        return None
    d = fill.status()
    if last_hour is not None:
        d["from_internet_last_hour"] = sum(1 for p in last_hour if p.get("source") == "internet")
    return d


@router.get("/sdr")
async def sdr_state(request: Request) -> JSONResponse:
    state = await _dashboard("/api/state")
    feed = await _feed_stats(_bot(request))
    # The link is for the person reading the page: the public address when
    # the dashboard has one, while the bot itself polls `sdr_dashboard_url`.
    return JSONResponse({"dashboard_url": settings.dashboard_link, "receiver": state, "feed": feed})


# The receiver as the dashboard streams it (its /events: twice a second, and
# every tenth frame with the service status and the last 15 minutes), relayed
# for the Station tab, which used to poll /api/sdr every 10 s while
# goes.digitaino.com moved with every frame. The constellation's points are
# left out: the tab draws none. A stream that fails or ends is said as an
# `_error` frame and opened again after SDR_RETRY_S.
SDR_RETRY_S = 5.0


async def _dashboard_frames(transport: httpx.AsyncBaseTransport | None = None, retry_s: float = SDR_RETRY_S):
    url = settings.sdr_dashboard_url.rstrip("/") + "/events"
    while True:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, read=30.0), transport=transport) as c:
                async with c.stream("GET", url) as r:
                    r.raise_for_status()
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        try:
                            d = json.loads(line[5:])
                        except ValueError:
                            continue
                        if isinstance(d.get("stats"), dict):
                            d["stats"].pop("const", None)
                        yield d
            err = "the dashboard ended its stream"
        except httpx.HTTPStatusError as e:      # 503: the dashboard's live viewers are all taken
            err = f"{e.response.status_code} {e.response.reason_phrase}".strip()
        except Exception as e:  # noqa: BLE001 - down or refusing: said, and tried again
            err = str(e) or type(e).__name__
        yield {"_error": err}
        await asyncio.sleep(retry_s)


@router.get("/sdr/events")
async def sdr_events():
    return sse_response(_dashboard_frames())


@router.get("/sdr/trend")
async def sdr_trend(hours: int = Query(72, ge=1, le=168)) -> JSONResponse:
    """The Station tab's history: EMWIN's delay behind NOAA and the products
    per hour (from the dish, from the internet), and the signal, over the
    last `hours`, from the dashboard's 7-day store. The public page had the
    last three days of both on its Overview until 2026-10-19; the owner
    wanted them here."""
    emwin, hrit = await asyncio.gather(_dashboard(f"/api/emwin?hours={hours}"), _dashboard(f"/api/hrit?hours={hours}"))
    for d in (emwin, hrit):
        if not d or d.get("_error"):
            raise HTTPException(502, "The dashboard does not answer: " + ((d or {}).get("_error") or "nothing"))
    return JSONResponse({"now": hrit.get("now"), "hours": hours,
                         "hourly": emwin.get("hourly") or [], "emwin_since": emwin.get("recorded_since"),
                         "signal": hrit.get("signal") or [], "bucket_s": hrit.get("bucket_s"),
                         "signal_since": hrit.get("recorded_since")})


@router.get("/sdr/history")
async def sdr_history() -> JSONResponse:
    return JSONResponse({"history": await _dashboard("/api/history")})


@router.post("/sdr/mode")
async def sdr_mode(request: Request) -> JSONResponse:
    body = await _body(request)
    mode = body.get("mode")
    if mode not in ("point", "receive"):
        raise HTTPException(400, "mode must be point or receive")
    res = await _dashboard(f"/mode/{mode}", "POST")
    if res and res.get("_error"):
        raise HTTPException(502, res["_error"])
    return JSONResponse({"ok": True, "mode": mode})


# -- Notes on the public page -------------------------------------------------------
#
# What the operator tells the public on goes.digitaino.com ("EMWIN is running two
# hours late"). The dashboard keeps them with its events, so a note stays up while
# the bot is down; they are written from here over localhost, which the dashboard
# takes from the LAN only and never from Cloudflare.


def _notes_answer(d: dict) -> JSONResponse:
    if d.get("_error"):
        raise HTTPException(400 if d.get("_status") == 400 else 502, d["_error"])
    return JSONResponse(d)


@router.get("/public-notes")
async def public_notes() -> JSONResponse:
    d = await _dashboard("/api/notes?all=1") or {}
    if d.get("_error"):
        raise HTTPException(502, "The dashboard does not answer: " + d["_error"])
    return JSONResponse({"up": d.get("up") or [], "recent": d.get("recent") or [], "page": settings.dashboard_link})


@router.post("/public-notes")
async def public_notes_post(request: Request) -> JSONResponse:
    body = await _body(request)
    return _notes_answer(await _dashboard("/notes", "POST", {k: body.get(k) for k in ("title", "detail", "level", "hours")}) or {})


@router.post("/public-notes/{note_id}/{action}")
async def public_notes_change(note_id: int, action: str) -> JSONResponse:
    if action not in ("end", "delete"):
        raise HTTPException(404, "end or delete")
    return _notes_answer(await _dashboard(f"/notes/{note_id}/{action}", "POST") or {})


# The tuner gains the RTL-SDR offers (the dashboard's own list): the meter's
# gain is set while the dish is aimed, and only to one of these.
SDR_GAINS = (0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28, 29.7,
             32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48, 49.6)


@router.post("/sdr/gain")
async def sdr_gain(request: Request) -> JSONResponse:
    """The pointing meter's tuner gain. The dashboard refuses its own control
    endpoints to anyone who comes through Cloudflare; the portal reaches it
    on localhost, so wx-admin gets the controls the public page cannot have."""
    body = await _body(request)
    try:
        gain = float(body.get("gain"))
    except (TypeError, ValueError):
        raise HTTPException(400, "gain must be a number")
    if not any(abs(gain - g) < 0.01 for g in SDR_GAINS):
        raise HTTPException(400, "gain must be one the tuner offers: " + ", ".join(str(g) for g in SDR_GAINS))
    res = await _dashboard(f"/meter/gain/{gain:g}", "POST")
    if res and res.get("_error"):
        raise HTTPException(502, res["_error"])
    return JSONResponse({"ok": True, "gain": gain})


@router.get("/sdr/meter")
async def sdr_meter() -> JSONResponse:
    """The receiver's mode and, while the dish is aimed, the signal meter:
    polled every second by the Station tab, so without the feed statistics
    /api/sdr adds (a scan of every product in the store)."""
    state = await _dashboard("/api/state") or {}
    if state.get("_error"):
        return JSONResponse({"error": state["_error"]})
    return JSONResponse({"mode": state.get("mode"), "mode_msg": state.get("mode_msg"), "meter": state.get("meter"),
                         "gains": SDR_GAINS})


@router.post("/sdr/resetpeak")
async def sdr_resetpeak() -> JSONResponse:
    res = await _dashboard("/meter/resetpeak", "POST")
    if res and res.get("_error"):
        raise HTTPException(502, res["_error"])
    return JSONResponse({"ok": True})


# -- Text bot console ----------------------------------------------------------------


@router.post("/console")
async def console(request: Request) -> JSONResponse:
    """Run one text command exactly as a DM would be handled, without the radio."""
    body = await _body(request)
    text = str(body.get("text", "")).strip()
    if not text:
        raise HTTPException(400, "text required")
    bot = _bot(request)
    t0 = time.monotonic()
    command, location = await bot._parse(text)
    # Exactly the DM path, with the browser as the "sender": one message
    # per command, "more" continues the last long reply.
    sender_key = "console:" + (request.client.host if request.client else "local")
    chunk, has_more = bot.reply_chunk(command, location, sender_key)
    traffic_log.record("console", sender=sender_key, text=text, command=command, location=location,
                       chars=len(chunk or ""), transport="console")
    return JSONResponse({
        "text": text, "command": command, "location": location,
        "reply": chunk, "has_more": has_more, "chars": len(chunk or ""),
        "ms": int((time.monotonic() - t0) * 1000),
    })


@router.get("/console/help")
async def console_help(request: Request) -> JSONResponse:
    from meshcore_weather.main import help_text
    return JSONResponse({"help": help_text()})


# -- Request/reply traffic: what the bot sees on its channel and by DM -----------------


def _kinds_arg(kinds: str | None) -> tuple[str, ...] | None:
    if not kinds:
        return None
    out = tuple(k for k in kinds.split(",") if k in TRAFFIC_KINDS)
    return out or None


@router.get("/traffic")
async def traffic(n: int = Query(200, ge=1, le=1000), kinds: str | None = None,
                  since_id: int = Query(0, ge=0)) -> JSONResponse:
    """Recent conversation events (full detail: this is the admin side) and the counters."""
    return JSONResponse({"events": traffic_log.recent(n, kinds=_kinds_arg(kinds), since_id=since_id),
                         "stats": _traffic_stats(), "kinds": list(TRAFFIC_KINDS)})


def _traffic_stats() -> dict:
    st = traffic_log.stats()
    st["delivery"] = delivery_tracker.stats()
    return st


@router.get("/traffic/stream")
async def traffic_stream():
    """SSE stream of new conversation events."""
    return sse_response(traffic_log.subscribe())


# What "help" says, spelled out for a web page.
PUBLIC_COMMANDS = [
    {"cmd": "wx <city ST>", "what": "current conditions, today's high/low and any active warnings for a place",
     "example": "wx round rock tx"},
    {"cmd": "forecast <city ST>", "what": "the next days, one line per day", "example": "forecast austin tx"},
    {"cmd": "warn <city ST or ST>", "what": "active NWS watches, warnings and advisories", "example": "warn TX"},
    {"cmd": "storm <ST>", "what": "storm reports from the last 6 hours (hail, wind, tornado, flooding)",
     "example": "storm TX"},
    {"cmd": "rain <ST>", "what": "rainfall totals reported by stations in the state", "example": "rain TX"},
    {"cmd": "metar <ICAO>", "what": "the latest airport observation", "example": "metar KAUS"},
    {"cmd": "space", "what": "space weather: Kp, geomagnetic storm and solar alerts", "example": "space"},
    {"cmd": "status", "what": "notices from the station's operator, such as why data is late", "example": "status"},
    {"cmd": "more", "what": "the next page of the last long reply", "example": "more"},
    {"cmd": "help", "what": "the command list", "example": "help"},
]

_PUBLIC_RADIO_CACHE: dict = {"t": 0.0, "info": None}


async def _radio_info_cached(radio) -> dict | None:
    """The public page is polled by anyone; ask the node at most every 30 s."""
    now = time.time()
    if now - _PUBLIC_RADIO_CACHE["t"] < 30:
        return _PUBLIC_RADIO_CACHE["info"]
    info = None
    if radio.connected:
        try:
            info = await radio.info()
        except Exception:
            info = None
    _PUBLIC_RADIO_CACHE.update(t=now, info=info)
    return info


def _preset_label(info: dict | None) -> str | None:
    if not info:
        return None
    for p in RADIO_PRESETS.values():
        if (abs((info.get("radio_freq") or 0) - p["freq_mhz"]) < 0.001 and abs((info.get("radio_bw") or 0) - p["bw_khz"]) < 0.1
                and info.get("radio_sf") == p["sf"] and info.get("radio_cr") == p["cr"]):
            return p["label"]
    return None


@router.get("/public/bot")
async def public_bot(request: Request, n: int = Query(50, ge=1, le=200)) -> JSONResponse:
    """Read-only bundle for the public dashboard: who the bot is, how to reach
    it, what it answers, the request/reply counters and the recent traffic in
    its redacted (public) form. No settings, no contacts, no keys, and no
    position of the bot or of the other bots it knows: a public page needs
    none of them, and the mesh gives them to anyone who listens anyway."""
    bot = _bot(request)
    radio = bot.radio
    info = await _radio_info_cached(radio)
    started = getattr(bot, "_started_at", None)
    from meshcore_weather.main import help_text
    peers = radio.peer_bots() if radio.connected and hasattr(radio, "peer_bots") else []
    return JSONResponse({
        "t": time.time(),
        "bot": {
            "name": (info or {}).get("name"),
            "connected": radio.connected,
            "tx_enabled": settings.tx_enabled,
            "reply_mode": settings.reply_mode,
            "uptime_s": int(time.time() - started) if started else None,
            "products": len(bot.store._products),
            "last_advert_at": getattr(radio, "last_advert_at", 0) or None,
            "version": _git_rev(),
        },
        "radio": None if not info else {
            "freq_mhz": info.get("radio_freq"), "bw_khz": info.get("radio_bw"),
            "sf": info.get("radio_sf"), "cr": info.get("radio_cr"),
            "tx_power_dbm": info.get("tx_power"), "preset": _preset_label(info),
        },
        "channels": {"text": settings.meshcore_channel, "data": settings.meshwx_channel,
                     "status": settings.status_channel or None},
        "coverage": {"home": settings.home_cities, "radius_km": settings.home_radius_km,
                     "states": settings.home_states, "timezone": settings.timezone},
        "commands": PUBLIC_COMMANDS,
        "help": help_text(),
        "dashboard_url": settings.dashboard_link,
        # Where the products come from right now, and how late they are: the
        # feed (the dish, or NOAA's bundles), what the internet fill took from
        # NWS because the feed had not brought it in time; `lag_min` is how far
        # behind the uplink runs (hours, on 2026-10-16, while every file was
        # seconds old). The public page says so, so a reader knows whether a
        # warning came off the satellite or over the internet, and how old.
        # Times are unix seconds.
        "feed": {
            "source": settings.emwin_source,
            "lag_min": getattr(bot.emwin, "feed_lag_min", None),
            "newest_product_at": _unix(getattr(bot.emwin, "newest_product_ts", None)),
            # The internet fill: filling in or not, why ("EMWIN is running
            # 45 min late"), since when, and how much of what NWS issued in the
            # last hour came down the feed in time.
            "fill": _fill_status(bot),
            # With the internet as the source: its last fetch that brought a
            # product, and what the last failed one ran into.
            "internet": {
                "last_ok": _unix(getattr(bot.emwin, "last_ok", None)),
                "last_error": getattr(bot.emwin, "last_error", None),
            } if settings.emwin_source == "internet" else None,
        },
        "peers": [{"name": p["name"]} for p in peers],
        "stats": _traffic_stats(),
        "broadcasts": {"24h": activity_log.stats(1440), "1h": activity_log.stats(60)},
        "recent": traffic_log.recent(n, public=True),
    })


@router.get("/public/warnings")
async def public_warnings(request: Request) -> JSONResponse:
    """Every active warning and watch the bot holds, as outlines for the public
    dashboard's map, and the area this bot answers for (portal/public_map.py).
    Built off the event loop, at most once a minute."""
    from meshcore_weather.portal import public_map
    bot = _bot(request)
    coverage = bot._coverage() if hasattr(bot, "_coverage") else None
    data = await asyncio.get_running_loop().run_in_executor(None, public_map.snapshot, bot.store, coverage)
    return JSONResponse(data)


# -- Limits and cooldowns -------------------------------------------------------------


def _limit_rows(bot) -> list[dict]:
    """Every gate between a request and an answer, and when it opens again.

    The bot spends other people's airtime, so it rations itself in five
    places, and until now none of them could be seen from here: an operator
    watching a request go unanswered had no way to tell a refusal from a
    silence. Each row says what the rule is, where it stands, and how many
    seconds until it lets the next one through.
    """
    from meshcore_weather.protocol import broadcaster as bc

    now = time.time()
    rows: list[dict] = []
    responder = getattr(bot, "_broadcaster", None)

    if responder is not None:
        sent = [t for t in getattr(responder, "_sent", []) if now - t <= 3600]
        cap = settings.app_packets_per_hour
        spent = len(sent) >= cap
        rows.append({
            "id": "budget",
            "name": "App answer budget",
            "rule": f"{cap} packets an hour, all app requests together; then \"busy\"",
            "detail": f"{len(sent)} of {cap} packets in the last hour",
            "used": len(sent), "cap": cap,
            "state": "spent" if spent else "ready",
            "opens_in_s": int(3600 - (now - min(sent))) if spent and sent else 0,
            "resettable": True,
        })

        floor = settings.app_sender_gap_s
        waiting = {k: v for k, v in getattr(responder, "_last_by_sender", {}).items()
                   if now - v < floor}
        rows.append({
            "id": "sender",
            "name": "Per-sender floor",
            "rule": f"one request every {floor:g} s from the same radio",
            "detail": (f"{_radios(len(waiting))} inside the window"
                       if waiting else "nobody waiting"),
            "used": len(waiting), "cap": None,
            "state": "cooling" if waiting else "ready",
            "opens_in_s": int(max((floor - (now - v) for v in waiting.values()), default=0)),
            "resettable": bool(waiting),
        })

        last_sweep = 0.0
        for attr in ("_last_sweep_at", "_last_sweep", "_sweep_at"):
            last_sweep = getattr(responder, attr, 0.0) or last_sweep
        cooldown = settings.sweep_window_s
        left = max(0.0, cooldown - (now - last_sweep)) if last_sweep else 0.0
        # Since revision 10 the window is per state, so the national figure is
        # only half the story: a scoped sweep of Texas holds Texas and nothing
        # else, and an operator watching a refusal needs to see that.
        by_state = getattr(responder, "_last_sweep_state", None) or {}
        cooling_states = {s: at for s, (at, _all) in by_state.items()
                          if now - at < cooldown}
        state_left = max((cooldown - (now - at) for at in cooling_states.values()),
                         default=0.0)
        rows.append({
            "id": "sweep",
            "name": "Alert map sweep",
            "rule": f"one sweep of the same ground every {_span(cooldown)}, whoever asks",
            "detail": ("never sent" if not last_sweep else
                       f"last national sweep {_ago(now - last_sweep)} ago")
                      + (f", {_states(len(cooling_states))} inside their own window"
                         if cooling_states else ""),
            "used": len(cooling_states), "cap": None,
            "state": "cooling" if left > 0 or cooling_states else "ready",
            "opens_in_s": int(max(left, state_left)),
            "resettable": bool(left > 0 or cooling_states),
        })

        # `>part` holds the bytes it resends, so this row is about what is
        # still there to ask for, and about the floor that stops ten phones
        # missing one packet from costing ten packets.
        parts = getattr(responder, "_parts", None)
        status = parts.status(now) if parts is not None else None
        if status is not None:
            held = status["groups"]
            rows.append({
                "id": "parts",
                "name": "Missing packet resends",
                "rule": (f"the last {getattr(bc, 'PARTS_CACHE_GROUPS', 8)} multi-packet answers, "
                         f"kept {getattr(bc, 'PARTS_CACHE_S', 600.0) / 60:.0f} min; "
                         f"one resend of a packet every {_span(settings.part_resend_floor_s)}"),
                "detail": ("nothing held" if not held else
                           f"{held} group{'' if held == 1 else 's'} held "
                           f"({status['packets']} packets), oldest {_ago(status['oldest_age_s'])}"),
                "used": held, "cap": getattr(bc, "PARTS_CACHE_GROUPS", 8),
                "state": "cooling" if status["waiting"] else "ready",
                "opens_in_s": status["opens_in_s"],
                "resettable": bool(status["waiting"]),
            })

        # `>radar` (spec 13): one packet a picture and five for a loop (7D.4),
        # so the budget above is its limit, plus a window per tile of one picture. The row also says
        # whether there are pictures to cut tiles from at all, which is the
        # first thing to look at when every radar request is refused.
        if hasattr(responder, "radar_cooldowns"):
            from meshcore_weather.radar import service as radar_service
            radar = radar_service.shared().status()
            cooling = responder.radar_cooldowns(now)
            window = settings.radar_window_s
            products = radar.get("products") or {}
            fresh = [p for p, info in products.items()
                     if info.get("calibrated") and info.get("age_min", 999) <= 30]
            rows.append({
                "id": "radar",
                "name": "Radar tiles",
                "rule": (f"one packet a picture, an hour's loop at most five; the same tile of "
                         f"the same picture once every {_span(window)}, whoever asks"),
                "detail": ("no radar pictures: this bot has no dish directory" if not radar.get("available")
                           else f"{len(fresh)} of {len(products)} pictures under 30 min old"
                                + (f", {len(cooling)} tile{'' if len(cooling) == 1 else 's'} inside the window"
                                   if cooling else "")),
                "used": len(cooling), "cap": None,
                "state": "cooling" if cooling else "ready",
                "opens_in_s": max((c["remaining_s"] for c in cooling), default=0),
                "resettable": bool(cooling),
            })

        # The scheduled jobs' own ceiling (schedule/scheduler.py): what the
        # warnings, digest, observations, forecast and coverage jobs may put
        # on the air in an hour, life-safety warnings always included.
        sched = getattr(responder, "scheduler", None)
        if sched is not None and hasattr(sched, "ceiling_status"):
            cs = sched.ceiling_status(now)
            waited = cs.get("jobs_waited") or []
            rows.append({
                "id": "scheduled",
                "name": "Scheduled broadcasts",
                "rule": (f"{cs['cap']} packets an hour, every scheduled job together; tornado, severe "
                         "thunderstorm, flash flood and extreme wind warnings always go"),
                "detail": (f"{cs['used']} of {cs['cap']} packets in the last hour"
                           + (f"; waited for room: {', '.join(waited)}" if waited else "")),
                "used": cs["used"], "cap": cs["cap"],
                "state": "spent" if cs["spent"] else "ready",
                "opens_in_s": cs["opens_in_s"],
                "resettable": bool(cs["used"] or waited),
            })

    replies = [t for t in getattr(bot, "_channel_replies", []) if now - t <= 3600]
    # People's text commands: one budget per person and one for everyone.
    hour_ago = time.time() - 3600
    all_replies = [t for t in getattr(bot, "_all_replies", []) if t > hour_ago]
    per_person = {k: len([t for t in v if t > hour_ago]) for k, v in getattr(bot, "_reply_history", {}).items()}
    full = [k for k, n in per_person.items() if n >= settings.text_replies_per_sender_per_hour]
    total_spent = len(all_replies) >= settings.text_replies_per_hour
    rows.append({
        "id": "text",
        "name": "Text replies",
        "rule": (f"{settings.text_replies_per_hour} an hour in all, "
                 f"{settings.text_replies_per_sender_per_hour} to any one person"),
        "detail": (f"{len(all_replies)} of {settings.text_replies_per_hour} this hour"
                   + (f", {len(full)} {'person' if len(full) == 1 else 'people'} at their limit" if full else "")),
        "used": len(all_replies), "cap": settings.text_replies_per_hour,
        "state": "spent" if total_spent or full else "ready",
        "opens_in_s": int(3600 - (now - min(all_replies))) if total_spent and all_replies else 0,
        "resettable": bool(total_spent or full),
    })

    per_hour = settings.stranger_replies_per_hour
    per_sender = settings.stranger_reply_gap_s
    holding = {k: v for k, v in getattr(bot, "_channel_reply_by_sender", {}).items()
               if now - v < per_sender}
    spent = len(replies) >= per_hour
    rows.append({
        "id": "channel",
        "name": "Channel replies to strangers",
        "rule": f"reply mode DM only: {per_hour} an hour, and one per radio every {_span(per_sender)}",
        "detail": (f"{len(replies)} of {per_hour} this hour"
                   + (f", {_radios(len(holding))} inside their own window" if holding else "")),
        "used": len(replies), "cap": per_hour,
        "state": "spent" if spent else ("cooling" if holding else "ready"),
        "opens_in_s": (int(3600 - (now - min(replies))) if spent and replies
                       else int(max((per_sender - (now - v) for v in holding.values()), default=0))),
        "resettable": bool(replies or holding),
    })
    return rows


def _span(seconds: float) -> str:
    """'5 min', '90 s', '2 h': a window as the operator set it."""
    seconds = float(seconds)
    if seconds >= 3600 and seconds % 3600 == 0:
        return f"{seconds / 3600:g} h"
    if seconds >= 60 and seconds % 60 == 0:
        return f"{seconds / 60:g} min"
    return f"{seconds:g} s"


def _radios(n: int) -> str:
    return "1 radio" if n == 1 else f"{n} radios"


def _states(n: int) -> str:
    return "1 state" if n == 1 else f"{n} states"


def _ago(seconds: float) -> str:
    seconds = int(max(0, seconds))
    if seconds < 90:
        return f"{seconds}s"
    if seconds < 5400:
        return f"{seconds // 60}m"
    return f"{seconds // 3600}h"


@router.get("/limits")
async def limits(request: Request) -> JSONResponse:
    return JSONResponse({"t": time.time(), "rows": _limit_rows(_bot(request))})


@router.post("/limits/reset")
async def limits_reset(request: Request) -> JSONResponse:
    """Clear one gate by hand. The operator's own bot, and every reset is
    logged: it spends airtime that the rule was holding back."""
    body = await _body(request)
    which = str(body.get("id") or "")
    bot = _bot(request)
    responder = getattr(bot, "_broadcaster", None)
    if which == "budget" and responder is not None:
        getattr(responder, "_sent").clear()
    elif which == "sender" and responder is not None:
        getattr(responder, "_last_by_sender").clear()
    elif which == "sweep" and responder is not None:
        for attr in ("_last_sweep_at", "_last_sweep", "_sweep_at"):
            if hasattr(responder, attr):
                setattr(responder, attr, 0.0)
        # The per-state windows go with it: one button, one rule.
        if getattr(responder, "_last_sweep_state", None) is not None:
            responder._last_sweep_state.clear()
    elif which == "parts" and getattr(responder, "_parts", None) is not None:
        # The held packets stay: dropping them would close this gate rather
        # than open it. What is cleared is the 30 s floor on resending them.
        responder._parts.clear_floors()
    elif which == "radar" and hasattr(responder, "clear_radar_cooldowns"):
        responder.clear_radar_cooldowns()
    elif which == "scheduled" and hasattr(getattr(responder, "scheduler", None), "reset_ceiling"):
        responder.scheduler.reset_ceiling()
    elif which == "text":
        getattr(bot, "_all_replies", []).clear()
        getattr(bot, "_reply_history", {}).clear()
    elif which == "channel":
        getattr(bot, "_channel_replies", []).clear()
        getattr(bot, "_channel_reply_by_sender", {}).clear()
    else:
        raise HTTPException(400, f"unknown limit {which!r}")
    logger.warning("Portal: %s limit reset by hand", which)
    return JSONResponse({"ok": True, "rows": _limit_rows(bot)})


# -- Logs, host, settings -------------------------------------------------------------


@router.get("/logs")
async def logs(n: int = Query(300, ge=1, le=2000), level: str | None = None,
               cat: str | None = None, q: str | None = None) -> JSONResponse:
    return JSONResponse({"lines": logbuf.tail(n, level, cat, q), "counts": logbuf.counts()})


@router.get("/logs/stream")
async def logs_stream():
    """SSE stream of every new log line, tagged with its category."""
    return sse_response(logbuf.subscribe())


def _git_rev() -> str | None:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], timeout=3,
                                       stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return None


def _host() -> dict:
    out: dict = {"hostname": os.uname().nodename}
    try:
        out["load"] = [round(x, 2) for x in os.getloadavg()]
    except OSError:
        pass
    try:
        mem = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":", 1)
            mem[k] = int(v.strip().split()[0])
        out["mem_total_mb"] = mem.get("MemTotal", 0) // 1024
        out["mem_available_mb"] = mem.get("MemAvailable", 0) // 1024
    except Exception:
        pass
    du = shutil.disk_usage("/")
    out["disk_free_gb"] = round(du.free / 1e9, 1)
    out["disk_used_pct"] = int(du.used * 100 / du.total)
    try:
        out["temp_c"] = round(int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000, 1)
    except Exception:
        pass
    try:
        out["uptime_s"] = int(float(Path("/proc/uptime").read_text().split()[0]))
    except Exception:
        pass
    return out


def _coverage_obj(bot):
    """The coverage the scheduler uses, or the one the settings give."""
    from meshcore_weather.protocol.coverage import Coverage
    broadcaster = getattr(bot, "_broadcaster", None)
    cov = getattr(broadcaster, "coverage", None) if broadcaster is not None else None
    if cov is None:
        try:
            cov = Coverage.from_config()
        except Exception:
            cov = None
    return cov


def _coverage_info(bot) -> dict:
    """The coverage the broadcasts filter on, as configured right now. A
    blocked coverage (errors, or nothing set without MCW_COVERAGE=national)
    says so in the summary: the scheduled area broadcasts are off."""
    cov = _coverage_obj(bot)
    src = (cov.sources if cov is not None else None) or {}
    empty = cov is None or cov.is_empty()
    if cov is None:
        summary = "Coverage could not be built: scheduled warnings, digest and observations send nothing"
    else:
        summary = cov.summary()
    return {
        "cities": list(src.get("cities") or []),
        "states": list(src.get("states") or []),
        "wfos": list(src.get("wfos") or []),
        "radius_km": settings.home_radius_km,
        "zones": 0 if empty else len(cov.zones),
        "counties": 0 if empty else len(cov.counties),
        "summary": summary,
        "blocked": cov.blocked if cov is not None else "not built",
        "national": bool(getattr(cov, "national", False)),
        "errors": list(getattr(cov, "errors", []) or []),
        "warnings": list(getattr(cov, "warnings", []) or []),
        "home": getattr(cov, "home_name", None),
        "center": list(cov.center) if cov is not None and cov.center else None,
    }


@router.get("/system")
async def system(request: Request) -> JSONResponse:
    bot = _bot(request)
    started = getattr(bot, "_started_at", None)
    safe = {k: v for k, v in settings.model_dump(mode="json").items()
            if not any(s in k for s in ("password", "key", "secret", "token"))}
    return JSONResponse({
        "bot": {
            "uptime_s": int(time.time() - started) if started else None,
            "git": _git_rev(),
            "tx_enabled": settings.tx_enabled,
            "products": len(bot.store._products),
            "radio_connected": bot.radio.connected,
            "broadcaster": bot._broadcaster is not None,
        },
        "host": _host(),
        "coverage": _coverage_info(bot),
        "problems": config_problems(bot),
        "settings": safe,
        "env_writable": sorted(ENV_WRITABLE),
        "live_keys": sorted(_LIVE_KEYS),
    })


def _audit_summary() -> dict:
    """The most recent scripts/audit.py run (data/audit.json), summarised."""
    import json
    path = Path(settings.data_dir) / "audit.json"
    if not path.exists():
        return {"available": False}
    try:
        d = json.loads(path.read_text())
    except Exception as e:
        return {"available": False, "error": str(e)}
    res = d.get("results", [])
    fails = [r for r in res if not r.get("ok")]
    by_check: dict = {}
    for r in res:
        c = by_check.setdefault(r["check"], {"pass": 0, "fail": 0})
        c["pass" if r.get("ok") else "fail"] += 1
    try:
        age_s = int(time.time() - datetime.fromisoformat(d["at"]).timestamp())
    except (KeyError, TypeError, ValueError):
        age_s = None
    return {"available": True, "at": d.get("at"), "age_s": age_s, "passed": len(res) - len(fails),
            "failed": len(fails), "by_check": by_check, "failures": fails[:20]}


# The audit's timer runs it every hour; a result older than this is a timer
# that stopped (it was off for five weeks once, and the card never said).
AUDIT_STALE_S = 3 * 3600


def attention(d: dict) -> list[dict]:
    """What the operator should act on, from the Overview's own bundle: the
    first thing the page shows. Only states someone would do something about,
    worst first; the log's warnings are not one (the dish logs a dropped
    packet a minute). Each item is {"level": "bad" | "warn" | "info",
    "text": ..., "href": the tab where it is fixed}."""
    out: list[dict] = []
    add = lambda level, text, href: out.append({"level": level, "text": text, "href": href})
    r, sat, feed = d.get("radio") or {}, d.get("satellite") or {}, d.get("feed") or {}
    if not r.get("connected"):
        add("bad", f"The radio is not connected: {r.get('error') or 'no reply on the serial port'}", "#radio")
    else:
        if r.get("pending_adoption"):
            add("warn", "A different radio is connected. Adverts are held until you adopt it or start a new profile.", "#radio")
        h = r.get("health") or {}
        if h.get("verdict") == "tx_suspect":
            add("bad", f"Transmit looks broken: {h.get('reason') or 'nothing it sends is heard'}", "#radio")
        elif h.get("verdict") == "rx_silent":
            add("bad", f"The radio hears nothing: {h.get('reason') or 'no packet from anyone'}", "#radio")
    if not r.get("tx_enabled"):
        add("warn", "Transmit is off: no replies, adverts or broadcasts go out.", "#radio")
    if not sat.get("reachable"):
        add("bad", f"The receiver's dashboard does not answer: {sat.get('error') or 'unreachable'}", "#station")
    elif sat.get("mode") == "point":
        add("info", "The dish is in pointing mode, so reception is paused.", "#station")
    elif not sat.get("locked"):
        add("warn", "The receiver has no lock on the satellite.", "#station")
    fill = feed.get("fill") or {}
    age = feed.get("newest_age_s")
    if age is None:
        add("bad", "The store holds no EMWIN products.", "#station")
    elif fill.get("active"):
        add("info", f"Internet filling in: {fill.get('reason')}.", "#station")
    elif age > 1800:
        add("warn", f"The newest product is {age // 60} min old.", "#station")
    elif (feed.get("lag_min") or 0) >= 30:
        add("warn", f"EMWIN runs {round(feed['lag_min'])} min behind NOAA.", "#station")
    for part, err in (fill.get("errors") or {}).items():
        add("warn", f"Internet fill, {part}: {err}", "#station")
    bc = d.get("broadcasts") or {}
    if bc.get("warnings_off"):
        add("bad", "Warnings are not being broadcast: the Warnings job is off.", "#mesh/jobs")
    for text in bc.get("config_problems") or []:
        add("warn", text, "#mesh/jobs")
    for p in (d.get("problems") or {}).get("config") or []:
        add("bad" if p.get("level") == "error" else "warn", p.get("text", ""), "#settings")
    errors = (d.get("problems") or {}).get("errors_last_hour") or 0
    if errors:
        add("warn", f"{errors} error{'s' if errors != 1 else ''} in the log in the last hour.", "#logs")
    au = d.get("audit") or {}
    if not au.get("available"):
        add("info", "The accuracy audit has not run yet.", "#overview/audit")
    elif au.get("age_s") is not None and au["age_s"] > AUDIT_STALE_S:
        days = round(au["age_s"] / 86400)
        add("warn", "The accuracy audit last ran " + (f"{days} days ago" if days > 1 else f"{round(au['age_s'] / 3600)} h ago")
            + "; its hourly timer is not running.", "#overview/audit")
    elif au.get("failed"):
        add("warn", f"The accuracy audit failed {au['failed']} of {au['passed'] + au['failed']} checks.", "#overview/audit")
    host = d.get("host") or {}
    disk, temp = host.get("disk_used_pct"), host.get("temp_c")
    if disk is not None and disk > 75:
        add("bad" if disk > 85 else "warn", f"The disk is {disk}% full.", "#settings/host")
    if temp is not None and temp > 75:
        add("bad" if temp > 80 else "warn", f"The Pi is at {temp}°C.", "#settings/host")
    order = {"bad": 0, "warn": 1, "info": 2}
    return sorted(out, key=lambda i: order[i["level"]])


def _schedule_load_problems() -> list[str]:
    from meshcore_weather.schedule.store import LOAD_PROBLEMS
    return LOAD_PROBLEMS


@router.get("/overview")
async def overview(request: Request) -> JSONResponse:
    """Everything the Overview page and the header strip show, in one call:
    dish, feed, radio, transmit, text bot, broadcasts, problems, audit, host."""
    bot = _bot(request)
    radio = bot.radio
    receiver = await _dashboard("/api/state") or {}
    feed = await _feed_stats(bot)
    st = receiver.get("stats") or {}
    info = await _radio_info_cached(radio) or {}
    tstats = _traffic_stats()
    w1, w24 = tstats["windows"]["1h"], tstats["windows"]["24h"]
    broadcaster = getattr(bot, "_broadcaster", None)
    jobs_total = jobs_enabled = 0
    next_in = None
    warnings_off = False
    if broadcaster is not None:
        cfg = broadcaster.scheduler.current_config()
        for job in cfg.jobs:
            jobs_total += 1
            if not job.enabled:
                warnings_off = warnings_off or job.id == "warnings"
                continue
            jobs_enabled += 1
            n = broadcaster.scheduler.job_status(job.id).get("next_run_in_seconds")
            if n is not None:
                next_in = n if next_in is None else min(next_in, n)
    counts = logbuf.counts()
    started = getattr(bot, "_started_at", None)
    d = {
        "t": time.time(),
        "satellite": {
            "reachable": not receiver.get("_error"),
            "error": receiver.get("_error"),
            "mode": receiver.get("mode"),
            "locked": bool(st.get("locked")),
            "vit_avg": st.get("vit_avg"),
            "drops": st.get("drops"),
        },
        "feed": {k: feed.get(k) for k in ("source", "products_total", "products_last_hour",
                                          "warnings_last_hour", "newest_age_s", "lag_min", "fill")},
        "radio": {
            "connected": radio.connected,
            "error": None if radio.connected else (getattr(bot, "_radio_last_error", None) or "not connected"),
            "name": info.get("name"),
            "freq_mhz": info.get("radio_freq"),
            "battery_mv": info.get("battery_mv"),
            "tx_enabled": settings.tx_enabled,
            "reply_mode": settings.reply_mode,
            "health": {k: v for k, v in _health_verdict().items() if k in ("verdict", "reason", "unheard_streak")},
            "pending_adoption": bool(getattr(radio, "pending_adoption", None)),
        },
        "textbot": {
            "requests_1h": w1["requests"], "replies_1h": w1["replies"], "dropped_1h": w1["dropped"],
            "requests_24h": w24["requests"], "replies_24h": w24["replies"], "dropped_24h": w24["dropped"],
            "senders_24h": w24["senders"],
            "last_request_at": tstats.get("last_request_at"), "last_reply_at": tstats.get("last_reply_at"),
            "delivery": tstats["delivery"],
        },
        "broadcasts": {
            "running": broadcaster is not None,
            "jobs_total": jobs_total, "jobs_enabled": jobs_enabled, "next_run_in_s": next_in,
            "1h": activity_log.stats(60), "24h": activity_log.stats(1440),
            # Why the area jobs send nothing (coverage fails closed), and the
            # scheduled ceiling's hour.
            "blocked": getattr(getattr(broadcaster, "coverage", None), "blocked", None) if broadcaster else None,
            "warnings_off": warnings_off,
            "config_problems": list(_schedule_load_problems()) if broadcaster is not None else [],
            "ceiling": broadcaster.scheduler.ceiling_status()
            if broadcaster is not None and hasattr(broadcaster.scheduler, "ceiling_status") else None,
        },
        # `config`: what the configuration gets wrong now (config_problems),
        # beside the log's count.
        "problems": {"last_hour": counts.get("problems", 0), "errors_last_hour": counts.get("errors", 0),
                     "config": config_problems(bot)},
        "audit": _audit_summary(),
        "host": _host(),
        "bot": {"uptime_s": int(time.time() - started) if started else None, "git": _git_rev()},
        "recent": traffic_log.recent(12),
        "dashboard_url": settings.dashboard_link,
    }
    d["attention"] = attention(d)
    return JSONResponse(d)


# Keys the running bot can take on board without a restart.
_LIVE_KEYS = {"MCW_TIMEZONE", "MCW_LOG_LEVEL", "MCW_HOME_CITIES", "MCW_HOME_RADIUS_KM",
              "MCW_HOME_STATES", "MCW_HOME_WFOS", "MCW_SERIAL_PORT", "MCW_SERIAL_BAUD", "MCW_TX_ENABLED",
              "MCW_REPLY_MODE", "MCW_CHANNEL_REPLY_MAX_HOPS", "MCW_ADVERT_INTERVAL_HOURS", "MCW_PEER_BOT_PREFIX",
              "MCW_CONTACT_HOUSEKEEPING", "MCW_CONTACT_KEEP_FREE", "MCW_SDR_DASHBOARD_URL",
              "MCW_SDR_DASHBOARD_PUBLIC_URL", "MCW_FILL_ENABLED", "MCW_FILL_GRACE_WARNING_MIN", "MCW_FILL_GRACE_MIN",
              "MCW_RETRANSMIT_MAX", "MCW_ECHO_WINDOW_S", "MCW_RETRANSMIT_PER_HOUR", "MCW_SCOPE_URL", "MCW_SCOPE_MODE",
              "MCW_SCOPE_MIN_OBSERVERS", "MCW_RADIO_ADOPT", "MCW_RADIO_RX_SILENT_MIN",
              "MCW_RELAYED_REPLY_DELAY_S"} | set(LIMIT_KEYS)

# Value checks, run before anything touches .env: a bad value must never be
# persisted, because the next start would refuse the file.
_INT_KEYS = {"MCW_SERIAL_BAUD", "MCW_HOME_RADIUS_KM", "MCW_SDR_POLL_INTERVAL", "MCW_CHANNEL_REPLY_MAX_HOPS",
             "MCW_ADVERT_INTERVAL_HOURS", "MCW_CONTACT_KEEP_FREE", "MCW_RETRANSMIT_MAX", "MCW_RETRANSMIT_PER_HOUR",
             "MCW_SCOPE_MIN_OBSERVERS", "MCW_RADIO_RX_SILENT_MIN", "MCW_FILL_GRACE_WARNING_MIN",
             "MCW_FILL_GRACE_MIN"} \
    | (set(LIMIT_KEYS) - {"MCW_APP_SENDER_GAP_S"})
_FLOAT_KEYS = {"MCW_ECHO_WINDOW_S", "MCW_APP_SENDER_GAP_S"}
_SECONDS_KEYS = {"MCW_RELAYED_REPLY_DELAY_S"}          # 0 allowed: off
# A budget of 0 would refuse everything: that is switching the bot off, which
# is MCW_TX_ENABLED's job.
_MIN_ONE_KEYS = {"MCW_APP_PACKETS_PER_HOUR", "MCW_TEXT_REPLIES_PER_SENDER_PER_HOUR", "MCW_TEXT_REPLIES_PER_HOUR",
                 "MCW_STRANGER_REPLIES_PER_HOUR", "MCW_SCHEDULED_PACKETS_PER_HOUR"}
# Free text with a shorter cap than the 200 every value gets.
_MAX_LEN = {"MCW_OPERATOR_CONTACT": 100}
_BOOL_KEYS = {"MCW_TX_ENABLED", "MCW_CONTACT_HOUSEKEEPING", "MCW_FILL_ENABLED"}
_CHOICES = {"MCW_REPLY_MODE": ("dm", "channel", "dm_only"), "MCW_EMWIN_SOURCE": ("sdr", "internet"),
            "MCW_LOG_LEVEL": ("DEBUG", "INFO", "WARNING", "ERROR"), "MCW_SCOPE_MODE": ("stats", "decide"),
            "MCW_RADIO_ADOPT": ("auto", "manual", "off")}
_TRUE = ("1", "true", "yes", "on")
_FALSE = ("0", "false", "no", "off")


def _validate_updates(updates: dict[str, str]) -> None:
    for key, val in updates.items():
        if val == "":
            continue                      # empty = comment the key out, back to the default
        if key in _INT_KEYS and not val.lstrip("-").isdigit():
            raise HTTPException(400, f"{key}: must be a whole number")
        if key in _INT_KEYS and int(val) < 0:
            raise HTTPException(400, f"{key}: must not be negative")
        if key in _MIN_ONE_KEYS and int(val) < 1:
            raise HTTPException(400, f"{key}: must be 1 or more")
        if key in _FLOAT_KEYS:
            try:
                if float(val) <= 0:
                    raise ValueError
            except ValueError:
                raise HTTPException(400, f"{key}: must be a number above 0")
        if key in _SECONDS_KEYS:
            try:
                if not 0 <= float(val) <= 10:
                    raise ValueError
            except ValueError:
                raise HTTPException(400, f"{key}: must be a number of seconds from 0 to 10")
        if key in ("MCW_SCOPE_URL", "MCW_SDR_DASHBOARD_PUBLIC_URL") and not val.startswith(("http://", "https://")):
            raise HTTPException(400, f"{key}: must start with http:// or https://")
        if key in _BOOL_KEYS and val.lower() not in _TRUE + _FALSE:
            raise HTTPException(400, f"{key}: must be true or false")
        if key in _CHOICES and val not in _CHOICES[key]:
            raise HTTPException(400, f"{key}: must be one of " + ", ".join(_CHOICES[key]))
        if key.endswith("_CHANNEL") and not (val.startswith("#") or val.isdigit()):
            raise HTTPException(400, f"{key}: must start with '#' or be a slot number")
        if key in _MAX_LEN and len(val) > _MAX_LEN[key]:
            raise HTTPException(400, f"{key}: at most {_MAX_LEN[key]} characters")
        if key == "MCW_TIMEZONE":
            from zoneinfo import ZoneInfo
            try:
                ZoneInfo(val)
            except Exception:
                raise HTTPException(400, f"{key}: {val!r} is not an IANA time zone (e.g. America/Denver)")
        if key == "MCW_HOME_CITIES":
            # Coverage fails closed on a home city that does not resolve; the
            # portal refuses one before it reaches .env, so a typo here never
            # switches a running bot's broadcasts off.
            from meshcore_weather.protocol.coverage import check_place
            for city in [c.strip() for c in val.split(",") if c.strip()]:
                _loc, err, _warn = check_place(city)
                if err:
                    raise HTTPException(400, f"{key}: {err}")
        if key in ("MCW_HOME_STATES", "MCW_HOME_WFOS"):
            from meshcore_weather.geodata import resolver
            resolver.load()
            field = "s" if key == "MCW_HOME_STATES" else "w"
            known = {z.get(field) for z in resolver._zones.values()}
            bad = [c for c in (x.strip().upper() for x in val.split(",")) if c and c not in known]
            if bad:
                raise HTTPException(400, f"{key}: not known to the NWS zones: {', '.join(bad)}")


async def _apply_live(bot, updates: dict[str, str]) -> list[str]:
    """Apply what can be applied now; return the keys that were."""
    import logging
    applied: list[str] = []
    coverage_changed = False
    for key, val in updates.items():
        if key not in _LIVE_KEYS or val == "":
            continue                      # an emptied key takes its default at the next start
        if key == "MCW_TIMEZONE":
            from meshcore_weather.config import timezone_set_by_operator
            settings.timezone = val
            timezone_set_by_operator()
        elif key == "MCW_LOG_LEVEL":
            logging.getLogger().setLevel(getattr(logging, val.upper(), logging.INFO))
            settings.log_level = val
        elif key == "MCW_TX_ENABLED":
            settings.tx_enabled = val.strip().lower() in _TRUE
        elif key == "MCW_REPLY_MODE":
            settings.reply_mode = val
        elif key == "MCW_SDR_DASHBOARD_URL":
            settings.sdr_dashboard_url = val
        elif key == "MCW_SDR_DASHBOARD_PUBLIC_URL":
            settings.sdr_dashboard_public_url = val
        elif key == "MCW_FILL_ENABLED":
            settings.fill_enabled = val.strip().lower() in _TRUE
        elif key in ("MCW_FILL_GRACE_WARNING_MIN", "MCW_FILL_GRACE_MIN"):
            setattr(settings, key[4:].lower(), int(val))
        elif key in ("MCW_CHANNEL_REPLY_MAX_HOPS", "MCW_ADVERT_INTERVAL_HOURS"):
            setattr(settings, key[4:].lower(), int(val))
        elif key == "MCW_PEER_BOT_PREFIX":
            settings.peer_bot_prefix = val
        elif key == "MCW_CONTACT_HOUSEKEEPING":
            settings.contact_housekeeping = val.strip().lower() in _TRUE
        elif key == "MCW_CONTACT_KEEP_FREE":
            settings.contact_keep_free = max(0, int(val))
        elif key in ("MCW_RETRANSMIT_MAX", "MCW_RETRANSMIT_PER_HOUR", "MCW_SCOPE_MIN_OBSERVERS"):
            setattr(settings, key[4:].lower(), max(1, int(val)) if key == "MCW_SCOPE_MIN_OBSERVERS" else int(val))
        elif key == "MCW_ECHO_WINDOW_S":
            settings.echo_window_s = float(val)
        elif key == "MCW_RELAYED_REPLY_DELAY_S":
            settings.relayed_reply_delay_s = float(val)
        elif key == "MCW_SCOPE_URL":
            settings.scope_url = val
        elif key == "MCW_SCOPE_MODE":
            settings.scope_mode = val
        elif key == "MCW_RADIO_ADOPT":
            settings.radio_adopt = val
        elif key == "MCW_RADIO_RX_SILENT_MIN":
            settings.radio_rx_silent_min = max(1, int(val))
        elif key in ("MCW_HOME_CITIES", "MCW_HOME_STATES", "MCW_HOME_WFOS", "MCW_HOME_RADIUS_KM"):
            attr = key[4:].lower()
            setattr(settings, attr, int(val) if key.endswith("_KM") else val)
            coverage_changed = True
        elif key in ("MCW_SERIAL_PORT", "MCW_SERIAL_BAUD"):
            setattr(settings, key[4:].lower(), int(val) if key.endswith("BAUD") else val)
        elif key in LIMIT_KEYS:
            setattr(settings, key[4:].lower(), float(val) if key in _FLOAT_KEYS else int(val))
        applied.append(key)
    if coverage_changed:
        # The resolver's home moves with the first home city (it ranks bare
        # place names and centres the observations and the home forecast):
        # `_set_home_from_settings` alone keeps the home it already has.
        from meshcore_weather.config import fill_timezone
        from meshcore_weather.protocol.coverage import refresh_home
        try:
            home = refresh_home()
            logger.info("Portal: home point now %s", home)
        except Exception:
            logger.exception("Portal: could not move the home point")
        try:
            fill_timezone()           # a zone taken from the old home city follows the new one
        except Exception:
            logger.exception("Portal: could not take the time zone from the new home city")
        if hasattr(bot, "_coverage_cache"):
            bot._coverage_cache = None
        if bot._broadcaster is not None:
            try:
                bot._broadcaster.scheduler.reload_coverage()
            except Exception:
                logger.exception("Portal: coverage reload failed")
    if "MCW_SERIAL_PORT" in applied or "MCW_SERIAL_BAUD" in applied:
        await bot.reconnect_radio()
    return applied


@router.post("/settings/env")
async def settings_env(request: Request) -> JSONResponse:
    body = await _body(request)
    updates = {str(k): str(v).strip() for k, v in body.items()}
    if not updates:
        raise HTTPException(400, "nothing to change")
    bad = set(updates) - ENV_WRITABLE
    if bad:
        raise HTTPException(400, f"not writable: {', '.join(sorted(bad))}")
    _validate_updates(updates)
    radio = _bot(request).radio
    if (updates.get("MCW_TX_ENABLED", "").lower() in _TRUE and getattr(radio, "connected", False)
            and hasattr(radio, "band_problem") and radio.band_problem()):
        raise HTTPException(400, f"MCW_TX_ENABLED: transmit stays off: {radio.band_problem()}")
    _write_env(updates)
    applied = await _apply_live(_bot(request), updates)
    pending = sorted(set(updates) - set(applied))
    if applied and pending:
        note = "Applied now: " + ", ".join(sorted(applied)) + ". Needs a restart: " + ", ".join(pending)
    elif applied:
        note = "Applied now"
    else:
        note = "Saved; needs a restart: " + ", ".join(pending)
    return JSONResponse({"ok": True, "applied": sorted(applied), "restart_needed": pending, "note": note})


@router.post("/system/restart")
async def system_restart(request: Request) -> JSONResponse:
    """Clean exit; systemd restarts the bot with the current .env."""
    _bot(request).request_restart()
    return JSONResponse({"ok": True, "note": "Restarting; back in about 40 seconds"})


@router.post("/radio/reconnect")
async def radio_reconnect(request: Request) -> JSONResponse:
    await _bot(request).reconnect_radio()
    bot = _bot(request)
    return JSONResponse({"ok": True, "connected": bot.radio.connected, "error": bot._radio_last_error})


# -- Radio health and hardware swaps ----------------------------------------------------
#
# The verdict (meshcore/health.py) needs no serial round trip; the node's
# own counters do, so they are cached like the public radio info.

_RADIO_STATS_CACHE: dict = {"t": 0.0, "stats": None}


def _health_verdict() -> dict:
    from meshcore_weather.meshcore.health import assess
    t = delivery_tracker
    return assess(outcomes=t.recent_outcomes(200), last_rx_at=t.last_rx_at,
                  last_repeat_heard_at=t.last_repeat_heard_at, rx_frames=t.rx_frames, started_at=t.started_at,
                  tx_enabled=settings.tx_enabled, rx_silent_s=settings.radio_rx_silent_min * 60,
                  loop_lag_pct=loop_lag.pct)


async def _radio_stats_cached(radio) -> dict | None:
    now = time.time()
    if now - _RADIO_STATS_CACHE["t"] < 30:
        return _RADIO_STATS_CACHE["stats"]
    stats = None
    if radio.connected:
        try:
            stats = await asyncio.wait_for(radio.stats(), 10)
        except Exception:
            stats = None
    _RADIO_STATS_CACHE.update(t=now, stats=stats)
    return stats


@router.get("/radio/health")
async def radio_health(request: Request) -> JSONResponse:
    from meshcore_weather.meshcore.health import firmware_check
    radio = _radio(request)
    device = getattr(radio, "device", {}) or {}
    drops = [d for d in getattr(_bot(request), "link_drops", []) if time.time() - d[0] < 86400]
    out = {
        "connected": radio.connected,
        "health": _health_verdict(),
        "link_drops": {"24h": len(drops), "last_at": drops[-1][0] if drops else None,
                       "last_reason": drops[-1][1] if drops else None},
        "firmware": firmware_check(device.get("ver")),
        "device": device,
        "delivery": delivery_tracker.stats()["windows"],
        "loop_lag": loop_lag.stats(),
        "radio_stats": await _radio_stats_cached(radio),
        "profile": radio.profile_status() if hasattr(radio, "profile_status") else None,
    }
    return JSONResponse(out)


@router.post("/radio/testtx")
async def radio_test_tx(request: Request) -> JSONResponse:
    radio = _radio_call(request)
    if not hasattr(radio, "test_transmit"):
        raise HTTPException(501, "link test not available")
    return JSONResponse(await _run(radio.test_transmit()))


@router.post("/radio/profile/save")
async def radio_profile_save(request: Request) -> JSONResponse:
    body = await _body(request)
    radio = _radio_call(request)
    if not hasattr(radio, "save_profile_now"):
        raise HTTPException(501, "profiles not available")
    summary = await _run(radio.save_profile_now(force=bool(body.get("force"))))
    return JSONResponse({"ok": True, "profile": summary})


@router.post("/radio/profile/adopt")
async def radio_profile_adopt(request: Request) -> JSONResponse:
    """Write the saved profile onto the connected radio, reboot it and
    reconnect; the reconnect's identity check records the outcome."""
    bot = _bot(request)
    radio = _radio_call(request)
    if not hasattr(radio, "adopt_profile"):
        raise HTTPException(501, "profiles not available")
    steps = await _run(radio.adopt_profile())
    await bot.reconnect_radio()
    new = bot.radio
    status = new.profile_status() if hasattr(new, "profile_status") else None
    return JSONResponse({"ok": True, "steps": steps, "connected": new.connected, "error": bot._radio_last_error,
                         "profile": status})


# -- Audit: structured answers for scripts/audit.py -----------------------------------
#
# The bot never touches the internet; the audit script does, and compares
# these structured answers with api.weather.gov, IEM, aviationweather.gov
# and SWPC. Same services the text and binary replies use.


@router.get("/audit/warnings")
async def audit_warnings(request: Request, state: str = Query(..., min_length=2, max_length=2)) -> JSONResponse:
    from meshcore_weather.protocol.warnings import extract_active_warnings
    st = state.upper()
    out = []
    for w in extract_active_warnings(_bot(request).store, coverage=None):
        ugcs = [u for u in (w.get("ugcs") or w.get("zones") or [])]
        if not any(u[:2] == st for u in ugcs):
            continue
        out.append({
            "office": w.get("vtec_office"), "phenomenon": w.get("vtec_phenomenon"),
            "significance": w.get("vtec_significance"), "etn": w.get("vtec_etn"),
            "expires": w["expires_at"].isoformat() if w.get("expires_at") else None,
            "ugcs": sorted(u for u in ugcs if u[:2] == st),
            "headline": (w.get("headline") or "")[:120],
        })
    return JSONResponse({"state": st, "events": out})


@router.get("/audit/storms")
async def audit_storms(request: Request, state: str = Query(..., min_length=2, max_length=2),
                       hours: int = Query(6, ge=1, le=48)) -> JSONResponse:
    from meshcore_weather.core import services
    sr = services.storm_reports_for(_bot(request).store, state=state.upper(), limit=200, max_age_hours=hours)
    return JSONResponse({"state": state.upper(), "reports": [
        {"at": e["at"].isoformat(), "event": e["event"], "location": e["location"], "county": e.get("county"),
         "state": e.get("state"), "mag": e.get("mag")} for e in (sr.entries if sr else [])]})


@router.get("/audit/obs")
async def audit_obs(request: Request, station: str = Query(..., min_length=4, max_length=4)) -> JSONResponse:
    from meshcore_weather.core import services
    from meshcore_weather.geodata import resolver
    loc = resolver.resolve(station.upper())
    if not loc:
        raise HTTPException(404, "unknown station")
    raw = services.raw_metar_for(_bot(request).store, loc)
    ob = services.observation_for(_bot(request).store, loc)
    return JSONResponse({
        "station": station.upper(),
        "metar": raw[2] if raw else None, "metar_station": raw[0] if raw else None,
        "obs": None if ob is None else {"station": ob.station, "temp_f": ob.temp_f, "dewpoint_f": ob.dewpoint_f,
                                        "wind_dir_deg": ob.wind_dir_deg, "wind_speed_mph": ob.wind_speed_mph,
                                        "wind_gust_mph": ob.wind_gust_mph, "obs_utc_min": ob.obs_utc_min},
    })


@router.get("/audit/forecast")
async def audit_forecast(request: Request, place: str = Query(..., min_length=2)) -> JSONResponse:
    from meshcore_weather.core import services
    from meshcore_weather.geodata import resolver
    loc = resolver.resolve(place)
    if not loc:
        raise HTTPException(404, "unknown place")
    fc = services.forecast_for(_bot(request).store, loc)
    return JSONResponse({
        "place": loc.get("name"), "lat": loc.get("lat"), "lon": loc.get("lon"),
        "point": fc.point_name if fc else None, "point_km": fc.distance_km if fc else None,
        "wfo": fc.wfo if fc else None, "issued": fc.issued_at.isoformat() if fc and fc.issued_at else None,
        "start_date": fc.start_date.date().isoformat() if fc and fc.start_date else None,
        "periods": [{"day": p["period_id"], "high_f": p["high_f"], "low_f": p["low_f"], "precip_pct": p.get("precip_pct", 0)}
                    for p in (fc.periods if fc else [])],
    })


@router.get("/audit/space")
async def audit_space(request: Request) -> JSONResponse:
    from meshcore_weather.core import space_weather
    sw = space_weather.space_weather_for(_bot(request).store)
    if sw is None:
        return JSONResponse({"available": False})
    return JSONResponse({"available": True, "issued": sw.issued_at.isoformat(), "kp_max_24h": sw.kp_max_24h,
                         "kp_forecast": sw.kp_forecast, "g_forecast": sw.g_forecast,
                         "first_day": sw.first_day.isoformat() if sw.first_day else None,
                         "kp_now": sw.kp_now, "kp_expected": sw.kp_expected, "sfi": sw.sfi, "ssn": sw.ssn})


@router.get("/audit/last")
async def audit_last() -> JSONResponse:
    """Result of the most recent scripts/audit.py run (data/audit.json)."""
    return JSONResponse(_audit_summary())
