"""Tests for the MeshWX v5 wire codec (docs/MeshWX_v5_Spec.md)."""

from __future__ import annotations

import json
import os

import pytest

from meshcore_weather.protocol import v5

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VECTORS_PATH = os.path.join(ROOT, "docs", "meshwx_v5_vectors.json")
INDEX_PATH = os.path.join(
    ROOT, "meshcore_weather", "client_data", "index.json"
)
PROTOCOL_PATH = os.path.join(
    ROOT, "meshcore_weather", "client_data", "protocol.json"
)

BOT = 0x4C7A
NOW = 29823900  # 2026-09-15 01:00 UTC


# ---------------------------------------------------------------------------
# Re-encoder: rebuild the wire bytes from a decoded dict.  Every round-trip
# test and the vector test go through this, so it doubles as a worked example
# of the decode -> encode mapping an app would implement.
# ---------------------------------------------------------------------------


def reencode(d: dict) -> bytes:
    name = d["name"]
    seq, bot = d["seq"], d["bot"]
    if name == "warning":
        areas = (
            [(a["state"], a["county"], a["start"], a["run"]) for a in d["areas"]]
            if d.get("areas")
            else None
        )
        polygon = (
            [(lat, lon) for lat, lon in d["polygon"]] if d.get("polygon") else None
        )
        return v5.encode_warning(
            seq,
            bot,
            event=d["event"],
            office=d["office"],
            etn=d["etn"],
            expires_min=d["expires_min"],
            tornado=d["tornado"],
            flood_source=d["flood_source"],
            flood_damage=d["flood_damage"],
            hail_qin=d["hail_qin"],
            wind_mph=d["wind_mph"],
            polygon=polygon,
            areas=areas,
            update=d["update"],
            issued_min=d["issued_min"],
            begins_min=d.get("begins_min"),
            source=d["source"],
        )
    if name == "cancel":
        return v5.encode_cancel(
            seq,
            bot,
            event=d["event"],
            office=d["office"],
            etn=d["etn"],
            reason=d["reason"],
        )
    if name == "digest":
        return v5.encode_digest(
            seq,
            bot,
            now_min=d["now_min"],
            feed_health=d["feed_health"],
            entries=[
                (e["event"], e["office"], e["etn"], e["expires_min"])
                for e in d["entries"]
            ],
            source=d["source"],
        )
    if name == "observations":
        return v5.encode_obs(
            seq, bot, ts_min=d["ts_min"], stations=d["stations"],
            source=d["source"],
        )
    if name == "forecast":
        return v5.encode_forecast(
            seq,
            bot,
            point=d["point"],
            issued_min=d["issued_min"],
            first_period=d["first_period"],
            periods=d["periods"],
            source=d["source"],
        )
    if name == "text":
        return v5.encode_text(
            seq,
            bot,
            subject=d["subject"],
            group=d["group"],
            idx=d["idx"],
            total=d["total"],
            text=d["text"],
            source=d["source"],
            cut=d["cut"],
        )
    if name == "not_available":
        return v5.encode_not_available(
            seq, bot, request=d["request"], reason=d["reason"]
        )
    if name == "request":
        return v5.encode_request(
            seq, bot, d["sender"], d["ts"], d["text"]
        )
    if name == "coverage":
        return v5.encode_coverage(
            seq,
            bot,
            lat=d["lat"],
            lon=d["lon"],
            radius_km=d["radius_km"],
            stations=d["stations"],
            offices=d["offices"],
            areas=[
                (a["state"], a["county"], a["start"], a["run"]) for a in d["areas"]
            ],
            zones_cut=d["zones_cut"],
            offices_cut=d["offices_cut"],
        )
    if name == "area_sweep":
        return v5.encode_area_sweep(
            seq,
            bot,
            built_min=d["built_min"],
            group=d["group"],
            idx=d["idx"],
            total=d["total"],
            entries=[
                (e["event"], e["state"], e["county"], e["start"], e["run"])
                for e in d["entries"]
            ],
            cut=d["cut"],
            advisories=d["advisories"],
            source=d["source"],
            scope=d["scope"],
            scoped=d["scoped"],
        )
    if name == "radar":
        return v5.encode_radar(
            seq,
            bot,
            taken_min=d["taken_min"],
            south=d["south"],
            west=d["west"],
            zoom=d["zoom"],
            product=d["product"],
            rows=[[int(ch) for ch in row] for row in d["rows"]],
            bounds=tuple(d["bounds"]) if d["bounds"] is not None else None,
            source=d["source"],
        )
    raise AssertionError(f"no re-encoder for {name!r}")


def roundtrip(data: bytes) -> dict:
    decoded = v5.decode(data)
    assert reencode(decoded) == data
    assert len(data) <= v5.MAX_SEND
    return decoded


#: What a bot before 1 October 2026 filled a packet to: the transport limit,
#: and the counts it allowed.  Every decoder still reads such a packet; only
#: what a bot sends shrank to ``v5.MAX_SEND``.
OLDER_BOT_LIMITS = dict(
    MAX_SEND=v5.MAX_DATA,
    MAX_TEXT_BYTES=157,
    MAX_DIGEST_ENTRIES=25,
    MAX_STATIONS=14,
    MAX_SWEEP_ENTRIES_PER_PACKET=38,
    MAX_COVERAGE_OFFICES=24,
)


def as_an_older_bot(monkeypatch) -> None:
    """Let the encoders build what an older bot sent, to make fixtures for
    the decoders.  The bot itself never does this."""
    for name, value in OLDER_BOT_LIMITS.items():
        monkeypatch.setattr(v5, name, value)


# ---------------------------------------------------------------------------
# Constants and header
# ---------------------------------------------------------------------------


def test_transport_constants():
    assert v5.DATA_TYPE == 0xFF10
    assert v5.MAX_DATA == 165
    assert v5.MAX_SEND == 157
    assert (
        v5.TYPE_WARNING,
        v5.TYPE_CANCEL,
        v5.TYPE_DIGEST,
        v5.TYPE_OBS,
        v5.TYPE_FORECAST,
        v5.TYPE_TEXT,
        v5.TYPE_NOT_AVAILABLE,
        v5.TYPE_COVERAGE,
        v5.TYPE_REQUEST,
        v5.TYPE_AREA_SWEEP,
    ) == (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    assert v5.SUBJECT_WARNING == 0 and v5.SUBJECT_GENERAL == 8
    assert v5.REASON_NO_DATA == 0 and v5.REASON_RATE_LIMITED == 4
    assert v5.TAG_TORNADO_OBSERVED == 3
    assert v5.FLOOD_SOURCE_OBSERVED == 3
    assert v5.FLOOD_DAMAGE_CATASTROPHIC == 2


def test_header_layout():
    # seq 0x11, bot 0x4C7A little-endian, type 1 flags 0 -> 0x10.
    assert v5.encode_header(0x11, 0x4C7A, v5.TYPE_WARNING) == bytes.fromhex(
        "117a4c10"
    )
    assert v5.encode_header(0, 1, v5.TYPE_CANCEL, 2) == bytes.fromhex("00010022")


@pytest.mark.parametrize(
    "seq,bot",
    [(-1, 0), (256, 0), (0, -1), (0, 0x10000)],
)
def test_header_range_checks(seq, bot):
    with pytest.raises(ValueError):
        v5.encode_header(seq, bot, v5.TYPE_DIGEST)


def test_unknown_type_decodes_as_header_only():
    data = v5.encode_header(9, BOT, 13, 3) + b"\x01\x02"
    out = v5.decode(data)
    assert out == {
        "seq": 9,
        "bot": BOT,
        "type": 13,
        "name": "unknown",
        "flags": 3,
    }


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"\x01\x02",
        bytes.fromhex("117a4c1003232a00"),          # warning cut short
        bytes.fromhex("127a4c20030d"),              # cancel cut short
        bytes.fromhex("147a4c30c913c70107"),        # digest cut short
        bytes.fromhex("157a4c40c913c7010301"),      # obs missing stations
        bytes.fromhex("167a4c5066000000000101"),    # forecast cut short
        bytes.fromhex("177a4c60000101"),            # text header cut short
        bytes.fromhex("187a4c7077"),                # not-available cut short
    ],
)
def test_truncated_input_raises(data):
    with pytest.raises(ValueError):
        v5.decode(data)


# ---------------------------------------------------------------------------
# Warning
# ---------------------------------------------------------------------------


