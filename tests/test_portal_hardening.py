"""Portal hardening (phase 1, item 5), the radio region guard (item 6) and
the identity checks (item 7).

The portal binds 127.0.0.1 by default and answers only a Host it knows, so a
DNS-rebinding page cannot reach it; the Pi's dashboard (Host 127.0.0.1:8081)
and an SSH tunnel (Host localhost:8081) still do. A frequency outside
MCW_RADIO_REGION's band is refused everywhere, and a node found on one at
start has transmit switched off. A node name off WX-<IATA> is a warning; an
admin key under 8 hex characters is refused.
"""

import asyncio
import json
import socket
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from meshcore_weather import config
from meshcore_weather.config import Settings, settings
from meshcore_weather.geodata import resolver
from meshcore_weather.main import WeatherBot
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.portal.server import HostCheck, PortalServer, create_app, host_of
from meshcore_weather.protocol import coverage as cov_mod

ROOT = Path(__file__).resolve().parent.parent


class FakeRadio:
    def __init__(self, freq=910.525, name="WX-TST", connected=True):
        self.connected = connected
        self.channel_idx = self.data_channel_idx = 1
        self.params = {"radio_freq": freq, "radio_bw": 62.5, "radio_sf": 7, "radio_cr": 5, "tx_power": 22}
        self._mc = MagicMock()
        self._mc.self_info = {"name": name, "public_key": "ab" * 32, **self.params}
        self.set_calls = []
        self.adverts = 0

    def band_problem(self):
        return config.frequency_problem(self.params["radio_freq"], self.params["radio_bw"])

    async def info(self):
        return {"name": self._mc.self_info["name"], **self.params}

    async def list_channels(self):
        return []

    def peer_bots(self):
        return []

    async def set_radio_params(self, f, bw, sf, cr):
        self.set_calls.append((f, bw, sf, cr))
        self.params.update({"radio_freq": f, "radio_bw": bw})

    async def advert_now(self, flood=True):
        self.adverts += 1
        return settings.tx_enabled


@pytest.fixture
def bot(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)                 # .env writes land in a temp dir
    for key in ("tx_enabled", "radio_region", "portal_host", "portal_allowed_hosts", "home_cities", "timezone",
                "admin_key"):
        monkeypatch.setattr(settings, key, getattr(settings, key))
    monkeypatch.setattr(config, "_tz_from_home", config._tz_from_home)
    monkeypatch.setattr(settings, "tx_enabled", False)
    resolver.load()
    monkeypatch.setattr(resolver, "_home", resolver._home)
    cov_mod.forget_config_build()
    b = WeatherBot()
    b.store = WeatherStore()
    b.radio = FakeRadio()
    yield b
    cov_mod.forget_config_build()


def _client(bot, base="http://127.0.0.1:8081", hosts=None):
    app = create_app(bot, allowed_hosts=config.portal_allowed_hosts() if hosts is None else hosts)
    return TestClient(app, base_url=base, headers={"X-Requested-With": "meshcore-portal"})


# -- Bind address and Host check ------------------------------------------------------


def test_the_portal_binds_localhost_by_default():
    assert Settings.model_fields["portal_host"].default == "127.0.0.1"


@pytest.mark.parametrize("header,host", [("127.0.0.1:8081", "127.0.0.1"), ("localhost:8081", "localhost"),
                                         ("[::1]:8081", "[::1]"), ("LocalHost", "localhost"),
                                         ("evil.example:80", "evil.example")])
def test_host_of(header, host):
    assert host_of(header) == host


@pytest.mark.parametrize("host", ["127.0.0.1:8081",   # the Pi's dashboard (BOT_URL)
                                  "localhost:8081",   # an SSH tunnel: ssh -L 8081:127.0.0.1:8081
                                  "[::1]:8081",
                                  "localhost:8080"])  # docker-compose's 127.0.0.1:8080
def test_local_names_are_answered(bot, host):
    c = _client(bot)
    assert c.get("/api/public/bot?n=5", headers={"Host": host}).status_code == 200
    assert c.get("/api/system", headers={"Host": host}).status_code == 200


def test_any_other_host_is_refused_before_a_route_runs(bot):
    c = _client(bot, "http://attacker.example")
    assert c.get("/api/system").status_code == 400
    r = c.post("/api/radio/tx", json={"enabled": True})
    assert r.status_code == 400 and not settings.tx_enabled


