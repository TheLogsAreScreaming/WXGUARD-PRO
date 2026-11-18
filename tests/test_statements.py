"""Statements and products the warning extractor did not read, and warnings
in force until further notice.

Flash Flood Statements (FFS) carry the CON / CAN / EXP updates to a Flash
Flood Warning. They were not among the product types the extractor read, so
an FFS that cancelled a warning, or cut it to part of its area, never
reached the lifecycle replay and the warning stayed active to its original
end (Lubbock and Midland, 2026-10-14). The Tropical Cyclone VTEC product
(TCV), which since 2015 carries the Atlantic and Gulf hurricane, tropical
storm and storm surge watches and warnings, tsunami messages (TSU) and Air
Quality Alerts (AQA) were not read either.

A VTEC end of 000000T0000Z means until further notice. It was read as the
segment's UGC expiry: the Satilla River flood warning said "til 9:30AM" and
was dropped at that time with no statement ending it, and so was Guam's
typhoon warning.

Real products from the dish are in fixtures/products. The products below
that are built in the dish's format are marked: no FFS cancel, TCV or
tsunami message was received while the dish was recording.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

pytest.importorskip("pyiem")

from meshcore_weather.core import render_text, services
from meshcore_weather.emwin import retention
from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol import warnings as warnings_mod
from meshcore_weather.protocol.vtec_events import UFN_GRACE
from meshcore_weather.protocol.warnings import extract_active_warnings
from tests.test_core import fresh

PRODUCTS = Path(__file__).parent / "fixtures" / "products"


@pytest.fixture(autouse=True)
def _fresh_parse_cache():
    """Parses are cached by filename; the built products reuse names."""
    warnings_mod._parsed_cache.clear()
    yield
    warnings_mod._parsed_cache.clear()


def _real(*name_fragments: str) -> list[dict]:
    recs = [{"filename": fresh(f.name), "raw_text": f.read_bytes().decode("utf-8", "replace")}
            for f in sorted(PRODUCTS.iterdir()) if any(frag in f.name for frag in name_fragments)]
    assert recs, name_fragments
    return recs


def _store(*recs: dict) -> WeatherStore:
    store = WeatherStore()
    store.ingest(list(recs))
    return store


def _built(wmo: str, issued: datetime, awips: str, lines: list[str], seq: int) -> dict:
    """A product in the dish's format (CR CR LF), received now."""
    return {"filename": f"A_{wmo}{issued:%d%H%M}_C_KWIN_{datetime.now(UTC):%Y%m%d%H%M%S}_{seq:06d}-1-{awips}.TXT",
            "raw_text": "\r\r\n".join([f"{wmo[:6]} {wmo[6:]} {issued:%d%H%M}", *lines]) + "\r\r\n"}


def _ident(w: dict) -> str:
    return f"{w['vtec_phenomenon']}.{w['vtec_significance']}.{w['vtec_office']}.{w['vtec_etn']}"


def _by_ident(store: WeatherStore, now: datetime) -> dict[str, dict]:
    ws = extract_active_warnings(store, coverage=None, now=now)
    idents = [_ident(w) for w in ws]
    assert len(idents) == len(set(idents)), idents          # never the same event twice
    return dict(zip(idents, ws))


def _warn_at(store: WeatherStore, now: datetime, lat: float, lon: float) -> str:
    loc = resolver.resolve_by_coords(lat, lon)
    ws = extract_active_warnings(store, coverage=None, now=now)
    return render_text.warnings(loc, services.warnings_for(store, loc, all_active=ws))


# -- Flash Flood Statements -------------------------------------------------------

# FF.W.0071, Lubbock, 2026-10-14: issued 22:09Z until 00:15Z for Crosby,
# Dickens, Garza and Kent counties; the FFS at 22:24Z continues it. A point
# inside its polygon (southeastern Crosby):
LUB_71_POINT = (33.45, -101.15)
LUB_71 = ["TXC107", "TXC125", "TXC169", "TXC263"]