def test_warning_roundtrip_polygon_and_areas():
    data = v5.encode_warning(
        17,
        BOT,
        event=3,
        office=35,
        etn=42,
        expires_min=NOW + 45,
        tornado=v5.TAG_TORNADO_RADAR_INDICATED,
        flood_source=v5.FLOOD_SOURCE_RADAR,
        flood_damage=v5.FLOOD_DAMAGE_CONSIDERABLE,
        hail_qin=4,
        wind_mph=60,
        polygon=[(30.52, -97.98), (30.61, -97.62), (30.38, -97.41)],
        areas=[(42, True, 453, 1), (42, True, 209, 3)],
        update=True,
    )
    out = roundtrip(data)
    assert out["name"] == "warning"
    assert out["flags"] == v5.FLAG_WARNING_UPDATE and out["update"] is True
    assert out["tornado"] == 2
    assert out["flood_source"] == 1
    assert out["flood_damage"] == 1
    assert out["hail_qin"] == 4 and out["wind_mph"] == 60
    assert out["polygon"] == [[30.52, -97.98], [30.61, -97.62], [30.38, -97.41]]
    assert out["areas"] == [
        {"state": 42, "county": True, "start": 453, "run": 1},
        {"state": 42, "county": True, "start": 209, "run": 3},
    ]


def test_warning_zones_only_has_no_polygon():
    data = v5.encode_warning(
        1, BOT, event=24, office=35, etn=7, expires_min=NOW + 1080,
        areas=[(42, False, 191, 4)],
    )
    out = roundtrip(data)
    assert out["polygon"] is None
    assert out["areas"] == [
        {"state": 42, "county": False, "start": 191, "run": 4}
    ]
    assert len(data) == 15 + 1 + 4


def test_warning_bare_is_fifteen_bytes():
    data = v5.encode_warning(
        1, BOT, event=3, office=35, etn=1, expires_min=NOW
    )
    assert len(data) == 15
    out = roundtrip(data)
    assert out["polygon"] is None and out["areas"] is None


def test_warning_polygon_vertex_count_limits():
    ring = [(30.0 + i * 0.01, -97.0) for i in range(31)]
    with pytest.raises(ValueError, match="3..30 vertices"):
        v5.encode_warning(
            1, BOT, event=3, office=1, etn=1, expires_min=NOW, polygon=ring
        )
    with pytest.raises(ValueError, match="3..30 vertices"):
        v5.encode_warning(
            1, BOT, event=3, office=1, etn=1, expires_min=NOW,
            polygon=[(30.0, -97.0), (30.1, -97.1)],
        )


def test_warning_polygon_delta_overflow():
    # 0.001 deg in an i16 reaches +/-32.767 deg; 40 deg of latitude does not.
    with pytest.raises(ValueError, match="does not fit in i16"):
        v5.encode_warning(
            1, BOT, event=3, office=1, etn=1, expires_min=NOW,
            polygon=[(30.0, -97.0), (70.0, -97.0), (30.0, -97.1)],
        )
    with pytest.raises(ValueError, match="does not fit in i16"):
        v5.encode_warning(
            1, BOT, event=3, office=1, etn=1, expires_min=NOW,
            polygon=[(30.0, -97.0), (30.1, -140.0), (30.0, -97.1)],
        )
    # Just inside the limit still encodes.
    ok = v5.encode_warning(
        1, BOT, event=3, office=1, etn=1, expires_min=NOW,
        polygon=[(30.0, -97.0), (30.0, -129.767), (30.1, -97.0)],
    )
    assert v5.decode(ok)["polygon"][1] == [30.0, -129.767]


def test_warning_over_the_send_limit_raises():
    ring = [(30.0 + i * 0.01, -97.0 - i * 0.01) for i in range(30)]
    areas = [(42, False, 100 + i, 1) for i in range(30)]
    with pytest.raises(ValueError, match="over the 157-byte send limit"):
        v5.encode_warning(
            1, BOT, event=3, office=1, etn=1, expires_min=NOW,
            polygon=ring, areas=areas,
        )


def test_warning_area_run_limits():
    with pytest.raises(ValueError, match="1..30 runs"):
        v5.encode_warning(
            1, BOT, event=3, office=1, etn=1, expires_min=NOW,
            areas=[(42, False, 100 + i, 1) for i in range(31)],
        )


def test_warning_tag_range_checks():
    for kwargs in ({"tornado": 4}, {"flood_source": 4}, {"flood_damage": 4}):
        with pytest.raises(ValueError):
            v5.encode_warning(
                1, BOT, event=3, office=1, etn=1, expires_min=NOW, **kwargs
            )


# -- Revision 5: the issue time ---------------------------------------------


def _warning(**over):
    kwargs = dict(
        event=3, office=35, etn=42, expires_min=NOW + 45,
        polygon=[(30.52, -97.98), (30.61, -97.62), (30.38, -97.41)],
        areas=[(42, True, 453, 1)],
    )
    kwargs.update(over)
    return v5.encode_warning(17, BOT, **kwargs)


def test_warning_issue_time_roundtrips_as_minutes_before_expiry():
    data = _warning(issued_min=NOW + 24)          # issued 21 min before expiry
    out = roundtrip(data)
    assert out["flags"] == v5.FLAG_WARNING_ISSUED
    assert out["issued_min"] == NOW + 24
    # Two trailing bytes, after the polygon and the areas, holding the gap.
    assert int.from_bytes(data[-2:], "little") == 21
    assert len(data) == len(_warning()) + 2


def test_warning_issue_time_is_the_last_two_bytes_and_nothing_else_moves():
    """A revision 4 decoder stops after the area list, so the old form is the
    new one with its last two bytes and its flag bit taken away."""
    new = _warning(issued_min=NOW - 600, update=True)
    old = _warning(update=True)
    assert new[3] == (1 << 4) | v5.FLAG_WARNING_UPDATE | v5.FLAG_WARNING_ISSUED
    assert new[:3] == old[:3] and new[4:-2] == old[4:]
    assert v5.decode(old)["issued_min"] is None
    # What a revision 4 decoder sees: everything it knows, unchanged.
    was = v5.decode(old)
    now = v5.decode(new)
    assert {k: v for k, v in now.items() if k not in ("flags", "issued_min")} == {
        k: v for k, v in was.items() if k not in ("flags", "issued_min")
    }


def test_warning_issue_time_saturates_rather_than_failing():
    # Two months before the expiry is past the u16; it pins at 45.5 days.
    far = v5.decode(_warning(issued_min=NOW + 45 - 90000))
    assert far["issued_min"] == NOW + 45 - v5.MAX_ISSUED_BEFORE_EXPIRY
    # A product issued after its own expiry is nonsense, not a reason to drop
    # a warning: it encodes as 0, "issued when it expires".
    assert v5.decode(_warning(issued_min=NOW + 100))["issued_min"] == NOW + 45


def test_warning_issue_time_survives_a_polygon_that_has_to_go():
    """The polygon is what a warning sheds under pressure; two bytes of issue
    time must not be the thing that makes the packet too big to send."""
    ring = [(30.0 + i * 0.01, -97.0 - i * 0.01) for i in range(30)]
    areas = [(42, False, 100 + i, 1) for i in range(30)]
    with pytest.raises(ValueError, match="over the 157-byte send limit"):
        v5.encode_warning(
            1, BOT, event=3, office=1, etn=1, expires_min=NOW,
            polygon=ring, areas=areas, issued_min=NOW - 30,
        )
    data = v5.encode_warning(
        1, BOT, event=3, office=1, etn=1, expires_min=NOW,
        polygon=ring[:8], areas=areas[:12], issued_min=NOW - 30,
    )
    assert len(data) <= v5.MAX_SEND
    assert v5.decode(data)["issued_min"] == NOW - 30
    assert len(v5.decode(data)["polygon"]) == 8


def test_warning_truncated_issue_time_raises():
    data = _warning(issued_min=NOW)
    with pytest.raises(ValueError, match="warning issue time"):
        v5.decode(data[:-1])


# ---------------------------------------------------------------------------
# Cancel
# ---------------------------------------------------------------------------


def test_cancel_roundtrip():
    data = v5.encode_cancel(
        19, BOT, event=3, office=35, etn=42, reason=v5.CANCEL_UPGRADED
    )
    assert len(data) == 8
    out = roundtrip(data)
    assert out["name"] == "cancel"
    assert (out["event"], out["office"], out["etn"]) == (3, 35, 42)
    assert out["reason"] == v5.CANCEL_UPGRADED == out["flags"]


# ---------------------------------------------------------------------------
# Digest
# ---------------------------------------------------------------------------


def test_digest_roundtrip_and_relative_expiry():
    data = v5.encode_digest(
        20, BOT, now_min=NOW, feed_health=7,
        entries=[(3, 35, 42, NOW + 45), (24, 35, 7, NOW + 1080)],
    )
    assert len(data) == 10 + 6 * 2
    out = roundtrip(data)
    assert out["now_min"] == NOW and out["feed_health"] == 7
    assert [e["expires_rel"] for e in out["entries"]] == [45, 1080]
    assert [e["expires_min"] for e in out["entries"]] == [NOW + 45, NOW + 1080]


