"""Extract active warnings from the EMWIN store using pyIEM (canonical NWS parser).

pyIEM (Iowa Environmental Mesonet) is the reference Python implementation for
parsing NWS text products. It handles VTEC (NWSI 10-1703), UGC (NWSI 10-1702),
polygon extraction with correct winding, both Z (zone) and C (county FIPS)
codes, and non-VTEC products like SPS via UGC-line expiry.

We build the UGCProvider from our bundled `geodata/zones.json` at module init
so the parser runs fully offline with no database or network dependency.

Each warning dict carries an `expires_at` (tz-aware datetime). That's the
NWS-authoritative expiry — the source of truth. `expiry_minutes` is a
convenience value (minutes from *now*) recomputed at extraction time.

A hand-rolled fallback path is retained for the edge case where pyIEM cannot
parse a product.
"""

import json
import logging
import re
from datetime import timedelta, datetime, timezone
from pathlib import Path

from pyiem.nws.products import parser as pyiem_parser
from pyiem.nws.ugc import UGC, UGCProvider

from meshcore_weather.core.vtec_names import event_code, long_name
from meshcore_weather.parser.pfm import TZ_ABBR_OFFSET
from meshcore_weather.parser.weather import (
    EMWINProduct,
    WeatherStore,
    _expand_zone_ranges,
    extract_warning_polygon,
)
from meshcore_weather.protocol.coverage import Coverage
from meshcore_weather.protocol.meshwx import (
    PRODUCT_TYPE_MAP,
    SEV_ADVISORY,
    SEV_WARNING,
    VTEC_SEVERITY_MAP,
    WARN_FIRE,
    WARN_FLASH_FLOOD,
    WARN_FLOOD,
    WARN_HIGH_WIND,
    WARN_MARINE,
    WARN_OTHER,
    WARN_SEVERE_TSTORM,
    WARN_SPECIAL,
    WARN_TORNADO,
    WARN_WINTER_STORM,
    pack_warning_polygon,
    pack_warning_zones,
)

logger = logging.getLogger(__name__)


# -- UGCProvider built once from bundled zones.json (fully offline) -----------

_GEODATA = Path(__file__).resolve().parent.parent / "geodata"
_UGC_PROVIDER: UGCProvider | None = None


def _build_ugc_provider() -> UGCProvider:
    """Build pyIEM's UGCProvider from bundled zones.json.

    pyIEM defaults to querying a PostGIS database for UGC metadata; the
    `legacy_dict` kwarg lets us pass a pre-built dict so it runs offline.
    """
    try:
        zones_data = json.loads((_GEODATA / "zones.json").read_text())
    except Exception as exc:  # pragma: no cover
        logger.warning("Could not load zones.json for pyIEM UGCProvider: %s", exc)
        return UGCProvider(legacy_dict={})

    legacy: dict = {}
    for code, z in zones_data.items():
        if len(code) < 6:
            continue
        try:
            legacy[code] = UGC(
                state=z.get("s", ""),
                geoclass=code[2],
                number=int(code[3:]),
                name=z.get("n", ""),
                wfos=[z.get("w", "")] if z.get("w") else [],
            )
        except (ValueError, IndexError):
            continue
    logger.debug("pyIEM UGCProvider initialized with %d zones", len(legacy))
    return UGCProvider(legacy_dict=legacy)


def _get_ugc_provider() -> UGCProvider:
    global _UGC_PROVIDER
    if _UGC_PROVIDER is None:
        _UGC_PROVIDER = _build_ugc_provider()
    return _UGC_PROVIDER


# -- VTEC phenomenon → warning_type nibble ------------------------------------

# VTEC phenomenon codes (NWSI 10-1703) → our 4-bit wire-format warning type.
# Only common ones are distinguished; everything else becomes WARN_OTHER.
VTEC_PHENOMENON_TO_WARN_TYPE: dict[str, int] = {
    # Convective
    "TO": WARN_TORNADO,
    "SV": WARN_SEVERE_TSTORM,
    "SQ": WARN_SEVERE_TSTORM,  # Snow Squall
    "EW": WARN_SEVERE_TSTORM,  # Extreme Wind (tropical)
    # Flood
    "FF": WARN_FLASH_FLOOD,
    "FA": WARN_FLOOD,
    "FL": WARN_FLOOD,
    # Winter
    "WS": WARN_WINTER_STORM,
    "WW": WARN_WINTER_STORM,
    "BZ": WARN_WINTER_STORM,
    "IS": WARN_WINTER_STORM,
    "LE": WARN_WINTER_STORM,
    "ZR": WARN_WINTER_STORM,
    "ZF": WARN_WINTER_STORM,
    "SN": WARN_WINTER_STORM,
    # Wind
    "HW": WARN_HIGH_WIND,
    "WI": WARN_HIGH_WIND,
    # Marine
    "MA": WARN_MARINE,
    "SC": WARN_MARINE,
    "SE": WARN_MARINE,
    "SR": WARN_MARINE,
    "HF": WARN_MARINE,
    "GL": WARN_MARINE,
    "SW": WARN_MARINE,
    # Fire
    "FW": WARN_FIRE,
    # Everything else → WARN_OTHER
}


