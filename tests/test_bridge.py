"""The debug bridge: the datagram feed, the request path, and the gate.

The app in the simulator is a client of the real bot through these: what
went on the air arrives on the feed, a `>` request goes through the same
`AppResponder.handle_request` a DM does, and neither is reachable unless
the portal is on and a token is set.
"""

import asyncio

import pytest
from fastapi.testclient import TestClient
from meshcore import EventType

from meshcore_weather.bridge import DatagramFeed, datagram_feed
from meshcore_weather.config import settings
from meshcore_weather.main import WeatherBot
from meshcore_weather.meshcore.delivery import delivery_tracker
from meshcore_weather.meshcore.radio import MeshcoreRadio
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.portal.server import create_app
from meshcore_weather.protocol import v5
from meshcore_weather.protocol.broadcaster import PER_HOUR, AppResponder

TOKEN = "s3cr3t-bridge-token"
SECRET = bytes(range(16))


@pytest.fixture(autouse=True)
def _empty_feed():
    """The feed is a module singleton; every test starts with it empty."""
    datagram_feed.reset()
    yield
    datagram_feed.reset()


# -- A bot whose radio really reaches send_channel_data ----------------------


class _Res:
    def __init__(self, ok=True):
        self.type = EventType.OK if ok else EventType.ERROR
        self.payload = None if ok else "nope"


class _Commands:
    """The companion node: it takes frames and reports its channel."""

    def __init__(self):
        self.frames = []

    async def get_channel(self, idx):
        ev = _Res()
        ev.type = EventType.CHANNEL_INFO
        ev.payload = {"channel_name": "#meshwx", "channel_secret": SECRET}
        return ev

    async def send(self, frame, expect):
        self.frames.append(bytes(frame))
        return _Res()


class _MC:
    def __init__(self):
        self.commands = _Commands()
        self.self_info = {"name": "WX-AUS", "public_key": "7a4c" + "00" * 30}


def _radio(monkeypatch):
    """A real MeshcoreRadio — the hook under test is inside it — with a fake
    node underneath and the retransmit task stubbed so resends are manual."""
    monkeypatch.setattr(settings, "tx_enabled", True)
    r = MeshcoreRadio()
    r._mc = _MC()
    r._channel_idx = r._data_channel_idx = 1
    r._channel_secrets = {}
    tracked = []
    monkeypatch.setattr(delivery_tracker, "track", tracked.append)
    return r, tracked


def _responder(monkeypatch):
    import meshcore_weather.schedule.scheduler as sched_mod
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    radio, tracked = _radio(monkeypatch)
    return AppResponder(WeatherStore(), radio), radio, tracked


# -- 1. The hook: every transmitted datagram, exactly once -------------------


async def test_the_feed_carries_the_stamped_bytes_once_per_transmission(monkeypatch):
    """The feed's bytes are what the radio was handed: the seq Scheduler
    stamped, not the builder's scratch number."""
    r, radio, tracked = _responder(monkeypatch)
    monkeypatch.setattr(r.scheduler, "_next_seq", 77)

    assert (await r.handle_request(">cov", "a")).startswith("1 packet(s), ")

    items = datagram_feed.since()
    assert len(items) == 1                                    # one transmission, one frame
    on_air = radio._mc.commands.frames[0][5:]                 # [62][idx][0xFF][type LE] + data
    assert bytes.fromhex(items[0].hex) == on_air
    assert items[0].data_type == 0xFF10 and items[0].length == len(on_air)
    assert items[0].cursor == 1 and items[0].resend is False and items[0].attempt == 0
    assert v5.decode(bytes.fromhex(items[0].hex))["seq"] == 77
    assert items[0].ts > 0


async def test_a_resend_appears_as_the_same_bytes_again(monkeypatch):
    """No echo heard: the identical frame goes out again, and the feed says
    so rather than hiding a second transmission."""
    r, radio, tracked = _responder(monkeypatch)
    await r.handle_request(">cov", "a")
    assert await tracked[0].resend(1) is True

    first, again = datagram_feed.since()
    assert again.hex == first.hex and again.cursor == 2
    assert again.resend is True and again.attempt == 2        # delivery counts attempts from 0
    assert len(radio._mc.commands.frames) == 2


async def test_nothing_reaches_the_feed_when_nothing_reaches_the_air(monkeypatch):
    r, radio, tracked = _responder(monkeypatch)
    monkeypatch.setattr(settings, "tx_enabled", False)
    assert await radio.send_channel_data(b"\x01\x02") is False
    radio._data_channel_idx = None                             # broadcasts off
    monkeypatch.setattr(settings, "tx_enabled", True)
    assert await radio.send_channel_data(b"\x01\x02") is False
    assert datagram_feed.since() == [] and datagram_feed.cursor == 0


