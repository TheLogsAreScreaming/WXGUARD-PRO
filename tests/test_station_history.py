"""The dashboard's 7-day station history (deploy/goes-dashboard/station_history.py).

It runs beside goesrecv on the Pi; nothing here needs goesrecv or pynng: frames, files and
providers are faked.
"""

import datetime as dt
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy" / "goes-dashboard"))
import station_history as sh  # noqa: E402

UTC = dt.timezone.utc


def vcdu(vc: int, count: int, apid: int | None = None) -> bytes:
    """A 892-byte VCDU: header (VCID in byte 1, 24-bit count in bytes 2-4), then an M_PDU whose
    first packet starts at offset 0 when `apid` is given."""
    head = bytes([0x40, vc & 0x3F]) + count.to_bytes(3, "big") + b"\x00"
    if apid is None:
        mpdu = bytes([0x07, 0xFF])               # no packet starts in this frame
        body = b""
    else:
        mpdu = bytes([0x00, 0x00])
        body = bytes([0x08 | (apid >> 8), apid & 0xFF])
    return (head + mpdu + body).ljust(892, b"\x00")


def test_frames_and_lost_frames_are_counted_per_channel():
    c = sh.VcCounter()
    for n in (10, 11, 12, 15, 16):          # 13 and 14 never arrived
        c.feed(vcdu(25, n, apid=807))
    for n in (100, 101):
        c.feed(vcdu(63, n))
    c.feed(vcdu(21, 5))
    c.feed(vcdu(21, 5 + 200_000))           # a counter reset, not 199,999 lost frames
    got = c.take()
    assert got[25] == (5, 2) and got[63] == (2, 0) and got[21] == (2, 0)
    assert c.info()[25]["apids"] == [807]
    assert c.take() == {}                   # each minute starts at zero


def test_counts_wrap_at_24_bits():
    c = sh.VcCounter()
    c.feed(vcdu(2, (1 << 24) - 1))
    c.feed(vcdu(2, 1))                      # 0 was lost across the wrap
    assert c.take()[2] == (2, 1)


def test_channel_names_say_only_what_is_known():
    assert sh.vc_name(13) == "ABI 13 · clean IR" and sh.vc_name(21) == "EMWIN"
    assert sh.vc_name(32).startswith("DCS") and sh.vc_name(25) is None


def _product(day_dir: Path, made: dt.datetime, arrived: float, seq: int, awips="SAHOURLY") -> None:
    name = f"A_SAUS70KWBC{made:%d%H%M}_C_KWIN_{made:%Y%m%d%H%M%S}_{seq}-2-{awips}.TXT"
    p = day_dir / name
    p.write_text("x")
    os.utime(p, (arrived, arrived))


def test_arrivals_count_only_what_is_new_and_how_late_it_came(tmp_path):
    sdr, inet = tmp_path / "emwin", tmp_path / "inet"
    day = sdr / "2026-10-18"
    day.mkdir(parents=True)
    now = time.time()
    made = dt.datetime.fromtimestamp(now - 3 * 3600, UTC)
    _product(day, made, now - 600, 1)                       # on disk before the first look
    a = sh.Arrivals({"sdr": str(sdr), "inet": str(inet)})
    assert a.poll()["sdr"] == 0
    _product(day, made, now, 2)                             # three hours after NOAA made it
    (inet / "2026-10-18").mkdir(parents=True)
    (inet / "2026-10-18" / "x.TXT").write_text("x")
    got = a.poll()
    assert got["sdr"] == 1 and got["inet"] == 1 and round(got["lags"][0]) == 180
    nxt = sdr / "2026-10-19"                                # a new UTC day: all of it is new
    nxt.mkdir()
    _product(nxt, made, now, 3)
    assert a.poll()["sdr"] == 1


def test_backfill_rebuilds_minutes_from_the_files_on_disk(tmp_path):
    day = tmp_path / "2026-10-18"
    day.mkdir()
    now = time.time()
    minute = (now - 3600) // 60 * 60
    made = dt.datetime.fromtimestamp(minute - 5 * 3600, UTC)
    for i in range(3):
        _product(day, made, minute + 10 + i, i)
    _product(day, made, now - 30, 9)                        # the last two minutes are the recorder's
    rows = sh.backfill(str(tmp_path), now)
    assert rows == [(int(minute), 3, 0, rows[0][3], 3)] and round(rows[0][3]) == 300


