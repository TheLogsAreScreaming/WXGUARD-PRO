"""Tornado and severe thunderstorm watches reach every output.

A watch reaches the bot as each office's Watch County Notification (WCN):
county UGCs (TXC453) and no polygon. The extractor kept a segment only when
it had a polygon or a zone (TXZ192), so every watch was dropped before
coverage, the broadcasts, `warn`, the digest, `>w`, the app or its
notifications could see it. On 14 and 16 October 2026 the dish received
severe thunderstorm watches 685, 686 and 687 and the bot carried none of
them.

The products under fixtures/products are those real WCNs and SPC's first
outline update (WOU) for watch 685. The Austin watch is built in the same
format, relative to now, because no watch has been issued for Travis County
while the dish was recording.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

pytest.importorskip("pyiem")

from meshcore_weather.config import settings
from meshcore_weather.core import render_text, services
from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol import warnings as warnings_mod
from meshcore_weather.protocol.coverage import Coverage
from meshcore_weather.protocol.warnings import extract_active_warnings
from meshcore_weather.schedule import executor as ex
from meshcore_weather.schedule.models import BroadcastJob
from tests.test_core import fresh

PRODUCTS = Path(__file__).parent / "fixtures" / "products"
UTC = timezone.utc
CDT = timedelta(hours=-5)

# Watch 685's first hour, 2026-10-14, and watch 686 in LWX on 2026-10-16.
AT_685 = datetime(2026, 10, 14, 21, 0, tzinfo=UTC)
LUB_685 = ["TXC075", "TXC101", "TXC107", "TXC125", "TXC169", "TXC191", "TXC263", "TXC269",
           "TXC305", "TXC345", "TXC433"]

# The Austin watch: nine EWX counties, Travis (453) and Williamson (491) among them.
AUSTIN_COUNTIES = ["TXC021", "TXC053", "TXC055", "TXC149", "TXC209", "TXC287", "TXC299",
                   "TXC453", "TXC491"]


@pytest.fixture(autouse=True)
def _fresh_parse_cache():
    """Parses are cached by filename, and the Austin products are rebuilt
    with each test's times under the same names."""
    warnings_mod._parsed_cache.clear()
    yield
    warnings_mod._parsed_cache.clear()


@pytest.fixture(scope="module")
def austin():
    return Coverage.from_sources(cities=["Austin TX"], radius_km=120)


def _real(*name_fragments: str) -> WeatherStore:
    recs = [{"filename": fresh(f.name), "raw_text": f.read_bytes().decode("utf-8", "replace")}
            for f in sorted(PRODUCTS.iterdir()) if any(frag in f.name for frag in name_fragments)]
    assert recs, name_fragments
    store = WeatherStore()
    store.ingest(recs)
    return store


def _wcn(issued: datetime, segments: list[tuple[list[str], str, str]], seq: int) -> dict:
    """An EWX Watch County Notification in the dish's format (CR CR LF, as
    the real ones in fixtures/products): one segment per (counties, VTEC
    line, text)."""
    local = issued + CDT
    end = issued + timedelta(hours=6)
    parts = [
        f"WWUS64 KEWX {issued:%d%H%M}", "WCNEWX", "",
        "WATCH COUNTY NOTIFICATION FOR WATCH 600",
        "NATIONAL WEATHER SERVICE AUSTIN/SAN ANTONIO TX",
        f"{local:%I%M %p} CDT {local:%a %b %d %Y}".upper().lstrip("0"), "",
    ]
    for counties, vtec, text in segments:
        ugc = counties[0] + "".join(f"-{c[3:]}" for c in counties[1:])
        parts += [f"{ugc}-{end:%d%H%M}-", vtec, "", *text.split("\n"), "", "$$", ""]
    return {"filename": f"A_WWUS64KEWX{issued:%d%H%M}_C_KWIN_{issued:%Y%m%d%H%M%S}_{seq:06d}-1-WCNEWXTX.TXT",
            "raw_text": "\r\r\n".join(parts) + "\r\r\n"}


