"""The internet fill (emwin/fill.py): the feed first, NWS over the internet for
whatever the feed has not delivered within its grace.

Everything runs against a fake NWS: api.weather.gov's listing and products,
the tgftp airport report and forecast feeds, radar.weather.gov's mosaics.
"""

import asyncio
import email.utils
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from meshcore_weather.config import settings
from meshcore_weather.emwin import fill as fill_mod
from meshcore_weather.emwin.fetcher import InternetSource, SDRSource
from meshcore_weather.radar.source import RadarSource

NOW = datetime.now(UTC).replace(second=0, microsecond=0)
GIF = b"GIF89a" + b"\x00" * 64


@pytest.fixture(autouse=True)
def _fill_on(monkeypatch):
    monkeypatch.setattr(settings, "fill_enabled", True)
    monkeypatch.setattr(settings, "fill_api_url", "https://api.test")
    monkeypatch.setattr(settings, "fill_radar_url", "https://radar.test/ridge/standard")
    monkeypatch.setattr(settings, "nws_metar_url", "https://tg.test/DS.metar/")
    monkeypatch.setattr(settings, "nws_taf_url", "https://tg.test/DS.tafst/")


def _item(pid: str, wmo: str, office: str, issued: datetime, code: str) -> dict:
    return {"id": pid, "wmoCollectiveId": wmo, "issuingOffice": office,
            "issuanceTime": issued.isoformat(), "productCode": code}


def _text(wmo: str, office: str, issued: datetime, awips: str, body: str = "Body of the product.") -> str:
    return f"\n000\n{wmo} {office} {issued:%d%H%M}\n{awips}\n\n{body}\n\n$$\n"


class FakeNws:
    """api.weather.gov, tgftp's two feeds and radar.weather.gov in one handler."""

    def __init__(self):
        self.items: list[dict] = []
        self.texts: dict[str, str] = {}
        self.feeds: dict[str, dict[str, tuple[datetime, str]]] = {"DS.metar": {}, "DS.tafst": {}}
        self.radar: dict[str, tuple[datetime, bytes]] = {}
        self.calls: list[str] = []
        self.fail_listing = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url, path = request.url, request.url.path
        self.calls.append(f"{url.host}{path}")
        if url.host == "api.test" and path == "/products":
            if self.fail_listing:
                return httpx.Response(503)
            q = parse_qs(url.query.decode())
            types = set(q["type"][0].split(","))
            start = datetime.fromisoformat(q["start"][0].replace("Z", "+00:00"))
            end = datetime.fromisoformat(q["end"][0].replace("Z", "+00:00"))
            got = [i for i in self.items if i["productCode"] in types
                   and start <= datetime.fromisoformat(i["issuanceTime"]) < end]
            return httpx.Response(200, json={"@graph": got})
        if url.host == "api.test" and path.startswith("/products/"):
            pid = path.rsplit("/", 1)[-1]
            return httpx.Response(200, json={"productText": self.texts[pid]}) if pid in self.texts else httpx.Response(404)
        if url.host == "tg.test":
            feed = path.strip("/").split("/")[0]
            files = self.feeds[feed]
            if path.endswith("/"):
                rows = "".join(f'<a href="{n}">{n}</a></td><td align="right">{w:%d-%b-%Y %H:%M}  </td>\n'
                               for n, (w, _) in files.items())
                return httpx.Response(200, text=rows)
            name = path.rsplit("/", 1)[-1]
            return httpx.Response(200, content=files[name][1].encode("latin-1")) if name in files else httpx.Response(404)
        if url.host == "radar.test":
            ridge = path.rsplit("/", 1)[-1][:-6]
            if ridge not in self.radar:
                return httpx.Response(404)
            made, data = self.radar[ridge]
            lastmod = email.utils.format_datetime(made, usegmt=True)
            if request.headers.get("If-Modified-Since") == lastmod:
                return httpx.Response(304)
            return httpx.Response(200, content=data, headers={"Last-Modified": lastmod})
        return httpx.Response(404)


