// Port of MC1Services/Sources/MeshWX/MeshWXTables.swift (and the ZIP extension in
// MeshWXZips.swift, whose members hang off MeshWXTables in Swift too).
//
// The preload bundle of spec §16: everything the wire refers to by index.
//
// The protocol's first design rule is "the mesh carries identifiers and numbers, the phone
// carries tables and words", so this type is not a convenience — without it a decoded warning is
// `event 3, office 35, state 42` and nothing an app can draw.
//
// PORTING §8: Swift reads the bundle synchronously on first use; a browser cannot, so
// `await MeshWXTables.load(loader)` reads every JSON table, builds the instance, stores it in
// `MeshWXTables.shared` and returns it. After that every lookup below is synchronous, exactly
// as in Swift.
//
// Nothing here throws on a missing table. A file the loader cannot supply leaves that one table
// empty: a weather app that fails to start because a resource did not copy is worse than one
// that cannot name a county.

import { MeshWXAreaRun } from './MeshWXMessage.js';
import { zipCodeIn, parseZipRows } from './MeshWXZips.js';
// MeshWXSeverity is declared in MeshWXPresentation.swift and used here, exactly as in Swift.
// The import is cyclic and safe: nothing below touches it at module-evaluation time.
import { MeshWXSeverity } from './MeshWXPresentation.js';

// MARK: - Geography

/**
 * Great-circle distance. Small enough to inline here rather than pull a geo library into a
 * module that must run under `node --test` with nothing installed.
 *
 * Deviation from Swift: `distanceMiles(fromLat:lon:toLat:lon:)` has two parameters labelled
 * `lon`, which one options object cannot express, so the keys are `fromLon` and `toLon`.
 */
export const MeshWXGeo = Object.freeze({
  earthRadiusMiles: 3958.7613,
  earthRadiusKilometres: 6371.0088,

  distanceMiles({ fromLat, fromLon, toLat, toLon }) {
    return MeshWXGeo.haversine(fromLat, fromLon, toLat, toLon) * MeshWXGeo.earthRadiusMiles;
  },

  distanceKilometres({ fromLat, fromLon, toLat, toLon }) {
    return MeshWXGeo.haversine(fromLat, fromLon, toLat, toLon) * MeshWXGeo.earthRadiusKilometres;
  },

  /** Central angle in radians. */
  haversine(lat1, lon1, lat2, lon2) {
    const toRadians = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRadians;
    const dLon = (lon2 - lon1) * toRadians;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians)
        * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  },
});

// MARK: - Table records
//
// Plain data with the Swift property names (PORTING §3). Only wire *messages* are snake_case.

/** A METAR station (`stations.json`): `{ icao, name, state, lat, lon }`. */
export const MeshWXStation = Object.freeze({
  make({ icao, name, state, lat, lon }) {
    return { icao, name, state, lat, lon };
  },
});

/** A PFM forecast point (`pfm_points.json`). `index` is the `point` u16 on the wire. */
export const MeshWXPoint = Object.freeze({
  make({ index, name, office, lat, lon, zone }) {
    return { index, name, office, lat, lon, zone };
  },
});

/** A populated place (`places.json`), for search and autocomplete. */
export const MeshWXPlace = Object.freeze({
  make({ name, state, lat, lon, population }) {
    return { name, state, lat, lon, population };
  },
});

/**
 * A forecast zone (`zones.json`). `lat`/`lon` are the centroid, which is the pin an app drops
 * when it has no polygon for the zone.
 */
export const MeshWXZone = Object.freeze({
  make({ id, name, office, state, lat, lon }) {
    return { id, name, office, state, lat, lon };
  },
});

/** A county, parish, borough or independent city (`counties.json`). */
export const MeshWXCounty = Object.freeze({
  make({ ugc, name, state, lat, lon }) {
    return { ugc, name, state, lat, lon };
  },
});

/** An NWS forecast office (`wfos.json`), or a national centre listed with them. */
export const MeshWXOffice = Object.freeze({
  make({ code, states, lat, lon, name = null }) {
    return { code, states, lat, lon, name };
  },
});

