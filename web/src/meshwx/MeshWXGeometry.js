// Port of MC1Services/Sources/MeshWX/MeshWXGeometry.swift
//
// Zone and county outlines, keyed by UGC code (spec §16, `zones.geojson` and `counties.geojson`).
//
// A warning either carries a polygon or names areas. Storm-based products (tornado, severe
// thunderstorm, flash flood) carry the polygon and the area list is just the counties under it;
// zone-based products (winter, heat, wind, fire) carry the list alone, and without these
// outlines the only thing an app can draw for them is a pin in the middle of a county. Hence
// the 14 MB.
//
// **Not every code has a ring.** The bundle is a cut in time and the UGC tables grow, so
// `rings()` returning null is a normal outcome, not a failure: fall back to the centroid that
// `zones.json` / `counties.json` carry (spec §16).
//
// PORTING §8: `MeshWXGeometry.shared` exists from import, and the two GeoJSON files load only
// through `await preload()` (both) or `preloadZones()` / `preloadCounties()`. Until a file has
// loaded, every lookup that needs it answers "not known" — null, or an empty list — exactly as
// the Swift does for a file that is not in the bundle, and `isZoneFileLoaded` /
// `isCountyFileLoaded` say which it is. Callers already treat that as *checking*, never as
// "not here".
//
// Internally a ring is a Float64Array of `[lat, lon, lat, lon, …]`: 514 000 vertices as objects
// would be tens of megabytes of boxed pairs, and every hot path here (ray casting, boxes,
// distance) reads the numbers straight. `rings()` materialises `{ latitude, longitude }` for the
// handful of codes anyone actually draws, and caches what it materialised.

const KM_PER_DEGREE_LATITUDE = 111.195;

/** A latitude/longitude box around every ring of one area. */
function boxOf(rings) {
  let first = true;
  let minLatitude = 0;
  let maxLatitude = 0;
  let minLongitude = 0;
  let maxLongitude = 0;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index += 2) {
      const latitude = ring[index];
      const longitude = ring[index + 1];
      if (first) {
        minLatitude = latitude; maxLatitude = latitude;
        minLongitude = longitude; maxLongitude = longitude;
        first = false;
      } else {
        if (latitude < minLatitude) minLatitude = latitude;
        if (latitude > maxLatitude) maxLatitude = latitude;
        if (longitude < minLongitude) minLongitude = longitude;
        if (longitude > maxLongitude) maxLongitude = longitude;
      }
    }
  }
  return first ? null : { minLatitude, maxLatitude, minLongitude, maxLongitude };
}

/**
 * Whether a ring contains a point, by ray casting in latitude/longitude, over the flat form.
 *
 * Planar on purpose: warning polygons and county outlines are tens of kilometres across, where
 * the curvature error is metres — far inside the 0.001° resolution a warning polygon is sent at.
 * A ring may repeat its first vertex or not; the duplicate edge has zero height and never
 * crosses the ray. A point exactly on an edge may land either side, which is why callers that
 * make safety claims must also measure distance to the edge.
 */
function ringContainsFlat(ring, latitude, longitude) {
  const count = ring.length / 2;
  if (count < 3) return false;
  let inside = false;
  let previousLat = ring[ring.length - 2];
  let previousLon = ring[ring.length - 1];
  for (let index = 0; index < ring.length; index += 2) {
    const vertexLat = ring[index];
    const vertexLon = ring[index + 1];
    if ((vertexLat > latitude) !== (previousLat > latitude)) {
      const fraction = (latitude - vertexLat) / (previousLat - vertexLat);
      const crossing = vertexLon + fraction * (previousLon - vertexLon);
      if (longitude < crossing) inside = !inside;
    }
    previousLat = vertexLat;
    previousLon = vertexLon;
  }
  return inside;
}

