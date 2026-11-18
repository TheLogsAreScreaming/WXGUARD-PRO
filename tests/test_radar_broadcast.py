"""The scheduled radar broadcast (spec 15): the tile over the coverage, each
new picture while there is precipitation in it, once more when it clears.

The picture is the Southern Plains mosaic of 20 September 2026 23:38 UTC
(tests/fixtures/radar): a squall line across Dallas, Lubbock clear.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from meshcore_weather.config import settings
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol.coverage import Coverage
from meshcore_weather.radar import area
from meshcore_weather.radar.service import RadarService
from meshcore_weather.schedule import store as store_module
from meshcore_weather.schedule.models import BroadcastJob

FIXTURES = Path(__file__).parent / "fixtures" / "radar"
NOW = datetime(2026, 9, 20, 23, 49, tzinfo=timezone.utc)
TAKEN_MIN = 29832458            # 2026-09-20 23:38 UTC
DALLAS = (32.78, -96.80)
LUBBOCK = (33.58, -101.85)


@pytest.fixture(autouse=True)
def _quiet(monkeypatch, tmp_path):
    """No audit lines or job files in the operator's data directory."""
    from meshcore_weather.radar import audit
    monkeypatch.setattr(audit, "path", lambda: tmp_path / "radar_audit.jsonl")
    monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_path / "broadcast_config.json")


def _radar(monkeypatch, root=FIXTURES):
    from meshcore_weather.radar import service as service_mod
    radar = RadarService(root)
    real = radar.tile_at
    monkeypatch.setattr(radar, "tile_at", lambda south, west, zoom, now=None: real(south, west, zoom, now=NOW))
    monkeypatch.setattr(service_mod, "_shared", radar)
    return radar


def _scheduler(monkeypatch, tmp_path, home=DALLAS):
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.geodata import resolver
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    monkeypatch.setattr(sched_mod, "_STATE_PATH", tmp_path / "warning_state.json")
    monkeypatch.setattr(resolver, "home", lambda: home)
    _radar(monkeypatch)
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    sent = []

    async def send(data, data_type=0xFF10, ev=None):
        sent.append(bytes(data))
        return True
    radio.send_channel_data = send
    sched = sched_mod.Scheduler(WeatherStore(), radio)
    sched._coverage = Coverage.empty()
    return sched, sent


def _job(**kw) -> BroadcastJob:
    return BroadcastJob(**{"id": "radar", "name": "Radar", "product": "radar", "location_type": "coverage",
                           "interval_minutes": 15, **kw})


# -- the tile ------------------------------------------------------------------

@pytest.mark.parametrize("lat, lon, km, expected", [
    (30.27, -97.74, 120, (28, -100, 1)),      # Austin's coverage: the Regional tile
    (30.27, -97.74, 50, (29, -99, 0)),        # nearer in, the Local one
    (30.27, -97.74, 300, (24, -104, 3)),
    (30.27, -97.74, 900, None),               # wider than any tile
    (52.0, -179.5, 100, None),                # every tile would cross the antimeridian
])
def test_the_narrowest_tile_that_holds_the_circle(lat, lon, km, expected):
    assert area.area_tile(lat, lon, km) == expected


def test_the_tile_holds_the_whole_circle():
    for lat, lon in [(30.27, -97.74), (45.5, -122.7), (61.2, -149.9), (18.4, -66.1)]:
        south, west, zoom = area.area_tile(lat, lon, 150)
        span = 2 << zoom
        dlat = 150 / area.KM_PER_DEG
        assert south <= lat - dlat and lat + dlat < south + span
        assert west + span - lon > 1.3 and lon - west > 1.3         # 150 km of longitude is over 1.3 degrees


def test_what_the_tile_shows_in_words():
    radar = RadarService(FIXTURES)
    tile, _, _ = radar.tile_at(*area.area_tile(*DALLAS, 60), now=NOW)
    assert area.in_words(area.judge(tile, *DALLAS, 60, 1), 60, 1) == \
        "heavy precipitation within 60 km of home; light over home"
    heavy = area.judge(tile, *DALLAS, 60, 3)
    assert heavy["cells"] == 3 and area.in_words(heavy, 60, 3) == \
        "heavy precipitation within 60 km of home, nearest 42 km S"
    tile, _, _ = radar.tile_at(*area.area_tile(*LUBBOCK, 30), now=NOW)
    assert area.judge(tile, *LUBBOCK, 30, 1)["cells"] == 0


# -- the job -------------------------------------------------------------------