/**
 * The two names a VTEC event has: a wire-era abbreviation for a badge and a full name for a
 * headline.
 */
export const MeshWXEventName = Object.freeze({
  make({ short, long }) {
    return { short, long };
  },
});

/**
 * One area of a warning, resolved to a name and a pin.
 *
 * `name` and the coordinates are nullable because the bundle is versioned and the wire is not:
 * a county added to the NWS tables after this bundle was cut still decodes to a valid UGC, just
 * without a label. Losing the name must not lose the area.
 */
export const MeshWXNamedArea = Object.freeze({
  make({ ugc, name = null, state, isCounty, lat = null, lon = null }) {
    return { ugc, name, state, isCounty, lat, lon };
  },
});

// MARK: - ASCII search helpers
//
// Byte-wise ASCII case folding rather than a locale uppercase: a place search runs over 35 000
// names on every keystroke, and the upper-cased names are precomputed once at load so that no
// keystroke allocates a string per candidate.

function foldASCII(value) {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    out += code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : value[index];
  }
  return out;
}

function searchKey(query) {
  return foldASCII(String(query ?? '').trim());
}

// MARK: - Tables

/** The preload bundle of spec §16. */
export class MeshWXTables {
  /**
   * Build from already-parsed bundle files. Every key is optional; a missing one leaves that
   * table empty. Keys are the file names without `.json`.
   */
  constructor(files = {}) {
    const protocolFile = files.protocol ?? null;
    const indexFile = files.index ?? null;
    const stationsFile = files.stations ?? null;
    const pointsFile = files.pfm_points ?? null;
    const placesFile = files.places ?? null;
    const zonesFile = files.zones ?? null;
    const countiesFile = files.counties ?? null;
    const wfosFile = files.wfos ?? null;
    const zipsFile = files.zips ?? null;

    /** `protocol.json` `version` — 15 for v5.0 revision 11. */
    this.protocolVersion = protocolFile?.version ?? 0;
    /** NWS office codes, ordered; the `office` byte indexes this. */
    this.offices = indexFile?.offices ?? [];
    /** ICAO codes, ordered; the `station` u16 indexes this. */
    this.stations = indexFile?.stations ?? [];
    /** State and territory codes, ordered; the area-run state field indexes this. */
    this.states = indexFile?.states ?? [];

    // The events table is keyed by VTEC code on disk and by wire byte on the air, so both
    // directions are built once here rather than scanned per warning.
    const byByte = new Map();
    const byCode = new Map();
    for (const [code, value] of Object.entries(protocolFile?.events ?? {})) {
      if (!Number.isInteger(value) || value < 0 || value > 255) continue;
      byByte.set(value, code);
      byCode.set(code, value);
    }
    /** Wire byte → VTEC code, e.g. `3` → `"SV.W"`. */
    this.eventCodes = byByte;
    /** VTEC code → wire byte. */
    this.eventByCode = byCode;
    /** VTEC code → `{ short, long }`. */
    this.eventNames = new Map(Object.entries(protocolFile?.event_names ?? {}));

    const sky = new Map();
    for (const [name, value] of Object.entries(protocolFile?.sky_codes ?? {})) {
      if (!Number.isInteger(value) || value < 0 || value > 15) continue;
      sky.set(value, name);
    }
    /** Sky code → the bundle's name for it (`"broken"`, `"thunderstorm"`). */
    this.skyNames = sky;

    /**
     * `protocol.json` `v5.radar` — what the client needs of revision 11's own block.
     *
     * The wire shape (the grid, the zooms, the flags) is in `MeshWXWire`, where a decoder can
     * reach it without the bundle. What is here is what the *bundle* is the authority on and a
     * newer bot may change under an older app: which mosaic each `product` index names, what dBZ
     * the three levels start at, and the two limits a screen quotes back to a person — how old a
     * picture the bot will still serve, and how long it holds one tile down before it sends it
     * again. An empty block leaves every list empty, which reads as "this bundle says nothing
     * about radar", never as "radar has no products".
     */
    const radarFile = protocolFile?.v5?.radar ?? null;
    this.radar = Object.freeze({
      /** Wire `product` index → EMWIN product id, e.g. `"RADSTHPL"`. */
      products: Object.freeze([...(radarFile?.products ?? [])]),
      /** The same list as names a person reads, e.g. `"Southern Plains"`. */
      productNames: Object.freeze([...(radarFile?.product_names ?? [])]),
      /** Level 1 starts at the first, level 2 at the second, level 3 at the third. */
      levelsDBZ: Object.freeze([...(radarFile?.levels_dbz ?? [])]),
      /** Spec §13: no picture older than this covers a tile, so the answer is a refusal. */
      maxAgeMinutes: radarFile?.max_age_minutes ?? null,
      /** Spec §13: the same tile of the same picture goes out at most this often. Seconds. */
      cooldownSeconds: radarFile?.cooldown_seconds ?? null,
      /** `"x"` — the Not-available letter of `>radar`, stated by the bundle as well. */
      requestLetter: radarFile?.request_letter ?? null,
    });

    /** Forecast points in wire order. */
    this.points = (pointsFile?.points ?? []).map((row, index) => ({
      index,
      name: row[0],
      office: row[1],
      lat: row[2],
      lon: row[3],
      zone: row[4],
    }));

    /** Populated places, for search. */
    this.places = (placesFile?.places ?? []).map((row) => ({
      name: row[0],
      state: row[1],
      lat: row[2],
      lon: row[3],
      population: row[4],
    }));
    // Precomputed once: the search path must never allocate a folded string per candidate.
    this._placeKeys = this.places.map((place) => foldASCII(place.name));

    this._stationsByICAO = new Map();
    this._stationList = [];
    this._stationKeys = [];
    for (const [icao, row] of Object.entries(stationsFile ?? {})) {
      const station = { icao, name: row.name, state: row.state, lat: row.lat, lon: row.lon };
      this._stationsByICAO.set(icao, station);
      this._stationList.push(station);
      this._stationKeys.push({ icao: foldASCII(icao), name: foldASCII(row.name) });
    }

    this._stationIndexByICAO = new Map();
    (indexFile?.stations ?? []).forEach((icao, position) => {
      if (position > 0xffff) return;
      this._stationIndexByICAO.set(icao, position);
    });

    this._zonesByID = new Map();
    for (const [id, row] of Object.entries(zonesFile ?? {})) {
      this._zonesByID.set(id, {
        id, name: row.name, office: row.wfo, state: row.state, lat: row.lat, lon: row.lon,
      });
    }

    this._countiesByUGC = new Map();
    for (const [ugc, row] of Object.entries(countiesFile ?? {})) {
      this._countiesByUGC.set(ugc, {
        ugc, name: row.name, state: row.state, lat: row.lat, lon: row.lon,
      });
    }

    this._officesByCode = new Map();
    for (const [code, row] of Object.entries(wfosFile ?? {})) {
      this._officesByCode.set(code, {
        code, states: row.states ?? [], lat: row.lat, lon: row.lon, name: row.name ?? null,
      });
    }

    this._zipRows = parseZipRows(zipsFile);
    this._zipTableLoaded = zipsFile != null;
  }

