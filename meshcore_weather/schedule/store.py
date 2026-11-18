"""Persistence for the broadcast schedule config.

Stores `BroadcastConfig` as JSON at `data/broadcast_config.json`.
Writes are atomic (temp file + rename) so a crash mid-write can't
corrupt the file. A missing or unreadable file gives the default schedule;
a file with some unreadable jobs keeps the others (load_config).
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from meshcore_weather.config import settings
from meshcore_weather.schedule.models import BUILTIN_IDS, PRODUCT_TYPES, BroadcastConfig, BroadcastJob

logger = logging.getLogger(__name__)

CONFIG_PATH = Path(settings.data_dir) / "broadcast_config.json"


# What the last load could not use, for the portal: one line per job dropped
# from a hand-edited file. Empty when the file was whole.
LOAD_PROBLEMS: list[str] = []


def load_config() -> BroadcastConfig:
    """Load broadcast config from disk.

    A missing file, or one that is not JSON at all, gives the default
    schedule. A file with some jobs the bot cannot read keeps the rest: the
    bad ones are listed in LOAD_PROBLEMS, the file is copied aside once as
    `broadcast_config.json.invalid` and not rewritten, so nothing the
    operator wrote is lost by a later save until they have seen it.
    """
    LOAD_PROBLEMS.clear()
    if not CONFIG_PATH.exists():
        logger.info(
            "No broadcast_config.json at %s — synthesizing default jobs from env",
            CONFIG_PATH,
        )
        cfg = default_config_for_bootstrap()
        # Persist the default so the operator can see/edit it
        try:
            save_config(cfg)
        except Exception as exc:
            logger.warning("Could not persist default broadcast config: %s", exc)
        return cfg

    try:
        raw = CONFIG_PATH.read_text()
        data = json.loads(raw)
        if not isinstance(data, dict) or not isinstance(data.get("jobs", []), list):
            raise ValueError("not a broadcast config")
    except Exception as exc:
        logger.warning(
            "broadcast_config.json at %s is invalid (%s) — falling back to defaults",
            CONFIG_PATH, exc,
        )
        LOAD_PROBLEMS.append(f"broadcast_config.json could not be read ({exc}); the default broadcasts are in use")
        return default_config_for_bootstrap()

    good: list[BroadcastJob] = []
    for j in _migrate_jobs(data.get("jobs") or []):
        try:
            good.append(BroadcastJob(**j))
        except Exception as exc:
            name = j.get("id") if isinstance(j, dict) else None
            LOAD_PROBLEMS.append(f"Job {name or '(no id)'} in broadcast_config.json is ignored: {_first_error(exc)}")
            logger.warning("broadcast_config.json: job %r ignored: %s", name, exc)
    try:
        version = int(data.get("version") or 2)
    except (TypeError, ValueError):
        version = 2
    cfg = BroadcastConfig(version=version, jobs=good)
    changed = _home_forecast_to_home(cfg)
    changed = _repair_builtins(cfg) or changed
    changed = _ensure_core_jobs(cfg) or changed
    if LOAD_PROBLEMS:
        _keep_aside(raw)
    elif changed:
        try:
            save_config(cfg)
        except Exception as exc:
            logger.warning("Could not persist migrated broadcast config: %s", exc)
    return cfg


def _first_error(exc: Exception) -> str:
    """pydantic's message without its preamble and links."""
    errors = getattr(exc, "errors", None)
    if callable(errors):
        try:
            e = errors()[0]
            return f"{'.'.join(str(x) for x in e.get('loc', ()))}: {e.get('msg')}"
        except Exception:
            pass
    return str(exc).splitlines()[0]


def _keep_aside(raw: str) -> None:
    """A copy of a file with unreadable jobs, once, before anything rewrites it."""
    aside = CONFIG_PATH.with_name(CONFIG_PATH.name + ".invalid")
    try:
        if not aside.exists():
            aside.write_text(raw)
            logger.warning("Kept a copy of broadcast_config.json as %s", aside)
    except OSError as exc:
        logger.warning("Could not keep a copy of broadcast_config.json: %s", exc)


