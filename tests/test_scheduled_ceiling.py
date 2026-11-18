"""The ceiling on scheduled transmissions (phase 1, item 2) and restarts that
do not re-broadcast (item 3).

MCW_SCHEDULED_PACKETS_PER_HOUR (default 120) caps what every scheduled job
together puts on the air in an hour. Tornado, severe thunderstorm, flash
flood and extreme wind warnings and their one repeat always go and count;
past the ceiling the rest waits for room, with its state untouched. A
restart restores when each job last ran (and when the node last adverted),
and a per-bot jitter from the node key keeps two bots that boot together
from staying in lock-step.
"""

import asyncio
import json
import logging
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import meshcore_weather.schedule.scheduler as sched_mod
from meshcore_weather.config import settings
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol.coverage import Coverage
from meshcore_weather.schedule import executor as ex
from meshcore_weather.schedule import store as store_module
from meshcore_weather.schedule.models import BroadcastConfig, BroadcastJob

KEY_A = "1d04" + "aa" * 30
KEY_B = "77e2" + "bb" * 30


def _warning(etn, phen="SV", sig="W"):
    now = datetime.now(UTC)
    return {
        "event_code": b.tables.event_code(f"{phen}.{sig}"), "vtec_office": "EWX", "vtec_etn": etn,
        "vtec_phenomenon": phen, "vtec_significance": sig, "expires_at": now + timedelta(hours=2),
        "onset_unix_min": int(now.timestamp() // 60), "ugcs": ["TXC453"], "zones": [],
        "vertices": [(30.30, -97.90), (30.45, -97.85), (30.40, -97.60), (30.25, -97.65)],
        "hail_qin": 4, "wind_mph": 60, "tornado_tag": 0, "flood_source": 0, "flood_damage": 0,
        "headline": f"{phen}.{sig} {etn}", "description": "",
    }


def _ctx(monkeypatch, warnings, budget=None):
    monkeypatch.setattr(ex, "extract_active_warnings", lambda store, coverage=None: list(warnings))
    ctx = ex.ExecutorContext(store=WeatherStore(), coverage=Coverage.empty(), seq=b.SeqCounter(), bot=1)
    ctx.budget = budget
    return ctx


JOB = BroadcastJob(id="warnings", name="w", product="warnings", location_type="coverage", interval_minutes=2)


def _ids(msgs):
    return [v5.decode(m)["etn"] for m in msgs]


# -- The warnings builder under a budget ----------------------------------------------


def test_life_safety_warnings_go_out_with_no_room_left(monkeypatch):
    tor, svr, adv = _warning(1, "TO", "W"), _warning(2, "SV", "W"), _warning(3, "FA", "Y")
    ctx = _ctx(monkeypatch, [adv, tor, svr], budget=0)
    out = ex._build_warnings(JOB, ctx)
    assert _ids(out) == [1, 2] and ctx.held_back == 1
    assert "FA.Y.EWX.3" not in ctx.warning_state          # held back: state untouched, tried again
    ctx.budget = 5
    assert _ids(ex._build_warnings(JOB, ctx)) == [3]


def test_the_room_goes_to_life_safety_first_then_in_order(monkeypatch):
    ws = [_warning(10, "FA", "Y"), _warning(11, "TO", "W"), _warning(12, "FL", "W"), _warning(13, "FF", "W")]
    ctx = _ctx(monkeypatch, ws, budget=3)
    out = ex._build_warnings(JOB, ctx)
    # Two protected take two of the three; one advisory fits, in feed order.
    assert _ids(out) == [10, 11, 13] and ctx.held_back == 1


def test_the_life_safety_repeat_is_never_held(monkeypatch):
    tor = _warning(5, "TO", "W")
    ctx = _ctx(monkeypatch, [tor])
    ex._build_warnings(JOB, ctx)
    ctx.warning_state["TO.W.EWX.5"]["repeat_at"] = time.time() - 1
    ctx.budget = 0
    assert _ids(ex._build_warnings(JOB, ctx)) == [5] and ctx.warning_state["TO.W.EWX.5"]["repeat_at"] is None


def test_a_held_cancel_keeps_its_state_and_goes_later(monkeypatch):
    adv = _warning(7, "FA", "Y")
    active = [adv]
    ctx = _ctx(monkeypatch, active)
    ex._build_warnings(JOB, ctx)
    active.clear()
    ctx.budget = 0
    assert ex._build_warnings(JOB, ctx) == [] and "FA.Y.EWX.7" in ctx.warning_state
    ctx.budget = 1
    out = ex._build_warnings(JOB, ctx)
    assert v5.decode(out[0])["name"] == "cancel" and "FA.Y.EWX.7" not in ctx.warning_state


def test_no_budget_means_the_old_behaviour(monkeypatch):
    ws = [_warning(i, "FA", "Y") for i in range(1, 30)]
    ctx = _ctx(monkeypatch, ws)
    assert len(ex._build_warnings(JOB, ctx)) == 29 and ctx.held_back == 0


# -- The scheduler ---------------------------------------------------------------------


def _sched(monkeypatch, tmp_path, key=KEY_A, jobs=None):
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    cfg_path = tmp_path / "broadcast_config.json"
    if jobs is not None:
        cfg_path.write_text(BroadcastConfig(version=2, jobs=jobs).model_dump_json())
    monkeypatch.setattr(store_module, "CONFIG_PATH", cfg_path)
    monkeypatch.setattr(sched_mod, "CONFIG_PATH", cfg_path)
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": key, "name": "WX-TST"}
    radio.last_advert_at = 0.0
    sent = []

    async def send(data, data_type=0xFF10, ev=None):
        sent.append(bytes(data))
        return True
    radio.send_channel_data = send
    s = sched_mod.Scheduler(WeatherStore(), radio)
    s._coverage = Coverage.empty()          # no filter: the builders below decide what exists
    return s, sent


@pytest.mark.asyncio
async def test_other_jobs_wait_at_the_ceiling_and_say_so_once_an_hour(monkeypatch, tmp_path, caplog):
    monkeypatch.setattr(settings, "scheduled_packets_per_hour", 3)
    monkeypatch.setitem(ex.PRODUCT_BUILDERS, "digest", lambda job, ctx: [v5.encode_cancel(0, 1, event=3, office=35, etn=99)])
    s, sent = _sched(monkeypatch, tmp_path, jobs=[
        BroadcastJob(id="digest", name="d", product="digest", location_type="coverage", interval_minutes=1)])
    await s._reload_config()
    for j in s._config.jobs:                            # the core jobs load_config adds: not due
        if j.id != "digest":
            s._last_run[j.id] = time.time()
    s._sched_sent.extend([time.time()] * 3)             # the hour is spent
    with caplog.at_level(logging.WARNING, logger="meshcore_weather.schedule.scheduler"):
        assert await s.tick() == 0
        assert await s.tick() == 0
    assert not sent and "digest" not in s._last_run      # not counted as run: it is tried again
    assert len([r for r in caplog.records if "ceiling" in r.getMessage()]) == 1
    st = s.ceiling_status()
    assert st["spent"] and st["used"] == 3 and st["jobs_waited"] == ["digest"] and st["opens_in_s"] > 3500
    s._sched_sent.clear()                               # an hour later
    assert await s.tick() == 1 and len(sent) == 1 and "digest" in s._last_run


@pytest.mark.asyncio
async def test_life_safety_goes_past_the_ceiling_and_counts(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "scheduled_packets_per_hour", 2)
    ws = [_warning(1, "FA", "Y"), _warning(2, "TO", "W"), _warning(3, "SV", "W"), _warning(4, "FF", "W")]
    monkeypatch.setattr(ex, "extract_active_warnings", lambda store, coverage=None: list(ws))
    s, sent = _sched(monkeypatch, tmp_path, jobs=[JOB])
    await s._reload_config()
    for j in s._config.jobs:
        if j.id != "warnings":
            s._last_run[j.id] = time.time()
    assert await s.tick() == 3
    assert sorted(_ids(sent)) == [2, 3, 4]               # the advisory waits
    assert s.ceiling_status()["used"] == 3 and s.ceiling_status()["jobs_waited"] == ["warnings"]


@pytest.mark.asyncio
async def test_a_day_of_routine_jobs_is_far_below_the_default_ceiling(monkeypatch, tmp_path):
    """The default schedule's own load: the digest and coverage every 3 h, the
    observations hourly, the forecast every 6 h. Simulated over 24 h of
    ticks, never more than a handful of packets in any hour."""
    assert settings.scheduled_packets_per_hour == 120
    for product in ("digest", "observations", "forecast", "coverage"):
        monkeypatch.setitem(ex.PRODUCT_BUILDERS, product,
                            lambda job, ctx: [v5.encode_cancel(0, 1, event=3, office=35, etn=1)])
    monkeypatch.setitem(ex.PRODUCT_BUILDERS, "warnings", lambda job, ctx: [])
    monkeypatch.setattr(sched_mod.resolver, "_home", (30.27, -97.74))
    s, sent = _sched(monkeypatch, tmp_path)
    await s._reload_config()
    calls = []
    real = sched_mod.resolver.resolve_by_coords
    monkeypatch.setattr(sched_mod.resolver, "resolve_by_coords", lambda *a, **k: calls.append(a) or real(*a, **k))
    clock = [1_800_000_000.0]
    # The scheduler's clock only: patching time.time itself would reach into
    # whatever else is running in this process.
    monkeypatch.setattr(sched_mod, "time", SimpleNamespace(time=lambda: clock[0], monotonic=time.monotonic))
    per_hour = []
    for hour in range(24):
        before = len(sent)
        for _ in range(120):                            # a tick every 30 s
            await s.tick()
            clock[0] += 30
        per_hour.append(len(sent) - before)
    assert max(per_hour) <= 4 and sum(per_hour) == 8 + 24 + 4 + 8
    assert len(calls) == 1                              # the home's offices: looked up once, not every tick


# -- Restarts --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_restart_does_not_rebroadcast_the_periodic_jobs(monkeypatch, tmp_path):
    for product in ("digest", "observations", "forecast", "coverage", "warnings"):
        monkeypatch.setitem(ex.PRODUCT_BUILDERS, product,
                            lambda job, ctx: [] if job.product == "warnings" else
                            [v5.encode_cancel(0, 1, event=3, office=35, etn=1)])
    s, _sent = _sched(monkeypatch, tmp_path)
    await s._reload_config()
    s._plan_start(time.time() - 3600)                   # jitter long past
    assert await s.tick() == 4                          # digest, observations, forecast, coverage
    s.radio.last_advert_at = time.time() - 600
    s._save_state()
    saved = json.loads(sched_mod._STATE_PATH.read_text())
    assert set(saved["last_run"]) == {"warnings", "digest", "observations", "forecast", "coverage"}
    assert saved["advert"]["key"] == KEY_A and len(saved["sched_sent"]) == 4

    again, sent2 = _sched(monkeypatch, tmp_path)        # the restart
    again._load_state()
    await again._reload_config()
    again._plan_start(time.time())
    assert await again.tick() == 0 and not sent2
    assert again.ceiling_status()["used"] == 4          # the hour's count survives too
    assert again.job_status("digest")["next_run_in_seconds"] > 3 * 3600 - 60
    rec = sched_mod.load_advert_record()
    assert rec["key"] == KEY_A and abs(rec["at"] - (time.time() - 600)) < 5


def test_a_saved_run_time_from_the_future_counts_as_now(monkeypatch, tmp_path):
    sched_mod._STATE_PATH.write_text(json.dumps({"warnings": {}, "next_seq": 5,
                                                 "last_run": {"digest": time.time() + 86400}}))
    s, _ = _sched(monkeypatch, tmp_path)
    s._load_state()
    assert s._last_run["digest"] <= time.time()


def test_old_state_files_still_load(monkeypatch, tmp_path):
    sched_mod._STATE_PATH.write_text(json.dumps({"warnings": {}, "next_seq": 9}))
    s, _ = _sched(monkeypatch, tmp_path)
    s._load_state()
    assert s.next_seq == 9 and s._last_run == {} and sched_mod.load_advert_record() is None


@pytest.mark.asyncio
async def test_the_jitter_is_per_bot_bounded_and_spares_the_warnings(monkeypatch, tmp_path):
    a, _ = _sched(monkeypatch, tmp_path, key=KEY_A)
    bb, _ = _sched(monkeypatch, tmp_path, key=KEY_B)
    for s in (a, bb):
        await s._reload_config()
    now = time.time()
    a._plan_start(now)
    bb._plan_start(now)
    assert "warnings" not in a._hold_until                 # changes only: never delayed
    offsets_a = {j: t - now for j, t in a._hold_until.items()}
    offsets_b = {j: t - now for j, t in bb._hold_until.items()}
    assert set(offsets_a) == {"digest", "observations", "forecast", "coverage"}
    assert all(0 <= v <= sched_mod.START_JITTER_MAX_S for v in offsets_a.values())
    assert offsets_a != offsets_b                           # two bots, two phases
    a2, _ = _sched(monkeypatch, tmp_path, key=KEY_A)
    await a2._reload_config()
    a2._plan_start(now)
    assert {j: t - now for j, t in a2._hold_until.items()} == offsets_a   # the same bot, the same phase


def test_jitter_fraction_is_stable_and_spread():
    fr = [sched_mod.jitter_fraction(f"key{i}", "digest") for i in range(200)]
    assert all(0 <= f < 1 for f in fr) and min(fr) < 0.1 and max(fr) > 0.9
    assert sched_mod.jitter_fraction("k", "digest") == sched_mod.jitter_fraction("k", "digest")


def test_a_mock_radio_never_breaks_the_state_file(monkeypatch, tmp_path):
    s, _ = _sched(monkeypatch, tmp_path)
    s.radio.last_advert_at = MagicMock()                  # not a number: nothing saved for it
    s._save_state()
    assert "advert" not in json.loads(sched_mod._STATE_PATH.read_text())


# -- The radio's side of a restart -----------------------------------------------------


def _radio(key=KEY_A):
    from meshcore_weather.meshcore.radio import MeshcoreRadio
    r = MeshcoreRadio()
    r._mc = MagicMock()
    r._mc.self_info = {"public_key": key, "name": "WX-TST", "radio_freq": 910.525, "radio_bw": 62.5}
    return r


def test_a_recent_advert_of_the_same_key_stands_in_for_the_connect_advert():
    r = _radio()
    r.restored_advert = {"at": time.time() - 1800, "key": KEY_A}
    assert r._restored_advert_fresh() and abs(r.last_advert_at - (time.time() - 1800)) < 5
    r = _radio()
    r.restored_advert = {"at": time.time() - 1800, "key": KEY_B}      # a new identity must advert
    assert not r._restored_advert_fresh()
    r = _radio()
    r.restored_advert = {"at": time.time() - 7 * 3600, "key": KEY_A}  # older than the interval
    assert not r._restored_advert_fresh()
    assert not _radio()._restored_advert_fresh()


@pytest.mark.asyncio
async def test_the_advert_loop_waits_out_the_restored_interval(monkeypatch):
    r = _radio()
    r._running = True
    r.last_advert_at = time.time() - 5 * 3600              # 6 h interval: one hour to go
    waits = []

    async def fake_sleep(s):
        waits.append(s)
        r._running = False
    sent = []

    async def fake_advert():
        sent.append(1)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(r, "_send_advert", fake_advert)
    r._mc.ensure_contacts = MagicMock(side_effect=Exception("no"))
    await r._advert_loop()
    assert 3500 < waits[0] < 3700 and sent == [1]


@pytest.mark.asyncio
async def test_a_reconnect_carries_the_last_advert_to_the_new_radio(monkeypatch):
    """A USB hiccup (four in five minutes on 2026-10-01) is not a reason to
    flood an advert: the new radio object gets the old one's last advert."""
    from meshcore_weather import main as main_mod

    class NewRadio:
        def __init__(self):
            self.restored_advert = None
            self.data_channel_idx = None

        def __getattr__(self, name):          # on_channel_message, on_dm, ...
            return lambda *a, **k: None

        async def start(self):
            pass

    old = MagicMock()
    old.last_advert_at = time.time() - 900
    old.public_key = KEY_A
    old.stop = _async_none
    monkeypatch.setattr(main_mod, "MeshcoreRadio", NewRadio)
    bot = main_mod.WeatherBot.__new__(main_mod.WeatherBot)
    bot.radio, bot._radio_task, bot._broadcaster, bot._radio_last_error = old, None, None, None
    await bot.reconnect_radio()
    assert bot.radio.restored_advert == {"at": old.last_advert_at, "key": KEY_A}


async def _async_none(*a, **k):
    return None