# -- Product types to inspect for active warnings ----------------------------

_WARNING_PRODUCT_TYPES = {
    # Warnings / watches / statements
    "TOR", "SVR", "SVS", "SPS", "FFW", "FLW", "FLS",
    "FFA",  # Flood Watch (FA.A / FF.A) — missing from the bot in 6 states on 2026-09-14
    "WSW", "NPW", "RFW", "FWW", "MWW", "MWS",
    "SMW", "SWO", "DSW", "EWW", "SQW", "CFW",
    # River products (VTEC-based)
    "RVA",  # River Watch/Warning — flood stage warnings with VTEC
    # Tornado and severe thunderstorm watches. NOTE: "AWW" is the Airport
    # Weather Warning (no VTEC, airport ops only) — not an SPC watch; do not
    # add it.
    "WCN",  # Watch County Notification: each office's counties in a watch
    # Not "WOU", SPC's Watch Outline Update. It carries the same watch under
    # office WNS with every office's counties, so each watch would go out
    # twice; it re-sends shrinking county lists as CON without clearing the
    # counties it drops, and ends the watch with state-wide codes (DCZ000) a
    # per-zone replay cannot apply, so a WNS event would outlive the watch.
    # The WCNs are what NWS (api.weather.gov) lists, county by county; on 14
    # and 16 Oct 2026 the dish's WCNs named every county the WOUs did.
    # Hurricane products (VTEC-based)
    "HLS",  # Hurricane Local Statement (VTEC in the Pacific; Guam's typhoon warnings)
    # Since 2015 the Atlantic and Gulf HLS carries no VTEC: the Tropical
    # Cyclone VTEC product (TCV) is the one that names, zone by zone, the
    # hurricane, tropical storm and storm surge watches and warnings. Where
    # an office's HLS does carry VTEC it is the same event (same ETN), which
    # the lifecycle replay merges, so nothing is counted twice.
    "TCV",
    # Flash Flood Statement: the CON / CAN / EXP updates to a Flash Flood
    # Warning (same office, same ETN). Without it an FFS that cancelled a
    # warning, or cut it to part of its area, was never applied, and the
    # warning stayed active to its original end (LUB and MAF, 2026-10-14).
    "FFS",
    "TSU",  # Tsunami warnings, advisories and watches (NTWC / PTWC, VTEC)
    "AQA",  # Air Quality Alert: no VTEC, ends at its UGC expiry
}

# SPS and AQA products don't carry VTEC; they get the WARN_SPECIAL type and
# advisory-level severity by default.
_NON_VTEC_TYPES = {"SPS", "AQA"}

# The name a reply uses for a product without VTEC (SPS keeps the generic
# "Special Wx Stmt"). The wire has no event code for these and sends the SPS
# one (vtec_names: the event table is append-only and shared with every app).
_NON_VTEC_NAMES = {"AQA": "AIR QUALITY ALERT"}

# Non-VTEC products whose newer issuance replaces the older one for the
# same area: an Air Quality Alert reissued for the same zones is the same
# alert, not a second one.
_SUPERSEDING_NON_VTEC = {"AQA"}
_ENDED_RE = re.compile(r"\b(CANCEL|EXPIRED|HAS ENDED|NO LONGER IN EFFECT)", re.IGNORECASE)


# -- Cancellation actions (VTEC significance) --------------------------------

_CANCEL_ACTIONS = {"CAN", "EXP", "UPG"}


def _vtec_key(vtec) -> tuple:
    """Identity of a VTEC event: what dedup and retirement key on."""
    return (vtec.phenomena, vtec.significance, vtec.office, vtec.etn)


# -- Headline shortening for LoRa display ------------------------------------


