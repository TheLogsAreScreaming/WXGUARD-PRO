"""`sat` / `>sat`: the GOES receiver from the monitor's last dashboard sample."""

import os
import time
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from meshcore_weather.core.render_text import MAX_DM
from meshcore_weather.main import HELP_TEXT, WeatherBot
from meshcore_weather.nlp import parse_intent
from meshcore_weather.sdr_monitor import SdrMonitor, receiver_line

T = 1_789_486_426.0


def _sample(t=T, vit=92, packets=56, drops=0, locked=True) -> dict:
    """/api/state as the Pi's dashboard sends it: a minute of per-second history rows."""
    return {
        "mode": "receive", "t": t,
        "stats": {"vit_avg": vit, "packets": packets, "drops": drops, "rs_sum": 2, "locked": locked,
                  "lock_since": t - 49_628 if locked else None, "freq": 21740.6, "gain": 11.2,
                  "feed_alive": True},
        "history": [[int(t) - i, vit, packets, drops, 2] for i in range(59, -1, -1)],
        "status": {"services": {"goesrecv": "active", "goesproc": "active", "goes-monitor": "inactive"},
                   "latest_emwin": [{"name": "A_ASUS43KBIS151533_C_KWIN_20260915153329_443981-3-RWRBISND.TXT",
                                     "mtime": int(t) - 12}]},
    }


def test_locked_and_good():
    s = _sample()
    s["history"][-1][1:4] = [150, 55, 1]                     # one burst second
    line = receiver_line(s, T, T + 3)
    assert line == "GOES locked 13h47m, signal good (vit 93), dropped 1 of 3360 packets last min, newest EMWIN 15s ago"
    assert len(line) <= MAX_DM


def test_poor_and_fair_signal():
    s = _sample(vit=700)
    s["status"]["services"]["goesproc"] = "failed"
    assert receiver_line(s, T, T) == ("GOES locked 13h47m, signal poor (vit 700), dropped 0 of 3360 packets "
                                      "last min, goesproc failed, newest EMWIN 12s ago")
    assert "signal fair (vit 450)" in receiver_line(_sample(vit=450), T, T)


def test_drops_come_from_the_minute_of_history_not_the_last_second():
    s = _sample(vit=95, drops=1)
    s["stats"]["drops"] = 0
    assert "signal fair (vit 95), dropped 60 of 3420 packets last min" in receiver_line(s, T, T)
    assert "signal poor (vit 95), dropped 240 of 3600 packets last min" in receiver_line(_sample(vit=95, drops=4), T, T)


def test_no_lock_and_not_reporting():
    assert receiver_line(_sample(vit=None, packets=0, locked=False), T, T) == \
        "GOES NOT locked, no packets last min, newest EMWIN 12s ago"
    assert receiver_line(None, None, T) == "GOES receiver not reporting (no dashboard reading), no EMWIN file yet"
    # A stale sample's numbers and EMWIN time are not passed off as now; the bot's own newest file still counts.
    assert receiver_line(_sample(), T, T + 300, emwin_mtime=T - 20) == \
        "GOES receiver not reporting (last reading 5m ago), newest EMWIN 5m ago"
    dead = _sample()
    dead["stats"]["feed_alive"] = False
    dead["status"]["services"]["goesrecv"] = "failed"
    assert receiver_line(dead, T, T) == "GOES receiver not reporting (goesrecv failed), newest EMWIN 12s ago"
    point = _sample()
    point["mode"] = "point"
    del point["stats"]
    assert receiver_line(point, T, T) == "GOES receiver in pointing mode, goesrecv stopped, newest EMWIN 12s ago"


def test_monitor_reports_its_last_sample_until_it_goes_stale():
    m = SdrMonitor("http://127.0.0.1:1")
    m.observe(_sample(), now=T)
    assert m.report(now=T + 5).startswith("GOES locked 13h47m, signal good (vit 92)")
    assert m.report(now=T + 121).startswith("GOES receiver not reporting (last reading 2m ago)")


@pytest.mark.asyncio
async def test_sat_words_help_and_places_that_start_with_them():
    for text in ("sat", "Satellite", "goes?", "SIGNAL"):
        assert await parse_intent(text) == {"command": "sat", "location": ""}
    assert await parse_intent("satellite beach fl") == {"command": "wx", "location": "satellite beach fl"}
    assert await parse_intent("signal mountain tn") == {"command": "wx", "location": "signal mountain tn"}
    assert ", sat," in HELP_TEXT and len(HELP_TEXT) <= 147
    assert WeatherBot()._process_command("sat", "") == \
        "No satellite receiver on this bot: its EMWIN comes over the internet"