def _austin_watch(now: datetime, issued_ago: int = 30, hours: int = 6) -> tuple[dict, datetime, datetime]:
    issued = (now - timedelta(minutes=issued_ago)).replace(second=0, microsecond=0)
    end = issued + timedelta(hours=hours)
    vtec = f"/O.NEW.KEWX.TO.A.0600.{issued:%y%m%dT%H%MZ}-{end:%y%m%dT%H%MZ}/"
    text = (
        "THE NATIONAL WEATHER SERVICE HAS ISSUED TORNADO WATCH 600 IN\n"
        f"EFFECT UNTIL {(end + CDT):%I%M %p} CDT FOR THE FOLLOWING AREAS\n\n"
        "IN TEXAS THIS WATCH INCLUDES 9 COUNTIES\n\n"
        "IN SOUTH CENTRAL TEXAS\n\n"
        "BASTROP               BURNET                CALDWELL\n"
        "FAYETTE               HAYS                  LEE\n"
        "LLANO                 TRAVIS                WILLIAMSON\n\n"
        "THIS INCLUDES THE CITIES OF AUSTIN, BASTROP, BUDA, BURNET,\n"
        "GEORGETOWN, GIDDINGS, LA GRANGE, LLANO, LOCKHART, ROUND ROCK,\n"
        "AND SAN MARCOS."
    )
    return _wcn(issued, [(AUSTIN_COUNTIES, vtec, text)], seq=600), issued, end


def _austin_store(now: datetime | None = None) -> WeatherStore:
    store = WeatherStore()
    store.ingest([_austin_watch(now or datetime.now(UTC))[0]])
    return store


def _ident(w: dict) -> str:
    return f"{w['vtec_phenomenon']}.{w['vtec_significance']}.{w['vtec_office']}.{w['vtec_etn']}"


def _decoded_ugcs(d: dict) -> set[str]:
    return {f"{b.tables.states[a['state']]}{'C' if a['county'] else 'Z'}{n:03d}"
            for a in d["areas"] for n in range(a["start"], a["start"] + a["run"])}


# -- Extraction ---------------------------------------------------------------------


def test_a_watch_is_its_counties_with_no_polygon():
    ws = {_ident(w): w for w in extract_active_warnings(_real("WCNLUBTX", "WCNMAFTX", "WCNOUNOK", "WCNSJTTX"),
                                                         coverage=None, now=AT_685)}
    assert set(ws) == {"SV.A.LUB.685", "SV.A.MAF.685", "SV.A.OUN.685", "SV.A.SJT.685"}
    lub = ws["SV.A.LUB.685"]
    assert lub["ugcs"] == LUB_685 and lub["zones"] == [] and lub["vertices"] == []
    assert lub["expires_at"] == datetime(2026, 10, 15, 4, 0, tzinfo=UTC)
    assert lub["issued_at"] == datetime(2026, 10, 14, 20, 22, tzinfo=UTC)
    assert lub["event_code"] == b.tables.event_code("SV.A")
    # Norman's notification names Oklahoma and Texas counties on one UGC line.
    assert {u[:3] for u in ws["SV.A.OUN.685"]["ugcs"]} == {"OKC", "TXC"}
    assert len(ws["SV.A.OUN.685"]["ugcs"]) == 17


def test_spc_outline_update_is_not_a_second_copy_of_the_watch():
    """SPC's WOU carries watch 685 under office WNS with all 52 counties of
    both states; the WCNs name the same counties office by office, and those
    are what api.weather.gov lists (every sender of watches 686 and 687 was
    a WFO). Taken too, every watch would go out twice."""
    store = _real("WOUWNSUS", "WCNLUBTX")
    ws = extract_active_warnings(store, coverage=None, now=AT_685)
    assert [_ident(w) for w in ws] == ["SV.A.LUB.685"]
    assert not extract_active_warnings(_real("WOUWNSUS"), coverage=None, now=AT_685)


def test_the_regex_fallback_keeps_counties_and_does_not_call_them_zones():
    store = _real("WCNLUBTX")
    entry = warnings_mod._fallback_entry(store, next(iter(store._products.values())), AT_685)
    assert entry is not None
    assert entry["ugcs"] == LUB_685 and entry["zones"] == []


def test_the_austin_watch_is_extracted_with_its_counties():
    now = datetime.now(UTC)
    _, issued, end = _austin_watch(now)
    [w] = extract_active_warnings(_austin_store(now=now), coverage=None)
    assert _ident(w) == "TO.A.EWX.600"
    assert w["ugcs"] == AUSTIN_COUNTIES and w["zones"] == [] and w["vertices"] == []
    assert w["expires_at"] == end and w["issued_at"] == issued


# -- Coverage -------------------------------------------------------------------------


