"""Regression tests for pyIEM-backed warning extraction."""

from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip("pyiem")

from meshcore_weather.parser.weather import WeatherStore  # noqa: E402
from meshcore_weather.protocol.warnings import extract_active_warnings  # noqa: E402


def _npw_two_events(now: datetime) -> str:
    """An NPW modeled on KEWX 2026-09-13 17:19Z: ONE segment carrying TWO
    VTEC events (a CON for today and a NEW for tomorrow)."""
    d = now.strftime("%d%H%M")
    con_end = (now + timedelta(hours=6)).strftime("%y%m%dT%H00Z")
    new_start = (now + timedelta(hours=24)).strftime("%y%m%dT%H00Z")
    new_end = (now + timedelta(hours=31)).strftime("%y%m%dT%H00Z")
    exp = (now + timedelta(hours=8)).strftime("%d%H%M")
    return (
        f"WWUS74 KEWX {d}\r\r\nNPWEWX\r\r\n\r\r\n"
        "URGENT - WEATHER MESSAGE\r\r\n"
        "National Weather Service Austin/San Antonio TX\r\r\n"
        f"{now.strftime('%I%M %p')} CDT {now.strftime('%a %b %d %Y')}\r\r\n\r\r\n"
        f"TXZ173-191>194-205>209-220>225-{exp}-\r\r\n"
        f"/O.NEW.KEWX.HT.Y.0011.{new_start}-{new_end}/\r\r\n"
        f"/O.CON.KEWX.HT.Y.0010.000000T0000Z-{con_end}/\r\r\n"
        "Williamson-Hays-Travis-Bastrop-Lee-Bexar-Comal-Guadalupe-Caldwell-\r\r\n"
        "Fayette-Atascosa-Wilson-Karnes-Gonzales-De Witt-Lavaca-\r\r\n"
        f"{now.strftime('%I%M %p')} CDT {now.strftime('%a %b %d %Y')}\r\r\n\r\r\n"
        "...HEAT ADVISORY IN EFFECT FROM NOON TO 7 PM CDT MONDAY...\r\r\n"
        "...HEAT ADVISORY REMAINS IN EFFECT UNTIL 7 PM CDT THIS EVENING...\r\r\n\r\r\n"
        "* WHAT...Heat index values up to 111.\r\r\n\r\r\n"
        "$$\r\r\n"
    )


def test_segment_with_two_vtec_lines_yields_two_warnings():
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    store = WeatherStore()
    fname = f"A_WWUS74KEWX{now:%d%H%M}_C_KWIN_{now:%Y%m%d%H%M%S}_310175-1-NPWEWXTX.TXT"
    store.ingest([{"filename": fname, "raw_text": _npw_two_events(now)}])

    warnings = extract_active_warnings(store, coverage=None)
    ewx = [w for w in warnings if w.get("vtec_office") == "EWX"]

    etns = sorted(w["vtec_etn"] for w in ewx)
    assert etns == [10, 11], f"expected both HT.Y events, got {etns}"
    by_etn = {w["vtec_etn"]: w for w in ewx}
    assert by_etn[10]["vtec_action"] == "CON"
    assert by_etn[11]["vtec_action"] == "NEW"
    assert len(by_etn[10]["zones"]) == 16
    # Each event gets its own headline, in VTEC order.
    assert "MONDAY" in by_etn[11]["headline"].upper()
    assert "MONDAY" not in by_etn[10]["headline"].upper()


def test_segments_of_one_event_are_merged():
    """One heat advisory, two UGC segments in the same product: the event
    must cover the zones of both segments."""
    from datetime import datetime, timedelta, timezone
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.warnings import extract_active_warnings
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    exp = (now + timedelta(hours=6)).strftime("%y%m%dT%H%MZ")     # not "23Z today": that is now, 23:00-23:59Z
    day = now.strftime("%d%H%M")
    text = (
        f"WWUS74 KHGX {day}\r\r\nNPWHGX\r\r\n\r\r\nURGENT - WEATHER MESSAGE\r\r\nNational Weather Service Houston/Galveston TX\r\r\n"
        f"{now.strftime('%I%M %p').lstrip('0')} CDT {now.strftime('%a %b %d %Y')}\r\r\n\r\r\n"
        f"TXZ213-214-215-{now.strftime('%d%H%M')}-\r\r\n/O.CON.KHGX.HT.Y.0011.000000T0000Z-{exp}/\r\r\n"
        "Austin-Waller-Montgomery-\r\r\n...HEAT ADVISORY REMAINS IN EFFECT UNTIL 7 PM CDT THIS EVENING...\r\r\n\r\r\n$$\r\r\n\r\r\n"
        f"TXZ226-227-228-229-{now.strftime('%d%H%M')}-\r\r\n/O.CON.KHGX.HT.Y.0011.000000T0000Z-{exp}/\r\r\n"
        "Harris-Chambers-Galveston-Brazoria-\r\r\n...HEAT ADVISORY REMAINS IN EFFECT UNTIL 7 PM CDT THIS EVENING...\r\r\n\r\r\n$$\r\r\n"
    )
    store = WeatherStore()
    store.ingest([{"filename": f"A_WWUS74KHGX{day}_C_KWIN_{now:%Y%m%d%H%M%S}_000001-1-NPWHGXTX.TXT", "raw_text": text}])
    ws = [w for w in extract_active_warnings(store, coverage=None) if w.get("vtec_etn") == 11]
    assert len(ws) == 1
    assert set(ws[0].get("ugcs") or ws[0].get("zones")) >= {"TXZ213", "TXZ214", "TXZ215", "TXZ226", "TXZ227", "TXZ228", "TXZ229"}


