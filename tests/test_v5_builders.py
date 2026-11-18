"""Store data -> v5 messages (protocol/v5_builders.py) and the warnings job
state machine (schedule/executor.py): new, update, repeat, cancel."""

import re
import time
from datetime import datetime, timedelta, timezone

from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.schedule import executor as ex
from meshcore_weather.schedule.models import BroadcastJob


def _warning(etn=42, hours=2, ugcs=("TXC453", "TXC209"), vertices=True, hail=4, wind=60, tornado=0,
             phen="SV", sig="W"):
    now = datetime.now(timezone.utc)
    return {
        "event_code": b.tables.event_code(f"{phen}.{sig}"), "vtec_office": "EWX", "vtec_etn": etn,
        "vtec_phenomenon": phen, "vtec_significance": sig,
        "expires_at": now + timedelta(hours=hours), "onset_unix_min": int(now.timestamp() // 60),
        "ugcs": list(ugcs), "zones": [u for u in ugcs if u[2] == "Z"],
        "vertices": [(30.30, -97.90), (30.45, -97.85), (30.40, -97.60), (30.25, -97.65)] if vertices else [],
        "hail_qin": hail, "wind_mph": wind, "tornado_tag": tornado, "flood_source": 0, "flood_damage": 0,
        "headline": "Severe Thunderstorm Warning until 4:45 PM", "description": "60 mph wind and quarter size hail",
    }


def test_warning_message_round_trips_identity_tags_polygon_and_counties():
    w = _warning()
    msg = b.warning_message(7, 0x041D, w)
    d = v5.decode(msg)
    assert d["name"] == "warning" and d["seq"] == 7 and d["bot"] == 0x041D
    assert (d["event"], d["office"], d["etn"]) == b.warning_identity(w)
    assert d["office"] == b.tables.office("EWX") and b.tables.office_code(d["office"]) == "EWX"
    assert d["hail_qin"] == 4 and d["wind_mph"] == 60 and d["expires_min"] == b.expires_min(w)
    assert len(d["polygon"]) == 4 and abs(d["polygon"][0][0] - 30.30) < 0.0002
    counties = {(a["start"], a["county"]) for a in d["areas"]}
    assert counties == {(453, True), (209, True)} and all(a["state"] == b.tables.states.index("TX") for a in d["areas"])
    assert b.identity_str(b.warning_identity(w)) == "SV.W.EWX.42"
    assert b.parse_identity("SV.W.EWX.42") == b.warning_identity(w) and b.parse_identity("XX.Q.EWX.1") is None
    assert len(msg) <= v5.MAX_SEND


def test_oversized_polygon_is_thinned_rather_than_dropped():
    w = _warning()
    w["vertices"] = [(30.0 + i * 0.01, -97.0 - i * 0.01) for i in range(60)]
    w["ugcs"] = [f"TXC{n}" for n in range(1, 120, 2)]           # 60 non-consecutive counties
    msg = b.warning_message(1, 1, w)
    assert msg is not None and len(msg) <= v5.MAX_SEND
    d = v5.decode(msg)
    assert 3 <= len(d["polygon"]) <= 16


def test_digest_lists_identities_soonest_first_and_skips_sps():
    ws = [_warning(etn=1, hours=5), _warning(etn=2, hours=1), {**_warning(etn=3), "vtec_etn": None}]
    d = v5.decode(b.digest_message(3, 9, ws, feed_health=7))
    assert d["name"] == "digest" and d["feed_health"] == 7
    assert [e["etn"] for e in d["entries"]] == [2, 1]
    assert 55 <= d["entries"][0]["expires_rel"] <= 60


class _Ctx:
    """Minimal ExecutorContext stand-in with a controllable warning list."""

    def __init__(self, warnings):
        self.warnings = warnings


def _ctx(monkeypatch, warnings):
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.coverage import Coverage
    monkeypatch.setattr(ex, "extract_active_warnings", lambda store, coverage=None: list(warnings))
    return ex.ExecutorContext(store=WeatherStore(), coverage=Coverage.empty(), seq=b.SeqCounter(), bot=1)


def test_warnings_job_sends_new_then_repeats_then_ignores_wording_then_cancels(monkeypatch):
    w = _warning()
    active = [w]
    ctx = _ctx(monkeypatch, active)
    job = BroadcastJob(id="warnings", name="w", product="warnings", location_type="coverage", interval_minutes=2)

    first = ex._build_warnings(job, ctx)
    assert len(first) == 1 and v5.decode(first[0])["update"] is False
    key = "SV.W.EWX.42"
    assert key in ctx.warning_state and ctx.warning_state[key]["repeat_at"] is not None

    assert ex._build_warnings(job, ctx) == []                     # nothing changed, not yet time to repeat
    ctx.warning_state[key]["repeat_at"] = time.time() - 1
    rep = ex._build_warnings(job, ctx)
    assert len(rep) == 1 and ctx.warning_state[key]["repeat_at"] is None     # the one life-safety repeat

    w["headline"] = "reworded"                                     # wording only: silence
    assert ex._build_warnings(job, ctx) == []
    w["expires_at"] += timedelta(hours=1)                          # material: update flag set
    upd = ex._build_warnings(job, ctx)
    assert len(upd) == 1 and v5.decode(upd[0])["update"] is True

    active.clear()                                                 # gone with time left: cancel
    out = ex._build_warnings(job, ctx)
    assert len(out) == 1 and v5.decode(out[0])["name"] == "cancel" and ctx.cancel_sent
    assert key not in ctx.warning_state


def test_expired_warning_disappears_without_a_cancel(monkeypatch):
    w = _warning(hours=0.05)
    active = [w]
    ctx = _ctx(monkeypatch, active)
    job = BroadcastJob(id="warnings", name="w", product="warnings", location_type="coverage", interval_minutes=2)
    ex._build_warnings(job, ctx)
    active.clear()
    assert ex._build_warnings(job, ctx) == [] and not ctx.cancel_sent


def test_text_messages_chunk_and_share_a_group():
    seq = b.SeqCounter(250)
    msgs = b.text_messages(seq, 5, v5.SUBJECT_AFD, "word " * 80)
    ds = [v5.decode(m) for m in msgs]
    assert len(ds) == 3 and [d["idx"] for d in ds] == [0, 1, 2] and all(d["total"] == 3 for d in ds)
    assert {d["group"] for d in ds} == {250} and [d["seq"] for d in ds] == [250, 251, 252]
    assert "".join(d["text"] for d in ds).split() == ["word"] * 80


# -- Revision 7: the data source ---------------------------------------------------


def test_a_warning_states_the_source_of_the_product_it_came_out_of():
    """The extractor stamps each entry with its product's source; the builder
    puts that on the wire without being told (spec 2.3)."""
    assert v5.decode(b.warning_message(1, 9, _warning()))["source"] == v5.SOURCE_UNSTATED
    dish = v5.decode(b.warning_message(1, 9, {**_warning(), "source": "sdr"}))
    assert dish["source"] == v5.SOURCE_GOES
    net = v5.decode(b.warning_message(1, 9, {**_warning(), "source": "internet"}))
    assert net["source"] == v5.SOURCE_INTERNET
    # An explicit value still wins, for a caller that knows better.
    told = b.warning_message(1, 9, {**_warning(), "source": "sdr"}, source=v5.SOURCE_MIXED)
    assert v5.decode(told)["source"] == v5.SOURCE_MIXED


def test_a_digest_states_the_store_wide_source_it_is_given():
    ws = [_warning(etn=1), _warning(etn=2)]
    assert v5.decode(b.digest_message(3, 9, ws, feed_health=7))["source"] == v5.SOURCE_UNSTATED
    mixed = b.digest_message(3, 9, ws, feed_health=7, source=v5.SOURCE_MIXED)
    assert v5.decode(mixed)["source"] == v5.SOURCE_MIXED


def test_a_cancel_carries_no_source_only_its_reason():
    """Whatever else revision 7 does, type 2's nibble stays a reason code."""
    for reason in range(3):
        d = v5.decode(b.cancel_message(1, 9, (3, 35, 42), reason=reason))
        assert d["reason"] == reason == d["flags"] and "source" not in d


# -- Revision 7: the cut text reply ------------------------------------------------


MAX_TEXT = v5.MAX_TEXT_CHUNKS * v5.MAX_TEXT_BYTES        # 1192 bytes of UTF-8


def _sentences(n: int, word: str = "word") -> str:
    """n sentences of ~50 characters each."""
    return " ".join(f"{word.capitalize()} {' '.join([word] * 8)} number {i}." for i in range(n))


def test_a_reply_that_fits_is_not_flagged_as_cut():
    seq = b.SeqCounter(10)
    msgs = b.text_messages(seq, 5, v5.SUBJECT_AFD, "word " * 80)
    ds = [v5.decode(m) for m in msgs]
    assert len(ds) == 3 and not any(d["cut"] for d in ds)


def test_an_eight_chunk_reply_that_exactly_fits_is_not_flagged():
    """The boundary case: 1192 bytes is eight full chunks and nothing was
    dropped, so the flag must stay clear."""
    text = "a" * MAX_TEXT
    body, cut = b.fit_text(text)
    assert body == text and cut is False
    msgs = b.text_messages(b.SeqCounter(0), 5, v5.SUBJECT_AFD, text)
    ds = [v5.decode(m) for m in msgs]
    assert len(ds) == v5.MAX_TEXT_CHUNKS
    assert not any(d["cut"] for d in ds)
    assert "".join(d["text"] for d in ds) == text
    # One byte more and it no longer fits.
    assert b.fit_text("a" * (MAX_TEXT + 1))[1] is True


def test_a_long_reply_is_cut_at_a_sentence_and_flagged_on_every_chunk():
    text = _sentences(60)                     # comfortably over 1192 bytes
    assert len(text.encode()) > MAX_TEXT
    seq = b.SeqCounter(100)
    msgs = b.text_messages(seq, 5, v5.SUBJECT_AFD, text)
    ds = [v5.decode(m) for m in msgs]
    assert len(ds) == v5.MAX_TEXT_CHUNKS
    # The flag is on EVERY chunk: losing the last packet must not lose it.
    assert all(d["cut"] for d in ds)
    body = "".join(d["text"] for d in ds)
    assert body.endswith(".") and not body.endswith("..")     # no ellipsis
    assert text.startswith(body)                              # a clean prefix
    assert len(body.encode()) <= MAX_TEXT
    # Cut at a sentence: the next character in the source is the space that
    # followed the full stop.
    assert text[len(body)] == " "


def test_the_cut_never_lands_inside_a_word():
    # One long sentence, no full stop anywhere near the limit: the fallback
    # is the last word boundary.
    text = "alpha bravo charlie delta echo foxtrot " * 60
    body, cut = b.fit_text(" ".join(text.split()))
    assert cut is True
    assert not body.endswith(" ") and body.split()[-1] in (
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot"
    )
    assert " ".join(text.split()).startswith(body + " ")


def test_the_cut_prefers_a_sentence_to_a_word_boundary():
    # A full stop early enough to fit, then a very long unpunctuated tail.
    head = _sentences(20)
    text = head + " " + "tail " * 400
    body, cut = b.fit_text(" ".join(text.split()))
    assert cut is True and body == head          # stops at the last full stop


def test_a_cut_reply_still_advances_the_counter_once_per_chunk():
    seq = b.SeqCounter(250)
    msgs = b.text_messages(seq, 5, v5.SUBJECT_AFD, _sentences(60))
    ds = [v5.decode(m) for m in msgs]
    assert [d["seq"] for d in ds] == [(250 + i) & 0xFF for i in range(len(ds))]
    assert {d["group"] for d in ds} == {250}
    assert seq.next() == (250 + len(ds)) & 0xFF   # exactly one number per chunk


def test_text_messages_carries_the_source():
    msgs = b.text_messages(b.SeqCounter(0), 5, v5.SUBJECT_AFD, _sentences(60),
                           source=v5.SOURCE_GOES)
    assert all(v5.decode(m)["source"] == v5.SOURCE_GOES for m in msgs)
    assert all(v5.decode(m)["cut"] for m in msgs)


def test_a_question_or_exclamation_ends_a_sentence_too():
    text = "Is this the end? " + "tail " * 400
    body, cut = b.fit_text(" ".join(text.split()))
    assert cut is True and body == "Is this the end?"


def test_humidity_and_feels_like():
    assert b._humidity(95, 75) in range(50, 56)
    assert b._feels_delta(95, 52, 5) >= 8            # heat index above 100
    assert b._feels_delta(30, None, 20) <= -10       # wind chill
    assert b._feels_delta(70, 50, 5) == 0


# -- Revision 3 ---------------------------------------------------------------------


def _half_hour_ahead(hours=2):
    """A future :00 or :30, so +25 minutes stays inside one 30-minute bucket."""
    return datetime.fromtimestamp((int(time.time() // 1800) + hours * 2) * 1800, timezone.utc)


def test_expiry_extension_inside_one_half_hour_is_sent(monkeypatch):
    w = _warning()
    w["expires_at"] = _half_hour_ahead()
    before = b.warning_fingerprint(w)
    w["expires_at"] += timedelta(minutes=25)                        # 21:00 -> 21:25
    assert b.warning_fingerprint(w) != before
    ctx = _ctx(monkeypatch, [w])
    job = BroadcastJob(id="warnings", name="w", product="warnings", location_type="coverage", interval_minutes=2)
    ex._build_warnings(job, ctx)
    w["expires_at"] += timedelta(minutes=25)
    upd = ex._build_warnings(job, ctx)
    assert len(upd) == 1 and v5.decode(upd[0])["update"] is True


def test_invented_expiry_only_counts_in_half_hours(monkeypatch):
    w = _warning()
    del w["expires_at"]                                             # fallback: now + expiry_minutes
    monkeypatch.setattr(b, "now_min", lambda: 29823900)
    fp = b.warning_fingerprint(w)
    monkeypatch.setattr(b, "now_min", lambda: 29823901)
    assert b.warning_fingerprint(w) == fp
    ufn = {**_warning(), "expires_estimated": True, "expires_at": datetime.fromtimestamp(29823900 * 60, timezone.utc)}
    fp = b.warning_fingerprint(ufn)                                 # until further notice: now + 12 h
    ufn["expires_at"] += timedelta(minutes=1)
    assert b.warning_fingerprint(ufn) == fp


def test_national_centres_are_appended_and_unknown_offices_are_not_sent(caplog):
    assert (b.tables.office("NHC"), b.tables.office("WNS"), b.tables.office("EWX")) == (125, 126, 35)
    watch = {**_warning(phen="TO", sig="A", vertices=False, ugcs=("TXC453",)), "vtec_office": "WNS"}
    assert b.identity_str(b.warning_identity(watch)) == "TO.A.WNS.42"
    assert v5.decode(b.warning_message(1, 1, watch))["office"] == 126
    stray = {**_warning(etn=5), "vtec_office": "XYZ"}
    assert b.warning_identity(stray) is None and b.warning_message(1, 1, stray) is None
    assert [e["etn"] for e in v5.decode(b.digest_message(1, 1, [stray, _warning(etn=7)], 0))["entries"]] == [7]
    assert "XYZ" in caplog.text


def _metar_store(*lines):
    from meshcore_weather.parser.weather import WeatherStore
    ts = datetime.now(timezone.utc) - timedelta(minutes=10)
    store = WeatherStore()
    # Each line's own DDHHMMZ group is what the batch reads as the report time, so it
    # is stamped from the product's time rather than left as whatever the test typed.
    stamped = [re.sub(r"^([A-Z0-9]{4}\s+(?:COR\s+)?)\d{6}Z", rf"\g<1>{ts:%d%H%M}Z", line) for line in lines]
    store.ingest([{"filename": f"A_SAUS70KWBC{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_{i:06d}-2-SAHOURLY.TXT",
                   "raw_text": "SAUS70 KWBC\nMETAR\n" + line} for i, line in enumerate(stamped, 1)])
    return store


def test_absent_metar_groups_go_out_as_unknown():
    store = _metar_store("KAUS 151153Z VRB04KT 31/ FEW250 RMK AO2 SLP123",
                         "KGTU 151156Z AUTO 12/08 A3001",
                         "KHYI 151155Z 00000KT 1 1/2SM BR OVC003 20/19 A2990")
    aus, gtu, hyi = v5.decode(b.obs_message(1, 1, store, ["KAUS", "KGTU", "KHYI"]))["stations"]
    assert aus["temp_f"] == 88 and aus["dewpoint_f"] is None and aus["humidity_pct"] is None
    assert aus["wind_mph"] == 5 and aus["wind_dir_deg"] == 0      # VRB: the nibble has no unknown, 0 is sent
    assert aus["visibility_mi"] is None and aus["pressure_inhg"] is None and aus["sky"] == 1
    assert gtu["wind_mph"] is None and gtu["sky"] == 15 and gtu["pressure_inhg"] == 30.01
    assert hyi["wind_mph"] == 0 and hyi["visibility_mi"] == 1        # 1 1/2 statute miles, rounded down


def test_parse_metar_fractional_and_less_than_visibility():
    from meshcore_weather.protocol.encoders import parse_metar
    vis = lambda group: parse_metar(f"KAUS 151153Z 18005KT {group} OVC002 20/19 A2990")["visibility_mi"]
    assert (vis("1/2SM"), vis("1 1/2SM"), vis("M1/4SM"), vis("3/4SM"), vis("10SM")) == (0.5, 1.5, 0.25, 0.75, 10)
    assert parse_metar("KAUS 151153Z 18005KT OVC002 20/19")["visibility_mi"] is None


def test_out_of_range_pressure_is_unknown_not_a_lost_batch():
    store = _metar_store("PADK 151153Z 18005KT 10SM CLR 08/05 A2870",
                         "KGTU 151156Z 18005KT 10SM CLR 20/10 A3001",
                         "PAFA 151153Z 00000KT 10SM CLR M40/M44 A3160")
    stations = [s["pressure_inhg"] for s in v5.decode(b.obs_message(1, 1, store, ["PADK", "KGTU", "PAFA"]))["stations"]]
    assert stations == [None, 30.01, None]


# -- Revision 5: per-station observation ages and the warning issue time ------------


def _aged_metar_store(pairs):
    """One hourly product per station, so each METAR carries its own time.
    `pairs` is (minutes before now, METAR line)."""
    from meshcore_weather.parser.weather import WeatherStore
    now = datetime.now(timezone.utc)
    store = WeatherStore()
    store.ingest([
        {"filename": f"A_SAUS70KWBC{ts:%d%H%M}_C_KWIN_{ts:%Y%m%d%H%M%S}_{i:06d}-2-SAHOURLY.TXT",
         # The report's own DDHHMMZ group is its time, so it is stamped from `ts`.
         "raw_text": "SAUS70 KWBC\nMETAR\n"
                     + re.sub(r"^([A-Z0-9]{4}\s+(?:COR\s+)?)\d{6}Z", rf"\g<1>{ts:%d%H%M}Z", line)}
        for i, (ts, line) in enumerate(
            ((now - timedelta(minutes=m), line) for m, line in pairs), 1)
    ])
    return store


def _clear(icao):
    return f"{icao} 151153Z 18005KT 10SM CLR 20/10 A3001"


def test_each_station_says_how_far_behind_the_batch_time_its_own_report_is():
    """The batch timestamp is the newest METAR in it, so one station reads 0
    and the others say how much older they are: "as of 8:24 PM" then belongs
    to a station, not to the packet (spec 6, revision 5)."""
    store = _aged_metar_store([(4, _clear("KAUS")), (25, _clear("KGTU")), (118, _clear("KHYI"))])
    d = v5.decode(b.obs_message(1, 1, store, ["KAUS", "KGTU", "KHYI"]))
    assert d["flags"] == v5.FLAG_OBS_AGES
    assert [s["age_min"] for s in d["stations"]] == [0, 20, 110]
    # ts is the newest report's minute, not "now".
    newest = store._find_metar_raw("KAUS")[1]
    assert d["ts_min"] == int(newest.timestamp() // 60)


def test_a_full_batch_drops_its_farthest_station_to_carry_the_ages():
    """Thirteen stations are 152 bytes on their own, so the ages cost the
    thirteenth — the farthest, since the list arrives nearest first — rather
    than being sent for some stations and not others."""
    icaos = ["KAUS", "KATT", "KGTU", "KHYI", "KEDC", "KBAZ", "KRYW",
             "KDZB", "KSSF", "KSAT", "KTPL", "KILE", "KGRK"]
    assert len(icaos) == b.MAX_OBS_STATIONS == v5.MAX_STATIONS
    store = _aged_metar_store([(5 + i, _clear(c)) for i, c in enumerate(icaos)])
    msg = b.obs_message(1, 1, store, icaos)
    assert len(msg) == 147 <= v5.MAX_SEND
    d = v5.decode(msg)
    assert d["flags"] == v5.FLAG_OBS_AGES
    assert len(d["stations"]) == v5.MAX_STATIONS_WITH_AGES == 12
    dropped = b.tables.station("KGRK")                 # the farthest, last in the list
    assert dropped not in {s["station"] for s in d["stations"]}
    assert all(s["age_min"] is not None for s in d["stations"])


def test_twelve_stations_keep_every_age():
    icaos = ["KAUS", "KATT", "KGTU", "KHYI", "KEDC", "KBAZ", "KRYW",
             "KDZB", "KSSF", "KSAT", "KTPL", "KILE"]
    store = _aged_metar_store([(5, _clear(c)) for c in icaos])
    d = v5.decode(b.obs_message(1, 1, store, icaos))
    assert len(d["stations"]) == 12 and all(s["age_min"] == 0 for s in d["stations"])


def test_a_warning_carries_the_issue_time_and_keeps_it_when_the_polygon_goes():
    issued = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(minutes=37)
    w = {**_warning(), "issued_at": issued}
    d = v5.decode(b.warning_message(7, 0x041D, w))
    assert d["flags"] & v5.FLAG_WARNING_ISSUED
    assert d["issued_min"] == int(issued.timestamp() // 60) == b.issued_min(w)

    big = {**w, "vertices": [(30.0 + i * 0.01, -97.0 - i * 0.01) for i in range(60)],
           "ugcs": [f"TXC{n}" for n in range(1, 120, 2)]}
    msg = b.warning_message(1, 1, big)
    assert msg is not None and len(msg) <= v5.MAX_SEND
    d = v5.decode(msg)
    assert 3 <= len(d["polygon"]) <= 16                      # the polygon is what gives way
    assert d["issued_min"] == int(issued.timestamp() // 60)   # the issue time never does


def test_a_warning_with_no_known_issue_time_sends_the_old_form():
    w = _warning()
    assert w.get("issued_at") is None and b.issued_min(w) is None
    d = v5.decode(b.warning_message(1, 1, w))
    assert not d["flags"] & v5.FLAG_WARNING_ISSUED and d["issued_min"] is None


def _austin_point(**changes):
    from meshcore_weather.parser.pfm import parse_pfm
    from tests.test_pfm import SAMPLE_PFM
    pt = parse_pfm(SAMPLE_PFM)[0]
    for k, v in changes.items():
        setattr(pt, k, v)
    return pt


def _serve(monkeypatch, pt):
    from types import SimpleNamespace
    from meshcore_weather.core import services
    monkeypatch.setattr(services, "nearest_pfm_point",
                        lambda store, lat, lon: (pt, SimpleNamespace(timestamp=pt.issue_time), 0.0))


def test_forecast_first_counts_from_the_issue_date_at_the_point(monkeypatch):
    from datetime import date
    from meshcore_weather.parser.pfm import downsample_to_daily
    from meshcore_weather.parser.weather import WeatherStore
    # 03:30Z Saturday is 10:30 PM CDT Friday: an evening issuance, first full day Saturday.
    pt = _austin_point(issue_time=datetime(2026, 4, 11, 3, 30, tzinfo=timezone.utc))
    assert downsample_to_daily(pt)[0].local_date == date(2026, 4, 11)
    _serve(monkeypatch, pt)
    d = v5.decode(b.forecast_message(1, 1, WeatherStore(), pt.lat, pt.lon))
    assert d["first_period"] == 2 and len(d["periods"]) >= 2
    pt.issue_time = datetime(2026, 4, 11, 11, 0, tzinfo=timezone.utc)   # 6 AM CDT Saturday
    assert v5.decode(b.forecast_message(1, 1, WeatherStore(), pt.lat, pt.lon))["first_period"] == 0


def test_a_cold_dry_day_is_not_wintry_but_freezing_rain_is(monkeypatch):
    from meshcore_weather.parser.weather import WeatherStore
    pt = _austin_point()
    for s in pt.slots:
        s.temp_f, s.obvis = 30, None          # frost territory, nothing falling
    _serve(monkeypatch, pt)
    days = v5.decode(b.forecast_message(1, 1, WeatherStore(), pt.lat, pt.lon))["periods"]
    assert days and not any(d["wintry"] for d in days)
    for s in pt.slots:
        s.obvis = "ZR"
    days = v5.decode(b.forecast_message(1, 1, WeatherStore(), pt.lat, pt.lon))["periods"]
    assert all(d["wintry"] for d in days)


def test_forecast_at_shared_coordinates_answers_under_the_index_asked_for(monkeypatch):
    from meshcore_weather.parser.weather import WeatherStore
    b.tables.load()
    lat, lon = b.tables.points[1840][2], b.tables.points[1840][3]
    assert [lat, lon] == b.tables.points[1617][2:4]
    pt = _austin_point(lat=lat, lon=lon, name="Stafford Springs-Tolland CT")
    _serve(monkeypatch, pt)
    fc = lambda *a, **k: v5.decode(b.forecast_message(1, 1, WeatherStore(), *a, **k))["point"]
    assert fc(lat, lon, point=1840) == 1840 and fc(lat, lon, point=1617) == 1617
    assert fc(lat, lon) == 1617                                     # no index asked: the point's own name decides
    pt.name = "Windsor Locks-Hartford CT"
    assert fc(lat, lon) == 1840
    assert fc(30.19, -97.67, point=102) == 1840                     # a substitute keeps its own index


def test_f_request_by_index_carries_that_index(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.broadcaster import AppResponder
    b.tables.load()
    p = b.tables.points[454]
    _serve(monkeypatch, _austin_point(lat=p[2], lon=p[3], name="Conway Lake-Tyler WV"))   # 402's name, 454's place
    radio = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    radio.send_channel_data = AsyncMock(return_value=True)
    asyncio.run(AppResponder(WeatherStore(), radio).handle_request(">f 454", "a"))
    d = v5.decode(radio.send_channel_data.await_args.args[0])
    assert d["name"] == "forecast" and d["point"] == 454


# -- `>f <lat>,<lon>` (spec 14, revision 10) -------------------------------------------


def _ask(monkeypatch, text):
    """One request through the responder, returning the decoded answer."""
    import asyncio
    from unittest.mock import AsyncMock, MagicMock
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.broadcaster import AppResponder
    radio = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    radio.send_channel_data = AsyncMock(return_value=True)
    asyncio.run(AppResponder(WeatherStore(), radio, render_text=lambda c, a: None)
                .handle_request(text, "a"))
    return v5.decode(radio.send_channel_data.await_args.args[0])


def test_a_coordinate_is_told_from_a_place_by_its_comma():
    assert b.parse_latlon("35.687,-105.938") == (35.687, -105.938)
    assert b.parse_latlon(" 35.687 , -105.938 ") == (35.687, -105.938)
    assert b.parse_latlon("+30,-97") == (30.0, -97.0)
    # A place is still a place, and a point index is still a point index.
    for text in ("round rock tx", "austin, tx", "102", "78701", "35.687",
                 "35.687,-105.938,0", "", "tx,ok"):
        assert b.parse_latlon(text) is None
    # Out of range reads as not a coordinate: the answer is reason 1 anyway.
    for text in ("95.0,-105.9", "35.6,-200.1", "-91,0"):
        assert b.parse_latlon(text) is None


def test_f_at_a_coordinate_answers_under_the_bundled_point(monkeypatch):
    """The same answer a resolved place gets. The point in the bundle at the
    coordinates the bot actually used is what the answer carries."""
    b.tables.load()
    p = b.tables.points[102]
    _serve(monkeypatch, _austin_point(lat=p[2], lon=p[3], name=p[0]))
    d = _ask(monkeypatch, f">f {p[2]},{p[3]}")
    assert d["name"] == "forecast" and d["point"] == 102


def test_f_at_a_coordinate_answers_0xffff_off_the_bundle(monkeypatch):
    """A point the bundle does not hold at those coordinates is 0xFFFF: the
    phone labels it from the coordinate it asked for. `pfm_points.json` was
    built from one day's products, so this is the ordinary case for the nine
    offices it has no point for at all."""
    # Central Nevada: the nearest bundled point is 70 km away, so whatever
    # the bot forecasts for here is not in the list the phone ships.
    b.tables.load()
    assert b.tables.point_index(38.5, -116.5) == 0xFFFF
    _serve(monkeypatch, _austin_point(lat=38.5, lon=-116.5, name="Railroad Valley-Nye NV"))
    d = _ask(monkeypatch, ">f 38.5,-116.5")
    assert d["name"] == "forecast" and d["point"] == 0xFFFF


def test_f_at_a_coordinate_out_of_range_is_unknown_location(monkeypatch):
    d = _ask(monkeypatch, ">f 95.0,-105.938")
    assert (d["name"], d["request"], d["reason"]) == (
        "not_available", "f", v5.REASON_UNKNOWN_LOCATION
    )


def test_f_at_a_coordinate_with_no_forecast_within_reach(monkeypatch):
    """`nearest_pfm_point` stops at 80 km. Past that the bot holds nothing for
    the place and says so, which is not the same as the bundle holding no
    point near it."""
    from meshcore_weather.core import services
    monkeypatch.setattr(services, "nearest_pfm_point", lambda store, lat, lon: None)
    assert services.FORECAST_MAX_KM == 80.0
    d = _ask(monkeypatch, ">f 35.687,-105.938")
    assert (d["name"], d["request"], d["reason"]) == (
        "not_available", "f", v5.REASON_NO_DATA
    )


# -- The send limit (157 bytes) -----------------------------------------------------------


def test_every_builder_stays_inside_the_send_limit_at_its_maxima(monkeypatch):
    """Every builder, fed more than one packet holds through the fixtures the
    tests above use, sends nothing over `v5.MAX_SEND`. The bot confirms a send
    by hearing a repeater's copy, and the companion firmware never reports a
    copy of a datagram over 157 bytes (it is 183 raw bytes; the frame holds 169)."""
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol import warnings as warnings_mod
    from meshcore_weather.protocol.coverage import Coverage
    from meshcore_weather.radar import cut_tile, read_picture
    from tests.test_radar import FRAMES, STHPL

    sent: dict[str, list[bytes]] = {}

    # Warnings: a 60-vertex polygon, 60 county runs, the issue time and a start.
    issued = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(minutes=37)
    ring = [(30.0 + i * 0.01, -97.0 - i * 0.01) for i in range(60)]
    counties = [f"TXC{n:03d}" for n in range(1, 120, 2)]
    timed = {**_warning(), "issued_at": issued, "onset_at": issued + timedelta(minutes=60)}
    sent["warning"] = [
        b.warning_message(1, 9, {**timed, "vertices": ring, "ugcs": counties}),
        b.warning_message(1, 9, {**timed, "vertices": ring, "ugcs": []}),
        b.warning_message(1, 9, {**timed, "vertices": [], "ugcs": counties}),
    ]
    sent["cancel"] = [b.cancel_message(1, 9, (3, 35, 42), reason=2)]
    sent["digest"] = [b.digest_message(1, 9, [_warning(etn=n, hours=1 + n) for n in range(1, 40)], 0)]

    # Observations: one candidate more than a batch with ages holds.
    icaos = ["KAUS", "KATT", "KGTU", "KHYI", "KEDC", "KBAZ", "KRYW",
             "KDZB", "KSSF", "KSAT", "KTPL", "KILE", "KGRK", "KLZZ"]
    store = _aged_metar_store([(5 + i, _clear(c)) for i, c in enumerate(icaos)])
    sent["observations"] = [b.obs_message(1, 9, store, icaos),
                            b.station_obs_message(1, 9, store, "KAUS")]

    _serve(monkeypatch, _austin_point())
    sent["forecast"] = [b.forecast_message(1, 9, WeatherStore(), 30.19, -97.67)]

    # Coverage: more runs and more offices than the packet carries, both cut.
    zones = {f"TXZ{n:03d}" for n in range(1, 81, 2)} | {f"TXZ{n:03d}" for n in range(100, 140)}
    b.tables.load()
    cov = Coverage(zones=zones, sources={"cities": [], "states": [], "wfos": b.tables.offices[:40]})
    sent["coverage"] = [b.coverage_message(1, 9, cov, (30.2672, -97.7431), 120)]

    # Area sweep: 300 warning runs and 300 watch runs, national and scoped.
    active = [_warning(etn=1, ugcs=[f"TXC{n:03d}" for n in range(1, 600, 2)]),
              _warning(etn=2, phen="TO", sig="A", ugcs=[f"OKC{n:03d}" for n in range(1, 600, 2)])]
    monkeypatch.setattr(warnings_mod, "extract_active_warnings", lambda store, coverage=None, now=None: active)
    sent["area_sweep"] = (b.area_sweep_messages(b.SeqCounter(), 9, WeatherStore())
                          + b.area_sweep_messages(b.SeqCounter(), 9, WeatherStore(), states=["OK", "TX"]))

    sent["text"] = (b.text_messages(b.SeqCounter(), 9, v5.SUBJECT_AFD, _sentences(60))
                    + b.text_messages(b.SeqCounter(), 9, v5.SUBJECT_AFD, "☃ " * 900))
    sent["not_available"] = [b.not_available(1, 9, ">radar", v5.REASON_RATE_LIMITED)]

    # Radar: the fixture picture's whole tile and its partial one, each made
    # too busy for a fine packet.
    picture = read_picture(STHPL, "RADSTHPL")
    frame = FRAMES["RADSTHPL"]
    sent["radar"] = []
    for south, west, zoom in ((32, -98, 0), (24, -100, 1)):
        tile = cut_tile(picture, frame, south, west, zoom)
        r0, r1, c0, c1 = tile.bounds or (0, 31, 0, 31)
        tile.rows = [[(r * 5 + c * 3) % 4 if r0 <= r <= r1 and c0 <= c <= c1 else 0 for c in range(32)]
                     for r in range(32)]
        sent["radar"].append(b.radar_message(1, 9, tile, picture, frame))

    for name, packets in sent.items():
        assert packets and all(p is not None for p in packets), name
        for p in packets:
            # A full digest alone is 160 (v5.MAX_DIGEST_ENTRIES says why).
            assert len(p) <= (v5.MAX_DATA if name == "digest" else v5.MAX_SEND), (name, len(p))
            assert v5.decode(p)["name"] == name
    # The fixtures do reach the limits, so the bound above was tested, not dodged.
    longest = {name: max(len(p) for p in packets) for name, packets in sent.items()}
    assert longest["coverage"] == v5.MAX_SEND
    assert longest["text"] == v5.MAX_SEND
    assert longest["area_sweep"] == 11 + 4 * v5.MAX_SWEEP_ENTRIES_PER_PACKET == 155
    assert longest["digest"] == 10 + 6 * v5.MAX_DIGEST_ENTRIES == 160
    assert longest["observations"] == 9 + 11 * 12 + 6 == 147
    assert all(v5.decode(p)["coarse"] for p in sent["radar"])
