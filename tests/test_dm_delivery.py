"""DM requests and replies on stock MeshCore: copies of a request, the pause
before a reply, one reply in flight per contact, the tries of one message,
`more` by confirmation, the 156-byte budget and the outcome record. All in
virtual time: nothing here really waits."""

import asyncio
import hashlib
import heapq
import json
import time
from types import SimpleNamespace

import pytest

from meshcore_weather.config import settings
from meshcore_weather.core.pages import split_pages
from meshcore_weather.main import WeatherBot
from meshcore_weather.meshcore.delivery import DeliveryTracker, DmOutbox
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.traffic import traffic_log
from tests.test_console import ChannelFakeRadio

A, B = "a1" * 32, "b2" * 32
AK, BK = A[:12], B[:12]
NAMES = {A: "Tommy", B: "Ann"}
WARN = "Austin TX: " + "; ".join(f"Flood Warning {i} until 5:45 PM CDT" for i in range(6))
GREEK = "Αθήνα: " + "; ".join(f"Περιοχή {i} βροχή ☔ άνεμος ≥ 30 χλμ" for i in range(12))


class VClock:
    """Virtual time. The earliest sleep resolves once every task is waiting."""

    def __init__(self, t0: float):
        self.t0 = self.t = t0
        self._timers: list = []
        self._n = 0

    def time(self) -> float:
        return self.t

    async def sleep(self, d: float) -> None:
        fut = asyncio.get_running_loop().create_future()
        self._n += 1
        heapq.heappush(self._timers, (self.t + max(0.0, d), self._n, fut))
        await fut

    def at(self, s: float, fn):
        """Run the coroutine function `fn` at t0 + s."""
        async def go():
            await self.sleep(self.t0 + s - self.t)
            await fn()
        return asyncio.ensure_future(go())

    async def run(self, until_s: float) -> None:
        end = self.t0 + until_s
        while True:
            for _ in range(50):
                await asyncio.sleep(0)
            while self._timers and self._timers[0][2].done():
                heapq.heappop(self._timers)
            if not self._timers or self._timers[0][0] > end:
                self.t = max(self.t, end)
                return
            due, _, fut = heapq.heappop(self._timers)
            self.t = max(self.t, due)
            fut.set_result(None)


SELF = b"\x11" * 32                  # the bot's public key


class DmRadio(ChannelFakeRadio):
    """A node whose DM tries are logged and whose ACKs follow a script:
    ack(key, text, ts, attempt) -> seconds until the ACK arrives, or None (lost).
    The ACK code is the firmware's: sha256(timestamp, attempt, text, the
    bot's own key), so the recipient is not in it. `refuse` makes the node
    turn a try down; `during` runs while a try is handed to the node."""

    def __init__(self, vc, tracker):
        super().__init__()
        self.vc, self.tracker = vc, tracker
        self.routes: dict[str, int] = {}
        self.log: list[tuple] = []
        self.ack = lambda key, text, ts, attempt: 1.5
        self.refuse = lambda key, text, ts, attempt: False
        self.during = None

    def dm_route_len(self, key):
        return self.routes.get(key[:12], -1)

    async def dm_reset_path(self, key):
        self.log.append(("reset", key[:12], self.vc.t - self.vc.t0))
        self.routes[key[:12]] = -1

    async def dm_transmit(self, key, text, ts, attempt):
        if self.refuse(key[:12], text, ts, attempt):
            self.log.append(("refused", key[:12], text, ts, attempt, self.dm_route_len(key), self.vc.t - self.vc.t0))
            return None
        code = hashlib.sha256(ts.to_bytes(4, "little") + bytes([attempt & 3]) + text.encode() + SELF).digest()[:4].hex()
        self.log.append(("tx", key[:12], text, ts, attempt, self.dm_route_len(key), self.vc.t - self.vc.t0, code))
        if self.during:
            self.during(key[:12], text, ts, attempt)
        delay = self.ack(key[:12], text, ts, attempt)
        if delay is not None:
            async def arrive():
                await self.vc.sleep(delay)
                self.tracker.on_ack(code)
            asyncio.ensure_future(arrive())
        return {"ack": code, "timeout_ms": 5000}                  # 6 s per try

    def txs(self, key):
        return [e for e in self.log if e[0] == "tx" and e[1] == key]


