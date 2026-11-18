"""Request datagrams: an app's `>` request flooded on #meshwx as GRP_DATA
(docs/MeshWX_v5_Spec.md §11).

What is checked here is the whole road: the companion frame the node hands
up, the radio hook that decodes it, the bot-id filter that decides whether
this bot is the one asked, the copy rule a resend meets, and the two limits
a datagram does and does not pass.
"""

import asyncio
from types import SimpleNamespace

import pytest

from meshcore_weather.config import settings
from meshcore_weather.main import WeatherBot
from meshcore_weather.meshcore.radio import MeshcoreRadio
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5
from meshcore_weather.traffic import traffic_log
from tests.test_console import ChannelFakeRadio

# The bot: public key 1d04..., so its `bot` header field is 0x041D, the one
# the spec's own vector names.
BOT = 0x041D
BOT_KEY = "1d04" + "00" * 30
PHONE = "aabbccddeeff"          # six key bytes of the phone asking
TS = 1789660000


def datagram(text=">d", to=BOT, sender=PHONE, ts=TS, seq=1):
    return v5.encode_request(seq, to, bytes.fromhex(sender), ts, text)


def event(data, channel_idx=1, data_type=v5.DATA_TYPE, path_len=2, snr=6.0):
    """What meshcore_py builds from RESP_CODE_CHANNEL_DATA_RECV (0x1B)."""
    return SimpleNamespace(payload={
        "SNR": snr, "channel_idx": channel_idx, "path_hash_mode": 0,
        "path_len": path_len, "data_type": data_type,
        "data_len": len(data), "payload": bytes(data).hex(),
    })


