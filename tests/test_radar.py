"""Radar (type 11, spec 13, revision 11; loops, revision 13): the tile codec, reading a real EMWIN radar GIF, cutting a tile from it, and the
`>radar` request with its limits.

The two pictures under tests/fixtures/radar are as the dish received them on
20 September 2026: the Southern Plains mosaic with a squall line across north
Texas, and the Puerto Rico picture, whose corner is laid out differently.
tests/fixtures/radar_loop holds three earlier Southern Plains pictures of the
same day, received at 00:30, 01:00 and 01:15 UTC (pictures of 00:22, 00:58 and
01:08): the hour a loop is made of, with a gap in it.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from meshcore_weather.protocol import v5
from meshcore_weather.protocol import v5_builders as b
from meshcore_weather.radar import RadarSource, cut_tile, describe, load_frames, read_picture
from meshcore_weather.radar.picture import issue_time, received_time
from meshcore_weather.radar.service import RadarService
from meshcore_weather.radar.tiles import candidates, coarse_bounds, tile_span

BOT = 0x4C7A
FIXTURES = Path(__file__).parent / "fixtures" / "radar"
DAY = FIXTURES / "2026-09-20"
STHPL = next(DAY.glob("*-RADSTHPL.GIF"))
ALLPR = next(DAY.glob("*-RADALLPR.GIF"))
#: The moment the fixtures were new: two minutes after the dish got them.
NOW = datetime(2026, 9, 20, 23, 49, tzinfo=timezone.utc)
TAKEN_MIN = 29832458            # 2026-09-20 23:38 UTC

FRAMES = {f.id: f for f in load_frames()}
LOOP_ROOT = Path(__file__).parent / "fixtures" / "radar_loop"
#: Five minutes after the newest loop picture reached the dish.
LOOP_NOW = datetime(2026, 9, 20, 1, 21, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _audit_lines_go_nowhere_real(monkeypatch, tmp_path):
    """A tile sent in a test must not land in the operator's audit log."""
    from meshcore_weather.radar import audit
    monkeypatch.setattr(audit, "path", lambda: tmp_path / "radar_audit.jsonl")


# ---------------------------------------------------------------------------
# The lattice
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("lat, lon, zoom, expected", [
    (30.27, -97.74, 0, (29, -99)),       # Austin: centre 30, -98
    (32.78, -96.80, 0, (32, -98)),       # Dallas: centre 33, -97
    (30.5, -97.5, 0, (30, -98)),         # a tie rounds up, in every language
    (-0.4, 0.4, 0, (-1, -1)),            # across the equator and Greenwich
    (30.27, -97.74, 1, (28, -100)),      # step 2
    (30.27, -97.74, 2, (28, -100)),      # step 4: centre 32, -96
    (30.27, -97.74, 3, (24, -104)),      # step 8: centre 32, -96
    (18.22, -66.59, 0, (17, -68)),       # Puerto Rico
])
def test_the_tile_for_a_coordinate(lat, lon, zoom, expected):
    assert v5.radar_tile(lat, lon, zoom) == expected


@pytest.mark.parametrize("zoom", range(4))
def test_a_place_is_never_near_the_edge_of_its_tile(zoom):
    span = tile_span(zoom)
    for lat, lon in [(30.27, -97.74), (47.61, -122.33), (25.76, -80.19), (64.84, -147.72), (-33.9, 151.2)]:
        south, west = v5.radar_tile(lat, lon, zoom)
        for value, edge in ((lat, south), (lon, west)):
            assert span / 4 <= value - edge <= 3 * span / 4


def test_zoom_out_of_range_is_refused():
    with pytest.raises(ValueError):
        v5.radar_tile(30, -97, 4)
    with pytest.raises(ValueError):
        v5.radar_tile(30, -97, -1)


# ---------------------------------------------------------------------------
# The codec
# ---------------------------------------------------------------------------


