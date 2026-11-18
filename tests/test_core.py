"""Tests for the core service layer and the resolver fixes behind it.

These pin the behaviour that the text commands, the scheduler, and the
on-demand path now share: polygon zones, home-aware disambiguation,
"nearest station that reports", "nearest forecast point by distance", and
text/binary renderings that come from the same object.
"""

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.core import render_text, services

AUSTIN = (30.27, -97.74)
FIXTURES = Path(__file__).parent / "fixtures"


def fresh(filename: str) -> str:
    """Re-stamp a fixture's KWIN receipt time to now: the store drops products
    older than 12 h, and the fixtures are real files from a fixed date."""
    import re
    return re.sub(r"_C_KWIN_\d{14}", f"_C_KWIN_{datetime.now(timezone.utc):%Y%m%d%H%M%S}", filename)


@pytest.fixture(autouse=True)
def _home():
    resolver.load()
    resolver.set_home(*AUSTIN)
    yield
    resolver._home = None


# -- Resolver -----------------------------------------------------------------


class TestResolver:
    def test_zone_by_polygon_not_centroid(self):
        # Cedar Park is in Williamson County (TXZ173); the nearest zone
        # centroid is Travis (TXZ192). Only polygon containment gets it right.
        r = resolver.resolve("Cedar Park TX")
        assert r["zones"][0] == "TXZ173"
        assert r["zone_method"] == "polygon"

    def test_bare_name_prefers_local_candidate(self):
        r = resolver.resolve("round rock")
        assert r["name"] == "Round Rock, TX"
        assert r["ambiguous"] == []

    def test_duplicate_name_in_state_prefers_local(self):
        # places.json has two "Lago Vista, TX": a colonia on the Rio Grande
        # and the Travis County city. Home is Austin, so the city wins.
        r = resolver.resolve("Lago Vista TX")
        assert abs(r["lat"] - 30.45) < 0.05

    def test_far_ambiguous_name_is_flagged(self):
        r = resolver.resolve("springfield")
        assert r["ambiguous"], "a far-away ambiguous bare name must be flagged"
        assert "add state" in render_text.place_label(r)

    def test_stations_ranked_with_distance(self):
        r = resolver.resolve("Round Rock, TX")
        # Georgetown (KGTU) and Austin Executive (KEDC) are both ~15-20 km away.
        assert r["station"] in ("KGTU", "KEDC")
        assert 12 < r["station_km"] < 22
        assert {s for s, _ in r["stations"][:2]} == {"KGTU", "KEDC"}
        assert r["stations"][0][1] <= r["stations"][1][1]

    def test_bare_word_is_not_a_substring_match(self):
        r = resolver.resolve("more")                        # was Skidmore, TX (substring)
        assert r is None or r["name"].upper().startswith("MORE")   # a prefix match (Moreno Valley) is fine
        assert resolver.resolve("san marc")["name"] == "San Marcos, TX"
        assert resolver.resolve("georget")["name"].startswith("Georgetown")

    def test_station_query_keeps_polygon_zone(self):
        r = resolver.resolve("KAUS")
        assert r["zones"][0] == "TXZ192"
        assert r["station_km"] == 0.0

    def test_station_id_with_digits(self):
        # 140 stations in the table carry digits (K1A6, KC09); a bare number is not one.
        assert resolver.resolve("K1A6")["station"] == "K1A6"
        assert resolver.resolve("kc09")["station"] == "KC09"
        assert resolver.resolve("1234") is None
        assert resolver.resolve("kyle")["station"] != "KYLE"


# -- Services -----------------------------------------------------------------


def _store_with(*records):
    store = WeatherStore()
    store.ingest(list(records))
    return store


