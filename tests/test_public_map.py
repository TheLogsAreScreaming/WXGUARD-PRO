"""The public dashboard's warnings map (portal/public_map.py, /api/public/warnings):
each active event as an outline, ordered the way the NWS map stacks them, and
flagged when it is in the area this bot answers for."""

from datetime import datetime, timedelta, timezone

import pytest
from shapely.geometry import MultiPolygon, box

from meshcore_weather.portal import public_map
from meshcore_weather.protocol.coverage import Coverage
from tests.test_public_feed import client  # noqa: F401  (the portal fixture)

NOW = datetime(2026, 10, 18, 20, 0, tzinfo=timezone.utc)

# Two zones side by side, simplified apart so their shared edge no longer meets
# exactly (a 0.002 degree crack), and a marine zone.
SHAPES = {
    "TXZ191": box(-98.0, 30.0, -97.5, 30.5),
    "TXZ192": box(-97.498, 30.0, -97.0, 30.5),
    "LMZ740": box(-87.5, 42.0, -87.0, 42.5),
}
NAMES = {"TXZ191": "Travis", "TXZ192": "Bastrop"}


@pytest.fixture(autouse=True)
def _fresh_outlines():
    public_map._outlines.clear()
    yield
    public_map._outlines.clear()


def _event(phen, sig, ugcs, vertices=(), **kw):
    return {"vtec_phenomenon": phen, "vtec_significance": sig, "vtec_office": "KEWX", "vtec_etn": 12,
            "ugcs": list(ugcs), "zones": [u for u in ugcs if u[2] == "Z"], "vertices": list(vertices),
            "headline": "HEADLINE", "issued_at": NOW - timedelta(minutes=20), "expires_at": NOW + timedelta(hours=1),
            "product_type": "TOR", "filename": "A_WFUS54KEWX182000_C_KWIN_20261018200000_1-1-TOREWXTX.TXT",
            "source": "sdr", **kw}


def test_a_storm_based_warning_is_its_own_polygon_not_its_counties():
    tor = _event("TO", "W", ["TXC453"], vertices=[(30.2, -97.8), (30.4, -97.8), (30.4, -97.6), (30.2, -97.6)])
    e = public_map.describe(tor, SHAPES, NAMES, in_area=True)
    assert e["name"] == "Tornado Warning" and e["color"] == "#FF0000" and e["office"] == "EWX"
    assert e["storm_based"] and e["missing"] == 0 and len(e["rings"]) == 1
    assert e["rings"][0][0] == [-97.8, 30.2]                    # lon, lat on the wire
    assert e["bbox"] == [-97.8, 30.2, -97.6, 30.4] and e["expires"] == int((NOW + timedelta(hours=1)).timestamp())


def test_a_zone_advisory_is_its_zones_merged_into_one_outline():
    wind = _event("WI", "Y", ["TXZ191", "TXZ192", "TXZ999"])
    e = public_map.describe(wind, SHAPES, NAMES, in_area=False)
    assert e["name"] == "Wind Advisory" and len(e["rings"]) == 1   # the crack is closed
    assert e["missing"] == 1 and e["where"] == "Travis, Bastrop and 1 more (TX)"
    assert e["bbox"] == [-98.0, 30.0, -97.0, 30.5]


def test_marine_zones_are_named_by_their_water():
    gale = _event("GL", "W", ["LMZ740"])
    assert public_map.describe(gale, SHAPES, NAMES, in_area=False)["where"] == "1 marine zone · Lake Michigan"


def test_slivers_are_left_out_but_a_tiny_area_keeps_its_one_part():
    coast = MultiPolygon([box(-76, 35, -75.5, 35.5), box(-75.2, 35.1, -75.195, 35.105)])
    assert len(public_map.rings(coast)) == 1
    assert len(public_map.rings(box(-75.2, 35.1, -75.195, 35.105))) == 1


def test_a_code_the_bots_table_lacks_still_gets_a_name():
    assert public_map.describe(_event("TY", "W", ["LMZ740"]), SHAPES, NAMES, in_area=False)["name"] == "Typhoon Warning"


def test_the_map_lists_warnings_then_watches_then_advisories_and_marks_the_home_area():
    events = [_event("WI", "Y", ["TXZ192"], vtec_etn=3), _event("SV", "A", ["TXZ191"], vtec_etn=5),
              _event("TO", "W", ["TXZ191"], vtec_etn=7),
              {**_event(None, None, ["TXZ192"]), "product_type": "SPS"}]
    cov = Coverage(zones={"TXZ191"}, sources={"cities": ["Austin TX"], "states": [], "wfos": [],
                                              "center": (30.27, -97.74), "radius_km": 120, "home_name": "Austin, TX"})
    data = public_map.build(events, cov, SHAPES, NAMES, now=NOW.timestamp())
    assert [w["name"] for w in data["warnings"]] == ["Tornado Warning", "Severe Thunderstorm Watch", "Wind Advisory",
                                                     "Special Weather Statement"]
    assert [w["in_area"] for w in data["warnings"]] == [True, True, False, False]
    assert data["warnings"][3]["color"] == "#FFE4B5"
    area = data["area"]
    assert area["name"] == "Austin, TX" and area["center"] == [-97.74, 30.27] and len(area["rings"]) == 1


def test_an_event_that_ended_lets_go_of_its_outline():
    public_map.build([_event("WI", "Y", ["TXZ191"])], None, SHAPES, NAMES)
    assert len(public_map._outlines) == 1
    public_map.build([_event("WI", "Y", ["TXZ192"])], None, SHAPES, NAMES)
    assert list(public_map._outlines) == [(("TXZ192",), ())]


def test_the_public_endpoint_serves_the_map(client, monkeypatch):  # noqa: F811
    tc, _bot = client
    from meshcore_weather.protocol import warnings as warnings_mod
    monkeypatch.setattr(warnings_mod, "extract_active_warnings", lambda store, coverage=None, now=None:
                        [_event("FF", "W", ["TXC453"], vertices=[(30.2, -97.8), (30.4, -97.8), (30.3, -97.6)])])
    monkeypatch.setattr(public_map, "load_shapes", lambda paths=None: SHAPES)
    monkeypatch.setattr(public_map, "_cache", {"t": 0.0, "data": None})
    r = tc.get("/api/public/warnings")
    assert r.status_code == 200
    d = r.json()
    assert d["count"] == 1 and d["warnings"][0]["name"] == "Flash Flood Warning"
    assert d["warnings"][0]["rings"] and "raw_text" not in d["warnings"][0]
