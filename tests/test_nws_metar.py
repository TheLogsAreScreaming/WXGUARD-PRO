"""NWS's own airport report and forecast feeds (emwin/nws_metar.py).

On 2026-10-18 the dish and NOAA's EMWIN bundles were both ~3 h behind, and
WX-AUS answered Camp Mabry with its 05:51 CDT report for six hours while
tgftp's DS.metar had every hourly report within minutes. These tests hold the
feeds' parsing, their polling and the store taking the fresher report; which
files the internet fill takes is tests/test_fill.py's.
"""

import asyncio
import time
from datetime import UTC, datetime, timedelta

import httpx

from meshcore_weather.core import services
from meshcore_weather.emwin import nws_metar
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b

# The layout of a real DS.metar file: `####...####` between single-station
# bulletins, "\r\r\n" and "\n" line ends mixed, a wrapped line not indented.
FEED_FILE = (
    "####018000072####\r\r\n"
    "SAUS44 KEWX 181651\r\r\n"
    "MTRATT\r\r\n"
    "METAR KATT 181651Z AUTO VRB03KT 10SM CLR 19/05 A3039 RMK AO2 SLP287 \n"
    "T01940050 $\n"
    "####018000073####\n"
    "SAMZ40 FQMA 181600\r\r\n"
    "METAR FQLC 181600Z 19004KT 9999 FEW020 28/20 Q1012=\r\r\n"
    "FQPB 181600Z 21006KT 9999 SCT020 29/21 Q1011=\n"
    "####018000074####\n"
    "SPUS44 KFWD 181702\n"
    "SPECI KDFW 181702Z 18010KT 10SM BKN015 22/12 A3010 RMK AO2=\n"
)


def _listing(*files: tuple[str, datetime]) -> str:
    rows = "".join(f'<tr><td><a href="{name}">{name}</a></td><td align="right">{when:%d-%b-%Y %H:%M}  </td>'
                   f'<td align="right"> 60K</td></tr>\n' for name, when in files)
    return f"<html><body><table>\n{rows}</table></body></html>"