def test_austin_coverage_has_the_counties_of_its_circle(austin):
    assert {"TXC453", "TXC491", "TXC209", "TXC021"} <= austin.counties     # Travis, Williamson, Hays, Bastrop
    assert "TXC201" not in austin.counties                                 # Harris (Houston), ~230 km
    assert austin.covers_any(["TXC453"]) and not austin.covers_any(["OKC031"])
    assert "counties" in austin.summary()


def test_office_coverage_has_the_offices_counties():
    ewx = Coverage.from_sources(wfos=["EWX"])
    assert len(ewx.counties) == 33 and {"TXC453", "TXC491", "TXC029"} <= ewx.counties   # Bexar is EWX's
    assert "TXC201" not in ewx.counties                                                  # Harris is HGX's
    assert len(Coverage.from_sources(states=["TX"]).counties) == 254


def test_austin_coverage_keeps_a_travis_watch_and_drops_oklahoma(austin):
    assert [_ident(w) for w in extract_active_warnings(_austin_store(), coverage=austin)] == ["TO.A.EWX.600"]
    store = _real("WCNOUNOK", "WCNLUBTX")
    assert extract_active_warnings(store, coverage=austin, now=AT_685) == []
    lubbock = Coverage.from_sources(cities=["Lubbock TX"], radius_km=120)
    assert [_ident(w) for w in extract_active_warnings(store, coverage=lubbock, now=AT_685)] == ["SV.A.LUB.685"]
    okc = Coverage.from_sources(cities=["Oklahoma City OK"], radius_km=120)
    assert extract_active_warnings(_austin_store(), coverage=okc) == []


def test_a_storm_based_warnings_counties_do_not_widen_coverage(austin):
    """A severe thunderstorm warning's UGC line names the counties its polygon
    touches. One over western Mason County (TXC319, partly inside the 120 km
    circle) is outside the circle and stays out, as before: the polygon
    decides, the county list does not."""
    assert "TXC319" in austin.counties
    w = {"ugcs": ["TXC319"], "zones": [],
         "vertices": [(30.80, -99.45), (30.80, -99.30), (30.65, -99.30), (30.65, -99.45)]}
    assert not warnings_mod._in_coverage(w, austin)
    assert warnings_mod._in_coverage({**w, "vertices": []}, austin)


# -- warn <place> ---------------------------------------------------------------------


def test_warn_austin_lists_the_watch():
    store = _austin_store()
    for place in ("Austin TX", "Round Rock TX"):                  # Travis, Williamson
        loc = resolver.resolve(place)
        ws = services.warnings_for(store, loc)
        assert [_ident(w) for w in ws] == ["TO.A.EWX.600"], place
        text = render_text.warnings(loc, ws)
        assert text.startswith(f"{resolver.resolve(place)['name']}: Tornado Watch til "), text
    assert services.warnings_for(store, resolver.resolve("San Antonio TX")) == []   # Bexar is not in it


def test_warn_matches_a_storm_based_warning_by_its_polygon_not_its_county():
    now = datetime.now(UTC)
    svr = {"ugcs": ["TXC453"], "zones": [], "vertices": [(30.50, -98.10), (30.50, -97.95), (30.40, -97.95)],
           "vtec_phenomenon": "SV", "vtec_significance": "W", "expires_at": now + timedelta(hours=1)}
    austin_loc = resolver.resolve("Austin TX")                  # Travis, but not under the polygon
    assert services.warnings_for(WeatherStore(), austin_loc, all_active=[svr]) == []
    lago = dict(austin_loc, lat=30.45, lon=-98.00)              # under it
    assert services.warnings_for(WeatherStore(), lago, all_active=[svr]) == [svr]


# -- The wire -------------------------------------------------------------------------


