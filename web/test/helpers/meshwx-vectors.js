// Port of MC1Services/Tests/MeshWXTests/MeshWXVectorFixtures.swift
//
// The official wire vectors.
//
// The fixture is the publisher's own file, byte for byte: `docs/meshwx_v5_vectors.json` from the
// bot's repository (eighteen at revision 9). A codec checked only against itself passes forever
// while being wrong, so nothing in this file is derived from the JS implementation.
//
// The Swift fixture declares a flat `Decoded` type with every key any vector can carry, because
// Swift has to name a shape to decode into. JS does not: PORTING §5 makes a decoded message
// *exactly* this JSON, so the tests compare against `vector.decoded` itself and a mis-typed key
// surfaces as a deep-equality failure rather than as a silent nil.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { MeshWXTables, MeshWXGeometry } from '../../src/meshwx/index.js';
import { nodeBundleLoader } from '../../src/meshwx/nodeLoader.js';

const VECTOR_FILE = new URL('../../../docs/meshwx_v5_vectors.json', import.meta.url);

/** Every vector in the publisher's file. */
export const vectors = JSON.parse(await readFile(fileURLToPath(VECTOR_FILE), 'utf8'));

/** How many vectors the file holds, counted without going through the tests' own shapes. */
export const fileCount = vectors.length;

/**
 * `request_digest`, the revision 6 Request vector (spec §11): `>d` to bot `0x041D` from the
 * sender `01 02 03 04 05 06` at `ts` 1789660000 with `seq` 1 — sixteen bytes.
 */
export const requestDigestHex = '011d0490010203040506600bac6a3e64';

/** The vector of that name, or `undefined`. */
export function vector(name) {
  return vectors.find((entry) => entry.name === name);
}

let tablesPromise = null;

/** `await MeshWXTables.load(nodeBundleLoader())`, once per test process (PORTING §8). */
export function sharedTables() {
  tablesPromise ??= MeshWXTables.load(nodeBundleLoader());
  return tablesPromise;
}

let geometryPromise = null;

/** `MeshWXGeometry.shared` with both GeoJSON files preloaded, once per test process. */
export function sharedGeometry() {
  geometryPromise ??= (async () => {
    MeshWXGeometry.configure(nodeBundleLoader());
    await MeshWXGeometry.shared.preload();
    return MeshWXGeometry.shared;
  })();
  return geometryPromise;
}

/** A loader over an in-memory bundle, for the tests that build a two-row table. */
export function objectLoader(files) {
  return async (fileName) => {
    const name = fileName.replace(/\.json$/, '');
    if (!Object.hasOwn(files, name)) throw new Error(`no ${fileName}`);
    return files[name];
  };
}