def test_digest_clamps_expiry():
    data = v5.encode_digest(
        1, BOT, now_min=NOW, feed_health=255,
        entries=[(3, 1, 1, NOW - 500), (3, 1, 2, NOW + 999999)],
    )
    entries = v5.decode(data)["entries"]
    assert entries[0]["expires_rel"] == 0        # already past -> 0
    assert entries[1]["expires_rel"] == 0xFFFF   # clamped to u16


def test_digest_empty_and_limit():
    out = roundtrip(v5.encode_digest(1, BOT, now_min=NOW, feed_health=0, entries=[]))
    assert out["entries"] == []
    big = [(3, 1, i, NOW + 10) for i in range(26)]
    with pytest.raises(ValueError, match="at most 25 entries"):
        v5.encode_digest(1, BOT, now_min=NOW, feed_health=0, entries=big)
    # The one message past the send limit: 25 entries is how an app knows the
    # list may have been cut, and released apps act on exactly that.
    full = v5.encode_digest(1, BOT, now_min=NOW, feed_health=0, entries=big[:25])
    assert len(full) == 10 + 6 * 25 == 160 and v5.MAX_SEND < len(full) <= v5.MAX_DATA


# ---------------------------------------------------------------------------
# Observations
# ---------------------------------------------------------------------------


def _station(**over):
    base = dict(
        station=202, temp_f=88, dewpoint_f=72, wind_dir_deg=160, sky=3,
        wind_mph=12, gust_mph=21, visibility_mi=10, pressure_inhg=29.92,
        humidity_pct=59, feels_delta_f=7,
    )
    base.update(over)
    return base


def test_obs_roundtrip():
    data = v5.encode_obs(21, BOT, ts_min=NOW - 7, stations=[_station()])
    assert len(data) == 9 + 11
    out = roundtrip(data)
    assert out["name"] == "observations"
    assert out["ts_min"] == NOW - 7
    s = out["stations"][0]
    assert s["station"] == 202
    assert s["temp_f"] == 88 and s["dewpoint_f"] == 72
    assert s["sky"] == 3
    assert s["wind_dir_deg"] == 157.5 and s["wind_dir"] == "SSE"
    assert s["pressure_inhg"] == 29.92
    assert s["feels_delta_f"] == 7


def test_obs_sentinels():
    data = v5.encode_obs(
        1, BOT, ts_min=NOW,
        stations=[
            _station(
                temp_f=None, dewpoint_f=None, wind_dir_deg=None, sky=None,
                wind_mph=None, gust_mph=None, visibility_mi=None,
                pressure_inhg=None, humidity_pct=None, feels_delta_f=None,
            )
        ],
    )
    # temp/dewpoint -128, dir 0 + sky 15, wind 255, gust 0, vis 255,
    # pressure 255, humidity 255, feels 0.
    assert data[9 + 2:9 + 11] == bytes([0x80, 0x80, 0x0F, 255, 0, 255, 255, 255, 0])
    s = roundtrip(data)["stations"][0]
    assert s["temp_f"] is None and s["dewpoint_f"] is None
    assert s["wind_mph"] is None and s["visibility_mi"] is None
    assert s["pressure_inhg"] is None and s["humidity_pct"] is None
    assert s["sky"] == 15
    assert s["gust_mph"] == 0 and s["feels_delta_f"] == 0


def test_obs_calm_is_direction_zero():
    data = v5.encode_obs(
        1, BOT, ts_min=NOW,
        stations=[_station(wind_dir_deg=None, wind_mph=0, gust_mph=0)],
    )
    s = v5.decode(data)["stations"][0]
    assert s["wind_dir_deg"] == 0.0 and s["wind_mph"] == 0


def test_obs_count_limits():
    with pytest.raises(ValueError, match="1..13 stations"):
        v5.encode_obs(1, BOT, ts_min=NOW, stations=[])
    with pytest.raises(ValueError, match="1..13 stations"):
        v5.encode_obs(1, BOT, ts_min=NOW, stations=[_station()] * 14)
    full = v5.encode_obs(1, BOT, ts_min=NOW, stations=[_station()] * 13)
    assert len(full) == 9 + 11 * 13 == 152 <= v5.MAX_SEND


def test_obs_pressure_out_of_range():
    with pytest.raises(ValueError, match="out of encodable range"):
        v5.encode_obs(1, BOT, ts_min=NOW, stations=[_station(pressure_inhg=28.5)])


# -- Revision 5: per-station ages -------------------------------------------


def test_obs_ages_roundtrip_and_pack_two_stations_to_a_byte():
    data = v5.encode_obs(
        29, BOT, ts_min=NOW,
        stations=[
            _station(station=202, age_min=0),
            _station(station=860, age_min=20),
            _station(station=976, age_min=110),
        ],
    )
    out = roundtrip(data)
    assert out["flags"] == v5.FLAG_OBS_AGES
    assert [s["age_min"] for s in out["stations"]] == [0, 20, 110]
    # Station 0 in the low nibble of the first byte, station 1 in its high
    # nibble, station 2 in the low nibble of the second; the pad stays 0.
    assert data[9 + 11 * 3:] == bytes([0x20, 0x0B])
    assert len(data) == 9 + 11 * 3 + 2


def test_obs_newest_station_has_age_zero():
    """`ts` is the newest report in the batch, so one station always reads 0
    and the line under it is the batch time itself."""
    data = v5.encode_obs(
        1, BOT, ts_min=NOW,
        stations=[_station(age_min=35), _station(station=860, age_min=0)],
    )
    ages = [s["age_min"] for s in v5.decode(data)["stations"]]
    assert 0 in ages and ages == [40, 0]


def test_obs_age_rounds_to_ten_minutes_and_saturates():
    ages = [0, 4, 5, 14, 119, 120, 400]
    data = v5.encode_obs(
        1, BOT, ts_min=NOW,
        stations=[_station(station=200 + i, age_min=a) for i, a in enumerate(ages)],
    )
    # Half up, so a report is never shown as more than 4 minutes fresher than
    # it is; 150 is the nibble's ceiling, read as "150 minutes or more".
    assert [s["age_min"] for s in v5.decode(data)["stations"]] == [
        0, 0, 10, 10, 120, 120, v5.OBS_AGE_MAX_MIN
    ]


def test_obs_ages_are_all_or_nothing():
    with pytest.raises(ValueError, match="every station in the batch or none"):
        v5.encode_obs(
            1, BOT, ts_min=NOW,
            stations=[_station(age_min=0), _station(station=860)],
        )


def test_obs_without_the_age_flag_is_the_old_form_byte_for_byte():
    """A revision 4 decoder stops after the station records, and the bytes it
    reads are the same ones it always read."""
    stations = [_station(station=202), _station(station=860)]
    old = v5.encode_obs(21, BOT, ts_min=NOW, stations=stations)
    new = v5.encode_obs(
        21, BOT, ts_min=NOW,
        stations=[dict(s, age_min=a) for s, a in zip(stations, (0, 30))],
    )
    assert new[:3] == old[:3] and new[4:-1] == old[4:]
    assert old[3] & 0x0F == 0 and new[3] & 0x0F == v5.FLAG_OBS_AGES
    assert all(s["age_min"] is None for s in v5.decode(old)["stations"])


def test_obs_ages_cost_the_thirteenth_station():
    """A full batch is 152 bytes already: the ages do not fit beside it, and
    the encoder says so rather than sending a packet no echo can confirm."""
    full = [_station(station=200 + i, age_min=0) for i in range(v5.MAX_STATIONS)]
    with pytest.raises(ValueError, match="over the 157-byte send limit"):
        v5.encode_obs(1, BOT, ts_min=NOW, stations=full)
    fits = v5.encode_obs(1, BOT, ts_min=NOW, stations=full[:v5.MAX_STATIONS_WITH_AGES])
    assert v5.MAX_STATIONS_WITH_AGES == 12
    assert len(fits) == 9 + 11 * 12 + 6 == 147 <= v5.MAX_SEND


def test_obs_truncated_age_block_raises():
    data = v5.encode_obs(
        1, BOT, ts_min=NOW,
        stations=[_station(age_min=0), _station(station=860, age_min=10)],
    )
    with pytest.raises(ValueError, match="observation ages"):
        v5.decode(data[:-1])


# ---------------------------------------------------------------------------
# Forecast
# ---------------------------------------------------------------------------


