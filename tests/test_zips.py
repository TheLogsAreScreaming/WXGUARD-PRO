"""US ZIP codes: the bundle table apps ship (client_data/zips.json, built by
scripts/build_client_data.py), the resolver, and a ZIP through the text and
`>` request paths."""

import asyncio
import importlib.util
import json
import re
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from meshcore_weather.config import settings
from meshcore_weather.core import services
from meshcore_weather.geodata import resolver, zip_code
from meshcore_weather.main import HELP_TEXT, WeatherBot
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from tests.test_console import ChannelFakeRadio

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).parent / "fixtures"
AUSTIN_78701 = (30.2706, -97.7426)     # the 78701 internal point in the shipped table


@pytest.fixture(autouse=True)
def _home():
    resolver.load()
    resolver.set_home(30.27, -97.74)
    yield
    resolver._home = None


# -- Build --------------------------------------------------------------------

_HEAD = "GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG" + " " * 20 + "\n"
_PLACES = [
    ["AUSTIN", "TX", 30.2672, -97.7431, 974447],
    ["SAN JUAN ZONA URBANA", "PR", 18.4663, -66.1057, 418140],
    ["ROUND ROCK", "TX", 30.5083, -97.6789, 119468],
    ["ADAK", "AK", 51.9099, -176.5981, 0],
    ["AUSTIN", "TX", 30.2672, -97.7431, 0],          # the same point again: the lower index wins
    ["ATTU STATION", "AK", 52.8503, 173.1811, 0],
]
_ROWS = [                                            # GEOID, INTPTLAT, INTPTLONG as the Census writes them
    ("78701", "30.270628", "-97.742589"),
    ("99591", "52.000000", "+179.500000"),           # Adak is nearer, across the antimeridian
    ("00901", "18.465426", "-66.104578"),
    ("78664", "30.514320", "-97.668660"),
    ("601", "18.180555", "-66.749961"),              # a GEOID that lost its leading zeros
]
_EXPECTED = {"version": 1, "source": "US Census Bureau 2020 ZCTA Gazetteer", "zips": [
    ["00601", 18.1806, -66.75, 1],
    ["00901", 18.4654, -66.1046, 1],
    ["78664", 30.5143, -97.6687, 2],
    ["78701", 30.2706, -97.7426, 0],
    ["99591", 52.0, 179.5, 3],
]}