def _metar_product(icao: str, line: str, age_min: int = 10, seq: int = 1) -> dict:
    ts = datetime.now(timezone.utc) - timedelta(minutes=age_min)
    # The report's own DDHHMMZ group is its time; `age_min` is meant for the report, so
    # the group is stamped from `ts` rather than left as whatever the test typed.
    line = re.sub(r"^([A-Z0-9]{4}\s+(?:COR\s+)?)\d{6}Z", rf"\g<1>{ts:%d%H%M}Z", line)
    return {
        "filename": f"A_SAUS70KWBC{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_{seq:06d}-2-SAHOURLY.TXT",
        "raw_text": f"SAUS70 KWBC {ts:%d%H%M}\r\r\nMETAR\r\r\n{line}=\r\r\n",
    }


class TestObservation:
    def test_skips_silent_nearest_station(self):
        # Only the second-nearest station has a METAR; it must be chosen.
        loc = resolver.resolve("Round Rock, TX")
        second = loc["stations"][1][0]
        store = _store_with(_metar_product(second, f"{second} 131855Z 18005G16KT 10SM FEW050 36/21 A2999"))
        ob = services.observation_for(store, loc)
        assert ob is not None and ob.station == second
        # The group is stamped from the product's time, so the minutes agree with observed_at.
        assert ob.temp_f == 97 and ob.wind_gust_mph == 18
        assert ob.obs_utc_min == ob.observed_at.hour * 60 + ob.observed_at.minute

    def test_skips_stale_station(self):
        loc = resolver.resolve("Round Rock, TX")
        first, second = loc["stations"][0][0], loc["stations"][1][0]
        store = _store_with(
            _metar_product(first, f"{first} 131355Z 16010KT 10SM CLR 30/20 A3001", age_min=300, seq=1),
            _metar_product(second, f"{second} 131855Z 18005KT 10SM CLR 36/21 A2999", age_min=5, seq=2),
        )
        ob = services.observation_for(store, loc)
        assert ob.station == second

    def test_text_and_bytes_agree(self):
        loc = resolver.resolve("Round Rock, TX")
        st, km = loc["stations"][0]
        store = _store_with(_metar_product(st, f"{st} 131855Z 16010G15KT 10SM BKN055 35/21 A3001"))
        ob = services.observation_for(store, loc)
        text = render_text.observation(loc, ob)
        from meshcore_weather.protocol.meshwx import unpack_observation
        wire = unpack_observation(ob.to_bytes())
        assert "95F" in text and wire["temp_f"] == 95
        assert f"{st} {km:.0f}km" in text and wire["location"]["station"] == st
        assert wire["wind_gust_mph"] == 17 and "g17" in text
        assert len(text) <= render_text.MAX_DM