  // MARK: - Loading

  /** The nine bundle files this reads, in load order. */
  static get bundleFiles() {
    return [
      'protocol', 'index', 'stations', 'pfm_points', 'places',
      'zones', 'counties', 'wfos', 'zips',
    ];
  }

  /**
   * Read every JSON table through `loader` and build an instance, without publishing it.
   * A file the loader rejects leaves that table empty.
   */
  static async from(loader) {
    const files = {};
    await Promise.all(MeshWXTables.bundleFiles.map(async (name) => {
      try {
        files[name] = await loader(`${name}.json`);
      } catch {
        files[name] = null;
      }
    }));
    return new MeshWXTables(files);
  }

  /** PORTING §8: build the shared instance and return it. Every lookup after this is sync. */
  static async load(loader) {
    const tables = await MeshWXTables.from(loader);
    MeshWXTables.shared = tables;
    return tables;
  }

  // MARK: - Wire index lookups
  //
  // All of these return null rather than throwing on an index past the end of the table.
  // `index.json` is append-only, so an out-of-range index means the bundle is older than the
  // bot — a normal thing on a mesh, not a bug.

  officeCode(index) {
    return index >= 0 && index < this.offices.length ? this.offices[index] : null;
  }

  /**
   * Whether an office byte names a national centre: one of `nationalCentreCodes`, or an office
   * whose `wfos.json` row lists no states. False for an index the bundle does not know.
   */
  isNationalCentre(index) {
    const code = this.officeCode(index);
    if (code == null) return false;
    return MeshWXTables.nationalCentreCodes.has(code) || this.office(code)?.states.length === 0;
  }

