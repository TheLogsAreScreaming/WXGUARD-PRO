"""Coverage fails closed (phase 1, item 1) and the home is a reference, not
Austin (item 4).

A volunteer's typo in MCW_HOME_CITIES used to be skipped in silence, and an
empty coverage meant "accept everything": the national warning feed on a
city mesh. Now a home city that does not resolve, or a bare name that is a
place in several states, is an error; with no coverage at all the scheduled
warnings, digest, observations and coverage statement send nothing unless
the operator asks for MCW_COVERAGE=national; and a build that raises keeps
the last good coverage.
"""

import json
import logging
import time
from datetime import UTC, datetime, timedelta

import pytest

from meshcore_weather import config
from meshcore_weather.config import settings
from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import coverage as cov_mod
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol.coverage import Coverage, check_place, refresh_home
from meshcore_weather.schedule import executor as ex
from meshcore_weather.schedule import store as store_module
from meshcore_weather.schedule.models import BroadcastConfig, BroadcastJob


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    """Each test builds its own coverage, and leaves the resolver's home and
    the time zone as it found them."""
    cov_mod.forget_config_build()
    for key in ("home_cities", "home_states", "home_wfos", "home_radius_km", "coverage", "timezone"):
        monkeypatch.setattr(settings, key, getattr(settings, key))
    monkeypatch.setattr(config, "_tz_from_home", config._tz_from_home)
    resolver.load()
    monkeypatch.setattr(resolver, "_home", resolver._home)
    yield
    cov_mod.forget_config_build()


def _configure(monkeypatch, cities="", states="", wfos="", radius=120, mode=""):
    monkeypatch.setattr(settings, "home_cities", cities)
    monkeypatch.setattr(settings, "home_states", states)
    monkeypatch.setattr(settings, "home_wfos", wfos)
    monkeypatch.setattr(settings, "home_radius_km", radius)
    monkeypatch.setattr(settings, "coverage", mode)
    return Coverage.from_config()


# -- Resolution of the home city -------------------------------------------------------


def test_austin_tx_builds_exactly_the_coverage_it_always_had(monkeypatch):
    """WX-AUS's setting: the same zones, counties and centre as before."""
    cov = _configure(monkeypatch, "Austin TX")
    old = Coverage.from_sources(cities=["Austin TX"], radius_km=120)
    assert not cov.blocked and not cov.errors and not cov.national
    assert cov.zones == old.zones and cov.counties == old.counties and cov.center == old.center
    assert cov.home_name == "Austin, TX" and "36 zones" in cov.summary()


def test_a_home_city_that_does_not_resolve_is_an_error_and_blocks(monkeypatch, caplog):
    with caplog.at_level(logging.INFO, logger="meshcore_weather.protocol.coverage"):
        cov = _configure(monkeypatch, "Austn TX")
    assert cov.errors and "Austn TX" in cov.errors[0] and cov.blocked
    assert cov.summary().startswith("BLOCKED")
    errors = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert errors and "Austn TX" in errors[0].getMessage()


def test_a_bare_name_in_several_states_is_ambiguous(monkeypatch):
    cov = _configure(monkeypatch, "Austin")
    assert cov.blocked and "ambiguous" in cov.errors[0] and "'Austin TX'" in cov.errors[0]
    loc, err, _warn = check_place("Springfield")
    assert loc is None and "ambiguous" in err


def test_one_bad_city_among_good_ones_still_blocks(monkeypatch):
    """Fail closed: a typo in the second city is not quietly dropped."""
    cov = _configure(monkeypatch, "Austin TX,Dallas")
    assert cov.blocked and len(cov.errors) == 1 and "Dallas" in cov.errors[0]
    assert cov.center is not None and abs(cov.center[0] - 30.27) < 0.01      # centred on the first city only


def test_a_failed_first_city_never_centres_the_radius_on_the_next(monkeypatch):
    cov = _configure(monkeypatch, "Nowhereville TX,Dallas TX")
    assert cov.blocked and cov.center is None and cov.radius_km == 0


