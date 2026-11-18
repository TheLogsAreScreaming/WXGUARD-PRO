"""`>o ICAO` answers with the nearest station that reports (spec 14, rev 8).

Field report 2026-09-18: Dayton's nearest station in the app's bundled list
is Wright-Patterson AFB (KFFO), which sends nothing on the feed, so every
`>o KFFO` came back Not available while Dayton International (KDAY, 16.6 km
from it) reported hourly. Chat never had the problem: it walks the stations
nearest first and skips the silent ones.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from tests.test_v5_builders import _metar_store


def _index(icao: str) -> int:
    return b.tables.station(icao)


def _app(text: str, store: WeatherStore) -> list[dict]:
    from meshcore_weather.protocol.broadcaster import AppResponder
    radio = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    radio.send_channel_data = AsyncMock(return_value=True)
    asyncio.run(AppResponder(store, radio).handle_request(text, "app"))
    return [v5.decode(c.args[0]) for c in radio.send_channel_data.await_args_list]


def test_a_station_that_reports_answers_for_itself():
    store = _metar_store("KFFO 181256Z 03009KT 7SM OVC006 22/21 A3023",
                         "KDAY 181256Z 03009KT 7SM OVC006 23/21 A3023")
    stations = v5.decode(b.station_obs_message(1, 1, store, "KFFO"))["stations"]
    assert [s["station"] for s in stations] == [_index("KFFO")]


def test_a_silent_station_is_answered_by_the_nearest_that_reports():
    # KDAY is 16.6 km from KFFO, KMGY 30.7 km: the nearer one answers, alone,
    # under its own index.
    store = _metar_store("KDAY 181256Z 03009KT 7SM OVC006 22/21 A3023",
                         "KMGY 181253Z AUTO 9SM OVC007 23/22 A3021")
    stations = v5.decode(b.station_obs_message(1, 1, store, "KFFO"))["stations"]
    assert [s["station"] for s in stations] == [_index("KDAY")]
    assert stations[0]["temp_f"] == 72


def test_nothing_within_40_km_is_nothing():
    # Columbus (KCMH) is about 100 km from Wright-Patterson: too far to stand in.
    store = _metar_store("KCMH 181251Z 03009KT 10SM OVC010 22/20 A3022")
    assert b.station_obs_message(1, 1, store, "KFFO") is None


def test_the_request_answers_with_the_stand_in_and_says_where_it_came_from():
    store = _metar_store("KDAY 181256Z 03009KT 7SM OVC006 22/21 A3023")
    msgs = _app(">o KFFO", store)
    assert [m["name"] for m in msgs] == ["observations"]
    assert [s["station"] for s in msgs[0]["stations"]] == [_index("KDAY")]


def test_a_silent_station_with_nothing_near_is_not_available():
    msgs = _app(">o KFFO", WeatherStore())
    assert [m["name"] for m in msgs] == ["not_available"]
    assert msgs[0]["reason"] == v5.REASON_NO_DATA


def test_an_unknown_station_is_still_an_unknown_location():
    msgs = _app(">o KZZZ", WeatherStore())
    assert [m["name"] for m in msgs] == ["not_available"]
    assert msgs[0]["reason"] == v5.REASON_UNKNOWN_LOCATION


# 2026-10-16: nothing near Woodcreek had reported in two hours, so the app
# showed "No current conditions". The owner's choice: the newest report up to
# twelve hours old, with its age, rather than nothing.


def _aged(pairs):
    from tests.test_v5_builders import _aged_metar_store
    return _aged_metar_store(pairs)


def _own_time(store, icao):
    return int(store._find_metar_raw(icao)[1].timestamp() // 60)


def test_a_station_with_only_a_stale_report_answers_with_it_dated_exactly():
    store = _aged([(5 * 60, "KAUS 151153Z 18005KT 10SM CLR 20/10 A3001")])
    d = v5.decode(b.station_obs_message(1, 1, store, "KAUS"))
    assert [s["station"] for s in d["stations"]] == [_index("KAUS")]
    # A batch of one: `ts` is the report's own time and its age is 0, so the
    # phone works out "as of" to the minute instead of a saturated nibble.
    assert d["ts_min"] == _own_time(store, "KAUS") and d["stations"][0]["age_min"] == 0


def test_a_fresh_neighbour_beats_the_stations_own_stale_report():
    # Camp Mabry is 12 km from Bergstrom: current there wins, as it does in chat.
    store = _aged([(5 * 60, "KAUS 151153Z 18005KT 10SM CLR 20/10 A3001"),
                   (10, "KATT 151153Z 18005KT 10SM CLR 22/10 A3001")])
    d = v5.decode(b.station_obs_message(1, 1, store, "KAUS"))
    assert [s["station"] for s in d["stations"]] == [_index("KATT")]


def test_a_stale_neighbour_stands_in_for_a_silent_station():
    store = _aged([(5 * 60, "KATT 151153Z 18005KT 10SM CLR 22/10 A3001")])
    d = v5.decode(b.station_obs_message(1, 1, store, "KAUS"))
    assert [s["station"] for s in d["stations"]] == [_index("KATT")]


def test_over_twelve_hours_is_still_nothing():
    store = _aged([(13 * 60, "KAUS 151153Z 18005KT 10SM CLR 20/10 A3001")])
    assert b.station_obs_message(1, 1, store, "KAUS") is None
    msgs = _app(">o KAUS", store)
    assert [m["name"] for m in msgs] == ["not_available"] and msgs[0]["reason"] == v5.REASON_NO_DATA


def test_the_app_request_gets_the_stale_report():
    store = _aged([(5 * 60, "KAUS 151153Z 18005KT 10SM CLR 20/10 A3001")])
    msgs = _app(">o KAUS", store)
    assert [m["name"] for m in msgs] == ["observations"]
    assert msgs[0]["stations"][0]["temp_f"] == 68


def test_the_hourly_batch_still_admits_only_current_reports():
    # A stale station cannot ride in a batch beside a fresh one: its age
    # would not fit the nibble, and the phone would date it fresher than it is.
    store = _aged([(5 * 60, "KAUS 151153Z 18005KT 10SM CLR 20/10 A3001"),
                   (10, "KATT 151153Z 18005KT 10SM CLR 22/10 A3001")])
    d = v5.decode(b.obs_message(1, 1, store, ["KATT", "KAUS"]))
    assert [s["station"] for s in d["stations"]] == [_index("KATT")]
    assert b.obs_message(1, 1, store, ["KAUS"]) is None
    # Admitting stale reports keeps only what the ages can place honestly.
    d = v5.decode(b.obs_message(1, 1, store, ["KATT", "KAUS"], max_age_min=b.OBS_STALE_MAX_AGE_MIN))
    assert [s["station"] for s in d["stations"]] == [_index("KATT")]
    both = _aged([(5 * 60, "KAUS 151153Z 18005KT 10SM CLR 20/10 A3001"),
                  (5 * 60 + 40, "KATT 151153Z 18005KT 10SM CLR 22/10 A3001")])
    d = v5.decode(b.obs_message(1, 1, both, ["KATT", "KAUS"], max_age_min=b.OBS_STALE_MAX_AGE_MIN))
    assert [(s["station"], s["age_min"]) for s in d["stations"]] == [(_index("KATT"), 40), (_index("KAUS"), 0)]