  stationICAO(index) {
    return index >= 0 && index < this.stations.length ? this.stations[index] : null;
  }

  stationIndex({ forICAO }) {
    return this._stationIndexByICAO.get(String(forICAO).toUpperCase()) ?? null;
  }

  stateCode(index) {
    return index >= 0 && index < this.states.length ? this.states[index] : null;
  }

  /** The EMWIN id a Radar message's `product` names (`"RADSTHPL"`), or null. */
  radarProduct({ at: index }) {
    const products = this.radar.products;
    return index >= 0 && index < products.length ? products[index] : null;
  }

  /**
   * The mosaic's name for a person (`"Southern Plains"`), or null when this bundle is older
   * than the bot and does not know the index. A screen that cannot name the picture says
   * nothing about it rather than printing a number nobody can look up.
   */
  radarProductName({ at: index }) {
    const names = this.radar.productNames;
    return index >= 0 && index < names.length ? names[index] : null;
  }

  /** VTEC code for an event byte, e.g. `3` → `"SV.W"`. */
  vtec({ for: event }) {
    return this.eventCodes.get(event) ?? null;
  }

  /** Short and long names for an event byte. */
  eventName({ for: event }) {
    const code = this.eventCodes.get(event);
    if (code == null) return null;
    return this.eventNames.get(code) ?? null;
  }

  /** Severity from the VTEC significance letter (spec §3). */
  severity({ for: event }) {
    const code = this.eventCodes.get(event);
    if (code == null) return null;
    return MeshWXSeverity.make({ vtec: code });
  }

  /**
   * A label that is always printable: the table's name, or `"unknown (#42)"` when the bundle
   * does not know the index.
   */
  officeLabel(index) {
    return this.officeCode(index) ?? MeshWXTables.unknownLabel(index);
  }

  stationLabel(index) {
    return this.stationICAO(index) ?? MeshWXTables.unknownLabel(index);
  }

  stateLabel(index) {
    return this.stateCode(index) ?? MeshWXTables.unknownLabel(index);
  }

  eventLabel({ for: event }) {
    return this.eventName({ for: event })?.long
      ?? this.vtec({ for: event })
      ?? MeshWXTables.unknownLabel(event);
  }

  static unknownLabel(index) {
    return `unknown (#${index})`;
  }

  // MARK: - Reference lookups

  /** `station({ icao })` by code, or `station({ at })` by wire index. */
  station({ icao, at }) {
    if (icao != null) return this._stationsByICAO.get(String(icao).toUpperCase()) ?? null;
    const code = this.stationICAO(at);
    return code == null ? null : this._stationsByICAO.get(code) ?? null;
  }

  point({ at }) {
    return at >= 0 && at < this.points.length ? this.points[at] : null;
  }

  zone(id) {
    return this._zonesByID.get(String(id).toUpperCase()) ?? null;
  }

  county(ugc) {
    return this._countiesByUGC.get(String(ugc).toUpperCase()) ?? null;
  }

  office(code) {
    return this._officesByCode.get(String(code).toUpperCase()) ?? null;
  }

