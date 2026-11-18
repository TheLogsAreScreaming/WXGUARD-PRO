"""The status channel (status_channel.py): one line per change, none for a
flap, no more than the rate limits allow, and never on the request channel."""

import asyncio
from types import SimpleNamespace

import pytest

from meshcore_weather.config import settings
from meshcore_weather.main import WeatherBot
from meshcore_weather.status_channel import MAX_LEN, PER_HOUR, REPEAT_S, StatusReporter

T = 1_800_000_000.0


def _state(locked=True, disk=49, temp=51.0, throttled="0x0", stats=True) -> dict:
    """/api/state as the Pi's dashboard sends it, the parts the reporter reads."""
    s = {"mode": "receive", "t": T,
         "status": {"disk_used_pct": disk, "temp": temp, "services": {"goesrecv": "active"}}}
    if throttled is not None:
        s["status"]["throttled"] = throttled
    if stats:
        s["stats"] = {"locked": locked, "vit_avg": 300, "feed_alive": True}
    return s


def _feed(on=False, added=0, lag=None, quiet=3.0, why="the dish has been quiet for 14 min"):
    """The EMWIN source as the reporter sees it: its internet fill (filling in
    or not, why, how much this spell) and how late it runs."""
    fill = SimpleNamespace(active_since=1 if on else None, spell_filled=added, reason=lambda now=None: why)
    return SimpleNamespace(fill=fill, feed_lag_min=lag, dish_quiet_min=lambda now=None: quiet)


def _reporter() -> StatusReporter:
    async def never(text):
        raise AssertionError("check() does no I/O")
    return StatusReporter(send=never)


def _check(r, now, state=None, reachable=True, feed=None):
    return r.check(now, state if state is not None else _state(), reachable, feed or _feed())


# -- the conditions -----------------------------------------------------------------


def test_lock_lost_is_said_after_ten_minutes_and_locked_again_once():
    r = _reporter()
    assert _check(r, T, _state(locked=False)) == []
    assert _check(r, T + 599, _state(locked=False)) == []
    assert _check(r, T + 600, _state(locked=False)) == ["GOES lock lost 10m"]
    assert _check(r, T + 610, _state(locked=False)) == []                 # said once
    assert _check(r, T + 900, _state(locked=True)) == ["GOES locked again"]
    assert _check(r, T + 910, _state(locked=True)) == []


def test_a_flap_is_not_an_outage():
    r = _reporter()
    for i in range(12):                                                    # 2 min down, 3 min up, for an hour
        down = i % 2 == 0
        assert _check(r, T + i * 300, _state(locked=not down)) == []
        assert _check(r, T + i * 300 + 120, _state(locked=not down)) == []


def test_pointing_mode_is_not_a_lost_lock():
    r = _reporter()
    pointing = _state(locked=False)
    pointing["mode"] = "point"
    for i in range(10):                                                    # half an hour of pointing
        assert _check(r, T + i * 180, pointing) == []
    assert _check(r, T + 1800, _state(locked=False)) == []                 # back to receive: the clock starts now
    assert _check(r, T + 2399, _state(locked=False)) == []
    assert _check(r, T + 2400, _state(locked=False)) == ["GOES lock lost 10m"]
    assert _check(r, T + 2500, pointing) == []                             # pointing to fix it
    assert _check(r, T + 2600, _state(locked=True)) == ["GOES locked again"]


def test_no_reading_is_no_evidence_about_the_lock():
    r = _reporter()
    assert _check(r, T, _state(locked=False)) == []
    for i in range(1, 200):                                                # pointing mode, then unreachable
        assert _check(r, T + i * 10, _state(stats=False)) == []
        assert _check(r, T + i * 10 + 5, None, reachable=False) == []
    # Still unlocked when the receiver reports again: the clock never stopped.
    assert _check(r, T + 2000, _state(locked=False)) == ["GOES lock lost 33m"]


