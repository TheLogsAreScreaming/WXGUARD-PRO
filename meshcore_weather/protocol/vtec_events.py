"""VTEC event lifecycle, the way NWS Directive 10-1703 defines it.

Every warning-class product carries one or more segments; each segment names
a set of UGC zones/counties and one or more VTEC lines. The VTEC action says
what the segment does to the event (office, phenomenon, significance, event
number) for those zones:

    NEW  the event starts for these zones            EXT  end time extended
    CON  continues for these zones (re-listed)       EXA  zones added
    CAN  cancelled for these zones only              EXB  zones added + time
    EXP  expired (or about to) for these zones       COR  correction
    UPG  upgraded to another event for these zones   ROU  routine

So an event is a set of zones each with its own end time, and cancellation is
per zone: an SVS that cancels two counties and continues three leaves the
warning active for three. Products are replayed in issue order so the state
is exactly what NWS has published, however the products arrived.

An end time of 000000T0000Z means "until further notice": a river flood
warning, a typhoon warning, a tsunami warning. It used to be read as the
segment's UGC expiry, so the reply said "til 9:30AM" for a warning NWS said
had no end, and the event was dropped at that time even though no statement
had ended it (2026-10-17: the Satilla River flood warning, Guam's typhoon
warning). Such a zone is now kept as until-further-notice for up to
`UFN_GRACE` past its segment's UGC expiry, the time by which NWS will have
issued the next statement; a CAN or EXP ends it sooner, as for any event.

The earlier extractor keyed on whole events, walked newest-first, and treated
any CAN as "the event is dead"; the audit against api.weather.gov showed both
resurrected and wrongly-killed events. This module replaces it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

ACTIVE_ACTIONS = {"NEW", "CON", "EXT", "EXA", "EXB", "COR", "ROU"}
CLEAR_ACTIONS = {"CAN", "EXP", "UPG"}

# How long an until-further-notice zone outlives its segment's UGC expiry
# without a new statement. The statement is reissued well inside that (the
# UGC expiry is when the next one is due), so this only matters when the
# dish missed it; past this the bot no longer claims to know.
UFN_GRACE = timedelta(hours=24)


@dataclass
class ZoneState:
    begin: datetime | None
    end: datetime | None          # when the zone stops being active; None = never (no UGC expiry either)
    until_further_notice: bool = False   # VTEC end 000000T0000Z: `end` is only how long it is kept without news


@dataclass
class EventState:
    key: tuple                    # (phenomena, significance, office, etn)
    zones: dict[str, ZoneState] = field(default_factory=dict)
    last_seg: object = None       # newest segment that carried an active action
    last_parsed: object = None
    last_prod: object = None
    last_vtec: object = None
    last_vtec_index: int = 0
    issued_at: datetime | None = None

    def active_zones(self, now: datetime) -> dict[str, ZoneState]:
        return {u: z for u, z in self.zones.items() if z.end is None or z.end > now}

    def expires_at(self, now: datetime) -> datetime | None:
        """The event's end, or None when it has none: in force until further
        notice in any of its active zones (or, oddly, no time at all)."""
        zones = self.active_zones(now).values()
        if not zones or self.until_further_notice(now):
            return None
        ends = [z.end for z in zones]
        if any(e is None for e in ends):
            return None
        return max(ends)

    def until_further_notice(self, now: datetime) -> bool:
        return any(z.until_further_notice for z in self.active_zones(now).values())

    def kept_until(self, now: datetime) -> datetime | None:
        """The latest time any active zone is kept to: for an until-further-
        notice event, when the bot stops carrying it unless a statement
        arrives. None when a zone has no time at all."""
        ends = [z.end for z in self.active_zones(now).values()]
        if not ends or any(e is None for e in ends):
            return None
        return max(ends)

    def onset_at(self, now: datetime) -> datetime | None:
        begins = [z.begin for z in self.active_zones(now).values() if z.begin is not None]
        return min(begins) if begins else None


def vtec_key(vtec) -> tuple:
    return (vtec.phenomena, vtec.significance, vtec.office, vtec.etn)


class VtecTracker:
    """Replay parsed products (pyIEM) in issue order and hold every event's
    per-zone state."""

    def __init__(self) -> None:
        self.events: dict[tuple, EventState] = {}

    def replay(self, items: list[tuple], until: datetime | None = None) -> None:
        """items: (parsed_product, EMWINProduct) pairs, any order. Products
        issued after `until` are ignored (lets tests ask "what was active at
        15:00Z" with the whole day's products loaded)."""
        def when(item):
            parsed, prod = item
            return (getattr(parsed, "valid", None) or prod.timestamp, prod.timestamp)
        for parsed, prod in sorted(items, key=when):
            # Known-by time: the earlier of the product's own issue time and
            # the moment we received it (a product with a mangled header
            # still counts once it is on disk).
            known = min(when((parsed, prod))[0], prod.timestamp)
            if until is not None and known > until:
                continue
            self._apply_product(parsed, prod)

    def _apply_product(self, parsed, prod) -> None:
        valid = getattr(parsed, "valid", None) or prod.timestamp
        for seg in parsed.segments:
            ugcs = [str(u) for u in seg.ugcs]
            if not ugcs or not seg.vtec:
                continue
            ugcexpire = getattr(seg, "ugcexpire", None)
            for idx, vtec in enumerate(seg.vtec):
                ev = self.events.setdefault(vtec_key(vtec), EventState(key=vtec_key(vtec)))
                action = vtec.action
                if action in CLEAR_ACTIONS:
                    for u in ugcs:
                        ev.zones.pop(u, None)
                    continue
                if action not in ACTIVE_ACTIONS:
                    continue
                if vtec.endts is not None:
                    end, ufn = vtec.endts, False
                else:
                    # 000000T0000Z: until further notice. The UGC expiry is
                    # when the next statement is due, not when it ends.
                    end, ufn = (ugcexpire or valid) + UFN_GRACE, True
                for u in ugcs:
                    ev.zones[u] = ZoneState(begin=vtec.begints, end=end, until_further_notice=ufn)
                ev.last_seg, ev.last_parsed, ev.last_prod = seg, parsed, prod
                ev.last_vtec, ev.last_vtec_index = vtec, idx
                if ev.issued_at is None or action == "NEW":
                    ev.issued_at = valid

    def active(self, now: datetime | None = None) -> list[EventState]:
        now = now or datetime.now(timezone.utc)
        return [ev for ev in self.events.values() if ev.active_zones(now) and ev.last_seg is not None]
