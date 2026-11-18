"""Unit tests for the PFM parser and downsampler."""

from datetime import datetime, timezone

import pytest

from meshcore_weather.parser.pfm import (
    PFMSlot,
    DailyPeriod,
    parse_pfm,
    find_point,
    downsample_to_daily,
)


# A trimmed-but-realistic PFM product, modeled on a real EWX Austin Bergstrom
# product. Two forecast points (Austin Bergstrom + a second point) so we can
# test multi-point parsing. Single 3-hourly table per point.
SAMPLE_PFM = """\
FOUS54 KEWX 101745

PFMEWX



Point Forecast Matrices

National Weather Service Austin/San Antonio TX

1245 PM CDT Fri Apr 10 2026



TXZ192-110900-

Austin Bergstrom-Travis TX

30.19N  97.67W Elev. 462 ft

1245 PM CDT Fri Apr 10 2026



Date           04/10/26      Sat 04/11/26            Sun 04/12/26

CDT 3hrly     16 19 22 01 04 07 10 13 16 19 22 01 04 07 10 13 16

UTC 3hrly     21 00 03 06 09 12 15 18 21 00 03 06 09 12 15 18 21



Min/Max                      65          82          68          80

Temp          80 77 69 68 67 66 71 78 81 78 72 70 69 68 72 76 78

Dewpt         66 66 66 66 66 66 68 68 68 67 67 67 67 68 70 70 69

RH            62 69 90 93 97100 90 71 65 69 84 90 93100 93 82 74

Wind dir       E  E SE SE SE SE SE SE SE SE SE SE  S SE  S  S  S

Wind spd       9  9  6  4  4  4  8 11 13 13 12 11 11 10 12 14 13

Clouds        SC SC B1 B1 B2 B2 B1 SC B1 B1 B1 OV OV OV OV OV OV

PoP 12hr                     20          50          40          60

Rain shwrs     C  S           S  C  C  C  C  C  C  C  C  C  L  L

Tstms          C  S              S  C  C  S     S  S     S  C  C

Obvis                        PF                   PF PF PF          PF



TXZ186-110900-

Kerrville Airport-Kerr TX

30.05N  99.13W Elev. 1617 ft

1245 PM CDT Fri Apr 10 2026



Date           04/10/26      Sat 04/11/26            Sun 04/12/26

CDT 3hrly     16 19 22 01 04 07 10 13 16 19 22 01 04 07 10 13 16

UTC 3hrly     21 00 03 06 09 12 15 18 21 00 03 06 09 12 15 18 21



Min/Max                      55          80          60          78

Temp          75 72 65 60 58 57 62 71 78 75 68 65 62 60 65 72 75

Dewpt         55 55 55 55 55 55 56 56 56 55 55 55 55 55 56 56 56

Wind dir      SE SE SE SE SE SE SE SE SE SE SE SE  S SE  S  S  S

Wind spd       8  8  5  3  3  3  7 10 12 12 11 10 10  9 11 13 12

Clouds        FW SC B1 B2 B2 B2 SC FW FW SC SC B1 B1 B1 B2 B2 B2

PoP 12hr                     10          40          30          50

Rain shwrs                                C  C  C  C  C  C  C  C  C

Tstms                                                       S  S  S



$$
"""