def _lub_ffs(issued: datetime, segments: list[str], seq: int) -> dict:
    """Lubbock Flash Flood Statement, in the format of the real one of 22:24Z."""
    local = issued - timedelta(hours=5)
    stamp = f"{local:%I%M %p} CDT {local:%a %b %d %Y}".lstrip("0")
    lines = ["FFSLUB", "", "Flash Flood Statement", "National Weather Service Lubbock TX", stamp, ""]
    for seg in segments:
        lines += [*seg.replace("{stamp}", stamp).split("\n"), "", "$$", ""]
    return _built("WGUS74KLUB", issued, "FFSLUBTX", lines, seq)


_CAN_ALL = """TXC107-125-169-263-150015-
/O.CAN.KLUB.FF.W.0071.000000T0000Z-261015T0015Z/
/00000.0.ER.000000T0000Z.000000T0000Z.000000T0000Z.OO/
Crosby TX-Dickens TX-Garza TX-Kent TX-
{stamp}

...THE FLASH FLOOD WARNING FOR SOUTHEASTERN CROSBY, SOUTHWESTERN DICKENS,
NORTHEASTERN GARZA AND NORTHWESTERN KENT COUNTIES IS CANCELLED...

The heavy rain has ended. Flooding is no longer expected to pose a threat.

LAT...LON 3328 10132 3359 10132 3360 10101 3326 10101"""

_CAN_WEST_CON_EAST = """TXC107-263-150015-
/O.CAN.KLUB.FF.W.0071.000000T0000Z-261015T0015Z/
/00000.0.ER.000000T0000Z.000000T0000Z.000000T0000Z.OO/
Crosby TX-Kent TX-
{stamp}

...THE FLASH FLOOD WARNING IS CANCELLED FOR SOUTHEASTERN CROSBY AND
NORTHWESTERN KENT COUNTIES...

The heavy rain has moved out of these areas.

LAT...LON 3328 10132 3359 10132 3360 10101 3326 10101

$$

TXC125-169-150015-
/O.CON.KLUB.FF.W.0071.000000T0000Z-261015T0015Z/
/00000.0.ER.000000T0000Z.000000T0000Z.000000T0000Z.OO/
Dickens TX-Garza TX-
{stamp}

...FLASH FLOOD WARNING REMAINS IN EFFECT UNTIL 715 PM CDT THIS
EVENING FOR SOUTHWESTERN DICKENS AND NORTHEASTERN GARZA COUNTIES...

At 545 PM CDT, Doppler radar indicated thunderstorms producing heavy
rain across the warned area. Flash flooding is ongoing or expected to
begin shortly.

LAT...LON 3328 10115 3359 10115 3360 10101 3326 10101

FLASH FLOOD...RADAR INDICATED"""


def test_a_flash_flood_statement_continues_the_same_event():
    """The real FFS of 22:24Z (CON) reaches FF.W.LUB.71, the warning the FFW
    of 22:09Z issued: one event, its four counties, the statement's
    headline, and FF.W.LUB.72 beside it, each once."""
    store = _store(*_real("FFWLUBTX", "FFSLUBTX"))
    ev = _by_ident(store, datetime(2026, 10, 14, 22, 40, tzinfo=UTC))
    assert set(ev) == {"FF.W.LUB.71"}           # 0072's FFW is not among the fixtures
    w = ev["FF.W.LUB.71"]
    assert w["product_type"] == "FFS" and w["ugcs"] == LUB_71
    assert w["expires_at"] == datetime(2026, 10, 15, 0, 15, tzinfo=UTC)
    assert w["issued_at"] == datetime(2026, 10, 14, 22, 9, tzinfo=UTC)    # the FFW's, not restamped
    assert "REMAINS IN EFFECT" not in w["headline"] and "CROSBY" in w["headline"]
    assert "Flash Flood Wrn til" in _warn_at(store, datetime(2026, 10, 14, 22, 40, tzinfo=UTC), *LUB_71_POINT)


def test_a_flash_flood_statement_that_cancels_ends_the_warning():
    """Before: an FFS was never read, so a cancelled warning stayed active
    until 00:15Z, its original end."""
    can = _lub_ffs(datetime(2026, 10, 14, 22, 45, tzinfo=UTC), [_CAN_ALL], seq=1)
    store = _store(*_real("FFWLUBTX", "FFSLUBTX"), can)
    at = datetime(2026, 10, 14, 22, 50, tzinfo=UTC)
    assert "FF.W.LUB.71" not in _by_ident(store, at)
    assert _warn_at(store, at, *LUB_71_POINT).startswith("No active warnings")
    # Before the cancel it was active.
    assert "FF.W.LUB.71" in _by_ident(store, datetime(2026, 10, 14, 22, 30, tzinfo=UTC))