def _shorten_headline(h: str) -> str:
    """Compact a raw NWS headline for LoRa display.

    Replaces verbose templates with abbreviations. Does NOT truncate to a byte
    limit — that's done later at pack time with word-boundary awareness.
    """
    if not h:
        return "Active warning"
    if any(j in h.lower() for j in ("www.", "http", "graphic product")):
        return "Active warning"
    h = h.strip().rstrip(".")
    for prefix in ("A ", "AN "):
        if h.startswith(prefix):
            h = h[len(prefix):]
    h = (h.replace("REMAINS IN EFFECT UNTIL ", "til ")
          .replace("IN EFFECT UNTIL ", "til ")
          .replace("REMAINS IN EFFECT", "")
          .replace("IN EFFECT ", "")
          .replace("WILL IMPACT", "for")
          .replace("UNTIL ", "til ")
          .replace("THROUGH ", "thru ")
          .replace("THIS EVENING", "eve")
          .replace("THIS AFTERNOON", "aft")
          .replace("THIS MORNING", "morn"))
    return re.sub(r"  +", " ", h).strip()


def _extract_headline_from_body(text: str) -> str:
    """Extract a headline from the ...TEXT... block when pyIEM has no headline.

    Looks for lines wrapped in triple-dots like:
      ...RED FLAG WARNING REMAINS IN EFFECT FROM NOON TO 8 PM CDT...
    A headline that wraps is read to its closing dots ("...FLASH FLOOD
    WARNING REMAINS IN EFFECT UNTIL 715 PM CDT THIS" / "EVENING FOR ...
    COUNTIES...", LUB's FFS of 2026-10-14, which pyIEM did not read), not
    cut at the end of its first line.
    """
    lines = text.splitlines()
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("...") and len(s) > 10:
            parts = [s]
            for nxt in lines[i + 1:i + 5]:
                if parts[-1].endswith("...") or not nxt.strip():
                    break
                parts.append(nxt.strip())
            clean = " ".join(parts).strip(".").strip()
            if clean and not any(x in clean.lower() for x in ("www.", "http")):
                return clean
    return ""


def _vtec_headline(vtec, parsed, end: datetime | None, until_further_notice: bool) -> str:
    """'Tornado Watch 600 until 6:59 PM CDT', from the VTEC line and the event
    name, for a product with no headline of its own. The time is in the
    product's own zone (its header's abbreviation), with the day when that is
    not the day of issue; the number only for an SPC watch, which people know
    by it. Empty for an event the name table does not know."""
    name = long_name(vtec.phenomena, vtec.significance)
    if not name or "." in name:
        return ""
    if vtec.significance == "A" and vtec.phenomena in ("TO", "SV") and vtec.etn:
        name = f"{name} {int(vtec.etn)}"
    if until_further_notice:
        return f"{name} until further notice"
    if end is None:
        return name
    abbr = str(getattr(parsed, "z", "") or "").upper()
    offset = TZ_ABBR_OFFSET.get(abbr)
    if offset is None:
        abbr, offset = "UTC", 0
    local = end + timedelta(hours=offset)
    clock = f"{local.hour % 12 or 12}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}"
    out = f"{name} until {clock} {'ChST' if abbr == 'CHST' else abbr}"
    issued = getattr(parsed, "valid", None)
    if isinstance(issued, datetime) and (issued + timedelta(hours=offset)).date() != local.date():
        out += f" {local:%a}"
    return out


def _extract_warning_description(text: str) -> str:
    """Extract structured detail from a warning product.

    Pulls the bullet-point lines like:
      * Timing...12 PM CDT through 8 PM CDT Monday.
      * Wind...Southwest at 20 to 30 mph with gusts to 40 mph.
      * Humidity...As low as 12 percent.

    Also grabs WHAT/WHERE/WHEN/IMPACTS blocks from newer NWS format.
    Returns a compact multiline string, whole.

    It used to be cut at 500 characters, a v4 limit, which is where a Flood
    Watch's text stopped at "WHEN: From" on the phone. The one reader is the
    `>wt` reply, and `text_messages` fits that to the eight packets a reply
    may take, at a sentence, and flags the cut when it has to make one
    (spec 8). Two limits, the tighter one silent, is how a phone came to
    show a truncated warning as if it were whole.
    """
    lines: list[str] = []
    in_bullets = False

    for line in text.splitlines():
        s = line.strip()

        # Bullet-point lines: "* Wind...Southwest 20-30 mph"
        if s.startswith("* "):
            in_bullets = True
            # Clean up: "* Wind...text" → "Wind: text"
            content = s[2:]
            if "..." in content:
                label, _, detail = content.partition("...")
                content = f"{label.strip()}: {detail.strip()}"
            lines.append(content)
            continue

        # Continuation of a bullet (indented)
        if in_bullets and s and not s.startswith("*") and not s.startswith("PRECAUTIONARY"):
            if s.startswith("&&") or s.startswith("$$"):
                break
            # Append to previous line
            if lines:
                lines[-1] += " " + s
            continue

        # WHAT/WHERE/WHEN/IMPACTS blocks (newer NWS format)
        for tag in ("WHAT", "WHERE", "WHEN", "IMPACTS", "ADDITIONAL DETAILS"):
            if s.startswith(tag + "..."):
                content = s[len(tag) + 3:].strip()
                lines.append(f"{tag.title()}: {content}")
                in_bullets = True
                break

        if s.startswith("PRECAUTIONARY") or s.startswith("&&"):
            break

    return "\n".join(lines)