class TestForecast:
    @pytest.fixture(autouse=True)
    def _clock(self, monkeypatch):
        # The fixture was issued 13 Sep 18:51Z, and the days before "today"
        # are left out of a forecast: today is that day.
        monkeypatch.setattr(services, "_now", lambda: datetime(2026, 9, 13, 19, 0, tzinfo=timezone.utc))

    @pytest.fixture
    def store(self):
        raw = (FIXTURES / "PFMEWX_20260913_1851Z.txt").read_bytes().decode("utf-8")
        return _store_with({
            "filename": fresh("A_FOUS54KEWX131851_C_KWIN_20260913185129_315409-3-PFMEWXTX.TXT"),
            "raw_text": raw,
        })

    def test_nearest_point_by_distance_not_zone(self, store):
        # Fixture holds the Austin (TXZ192) and Hondo (TXZ204) points. Kyle is
        # in Hays (TXZ191), which has no point of its own; it must still get
        # a forecast from the nearest point rather than nothing.
        fc = services.forecast_for(store, resolver.resolve("Kyle TX"))
        assert fc is not None
        assert fc.point_zone == "TXZ192"
        assert 25 < fc.distance_km < 45
        assert len(fc.periods) == 7

    def test_far_place_gets_no_forecast(self, store):
        assert services.forecast_for(store, resolver.resolve("Paris TX")) is None

    def test_text_and_bytes_agree(self, store):
        loc = resolver.resolve("Austin TX")
        fc = services.forecast_for(store, loc)
        text = render_text.forecast(loc, fc)
        from meshcore_weather.protocol.meshwx import unpack_forecast
        wire = unpack_forecast(fc.to_bytes())
        p0 = wire["periods"][0]
        assert f"{p0['high_f']}/{p0['low_f']}" in text
        assert len(wire["periods"]) == 7
        assert len(text) <= render_text.MAX_DM
        assert "issued" not in text                  # a current forecast does not say its age

    # 2026-10-01: the dish was down through two issuances, the newest Austin
    # forecast was 34 hours old, and "forecast lockhart TX" was told there was
    # no forecast point within 80 km.

    def test_a_forecast_is_kept_through_missed_issuances(self):
        from meshcore_weather.emwin.retention import is_expired
        now = datetime(2026, 10, 1, 16, 0, tzinfo=timezone.utc)
        assert not is_expired("PFM", now - timedelta(hours=34), now)
        assert is_expired("PFM", now - timedelta(hours=49), now)
        assert is_expired("AFD", now - timedelta(hours=13), now)    # everything else as before

    def test_an_old_forecast_starts_today_and_says_when_it_was_issued(self, store, monkeypatch):
        loc = resolver.resolve("Lockhart TX")
        current = services.forecast_for(store, loc)
        # 36 hours on: two of its days have gone by.
        later = datetime(2026, 9, 15, 7, 0, tzinfo=timezone.utc)
        monkeypatch.setattr(services, "_now", lambda: later)
        fc = services.forecast_for(store, loc)
        assert fc.stale and not current.stale
        assert fc.start_date.date() == later.date()
        assert [p["period_id"] for p in fc.periods] == list(range(len(fc.periods)))
        same_day = (fc.start_date - current.start_date).days
        assert same_day > 0 and fc.periods[0]["high_f"] == current.periods[same_day]["high_f"]
        text = render_text.forecast(loc, fc)
        assert text.startswith("Lockhart, TX (Austin Bergstrom 34km, issued Sun 1:51PM): Tue ")
        assert text.count("|") == 3                  # four days, so it still fits one packet
        assert len(text) <= render_text.MAX_DM

    def test_an_old_forecast_for_a_long_label_still_fits_one_packet(self, store, monkeypatch):
        # "Forecast 78664" went to two pages: the ZIP, the point's name and the
        # issue time left no room for four days.
        monkeypatch.setattr(services, "_now", lambda: datetime(2026, 9, 15, 7, 0, tzinfo=timezone.utc))
        for place in ("78664", "Lockhart TX", "Dripping Springs TX", "78620"):
            loc = resolver.resolve(place)
            fc = services.forecast_for(store, loc)
            text = render_text.forecast(loc, fc)
            assert len(text.encode()) <= render_text.MAX_DM, text
            assert ", issued " in text and text.count("|") <= 3
        # A label with room for three days gets three, not a second page.
        long_loc = dict(loc, name="Lake Travis Northshore Estates At The Hills, TX 78620")
        text = render_text.forecast(long_loc, fc)
        assert len(text.encode()) <= render_text.MAX_DM and text.count("|") == 2, text

    def test_a_point_nearby_with_no_forecast_held_is_not_called_far(self):
        empty = WeatherStore()
        loc = resolver.resolve("Lockhart TX")
        assert render_text.forecast(loc, services.forecast_for(empty, loc)) == \
            "Lockhart, TX: no recent forecast received"
        at_sea = dict(loc, lat=25.0, lon=-140.0)
        assert render_text.forecast(at_sea, None).endswith(": no forecast point within 80km")


class TestWarnings:
    def test_zone_match_and_text(self):
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        from tests.test_warnings import _npw_two_events
        store = _store_with({
            "filename": f"A_WWUS74KEWX{now:%d%H%M}_C_KWIN_{now:%Y%m%d%H%M%S}_310175-1-NPWEWXTX.TXT",
            "raw_text": _npw_two_events(now),
        })
        loc = resolver.resolve("Round Rock, TX")      # TXZ173 is in the NPW
        ws = services.warnings_for(store, loc)
        assert [w["vtec_etn"] for w in ws] == [10, 11]  # in-effect first, then upcoming
        text = render_text.warnings(loc, ws)
        assert text.startswith("2 active, Round Rock, TX: Heat Adv til ")
        assert len(text) <= render_text.MAX_DM
        assert services.warnings_for(store, resolver.resolve("Paris TX")) == []