  /**
   * Nearest forecast point by great-circle distance — the "forecast for my location" lookup of
   * spec §21. Send `>f <index>` for what comes back and label the answer with the point's name
   * and its distance, because it is not the user's coordinate.
   */
  nearestPoint({ toLat, lon }) {
    let best = null;
    let bestAngle = Infinity;
    for (const point of this.points) {
      // Compare the central angle rather than a distance: it is monotonic in distance and saves
      // a multiply per candidate across ~1900 points.
      const angle = MeshWXGeo.haversine(toLat, lon, point.lat, point.lon);
      if (angle < bestAngle) {
        bestAngle = angle;
        best = point;
      }
    }
    return best;
  }

  /**
   * Nearest weather station by great-circle distance, within `within` kilometres: the station to
   * ask with `>o <ICAO>` when no reading the phone holds is near a place. Null beyond the
   * radius: a reading from farther away would not describe the place.
   */
  nearestStation({ toLat, lon, within = 80 }) {
    let best = null;
    let bestDistance = Infinity;
    for (const station of this._stationList) {
      const distance = MeshWXGeo.distanceKilometres({
        fromLat: toLat, fromLon: lon, toLat: station.lat, toLon: station.lon,
      });
      if (distance > within) continue;
      if (best != null
        && (distance > bestDistance || (distance === bestDistance && station.icao >= best.icao))) {
        continue;
      }
      best = station;
      bestDistance = distance;
    }
    return best;
  }

  // MARK: - Search (spec §21)

  /**
   * The place to name a coordinate by ("Austin"), within `within` kilometres.
   *
   * Nearest place of at least `minimumPopulation` people first, then the nearest place of any
   * size: a point in central Austin is "Austin", not the 400-person village whose census
   * centroid happens to sit 800 m closer. Null when nothing is within the radius — a label from
   * 60 km away would tell the user they are somewhere they are not.
   */
  nearestPlace({ toLat, lon, within = 25, minimumPopulation = 1000 }) {
    let bestSizeable = null;
    let bestSizeableDistance = Infinity;
    let bestAny = null;
    let bestAnyDistance = Infinity;
    for (const place of this.places) {
      const distance = MeshWXGeo.distanceKilometres({
        fromLat: toLat, fromLon: lon, toLat: place.lat, toLon: place.lon,
      });
      if (distance > within) continue;
      if (bestAny == null || distance < bestAnyDistance) {
        bestAny = place;
        bestAnyDistance = distance;
      }
      if (place.population >= minimumPopulation
        && (bestSizeable == null || distance < bestSizeableDistance)) {
        bestSizeable = place;
        bestSizeableDistance = distance;
      }
    }
    return bestSizeable ?? bestAny;
  }

  /**
   * Place search: prefix match on the name, then nearest to `nearLat`/`lon` if given, then the
   * biggest (spec §21).
   *
   * Distance before population is deliberate. 4,292 names exist in more than one state — Round
   * Rock is in TX and AZ — and the one the user means is almost always the one they can drive
   * to, not the one with more people in it.
   */
  searchPlaces({ query, nearLat = null, lon = null, limit = 25 }) {
    const prefix = searchKey(query);
    if (prefix.length === 0 || limit <= 0) return [];
    const matches = [];
    for (let index = 0; index < this.places.length; index += 1) {
      if (this._placeKeys[index].startsWith(prefix)) matches.push(this.places[index]);
    }

    if (nearLat == null || lon == null) {
      // No anchor to rank against: biggest first, name as the tie-break so the order is stable
      // between launches.
      matches.sort((left, right) => (
        left.population !== right.population
          ? right.population - left.population
          : compareStrings(left.name, right.name)
      ));
      return matches.slice(0, limit);
    }
    const ranked = matches.map((place) => ({
      place, angle: MeshWXGeo.haversine(nearLat, lon, place.lat, place.lon),
    }));
    ranked.sort((left, right) => (
      left.angle === right.angle
        ? right.place.population - left.place.population
        : left.angle - right.angle
    ));
    return ranked.slice(0, limit).map((entry) => entry.place);
  }

