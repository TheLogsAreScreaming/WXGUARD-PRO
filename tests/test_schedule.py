"""Tests for the unified broadcast schedule system."""

import asyncio
import json
import os
import tempfile
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from meshcore_weather.schedule.models import (
    BroadcastConfig,
    BroadcastJob,
    LOCATION_TYPES,
    PRODUCT_TYPES,
)
from meshcore_weather.schedule import store as store_module


# -- Model validation --------------------------------------------------------


class TestBroadcastJobValidation:
    def test_minimal_valid_job(self):
        job = BroadcastJob(
            id="test-1",
            name="Test job",
            product="observations",
            location_type="coverage",
            interval_minutes=15,
        )
        assert job.id == "test-1"
        assert job.enabled is True  # default
        assert job.location_id == ""

    def test_id_gets_lowercased(self):
        job = BroadcastJob(
            id="UPPER-CASE",
            name="x",
            product="observations",
            location_type="coverage",
            interval_minutes=5,
        )
        assert job.id == "upper-case"

    def test_id_rejects_spaces(self):
        with pytest.raises(Exception):
            BroadcastJob(
                id="has space",
                name="x",
                product="observations",
                location_type="coverage",
                interval_minutes=5,
            )

    def test_id_rejects_special_chars(self):
        with pytest.raises(Exception):
            BroadcastJob(
                id="has/slash",
                name="x",
                product="observations",
                location_type="coverage",
                interval_minutes=5,
            )

    def test_unknown_product_rejected(self):
        with pytest.raises(Exception):
            BroadcastJob(
                id="ok",
                name="x",
                product="something_bogus",
                location_type="coverage",
                interval_minutes=5,
            )

    def test_unknown_location_type_rejected(self):
        with pytest.raises(Exception):
            BroadcastJob(
                id="ok",
                name="x",
                product="observations",
                location_type="not_a_real_type",
                interval_minutes=5,
            )

    def test_zero_interval_rejected(self):
        with pytest.raises(Exception):
            BroadcastJob(
                id="ok",
                name="x",
                product="observations",
                location_type="coverage",
                interval_minutes=0,
            )

    def test_negative_interval_rejected(self):
        with pytest.raises(Exception):
            BroadcastJob(
                id="ok",
                name="x",
                product="observations",
                location_type="coverage",
                interval_minutes=-5,
            )

    def test_all_products_are_accepted(self):
        """Every product in PRODUCT_TYPES constructs a valid job."""
        for product in PRODUCT_TYPES:
            job = BroadcastJob(
                id=f"test-{product}",
                name=product,
                product=product,
                location_type="coverage",
                interval_minutes=60,
            )
            assert job.product == product

    def test_all_location_types_are_accepted(self):
        for lt in LOCATION_TYPES:
            job = BroadcastJob(
                id=f"test-{lt}",
                name=lt,
                product="observations",
                location_type=lt,
                interval_minutes=60,
            )
            assert job.location_type == lt


class TestBroadcastConfigMutations:
    def test_upsert_insert(self):
        cfg = BroadcastConfig()
        job = BroadcastJob(
            id="a",
            name="A",
            product="observations",
            location_type="coverage",
            interval_minutes=5,
        )
        cfg.upsert_job(job)
        assert len(cfg.jobs) == 1
        assert cfg.get_job("a") is not None

    def test_upsert_replaces_existing(self):
        cfg = BroadcastConfig()
        cfg.upsert_job(
            BroadcastJob(
                id="a",
                name="A",
                product="observations",
                location_type="coverage",
                interval_minutes=5,
            )
        )
        cfg.upsert_job(
            BroadcastJob(
                id="a",
                name="A prime",
                product="observations",
                location_type="coverage",
                interval_minutes=15,
            )
        )
        assert len(cfg.jobs) == 1
        assert cfg.get_job("a").name == "A prime"
        assert cfg.get_job("a").interval_minutes == 15

    def test_delete(self):
        cfg = BroadcastConfig()
        cfg.upsert_job(
            BroadcastJob(
                id="a",
                name="A",
                product="observations",
                location_type="coverage",
                interval_minutes=5,
            )
        )
        assert cfg.delete_job("a") is True
        assert cfg.delete_job("a") is False  # second delete is a no-op
        assert len(cfg.jobs) == 0

    def test_json_roundtrip(self):
        cfg = BroadcastConfig(
            version=1,
            jobs=[
                BroadcastJob(
                    id=f"job-{i}",
                    name=f"Job {i}",
                    product="observations",
                    location_type="coverage",
                    interval_minutes=15 + i,
                )
                for i in range(5)
            ],
        )
        js = cfg.model_dump_json()
        restored = BroadcastConfig(**json.loads(js))
        assert len(restored.jobs) == 5
        for i, job in enumerate(restored.jobs):
            assert job.id == f"job-{i}"
            assert job.interval_minutes == 15 + i