def _period(**over):
    base = dict(
        high_f=93, low_f=None, pop_pct=40, sky=3, thunder=True, wintry=False,
        windy=False, fog=False, wind_dir_deg=180, wind_mph=10,
    )
    base.update(over)
    return base


def test_forecast_roundtrip():
    periods = [
        _period(high_f=None, low_f=73, thunder=False, fog=True),
        _period(),
        _period(high_f=None, low_f=72, wintry=True, windy=True),
    ]
    data = v5.encode_forecast(
        22, BOT, point=102, issued_min=NOW - 120, first_period=1, periods=periods
    )
    assert len(data) == 12 + 5 * 3
    out = roundtrip(data)
    assert out["name"] == "forecast"
    assert out["point"] == 102 and out["first_period"] == 1
    assert out["issued_min"] == NOW - 120
    assert out["periods"][0]["high_f"] is None
    assert out["periods"][0]["low_f"] == 73
    assert out["periods"][0]["fog"] is True
    assert out["periods"][1]["low_f"] is None
    assert out["periods"][1]["thunder"] is True
    assert out["periods"][2]["wintry"] is True and out["periods"][2]["windy"] is True
    assert out["periods"][1]["wind_dir_deg"] == 180.0
    assert out["periods"][1]["wind_dir"] == "S"
    assert out["periods"][1]["wind_mph"] == 10


def test_forecast_sentinels_and_speed_quantisation():
    data = v5.encode_forecast(
        1, BOT, point=0xFFFF, issued_min=NOW, first_period=0,
        periods=[
            _period(high_f=None, low_f=None, pop_pct=None, sky=None,
                    wind_dir_deg=None, wind_mph=None),
            _period(wind_mph=200),
        ],
    )
    assert data[12] == 127 and data[13] == 127  # high/low not given
    assert data[14] == 255                      # pop not given
    out = v5.decode(data)
    assert out["point"] == 0xFFFF
    p0, p1 = out["periods"]
    assert p0["high_f"] is None and p0["low_f"] is None and p0["pop_pct"] is None
    assert p0["sky"] == 15
    assert p0["wind_dir_deg"] == 0.0 and p0["wind_mph"] == 0
    assert p1["wind_mph"] == 75  # nibble saturates at 15 -> 75 mph


def test_forecast_count_limits():
    with pytest.raises(ValueError, match="1..14 periods"):
        v5.encode_forecast(
            1, BOT, point=1, issued_min=NOW, first_period=0, periods=[]
        )
    with pytest.raises(ValueError, match="1..14 periods"):
        v5.encode_forecast(
            1, BOT, point=1, issued_min=NOW, first_period=0,
            periods=[_period()] * 15,
        )


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------


def test_text_roundtrip():
    data = v5.encode_text(
        23, BOT, subject=v5.SUBJECT_AFD, group=23, idx=0, total=2, text="hello"
    )
    assert len(data) == 8 + 5
    out = roundtrip(data)
    assert out["name"] == "text"
    assert out["subject"] == v5.SUBJECT_AFD
    assert (out["group"], out["idx"], out["total"]) == (23, 0, 2)
    assert out["text"] == "hello"


def test_text_chunk_limit():
    with pytest.raises(ValueError, match="over the 149-byte limit"):
        v5.encode_text(
            1, BOT, subject=0, group=1, idx=0, total=1, text="x" * 150
        )
    full = v5.encode_text(
        1, BOT, subject=0, group=1, idx=0, total=1, text="x" * 149
    )
    assert len(full) == v5.MAX_SEND


def test_text_chunks_split_and_number():
    body = "A" * 400
    chunks = v5.text_chunks(23, BOT, subject=v5.SUBJECT_WARNING, text=body)
    assert len(chunks) == 3
    decoded = [roundtrip(c) for c in chunks]
    assert [d["seq"] for d in decoded] == [23, 24, 25]
    assert {d["group"] for d in decoded} == {23}
    assert [d["idx"] for d in decoded] == [0, 1, 2]
    assert {d["total"] for d in decoded} == {3}
    assert "".join(d["text"] for d in decoded) == body
    assert [len(c) for c in chunks] == [157, 157, 8 + 400 - 298]


def test_text_chunks_never_split_a_code_point():
    # Three-byte code points: 149 is not a multiple of 3, so a naive split
    # would cut one in half.
    body = "☃" * 200
    chunks = v5.text_chunks(0, BOT, subject=v5.SUBJECT_GENERAL, text=body)
    rebuilt = "".join(v5.decode(c)["text"] for c in chunks)
    assert rebuilt == body
    for c in chunks:
        assert (len(c) - 8) % 3 == 0


def test_text_chunks_seq_wraps():
    chunks = v5.text_chunks(254, BOT, subject=0, text="B" * 400)
    assert [v5.decode(c)["seq"] for c in chunks] == [254, 255, 0]
    assert {v5.decode(c)["group"] for c in chunks} == {254}


def test_text_chunks_too_long():
    with pytest.raises(ValueError, match="over the 8-chunk limit"):
        v5.text_chunks(0, BOT, subject=0, text="C" * (149 * 8 + 1))


def test_text_chunks_empty_text():
    chunks = v5.text_chunks(5, BOT, subject=0, text="")
    assert len(chunks) == 1
    assert v5.decode(chunks[0])["text"] == ""


# ---------------------------------------------------------------------------
# Not available
# ---------------------------------------------------------------------------


def test_not_available_roundtrip():
    data = v5.encode_not_available(
        25, BOT, request="f round rock zz", reason=v5.REASON_UNKNOWN_LOCATION
    )
    assert len(data) == 6
    out = roundtrip(data)
    assert out["name"] == "not_available"
    assert out["request"] == "f" and out["request_code"] == ord("f")
    assert out["reason"] == v5.REASON_UNKNOWN_LOCATION


def test_not_available_strips_the_request_prefix():
    data = v5.encode_not_available(1, BOT, request=">metar KAUS", reason=0)
    assert v5.decode(data)["request"] == "m"
    with pytest.raises(ValueError):
        v5.encode_not_available(1, BOT, request="", reason=0)


# ---------------------------------------------------------------------------
# Request (type 9, spec 11) — the one message that travels app -> bot
# ---------------------------------------------------------------------------

SENDER = bytes.fromhex("010203040506")
REQ_TS = 1789660000


def test_request_roundtrip():
    data = v5.encode_request(1, 0x041D, SENDER, REQ_TS, ">d")
    assert len(data) == 16
    out = roundtrip(data)
    assert out["name"] == "request" and out["type"] == v5.TYPE_REQUEST
    assert out["seq"] == 1 and out["bot"] == 0x041D and out["flags"] == 0
    assert out["sender"] == "010203040506"
    assert out["ts"] == REQ_TS and out["text"] == ">d"

    req = v5.decode_request(data)
    assert (req.seq, req.bot, req.sender_prefix, req.ts, req.text) == (
        1, 0x041D, "010203040506", REQ_TS, ">d"
    )
    assert req.as_dict() == out
    assert not req.for_any_bot


def test_request_layout_is_header_sender_ts_text():
    """Byte for byte, spec 11: 4 header, 6 sender, 4 ts LE, then the text."""
    data = v5.encode_request(7, 0x4C7A, SENDER, REQ_TS, ">o KAUS")
    assert data[:4] == v5.encode_header(7, 0x4C7A, v5.TYPE_REQUEST)
    assert data[3] == 0x90                                   # type 9, flags 0
    assert data[4:10] == SENDER
    assert int.from_bytes(data[10:14], "little") == REQ_TS   # seconds, not minutes
    assert data[14:] == b">o KAUS"                           # the text ends the packet
    assert len(data) == 14 + len(">o KAUS")


def test_request_any_bot_is_ffff():
    req = v5.decode_request(
        v5.encode_request(3, v5.REQUEST_BOT_ANY, SENDER, REQ_TS, ">cov")
    )
    assert req.bot == 0xFFFF and req.for_any_bot


def test_request_accepts_a_hex_sender_and_rejects_a_wrong_length():
    assert v5.encode_request(1, BOT, "010203040506", REQ_TS, ">d") == v5.encode_request(
        1, BOT, SENDER, REQ_TS, ">d"
    )
    for bad in (b"\x01\x02\x03\x04\x05", b"\x01" * 7, "0102030405", "zz" * 6):
        with pytest.raises(ValueError):
            v5.encode_request(1, BOT, bad, REQ_TS, ">d")