def test_a_flash_flood_statement_that_cancels_part_of_the_area_keeps_the_rest():
    ffs = _lub_ffs(datetime(2026, 10, 14, 22, 45, tzinfo=UTC), [_CAN_WEST_CON_EAST], seq=2)
    store = _store(*_real("FFWLUBTX", "FFSLUBTX"), ffs)
    at = datetime(2026, 10, 14, 22, 50, tzinfo=UTC)
    w = _by_ident(store, at)["FF.W.LUB.71"]
    assert w["ugcs"] == ["TXC125", "TXC169"]
    assert min(lon for _, lon in w["vertices"]) == pytest.approx(-101.15)     # the statement's own polygon
    assert _warn_at(store, at, 33.45, -101.28).startswith("No active warnings")   # cancelled side
    assert "Flash Flood Wrn til" in _warn_at(store, at, 33.45, -101.05)           # continued side


def test_a_statement_whose_warning_was_missed_is_still_the_warning():
    """Midland's FFS of 20:33Z (CON for FF.W.0233) without the FFW: the bot
    carried nothing for Grandfalls; now the warning, to 22:15Z."""
    store = _store(*_real("FFSMAFTX"))
    at = datetime(2026, 10, 14, 21, 0, tzinfo=UTC)
    w = _by_ident(store, at)["FF.W.MAF.233"]
    assert w["ugcs"] == ["TXC371", "TXC475"] and w["expires_at"] == datetime(2026, 10, 14, 22, 15, tzinfo=UTC)
    assert w["flood_damage"] == 1                                    # FLASH FLOOD DAMAGE THREAT...CONSIDERABLE
    loc = resolver.resolve("Grandfalls TX")
    assert "Flash Flood Wrn til" in render_text.warnings(
        loc, services.warnings_for(store, loc, all_active=extract_active_warnings(store, now=at)))
    assert not _by_ident(store, datetime(2026, 10, 14, 22, 16, tzinfo=UTC))


def test_guam_flash_flood_warning_through_its_statement_and_extension():
    """FF.W.GUM.36: FFW NEW 09:28Z to 17:30Z, FFS CON 11:23Z, FFW EXT 17:23Z
    to 19:30Z. One event throughout."""
    store = _store(*_real("FFWGUMGU", "FFSGUMGU"))
    w = _by_ident(store, datetime(2026, 10, 17, 12, 0, tzinfo=UTC))["FF.W.GUM.36"]
    assert w["product_type"] == "FFS" and w["ugcs"] == ["GUC010"]
    assert w["expires_at"] == datetime(2026, 10, 17, 17, 30, tzinfo=UTC)
    w = _by_ident(store, datetime(2026, 10, 17, 18, 0, tzinfo=UTC))["FF.W.GUM.36"]
    assert w["expires_at"] == datetime(2026, 10, 17, 19, 30, tzinfo=UTC)


# -- Air Quality Alerts ---------------------------------------------------------------


def test_air_quality_alerts_reach_warn_with_their_ugc_expiry():
    store = _store(*_real("AQASGXCA", "AQAPSRAZ"))
    at = datetime(2026, 10, 17, 2, 0, tzinfo=UTC)
    ws = [w for w in extract_active_warnings(store, coverage=None, now=at) if w["product_type"] == "AQA"]
    by_office = {w["vtec_office"]: w for w in ws}
    assert set(by_office) == {"SGX", "PSR"}
    sgx = by_office["SGX"]
    assert sgx["ugcs"] == ["CAZ552", "CAZ554"] and sgx["expires_at"] == datetime(2026, 10, 18, 1, 0, tzinfo=UTC)
    assert sgx["vtec_phenomenon"] is None and sgx["event_name"] == "AIR QUALITY ALERT"
    assert "WILDFIRE SMOKE" in sgx["headline"]
    assert by_office["PSR"]["ugcs"] == ["AZC021"]                          # Pinal County: a county code
    irvine, casa_grande = resolver.resolve("Irvine CA"), resolver.resolve("Casa Grande AZ")
    assert render_text.warnings(irvine, services.warnings_for(store, irvine, all_active=ws)).startswith(
        "Irvine, CA: Air Quality Alert til")
    assert "Air Quality Alert til" in render_text.warnings(
        casa_grande, services.warnings_for(store, casa_grande, all_active=ws))
    # Pinal's ended at its UGC expiry, 03:00Z.
    later = extract_active_warnings(store, coverage=None, now=datetime(2026, 10, 17, 3, 1, tzinfo=UTC))
    assert {w["vtec_office"] for w in later if w["product_type"] == "AQA"} == {"SGX"}