async def test_precipitation_in_the_area_sends_the_tile_and_starts_its_window(monkeypatch, tmp_path):
    sched, sent = _scheduler(monkeypatch, tmp_path)
    sched.current_config().upsert_job(_job(within_km=60))
    assert await sched._run(sched.current_config().get_job("radar"), sched.context()) == 1
    out = v5.decode(sent[0])
    assert out["name"] == "radar" and out["taken_min"] == TAKEN_MIN
    assert (out["south"], out["west"], out["zoom"]) == area.area_tile(*DALLAS, 60)
    result = sched.job_status("radar")["last_result"]
    assert result["packets"] == 1 and "precipitation within 60 km of home" in result["note"]
    assert sched._radar_state == {"judged": TAKEN_MIN, "wet": True}
    assert (out["south"], out["west"], out["zoom"], TAKEN_MIN) in sched.radar_on_air
    lines = (tmp_path / "radar_audit.jsonl").read_text().splitlines()
    assert json.loads(lines[0])["request"] == "(scheduled)"


async def test_the_same_picture_is_not_sent_twice_and_the_job_keeps_looking(monkeypatch, tmp_path):
    sched, sent = _scheduler(monkeypatch, tmp_path)
    sched.current_config().upsert_job(_job(within_km=60))
    job = sched.current_config().get_job("radar")
    await sched._run(job, sched.context())
    before = dict(sched.job_status("radar")["last_result"])
    assert await sched._run(job, sched.context()) == 0 and len(sent) == 1
    assert sched.job_status("radar")["last_result"] == before         # a look with nothing new leaves no mark
    assert sched._hold_until["radar"] > 0


async def test_a_dry_area_sends_nothing_and_says_so(monkeypatch, tmp_path):
    sched, sent = _scheduler(monkeypatch, tmp_path, home=LUBBOCK)
    sched.current_config().upsert_job(_job(within_km=30))
    assert await sched._run(sched.current_config().get_job("radar"), sched.context()) == 0 and not sent
    result = sched.job_status("radar")["last_result"]
    assert result["reason"] == "no precipitation within 30 km of home on the 23:38Z picture"
    assert result["idle"] is True
    assert "radar" not in sched._last_run                       # a dry look is not a run: the next picture is judged
    assert sched.scheduled_packets_per_hour() < 10              # and costs nothing while it is dry


async def test_one_more_picture_goes_when_the_area_clears(monkeypatch, tmp_path):
    sched, sent = _scheduler(monkeypatch, tmp_path, home=LUBBOCK)
    sched._radar_state.update(judged=TAKEN_MIN - 15, wet=True)
    sched.current_config().upsert_job(_job(within_km=30))
    assert await sched._run(sched.current_config().get_job("radar"), sched.context()) == 1
    assert "no precipitation left" in sched.job_status("radar")["last_result"]["note"]
    assert sched._radar_state["wet"] is False


async def test_heavy_only_ignores_lighter_precipitation(monkeypatch, tmp_path):
    sched, sent = _scheduler(monkeypatch, tmp_path)
    sched.current_config().upsert_job(_job(within_km=20, min_level=3))
    assert await sched._run(sched.current_config().get_job("radar"), sched.context()) == 0
    assert sched.job_status("radar")["last_result"]["reason"].startswith("nothing heavy within 20 km")


async def test_send_now_sends_the_picture_whatever_the_weather(monkeypatch, tmp_path):
    sched, sent = _scheduler(monkeypatch, tmp_path, home=LUBBOCK)
    sched.current_config().upsert_job(_job(within_km=30))
    assert await sched.run_job_now("radar") == 1
    assert await sched.run_job_now("radar") == 0                 # the same picture is inside its window
    assert "went out in the last" in sched.job_status("radar")["last_result"]["reason"]


async def test_an_answer_and_the_broadcast_share_the_window(monkeypatch, tmp_path):
    from meshcore_weather.protocol.broadcaster import AppResponder
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.geodata import resolver
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    monkeypatch.setattr(sched_mod, "_STATE_PATH", tmp_path / "warning_state.json")
    monkeypatch.setattr(resolver, "home", lambda: DALLAS)
    radar = _radar(monkeypatch)
    real = radar.tile_for
    monkeypatch.setattr(radar, "tile_for", lambda lat, lon, zoom=0, now=None: real(lat, lon, zoom, now=NOW))
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    sent = []

    async def send(data, data_type=0xFF10, ev=None):
        sent.append(bytes(data))
        return True
    radio.send_channel_data = send
    responder = AppResponder(WeatherStore(), radio, render_text=lambda c, a: None)
    sched = responder.scheduler
    sched._coverage = Coverage.empty()
    # 40 km around Dallas is the Local tile a phone gets for Dallas itself.
    assert area.area_tile(*DALLAS, 40) == (32, -98, 0)
    await responder.handle_request(">radar 32.780,-96.800", "aa")
    sched.current_config().upsert_job(_job(within_km=40))
    assert await sched._run(sched.current_config().get_job("radar"), sched.context()) == 0
    assert sched.job_status("radar")["last_result"]["reason"] == "the 23:38Z picture went out as an answer just now"
    assert len(sent) == 1