def test_request_text_must_start_with_the_prefix_and_fit_forty_bytes():
    assert len(v5.encode_request(1, BOT, SENDER, REQ_TS, ">f " + "x" * 37)) == 54
    with pytest.raises(ValueError):
        v5.encode_request(1, BOT, SENDER, REQ_TS, "d")              # no '>'
    with pytest.raises(ValueError):
        v5.encode_request(1, BOT, SENDER, REQ_TS, "")
    with pytest.raises(ValueError):
        v5.encode_request(1, BOT, SENDER, REQ_TS, ">f " + "x" * 38)  # 41 bytes
    with pytest.raises(ValueError):
        v5.encode_request(1, BOT, SENDER, -1, ">d")


def test_request_carries_utf8_text():
    data = v5.encode_request(1, BOT, SENDER, REQ_TS, ">f Peñitas TX")
    assert v5.decode_request(data).text == ">f Peñitas TX"


@pytest.mark.parametrize(
    "data,why",
    [
        (b"", "empty"),
        (bytes.fromhex("011d0490010203040506600bac6a"), "no text at all, 14 bytes"),
        (bytes.fromhex("011d0480010203040506600bac6a3e64"), "type 8, not 9"),
        (bytes.fromhex("011d0490010203040506600bac6a6464"), "text does not start with '>'"),
        (bytes.fromhex("011d0490010203040506600bac6a3eff"), "text is not UTF-8"),
        (v5.encode_header(1, BOT, v5.TYPE_REQUEST) + SENDER
         + REQ_TS.to_bytes(4, "little") + b">f " + b"x" * 38, "41 bytes of text"),
    ],
)
def test_malformed_requests_are_refused(data, why):
    with pytest.raises(ValueError):
        v5.decode_request(data)
    if len(data) >= 4 and data[3] >> 4 == v5.TYPE_REQUEST:
        with pytest.raises(ValueError):
            v5.decode(data)          # the generic dispatch refuses them too


def test_request_flags_nibble_is_reserved_and_ignored():
    data = bytearray(v5.encode_request(1, BOT, SENDER, REQ_TS, ">d"))
    data[3] |= 0x0F                                   # a future app sets flags
    req = v5.decode_request(bytes(data))
    assert req.flags == 0x0F and req.text == ">d"     # still read as a request


def test_the_spec_vector_is_these_exact_bytes():
    """docs/MeshWX_v5_Spec.md §11 quotes these sixteen bytes; an app checks
    itself against them, so they may never move."""
    assert v5.encode_request(1, 0x041D, SENDER, 1789660000, ">d") == bytes.fromhex(
        "011d0490010203040506600bac6a3e64"
    )
    vector = next(v for v in _vectors() if v["name"] == "request_digest")
    assert vector["hex"] == "011d0490010203040506600bac6a3e64"
    assert vector["decoded"]["sender"] == "010203040506"
    assert vector["decoded"]["ts"] == 1789660000 and vector["decoded"]["text"] == ">d"


# ---------------------------------------------------------------------------
# Data source (flags nibble bits 2-3, revision 7)
# ---------------------------------------------------------------------------


def test_source_constants_and_nibble_arithmetic():
    assert (v5.SOURCE_MASK, v5.SOURCE_SHIFT) == (0x0C, 2)
    assert (
        v5.SOURCE_UNSTATED, v5.SOURCE_GOES, v5.SOURCE_INTERNET, v5.SOURCE_MIXED
    ) == (0, 1, 2, 3)
    # Packing keeps the type's own bits and never spills outside the nibble.
    assert v5.pack_source(v5.SOURCE_INTERNET, v5.FLAG_WARNING_ISSUED) == 0xA
    assert v5.pack_source(v5.SOURCE_MIXED) == 0xC
    assert v5.pack_source(v5.SOURCE_UNSTATED, 0x3) == 0x3
    # Packing twice is packing once: the old source is replaced, not ORed.
    assert v5.pack_source(v5.SOURCE_GOES, 0xC) == 0x4
    for nib in range(16):
        assert v5.unpack_source(nib) == (nib & 0x0C) >> 2
        assert v5.pack_source(v5.unpack_source(nib), nib) == nib
    for bad in (-1, 4, 99):
        with pytest.raises(ValueError):
            v5.pack_source(bad)


@pytest.mark.parametrize(
    "source", [v5.SOURCE_UNSTATED, v5.SOURCE_GOES, v5.SOURCE_INTERNET, v5.SOURCE_MIXED]
)
def test_source_roundtrips_on_every_type_that_carries_it(source):
    """Warning, Digest, Observations, Forecast and Text all read the same two
    bits back, and encode -> decode -> encode stays byte-identical."""
    made = {
        "warning": v5.encode_warning(
            1, BOT, event=3, office=35, etn=42, expires_min=NOW + 45,
            areas=[(42, False, 192, 1)],       # TXZ192
            issued_min=NOW, update=True, source=source,
        ),
        "digest": v5.encode_digest(
            2, BOT, now_min=NOW, feed_health=7,
            entries=[(3, 35, 42, NOW + 45)], source=source,
        ),
        "observations": v5.encode_obs(
            3, BOT, ts_min=NOW, source=source,
            stations=[{"station": 1, "temp_f": 70, "age_min": 20}],
        ),
        "forecast": v5.encode_forecast(
            4, BOT, point=102, issued_min=NOW, first_period=0,
            periods=[{"high_f": 90, "low_f": 70, "pop_pct": 10, "sky": 1}],
            source=source,
        ),
        "text": v5.encode_text(
            5, BOT, subject=v5.SUBJECT_AFD, group=5, idx=0, total=1,
            text="hello", source=source,
        ),
    }
    for name, data in made.items():
        out = roundtrip(data)            # re-encodes to the same bytes
        assert out["name"] == name
        assert out["source"] == source, name
        assert v5.unpack_source(data[3] & 0x0F) == source, name


def test_source_leaves_the_other_flag_bits_alone():
    """A source never eats the update, issued, ages or cut bits."""
    warn = v5.decode(v5.encode_warning(
        1, BOT, event=3, office=35, etn=42, expires_min=NOW + 45,
        areas=[(42, False, 192, 1)], issued_min=NOW, update=True,
        source=v5.SOURCE_INTERNET,
    ))
    assert warn["update"] and warn["issued_min"] == NOW
    assert warn["source"] == v5.SOURCE_INTERNET and warn["flags"] == 0xB

    obs = v5.decode(v5.encode_obs(
        3, BOT, ts_min=NOW, source=v5.SOURCE_GOES,
        stations=[{"station": 1, "temp_f": 70, "age_min": 20}],
    ))
    assert obs["stations"][0]["age_min"] == 20
    assert obs["source"] == v5.SOURCE_GOES and obs["flags"] == 0x5


def test_source_defaults_to_unstated_and_matches_the_old_bytes():
    """A message built without a source is the byte-for-byte revision 6 one:
    an app upgrading reads every old packet as 'unstated'."""
    kwargs = dict(event=3, office=35, etn=42, expires_min=NOW + 45,
                  areas=[(42, False, 192, 1)])
    assert v5.encode_warning(1, BOT, **kwargs) == v5.encode_warning(
        1, BOT, source=v5.SOURCE_UNSTATED, **kwargs
    )
    assert v5.decode(v5.encode_warning(1, BOT, **kwargs))["source"] == v5.SOURCE_UNSTATED
    text = v5.encode_text(5, BOT, subject=0, group=5, idx=0, total=1, text="x")
    assert text[3] & 0x0F == 0
    assert v5.decode(text)["source"] == v5.SOURCE_UNSTATED


def test_cancel_never_carries_a_source():
    """Type 2 spends its whole nibble on a reason code (spec 4), so bits 2-3
    of a Cancel are part of that number and must never be read as a source.
    An app already reads reason 4 as reason 4, not as 'cancelled, internet'."""
    import inspect

    # There is no way to put one in: the encoder takes no `source` at all.
    assert "source" not in inspect.signature(v5.encode_cancel).parameters
    with pytest.raises(TypeError):
        v5.encode_cancel(1, BOT, event=3, office=35, etn=42, source=v5.SOURCE_GOES)

    # And nothing takes one out: every reason 0..15 decodes as itself, whole.
    for reason in range(16):
        data = v5.encode_cancel(1, BOT, event=3, office=35, etn=42, reason=reason)
        out = roundtrip(data)
        assert out["reason"] == reason == out["flags"]
        assert "source" not in out
    # Reason 4 (0b0100) is exactly the bit pattern SOURCE_GOES would occupy.
    assert v5.encode_cancel(1, BOT, event=3, office=35, etn=42, reason=4)[3] == 0x24
    assert v5.decode(v5.encode_cancel(1, BOT, event=3, office=35, etn=42,
                                      reason=4))["reason"] == 4


