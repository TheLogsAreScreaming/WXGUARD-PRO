"""Coverage (type 8): the bot states its own area instead of letting an app
guess it (docs/MeshWX_v5_Spec.md §10).

The guess this replaces put a false line on a real phone: "WX-AUS may not
carry alerts for Travis County (NWS Austin/San Antonio)" — the bot's own home
county — because the one warning active at that moment came from a
neighbouring office.
"""

import asyncio
import time
from unittest.mock import MagicMock

import pytest

from meshcore_weather.core import render_text
from meshcore_weather.core.pages import split_pages
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol.coverage import Coverage

BOT = 0x4C7A
AUSTIN = (30.2672, -97.7431)

_BUILT: dict = {}


def _coverage(**sources) -> Coverage:
    """Coverage sets are shared between tests: building one walks the zone
    polygons, and the suite should not pay for that repeatedly."""
    key = repr(sorted(sources.items()))
    if key not in _BUILT:
        _BUILT[key] = Coverage.from_sources(**sources)
    return _BUILT[key]


def _wx_aus() -> Coverage:
    """The live WX-AUS coverage: 120 km around Austin."""
    return _coverage(cities=["Austin TX"], radius_km=120)


def _tx() -> int:
    b.tables.load()
    return b.tables.states.index("TX")


# -- The wire (spec 10) ------------------------------------------------------


def test_coverage_round_trips_centre_radius_offices_and_runs():
    data = v5.encode_coverage(17, BOT, lat=30.2672, lon=-97.7431, radius_km=120,
                              stations=14, offices=[35, 40, 51, 113],
                              areas=[(42, False, 155, 6), (42, True, 453, 1)])
    d = v5.decode(data)
    assert d["name"] == "coverage" and d["seq"] == 17 and d["bot"] == BOT
    assert (d["lat"], d["lon"]) == (30.2672, -97.7431)
    assert d["radius_km"] == 120 and d["stations"] == 14
    assert d["offices"] == [35, 40, 51, 113]
    assert d["areas"] == [
        {"state": 42, "county": False, "start": 155, "run": 6},
        {"state": 42, "county": True, "start": 453, "run": 1},
    ]
    assert d["zones_cut"] is False and d["offices_cut"] is False
    assert len(data) == 14 + 4 + 1 + 8 <= v5.MAX_SEND


def test_a_bare_coverage_is_fifteen_bytes_and_the_cut_flags_ride_in_the_nibble():
    bare = v5.encode_coverage(1, BOT, lat=0, lon=0)
    assert len(bare) == 15                       # 14 fixed plus an empty run count
    d = v5.decode(bare)
    assert d["offices"] == [] and d["areas"] == [] and d["radius_km"] == 0
    cut = v5.decode(v5.encode_coverage(1, BOT, lat=0, lon=0,
                                       zones_cut=True, offices_cut=True))
    assert cut["flags"] == v5.FLAG_COVERAGE_ZONES_CUT | v5.FLAG_COVERAGE_OFFICES_CUT
    assert cut["zones_cut"] is True and cut["offices_cut"] is True


def test_southern_and_eastern_coordinates_and_a_truncated_packet():
    d = v5.decode(v5.encode_coverage(1, BOT, lat=-41.2865, lon=174.7762, radius_km=65535))
    assert (d["lat"], d["lon"], d["radius_km"]) == (-41.2865, 174.7762, 65535)
    with pytest.raises(ValueError):              # the run count byte is missing
        v5.decode(v5.encode_coverage(1, BOT, lat=0, lon=0, offices=[1, 2])[:-1])


def test_both_lists_full_still_fit_one_packet():
    """The caps are chosen so a full office list never costs a zone run."""
    data = v5.encode_coverage(
        1, BOT, lat=30.0, lon=-97.0, radius_km=400, stations=12,
        offices=list(range(v5.MAX_COVERAGE_OFFICES)),
        areas=[(42, False, 100 + i, 1) for i in range(v5.MAX_COVERAGE_RUNS)],
    )
    assert len(data) == 14 + 22 + 1 + 4 * 30 == 157 == v5.MAX_SEND
    d = v5.decode(data)
    assert len(d["offices"]) == 22 and len(d["areas"]) == 30


def test_encode_rejects_more_than_the_caps():
    with pytest.raises(ValueError, match="at most 22 offices"):
        v5.encode_coverage(1, BOT, lat=0, lon=0, offices=list(range(23)))
    with pytest.raises(ValueError, match=r"0\.\.30 runs"):
        v5.encode_coverage(1, BOT, lat=0, lon=0,
                           areas=[(42, False, 100 + i, 1) for i in range(31)])