  /**
   * Station search by ICAO prefix or name substring (spec §21), nearest first when a location is
   * given.
   */
  searchStations({ query, nearLat = null, lon = null, limit = 25 }) {
    const key = searchKey(query);
    if (key.length === 0 || limit <= 0) return [];
    const matches = [];
    for (let index = 0; index < this._stationList.length; index += 1) {
      const keys = this._stationKeys[index];
      if (keys.icao.startsWith(key) || keys.name.includes(key)) {
        matches.push(this._stationList[index]);
      }
    }

    if (nearLat == null || lon == null) {
      // Stable and predictable without a location: alphabetical by ICAO.
      matches.sort((left, right) => compareStrings(left.icao, right.icao));
      return matches.slice(0, limit);
    }
    const ranked = matches.map((station) => ({
      station, angle: MeshWXGeo.haversine(nearLat, lon, station.lat, station.lon),
    }));
    ranked.sort((left, right) => (
      left.angle === right.angle
        ? compareStrings(left.station.icao, right.station.icao)
        : left.angle - right.angle
    ));
    return ranked.slice(0, limit).map((entry) => entry.station);
  }

  // MARK: - Areas

  /**
   * Resolve a warning's area runs to named places with pins (spec §16). Takes either the runs
   * themselves or a decoded warning, exactly as the two Swift overloads do.
   *
   * Runs whose state index is unknown are dropped — there is no UGC to build without the state
   * code — but a UGC the bundle has no row for is kept, name null, so the app can still say
   * "and 3 more areas" instead of under-reporting the warning.
   */
  namedAreas({ for: subject }) {
    const runs = Array.isArray(subject) ? subject : subject?.areas ?? [];
    const out = [];
    for (const run of runs) {
      const state = this.stateCode(run.state);
      if (state == null) continue;
      for (const ugc of MeshWXAreaRun.ugcCodes(run, { states: this.states })) {
        if (run.county) {
          const county = this.county(ugc);
          out.push({
            ugc,
            name: county?.name ?? null,
            state,
            isCounty: true,
            lat: county?.lat ?? null,
            lon: county?.lon ?? null,
          });
        } else {
          const zone = this.zone(ugc);
          out.push({
            ugc,
            name: zone?.name ?? null,
            state,
            isCounty: false,
            lat: zone?.lat ?? null,
            lon: zone?.lon ?? null,
          });
        }
      }
    }
    return out;
  }

  // MARK: - ZIP codes (MeshWXZips.swift)

  /** The five digits a query names as a ZIP, or null. See `zipCodeIn`. */
  static zipCode({ in: query }) {
    return zipCodeIn(query);
  }

  /**
   * The ZIP a query names, looked up exactly and never by prefix (spec §16, §21). Null for a
   * query that is not a ZIP, and for a ZIP the table does not have.
   */
  zip(query) {
    const code = zipCodeIn(query);
    if (code == null) return null;
    const row = this._zipRows.get(code);
    if (row == null) return null;
    if (!(row.placeIndex >= 0 && row.placeIndex < this.places.length)) return null;
    return {
      code,
      lat: row.lat,
      lon: row.lon,
      placeIndex: row.placeIndex,
      place: this.places[row.placeIndex],
    };
  }

  /** How many ZIPs the table holds; 0 when the file is missing or bad. */
  get zipCount() {
    return this._zipRows.size;
  }

  /** Every ZIP in the table, ascending. */
  zipCodes() {
    return [...this._zipRows.keys()].sort(compareStrings);
  }

  /** Whether `zips.json` was supplied (or tried and failed). */
  get isZipTableLoaded() {
    return this._zipTableLoaded;
  }
}

/**
 * Issuers in the `offices` list that are national centres rather than forecast offices: `NHC`
 * (the National Hurricane Center, index 125) and `WNS` (the Storm Prediction Center, 126, which
 * issues tornado and severe thunderstorm watches). Their products cover many forecast offices'
 * areas, so they say nothing about which office a bot carries.
 */
MeshWXTables.nationalCentreCodes = new Set(['NHC', 'WNS']);

/**
 * The app-wide tables. Empty until `await MeshWXTables.load(loader)` replaces it, so that a
 * lookup before the bundle arrives answers "unknown" rather than throwing (PORTING §8).
 */
MeshWXTables.shared = new MeshWXTables({});

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