@pytest.mark.parametrize(
    "data",
    [
        v5.encode_not_available(1, BOT, request="f", reason=1),
        v5.encode_request(1, BOT, b"\x01\x02\x03\x04\x05\x06", 1789660000, ">d"),
        v5.encode_coverage(1, BOT, lat=30.2672, lon=-97.7431, radius_km=120,
                           stations=13, offices=[35], areas=[(42, False, 192, 1)],
                           zones_cut=True, offices_cut=True),
    ],
)
def test_types_without_a_weather_product_state_no_source(data):
    """Request, Not available and Coverage are not built from a weather
    product — Coverage describes the bot's own configuration — so their
    source bits stay 0, whatever else is in the nibble."""
    assert v5.unpack_source(data[3] & 0x0F) == v5.SOURCE_UNSTATED


# ---------------------------------------------------------------------------
# Text cut flag (revision 7)
# ---------------------------------------------------------------------------


def test_text_cut_flag_roundtrips_beside_the_source():
    data = v5.encode_text(
        30, BOT, subject=v5.SUBJECT_AFD, group=30, idx=3, total=8,
        text="the discussion so far.", source=v5.SOURCE_GOES, cut=True,
    )
    assert data[3] == (v5.TYPE_TEXT << 4) | 0x5     # cut bit 0 + source 1
    out = roundtrip(data)
    assert out["cut"] is True and out["source"] == v5.SOURCE_GOES
    assert out["idx"] == 3 and out["total"] == 8


def test_text_is_not_cut_unless_it_says_so():
    out = v5.decode(v5.encode_text(
        30, BOT, subject=0, group=30, idx=0, total=1, text="all of it"
    ))
    assert out["cut"] is False and out["flags"] == 0


def test_text_chunks_put_the_cut_flag_on_every_chunk():
    """Losing the last packet must not lose the fact that the tail is gone."""
    chunks = v5.text_chunks(
        23, BOT, subject=v5.SUBJECT_AFD, text="A" * 400,
        source=v5.SOURCE_INTERNET, cut=True,
    )
    assert len(chunks) == 3
    for c in chunks:
        d = roundtrip(c)
        assert d["cut"] is True and d["source"] == v5.SOURCE_INTERNET


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "deg,nib,compass",
    [
        (0, 0, "N"), (90, 4, "E"), (180, 8, "S"), (270, 12, "W"),
        (350, 0, "N"), (360, 0, "N"), (292.5, 13, "WNW"), (None, 0, "N"),
    ],
)
def test_wind_dir_nibble(deg, nib, compass):
    assert v5.wind_dir_nibble(deg) == nib
    assert v5.nibble_to_compass(nib) == compass


def test_areas_from_ugcs_merges_runs():
    states = ["TX", "OK"]
    assert v5.areas_from_ugcs(
        ["TXZ191", "TXZ192", "TXZ193", "TXZ194", "TXZ200"], states
    ) == [(0, False, 191, 4), (0, False, 200, 1)]


def test_areas_from_ugcs_separates_kind_and_state():
    states = ["TX", "OK"]
    out = v5.areas_from_ugcs(
        ["TXC191", "TXZ191", "TXZ192", "OKZ001", "OKZ002"], states
    )
    # Sorted by (state index, county flag, number): zones before counties.
    assert out == [
        (0, False, 191, 2),
        (0, True, 191, 1),
        (1, False, 1, 2),
    ]


def test_areas_from_ugcs_skips_unknown_states_and_junk():
    states = ["TX"]
    assert v5.areas_from_ugcs(
        ["TXC453", "OKZ001", "ZZZ", "TX453", "txc454"], states
    ) == [(0, True, 453, 2)]


def test_areas_from_ugcs_dedupes():
    assert v5.areas_from_ugcs(["TXZ191", "TXZ191", "TXZ192"], ["TX"]) == [
        (0, False, 191, 2)
    ]


def test_areas_from_ugcs_splits_runs_over_255():
    ugcs = [f"TXZ{n:03d}" for n in range(1, 260)]
    runs = v5.areas_from_ugcs(ugcs, ["TX"])
    assert runs == [(0, False, 1, 255), (0, False, 256, 4)]


# ---------------------------------------------------------------------------
# Bundle files
# ---------------------------------------------------------------------------


def test_index_json_matches_the_source_tables():
    base = os.path.dirname(INDEX_PATH)
    with open(INDEX_PATH, encoding="utf-8") as fh:
        index = json.load(fh)
    with open(os.path.join(base, "wfos.json"), encoding="utf-8") as fh:
        wfos = json.load(fh)
    with open(os.path.join(base, "stations.json"), encoding="utf-8") as fh:
        stations = json.load(fh)
    with open(os.path.join(base, "state_index.json"), encoding="utf-8") as fh:
        state_index = json.load(fh)
    assert index["version"] == 2
    # Sorted WFOs, then the national centres appended: no office index moves.
    assert index["offices"] == sorted(set(wfos) - {"NHC", "WNS"}) + ["NHC", "WNS"]
    assert list(wfos) == index["offices"]
    assert (index["offices"].index("NHC"), index["offices"].index("WNS")) == (125, 126)
    assert index["stations"] == sorted(stations)
    assert index["states"] == state_index["states"]  # same list, same order
    assert index["offices"].index("EWX") == 35
    assert index["states"].index("TX") == 42
    assert len(index["states"]) <= 128  # the state byte only has 7 bits