def test_an_older_client_that_does_not_know_type_8_is_unaffected():
    """Receivers ignore unknown types (spec 2.2), and nothing about the header
    changed, so a revision 3 decoder reads type 8 and drops the message."""
    data = b.coverage_message(5, BOT, _wx_aus(), None, 120)
    assert data[0] == 5 and int.from_bytes(data[1:3], "little") == BOT
    assert data[3] >> 4 == v5.TYPE_COVERAGE == 8
    assert v5.TYPE_COVERAGE not in {v5.TYPE_WARNING, v5.TYPE_CANCEL, v5.TYPE_DIGEST,
                                    v5.TYPE_OBS, v5.TYPE_FORECAST, v5.TYPE_TEXT,
                                    v5.TYPE_NOT_AVAILABLE}


# -- WX-AUS's real coverage --------------------------------------------------


def test_wx_aus_real_coverage_is_five_runs_in_one_thirty_nine_byte_packet():
    f = b.coverage_facts(_wx_aus(), None, 120)
    tx = _tx()
    assert len(f["zones"]) == 36
    assert f["offices"] == ["EWX", "FWD", "HGX", "SJT"]
    assert f["office_idx"] == [35, 40, 51, 113]
    assert f["areas"] == [(tx, False, 155, 6), (tx, False, 170, 6), (tx, False, 186, 12),
                          (tx, False, 205, 7), (tx, False, 221, 5)]
    assert f["radius_km"] == 120 and f["stations"] == 12
    assert not f["zones_cut"] and not f["offices_cut"]

    msg = b.coverage_message(17, BOT, _wx_aus(), None, 120)
    assert len(msg) == 39                        # 14 fixed + 4 offices + 1 + 5 x 4
    d = v5.decode(msg)
    assert (d["lat"], d["lon"]) == AUSTIN and d["radius_km"] == 120
    assert d["offices"] == [35, 40, 51, 113] and b.tables.office_code(35) == "EWX"


def test_the_runs_decode_back_to_the_zones_including_travis_county():
    d = v5.decode(b.coverage_message(1, BOT, _wx_aus(), None, 120))
    numbers = {n for a in d["areas"] for n in range(a["start"], a["start"] + a["run"])}
    # TXZ192 is Travis, the zone a phone was wrongly told might be uncovered.
    assert 192 in numbers
    states = b.tables.states
    decoded = {f"{states[a['state']]}Z{n:03d}" for a in d["areas"]
               for n in range(a["start"], a["start"] + a["run"])}
    assert decoded == set(b.coverage_facts(_wx_aus(), None, 120)["zones"])


def test_every_run_is_a_forecast_zone_not_a_county():
    d = v5.decode(b.coverage_message(1, BOT, _wx_aus(), None, 120))
    assert all(a["county"] is False for a in d["areas"])


# -- Truncation --------------------------------------------------------------


def test_a_zone_list_too_big_keeps_the_runs_that_cover_the_most_zones():
    tx = _tx()
    zones = {f"TXZ{n:03d}" for n in range(1, 61, 2)}     # 30 runs of one
    zones |= {f"TXZ{n:03d}" for n in range(100, 140)}    # one run of forty
    f = b.coverage_facts(Coverage(zones=zones), AUSTIN, 120)
    assert f["zones_cut"] is True and len(f["areas"]) == v5.MAX_COVERAGE_RUNS
    assert (tx, False, 100, 40) in f["areas"]           # the big run survives
    assert (tx, False, 59, 1) not in f["areas"]         # the last singleton is dropped
    assert f["areas"] == sorted(f["areas"])             # put back in wire order

    d = v5.decode(b.coverage_message(1, BOT, Coverage(zones=zones), AUSTIN, 120))
    assert d["zones_cut"] is True
    listed = sum(a["run"] for a in d["areas"])
    assert listed < len(f["zones"])                     # understates, and says so


