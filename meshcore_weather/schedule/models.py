"""Pydantic models for the broadcast schedule config.

One `BroadcastConfig` per bot, containing a list of `BroadcastJob`
entries. Persistence is JSON; pydantic handles serialization and
validation automatically.
"""

from __future__ import annotations

import re
from pydantic import BaseModel, Field, field_validator


# v5 products. Each is one message type on the data channel; everything
# else (storm reports, METAR/TAF, outlooks, discussions, space weather) is
# request-only text and never scheduled.
PRODUCT_TYPES = {
    "warnings",       # every active warning in coverage, sent on change, with cancels and repeats
    "digest",         # the list of active warning identities (loss recovery)
    "observations",   # one batched packet of the coverage stations' current conditions
    "forecast",       # 7-day point forecast for a place or PFM point
    "coverage",       # what this bot covers: centre, radius, NWS offices, zone runs
    "radar",          # the radar tile over the coverage, while there is precipitation in it
}

# Location types: how the job's `location_id` is read.
LOCATION_TYPES = {
    "coverage",    # the operator's coverage area (warnings, digest, observations, forecast at the home point, radar)
    "city",        # a place name resolved by the bot, e.g. "Austin TX" (forecast)
    "pfm_point",   # index into client_data/pfm_points.json (forecast)
    "station",     # 4-letter ICAO (observations, one station)
}


# The five broadcasts every MeshWX app expects (spec §15). An operator can turn
# one off or change how often it runs, never delete it or make it send
# something else: an app relies on each of them.
BUILTIN_IDS = ("warnings", "digest", "observations", "forecast", "coverage")

# How often each product may run, in minutes: the choices the portal offers,
# and the one a new job starts with. Warnings are sent when they change; their
# interval is how often the bot looks, so it stays short.
INTERVAL_CHOICES = {
    "warnings": (1, 2, 5),
    "digest": (60, 120, 180, 360, 720),
    "observations": (30, 60, 120, 180),
    "forecast": (180, 360, 720, 1440),
    "coverage": (60, 180, 360, 720, 1440),
    # A new radar picture comes every 15 minutes: at most one picture per interval.
    "radar": (15, 30, 60),
}
DEFAULT_INTERVAL = {"warnings": 2, "digest": 180, "observations": 60, "forecast": 360, "coverage": 180,
                    "radar": 15}

# Radar's `min_level`: the weakest precipitation that counts (spec 13.1 levels).
RADAR_LEVELS = {1: "Any precipitation", 2: "Moderate or heavier precipitation", 3: "Heavy precipitation"}


def is_builtin(job: "BroadcastJob") -> bool:
    """One of the five built-in broadcasts. The home forecast counts however
    its id was written (a bot bootstrapped before 2026-10-17 named it after
    its city)."""
    return job.id in BUILTIN_IDS or (job.product == "forecast" and job.location_id.strip().lower() == "home")


_ID_PATTERN = re.compile(r"^[a-z0-9_-]+$")


class BroadcastJob(BaseModel):
    """One scheduled broadcast job.

    Identity is stable across config reloads via `id`. The scheduler uses
    `id` to track last-run timestamps so a rename or interval change
    doesn't reset the schedule.
    """

    id: str = Field(..., description="Stable unique identifier (slug)")
    name: str = Field(..., description="Human-readable label for the portal UI")
    product: str = Field(..., description="Product type (see PRODUCT_TYPES)")
    location_type: str = Field(..., description="Location type (see LOCATION_TYPES)")
    location_id: str = Field(
        "",
        description="Type-specific location identifier. Empty for 'coverage'.",
    )
    interval_minutes: int = Field(
        ..., gt=0, description="How often this job runs, in minutes"
    )
    enabled: bool = Field(True, description="If False, scheduler skips this job")
    # Radar only. None: any precipitation, within the coverage radius.
    min_level: int | None = Field(None, ge=1, le=3, description="Radar: weakest level that counts, 1-3")
    within_km: int | None = Field(None, gt=0, le=1000, description="Radar: how far from home, in km")

    @field_validator("id")
    @classmethod
    def _validate_id(cls, v: str) -> str:
        v = v.strip().lower()
        if not v:
            raise ValueError("id must not be empty")
        if len(v) > 64:
            raise ValueError("id too long (max 64 chars)")
        if not _ID_PATTERN.match(v):
            raise ValueError(
                "id must contain only lowercase letters, digits, hyphens, "
                "and underscores"
            )
        return v

    @field_validator("product")
    @classmethod
    def _validate_product(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in PRODUCT_TYPES:
            raise ValueError(
                f"unknown product {v!r}; must be one of: "
                f"{', '.join(sorted(PRODUCT_TYPES))}"
            )
        return v

    @field_validator("location_type")
    @classmethod
    def _validate_location_type(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in LOCATION_TYPES:
            raise ValueError(
                f"unknown location_type {v!r}; must be one of: "
                f"{', '.join(sorted(LOCATION_TYPES))}"
            )
        return v

    @field_validator("location_id")
    @classmethod
    def _validate_location_id(cls, v: str) -> str:
        # Further type-specific validation happens at executor time; at
        # the model level we just strip.
        return v.strip()


class BroadcastConfig(BaseModel):
    """Top-level broadcast schedule configuration.

    Contains a list of jobs plus a schema version for future
    compatibility. Persisted at `data/broadcast_config.json`.
    """

    version: int = Field(1, description="Schema version")
    jobs: list[BroadcastJob] = Field(default_factory=list)

    def get_job(self, job_id: str) -> BroadcastJob | None:
        """Look up a job by ID; returns None if not found."""
        for job in self.jobs:
            if job.id == job_id:
                return job
        return None

    def upsert_job(self, job: BroadcastJob) -> None:
        """Replace the existing job with the same ID, or append if new."""
        for i, existing in enumerate(self.jobs):
            if existing.id == job.id:
                self.jobs[i] = job
                return
        self.jobs.append(job)

    def delete_job(self, job_id: str) -> bool:
        """Remove a job by ID. Returns True if one was deleted."""
        before = len(self.jobs)
        self.jobs = [j for j in self.jobs if j.id != job_id]
        return len(self.jobs) < before