def test_protocol_json_v5_block():
    from meshcore_weather.protocol import broadcaster as bc

    with open(PROTOCOL_PATH, encoding="utf-8") as fh:
        proto = json.load(fh)
    assert proto["version"] == 17
    assert "docs/MeshWX_v5_Spec.md" in proto["v5"]["notes"]
    # A warning's start, two bytes after the issue time.
    assert proto["v5"]["record_sizes"]["warning_begins"] == 2
    assert proto["v5"]["sentinels"]["warning_begins_saturated"] == v5.MAX_BEGINS_BEFORE_EXPIRY
    assert proto["index_file"] == "index.json"
    # Legacy keys other code still reads are untouched.
    for key in ("messages", "events", "event_names", "sky_codes", "data_types"):
        assert key in proto
    block = proto["v5"]
    assert block["data_type"] == v5.DATA_TYPE == 65296
    # What a decoder reads, and beside it what a bot sends: the meaning of
    # `max_data` did not change when the send limit came in.
    assert block["max_data"] == v5.MAX_DATA == 165
    assert block["max_send"] == v5.MAX_SEND == 157
    assert block["limits"]["text_bytes_per_chunk"] == v5.MAX_TEXT_BYTES
    assert block["limits"]["digest_entries"] == [0, v5.MAX_DIGEST_ENTRIES]
    assert block["limits"]["stations"] == [1, v5.MAX_STATIONS]
    assert block["types"] == {
        "warning": 1, "cancel": 2, "digest": 3, "observations": 4,
        "forecast": 5, "text": 6, "not_available": 7, "coverage": 8,
        "request": 9, "area_sweep": 10, "radar": 11,
    }
    # Revision 11: radar tiles.
    radar = block["radar"]
    assert block["flags"]["radar"] == {"coarse": v5.FLAG_RADAR_COARSE, "partial": v5.FLAG_RADAR_PARTIAL}
    assert (radar["grid"], radar["coarse_grid"], radar["max_zoom"]) == (
        v5.RADAR_GRID, v5.RADAR_COARSE_GRID, v5.MAX_RADAR_ZOOM)
    assert radar["levels_dbz"] == list(v5.RADAR_LEVELS_DBZ)
    assert radar["request_letter"] == v5.RADAR_REQUEST_LETTER
    assert radar["span_degrees"] == [2 << z for z in range(v5.MAX_RADAR_ZOOM + 1)]
    from meshcore_weather.radar import load_frames
    from meshcore_weather.radar.service import MAX_AGE_MIN
    assert radar["products"] == [f.id for f in load_frames()]
    assert radar["product_names"] == [f.name for f in load_frames()]
    assert radar["max_age_minutes"] == MAX_AGE_MIN
    assert radar["cooldown_seconds"] == bc.RADAR_COOLDOWN_S
    assert block["record_sizes"]["radar_fixed"] == 12 and block["record_sizes"]["radar_bounds"] == 4
    assert block["limits"]["radar_cells_bytes"] == [1, v5.MAX_SEND - 12]
    # Revision 13: the last hour.
    assert (radar["loop"]["window_minutes"], radar["loop"]["max_frames"], radar["loop"]["min_spacing_minutes"]) == (
        v5.RADAR_LOOP_WINDOW_MIN, v5.RADAR_LOOP_MAX_FRAMES, v5.RADAR_LOOP_MIN_SPACING_MIN)
    assert block["flags"]["coverage"] == {
        "zones_truncated": v5.FLAG_COVERAGE_ZONES_CUT,
        "offices_truncated": v5.FLAG_COVERAGE_OFFICES_CUT,
    }
    assert block["limits"]["coverage_offices"] == [0, v5.MAX_COVERAGE_OFFICES]
    assert block["limits"]["coverage_runs"] == [0, v5.MAX_COVERAGE_RUNS]
    assert block["record_sizes"]["coverage_fixed"] == 14
    # Revision 6: the app's Request datagram (spec 11).
    assert block["record_sizes"]["request_fixed"] == v5.MIN_REQUEST_SIZE - 1 == 14
    assert block["record_sizes"]["request_sender"] == v5.REQUEST_SENDER_BYTES
    assert block["limits"]["request_text_bytes"] == [1, v5.MAX_REQUEST_TEXT]
    assert block["sentinels"]["request_bot_any"] == v5.REQUEST_BOT_ANY
    assert block["header"]["bot"]["offset"] == 1
    assert block["not_available_reasons"]["rate_limited"] == v5.REASON_RATE_LIMITED
    assert block["text_subjects"]["general"] == v5.SUBJECT_GENERAL
    assert block["tornado_tags"]["observed"] == v5.TAG_TORNADO_OBSERVED
    assert block["flood_source"]["radar_and_gauge"] == v5.FLOOD_SOURCE_RADAR_AND_GAUGE
    assert block["flood_damage"]["catastrophic"] == v5.FLOOD_DAMAGE_CATASTROPHIC
    assert block["flags"]["warning"]["update"] == v5.FLAG_WARNING_UPDATE
    # Revision 5: the two added times and what they cost.
    assert block["flags"]["warning"]["issued"] == v5.FLAG_WARNING_ISSUED
    assert block["flags"]["observations"] == {"ages": v5.FLAG_OBS_AGES}
    assert block["limits"]["stations_with_ages"] == [1, v5.MAX_STATIONS_WITH_AGES]
    assert block["limits"]["observation_age_minutes"] == [0, v5.OBS_AGE_MAX_MIN]
    assert block["limits"]["warning_issued_before_expiry_minutes"] == [
        0, v5.MAX_ISSUED_BEFORE_EXPIRY
    ]
    assert block["record_sizes"]["warning_issued"] == 2
    assert block["record_sizes"]["observation_ages_stations_per_byte"] == 2
    assert block["record_sizes"]["observation_age_step_minutes"] == v5.OBS_AGE_STEP_MIN
    assert block["sentinels"]["observation_age_saturated"] == v5.OBS_AGE_MAX_MIN
    assert block["sentinels"]["warning_issued_saturated"] == v5.MAX_ISSUED_BEFORE_EXPIRY
    # Revision 7: the data source and the text cut flag.
    assert block["source"]["mask"] == v5.SOURCE_MASK
    assert block["source"]["shift"] == v5.SOURCE_SHIFT
    assert block["source"]["values"] == {
        "unstated": v5.SOURCE_UNSTATED,
        "goes": v5.SOURCE_GOES,
        "internet": v5.SOURCE_INTERNET,
        "mixed": v5.SOURCE_MIXED,
    }
    assert block["flags"]["text"] == {"cut": v5.FLAG_TEXT_CUT}
    # Cancel's nibble is a reason code and keeps no room for a source.
    assert "source" not in block["flags"]["cancel"]
    assert "cancel" in block["notes"].lower() and "source" in block["notes"]
    # Revision 9: the area sweep.
    assert block["flags"]["area_sweep"] == {
        "cut": v5.FLAG_SWEEP_CUT, "advisories": v5.FLAG_SWEEP_ADVISORIES,
    }
    assert block["limits"]["sweep_packets"] == [1, v5.MAX_SWEEP_PACKETS]
    assert block["limits"]["sweep_entries_per_packet"] == [
        0, v5.MAX_SWEEP_ENTRIES_PER_PACKET
    ]
    assert block["limits"]["sweep_entries"] == [1, v5.MAX_SWEEP_ENTRIES]
    assert block["limits"]["sweep_run"] == [1, v5.MAX_SWEEP_RUN]
    assert block["limits"]["sweep_start"] == [0, v5.MAX_SWEEP_START]
    assert block["record_sizes"]["area_sweep_fixed"] == 11
    assert block["record_sizes"]["area_sweep_entry"] == 4
    # Revision 10: the scoped sweep and the parts cache.
    assert block["area_sweep"] == {
        "total_mask": v5.SWEEP_TOTAL_MASK,
        "scoped_bit": v5.SWEEP_SCOPED_BIT,
        "scope_event": v5.SWEEP_SCOPE_EVENT,
    }
    assert block["limits"]["sweep_scope_states"] == [0, v5.MAX_SWEEP_SCOPE_STATES]
    assert block["limits"]["parts_cache_groups"] == bc.PARTS_CACHE_GROUPS
    assert block["limits"]["parts_cache_seconds"] == bc.PARTS_CACHE_S
    assert block["limits"]["part_resend_floor_seconds"] == bc.PART_RESEND_FLOOR_S
    assert ">part" in block["notes"] and ">f <lat>,<lon>" in block["notes"]
    assert block["notes"]


# ---------------------------------------------------------------------------
# Test vectors
# ---------------------------------------------------------------------------


