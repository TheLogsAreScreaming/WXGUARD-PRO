// Port of MC1Services/Tests/MeshWXTests/MeshWXGeometryTests.swift
//
// The bundled zone and county outlines (spec §16).
//
// Deviation from Swift, forced by PORTING §8: Swift parses a GeoJSON file synchronously on the
// first lookup that needs it, so its tests can call `rings(for:)` cold. A browser cannot, so
// every suite here preloads first, and the "missing resources" case preloads a loader that
// fails — which is the same claim: a failed read still counts as loaded and is not retried.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { MeshWXGeometry } from '../src/meshwx/index.js';
import { nodeBundleLoader } from '../src/meshwx/nodeLoader.js';
import { sharedGeometry, sharedTables } from './helpers/meshwx-vectors.js';

/** The box a ring spans, so a test can assert *where* an outline is without depending on which
 *  vertex the source file happens to start at. */
function boundingBox(ring) {
  const latitudes = ring.map((vertex) => vertex.latitude);
  const longitudes = ring.map((vertex) => vertex.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  return {
    minLatitude,
    maxLatitude,
    minLongitude,
    maxLongitude,
    centreLatitude: (minLatitude + maxLatitude) / 2,
    centreLongitude: (minLongitude + maxLongitude) / 2,
    contains: (latitude, longitude) => latitude >= minLatitude && latitude <= maxLatitude
      && longitude >= minLongitude && longitude <= maxLongitude,
    toString: () => `lat ${minLatitude}…${maxLatitude}, lon ${minLongitude}…${maxLongitude}`,
  };
}

describe('MeshWX geometry', () => {
  let geometry;
  before(async () => { geometry = await sharedGeometry(); });

  test('countyRingsCoverTheCounty', () => {
    // Travis county, TX: the same county the kit's severe thunderstorm vector names.
    const rings = geometry.rings({ for: 'TXC453' });
    assert.ok(rings != null);
    assert.ok(rings.length > 0);
    const ring = rings[0];
    assert.ok(ring.length > 3, `a fillable ring needs more than three points, got ${ring.length}`);

    // The outline must actually be around Austin, not around whatever feature happened to be
    // first in the file: check the box it spans, since any single vertex sits on an edge rather
    // than near the centre.
    const box = boundingBox(ring);
    assert.ok(box.contains(30.3, -97.8), `Travis box is ${box}`);
    assert.ok(Math.abs(box.centreLatitude - 30.3) < 0.2);
    assert.ok(Math.abs(box.centreLongitude - -97.8) < 0.2);
  });

  test('zoneRingsExist', () => {
    const rings = geometry.rings({ for: 'TXZ192' });
    assert.ok(rings != null);
    const ring = rings[0];
    assert.ok(ring.length > 3);
    assert.ok(boundingBox(ring).contains(30.3, -97.8));
  });

  test('lookupIsCaseInsensitiveAndKindAware', () => {
    assert.notEqual(geometry.rings({ for: 'txc453' }), null);
    // The third character picks the file; anything else is not a UGC.
    assert.equal(geometry.rings({ for: 'TXQ453' }), null);
    assert.equal(geometry.rings({ for: 'TX' }), null);
    assert.equal(geometry.rings({ for: '' }), null);
  });

  test('unknownCodesReturnNilSoTheAppFallsBackToTheCentroid', () => {
    // Spec §16: bundling the polygons is not a promise every code has one.
    assert.equal(geometry.rings({ for: 'TXC997' }), null);
    assert.equal(geometry.rings({ for: 'ZZZ001' }), null);
  });

  test('namedAreasResolveToRings', async () => {
    const tables = await sharedTables();
    const areas = tables.namedAreas({ for: [{ state: 42, county: true, start: 453, run: 1 }] });
    const area = areas[0];
    assert.ok(area != null);
    assert.notEqual(geometry.rings({ for: area }), null);
  });

  test('missingResourcesYieldNoRingsRatherThanCrashing', async () => {
    const empty = new MeshWXGeometry(async () => { throw new Error('no bundle'); });
    await empty.preloadCounties();
    assert.equal(empty.rings({ for: 'TXC453' }), null);
    // A failed read still counts as loaded, so it is not retried on every lookup.
    assert.ok(empty.isCountyFileLoaded);
  });

  /** Numbers for the report, and proof that `preload()` warms both caches. */
  test('reportsGeoJSONLoadTimes', async () => {
    const fresh = new MeshWXGeometry(nodeBundleLoader());
    assert.ok(!fresh.isZoneFileLoaded);
    assert.ok(!fresh.isCountyFileLoaded);

    let started = performance.now();
    await fresh.preloadCounties();
    console.log(`MeshWX: counties.geojson first load ${Math.round(performance.now() - started)} ms`);
    started = performance.now();
    await fresh.preloadZones();
    console.log(`MeshWX: zones.geojson first load ${Math.round(performance.now() - started)} ms`);
    assert.ok(fresh.isZoneFileLoaded);
    assert.ok(fresh.isCountyFileLoaded);

    const both = new MeshWXGeometry(nodeBundleLoader());
    started = performance.now();
    await both.preload();
    console.log(`MeshWX: preload() of both files ${Math.round(performance.now() - started)} ms`);
    assert.ok(both.isZoneFileLoaded);
    assert.ok(both.isCountyFileLoaded);

    // Warm lookups must not re-read anything.
    started = performance.now();
    assert.notEqual(both.rings({ for: 'TXC453' }), null);
    assert.ok(performance.now() - started < 50);
  });
});

/** The kit's severe thunderstorm polygon (SV.W.EWX.42), as the decoder reconstructs it. */
const stormPolygon = [
  { latitude: 30.52, longitude: -97.98 },
  { latitude: 30.61, longitude: -97.62 },
  { latitude: 30.38, longitude: -97.41 },
  { latitude: 30.15, longitude: -97.5 },
  { latitude: 30.09, longitude: -97.85 },
  { latitude: 30.28, longitude: -98.04 },
];

/** Containment: which outline holds a point, and whether a warning polygon does. */
describe('MeshWX geometry containment', () => {
  let geometry;
  before(async () => { geometry = await sharedGeometry(); });

  test('aPolygonContainsItsInteriorAndNotTheOutside', () => {
    assert.ok(MeshWXGeometry.ring(
      stormPolygon, { contains: { latitude: 30.35, longitude: -97.7 } },
    ));
    assert.ok(!MeshWXGeometry.ring(
      stormPolygon, { contains: { latitude: 30.0, longitude: -97.0 } },
    ));
    // Just past the eastern vertex, where a bounding box would still say yes.
    assert.ok(!MeshWXGeometry.ring(
      stormPolygon, { contains: { latitude: 30.58, longitude: -97.45 } },
    ));
  });

  test('aClosedRingAnswersTheSameAsAnOpenOne', () => {
    const closed = [...stormPolygon, stormPolygon[0]];
    const inside = { latitude: 30.35, longitude: -97.7 };
    const outside = { latitude: 30.0, longitude: -97.0 };
    assert.ok(MeshWXGeometry.ring(closed, { contains: inside }));
    assert.ok(!MeshWXGeometry.ring(closed, { contains: outside }));
  });

  test('degenerateRingsContainNothing', () => {
    const point = { latitude: 30.35, longitude: -97.7 };
    assert.ok(!MeshWXGeometry.ring([], { contains: point }));
    assert.ok(!MeshWXGeometry.ring(stormPolygon.slice(0, 2), { contains: point }));
  });

  /** Expected codes come from an independent Python ray cast over the same GeoJSON files. */
  test('downtownAustinIsInTravisCountyAndZone', () => {
    const codes = geometry.areaCodes({ containing: { latitude: 30.2672, longitude: -97.7431 } });
    assert.deepStrictEqual(codes, ['TXC453', 'TXZ192']);
  });

  test('roundRockIsInWilliamsonCounty', () => {
    const codes = geometry.areaCodes({ containing: { latitude: 30.5083, longitude: -97.6789 } });
    assert.deepStrictEqual(codes, ['TXC491', 'TXZ173']);
  });

  test('openWaterIsInAMarineZoneAndNoCounty', () => {
    const codes = geometry.areaCodes({ containing: { latitude: 28.5, longitude: -94.5 } });
    assert.deepStrictEqual(codes, ['GMZ375']);
  });

  test('containmentByCodeDistinguishesOutsideFromNoOutline', () => {
    const austin = { latitude: 30.2672, longitude: -97.7431 };
    assert.equal(geometry.contains(austin, { ugc: 'TXC453' }), true);
    assert.equal(geometry.contains(austin, { ugc: 'TXC491' }), false);
    // No outline is not "outside": the caller must not claim the area misses the point.
    assert.equal(geometry.contains(austin, { ugc: 'TXC997' }), null);
  });
});

/** How far a point is from an outline, and which areas an uncertain location might be in. */
describe('MeshWX geometry distance', () => {
  let geometry;
  before(async () => { geometry = await sharedGeometry(); });

  test('insideIsZero', () => {
    assert.equal(MeshWXGeometry.distanceKilometres({
      from: { latitude: 30.35, longitude: -97.7 }, to: stormPolygon,
    }), 0);
  });

  test('eastOfTheEasternVertexIsAboutTenKilometres', () => {
    // 0.1° of longitude at 30.38°N is 9.59 km, and the eastern vertex is the nearest point.
    const distance = MeshWXGeometry.distanceKilometres({
      from: { latitude: 30.38, longitude: -97.31 }, to: stormPolygon,
    });
    assert.ok(distance > 9.3 && distance < 9.7, `got ${distance}`);
  });

  test('theNearestPointCanBeOnAnEdge', () => {
    // Due south of the middle of the southern edge (30.15,-97.5)–(30.09,-97.85).
    const distance = MeshWXGeometry.distanceKilometres({
      from: { latitude: 30.0, longitude: -97.675 }, to: stormPolygon,
    });
    assert.ok(distance > 12 && distance < 13.5, `got ${distance}`);
  });

  test('noOutlineIsNotFarAway', () => {
    const austin = { latitude: 30.2672, longitude: -97.7431 };
    assert.equal(geometry.distanceKilometres({ from: austin, toArea: 'TXC997' }), null);
    assert.equal(geometry.distanceKilometres({ from: austin, toArea: 'TXC453' }), 0);
    const bexar = geometry.distanceKilometres({ from: austin, toArea: 'TXC029' }) ?? 0;
    assert.ok(bexar > 60, `Bexar county is a long way from downtown Austin, got ${bexar}`);
  });

  test('anUncertainLocationMayBeInTheNeighbouringCounties', () => {
    const austin = { latitude: 30.2672, longitude: -97.7431 };
    const tight = geometry.areaCodes({ near: austin, withinKilometres: 1 });
    assert.deepStrictEqual(tight, ['TXC453', 'TXZ192']);
    const loose = geometry.areaCodes({ near: austin, withinKilometres: 35 });
    assert.ok(loose.includes('TXC453'));
    assert.ok(loose.includes('TXC491'), 'Williamson county is north of Austin');
    assert.ok(loose.includes('TXC209'), 'Hays county is south-west of Austin');
    assert.ok(!loose.includes('TXC029'), 'Bexar county is not within 35 km');
  });
});
