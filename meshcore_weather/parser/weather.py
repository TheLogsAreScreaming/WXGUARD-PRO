"""Parse EMWIN weather products following the Vitality GOES approach.

Products are matched by their EMWIN 8-character identifier:
    chars 0-2: product type (ZFP, RWR, SVR, etc.)
    chars 3-5: NWS office code (EWX, MFL, BUF, etc.)
    chars 6-7: state abbreviation (TX, FL, NY, etc.)

For a location like "Austin TX", we resolve to:
    orig = "EWXTX" (office EWX + state TX)
    wxZone = "TXZ192"
    city = "AUSTIN"
    lat/lon for geofencing

Then find EMWIN products: ZFP+EWXTX, RWR+EWXTX, PFM+EWXTX, etc.
"""

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from meshcore_weather.geodata import resolver
from meshcore_weather.protocol import v5

logger = logging.getLogger(__name__)

#: EMWIN source name -> v5 source constant (spec 2.3, revision 7).
_V5_SOURCE = {"sdr": v5.SOURCE_GOES, "internet": v5.SOURCE_INTERNET}

# One token of a UGC line, between the dashes: "TXZ171", "TXZ171>173", or a
# bare "183>194" that takes its state and kind from the token before it.
_UGC_TOKEN_RE = re.compile(r"(?:([A-Z]{2}[ZC]))?(\d{3})(?:>(\d{3}))?")
# The line ends with the expiry, "-170100-": six digits that are a time, not
# two zones.
_UGC_EXPIRY_RE = re.compile(r"\d{6}")


def _expand_zone_ranges(text: str) -> set[str]:
    """Expand NWS UGC notation like 'TXZ021>044' into individual zones.

    Searches the first 25 lines of text for zone and county codes. A UGC line
    names the state and kind once and then runs on in bare numbers and
    ranges ("TXZ171>173-183>194-202>209-217>225-228-170100-"), so the prefix
    carries from token to token until a new one is named or the line ends in
    its expiry. Only the first range used to be expanded, which left Travis
    County (TXZ192, inside "183>194") out of every compact wind advisory.
    """
    zones: set[str] = set()
    prefix: str | None = None
    for line in text.splitlines()[:25]:
        s = line.strip()
        if not s:
            prefix = None
            continue
        # A line wrapped after a dash continues the one before it, so the
        # prefix is kept; anything that is not a UGC token ends the run.
        for token in s.split("-"):
            if not token:
                continue
            if _UGC_EXPIRY_RE.fullmatch(token):
                prefix = None
                break
            m = _UGC_TOKEN_RE.fullmatch(token)
            if not m:
                prefix = None
                continue
            if m.group(1):
                prefix = m.group(1)
            if prefix is None:
                continue
            start = int(m.group(2))
            end = int(m.group(3)) if m.group(3) else start
            for n in range(start, end + 1):
                zones.add(f"{prefix}{n:03d}")
    return zones


def extract_warning_polygon(text: str) -> list[tuple[float, float]]:
    """Extract LAT...LON polygon vertices from an NWS warning product."""
    coords: list[tuple[float, float]] = []
    in_polygon = False
    for line in text.splitlines():
        stripped = line.strip()
        if "LAT...LON" in stripped:
            in_polygon = True
            nums = re.findall(r"\d{4,5}", stripped.split("LAT...LON")[-1])
            for j in range(0, len(nums) - 1, 2):
                try:
                    coords.append((int(nums[j]) / 100, -(int(nums[j + 1]) / 100)))
                except (ValueError, IndexError):
                    pass
            continue
        if in_polygon:
            if not stripped or stripped.startswith("TIME") or stripped.startswith("$$"):
                break
            nums = re.findall(r"\d{4,5}", stripped)
            for j in range(0, len(nums) - 1, 2):
                try:
                    coords.append((int(nums[j]) / 100, -(int(nums[j + 1]) / 100)))
                except (ValueError, IndexError):
                    pass
    return coords


def parse_vtec(text: str) -> dict | None:
    """Parse VTEC line from an NWS warning product.

    Returns dict with action, phenomenon, significance, and end time,
    or None if no VTEC line found.
    """
    for line in text.splitlines()[:30]:
        s = line.strip()
        m = re.match(
            r"/O\.(\w+)\.\w{4}\.(\w{2})\.(\w)\.\d{4}\.\d{6}T\d{4}Z-(\d{6}T\d{4}Z)/",
            s,
        )
        if m:
            return {
                "action": m.group(1),
                "phenomenon": m.group(2),
                "significance": m.group(3),
                "end": m.group(4),
            }
    return None