def _source(tmp_path, nws: FakeNws) -> SDRSource:
    src = SDRSource(root=tmp_path / "dish", fallback_root=tmp_path / "fill")
    (tmp_path / "dish").mkdir(exist_ok=True)
    src.fill = fill_mod.InternetFill(src, transport=httpx.MockTransport(nws))
    return src


def _dish(root: Path, name: str, body: bytes = b"WOXX20 KWNP 191400\r\r\nX\r\r\n", age_s: float = 30) -> Path:
    stamp = fill_mod.stamp_of_name(name) or NOW
    d = root / f"{stamp:%Y-%m-%d}"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_bytes(body)
    os.utime(p, (time.time() - age_s, time.time() - age_s))
    return p


def _poll(src: SDRSource, at: datetime, *parts: str) -> int:
    """One poll at `at` of the parts named (all three when none are)."""
    for part in ("text", "obs", "radar"):
        setattr(src.fill, f"_{part}_next", 0.0 if not parts or part in parts else float("inf"))
    return asyncio.run(src.fill.poll(at))


def _kwin(wmo: str, office: str, t: datetime, eid: str, seq: int = 1, prio: int = 2, ext: str = "TXT") -> str:
    kind = "A" if ext == "TXT" else "Z"
    return f"{kind}_{wmo}{office}{t:%d%H%M}_C_KWIN_{t:%Y%m%d%H%M%S}_{seq}-{prio}-{eid}.{ext}"


# -- text products, from api.weather.gov ------------------------------------------------


def test_the_feed_first_and_nws_only_for_what_it_has_not_brought_in_its_grace(tmp_path):
    nws = FakeNws()
    src = _source(tmp_path, nws)
    t_afd, t_zfp, t_tor = NOW - timedelta(minutes=20), NOW - timedelta(minutes=10), NOW - timedelta(minutes=2)
    t_sft = NOW - timedelta(minutes=3)
    _dish(tmp_path / "dish", _kwin("FXUS64", "KEWX", t_afd, "AFDEWXTX"))          # the dish has the discussion
    _dish(tmp_path / "dish", _kwin("FPUS64", "KEWX", t_sft, "SFTEWXTX", seq=2))   # ... and the state table, in time
    src.scan()
    nws.items = [_item("sft", "FPUS64", "KEWX", t_sft, "SFT"),
                 _item("afd", "FXUS64", "KEWX", t_afd, "AFD"), _item("zfp", "FPUS54", "KEWX", t_zfp, "ZFP"),
                 _item("tor", "WFUS54", "KOUN", t_tor, "TOR")]
    nws.texts = {"zfp": _text("FPUS54", "KEWX", t_zfp, "ZFPEWX"), "tor": _text("WFUS54", "KOUN", t_tor, "TOROUN",
                                                                               "OKC109-191500-")}
    assert _poll(src, NOW, "text") == 1                          # the warning after 2 min; the forecast waits its 15
    assert "api.test/products/afd" not in nws.calls and "api.test/products/zfp" not in nws.calls
    held = {p["awips_id"]: p for p in asyncio.run(src.fetch_products())}
    tor = held["TOROUNOK"]                                       # OUN's state: from its UGC line, nothing learned yet
    assert tor["source"] == "internet" and tor["filename"].startswith("A_WFUS54KOUN")
    assert "_C_NWSA_" in tor["filename"] and tor["filename"].endswith("-1-TOROUNOK.TXT")
    assert tor["raw_text"].startswith("WFUS54 KOUN") and "\r\r\n" in tor["raw_text"]

    assert _poll(src, NOW + timedelta(minutes=6), "text") == 1   # 16 min on: the zone forecast
    zfp = {p["awips_id"]: p for p in asyncio.run(src.fetch_products())}["ZFPEWXTX"]   # TX: learned from the dish's EWX ids
    assert (tmp_path / "fill" / f"{t_zfp:%Y-%m-%d}" / zfp["filename"]).is_file()
    # The dish brought the discussion 20 min after it was issued (its file is 30 s old): late, though not filled.
    assert src.fill.decided[("FXUS64", "KEWX", f"{t_afd:%d%H%M}")][1] == "late"
    assert src.fill.decided[("FPUS64", "KEWX", f"{t_sft:%d%H%M}")][1] == "feed"
    assert [k for k, v in src.fill.decided.items() if v[1] == "fill"] and not src.fill.pending