def _rows(n, cells=()):
    rows = [[0] * n for _ in range(n)]
    for r, c, level in cells:
        rows[r][c] = level
    return rows


def test_a_dry_tile_is_one_byte_of_cells():
    data = v5.encode_radar(7, BOT, taken_min=TAKEN_MIN, south=29, west=-99, zoom=0,
                           product=1, rows=_rows(32), source=v5.SOURCE_GOES)
    assert len(data) == 13 and data[3] == (v5.TYPE_RADAR << 4) | 0x4
    assert data[12] == 0                      # split bit 0, level 00, padding
    out = v5.decode(data)
    assert out["name"] == "radar" and out["size"] == 32 and not out["coarse"] and not out["partial"]
    assert (out["south"], out["west"], out["zoom"], out["product"]) == (29, -99, 0, 1)
    assert out["taken_min"] == TAKEN_MIN and out["source"] == v5.SOURCE_GOES and out["bounds"] is None
    assert out["rows"] == ["0" * 32] * 32


def test_the_quadtree_bit_order():
    """One heavy cell in the north-west corner of a 16 x 16 tile: split at 16,
    8, 4 and 2, north-west first each time."""
    data = v5.encode_radar(1, BOT, taken_min=1, south=0, west=0, zoom=0, product=0,
                           rows=_rows(16, [(0, 0, 3)]))
    assert data[3] & v5.FLAG_RADAR_COARSE
    bits = "".join(f"{byte:08b}" for byte in data[12:])
    # 16: split. 8 NW: split. 4 NW: split. 2 NW: split, then cells 11 00 00 00.
    # Then the three dry 2-squares, 4-squares and 8-squares, each `0 00`.
    assert bits.startswith("1" "1" "1" "1" "11000000" + "000" * 9)
    assert set(bits[4 + 8 + 27:]) <= {"0"}
    assert v5.decode(data)["rows"][0] == "3" + "0" * 15


def test_every_grid_round_trips():
    import random
    rng = random.Random(11)
    done = 0
    for _ in range(300):
        n = rng.choice((16, 32))
        rows = [[rng.choice((1, 1, 2, 3)) if rng.random() < 0.15 else 0 for _ in range(n)] for _ in range(n)]
        try:
            data = v5.encode_radar(1, BOT, taken_min=5, south=-10, west=170, zoom=3, product=14, rows=rows)
        except ValueError:
            assert n == 32                     # a coarse tile always fits
            continue
        out = v5.decode(data)
        assert out["rows"] == ["".join(map(str, r)) for r in rows]
        assert (out["south"], out["west"], out["zoom"], out["product"], out["size"]) == (-10, 170, 3, 14, n)
        done += 1
    assert done > 100


def test_the_worst_coarse_tile_still_fits():
    rows = [[(r * 7 + c * 3) % 4 for c in range(16)] for r in range(16)]
    assert len(v5.encode_radar(1, BOT, taken_min=5, south=0, west=0, zoom=0, product=0,
                               rows=rows, bounds=(0, 15, 0, 15))) <= v5.MAX_SEND


def test_partial_tiles_carry_their_bounds_and_nothing_outside_them():
    rows = _rows(16, [(2, 3, 1), (9, 11, 2)])
    data = v5.encode_radar(1, BOT, taken_min=5, south=24, west=-100, zoom=1, product=1,
                           rows=rows, bounds=(0, 9, 0, 15))
    assert data[3] & 0x3 == v5.FLAG_RADAR_COARSE | v5.FLAG_RADAR_PARTIAL
    assert list(data[12:16]) == [0, 9, 0, 15]
    assert v5.decode(data)["bounds"] == [0, 9, 0, 15]
    with pytest.raises(ValueError):            # an echo where the picture does not reach
        v5.encode_radar(1, BOT, taken_min=5, south=24, west=-100, zoom=1, product=1,
                        rows=_rows(16, [(12, 3, 1)]), bounds=(0, 9, 0, 15))