def test_cancelled_event_is_not_resurrected_by_the_older_product():
    """CYS: NEW high wind warning at 11:29Z, CAN at 19:39Z. With both
    products in the store the event must be gone (found 2026-09-14)."""
    from datetime import datetime, timedelta, timezone
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.warnings import extract_active_warnings
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    exp = (now + timedelta(hours=6)).strftime("%y%m%dT%H%MZ")
    t_new, t_can = now - timedelta(hours=3), now - timedelta(minutes=20)

    def prod(t, vtec, seq):
        text = (f"WWUS75 KCYS {t:%d%H%M}\r\r\nNPWCYS\r\r\n\r\r\nURGENT - WEATHER MESSAGE\r\r\nNational Weather Service Cheyenne WY\r\r\n"
                f"{t.strftime('%I%M %p').lstrip('0')} MDT {t.strftime('%a %b %d %Y')}\r\r\n\r\r\nWYZ101-102-{t:%d%H%M}-\r\r\n{vtec}\r\r\n"
                "Laramie Range-\r\r\n...HIGH WIND WARNING...\r\r\n\r\r\n$$\r\r\n")
        return {"filename": f"A_WWUS75KCYS{t:%d%H%M}_C_KWIN_{t:%Y%m%d%H%M%S}_{seq:06d}-1-NPWCYSWY.TXT", "raw_text": text}

    store = WeatherStore()
    store.ingest([prod(t_new, f"/O.NEW.KCYS.HW.W.0038.{t_new:%y%m%dT%H%MZ}-{exp}/", 1),
                  prod(t_can, f"/O.CAN.KCYS.HW.W.0038.000000T0000Z-{exp}/", 2)])
    assert [w for w in extract_active_warnings(store, coverage=None) if w.get("vtec_etn") == 38] == []
    # Without the cancellation the event is active
    store2 = WeatherStore()
    store2.ingest([prod(t_new, f"/O.NEW.KCYS.HW.W.0038.{t_new:%y%m%dT%H%MZ}-{exp}/", 1)])
    assert len([w for w in extract_active_warnings(store2, coverage=None) if w.get("vtec_etn") == 38]) == 1