# -- Persistence -------------------------------------------------------------


class TestStorePersistence:
    def test_save_and_load_roundtrip(self, tmp_path, monkeypatch):
        # Redirect CONFIG_PATH to a temp location
        tmp_cfg = tmp_path / "broadcast_config.json"
        monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_cfg)

        cfg = BroadcastConfig(
            version=1,
            jobs=[
                BroadcastJob(
                    id="round-trip",
                    name="Round trip",
                    product="forecast",
                    location_type="city",
                    location_id="Austin TX",
                    interval_minutes=60,
                )
            ],
        )
        store_module.save_config(cfg)
        assert tmp_cfg.exists()
        loaded = store_module.load_config()
        # The saved job plus all five built-ins: a forecast for a city is one
        # the operator added, not the home forecast.
        assert len(loaded.jobs) == 6
        assert loaded.jobs[0].id == "round-trip"
        assert loaded.jobs[0].location_id == "Austin TX"

    def test_corrupt_file_falls_back_to_defaults(self, tmp_path, monkeypatch):
        tmp_cfg = tmp_path / "broadcast_config.json"
        tmp_cfg.write_text("{this is not valid json")
        monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_cfg)

        cfg = store_module.load_config()
        # Corrupt file → falls back to default_config_for_bootstrap, which
        # always emits at least warnings-delta + warnings-full.
        ids = {j.id for j in cfg.jobs}
        assert {"warnings", "digest", "observations", "forecast"} <= ids

    def test_missing_file_bootstraps_and_saves(self, tmp_path, monkeypatch):
        tmp_cfg = tmp_path / "broadcast_config.json"
        assert not tmp_cfg.exists()
        monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_cfg)

        cfg = store_module.load_config()
        # Default bootstrap ran and the result was persisted
        assert tmp_cfg.exists()
        assert len(cfg.jobs) >= 2  # at minimum warnings delta + full

    def test_atomic_write_does_not_leave_tmp(self, tmp_path, monkeypatch):
        """save_config should use temp-then-rename so no .tmp files survive."""
        tmp_cfg = tmp_path / "broadcast_config.json"
        monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_cfg)
        cfg = BroadcastConfig(version=1, jobs=[])
        store_module.save_config(cfg)
        # The temp file should not exist after a successful write
        tmp_file = tmp_cfg.with_suffix(".json.tmp")
        assert not tmp_file.exists()


# -- Default bootstrap -------------------------------------------------------