def test_codes_and_close_names(monkeypatch):
    assert check_place("78701")[1] is None and check_place("KAUS")[1] is None and check_place("AUS")[1] is None
    loc, err, warn = check_place("Pfluger TX")                    # resolved, but not that name
    assert loc and err is None and "Pflugerville" in warn
    loc, err, warn = check_place("Austin, TX")
    assert loc and err is None and warn is None


def test_unknown_states_and_offices_are_errors(monkeypatch):
    cov = _configure(monkeypatch, "", states="TXX", wfos="ZZZ")
    assert cov.blocked and any("TXX" in e for e in cov.errors) and any("ZZZ" in e for e in cov.errors)


# -- Empty coverage: nothing, unless national ------------------------------------------


def test_nothing_configured_is_blocked_not_everything(monkeypatch, caplog):
    with caplog.at_level(logging.INFO, logger="meshcore_weather.protocol.coverage"):
        cov = _configure(monkeypatch, "")
    assert cov.unconfigured and cov.blocked and "MCW_COVERAGE=national" in cov.blocked
    assert any(r.levelno == logging.ERROR for r in caplog.records)


def test_national_is_the_explicit_way_to_everything(monkeypatch):
    cov = _configure(monkeypatch, "", mode="national")
    assert cov.national and not cov.blocked and cov.is_empty()
    assert cov.covers_any(["CAZ041"]) and "national" in cov.summary()
    cov = _configure(monkeypatch, "Austin TX", mode="national")   # national, with a home point
    assert cov.national and not cov.zones and cov.center and cov.home_name == "Austin, TX"


def test_an_unknown_coverage_mode_is_an_error(monkeypatch):
    assert _configure(monkeypatch, "Austin TX", mode="nationwide").blocked


def test_startup_logs_the_summary_and_the_home_point(monkeypatch, caplog):
    with caplog.at_level(logging.INFO, logger="meshcore_weather.protocol.coverage"):
        _configure(monkeypatch, "Austin TX")
    text = [r.getMessage() for r in caplog.records]
    assert any(t.startswith("Coverage: 36 zones") for t in text)
    assert any(t.startswith("Home point: Austin, TX (30.2672, -97.7431)") for t in text)


def test_the_build_is_shared_and_logged_once_per_setting(monkeypatch, caplog):
    first = _configure(monkeypatch, "Austin TX")
    with caplog.at_level(logging.INFO, logger="meshcore_weather.protocol.coverage"):
        assert Coverage.from_config() is first
    assert not caplog.records
    assert _configure(monkeypatch, "Austin TX", radius=60) is not first


# -- The scheduled jobs on a blocked coverage ------------------------------------------


