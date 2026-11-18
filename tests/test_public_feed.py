"""What the public bundle, the admin Satellite page and the `sat` reply say
about the feed: where the products come from, how late they are, how the
internet backup is doing, and the dashboard's public address. And what the
public bundle no longer says: keys and positions."""

import asyncio
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from meshcore_weather.config import settings
from meshcore_weather.core.render_text import MAX_DM
from meshcore_weather.emwin.fetcher import InternetSource, SDRSource
from meshcore_weather.main import WeatherBot
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.portal.routes import admin as admin_mod
from meshcore_weather.portal.server import create_app
from meshcore_weather.sdr_monitor import SdrMonitor, receiver_line
from tests.test_admin_api import FakeRadio
from tests.test_receiver_status import T, _sample


class PeerRadio(FakeRadio):
    def peer_bots(self):
        return [{"name": "WX-SAT", "public_key": "00" * 32, "lat": 29.42, "lon": -98.49}]


SINCE = datetime(2026, 10, 16, 14, 0, tzinfo=timezone.utc)


def _dish_source(tmp_path) -> SDRSource:
    """An SDR source in the middle of an outage, with a record to show: the
    internet fill filling in since SINCE."""
    src = SDRSource(root=tmp_path / "dish", fallback_root=tmp_path / "backup")
    src.fill.active_since = SINCE
    src.fill.spell_filled = 3
    src.fill.last_ok = SINCE + timedelta(minutes=20)
    src.fill.last_error = "text: 403 Forbidden at 14:30Z"
    src._lag_samples.extend((time.time() - 60, lag) for lag in (290, 300, 310, 305, 295))
    src.newest_product_ts = SINCE - timedelta(hours=5)
    return src


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "admin_key", "")
    monkeypatch.setattr(settings, "tx_enabled", False)
    monkeypatch.setattr(settings, "emwin_source", "sdr")
    monkeypatch.setattr(settings, "status_channel", "#meshwx-status")
    # On, so the spell _dish_source sets up reads as one (an off fill never
    # fills in). Nothing here polls it, so it asks NWS for nothing.
    monkeypatch.setattr(settings, "fill_enabled", True)

    async def no_dashboard(path, method="GET"):
        return {"_error": "not in this test"}

    monkeypatch.setattr(admin_mod, "_dashboard", no_dashboard)
    bot = WeatherBot()
    bot.store = WeatherStore()
    bot.radio = PeerRadio()
    bot.emwin = _dish_source(tmp_path)
    return TestClient(create_app(bot), headers={"X-Requested-With": "meshcore-portal"}), bot


def test_the_public_bundle_says_where_the_products_come_from_and_how_late(client, monkeypatch):
    c, bot = client
    monkeypatch.setattr(settings, "sdr_dashboard_url", "http://127.0.0.1:8080")
    monkeypatch.setattr(settings, "sdr_dashboard_public_url", "https://goes.example.org")
    p = c.get("/api/public/bot").json()
    feed = p["feed"]
    assert set(feed) == {"source", "lag_min", "newest_product_at", "fill", "internet"}
    assert feed["source"] == "sdr" and feed["lag_min"] == 300 and feed["internet"] is None
    assert feed["newest_product_at"] == int((SINCE - timedelta(hours=5)).timestamp())
    fill = feed["fill"]
    assert fill["active"] is True and fill["since"] == int(SINCE.timestamp())
    assert fill["reason"] == "the dish is quiet"                       # no file from the dish at all
    assert fill["last_ok"] == int((SINCE + timedelta(minutes=20)).timestamp())
    assert fill["last_error"] == "text: 403 Forbidden at 14:30Z"
    assert fill["grace_min"] == {"warnings": 2, "other": 15, "radar": 20}
    assert p["dashboard_url"] == "https://goes.example.org"
    assert p["channels"] == {"text": settings.meshcore_channel, "data": settings.meshwx_channel,
                             "status": "#meshwx-status"}

    # Not filling in, nothing on record yet: the same keys, empty.
    bot.emwin = SDRSource(root=bot.emwin.root, fallback_root=bot.emwin.fallback_root)
    fill = c.get("/api/public/bot").json()["feed"]["fill"]
    assert fill["active"] is False and fill["since"] is None and fill["last_ok"] is None
    assert fill["last_hour"] == {"issued": 0, "in_time": 0, "in_time_pct": None, "text": 0, "obs_files": 0,
                                 "obs_reports": 0, "radar": 0}