def test_the_feeds_late_copy_is_dropped_but_still_says_how_late_it_runs(tmp_path):
    nws = FakeNws()
    src = _source(tmp_path, nws)
    t = NOW - timedelta(minutes=30)
    nws.items = [_item("zfp", "FPUS54", "KEWX", t, "ZFP")]
    nws.texts = {"zfp": _text("FPUS54", "KEWX", t, "ZFPEWX")}
    assert _poll(src, NOW, "text") == 1
    for f in (tmp_path / "fill").rglob("*.TXT"):
        os.utime(f, (time.time() - 60, time.time() - 60))
    _dish(tmp_path / "dish", _kwin("FPUS54", "KEWX", t, "ZFPEWXTX"), age_s=5)    # the dish's copy, 30 min late
    assert src.scan() == 0 and len(asyncio.run(src.fetch_products())) == 1
    assert src._lag_samples and src.newest_mtime is not None

    # A restart: what the fill took is read back first, and the dish's copy is still dropped.
    again = _source(tmp_path, nws)
    assert again.scan() == 1
    (prod,) = asyncio.run(again.fetch_products())
    assert prod["source"] == "internet" and prod["awips_id"] == "ZFPEWXUS"     # nothing learned of EWX here
    assert again.fill.is_duplicate(_kwin("FPUS54", "KEWX", t, "ZFPEWXTX"))


def test_the_emwin_id_is_learned_from_the_feed_then_the_office_then_the_ugc_line():
    book = fill_mod.IdBook()
    book.learn(_kwin("CDUS44", "KSJT", NOW, "CLIABITX"))
    assert book.emwin_id("CLIABI", "KSJT", "") == "CLIABITX"                  # seen on the dish
    assert book.emwin_id("CLISJT", "KSJT", "") == "CLISJTTX"                  # the office's usual state
    assert book.emwin_id("FFWOUN", "KOUN", "OKC109-191500-\n") == "FFWOUNOK"  # its UGC line
    assert book.emwin_id("SWODY1", "KWNS", "no ugc") == "SWODY1US"
    assert book.emwin_id("TAV", "KWBC", "") == "TAVUSXXX"                      # always eight


def test_a_failed_listing_is_on_record_and_the_other_parts_still_run(tmp_path):
    nws = FakeNws()
    nws.fail_listing = True
    src = _source(tmp_path, nws)
    nws.feeds["DS.metar"]["sn.0001.txt"] = (NOW - timedelta(minutes=20), "SAUS44 KEWX 191340\nMTRAUS\nMETAR KAUS 191340Z 18008KT 10SM CLR 25/15 A3001=\n")
    assert _poll(src, NOW) == 1                                   # the airport file, though the listing failed
    st = src.fill.status(NOW)
    assert st["errors"]["text"].startswith("text: 503") and st["last_ok"] == int(NOW.timestamp())
    assert "obs" not in st["errors"]
    assert st["errors"]["radar"].startswith("radar ")             # no web picture in this fake: that region only


def test_nothing_is_asked_when_the_fill_is_off(tmp_path, monkeypatch):
    nws = FakeNws()
    src = _source(tmp_path, nws)
    monkeypatch.setattr(settings, "fill_enabled", False)
    assert _poll(src, NOW) == 0 and nws.calls == []


# -- airport reports and forecasts, from NWS's feeds --------------------------------------


METAR_FILE = "####1####\nSAUS44 KEWX 191340\nMTRAUS\nMETAR KAUS 191340Z 18008KT 10SM CLR 25/15 A3001=\n"
TAF_FILE = "####1####\nFTUS44 KEWX 191340\nTAFAUS\nTAF KAUS 191340Z 1914/2018 18008KT P6SM SKC=\n"


