"""PFM layouts the parser misread (real products, fixtures/products).

- No space between "hrly" and the first hour: "MDT 6hrly00   06 12 18"
  (TFX, CYS), "UTC 6hrly06 12 18" (AMA and 23 others in three days), and
  "UTC3hrly     09 12" (MHX). The 6-hourly header did not parse, so its
  table was dropped and its rows were read into the 3-hourly table's columns
  (a two-digit value cut in half: Lewistown MT "Sat 73/3 | Sun 67/35 | Mon
  70/40 60% rain", truth 73/39, 59/35, 70/41 0%; Bridgeport NE "77/3").
- A row label glued to its first value: "Temp52 49 43 ..." (BOX: Taunton's
  first three days were lost and Tuesday's 59/44 shown as today's),
  "Max/Min70" (EWX, San Marcos Airport), "Temp66 66" (MAF, Big Lake),
  "PoP 12hr90" (AKQ).
"""

from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from meshcore_weather.core import render_text, services
from meshcore_weather.geodata import resolver
from meshcore_weather.parser.pfm import (
    _HRLY_LOCAL_RE,
    _HRLY_UTC_RE,
    _unglue_row,
    downsample_to_daily,
    parse_pfm,
)
from meshcore_weather.parser.weather import WeatherStore
from tests.test_core import fresh

PRODUCTS = Path(__file__).parent / "fixtures" / "products"


def _raw(fragment: str) -> str:
    return next(PRODUCTS.glob(f"*{fragment}*")).read_bytes().decode("utf-8", "replace")


def _point(fragment: str, name: str, raw: str | None = None):
    return next(p for p in parse_pfm(raw or _raw(fragment)) if p.name.startswith(name))


def _days(point) -> list[tuple[str, int, int, int]]:
    return [(d.local_date.strftime("%a"), d.high_f, d.low_f, d.precip_pct) for d in downsample_to_daily(point)]


def _store(fragment: str) -> WeatherStore:
    f = next(PRODUCTS.glob(f"*{fragment}*"))
    store = WeatherStore()
    store.ingest([{"filename": fresh(f.name), "raw_text": f.read_bytes().decode("utf-8", "replace")}])
    return store


def test_header_rows_with_no_space_before_the_first_hour_parse():
    m = _HRLY_LOCAL_RE.match("MDT 6hrly00   06 12 18 00   06 12 18")
    assert m and m.group("label").strip() == "MDT 6hrly" and m.group("hours").startswith("00")
    assert _HRLY_UTC_RE.match("UTC 3hrly21 00 03 06").group("hours").startswith("21")
    assert _HRLY_UTC_RE.match("UTC 6hrly06 12 18 00").group("hours").startswith("06")
    assert _HRLY_UTC_RE.match("UTC3hrly     09 12 15").group("hours").startswith("09")
    assert _HRLY_LOCAL_RE.match("AKDT3hrly13 16 19").group("label").strip() == "AKDT3hrly"


def test_lewistown_reads_both_tables():
    """TFX 16:21Z: before "Sat 73/3 | Sun 67/35 | Mon 70/40 60% rain"."""
    lewistown = _point("PFMTFXMT", "Lewistown")
    assert _days(lewistown) == [("Sat", 73, 39, 0), ("Sun", 59, 35, 0), ("Mon", 70, 41, 0), ("Tue", 58, 34, 5),
                                ("Wed", 63, 40, 10), ("Thu", 67, 38, 5), ("Fri", 48, 46, 60)]
    six = [s for s in lewistown.slots if s.interval_hours == 6]
    assert [s.minmax_f for s in six if s.minmax_f is not None] == [41, 58, 34, 63, 40, 67, 38, 48]
    assert six[0].dt == datetime(2026, 10, 20, 6, 0, tzinfo=UTC)          # Tue 00 MDT


def test_lewistown_forecast_reply(monkeypatch):
    monkeypatch.setattr(services, "_now", lambda: datetime(2026, 10, 17, 20, 30, tzinfo=UTC))
    loc = resolver.resolve("Lewistown MT")
    fc = services.forecast_for(_store("PFMTFXMT"), loc)
    reply = render_text.forecast(loc, fc)
    assert "Sat 73/39 | Sun 59/35 | Mon 70/41 |" in reply and "60%" not in reply.split("Tue")[0]


def test_bridgeport_low_is_not_a_cut_number():
    """CYS 18:17Z: before "Sat 77/3 | Sun 78/35 | Mon 68/43 30% rain"."""
    assert _days(_point("PFMCYSWY", "Bridgeport"))[:4] == [
        ("Sat", 77, 37, 0), ("Sun", 70, 35, 0), ("Mon", 68, 37, 0), ("Tue", 73, 43, 0)]


def test_taunton_temp_row_glued_to_its_label():
    """BOX 17:06Z, "Temp52 49 43 ...": before, the forecast began on Tuesday."""
    taunton = _point("PFMBOXMA", "Taunton")
    assert _days(taunton)[:4] == [("Sat", 53, 28, 0), ("Sun", 56, 32, 0), ("Mon", 59, 41, 5), ("Tue", 59, 44, 5)]
    three = [s for s in taunton.slots if s.interval_hours == 3]
    assert [s.temp_f for s in three][3:7] == [52, 49, 43, 37]      # from the 18Z column, as Dewpt