def _builder():
    spec = importlib.util.spec_from_file_location("build_client_data", ROOT / "scripts" / "build_client_data.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _gazetteer(path: Path, rows) -> Path:
    path.write_text(_HEAD + "".join(f"{z}\t1000\t0\t0.001\t0.000\t{la}\t{lo}      \n" for z, la, lo in rows))
    return path


def test_build_writes_the_app_format_sorted_rounded_and_deterministic(tmp_path):
    bcd = _builder()
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    bcd.build_zips(tmp_path / "a", source=_gazetteer(tmp_path / "gaz.txt", _ROWS), places=_PLACES)
    text = (tmp_path / "a" / "zips.json").read_text()
    assert text == json.dumps(_EXPECTED, separators=(",", ":"))
    # Rows in another order, read from the .zip as downloaded: the same bytes.
    with zipfile.ZipFile(tmp_path / "gaz.zip", "w") as zf:
        zf.write(_gazetteer(tmp_path / "rev.txt", _ROWS[::-1]), "2020_Gaz_zcta_national.txt")
    bcd.build_zips(tmp_path / "b", source=tmp_path / "gaz.zip", places=_PLACES)
    assert (tmp_path / "b" / "zips.json").read_text() == text


def test_build_without_the_gazetteer_keeps_the_existing_table(tmp_path, capsys):
    bcd = _builder()
    (tmp_path / "zips.json").write_text("kept")
    bcd.build_zips(tmp_path, source=tmp_path / "missing.txt", places=_PLACES)
    assert (tmp_path / "zips.json").read_text() == "kept"
    out = capsys.readouterr().out
    assert "SKIPPED" in out and "existing zips.json kept" in out and bcd.ZCTA_GAZETTEER_URL in out


def test_shipped_table_is_the_census_zctas_indexing_bundled_places():
    data = ROOT / "meshcore_weather" / "client_data"
    doc = json.loads((data / "zips.json").read_text())
    places = json.loads((data / "places.json").read_text())["places"]
    rows = doc["zips"]
    assert doc["version"] == 1 and doc["source"] == "US Census Bureau 2020 ZCTA Gazetteer"
    assert len(rows) >= 33000 and [r[0] for r in rows] == sorted({r[0] for r in rows})
    assert all(len(r) == 4 and re.fullmatch(r"\d{5}", r[0]) and 0 <= r[3] < len(places) for r in rows)
    by_zip = {r[0]: r for r in rows}
    assert tuple(by_zip["78701"][1:3]) == AUSTIN_78701 and places[by_zip["78701"][3]][:2] == ["AUSTIN", "TX"]
    assert places[by_zip["00901"][3]][:2] == ["SAN JUAN", "PR"]
    assert "20500" not in by_zip                     # a business ZIP with no ZCTA


# -- Resolver -----------------------------------------------------------------


def test_zip_and_zip4_resolve_through_the_coordinate_path():
    r = resolver.resolve("78701")
    assert r["name"] == "Austin, TX 78701" and (r["lat"], r["lon"]) == AUSTIN_78701
    assert r["zones"][0] == "TXZ192" and r["wfos"] == ["EWX"] and r["station"] and r["stations"]
    assert resolver.resolve("78701-1234") == r and resolver.resolve(" 78701 ") == r
    same = resolver.resolve_by_coords(*AUSTIN_78701)
    assert {k: v for k, v in same.items() if k != "name"} == {k: v for k, v in r.items() if k != "name"}


def test_leading_zero_zips_keep_their_zeros():
    sj = resolver.resolve("00901")
    assert sj["name"] == "San Juan, PR 00901" and sj["zones"][0].startswith("PRZ") and sj["wfos"] == ["SJU"]
    # Allston is the Census place nearest 02134 (a Boston neighbourhood).
    bos = resolver.resolve("02134")
    assert bos["name"] == "Allston, MA 02134" and bos["zones"][0].startswith("MAZ") and bos["wfos"] == ["BOX"]


def test_unknown_zip_is_nothing_and_digits_never_collide():
    assert resolver.resolve("00000") is None and resolver.resolve("20500") is None
    assert resolver.resolve("TXZ192")["zones"] == ["TXZ192"] and resolver.resolve("KAUS")["station"] == "KAUS"
    assert resolver.resolve("K1A6")["station"] == "K1A6"
    for not_zip in ("102", "7870", "787011", "78701-12"):
        assert zip_code(not_zip) is None and resolver.resolve(not_zip) is None, not_zip
    assert zip_code("78701") == zip_code("78701-1234") == "78701" and zip_code("TXZ192") is None


# -- Text path ------------------------------------------------------------------


def _fresh(filename: str) -> str:
    return re.sub(r"_C_KWIN_\d{14}", f"_C_KWIN_{datetime.now(timezone.utc):%Y%m%d%H%M%S}", filename)


def _store() -> WeatherStore:
    """The Austin and San Juan PFMs from the fixtures, and a METAR from Camp Mabry."""
    sju = next((FIXTURES / "products").glob("*PFMSJUPR*"))
    ts = datetime.now(timezone.utc) - timedelta(minutes=10)
    store = WeatherStore()
    store.ingest([
        {"filename": _fresh("A_FOUS54KEWX131851_C_KWIN_20260913185129_315409-3-PFMEWXTX.TXT"),
         "raw_text": (FIXTURES / "PFMEWX_20260913_1851Z.txt").read_text()},
        {"filename": _fresh(sju.name), "raw_text": sju.read_bytes().decode("utf-8", "replace")},
        {"filename": f"A_SAUS70KWBC{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_000001-2-SAHOURLY.TXT",
         "raw_text": f"SAUS70 KWBC {ts:%d%H%M}\r\r\nMETAR\r\r\nKATT {ts:%d%H%M}Z 18005KT 10SM CLR 31/21 A3001=\r\r\n"},
    ])
    return store


@pytest.fixture
def bot(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "tx_enabled", True)
    monkeypatch.setattr(settings, "reply_mode", "channel")
    monkeypatch.setattr(settings, "admin_key", "")
    bot = WeatherBot()
    bot.store = _store()
    bot.radio = ChannelFakeRadio()
    return bot


def _say(bot, text, who):
    bot._rate_limit[who] = time.time() - 10
    bot.radio.channel_sent.clear()
    asyncio.run(bot._handle_channel_message("1", who, text, 0))
    return bot.radio.channel_sent[-1][1]


def test_zip_commands_by_text_end_to_end(bot, monkeypatch):
    # The San Juan forecast fixture was issued 14 Sep 18:32Z: that is today.
    from meshcore_weather.core import services
    monkeypatch.setattr(services, "_now", lambda: datetime(2026, 9, 14, 19, 0, tzinfo=timezone.utc))
    out = _say(bot, "wx 78701", "A")
    assert out.startswith("Austin, TX 78701: ") and "(KATT 6km)" in out, out
    assert _say(bot, "78701-1234", "B").startswith("Austin, TX 78701: ")        # a bare ZIP is a place
    assert _say(bot, "forecast 00901", "C").startswith("San Juan, PR 00901 (Luis Munoz Marin")
    assert _say(bot, "metar 78701", "D").startswith("METAR (KATT 6km) KATT ")
    assert _say(bot, "warn 78701", "E") == "No active warnings for Austin, TX 78701"
    assert _say(bot, "wx 00000", "F") == "Unknown ZIP: 00000"
    assert _say(bot, "forecast zzqqx", "G") == "Unknown location: zzqqx"


def test_help_mentions_zip_within_the_channel_budget(monkeypatch):
    from meshcore_weather.main import help_text
    assert "ZIP" in HELP_TEXT and len(HELP_TEXT) <= 147
    monkeypatch.setattr(settings, "sdr_dashboard_public_url", "https://goes.digitaino.com/")
    assert help_text() == HELP_TEXT + ". goes.digitaino.com" and len(help_text().encode()) <= 147
    monkeypatch.setattr(settings, "sdr_dashboard_public_url", "https://a-public-page-address-far-too-long-for-the-line.example.org")
    assert help_text() == HELP_TEXT                       # an address that does not fit is left out


# -- App requests -----------------------------------------------------------------


def _app(text: str, store: WeatherStore | None = None) -> list[dict]:
    from meshcore_weather.protocol.broadcaster import AppResponder
    radio = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    radio.send_channel_data = AsyncMock(return_value=True)
    asyncio.run(AppResponder(store if store is not None else WeatherStore(), radio).handle_request(text, "app"))
    return [v5.decode(c.args[0]) for c in radio.send_channel_data.await_args_list]


def test_f_five_digits_is_a_zip_and_up_to_four_a_point(monkeypatch):
    from tests.test_v5_builders import _austin_point
    b.tables.load()
    p = b.tables.points[102]
    pt = _austin_point(lat=p[2], lon=p[3], name=p[0])
    asked = []
    monkeypatch.setattr(services, "nearest_pfm_point", lambda store, lat, lon: (
        asked.append((lat, lon)) or (pt, SimpleNamespace(timestamp=pt.issue_time), 0.0)))
    d = _app(">f 102")[-1]
    assert d["name"] == "forecast" and d["point"] == 102 and asked[-1] == (p[2], p[3])
    for req in (">f 78701", ">f 78701-1234"):
        assert _app(req)[-1]["name"] == "forecast" and asked[-1] == AUSTIN_78701, req
    n = len(asked)
    d = _app(">f 00000")[-1]
    assert d["name"] == "not_available" and d["request"] == "f" and d["reason"] == v5.REASON_UNKNOWN_LOCATION
    assert len(asked) == n


def test_metar_and_taf_by_zip_use_the_nearest_station_and_o_is_unchanged():
    d = _app(">metar 78701", _store())
    assert d[0]["name"] == "text" and d[0]["text"].startswith("METAR (KATT 6km) KATT ")
    d = _app(">taf 78701", _store())[-1]                     # resolved; no TAF on file
    assert d["name"] == "not_available" and d["request"] == "t" and d["reason"] == v5.REASON_NO_DATA
    d = _app(">taf 00000")[-1]
    assert d["name"] == "not_available" and d["reason"] == v5.REASON_UNKNOWN_LOCATION
    d = _app(">o 78701")[-1]                                  # `>o` takes a station, not a ZIP
    assert d["name"] == "not_available" and d["reason"] == v5.REASON_UNKNOWN_LOCATION