def _sgx_aqa(issued: datetime, ugc: str, names: str, headline: str, seq: int) -> dict:
    local = issued - timedelta(hours=7)
    stamp = f"{local:%I%M %p} PDT {local:%a %b %d %Y}".lstrip("0")
    return _built("AEUS76KSGX", issued, "AQASGXCA", [
        "AQASGX", "", "Air Quality Alert Message", "Relayed by National Weather Service San Diego, CA",
        stamp, "", ugc, names, stamp, "", headline, "", "* WHAT...The South Coast AQMD has issued an air",
        "quality alert.", "", "$$", ""], seq)


def test_a_reissued_air_quality_alert_replaces_the_older_one_for_its_area():
    newer = _sgx_aqa(datetime(2026, 10, 17, 20, 0, tzinfo=UTC), "CAZ552-190100-",
                     "Orange County Coastal Areas-",
                     "...AIR QUALITY ALERT EXTENDED THROUGH SUNDAY...", seq=3)
    store = _store(*_real("AQASGXCA"), newer)
    at = datetime(2026, 10, 17, 21, 0, tzinfo=UTC)
    ws = [w for w in extract_active_warnings(store, coverage=None, now=at) if w["product_type"] == "AQA"]
    assert sorted((w["ugcs"], w["expires_at"].day) for w in ws) == [(["CAZ552"], 19), (["CAZ554"], 18)]
    coastal = resolver.resolve("Huntington Beach CA")
    assert coastal["zones"][0] == "CAZ552"
    assert len(services.warnings_for(store, coastal, all_active=ws)) == 1
    ended = _sgx_aqa(datetime(2026, 10, 17, 22, 0, tzinfo=UTC), "CAZ552-554-180100-",
                     "Orange County Coastal Areas-Orange County Inland Areas-",
                     "...AIR QUALITY ALERT HAS EXPIRED...", seq=4)
    store = _store(*_real("AQASGXCA"), newer, ended)
    assert not [w for w in extract_active_warnings(store, coverage=None, now=at + timedelta(hours=2))
                if w["product_type"] == "AQA"]


# -- Until further notice ---------------------------------------------------------------

# The Satilla River at Atkinson, Brantley County GA: FL.W.JAX.5, until
# further notice. Statements at 14:49Z (16th), 01:20Z and 13:20Z (17th); the
# last one's UGC expiry is 13:30Z on the 18th. A point inside its polygon:
SATILLA = (31.21, -81.87)


def test_a_river_flood_warning_until_further_notice_says_so():
    store = _store(*_real("FLSJAXFL"))
    at = datetime(2026, 10, 17, 14, 0, tzinfo=UTC)
    w = _by_ident(store, at)["FL.W.JAX.5"]
    assert w["until_further_notice"] and w["expires_estimated"]
    reply = _warn_at(store, at, *SATILLA)
    assert reply.endswith("River Flood Wrn until further notice")      # was "til Sun 9:30AM"
    assert " til " not in reply
    loc = resolver.resolve_by_coords(*SATILLA)
    assert "!River Flood Wrn until further notice" in render_text.summary(
        loc, None, services.warnings_for(store, loc, all_active=extract_active_warnings(store, now=at)), None)


def test_until_further_notice_outlives_the_ugc_expiry_by_a_day_at_most():
    store = _store(*_real("FLSJAXFL"))
    ugc_expiry = datetime(2026, 10, 18, 13, 30, tzinfo=UTC)
    # Before: gone at the UGC expiry with no statement having ended it.
    assert "FL.W.JAX.5" in _by_ident(store, ugc_expiry + timedelta(hours=6))
    assert "FL.W.JAX.5" in _by_ident(store, ugc_expiry + UFN_GRACE - timedelta(minutes=1))
    assert "FL.W.JAX.5" not in _by_ident(store, ugc_expiry + UFN_GRACE + timedelta(minutes=1))