def test_the_public_bundle_gives_no_key_and_no_position(client):
    c, _ = client
    p = c.get("/api/public/bot").json()
    assert p["bot"]["name"] == "mesh-wx" and p["bot"]["connected"] is True
    for key in ("public_key", "lat", "lon"):
        assert key not in p["bot"], key
    assert p["peers"] == [{"name": "WX-SAT"}]
    assert "settings" not in p and "contacts" not in p


def test_the_admin_satellite_page_links_the_public_dashboard_and_shows_the_record(client, monkeypatch):
    c, _ = client
    monkeypatch.setattr(settings, "sdr_dashboard_url", "http://127.0.0.1:8080")
    monkeypatch.setattr(settings, "sdr_dashboard_public_url", "")
    assert c.get("/api/sdr").json()["dashboard_url"] == "http://127.0.0.1:8080"
    monkeypatch.setattr(settings, "sdr_dashboard_public_url", "https://goes.example.org")
    d = c.get("/api/sdr").json()
    assert d["dashboard_url"] == "https://goes.example.org"
    feed = d["feed"]
    assert feed["lag_min"] == 300 and feed["newest_product_at"] == int((SINCE - timedelta(hours=5)).timestamp())
    fill = feed["fill"]
    assert fill["active"] is True and fill["since"] == int(SINCE.timestamp())
    assert fill["last_error"] == "text: 403 Forbidden at 14:30Z" and fill["from_internet_last_hour"] == 0


def _internet_source(tmp_path) -> InternetSource:
    """An internet-only bot's feed after a refusal, with products running late."""
    src = InternetSource(cache_file=tmp_path / "products.jsonl")
    src.last_ok = SINCE + timedelta(minutes=20)
    src.last_error = "403 Forbidden at 14:30Z"
    src.last_error_at = SINCE + timedelta(minutes=30)
    src._lag_samples.extend((time.time() - 60, lag) for lag in (290, 300, 310, 305, 295))
    src.newest_product_ts = SINCE - timedelta(hours=5)
    return src


def test_an_internet_only_bot_says_how_its_fetches_are_doing_and_how_late(client, monkeypatch, tmp_path):
    """The source every city without a dish runs on: the lag and the newest
    product as the dish's, and its own fetches where the dish has its backup."""
    c, bot = client
    monkeypatch.setattr(settings, "emwin_source", "internet")
    bot.emwin = _internet_source(tmp_path)
    newest = int((SINCE - timedelta(hours=5)).timestamp())
    feed = c.get("/api/public/bot").json()["feed"]
    assert feed["source"] == "internet" and feed["lag_min"] == 300 and feed["newest_product_at"] == newest
    assert feed["internet"] == {"last_ok": int((SINCE + timedelta(minutes=20)).timestamp()),
                                "last_error": "403 Forbidden at 14:30Z"}
    assert feed["fill"]["reason"] == "EMWIN is running 5 h 00 min late"   # the same fill, over NOAA's bundles
    feed = c.get("/api/sdr").json()["feed"]
    assert feed["source"] == "internet" and feed["fill"] is not None
    assert feed["lag_min"] == 300 and feed["newest_product_at"] == newest
    assert feed["internet"] == {"last_ok": int((SINCE + timedelta(minutes=20)).timestamp()),
                                "last_error": "403 Forbidden at 14:30Z"}
    # Nothing fetched yet: the same keys, empty.
    bot.emwin = InternetSource(cache_file=tmp_path / "products.jsonl")
    feed = c.get("/api/public/bot").json()["feed"]
    assert (feed["lag_min"], feed["newest_product_at"], feed["internet"]) == (None, None, {"last_ok": None, "last_error": None})
    # The dish's bundle has no `internet` object.
    monkeypatch.setattr(settings, "emwin_source", "sdr")
    assert c.get("/api/sdr").json()["feed"]["internet"] is None


def test_the_public_dashboard_address_can_be_set_from_the_portal(client, monkeypatch):
    c, _ = client
    monkeypatch.setattr(admin_mod, "_write_env", lambda updates: None)
    monkeypatch.setattr(settings, "sdr_dashboard_public_url", "")
    r = c.post("/api/settings/env", json={"MCW_SDR_DASHBOARD_PUBLIC_URL": "goes.example.org"})
    assert r.status_code == 400
    r = c.post("/api/settings/env", json={"MCW_SDR_DASHBOARD_PUBLIC_URL": "https://goes.example.org",
                                      "MCW_FILL_GRACE_MIN": "20", "MCW_FILL_ENABLED": "true", "MCW_STATUS_CHANNEL": "#meshwx-status"})
    assert r.status_code == 200, r.text
    assert settings.dashboard_link == "https://goes.example.org" and settings.fill_grace_min == 20
    assert settings.fill_enabled is True
    assert c.post("/api/settings/env", json={"MCW_STATUS_CHANNEL": "status"}).status_code == 400