def test_an_office_list_too_big_is_cut_to_the_lowest_indices_and_flagged():
    b.tables.load()
    many = b.tables.offices[:v5.MAX_COVERAGE_OFFICES + 1]
    cov = Coverage(zones=set(), sources={"cities": [], "states": [], "wfos": many})
    f = b.coverage_facts(cov, AUSTIN, 120)
    assert f["offices_cut"] is True
    assert f["office_idx"] == list(range(v5.MAX_COVERAGE_OFFICES))
    assert len(f["offices"]) == 23                      # the text reply keeps them all
    d = v5.decode(b.coverage_message(1, BOT, cov, AUSTIN, 120))
    assert d["offices_cut"] is True and len(d["offices"]) == 22
    # No zone fell inside a circle, so no circle is claimed and no observations.
    assert d["radius_km"] == 0 and d["stations"] == 0


def test_a_big_real_coverage_still_fits_one_packet():
    cov = _coverage(states=["TX", "OK", "NM"])
    msg = b.coverage_message(1, BOT, cov, AUSTIN, 120)
    assert len(msg) <= v5.MAX_SEND
    d = v5.decode(msg)
    assert len(d["offices"]) <= v5.MAX_COVERAGE_OFFICES
    assert len(d["areas"]) <= v5.MAX_COVERAGE_RUNS


# -- Nothing to state --------------------------------------------------------


def test_a_bot_with_no_centre_and_no_zones_sends_nothing():
    assert b.coverage_message(1, BOT, Coverage.empty(), None, 120) is None


def test_no_area_filter_is_an_answer_not_an_empty_message():
    """Zero offices and zero runs mean the bot filters nothing (spec 10)."""
    d = v5.decode(b.coverage_message(1, BOT, Coverage.empty(), AUSTIN, 120))
    assert d["offices"] == [] and d["areas"] == []
    assert d["radius_km"] == 0 and not d["zones_cut"] and not d["offices_cut"]
    assert (d["lat"], d["lon"]) == AUSTIN


# -- `>cov` through the app responder ---------------------------------------


def _responder():
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.broadcaster import AppResponder
    import meshcore_weather.schedule.scheduler as sched_mod
    sched_mod.TX_SPACING = 0
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "7a4c" + "00" * 30}
    sent: list[bytes] = []

    async def cap(data, data_type=0xFF10, ev=None):
        sent.append(bytes(data))
        return True
    radio.send_channel_data = cap
    return AppResponder(WeatherStore(), radio), sent


@pytest.mark.asyncio
async def test_cov_request_answers_one_packet_that_states_the_area(monkeypatch):
    r, sent = _responder()
    monkeypatch.setattr(r.scheduler, "_coverage", _wx_aus())
    assert await r.handle_request(">cov", "a") == "1 packet(s), 39 B"
    assert len(sent) == 1
    d = v5.decode(sent[-1])
    assert d["name"] == "coverage" and d["bot"] == BOT
    assert d["offices"] == [35, 40, 51, 113] and len(d["areas"]) == 5


@pytest.mark.asyncio
async def test_cov_meets_the_per_sender_spacing_and_the_hourly_budget(monkeypatch):
    from meshcore_weather.protocol.broadcaster import PER_HOUR
    r, sent = _responder()
    monkeypatch.setattr(r.scheduler, "_coverage", _wx_aus())
    await r.handle_request(">cov", "a")
    n = len(sent)
    assert await r.handle_request(">cov", "a") == "rate limited" and len(sent) == n
    r._sent.extend([time.time()] * PER_HOUR)
    assert await r.handle_request(">cov", "b") == "hourly budget spent, told busy"
    assert len(sent) == n + 1                     # the "busy", and nothing built


@pytest.mark.asyncio
async def test_cov_without_an_area_is_not_available_under_the_letter_c(monkeypatch):
    from meshcore_weather.geodata import resolver
    r, sent = _responder()
    monkeypatch.setattr(r.scheduler, "_coverage", Coverage.empty())
    monkeypatch.setattr(resolver, "home", lambda: None)
    await r.handle_request(">cov", "a")
    d = v5.decode(sent[-1])
    assert (d["name"], d["request"], d["reason"]) == ("not_available", "c", v5.REASON_NO_DATA)


# -- The scheduled broadcast -------------------------------------------------