@pytest.mark.asyncio
async def test_status_gives_the_operators_notices_from_the_dashboard_and_the_public_page(monkeypatch):
    import httpx
    from meshcore_weather.config import settings
    for text in ("status", "Status?", "notices", "NOTICE"):
        assert await parse_intent(text) == {"command": "status", "location": ""}
    assert await parse_intent("status tx") == {"command": "wx", "location": "status tx"}
    from meshcore_weather.nlp import is_conversation
    assert not is_conversation("status", resolve=lambda q: None, states={"TX"})     # a request on the channel too
    assert ", status," in HELP_TEXT
    monkeypatch.setattr(settings, "sdr_dashboard_public_url", "https://goes.digitaino.com")
    notes = [{"id": 2, "t": 1, "t_end": None, "title": "EMWIN is running about two hours late",
              "detail": "NOAA is working on the link to the uplink site."},
             {"id": 1, "t": 1, "t_end": 2, "title": "Long over", "detail": ""}]

    def dashboard(request):
        return httpx.Response(200, json=_sample() if request.url.path == "/api/state" else {"up": notes})

    m = SdrMonitor("http://dash.test")
    async with httpx.AsyncClient(transport=httpx.MockTransport(dashboard)) as client:
        await m.poll(client)
    bot = WeatherBot()
    bot._sdr_monitor = m
    assert bot._process_command("status", "") == ("Notice: EMWIN is running about two hours late. goes.digitaino.com; "
                                                  "NOAA is working on the link to the uplink site.")   # the ended one is left out
    # A long note: page 1 alone is the headline and where to read more.
    m.notes = [dict(notes[0], title="Weather data is late because of a NOAA problem, not our station", detail="x " * 300)]
    first, more = bot.reply_chunk("status", "", "k")
    assert first.startswith("Notice: Weather data is late because of a NOAA problem, not our station. goes.digitaino.com (1/")
    assert more
    m.notes = []
    assert bot._process_command("status", "") == "No notices from the operator. EMWIN on time. goes.digitaino.com"
    assert bot._process_command("help", "").endswith(", more. goes.digitaino.com")


def test_sdr_source_remembers_its_newest_file(tmp_path):
    from meshcore_weather.emwin.fetcher import SDRSource
    now = datetime.now(timezone.utc)
    d = tmp_path / f"{now:%Y-%m-%d}"
    d.mkdir()
    for i, age in enumerate((300, 40)):
        p = d / f"A_WOXX20KWNP{now:%d%H%M}_C_KWIN_{now:%Y%m%d%H%M%S}_{i:06d}-1-WATA20US.TXT"
        p.write_bytes(b"WOXX20 KWNP 151200\r\r\nbody")
        os.utime(p, (now.timestamp() - age, now.timestamp() - age))
    src = SDRSource(root=tmp_path)
    assert src.newest_mtime is None
    assert src.scan() == 2 and src.newest_mtime == pytest.approx(now.timestamp() - 40)


@pytest.mark.asyncio
async def test_app_request_sat_is_text_subject_8_even_when_not_reporting(monkeypatch):
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol import v5
    from meshcore_weather.protocol.broadcaster import AppResponder
    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    sent = []

    async def cap(data, data_type=0xFF10, ev=None):
        sent.append(data)
        return True
    radio.send_channel_data = cap
    bot = WeatherBot()
    bot._sdr_monitor = SdrMonitor("http://127.0.0.1:1")
    r = AppResponder(WeatherStore(), radio, render_text=bot._process_command)

    await r.handle_request(">sat", "a")
    d = v5.decode(sent[-1])
    assert (d["name"], d["subject"]) == ("text", v5.SUBJECT_GENERAL)
    assert d["text"] == "GOES receiver not reporting (no dashboard reading), no EMWIN file yet"

    now = time.time()
    bot._sdr_monitor.observe(_sample(t=now), now=now)
    await r.handle_request(">sat", "b")
    d = v5.decode(sent[-1])
    assert (d["name"], d["subject"], d["total"]) == ("text", v5.SUBJECT_GENERAL, 1)
    assert d["text"].startswith("GOES locked 13h47m, signal good (vit 92), dropped 0 of 3360 packets last min, newest EMWIN 1")
