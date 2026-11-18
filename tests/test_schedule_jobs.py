"""The broadcast jobs as an operator edits them: five built-ins that stay, a
guided way to add a forecast or one station, a preview, and a reason for every
run that sends nothing."""

import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from meshcore_weather.config import settings
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.schedule import store as store_module
from meshcore_weather.schedule.models import BroadcastConfig, BroadcastJob, is_builtin


def _scheduler(monkeypatch, tmp_path):
    import meshcore_weather.schedule.scheduler as sched_mod
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    monkeypatch.setattr(sched_mod, "_STATE_PATH", tmp_path / "warning_state.json")
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    sent = []

    async def send(data, data_type=0xFF10, ev=None):
        sent.append(bytes(data))
        return True
    radio.send_channel_data = send
    return sched_mod.Scheduler(WeatherStore(), radio), sent


@pytest.fixture
def cfg_path(tmp_path, monkeypatch):
    path = tmp_path / "broadcast_config.json"
    monkeypatch.setattr(store_module, "CONFIG_PATH", path)
    return path


# -- the store -----------------------------------------------------------------

def test_a_builtin_edited_into_another_product_sends_its_own_again(cfg_path):
    cfg = store_module.default_config_for_bootstrap()
    cfg.upsert_job(cfg.get_job("warnings").model_copy(update={"product": "forecast", "location_type": "city",
                                                               "location_id": "Dallas TX"}))
    cfg_path.write_text(cfg.model_dump_json())
    loaded = store_module.load_config()
    w = loaded.get_job("warnings")
    assert (w.product, w.location_type, w.location_id) == ("warnings", "coverage", "")


def test_an_unreadable_job_is_set_aside_and_the_rest_kept(cfg_path):
    good = store_module.default_config_for_bootstrap().model_dump()
    good["jobs"].append({"id": "Bad Id!", "name": "x", "product": "forecast", "location_type": "city",
                         "location_id": "Waco TX", "interval_minutes": 360})
    good["jobs"].append({"id": "waco", "name": "Forecast: Waco", "product": "forecast", "location_type": "city",
                         "location_id": "Waco TX", "interval_minutes": 360})
    cfg_path.write_text(json.dumps(good))
    before = cfg_path.read_text()
    loaded = store_module.load_config()
    assert loaded.get_job("waco") is not None and len(loaded.jobs) == 6
    assert len(store_module.LOAD_PROBLEMS) == 1 and "ignored" in store_module.LOAD_PROBLEMS[0]
    assert cfg_path.read_text() == before                          # nothing rewritten
    assert cfg_path.with_name("broadcast_config.json.invalid").read_text() == before


def test_new_ids_are_made_from_the_name_and_never_a_builtin(cfg_path):
    cfg = store_module.default_config_for_bootstrap()
    assert store_module.new_job_id(cfg, "Forecast: Round Rock, TX") == "forecast-round-rock-tx"
    cfg.jobs.append(BroadcastJob(id="forecast-round-rock-tx", name="x", product="forecast",
                                 location_type="city", location_id="Round Rock TX", interval_minutes=360))
    assert store_module.new_job_id(cfg, "Forecast: Round Rock, TX") == "forecast-round-rock-tx-2"
    assert store_module.new_job_id(cfg, "Warnings") == "warnings-2"


def test_a_station_job_does_not_stand_in_for_the_builtin_batch(cfg_path):
    cfg_path.write_text(BroadcastConfig(jobs=[
        BroadcastJob(id="kdfw", name="Observations: KDFW", product="observations", location_type="station",
                     location_id="KDFW", interval_minutes=60)]).model_dump_json())
    ids = {j.id for j in store_module.load_config().jobs}
    assert {"kdfw", "observations", "forecast", "warnings", "digest", "coverage"} == ids


def test_the_home_forecast_is_builtin_whatever_its_id():
    old = BroadcastJob(id="forecast-austin-tx", name="Forecast: home", product="forecast",
                       location_type="coverage", location_id="home", interval_minutes=180)
    city = BroadcastJob(id="waco", name="Forecast: Waco", product="forecast",
                        location_type="city", location_id="Waco TX", interval_minutes=360)
    assert is_builtin(old) and not is_builtin(city)


# -- the scheduler -------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_job_that_sends_nothing_says_why_and_it_survives_a_restart(monkeypatch, tmp_path, cfg_path):
    sched, sent = _scheduler(monkeypatch, tmp_path)
    await sched._reload_config()
    job = BroadcastJob(id="nowhere", name="x", product="forecast", location_type="city",
                       location_id="Nowhere Special ZZ", interval_minutes=360)
    sched.current_config().upsert_job(job)
    assert await sched.run_job_now("nowhere") == 0 and not sent
    reason = sched.job_status("nowhere")["last_result"]["reason"]
    assert reason == "no place called 'Nowhere Special ZZ'"
    again, _ = _scheduler(monkeypatch, tmp_path)
    again._load_state()
    assert again._last_result["nowhere"]["reason"] == reason


@pytest.mark.asyncio
async def test_a_digest_turned_off_stays_off_after_a_cancel(monkeypatch, tmp_path, cfg_path):
    sched, sent = _scheduler(monkeypatch, tmp_path)
    await sched._reload_config()
    for j in sched.current_config().jobs:
        sched._last_run[j.id] = time.time()                 # nothing due on its own
    sched.current_config().get_job("digest").enabled = False
    sched._digest_due_at = time.time() - 1                  # a cancel went out a minute ago
    await sched.tick()
    assert not sent