class Clock:
    def __init__(self, t=1_700_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class Responder:
    """The AppResponder as far as main is concerned."""

    def __init__(self, outcome="1 packet(s), 20 B"):
        self.calls: list[tuple[str, str]] = []
        self.outcome = outcome

    async def handle_request(self, text, sender_key, ev=None, not_before=0.0):
        self.calls.append((text, sender_key))
        return self.outcome(text) if callable(self.outcome) else self.outcome


@pytest.fixture
def bot(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "tx_enabled", True)
    monkeypatch.setattr(settings, "dm_copy_window_s", 120)
    monkeypatch.setattr(settings, "dm_copy_retain_s", 1800)
    traffic_log._events.clear()
    b = WeatherBot()
    b.store = WeatherStore()
    b.radio = ChannelFakeRadio()
    b.radio.public_key = BOT_KEY
    b._clock = Clock()
    b._broadcaster = Responder()
    return b


async def ask(wx, text=">d", hops=2, **kw):
    """One Request datagram, decoded, as the radio hands it to the bot."""
    await wx._handle_channel_request(v5.decode_request(datagram(text, **kw)), hops, 6.0)


# -- The radio hook -----------------------------------------------------------


def _radio(**kw):
    r = MeshcoreRadio()
    r._channel_idx = r._data_channel_idx = 1
    heard = []

    async def handler(request, hops, snr):
        heard.append((request, hops, snr))
    r.on_channel_request(handler)
    return r, heard


def test_the_radio_hands_a_request_datagram_to_the_bot():
    r, heard = _radio()
    asyncio.run(r._on_channel_data(event(datagram(">o KAUS"))))
    assert len(heard) == 1
    request, hops, snr = heard[0]
    assert request.text == ">o KAUS" and request.sender_prefix == PHONE
    assert request.bot == BOT and request.ts == TS and request.seq == 1
    assert hops == 2 and snr == 6.0


def test_a_direct_datagram_has_no_hop_count():
    r, heard = _radio()
    asyncio.run(r._on_channel_data(event(datagram(), path_len=255)))
    assert heard and heard[0][1] is None


@pytest.mark.parametrize("kw", [
    {"channel_idx": 0},                 # the public channel, never ours
    {"channel_idx": 2},                 # somebody else's slot
    {"data_type": 0xFF1E},              # the operator link test
    {"data_type": 0x0001},
])
def test_datagrams_that_are_not_ours_are_left_alone(kw):
    r, heard = _radio()
    asyncio.run(r._on_channel_data(event(datagram(), **kw)))
    assert heard == []


def test_our_own_v5_messages_echoed_back_are_not_requests():
    """Types 1-8 on this channel go bot -> app. Hearing one back (a repeater's
    echo of our own flood) must not look like somebody asking us something."""
    r, heard = _radio()
    ours = v5.encode_not_available(9, BOT, request="w", reason=0)
    asyncio.run(r._on_channel_data(event(ours)))
    assert heard == []


@pytest.mark.parametrize("data", [
    bytes.fromhex("011d0490aabbccddeeff600bac6a"),        # 14 bytes: no text
    bytes.fromhex("011d0490aabbccddeeff600bac6a64"),      # text without '>'
    bytes.fromhex("011d0490aabbccddeeff600bac6a3eff"),    # text not UTF-8
    v5.encode_header(1, BOT, v5.TYPE_REQUEST) + bytes.fromhex("aabbccddeeff")
    + TS.to_bytes(4, "little") + b">f " + b"x" * 38,      # 41 bytes of text
])
def test_a_malformed_request_is_dropped_by_the_radio(data):
    r, heard = _radio()
    asyncio.run(r._on_channel_data(event(data)))
    assert heard == []


def test_control_characters_never_reach_the_bot():
    """Terminal escapes and the like are stripped before anything logs the
    text, as they are on every other road into the bot."""
    r, heard = _radio()
    asyncio.run(r._on_channel_data(event(datagram(">f aus\x1b\x07tx"))))
    assert heard[0][0].text == ">f austx"


def test_a_datagram_off_the_node_reaches_the_bot_and_is_answered(bot):
    """End to end: the companion's frame, the radio's decode, main's handler,
    the answer the broadcaster builds."""
    r = MeshcoreRadio()
    r._channel_idx = r._data_channel_idx = 1
    r.on_channel_request(bot._handle_channel_request)
    asyncio.run(r._on_channel_data(event(datagram(">o KAUS"), path_len=4)))
    assert bot._broadcaster.calls == [(">o KAUS", PHONE)]
    ev = traffic_log.recent(5, kinds=("data_request",))[-1]
    assert ev["transport"] == "channel_data" and ev["hops"] == 4


@pytest.mark.asyncio
async def test_start_registers_the_hook_on_the_radio(monkeypatch, tmp_path):
    """The bot asks the radio for Request datagrams exactly as it asks for
    channel messages and DMs."""
    from tests.test_startup import StartFakeRadio

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "portal_enabled", False)
    b = WeatherBot()
    b.radio = StartFakeRadio()
    b.store = WeatherStore()

    async def nothing():
        return None
    monkeypatch.setattr(b, "_load_backlog", nothing)
    await b.start()
    assert b.radio._req == b._handle_channel_request
    await b.stop()


# -- Which bot answers (spec 11, 20) ------------------------------------------


def test_a_request_naming_this_bot_is_answered(bot):
    asyncio.run(ask(bot, ">d", to=BOT))
    assert bot._broadcaster.calls == [(">d", PHONE)]


def test_a_request_to_any_bot_is_answered(bot):
    asyncio.run(ask(bot, ">d", to=v5.REQUEST_BOT_ANY))
    assert bot._broadcaster.calls == [(">d", PHONE)]


def test_a_request_naming_another_bot_is_ignored(bot):
    asyncio.run(ask(bot, ">d", to=0x4C7A))
    assert bot._broadcaster.calls == []
    assert traffic_log.recent(20, kinds=("data_request",)) == []


