"""Request/reply traffic: what the bot records, what the public view hides,
the counters, and the portal endpoints that serve them."""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from meshcore_weather.config import settings
from meshcore_weather.main import WeatherBot
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.portal.server import create_app
from meshcore_weather.traffic import TrafficLog, traffic_log
from tests.test_admin_api import FakeRadio
from tests.test_console import ChannelFakeRadio


@pytest.fixture
def bot(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "tx_enabled", True)
    monkeypatch.setattr(settings, "reply_mode", "dm")
    monkeypatch.setattr(settings, "channel_reply_max_hops", 2)
    monkeypatch.setattr(settings, "admin_key", "")
    from meshcore_weather.geodata import resolver
    resolver.load()
    resolver.set_home(30.27, -97.74)
    traffic_log._path = None
    traffic_log._events.clear()
    traffic_log._tally.clear()
    b = WeatherBot()
    b.store = WeatherStore()
    b.radio = ChannelFakeRadio()
    return b


def _kinds(events):
    return [e["kind"] for e in events]


def test_channel_request_and_reply_are_logged_and_counted(bot):
    before = traffic_log.lifetime["replies"]
    asyncio.run(bot._handle_channel_message("1", "Stranger", "help", 1))
    ev = traffic_log.recent(10)
    assert _kinds(ev)[-2:] == ["channel_in", "reply_channel"]
    req, rep = ev[-2], ev[-1]
    assert req["sender"] == "Stranger" and req["text"] == "help" and req["command"] == "help" and req["hops"] == 1
    assert rep["req_id"] == req["id"] and rep["ms"] is not None and 0 < rep["chars"] <= 147
    assert rep["text"] == bot.radio.channel_sent[0][1]
    st = traffic_log.stats()
    w = st["windows"]["1h"]
    assert w["requests"] >= 1 and w["channel_replies"] >= 1 and w["senders"] >= 1
    assert st["lifetime"]["replies"] == before + 1 and st["lifetime"]["by_command"].get("help", 0) >= 1
    assert st["latency"]["median_ms"] is not None and st["last_reply_at"] >= st["last_request_at"]


def test_dm_replies_are_redacted_on_the_public_view(bot):
    bot.radio.contacts["Tommy"] = {"public_key": "ab" * 32, "adv_name": "Tommy"}
    asyncio.run(bot._handle_channel_message("1", "Tommy", "help"))
    admin = traffic_log.recent(2)
    assert _kinds(admin) == ["channel_in", "reply_dm"]
    assert admin[1]["sender"] == "Tommy" and admin[1]["text"] and admin[1]["key"] == "ab" * 6
    public = traffic_log.recent(2, public=True)
    assert public[0]["sender"] == "Tommy" and public[0]["text"] == "help"      # channel text is public
    assert public[1]["sender"] is None and public[1]["text"] is None            # a DM is not
    assert public[1]["command"] == "help" and public[1]["chars"] == admin[1]["chars"]
    assert "key" not in public[1]


def test_direct_dm_is_private_but_counted(bot):
    asyncio.run(bot._handle_dm("ab" * 32, "Tommy", "help"))
    admin = traffic_log.recent(2)
    assert _kinds(admin) == ["dm_in", "reply_dm"] and admin[0]["text"] == "help" and admin[0]["command"] == "help"
    public = traffic_log.recent(2, public=True)
    assert public[0]["sender"] is None and public[0]["text"] is None and public[0]["command"] == "help"
    assert traffic_log.stats()["windows"]["1h"]["dm_replies"] >= 1


def test_drops_carry_their_reason(bot):
    asyncio.run(bot._handle_channel_message("1", "Far", "help", 5))
    d = traffic_log.recent(1)[0]
    assert d["kind"] == "dropped" and "5 hops" in d["reason"] and d["sender"] == "Far"
    asyncio.run(bot._handle_channel_message("1", "Far", "help", 5))       # 5 s rate limit first
    assert traffic_log.recent(1)[0]["reason"] == "rate limit"
    monkey_mode = settings.reply_mode
    try:
        settings.reply_mode = "dm_only"
        bot._rate_limit.clear()
        asyncio.run(bot._handle_channel_message("1", "Far", "help", 0))
        assert "dm_only" in traffic_log.recent(1)[0]["reason"]
    finally:
        settings.reply_mode = monkey_mode
    assert traffic_log.stats()["windows"]["1h"]["dropped"] >= 3