@pytest.fixture
def w(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for name, value in {"tx_enabled": True, "reply_mode": "dm", "admin_key": "", "retransmit_max": 1,
                        "dm_reply_delay_s": 2.0, "dm_copy_window_s": 120, "dm_copy_retain_s": 1800}.items():
        monkeypatch.setattr(settings, name, value)
    traffic_log._events.clear()
    vc = VClock(time.time())
    tracker = DeliveryTracker()
    bot = WeatherBot()
    bot.store = WeatherStore()
    bot.radio = DmRadio(vc, tracker)
    bot._clock = vc.time
    bot.dm_outbox = DmOutbox(tracker, clock=vc.time, sleep=vc.sleep, jitter=lambda: 0.0)
    monkeypatch.setattr(bot, "_process_command",
                        lambda c, l: WARN if c == "warn" else (c + " " + l).strip() + ": fine")
    return SimpleNamespace(vc=vc, bot=bot, radio=bot.radio, tracker=tracker)


def dm(w, key, text, ts):
    return lambda: w.bot._handle_dm(key, NAMES[key], text, ts, 2)


def play(w, events, until):
    async def main():
        for s, fn in events:
            w.vc.at(s, fn)
        await w.vc.run(until)
    asyncio.run(main())


def test_the_1247_more_copies_neither_skip_a_page_nor_end_the_reply_early(w):
    """15 Sep 12:47 on a lossy 2-hop link: `more` came in 3 times while the
    ACKs of page 2 were lost; the bot answered a copy with "That was the
    whole reply" while page 2 was still undelivered."""
    pages = split_pages(WARN, 147)
    assert len(pages) == 2
    w.radio.routes[AK] = 2
    w.radio.ack = lambda key, text, ts, attempt: None if text == pages[1] and attempt < 3 else 1.5
    m = 1_000_100
    play(w, [(0, dm(w, A, "warn austin tx", 1_000_000)),
             (20, dm(w, A, "more", m)),
             (27, dm(w, A, "more", m)),            # while page 2 is being tried: nothing
             (60, dm(w, A, "more", m)),            # page 2 failed: the same page again
             (75, dm(w, A, "more", m)),            # page 2 confirmed, the same timestamp again: nothing
             (200, dm(w, A, "more", m + 180))],    # a new request: now the reply is complete
         until=300)
    tx = w.radio.txs(AK)
    texts = [e[2] for e in tx]
    assert texts[:5] == [pages[0]] + [pages[1]] * 4
    page2 = tx[1:5]
    assert [e[4] for e in page2] == [0, 1, 2, 3] and len({e[3] for e in page2}) == 1
    assert page2[0][6] == pytest.approx(22) and page2[3][6] == pytest.approx(62)
    assert len(tx) == 6 and texts[5] == "That was the whole reply to 'warn austin tx'. Send a new command."
    assert len(traffic_log.recent(50, kinds=("dm_copy",))) == 3
    assert not traffic_log.recent(50, kinds=("dropped",))


LONG = "Austin TX: " + "; ".join(f"Flood Warning {i} until 5:45 PM CDT" for i in range(12))


@pytest.fixture
def paged(w, monkeypatch):
    monkeypatch.setattr(w.bot, "_process_command", lambda c, l: LONG)
    w.pages = split_pages(LONG, 147)
    assert len(w.pages) >= 3
    return w


def test_quick_deliberate_paging_gets_the_next_page(paged):
    w = paged
    play(w, [(0, dm(w, A, "warn austin tx", 100)), (20, dm(w, A, "more", 120)),
             (40, dm(w, A, "More", 140))], until=90)                # page 2 confirmed at 23.5 s
    assert [e[2] for e in w.radio.txs(AK)] == w.pages[:3]
    assert not traffic_log.recent(20, kinds=("dm_copy",))


def test_a_more_retried_with_new_timestamps_while_its_page_is_in_flight_gets_one_page(paged):
    """meshcore_py and meshcore-cli change the timestamp on every retry."""
    w = paged
    w.radio.routes[AK] = 2
    w.radio.ack = lambda key, text, ts, attempt: None if text == w.pages[1] and attempt < 2 else 1.5
    play(w, [(0, dm(w, A, "warn austin tx", 100)), (20, dm(w, A, "more", 120)),
             (25, dm(w, A, "more", 125)), (30, dm(w, A, "more", 130))], until=120)
    assert [e[2] for e in w.radio.txs(AK)] == [w.pages[0]] + [w.pages[1]] * 3     # tries of page 2 only
    assert len(traffic_log.recent(20, kinds=("dm_copy",))) == 2


def test_a_more_whose_page_failed_gets_that_page_again_not_the_next(paged):
    w = paged
    w.radio.ack = lambda key, text, ts, attempt: None if text == w.pages[1] and ts < w.vc.t0 + 60 else 1.5
    play(w, [(0, dm(w, A, "warn austin tx", 100)), (20, dm(w, A, "more", 120)),
             (60, dm(w, A, "more", 160))], until=120)                  # page 2 failed at 34 s
    tx = w.radio.txs(AK)
    assert [e[2] for e in tx] == [w.pages[0]] + [w.pages[1]] * 3
    assert [e[4] for e in tx[1:]] == [0, 1, 3] and tx[3][3] == tx[1][3]   # the same message, attempt 3


def test_an_exact_timestamp_copy_of_more_after_its_page_was_confirmed_gets_nothing(paged):
    w = paged
    play(w, [(0, dm(w, A, "warn austin tx", 100)), (20, dm(w, A, "more", 120)),
             (40, dm(w, A, "more", 120))], until=90)
    assert [e[2] for e in w.radio.txs(AK)] == w.pages[:2]
    reason = traffic_log.recent(20, kinds=("dm_copy",))[-1]["reason"]
    assert "same timestamp" in reason and "reply confirmed" in reason


def test_a_first_more_while_page_1_is_unconfirmed_is_a_copy_of_the_command(paged):
    w = paged
    w.radio.ack = lambda key, text, ts, attempt: None if text == w.pages[0] and attempt == 0 else 1.5
    play(w, [(0, dm(w, A, "warn austin tx", 100)), (5, dm(w, A, "more", 105)),
             (30, dm(w, A, "more", 130))], until=90)
    assert [e[2] for e in w.radio.txs(AK)] == [w.pages[0], w.pages[0], w.pages[1]]
    assert "page before it unconfirmed" in traffic_log.recent(20, kinds=("dm_copy",))[0]["reason"]


def test_a_more_without_a_sender_timestamp_keeps_the_same_text_rule(paged):
    w = paged
    play(w, [(0, dm(w, A, "warn austin tx", None)), (20, dm(w, A, "more", None)),
             (40, dm(w, A, "more", None))], until=90)
    assert [e[2] for e in w.radio.txs(AK)] == w.pages[:2]


def test_a_sender_that_changes_the_timestamp_on_every_try_gets_one_reply(w):
    play(w, [(0, dm(w, A, "wx austin", 5000)), (5, dm(w, A, "WX  Austin ", 5005)),
             (10, dm(w, A, "wx austin", 5010))], until=60)
    assert len(w.radio.txs(AK)) == 1


def test_after_the_window_the_same_text_is_new_but_a_same_timestamp_copy_is_not(w):
    play(w, [(0, dm(w, A, "wx austin", 7000)), (125, dm(w, A, "wx austin", 7125)),
             (725, dm(w, A, "wx austin", 7000))], until=800)
    assert len(w.radio.txs(AK)) == 2
    copies = traffic_log.recent(10, kinds=("dm_copy",))
    assert len(copies) == 1 and "same timestamp" in copies[0]["reason"]


def test_a_failed_reply_goes_again_as_attempt_3_then_as_a_new_message(w, monkeypatch):
    built = []
    monkeypatch.setattr(w.bot, "_process_command", lambda c, l: built.append(1) or f"answer {len(built)}")
    w.radio.routes[AK] = 1
    w.radio.ack = lambda *a: None                                  # nothing ever confirms
    play(w, [(0, dm(w, A, "wx austin", 9000)), (50, dm(w, A, "wx austin", 9000)),
             (100, dm(w, A, "wx austin", 9000))], until=200)
    tx = w.radio.txs(AK)
    ts0 = tx[0][3]
    assert [(e[4], e[3] == ts0) for e in tx] == [(0, True), (1, True), (2, True), (3, True), (0, False), (1, False)]
    assert tx[4][3] > ts0 and {e[2] for e in tx} == {"answer 1"} and built == [1]     # never rebuilt
    assert [e[5] for e in tx] == [1, 1, -1, -1, -1, -1]
    assert [e[0] for e in w.radio.log].count("reset") == 1 and w.radio.log[2][0] == "reset"
    assert tx[3][6] == pytest.approx(52) and tx[4][6] == pytest.approx(102)


def test_the_rate_limit_never_drops_a_copy_and_a_suppressed_copy_costs_nothing(w):
    play(w, [(0, dm(w, A, "help", 100)), (1, dm(w, A, "help", 101)),        # a copy inside the 5 s spacing
             (6, dm(w, A, "wx austin", 106)),
             (7, dm(w, A, "metar kaus", 107)),                              # 1 s later: the limiter drops it
             (12, dm(w, A, "metar kaus", 112))], until=120)                 # its copy is answered now
    texts = [e[2] for e in w.radio.txs(AK)]
    assert len(texts) == 3 and texts[1].startswith("wx austin") and texts[2].startswith("metar kaus")
    assert [e["reason"] for e in traffic_log.recent(20, kinds=("dropped",))] == ["rate limit"]
    assert len(w.bot._reply_history[AK]) == 3               # help, wx, the metar copy; the help copy is free


def test_contacts_never_wait_on_each_other_and_one_contacts_replies_keep_their_order(w):
    w.radio.ack = lambda key, text, ts, attempt: None if key == AK else 1.0     # A's link is dead
    play(w, [(0, dm(w, A, "wx austin", 1)), (3, dm(w, B, "help", 3)), (6, dm(w, A, "metar kaus", 6)),
             (9, lambda: w.bot._handle_channel_message("1", "Tommy", "help", 0))], until=120)
    a, b = w.radio.txs(AK), w.radio.txs(BK)
    assert len(b) == 1 and b[0][6] == pytest.approx(5)      # B is answered while A's reply is being tried
    assert [e[2][:5] for e in a] == ["wx au", "wx au", "metar", "metar", "help:", "help:"]
    assert [e[6] for e in a] == pytest.approx([2, 8, 14, 20, 26, 32])   # each starts when the one before failed


def test_the_pause_the_route_tries_and_a_late_ack_for_attempt_0(w):
    w.radio.routes[AK] = 3
    w.radio.ack = lambda key, text, ts, attempt: 25.0 if attempt == 0 else None
    play(w, [(10, dm(w, A, "wx austin", 1)), (40, dm(w, A, "wx austin", 1))], until=120)
    log = w.radio.log
    assert [e[0] for e in log] == ["tx", "tx", "reset", "tx"]            # nothing after the last try
    assert log[0][6] == pytest.approx(12.0)                              # 2 s after the request arrived
    assert [(e[4], e[5]) for e in log if e[0] == "tx"] == [(0, 3), (1, 3), (2, -1)]
    row = w.tracker.recent_outcomes()[-1]
    assert row[3] is True and row[6]["ack_attempt"] == 0 and row[6]["late"] is True
    assert row[6]["confirm_ms"] == 25000 and row[6]["route"] == 3
    assert "reply confirmed" in traffic_log.recent(5, kinds=("dm_copy",))[-1]["reason"]


def test_pages_split_on_bytes_never_inside_a_character():
    old = split_pages(GREEK, 147)
    assert any(len(p.encode()) > 156 for p in old)                     # characters alone overflow a DM
    pages = split_pages(GREEK, 147, max_bytes=156)
    assert len(pages) > len(old)
    for i, p in enumerate(pages, 1):
        assert len(p.encode("utf-8")) <= 156 and len(p) <= 147
        assert p.endswith(f"({i}/{len(pages)}) more" if i < len(pages) else f"({i}/{len(pages)})")
    items = [x for p in pages for x in p.rsplit(" (", 1)[0].replace("Αθήνα: ", "").split("; ")]
    assert "; ".join(items) == GREEK.replace("Αθήνα: ", "")               # nothing lost, whole items
    hard = split_pages("é☔" * 200, 147, max_bytes=156)
    assert all(len(p.encode()) <= 156 for p in hard)
    assert "".join(p.rsplit(" (", 1)[0] for p in hard) == "é☔" * 200


def test_every_dm_reply_fits_156_bytes(w, monkeypatch):
    monkeypatch.setattr(w.bot, "_process_command", lambda c, l: GREEK)
    play(w, [(0, dm(w, A, "wx athens", 1)), (30, dm(w, A, "more", 2))], until=90)
    tx = w.radio.txs(AK)
    assert len(tx) == 2 and "(1/" in tx[0][2] and "(2/" in tx[1][2]
    assert all(len(e[2].encode("utf-8")) <= 156 for e in tx)


def test_app_request_copies_are_skipped_at_6_s_and_answered_again_at_15_s(w):
    calls = []

    class Responder:
        async def handle_request(self, text, key, ev=None, not_before=0.0):
            calls.append(w.vc.t - w.vc.t0)
            await w.vc.sleep(1.0)                                         # the datagrams go out
            return "1 packet(s), 20 B"

    w.bot._broadcaster = Responder()
    play(w, [(0, dm(w, A, ">w", 500)), (7, dm(w, A, ">w", 500)), (16, dm(w, A, ">w", 500))], until=60)
    assert calls == pytest.approx([0, 16])                               # 6 s after the answer: skipped; 15 s: again
    assert w.radio.log == []


def test_outcome_rows_carry_the_reply_fields_and_no_text_or_keys(w, tmp_path):
    path = tmp_path / "delivery_outcomes.json"
    w.tracker._persist_path = path
    w.radio.routes[AK] = 2
    w.radio.ack = lambda key, text, ts, attempt: 1.0 if attempt == 1 else None
    play(w, [(0, dm(w, A, "wx austin", 42)), (4, dm(w, A, "wx austin", 42)),
             (15, dm(w, A, "wx austin", 42))], until=120)
    rows = w.tracker.recent_outcomes()
    assert len(rows) == 1
    t, kind, echoed, acked, resent, echo_ms, fields = rows[0]
    assert kind == "dm" and acked is True and resent == 1
    assert fields == {"reply": "answer", "ack_attempt": 1, "late": False, "confirm_ms": 7000, "route": 2,
                      "tries": 2, "messages": 1, "copies": 3, "copy_after_try": True}
    w.tracker.flush_outcomes()                                       # what shutdown does
    saved = path.read_text()
    assert "austin" not in saved.lower() and AK not in saved and "Tommy" not in saved
    again = DeliveryTracker(persist_path=path).recent_outcomes()
    assert again[0][6] == fields and json.loads(saved)["outcomes"][0][6]["copies"] == 3
    ev = traffic_log.recent(10, kinds=("reply_dm",))[-1]
    assert ev["delivery"]["acked"] and ev["delivery"]["ack_attempt"] == 1 and ev["delivery"]["copies"] == 3


# -- review findings --


def quiet(w, key, text, ts):
    """A DM whose handler may raise (the radio logs such an error and carries on)."""
    async def go():
        try:
            await w.bot._handle_dm(key, NAMES[key], text, ts, 2)
        except RuntimeError:
            pass
    return go


def reply_of(w, key, i=0):
    return w.bot._dm_requests._by_key[key[:12]][i].reply


def test_two_contacts_given_the_same_text_in_the_same_second_never_share_an_ack_code(w):
    """The code has no recipient in it: replies to two people with the same
    text and timestamp shared codes, and A's ACK confirmed B's reply."""
    w.radio.ack = lambda key, text, ts, attempt: 1.0 if key == AK else None     # only A's phone answers
    play(w, [(0, dm(w, A, "help", 1)), (0, dm(w, B, "help", 1))], until=90)
    a, b = w.radio.txs(AK), w.radio.txs(BK)
    assert a[0][2] == b[0][2] and int(a[0][6]) == int(b[0][6])                  # same text, same second
    assert a[0][3] != b[0][3] and a[0][7] != b[0][7]
    ra, rb = reply_of(w, A), reply_of(w, B)
    assert ra.state == "confirmed" and ra.tries == 1
    assert rb.state == "failed" and rb.tries == 2
    assert w.tracker._dm_acks == {}


def test_a_reply_whose_first_try_was_refused_goes_again_from_attempt_0_without_a_reset(w):
    w.radio.routes[AK] = 2
    w.radio.refuse = lambda key, text, ts, attempt: w.vc.t - w.vc.t0 < 10       # the node timed out
    play(w, [(0, dm(w, A, "wx austin", 1)), (20, dm(w, A, "wx austin", 1))], until=90)
    log = w.radio.log
    assert [e[0] for e in log] == ["refused", "tx"] and log[1][4] == 0 and log[1][5] == 2
    assert log[1][3] == log[0][3]                                               # its unused timestamp
    fields = w.tracker.recent_outcomes()[-1][6]
    assert fields["messages"] == 1 and fields["tries"] == 1 and fields["route"] == 2


def test_no_ack_code_stays_registered_when_an_ack_lands_while_the_next_try_is_handed_over(w):
    w.radio.ack = lambda *a: None
    w.radio.during = (lambda key, text, ts, attempt:
                      w.tracker.on_ack(w.radio.txs(AK)[0][7]) if attempt == 1 else None)
    play(w, [(0, dm(w, A, "wx austin", 1))], until=60)
    r = reply_of(w, A)
    assert r.state == "confirmed" and r.ack_attempt == 0 and r.tries == 2
    assert w.tracker.recent_outcomes()[-1][6]["tries"] == 2
    assert w.tracker._dm_acks == {}


def test_no_ack_code_stays_registered_after_a_try_raises(w):
    w.radio.ack = lambda *a: None

    def boom(key, text, ts, attempt):
        if attempt == 1:
            raise RuntimeError("serial link gone")

    w.radio.during = boom
    play(w, [(0, dm(w, A, "wx austin", 1))], until=120)
    r = reply_of(w, A)
    assert r.state == "failed" and r.tries == 1
    assert w.tracker.recent_outcomes()[-1][3] is False
    assert w.tracker._dm_acks == {}                                            # held 60 s, then let go


def test_an_ack_handled_before_its_code_is_registered_still_confirms(w):
    """After a stalled event loop the ACK task can run before the try's code is on record."""
    w.radio.ack = lambda *a: None
    w.radio.during = lambda key, text, ts, attempt: w.tracker.on_ack(w.radio.log[-1][7])
    play(w, [(0, dm(w, A, "wx austin", 1))], until=60)
    r = reply_of(w, A)
    assert r.state == "confirmed" and r.ack_attempt == 0 and r.tries == 1
    assert len(w.radio.txs(AK)) == 1 and w.tracker._dm_acks == {}


def test_an_admin_reply_goes_through_the_outbox_after_the_pause(w, monkeypatch):
    monkeypatch.setattr(settings, "admin_key", AK)
    play(w, [(0, dm(w, A, "admin", 1)), (5, dm(w, A, "admin", 1))], until=60)
    tx = w.radio.txs(AK)
    assert len(tx) == 1 and tx[0][2].startswith("Admin commands") and tx[0][6] == pytest.approx(2.0)
    assert w.tracker.recent_outcomes()[-1][6]["reply"] == "admin"
    assert w.radio.dms == []                                                   # never the unqueued send


def test_a_request_that_ended_in_an_error_is_answered_by_its_next_copy(w, monkeypatch):
    built, answers = [], []

    def flaky(c, l):
        built.append(c)
        if len(built) == 1:
            raise RuntimeError("parser blew up")
        return "wx austin: fine"

    class Responder:
        async def handle_request(self, text, key, ev=None, not_before=0.0):
            answers.append(w.vc.t - w.vc.t0)
            if len(answers) == 1:
                raise RuntimeError("answer build failed")
            return "1 packet(s), 20 B"

    monkeypatch.setattr(w.bot, "_process_command", flaky)
    w.bot._broadcaster = Responder()
    play(w, [(0, quiet(w, A, "wx austin", 1)), (20, quiet(w, A, "wx austin", 1)),
             (0, quiet(w, B, ">w", 5)), (6, quiet(w, B, ">w", 5))], until=60)
    assert [e[2] for e in w.radio.txs(AK)] == ["wx austin: fine"]
    assert answers == pytest.approx([0, 6])


def test_outcome_rows_are_saved_at_most_once_a_minute_and_at_shutdown(w, tmp_path, monkeypatch):
    path = tmp_path / "outcomes.json"
    w.tracker._persist_path = path
    writes = []
    save = w.tracker._save_outcomes
    monkeypatch.setattr(w.tracker, "_save_outcomes", lambda: (writes.append(1), save()))
    play(w, [(0, dm(w, A, "wx austin", 42))] + [(10 + i, dm(w, A, "wx austin", 42)) for i in range(4)],
         until=60)
    assert len(writes) == 1                              # the row; four copies inside the minute wait
    w.tracker.flush_outcomes()
    assert len(writes) == 2 and json.loads(path.read_text())["outcomes"][-1][6]["copies"] == 5


def test_a_full_reply_queue_drops_the_next_reply(w, monkeypatch):
    monkeypatch.setattr(w.bot, "_rate_check", lambda *a, **k: True)
    w.radio.ack = lambda *a: None                                               # every reply takes 12 s
    play(w, [(i, dm(w, A, f"wx place{i}", 100 + i)) for i in range(7)], until=120)
    assert [e["reason"] for e in traffic_log.recent(50, kinds=("dropped",))] == ["reply queue full"] * 2
    assert {e[2] for e in w.radio.txs(AK)} == {f"wx place{i}: fine" for i in range(5)}


def test_retransmit_max_0_sends_attempt_0_only(w, monkeypatch):
    monkeypatch.setattr(settings, "retransmit_max", 0)
    w.radio.routes[AK] = 2
    w.radio.ack = lambda *a: None
    play(w, [(0, dm(w, A, "wx austin", 1))], until=60)
    assert [(e[0], e[4]) for e in w.radio.log] == [("tx", 0)]
    assert w.tracker.recent_outcomes()[-1][6]["tries"] == 1
