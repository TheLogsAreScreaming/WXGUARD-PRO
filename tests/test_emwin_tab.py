"""The dashboard's product browser index and warnings base map (deploy/goes-dashboard/emwin_tab.py).

It runs beside goesproc on the Pi; here the day directories and Natural Earth files are faked.
"""

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy" / "goes-dashboard"))
import emwin_tab as et  # noqa: E402

AFD = "A_FXUS64KEWX181724_C_KWIN_20261018172411_720145-2-AFDEWXTX.TXT"
SAH = "A_SAUS70KWBC181300_C_KWIN_20261018130000_700001-2-SAHOURLY.TXT"
GIF = "Z_QYPN98KWNM180300_C_KWIN_20261018150041_715063-4-NPSA01US.GIF"
OFFICES = {"EWX": "Austin/San Antonio", "WBC": "NCEP / Weather Prediction Center"}


def _file(d: Path, name: str, text: str, arrived: float) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(text.encode())
    os.utime(d / name, (arrived, arrived))


def _index(tmp_path, now):
    sdr, inet = tmp_path / "emwin", tmp_path / "inet"
    _file(sdr / "2026-10-18", AFD, "FXUS64 KEWX 181724\r\r\nAFDEWX\r\r\n\r\r\nA burn\r\r\nban is in effect for Travis County.\r\r\n", now - 600)
    _file(sdr / "2026-10-18", SAH, "SAUS70 KWBC 181300\r\r\nKATT 181251Z 18008KT 10SM CLR 24/12 A3002=\r\r\n", now - 300)
    _file(sdr / "2026-10-18", GIF, "GIF89a", now - 200)
    _file(sdr / "2026-10-14", "A_FXUS64KEWX140000_C_KWIN_20261014000000_1-2-AFDEWXTX.TXT", "old", now - 4 * 86400)
    _file(inet / "2026-10-18", SAH, "the same product from the internet backup", now - 100)
    idx = et.ProductIndex({"sdr": (str(sdr), "emwin"), "inet": (str(inet), "inet")}, offices=OFFICES)
    idx.scan(now)
    return idx


def test_the_index_reads_what_a_product_is_out_of_its_file_name(tmp_path):
    now = time.time()
    idx = _index(tmp_path, now)
    d = idx.search()
    assert d["total"] == 3                                   # the 4-day-old one is past two days
    by_awips = {p["awips"]: p for p in d["products"]}
    afd = by_awips["AFDEWXTX"]
    assert afd["name"] == "Area Forecast Discussion" and afd["kind"] == "Discussions"
    assert afd["office"] == "EWX" and afd["office_name"] == "Austin/San Antonio" and afd["wmo"] == "FXUS64 KEWX 181724"
    assert afd["filed"] == 1792344251 and afd["id"] == f"emwin/2026-10-18/{AFD}"
    assert by_awips["NPSA01US"]["kind"] == "Images" and by_awips["SAHOURLY"]["kind"] == "Observations"
    assert by_awips["SAHOURLY"]["src"] == "sdr"              # the dish's copy, not the backup's
    assert [p["awips"] for p in d["products"]] == ["NPSA01US", "SAHOURLY", "AFDEWXTX"]   # newest first


def test_a_search_matches_names_by_word_and_text_by_phrase(tmp_path):
    idx = _index(tmp_path, time.time())
    assert [p["awips"] for p in idx.search("forecast discussion")["products"]] == ["AFDEWXTX"]
    hit = idx.search("burn ban")
    assert [p["awips"] for p in hit["products"]] == ["AFDEWXTX"] and hit["products"][0]["hit"] == "text"
    assert idx.search("ban burn")["products"] == []          # a phrase in the text, not two words anywhere
    assert [p["awips"] for p in idx.search("katt")["products"]] == ["SAHOURLY"]
    assert idx.search("", office="EWX")["matched"] == 1 and idx.search("", kind="Images")["matched"] == 1
    assert idx.search("katt", text=False)["products"] == []


def test_a_product_is_found_by_id_or_name_and_read_with_plain_line_endings(tmp_path):
    idx = _index(tmp_path, time.time())
    ent = idx.get(pid=f"emwin/2026-10-18/{AFD}")
    assert ent is not None and idx.get(name=AFD) == ent
    assert idx.get(pid=f"inet/2026-10-18/{AFD}") is None and idx.get(pid="emwin/2026-10-18/../../etc/passwd") is None
    assert idx.read(ent).splitlines()[:3] == ["FXUS64 KEWX 181724", "AFDEWX", ""]


def test_a_rescan_only_adds_new_files_and_drops_old_days(tmp_path):
    now = time.time()
    idx = _index(tmp_path, now)
    assert idx.scan(now + 10) == 0
    _file(tmp_path / "emwin" / "2026-10-19", AFD.replace("181724", "190000"), "x", now)
    assert idx.scan(now + 20) == 1 and idx.search()["total"] == 4