# EMWIN 8-char identifier regex from filename
# e.g. A_FPUS54KOUN072238_C_KWIN_20260407222840_123456-2-ZFPOUNOK.TXT
#                                                          ^^^^^^^^
EMWIN_ID_RE = re.compile(r"-([A-Z0-9]{8})\.TXT$", re.IGNORECASE)

# The first line of a METAR in a collective: a four-character station (digits
# allowed: KT82, K11R), an optional COR, then the DDHHMMZ time group. The same
# shape encoders.metar_observed_at reads the time from.
_METAR_LINE_RE = re.compile(r"^[A-Z0-9]{4}\s+(?:COR\s+)?\d{6}Z")

# Timestamp from EMWIN filename (5th underscore-delimited field)
EMWIN_TS_RE = re.compile(r"_(\d{14})_")


@dataclass
class EMWINProduct:
    """A parsed EMWIN product with metadata from its filename."""
    filename: str
    emwin_id: str       # 8-char identifier e.g. "ZFPEWXTX"
    product_type: str   # first 3 chars e.g. "ZFP"
    orig: str           # last 5 chars e.g. "EWXTX"
    office: str         # chars 3-5 e.g. "EWX"
    state: str          # chars 6-7 e.g. "TX"
    timestamp: datetime
    raw_text: str
    # How the bot got this product: "sdr" off its own GOES dish, "internet"
    # from NOAA, "" when the source did not say (spec 2.3, revision 7).
    source: str = ""