# -- 2. Ring buffer and cursor ----------------------------------------------


def test_the_ring_keeps_the_last_datagrams_and_the_cursor_never_repeats():
    feed = DatagramFeed(maxlen=4)
    for i in range(6):
        feed.publish(bytes([i]), 0xFF10)
    assert [i.cursor for i in feed.since()] == [3, 4, 5, 6]     # the oldest two are gone
    assert feed.cursor == 6
    assert [i.hex for i in feed.since(4)] == ["04", "05"]       # only what came after
    assert feed.since(6) == []
    assert feed.since(None, limit=2)[0].cursor == 5             # a limited page is the newest
    assert feed.gap_after(1) and not feed.gap_after(4) and not feed.gap_after(None)


async def test_a_late_client_gets_the_catch_up_then_the_live_datagrams():
    feed = DatagramFeed()
    feed.publish(b"\xaa", 0xFF10)
    feed.publish(b"\xbb", 0xFF10)
    gen = feed.subscribe(cursor=1)                             # saw #1 before it dropped out
    seen = [await gen.__anext__()]                             # the catch-up: #2 only
    feed.publish(b"\xcc", 0xFF10)
    seen.append(await asyncio.wait_for(gen.__anext__(), 2))    # live
    await gen.aclose()
    assert [i.hex for i in seen] == ["bb", "cc"]
    assert feed.subscriber_count == 0                          # the generator cleaned up


async def test_a_datagram_sent_during_the_catch_up_is_delivered_once():
    feed = DatagramFeed()
    feed.publish(b"\xaa", 0xFF10)
    seen = []
    gen = feed.subscribe()
    seen.append(await gen.__anext__())                          # subscriber now registered
    feed.publish(b"\xbb", 0xFF10)                               # queued *and* in the ring
    seen.append(await asyncio.wait_for(gen.__anext__(), 2))
    await gen.aclose()
    assert [i.cursor for i in seen] == [1, 2]                   # no duplicate of #2


# -- 3. The HTTP surface -----------------------------------------------------


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "portal_enabled", True)
    monkeypatch.setattr(settings, "bridge_token", TOKEN)
    monkeypatch.setattr(settings, "admin_key", "")
    responder, radio, tracked = _responder(monkeypatch)
    bot = WeatherBot()
    bot.store = responder.store
    bot.radio = radio
    bot._broadcaster = responder
    c = TestClient(create_app(bot), headers={"X-Requested-With": "meshcore-portal",
                                             "X-Bridge-Token": TOKEN})
    return c, bot, tracked