def test_a_cut_off_tree_is_refused_and_padding_is_not():
    data = v5.encode_radar(1, BOT, taken_min=5, south=0, west=0, zoom=0, product=0,
                           rows=_rows(32, [(5, 5, 2), (20, 9, 1)]))
    with pytest.raises(ValueError):
        v5.decode(data[:-2])
    assert v5.decode(data + b"\x00")["rows"] == v5.decode(data)["rows"]


def test_coarsening_keeps_the_strongest_cell():
    rows = _rows(32, [(0, 1, 1), (1, 0, 3), (31, 31, 2)])
    coarse = v5.radar_coarsen(rows)
    assert len(coarse) == 16 and coarse[0][0] == 3 and coarse[15][15] == 2
    assert sum(map(sum, coarse)) == 5


def test_the_vectors_include_a_real_tile():
    vectors = {v["name"]: v for v in json.loads(
        (Path(__file__).parent.parent / "docs" / "meshwx_v5_vectors.json").read_text())}
    tile = vectors["radar_tile"]
    assert len(tile["hex"]) // 2 == 131 and tile["decoded"]["taken_min"] == TAKEN_MIN
    assert vectors["not_available_radar"]["decoded"]["request"] == "x"
    assert vectors["request_radar"]["decoded"]["text"] == ">radar 32.780,-96.800"
    assert vectors["radar_tile_coarse_partial"]["decoded"]["bounds"] == [0, 9, 0, 15]


# ---------------------------------------------------------------------------
# Reading a picture
# ---------------------------------------------------------------------------


def test_file_names():
    assert received_time(STHPL.name) == datetime(2026, 9, 20, 23, 46, 44, tzinfo=timezone.utc)
    # The header says 11:45 on a 12-hour clock: 23:45.
    assert issue_time(STHPL.name, received_time(STHPL.name)) == datetime(2026, 9, 20, 23, 45, tzinfo=timezone.utc)
    midnight = "Z_QATA00KWBC211200_C_KWIN_20260921000133_818617-3-RADREFUS.GIF"
    assert issue_time(midnight, received_time(midnight)) == datetime(2026, 9, 21, 0, 0, tzinfo=timezone.utc)


def test_the_southern_plains_picture():
    picture = read_picture(STHPL, "RADSTHPL")
    assert picture is not None and picture.frame_ok
    assert picture.taken == datetime(2026, 9, 20, 23, 38, tzinfo=timezone.utc) and picture.taken_is_printed
    assert picture.levels.shape == (571, 600)
    assert (picture.levels[:24] == -1).all() and (picture.levels[-22:] == -1).all()
    assert 3000 < int((picture.levels > 0).sum()) < 12000       # a squall line, not a washout
    assert int((picture.levels == 3).sum()) > 50


def test_puerto_rico_prints_its_time_elsewhere_and_it_is_still_read():
    picture = read_picture(ALLPR, "RADALLPR")
    assert picture is not None and picture.frame_ok and picture.taken_is_printed
    assert picture.taken == datetime(2026, 9, 20, 23, 38, tzinfo=timezone.utc)


def test_the_date_is_not_mistaken_for_the_time():
    """Found on the Pi the first evening: on the 21st the corner reads
    `09/21/2026 00:42 UTC`, and `09/21` is four digits spaced exactly like a
    time. It is not plausible at 00:46, so the reader used to give up and fall
    back to the issue time; at 09:30 it would have been believed. A slash is
    not a colon, and the time is the rightmost group."""
    import numpy as np
    from PIL import Image

    from meshcore_weather.radar.picture import read_stamp
    pacnw = next((FIXTURES / "2026-09-21").glob("*-RADPACNW.GIF"))
    assert read_stamp(np.asarray(Image.open(pacnw).convert("L"))) == [(0, 42)]
    picture = read_picture(pacnw, "RADPACNW")
    assert picture.taken_is_printed
    assert picture.taken == datetime(2026, 9, 21, 0, 42, tzinfo=timezone.utc)
    # Puerto Rico prints a local time after the UTC one: both are read, the
    # rightmost first, and only the UTC one is within reach of the receipt.
    assert read_stamp(np.asarray(Image.open(ALLPR).convert("L"))) == [(19, 38), (23, 38)]


