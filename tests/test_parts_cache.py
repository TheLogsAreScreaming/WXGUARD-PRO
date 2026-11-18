"""`>part <group> <idx>[,<idx>…]` (spec 14.5, revision 10).

A phone that heard 4 of 7 packets asks for the other 3 instead of spending a
whole answer again. Three layers: the cache the scheduler fills as it stamps
packets and hands them to the radio (protocol/broadcaster.py `PartsCache`,
schedule/scheduler.py), the resend itself, which must keep the `group` the
packets were assembled under, and the limits that stop one missing packet
being paid for ten times.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.protocol.broadcaster import (
    PART_RESEND_FLOOR_S,
    PARTS_CACHE_GROUPS,
    PARTS_CACHE_S,
    PartsCache,
)

BOT = 0x4C7A


def _warning(phen="SV", sig="W", ugcs=("TXC453",), onset=0):
    return {
        "event_code": b.tables.event_code(f"{phen}.{sig}"),
        "vtec_phenomenon": phen,
        "vtec_significance": sig,
        "ugcs": list(ugcs),
        "onset_unix_min": onset,
    }


def _responder(monkeypatch, active=None):
    """An AppResponder whose radio keeps what it was handed."""
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol import warnings as warnings_mod
    from meshcore_weather.protocol.broadcaster import AppResponder

    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    monkeypatch.setattr(
        warnings_mod, "extract_active_warnings",
        lambda store, coverage=None, now=None: list(active or []),
    )
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    sent = []

    async def cap(data, data_type=0xFF10, ev=None):
        sent.append(data)
        return True

    radio.send_channel_data = cap
    return AppResponder(WeatherStore(), radio, render_text=lambda c, a: None), sent


def _sweep_active(runs=120):
    """Enough active area for a sweep of four packets."""
    return [_warning("SV", "W", [f"TXC{n:03d}" for n in range(1, runs * 2, 2)])]


def _of_type(sent, mtype):
    return [v5.decode(m) for m in sent if m[3] >> 4 == mtype]


# ---------------------------------------------------------------------------
# The cache itself
# ---------------------------------------------------------------------------


def test_the_cache_holds_the_newest_answers_and_lets_the_rest_go():
    cache = PartsCache()
    for group in range(PARTS_CACHE_GROUPS + 3):
        cache.remember(group, 0, bytes([group]), now=1000.0 + group)
        cache.remember(group, 1, bytes([group, 1]), now=1000.0 + group)
    # The three oldest answers went when the ninth, tenth and eleventh started.
    assert cache.status(now=1100.0)["groups"] == PARTS_CACHE_GROUPS
    assert cache.lookup(0, [0], now=1100.0) == ([], [], [0])
    kept = PARTS_CACHE_GROUPS + 2
    assert cache.lookup(kept, [0], now=1100.0)[0] == [bytes([kept])]


def test_a_group_is_let_go_after_ten_minutes():
    assert PARTS_CACHE_S == 600.0
    cache = PartsCache()
    cache.remember(212, 3, b"packet", now=1000.0)
    assert cache.lookup(212, [3], now=1000.0 + PARTS_CACHE_S - 1)[0] == [b"packet"]
    assert cache.lookup(212, [3], now=1000.0 + PARTS_CACHE_S + 1) == ([], [], [3])


def test_the_floor_is_per_packet_and_not_per_sender():
    assert PART_RESEND_FLOOR_S == 30.0
    cache = PartsCache()
    for idx in (1, 2):
        cache.remember(212, idx, bytes([idx]), now=1000.0)
    packets, waiting, unknown = cache.lookup(212, [1, 2, 5], now=1000.0)
    assert packets == [b"\x01", b"\x02"] and waiting == [] and unknown == [5]

    cache.stamp(212, [1], now=1000.0)
    packets, waiting, unknown = cache.lookup(212, [1, 2], now=1010.0)
    assert packets == [b"\x02"] and waiting == [1]
    # Past the floor it is sendable again.
    assert cache.lookup(212, [1], now=1000.0 + PART_RESEND_FLOOR_S + 1)[0] == [b"\x01"]


def test_the_kind_is_remembered_for_the_log_only():
    """The request names a group and nothing else, so the bot has to know for
    itself whether it is resending a map or a report before it can say so."""
    cache = PartsCache()
    cache.remember(212, 0, b"packet", mtype=v5.TYPE_AREA_SWEEP)
    cache.remember(7, 0, b"packet", mtype=v5.TYPE_TEXT)
    assert (cache.kind(212), cache.kind(7), cache.kind(99)) == (
        "area_sweep", "text", "answer"
    )


def test_clearing_the_floors_keeps_the_packets():
    """The portal's Reset opens this gate. Dropping the bytes would close it."""
    cache = PartsCache()
    cache.remember(212, 1, b"packet", now=1000.0)
    cache.stamp(212, [1], now=1000.0)
    assert cache.lookup(212, [1], now=1001.0) == ([], [1], [])
    cache.clear_floors()
    assert cache.lookup(212, [1], now=1001.0) == ([b"packet"], [], [])