class TestBootstrap:
    def test_bootstrap_has_the_five_v5_jobs(self, monkeypatch):
        from meshcore_weather.config import settings
        monkeypatch.setattr(settings, "home_cities", "Austin TX,Dallas TX")
        cfg = store_module.default_config_for_bootstrap()
        by_id = {j.id: j for j in cfg.jobs}
        assert set(by_id) == {"warnings", "digest", "observations", "forecast", "coverage"}
        assert by_id["warnings"].interval_minutes == 2 and by_id["digest"].interval_minutes == 180
        assert by_id["observations"].location_type == "coverage"
        # The home point by reference, resolved when the job runs: never a
        # place name baked into a file that gets copied to another city.
        assert by_id["forecast"].location_type == "coverage" and by_id["forecast"].location_id == "home"
        # The coverage statement rides with the digest: one packet every 3 h.
        assert by_id["coverage"].product == "coverage" and by_id["coverage"].interval_minutes == 180
        assert by_id["coverage"].location_type == "coverage" and by_id["coverage"].enabled

    def test_bootstrap_with_no_home_cities_forecasts_the_coverage_centre(self, monkeypatch):
        from meshcore_weather.config import settings
        monkeypatch.setattr(settings, "home_cities", "")
        cfg = store_module.default_config_for_bootstrap()
        assert len(cfg.jobs) == 5 and cfg.get_job("forecast").location_type == "coverage"

    def test_v4_config_migrates_to_v5_jobs(self, tmp_path, monkeypatch):
        """The Pi's old file: delta -> warnings, full -> digest, per-city obs -> one batch."""
        import json
        from meshcore_weather.config import settings
        monkeypatch.setattr(settings, "home_cities", "Austin TX")
        old = {"version": 1, "jobs": [
            {"id": "warnings-delta", "name": "d", "product": "warnings_delta", "location_type": "coverage",
             "location_id": "", "interval_minutes": 2, "enabled": False},
            {"id": "warnings-full", "name": "f", "product": "warnings", "location_type": "coverage",
             "location_id": "", "interval_minutes": 120, "enabled": True},
            {"id": "obs-austin-tx", "name": "o", "product": "observation", "location_type": "city",
             "location_id": "Austin TX", "interval_minutes": 60, "enabled": True},
            {"id": "obs-dallas-tx", "name": "o2", "product": "observation", "location_type": "city",
             "location_id": "Dallas TX", "interval_minutes": 60, "enabled": True},
            {"id": "forecast-austin-tx", "name": "fc", "product": "forecast", "location_type": "city",
             "location_id": "Austin TX", "interval_minutes": 60, "enabled": True},
            {"id": "afd", "name": "afd", "product": "afd", "location_type": "wfo",
             "location_id": "EWX", "interval_minutes": 720, "enabled": True},
        ]}
        cfg_path = tmp_path / "broadcast_config.json"
        cfg_path.write_text(json.dumps(old))
        monkeypatch.setattr(store_module, "CONFIG_PATH", cfg_path)
        cfg = store_module.load_config()
        by_id = {j.id: j for j in cfg.jobs}
        # The coverage job is added on load, so an old file picks it up too.
        assert set(by_id) == {"warnings", "digest", "observations",
                              "forecast-austin-tx", "coverage"}
        assert by_id["warnings"].product == "warnings" and by_id["warnings"].enabled is False
        assert by_id["digest"].product == "digest" and by_id["digest"].interval_minutes == 180
        assert by_id["observations"].location_type == "coverage"
        assert by_id["forecast-austin-tx"].interval_minutes == 180


# -- Scheduler semantics -----------------------------------------------------