def test_a_picture_under_the_wrong_product_is_not_trusted():
    assert read_picture(ALLPR, "RADSTHPL") is None              # 550 rows, not 571
    assert read_picture(STHPL, "RADNOPE") is None               # no mask
    wrong = read_picture(STHPL, "RADSMSVY")                     # same size, another map
    assert wrong is not None and not wrong.frame_ok


def test_a_damaged_gif_is_none(tmp_path):
    bad = tmp_path / STHPL.name
    bad.write_bytes(STHPL.read_bytes()[:3000])
    assert read_picture(bad, "RADSTHPL") is None


# ---------------------------------------------------------------------------
# Cutting a tile
# ---------------------------------------------------------------------------


def test_the_frames():
    assert [f.id for f in load_frames()][:2] == ["RADREFUS", "RADSTHPL"]
    assert len(FRAMES) == 15 and not FRAMES["RADALLGU"].calibrated
    plains = FRAMES["RADSTHPL"]
    assert (plains.west, plains.east) == (-108, -92)
    # The Texas panhandle's corner, 36.5N 103.04W, is at pixel (186, 101).
    assert abs(plains.x(-103.04) - 186) < 1.5 and abs(plains.y(36.5) - 101.5) < 1.5


def test_the_best_product_for_a_tile():
    assert [f.id for f in candidates(list(FRAMES.values()), 32, -98, 0)][0] == "RADSTHPL"
    # South of the regional picture's edge only the national one holds the whole tile.
    assert [f.id for f in candidates(list(FRAMES.values()), 24, -100, 1)][0] == "RADREFUS"
    assert candidates(list(FRAMES.values()), 12, 144, 0) == []          # Guam is not calibrated
    assert candidates(list(FRAMES.values()), -34, 150, 0) == []         # Sydney


def test_dallas_under_the_squall_line():
    picture = read_picture(STHPL, "RADSTHPL")
    tile = cut_tile(picture, FRAMES["RADSTHPL"], 32, -98, 0)
    assert tile.bounds is None and 300 < tile.wet < 480
    vector = next(v for v in json.loads(
        (Path(__file__).parent.parent / "docs" / "meshwx_v5_vectors.json").read_text())
        if v["name"] == "radar_tile")
    assert ["".join(map(str, r)) for r in tile.rows] == vector["decoded"]["rows"]
    facts = describe(tile, 32.78, -96.80)
    assert facts["here"] == 1
    assert facts["heavy"][0] == 3 and 30 < facts["heavy"][1] < 60 and facts["heavy"][2] == "S"


def test_the_roads_are_not_rain():
    """Lubbock was clear, and I-27 runs through it in the scale's own 58 dBZ red."""
    picture = read_picture(STHPL, "RADSTHPL")
    tile = cut_tile(picture, FRAMES["RADSTHPL"], 33, -103, 0)
    assert tile.wet == 0
    assert describe(tile, 33.58, -101.85) == {"here": 0, "nearest": None, "heavy": None}


def test_a_tile_over_the_edge_is_partial():
    picture = read_picture(STHPL, "RADSTHPL")
    tile = cut_tile(picture, FRAMES["RADSTHPL"], 24, -100, 1)          # the picture stops at 24.6N
    row0, row1, col0, col1 = tile.bounds
    assert (row0, col0, col1) == (0, 0, 31) and 20 <= row1 < 31
    assert all(v == 0 for row in tile.rows[row1 + 1:] for v in row)
    assert describe(tile, 24.1, -98.0)["here"] is None                  # below the picture
    assert cut_tile(picture, FRAMES["RADSTHPL"], 40, -80, 0) is None    # nowhere near it


