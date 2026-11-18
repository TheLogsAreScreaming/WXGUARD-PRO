#!/usr/bin/env python3
"""Generate the MeshWX v5 client bundle index and the wire test vectors.

    python3 scripts/v5_vectors.py            # writes both files
    python3 scripts/v5_vectors.py --index    # only client_data/index.json
    python3 scripts/v5_vectors.py --vectors  # only docs/meshwx_v5_vectors.json

``index.json`` is the append-only table the wire indexes into: office byte,
station u16 and state byte (spec 16).  It is derived, never hand-edited.

The vectors are the conformance fixtures for ``docs/MeshWX_v5_Spec.md``: a
client is correct when it decodes every ``hex`` to the ``decoded`` JSON and
re-encodes that JSON back to the same ``hex``.

Values are Austin-area and realistic: office EWX, stations KAUS/KGTU/KHYI,
PFM point 102 (Austin Bergstrom), and ``NOW_MIN`` = 2026-09-15 01:00 UTC.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from meshcore_weather.protocol import v5  # noqa: E402

CLIENT_DATA = ROOT / "meshcore_weather" / "client_data"
INDEX_PATH = CLIENT_DATA / "index.json"
VECTORS_PATH = ROOT / "docs" / "meshwx_v5_vectors.json"

#: 2026-09-15 01:00 UTC, in Unix minutes.
NOW_MIN = 29823900

BOT = 0x4C7A  # first two bytes of the WX-AUS public key, little-endian u16


def _load(name: str):
    with open(CLIENT_DATA / name, encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------
# index.json
# --------------------------------------------------------------------------


def build_index() -> dict:
    """Offices, stations and states, in the exact order the wire indexes."""
    return {
        "version": 2,
        # wfos.json is in wire order: the sorted WFOs, then the national
        # centres NHC and WNS appended (build_client_data.py). Never re-sort.
        "offices": list(_load("wfos.json").keys()),
        "stations": sorted(_load("stations.json").keys()),
        # state_index.json is append-only and its order IS the wire order.
        "states": list(_load("state_index.json")["states"]),
    }


def write_index() -> dict:
    index = build_index()
    with open(INDEX_PATH, "w", encoding="utf-8") as fh:
        json.dump(index, fh, separators=(",", ":"))
        fh.write("\n")
    print(
        f"wrote {INDEX_PATH.relative_to(ROOT)}: "
        f"{len(index['offices'])} offices, {len(index['stations'])} stations, "
        f"{len(index['states'])} states"
    )
    return index


# --------------------------------------------------------------------------
# Vectors
# --------------------------------------------------------------------------

# Event codes come from protocol.json "events".
EV_TO_W = 1   # tornado warning
EV_SV_W = 3   # severe thunderstorm warning
EV_FF_W = 6   # flash flood warning
EV_FA_A = 10  # flood watch
EV_WS_W = 24  # winter storm warning


def build_vectors(index: dict) -> list:
    offices = index["offices"]
    stations = index["stations"]
    states = index["states"]

    ewx = offices.index("EWX")
    kaus = stations.index("KAUS")
    kgtu = stations.index("KGTU")
    khyi = stations.index("KHYI")

    vectors = []

    def add(name, data, note=None):
        entry = {"name": name, "hex": data.hex(), "decoded": v5.decode(data)}
        if note:
            entry["note"] = note
        vectors.append(entry)

    # 1. Severe thunderstorm warning: polygon (6 vertices) + 2 county runs,
    #    hail 1.00 in, wind 60 mph, tornado possible (radar indicated).
    add(
        "severe_thunderstorm_warning_polygon",
        v5.encode_warning(
            17,
            BOT,
            event=EV_SV_W,
            office=ewx,
            etn=42,
            expires_min=NOW_MIN + 45,
            tornado=v5.TAG_TORNADO_RADAR_INDICATED,
            hail_qin=4,
            wind_mph=60,
            polygon=[
                (30.52, -97.98),
                (30.61, -97.62),
                (30.38, -97.41),
                (30.15, -97.50),
                (30.09, -97.85),
                (30.28, -98.04),
            ],
            areas=v5.areas_from_ugcs(["TXC453", "TXC209"], states),
        ),
        "SV.W.EWX.42 over Travis and Hays counties; expires 01:45 UTC",
    )

    # 1b. The same warning with its issue time: flags nibble bit 1 set and the
    #     issue time after the area list, as minutes before `expires`. Issued
    #     01:24 UTC, expires 01:45.
    add(
        "severe_thunderstorm_warning_issued",
        v5.encode_warning(
            28,
            BOT,
            event=EV_SV_W,
            office=ewx,
            etn=42,
            expires_min=NOW_MIN + 45,
            tornado=v5.TAG_TORNADO_RADAR_INDICATED,
            hail_qin=4,
            wind_mph=60,
            polygon=[
                (30.52, -97.98),
                (30.61, -97.62),
                (30.38, -97.41),
                (30.15, -97.50),
                (30.09, -97.85),
                (30.28, -98.04),
            ],
            areas=v5.areas_from_ugcs(["TXC453", "TXC209"], states),
            issued_min=NOW_MIN + 24,
        ),
        "SV.W.EWX.42 again, with the issue time (flags bit 1): 53 bytes, the "
        "two trailing bytes hold 21 = minutes between the issuance and the expiry",
    )

    # 1c. The same warning again, as a bot fed by its own GOES dish sends it:
    #     source 1 in bits 2-3 of the flags nibble, beside the issue-time bit.
    #     Not one byte of the body differs.
    add(
        "severe_thunderstorm_warning_from_goes",
        v5.encode_warning(
            31,
            BOT,
            event=EV_SV_W,
            office=ewx,
            etn=42,
            expires_min=NOW_MIN + 45,
            tornado=v5.TAG_TORNADO_RADAR_INDICATED,
            hail_qin=4,
            wind_mph=60,
            polygon=[
                (30.52, -97.98),
                (30.61, -97.62),
                (30.38, -97.41),
                (30.15, -97.50),
                (30.09, -97.85),
                (30.28, -98.04),
            ],
            areas=v5.areas_from_ugcs(["TXC453", "TXC209"], states),
            issued_min=NOW_MIN + 24,
            source=v5.SOURCE_GOES,
        ),
        "type byte 0x16: warning, flags 0x6 = issued (bit 1) + source 1 GOES "
        "(bits 2-3); otherwise byte for byte the issued vector",
    )

    # 1d. A watch issued before it takes effect carries its start: a Flood
    #     Watch issued at 09:24 on a Tuesday for Wednesday 19:00 through Friday
    #     19:00 (both CDT). Zones only.
    add(
        "warning_upcoming_watch",
        v5.encode_warning(
            33,
            BOT,
            event=EV_FA_A,
            office=ewx,
            etn=8,
            expires_min=NOW_MIN + 4896,      # Friday 19:00: 81 h 36 min after issuance
            areas=v5.areas_from_ugcs(
                ["TXZ191", "TXZ192", "TXZ193", "TXZ194", "TXZ205", "TXZ206"], states
            ),
            issued_min=NOW_MIN,
            begins_min=NOW_MIN + 2016,       # Wednesday 19:00: 33 h 36 min after issuance
            source=v5.SOURCE_GOES,
        ),
        "FA.A.EWX.8, not in effect until 33 h 36 min after it was issued: after "
        "the issue time (4896 = issued_before) two more bytes, 2880 = minutes "
        "from the start to the expiry, found by length. Shown from Wednesday "
        "19:00 until Friday 19:00, not as in effect now",
    )

    # 2. Winter storm warning: zone list only (TXZ191-194 and TXZ200).
    add(
        "winter_storm_warning_zones",
        v5.encode_warning(
            18,
            BOT,
            event=EV_WS_W,
            office=ewx,
            etn=7,
            expires_min=NOW_MIN + 1080,  # 18 hours
            areas=v5.areas_from_ugcs(
                ["TXZ191", "TXZ192", "TXZ193", "TXZ194", "TXZ200"], states
            ),
        ),
        "WS.W.EWX.7, two runs: zones 191-194 and zone 200",
    )

    # 3. Cancel: the severe thunderstorm warning expired early.
    add(
        "cancel_expired_early",
        v5.encode_cancel(
            19,
            BOT,
            event=EV_SV_W,
            office=ewx,
            etn=42,
            reason=v5.CANCEL_EXPIRED,
        ),
    )

    # 4. Digest: 3 active identities, feed last heard 28 minutes ago (7 x 4).
    add(
        "digest_three_entries",
        v5.encode_digest(
            20,
            BOT,
            now_min=NOW_MIN,
            feed_health=7,
            entries=[
                (EV_SV_W, ewx, 42, NOW_MIN + 45),
                (EV_WS_W, ewx, 7, NOW_MIN + 1080),
                (EV_SV_W, ewx, 43, NOW_MIN + 20),
            ],
        ),
    )

    # 5. Observations: KAUS complete, KGTU calm with gaps, KHYI mostly unknown.
    add(
        "observations_three_stations",
        v5.encode_obs(
            21,
            BOT,
            ts_min=NOW_MIN - 7,
            stations=[
                {
                    "station": kaus,
                    "temp_f": 88,
                    "dewpoint_f": 72,
                    "wind_dir_deg": 160,
                    "sky": 3,
                    "wind_mph": 12,
                    "gust_mph": 21,
                    "visibility_mi": 10,
                    "pressure_inhg": 29.92,
                    "humidity_pct": 59,
                    "feels_delta_f": 7,
                },
                {
                    "station": kgtu,
                    "temp_f": 84,
                    "dewpoint_f": 70,
                    "wind_dir_deg": None,  # calm
                    "sky": 1,
                    "wind_mph": 0,
                    "gust_mph": 0,
                    "visibility_mi": 10,
                    "pressure_inhg": 29.95,
                    "humidity_pct": None,
                    "feels_delta_f": 0,
                },
                {
                    "station": khyi,
                    "temp_f": None,
                    "dewpoint_f": None,
                    "wind_dir_deg": 290,
                    "sky": 10,
                    "wind_mph": None,
                    "gust_mph": 0,
                    "visibility_mi": None,
                    "pressure_inhg": None,
                    "humidity_pct": None,
                    "feels_delta_f": 0,
                },
            ],
        ),
        "KGTU is calm, KHYI has only wind direction and sky",
    )

    # 5b. The same batch with per-station ages: flags nibble bit 0 set and a
    #     trailing nibble per station saying how far behind
    #     `ts` that station's own METAR is, in 10-minute steps. KAUS is the
    #     newest report, so its age is 0; KHYI filed 110 minutes earlier and
    #     must not be drawn as "as of" the batch time.
    add(
        "observations_three_stations_ages",
        v5.encode_obs(
            29,
            BOT,
            ts_min=NOW_MIN - 7,
            stations=[
                {
                    "station": kaus,
                    "temp_f": 88,
                    "dewpoint_f": 72,
                    "wind_dir_deg": 160,
                    "sky": 3,
                    "wind_mph": 12,
                    "gust_mph": 21,
                    "visibility_mi": 10,
                    "pressure_inhg": 29.92,
                    "humidity_pct": 59,
                    "feels_delta_f": 7,
                    "age_min": 0,
                },
                {
                    "station": kgtu,
                    "temp_f": 84,
                    "dewpoint_f": 70,
                    "wind_dir_deg": None,  # calm
                    "sky": 1,
                    "wind_mph": 0,
                    "gust_mph": 0,
                    "visibility_mi": 10,
                    "pressure_inhg": 29.95,
                    "humidity_pct": None,
                    "feels_delta_f": 0,
                    "age_min": 20,
                },
                {
                    "station": khyi,
                    "temp_f": None,
                    "dewpoint_f": None,
                    "wind_dir_deg": 290,
                    "sky": 10,
                    "wind_mph": None,
                    "gust_mph": 0,
                    "visibility_mi": None,
                    "pressure_inhg": None,
                    "humidity_pct": None,
                    "feels_delta_f": 0,
                    "age_min": 110,
                },
            ],
        ),
        "with per-station ages (flags bit 0): 44 bytes, ages 0 / 20 / 110 "
        "minutes packed as nibbles 0, 2 and 11 in two trailing bytes (0x20, 0x0b)",
    )

    # 6. Forecast: point 102 (Austin Bergstrom), 7 periods from tonight.
    #    Night periods carry high = None (127), day periods low = None (127).
    add(
        "forecast_seven_periods",
        v5.encode_forecast(
            22,
            BOT,
            point=102,
            issued_min=NOW_MIN - 120,
            first_period=1,  # tonight
            periods=[
                {   # 1 tonight
                    "high_f": None, "low_f": 73, "pop_pct": 20, "sky": 2,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": True, "wind_dir_deg": 157.5, "wind_mph": 5,
                },
                {   # 2 tomorrow
                    "high_f": 93, "low_f": None, "pop_pct": 40, "sky": 3,
                    "thunder": True, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 180, "wind_mph": 10,
                },
                {   # 3 tomorrow night
                    "high_f": None, "low_f": 72, "pop_pct": 30, "sky": 3,
                    "thunder": True, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 180, "wind_mph": 5,
                },
                {   # 4
                    "high_f": 90, "low_f": None, "pop_pct": 60, "sky": 8,
                    "thunder": True, "wintry": False, "windy": True,
                    "fog": False, "wind_dir_deg": 202.5, "wind_mph": 20,
                },
                {   # 5
                    "high_f": None, "low_f": 69, "pop_pct": 20, "sky": 2,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 315, "wind_mph": 10,
                },
                {   # 6
                    "high_f": 86, "low_f": None, "pop_pct": 10, "sky": 1,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 0, "wind_mph": 10,
                },
                {   # 7
                    "high_f": None, "low_f": 65, "pop_pct": None, "sky": 0,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": None, "wind_mph": None,
                },
            ],
        ),
        "point 102 = Austin Bergstrom-Travis TX; the reserved half-day form, "
        "odd first_period with alternating temperatures",
    )

    # 6b. Forecast as this bot actually sends it: whole days, even first_period,
    #     every entry carrying BOTH a high and a low. Temperatures follow a real
    #     WX-AUS week for point 103 (spec 7).
    add(
        "forecast_seven_days",
        v5.encode_forecast(
            26,
            BOT,
            point=103,
            issued_min=NOW_MIN - 60,
            first_period=0,  # day 0; always even for daily periods
            periods=[
                {   # day 0
                    "high_f": 102, "low_f": 77, "pop_pct": 0, "sky": 0,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 180, "wind_mph": 10,
                },
                {   # day 1
                    "high_f": 100, "low_f": 78, "pop_pct": 0, "sky": 1,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 180, "wind_mph": 10,
                },
                {   # day 2
                    "high_f": 99, "low_f": 76, "pop_pct": 30, "sky": 3,
                    "thunder": True, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 180, "wind_mph": 10,
                },
                {   # day 3
                    "high_f": 98, "low_f": 74, "pop_pct": 10, "sky": 2,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 157.5, "wind_mph": 5,
                },
                {   # day 4
                    "high_f": 98, "low_f": 75, "pop_pct": 0, "sky": 1,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 135, "wind_mph": 5,
                },
                {   # day 5
                    "high_f": 99, "low_f": 75, "pop_pct": 10, "sky": 2,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 180, "wind_mph": 10,
                },
                {   # day 6
                    "high_f": 95, "low_f": 74, "pop_pct": 20, "sky": 3,
                    "thunder": False, "wintry": False, "windy": False,
                    "fog": False, "wind_dir_deg": 157.5, "wind_mph": 10,
                },
            ],
        ),
        "point 103 = Austin Camp Mabry-Travis TX; the daily form this bot sends",
    )

    # 6c. Coverage: WX-AUS as it really is. 36 public zones inside 120 km of
    #     Austin, which sort into five consecutive runs, four offices, and the
    #     hourly observations cap.
    add(
        "coverage_wx_aus",
        v5.encode_coverage(
            27,
            BOT,
            lat=30.2672,
            lon=-97.7431,
            radius_km=120,
            stations=13,
            offices=[offices.index(c) for c in ("EWX", "FWD", "HGX", "SJT")],
            areas=v5.areas_from_ugcs(
                [
                    f"TXZ{n:03d}"
                    for n in (
                        list(range(155, 161))
                        + list(range(170, 176))
                        + list(range(186, 198))
                        + list(range(205, 212))
                        + list(range(221, 226))
                    )
                ],
                states,
            ),
        ),
        "WX-AUS's coverage: 36 zones as 5 runs inside 120 km of Austin, offices "
        "EWX/FWD/HGX/SJT, neither list cut, a station cap of 13",
    )

    # 7. Text: a warning narrative in two chunks, chunk 0 filled to the
    #    transport's 165-byte maximum. A bot sends at most 157, so the encoder
    #    refuses to build chunk 0 and the bytes are pinned here: a decoder must
    #    read anything the transport carries (spec section 2.5).
    for name, hexdata in (
        ("text_warning_narrative_chunk0", "177a4c6000170002534556455245205448554e44455253544f524d205741524e494e4720464f52204e4f5254484541535445524e204841595320414e4420534f5554485745535445524e2054524156495320434f554e5449455320554e54494c2031343520414d204344542e204174203132353720414d206120736576657265207468756e64657273746f726d20776173206e656172204472697070696e6720537072696e"),
        ("text_warning_narrative_chunk1", "187a4c600017010267732c206d6f76696e672065617374206174203430206d70682e2048415a4152443a203630206d706820677573747320616e6420717561727465722073697a65206861696c2e20534f555243453a20526164617220696e646963617465642e"),
    ):
        add(
            name,
            bytes.fromhex(hexdata),
            "group 23, reassemble by (bot, group) in idx order. Chunk 0 is 165 "
            "bytes, the transport maximum: past what a bot sends, and a decoder "
            "must still read it",
        )

    # 7b. Text: a forecast discussion longer than the air allows.
    #     Source 1 (off the bot's own GOES dish) in bits 2-3 and the cut flag
    #     in bit 0 make the flags nibble 0x5, on this chunk and on every other
    #     chunk of the same reply.
    add(
        "text_afd_cut_from_goes",
        v5.encode_text(
            30,
            BOT,
            subject=v5.SUBJECT_AFD,
            group=30,
            idx=0,
            total=8,
            text=(
                "SHORT TERM. Isolated to scattered showers and storms will "
                "develop along the seabreeze this afternoon and drift inland "
                "through the evening."
            ),
            source=v5.SOURCE_GOES,
            cut=True,
        ),
        "type byte 0x65: text, flags 0x5 = cut (bit 0) + source 1 GOES "
        "(bits 2-3); the tail of the discussion did not fit in eight chunks",
    )

    # 8. Not available: a forecast for a place the bot could not resolve.
    add(
        "not_available_unknown_location",
        v5.encode_not_available(
            25, BOT, request="f round rock zz", reason=v5.REASON_UNKNOWN_LOCATION
        ),
    )

    # 8b. Area sweep: the national picture, the answer to `>wmap`, cut, in two
    #     packets. Packet 0 holds 38 entries, 163 bytes: past the 36 a bot
    #     sends, so the encoder refuses it and the bytes are pinned here, and a
    #     decoder must still read it (spec section 2.5). Warnings first, then
    #     watches; inside each, by state and then by the run's first number.
    #     The cut flag is on both packets.
    for name, hexdata in (
        ("area_sweep_national_packet0", "207a4ca99c13c7012000020b060a0c0307770806079100180a211c0b1814080b1c1410031fad0803232104082347000b2c2808032f31140b301e140331bd040631fe011834010401471b040347290c064765000355d11003552b0906554b050155c5010155eb0118620c0c040146100207320c190a321404133c0c041df415041f2c2d07235a10072f500c0431901d19320a100435580e194205040247c81419500708"),
        ("area_sweep_national_packet1", "217a4ca99c13c7012001020255642419621e08"),
    ):
        add(
            name,
            bytes.fromhex(hexdata),
            "type byte 0xA9: area sweep, flags 0x9 = cut (bit 0) + source 2 "
            "internet (bits 2-3); advisories (bit 1) clear, so this is "
            "warnings and watches only. Group 32, reassemble by (bot, group) "
            "in idx order. `total` has bit 7 clear and there are no scope "
            "entries: the country. Packet 0 carries 38 entries (163 bytes), "
            "more than a bot sends, and a decoder must still read it",
        )

    def runs(event, state, kind, spans):
        """`(event, state index, is_county, start, run)` for one state."""
        return [
            (event, states.index(state), kind == "C", start, run)
            for start, run in spans
        ]

    def in_wire_order(entries):
        """Inside one severity: by state, then by the run's first number."""
        return sorted(entries, key=lambda e: (e[1], e[3], e[2]))

    # 8c. Area sweep: a sweep of two states, the answer to
    #     `>wmap OKTX`.  Packet 0 opens with one scope entry per state asked
    #     for — event 0, zone kind, start 0, run 1, which is `XXZ000`, "all of
    #     state XX" — and `total` carries bit 7 to say the picture is those
    #     states and not the country.  Oklahoma has nothing active: its scope
    #     entry with no alert entry behind it is the answer, and the reason the
    #     scope is on the wire at all.
    scoped_scope = sorted(states.index(s) for s in ("OK", "TX"))
    add(
        "area_sweep_scoped_packet0",
        v5.sweep_packets(
            34,
            BOT,
            built_min=NOW_MIN,
            entries=in_wire_order(
                runs(EV_WS_W, "TX", "Z", [(191, 4)])
                + runs(EV_SV_W, "TX", "C", [(209, 5)])
                + runs(EV_TO_W, "TX", "C", [(453, 1)])
                + runs(EV_FF_W, "TX", "C", [(491, 2)])
            ),
            scope=scoped_scope,
            source=v5.SOURCE_INTERNET,
        )[0],
        "type byte 0xA8: area sweep, flags 0x8 = source 2 internet, nothing "
        "cut and no advisories. `total` is 0x81: bit 7 scoped, one packet. "
        "The first two entries are the scope, Oklahoma and Texas; Oklahoma "
        "has no alert entry, which says it is clear at this level",
    )

    # 9. Request: the one message that travels app -> bot, a `>d` flooded on
    #    #meshwx.  Its `bot` is 0x041D, not this bot's BOT, because the vector
    #    is the spec's own (section 11) and an app must be able to
    #    check the bytes it sends without knowing which bot it is talking to.
    add(
        "request_digest",
        v5.encode_request(
            1,
            0x041D,
            bytes.fromhex("010203040506"),
            1789660000,
            ">d",
        ),
        "app -> bot: 16 bytes, sender prefix 01..06, ts 1789660000 "
        "(2026-09-17 15:46:40 UTC); a resend keeps sender, ts and text and "
        "takes the next seq",
    )

    # 9b. Request: the three packets of a sweep this phone never
    #     heard, asked for by the group the packets it did hear carried.
    add(
        "request_parts",
        v5.encode_request(
            2,
            0x041D,
            bytes.fromhex("010203040506"),
            1789660042,
            ">part 212 1,4,6",
        ),
        "app -> bot: `>part <group> <idx>[,<idx>…]`, decimal. The answer is "
        "those packets again, identical but for a fresh seq; the group they "
        "carry does not change",
    )

    # 9c. Request: a forecast for a coordinate, which is how a
    #     phone asks when it knows of no bundled point near the place. Three
    #     decimals, the comma is what tells it from a place name.
    add(
        "request_forecast_at",
        v5.encode_request(
            3,
            0x041D,
            bytes.fromhex("010203040506"),
            1789660100,
            ">f 35.687,-105.938",
        ),
        "app -> bot: Santa Fe NM as a coordinate. The answer is an ordinary "
        "Forecast for the nearest point the bot holds one for, carrying that "
        "point's bundle index or 0xFFFF when it is not in the bundle",
    )

    # 10. Radar: one tile of a radar picture.  This one is real:
    #     the 2 x 2 degree tile around Dallas cut from the Southern Plains
    #     mosaic the dish received at 23:46 UTC on 20 September 2026, picture
    #     time 23:38, with a squall line across it.  32 rows of 32 levels,
    #     north row first: 0 none, 1 light, 2 moderate, 3 heavy.
    dallas_rows = [
        "00000000000000000000001111111111",
        "00000000000000000000001111111111",
        "00000000000000000000001121111111",
        "00000000000000000000001111111222",
        "00000000000000000000011111112233",
        "00000000000000000000221111001223",
        "00000000000000000000222220000122",
        "00000000000000000002222220000000",
        "00000000000000000020022220000000",
        "00000000000000002220002200000000",
        "00000000000000022220000000000000",
        "00000000000000022200000000000000",
        "00000000000000011100000000000010",
        "00000000000000000000110111100110",
        "00000000000000000001111111111000",
        "00000000000000000001111111110000",
        "00000000000000000001111111111000",
        "00000000000000111111111111111000",
        "00000000000000111111111111111000",
        "00000000000000111111111111100000",
        "00000000000001111111111111100000",
        "00000000000011112222111111110000",
        "00000000000011122222211111110000",
        "00000000000111222221111111100000",
        "00000000011112222222211111101000",
        "00000001111222221123321111111000",
        "00000011112222221122301111111000",
        "00000011112222211122211111111000",
        "00000011111222111112111111100000",
        "00000001221222211110001100000000",
        "00000000221122221100000000000000",
        "00000001111111222100000000000000",
    ]
    add(
        "radar_tile",
        v5.encode_radar(
            40,
            BOT,
            taken_min=29832458,
            south=32,
            west=-98,
            zoom=0,
            product=1,
            rows=[[int(ch) for ch in row] for row in dallas_rows],
            source=v5.SOURCE_GOES,
        ),
        "type byte 0xB4: radar, flags 0x4 = source 1 GOES, fine (32 x 32) and "
        "whole. `shape` 0x04 = product 1 (RADSTHPL) << 2 | zoom 0. The tile is "
        "32N to 34N, 98W to 96W; the cells are a quadtree, most significant "
        "bit first",
    )

    # 10b. Radar: a coarse, partial tile.  16 x 16 because the fine picture did
    #      not fit, and only rows 0 to 9 are inside the radar picture: the six
    #      rows south of it are unknown, not dry, and are level 0 on the wire.
    coarse_rows = [[0] * 16 for _ in range(16)]
    for r, c, level in [(2, 3, 1), (2, 4, 2), (3, 3, 2), (3, 4, 3), (3, 5, 2), (4, 4, 1),
                        (7, 10, 1), (7, 11, 1), (8, 10, 1), (8, 11, 2), (9, 11, 1)]:
        coarse_rows[r][c] = level
    add(
        "radar_tile_coarse_partial",
        v5.encode_radar(
            41,
            BOT,
            taken_min=29832458,
            south=24,
            west=-100,
            zoom=1,
            product=1,
            rows=coarse_rows,
            bounds=(0, 9, 0, 15),
            source=v5.SOURCE_GOES,
        ),
        "type byte 0xB7: radar, flags 0x7 = coarse (bit 0) + partial (bit 1) + "
        "source 1 GOES. Four bounds bytes follow the fixed fields: rows 0-9, "
        "columns 0-15 of this 16 x 16 grid are inside the radar picture",
    )

    # 10c. The request for the first of those, and the refusal a second phone
    #      gets when it asks for the same tile of the same picture inside five
    #      minutes.  The letter is `x`: `r` is `>rain`.
    add(
        "request_radar",
        v5.encode_request(
            4,
            0x041D,
            bytes.fromhex("010203040506"),
            1789948000,
            ">radar 32.780,-96.800",
        ),
        "app -> bot: the zoom 0 tile for Dallas. A wider tile is "
        "`>radar 32.780,-96.800 z2`",
    )
    add(
        "not_available_radar",
        v5.encode_not_available(42, BOT, request=v5.RADAR_REQUEST_LETTER, reason=v5.REASON_RATE_LIMITED),
        "request letter `x` (0x78) is `>radar`, the one request whose letter "
        "is not its first; reason 4, this tile of this picture went out in "
        "the last 5 minutes",
    )

    # 11. The last hour of a tile: no new message, one request word.
    add(
        "request_radar_loop",
        v5.encode_request(
            6,
            0x041D,
            bytes.fromhex("010203040506"),
            1789948120,
            ">radar 30.270,-97.740 loop 2353 2338",
        ),
        "app -> bot: the last hour of the zoom 0 tile for Austin, leaving out the "
        "pictures taken at 23:53 and 23:38 UTC, which this app already holds (newest first)",
    )

    return vectors


def write_vectors(index: dict) -> list:
    vectors = build_vectors(index)
    with open(VECTORS_PATH, "w", encoding="utf-8") as fh:
        json.dump(vectors, fh, indent=2)
        fh.write("\n")
    print(f"wrote {VECTORS_PATH.relative_to(ROOT)}: {len(vectors)} vectors")
    for entry in vectors:
        print(f"  {len(entry['hex']) // 2:3d} bytes  {entry['name']}")
    return vectors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index", action="store_true", help="only write index.json")
    ap.add_argument(
        "--vectors", action="store_true", help="only write the test vectors"
    )
    args = ap.parse_args()
    both = not (args.index or args.vectors)

    index = write_index() if (both or args.index) else build_index()
    if both or args.vectors:
        write_vectors(index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