def _metar(station: str, t: datetime, kind: str = "METAR") -> str:
    return f"{kind} {station} {t:%d%H%M}Z 18008KT 10SM CLR 25/15 A3001="


def _nws_file(*reports: str, n: int = 1) -> str:
    """A DS.metar file: one single-station bulletin a report."""
    return "".join(f"####{n}{i:04d}####\nSAUS44 KEWX 191340\nMTR{r.split()[1][1:]}\n{r}\n" for i, r in enumerate(reports))


def _sah(t: datetime, *reports: str) -> bytes:
    """One of the dish's SAHOURLY bundles, made at `t`: "METAR" or "SPECI" on a
    line of its own, then a line a station."""
    kind = reports[0].split()[0]
    return "\r\r\n".join([f"SAUS70 KWBC {t:%d%H%M}", kind, *(r.split(" ", 1)[1] for r in reports)]).encode()


def test_a_lost_bundle_is_filled_report_by_report_while_others_arrive(tmp_path):
    # 2026-10-19: the dish lost the bundles with KAUS 1553Z while others came
    # on time, and one fresh bundle had said every station was current.
    from meshcore_weather.core import services
    from meshcore_weather.geodata import resolver
    from meshcore_weather.parser.weather import WeatherStore

    nws = FakeNws()
    src = _source(tmp_path, nws)
    h = NOW - timedelta(minutes=25)                  # the hourly reports
    _dish(tmp_path / "dish", _kwin("SAUS70", "KWBC", h - timedelta(minutes=57), "SAHOURLY", seq=1),
          body=_sah(h - timedelta(minutes=57), _metar("KAUS", h - timedelta(hours=1))))
    _dish(tmp_path / "dish", _kwin("SAUS70", "KWBC", h + timedelta(minutes=2), "SAHOURLY", seq=2),
          body=_sah(h + timedelta(minutes=2), _metar("KDFW", h)))       # on time; KAUS's bundle is lost
    src.scan()
    speci = NOW - timedelta(minutes=10)
    nws.feeds["DS.metar"] = {
        "sn.0010.txt": (h + timedelta(minutes=3), _nws_file(_metar("KAUS", h), _metar("KDFW", h), _metar("EGLL", h))),
        "sn.0011.txt": (speci + timedelta(minutes=2), _nws_file(_metar("KAUS", speci, "SPECI"),
                                                                _metar("KDFW", speci, "SPECI"), n=2)),
    }
    assert _poll(src, NOW, "obs") == 1
    assert not any(c.endswith("sn.0011.txt") for c in nws.calls)      # in its grace yet
    (filled,) = [p for p in asyncio.run(src.fetch_products()) if p["source"] == "internet"]
    assert f"KAUS {h:%d%H%M}Z" in filled["raw_text"]
    assert "KDFW" not in filled["raw_text"] and "EGLL" not in filled["raw_text"]   # the feed's; not a station of ours

    # Ten minutes on: the specials' file is due, and the dish brought KDFW's in time.
    _dish(tmp_path / "dish", _kwin("SAUS70", "KWBC", speci + timedelta(minutes=1), "SAHOURLY", seq=3),
          body=_sah(speci + timedelta(minutes=1), _metar("KDFW", speci, "SPECI")))
    src.scan()
    assert _poll(src, NOW + timedelta(minutes=10), "obs") == 1
    newest = max((p for p in asyncio.run(src.fetch_products()) if p["source"] == "internet"), key=lambda p: p["timestamp"])
    assert f"KAUS {speci:%d%H%M}Z" in newest["raw_text"] and "KDFW" not in newest["raw_text"]

    store = WeatherStore()
    store.ingest(asyncio.run(src.fetch_products()), log=False)
    assert services.raw_metar_for(store, resolver.resolve("KAUS"))[2].startswith(f"KAUS {speci:%d%H%M}Z")
    assert services.raw_metar_for(store, resolver.resolve("KDFW"))[2].startswith(f"KDFW {speci:%d%H%M}Z")

    st = src.fill.status(NOW + timedelta(minutes=10))
    assert st["active"] is False                        # a station or two: mopping up, not filling in
    assert st["last_hour"]["obs_files"] == 2 and st["last_hour"]["obs_reports"] == 2

    # A restart reads back what was taken, report by report: nothing is taken twice.
    for f in (tmp_path / "fill").rglob("*.TXT"):
        os.utime(f, (time.time() - 60, time.time() - 60))
    again = _source(tmp_path, nws)
    again.scan()
    assert again.fill.reports["SAH"]["KAUS"] == speci
    assert _poll(again, NOW + timedelta(minutes=11), "obs") == 0