class WeatherStore:
    """EMWIN product store using Vitality GOES-style filename matching."""

    def __init__(self):
        self._products: dict[str, EMWINProduct] = {}  # keyed by filename

    def ingest(self, raw_products: list[dict], log: bool = True) -> int:
        """Parse products into the store; returns how many were new. `log` is
        off when the caller ingests in chunks (main.WeatherBot._ingest) and
        says the total itself."""
        count = known = 0
        for raw in raw_products:
            # The sources hand back their whole cache every poll, so this
            # used to re-parse ~14k products a minute on the event loop and
            # stall everything sharing the thread, the handler that matches
            # a repeater's echo included. A filename names one product for
            # ever, so one already in the store never needs parsing again.
            name = raw.get("filename")
            if name and name in self._products:
                known += 1
                continue
            prod = self._parse(raw)
            if prod:
                self._products[prod.filename] = prod
                count += 1
        # Expire old products from the store (warnings live longer: see
        # emwin/retention.py)
        from meshcore_weather.emwin.retention import is_expired
        now = datetime.now(timezone.utc)
        before = len(self._products)
        self._products = {
            k: v for k, v in self._products.items()
            if not is_expired(v.product_type, v.timestamp, now)
        }
        expired = before - len(self._products)
        if log:
            logger.info("Ingested %d/%d products%s%s",
                        count, len(raw_products),
                        f", {known} already held" if known else "",
                        f" (expired {expired})" if expired else "")
        return count

    def _parse(self, raw: dict) -> EMWINProduct | None:
        filename = raw.get("filename", "")
        raw_text = raw.get("raw_text", "")

        # Extract 8-char EMWIN identifier from filename
        m = EMWIN_ID_RE.search(filename)
        if not m:
            return None
        emwin_id = m.group(1).upper()
        if len(emwin_id) != 8:
            return None

        product_type = emwin_id[:3]
        orig = emwin_id[3:]
        office = orig[:3]
        state = orig[3:]

        # Extract timestamp from filename
        ts = datetime.now(timezone.utc)
        m_ts = EMWIN_TS_RE.search(filename)
        if m_ts:
            try:
                ts = datetime.strptime(m_ts.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
            except ValueError:
                pass

        return EMWINProduct(
            filename=filename,
            emwin_id=emwin_id,
            product_type=product_type,
            orig=orig,
            office=office,
            state=state,
            timestamp=ts,
            raw_text=raw_text,
            source=str(raw.get("source") or ""),
        )

    # -- Where the products came from (spec 2.3, revision 7) --

    @staticmethod
    def product_source(prod) -> int:
        """One product's origin as a v5 source constant.

        `prod` is an EMWINProduct, or any dict carrying the same `source` key:
        a raw product from a fetcher, or a warning entry, which keeps the
        source of the product it was extracted from.

        A product from a source that did not stamp itself is `unstated`: the
        absence of a claim, never a claim of absence.
        """
        name = prod.get("source") if isinstance(prod, dict) else getattr(prod, "source", "")
        return _V5_SOURCE.get(name or "", v5.SOURCE_UNSTATED)

    def products_source(self, products: "list[EMWINProduct] | None" = None) -> int:
        """The v5 source constant for a set of products, the whole live store
        by default: what every message aggregated from many products says.

        Products that disagree give `mixed`; products that none of them know
        give `unstated`. A product with no stamp is simply not counted, so one
        unstamped file does not turn a dish-fed bot into a mixed one.
        """
        kinds = {
            self.product_source(p)
            for p in (self._products.values() if products is None else products)
        }
        kinds.discard(v5.SOURCE_UNSTATED)
        if not kinds:
            return v5.SOURCE_UNSTATED
        return kinds.pop() if len(kinds) == 1 else v5.SOURCE_MIXED

    # -- Finding products by type + orig --

    def _find(self, product_type: str, orig: str) -> EMWINProduct | None:
        """Find the newest product matching type+orig (e.g. ZFP + EWXTX)."""
        target = (product_type + orig).upper()
        best = None
        for prod in self._products.values():
            if prod.emwin_id == target:
                if best is None or prod.timestamp > best.timestamp:
                    best = prod
        return best

    def _find_any_orig(self, product_type: str, origs: list[str]) -> EMWINProduct | None:
        """Try multiple orig values, return newest match."""
        for orig in origs:
            p = self._find(product_type, orig)
            if p:
                return p
        return None


    # WFO codes that differ between zone database and AWIPS product IDs
    _WFO_AWIPS_ALIASES = {
        "SJU": "JSJ",  # San Juan PR
        "GUM": "GUA",  # Guam
    }

    def _build_origs(self, loc: dict) -> list[str]:
        """Build possible orig values (office+state) from resolver result."""
        origs = []
        state = ""
        name = loc.get("name", "")
        if ", " in name:
            state = name.split(", ")[-1].strip()

        wfos = list(loc.get("wfos", []))
        # Add AWIPS aliases (SJU->JSJ, etc.)
        for wfo in list(wfos):
            alias = self._WFO_AWIPS_ALIASES.get(wfo)
            if alias and alias not in wfos:
                wfos.append(alias)

        for wfo in wfos:
            if state and len(state) == 2:
                orig = f"{wfo}{state}"
                if orig not in origs:
                    origs.append(orig)
            for zone in loc.get("zones", []):
                zone_state = zone[:2]
                orig = f"{wfo}{zone_state}"
                if orig not in origs:
                    origs.append(orig)
        return [o.upper() for o in origs]

    # -- Public API --


    def _parse_rwr_city(self, text: str, city: str) -> str:
        """Extract city conditions from RWR fixed-width table."""
        raw = self._parse_rwr_city_raw(text, city)
        if not raw:
            return ""
        return self._format_rwr_conditions(raw)

    def _parse_rwr_city_raw(self, text: str, city: str) -> str:
        """Like _parse_rwr_city but returns the raw column data, not formatted."""
        if not city:
            return ""
        in_table = False
        for line in text.splitlines():
            stripped = line.strip()
            if "SKY/WX" in stripped and "TMP" in stripped:
                in_table = True
                continue
            if not in_table or not stripped:
                continue
            if stripped.startswith("$$"):
                in_table = False
                continue
            if not stripped.upper().startswith(city):
                continue
            return stripped[len(city):].strip()
        return ""

    def _format_rwr_conditions(self, raw: str) -> str:
        """Format raw RWR condition columns into readable text."""
        parts = raw.split()
        if len(parts) < 4:
            return raw[:100]

        # Merge sky/wx words until we hit a number (temperature)
        sky_parts = []
        temp_idx = 0
        for i, p in enumerate(parts):
            if p.lstrip("-").isdigit():
                temp_idx = i
                break
            sky_parts.append(p)

        sky_map = {
            "SUNNY": "Sunny", "MOSUNNY": "Mostly Sunny", "PTSUNNY": "Partly Sunny",
            "CLEAR": "Clear", "MOCLDY": "Mostly Cloudy", "PTCLDY": "Partly Cloudy",
            "CLOUDY": "Cloudy", "FAIR": "Fair", "HAZE": "Haze", "FOG": "Fog",
        }
        sky_raw = " ".join(sky_parts).upper()
        sky = sky_map.get(sky_raw, " ".join(sky_parts).title())

        # Handle multi-word conditions like "LGT RAIN"
        for phrase, label in [("LGT RAIN", "Lt Rain"), ("HVY RAIN", "Hvy Rain"),
                               ("RAIN", "Rain"), ("SNOW", "Snow"), ("TSTORM", "T-Storm")]:
            if phrase in sky_raw:
                sky = label
                break

        try:
            temp_f = parts[temp_idx]
            pieces = [sky, f"{temp_f}F"]
            # Wind is usually after temp, dewpoint, humidity
            for p in parts[temp_idx + 1:]:
                if re.match(r"^[NESWVRB]+\d+", p) or p == "CALM":
                    pieces.append(f"Wind {p}")
                    break
            return " | ".join(pieces)
        except (IndexError, ValueError):
            return raw[:100]


    def _find_metar_raw(self, station: str) -> tuple[str, datetime] | None:
        """Find the newest raw METAR string for a specific station.

        A collective wraps a long report at about 69 columns and indents the
        rest ("K2G4 170055Z ... OVC060" / "     10/09 A2995 RMK AO2="), so a
        report is every line from the station's up to the one ending in "=",
        joined; the first line alone has no temperature in some 400 reports a
        day. Stations with digits (KT82, K11R, K3T5) and corrected reports
        ("KAUS COR 170153Z") are reports too, the same shapes encoders.py
        reads a time from.
        """
        if not station:
            return None
        head = station + " "
        for prod in sorted(self._products.values(), key=lambda p: p.timestamp, reverse=True):
            if prod.product_type != "SAH" and "METAR" not in prod.raw_text[:200]:
                continue
            lines = prod.raw_text.splitlines()
            for i, line in enumerate(lines):
                stripped = line.strip()
                if not stripped.startswith(head) or not _METAR_LINE_RE.match(stripped):
                    continue
                report = stripped
                # The feed's "\r\r\n" line ends leave a blank line between
                # every two lines, so blanks are skipped; a line that is not
                # indented is the next station.
                for nxt in lines[i + 1:]:
                    if report.endswith("="):
                        break
                    if not nxt.strip():
                        continue
                    if not nxt[:1].isspace():
                        break
                    report += " " + nxt.strip()
                # Products are walked newest first, so the first one holding
                # the station is its newest: no need to read the rest (the
                # NWS METAR feed's files hold thousands of reports each).
                return report.rstrip("="), prod.timestamp
        return None


    def _parse_zfp_zone(self, text: str, zone: str) -> str:
        """Extract forecast for a specific zone from a ZFP product."""
        lines = text.splitlines()
        in_zone = False
        forecast_parts = []

        for line in lines:
            stripped = line.strip()
            if not in_zone:
                # Look for zone code at start of line (e.g. "TXZ192-TXZ193-")
                if zone in stripped and re.match(r"^[A-Z]{2}Z\d{3}", stripped):
                    in_zone = True
                continue

            # End of zone section
            if stripped.startswith("$$") or stripped.startswith("&&"):
                break

            # Forecast periods start with "."
            if stripped.startswith("."):
                period = stripped.lstrip(".").strip()
                forecast_parts.append(period)
                continue

            # Continuation of current period
            if forecast_parts and stripped:
                forecast_parts[-1] += " " + stripped

        if not forecast_parts:
            return ""

        # Return first period (e.g. "TODAY...Sunny with a high of 72.")
        return forecast_parts[0]


    @staticmethod
    def _is_cancelled(text: str) -> bool:
        """Check if a warning product has been cancelled or expired via VTEC."""
        for line in text.splitlines()[:30]:
            s = line.strip()
            if s.startswith("/O."):
                # VTEC action: CAN=cancelled, EXP=expired, UPG=upgraded
                m = re.match(r"/O\.(\w+)\.", s)
                if m and m.group(1) in ("CAN", "EXP", "UPG"):
                    return True
            upper = s.upper()
            if "IS CANCELLED" in upper or "WILL EXPIRE AT" in upper:
                return True
            if "WILL EXPIRE" in upper or "HAS WEAKENED" in upper:
                return True
        return False