def save_config(cfg: BroadcastConfig) -> None:
    """Write the config to disk atomically.

    Writes to a temp file in the same directory, then renames. This
    guarantees the destination is either the old valid file or the
    new valid file — never a half-written mess.
    """
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = CONFIG_PATH.with_suffix(".json.tmp")
    # Unset fields stay out: a forecast job carries no radar distance.
    json_text = cfg.model_dump_json(indent=2, exclude_none=True)
    tmp_path.write_text(json_text + "\n")
    os.replace(tmp_path, CONFIG_PATH)
    logger.debug("Wrote broadcast config to %s (%d jobs)", CONFIG_PATH, len(cfg.jobs))


# -- Default bootstrap --


def default_config_for_bootstrap() -> BroadcastConfig:
    """The v5 schedule a fresh deployment gets: warnings on change (checked
    every 2 min), the digest every 3 h, one observations packet an hour, the
    home forecast every 6 h, and the coverage statement every 3 h. Radar,
    more forecasts and single stations are the operator's to add."""
    cfg = BroadcastConfig(version=2, jobs=[])
    _ensure_core_jobs(cfg)
    logger.info("Bootstrap schedule: %d default jobs", len(cfg.jobs))
    return cfg


_V4_TO_V5 = {"warnings_delta": "warnings", "observation": "observations"}
# v4's radar (an internet composite, a region per job) is retired; v5's is a
# coverage job (executor._build_radar).
_RETIRED = {"outlook", "storm_reports", "rain_obs", "metar", "taf", "warnings_near", "afd",
            "space_weather", "fire_weather", "daily_climate", "nowcast"}


def _migrate_jobs(jobs: list[dict]) -> list[dict]:
    """v4 job files keep working: delta -> warnings, the full re-broadcast
    -> digest, per-city observations -> one coverage batch, forecast kept
    at 6 h. Retired products are dropped."""
    out: list[dict] = []
    seen_obs = False
    for j in jobs:
        prod = j.get("product")
        if prod == "warnings" and j.get("id") in ("warnings-full", "warnings-coverage"):
            j = {**j, "id": "digest", "name": "Active warnings digest", "product": "digest",
                 "location_type": "coverage", "location_id": "", "interval_minutes": 180}
        elif prod in _V4_TO_V5:
            j = {**j, "product": _V4_TO_V5[prod]}
            if j["product"] == "warnings":
                j.update(id="warnings", name="Warnings on change", interval_minutes=2)
            elif j["product"] == "observations":
                if seen_obs or j.get("location_type") != "station":
                    if seen_obs:
                        continue
                    j.update(id="observations", name="Observations, coverage stations",
                             location_type="coverage", location_id="", interval_minutes=60)
                seen_obs = True
        elif prod == "forecast":
            if j.get("location_type") not in ("city", "pfm_point", "coverage"):
                continue
            j = {**j, "interval_minutes": max(int(j.get("interval_minutes") or 360), 180)}
        elif prod in _RETIRED or prod not in PRODUCT_TYPES or (
                prod == "radar" and j.get("location_type") != "coverage"):
            logger.warning("Dropping broadcast job %r: product %r is request-only in v5", j.get("id"), prod)
            continue
        if any(o.get("id") == j.get("id") for o in out):
            continue
        out.append(j)
    return out


def _same_place(a: str, b: str) -> bool:
    """'Austin TX', 'austin, tx' and 'Austin  TX' name the same place."""
    def norm(x: str) -> str:
        return " ".join((x or "").replace(",", " ").upper().split())
    return bool(a.strip()) and norm(a) == norm(b)