def _polygon_from_sbw(sbw) -> list[tuple[float, float]]:
    """Convert a pyIEM/Shapely polygon to (lat, lon) vertex list.

    Shapely stores coordinates as (lon, lat); our MeshWX protocol wants
    (lat, lon). Drops the closing vertex (first == last).
    """
    if sbw is None or sbw.geom_type != "Polygon":
        return []
    coords = list(sbw.exterior.coords)
    if len(coords) >= 2 and coords[0] == coords[-1]:
        coords = coords[:-1]
    return [(lat, lon) for lon, lat in coords]


# -- pyIEM-backed extraction --------------------------------------------------


_parsed_cache: dict[str, object] = {}
_PARSE_FAILED = object()


def _extract_warnings_pyiem(store: WeatherStore, now: datetime | None = None) -> list[dict]:
    """Every active warning, from a replay of all warning-class products.

    VTEC products go through `VtecTracker` (per-zone lifecycle, products in
    issue order); the entry for an active event is built from the newest
    segment that carried it, with the tracker's zone set and expiry.
    Non-VTEC products (SPS) are one entry per segment, newest product wins.
    """
    from meshcore_weather.protocol.vtec_events import VtecTracker

    provider = _get_ugc_provider()
    now = now or datetime.now(timezone.utc)

    products = list(store._products.values())      # snapshot: the warm-up runs off-loop
    live = {p.filename for p in products if p.product_type in _WARNING_PRODUCT_TYPES}
    for stale in [k for k in _parsed_cache if k not in live]:
        del _parsed_cache[stale]

    parsed_items: list[tuple] = []
    failed: list[EMWINProduct] = []
    for prod in products:
        if prod.product_type not in _WARNING_PRODUCT_TYPES:
            continue
        parsed = _parsed_cache.get(prod.filename)
        if parsed is None:
            try:
                parsed = pyiem_parser(prod.raw_text, ugc_provider=provider)
            except Exception as exc:  # pyIEM can raise on malformed input
                # Once per product (the cache remembers the failure), at a
                # level that is read: a dropped warning used to leave no trace
                # above DEBUG.
                logger.warning("pyIEM parse failed for %s: %s", prod.filename, exc)
                parsed = _PARSE_FAILED
            _parsed_cache[prod.filename] = parsed
        if parsed is _PARSE_FAILED:
            failed.append(prod)
            continue
        parsed_items.append((parsed, prod))

    results: list[dict] = []

    # -- Products pyIEM rejected: the regex extractor, one product at a time --
    # At least the headline, zones and VTEC expiry survive, so the warning is
    # broadcast rather than silently missing. The fallback knows nothing of
    # the lifecycle, so a later CAN for the same event is only honoured when
    # it, too, is in a product pyIEM rejected (`_is_cancelled` reads the
    # product's own VTEC action).
    for prod in failed:
        try:
            entry = _fallback_entry(store, prod, now)
        except Exception as exc:  # noqa: BLE001 - one unreadable product must not cost the rest
            logger.warning("Fallback extraction failed for %s too: %s", prod.filename, exc)
            continue
        if entry is not None:
            results.append(entry)

    # -- VTEC events: replay the lifecycle -----------------------------------
    tracker = VtecTracker()
    tracker.replay(parsed_items, until=now)
    for ev in tracker.active(now):
        entry = _segment_to_entry(ev.last_seg, ev.last_parsed, ev.last_prod, now,
                                  vtec=ev.last_vtec, vtec_index=ev.last_vtec_index,
                                  tracker_state=ev)
        if entry is None:
            continue
        del entry["_dedup_key"]
        results.append(entry)

    # -- Non-VTEC (SPS, AQA): newest product per (office, type, valid) --------
    # An AQA reissued for an area replaces the older one there (and one that
    # says the alert has ended clears it), so a place never hears of two.
    seen: set[tuple] = set()
    claimed: dict[tuple, set[str]] = {}
    newest_first = sorted(parsed_items, reverse=True,
                          key=lambda x: (getattr(x[0], "valid", None) or x[1].timestamp, x[1].timestamp))
    for parsed, prod in newest_first:
        if prod.product_type not in _NON_VTEC_TYPES:
            continue
        for seg in parsed.segments:
            if seg.vtec:
                continue
            only: set[str] | None = None
            if prod.product_type in _SUPERSEDING_NON_VTEC:
                ugcs = {str(u) for u in seg.ugcs}
                done = claimed.setdefault((prod.office, prod.product_type), set())
                only = ugcs - done
                done |= ugcs
                if not only or _ENDED_RE.search(" ".join(seg.headlines or [])):
                    continue
            entry = _segment_to_entry(seg, parsed, prod, now, only_ugcs=only)
            if entry is None or entry["_dedup_key"] in seen:
                continue
            seen.add(entry["_dedup_key"])
            del entry["_dedup_key"]
            results.append(entry)
    return results