def test_the_watch_goes_out_as_a_v5_warning_with_its_counties():
    now = datetime.now(UTC)
    _, issued, end = _austin_watch(now)
    [w] = extract_active_warnings(_austin_store(now=now), coverage=None)
    msg = b.warning_message(9, 0x041D, w)
    assert msg is not None and len(msg) <= v5.MAX_SEND
    d = v5.decode(msg)
    assert d["name"] == "warning" and b.identity_str((d["event"], d["office"], d["etn"])) == "TO.A.EWX.600"
    assert not d.get("polygon")
    assert all(a["county"] for a in d["areas"]) and _decoded_ugcs(d) == set(AUSTIN_COUNTIES)
    assert d["expires_min"] == int(end.timestamp() // 60)
    assert d["issued_min"] == int(issued.timestamp() // 60)
    digest = v5.decode(b.digest_message(1, 1, [w], feed_health=0))
    assert [(e["event"], e["office"], e["etn"]) for e in digest["entries"]] == [(d["event"], d["office"], 600)]


def test_the_warnings_job_broadcasts_the_watch_and_cancels_it(austin):
    """The scheduled path end to end: in coverage it goes out, and a CAN
    for every county before its expiry sends the Cancel."""
    now = datetime.now(UTC)
    store = _austin_store(now=now)
    ctx = ex.ExecutorContext(store=store, coverage=austin, seq=b.SeqCounter(), bot=1)
    job = BroadcastJob(id="warnings", name="w", product="warnings", location_type="coverage", interval_minutes=2)
    [first] = [v5.decode(m) for m in ex._build_warnings(job, ctx)]
    assert first["name"] == "warning" and _decoded_ugcs(first) == set(AUSTIN_COUNTIES)
    assert ex._build_warnings(job, ctx) == []                  # unchanged: nothing more

    _, _issued, end = _austin_watch(now)
    can = _wcn(now - timedelta(minutes=5), [(AUSTIN_COUNTIES, f"/O.CAN.KEWX.TO.A.0600.000000T0000Z-{end:%y%m%dT%H%MZ}/",
                                             "THE NATIONAL WEATHER SERVICE HAS CANCELLED TORNADO WATCH 600")], seq=601)
    store.ingest([can])
    [cancel] = [v5.decode(m) for m in ex._build_warnings(job, ctx)]
    assert cancel["name"] == "cancel" and (cancel["event"], cancel["office"], cancel["etn"]) == \
        (first["event"], first["office"], first["etn"])


def test_the_app_requests_answer_with_the_watch(monkeypatch):
    """`>w TXC453` names the county; a bare `>w` is the bot's coverage."""
    from meshcore_weather.protocol import broadcaster
    monkeypatch.setattr(settings, "home_cities", "Austin TX")
    monkeypatch.setattr(settings, "home_radius_km", 120)

    def ask(text: str) -> list[dict]:
        radio = MagicMock()
        radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
        radio.send_channel_data = AsyncMock(return_value=True)
        asyncio.run(broadcaster.AppResponder(_austin_store(), radio).handle_request(text, "app"))
        return [v5.decode(c.args[0]) for c in radio.send_channel_data.await_args_list]

    county = ask(">w TXC453")
    assert [m["name"] for m in county] == ["warning"] and "TXC453" in _decoded_ugcs(county[0])
    bare = ask(">w")
    assert [m["name"] for m in bare] == ["warning", "digest"] and len(bare[1]["entries"]) == 1
    assert [m["name"] for m in ask(">w TXC029")] == ["not_available"]          # Bexar


# -- Ending ---------------------------------------------------------------------------


def test_a_partial_cancel_leaves_the_rest_and_expiry_ends_it():
    now = datetime.now(UTC)
    new, _issued, end = _austin_watch(now, issued_ago=200, hours=4)          # ends in 40 minutes
    rest = [c for c in AUSTIN_COUNTIES if c != "TXC491"]
    tail = f"000000T0000Z-{end:%y%m%dT%H%MZ}/"
    can = _wcn(now - timedelta(minutes=60), [
        (["TXC491"], f"/O.CAN.KEWX.TO.A.0600.{tail}", "THE NATIONAL WEATHER SERVICE HAS CANCELLED TORNADO WATCH 600"),
        (rest, f"/O.CON.KEWX.TO.A.0600.{tail}", "THE NATIONAL WEATHER SERVICE CONTINUES TORNADO WATCH 600"),
    ], seq=602)
    store = WeatherStore()
    store.ingest([new, can])
    [w] = extract_active_warnings(store, coverage=None)
    assert w["ugcs"] == rest
    assert services.warnings_for(store, resolver.resolve("Round Rock TX")) == []
    assert services.warnings_for(store, resolver.resolve("Austin TX")) != []

    exp = _wcn(now - timedelta(minutes=2), [(rest, f"/O.EXP.KEWX.TO.A.0600.{tail}",
                                             "THE NATIONAL WEATHER SERVICE WILL ALLOW TORNADO WATCH 600 TO EXPIRE")],
               seq=603)
    store.ingest([exp])
    assert extract_active_warnings(store, coverage=None) == []


# -- Counties and zones in one watch ----------------------------------------------------


def test_a_watch_over_counties_and_marine_zones():
    """LWX's notifications for watch 686 put the counties in one segment and
    the Chesapeake Bay and tidal Potomac zones in another, both under one
    event: added to at 18:14Z (EXA), cut back county by county, and
    cancelled for the bay, DC and the counties around it at 22:52Z. The
    22:36Z notification that cancelled the nine western counties never
    reached the dish (api.weather.gov has it), so for the bot they stay
    until the watch's own end at 00Z."""
    store = _real("WCNLWXMD")
    [w] = extract_active_warnings(store, coverage=None, now=datetime(2026, 10, 16, 18, 30, tzinfo=UTC))
    assert _ident(w) == "SV.A.LWX.686"
    marine = [f"ANZ{n}" for n in range(530, 544)]
    assert w["zones"] == marine                                   # 539-541 and 543 came with the EXA
    assert {"DCC001", "MDC001", "VAC510", "WVC065"} <= set(w["ugcs"]) and len(w["ugcs"]) == 49 + 14

    # 49 county runs and one zone run, more than the 30 a Warning carries
    # (spec 3): cut in state order, the marine zones (AN, last) go first...
    d = v5.decode(b.warning_message(1, 1, w))
    assert len(d["areas"]) == 30 and {a["county"] for a in d["areas"]} == {True}
    # ...unless they are what was asked for (`>w ANZ535`): then both kinds go.
    asked = v5.decode(b.warning_message(1, 1, w, keep={"ANZ535"}))
    assert {a["county"] for a in asked["areas"]} == {True, False} and set(marine) <= _decoded_ugcs(asked)

    # A bot at Washington keeps its own counties when the list is cut: DC,
    # Alexandria, Fairfax City and Manassas came after the 30th run.
    dc = Coverage.from_sources(cities=["Washington DC"], radius_km=60)
    assert extract_active_warnings(store, coverage=dc, now=datetime(2026, 10, 16, 18, 30, tzinfo=UTC)) == [w]
    near = set(w["ugcs"]) & (dc.zones | dc.counties)
    assert "DCC001" in near and not near <= _decoded_ugcs(d)
    kept = v5.decode(b.warning_message(1, 1, w, keep=dc.zones | dc.counties))
    assert near <= _decoded_ugcs(kept) and len(kept["areas"]) == 30
    assert kept["areas"] == sorted(kept["areas"], key=lambda a: (a["state"], a["county"], a["start"]))

    [w] = extract_active_warnings(store, coverage=None, now=datetime(2026, 10, 16, 20, 10, tzinfo=UTC))
    assert not {"MDC001", "MDC023", "WVC057"} & set(w["ugcs"]) and "DCC001" in w["ugcs"]
    [w] = extract_active_warnings(store, coverage=None, now=datetime(2026, 10, 16, 23, 0, tzinfo=UTC))
    assert w["ugcs"] == ["MDC013", "MDC021", "VAC047", "VAC061", "VAC079", "VAC107", "VAC113", "VAC137", "VAC157"]
    assert w["zones"] == []                                       # the bay went at 22:52Z
    assert extract_active_warnings(store, coverage=None, now=datetime(2026, 10, 17, 0, 0, tzinfo=UTC)) == []


# -- The audit ------------------------------------------------------------------------


def test_the_audit_endpoint_lists_the_watch_by_office_and_county(tmp_path, monkeypatch):
    """scripts/audit.py compares this with api.weather.gov, which lists a
    watch as each office's event over its counties: with watches dropped it
    would have said MISSING from bot for every one."""
    from fastapi.testclient import TestClient

    from meshcore_weather.main import WeatherBot
    from meshcore_weather.portal.server import create_app
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "admin_key", "")
    monkeypatch.setattr(settings, "tx_enabled", False)
    bot = WeatherBot()
    bot.store = _austin_store()
    c = TestClient(create_app(bot), headers={"X-Requested-With": "meshcore-portal"})
    [ev] = c.get("/api/audit/warnings", params={"state": "TX"}).json()["events"]
    assert (ev["office"], ev["phenomenon"], ev["significance"], ev["etn"]) == ("EWX", "TO", "A", 600)
    assert ev["ugcs"] == AUSTIN_COUNTIES
    assert c.get("/api/audit/warnings", params={"state": "OK"}).json()["events"] == []