def test_admin_and_console_traffic_never_reach_the_public_view(bot, monkeypatch):
    monkeypatch.setattr(settings, "admin_key", "ab" * 6)
    bot.radio.stats = None
    asyncio.run(bot._handle_dm("ab" * 32, "Admin", "admin"))
    traffic_log.record("console", sender="console:1.2.3.4", text="wx austin", command="wx", location="austin",
                       chars=100, transport="console")
    admin = traffic_log.recent(20)
    assert "console" in _kinds(admin)
    assert all(e["kind"] not in ("admin", "console") for e in traffic_log.recent(20, public=True))


def test_admin_command_is_not_counted_as_a_request(bot, monkeypatch):
    monkeypatch.setattr(settings, "admin_key", "ab" * 6)
    before = traffic_log.lifetime["requests"]
    asyncio.run(bot._handle_dm("ab" * 32, "Admin", "admin"))
    ev = traffic_log.recent(3)
    assert any(e["kind"] == "admin" and e["command"] == "admin" for e in ev)
    assert traffic_log.lifetime["requests"] == before
    assert all(e["kind"] != "admin" for e in traffic_log.recent(3, public=True))


def test_peer_bots_and_adverts_are_logged(bot):
    asyncio.run(bot._handle_channel_message("1", "WX-SAT", "Round Rock, TX: 91F", 0))
    asyncio.run(bot._handle_advert("Newcomer", "cd" * 6))
    ev = traffic_log.recent(2)
    assert _kinds(ev) == ["peer", "advert"] and ev[0]["sender"] == "WX-SAT" and ev[1]["sender"] == "Newcomer"
    assert bot.radio.channel_sent == [] and bot.radio.dms == []


def test_lifetime_counters_survive_a_restart(tmp_path):
    p = tmp_path / "traffic_stats.json"
    t = TrafficLog(path=p)
    req = t.record("channel_in", sender="A", text="help", command="help")
    t.record("reply_channel", text="x" * 50, chars=50, req=req)
    t.record("dropped", reason="rate limit", req=req)
    t.flush(force=True)
    t2 = TrafficLog(path=p)
    assert t2.lifetime["requests"] == 1 and t2.lifetime["replies"] == 1 and t2.lifetime["dropped"] == 1
    assert t2.lifetime["chars_sent"] == 50 and t2.lifetime["by_command"] == {"help": 1}
    assert t2.lifetime["since"] == t.lifetime["since"]
    p.write_text("{not json")
    assert TrafficLog(path=p).lifetime["requests"] == 0      # corrupt file: start over, no crash


def test_windows_latency_and_the_feed_survive_a_restart(tmp_path):
    """After a restart the dashboard read 0 requests · 24 h and no median
    while the lifetime count stood: only `lifetime` was saved."""
    p = tmp_path / "traffic_stats.json"
    t = TrafficLog(path=p)
    req = t.record("channel_in", sender="A", text="wx austin", command="wx")
    t.record("reply_channel", text="Austin TX: 91F", chars=14, req=req)
    dm = t.record("dm_in", sender="Tommy", key="ab" * 6, text="wx my house", command="wx")
    t.record("reply_dm", text="Kyle TX: 88F", chars=12, req=dm)
    t.flush(force=True)

    t2 = TrafficLog(path=p)
    st = t2.stats()
    assert st["windows"]["24h"]["requests"] == 2 and st["windows"]["7d"]["replies"] == 2
    assert st["windows"]["24h"]["senders"] == 2 and st["latency"]["median_ms"] is not None
    public = t2.recent(10, public=True)
    assert _kinds(public) == ["channel_in", "reply_channel", "dm_in", "reply_dm"]
    assert public[0]["text"] == "wx austin" and public[2]["text"] is None and public[2]["command"] == "wx"
    saved = (tmp_path / "traffic_recent.json").read_text()
    assert "wx my house" not in saved and "Kyle TX" not in saved             # DM text never reaches disk
    assert t2.recent(10)[2]["sender"] == "Tommy" and t2.recent(10)[2]["text"] is None
    assert t2.record("channel_in", sender="B", text="help")["id"] > public[-1]["id"]   # since_id still works

    (tmp_path / "traffic_recent.json").write_text("[1, 2")
    t3 = TrafficLog(path=p)
    assert t3.stats()["windows"]["24h"]["requests"] == 0 and t3.lifetime["requests"] == 3