def _server(files: dict[str, tuple[datetime, str]], fail_listing: bool = False):
    """A fake tgftp directory: {file name: (written at, body)}."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls.append(path)
        if path.endswith("/"):
            if fail_listing:
                return httpx.Response(503)
            return httpx.Response(200, text=_listing(*((n, w) for n, (w, _) in files.items())))
        name = path.rsplit("/", 1)[-1]
        if name in files:
            return httpx.Response(200, content=files[name][1].encode("latin-1"))
        return httpx.Response(404)

    return handler, calls


def test_the_listing_gives_each_file_and_its_utc_time():
    html = ('<tr><td><a href="sn.0190.txt">sn.0190.txt</a></td><td align="right">18-Oct-2026 16:55  </td>'
            '<td align="right">84K</td></tr>\n<tr><td><a href="../">Parent Directory</a></td></tr>')
    assert nws_metar.parse_listing(html) == [("sn.0190.txt", datetime(2026, 10, 18, 16, 55, tzinfo=UTC))]


def test_reports_are_one_line_each_without_the_metar_word():
    assert nws_metar.reports_in(FEED_FILE) == [
        "KATT 181651Z AUTO VRB03KT 10SM CLR 19/05 A3039 RMK AO2 SLP287 T01940050 $=",
        "FQLC 181600Z 19004KT 9999 FEW020 28/20 Q1012=",
        "FQPB 181600Z 21006KT 9999 SCT020 29/21 Q1011=",
        "KDFW 181702Z 18010KT 10SM BKN015 22/12 A3010 RMK AO2=",
    ]


def test_a_feed_file_is_an_hourly_collective_the_store_reads():
    written = datetime(2026, 10, 18, 16, 55, tzinfo=UTC)
    prod = nws_metar.collective(nws_metar.reports_in(FEED_FILE), written, 19012345)
    assert prod["filename"] == "A_SAUS99NWSF181655_C_NWSF_20261018165500_19012345-2-SAHOURLY.TXT"
    assert prod["source"] == "internet" and prod["timestamp"] == written
    # The store keeps hours, not days, so the copy it reads is written now: one stamped
    # Oct 18 started expiring at ingest once the clock passed it (found 2026-10-19).
    now = datetime.now(UTC).replace(microsecond=0)
    store = WeatherStore()
    store.ingest([nws_metar.collective(nws_metar.reports_in(FEED_FILE), now, 19012346)], log=False)
    report, ts = store._find_metar_raw("KATT")
    assert report.startswith("KATT 181651Z AUTO VRB03KT") and report.endswith("T01940050 $")
    assert ts == now
    assert store._find_metar_raw("KDFW")[0].startswith("KDFW 181702Z")


def test_the_fresher_nws_report_wins_over_the_dishs_old_one():
    # The 2026-10-18 case: the dish's newest Camp Mabry report is five hours
    # old, NWS's is minutes old. The answer must be NWS's 19 C (66 F), not 8 C (46 F).
    now = datetime.now(UTC)
    old = now - timedelta(hours=5)
    dish = {"filename": f"A_SAUS70KWBC{old:%d%H%M}_C_KWIN_{old:%Y%m%d%H%M%S}_000001-2-SAHOURLY.TXT",
            "raw_text": f"SAUS70 KWBC\nMETAR\nKATT {old:%d%H%M}Z AUTO 00000KT 10SM CLR 08/06 A3038 RMK AO2=",
            "source": "sdr"}
    taken = now - timedelta(minutes=9)
    nws = nws_metar.collective([f"KATT {taken:%d%H%M}Z AUTO VRB03KT 10SM CLR 19/05 A3039 RMK AO2="],
                               now - timedelta(minutes=5), 1)
    store = WeatherStore()
    store.ingest([dish, nws], log=False)
    stations = v5.decode(b.station_obs_message(1, 1, store, "KATT"))["stations"]
    assert stations[0]["temp_f"] == 66

    # And once EMWIN catches up with a newer collective, the dish's wins again.
    later = now - timedelta(minutes=2)
    caught_up = {"filename": f"A_SAUS70KWBC{later:%d%H%M}_C_KWIN_{later:%Y%m%d%H%M%S}_000002-2-SAHOURLY.TXT",
                 "raw_text": f"SAUS70 KWBC\nMETAR\nKATT {later:%d%H%M}Z AUTO 18005KT 10SM CLR 20/05 A3039=",
                 "source": "sdr"}
    store.ingest([caught_up], log=False)
    assert v5.decode(b.station_obs_message(1, 1, store, "KATT"))["stations"][0]["temp_f"] == 68


def test_a_first_poll_takes_the_last_75_minutes_and_the_next_only_what_is_new():
    now = datetime(2026, 10, 18, 17, 0, tzinfo=UTC)
    files = {
        "sn.0170.txt": (now - timedelta(minutes=100), FEED_FILE),   # older than the window
        "sn.0185.txt": (now - timedelta(minutes=30), FEED_FILE),
        "sn.0190.txt": (now - timedelta(minutes=5), FEED_FILE),
    }
    handler, calls = _server(files)
    feed = nws_metar.NwsFeed("https://tgftp.example/DS.metar", nws_metar.metar_file)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            first = await feed.poll(client, now)
            files["sn.0191.txt"] = (now + timedelta(minutes=5), FEED_FILE)
            second = await feed.poll(client, now + timedelta(minutes=6))
            return first, second

    first, second = asyncio.run(run())
    assert [p["timestamp"] for p in first] == [now - timedelta(minutes=30), now - timedelta(minutes=5)]
    assert [p["timestamp"] for p in second] == [now + timedelta(minutes=5)]
    assert not any(c.endswith("sn.0170.txt") for c in calls)
    assert feed.newest_file == now + timedelta(minutes=5)


def test_a_failed_listing_costs_that_poll_only():
    now = datetime(2026, 10, 18, 17, 0, tzinfo=UTC)
    handler, _ = _server({"sn.0190.txt": (now - timedelta(minutes=5), FEED_FILE)}, fail_listing=True)
    feed = nws_metar.NwsFeed("https://tgftp.example/DS.metar/", nws_metar.metar_file)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await feed.poll(client, now)

    assert asyncio.run(run()) == []
    assert feed.last_error.startswith("HTTPStatusError")


def test_a_file_the_fill_turns_down_is_asked_about_again():
    now = datetime(2026, 10, 18, 17, 0, tzinfo=UTC)
    handler, calls = _server({"sn.0190.txt": (now - timedelta(minutes=5), FEED_FILE)})
    feed = nws_metar.NwsFeed("https://tgftp.example/DS.metar/", nws_metar.metar_file)

    async def run(keep):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await feed.poll(client, now, keep=keep)

    assert asyncio.run(run(lambda written: False)) == [] and not any(c.endswith(".txt") for c in calls)
    assert len(asyncio.run(run(lambda written: True))) == 1


TAF_FILE = (
    "####018150041####\r\r\n"
    "FTUS44 KEWX 191720\r\r\n"
    "TAFAUS\r\r\n"
    "TAF KAUS 191720Z 1918/2024 16008KT P6SM SCT035\r\r\n"
    "     FM200000 14006KT P6SM SKC=\r\r\n"
    "####018150042####\r\r\n"
    "FTUS90 KWBC 191720\r\r\n"
    "TAF\r\r\n"
    "TAF AMD PABI 191720Z 1918/2020 11012KT 9999 SCT080=\r\r\n"
)


def test_an_airport_forecast_file_is_read_like_the_dishs_tafs():
    written = datetime.now(UTC).replace(microsecond=0)
    prod = nws_metar.taf_file(TAF_FILE, written, 77)
    assert prod["awips_id"] == "TAFALLUS" and prod["filename"].endswith("-2-TAFALLUS.TXT")
    assert "####" not in prod["raw_text"] and nws_metar.taf_file("no forecast here", written, 1) is None
    store = WeatherStore()
    store.ingest([prod], log=False)
    assert services.station_taf(store, "KAUS") == "TAF KAUS 191720Z 1918/2024 16008KT P6SM SCT035 FM200000 14006KT P6SM SKC="
    assert services.station_taf(store, "PABI") == "TAF PABI AMD 191720Z 1918/2020 11012KT 9999 SCT080="


def test_a_dish_taf_keeps_its_change_groups():
    # The dish's own "\r\r\n" lines: each TAF reply used to stop after its first line.
    text = "FTUS80 KWBC 191257 AAA\r\r\nTAF AMD\r\r\nKAUS 191254Z 1913/2012 VRB04KT P6SM SCT250\r\r\n     FM191800 18008KT P6SM BKN040=\r\r\n"
    assert services._taf_block(text, "KAUS") == "KAUS 191254Z 1913/2012 VRB04KT P6SM SCT250 FM191800 18008KT P6SM BKN040="