def test_a_minute_of_seconds_becomes_one_signal_row():
    secs = [[t, 150 + t % 3, 56, 0, 2] for t in range(55)] + [[t, None, 0, 1, 0] for t in range(55, 60)]
    row = sh.summarize_signal(secs, locked_now=True)
    assert row["vit_med"] == 151 and row["vit_lo"] == 150 and row["vit_hi"] == 152
    assert row["packets"] == 55 * 56 and row["drops"] == 5 and row["rs"] == 110
    assert round(row["locked"], 3) == round(55 / 60, 3)
    assert sh.summarize_signal([], locked_now=False) is None


def _events(store):
    return store.rows("SELECT kind, level, title, t, t_end FROM events WHERE source='live' ORDER BY id")


def _observe(ev, store, now, **kw):
    args = dict(locked=1.0, mode="receive", up_s=10_000, watchdog=0, backup_on=False, nws={"on": False}, lag_30=None)
    args.update(kw)
    with store.tx() as db:
        ev.observe(db, now, **args)


def test_lock_loss_opens_an_event_and_regaining_closes_it(tmp_path):
    store = sh.Store(str(tmp_path / "h.db"))
    ev, t = sh.Events(store), 1_800_000_000
    _observe(ev, store, t)
    _observe(ev, store, t + 60, locked=0.0)
    _observe(ev, store, t + 120, locked=0.0)
    _observe(ev, store, t + 15 * 60, locked=0.5)
    assert _events(store) == [("lock", "bad", "No lock for 14 min", t + 60, t + 15 * 60)]


def test_pointing_and_restarts_are_events(tmp_path):
    store = sh.Store(str(tmp_path / "h.db"))
    ev, t = sh.Events(store), 1_800_000_000
    _observe(ev, store, t, up_s=5000)
    _observe(ev, store, t + 60, mode="point", locked=None, up_s=5060)
    _observe(ev, store, t + 600, mode="receive", up_s=20)       # goesrecv came back after aiming
    _observe(ev, store, t + 660, up_s=80, watchdog=0)
    _observe(ev, store, t + 720, up_s=5, watchdog=1)            # the watchdog's doing
    got = [(k, title) for k, _, title, _, _ in _events(store)]
    assert got == [("pointing", "Pointing mode for 9 min"), ("restart", "goesrecv restarted"),
                   ("restart", "Watchdog restarted goesrecv")]


def test_emwin_late_holds_through_dips_and_ends_after_an_hour_on_time(tmp_path):
    store = sh.Store(str(tmp_path / "h.db"))
    store.db.execute("DELETE FROM events")                      # no seeded open event
    ev, t = sh.Events(store), 1_800_000_000
    _observe(ev, store, t, lag_30=45)
    _observe(ev, store, t + 600, lag_30=286)
    _observe(ev, store, t + 1200, lag_30=8)                     # a dip, as on Oct 17 evening
    _observe(ev, store, t + 1800, lag_30=60)
    _observe(ev, store, t + 2400, lag_30=5)
    _observe(ev, store, t + 2400 + 3000, lag_30=5)
    assert _events(store)[0][4] is None                         # 50 min on time: still open
    _observe(ev, store, t + 2400 + 3600, lag_30=5)
    kind, level, title, t0, t_end = _events(store)[0]
    assert (kind, level, title, t0, t_end) == ("emwin_late", "bad", "EMWIN up to 4 h 46 min late", t, t + 6000)


def test_a_condition_open_at_install_is_continued_not_duplicated(tmp_path):
    # The seed opens "EMWIN fell behind" (Oct 17) and the NWS feed (Oct 19 01:17Z) with no end:
    # both were still going when the history was installed.
    store = sh.Store(str(tmp_path / "h.db"))
    ev, t = sh.Events(store), 1_800_000_000
    _observe(ev, store, t, lag_30=300, nws={"on": True, "reason": "EMWIN 5 h late"})
    assert _events(store) == []
    late = store.rows("SELECT title, t_end FROM events WHERE kind='emwin_late' AND t_end IS NULL")
    assert late == [("EMWIN up to 5 h 00 min late", None)]
    _observe(ev, store, t + 60, nws={"on": False})
    closed = store.rows("SELECT title, t_end FROM events WHERE kind='nws_metar' ORDER BY t DESC LIMIT 1")
    assert closed[0][1] == t + 60 and closed[0][0].startswith("Current conditions from NWS for")


