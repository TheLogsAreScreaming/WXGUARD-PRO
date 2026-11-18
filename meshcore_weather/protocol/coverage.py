"""Coverage: the bot's broadcast area, built from operator-configured
cities, states, and NWS WFOs.

Used to filter warnings and radar grids before broadcast so we only use
airtime for data that affects the bot's mesh area.

Coverage fails closed. A home city that does not resolve (or a bare name
that is a place in several states), an unknown state or office, or no
coverage at all leaves the coverage *blocked*: the scheduled warnings,
digest, observations and coverage statement send nothing (executor.py)
until it is fixed, or until the operator asks for every warning in the
country with MCW_COVERAGE=national. A new operator's typo used to mean
"accept everything" and put the whole national warning feed on the air.
"""

import logging
import math
from collections.abc import Iterable

from meshcore_weather.config import settings
from meshcore_weather.geodata import resolver
from meshcore_weather.protocol.meshwx import REGIONS


def _point_in_polygon(lat: float, lon: float, polygon: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test."""
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        yi, xi = polygon[i]
        yj, xj = polygon[j]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def _circle(lat: float, lon: float, radius_km: float):
    """Approximate geographic circle as a shapely polygon (lon/lat degrees)."""
    from shapely.geometry import Point
    from shapely.affinity import scale
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.1, math.cos(math.radians(lat))))
    return scale(Point(lon, lat).buffer(1.0, 64), xfact=dlon, yfact=dlat, origin=(lon, lat))


def zones_within_radius(lat: float, lon: float, radius_km: float) -> set[str]:
    """Public forecast zones whose polygon intersects the circle. Falls back
    to zone centroids within the radius if shapes are unavailable."""
    resolver.load()
    if resolver._load_polygons():
        circle = _circle(lat, lon, radius_km)
        out = set()
        for i in resolver._poly_tree.query(circle):
            if resolver._poly_geoms[i].intersects(circle):
                out.add(resolver._poly_codes[i])
        return out
    from meshcore_weather.geodata import _haversine
    return {code for code, z in resolver._zones.items()
            if _haversine(lat, lon, z["la"], z["lo"]) <= radius_km}


def counties_within_radius(lat: float, lon: float, radius_km: float) -> set[str]:
    """Counties whose outline intersects the circle: the same rule as the
    zones, for the products that name counties (watches). Falls back to each
    county's inside point within the radius if outlines are unavailable."""
    if resolver._load_county_polygons():
        circle = _circle(lat, lon, radius_km)
        return {resolver._county_codes[i] for i in resolver._county_tree.query(circle)
                if resolver._county_geoms[i].intersects(circle)}
    from meshcore_weather.geodata import _haversine
    return {code for code, c in resolver.counties().items()
            if _haversine(lat, lon, c["lat"], c["lon"]) <= radius_km}


def counties_of_offices(wfos: Iterable[str]) -> set[str]:
    """Counties an NWS office serves: those whose inside point lies in one of
    its public zones. Offices' areas follow county lines, so a county is one
    office's, and its point settles which."""
    wfos = set(wfos)
    resolver.load()
    states = {z["s"] for z in resolver._zones.values() if z.get("w") in wfos}
    out = set()
    for code, c in resolver.counties().items():
        if c.get("state") not in states:
            continue
        zone = resolver.zone_containing(c["lat"], c["lon"])
        if zone is None:
            nearest = resolver._nearest_zones(c["lat"], c["lon"], n=1)
            zone = nearest[0] if nearest else None
        if zone and resolver._zones.get(zone, {}).get("w") in wfos:
            out.add(code)
    return out


logger = logging.getLogger(__name__)

BBox = tuple[float, float, float, float]  # (north, south, west, east)

# Coverage.from_config's one build per combination of settings.
_FROM_CONFIG: dict[tuple, "Coverage"] = {}


def forget_config_build() -> None:
    """Drop the kept from_config build (tests; a changed geodata)."""
    _FROM_CONFIG.clear()


def _split_csv(s: str) -> list[str]:
    """Split comma-separated string, strip whitespace, drop empties."""
    return [p.strip() for p in s.split(",") if p.strip()]


def _is_code(upper: str, loc: dict) -> bool:
    """A ZIP, a zone code or a station ID: one place, no ambiguity."""
    from meshcore_weather.geodata import zip_code
    if zip_code(upper):
        return True
    if len(upper) >= 5 and upper[2] == "Z" and upper[3:].isdigit():
        return True
    return len(upper) in (3, 4) and upper.isalnum() and loc.get("station_km") == 0.0


def check_place(query: str) -> tuple[dict | None, str | None, str | None]:
    """Resolve one MCW_HOME_CITIES entry the way the bot will, and say what
    is wrong with it. Returns (location, error, warning).

    An error: the entry does not resolve, or it is a bare name that is a
    place in more than one state ("Austin" is in seven), where the bot would
    pick the biggest and centre its coverage hundreds of km from the mesh. A
    warning: it resolved, but not to a place of that exact name ("Pfluger TX"
    is read as Pflugerville)."""
    from meshcore_weather.geodata import _normalize
    resolver.load()
    q = (query or "").strip()
    loc = resolver.resolve(q) if q else None
    if not loc:
        return None, (f"home city {q!r} is not a place the bot knows: write it as 'City ST' "
                      "(e.g. 'Austin TX') or give a ZIP code"), None
    upper = q.upper()
    if _is_code(upper, loc):
        return loc, None, None
    parts = upper.replace(",", " ").split()
    if len(parts) >= 2 and len(parts[-1]) == 2 and parts[-1].isalpha():
        city, state = _normalize(" ".join(parts[:-1])), parts[-1]
        if any(p[1] == state and _normalize(p[0]) == city for p in resolver._places):
            return loc, None, None
        return loc, None, f"home city {q!r} was read as {loc['name']!r}: check it, or write that name in full"
    # A bare name: the bot takes the biggest place of that name, wherever it is.
    name = _normalize(q)
    matches = [p for p in resolver._places if _normalize(p[0]) == name]
    exact = bool(matches)
    if not matches and len(name) >= 3:
        matches = [p for p in resolver._places
                   if _normalize(p[0]).startswith(name) or any(w.startswith(name) for w in _normalize(p[0]).split())]
    states = sorted({p[1] for p in matches})
    if len(states) > 1 or (not exact and len({(p[0], p[1]) for p in matches}) > 1):
        listed = ", ".join(states[:8]) + ("…" if len(states) > 8 else "")
        return None, (f"home city {q!r} is ambiguous without a state ({len(matches)} places in {listed}): "
                      f"write it as 'City ST', e.g. '{q} {loc['name'].rsplit(', ', 1)[-1]}'"), None
    if not exact:
        return loc, None, f"home city {q!r} was read as {loc['name']!r}: write the full name and state"
    return loc, None, f"home city {q!r} has no state: write it as {loc['name'].replace(',', '')!r}"


def refresh_home() -> tuple[float, float] | None:
    """Point the resolver's home (which ranks bare place names, and is the
    centre of the observations and the home forecast) at the first
    MCW_HOME_CITIES entry again: after a live change of the home city.
    `_set_home_from_settings` keeps a home it already has, so it is cleared
    first; an entry that no longer resolves leaves no home (fails closed)."""
    resolver.load()
    try:
        resolver._set_home_from_settings(force=True)
    except TypeError:                       # geodata without the force flag
        resolver._home = None
        resolver._set_home_from_settings()
    return resolver.home()


class Coverage:
    """Canonical set of NWS zones, and of counties, that the bot cares about.

    Sources (all optional, all additive):
      - Cities: "Austin TX" → each city's resolved zone and its county
      - Radius around the first city → every zone and county whose outline
        intersects the circle
      - States: "TX" → all zones where zone.s == "TX", and the state's counties
      - WFOs: "EWX" → all zones where zone.w == "EWX", and the counties it serves

    The counties are there for the products that name counties and carry no
    polygon: tornado and severe thunderstorm watches (WCN). Matching only
    zones dropped every one of them.

    A Coverage with no zones is no filter (`is_empty`: every warning
    matches). Built from the settings (`from_config`) it is only that when the
    operator set MCW_COVERAGE=national; otherwise no zones means `blocked`,
    and so do configuration errors: the scheduled area broadcasts then send
    nothing (see the module docstring).
    """

    def __init__(
        self,
        zones: set[str] | None = None,
        sources: dict | None = None,
        counties: set[str] | None = None,
        *,
        errors: list[str] | None = None,
        warnings: list[str] | None = None,
        national: bool = False,
        unconfigured: bool = False,
    ):
        self.zones: set[str] = zones or set()
        self.counties: set[str] = counties or set()
        self.sources: dict = sources or {"cities": [], "states": [], "wfos": []}
        self.center: tuple[float, float] | None = self.sources.get("center")
        # What the configuration got wrong (each one blocks the scheduled area
        # broadcasts), and what it got doubtfully right (logged, shown).
        self.errors: list[str] = list(errors or [])
        self.warnings: list[str] = list(warnings or [])
        self.national = national            # MCW_COVERAGE=national: no filter, on purpose
        self.unconfigured = unconfigured    # nothing configured and not national
        self.home_name: str | None = self.sources.get("home_name")
        self.radius_km: float = float(self.sources.get("radius_km") or 0)
        self.bbox: BBox | None = None
        self.region_ids: set[int] = set()
        # States the operator *explicitly* covers (via home_states or via WFOs
        # whose served state we can determine). Used to match county-FIPS UGCs
        # (e.g. TXC029) which are not in the zones set.
        self.explicit_states: set[str] = set()
        for s in self.sources.get("states", []) or []:
            if s:
                self.explicit_states.add(s.upper())
        self._recompute_bbox_and_regions()
        # NOTE: listing a WFO no longer implies its whole state. That rule
        # turned MCW_HOME_WFOS=EWX into "all of Texas" and flooded Austin
        # with Lake Charles river warnings. Only MCW_HOME_STATES widens.

    @classmethod
    def empty(cls) -> "Coverage":
        """No filter: every warning matches. Not what `from_config` gives a
        bot with nothing configured; that one is `blocked`."""
        return cls()

    @classmethod
    def unavailable(cls, reason: str) -> "Coverage":
        """No coverage could be built: the scheduled area broadcasts send
        nothing (the scheduler's state before the first build, or after a
        build that raised when there was no good one to keep)."""
        return cls(errors=[reason])

    @classmethod
    def from_config(cls) -> "Coverage":
        """Build coverage from settings: a radius around the first home city
        (the normal case), widened by any extra cities/states/WFOs, or the
        whole country with MCW_COVERAGE=national.

        The result is kept for the same settings, so the bot, the scheduler
        and the portal share one build (and one log of it): a new
        combination of settings is built, and logged, once."""
        key = (settings.home_cities, settings.home_states, settings.home_wfos,
               settings.home_radius_km, settings.coverage)
        cached = _FROM_CONFIG.get(key)
        if cached is not None:
            return cached
        cov = cls._build_from_config()
        _FROM_CONFIG.clear()
        _FROM_CONFIG[key] = cov
        cov.log()
        return cov

    @classmethod
    def _build_from_config(cls) -> "Coverage":
        resolver.load()
        errors: list[str] = []
        warnings: list[str] = []
        mode = (settings.coverage or "").strip().lower()
        if mode not in ("", "area", "national"):
            errors.append(f"MCW_COVERAGE={settings.coverage!r} is not 'national' (leave it empty for the home area)")
        cities = _split_csv(settings.home_cities)
        good: list[str] = []
        home: dict | None = None
        for i, city in enumerate(cities):
            loc, err, warn = check_place(city)
            if err:
                errors.append(err)
            if warn:
                warnings.append(warn)
            if loc is not None and not err:
                good.append(city)
                if i == 0:
                    home = loc
        states = [s.upper() for s in _split_csv(settings.home_states)]
        known_states = {z.get("s") for z in resolver._zones.values()}
        errors += [f"MCW_HOME_STATES: {s!r} is not a state the NWS zones list" for s in states
                   if s not in known_states]
        wfos = [w.upper() for w in _split_csv(settings.home_wfos)]
        known_wfos = {z.get("w") for z in resolver._zones.values()}
        errors += [f"MCW_HOME_WFOS: {w!r} is not an NWS office the zones list" for w in wfos
                   if w not in known_wfos]
        center = (home["lat"], home["lon"]) if home else None
        home_name = home["name"] if home else None
        if mode == "national":
            # No filter on purpose. The home point still centres the coverage
            # statement, the observations and the home forecast.
            return cls(sources={"cities": cities, "states": [], "wfos": [], "center": center,
                                "radius_km": 0, "home_name": home_name},
                       errors=errors, warnings=warnings, national=True)
        # Only the cities that resolved; the radius only around the first city
        # itself, never around whichever came next.
        cov = cls.from_sources(cities=good, states=[s for s in states if s in known_states],
                               wfos=[w for w in wfos if w in known_wfos],
                               radius_km=settings.home_radius_km if home else 0)
        cov.errors, cov.warnings = errors, warnings
        cov.sources["cities"] = cities
        cov.sources["home_name"] = cov.home_name = home_name
        cov.sources["center"] = cov.center = center    # the first city's, or none: never the next one's
        cov.unconfigured = not cov.zones and not errors
        return cov

    @classmethod
    def from_sources(
        cls,
        cities: list[str] | None = None,
        states: list[str] | None = None,
        wfos: list[str] | None = None,
        radius_km: float = 0,
    ) -> "Coverage":
        """Build coverage from explicit lists of cities/states/WFOs, plus a
        radius (km) around the first city: every public zone whose polygon
        intersects that circle is covered."""
        cities = cities or []
        states = [s.upper() for s in (states or [])]
        wfos = [w.upper() for w in (wfos or [])]

        resolver.load()
        zones: set[str] = set()
        counties: set[str] = set()
        center: tuple[float, float] | None = None

        # Cities → the zone and the county each city is in (polygon), plus
        # the radius circle around the first one.
        for city in cities:
            loc = resolver.resolve(city)
            if loc and loc.get("zones"):
                zones.add(loc["zones"][0])
                county = resolver.county_for_point(loc["lat"], loc["lon"])
                if county:
                    counties.add(county)
                if center is None:
                    center = (loc["lat"], loc["lon"])
        if center is not None and radius_km > 0:
            zones.update(zones_within_radius(center[0], center[1], radius_km))
            counties.update(counties_within_radius(center[0], center[1], radius_km))

        # States → all zones and counties in that state
        if states:
            for code, z in resolver._zones.items():
                if z.get("s") in states:
                    zones.add(code)
            counties.update(code for code, c in resolver.counties().items() if c.get("state") in states)

        # WFOs → all zones and counties served by that office
        if wfos:
            for code, z in resolver._zones.items():
                if z.get("w") in wfos:
                    zones.add(code)
            counties.update(counties_of_offices(wfos))

        return cls(
            zones=zones,
            counties=counties,
            sources={"cities": cities, "states": states, "wfos": wfos,
                     "center": center, "radius_km": radius_km if center else 0},
        )

    # -- Derived properties --

    def is_empty(self) -> bool:
        """No zones: as a filter, everything matches. Whether the scheduled
        broadcasts may send on it is `blocked`."""
        return not self.zones

    @property
    def blocked(self) -> str | None:
        """Why the scheduled area broadcasts (warnings, digest, observations,
        coverage statement) must send nothing, or None when they may."""
        if self.errors:
            return "; ".join(self.errors)
        if self.unconfigured:
            return ("no coverage is set: give MCW_HOME_CITIES (e.g. 'Austin TX'), or set "
                    "MCW_COVERAGE=national to broadcast every warning in the country")
        return None

    def log(self) -> None:
        """The start-up lines: what is covered, the home point, and every
        error loudly."""
        logger.info("Coverage: %s", self.summary())
        if self.center:
            logger.info("Home point: %s (%.4f, %.4f)", self.home_name or "?", self.center[0], self.center[1])
        else:
            logger.warning("Home point: none (MCW_HOME_CITIES); no observations or home forecast are broadcast")
        for w in self.warnings:
            logger.warning("Coverage: %s", w)
        for e in self.errors:
            logger.error("Coverage error: %s. Scheduled warnings, digest and observations send nothing "
                         "until it is fixed (meshcore-weather --check)", e)
        if self.unconfigured:
            logger.error("Coverage error: %s. Scheduled warnings, digest and observations send nothing", self.blocked)

    def _recompute_bbox_and_regions(self) -> None:
        """Compute bbox of all zone centroids + overlapping MeshWX regions."""
        if not self.zones:
            self.bbox = None
            self.region_ids = set()
            return

        lats: list[float] = []
        lons: list[float] = []
        for code in self.zones:
            z = resolver._zones.get(code)
            if z:
                lats.append(z["la"])
                lons.append(z["lo"])

        if not lats:
            self.bbox = None
            self.region_ids = set()
            return

        # Pad the bbox by ~1 degree so region overlap is tolerant
        pad = 1.0
        self.bbox = (
            max(lats) + pad,
            min(lats) - pad,
            min(lons) - pad,
            max(lons) + pad,
        )

        # Find MeshWX regions that overlap the bbox
        self.region_ids = set()
        n, s, w, e = self.bbox
        for rid, region in REGIONS.items():
            # Standard AABB overlap test
            if not (region["s"] > n or region["n"] < s or region["w"] > e or region["e"] < w):
                self.region_ids.add(rid)

    # -- Filtering API --

    def covers_zone(self, zone_code: str) -> bool:
        """Is this exact zone code in our coverage?"""
        return zone_code in self.zones

    def covers_any(self, zone_codes: Iterable[str], by_county: bool = True) -> bool:
        """Does any of these UGC codes intersect our coverage?

        Accepts both NWS zone codes (TXZ192) and county codes (TXC453). Match
        rules, in order:
          1. Exact zone match against our zones set (narrow, precise)
          2. Exact county match against our counties set. A watch (WCN)
             names counties and has no polygon, so this is the only way one
             is in coverage. `by_county=False` skips it, for a storm-based
             warning: its UGC line lists the counties its polygon touches,
             not the area warned, and the caller judges it by the polygon.
          3. If the operator explicitly covers a state (home_states),
             accept any UGC whose 2-letter prefix matches.
        """
        if not self.zones:
            return True  # empty coverage = accept everything
        codes = list(zone_codes)
        for code in codes:
            if code in self.zones:
                return True
        if by_county:
            for code in codes:
                if code in self.counties:
                    return True
        if self.explicit_states:
            for code in codes:
                if len(code) >= 2 and code[:2].upper() in self.explicit_states:
                    return True
        return False

    def covers_polygon(self, vertices: list[tuple[float, float]]) -> bool:
        """Does a storm-based polygon touch our area?

        With a centre/radius: the polygon intersects the coverage circle
        (exact, and catches small SVR/TOR polygons that contain no zone
        centroid). Otherwise: it intersects any covered zone's polygon, or,
        if shapes are unavailable, contains a covered zone centroid.
        """
        if not self.zones or not vertices or len(vertices) < 3:
            return self.is_empty()  # empty coverage = accept
        try:
            from shapely.geometry import Polygon
            poly = Polygon([(lon, lat) for lat, lon in vertices])
            if not poly.is_valid:
                poly = poly.buffer(0)
            if self.center and self.radius_km > 0:
                return poly.intersects(_circle(self.center[0], self.center[1], self.radius_km))
            if resolver._load_polygons():
                for i, code in enumerate(resolver._poly_codes):
                    if code in self.zones and resolver._poly_geoms[i].intersects(poly):
                        return True
                return False
        except Exception:
            pass
        for code in self.zones:
            z = resolver._zones.get(code)
            if z and _point_in_polygon(z["la"], z["lo"], vertices):
                return True
        return False

    def summary(self) -> str:
        """Human-readable summary for logging/portal display."""
        if self.blocked:
            built = f" (built so far: {len(self.zones)} zones)" if self.zones else ""
            return (f"BLOCKED, nothing is broadcast: {self.blocked}{built}. Scheduled warnings, "
                    "digest, observations and the coverage statement send nothing until this is fixed")
        if self.national:
            home = f"; home point {self.home_name}" if self.home_name else ""
            return f"national: every warning the feed carries (MCW_COVERAGE=national){home}"
        if self.is_empty():
            return "all regions (no filter)"
        parts = []
        if self.center and self.radius_km:
            parts.append(f"{self.radius_km:.0f} km around {self.center[0]:.2f},{self.center[1]:.2f}")
        if self.sources.get("cities"):
            parts.append(f"{len(self.sources['cities'])} cities")
        if self.sources.get("states"):
            parts.append(f"states={','.join(self.sources['states'])}")
        if self.sources.get("wfos"):
            parts.append(f"wfos={','.join(self.sources['wfos'])}")
        return f"{len(self.zones)} zones, {len(self.counties)} counties ({', '.join(parts)})"