def test_the_internet_fill_filling_in_and_done_are_transitions_not_a_state():
    r = _reporter()
    assert _check(r, T, feed=_feed(on=True)) == []                         # the first look is a baseline
    assert _check(r, T + 10, feed=_feed(on=True)) == []
    assert _check(r, T + 20, feed=_feed(on=False, added=12)) == \
        ["internet fill done, the feed is in time again (12 products filled)"]
    assert _check(r, T + 30, feed=_feed(on=False)) == []
    assert _check(r, T + 40, feed=_feed(on=True, why="EMWIN is running 45 min late")) == \
        ["internet filling in (EMWIN is running 45 min late)"]
    assert _check(StatusReporter(send=None), T, feed=None) == []


def test_a_fill_turned_off_in_a_spell_is_said_as_turned_off_not_done():
    r = _reporter()
    assert _check(r, T, feed=_feed(on=True)) == []
    assert _check(r, T + 10, feed=_feed(on=True)) == []
    off = _feed(on=False, added=40)
    off.fill.enabled = False
    assert _check(r, T + 20, feed=off) == ["internet fill turned off"]
    assert _check(r, T + 30, feed=off) == []


def test_products_behind_the_uplink_need_two_hours_held_and_clear_after_an_hour_under_45m():
    """17 Oct: NOAA's feed swung between about 20 and 90 minutes late all
    day, and a one-hour line with no hold posted "behind" and "current
    again" every hour. Now two hours, held twenty minutes; clear under 45
    minutes, held an hour."""
    r = _reporter()
    assert _check(r, T, feed=_feed(lag=90)) == []                          # the usual swing: not news
    assert _check(r, T + 600, feed=_feed(lag=130)) == []                   # two hours, not held yet
    assert _check(r, T + 1500, feed=_feed(lag=100)) == []                  # dipped: the hold starts again
    assert _check(r, T + 1600, feed=_feed(lag=300)) == []
    assert _check(r, T + 2800, feed=_feed(lag=300)) == ["products ~5h behind the uplink"]
    assert _check(r, T + 2900, feed=_feed(lag=600)) == []                  # said; worse is not news
    assert _check(r, T + 3000, feed=_feed(lag=None)) == []
    assert _check(r, T + 3100, feed=_feed(lag=30)) == []                   # under 45, not for an hour yet
    assert _check(r, T + 4000, feed=_feed(lag=50)) == []                   # back over: the hold starts again
    assert _check(r, T + 4100, feed=_feed(lag=20)) == []
    assert _check(r, T + 7700, feed=_feed(lag=20)) == ["products current again (~20m behind)"]
    assert _check(r, T + 7800, feed=_feed(lag=20)) == []


def test_what_was_said_survives_a_restart(tmp_path):
    """Two restarts on 17 Oct each posted the lag line again."""
    f = tmp_path / "status_state.json"
    sent: list[str] = []

    async def send(line: str) -> bool:
        sent.append(line)
        return True

    one = StatusReporter(send=send, state_file=f)
    asyncio.run(one.tick(T, _state(), True, _feed(lag=300)))
    asyncio.run(one.tick(T + 1200, _state(), True, _feed(lag=300)))
    assert sent == ["status: products ~5h behind the uplink"]
    two = StatusReporter(send=send, state_file=f)                          # the bot restarted
    asyncio.run(two.tick(T + 1300, _state(), True, _feed(lag=300)))
    asyncio.run(two.tick(T + 2600, _state(), True, _feed(lag=300)))
    assert sent == ["status: products ~5h behind the uplink"]              # not said again
    asyncio.run(two.tick(T + 2700, _state(), True, _feed(lag=10)))
    asyncio.run(two.tick(T + 6300, _state(), True, _feed(lag=10)))
    assert sent[-1] == "status: products current again (~10m behind)"      # and cleared, as said before
    three = StatusReporter(send=send, state_file=tmp_path / "missing" / "state.json")
    assert three._lag_said is False                                        # no file yet: a fresh start


def _sender(sent: list[str]):
    async def send(line: str) -> bool:
        sent.append(line)
        return True
    return send