class TestSchedulerTick:
    @pytest.mark.asyncio
    async def test_job_does_not_run_before_interval_elapsed(self, tmp_path, monkeypatch):
        """A job with interval=60min that ran 1s ago should NOT run on the next tick."""
        from meshcore_weather.parser.weather import WeatherStore
        from meshcore_weather.schedule.scheduler import Scheduler

        tmp_cfg = tmp_path / "broadcast_config.json"
        tmp_cfg.write_text(
            BroadcastConfig(
                version=1,
                jobs=[
                    BroadcastJob(
                        id="far-future",
                        name="shouldn't run",
                        product="warnings",
                        location_type="coverage",
                        interval_minutes=60,
                    )
                ],
            ).model_dump_json()
        )
        monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_cfg)

        store = WeatherStore()
        radio = MagicMock()
        radio.send_lock = asyncio.Lock()
        radio.send_channel_data = AsyncMock(return_value=True)
        sched = Scheduler(store, radio)

        # Skip start() to avoid opening an HTTP client; just initialize state manually
        sched._coverage = sched._coverage  # no-op; Coverage.empty() by default
        await sched._reload_config()
        # Fake "already ran this tick" (for the core jobs load_config adds too)
        for j in sched._config.jobs:
            sched._last_run[j.id] = time.time()
        sched._http_client = None

        sent_count = await sched.tick()
        assert sent_count == 0
        # send_binary_channel should not have been called
        radio.send_channel_data.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_disabled_job_is_skipped(self, tmp_path, monkeypatch):
        from meshcore_weather.parser.weather import WeatherStore
        from meshcore_weather.schedule.scheduler import Scheduler

        tmp_cfg = tmp_path / "broadcast_config.json"
        tmp_cfg.write_text(
            BroadcastConfig(
                version=1,
                jobs=[
                    BroadcastJob(
                        id="disabled-job",
                        name="off",
                        product="warnings",
                        location_type="coverage",
                        interval_minutes=1,
                        enabled=False,
                    )
                ],
            ).model_dump_json()
        )
        monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_cfg)

        store = WeatherStore()
        radio = MagicMock()
        radio.send_lock = asyncio.Lock()
        radio.send_channel_data = AsyncMock(return_value=True)
        sched = Scheduler(store, radio)

        await sched._reload_config()
        for j in sched._config.jobs:                    # only the disabled job is due
            if j.id != "disabled-job":
                sched._last_run[j.id] = time.time()

        sent_count = await sched.tick()
        assert sent_count == 0
        radio.send_channel_data.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_one_bad_builder_does_not_break_other_jobs(self, tmp_path, monkeypatch):
        """A builder that raises should log but not stop the tick from
        processing other jobs."""
        from meshcore_weather.parser.weather import WeatherStore
        from meshcore_weather.schedule import executor as executor_module
        from meshcore_weather.schedule.scheduler import Scheduler

        tmp_cfg = tmp_path / "broadcast_config.json"
        tmp_cfg.write_text(
            BroadcastConfig(
                version=1,
                jobs=[
                    BroadcastJob(
                        id="bad-one",
                        name="raises",
                        product="warnings",
                        location_type="coverage",
                        interval_minutes=1,
                    ),
                    BroadcastJob(
                        id="good-one",
                        name="works",
                        product="warnings",
                        location_type="coverage",
                        interval_minutes=1,
                    ),
                ],
            ).model_dump_json()
        )
        monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_cfg)

        # Patch the warnings builder so the FIRST call raises, the SECOND returns []
        call_count = {"n": 0}
        original_builder = executor_module.PRODUCT_BUILDERS["warnings"]

        def flaky_warnings(job, ctx):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("simulated builder failure")
            return []

        monkeypatch.setitem(executor_module.PRODUCT_BUILDERS, "warnings", flaky_warnings)

        store = WeatherStore()
        radio = MagicMock()
        radio.send_lock = asyncio.Lock()
        radio.send_channel_data = AsyncMock(return_value=True)
        sched = Scheduler(store, radio)
        await sched._reload_config()
        sched._http_client = None

        # Both jobs should execute — the exception is caught per-job
        await sched.tick()
        assert call_count["n"] == 2


# -- App requests (v5) ----------------------------------------------------------


class TestAppResponder:
    def _responder(self):
        from meshcore_weather.parser.weather import WeatherStore
        from meshcore_weather.protocol.broadcaster import AppResponder
        import meshcore_weather.schedule.scheduler as sched_mod
        sched_mod.TX_SPACING = 0
        radio = MagicMock()
        radio._mc = MagicMock()
        radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
        sent = []

        async def cap(data, data_type=0xFF10, ev=None):
            sent.append(data)
            return True
        radio.send_channel_data = cap
        return AppResponder(WeatherStore(), radio, render_text=lambda c, a: None), sent

    @pytest.mark.asyncio
    async def test_unknown_station_and_unsupported_command(self):
        from meshcore_weather.protocol import v5
        r, sent = self._responder()
        await r.handle_request(">o ZZZZ", "a")
        d = v5.decode(sent[-1])
        assert d["name"] == "not_available" and d["reason"] == v5.REASON_UNKNOWN_LOCATION and d["bot"] == 0x041D
        await r.handle_request(">nope", "b")
        assert v5.decode(sent[-1])["reason"] == v5.REASON_UNSUPPORTED

    @pytest.mark.asyncio
    async def test_empty_store_answers_no_data_and_rate_limits(self):
        from meshcore_weather.protocol import v5
        r, sent = self._responder()
        await r.handle_request(">o KAUS", "a")
        assert v5.decode(sent[-1])["reason"] == v5.REASON_NO_DATA
        n = len(sent)
        assert await r.handle_request(">o KAUS", "a") == "rate limited" and len(sent) == n
        await r.handle_request(">d", "b")
        d = v5.decode(sent[-1])
        assert d["name"] == "digest" and d["entries"] == [] and d["feed_health"] == 255


# -- Revision 3: seq stamped on air, one transmit at a time, budget, named stations --