def _warning(etn=42, phen="SV", sig="W"):
    now = datetime.now(UTC)
    return {
        "event_code": b.tables.event_code(f"{phen}.{sig}"), "vtec_office": "EWX", "vtec_etn": etn,
        "vtec_phenomenon": phen, "vtec_significance": sig, "expires_at": now + timedelta(hours=2),
        "onset_unix_min": int(now.timestamp() // 60), "ugcs": ["TXC453"], "zones": [],
        "vertices": [(30.30, -97.90), (30.45, -97.85), (30.40, -97.60), (30.25, -97.65)],
        "hail_qin": 4, "wind_mph": 60, "tornado_tag": 0, "flood_source": 0, "flood_damage": 0,
        "headline": "Severe Thunderstorm Warning", "description": "",
    }


@pytest.mark.parametrize("product", ["warnings", "digest", "observations", "coverage"])
def test_area_jobs_send_nothing_on_a_blocked_coverage(monkeypatch, product):
    called = []
    monkeypatch.setattr(ex, "extract_active_warnings", lambda store, coverage=None: called.append(1) or [_warning()])
    monkeypatch.setattr(b, "coverage_stations", lambda *a, **k: called.append(1) or ["KAUS"])
    ctx = ex.ExecutorContext(store=WeatherStore(), coverage=Coverage.unavailable("not built"), seq=b.SeqCounter(),
                             bot=1, home=(30.27, -97.74), radius_km=120)
    job = BroadcastJob(id=product, name=product, product=product, location_type="coverage", interval_minutes=2)
    assert ex.BroadcastExecutor().run_job(job, ctx) == [] and not called and not ctx.warning_state


def test_warnings_go_out_on_a_national_coverage(monkeypatch):
    monkeypatch.setattr(ex, "extract_active_warnings", lambda store, coverage=None: [_warning()])
    cov = _configure(monkeypatch, "", mode="national")
    ctx = ex.ExecutorContext(store=WeatherStore(), coverage=cov, seq=b.SeqCounter(), bot=1)
    job = BroadcastJob(id="warnings", name="w", product="warnings", location_type="coverage", interval_minutes=2)
    assert len(ex._build_warnings(job, ctx)) == 1


def _scheduler():
    from unittest.mock import AsyncMock, MagicMock

    from meshcore_weather.schedule.scheduler import Scheduler
    radio = MagicMock()
    radio.send_channel_data = AsyncMock(return_value=True)
    return Scheduler(WeatherStore(), radio)


def test_the_scheduler_starts_with_no_coverage_rather_than_everything():
    assert _scheduler().coverage.blocked


def test_a_rebuild_that_raises_keeps_the_last_good_coverage(monkeypatch):
    s = _scheduler()
    _configure(monkeypatch, "Austin TX")
    s.reload_coverage()
    good = s.coverage
    assert not good.blocked

    def boom():
        raise RuntimeError("shapely fell over")
    monkeypatch.setattr(Coverage, "from_config", staticmethod(boom))
    s.reload_coverage()
    assert s.coverage is good


def test_a_first_build_that_raises_sends_nothing(monkeypatch):
    s = _scheduler()

    def boom():
        raise RuntimeError("geodata missing")
    monkeypatch.setattr(Coverage, "from_config", staticmethod(boom))
    s.reload_coverage()
    assert s.coverage.blocked and s.coverage.is_empty()


@pytest.mark.asyncio
async def test_a_blocked_tick_says_why_once_an_hour(monkeypatch, tmp_path, caplog):
    monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_path / "broadcast_config.json")
    s = _scheduler()
    _configure(monkeypatch, "")
    s.reload_coverage()
    await s._reload_config()
    with caplog.at_level(logging.ERROR, logger="meshcore_weather.schedule.scheduler"):
        assert await s.tick() == 0
        assert await s.tick() == 0
    lines = [r for r in caplog.records if "are off" in r.getMessage()]
    assert len(lines) == 1 and "MCW_HOME_CITIES" in lines[0].getMessage()
    s.radio.send_channel_data.assert_not_awaited()


# -- The home: a reference, resolved at run time (item 4) -------------------------------


def test_bootstrap_forecast_is_home_whatever_the_city(monkeypatch):
    monkeypatch.setattr(settings, "home_cities", "Denver CO")
    job = store_module.default_config_for_bootstrap().get_job("forecast")
    assert (job.location_type, job.location_id, job.name) == ("coverage", "home", "Forecast: home")


def test_an_austin_forecast_job_becomes_home_on_load(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "home_cities", "Austin TX")
    path = tmp_path / "broadcast_config.json"
    path.write_text(json.dumps({"version": 2, "jobs": [
        {"id": "forecast", "name": "Forecast: Austin TX", "product": "forecast", "location_type": "city",
         "location_id": "Austin TX", "interval_minutes": 360, "enabled": True},
        {"id": "forecast-dallas", "name": "Dallas", "product": "forecast", "location_type": "city",
         "location_id": "Dallas TX", "interval_minutes": 360, "enabled": True},
    ]}))
    monkeypatch.setattr(store_module, "CONFIG_PATH", path)
    cfg = store_module.load_config()
    home, dallas = cfg.get_job("forecast"), cfg.get_job("forecast-dallas")
    assert (home.location_type, home.location_id, home.name) == ("coverage", "home", "Forecast: home")
    assert home.interval_minutes == 360 and home.enabled
    assert (dallas.location_type, dallas.location_id) == ("city", "Dallas TX")     # the operator's own
    saved = json.loads(path.read_text())                                            # and it is written back
    assert any(j["id"] == "forecast" and j["location_id"] == "home" for j in saved["jobs"])