def test_observation_text_leaves_out_groups_the_metar_did_not_carry():
    resolver.load()
    loc = resolver.resolve("Round Rock, TX")
    st, _km = loc["stations"][0]
    store = _store_with(_metar_product(st, f"{st} 131855Z VRB04KT 31/ FEW250"))
    ob = services.observation_for(store, loc)
    conditions = render_text.observation(loc, ob).split("): ", 1)[1]
    assert conditions == "88F VRB5 few"
    assert ob.to_bytes()                                    # the v4 packer still fills its old defaults


class TestStaleObservation:
    """Nothing current within reach: the newest report up to twelve hours old
    is served with its age rather than nothing (owner, 2026-10-16: "Woodcreek,
    TX 78676: !Wind Adv til 7:00PM | 70/49 20%" read as complete with no
    observation at all and a five-hour-old forecast)."""

    def test_the_newest_stale_report_stands_in_when_nothing_is_fresh(self):
        loc = resolver.resolve("Round Rock, TX")
        first, second = loc["stations"][0][0], loc["stations"][1][0]
        store = _store_with(
            _metar_product(first, f"{first} 131355Z 16010KT 10SM CLR 30/20 A3001", age_min=400, seq=1),
            _metar_product(second, f"{second} 131855Z 18005KT 10SM CLR 36/21 A2999", age_min=300, seq=2),
        )
        ob = services.observation_for(store, loc)
        # The newest, not the nearest: five hours old beats nearly seven.
        assert ob is not None and ob.station == second and ob.stale
        assert 299 <= ob.age_min <= 301

    def test_a_fresh_report_is_never_flagged_and_still_wins(self):
        loc = resolver.resolve("Round Rock, TX")
        first, second = loc["stations"][0][0], loc["stations"][1][0]
        store = _store_with(
            _metar_product(first, f"{first} 131355Z 16010KT 10SM CLR 30/20 A3001", age_min=300, seq=1),
            _metar_product(second, f"{second} 131855Z 18005KT 10SM CLR 36/21 A2999", age_min=5, seq=2),
        )
        ob = services.observation_for(store, loc)
        assert ob.station == second and not ob.stale

    def test_over_twelve_hours_is_nothing(self):
        loc = resolver.resolve("Round Rock, TX")
        st = loc["stations"][0][0]
        store = _store_with(_metar_product(st, f"{st} 131355Z 16010KT 10SM CLR 30/20 A3001", age_min=13 * 60))
        assert services.observation_for(store, loc) is None
        assert render_text.observation(loc, None) == "Round Rock, TX: no current obs within 12h of nearby stations"
        assert render_text.summary(loc, None, [], None) == "Round Rock, TX: no data yet"

    def test_the_replies_say_how_old_it_is(self):
        loc = resolver.resolve("Round Rock, TX")
        st, km = loc["stations"][0]
        store = _store_with(_metar_product(st, f"{st} 131355Z 16010KT 10SM CLR 30/20 A3001", age_min=5 * 60 + 20))
        ob = services.observation_for(store, loc)
        assert ob.stale
        text = render_text.observation(loc, ob)
        assert f"({st} {km:.0f}km, 5h old): 86F dp68 SSE12 clear 10mi 30.01" in text
        assert text.startswith("Round Rock, TX ")
        wx = render_text.summary(loc, ob, [], None)
        assert wx == f"Round Rock, TX: 86F dp68 SSE12 clear ({st} {km:.0f}km, 5h old)"
        assert len(wx) <= render_text.MAX_DM
        # A current report reads exactly as before.
        fresh = services.observation_for(store, loc, max_age_min=6 * 60)
        assert not fresh.stale
        assert render_text.summary(loc, fresh, [], None) == f"Round Rock, TX: 86F dp68 SSE12 clear ({st} {km:.0f}km)"

    def test_an_old_forecast_says_when_it_was_issued_in_the_summary(self):
        loc = resolver.resolve("Round Rock, TX")
        issued = datetime.now(timezone.utc) - timedelta(hours=5)
        period = {"period_id": 0, "high_f": 70, "low_f": 49, "precip_pct": 20, "sky_code": 0}
        fc = services.Forecast(point_name="Austin Bergstrom", point_zone="TXZ192", distance_km=34.0,
                               issued_at=issued, source="PFM", periods=[period], stale=True)
        text = render_text.summary(loc, None, [], fc)
        assert text == f"Round Rock, TX: 70/49 20% fc issued {render_text._when(issued, render_text.tz_for_loc(loc))}"
        assert len(text) <= render_text.MAX_DM
        current = services.Forecast(point_name="Austin Bergstrom", point_zone="TXZ192", distance_km=34.0,
                                    issued_at=issued, source="PFM", periods=[period])
        assert render_text.summary(loc, None, [], current) == "Round Rock, TX: 70/49 20%"

    def test_the_metar_reply_serves_a_stale_report_and_says_how_old(self):
        # "metar <place>" is render_text.raw_metar over services.raw_metar_for:
        # the same twelve hours, the same label.
        loc = resolver.resolve("Round Rock, TX")
        st, km = loc["stations"][0]
        store = _store_with(_metar_product(st, f"{st} 131355Z 16010KT 10SM CLR 30/20 A3001", age_min=5 * 60 + 20))
        found = services.raw_metar_for(store, loc)
        assert found is not None and found[0] == st
        text = render_text.raw_metar(loc, found)
        assert text.startswith(f"METAR ({st} {km:.0f}km, 5h old) {st} ")
        # The station asked for by name: no distance, still the age.
        assert render_text.raw_metar(loc, (st, 0.0, found[2])).startswith(f"METAR (5h old) {st} ")
        # A current one reads as before.
        fresh = _store_with(_metar_product(st, f"{st} 131855Z 16010KT 10SM CLR 30/20 A3001", age_min=10))
        assert render_text.raw_metar(loc, services.raw_metar_for(fresh, loc)).startswith(f"METAR ({st} {km:.0f}km) {st} ")
        old = _store_with(_metar_product(st, f"{st} 131355Z 16010KT 10SM CLR 30/20 A3001", age_min=13 * 60))
        assert services.raw_metar_for(old, loc) is None
        assert render_text.raw_metar(loc, None) == "Round Rock, TX: no METAR within 12h from nearby stations"

    def test_a_station_asked_for_by_name_answers_with_its_own_report(self):
        # 2026-10-19: "metar KLAX" answered with Hawthorne's (KHHR) newer report.
        # A METAR is one airport's; the reply says how old it is, as `>metar` does.
        loc = resolver.resolve("KLAX")
        near = loc["stations"][1][0]
        store = _store_with(
            _metar_product("KLAX", "KLAX 191353Z 25008KT 10SM CLR 20/12 A2995", age_min=155, seq=1),
            _metar_product(near, f"{near} 191553Z 25008KT 10SM CLR 21/12 A2995", age_min=35, seq=2),
        )
        found = services.raw_metar_for(store, loc)
        assert found[0] == "KLAX" and render_text.raw_metar(loc, found).startswith("METAR (2h old) KLAX ")
        # A place still gets the nearest current report.
        place = dict(loc, stations=[(s, km + 1.0) for s, km in loc["stations"]])
        assert services.raw_metar_for(store, place)[0] == near
        # A station with nothing in twelve hours: a neighbour, named.
        silent = _store_with(_metar_product(near, f"{near} 191553Z 25008KT 10SM CLR 21/12 A2995", age_min=35))
        assert services.raw_metar_for(silent, loc)[0] == near