def test_a_condition_back_within_ten_minutes_continues_its_event(tmp_path):
    # The bot restarting reports its NWS feed off for a minute: one spell, not two.
    store = sh.Store(str(tmp_path / "h.db"))
    store.db.execute("DELETE FROM events")
    ev, t = sh.Events(store), 1_800_000_000
    _observe(ev, store, t, nws={"on": True, "reason": "EMWIN 5 h late"})
    _observe(ev, store, t + 3600, nws={"on": False})
    _observe(ev, store, t + 3660, nws={"on": True, "reason": "EMWIN 5 h late"})
    assert _events(store) == [("nws_metar", "info", "Current conditions from NWS over the internet", t, None)]
    _observe(ev, store, t + 7200, nws={"on": False})
    _observe(ev, store, t + 7200 + 900, nws={"on": True})          # 15 min later: a new spell
    rows = _events(store)
    assert len(rows) == 2 and rows[0][2:] == ("Current conditions from NWS for 2 h 00 min", t, t + 7200)


def test_mend_joins_events_split_before_rejoining_existed(tmp_path):
    # Oct 18 as recorded: on by hand, then automatic (both written in at install), then the
    # bot's restart at 23:10 split the automatic spell, the second half recorded live.
    store = sh.Store(str(tmp_path / "h.db"))
    store.db.execute("DELETE FROM events")
    t = 1_800_000_000
    for t0, t1, title, src in ((t - 27300, t - 60, "Switched on by hand", "seed"),
                               (t, t + 10380, "Current conditions from NWS for 2 h 53 min", "seed"),
                               (t + 10440, None, "Current conditions from NWS over the internet", "live"),
                               (t - 90000, t - 86400, "Current conditions from NWS for 1 h 00 min", "live")):
        store.db.execute("INSERT INTO events (t, t_end, kind, level, title, detail, source) VALUES (?,?,?,?,?,?,?)",
                         (t0, t1, "nws_metar", "info", title, "", src))
    with store.tx() as db:
        assert sh.Events(store).mend(db) == 1
    rows = store.rows("SELECT t, t_end, title FROM events ORDER BY t")
    assert rows == [(t - 90000, t - 86400, "Current conditions from NWS for 1 h 00 min"),
                    (t - 27300, t - 60, "Switched on by hand"),
                    (t, None, "Current conditions from NWS over the internet")]


def test_the_internet_fill_is_one_event_and_ends_the_backups_it_replaced(tmp_path):
    # The NWS feed's spell from Oct 19 01:17Z is still open when the bot starts
    # reporting the fill: it closes there, and the fill has its own events.
    store = sh.Store(str(tmp_path / "h.db"))
    ev, t = sh.Events(store), 1_800_000_000
    _observe(ev, store, t, fill={"active": True, "reason": "EMWIN is running 45 min late"})
    nws = store.rows("SELECT t_end, title FROM events WHERE kind='nws_metar' ORDER BY t DESC LIMIT 1")
    assert nws[0][0] == t and nws[0][1].startswith("Current conditions from NWS for")
    assert _events(store) == [("fill", "warn", "Internet filling in for the feed", t, None)]
    _observe(ev, store, t + 3600, fill={"active": False})
    assert _events(store)[0][2:] == ("Internet filled in for 60 min", t, t + 3600)