# -- the `sat` reply -----------------------------------------------------------------


def test_the_sat_line_counts_only_the_dishs_files_and_says_how_far_behind():
    s = _sample()
    s["status"]["latest_emwin"] = [
        {"name": "A_FROM_INET.TXT", "src": "net", "mtime": int(T) - 5},
        {"name": "A_FROM_DISH.TXT", "src": "sat", "mtime": int(T) - 900},
    ]
    line = receiver_line(s, T, T)
    assert line.endswith("newest EMWIN 15m ago") and "5s" not in line
    assert receiver_line(s, T, T, lag_min=29).endswith("newest EMWIN 15m ago")
    assert receiver_line(s, T, T, lag_min=45).endswith("newest EMWIN 15m ago, products ~45m behind")
    assert receiver_line(s, T, T, lag_min=300).endswith("newest EMWIN 15m ago, products ~5h behind")
    assert receiver_line(s, T, T, lag_min=119).endswith("products ~119m behind")
    # The suffix rides along when the receiver is not reporting, too.
    assert receiver_line(None, None, T, emwin_mtime=T - 20, lag_min=600) == \
        "GOES receiver not reporting (no dashboard reading), newest EMWIN 20s ago, products ~10h behind"
    long = _sample(vit=700)
    long["status"]["services"]["goesproc"] = "failed"
    assert len(receiver_line(long, T, T, lag_min=600)) <= MAX_DM
    # A dashboard that does not tag its entries is the dish.
    assert receiver_line(_sample(), T, T).endswith("newest EMWIN 12s ago")


def test_the_sat_reply_passes_the_lag_through():
    bot = WeatherBot()
    bot._sdr_monitor = SdrMonitor("http://127.0.0.1:1")
    now = time.time()
    bot._sdr_monitor.observe(_sample(t=now), now=now)
    bot.emwin = SimpleNamespace(newest_mtime=None, feed_lag_min=300, fill=SimpleNamespace(active_since=None))
    line = bot._process_command("sat", "")
    assert line.startswith("GOES locked 13h47m") and line.endswith(", products ~5h behind")
    bot.emwin = SimpleNamespace(newest_mtime=None, feed_lag_min=None, fill=SimpleNamespace(active_since=SINCE))
    assert bot._process_command("sat", "").endswith("Internet filling in since 14:00Z")


def test_the_monitor_tells_the_status_channel_what_every_poll_found():
    """poll() hands the sample, or the failure, to the reporter with the feed."""
    seen = []

    class Reporter:
        async def tick(self, now, state, reachable, feed=None):
            seen.append((state is not None, reachable, feed))

    class Resp:
        def __init__(self, state):
            self._state = state

        def raise_for_status(self):
            pass

        def json(self):
            return self._state

    class Client:
        def __init__(self):
            self.up = True

        async def get(self, url):
            if not self.up:
                raise OSError("connection refused")
            return Resp(_sample())

    feed = object()
    m = SdrMonitor("http://127.0.0.1:1", status=Reporter(), feed=feed)
    client = Client()
    asyncio.run(m.poll(client))
    client.up = False
    asyncio.run(m.poll(client))
    assert seen == [(True, True, feed), (False, False, feed)]
    assert m.report().startswith("GOES locked")          # a failed poll leaves the last good sample


def test_the_sat_reply_stays_one_message_in_an_outage():
    """Locked, goesproc failed (so no files, so the fill filling in) and the
    products hours behind: the longest `sat` there is. It loses the packet
    count rather than spill onto a second page."""
    bot = WeatherBot()
    bot._sdr_monitor = SdrMonitor("http://127.0.0.1:1")
    s = _sample(vit=700)
    s["status"]["services"]["goesproc"] = "failed"
    bot._sdr_monitor.observe(s, now=time.time())
    bot.emwin = SimpleNamespace(newest_mtime=None, feed_lag_min=600, fill=SimpleNamespace(active_since=SINCE))
    line = bot._process_command("sat", "")
    assert len(line) <= min(MAX_DM, bot.page_budget())
    assert "dropped" not in line and "goesproc failed" in line and "products ~10h behind" in line
    assert line.endswith("Internet filling in since 14:00Z")
    # With room to spare, the count stays.
    bot.emwin = SimpleNamespace(newest_mtime=None, feed_lag_min=None, fill=None)
    assert "dropped 0 of 3360 packets last min" in bot._process_command("sat", "")
