"""Expanding a UGC line into zones (parser.weather._expand_zone_ranges).

NWS names the state and kind once and then runs on in bare numbers and
ranges. "TXZ171>173-183>194-202>209-217>225-228-170100-" used to yield only
TXZ171-173, because every token was required to carry its own "TXZ": Travis
County (TXZ192, inside "183>194") was missing from every compact wind
advisory. The lines below are from live products of 2026-10-17.
"""

from meshcore_weather.parser.weather import _expand_zone_ranges


def _zones(prefix: str, *numbers: int) -> set[str]:
    return {f"{prefix}{n:03d}" for n in numbers}


def test_bare_ranges_take_the_prefix_of_the_token_before_them():
    text = ("WWUS74 KEWX 161700\nNPWEWX\n\nURGENT - WEATHER MESSAGE\n\n"
            "TXZ171>173-183>194-202>209-217>225-228-170100-\n"
            "/O.NEW.KEWX.WI.Y.0012.261016T1700Z-261017T0000Z/\n"
            "Burnet-Williamson-Travis-\n...WIND ADVISORY IN EFFECT UNTIL 7 PM CDT THIS EVENING...\n")
    zones = _expand_zone_ranges(text)
    assert zones == (_zones("TXZ", *range(171, 174)) | _zones("TXZ", *range(183, 195))
                     | _zones("TXZ", *range(202, 210)) | _zones("TXZ", *range(217, 226)) | {"TXZ228"})
    assert "TXZ192" in zones


def test_the_expiry_is_a_time_not_two_zones():
    zones = _expand_zone_ranges("TXZ228-170100-\n")
    assert zones == {"TXZ228"}                       # not TXZ170 and TXZ100


def test_a_second_state_on_the_line_switches_the_prefix():
    line = ("LAZ027>033-044-045-055-073-074-141>143-152>154-241>243-252>254-"
            "TXZ180-201-259>262-515-516-615-616-172200-\n")
    zones = _expand_zone_ranges(line)
    assert _zones("LAZ", *range(27, 34), 44, 45, 55, 73, 74, 141, 142, 143, 152, 153, 154,
                  241, 242, 243, 252, 253, 254) <= zones
    assert _zones("TXZ", 180, 201, 259, 260, 261, 262, 515, 516, 615, 616) <= zones
    assert "LAZ180" not in zones and "TXZ027" not in zones


def test_counties_are_expanded_too():
    assert _expand_zone_ranges("TXC453-491-209-170100-\n") == {"TXC453", "TXC491", "TXC209"}


def test_a_line_that_is_not_ugc_names_nothing():
    text = ("WWUS74 KHGX 170100\n1245 PM CDT Fri Oct 16 2026\n"
            "LAT...LON 3012 9745 3015 9750 3020 9740\n"
            "TIME...MOT...LOC 2345Z 270DEG 25KT 3012 9745\n")
    assert _expand_zone_ranges(text) == set()


def test_the_prefix_does_not_leak_past_the_ugc_line():
    # Once the UGC line has ended, a bare number elsewhere is not a zone.
    text = "TXZ192-170100-\n123-456-\n"
    assert _expand_zone_ranges(text) == {"TXZ192"}