def test_airport_forecasts_are_filled_station_by_station_too(tmp_path):
    from meshcore_weather.core import services
    from meshcore_weather.parser.weather import WeatherStore

    nws = FakeNws()
    src = _source(tmp_path, nws)
    old, new = NOW - timedelta(hours=5), NOW - timedelta(minutes=25)
    _dish(tmp_path / "dish", _kwin("FTUS80", "KWBC", old, "TAFALLUS", seq=1),
          body=f"FTUS80 KWBC {old:%d%H%M}\r\r\nTAF\r\r\nKAUS {old:%d%H%M}Z 1912/2012 18008KT P6SM SKC=\r\r\n".encode())
    _dish(tmp_path / "dish", _kwin("FTUS80", "KWBC", new, "TAFALLUS", seq=2),          # on time
          body=f"FTUS80 KWBC {new:%d%H%M}\r\r\nTAF AMD\r\r\nKDFW {new:%d%H%M}Z 1918/2024 18010KT P6SM BKN040=\r\r\n".encode())
    src.scan()
    nws.feeds["DS.tafst"] = {"sn.0001.txt": (new + timedelta(minutes=2), (
        f"####1####\nFTUS44 KEWX {new:%d%H%M}\nTAFAUS\nTAF KAUS {new:%d%H%M}Z 1918/2024 16008KT P6SM SCT035\n"
        f"     FM200000 14006KT P6SM SKC=\n"
        f"####2####\nFTUS44 KFWD {new:%d%H%M}\nTAFDFW\nTAF AMD KDFW {new:%d%H%M}Z 1918/2024 18010KT P6SM BKN040=\n"
        f"####3####\nFTCH05 SCSC {new:%d%H%M}\nTAF SCIP {new:%d%H%M}Z 1918/2018 09014KT 9999 SCT030=\n"))}
    assert _poll(src, NOW, "obs") == 1
    (filled,) = [p for p in asyncio.run(src.fetch_products()) if p["source"] == "internet"]
    assert filled["awips_id"] == "TAFALLUS" and "KDFW" not in filled["raw_text"] and "SCIP" not in filled["raw_text"]
    store = WeatherStore()
    store.ingest(asyncio.run(src.fetch_products()), log=False)
    assert services.station_taf(store, "KAUS").startswith(f"TAF KAUS {new:%d%H%M}Z 1918/2024")
    assert services.station_taf(store, "KDFW").startswith(f"TAF KDFW {new:%d%H%M}Z")              # the dish's


STATIONS = ["KAUS", "KDFW", "KIAH", "KLAX", "KSEA", "KDEN", "KMIA", "KBOS", "KSTL", "KBNA", "KSLC", "KPDX"]


def _six_files(nws: FakeNws) -> None:
    """Six DS.metar files, 50 to 25 min old, each with a report from every station."""
    for i in range(6):
        written = NOW - timedelta(minutes=50 - 5 * i)
        nws.feeds["DS.metar"][f"sn.{i:04d}.txt"] = (written, _nws_file(*(_metar(s, written - timedelta(minutes=2))
                                                                          for s in STATIONS), n=i))