def test_a_warning_carries_the_products_own_issue_time_not_the_arrival_time():
    """Revision 5: the warning's `issued_at` is the issuance in the product's
    own header, kept from the NEW segment by the lifecycle replay. A phone
    that was out of range for hours must still read "issued 1:29 PM", not the
    moment the bot finally received the file."""
    from datetime import datetime, timedelta, timezone
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol import v5, v5_builders as b
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    t_new, t_con = now - timedelta(hours=3), now - timedelta(minutes=20)
    exp = (now + timedelta(hours=6)).strftime("%y%m%dT%H%MZ")

    def prod(t, vtec, seq, received):
        local = t - timedelta(hours=6)          # MDT, the time the product prints
        text = (f"WWUS75 KCYS {t:%d%H%M}\r\r\nNPWCYS\r\r\n\r\r\nURGENT - WEATHER MESSAGE\r\r\n"
                f"National Weather Service Cheyenne WY\r\r\n"
                f"{local.strftime('%I%M %p').lstrip('0')} MDT {local.strftime('%a %b %d %Y')}\r\r\n\r\r\n"
                f"WYZ101-102-{t:%d%H%M}-\r\r\n{vtec}\r\r\nLaramie Range-\r\r\n"
                "...HIGH WIND WARNING...\r\r\n\r\r\n$$\r\r\n")
        # The filename's time is when the bot received the product, which here
        # is much later than the issuance: the wire must carry the issuance.
        return {"filename": f"A_WWUS75KCYS{t:%d%H%M}_C_KWIN_{received:%Y%m%d%H%M%S}_{seq:06d}-1-NPWCYSWY.TXT",
                "raw_text": text}

    store = WeatherStore()
    store.ingest([prod(t_new, f"/O.NEW.KCYS.HW.W.0039.{t_new:%y%m%dT%H%MZ}-{exp}/", 1, now),
                  prod(t_con, f"/O.CON.KCYS.HW.W.0039.000000T0000Z-{exp}/", 2, now)])
    w = next(w for w in extract_active_warnings(store, coverage=None) if w.get("vtec_etn") == 39)

    assert w["issued_at"] == t_new                     # the NEW, not the CON, not `now`
    assert b.issued_min(w) == int(t_new.timestamp() // 60)
    d = v5.decode(b.warning_message(1, 1, w))
    assert d["issued_min"] == int(t_new.timestamp() // 60)
    assert d["expires_min"] - d["issued_min"] == 9 * 60      # issued 3 h ago, expires in 6 h


def test_a_product_pyiem_rejects_is_logged_and_still_carried_by_the_fallback(monkeypatch, caplog):
    """A product pyIEM fails to parse used to be logged at DEBUG and dropped,
    warning and all. Now it is logged at WARNING with its filename and goes
    through the regex extractor on its own, so the headline, zones and VTEC
    expiry survive beside everything pyIEM did parse."""
    import logging
    from datetime import datetime, timedelta, timezone
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol import warnings as warnings_mod
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    exp = (now + timedelta(hours=6)).strftime("%y%m%dT%H%MZ")
    day = now.strftime("%d%H%M")

    def prod(office, ugc, vtec, names, headline, seq):
        text = (f"WWUS74 K{office} {day}\r\r\nNPW{office}\r\r\n\r\r\nURGENT - WEATHER MESSAGE\r\r\n"
                f"National Weather Service {office}\r\r\n"
                f"{now.strftime('%I%M %p').lstrip('0')} CDT {now.strftime('%a %b %d %Y')}\r\r\n\r\r\n"
                f"{ugc}-{day}-\r\r\n{vtec}\r\r\n{names}\r\r\n{headline}\r\r\n\r\r\n$$\r\r\n")
        return {"filename": f"A_WWUS74K{office}{day}_C_KWIN_{now:%Y%m%d%H%M%S}_{seq:06d}-1-NPW{office}TX.TXT",
                "raw_text": text}

    bad = prod("EWX", "TXZ171>173-183>194-202>209-217>225-228", f"/O.NEW.KEWX.WI.Y.0012.{now:%y%m%dT%H%MZ}-{exp}/",
               "Burnet-Williamson-Travis-", "...WIND ADVISORY IN EFFECT UNTIL 7 PM CDT THIS EVENING...", 1)
    good = prod("HGX", "TXZ213-214-215", f"/O.CON.KHGX.HT.Y.0011.000000T0000Z-{exp}/",
                "Austin-Waller-Montgomery-", "...HEAT ADVISORY REMAINS IN EFFECT UNTIL 7 PM CDT THIS EVENING...", 2)
    store = WeatherStore()
    store.ingest([bad, good])

    real = warnings_mod.pyiem_parser

    def flaky(text, **kw):
        if "WIND ADVISORY" in text:
            raise ValueError("simulated pyIEM failure")
        return real(text, **kw)

    monkeypatch.setattr(warnings_mod, "pyiem_parser", flaky)
    warnings_mod._parsed_cache.clear()
    with caplog.at_level(logging.WARNING, logger="meshcore_weather.protocol.warnings"):
        ws = warnings_mod.extract_active_warnings(store, coverage=None)
    by_phenomenon = {w["vtec_phenomenon"]: w for w in ws}
    assert set(by_phenomenon) == {"WI", "HT"}
    wind = by_phenomenon["WI"]
    assert wind["filename"] == bad["filename"] and wind["vtec_significance"] == "Y"
    assert "TXZ192" in wind["zones"] and "Wind Advisory" in wind["headline"].title()
    assert abs((wind["expires_at"] - (now + timedelta(hours=6))).total_seconds()) < 60
    assert wind["issued_at"] is None                         # the fallback does not guess at it
    assert by_phenomenon["HT"]["vtec_etn"] == 11             # pyIEM's own entry, untouched
    logged = [r for r in caplog.records if r.levelno == logging.WARNING and "pyIEM parse failed" in r.getMessage()]
    assert len(logged) == 1 and bad["filename"] in logged[0].getMessage()
    # The failure is remembered, so the next extraction does not log it again.
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="meshcore_weather.protocol.warnings"):
        again = warnings_mod.extract_active_warnings(store, coverage=None)
    assert {w["vtec_phenomenon"] for w in again} == {"WI", "HT"}
    assert not [r for r in caplog.records if "pyIEM parse failed" in r.getMessage()]
    warnings_mod._parsed_cache.clear()