def test_utc_header_one_column_left_of_the_data():
    """MHX 15:33Z, "UTC3hrly     09 12": before, the 3-hourly table was
    dropped and New River MCAS began on Tuesday."""
    assert _days(_point("PFMMHXNC", "New River"))[:3] == [
        ("Sat", 63, 45, 100), ("Sun", 64, 51, 20), ("Mon", 66, 51, 30)]


def test_texas_glued_rows():
    """EWX 09:06Z "Max/Min70": San Marcos Airport's Saturday low was 56 (from
    the Temp row) where NWS forecast 47. MAF 00:46Z "Temp66 66" in the
    6-hourly table: Big Lake had three days, not seven."""
    assert _days(_point("PFMEWXTX", "San Marcos Airport"))[:3] == [
        ("Sat", 70, 47, 0), ("Sun", 74, 50, 0), ("Mon", 78, 56, 0)]
    big_lake = _point("PFMMAFTX", "Big Lake")
    six = [s for s in big_lake.slots if s.interval_hours == 6]
    assert [s.temp_f for s in six][:6] == [66, 66, 57, 54, 73, 74]
    assert len(_days(big_lake)) == 7


def test_unglue_places_values_on_the_columns():
    cols = [14 + 3 * k for k in range(8)]            # a 3-hourly table, 8 columns
    row = _unglue_row("Temp52 49 43", 4, cols)
    assert row is not None and row.split() == ["Temp", "52", "49", "43"]
    assert row.index("43") == cols[-1]                  # right-aligned on the last column
    # A 12-hourly row lands on its columns only (here 3 and 7).
    row = _unglue_row("PoP 12hr40           0", 8, cols, anchor_cols={3, 7})
    assert row.index("40") == cols[3] and row.rindex("0") == cols[7] + 1
    assert _unglue_row("Rain shwrsWind chill", 10, cols) is None     # not values


def _without_table_header(raw: str, point: str) -> str:
    """The point's 6-hourly local header made unreadable."""
    start = raw.index(point)
    k = raw.index("MDT 6hrly", start)
    return raw[:k] + "MDT 6hrlyXX" + raw[k + len("MDT 6hrly00"):]


def test_rows_of_an_unreadable_table_stay_out_of_the_previous_one():
    raw = _raw("PFMTFXMT")
    broken = _point("PFMTFXMT", "Lewistown", _without_table_header(raw, "Lewistown"))
    good = _point("PFMTFXMT", "Lewistown", raw)
    three = [(s.dt, s.temp_f, s.minmax_f, s.pop_pct) for s in good.slots if s.interval_hours == 3]
    assert [(s.dt, s.temp_f, s.minmax_f, s.pop_pct) for s in broken.slots] == three
    # The 3-hourly table's days only (Monday's low then comes from its own
    # night, the 6-hourly table's Tuesday-morning minimum being gone).
    assert _days(broken)[:2] == _days(good)[:2] and len(_days(broken)) == 3


def test_min_max_row_stands_in_for_an_unusable_temp_row():
    raw = _raw("PFMCYSWY")
    start = raw.index("Bridgeport")
    end = raw.index("$$", start)
    body = "\n".join(line for line in raw[start:end].splitlines() if not line.startswith("Temp"))
    bridgeport = _point("PFMCYSWY", "Bridgeport", raw[:start] + body + "\n" + raw[end:])
    assert all(s.temp_f is None for s in bridgeport.slots)
    assert [(d, h, lo) for d, h, lo, _ in _days(bridgeport)][:4] == [
        ("Sat", 77, 37), ("Sun", 70, 35), ("Mon", 68, 37), ("Tue", 73, 43)]


def test_summary_names_the_first_day_when_it_is_not_today():
    loc = resolver.resolve("Taunton MA")
    period = {"period_id": 0, "high_f": 59, "low_f": 44, "precip_pct": 5, "sky_code": 0}
    fc = services.Forecast(point_name="Taunton-Bristol MA", point_zone="MAZ017", distance_km=7.0,
                           issued_at=datetime(2026, 10, 17, 17, 6, tzinfo=UTC), source="PFM",
                           periods=[period], start_date=datetime(2026, 10, 20))
    saturday = datetime(2026, 10, 17, 20, 30, tzinfo=UTC)
    assert render_text.summary(loc, None, [], fc, now=saturday) == "Taunton, MA: Tue 59/44"
    today = services.Forecast(**{**fc.__dict__, "start_date": datetime(2026, 10, 17)})
    assert render_text.summary(loc, None, [], today, now=saturday) == "Taunton, MA: 59/44"


@pytest.mark.parametrize("fragment,place", [("PFMTFXMT", "Lewistown MT"), ("PFMBOXMA", "Taunton MA")])
def test_forecast_starts_today_and_the_summary_does_not_name_it(monkeypatch, fragment, place):
    saturday = datetime(2026, 10, 17, 20, 30, tzinfo=UTC)
    monkeypatch.setattr(services, "_now", lambda: saturday)
    loc = resolver.resolve(place)
    fc = services.forecast_for(_store(fragment), loc)
    assert fc.start_date.date() == date(2026, 10, 17)
    p = fc.periods[0]
    assert f": {p['high_f']}/{p['low_f']}" in render_text.summary(loc, None, [], fc, now=saturday)