def _sched(monkeypatch, results=None):
    """A Scheduler whose radio keeps what it was handed and answers from
    `results` (True once they run out)."""
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.parser.weather import WeatherStore
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    handed, answers = [], list(results or [])

    async def send(data, data_type=0xFF10, ev=None):
        handed.append(bytes(data))
        await asyncio.sleep(0)                      # give a concurrent transmit the chance to cut in
        return answers.pop(0) if answers else True
    radio.send_channel_data = send
    return sched_mod.Scheduler(WeatherStore(), radio), handed


def _cancels(*etns):
    from meshcore_weather.protocol import v5
    return [v5.encode_cancel(7, 1, event=3, office=35, etn=n) for n in etns]   # the builder's seq 7 is ignored


@pytest.mark.asyncio
async def test_seq_is_stamped_at_send_and_a_failed_send_reuses_it(monkeypatch):
    from meshcore_weather.protocol import v5
    s, handed = _sched(monkeypatch, results=[True, False, True])
    s._next_seq = 254
    assert await s.transmit(_cancels(1, 2, 3), "t") == (2, 16)
    assert [m[0] for m in handed] == [254, 255, 255]          # 255 was not taken by the radio: used again
    assert [v5.decode(m)["etn"] for m in handed] == [1, 2, 3]
    assert s.next_seq == 0                                     # wraps


@pytest.mark.asyncio
async def test_text_group_follows_the_seq_of_its_first_chunk(monkeypatch):
    from meshcore_weather.protocol import v5
    from meshcore_weather.protocol import v5_builders as b
    s, handed = _sched(monkeypatch)
    s._next_seq = 40
    await s.transmit(b.text_messages(b.SeqCounter(3), 1, v5.SUBJECT_AFD, "word " * 80), "t")
    ds = [v5.decode(m) for m in handed]
    assert [d["seq"] for d in ds] == [40, 41, 42] and {d["group"] for d in ds} == {40}


@pytest.mark.asyncio
async def test_concurrent_transmits_leave_in_seq_order_without_interleaving(monkeypatch):
    from meshcore_weather.protocol import v5
    s, handed = _sched(monkeypatch)
    s._next_seq = 10
    await asyncio.gather(s.transmit(_cancels(1, 2, 3), "tick"), s.transmit(_cancels(101, 102), "request"))
    ds = [v5.decode(m) for m in handed]
    assert [d["etn"] for d in ds] == [1, 2, 3, 101, 102]
    assert [d["seq"] for d in ds] == [10, 11, 12, 13, 14]


@pytest.mark.asyncio
async def test_next_seq_is_persisted_after_a_send_and_restored(monkeypatch):
    import meshcore_weather.schedule.scheduler as sched_mod
    s, _ = _sched(monkeypatch)
    s._next_seq = 200
    await s.transmit(_cancels(9), "t")
    saved = json.loads(sched_mod._STATE_PATH.read_text())
    assert saved["next_seq"] == 201 and saved["warnings"] == {}
    again, _ = _sched(monkeypatch)
    again._load_state()
    assert again.next_seq == 201


@pytest.mark.asyncio
async def test_seq_is_saved_past_the_batch_before_it_goes_out(monkeypatch):
    import meshcore_weather.schedule.scheduler as sched_mod
    s, _ = _sched(monkeypatch, results=[True, True, False])
    s._next_seq = 253
    saved_during = []
    send = s.radio.send_channel_data

    async def spy(data, data_type=0xFF10, ev=None):
        saved_during.append(json.loads(sched_mod._STATE_PATH.read_text())["next_seq"])
        return await send(data, data_type, ev)
    s.radio.send_channel_data = spy
    await s.transmit(_cancels(1, 2, 3, 4), "t")
    assert saved_during == [1, 1, 1, 1]        # 253 + 4 wraps: a restart mid-batch lands past it
    assert s.next_seq == 0                     # 253, 254 and 255 went out; the failed one's number is reused
    assert json.loads(sched_mod._STATE_PATH.read_text())["next_seq"] == 0