def test_a_restart_in_a_fill_spell_says_neither_done_nor_filling_in_again(tmp_path, monkeypatch):
    """19 Oct: each deploy in a fill spell posted "done (0 products filled)"
    at once and "filling in" a minute later. The fill keeps nothing across a
    restart (it starts off, with nothing filled), so its first look is no news."""
    monkeypatch.setattr(settings, "tx_enabled", True)
    f, sent = tmp_path / "status_state.json", []
    one = StatusReporter(send=_sender(sent), state_file=f)
    asyncio.run(one.tick(T, _state(), True, _feed()))
    asyncio.run(one.tick(T + 60, _state(), True, _feed(on=True, why="EMWIN is running 2 h 04 min late")))
    assert sent == ["status: internet filling in (EMWIN is running 2 h 04 min late)"]
    two = StatusReporter(send=_sender(sent), state_file=f)                 # deployed in the spell
    asyncio.run(two.tick(T + 4800, _state(), True, _feed()))               # the fill afresh: off, 0 filled
    asyncio.run(two.tick(T + 4860, _state(), True, _feed(on=True)))        # and on again a minute later
    assert sent == ["status: internet filling in (EMWIN is running 2 h 04 min late)"]
    asyncio.run(two.tick(T + 9000, _state(), True, _feed(added=40)))       # the spell this run saw ends
    assert sent[1:] == ["status: internet fill done, the feed is in time again (40 products filled)"]
    three = StatusReporter(send=_sender(sent), state_file=f)
    asyncio.run(three.tick(T + 9600, _state(), True, _feed()))
    assert len(sent) == 2                                                  # done is not said again


def test_a_fill_spell_that_ended_while_the_bot_was_down_is_done_after_a_whole_window(tmp_path, monkeypatch):
    """The channel heard "filling in" and the fill does not come on again
    after the restart: "done" once this run's fill has gone its whole
    look-back without filling in (it counts nothing from before the restart)."""
    monkeypatch.setattr(settings, "tx_enabled", True)
    f, sent = tmp_path / "status_state.json", []
    one = StatusReporter(send=_sender(sent), state_file=f)
    asyncio.run(one.tick(T, _state(), True, _feed()))
    asyncio.run(one.tick(T + 60, _state(), True, _feed(on=True)))
    two = StatusReporter(send=_sender(sent), state_file=f)
    asyncio.run(two.tick(T + 4800, _state(), True, _feed()))
    asyncio.run(two.tick(T + 4800 + 1790, _state(), True, _feed()))
    assert len(sent) == 1                                                  # not a whole window yet
    asyncio.run(two.tick(T + 4800 + 1800, _state(), True, _feed()))
    assert sent[1:] == ["status: internet fill done, the feed is in time again"]
    asyncio.run(two.tick(T + 9000, _state(), True, _feed(on=True, why="the dish is quiet")))
    assert sent[2:] == ["status: internet filling in (the dish is quiet)"]  # the next spell is news again


def test_the_dashboard_unreachable_five_minutes_and_back():
    r = _reporter()
    assert _check(r, T, None, reachable=False) == []
    assert _check(r, T + 299, None, reachable=False) == []
    assert _check(r, T + 300, None, reachable=False) == ["receiver dashboard unreachable 5m"]
    assert _check(r, T + 310, None, reachable=False) == []
    assert _check(r, T + 400) == ["receiver dashboard reachable again"]
    assert _check(r, T + 410) == []
    assert _check(r, T + 420, None, reachable=False) == []                 # a blip is nothing


def test_the_pi_disk_temperature_and_throttle_flags_make_one_line_and_one_all_clear():
    r = _reporter()
    assert _check(r, T, _state(disk=90)) == ["Pi: disk 90% full"]
    assert _check(r, T + 10, _state(disk=91, temp=72.4, throttled="0x50005")) == []   # one line until clear
    assert _check(r, T + 20, _state(disk=83, temp=68.0)) == []            # under the line, not yet normal
    assert _check(r, T + 30, _state(disk=70, temp=60.2)) == ["Pi back to normal (disk 70%, CPU 60C)"]
    assert _check(r, T + 40, _state(disk=70, temp=60.2)) == []
    r = _reporter()
    assert _check(r, T, _state(disk=90, temp=75.0, throttled="0x50005")) == \
        ["Pi: disk 90% full, CPU 75C, throttled 0x50005"]
    r = _reporter()
    assert _check(r, T, _state(throttled=None)) == []                      # an older dashboard: no flags
    assert _check(r, T + 10, _state(throttled="0x0")) == []
    assert _check(r, T + 15, _state(throttled="0x50000")) == []                # since-boot bits only: not now
    assert _check(r, T + 20, _state(throttled="0x80008")) == ["Pi: throttled 0x80008"]
    assert _check(r, T + 30, _state(throttled=None)) == ["Pi back to normal (disk 49%, CPU 51C)"]
    r = _reporter()
    assert _check(r, T, _state(temp=70.0)) == ["Pi: CPU 70C"]
    assert _check(r, T + 10, _state(temp=66.0)) == []
    assert _check(r, T + 20, _state(temp=64.9)) == ["Pi back to normal (disk 49%, CPU 65C)"]