# ---------------------------------------------------------------------------
# Filling it where the packets are stamped
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_cache_is_filled_at_transmission_under_the_stamped_group(monkeypatch):
    """`group` is the seq the first packet took from the radio, so the only
    place that knows it is the transmit path. A cache filled where the answer
    was built would be keyed by a number no phone ever saw."""
    r, sent = _responder(monkeypatch, _sweep_active())
    built = b.area_sweep_messages(b.SeqCounter(), r._scheduler.bot_id(), r.store)
    # The radio's counter, wherever it happens to stand, is not the builder's.
    r._scheduler._next_seq = (v5.decode(built[0])["group"] + 9) & 0xFF
    await r.handle_request(">wmap", "a")
    packets = _of_type(sent, v5.TYPE_AREA_SWEEP)
    group = packets[0]["group"]
    assert len(packets) > 1 and {p["group"] for p in packets} == {group}

    status = r._parts.status()
    assert status["groups"] == 1 and status["packets"] == len(packets)
    held, waiting, unknown = r._parts.lookup(group, [0, 1])
    assert held == sent[:2] and not waiting and not unknown
    # The scratch group the builder used is not a key: nothing went out as it.
    assert v5.decode(built[0])["group"] != group
    assert r._parts.lookup(v5.decode(built[0])["group"], [0]) == ([], [], [0])


@pytest.mark.asyncio
async def test_an_answer_of_one_packet_is_not_kept(monkeypatch):
    """The eight slots are for answers a phone can lose a piece of."""
    r, sent = _responder(monkeypatch, [_warning("TO", "W", ["TXC453"])])
    await r.handle_request(">wmap", "a")
    assert len(_of_type(sent, v5.TYPE_AREA_SWEEP)) == 1
    assert r._parts.status()["groups"] == 0


@pytest.mark.asyncio
async def test_a_text_reply_is_kept_by_its_chunks(monkeypatch):
    r, sent = _responder(monkeypatch)
    r._render_text = lambda cmd, arg: "word " * 400      # more than one chunk
    await r.handle_request(">space", "a")
    chunks = _of_type(sent, v5.TYPE_TEXT)
    assert len(chunks) > 1
    group = chunks[0]["group"]
    assert {c["group"] for c in chunks} == {group}
    assert r._parts.status()["packets"] == len(chunks)
    assert r._parts.lookup(group, [1])[0] == [sent[1]]


# ---------------------------------------------------------------------------
# The resend
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_resent_part_is_the_same_bytes_under_a_new_seq(monkeypatch):
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    first = list(sent)
    group = v5.decode(first[0])["group"]

    sent.clear()
    out = await r.handle_request(f">part {group} 1,2", "b")
    assert "packet(s)" in out and len(sent) == 2
    for original, again in zip(first[1:3], sent):
        assert again[0] != original[0]              # a fresh seq, byte 0
        assert again[1:] == original[1:]            # and nothing else moved
        assert v5.decode(again)["group"] == group


@pytest.mark.asyncio
async def test_a_resent_first_packet_keeps_its_group(monkeypatch):
    """The stamping step gives a multi-packet answer the seq of its first
    packet as a group. A resent packet 0 must not take a new one: its other
    packets went out under the old one and a phone reassembles by group."""
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    group = v5.decode(sent[0])["group"]

    sent.clear()
    await r.handle_request(f">part {group} 0", "b")
    again = v5.decode(sent[0])
    assert again["idx"] == 0 and again["group"] == group
    assert again["seq"] != group