def test_extra_names_come_from_the_setting_and_a_specific_bind(bot, monkeypatch):
    monkeypatch.setattr(settings, "portal_allowed_hosts", "mesh-wx.local, Pi.Example ")
    monkeypatch.setattr(settings, "portal_host", "10.0.0.51")
    hosts = config.portal_allowed_hosts()
    assert {"mesh-wx.local", "pi.example", "10.0.0.51", "localhost"} <= set(hosts)
    for base in ("http://mesh-wx.local:8081", "http://pi.example", "http://10.0.0.51:8081"):
        assert _client(bot, base).get("/api/system").status_code == 200
    monkeypatch.setattr(settings, "portal_host", "0.0.0.0")
    assert "0.0.0.0" not in config.portal_allowed_hosts()


def test_the_xhr_guard_still_applies_to_a_good_host(bot):
    bare = TestClient(create_app(bot, allowed_hosts=config.portal_allowed_hosts()), base_url="http://127.0.0.1:8081")
    assert bare.post("/api/radio/tx", json={"enabled": True}).status_code == 403


def test_the_server_always_builds_the_app_with_the_host_check(bot):
    app = PortalServer(bot).build_app()
    assert any(m.cls is HostCheck for m in app.user_middleware)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.asyncio
async def test_a_real_server_answers_the_dashboard_and_a_tunnel_and_nobody_else(bot, monkeypatch):
    """Over TCP, as deploy/goes-dashboard/dashboard.py asks (urllib, Host
    127.0.0.1:8081) and as a browser on the far end of an SSH tunnel asks
    (Host localhost:<port>); a rebinding page's Host gets 400."""
    port = _free_port()
    monkeypatch.setattr(settings, "portal_host", "127.0.0.1")
    monkeypatch.setattr(settings, "portal_port", port)
    server = PortalServer(bot)
    await server.start()
    try:
        for _ in range(100):
            if server._server is not None and server._server.started:
                break
            await asyncio.sleep(0.05)

        def fetch(url, host=None):
            req = urllib.request.Request(url, headers={"Host": host} if host else {})
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, None

        status, body = await asyncio.to_thread(fetch, f"http://127.0.0.1:{port}/api/public/bot?n=60")
        assert status == 200 and "bot" in body
        status, _ = await asyncio.to_thread(fetch, f"http://127.0.0.1:{port}/api/public/bot", f"localhost:{port}")
        assert status == 200
        status, _ = await asyncio.to_thread(fetch, f"http://127.0.0.1:{port}/api/system", "rebind.attacker.example")
        assert status == 400
    finally:
        await server.stop()


def test_compose_publishes_on_localhost_and_binds_all_inside_the_container():
    text = (ROOT / "docker-compose.yml").read_text()
    assert '"127.0.0.1:8080:8080"' in text and '"8080:8080"' not in text.replace('"127.0.0.1:8080:8080"', "")
    assert "MCW_PORTAL_HOST=0.0.0.0" in text and "MCW_PORTAL_PORT=8080" in text


# -- Radio region ---------------------------------------------------------------------


@pytest.mark.parametrize("freq,bw,region,ok", [
    (910.525, 62.5, "US", True), (910.525, 250, "US", True), (902.1, 125, "US", True),
    (869.525, 62.5, "US", False), (927.9, 500, "US", False), (868.0, 62.5, "us", False),
    (869.525, 62.5, "EU", True), (910.525, 62.5, "EU", False), (910.525, 62.5, "MARS", False)])
def test_frequency_problem(freq, bw, region, ok):
    assert (config.frequency_problem(freq, bw, region) is None) == ok


@pytest.mark.asyncio
async def test_the_radio_refuses_an_out_of_band_frequency(monkeypatch):
    from meshcore_weather.meshcore.radio import MeshcoreRadio
    monkeypatch.setattr(settings, "radio_region", "US")
    r = MeshcoreRadio()
    r._mc = MagicMock()
    r._running = True
    r._mc.self_info = {}
    r._mc.commands.set_radio = AsyncMock()
    with pytest.raises(ValueError, match="outside the US band"):
        await r.set_radio_params(869.525, 62.5, 7, 5)
    r._mc.commands.set_radio.assert_not_awaited()
    from meshcore import EventType
    r._mc.commands.set_radio = AsyncMock(return_value=MagicMock(type=EventType.OK))
    await r.set_radio_params(910.525, 62.5, 7, 5)                    # WX-AUS's own: still fine
    assert r._mc.self_info["radio_freq"] == 910.525 and r.band_problem() is None


