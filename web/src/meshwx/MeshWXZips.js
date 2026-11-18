// Port of MC1Services/Sources/MeshWX/MeshWXZips.swift
//
// MARK: - ZIP codes (spec §16 `zips.json`, §21)
//
// A US ZIP code from `zips.json`: the Census ZCTA's internal point, and the bundled place
// nearest it, which names it.
//
// ZCTAs approximate delivery ZIPs, so PO-box-only and some business ZIPs (the White House's
// 20500) have no row. Those are unknown ZIPs, not errors.
//
// Deviation from Swift, forced by PORTING §8: Swift reads `zips.json` lazily on the first ZIP
// query, behind a lock. A browser cannot read a file synchronously, so `MeshWXTables.load()`
// reads it with the other tables and every lookup here is synchronous afterwards.

import { MeshWXPlaceNames } from './MeshWXPlaceNames.js';

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/**
 * One resolved ZIP: `{ code, lat, lon, placeIndex, place }`, where `place` is the
 * `MeshWXPlace` the ZIP is named after.
 */
export const MeshWXZip = Object.freeze({
  make({ code, lat, lon, placeIndex, place }) {
    return { code, lat, lon, placeIndex, place };
  },

  /**
   * `"San Juan, PR 00901"`: the place's label with the ZIP after it (spec §16.2), the same
   * characters as the weather bot's reply and as the app's row for the town.
   */
  label(zip) {
    return MeshWXPlaceNames.label({ name: zip.place.name, state: zip.place.state, zip: zip.code });
  },
});

/**
 * The five digits a query names as a ZIP: `"78701"`, or ZIP+4 `"78701-1234"`, → `"78701"`,
 * surrounding whitespace allowed. Anything else is null: four or six digits are not a ZIP.
 *
 * The bot's rule (`geodata.zip_code`, a full match of `(\d{5})(?:-\d{4})?`). Python's `\d` is
 * any Unicode decimal digit, so the same is accepted here; the table only has ASCII ones.
 */
export function zipCodeIn(query) {
  const scalars = [...String(query ?? '').trim()];
  if (!(scalars.length === 5 || (scalars.length === 10 && scalars[5] === '-'))) return null;
  for (let offset = 0; offset < scalars.length; offset += 1) {
    if (offset === 5) continue;
    if (!DECIMAL_DIGIT.test(scalars[offset])) return null;
  }
  return scalars.slice(0, 5).join('');
}

/**
 * `zips.json` → `code → { lat, lon, placeIndex }`.
 *
 * Assigned, not built from unique keys: a duplicate must not trap, and the last one wins as in
 * the bot's dict comprehension.
 */
export function parseZipRows(file) {
  const rows = new Map();
  for (const record of file?.zips ?? []) {
    rows.set(record[0], { lat: record[1], lon: record[2], placeIndex: record[3] });
  }
  return rows;
}
