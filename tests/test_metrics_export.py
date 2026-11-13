"""Weather history export: readings, InfluxDB line protocol, /metrics page."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx

from meshcore_weather.metrics import MetricsExporter
from meshcore_weather.metrics.influx import InfluxPusher, auth_headers, to_line, write_url
from meshcore_weather.metrics.prometheus import MetricsServer, render
from meshcore_weather.metrics.readings import Reading, latest_readings, parse_station_list
from meshcore_weather.parser.weather import EMWINProduct

UTC = UTC
NOW = datetime(2026, 11, 13, 18, 30, tzinfo=UTC)
ROOT = Path(__file__).resolve().parents[1]


def _product(name: str, when: datetime, text: str, ptype: str = "SAH") -> EMWINProduct:
    return EMWINProduct(filename=name, emwin_id=f"{ptype}EWXTX", product_type=ptype,
                        orig="EWXTX", office="EWX", state="TX", timestamp=when, raw_text=text)


def _store(*products: EMWINProduct):
    return SimpleNamespace(_products={p.filename: p for p in products})


OLD = _product("A.TXT", NOW - timedelta(minutes=30),
               "METAR\nKAUS 131753Z 17008KT 10SM CLR 20/10 A3001=\nKSAT 131751Z 18005KT 10SM FEW040 22/12 A3002=")
NEW = _product("B.TXT", NOW - timedelta(minutes=5),
               "METAR\nKAUS 131823Z 18012G20KT 7SM BKN030 21/M01 A2998=\nKDFW 131824Z VRB03KT 1 1/2SM BR 15/14=")
STALE = _product("C.TXT", NOW - timedelta(hours=9), "METAR\nKHOU 130853Z 00000KT 10SM CLR 18/16 A3005=")


def test_newest_observation_per_station_wins():
    rs = {r.station: r for r in latest_readings(_store(OLD, NEW, STALE), now=NOW)}
    assert set(rs) == {"KAUS", "KSAT", "KDFW"}          # KHOU is too old
    aus = rs["KAUS"]
    assert aus.observed_at == datetime(2026, 11, 13, 18, 23, tzinfo=UTC)
    assert aus.values["temp_f"] == 70.0 and aus.values["dewpoint_f"] == 30.0
    assert aus.values["wind_speed_mph"] == 14.0 and aus.values["wind_gust_mph"] == 23.0
    assert aus.values["pressure_inhg"] == 29.98


def test_missing_groups_are_left_out_not_zeroed():
    dfw = {r.station: r for r in latest_readings(_store(NEW), now=NOW)}["KDFW"]
    assert "pressure_inhg" not in dfw.values     # no altimeter group
    assert "wind_dir_deg" not in dfw.values      # variable wind
    assert dfw.values["visibility_mi"] == 1.5


def test_station_filter_and_limit():
    store = _store(OLD, NEW)
    assert [r.station for r in latest_readings(store, parse_station_list("ksat, kdfw"), now=NOW)] == \
        ["KDFW", "KSAT"]
    assert len(latest_readings(store, limit=1, now=NOW)) == 1
    assert parse_station_list("  ") is None


def test_non_metar_products_are_ignored():
    zfp = _product("Z.TXT", NOW, "KAUS 131823Z 18012KT 10SM CLR 21/10 A2998", ptype="ZFP")
    assert latest_readings(_store(zfp), now=NOW) == []


# -- InfluxDB line protocol ------------------------------------------------------

def _reading(station="KAUS", **values):
    return Reading(station, datetime(2026, 11, 13, 18, 23, tzinfo=UTC), values or {"temp_f": 70.0})


def test_line_protocol_shape():
    line = to_line(_reading(temp_f=70, pressure_inhg=29.98))
    assert line == "wxguard_weather,station=KAUS pressure_inhg=29.98,temp_f=70.0 1794594180"


def test_line_protocol_escapes_tags():
    line = to_line(_reading(), extra_tags={"site": "my bot,1=x"})
    assert r"site=my\ bot\,1\=x" in line


def test_write_url_adds_second_precision_once():
    assert write_url("http://h:8086/api/v2/write?org=o&bucket=b") == \
        "http://h:8086/api/v2/write?org=o&bucket=b&precision=s"
    assert write_url("http://h:8086/write?db=wx&precision=ms").endswith("precision=ms")


def test_auth_header_forms():
    assert auth_headers("") == {}
    assert auth_headers("abc") == {"Authorization": "Token abc"}
    assert auth_headers("Bearer abc") == {"Authorization": "Bearer abc"}


async def test_push_sends_each_observation_once_and_retries_failures():
    seen: list[httpx.Request] = []
    status = {"code": 500}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status["code"], text="nope" if status["code"] >= 300 else "")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    pusher = InfluxPusher("http://influx:8086/api/v2/write?bucket=wx", "tok", client=client)
    readings = [_reading("KAUS"), _reading("KSAT")]

    assert await pusher.push(readings) == 0           # refused: kept for next round
    assert pusher.last_error.startswith("HTTP 500")
    status["code"] = 204
    assert await pusher.push(readings) == 2
    assert await pusher.push(readings) == 0           # nothing new
    assert len(seen) == 2
    req = seen[-1]
    assert req.headers["Authorization"] == "Token tok"
    assert "precision=s" in str(req.url)
    assert req.content.decode().count("\n") == 1      # two lines
    await client.aclose()


async def test_push_survives_a_network_error():
    def handler(request):
        raise httpx.ConnectError("down", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    pusher = InfluxPusher("http://influx:8086/write?db=wx", client=client)
    assert await pusher.push([_reading()]) == 0
    assert "ConnectError" in pusher.last_error
    await client.aclose()


# -- Prometheus -------------------------------------------------------------------

def test_render_exposition_text():
    text = render([_reading("KAUS", temp_f=70.0), _reading("K7R5", wind_speed_mph=5.0)],
                  {"wxguard_store_products": (12.0, "Products.")})
    assert "# TYPE wxguard_weather_temp_f gauge" in text
    assert 'wxguard_weather_temp_f{station="KAUS"} 70.0' in text
    assert 'wxguard_weather_wind_speed_mph{station="K7R5"} 5.0' in text
    assert "wxguard_weather_dewpoint_f" not in text   # no station has it
    assert 'wxguard_weather_observed_timestamp_seconds{station="KAUS"} 1794594180' in text
    assert "wxguard_store_products 12.0" in text
    assert text.endswith("\n")


async def _get(port: int, path: str, method: str = "GET") -> tuple[str, str]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(f"{method} {path} HTTP/1.1\r\nHost: x\r\n\r\n".encode())
    await writer.drain()
    data = (await reader.read()).decode()
    writer.close()
    head, _, body = data.partition("\r\n\r\n")
    return head.split("\r\n")[0], body


async def test_server_serves_metrics_on_localhost_only_path():
    server = MetricsServer(lambda: "wxguard_up 1.0\n", port=0)
    await server.start()
    try:
        assert server.host == "127.0.0.1"
        status, body = await _get(server.port, "/metrics")
        assert status.endswith("200 OK") and body == "wxguard_up 1.0\n"
        status, _ = await _get(server.port, "/")
        assert "404" in status
        status, _ = await _get(server.port, "/metrics", method="POST")
        assert "405" in status
    finally:
        await server.stop()


# -- Exporter wiring --------------------------------------------------------------

def _settings(**over):
    base = dict(metrics_influx_url="", metrics_influx_token="", metrics_prometheus_enabled=False,
                metrics_prometheus_host="127.0.0.1", metrics_prometheus_port=0, metrics_stations="",
                metrics_interval_s=60, metrics_max_age_min=180, metrics_max_stations=300)
    base.update(over)
    return SimpleNamespace(**base)


def test_off_by_default():
    from meshcore_weather.config import Settings
    s = Settings(_env_file=None)
    assert s.metrics_influx_url == "" and s.metrics_prometheus_enabled is False
    assert s.metrics_prometheus_host == "127.0.0.1"
    assert MetricsExporter.from_settings(_store(), s) is None


async def test_exporter_page_includes_bot_gauges():
    exp = MetricsExporter.from_settings(_store(NEW), _settings(metrics_prometheus_enabled=True),
                                        radio_connected=lambda: True)
    exp._max_age = timedelta(days=36500)      # fixture times are fixed, the clock is not
    page = exp.page()
    assert 'wxguard_weather_temp_f{station="KAUS"} 70.0' in page
    assert "wxguard_radio_connected 1.0" in page
    assert "wxguard_store_products 1.0" in page
    await exp.start()
    try:
        status, body = await _get(exp.server.port, "/metrics")
        assert "200" in status and "wxguard_weather_temp_f" in body
    finally:
        await exp.stop()


def test_sample_grafana_dashboard_is_valid_and_uses_exported_names():
    dash = json.loads((ROOT / "deploy/grafana/wxguard-weather-dashboard.json").read_text())
    assert dash["title"] and dash["panels"]
    exprs = json.dumps(dash)
    for name in ("wxguard_weather_temp_f", "wxguard_weather_wind_speed_mph", "wxguard_weather_pressure_inhg"):
        assert name in exprs
    assert (ROOT / "docs/METRICS_EXPORT.md").is_file()