def _segment_to_entry(
    seg, parsed, prod, now: datetime, vtec=None, vtec_index: int = 0, tracker_state=None,
    only_ugcs: set[str] | None = None,
) -> dict | None:
    """Convert one VTEC event of a pyIEM product segment to a warning dict.

    `vtec` selects which of the segment's VTEC lines this entry describes
    (segments can carry more than one); None means "the first one", or the
    non-VTEC path for products like SPS. `vtec_index` picks the matching
    headline when the segment has one headline per event. `only_ugcs` keeps
    a non-VTEC segment to the part of its area no newer issuance covers.

    Returns None if the event should be skipped (cancelled, expired, no
    extractable data, etc.).
    """
    ugcs = [str(u) for u in seg.ugcs]
    if only_ugcs is not None:
        ugcs = [u for u in ugcs if u in only_ugcs]
    if tracker_state is not None:
        # The event's current zones and times come from the lifecycle replay,
        # not from this one segment.
        ugcs = sorted(tracker_state.active_zones(now))
    # The area is the UGC list, zones (TXZ192) and counties (TXC453) alike.
    # A watch (WCN) names counties only and has no polygon; requiring a
    # polygon or a zone here dropped every tornado and severe thunderstorm
    # watch before anything downstream saw it.
    if not ugcs:
        return None

    # -- VTEC path (most warnings: TOR, SVR, SVS, FFW, WSW, etc.) --
    expires_estimated = False
    until_further_notice = False
    event_name = None
    if seg.vtec:
        if vtec is None:
            vtec = seg.vtec[0]
        if tracker_state is not None:
            expires_at = tracker_state.expires_at(now)
            if expires_at is None:
                # Until further notice (VTEC end 000000T0000Z). Replies say
                # so; the wire needs a finite time and gets the one the bot
                # keeps the event to without a new statement (its UGC expiry
                # plus vtec_events.UFN_GRACE), flagged as invented. It moves
                # only when a statement arrives; "now + 12 h" moved with the
                # clock, and so re-sent the warning every 30 minutes (spec 3).
                until_further_notice = tracker_state.until_further_notice(now)
                expires_at = tracker_state.kept_until(now) or now + timedelta(hours=12)
                expires_estimated = True
            onset_at = tracker_state.onset_at(now)
        else:
            if vtec.action in _CANCEL_ACTIONS:
                return None
            expires_at = vtec.endts
            if expires_at is None:
                # Very rare: VTEC without end time. Fall back to UGC expiry.
                expires_at = getattr(seg, "ugcexpire", None)
            if expires_at is None:
                return None
            if expires_at <= now:
                return None  # already expired
            onset_at = vtec.begints  # when the warning becomes active
        wtype = VTEC_PHENOMENON_TO_WARN_TYPE.get(vtec.phenomena, WARN_OTHER)
        severity = VTEC_SEVERITY_MAP.get(vtec.significance, SEV_WARNING)
        dedup_key = (vtec.phenomena, vtec.significance, vtec.office, vtec.etn)
        vtec_meta = {
            "vtec_action": vtec.action,
            "vtec_phenomenon": vtec.phenomena,
            "vtec_significance": vtec.significance,
            "vtec_office": vtec.office,
            "vtec_etn": vtec.etn,
        }
        event = event_code(vtec.phenomena, vtec.significance)
    # -- Non-VTEC path (SPS, rare others) --
    elif prod.product_type in _NON_VTEC_TYPES:
        expires_at = getattr(seg, "ugcexpire", None)
        if expires_at is None or expires_at <= now:
            return None

        onset_at = parsed.valid  # effective immediately for non-VTEC
        wtype = WARN_SPECIAL
        severity = SEV_ADVISORY
        # Dedup by (office, type, valid time) — SPS doesn't have ETNs.
        dedup_key = (prod.office, prod.product_type, parsed.valid)
        vtec_meta = {
            "vtec_action": None,
            "vtec_phenomenon": None,
            "vtec_significance": None,
            "vtec_office": prod.office,
            "vtec_etn": None,
        }
        event = event_code(None, None)   # SPS (the wire's one non-VTEC event)
        event_name = _NON_VTEC_NAMES.get(prod.product_type)
    else:
        return None

    # Polygon, and the zones among the UGCs (`ugcs` keeps the counties too)
    vertices = _polygon_from_sbw(seg.sbw)
    zones = [u for u in ugcs if len(u) == 6 and u[2] == "Z"]

    # Headline: prefer pyIEM's canonical ...HEADLINE... block.
    # Fall back to extracting ...TEXT... from the raw product if empty.
    headlines = list(seg.headlines) if seg.headlines else []
    if len(headlines) > vtec_index:
        headline_raw = headlines[vtec_index]
    else:
        headline_raw = headlines[0] if headlines else ""
    if not headline_raw:
        # This segment's own headline first: in a product of several
        # segments the first one in the text may be another area's.
        headline_raw = (_extract_headline_from_body(getattr(seg, "unixtext", "") or "")
                        or _extract_headline_from_body(prod.raw_text))
    if not headline_raw and seg.vtec:
        # A watch county notification (WCN) or a TCV has no ...HEADLINE...:
        # say what it is from the VTEC line rather than "Active warning",
        # which was all `>wt` returned for a tornado watch.
        headline_raw = _vtec_headline(vtec, parsed, None if expires_estimated else expires_at,
                                      until_further_notice)
    headline = _shorten_headline(headline_raw)

    # Description: structured detail lines (Wind, Humidity, Timing, Impacts)
    description = _extract_warning_description(prod.raw_text)

    expiry_minutes = max(0, int((expires_at - now).total_seconds() / 60))

    onset_unix_min = int(onset_at.timestamp() / 60) if onset_at else 0

    # When the product said it was issued, from its own header (pyIEM's
    # `valid`), never when the bot received the file: the phone shows this as
    # "issued 8:24 PM" and a radio that was out of range for three hours must
    # not turn that into the time it finally heard the warning. The lifecycle
    # replay keeps the NEW segment's time for the identity, so a continuation
    # (SVS) does not restamp a warning as newly issued.
    issued_at = getattr(tracker_state, "issued_at", None) if tracker_state is not None else None
    if issued_at is None:
        issued_at = getattr(parsed, "valid", None)

    entry = {
        # Storm-based warning tags (pyIEM reads them from the product text):
        # the actionable numbers of a severe or flash flood warning.
        **_segment_tags(seg),
        # Wire-format fields (consumed by warnings_to_binary)
        "warning_type": wtype,
        "severity": severity,
        "event_code": event,
        "onset_at": onset_at,          # when the warning becomes active (None = immediate)
        "onset_unix_min": onset_unix_min,
        "issued_at": issued_at,        # the product's own issuance (spec 3, revision 5)
        "expires_at": expires_at,      # canonical absolute expiry (NWS-authoritative)
        "expires_estimated": expires_estimated,  # invented (until further notice): not NWS's time
        "until_further_notice": until_further_notice,  # VTEC end 000000T0000Z: replies say so, not a time
        "event_name": event_name,      # a reply's name for a non-VTEC product (AQA); None = from the VTEC
        "expiry_minutes": expiry_minutes,  # convenience — minutes from "now"
        "vertices": vertices,
        "headline": headline,
        "description": description,
        "zones": sorted(zones),
        # Extended metadata
        "ugcs": sorted(ugcs),
        "product_type": prod.product_type,
        "filename": prod.filename,
        # How the bot got the product this warning was read out of, for the
        # wire's source field (spec 2.3, revision 7).
        "source": getattr(prod, "source", ""),
        "_dedup_key": dedup_key,
        **vtec_meta,
    }
    return entry