def test_portal_offers_only_the_regions_presets_and_refuses_the_rest(bot, monkeypatch):
    c = _client(bot)
    d = c.get("/api/radio").json()
    assert set(d["presets"]) == {"us_meshcore", "us_wide"} and d["radio_region"] == "US"
    assert c.post("/api/radio/params", json={"preset": "eu_meshcore"}).status_code == 400
    r = c.post("/api/radio/params", json={"freq_mhz": 869.525, "bw_khz": 62.5, "sf": 7, "cr": 5})
    assert r.status_code == 400 and "outside the US band" in r.json()["detail"]
    assert c.post("/api/radio/params", json={"preset": "us_meshcore"}).json()["freq_mhz"] == 910.525
    assert bot.radio.set_calls == [(910.525, 62.5, 7, 5)]
    monkeypatch.setattr(settings, "radio_region", "EU")
    assert set(c.get("/api/radio").json()["presets"]) == {"eu_meshcore"}


def test_transmit_cannot_be_switched_on_out_of_band(bot):
    bot.radio = FakeRadio(freq=869.525)
    c = _client(bot)
    r = c.post("/api/radio/tx", json={"enabled": True})
    assert r.status_code == 400 and not settings.tx_enabled and bot.radio.adverts == 0
    assert c.post("/api/settings/env", json={"MCW_TX_ENABLED": "true"}).status_code == 400
    assert not settings.tx_enabled
    bot.radio = FakeRadio(freq=910.525)
    assert c.post("/api/radio/tx", json={"enabled": True}).json()["tx_enabled"] and settings.tx_enabled


def _connected_radio(freq, name):
    from meshcore_weather.meshcore.radio import MeshcoreRadio
    r = MeshcoreRadio()
    r._mc = MagicMock()
    r._mc.self_info = {"name": name, "public_key": "ab" * 32, "radio_freq": freq, "radio_bw": 62.5}
    return r


def test_a_node_found_out_of_band_has_transmit_switched_off(monkeypatch, caplog):
    monkeypatch.setattr(settings, "tx_enabled", True)
    monkeypatch.setattr(settings, "radio_region", "US")
    r = _connected_radio(869.525, "WX-AUS")
    r._check_identity_and_band()
    assert not settings.tx_enabled and "outside the US band" in r.region_problem
    assert any(rec.levelname == "ERROR" for rec in caplog.records)


def test_wx_aus_on_its_own_band_keeps_transmitting(monkeypatch, caplog):
    monkeypatch.setattr(settings, "tx_enabled", True)
    monkeypatch.setattr(settings, "radio_region", "US")
    r = _connected_radio(910.525, "WX-AUS")
    r._check_identity_and_band()
    assert settings.tx_enabled and r.region_problem is None and r.name_problem is None
    assert not [rec for rec in caplog.records if rec.levelname in ("WARNING", "ERROR")]


# -- Identity ---------------------------------------------------------------------------


@pytest.mark.parametrize("name,ok", [("WX-AUS", True), ("WX-SJU", True), ("WX-AB", True), ("WX-ABCDEFGH", True),
                                     ("WX-A", False), ("WX-ABCDEFGHI", False), ("wx-aus", False),
                                     ("Weather Bot", False), ("WX_AUS", False), ("", False), (None, False)])
def test_node_name_convention(name, ok):
    assert (config.node_name_problem(name) is None) == ok


def test_a_node_name_off_the_convention_is_logged_and_shown(bot, monkeypatch, caplog):
    monkeypatch.setattr(settings, "radio_region", "US")
    r = _connected_radio(910.525, "My Weather Node")
    r._check_identity_and_band()
    assert r.name_problem and any("WX-<IATA>" in rec.getMessage() for rec in caplog.records)
    bot.radio = FakeRadio(name="My Weather Node")
    probs = _client(bot).get("/api/overview").json()["problems"]["config"]
    assert any("WX-<IATA>" in p["text"] and p["level"] == "warning" for p in probs)