# -- the rate limits ----------------------------------------------------------------


def test_the_same_condition_is_not_repeated_within_half_an_hour():
    r = _reporter()
    _check(r, T, None, reachable=False)
    assert _check(r, T + 300, None, reachable=False) == ["receiver dashboard unreachable 5m"]
    assert _check(r, T + 400) == ["receiver dashboard reachable again"]
    _check(r, T + 500, None, reachable=False)
    assert _check(r, T + 800, None, reachable=False) == []                 # 5 min down again, too soon
    assert _check(r, T + 300 + REPEAT_S - 10, None, reachable=False) == []
    assert _check(r, T + 300 + REPEAT_S, None, reachable=False) == ["receiver dashboard unreachable 26m"]
    # The all-clear has its own window: a second one inside it is dropped,
    # not held for later.
    assert _check(r, T + 300 + REPEAT_S + 10) == []
    assert r._down_said is False


def test_at_most_six_lines_an_hour_and_an_alert_waits_its_turn():
    r = _reporter()
    assert _check(r, T, feed=_feed(on=False)) == []
    got = []
    got += _check(r, T + 10, feed=_feed(on=True))
    got += _check(r, T + 20, feed=_feed(on=False, added=1))
    got += _check(r, T + 30, _state(disk=90))
    got += _check(r, T + 40, _state(disk=70))
    _check(r, T + 50, None, reachable=False)
    got += _check(r, T + 350, None, reachable=False)
    got += _check(r, T + 360)
    assert len(got) == PER_HOUR == 6
    # The seventh waits: the disk is still full at every poll, and the line
    # goes out the moment the oldest of the six is an hour old.
    assert _check(r, T + 370, _state(disk=95)) == []
    assert _check(r, T + 3609, _state(disk=95)) == []
    assert _check(r, T + 3610, _state(disk=95)) == ["Pi: disk 95% full"]
    assert _check(r, T + 3620, _state(disk=95)) == []


# -- posting --------------------------------------------------------------------------


def test_tick_keeps_lines_short_and_respects_transmit(monkeypatch):
    sent = []

    async def send(text):
        sent.append(text)
        return True

    monkeypatch.setattr(settings, "tx_enabled", True)
    r = StatusReporter(send=send)
    assert asyncio.run(r.tick(T, _state(locked=False), True, _feed())) == []
    # Two changes in one poll are one line, when they fit.
    out = asyncio.run(r.tick(T + 600, _state(locked=False), True, _feed(on=True, why="the dish has been quiet for 11 min")))
    assert out == sent == ["status: GOES lock lost 10m; internet filling in (the dish has been quiet for 11 min)"]
    out = asyncio.run(r.tick(T + 620, _state(locked=False), True, _feed(on=False, added=2)))
    assert out == ["status: internet fill done, the feed is in time again (2 products filled)"]
    assert all(len(line) <= MAX_LEN for line in sent) and [line for _, line in r.recent] == sent

    # ... and when they do not, two lines, in a fixed order (the limit lowered
    # here: with the short "status:" prefix these three fit in one).
    import meshcore_weather.status_channel as status_channel
    monkeypatch.setattr(status_channel, "MAX_LEN", 80)
    two = StatusReporter(send=send)
    _check(two, T - 600, _state(), feed=_feed(lag=600))                   # the lag's hold starts
    _check(two, T, _state(locked=False), feed=_feed(lag=600))
    out = asyncio.run(two.tick(T + 600, _state(locked=False, disk=90, temp=75.0, throttled="0x50005"), True,
                               _feed(lag=600)))
    assert out == ["status: GOES lock lost 10m; products ~10h behind the uplink",
                   "status: Pi: disk 90% full, CPU 75C, throttled 0x50005"]
    sent.clear()

    monkeypatch.setattr(settings, "tx_enabled", False)
    assert asyncio.run(r.tick(T + 700, _state(locked=True), True, _feed())) == []
    assert sent == []                                                      # nothing went to the sender
    monkeypatch.setattr(settings, "tx_enabled", True)
    assert asyncio.run(r.tick(T + 710, _state(locked=True), True, _feed())) == []   # the clear was spent

    async def refused(text):
        return False
    r = StatusReporter(send=refused)
    _check(r, T, feed=_feed(on=False))
    assert asyncio.run(r.tick(T + 10, _state(), True, _feed(on=True))) == [] and list(r.recent) == []

    # No name of its own in the line: the firmware already puts the node's
    # name before every channel message ("WX-AUS: status: ...").
    plain = StatusReporter(send=send)
    _check(plain, T, feed=_feed(on=False))
    (line,) = asyncio.run(plain.tick(T + 10, _state(), True, _feed(on=True, why="the dish has been quiet for 12 min")))
    assert line == "status: internet filling in (the dish has been quiet for 12 min)"


