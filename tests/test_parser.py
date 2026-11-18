"""Tests for the EMWIN parser and geo resolver."""

from datetime import datetime, timezone

from meshcore_weather.geodata import resolver
from meshcore_weather.parser.weather import WeatherStore
from meshcore_weather.protocol import v5


def _make_emwin(emwin_id: str, text: str, ts: str = "") -> dict:
    """Create a mock EMWIN product dict with proper filename."""
    if not ts:
        ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    return {
        "filename": f"A_XXXX00KWBC_{ts}_000000-2-{emwin_id}.TXT",
        "raw_text": text,
    }


class TestWeatherStore:
    def test_ingest_and_find_by_emwin_id(self):
        store = WeatherStore()
        count = store.ingest([
            _make_emwin("ZFPEWXTX", "TXZ192-\n.TODAY...Sunny. High 85."),
            _make_emwin("RWREWXTX", "SKY/WX TMP\nAUSTIN SUNNY 85 55 40 S10 30.05"),
        ])
        assert count == 2

        # Should find ZFP for EWX+TX
        p = store._find("ZFP", "EWXTX")
        assert p is not None
        assert p.product_type == "ZFP"

    def test_find_newest(self):
        store = WeatherStore()
        now = datetime.now(timezone.utc)
        old_ts = (now - __import__('datetime').timedelta(hours=2)).strftime("%Y%m%d%H%M%S")
        new_ts = (now - __import__('datetime').timedelta(hours=1)).strftime("%Y%m%d%H%M%S")
        store.ingest([
            _make_emwin("ZFPEWXTX", "old forecast", ts=old_ts),
            _make_emwin("ZFPEWXTX", "new forecast", ts=new_ts),
        ])
        p = store._find("ZFP", "EWXTX")
        assert "new forecast" in p.raw_text

    def test_zfp_zone_parsing(self):
        store = WeatherStore()
        zfp_text = """FPUS54 KEWX 072238
ZFPEWX

TXZ192-TXZ193-080100-
Travis-Williamson-
Including the cities of Austin and Round Rock
1038 PM CDT TUE APR 7 2026

.TONIGHT...Clear. Low around 55. North wind 5 to 10 mph.
.WEDNESDAY...Sunny. High near 82. South wind 5 to 10 mph.
$$"""
        store.ingest([_make_emwin("ZFPEWXTX", zfp_text)])
        forecast = store._parse_zfp_zone(zfp_text, "TXZ192")
        assert "TONIGHT" in forecast
        assert "Clear" in forecast

    def test_rwr_city_parsing(self):
        store = WeatherStore()
        rwr_text = """ASCA42 KEWX 072200
RWREWX

CITY           SKY/WX    TMP DP  RH WIND       PRES
AUSTIN         CLEAR     68  45  43 N5        30.12
SAN ANTONIO    PTCLDY    70  48  45 SE8       30.10
$$"""
        result = store._parse_rwr_city(rwr_text, "AUSTIN")
        assert "Clear" in result
        assert "68F" in result


class TestLocationResolver:
    def test_resolve_station(self):
        resolver.load()
        r = resolver.resolve("KAUS")
        assert r is not None
        assert any("TX" in z for z in r["zones"])

    def test_resolve_city_state(self):
        resolver.load()
        r = resolver.resolve("Austin TX")
        assert r is not None
        assert "EWX" in r["wfos"]

    def test_resolve_zone(self):
        resolver.load()
        r = resolver.resolve("NYZ010")
        assert r is not None

    def test_resolve_unknown(self):
        resolver.load()
        r = resolver.resolve("Zzxqvw")
        assert r is None


def test_ingest_skips_products_already_held():
    """The sources hand back their whole cache every poll. Re-parsing all
    of it on the event loop is what used to stall the echo handler."""
    store = WeatherStore()
    batch = [_make_emwin("ZFPEWXTX", "TXZ192-\n.TODAY...Sunny. High 85."),
             _make_emwin("RWREWXTX", "SKY/WX TMP\nAUSTIN SUNNY 85 55 40 S10 30.05")]
    assert store.ingest(batch) == 2
    assert store.ingest(batch) == 0
    assert len(store._products) == 2

    parsed = []
    real = store._parse
    store._parse = lambda raw: (parsed.append(raw["filename"]), real(raw))[1]
    fresh = _make_emwin("AFDEWXTX", "...SHORT TERM...\nHot.")
    assert store.ingest(batch + [fresh]) == 1
    assert parsed == [fresh["filename"]]          # the 2 known ones never reached the parser


# -- Where the products came from (spec 2.3, revision 7) --------------------


def _sourced(emwin_id: str, source: str) -> dict:
    return {**_make_emwin(emwin_id, "body"), "source": source}


def test_a_product_keeps_the_source_the_fetcher_stamped_on_it():
    store = WeatherStore()
    store.ingest([_sourced("ZFPEWXTX", "sdr"), _sourced("RWREWXTX", "internet"),
                  _make_emwin("AFDEWXTX", "unstamped")])
    by_id = {p.emwin_id: p for p in store._products.values()}
    assert by_id["ZFPEWXTX"].source == "sdr"
    assert by_id["RWREWXTX"].source == "internet"
    assert by_id["AFDEWXTX"].source == ""       # a source that did not say


def test_product_source_maps_one_product_to_a_wire_constant():
    store = WeatherStore()
    store.ingest([_sourced("ZFPEWXTX", "sdr"), _sourced("RWREWXTX", "internet"),
                  _make_emwin("AFDEWXTX", "unstamped")])
    by_id = {p.emwin_id: p for p in store._products.values()}
    assert store.product_source(by_id["ZFPEWXTX"]) == v5.SOURCE_GOES
    assert store.product_source(by_id["RWREWXTX"]) == v5.SOURCE_INTERNET
    assert store.product_source(by_id["AFDEWXTX"]) == v5.SOURCE_UNSTATED
    # A warning entry carries the source of the product it came out of, so it
    # answers the same way.
    assert store.product_source({"source": "sdr"}) == v5.SOURCE_GOES
    assert store.product_source({}) == v5.SOURCE_UNSTATED
    assert store.product_source(None) == v5.SOURCE_UNSTATED


def test_products_source_says_mixed_only_when_the_store_really_disagrees():
    store = WeatherStore()
    assert store.products_source() == v5.SOURCE_UNSTATED      # nothing held yet

    store.ingest([_sourced("ZFPEWXTX", "sdr"), _sourced("RWREWXTX", "sdr")])
    assert store.products_source() == v5.SOURCE_GOES

    # An unstamped product is not counted: one old cache line does not turn a
    # dish-fed bot into a mixed one.
    store.ingest([_make_emwin("AFDEWXTX", "unstamped")])
    assert store.products_source() == v5.SOURCE_GOES

    store.ingest([_sourced("HWOEWXTX", "internet")])
    assert store.products_source() == v5.SOURCE_MIXED

    # And it answers about a named subset, not only the whole store.
    goes = [p for p in store._products.values() if p.source == "sdr"]
    assert store.products_source(goes) == v5.SOURCE_GOES
    assert store.products_source([]) == v5.SOURCE_UNSTATED
