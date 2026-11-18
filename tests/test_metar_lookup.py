"""Finding a station's METAR in a collective (WeatherStore._find_metar_raw).

Two things the lookup got wrong, found 2026-10-17 against the live feed:

- A station with a digit in its identifier (KT82, K11R, KT74, K6R3, K3T5:
  all inside the bot's coverage, each reporting about 43 times a day) never
  matched `[A-Z]{4}`, so none of them could ever be served.
- A collective wraps a long report at about 69 columns and indents the rest,
  and only the first line was returned. Some 400 reports a day wrap, and one
  that wraps before its temperature group ("K2G4 ... OVC060" / "     10/09
  A2995 RMK AO2=") parsed as having no temperature at all.

The fixtures are two real SAHOURLY collectives from that day.
"""

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from meshcore_weather.core import services
from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol.encoders import parse_metar

PRODUCTS = Path(__file__).parent / "fixtures" / "products"
COLLECTIVES = sorted(PRODUCTS.glob("A_SAUS70KWBC170100_*-SAHOURLY.TXT"))


def _restamped(path: Path, when: datetime) -> dict:
    """The real product, dated `when`: the filename's time so the store's
    retention keeps it, and every report's DDHHMMZ group so the services
    read it as current."""
    name = re.sub(r"_\d{14}_", f"_{when:%Y%m%d%H%M%S}_", path.name)
    text = path.read_bytes().decode("utf-8", "replace")
    text = re.sub(r"^([A-Z0-9]{4}\s+(?:COR\s+)?)\d{6}Z", rf"\g<1>{when:%d%H%M}Z", text, flags=re.MULTILINE)
    return {"filename": name, "raw_text": text}


def _store(when: datetime | None = None) -> WeatherStore:
    when = when or datetime.now(timezone.utc) - timedelta(minutes=10)
    store = WeatherStore()
    assert len(COLLECTIVES) == 2
    store.ingest([_restamped(p, when) for p in COLLECTIVES])
    return store


def test_a_station_with_a_digit_is_found():
    found = _store()._find_metar_raw("K11R")
    assert found is not None
    assert found[0].startswith("K11R ")
    assert parse_metar(found[0])["temp_f"] == 63             # 17/03


def test_a_wrapped_report_is_joined_up_to_its_terminator():
    # "K2G4 170055Z AUTO 30012G24KT 250V340 10SM FEW010 FEW047 OVC060" then
    # "     10/09 A2995 RMK AO2=": the temperature and altimeter are on the
    # second line, and the "=" that ends the report is dropped.
    text, _ts = _store()._find_metar_raw("K2G4")
    assert text.endswith("OVC060 10/09 A2995 RMK AO2")
    fields = parse_metar(text)
    assert (fields["temp_f"], fields["dewpoint_f"], fields["pressure_inhg"]) == (50, 48, 29.95)


def test_a_report_wrapped_twice_is_joined_whole():
    # KBJJ runs to three lines; the remarks are joined too, so the raw METAR
    # reply carries the whole report.
    text, _ts = _store()._find_metar_raw("KBJJ")
    assert "10/09 A3005 RMK AO2 WSHFT 0016 RAB20 PRESRR SLP176 P0007 T01000089" in text
    assert parse_metar(text)["pressure_inhg"] == 30.05


def test_the_join_stops_at_the_next_station():
    # K0W3 is the second-to-last report in its collective, followed by K11R:
    # a wrapped report must not swallow the station after it.
    text, _ts = _store()._find_metar_raw("K0W3")
    assert "K11R" not in text and text.endswith("T01650165")


def test_the_station_must_match_whole():
    store = _store()
    assert store._find_metar_raw("K2G") is None                # a prefix of K2G4 is not a station
    assert store._find_metar_raw("") is None


def test_a_corrected_report_is_found_and_decoded():
    ts = datetime.now(timezone.utc) - timedelta(minutes=10)
    store = WeatherStore()
    store.ingest([{
        "filename": f"A_SAUS70KWBC{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_000001-2-SAHOURLY.TXT",
        "raw_text": f"SAUS70 KWBC {ts:%d%H%M}\r\r\nMETAR\r\r\n"
                    f"KAUS COR {ts:%d%H%M}Z 36020G30KT 10SM FEW120 BKN200 17/03 A3041 RMK AO2=\r\r\n",
    }])
    text, _ts = store._find_metar_raw("KAUS")
    assert text.startswith("KAUS COR ")
    assert parse_metar(text)["temp_f"] == 63
    ob = services.observation_for(store, resolver.resolve("Austin, TX"))
    assert ob is not None and ob.station == "KAUS" and ob.temp_f == 63


def test_brenham_is_served_by_its_own_airport():
    # Brenham Municipal is K11R, 6 km away; before the fix the reply came from
    # College Station, 47 km off, or from nowhere.
    resolver.load()
    ob = services.observation_for(_store(), resolver.resolve("Brenham, TX"))
    assert ob is not None and ob.station == "K11R"
    assert ob.temp_f == 63 and ob.wind_gust_mph == 20 and not ob.stale