def test_coarse_bounds_move_inwards():
    assert coarse_bounds(None) is None
    assert coarse_bounds((0, 26, 0, 31)) == (0, 12, 0, 15)
    assert coarse_bounds((3, 31, 1, 30)) == (2, 15, 1, 14)
    assert coarse_bounds((5, 5, 0, 31)) is None


def test_a_tile_too_busy_for_a_packet_goes_out_coarse():
    picture = read_picture(STHPL, "RADSTHPL")
    frame = FRAMES["RADSTHPL"]
    tile = cut_tile(picture, frame, 32, -98, 0)
    # Noise no real picture has, to push the fine tile past the packet.
    tile.rows = [[(r * 5 + c * 3) % 4 for c in range(32)] for r in range(32)]
    data = b.radar_message(9, BOT, tile, picture, frame)
    out = v5.decode(data)
    assert out["coarse"] and out["size"] == 16 and len(data) <= v5.MAX_SEND
    assert out["rows"] == ["".join(map(str, r)) for r in v5.radar_coarsen(tile.rows)]


# ---------------------------------------------------------------------------
# The source and the service
# ---------------------------------------------------------------------------


def test_the_newest_picture_is_found_and_decoded_once():
    source = RadarSource(FIXTURES)
    assert source.available
    picture = source.newest("RADSTHPL", NOW)
    assert picture is not None and picture.path == STHPL
    assert source.newest("RADSTHPL", NOW) is picture                    # cached
    assert source.newest("RADGRTLK", NOW) is None
    assert set(source.status(NOW)) == {"RADALLPR", "RADSTHPL"}


def test_a_damaged_newest_file_falls_back_to_the_one_before(tmp_path):
    day = tmp_path / "2026-09-20"
    day.mkdir()
    (day / STHPL.name).write_bytes(STHPL.read_bytes())
    newer = STHPL.name.replace("20260920234644", "20260920235944")
    (day / newer).write_bytes(STHPL.read_bytes()[:2000])
    old = (datetime.now() - timedelta(minutes=5)).timestamp()
    for f in day.iterdir():
        os.utime(f, (old, old))
    picture = RadarSource(tmp_path).newest("RADSTHPL", NOW + timedelta(minutes=15))
    assert picture is not None and picture.path.name == STHPL.name


def test_the_service_answers_and_lets_go_of_old_pictures():
    service = RadarService(FIXTURES)
    tile, picture, frame = service.tile_for(32.78, -96.80, 0, now=NOW)
    assert (tile.south, tile.west, frame.id) == (32, -98, "RADSTHPL")
    tile, picture, frame = service.tile_for(18.22, -66.59, 0, now=NOW)
    assert frame.id == "RADALLPR"
    assert service.tile_for(32.78, -96.80, 0, now=NOW + timedelta(hours=2)) is None
    assert service.tile_for(47.6, -122.3, 0, now=NOW) is None           # no Pacific Northwest picture here
    assert not RadarService(None).available and RadarService(None).tile_for(32, -96) is None


# ---------------------------------------------------------------------------
# `>radar`
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("arg, expected", [
    ("", ("", 0, None)),
    ("32.780,-96.800", ("32.780,-96.800", 0, None)),
    ("32.780,-96.800 z2", ("32.780,-96.800", 2, None)),
    ("round rock tx Z1", ("round rock tx", 1, None)),
    ("z3", ("", 3, None)),
    ("zion il", ("zion il", 0, None)),       # a town, not a zoom
    ("austin tx z4", None),
    ("austin tx z-1", ("austin tx z-1", 0, None)),   # no such zoom: a place that will not resolve
    ("32.780,-96.800 loop", ("32.780,-96.800", 0, [])),
    ("30.270,-97.740 z1 loop 2353 2338", ("30.270,-97.740", 1, [1433, 1418])),
    ("78701 Z1 LOOP 0008", ("78701", 1, [8])),
    ("loop", ("", 0, [])),                   # the bot's home, looped
    ("loop tx", ("loop tx", 0, None)),       # Loop, Texas
    ("austin loop 2599", ("austin", 0, [])), # not a time: matches nothing held
])
def test_parsing_the_request(arg, expected):
    assert b.parse_radar_request(arg) == expected