def test_it_counts_as_filling_in_only_when_the_feed_missed_most_of_what_it_carries(tmp_path):
    # EMWIN three hours late: the feed carries every one of these stations, and missed all of it.
    nws = FakeNws()
    (tmp_path / "late").mkdir()
    src = _source(tmp_path / "late", nws)
    t = NOW - timedelta(hours=3)
    _dish(tmp_path / "late" / "dish", _kwin("SAUS70", "KWBC", t, "SAHOURLY"), body=_sah(t, *(_metar(s, t) for s in STATIONS)))
    src.scan()
    _six_files(nws)
    assert _poll(src, NOW, "obs") == 6
    st = src.fill.status(NOW)
    assert st["active"] is True and src.fill.spell_filled == 6 and st["last_hour"]["obs_reports"] == 72

    # Stations the feed never carries: every report is taken, and none of it is filling in.
    nws = FakeNws()
    (tmp_path / "never").mkdir()
    src = _source(tmp_path / "never", nws)
    _six_files(nws)
    assert _poll(src, NOW, "obs") == 6
    st = src.fill.status(NOW)
    assert st["active"] is False and st["last_hour"]["obs_reports"] == 72 and st["last_hour"]["obs_files"] == 6


def test_airport_files_are_taken_once_their_grace_is_up(tmp_path):
    nws = FakeNws()
    src = _source(tmp_path, nws)
    _dish(tmp_path / "dish", _kwin("SAUS70", "KWBC", NOW - timedelta(hours=3), "SAHOURLY"))   # EMWIN 3 h late
    src.scan()
    nws.feeds["DS.metar"] = {"sn.0001.txt": (NOW - timedelta(hours=4), METAR_FILE),           # older than a first poll's 75 min
                             "sn.0002.txt": (NOW - timedelta(minutes=20), METAR_FILE),
                             "sn.0003.txt": (NOW - timedelta(minutes=5), METAR_FILE)}         # in its grace yet
    nws.feeds["DS.tafst"] = {"sn.0001.txt": (NOW - timedelta(minutes=30), TAF_FILE)}          # the feed has no TAF at all
    assert _poll(src, NOW, "obs") == 2
    held = {p["awips_id"]: p for p in asyncio.run(src.fetch_products())}
    assert held["SAHOURLY"]["source"] == "sdr" or "KAUS 191340Z" in held["SAHOURLY"]["raw_text"]
    assert sum(1 for p in asyncio.run(src.fetch_products()) if p["filename"].startswith("A_SAUS99NWSF")) == 1
    assert "KAUS 191340Z" in held["TAFALLUS"]["raw_text"] and held["TAFALLUS"]["source"] == "internet"
    assert not any(c.endswith("sn.0003.txt") for c in nws.calls)


# -- radar, from radar.weather.gov ---------------------------------------------------------


def test_radar_comes_from_the_web_while_the_dishs_picture_is_old(tmp_path):
    nws = FakeNws()
    src = _source(tmp_path, nws)
    old = NOW - timedelta(hours=2)
    _dish(tmp_path / "dish", _kwin("QATA00", "KWBC", old, "RADSTHPL", prio=3, ext="GIF"), body=GIF)
    _dish(tmp_path / "dish", _kwin("QATA00", "KWBC", NOW - timedelta(minutes=5), "RADREFUS", prio=3, ext="GIF"), body=GIF)
    src.scan()
    made = NOW - timedelta(minutes=4)
    nws.radar = {"SOUTHPLAINS": (made, GIF), "CONUS": (made, GIF)}
    assert _poll(src, NOW, "radar") == 1                                 # Southern Plains; the US one is current
    assert not any(c.endswith("CONUS_0.gif") for c in nws.calls)
    (kept,) = (tmp_path / "fill").rglob("*.GIF")
    os.utime(kept, (time.time() - 10, time.time() - 10))                 # settled, as by the next scan
    assert "_C_NWSR_" in kept.name and kept.name.endswith("-3-RADSTHPL.GIF")
    listing = RadarSource(tmp_path / "dish", [tmp_path / "fill"])
    listing._scan(NOW)
    assert listing._listing["RADSTHPL"][0] == (made, kept)              # newest first, timed by Last-Modified
    assert _poll(src, NOW + timedelta(minutes=6), "radar") == 0          # the same picture: 304
    assert not asyncio.run(src.fetch_products())                          # a picture is not a text product