/**
 * Distance in kilometres from a point to the nearest edge of a flat ring, 0 when inside.
 *
 * An equirectangular projection around the point: within the tens of kilometres a "near" alert
 * or a location's uncertainty radius spans, its error is well under the 0.001° a warning polygon
 * is sent at. A two-point ring is a line; a one-point ring is a point.
 */
function distanceToFlatRing(ring, latitude, longitude) {
  const count = ring.length / 2;
  if (count === 0) return Infinity;
  if (count >= 3 && ringContainsFlat(ring, latitude, longitude)) return 0;
  const kmPerLongitude = KM_PER_DEGREE_LATITUDE * Math.cos((latitude * Math.PI) / 180);
  const x = (index) => (ring[index * 2 + 1] - longitude) * kmPerLongitude;
  const y = (index) => (ring[index * 2] - latitude) * KM_PER_DEGREE_LATITUDE;
  if (count < 2) {
    return Math.sqrt(x(0) * x(0) + y(0) * y(0));
  }
  let nearest = Infinity;
  let previousX = x(count - 1);
  let previousY = y(count - 1);
  for (let index = 0; index < count; index += 1) {
    const currentX = x(index);
    const currentY = y(index);
    const dx = currentX - previousX;
    const dy = currentY - previousY;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared > 0
      ? Math.max(0, Math.min(1, -(previousX * dx + previousY * dy) / lengthSquared))
      : 0;
    const closestX = previousX + fraction * dx;
    const closestY = previousY + fraction * dy;
    const distance = Math.sqrt(closestX * closestX + closestY * closestY);
    if (distance < nearest) nearest = distance;
    previousX = currentX;
    previousY = currentY;
  }
  return nearest;
}

function flatten(positions) {
  const out = new Float64Array(positions.length * 2);
  let cursor = 0;
  for (const position of positions) {
    if (position == null || position.length < 2) continue;
    // GeoJSON is lon-first; everything else in this module is lat-first, so the swap happens
    // once here, at the boundary, rather than at every call site.
    out[cursor] = position[1];
    out[cursor + 1] = position[0];
    cursor += 2;
  }
  return cursor === out.length ? out : out.subarray(0, cursor);
}

function featureRings(geometry) {
  if (geometry == null) return [];
  if (geometry.type === 'MultiPolygon') {
    // Index 0 of each polygon is its outer ring; the rest are holes.
    return (geometry.coordinates ?? [])
      .map((polygon) => polygon?.[0])
      .filter((ring) => ring != null)
      .map(flatten);
  }
  if (geometry.type === 'Polygon') {
    const outer = geometry.coordinates?.[0];
    return outer == null ? [] : [flatten(outer)];
  }
  // Point, LineString and friends have no area to fill.
  return [];
}

function parseFeatureCollection(collection) {
  const result = new Map();
  for (const feature of collection?.features ?? []) {
    const code = feature?.properties?.code;
    if (code == null) continue;
    const rings = featureRings(feature.geometry);
    if (rings.length === 0) continue;
    const key = String(code).toUpperCase();
    // A handful of zones (74 in the 2026-09 cut) appear as two features; appending rather than
    // assigning keeps both halves instead of drawing only the last one.
    const existing = result.get(key);
    if (existing == null) result.set(key, rings);
    else existing.push(...rings);
  }
  const out = new Map();
  for (const [code, rings] of result) out.set(code, { rings, box: boxOf(rings) });
  return out;
}

/** Zone and county outlines, keyed by UGC code. */
export class MeshWXGeometry {
  /** `loader` is PORTING §8's `async (fileName) => parsedJSON`, or null for "no bundle". */
  constructor(loader = null) {
    this.loader = loader;
    this._zones = null;
    this._counties = null;
    this._materialised = new Map();
    this._loading = new Map();
  }

  /**
   * Give `MeshWXGeometry.shared` its loader. The instance exists from import, so nothing has to
   * wait for configuration to hold a reference to it.
   */
  static configure(loader) {
    MeshWXGeometry.shared.loader = loader;
    return MeshWXGeometry.shared;
  }