def test_the_refusal_letter():
    assert b.request_letter("radar") == b.request_letter(">radar") == "x"
    assert b.request_letter("rain") == "r" and b.request_letter("w") == "w" and b.request_letter("") == "?"
    assert v5.decode(b.not_available(1, BOT, "radar", v5.REASON_NO_DATA))["request"] == "x"


def _responder(monkeypatch, root=FIXTURES, now=NOW):
    import meshcore_weather.schedule.scheduler as sched_mod
    from meshcore_weather.parser.weather import WeatherStore
    from meshcore_weather.protocol.broadcaster import AppResponder
    from meshcore_weather.radar import service as service_mod

    monkeypatch.setattr(sched_mod, "TX_SPACING", 0)
    radar = RadarService(root)
    real = radar.tile_for
    monkeypatch.setattr(radar, "tile_for", lambda lat, lon, zoom=0, now_=None: real(lat, lon, zoom, now=now))
    real_loop = radar.loop_for
    monkeypatch.setattr(radar, "loop_for", lambda lat, lon, zoom=0, now_=None: real_loop(lat, lon, zoom, now=now))
    monkeypatch.setattr(service_mod, "_shared", radar)
    radio = MagicMock()
    radio._mc = MagicMock()
    radio._mc.self_info = {"public_key": "1d04" + "00" * 30}
    sent = []

    async def cap(data, data_type=0xFF10, ev=None):
        sent.append(data)
        return True

    radio.send_channel_data = cap
    return AppResponder(WeatherStore(), radio, render_text=lambda c, a: None), sent


async def test_a_radar_request_is_one_packet(monkeypatch):
    responder, sent = _responder(monkeypatch)
    outcome = await responder.handle_request(">radar 32.780,-96.800", "aa")
    assert outcome == "1 packet(s), 131 B"
    out = v5.decode(sent[0])
    assert out["name"] == "radar" and (out["south"], out["west"], out["zoom"]) == (32, -98, 0)
    assert out["taken_min"] == TAKEN_MIN and out["source"] == v5.SOURCE_GOES and out["product"] == 1


async def test_every_tile_sent_leaves_an_audit_line(monkeypatch, tmp_path):
    """scripts/radar_audit.py scores tiles against their source pictures, and
    this line is how it knows which tiles people actually pulled."""
    target = tmp_path / "radar_audit.jsonl"                                # where the fixture points
    responder, sent = _responder(monkeypatch)
    await responder.handle_request(">radar 32.780,-96.800", "aabbccddeeff00112233")
    await responder.handle_request(">radar 32.9,-97.1", "bb")             # refused: no line
    lines = [json.loads(x) for x in target.read_text().splitlines()]
    assert len(lines) == 1
    line = lines[0]
    assert (line["south"], line["west"], line["zoom"], line["product"]) == (32, -98, 0, "RADSTHPL")
    assert line["file"] == STHPL.name and line["taken_min"] == TAKEN_MIN and line["taken_is_printed"]
    assert line["sender"] == "aabbccddeeff" and line["request"] == ">radar 32.780,-96.800"
    assert bytes.fromhex(line["hex"])[1:] == sent[0][1:] and line["bytes"] == 131
    assert not responder._radar_cut


def test_the_audit_log_is_cut_and_never_raises(tmp_path):
    from meshcore_weather.radar import audit
    picture = read_picture(STHPL, "RADSTHPL")
    frame = FRAMES["RADSTHPL"]
    tile = cut_tile(picture, frame, 32, -98, 0)
    packet = b.radar_message(1, BOT, tile, picture, frame)
    target = tmp_path / "radar_audit.jsonl"
    target.write_bytes(b"x" * (audit.MAX_BYTES + 1))
    audit.record(request=">radar", sender="s", tile=tile, picture=picture, frame=frame,
                 packet=packet, file=target)
    assert target.with_suffix(".jsonl.1").exists() and len(target.read_text().splitlines()) == 1
    audit.record(request=">radar", sender="s", tile=None, picture=None, frame=None,
                 packet=b"", file=target)                                   # logged, not raised


