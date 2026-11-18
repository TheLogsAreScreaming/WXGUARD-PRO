"""How long each product type stays in the store.

The store used to drop everything after 12 hours. A heat advisory issued at
10 PM for the next afternoon is still in force at noon, so it vanished from
the answers while NWS still had it up (found 2026-09-14 against
api.weather.gov: 4 of 9 Texas heat advisories missing). Warning-class
products now live long enough for their VTEC expiry to be the thing that
retires them; storm reports long enough to filter by report time.

Point forecasts (PFM) went the same way on 2026-10-01: the dish was down
through two issuances, the newest Austin/San Antonio forecast was 34 hours
old, and at 12 hours every forecast in central Texas had been dropped, so
"forecast lockhart TX" answered that there was no forecast point within
80 km. A forecast is issued about every 12 hours and covers a week; it is
now kept through missed issuances, and the text reply says how old it is
(core/render_text.forecast) while the days already past are left out
(core/services.forecast_for).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from meshcore_weather.config import settings

WARNING_TYPES = {
    "TOR", "SVR", "SVS", "SPS", "FFW", "FFS", "FLW", "FLS", "FFA", "FLA",
    "WSW", "NPW", "RFW", "FWW", "MWW", "MWS", "SMW", "DSW", "EWW", "SQW", "CFW",
    "RVA", "WCN", "WOU", "SEL", "HLS", "TCV", "HWO",
    "TSU",   # tsunami messages: in force until further notice
    "AQA",   # air quality alerts: issued the evening before, for the next day
}
WARNING_HOURS = 48
LSR_HOURS = 24
FORECAST_TYPES = {"PFM"}
FORECAST_HOURS = 48


def max_age_hours(product_type: str) -> int:
    if product_type in WARNING_TYPES:
        return max(WARNING_HOURS, settings.emwin_max_age_hours)
    if product_type == "LSR":
        return max(LSR_HOURS, settings.emwin_max_age_hours)
    if product_type in FORECAST_TYPES:
        return max(FORECAST_HOURS, settings.emwin_max_age_hours)
    return settings.emwin_max_age_hours


def longest_hours() -> int:
    return max(WARNING_HOURS, LSR_HOURS, FORECAST_HOURS, settings.emwin_max_age_hours)


def is_expired(product_type: str, received: datetime, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    return received < now - timedelta(hours=max_age_hours(product_type))