def test_state_file_without_a_seq_keeps_the_clock_start(monkeypatch):
    import meshcore_weather.schedule.scheduler as sched_mod
    sched_mod._STATE_PATH.write_text(json.dumps({"warnings": {"SV.W.EWX.1": {"expires": int(time.time() // 60) + 30}}}))
    s, _ = _sched(monkeypatch)
    start = s.next_seq
    s._load_state()
    assert s.next_seq == start and "SV.W.EWX.1" in s._warning_state


@pytest.mark.asyncio
async def test_spent_hourly_budget_builds_nothing_and_says_busy_once(monkeypatch):
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.broadcaster import PER_HOUR, AppResponder
    from meshcore_weather.protocol import v5
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    radio = MagicMock()
    radio.send_channel_data = AsyncMock(return_value=True)
    r = AppResponder(WeatherStore(), radio)
    built = []
    monkeypatch.setattr(r, "_answer", lambda *a: built.append(a) or [])
    r._sent.extend([time.time()] * PER_HOUR)
    start = r.scheduler.next_seq
    # Nothing is built; the one packet is the 6-byte "busy", off the budget.
    assert await r.handle_request(">d", "a") == "hourly budget spent, told busy"
    assert built == [] and r.scheduler.next_seq == start + 1 and len(r._sent) == PER_HOUR
    sent = radio.send_channel_data.await_args.args[-1]
    busy = v5.decode(bytes(sent))
    assert busy["name"] == "not_available" and busy["reason"] == v5.REASON_RATE_LIMITED
    # Told once a minute per radio: the next refusal is silent.
    r._last_by_sender.clear()
    assert await r.handle_request(">d", "a") == "hourly budget spent"
    assert r.scheduler.next_seq == start + 1
    # A radar refusal is never "busy": reason 4 there means "sent minutes ago".
    assert await r.handle_request(">radar 30.27,-97.74", "b") == "hourly budget spent"
    assert r.scheduler.next_seq == start + 1


def _product(awips: str, text: str, age_min: int = 10, seq: int = 1) -> dict:
    from datetime import datetime, timedelta, timezone
    ts = datetime.now(timezone.utc) - timedelta(minutes=age_min)
    return {"filename": f"A_XXUS70KWBC{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_{seq:06d}-2-{awips}.TXT", "raw_text": text}


@pytest.mark.asyncio
async def test_named_station_metar_and_taf_never_answer_with_a_neighbour():
    from meshcore_weather.core import services
    from meshcore_weather.protocol import v5
    r, sent = TestAppResponder()._responder()
    r.store.ingest([_product("SAHOURLY", "SAUS70 KWBC 151200\nMETAR\nKGTU 151155Z 18005KT 10SM CLR 30/20 A3001", seq=1)])
    await r.handle_request(">metar KAUS", "a")
    d = v5.decode(sent[-1])
    assert (d["name"], d["request"], d["reason"]) == ("not_available", "m", v5.REASON_NO_DATA)

    r.store.ingest([_product("SAHOURLY", "SAUS70 KWBC 151205\nMETAR\nKAUS 151153Z 17006KT 10SM FEW250 31/19 A3000", seq=2)])
    await r.handle_request(">metar KAUS", "b")
    assert v5.decode(sent[-1])["text"].startswith("METAR KAUS 151153Z")

    r.store.ingest([_product("TAFGTUTX", "FTUS44 KEWX 151120\nTAFGTU\nTAF\nKGTU 151120Z 1512/1612 18008KT P6SM SKC",
                             age_min=12, seq=3)])
    await r.handle_request(">taf KAUS", "c")
    d = v5.decode(sent[-1])
    assert (d["name"], d["request"], d["reason"]) == ("not_available", "t", v5.REASON_NO_DATA)

    r.store.ingest([_product("TAFAUSTX", "FTUS44 KEWX 151121\nTAFAUS\nTAF AMD\nKAUS 151120Z 1512/1612 19010KT P6SM SCT040\n"
                             "     FM151800 19012G20KT P6SM BKN040", seq=4)])
    await r.handle_request(">taf KAUS", "d")
    d = v5.decode(sent[-1])
    assert d["name"] == "text" and d["text"].startswith("TAF KAUS 151120Z 1512/1612") and "FM151800" in d["text"]

    r.store.ingest([_product("TAFAUSTX", "FTUS44 KEWX 151140 AAA\nTAFAUS\nTAF AMD KAUS 151140Z 1512/1612 20012KT P6SM",
                             age_min=5, seq=5)])
    assert services.station_taf(r.store, "KAUS") == "TAF KAUS AMD 151140Z 1512/1612 20012KT P6SM"