def test_the_base_map_is_us_states_and_the_land_around_them(tmp_path):
    square = [[-100 + i / 100, 30] for i in range(100)] + [[-99, 30], [-99, 31], [-100, 31], [-100, 30]]
    states = {"features": [
        {"properties": {"adm0_a3": "USA", "postal": "TX"}, "geometry": {"type": "Polygon", "coordinates": [square]}},
        {"properties": {"adm0_a3": "CAN", "postal": "ON"}, "geometry": {"type": "Polygon", "coordinates": [square]}}]}
    countries = {"features": [
        {"properties": {"ADM0_A3": "MEX", "CONTINENT": "North America"},
         "geometry": {"type": "MultiPolygon", "coordinates": [[square]]}},
        {"properties": {"ADM0_A3": "FRA", "CONTINENT": "Europe"}, "geometry": {"type": "Polygon", "coordinates": [square]}},
        {"properties": {"ADM0_A3": "GUM", "CONTINENT": "Oceania"}, "geometry": {"type": "Polygon", "coordinates": [square]}}]}
    (tmp_path / "ne_50m_admin_1_states_provinces_lakes.json").write_text(json.dumps(states))
    (tmp_path / "ne_50m_admin_0_countries_lakes.json").write_text(json.dumps(countries))
    b = et.basemap(str(tmp_path))
    assert [s["id"] for s in b["states"]] == ["TX"] and len(b["land"]) == 2       # Mexico and Guam
    assert b["states"][0]["rings"][0] == [[-100, 30], [-99, 30], [-99, 31], [-100, 31], [-100, 30]]  # the straight edge thinned
    assert "error" in et.basemap(str(tmp_path / "missing"))


def test_radar_frames_are_timed_by_the_emwin_stamp_and_listed_once(tmp_path):
    # The 00:30Z frame is headed 1230 (12-hour clock); NOAA sent the 00:45Z one twice.
    now = time.time()
    day = tmp_path / "emwin" / "2026-10-18"
    names = ["Z_QATA00KWBC181230_C_KWIN_20261018003041_675083-3-RADSTHPL.GIF",
             "Z_QATA00KWBC181245_C_KWIN_20261018004551_675830-3-RADSTHPL.GIF",
             "Z_QATA00KWBC181245_C_KWIN_20261018004552_675831-3-RADSTHPL.GIF",
             "Z_QETI00KWNS181245_C_KWIN_20261018124537_709407-4-MODDY1US.PNG"]
    for i, name in enumerate(names):
        _file(day, name, "GIF89a", now - 600 + i)
    nws = tmp_path / "nws" / "2026-10-18"
    _file(nws, "20261018T220045Z_USA_latest.gif", "GIF89a", now - 60)
    _file(nws, "20261018T200006Z_atlsea_latestBW.gif", "GIF89a", now - 60)
    _file(nws, "20261018T200006Z_unknown_latestBW.gif", "GIF89a", now - 60)
    idx = et.ProductIndex({"sdr": (str(tmp_path / "emwin"), "emwin")})
    idx.scan(now)
    d = et.radar_and_charts(idx, str(tmp_path / "nws"))
    (radar,) = d["radar"]
    assert radar["name"] == "Southern Plains" and len(radar["frames"]) == 2
    assert [f[1] for f in radar["frames"]] == [1792283441, 1792284351]       # 00:30:41Z and 00:45:51Z
    assert radar["frames"][0][0] == f"emwin/2026-10-18/{names[0]}"
    charts = {c["id"]: c for c in d["charts"]}
    assert set(charts) == {"usa", "severe", "atlsea"} and charts["usa"]["source"] == "hrit"
    assert charts["usa"]["frames"][0][0] == "nws/2026-10-18/20261018T220045Z_USA_latest.gif"
    assert [c["id"] for c in d["charts"]] == ["usa", "severe", "atlsea"]     # the catalogue's order


def test_radar_keeps_the_last_twelve_hours_and_charts_keep_two_days(tmp_path):
    now = time.time()
    day = tmp_path / "emwin" / "2026-10-18"
    for h in (0, 6, 13):                                     # 13 h before the newest frame: dropped
        stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime(1792368000 - h * 3600))
        _file(day, f"Z_QATA00KWBC181200_C_KWIN_{stamp}_{h}-3-RADSTHPL.GIF", "GIF89a", now - 60)
        _file(day, f"Z_QETI00KWNS181200_C_KWIN_{stamp}_{h}-4-MODDY1US.PNG", "GIF89a", now - 60)
    idx = et.ProductIndex({"sdr": (str(tmp_path / "emwin"), "emwin")})
    idx.scan(now)
    d = et.radar_and_charts(idx, str(tmp_path / "nws"))
    assert len(d["radar"][0]["frames"]) == 2 and len(d["charts"][0]["frames"]) == 3