def _home_forecast_to_home(cfg: BroadcastConfig) -> bool:
    """A forecast job written for the home city by name ("Austin TX", which
    every bot bootstrapped before 2026-10-17 got) becomes the `home` job: the
    first MCW_HOME_CITIES entry resolved when it runs, so a bot copied to
    another city, or a home city changed on the portal, forecasts its own
    home and not Austin. Only a job naming the configured home city moves; a
    forecast for another place is the operator's own. Returns True if one did."""
    home = (_split_csv(settings.home_cities) or [""])[0]
    changed = False
    for i, job in enumerate(cfg.jobs):
        if job.product != "forecast" or job.location_type != "city" or not _same_place(job.location_id, home):
            continue
        name = "Forecast: home" if job.name.strip() == f"Forecast: {job.location_id}".strip() else job.name
        cfg.jobs[i] = job.model_copy(update={"location_type": "coverage", "location_id": "home", "name": name})
        logger.info("Broadcast job %s: forecast for %r is now the home forecast (location 'home')",
                    job.id, job.location_id)
        changed = True
    return changed


def _core_defaults() -> list[BroadcastJob]:
    return [
        BroadcastJob(id="warnings", name="Warnings on change", product="warnings",
                     location_type="coverage", interval_minutes=2),
        BroadcastJob(id="digest", name="Active warnings digest", product="digest",
                     location_type="coverage", interval_minutes=180),
        BroadcastJob(id="observations", name="Observations, coverage stations", product="observations",
                     location_type="coverage", interval_minutes=60),
        # The home point, resolved when the job runs: never a place name
        # baked into the file (executor._build_forecast).
        BroadcastJob(id="forecast", name="Forecast: home", product="forecast",
                     location_type="coverage", location_id="home", interval_minutes=360),
        BroadcastJob(id="coverage", name="Coverage statement", product="coverage",
                     location_type="coverage", interval_minutes=180),
    ]


def _repair_builtins(cfg: BroadcastConfig) -> bool:
    """A built-in job edited into another product (the portal allowed it until
    2026-10-20) sends its own product again: a `warnings` job turned into a
    forecast meant the bot never broadcast a warning, and nothing said so.
    Returns True if one was repaired."""
    changed = False
    for d in _core_defaults():
        job = cfg.get_job(d.id)
        if job is None or (job.product == d.product and job.location_type == d.location_type
                           and (d.location_id == "" or job.location_id == d.location_id)):
            continue
        cfg.upsert_job(job.model_copy(update={"product": d.product, "location_type": d.location_type,
                                              "location_id": d.location_id}))
        logger.warning("Broadcast job %s sends %s again (it had been changed to %s)", d.id, d.product, job.product)
        changed = True
    return changed


def new_job_id(cfg: BroadcastConfig, label: str) -> str:
    """A unique id for a new job, made from its name: `forecast-round-rock-tx`,
    then `-2`, `-3`. Never one of the built-in ids."""
    base = _slugify(label)[:56] or "job"
    candidate, n = base, 2
    while cfg.get_job(candidate) is not None or candidate in BUILTIN_IDS:
        candidate, n = f"{base}-{n}", n + 1
    return candidate


def _ensure_core_jobs(cfg: BroadcastConfig) -> bool:
    """Add any of the five v5 jobs that are missing. Returns True if it did.

    This is also the migration: a bot that already has a config file picks up
    the coverage job the next time it loads one."""
    added = False
    for job in _core_defaults():
        # A job the operator added for one place (a forecast for a city, one
        # station's observations) is not the built-in one.
        present = cfg.get_job(job.id) is not None or any(
            j.product == job.product and j.location_type == "coverage" for j in cfg.jobs)
        if not present:
            cfg.jobs.append(job)
            added = True
    return added


# -- Helpers --


def _split_csv(s: str) -> list[str]:
    return [p.strip() for p in (s or "").split(",") if p.strip()]


_SLUG_CHARS = re.compile(r"[^a-z0-9]+")


def _slugify(s: str) -> str:
    """Convert a display string like 'Austin TX' → 'austin-tx'."""
    s = s.strip().lower()
    s = _SLUG_CHARS.sub("-", s)
    s = s.strip("-")
    return s or "item"