@pytest.mark.asyncio
async def test_the_scheduled_job_sends_one_packet_stamped_at_transmit(monkeypatch):
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.schedule import executor as ex
    from meshcore_weather.schedule.models import BroadcastJob
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "7a4c" + "00" * 30}
    handed: list[bytes] = []

    async def send(data, data_type=0xFF10, ev=None):
        handed.append(bytes(data))
        return True
    radio.send_channel_data = send

    s = sched_mod.Scheduler(WeatherStore(), radio)
    s._coverage = _wx_aus()
    s._next_seq = 77
    job = BroadcastJob(id="coverage", name="c", product="coverage",
                       location_type="coverage", interval_minutes=180)
    msgs = ex.PRODUCT_BUILDERS["coverage"](job, s.context())
    assert len(msgs) == 1
    assert await s.transmit(msgs, "job coverage") == (1, 39)
    d = v5.decode(handed[-1])
    assert d["name"] == "coverage"
    assert d["seq"] == 77 and s.next_seq == 78      # stamped on air, not by the builder


def test_the_default_schedule_broadcasts_coverage_every_three_hours(monkeypatch, tmp_path):
    from meshcore_weather.schedule import store as store_module
    monkeypatch.setattr(store_module, "CONFIG_PATH", tmp_path / "broadcast_config.json")
    job = store_module.default_config_for_bootstrap().get_job("coverage")
    assert job is not None and job.product == "coverage"
    assert job.interval_minutes == 180 and job.enabled


# -- The `cov` text command --------------------------------------------------


@pytest.mark.asyncio
async def test_cov_words_and_the_places_that_start_with_them():
    from meshcore_weather.nlp import parse_intent
    for text in ("cov", "Coverage", "covers?"):
        assert await parse_intent(text) == {"command": "cov", "location": ""}
    assert await parse_intent("cove tx") == {"command": "wx", "location": "cove tx"}
    assert await parse_intent("coverage of round rock") == \
        {"command": "wx", "location": "coverage of round rock"}


def test_cov_says_the_area_the_offices_the_stations_and_the_alert_list():
    from meshcore_weather.main import HELP_TEXT, WeatherBot
    bot = WeatherBot()
    bot._coverage_cache = _wx_aus()
    reply = bot._process_command("cov", "")
    assert reply == (
        "Coverage: 36 NWS zones within 120 km of Austin, TX; "
        "offices EWX, FWD, HGX, SJT; up to 12 stations hourly; alert list every 3 h"
    )
    assert len(reply) <= render_text.MAX_DM               # one message, no paging needed
    assert ", cov," in HELP_TEXT and len(HELP_TEXT) <= render_text.MAX_DM


def test_a_bot_with_no_area_filter_says_so_in_words(monkeypatch):
    from meshcore_weather.geodata import resolver
    from meshcore_weather.main import WeatherBot
    monkeypatch.setattr(resolver, "home", lambda: None)
    bot = WeatherBot()
    bot._coverage_cache = Coverage.empty()
    assert bot._process_command("cov", "") == (
        "Coverage: no area filter, so this bot carries everything its feed brings; "
        "no station observations; alert list every 3 h"
    )


def test_the_alert_list_interval_is_worded_from_the_live_schedule():
    f = b.coverage_facts(_wx_aus(), None, 120)
    assert render_text.coverage(f, 180).endswith("alert list every 3 h")
    assert render_text.coverage(f, 90).endswith("alert list every 90 min")
    assert render_text.coverage(f, 0).endswith("alert list off")


def test_a_long_coverage_reply_pages_and_more_walks_it(monkeypatch, tmp_path):
    """A bot covering three states names too many offices for one message, so
    the reply pages like every other long one and `more` fetches the rest."""
    from meshcore_weather.config import settings
    from meshcore_weather.main import WeatherBot
    from meshcore_weather.parser.weather import WeatherStore
    from tests.test_console import ChannelFakeRadio
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "tx_enabled", True)
    monkeypatch.setattr(settings, "reply_mode", "channel")
    monkeypatch.setattr(settings, "admin_key", "")

    bot = WeatherBot()
    bot.store = WeatherStore()
    bot.radio = ChannelFakeRadio()
    bot._coverage_cache = _coverage(states=["TX", "OK", "NM"])

    reply = bot._process_command("cov", "")
    pages = split_pages(reply, bot.page_budget())
    assert reply.startswith("Coverage: ") and len(pages) > 1
    assert all(len(p) <= bot.page_budget() for p in pages)

    bot._rate_limit["D"] = time.time() - 10
    asyncio.run(bot._handle_channel_message("1", "D", "cov", 0))
    assert bot.radio.channel_sent[-1][1].endswith(f"(1/{len(pages)}) more")
    bot._rate_limit["D"] = time.time() - 10
    asyncio.run(bot._handle_channel_message("1", "D", "more", 0))
    assert f"(2/{len(pages)})" in bot.radio.channel_sent[-1][1]