def test_the_bot_never_posts_status_on_the_request_channel():
    sent = []

    class Radio:
        channel_idx, data_channel_idx = 1, 1
        status_channel_idx = None

        async def send_channel_message(self, channel, text, ev=None):
            sent.append((channel, text))
            return True

    bot = WeatherBot()
    bot.radio = Radio()
    assert asyncio.run(bot._post_status("WX status: x")) is False          # no slot of its own
    bot.radio.status_channel_idx = 1
    assert asyncio.run(bot._post_status("WX status: x")) is False          # the request channel
    bot.radio.status_channel_idx = 3
    assert asyncio.run(bot._post_status("WX status: x")) is True
    assert sent == [(3, "WX status: x")]


def test_the_radio_sends_on_its_status_slot_and_on_no_other(monkeypatch):
    from meshcore_weather.meshcore import radio as radio_mod
    monkeypatch.setattr(settings, "tx_enabled", True)
    r = radio_mod.MeshcoreRadio()
    calls = []

    class Commands:
        async def send_chan_msg(self, channel, text, timestamp=None):
            calls.append(channel)
            return SimpleNamespace(type=radio_mod.EventType.OK, payload={})

        async def get_channel(self, idx):
            return SimpleNamespace(type=radio_mod.EventType.CHANNEL_INFO,
                                   payload={"channel_name": "#x", "channel_secret": b""})

    r._mc = SimpleNamespace(commands=Commands(), self_info={"name": "WX-AUS"})
    r._channel_idx, r._data_channel_idx, r._status_channel_idx = 1, 1, 3
    r._channel_secrets = {}
    monkeypatch.setattr(radio_mod.delivery_tracker, "track", lambda outbound: None)
    assert r.status_channel_idx == 3 and r._role_for(3) == "status"
    assert asyncio.run(r.send_channel_message(3, "status: GOES locked again")) is True
    assert asyncio.run(r.send_channel_message(2, "nope")) is False
    assert asyncio.run(r.send_channel_message(0, "nope")) is False
    assert calls == [3]
    with pytest.raises(ValueError):
        asyncio.run(r.assign_role("status", settings.meshcore_channel))


def test_nothing_is_looked_at_until_the_node_has_the_status_slot():
    """Seen on WX-AUS at a restart (17 Oct): the first poll came before the
    radio had its status slot, the line failed, and the reporter counted it
    as said, so it would never be posted for real."""
    sent: list[str] = []

    async def send(line: str) -> bool:
        sent.append(line)
        return True

    ready = {"slot": False}
    r = StatusReporter(send=send, ready=lambda: ready["slot"])
    assert asyncio.run(r.tick(T, _state(), True, _feed(lag=180))) == []
    ready["slot"] = True
    assert asyncio.run(r.tick(T + 10, _state(), True, _feed(lag=180))) == []
    assert asyncio.run(r.tick(T + 1210, _state(), True, _feed(lag=180))) == ["status: products ~3h behind the uplink"]