def test_preview_builds_without_sending_or_moving_warning_state(monkeypatch, tmp_path, cfg_path):
    sched, sent = _scheduler(monkeypatch, tmp_path)
    asyncio.run(sched._reload_config())
    sched._warning_state = {"x": {"expires": 0}}
    out = sched.preview(sched.current_config().get_job("warnings"))
    assert out["packets"] == [] and sched._warning_state == {"x": {"expires": 0}} and not sent


# -- the portal API ------------------------------------------------------------

@pytest.fixture
def client(tmp_path, monkeypatch, cfg_path):
    from meshcore_weather.main import WeatherBot
    from meshcore_weather.portal.server import create_app
    from tests.test_admin_api import FakeRadio
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "admin_key", "")
    monkeypatch.setattr(settings, "tx_enabled", False)
    sched, sent = _scheduler(monkeypatch, tmp_path)
    asyncio.run(sched._reload_config())
    bot = WeatherBot()
    bot.store = sched.store
    bot.radio = FakeRadio()
    bot._broadcaster = SimpleNamespace(scheduler=sched, coverage=None)
    return TestClient(create_app(bot), headers={"X-Requested-With": "meshcore-portal"}), sched


def test_meta_offers_three_kinds_and_intervals_per_product(client):
    c, _ = client
    meta = c.get("/api/schedule/meta").json()
    assert set(meta["kinds"]) == {"forecast", "station", "radar"}
    assert meta["interval_choices"]["radar"] == [15, 30, 60]
    assert meta["interval_choices"]["warnings"] == [1, 2, 5]
    assert meta["default_interval"]["forecast"] == 360


def test_the_list_puts_the_builtins_first_and_marks_them(client):
    c, _ = client
    jobs = c.get("/api/schedule/jobs").json()["jobs"]
    assert [j["builtin"] for j in jobs] == [True] * 5
    obs = next(j for j in jobs if j["id"] == "observations")
    assert obs["location_label"].startswith("Stations within")


def test_adding_a_forecast_for_a_coordinate(client):
    c, sched = client
    r = c.post("/api/schedule/jobs", json={"kind": "forecast", "place": "30.508,-97.679", "interval_minutes": 720})
    assert r.status_code == 200, r.text
    job = r.json()["job"]
    assert job["id"] == "forecast-30-508-97-679" and job["name"] == "Forecast: 30.508, -97.679"
    assert job["builtin"] is False and job["location_type"] == "city"
    again = c.post("/api/schedule/jobs", json={"kind": "forecast", "place": "30.508,-97.679", "interval_minutes": 720})
    assert again.status_code == 400 and "already a broadcast" in again.json()["detail"]


def test_adding_refuses_what_cannot_work(client):
    c, _ = client
    assert c.post("/api/schedule/jobs", json={"kind": "radar", "place": "x"}).status_code == 400
    r = c.post("/api/schedule/jobs", json={"kind": "station", "station": "kzzz", "interval_minutes": 60})
    assert r.status_code == 400 and "not a station" in r.json()["detail"]
    r = c.post("/api/schedule/jobs", json={"kind": "forecast", "place": "30.5,-97.6", "interval_minutes": 7})
    assert r.status_code == 400 and "intervals offered" in r.json()["detail"]
    r = c.post("/api/schedule/jobs", json={"kind": "forecast", "place": "", "interval_minutes": 360})
    assert r.status_code == 400


def test_builtins_cannot_be_deleted_and_edits_keep_what_they_send(client):
    c, sched = client
    assert c.delete("/api/schedule/jobs/warnings").status_code == 400
    r = c.put("/api/schedule/jobs/warnings", json={"product": "forecast", "interval_minutes": 5, "name": "Alerts"})
    assert r.status_code == 200
    w = sched.current_config().get_job("warnings")
    assert (w.product, w.interval_minutes, w.name) == ("warnings", 5, "Alerts")
    assert c.put("/api/schedule/jobs/warnings", json={"interval_minutes": 60}).status_code == 400


def test_an_added_job_can_be_deleted(client):
    c, sched = client
    job = c.post("/api/schedule/jobs", json={"kind": "forecast", "place": "30.508,-97.679",
                                            "interval_minutes": 360}).json()["job"]
    assert c.delete(f"/api/schedule/jobs/{job['id']}").status_code == 200
    assert sched.current_config().get_job(job["id"]) is None


def test_run_now_refuses_a_job_that_is_off_and_says_why_nothing_went(client):
    c, sched = client
    sched.current_config().get_job("coverage").enabled = False
    assert c.post("/api/schedule/jobs/coverage/run-now").status_code == 400
    r = c.post("/api/schedule/jobs/observations/run-now").json()
    assert r["messages_sent"] == 0 and r["reason"]


def test_preview_explains_a_place_it_cannot_find(client):
    c, _ = client
    r = c.post("/api/schedule/preview", json={"kind": "forecast", "place": "Nowhere Special ZZ"}).json()
    assert r["ok"] is False and "No place called" in r["errors"][0]
    r = c.post("/api/schedule/preview", json={"job_id": "coverage"}).json()
    assert r["ok"] is True and "per_hour" in r and r["per_hour"]["cap"] == settings.scheduled_packets_per_hour


def test_needs_attention_says_when_warnings_are_off():
    from meshcore_weather.portal.routes.admin import attention
    items = attention({"radio": {"connected": True, "tx_enabled": True}, "satellite": {"reachable": True, "locked": True},
                       "feed": {"newest_age_s": 10}, "broadcasts": {"warnings_off": True}, "audit": {"available": True}})
    assert any("Warnings are not being broadcast" in i["text"] and i["level"] == "bad" for i in items)