def test_the_bot_id_is_the_one_the_answers_carry(bot):
    """`bot` is checked against the same u16 the bot stamps on its own
    headers, so an answer and this filter can never disagree."""
    from meshcore_weather.protocol import v5_builders as b
    assert bot.bot_id() == b.bot_id(BOT_KEY) == BOT


# -- One sender, whichever way the phone asks ---------------------------------


def test_the_sender_is_the_prefix_a_dm_carries(bot):
    """A datagram names six key bytes; a DM names the same twelve hex
    characters. One phone must be one sender to the limits and the copy
    rule, so the second ask here is a copy of the first, not a new request."""
    asyncio.run(ask(bot, ">w"))
    asyncio.run(bot._handle_dm(PHONE + "00" * 26, "Tommy", ">w", sender_ts=TS))
    assert bot._broadcaster.calls == [(">w", PHONE)]            # answered once
    copies = traffic_log.recent(20, kinds=("dm_copy",))
    assert len(copies) == 1 and copies[0]["key"] == PHONE


def test_the_sender_name_is_the_contact_we_know_or_the_key(bot):
    asyncio.run(ask(bot, ">d"))
    assert traffic_log.recent(5, kinds=("data_request",))[-1]["sender"] == f"app:{PHONE}"
    bot._known_contacts["Tommy"] = PHONE
    bot._clock.t += 3600
    asyncio.run(ask(bot, ">d"))
    assert traffic_log.recent(5, kinds=("data_request",))[-1]["sender"] == "Tommy"


# -- Copies (spec 11 "Copies", 13) --------------------------------------------


def test_a_resend_with_the_same_timestamp_waits_out_the_twelve_seconds(bot):
    asyncio.run(ask(bot, ">d"))
    bot._clock.t += 6                                   # the app's 10 s retry, early
    asyncio.run(ask(bot, ">d"))
    assert len(bot._broadcaster.calls) == 1
    reason = traffic_log.recent(20, kinds=("dm_copy",))[-1]["reason"]
    assert "same timestamp" in reason and "6 s ago" in reason

    bot._clock.t += 7                                   # 13 s after the answer went out
    asyncio.run(ask(bot, ">d"))
    assert len(bot._broadcaster.calls) == 2
    assert bot.APP_COPY_GAP_S == 12


def test_a_copy_of_an_unanswered_request_is_answered_at_once(bot):
    """Nothing went out, so nothing is being doubled: the copy is answered
    without waiting, whatever the gap."""
    bot._broadcaster.outcome = "rate limited"
    asyncio.run(ask(bot, ">d"))
    bot._broadcaster.outcome = "1 packet(s), 20 B"
    bot._clock.t += 1
    asyncio.run(ask(bot, ">d"))
    assert len(bot._broadcaster.calls) == 2


def test_a_copy_is_logged_as_a_datagram_copy_never_as_a_dm(bot):
    asyncio.run(ask(bot, ">d"))
    bot._clock.t += 1
    asyncio.run(ask(bot, ">d"))
    copy = traffic_log.recent(20, kinds=("dm_copy",))[-1]
    assert copy["transport"] == "channel_data" and copy["key"] == PHONE
    assert bot.radio.dms == []                      # never an answer by DM


# -- Limits (spec 11 "Limits", 8.2) -------------------------------------------


def test_a_datagram_never_meets_the_limiter_for_people(bot):
    """Spec 11: the app limits inside the broadcaster, and not the text-command
    limiter — exactly like a `>` line arriving as channel text."""
    seen = []
    bot._rate_check = lambda *a, **k: seen.append(a) or True
    for i in range(6):
        asyncio.run(ask(bot, f">f 10{i}", ts=TS + i))
        bot._clock.t += 1                           # one a second, six in a row
    assert len(bot._broadcaster.calls) == 6         # the 5 s people-spacing never applies
    assert seen == []
    assert bot._reply_history == {} and bot._all_replies == [] and bot._rate_limit == {}