# -- Hand-rolled fallback (legacy path) ---------------------------------------


def _parse_vtec_end_datetime(end_str: str) -> datetime | None:
    """Parse a VTEC end string 'YYMMDDTHHMMZ' (12 chars) into a UTC datetime.

    The pre-existing `_vtec_end_to_minutes` was fundamentally broken: it was
    treating the first 6 chars as DDHHMM, when the actual captured group is
    the full 12-char `YYMMDDTHHMMZ`. That's what caused the "363h" display bug.
    """
    try:
        # Format: YYMMDDTHHMMZ  e.g. "260411T0100Z"
        if len(end_str) < 12 or end_str[6] != "T":
            return None
        year = 2000 + int(end_str[0:2])
        month = int(end_str[2:4])
        day = int(end_str[4:6])
        hour = int(end_str[7:9])
        minute = int(end_str[9:11])
        return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    except (ValueError, IndexError):
        return None


def _extract_warnings_fallback(store: WeatherStore) -> list[dict]:
    """Legacy hand-rolled extraction. Only used if pyIEM parsing crashes globally."""
    now = datetime.now(timezone.utc)
    results: list[dict] = []
    seen: set[str] = set()

    for prod in sorted(store._products.values(), key=lambda p: p.timestamp, reverse=True):
        if prod.product_type not in _WARNING_PRODUCT_TYPES:
            continue
        key = f"{prod.product_type}_{prod.orig}"
        if key in seen:
            continue
        seen.add(key)
        entry = _fallback_entry(store, prod, now)
        if entry is not None:
            results.append(entry)
    return results