def test_a_cancel_ends_a_warning_until_further_notice():
    issued = datetime(2026, 10, 17, 19, 0, tzinfo=UTC)
    can = _built("WGUS82KJAX", issued, "FLSJAXFL", [
        "FLSJAX", "", "Flood Statement", "National Weather Service Jacksonville FL",
        "300 PM EDT Sat Oct 17 2026", "", "GAC025-180700-",
        "/O.CAN.KJAX.FL.W.0005.000000T0000Z-000000T0000Z/",
        "/ATKG1.1.ER.261009T2230Z.261017T1800Z.261017T1800Z.NO/", "300 PM EDT Sat Oct 17 2026", "",
        "...THE FLOOD WARNING IS CANCELLED FOR THE SATILLA RIVER AT ATKINSON...", "",
        "LAT...LON 3129 8184 3114 8183 3114 8190 3128 8191", "", "$$", ""], seq=5)
    store = _store(*_real("FLSJAXFL"), can)
    assert "FL.W.JAX.5" not in _by_ident(store, datetime(2026, 10, 17, 19, 30, tzinfo=UTC))


def test_until_further_notice_on_the_wire_is_a_fixed_invented_expiry():
    """The wire needs a time. It gets the one the bot keeps the event to (the
    UGC expiry plus a day), flagged invented, so it does not move with the
    clock: "now + 12 h" changed every 30 minutes and re-sent the warning."""
    store = _store(*_real("FLSJAXFL"))
    at = datetime(2026, 10, 17, 14, 0, tzinfo=UTC)
    w = _by_ident(store, at)["FL.W.JAX.5"]
    assert w["expires_at"] == datetime(2026, 10, 18, 13, 30, tzinfo=UTC) + UFN_GRACE
    later = _by_ident(store, at + timedelta(hours=3))["FL.W.JAX.5"]
    assert b.warning_fingerprint(later) == b.warning_fingerprint(w)
    w["vtec_office"] = "JAX"
    msg = b.warning_message(1, 0x1D04, w)
    assert msg is not None and v5.decode(msg)["expires_min"] == int(w["expires_at"].timestamp() // 60)


def test_guams_typhoon_warning_is_until_further_notice():
    store = _store(*_real("HLSPQ2GU"))
    at = datetime(2026, 10, 17, 18, 0, tzinfo=UTC)
    ev = _by_ident(store, at)
    assert {"TY.W.GUM.4029", "TR.W.GUM.4029", "TY.A.GUM.4029"} <= set(ev)
    assert all(w["until_further_notice"] for w in ev.values())
    hagatna = resolver.resolve("Hagatna GU")
    reply = render_text.warnings(hagatna, services.warnings_for(store, hagatna,
                                                                all_active=list(ev.values())))
    assert reply.endswith("until further notice") and " til " not in reply
    # The 17:01Z statement's UGC expiry is 05:15Z on the 18th: kept a day past it.
    assert "TY.W.GUM.4029" in _by_ident(store, datetime(2026, 10, 18, 20, 0, tzinfo=UTC))


# -- Tropical Cyclone VTEC (TCV) --------------------------------------------------------


def _tcv(issued: datetime, advisory: int, action: str, seq: int, office: str = "HGX",
         segments: list[tuple[str, list[str], str]] | None = None) -> dict:
    """A Tropical Cyclone VTEC product in the format NWS has used since 2015
    (built: none was received while the dish was recording). Hurricane Imelda
    is AL09, so its events are ETN 1009."""
    local = issued - timedelta(hours=5)
    stamp = f"{local:%I%M %p} CDT {local:%a %b %d %Y}".lstrip("0")
    segments = segments or [
        ("TXZ438-439-", [f"/O.{action}.KHGX.HU.W.1009.000000T0000Z-000000T0000Z/",
                         f"/O.{action}.KHGX.SS.W.1009.000000T0000Z-000000T0000Z/"],
         "Galveston Island-Bolivar Peninsula-"),
        ("TXZ213-", [f"/O.{action}.KHGX.TR.W.1009.000000T0000Z-000000T0000Z/"], "Inland Harris-"),
    ]
    lines = [f"TCV{office}", "", "URGENT - IMMEDIATE BROADCAST REQUESTED",
             f"Hurricane Imelda Local Watch/Warning Statement/Advisory Number {advisory}",
             "National Weather Service Houston/Galveston TX  AL092026", stamp, ""]
    expires = issued + timedelta(hours=3)
    for ugc, vtecs, names in segments:
        lines += [f"{ugc}{expires:%d%H%M}-", *vtecs, names, stamp, "",
                  "* WIND:", "    - LATEST LOCAL FORECAST: Equivalent Category 2 Hurricane force wind",
                  "        - Peak Wind Forecast: 85-105 mph with gusts to 125 mph", "",
                  "* SURGE:", "    - LATEST LOCAL FORECAST: Life-threatening storm surge possible", "",
                  "$$", ""]
    return _built(f"WTUS84K{office}", issued, f"TCV{office}TX", lines, seq)


def test_tcv_hurricane_and_storm_surge_warnings_reach_warn():
    at = datetime(2026, 10, 17, 21, 30, tzinfo=UTC)
    store = _store(_tcv(datetime(2026, 10, 17, 21, 0, tzinfo=UTC), 15, "NEW", seq=6))
    ev = _by_ident(store, at)
    assert set(ev) == {"HU.W.HGX.1009", "SS.W.HGX.1009", "TR.W.HGX.1009"}
    hu = ev["HU.W.HGX.1009"]
    assert hu["product_type"] == "TCV" and hu["ugcs"] == ["TXZ438", "TXZ439"]
    assert hu["until_further_notice"] and hu["headline"] == "Hurricane Warning until further notice"
    assert hu["event_code"] == b.tables.event_code("HU.W")
    galveston = resolver.resolve("Galveston TX")
    reply = render_text.warnings(galveston, services.warnings_for(store, galveston, all_active=list(ev.values())))
    assert reply == ("2 active, Galveston, TX: Hurricane Wrn until further notice; "
                     "Storm Surge Wrn until further notice")
    houston = resolver.resolve("Houston TX")
    assert render_text.warnings(houston, services.warnings_for(store, houston, all_active=list(ev.values()))) \
        == "Houston, TX: Trop Storm Wrn until further notice"


def test_successive_tcvs_are_one_event_each_and_a_cancel_ends_them():
    first = _tcv(datetime(2026, 10, 17, 21, 0, tzinfo=UTC), 15, "NEW", seq=7)
    second = _tcv(datetime(2026, 10, 18, 0, 0, tzinfo=UTC), 16, "CON", seq=8)
    store = _store(first, second)
    ev = _by_ident(store, datetime(2026, 10, 18, 0, 30, tzinfo=UTC))
    assert set(ev) == {"HU.W.HGX.1009", "SS.W.HGX.1009", "TR.W.HGX.1009"}
    assert ev["HU.W.HGX.1009"]["issued_at"] == datetime(2026, 10, 17, 21, 0, tzinfo=UTC)
    third = _tcv(datetime(2026, 10, 18, 3, 0, tzinfo=UTC), 17, "CAN", seq=9)
    assert not _by_ident(_store(first, second, third), datetime(2026, 10, 18, 3, 30, tzinfo=UTC))


def test_an_hls_and_a_tcv_for_one_event_count_once():
    """Where an office's HLS carries the VTEC too (Guam's do), the TCV's line
    for the same event is the same event."""
    issued = datetime(2026, 10, 17, 17, 5, tzinfo=UTC)
    tcv = _built("WTPQ82PGUM", issued, "TCVPQ2GU", [
        "TCVPQ2", "", "URGENT - IMMEDIATE BROADCAST REQUESTED",
        "Typhoon Champi Local Watch/Warning Statement/Advisory Number 21",
        "National Weather Service Tiyan GU  WP292026", "305 AM ChST Sun Oct 18 2026", "",
        "GUZ001-180515-", "/O.CON.PGUM.TY.W.4029.000000T0000Z-000000T0000Z/", "Guam-",
        "305 AM ChST Sun Oct 18 2026", "", "* WIND:", "    - LATEST LOCAL FORECAST: Typhoon force wind",
        "", "$$", ""], seq=10)
    store = _store(*_real("HLSPQ2GU"), tcv)
    ws = extract_active_warnings(store, coverage=None, now=datetime(2026, 10, 17, 18, 0, tzinfo=UTC))
    assert [_ident(w) for w in ws].count("TY.W.GUM.4029") == 1
    hagatna = resolver.resolve("Hagatna GU")
    assert len([w for w in services.warnings_for(store, hagatna, all_active=ws)
                if w["vtec_phenomenon"] == "TY"]) == 1


# -- Tsunami messages -------------------------------------------------------------------------


def test_a_tsunami_warning_reaches_warn_until_further_notice():
    """Built in the National Tsunami Warning Center's format (none was
    received while the dish was recording)."""
    issued = datetime(2026, 10, 17, 21, 5, tzinfo=UTC)
    tsu = _built("WEPA43PAAQ", issued, "TSUWCACA", [
        "TSUWCA", "", "BULLETIN", "Tsunami Message Number  1",
        "NWS National Tsunami Warning Center Palmer AK", "205 PM PDT Sat Oct 17 2026", "",
        "...THE TSUNAMI WARNING IS NOW IN EFFECT...", "", "CAZ101-180505-",
        "/O.NEW.PAAQ.TS.W.0003.261017T2105Z-000000T0000Z/", "Coastal Del Norte-",
        "205 PM PDT Sat Oct 17 2026", "", "...TSUNAMI WARNING IN EFFECT...", "",
        "* WHAT...Tsunami waves are expected.", "", "$$", ""], seq=11)
    store = _store(tsu)
    ws = extract_active_warnings(store, coverage=None, now=issued + timedelta(minutes=30))
    [w] = [w for w in ws if w["vtec_phenomenon"] == "TS"]
    assert w["product_type"] == "TSU" and w["ugcs"] == ["CAZ101"] and w["until_further_notice"]
    crescent = resolver.resolve("Crescent City CA")
    assert render_text.warnings(crescent, services.warnings_for(store, crescent, all_active=ws)) \
        == "Crescent City, CA: Tsunami Wrn until further notice"


def test_retention_keeps_the_new_product_types_as_warnings():
    for t in ("FFS", "TCV", "TSU", "AQA"):
        assert t in retention.WARNING_TYPES and t in warnings_mod._WARNING_PRODUCT_TYPES
    now = datetime.now(UTC)
    assert not retention.is_expired("TSU", now - timedelta(hours=30), now)
    assert not retention.is_expired("AQA", now - timedelta(hours=30), now)


# -- A watch's headline (`>wt`) --------------------------------------------------------------


def test_a_watch_has_a_headline_built_from_its_vtec():
    """A WCN has no ...HEADLINE..., so `>wt` for a watch said only "Active
    warning"."""
    store = _store(*_real("WCNLUBTX"))
    w = _by_ident(store, datetime(2026, 10, 14, 21, 0, tzinfo=UTC))["SV.A.LUB.685"]
    assert w["headline"] == "Severe Thunderstorm Watch 685 until 11:00 PM CDT"


@pytest.mark.asyncio
async def test_wt_for_a_watch_answers_with_that_headline(monkeypatch):
    from unittest.mock import MagicMock

    from meshcore_weather.protocol.broadcaster import AppResponder

    store = _store(*_real("WCNLUBTX"))
    at = datetime(2026, 10, 14, 21, 0, tzinfo=UTC)
    real = warnings_mod.extract_active_warnings
    monkeypatch.setattr(warnings_mod, "extract_active_warnings",
                        lambda s, coverage=None, now=None: real(s, coverage=coverage, now=at))
    import meshcore_weather.protocol.broadcaster as bc
    monkeypatch.setattr(bc, "extract_active_warnings",
                        lambda s, coverage=None, now=None: real(s, coverage=coverage, now=at), raising=False)
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    r = AppResponder(store, radio, render_text=lambda c, a: None)
    msgs = r._answer("wt", "SV.A.LUB.685", b.SeqCounter(), 0x1D04)
    text = "".join(v5.decode(m)["text"] for m in msgs if m[3] >> 4 == v5.TYPE_TEXT)
    assert text.startswith("Severe Thunderstorm Watch 685 until 11:00 PM CDT")