@pytest.mark.parametrize("key,kept", [("", ""), ("abc", ""), ("abcdef0", ""), ("zz12345678", ""),
                                      ("abcdef01", "abcdef01"), ("0123456789AB", "0123456789AB")])
def test_a_short_or_non_hex_admin_key_is_refused(key, kept):
    s = Settings(admin_key=key, _env_file=None)
    assert s.admin_key == kept
    assert bool(s.rejected) == (bool(key) and not kept)


def test_a_refused_admin_key_matches_nobody(monkeypatch):
    s = Settings(admin_key="ab", _env_file=None)
    monkeypatch.setattr(settings, "admin_key", s.admin_key)
    assert not WeatherBot()._is_admin("ab1234567890")


# -- The live home city -------------------------------------------------------------------


def test_a_live_home_change_moves_the_resolver_home_and_the_derived_zone(bot, monkeypatch):
    monkeypatch.setattr(settings, "home_cities", "Austin TX")
    monkeypatch.setattr(settings, "timezone", "")
    monkeypatch.setattr(config, "_tz_from_home", False)
    config.fill_timezone()
    c = _client(bot)
    r = c.post("/api/settings/env", json={"MCW_HOME_CITIES": "Denver CO"})
    assert r.status_code == 200 and "MCW_HOME_CITIES" in r.json()["applied"]
    assert abs(resolver.home()[0] - 39.74) < 0.05
    assert settings.timezone == "America/Denver"
    cov = c.get("/api/system").json()["coverage"]
    assert cov["home"] == "Denver, CO" and not cov["blocked"]


def test_a_home_city_that_does_not_resolve_never_reaches_env(bot, tmp_path):
    c = _client(bot)
    r = c.post("/api/settings/env", json={"MCW_HOME_CITIES": "Austin"})
    assert r.status_code == 400 and "ambiguous" in r.json()["detail"]
    assert c.post("/api/settings/env", json={"MCW_HOME_STATES": "TXX"}).status_code == 400
    assert c.post("/api/settings/env", json={"MCW_TIMEZONE": "Mars/Olympus"}).status_code == 400
    assert not (tmp_path / ".env").exists()


def test_operator_contact_is_writable_and_capped(bot, tmp_path):
    c = _client(bot)
    assert c.post("/api/settings/env", json={"MCW_OPERATOR_CONTACT": "x" * 101}).status_code == 400
    r = c.post("/api/settings/env", json={"MCW_OPERATOR_CONTACT": "ops@example.org"}).json()
    assert r["restart_needed"] == ["MCW_OPERATOR_CONTACT"]
    assert "MCW_OPERATOR_CONTACT=ops@example.org" in (tmp_path / ".env").read_text()


def test_the_scheduled_ceiling_is_a_limits_row_and_a_live_setting(bot, monkeypatch):
    from meshcore_weather.protocol.broadcaster import AppResponder
    monkeypatch.setattr(settings, "scheduled_packets_per_hour", settings.scheduled_packets_per_hour)
    radio = MagicMock()
    radio.send_channel_data = AsyncMock(return_value=True)
    bot._broadcaster = AppResponder(WeatherStore(), radio)
    c = _client(bot)
    rows = {r["id"]: r for r in c.get("/api/limits").json()["rows"]}
    assert rows["scheduled"]["cap"] == 120 and rows["scheduled"]["state"] == "ready"
    assert c.post("/api/settings/env", json={"MCW_SCHEDULED_PACKETS_PER_HOUR": "0"}).status_code == 400
    assert c.post("/api/settings/env", json={"MCW_SCHEDULED_PACKETS_PER_HOUR": "60"}).json()["applied"]
    assert settings.scheduled_packets_per_hour == 60
    bot._broadcaster.scheduler._sched_sent.extend([1e12] * 60)       # spent (stamped in the future: stays)
    row = {r["id"]: r for r in c.get("/api/limits").json()["rows"]}["scheduled"]
    assert row["state"] == "spent" and row["resettable"]
    assert c.post("/api/limits/reset", json={"id": "scheduled"}).json()["ok"]
    assert not bot._broadcaster.scheduler._sched_sent