def test_help_is_the_same_line_by_dm_and_on_the_channel(bot):
    # The channel's used to end "DM me for private replies"; the public page's
    # address took its place (owner, 2026-10-19).
    from meshcore_weather.main import help_text
    asyncio.run(bot._handle_dm("ab" * 32, "Tommy", "help"))
    dm = bot.radio.dms[-1][1]
    assert dm.startswith("Weather bot:") and "DM me" not in dm
    asyncio.run(bot._handle_channel_message("1", "Stranger", "help", 1))
    assert bot.radio.channel_sent[-1][1].endswith(help_text()) and dm == help_text()


def test_unknown_kind_is_refused():
    with pytest.raises(ValueError):
        TrafficLog().record("bogus")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "admin_key", "")
    monkeypatch.setattr(settings, "tx_enabled", False)
    traffic_log._path = None
    bot = WeatherBot()
    bot.store = WeatherStore()
    bot.radio = FakeRadio()
    return TestClient(create_app(bot), headers={"X-Requested-With": "meshcore-portal"}), bot


def test_traffic_and_public_endpoints(client):
    c, bot = client
    req = traffic_log.record("dm_in", sender="Tommy", key="ab" * 6, text="wx austin", command="wx", location="austin")
    traffic_log.record("reply_dm", text="Austin TX: 91F", chars=14, req=req, ok=True)
    d = c.get("/api/traffic?n=5").json()
    assert d["events"][-1]["kind"] == "reply_dm" and d["events"][-1]["sender"] == "Tommy"
    assert "windows" in d["stats"] and "dm_in" in d["kinds"]
    assert c.get("/api/traffic?n=5&kinds=dm_in").json()["events"][-1]["kind"] == "dm_in"
    last = d["events"][-1]["id"]
    assert c.get(f"/api/traffic?since_id={last}").json()["events"] == []

    p = c.get("/api/public/bot").json()
    assert p["bot"]["name"] == "mesh-wx" and p["radio"]["preset"] == "US MeshCore default"
    assert p["channels"]["text"] == settings.meshcore_channel
    assert any(cmd["cmd"].startswith("wx") for cmd in p["commands"]) and "wx" in p["help"]
    assert "settings" not in p and "contacts" not in p
    rep = p["recent"][-1]
    assert rep["kind"] == "reply_dm" and rep["sender"] is None and rep["text"] is None and "key" not in rep
    # No portal header needed: this is the read-only bundle the public page proxies.
    assert TestClient(create_app(bot)).get("/api/public/bot").status_code == 200


def test_an_app_request_counts_as_a_request_and_its_answer_as_an_app_reply(tmp_path):
    # 2026-10-18: a day of the iOS app asking read "1 request, 40 replies, 39 by
    # DM" on the public page, the last request "21 h ago".
    t = TrafficLog(path=tmp_path / "traffic.json")
    req = t.record("data_request", sender="Digitaino", key="cc62182a79ed", text=">o KATT")
    t.record("reply_data", text="1 packet(s), 21 B", chars=21, req=req)
    chat = t.record("channel_in", sender="KJ5GFX", text="wx austin", command="wx")
    t.record("reply_channel", text="x" * 40, chars=40, req=chat)
    st = t.stats()
    w = st["windows"]["24h"]
    assert (w["requests"], w["replies"], w["senders"]) == (2, 2, 2)
    assert (w["app_replies"], w["channel_replies"], w["dm_replies"]) == (1, 1, 0)
    assert st["lifetime"]["requests"] == 2
    assert st["last_request_at"] is not None