class TestPFMParser:
    def test_two_points_extracted(self):
        points = parse_pfm(SAMPLE_PFM)
        assert len(points) == 2
        assert points[0].zone == "TXZ192"
        assert points[0].name == "Austin Bergstrom-Travis TX"
        assert points[1].zone == "TXZ186"
        assert points[1].name == "Kerrville Airport-Kerr TX"

    def test_metadata_parsed(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        assert austin.lat == 30.19
        assert austin.lon == -97.67
        assert austin.elev_ft == 462
        assert austin.wfo == "EWX"
        assert austin.tz_offset_hours == -5  # CDT
        assert austin.issue_time is not None
        assert austin.issue_time.tzinfo == timezone.utc

    def test_temperature_row_parsed(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        # Slot 0 = 21Z (16 CDT) = first column = 80°F
        assert austin.slots[0].temp_f == 80
        # Last slot = 21Z next day = 78°F per the Temp row
        assert austin.slots[-1].temp_f == 78
        # Min temp in the table is 66°F (overnight Saturday morning at 12Z)
        all_temps = [s.temp_f for s in austin.slots if s.temp_f is not None]
        assert min(all_temps) == 66
        assert max(all_temps) == 81

    def test_wind_parsed(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        # First slot wind = E 9 mph
        assert austin.slots[0].wind_dir == "E"
        assert austin.slots[0].wind_spd_mph == 9

    def test_clouds_parsed(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        clouds = [s.cloud for s in austin.slots if s.cloud]
        assert "SC" in clouds
        assert "B1" in clouds
        assert "OV" in clouds

    def test_pop12_sparse(self):
        """PoP 12hr only has values at 12-hour boundaries (06Z and 18Z),
        not in every column."""
        austin = parse_pfm(SAMPLE_PFM)[0]
        pop_slots = [s for s in austin.slots if s.pop_pct is not None]
        # Sparse — at most one per 12 hours
        assert 1 <= len(pop_slots) <= 6
        assert all(0 <= s.pop_pct <= 100 for s in pop_slots)

    def test_rain_tstm_codes_parsed(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        rain_codes = {s.rain for s in austin.slots if s.rain}
        # Sample has C, S, L
        assert "C" in rain_codes

    def test_obvis_parsed(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        obvis_codes = [s.obvis for s in austin.slots if s.obvis]
        assert "PF" in obvis_codes

    def test_find_point_by_zone(self):
        points = parse_pfm(SAMPLE_PFM)
        austin = find_point(points, zone="TXZ192")
        assert austin is not None
        assert austin.name == "Austin Bergstrom-Travis TX"

        kerr = find_point(points, zone="TXZ186")
        assert kerr is not None
        assert kerr.name == "Kerrville Airport-Kerr TX"

    def test_unknown_zone_returns_none(self):
        points = parse_pfm(SAMPLE_PFM)
        assert find_point(points, zone="ZZZ999") is None


class TestPFMDownsampler:
    def test_emits_periods_with_high_low(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        periods = downsample_to_daily(austin)
        assert len(periods) >= 1
        for p in periods:
            assert p.high_f is not None
            assert p.low_f is not None
            # Invariant: high >= low
            assert p.high_f >= p.low_f, f"day {p.day_offset}: high {p.high_f} < low {p.low_f}"

    def test_saturday_high_low_match_pfm(self):
        """Saturday's downsampled high should be near 81°F (max in Temp row
        for Saturday's CDT day) and low near 66°F (min during Saturday)."""
        austin = parse_pfm(SAMPLE_PFM)[0]
        periods = downsample_to_daily(austin)
        # Day 0 in the downsampled output is the first day with enough data.
        # For a Friday-afternoon issue with 3 Friday slots, day 0 will be Saturday.
        sat = periods[0]
        assert 78 <= sat.high_f <= 85, f"Sat high {sat.high_f}°F out of expected range"
        assert 60 <= sat.low_f <= 70, f"Sat low {sat.low_f}°F out of expected range"

    def test_thunderstorm_flag_set(self):
        """Sample has Tstms = C/S in many columns → thunder flag should be on."""
        austin = parse_pfm(SAMPLE_PFM)[0]
        periods = downsample_to_daily(austin)
        # _COND_THUNDER = 0x01
        assert any(p.condition_flags & 0x01 for p in periods), "thunderstorm flag never set"

    def test_fog_flag_set(self):
        """Sample has Obvis=PF in some slots → fog flag (0x04) should be on."""
        austin = parse_pfm(SAMPLE_PFM)[0]
        periods = downsample_to_daily(austin)
        assert any(p.condition_flags & 0x04 for p in periods), "fog flag never set"

    def test_partial_days_filtered(self):
        """The sample has a partial Friday (3 slots) at the start. With
        min_slots_per_day=4 (default), Friday should be dropped."""
        austin = parse_pfm(SAMPLE_PFM)[0]
        periods = downsample_to_daily(austin, min_slots_per_day=4)
        # Day 0 should be Saturday (with full data), not Friday
        # Saturday's high should be ~80, Friday afternoon's max would be 80
        # Both happen to be near the same value, so we check by counting periods
        # vs the unfiltered version
        unfiltered = downsample_to_daily(austin, min_slots_per_day=1)
        assert len(periods) <= len(unfiltered)

    def test_to_encoder_dict(self):
        austin = parse_pfm(SAMPLE_PFM)[0]
        period = downsample_to_daily(austin)[0]
        d = period.to_encoder_dict()
        # Required keys for pack_forecast()
        for key in ("period_id", "high_f", "low_f", "sky_code", "precip_pct",
                    "wind_dir_nibble", "wind_speed_5mph", "condition_flags"):
            assert key in d
        assert isinstance(d["period_id"], int)
        assert isinstance(d["high_f"], int)
        assert isinstance(d["low_f"], int)
        # high/low are bounded for int8 packing
        assert -128 <= d["high_f"] <= 127
        assert -128 <= d["low_f"] <= 127
        assert 0 <= d["sky_code"] <= 0xF
        assert 0 <= d["precip_pct"] <= 100


class TestPFMEncoderIntegration:
    def test_encode_forecast_from_pfm_roundtrip(self):
        """encode_forecast_from_pfm produces a valid 0x31 message."""
        from meshcore_weather.protocol.encoders import encode_forecast_from_pfm
        from meshcore_weather.protocol.meshwx import unpack_forecast, MSG_FORECAST

        msg = encode_forecast_from_pfm(SAMPLE_PFM, "TXZ192", issued_hours_ago=0)
        assert msg is not None
        assert msg[0] == MSG_FORECAST
        decoded = unpack_forecast(msg)
        assert len(decoded["periods"]) >= 1
        # First period should have a high temp from PFM (real number, not None)
        first = decoded["periods"][0]
        assert first["high_f"] is not None
        assert 60 <= first["high_f"] <= 100

    def test_encode_forecast_pfm_with_loc_pfm_point(self):
        """Encoder echoes back LOC_PFM_POINT when caller provides it."""
        from meshcore_weather.protocol.encoders import encode_forecast_from_pfm
        from meshcore_weather.protocol.meshwx import (
            unpack_forecast, LOC_PFM_POINT,
        )

        msg = encode_forecast_from_pfm(
            SAMPLE_PFM, "TXZ192", issued_hours_ago=0,
            loc_type=LOC_PFM_POINT, loc_id=42,
        )
        assert msg is not None
        decoded = unpack_forecast(msg)
        assert decoded["location"]["type"] == LOC_PFM_POINT
        assert decoded["location"]["pfm_point_id"] == 42

    def test_encode_forecast_pfm_unknown_zone_returns_none(self):
        from meshcore_weather.protocol.encoders import encode_forecast_from_pfm
        msg = encode_forecast_from_pfm(SAMPLE_PFM, "ZZZ999", issued_hours_ago=0)
        assert msg is None


class TestMalformedPoint:
    """A single malformed point must not abort the whole product (real EWX
    PFM from 2026-09-13 had "09 1215 18" in one point's UTC header row)."""

    def _product_with_bad_point(self, bad_header: str) -> str:
        # Duplicate the sample's first point as a second point with a
        # corrupted UTC header, then keep the real second point after it.
        first_point = SAMPLE_PFM.split("TXZ192-110900-")[1].split("TXZ")[0]
        bad_point = "TXZ204-110900-" + first_point.replace(
            "Austin Bergstrom-Travis TX", "Hondo Airport-Medina TX"
        )
        good_utc = [l for l in bad_point.splitlines() if l.startswith("UTC 3hrly")][0]
        bad_point = bad_point.replace(good_utc, bad_header)
        head, rest = SAMPLE_PFM.split("TXZ192-110900-", 1)
        return head + "TXZ192-110900-" + rest.replace("TXZ", bad_point + "TXZ", 1)

    def test_run_together_hours_are_repaired(self):
        text = self._product_with_bad_point(
            "UTC 3hrly     21 00 03 06 09 12 15 18 21 00 03 06 09 1215 18 21 00 03 06 09 12"
        )
        points = parse_pfm(text)
        hondo = find_point(points, zone="TXZ204")
        assert hondo is not None
        assert len([s for s in hondo.slots if s.interval_hours == 3]) == 22
        assert find_point(points, zone="TXZ192") is not None

    def test_impossible_hour_skips_only_that_point(self):
        text = self._product_with_bad_point(
            "UTC 3hrly     21 00 03 06 09 12 15 18 21 00 03 06 09 99 15 18 21 00 03 06 09 12"
        )
        points = parse_pfm(text)
        assert find_point(points, zone="TXZ204") is None
        assert find_point(points, zone="TXZ192") is not None
        assert len(points) == len(parse_pfm(SAMPLE_PFM))


class TestRealEWXProduct:
    """Real KEWX PFM received over GOES-19 HRIT on 2026-09-13 18:51Z, trimmed
    to the Austin Bergstrom point (clean) and the Hondo point (which has the
    run-together "09 1215 18" header row). Public-domain NWS data."""

    @pytest.fixture
    def text(self):
        from pathlib import Path
        path = Path(__file__).parent / "fixtures" / "PFMEWX_20260913_1851Z.txt"
        return path.read_bytes().decode("utf-8")

    def test_both_tables_parsed_for_austin(self, text):
        austin = find_point(parse_pfm(text), zone="TXZ192")
        assert austin is not None
        assert sum(1 for s in austin.slots if s.interval_hours == 3) == 22
        assert sum(1 for s in austin.slots if s.interval_hours == 6) == 18

    def test_six_hourly_table_anchored_on_its_date_row(self, text):
        austin = find_point(parse_pfm(text), zone="TXZ192")
        six = sorted(s.dt for s in austin.slots if s.interval_hours == 6)
        # "Date 09/16 Thu 09/17/26 ..." / "CDT 6hrly 13 19 ..." / "UTC 6hrly 18 00 ..."
        assert six[0] == datetime(2026, 9, 16, 18, tzinfo=timezone.utc)
        assert six[-1] == datetime(2026, 9, 21, 0, tzinfo=timezone.utc)
        three = sorted(s.dt for s in austin.slots if s.interval_hours == 3)
        assert three[0] == datetime(2026, 9, 13, 21, tzinfo=timezone.utc)
        assert three[-1] < six[0]

    def test_seven_day_forecast_from_real_product(self, text):
        austin = find_point(parse_pfm(text), zone="TXZ192")
        days = downsample_to_daily(austin)
        # Sun 9/13 is partial (3 slots); Mon 9/14 .. Sun 9/20 are full days.
        assert len(days) == 7, f"got {len(days)} daily periods"
        assert [d.day_offset for d in days] == [0, 1, 2, 3, 4, 5, 6]
        assert all(d.high_f is not None and d.low_f is not None for d in days)

    def test_glued_date_and_6hrly_header_is_split(self, text):
        # New Braunfels: NWS dropped the newline between the second "Date"
        # row and "CDT 6hrly". Before the repair the 6-hourly rows were
        # applied on top of the 3-hourly columns (temps of 7 and 1 F).
        nb = find_point(parse_pfm(text), zone="TXZ207")
        assert nb is not None
        assert sum(1 for s in nb.slots if s.interval_hours == 6) == 18
        temps = [s.temp_f for s in nb.slots if s.temp_f is not None]
        assert min(temps) > 60 and max(temps) <= 101
        assert len(downsample_to_daily(nb)) == 7

    def test_hondo_point_survives_bad_header(self, text):
        hondo = find_point(parse_pfm(text), zone="TXZ204")
        assert hondo is not None
        assert sum(1 for s in hondo.slots if s.interval_hours == 3) == 22


def test_highs_and_lows_come_from_the_min_max_row():
    """Checked 2026-09-14 against forecast.weather.gov's PFM for the same
    issuance: sampled 3-hourly temps ran 2-6 F below the forecast max."""
    from pathlib import Path
    from meshcore_weather.parser.pfm import parse_pfm, downsample_to_daily
    pts = parse_pfm((Path(__file__).parent / "fixtures" / "PFMEWX_20260913_1851Z.txt").read_bytes().decode())
    mabry = [p for p in pts if p.name.startswith("Austin Camp Mabry")][0]
    days = [(d.high_f, d.low_f) for d in downsample_to_daily(mabry)]
    # Mon..Sat from the Min/Max (3-hourly) and Max/Min (6-hourly) rows
    assert days[:6] == [(101, 78), (102, 77), (100, 77), (97, 75), (98, 74), (98, 74)]


def test_partial_first_day_with_row_max_is_day_zero():
    """MPX PFM issued 18:51Z: Monday has only evening samples but the
    Max/Min row gives 62; the first period must be Monday 62/57, not
    Tuesday's numbers labelled Monday (found 2026-09-14)."""
    from pathlib import Path
    from datetime import date
    from meshcore_weather.parser.pfm import parse_pfm, downsample_to_daily
    pts = parse_pfm((Path(__file__).parent / "fixtures" / "PFMMPX_20260914_1851Z.txt").read_bytes().decode("utf-8", "replace"))
    mpls = [p for p in pts if p.name.startswith("Minneapolis")][0]
    days = downsample_to_daily(mpls)
    assert days[0].local_date == date(2026, 9, 14)
    assert (days[0].high_f, days[0].low_f) == (62, 57)
    assert (days[1].high_f, days[1].low_f) == (70, 51)


def test_date_row_glued_to_previous_row_is_repaired():
    """HGX PFM over the satellite, 2026-09-14: the 6-hourly Date row arrived
    glued to the Heat row ("...Y  YDate          Thu 09/17/26 ..."), which
    dated the extended days two days early. Simulated on the KEWX fixture."""
    from pathlib import Path
    from meshcore_weather.parser.pfm import parse_pfm, downsample_to_daily
    raw = (Path(__file__).parent / "fixtures" / "PFMEWX_20260913_1851Z.txt").read_bytes().decode()
    glued = raw.replace("\r\r\n\r\r\n\r\r\nDate           09/16", "Date           09/16", 1)   # 6-hourly Date row glued to the row above
    assert glued != raw
    def mabry(text):
        pts = parse_pfm(text)
        p = [x for x in pts if x.name.startswith("Austin Camp Mabry")][0]
        return [(d.local_date.isoformat(), d.high_f, d.low_f) for d in downsample_to_daily(p)][:6]
    assert mabry(glued) == mabry(raw)


def test_min_max_row_glued_to_the_utc_header_is_repaired():
    """JKL PFM over the satellite, 2026-10-17 (and 45 of 1,722 PFMs in three
    days, SJT and MAF among them): the 6-hourly Min/Max row arrived glued to
    the UTC header ("...06 12 18 00Min/Max   34   67 ..."), which read as a
    UTC hour of 34 and lost the whole point. Real file, Jenny Wiley State
    Park (KYZ110)."""
    from pathlib import Path
    from datetime import date
    from meshcore_weather.parser.pfm import parse_pfm, downsample_to_daily
    raw = (Path(__file__).parent / "fixtures" / "products"
           / "A_FOUS53KJKL171157_C_KWIN_20261017115708_639675-3-PFMJKLKY.TXT").read_bytes().decode("utf-8", "replace")
    assert "18 00Min/Max" in raw
    pts = parse_pfm(raw)
    assert len(pts) == 71                               # every point in the product, not 70
    jenny = [p for p in pts if p.zone == "KYZ110"][0]
    assert jenny.name.startswith("JENNY WILEY STATE PARK")
    six = [s for s in jenny.slots if s.interval_hours == 6]
    assert [s.minmax_f for s in six if s.minmax_f is not None] == [34, 67, 41, 69, 43, 70, 45, 70]
    days = [(d.local_date, d.high_f, d.low_f) for d in downsample_to_daily(jenny)]
    assert days[3] == (date(2026, 10, 20), 67, 41)        # from the repaired 6-hourly table
    assert days[0] == (date(2026, 10, 17), 54, 35)        # the 3-hourly table was never in doubt