# -- what it says it is doing ---------------------------------------------------------------


def test_it_counts_as_filling_in_after_five_products_and_says_why(tmp_path):
    nws = FakeNws()
    src = _source(tmp_path, nws)
    _dish(tmp_path / "dish", _kwin("FXUS64", "KEWX", NOW - timedelta(minutes=50), "AFDEWXTX"), age_s=5)
    src.scan()
    src._lag_samples.extend((time.time() - i, 45.0) for i in range(10))
    issued = NOW - timedelta(minutes=40)
    for i in range(6):
        nws.items.append(_item(f"z{i}", "FPUS54", "KEWX", issued + timedelta(minutes=i), "ZFP"))
        nws.texts[f"z{i}"] = _text("FPUS54", "KEWX", issued + timedelta(minutes=i), "ZFPEWX")
    assert src.fill.status(NOW)["active"] is False
    assert _poll(src, NOW, "text") == 6
    st = src.fill.status(NOW)
    assert st["active"] is True and st["since"] == int(NOW.timestamp()) and src.fill.spell_filled == 6
    assert st["reason"] == "EMWIN is running 45 min late"
    assert st["last_hour"]["issued"] == 6 and st["last_hour"]["in_time"] == 0 and st["last_hour"]["in_time_pct"] == 0
    assert st["last_hour"]["text"] == 6
    # Half an hour with nothing to take: done.
    assert _poll(src, NOW + timedelta(minutes=31), "text") == 0
    assert src.fill.status(NOW + timedelta(minutes=31))["active"] is False


def test_a_bot_without_a_dish_gets_the_same_fill_over_noaas_bundles(tmp_path):
    nws = FakeNws()
    src = InternetSource(cache_file=tmp_path / "products.jsonl")
    src.fill = fill_mod.InternetFill(src, transport=httpx.MockTransport(nws))
    t = NOW - timedelta(minutes=20)
    nws.items = [_item("zfp", "FPUS54", "KEWX", t, "ZFP")]
    nws.texts = {"zfp": _text("FPUS54", "KEWX", t, "ZFPEWX")}
    for part in ("obs", "radar"):
        setattr(src.fill, f"_{part}_next", float("inf"))
    assert asyncio.run(src.fill.poll(NOW)) == 1 and len(src._unsaved) == 1     # onto the cache file too
    late = {"filename": _kwin("FPUS54", "KEWX", t, "ZFPEWXTX"), "awips_id": "ZFPEWXTX", "timestamp": t,
            "raw_text": "FPUS54 KEWX", "source": "internet"}
    assert src._take([late], NOW, fresh=True) == []                             # the bundle's late copy


def test_turning_the_fill_off_in_a_spell_ends_the_spell(tmp_path, monkeypatch):
    """19 Oct: the fill was turned off in Settings while filling in, and the
    public page kept saying the bot was getting products from NWS."""
    nws = FakeNws()
    src = _source(tmp_path, nws)
    issued = NOW - timedelta(minutes=40)
    for i in range(6):
        nws.items.append(_item(f"z{i}", "FPUS54", "KEWX", issued + timedelta(minutes=i), "ZFP"))
        nws.texts[f"z{i}"] = _text("FPUS54", "KEWX", issued + timedelta(minutes=i), "ZFPEWX")
    assert _poll(src, NOW, "text") == 6 and src.fill.status(NOW)["active"] is True
    monkeypatch.setattr(settings, "fill_enabled", False)
    st = src.fill.status(NOW)
    assert st["enabled"] is False and st["active"] is False and st["since"] is None   # before the next poll, too
    asked = len(nws.calls)
    assert _poll(src, NOW + timedelta(minutes=1)) == 0
    assert src.fill.active_since is None and len(nws.calls) == asked              # ended, and nothing asked