def _fallback_entry(store: WeatherStore, prod: EMWINProduct, now: datetime) -> dict | None:
    """One product's warning by regex alone: the first VTEC line, the UGC
    zones and counties, the polygon and the headline. None when the product
    is cancelled, expired, or names no area. Used for every product when
    pyIEM crashes outright, and for the one product pyIEM refuses to parse."""
    from meshcore_weather.parser.weather import parse_vtec  # local import to avoid cycles

    if store._is_cancelled(prod.raw_text):
        return None

    vertices = extract_warning_polygon(prod.raw_text)
    ugcs = _expand_zone_ranges(prod.raw_text)      # zones and counties
    zones = {u for u in ugcs if u[2] == "Z"}
    if len(vertices) < 3 and not ugcs:
        return None

    wtype = PRODUCT_TYPE_MAP.get(prod.product_type, WARN_OTHER)
    vtec = parse_vtec(prod.raw_text)
    expires_at: datetime | None = None
    if vtec:
        severity = VTEC_SEVERITY_MAP.get(vtec["significance"], SEV_WARNING)
        expires_at = _parse_vtec_end_datetime(vtec["end"])
    else:
        severity = SEV_WARNING

    expires_estimated = expires_at is None
    if expires_at is None:
        # Last-resort default: 2 hours from now. Only applied in the
        # fallback path for products with no VTEC.
        expires_at = now.replace(second=0, microsecond=0)
        expires_at = expires_at.replace(hour=(expires_at.hour + 2) % 24)

    if expires_at <= now:
        return None  # expired

    expiry_minutes = max(0, int((expires_at - now).total_seconds() / 60))

    # Fallback path has no VTEC onset; assume effective immediately
    onset_at = now

    return {
        "warning_type": wtype,
        "severity": severity,
        "onset_at": onset_at,
        "onset_unix_min": int(onset_at.timestamp() / 60),
        # No parsed product header on this path, and the filename's time is
        # when the bot received the file, not when NWS issued it: say
        # nothing rather than something wrong (spec 3, revision 5).
        "issued_at": None,
        "expires_at": expires_at,
        "expires_estimated": expires_estimated,
        "expiry_minutes": expiry_minutes,
        "vertices": vertices,
        # (`store._short_headline` was called here, and never existed: the
        # global fallback had been crashing on its first product.)
        "headline": _shorten_headline(_extract_headline_from_body(prod.raw_text)),
        "description": _extract_warning_description(prod.raw_text),
        "zones": sorted(zones),
        "ugcs": sorted(ugcs),
        "product_type": prod.product_type,
        "filename": prod.filename,
        "source": getattr(prod, "source", ""),
        "vtec_action": (vtec or {}).get("action"),
        "vtec_phenomenon": (vtec or {}).get("phenomenon"),
        "vtec_significance": (vtec or {}).get("significance"),
        "vtec_office": None,
        "vtec_etn": None,
    }


# -- Public API ---------------------------------------------------------------