async def test_the_same_picture_of_the_same_tile_is_refused_for_five_minutes(monkeypatch):
    responder, sent = _responder(monkeypatch)
    await responder.handle_request(">radar 32.780,-96.800", "aa")
    await responder.handle_request(">radar 32.9,-97.1", "bb")          # another phone, the same tile
    refusal = v5.decode(sent[1])
    assert refusal["name"] == "not_available" and refusal["request"] == "x"
    assert refusal["reason"] == v5.REASON_RATE_LIMITED
    assert [c["south"] for c in responder.radar_cooldowns()] == [32]
    await responder.handle_request(">radar 32.780,-96.800 z1", "cc")   # a wider tile is another tile
    assert v5.decode(sent[2])["name"] == "radar" and v5.decode(sent[2])["zoom"] == 1
    responder.clear_radar_cooldowns()
    await responder.handle_request(">radar 32.780,-96.800", "dd")
    assert v5.decode(sent[3])["name"] == "radar"


@pytest.mark.parametrize("text, reason", [
    (">radar 47.600,-122.300", v5.REASON_NO_DATA),                     # no picture of Seattle here
    (">radar 13.450,144.790", v5.REASON_NO_DATA),                      # Guam is not calibrated
    (">radar nowhere at all zz", v5.REASON_UNKNOWN_LOCATION),
    (">radar 32.780,-96.800 z7", v5.REASON_UNKNOWN_LOCATION),
])
async def test_refusals(monkeypatch, text, reason):
    responder, sent = _responder(monkeypatch)
    await responder.handle_request(text, "aa")
    out = v5.decode(sent[0])
    assert (out["name"], out["request"], out["reason"]) == ("not_available", "x", reason)


async def test_a_bot_without_a_dish_says_so(monkeypatch, tmp_path):
    responder, sent = _responder(monkeypatch, root=tmp_path / "nothing-here")
    await responder.handle_request(">radar 32.780,-96.800", "aa")
    assert v5.decode(sent[0])["reason"] == v5.REASON_UNSUPPORTED


async def test_an_old_picture_is_no_answer(monkeypatch):
    responder, sent = _responder(monkeypatch, now=NOW + timedelta(hours=3))
    await responder.handle_request(">radar 32.780,-96.800", "aa")
    assert v5.decode(sent[0])["reason"] == v5.REASON_NO_DATA


# ---------------------------------------------------------------------------
# The words
# ---------------------------------------------------------------------------


def test_the_text_reply():
    from meshcore_weather.core import render_text
    loc = {"name": "Dallas", "state": "TX", "lat": 32.78, "lon": -96.80}
    taken = datetime(2026, 9, 20, 23, 38, tzinfo=timezone.utc)
    text = render_text.radar(loc, taken, {"here": 1, "nearest": (1, 4.0, "W"), "heavy": (3, 41.6, "S")}, now=NOW)
    assert "(11 min old)" in text and "Dallas: light precipitation here. Heavy 42 km S" in text
    text = render_text.radar(loc, taken, {"here": 0, "nearest": (2, 37.3, "N"), "heavy": None}, now=NOW)
    assert text.endswith("dry here. Nearest precipitation 37 km N, moderate")
    text = render_text.radar(loc, taken, {"here": 0, "nearest": None, "heavy": None}, now=NOW)
    assert text.endswith("no precipitation on the picture (220 km across)")
    assert "does not reach" in render_text.radar(loc, taken, {"here": None, "nearest": None, "heavy": None}, now=NOW)
    assert "no recent radar picture" in render_text.radar(loc, taken, None, now=NOW)