def _vectors():
    with open(VECTORS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def test_vectors_cover_every_message_type():
    names = {v5.decode(bytes.fromhex(v["hex"]))["name"] for v in _vectors()}
    assert names == {
        "warning", "cancel", "digest", "observations", "forecast", "text",
        "not_available", "coverage", "request", "area_sweep", "radar",
    }


@pytest.mark.parametrize("vector", _vectors(), ids=lambda v: v["name"])
def test_vector_decodes_and_reencodes(vector, monkeypatch):
    data = bytes.fromhex(vector["hex"])
    assert len(data) <= v5.MAX_DATA
    decoded = v5.decode(data)
    assert decoded == vector["decoded"]
    if len(data) > v5.MAX_SEND:
        # A packet an older bot filled past the send limit: every decoder
        # reads it, and this bot's encoder refuses to build it.
        with pytest.raises(ValueError):
            reencode(decoded)
        as_an_older_bot(monkeypatch)
    assert reencode(decoded).hex() == vector["hex"]


def test_warning_vector_byte_by_byte():
    """Hand-check of `severe_thunderstorm_warning_polygon`, offset by offset.

    hex: 11 7a4c 10 | 03 23 2a00 c913c701 83 04 3c |
         06 30a804 a80cf1 | 5a00 6801 | 1aff d200 | 1aff a6ff |
         c4ff a2fe | be00 42ff | 02 | aad10001 | aac50101

      0      11        seq = 17
      1..2   7a 4c     bot = 0x4C7A = 19578 (little-endian)
      3      10        type byte: high nibble 1 = warning, flags 0
      4      03        event = 3 = SV.W
      5      23        office = 35 = EWX in index.json "offices"
      6..7   2a 00     etn = 42
      8..11  c9 13 c7 01  expires = 0x01C713C9 = 29823945 min = 01:45 UTC
      12     83        tags 1000 0011: tornado 2 (radar indicated),
                       flood source 0, flood damage 0, bit1 polygon, bit0 areas
      13     04        hail = 4 quarter inches = 1.00 in
      14     3c        wind = 60 mph
      15     06        polygon vertex count = 6
      16..18 30 a8 04  lat0 i24 = 305200 -> 30.5200
      19..21 a8 0c f1  lon0 i24 = 0xF10CA8 - 2^24 = -979800 -> -97.9800
      22..25 5a00 6801 dlat +90, dlon +360 (0.001 deg) -> 30.610, -97.620
      26..29 1aff d200 dlat -230, dlon +210            -> 30.380, -97.410
      30..33 1aff a6ff dlat -230, dlon  -90            -> 30.150, -97.500
      34..37 c4ff a2fe dlat  -60, dlon -350            -> 30.090, -97.850
      38..41 be00 42ff dlat +190, dlon -190            -> 30.280, -98.040
      42     02        area run count = 2
      43..46 aa d100 01  state 0xAA = county flag + index 42 (TX),
                         start = 209 (Hays), run = 1
      47..50 aa c501 01  state TX county, start = 453 (Travis), run = 1

    Total 15 + 27 + 9 = 51 bytes, matching spec section 3.
    """
    vector = next(
        v for v in _vectors() if v["name"] == "severe_thunderstorm_warning_polygon"
    )
    data = bytes.fromhex(vector["hex"])
    assert len(data) == 51
    assert data[:4] == bytes.fromhex("117a4c10")
    assert data[4] == 3 and data[5] == 35
    assert int.from_bytes(data[6:8], "little") == 42
    assert int.from_bytes(data[8:12], "little") == NOW + 45
    assert data[12] == 0x83
    assert data[13] == 4 and data[14] == 60
    assert data[15] == 6
    assert int.from_bytes(data[16:19], "little") == 305200
    assert int.from_bytes(data[19:22], "little") - (1 << 24) == -979800
    assert data[42] == 2
    assert data[43] == 0x80 | 42
    assert int.from_bytes(data[44:46], "little") == 209
    assert data[46] == 1
    assert int.from_bytes(data[48:50], "little") == 453


def test_vector_sizes_are_within_budget():
    sizes = {v["name"]: len(v["hex"]) // 2 for v in _vectors()}
    assert sizes["severe_thunderstorm_warning_polygon"] == 51
    assert sizes["winter_storm_warning_zones"] == 24
    assert sizes["cancel_expired_early"] == 8
    assert sizes["not_available_unknown_location"] == 6
    # WX-AUS's real coverage: 14 fixed + 4 offices + 1 + 5 runs of 4.
    assert sizes["coverage_wx_aus"] == 39
    assert all(n <= v5.MAX_DATA for n in sizes.values())
    # Two vectors keep what a bot sent before the send limit, so every
    # client's decoder is held to the full 165 bytes.
    assert {name for name, n in sizes.items() if n > v5.MAX_SEND} == {
        "text_warning_narrative_chunk0", "area_sweep_national_packet0",
    }


# ---------------------------------------------------------------------------
# The send limit: a bot sends 157 bytes, a decoder reads 165
# ---------------------------------------------------------------------------


def test_a_decoder_reads_every_packet_an_older_bot_filled_to_the_transport_limit(monkeypatch):
    """Bots before 1 October 2026 filled packets to 165 bytes, the counts
    with them. The send limit shrank what a bot builds, never what a decoder
    takes: every one of these decodes, and none of them can be built now."""
    north_half_noisy = [
        [(r * 5 + c * 3) % 4 if r < 16 else 0 for c in range(32)] for r in range(32)
    ]
    with monkeypatch.context() as m:
        as_an_older_bot(m)
        full = {
            "text": v5.encode_text(
                1, BOT, subject=0, group=1, idx=0, total=1, text="x" * 157),
            "area_sweep": v5.encode_area_sweep(
                1, BOT, built_min=NOW, group=1, idx=0, total=1,
                entries=[(3, 42, True, n, 1) for n in range(38)]),
            "observations": v5.encode_obs(
                1, BOT, ts_min=NOW, stations=[_station(station=200 + i) for i in range(14)]),
            "observations_with_ages": v5.encode_obs(
                1, BOT, ts_min=NOW,
                stations=[_station(station=200 + i, age_min=10) for i in range(13)]),
            "coverage": v5.encode_coverage(
                1, BOT, lat=30.0, lon=-97.0, radius_km=400, stations=13,
                offices=list(range(24)),
                areas=[(42, False, 100 + i, 1) for i in range(30)]),
            "radar": v5.encode_radar(
                1, BOT, taken_min=NOW, south=30, west=-98, zoom=0, product=1,
                rows=north_half_noisy),
        }
    assert {name: len(data) for name, data in full.items()} == {
        "text": 165, "area_sweep": 163, "observations": 163,
        "observations_with_ages": 159, "coverage": 159, "radar": 163,
    }
    for name, data in full.items():
        assert v5.MAX_SEND < len(data) <= v5.MAX_DATA, name
        decoded = v5.decode(data)
        with pytest.raises(ValueError):
            reencode(decoded)
        full[name] = decoded
    assert len(full["text"]["text"]) == 157
    assert len(full["area_sweep"]["entries"]) == 38
    assert len(full["observations"]["stations"]) == 14
    assert [s["age_min"] for s in full["observations_with_ages"]["stations"]] == [10] * 13
    assert (len(full["coverage"]["offices"]), len(full["coverage"]["areas"])) == (24, 30)
    assert full["radar"]["rows"] == ["".join(map(str, r)) for r in north_half_noisy]


def test_every_encoder_refuses_more_than_the_send_limit():
    """The check every encoder ends in is the send limit, not the transport's."""
    with pytest.raises(ValueError, match="158 bytes, over the 157-byte send limit"):
        v5._check_size(bytes(158), "test")
    assert v5._check_size(bytes(157), "test") == bytes(157)


# ---------------------------------------------------------------------------
# Revision 12: a warning's start
# ---------------------------------------------------------------------------

def _watch(**kw):
    args = dict(event=10, office=35, etn=8, expires_min=NOW + 4896,
                areas=[(42, False, 191, 4)], issued_min=NOW)
    args.update(kw)
    return v5.encode_warning(33, 0x4C7A, **args)


def test_a_start_after_issuance_rides_after_the_issue_time():
    without, with_start = _watch(), _watch(begins_min=NOW + 2016)
    assert len(with_start) == len(without) + 2 and with_start[:-2] == without
    assert int.from_bytes(with_start[-2:], "little") == 2880           # minutes from start to expiry
    d = v5.decode(with_start)
    assert (d["issued_min"], d["begins_min"], d["expires_min"]) == (NOW, NOW + 2016, NOW + 4896)
    assert v5.decode(without)["begins_min"] is None


def test_a_revision_11_decoder_reads_the_same_warning():
    """Every decoder before revision 12 reads the issue time at its fixed
    place after the area list and stops. That is what lets the start ride
    without a flag."""
    data = _watch(begins_min=NOW + 2016)
    fixed = 15 + 1 + 4                           # header+body, run count, one run
    assert int.from_bytes(data[fixed:fixed + 2], "little") == 4896     # the issue time, where it always was
    old = v5.decode(data[:fixed + 2])
    assert old["issued_min"] == NOW and old["begins_min"] is None


def test_no_start_is_sent_that_is_not_after_issuance_and_before_expiry():
    for start in (NOW, NOW - 60, NOW + 4896, NOW + 5000):
        assert len(_watch(begins_min=start)) == len(_watch()), start
    assert len(_watch(issued_min=None, begins_min=NOW + 2016)) == len(_watch(issued_min=None))


def test_a_decoder_ignores_a_start_that_cannot_be_one_and_bytes_after_it():
    base = bytes(_watch())
    for bad in (0, 4896, 5000):
        assert v5.decode(base + bad.to_bytes(2, "little"))["begins_min"] is None, bad
    later = v5.decode(bytes(_watch(begins_min=NOW + 2016)) + b"\x01\x02\x03")
    assert later["begins_min"] == NOW + 2016                              # a future revision's bytes


def test_the_start_is_a_material_change_but_only_when_there_is_one():
    from datetime import datetime, timedelta, timezone
    from meshcore_weather.protocol import v5_builders as b
    issued = datetime(2026, 9, 29, 14, 24, tzinfo=timezone.utc)
    w = {"expires_at": issued + timedelta(minutes=4896), "issued_at": issued, "ugcs": ["TXZ191"]}
    plain = b.warning_fingerprint(w)
    assert b.begins_min(w) is None
    assert b.warning_fingerprint({**w, "onset_at": issued}) == plain           # in effect from issuance
    assert b.warning_fingerprint({**w, "onset_at": issued - timedelta(hours=1)}) == plain
    wed = b.warning_fingerprint({**w, "onset_at": issued + timedelta(minutes=2016)})
    moved = b.warning_fingerprint({**w, "onset_at": issued + timedelta(minutes=1800)})
    assert wed != plain and moved != wed                                      # moved earlier: resend
    assert b.begins_min({**w, "onset_at": issued + timedelta(minutes=2016)}) == int(issued.timestamp() // 60) + 2016


def test_a_warning_narrative_is_not_cut_at_500_characters():
    """It was, silently, below the eight packets the reply may take; a
    Flood Watch stopped at "WHEN: From" on the phone."""
    from meshcore_weather.protocol.warnings import _extract_warning_description
    body = "\n".join([
        "* WHAT...Flooding caused by excessive rainfall is possible.",
        "* WHERE...A portion of south central Texas, including the following counties, " +
        ", ".join(f"County{i}" for i in range(40)) + ".",
        "* WHEN...From Wednesday evening through Friday evening.",
        "* IMPACTS...Excessive runoff may result in flooding of rivers, creeks, streams, and other "
        "low-lying and flood-prone locations.",
        "PRECAUTIONARY/PREPAREDNESS ACTIONS...",
        "You should monitor later forecasts.",
    ])
    text = _extract_warning_description(body)
    assert len(text) > 500 and text.endswith("flood-prone locations.")
    assert "WHEN: From Wednesday evening through Friday evening." in text
    assert "monitor later forecasts" not in text                               # the boilerplate still stops it