  // MARK: - Lazy per-file loading

  async _load(which, file) {
    if (this[which] != null) return this[which];
    if (this._loading.has(which)) return this._loading.get(which);
    const task = (async () => {
      let parsed = new Map();
      if (this.loader != null) {
        try {
          parsed = parseFeatureCollection(await this.loader(file));
        } catch {
          // A missing or malformed file leaves that one table empty, so a failed read is never
          // retried in a loop.
          parsed = new Map();
        }
      }
      if (this[which] == null) this[which] = parsed;
      this._loading.delete(which);
      return this[which];
    })();
    this._loading.set(which, task);
    return task;
  }

  /** Read `zones.geojson`. */
  async preloadZones() {
    await this._load('_zones', 'zones.geojson');
  }

  /** Read `counties.geojson`. */
  async preloadCounties() {
    await this._load('_counties', 'counties.geojson');
  }

  /** Parse both files, in parallel. */
  async preload() {
    await Promise.all([this.preloadZones(), this.preloadCounties()]);
  }

  /** Whether each file has been read yet, for a "preparing map" indicator. */
  get isZoneFileLoaded() {
    return this._zones != null;
  }

  get isCountyFileLoaded() {
    return this._counties != null;
  }

  // MARK: - Lookup

  _entry(ugc) {
    const code = String(ugc ?? '').toUpperCase();
    if (code.length < 3) return null;
    switch (code[2]) {
      case 'C': return this._counties?.get(code) ?? null;
      case 'Z': return this._zones?.get(code) ?? null;
      default: return null;
    }
  }

  /**
   * Outer rings for a UGC code (`"TXC453"`, `"TXZ192"`) or for an area already resolved to a
   * name by `MeshWXTables`, as `[[{ latitude, longitude }, …], …]`; null when the bundle has no
   * outline for it, and null as well while the file it lives in has not been preloaded.
   *
   * A Polygon yields one ring; a MultiPolygon yields one per part, so an island county draws as
   * several closed shapes. Holes are dropped: a county with a lake in it is drawn filled, since
   * at the zoom a warning map uses a hole is a few pixels, and carrying holes would double the
   * memory and force every consumer to handle even-odd fill rules.
   */
  rings({ for: subject }) {
    const ugc = typeof subject === 'string' ? subject : subject?.ugc;
    const code = String(ugc ?? '').toUpperCase();
    const cached = this._materialised.get(code);
    if (cached != null) return cached;
    const entry = this._entry(code);
    if (entry == null) return null;
    const rings = entry.rings.map((ring) => {
      const out = new Array(ring.length / 2);
      for (let index = 0; index < ring.length; index += 2) {
        out[index / 2] = { latitude: ring[index], longitude: ring[index + 1] };
      }
      return out;
    });
    this._materialised.set(code, rings);
    return rings;
  }

  // MARK: - Containment

  /**
   * Whether the outline of a UGC code contains a point, or null when the bundle has no outline
   * for that code — "no outline" is not "outside", and callers must not treat it as such.
   */
  contains(point, { ugc }) {
    const entry = this._entry(ugc);
    if (entry == null) return null;
    return entry.rings.some((ring) => ringContainsFlat(ring, point.latitude, point.longitude));
  }