def _segment_tags(seg) -> dict:
    """hail (quarter inches), wind (mph), tornado / flood tags as v5 codes."""
    out = {"hail_qin": 0, "wind_mph": 0, "tornado_tag": 0, "flood_source": 0, "flood_damage": 0}
    try:
        hail = getattr(seg, "hailtag", None)
        if hail:
            out["hail_qin"] = max(0, min(255, int(round(float(hail) * 4))))
        wind = getattr(seg, "windtag", None)
        if wind:
            mph = float(wind)
            if str(getattr(seg, "windtagunits", "") or "").upper().startswith("KT"):
                mph *= 1.15078
            out["wind_mph"] = max(0, min(255, int(round(mph))))
        tor = str(getattr(seg, "tornadotag", "") or "").upper()
        if "OBSERVED" in tor or "EMERGENCY" in tor:
            out["tornado_tag"] = 3
        elif "RADAR" in tor:
            out["tornado_tag"] = 2
        elif "POSSIBLE" in tor:
            out["tornado_tag"] = 1
        tags = getattr(seg, "flood_tags", None) or {}
        for key, val in dict(tags).items():
            k, v = str(key).upper(), str(val).upper()
            if "DAMAGE" in k:
                out["flood_damage"] = 2 if "CATASTROPHIC" in v else 1 if "CONSIDERABLE" in v else 0
            elif "FLOOD" in k and "DAMAGE" not in k:
                out["flood_source"] = 3 if "OBSERVED" in v else 2 if "GAUGE" in v else 1 if "RADAR" in v else 0
        dmg = str(getattr(seg, "damagetag", "") or "").upper()
        if dmg and not out["flood_damage"] and ("CONSIDERABLE" in dmg or "CATASTROPHIC" in dmg or "DESTRUCTIVE" in dmg):
            out["flood_damage"] = 2 if ("CATASTROPHIC" in dmg or "DESTRUCTIVE" in dmg) else 1
    except Exception:          # tags are a bonus, never a reason to drop a warning
        pass
    return out


def extract_active_warnings(
    store: WeatherStore,
    coverage: Coverage | None = None,
    now: datetime | None = None,
) -> list[dict]:
    """Extract all active warnings from the store.

    Uses pyIEM as the primary parser. Falls back to the hand-rolled extractor
    only if pyIEM crashes globally.

    Each returned dict includes `expires_at` (tz-aware datetime) as the
    NWS-authoritative expiry source of truth, and `expiry_minutes` as a
    convenience recomputed at extraction time.
    """
    try:
        raw = _extract_warnings_pyiem(store, now)
    except Exception as exc:
        logger.warning("pyIEM warning extraction crashed; falling back: %s", exc)
        raw = _extract_warnings_fallback(store)

    filter_active = coverage is not None and not coverage.is_empty()
    results: list[dict] = []
    for w in raw:
        if filter_active and not _in_coverage(w, coverage):
            continue
        results.append(w)

    return results


def _in_coverage(w: dict, coverage: Coverage) -> bool:
    """A warning is in coverage when its area touches it. A storm-based
    warning's area is its polygon: the counties on its UGC line are only the
    ones the polygon touches, so they do not count on their own (its zones
    still do). A product without a polygon is its zones and counties: a
    tornado watch for Travis County is in an Austin bot's coverage."""
    ugcs = w.get("ugcs") or w.get("zones", [])
    has_polygon = len(w.get("vertices") or []) >= 3
    if ugcs and coverage.covers_any(ugcs, by_county=not has_polygon):
        return True
    return has_polygon and coverage.covers_polygon(w["vertices"])


def warnings_to_binary(warnings: list[dict], prefer_zones: bool = True) -> list[bytes]:
    """Pack a list of warning dicts into MeshWX binary messages.

    Each warning produces:
      1. A 0x20 (polygon) or 0x21 (zones) message with headline
      2. Optionally, 0x40 text chunk(s) with the detailed description
         (wind speeds, humidity, impacts, etc.)
    """
    msgs: list[bytes] = []
    for w in warnings:
        try:
            expires_at: datetime | None = w.get("expires_at")
            if expires_at is None:
                logger.debug("skip warning without expires_at: %s", w.get("headline", "?")[:40])
                continue
            expires_unix_min = int(expires_at.timestamp() / 60)

            onset_unix_min = w.get("onset_unix_min", 0)
            zones = w.get("zones", [])
            if prefer_zones and zones:
                msg = pack_warning_zones(
                    event=w.get("event_code", 0),
                    expires_unix_min=expires_unix_min,
                    zones=zones,
                    headline=w["headline"],
                    onset_unix_min=onset_unix_min,
                )
            elif w.get("vertices"):
                msg = pack_warning_polygon(
                    event=w.get("event_code", 0),
                    expires_unix_min=expires_unix_min,
                    vertices=w["vertices"],
                    headline=w["headline"],
                    onset_unix_min=onset_unix_min,
                )
            else:
                continue
            msgs.append(msg)
        except Exception:
            logger.debug("Failed to pack warning: %s", w.get("headline", "?")[:40])
    return msgs