async def test_without_a_dish_it_says_so(monkeypatch, tmp_path):
    from meshcore_weather.radar import service as service_mod
    sched, sent = _scheduler(monkeypatch, tmp_path)
    monkeypatch.setattr(service_mod, "_shared", RadarService(None))
    sched.current_config().upsert_job(_job())
    assert await sched._run(sched.current_config().get_job("radar"), sched.context()) == 0
    assert "satellite dish" in sched.job_status("radar")["last_result"]["reason"]
    assert "radar" in sched._last_run                            # nothing to wait for: the interval applies


# -- the job file --------------------------------------------------------------

def test_a_radar_job_survives_a_reload_and_a_v4_one_does_not(tmp_path):
    cfg = store_module.default_config_for_bootstrap()
    cfg.upsert_job(_job(min_level=2, within_km=80))
    store_module.save_config(cfg)
    saved = json.loads(store_module.CONFIG_PATH.read_text())
    assert "min_level" not in next(j for j in saved["jobs"] if j["id"] == "warnings")
    loaded = store_module.load_config().get_job("radar")
    assert (loaded.min_level, loaded.within_km) == (2, 80)
    saved["jobs"].append({"id": "radar-ewx", "name": "Radar", "product": "radar", "location_type": "region",
                          "location_id": "EWX", "interval_minutes": 15})
    store_module.CONFIG_PATH.write_text(json.dumps(saved))
    assert store_module.load_config().get_job("radar-ewx") is None


# -- the portal ----------------------------------------------------------------

@pytest.fixture
def client(tmp_path, monkeypatch):
    from meshcore_weather.main import WeatherBot
    from meshcore_weather.portal.server import create_app
    from tests.test_admin_api import FakeRadio
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "admin_key", "")
    monkeypatch.setattr(settings, "tx_enabled", False)
    monkeypatch.setattr(settings, "home_radius_km", 120)
    sched, _ = _scheduler(monkeypatch, tmp_path)
    asyncio.run(sched._reload_config())
    bot = WeatherBot()
    bot.store = sched.store
    bot.radio = FakeRadio()
    bot._broadcaster = SimpleNamespace(scheduler=sched, coverage=None)
    return TestClient(create_app(bot), headers={"X-Requested-With": "meshcore-portal"}), sched


def test_adding_radar_from_the_portal(client):
    c, sched = client
    r = c.post("/api/schedule/preview", json={"kind": "radar", "min_level": 1, "within_km": "60"}).json()
    assert r["ok"] and r["packets"] == 1 and r["product"] == "radar"
    assert r["label"] == "Any precipitation within 60 km of home"
    assert any(n.startswith("Local tile") or n.startswith("Regional tile") for n in r["notes"])
    assert "precipitation" in r["note"] and r["radar"]["taken"] == "23:38Z"
    r = c.post("/api/schedule/jobs", json={"kind": "radar", "min_level": 2, "within_km": "120", "interval_minutes": 30})
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    assert (job["id"], job["name"], job["min_level"], job["within_km"]) == ("radar", "Radar", 2, None)
    assert job["builtin"] is False
    again = c.post("/api/schedule/jobs", json={"kind": "radar", "interval_minutes": 15})
    assert again.status_code == 400 and "already a radar broadcast" in again.json()["detail"]


def test_editing_radar_settings(client):
    c, sched = client
    c.post("/api/schedule/jobs", json={"kind": "radar", "interval_minutes": 15})
    assert c.put("/api/schedule/jobs/radar", json={"min_level": 3, "within_km": "45"}).status_code == 200
    job = sched.current_config().get_job("radar")
    assert (job.min_level, job.within_km) == (3, 45)
    assert c.put("/api/schedule/jobs/radar", json={"within_km": "900"}).status_code == 400   # no tile holds it
    assert c.put("/api/schedule/jobs/radar", json={"min_level": 4}).status_code == 400
    assert c.put("/api/schedule/jobs/radar", json={"interval_minutes": 5}).status_code == 400
    assert c.delete("/api/schedule/jobs/radar").status_code == 200