def test_more_requests_than_a_person_may_have_in_an_hour_still_go_through(bot):
    for i in range(bot.REPLIES_PER_SENDER_PER_HOUR + 5):
        asyncio.run(ask(bot, f">f {i}", ts=TS + i))
        bot._clock.t += 1
    assert len(bot._broadcaster.calls) == bot.REPLIES_PER_SENDER_PER_HOUR + 5


def test_the_app_limiter_inside_the_broadcaster_still_refuses(bot):
    bot._broadcaster.outcome = "hourly budget spent"
    asyncio.run(ask(bot, ">d"))
    assert traffic_log.recent(20, kinds=("dropped",))[-1]["reason"] == "hourly budget spent"


def test_without_a_data_channel_there_is_nothing_to_answer_with(bot):
    bot._broadcaster = None
    asyncio.run(ask(bot, ">d"))
    assert (traffic_log.recent(20, kinds=("dropped",))[-1]["reason"]
            == "broadcasts off: no data channel")


# -- The traffic log ----------------------------------------------------------


def test_the_request_is_logged_with_its_transport_and_hops(bot):
    asyncio.run(ask(bot, ">o KAUS", hops=3))
    ev = traffic_log.recent(5, kinds=("data_request",))[-1]
    assert ev["kind"] == "data_request" and ev["transport"] == "channel_data"
    assert ev["hops"] == 3 and ev["text"] == ">o KAUS" and ev["dir"] == "in"
    # Channel traffic is public by nature: the text stays, the key never shows.
    public = traffic_log.recent(5, public=True, kinds=("data_request",))[-1]
    assert public["text"] == ">o KAUS" and "key" not in public


def test_the_answer_is_logged_as_a_reply_row_of_its_own(bot):
    """The feed used to show only the request, as if the bot had never answered
    (Rafael, 17 September): every answer now has its own outgoing row, after
    the request it answers, with what went out."""
    asyncio.run(ask(bot, ">o KAUS", hops=3))
    req = traffic_log.recent(5, kinds=("data_request",))[-1]
    reply = traffic_log.recent(5, kinds=("reply_data",))[-1]
    assert reply["dir"] == "out" and reply["transport"] == "channel_data"
    assert reply["req_id"] == req["id"] and reply["sender"] == req["sender"]
    assert reply["ok"] is True and reply["text"].endswith(" B") and reply["chars"] > 0
    assert reply["t"] >= req["t"]
    # Public by nature, like the request it answers.
    assert traffic_log.recent(5, public=True, kinds=("reply_data",))[-1]["text"] == reply["text"]


# -- While the products are still loading (spec 9) --------------------------


@pytest.mark.asyncio
async def test_a_request_before_the_backlog_is_free(monkeypatch, tmp_path):
    """The same behaviour the DM path has for a `>`: an off-budget Not
    available now, and the real answer to the app's own resend."""
    from tests.test_startup import _responder

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "tx_enabled", True)
    traffic_log._events.clear()
    b = WeatherBot()
    b.store = WeatherStore()
    b.radio = ChannelFakeRadio()
    b.radio.public_key = BOT_KEY
    b._clock = Clock()
    b._store_ready.clear()                         # as a restart leaves it
    b._broadcaster, sent = _responder(monkeypatch, b._store_ready)

    await ask(b, ">w")
    out = v5.decode(sent[-1])
    assert out["name"] == "not_available" and out["reason"] == v5.REASON_NO_DATA
    assert list(b._broadcaster._sent) == []         # not a packet of the hourly budget
    assert b._reply_history == {} and b._all_replies == []
    assert b.radio.dms == []

    b._store_ready.set()
    b._broadcaster._last_by_sender.clear()
    b._clock.t += 30                                # the app asks again
    await ask(b, ">w")
    assert v5.decode(sent[-1])["name"] in ("digest", "not_available")
    assert traffic_log.recent(20, kinds=("dm_copy",))[-1]["reason"].endswith("answer")