def test_operator_notes_are_up_until_their_time_or_taken_down_and_stay_in_the_events(tmp_path):
    import pytest
    store = sh.Store(str(tmp_path / "h.db"))
    notes, t = sh.Notes(store), 1_800_000_000
    late = notes.add(t, "  EMWIN is running   two hours late ", "NOAA is on it.", "warn", hours=6)
    open_ = notes.add(t + 60, "Dish maintenance Saturday morning")
    assert late["title"] == "EMWIN is running two hours late" and late["t_end"] == t + 6 * 3600
    assert [n["id"] for n in notes.up(t + 120)] == [open_["id"], late["id"]]           # newest first
    assert [n["id"] for n in notes.up(t + 7 * 3600)] == [open_["id"]]                  # its six hours are up
    assert notes.end(open_["id"], t + 8 * 3600) and notes.up(t + 8 * 3600) == []
    assert not notes.end(open_["id"], t + 9 * 3600)                                     # down already
    assert {n["id"] for n in notes.recent(t + 9 * 3600)} == {late["id"], open_["id"]}
    # The seed history's note is NOAA's word from Oct 18, never one of the operator's up now.
    assert all(n["title"] != "NOAA confirmed the EMWIN delay" for n in notes.recent(t))
    # In the events list with everything else, and a note still up survives the prune.
    rec = sh.Recorder(store, sh.VcCounter(), None, None, *([lambda: None] * 6), emwin_root=str(tmp_path))
    assert any(e["kind"] == "note" and e["title"] == "EMWIN is running two hours late" for e in rec.events_list(t + 9 * 3600))
    forever = notes.add(t, "Up until taken down")
    store.prune(t + 30 * 86400)
    assert [n["id"] for n in notes.up(t + 30 * 86400)] == [forever["id"]]
    assert notes.delete(forever["id"]) and notes.up(t + 30 * 86400) == [] and not notes.delete(forever["id"])
    for bad in (dict(title=" "), dict(title="x" * 121), dict(title="x", level="loud"), dict(title="x", hours=0),
                dict(title="x", hours=24 * 15)):
        with pytest.raises(ValueError):
            notes.add(t, **bad)


def test_the_sun_passes_behind_goes19_from_austin_in_early_october_and_march():
    sun = sh.SunPredictor(30.27, -97.74, -75.2, "America/Chicago", mag_decl=2.6)
    assert (round(sun.az, 1), round(sun.el, 1)) == (140.5, 47.0)
    sep, at = sun.closest(dt.date(2026, 10, 5))
    local = dt.datetime.fromtimestamp(at, sun.tz)
    assert sep < 0.5 and (local.hour, local.minute // 10) == (11, 3)
    assert 4.5 < sun.closest(dt.date(2026, 10, 18))[0] < 5.1
    p = sun.predictions(dt.datetime(2026, 10, 25, 12, tzinfo=UTC).timestamp())
    assert p["satellite"] == {"az": 140.5, "el": 47.0, "compass": 138}
    spring = p["windows"][0]
    assert spring["start"] == "2027-02-23" and spring["end"] == "2027-03-20" and spring["best"] < 0.5


def test_a_recorder_minute_writes_one_row_per_table_and_feeds_the_pages(tmp_path):
    emwin = tmp_path / "emwin"
    (emwin / time.strftime("%Y-%m-%d", time.gmtime())).mkdir(parents=True)
    store = sh.Store(str(tmp_path / "h.db"))
    vc = sh.VcCounter()
    arrivals = sh.Arrivals({"sdr": str(emwin)})
    arrivals.poll()
    now = time.time()
    t = int(now // 60 * 60) - 60
    secs = [[t + i, 160, 56, 0, 3] for i in range(60)]
    rec = sh.Recorder(store, vc, arrivals, sh.SunPredictor(30.27, -97.74, -75.2, "America/Chicago"),
                      seconds=lambda: secs, locked_now=lambda: True, demod=lambda: {"frequency": 22200.0, "gain": 10.6},
                      mode=lambda: "receive", status=lambda: {"goesrecv_up_s": 100, "watchdog": {"restarts": 0}},
                      bot_feed=lambda: {"internet_backup": {"on": False}, "nws_metar": {"on": True, "reason": "x"}},
                      emwin_root=str(emwin))
    for n in range(30):
        vc.feed(vcdu(21, n))
    day = emwin / time.strftime("%Y-%m-%d", time.gmtime())
    for i in range(25):
        _product(day, dt.datetime.fromtimestamp(now - 3600, UTC), now - 10, i)
    rec.minute(now)
    assert store.rows("SELECT vit_med, packets, locked FROM signal") == [(160, 3360, 1.0)]
    assert store.rows("SELECT vc, frames, lost FROM vc") == [(21, 30, 0)]
    assert store.rows("SELECT files, lag_n FROM emwin") == [(25, 25)]
    h = rec.hrit(6)
    assert h["signal"][0][1] == 160 and h["vc"][0]["name"] == "EMWIN" and h["vc"][0]["frames_per_min"] == 30
    assert any(e["kind"] == "note" for e in h["events"]) and h["sun"]["satellite"]["compass"] == 141
    e = rec.emwin(24)
    assert e["hourly"][-1][1] == 25 and round(e["hourly"][-1][3]) == 60 and e["lag_now"] is not None
    assert e["kinds_24h"] == [["SA", 25]]