@pytest.mark.asyncio
async def test_only_the_indexes_it_holds_go_out(monkeypatch):
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    total = v5.decode(sent[0])["total"]
    group = v5.decode(sent[0])["group"]

    sent.clear()
    await r.handle_request(f">part {group} 1,{total + 3}", "b")
    assert len(sent) == 1 and v5.decode(sent[0])["idx"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("arg", ["251 1,2", "251", ">part", "abc 1", "300 1"])
async def test_nothing_to_resend_is_not_available_p_reason_0(monkeypatch, arg):
    """An unknown group, a request with no indexes, a request the bot cannot
    read at all: the packets are gone either way and the phone should ask for
    the whole answer again."""
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(f">part {arg}", "a")
    d = v5.decode(sent[-1])
    assert (d["name"], d["request"], d["reason"]) == (
        "not_available", "p", v5.REASON_NO_DATA
    )
    assert len(sent[-1]) == 6


@pytest.mark.asyncio
async def test_an_index_the_group_never_had_is_not_available(monkeypatch):
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    group, total = (v5.decode(sent[0])[k] for k in ("group", "total"))
    sent.clear()
    await r.handle_request(f">part {group} {total},{total + 1}", "b")
    d = v5.decode(sent[-1])
    assert (d["request"], d["reason"]) == ("p", v5.REASON_NO_DATA)


@pytest.mark.asyncio
async def test_one_packet_serves_every_phone_that_missed_it(monkeypatch):
    """Ten phones missing packet 3 cost one packet, and the tenth of them is
    told nothing at all: its answer is already on the air."""
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    group = v5.decode(sent[0])["group"]

    sent.clear()
    await r.handle_request(f">part {group} 2", "b")
    assert len(sent) == 1

    out = await r.handle_request(f">part {group} 2", "c")
    assert out == "already resent"
    assert sent == sent[:1]                  # silence, and not a Not available

    # A packet outside the window still goes, in the same request as one
    # inside it: what is refused is the packet, not the ask.
    await r.handle_request(f">part {group} 1,2", "d")
    assert len(sent) == 2 and v5.decode(sent[-1])["idx"] == 1

    # Past the floor, packet 2 is sendable again.
    r._parts.clear_floors()
    await r.handle_request(f">part {group} 2", "e")
    assert len(sent) == 3 and v5.decode(sent[-1])["idx"] == 2


@pytest.mark.asyncio
async def test_a_group_the_bot_has_let_go_is_not_available(monkeypatch):
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    group = v5.decode(sent[0])["group"]
    # Ten minutes later the bot no longer holds it.
    for held in r._parts._groups.values():
        held["at"] -= PARTS_CACHE_S + 1
    sent.clear()
    await r.handle_request(f">part {group} 1", "b")
    d = v5.decode(sent[-1])
    assert (d["request"], d["reason"]) == ("p", v5.REASON_NO_DATA)


# ---------------------------------------------------------------------------
# The limits around it (spec 14.5)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_every_resent_packet_comes_out_of_the_hourly_budget(monkeypatch):
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    spent = len(r._sent)
    group = v5.decode(sent[0])["group"]
    await r.handle_request(f">part {group} 1,2,3", "b")
    assert len(r._sent) == spent + 3


@pytest.mark.asyncio
async def test_the_per_sender_floor_applies_to_a_part_request(monkeypatch):
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    group = v5.decode(sent[0])["group"]
    sent.clear()
    assert await r.handle_request(f">part {group} 1", "b") != "rate limited"
    assert await r.handle_request(f">part {group} 2", "b") == "rate limited"
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_a_resend_neither_meets_the_sweep_cooldown_nor_restarts_it(monkeypatch):
    """A resend is not a new sweep: it costs what it costs, and the five
    minutes go on running from the sweep itself."""
    r, sent = _responder(monkeypatch, _sweep_active())
    await r.handle_request(">wmap", "a")
    group = v5.decode(sent[0])["group"]
    at, states = r._last_sweep, dict(r._last_sweep_state)

    # Inside the window, where a `>wmap` would be refused, `>part` answers.
    sent.clear()
    await r.handle_request(f">part {group} 1", "b")
    assert len(sent) == 1 and v5.decode(sent[0])["name"] == "area_sweep"
    # And it did not push the window out.
    assert r._last_sweep == at and r._last_sweep_state == states