async def test_radar_is_a_word_people_can_type():
    from meshcore_weather.nlp import parse_intent
    assert await parse_intent("radar austin tx") == {"command": "radar", "location": "austin tx"}
    assert await parse_intent("radar") == {"command": "radar", "location": ""}


# ---------------------------------------------------------------------------
# Revision 13: the last hour (`loop`)
# ---------------------------------------------------------------------------


def test_the_source_finds_the_hour_before_a_picture():
    source = RadarSource(LOOP_ROOT)
    newest = source.newest("RADSTHPL", LOOP_NOW)
    assert newest.taken.strftime("%H:%M") == "01:08"
    older = source.older("RADSTHPL", newest, 60, LOOP_NOW)
    assert [p.taken.strftime("%H:%M") for p in older] == ["00:58", "00:22"]
    assert source.older("RADSTHPL", newest, 60, LOOP_NOW)[0] is older[0]   # decoded once


def test_a_loop_is_one_product_oldest_first(monkeypatch):
    service = RadarService(LOOP_ROOT)
    frames = service.loop_for(37.0, -97.0, 0, now=LOOP_NOW)
    assert [p.taken.strftime("%H:%M") for _, p, _ in frames] == ["00:22", "00:58", "01:08"]
    assert {(t.south, t.west, t.zoom) for t, _, _ in frames} == {(36, -98, 0)}
    assert {f.id for _, _, f in frames} == {"RADSTHPL"}
    # 00:58 is exactly 10 minutes before 01:08, the closest two steps may be.
    monkeypatch.setattr(v5, "RADAR_LOOP_MIN_SPACING_MIN", 11)
    assert [p.taken.strftime("%H:%M") for _, p, _ in service.loop_for(37.0, -97.0, 0, now=LOOP_NOW)] == [
        "00:22", "01:08"]
    assert service.loop_for(37.0, -97.0, 0, now=LOOP_NOW + timedelta(hours=2)) == []


async def test_a_loop_request_sends_the_hour_oldest_first(monkeypatch):
    responder, sent = _responder(monkeypatch, root=LOOP_ROOT, now=LOOP_NOW)
    outcome = await responder.handle_request(">radar 37.000,-97.000 loop", "aa")
    assert outcome.startswith("3 packet(s)")
    out = [v5.decode(x) for x in sent]
    assert [o["name"] for o in out] == ["radar"] * 3
    assert [o["taken_min"] % 1440 for o in out] == [22, 58, 68]
    assert len(responder.radar_cooldowns()) == 3                         # every frame starts its window
    # Asked again at once: everything went by in the last five minutes.
    await responder.handle_request(">radar 37.000,-97.000 loop", "bb")
    assert v5.decode(sent[3])["reason"] == v5.REASON_RATE_LIMITED


async def test_a_loop_leaves_out_what_the_app_holds(monkeypatch):
    responder, sent = _responder(monkeypatch, root=LOOP_ROOT, now=LOOP_NOW)
    await responder.handle_request(">radar 37.000,-97.000 loop 0108 0022", "aa")
    out = [v5.decode(x) for x in sent]
    assert [(o["name"], o["zoom"], o["taken_min"] % 1440) for o in out] == [("radar", 0, 58)]
    responder.clear_radar_cooldowns()
    sent.clear()
    await responder.handle_request(">radar 37.000,-97.000 loop 0108 0058 0022", "bb")
    assert v5.decode(sent[0])["reason"] == v5.REASON_RATE_LIMITED       # nothing it lacks


async def test_a_loop_with_no_picture_says_so(monkeypatch):
    responder, sent = _responder(monkeypatch, root=LOOP_ROOT, now=LOOP_NOW + timedelta(hours=3))
    await responder.handle_request(">radar 37.000,-97.000 loop", "aa")
    assert v5.decode(sent[0])["reason"] == v5.REASON_NO_DATA