def test_a_forecast_for_another_home_is_left_alone(monkeypatch, tmp_path):
    """A bot whose home is Denver keeps an explicit Austin job as it is."""
    monkeypatch.setattr(settings, "home_cities", "Denver CO")
    cfg = BroadcastConfig(version=2, jobs=[BroadcastJob(id="forecast", name="x", product="forecast",
                                                        location_type="city", location_id="austin,  tx",
                                                        interval_minutes=360)])
    assert not store_module._home_forecast_to_home(cfg)
    monkeypatch.setattr(settings, "home_cities", "Austin TX")
    assert store_module._home_forecast_to_home(cfg) and cfg.jobs[0].location_id == "home"


@pytest.mark.parametrize("location_type", ["coverage", "city"])
def test_the_home_forecast_uses_the_home_point_at_run_time(monkeypatch, location_type):
    seen = []
    monkeypatch.setattr(b, "forecast_message", lambda seq, bot, store, lat, lon, point=None: seen.append((lat, lon)) or b"x")
    monkeypatch.setattr(ex.resolver, "resolve", lambda q: pytest.fail(f"'home' must not be looked up as a place: {q}"))
    ctx = ex.ExecutorContext(store=WeatherStore(), coverage=Coverage.empty(), seq=b.SeqCounter(), bot=1,
                             home=(39.74, -104.99))
    job = BroadcastJob(id="forecast", name="f", product="forecast", location_type=location_type,
                       location_id="home", interval_minutes=360)
    assert ex._build_forecast(job, ctx) == [b"x"] and seen == [(39.74, -104.99)]


def test_refresh_home_moves_the_resolver_home(monkeypatch):
    monkeypatch.setattr(settings, "home_cities", "Austin TX")
    assert abs(refresh_home()[0] - 30.27) < 0.01
    monkeypatch.setattr(settings, "home_cities", "Denver CO")
    assert abs(refresh_home()[0] - 39.74) < 0.05
    monkeypatch.setattr(settings, "home_cities", "Nowhereville ZZ")
    assert refresh_home() is None                                  # fails closed: no stale home


# -- Time zone from the home city (item 4) ------------------------------------------------


def test_timezone_default_is_not_austins():
    assert config.Settings.model_fields["timezone"].default == ""
    assert config.Settings.model_fields["mqtt_iata"].default == ""


def test_an_empty_timezone_is_taken_from_the_home_city_and_follows_it(monkeypatch):
    monkeypatch.setattr(settings, "timezone", "")
    monkeypatch.setattr(config, "_tz_from_home", False)
    monkeypatch.setattr(settings, "home_cities", "Denver CO")
    assert config.fill_timezone()[0] == "America/Denver" and settings.timezone == "America/Denver"
    monkeypatch.setattr(settings, "home_cities", "Austin TX")
    assert config.fill_timezone()[0] == "America/Chicago"          # derived, so it follows the home
    config.timezone_set_by_operator()
    monkeypatch.setattr(settings, "timezone", "America/New_York")
    monkeypatch.setattr(settings, "home_cities", "Denver CO")
    assert config.fill_timezone() == ("America/New_York", "MCW_TIMEZONE")


def test_no_home_no_timezone(monkeypatch):
    monkeypatch.setattr(settings, "timezone", "")
    monkeypatch.setattr(config, "_tz_from_home", False)
    monkeypatch.setattr(settings, "home_cities", "")
    tz, how = config.fill_timezone()
    assert tz == "" and "empty" in how


def test_the_mqtt_region_comes_from_the_node_name_never_a_default():
    assert config.iata_from_name("WX-AUS") == "AUS" and config.iata_from_name("WX-DEN1") == "DEN1"
    assert config.iata_from_name("mesh-wx") is None and config.iata_from_name(None) is None


def test_job_status_counts_down_a_restored_hold(monkeypatch, tmp_path):
    monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_path / "broadcast_config.json")
    s = _scheduler()
    s._config = store_module.default_config_for_bootstrap()
    s._hold_until["digest"] = time.time() + 120
    st = s.job_status("digest")
    assert 100 < st["next_run_in_seconds"] <= 120