  /**
   * `areaCodes({ containing: point })`: every county and zone whose outline contains a point,
   * sorted — normally one county and one land zone, occasionally more where fire-weather or
   * marine zones overlap.
   *
   * `areaCodes({ near: point, withinKilometres: r })`: every county and zone whose outline
   * contains the point or passes within a radius of it — the areas a location with that much
   * uncertainty might be in.
   */
  areaCodes({ containing, near, withinKilometres }) {
    const point = containing ?? near;
    if (point == null) return [];
    const hits = [];
    if (containing != null) {
      for (const table of [this._counties, this._zones]) {
        if (table == null) continue;
        for (const [code, entry] of table) {
          if (entry.box == null) continue;
          if (point.latitude < entry.box.minLatitude || point.latitude > entry.box.maxLatitude
            || point.longitude < entry.box.minLongitude
            || point.longitude > entry.box.maxLongitude) continue;
          if (entry.rings.some((ring) => ringContainsFlat(ring, point.latitude, point.longitude))) {
            hits.push(code);
          }
        }
      }
      return hits.sort();
    }
    const radius = withinKilometres;
    const latitudePad = radius / KM_PER_DEGREE_LATITUDE;
    const longitudePad = radius / Math.max(
      1, KM_PER_DEGREE_LATITUDE * Math.cos((point.latitude * Math.PI) / 180),
    );
    for (const table of [this._counties, this._zones]) {
      if (table == null) continue;
      for (const [code, entry] of table) {
        const box = entry.box;
        if (box == null) continue;
        if (point.latitude < box.minLatitude - latitudePad
          || point.latitude > box.maxLatitude + latitudePad
          || point.longitude < box.minLongitude - longitudePad
          || point.longitude > box.maxLongitude + longitudePad) continue;
        if (entry.rings.some(
          (ring) => distanceToFlatRing(ring, point.latitude, point.longitude) <= radius,
        )) {
          hits.push(code);
        }
      }
    }
    return hits.sort();
  }

  /**
   * Distance from a point to a UGC area's outline, 0 inside, or null when the bundle has no
   * outline for the code — "no outline" is not "far away".
   */
  distanceKilometres({ from, toArea }) {
    const entry = this._entry(toArea);
    if (entry == null || entry.rings.length === 0) return null;
    let nearest = Infinity;
    for (const ring of entry.rings) {
      const distance = distanceToFlatRing(ring, from.latitude, from.longitude);
      if (distance < nearest) nearest = distance;
    }
    return nearest;
  }

  /**
   * Distance in kilometres from a point to the nearest edge of a ring of
   * `{ latitude, longitude }`, 0 when inside.
   */
  static distanceKilometres({ from, to }) {
    return distanceToFlatRing(
      MeshWXGeometry.flatten(to), from.latitude, from.longitude,
    );
  }

  /** Whether a ring of `{ latitude, longitude }` contains a point, by ray casting. */
  static ring(ring, { contains }) {
    return ringContainsFlat(MeshWXGeometry.flatten(ring), contains.latitude, contains.longitude);
  }

  /** A ring of `{ latitude, longitude }` as the flat `[lat, lon, …]` this module works in. */
  static flatten(ring) {
    const out = new Float64Array(ring.length * 2);
    ring.forEach((vertex, index) => {
      out[index * 2] = vertex.latitude;
      out[index * 2 + 1] = vertex.longitude;
    });
    return out;
  }

  /**
   * A latitude/longitude box around every ring of one area.
   *
   * Asking "which county am I in" against 8,600 outlines is a ray cast per vertex; asking it
   * against 8,600 boxes first leaves two or three outlines to cast against, which is what makes
   * the lookup cheap enough to run whenever the place changes.
   */
  static Box = Object.freeze({
    /** From rings of `{ latitude, longitude }`; null when they hold no vertex. */
    make(rings) {
      return boxOf(rings.map((ring) => MeshWXGeometry.flatten(ring)));
    },

    contains(box, point) {
      return point.latitude >= box.minLatitude && point.latitude <= box.maxLatitude
        && point.longitude >= box.minLongitude && point.longitude <= box.maxLongitude;
    },
  });

  /** The box around a UGC area's outlines, or null when the bundle has none. */
  box({ for: ugc }) {
    return this._entry(ugc)?.box ?? null;
  }
}

/** The app-wide geometry. `MeshWXGeometry.configure(loader)` gives it a bundle to read. */
MeshWXGeometry.shared = new MeshWXGeometry(null);