def test_the_gate_is_the_token_and_the_portal(client, monkeypatch):
    c, _, _ = client
    assert c.get("/api/bridge/datagrams").status_code == 200

    bare = TestClient(create_app(c.app.state.bot))
    assert bare.get("/api/bridge/datagrams").status_code == 401       # no token
    assert bare.get("/api/bridge/stream").status_code == 401
    assert bare.get("/api/bridge/info").status_code == 401
    assert bare.post("/api/bridge/request", json={"text": ">cov"},
                     headers={"X-Requested-With": "meshcore-portal"}).status_code == 401
    assert bare.get("/api/bridge/datagrams", headers={"X-Bridge-Token": "wrong"}).status_code == 401
    assert bare.get("/api/bridge/datagrams",
                    headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200

    monkeypatch.setattr(settings, "bridge_token", "")
    assert c.get("/api/bridge/datagrams").status_code == 404          # no token set: not there
    monkeypatch.setattr(settings, "bridge_token", TOKEN)
    monkeypatch.setattr(settings, "portal_enabled", False)
    assert c.get("/api/bridge/datagrams").status_code == 404


def test_a_post_still_needs_the_portal_header(client):
    c, _, _ = client
    no_xhr = TestClient(create_app(c.app.state.bot), headers={"X-Bridge-Token": TOKEN})
    assert no_xhr.post("/api/bridge/request", json={"text": ">cov"}).status_code == 403


def test_a_request_is_answered_on_the_air_and_therefore_on_the_feed(client):
    c, bot, _ = client
    r = c.post("/api/bridge/request", json={"text": ">cov", "client": "sim"}).json()
    assert r["ok"] and r["accepted"] and r["outcome"] == "sent"
    assert r["packets"] == 1 and r["bytes"] > 0 and r["cursor"] == 1

    d = c.get("/api/bridge/datagrams").json()
    assert d["latest"] == 1 and d["gap"] is False and len(d["datagrams"]) == 1
    frame = d["datagrams"][0]
    assert v5.decode(bytes.fromhex(frame["hex"]))["name"] in ("coverage", "not_available")
    assert frame["data_type"] == 0xFF10 and frame["cursor"] == d["cursor"] == 1
    assert c.get("/api/bridge/datagrams?since=1").json()["datagrams"] == []


def test_the_bridge_client_is_just_another_sender(client):
    """Same spacing per sender, same hourly packet budget."""
    c, bot, _ = client
    assert c.post("/api/bridge/request", json={"text": ">cov", "client": "sim"}).json()["ok"]
    again = c.post("/api/bridge/request", json={"text": ">cov", "client": "sim"}).json()
    assert again == {"ok": False, "accepted": False, "outcome": "rate_limited",
                     "retry_after": 2.0, "detail": "rate limited"}
    assert datagram_feed.cursor == 1                              # nothing more went out

    other = c.post("/api/bridge/request", json={"text": ">cov", "client": "other"}).json()
    assert other["ok"] and datagram_feed.cursor == 2               # a different sender is free

    import time
    bot._broadcaster._sent.extend([time.time()] * PER_HOUR)
    spent = c.post("/api/bridge/request", json={"text": ">cov", "client": "third"}).json()
    assert spent == {"ok": False, "accepted": False, "outcome": "budget_spent",
                     "detail": "hourly budget spent, told busy"}
    # The one thing on air is the 6-byte "busy" (Not available, reason 4).
    assert datagram_feed.cursor == 3
    busy = v5.decode(bytes.fromhex(c.get("/api/bridge/datagrams?since=2").json()["datagrams"][0]["hex"]))
    assert busy["name"] == "not_available" and busy["reason"] == v5.REASON_RATE_LIMITED


def test_a_part_already_on_the_air_is_not_a_delivery(client):
    """`>part` for packets that went out again in the last 30 s sends nothing
    (spec 14.5). A simulator must not confirm a delivery that never happened,
    so it is told how long to wait rather than "sent"."""
    from meshcore_weather.protocol.broadcaster import PART_RESEND_FLOOR_S

    c, bot, _ = client
    cache = bot._broadcaster._parts
    cache.remember(212, 1, bytes.fromhex("017a4ca0") + b"\x00" * 7, mtype=10)
    assert c.post("/api/bridge/request",
                  json={"text": ">part 212 1", "client": "sim"}).json()["ok"]
    assert datagram_feed.cursor == 1

    again = c.post("/api/bridge/request",
                   json={"text": ">part 212 1", "client": "other"}).json()
    assert again == {"ok": False, "accepted": False, "outcome": "already_resent",
                     "retry_after": PART_RESEND_FLOOR_S, "detail": "already resent"}
    assert datagram_feed.cursor == 1                   # nothing more went out


def test_a_request_that_is_not_a_request_is_refused(client):
    c, _, _ = client
    assert c.post("/api/bridge/request", json={"text": "hello"}).status_code == 400
    assert c.post("/api/bridge/request", json={"text": ""}).status_code == 400
    assert c.post("/api/bridge/request", json={"text": ">" + "x" * 300}).status_code == 400
    assert c.post("/api/bridge/request", content=b"not json").status_code == 400
    assert datagram_feed.cursor == 0


def test_info_names_the_bot_and_the_channel(client):
    c, _, _ = client
    d = c.get("/api/bridge/info").json()
    assert d["ok"] and d["channel"] == settings.meshwx_channel
    assert d["data_type"] == 0xFF10 and d["cursor"] == 0 and d["bot_id"] == 0x4C7A


def test_requests_need_a_broadcaster(client):
    c, bot, _ = client
    bot._broadcaster = None
    assert c.post("/api/bridge/request", json={"text": ">cov"}).status_code == 503
    assert c.get("/api/bridge/datagrams").status_code == 200       # the feed is still readable


# -- 4. The stream endpoint --------------------------------------------------


class _Request:
    """Enough of a Starlette request for the route's own gate."""

    def __init__(self, headers=None):
        self.headers = headers if headers is not None else {"x-bridge-token": TOKEN}
        self.client = None


async def test_the_stream_sends_hello_then_one_frame_per_datagram(monkeypatch):
    from meshcore_weather.portal.routes.bridge import bridge_stream

    monkeypatch.setattr(settings, "portal_enabled", True)
    monkeypatch.setattr(settings, "bridge_token", TOKEN)
    datagram_feed.publish(b"\xaa\xbb", 0xFF10)

    frames = []
    body = (await bridge_stream(_Request(), since=None)).body_iterator
    async for frame in body:
        frames.append(frame)
        if len(frames) == 2:
            break
    await body.aclose()

    assert frames[0] == 'data: {"hello": true}\n\n'
    assert '"hex": "aabb"' in frames[1] and '"cursor": 1' in frames[1]
