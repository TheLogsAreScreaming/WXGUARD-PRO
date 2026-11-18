"""Storm-report times in every zone a product header can name.

The header pattern read only capitals, so Guam's "1015 PM ChST Sat Oct 17
2026" did not match: every Guam report was taken as UTC, ten hours off, and
fell outside the six-hour window. Each abbreviation now maps to the offset
the zone's own clock has."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from meshcore_weather.core import services
from meshcore_weather.parser.weather import WeatherStore


@pytest.mark.parametrize("abbr,zone,month", [
    ("EST", "America/New_York", 1), ("EDT", "America/New_York", 7),
    ("CST", "America/Chicago", 1), ("CDT", "America/Chicago", 7),
    ("MST", "America/Denver", 1), ("MDT", "America/Denver", 7),
    ("MST", "America/Phoenix", 7),
    ("PST", "America/Los_Angeles", 1), ("PDT", "America/Los_Angeles", 7),
    ("AKST", "America/Anchorage", 1), ("AKDT", "America/Anchorage", 7),
    ("HST", "Pacific/Honolulu", 7), ("HST", "America/Adak", 1), ("HDT", "America/Adak", 7),
    ("AST", "America/Puerto_Rico", 7),
    ("ChST", "Pacific/Guam", 7),
    ("SST", "Pacific/Pago_Pago", 7),
])
def test_every_header_zone_has_its_clocks_offset(abbr, zone, month):
    when = datetime(2026, month, 15, 12, tzinfo=UTC)
    local = when.astimezone(ZoneInfo(zone))
    assert local.tzname().upper() == abbr.upper() or zone == "Pacific/Pago_Pago"   # tzdata calls Samoa "SST"
    assert services._TZ_ABBR_OFFSET[abbr.upper()] == local.utcoffset() / timedelta(hours=1)
    m = services._LSR_HDR_RE.search(f"1015 PM {abbr} Sat Oct 17 2026")
    assert m and m.group(1) == abbr


def test_a_guam_report_is_read_in_chamorro_time():
    entry = {"date": "10/17/2026", "time": "1015 PM"}
    assert services._lsr_entry_time(entry, "ChST") == datetime(2026, 10, 17, 12, 15, tzinfo=UTC)


def _guam_lsr(local: datetime) -> dict:
    """A Guam Local Storm Report in the format of the real ones (built: none
    was received while the dish was recording)."""
    stamp = f"{local:%I%M %p} ChST {local:%a %b %d %Y}".lstrip("0")
    lines = [
        f"NWUS56 PGUM {local - timedelta(hours=10):%d%H%M}", "LSRGUM", "",
        "Preliminary Local Storm Report", "National Weather Service Tiyan GU", stamp, "",
        "..TIME...   ...EVENT...      ...CITY LOCATION...     ...LAT.LON...",
        "..DATE...   ....MAG....      ..COUNTY LOCATION..ST.. ...SOURCE....",
        "            ..REMARKS..", "",
        f"{local:%I%M %p}     Flood            Hagatna                 13.48N 144.75E",
        f"{local:%m/%d/%Y}                   Guam               GU   Public           ", "",
        "            Water over the road at Marine Corps Drive. ", "", "$$", ""]
    issued = local - timedelta(hours=10)
    return {"filename": f"A_NWUS56PGUM{issued:%d%H%M}_C_KWIN_{datetime.now(UTC):%Y%m%d%H%M%S}_000001-2-LSRGUMGU.TXT",
            "raw_text": "\r\r\n".join(lines)}


def test_guam_storm_reports_are_recent():
    local = (datetime.now(UTC) - timedelta(minutes=30)).astimezone(ZoneInfo("Pacific/Guam")).replace(tzinfo=None)
    store = WeatherStore()
    store.ingest([_guam_lsr(local)])
    sr = services.storm_reports_for(store, state="GU")
    assert sr is not None and [e["event"] for e in sr.entries] == ["Flood"]
    assert abs(sr.entries[0]["at"] - (datetime.now(UTC) - timedelta(minutes=30))) < timedelta(minutes=2)
