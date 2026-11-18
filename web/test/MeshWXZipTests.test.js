// Port of MC1Services/Tests/MeshWXTests/MeshWXZipTests.swift
//
// US ZIP codes (spec §16 `zips.json`, §21): the bot's own table, looked up and labelled by the
// label rule of spec §16.2, so a ZIP resolves and reads the same texted to the bot as typed into
// the app.
//
// Every expected label here is the bot's (`resolver.resolve(zip)['name']`, asserted by the same
// table in meshwx `tests/test_place_names.py`), not read off this implementation.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { MeshWXTables, MeshWXZip, MeshWXPlaceNames } from '../src/meshwx/index.js';
import { nodeBundleLoader, defaultBundleDirectory } from '../src/meshwx/nodeLoader.js';
import { sharedTables, objectLoader } from './helpers/meshwx-vectors.js';

/** SHA-256 of `meshcore_weather/client_data/zips.json` at bot commit 5993383. */
const BOT_FILE_SHA256 = '1a1bc0b68b4f2e74e4e02c05092ef0863281b9ee1291d3dc29a67578934c716c';
/**
 * SHA-256 of the bot's label for every ZIP in the table, in ZIP order, joined by newlines
 * (`geodata.names.place_label(name, state, zip)`; meshwx `tests/test_place_names.py` pins it too).
 */
const BOT_LABELS_SHA256 = 'f7bed783cf389ba4e2e2a7ab8ea8d83808f635f55a4376f2ca017c7d590c505f';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

describe('MeshWX ZIP codes', () => {
  let tables;
  before(async () => { tables = await sharedTables(); });

  test('bundledFileIsTheBotsByteForByte', async () => {
    const data = await readFile(fileURLToPath(new URL('zips.json', defaultBundleDirectory)));
    assert.equal(data.length, 1_082_771);
    assert.equal(sha256(data), BOT_FILE_SHA256);
  });

  test('tableHasEveryRow', () => {
    assert.equal(tables.zipCount, 33_144);
    const codes = tables.zipCodes();
    assert.equal(codes[0], '00601');
    assert.ok(codes.every((code) => code.length === 5));
  });

  /**
   * Swift reads `zips.json` on the first ZIP query and not before; PORTING §8 makes that
   * impossible in a browser, so `MeshWXTables.load()` reads it with the other tables. What the
   * Swift test really asserts about behaviour — that a query which is not a ZIP resolves to
   * nothing, and a ZIP resolves to the bot's label — still holds.
   */
  test('tableIsReadOnTheFirstZipQueryAndNotBefore', async () => {
    const fresh = await MeshWXTables.from(nodeBundleLoader());
    fresh.searchPlaces({ query: 'austin' });
    assert.equal(fresh.zip('Austin'), null);
    assert.equal(fresh.zip('7870'), null);
    assert.equal(MeshWXZip.label(fresh.zip('78701')), 'Austin, TX 78701');
    assert.ok(fresh.isZipTableLoaded);
  });

  /** Eight lookups at once agree — the Swift's concurrency case, now trivially synchronous. */
  test('coldLookupsFromManyTasksAgree', async () => {
    const fresh = await MeshWXTables.from(nodeBundleLoader());
    const labels = await Promise.all(Array.from(
      { length: 8 }, async () => MeshWXZip.label(fresh.zip('78701')),
    ));
    assert.equal(labels.length, 8);
    assert.ok(labels.every((label) => label === 'Austin, TX 78701'));
    assert.equal(fresh.zipCount, 33_144);
  });

  test('austin', () => {
    const zip = tables.zip('78701');
    assert.ok(zip != null);
    assert.equal(zip.code, '78701');
    assert.equal(zip.lat, 30.2706);
    assert.equal(zip.lon, -97.7426);
    assert.equal(zip.placeIndex, 29645);
    assert.equal(zip.place.name, 'AUSTIN');
    assert.equal(zip.place.state, 'TX');
    assert.equal(MeshWXZip.label(zip), 'Austin, TX 78701');
  });

  test('leadingZeroIsKept', () => {
    const zip = tables.zip('00901');
    assert.ok(zip != null);
    assert.equal(zip.code, '00901');
    assert.equal(zip.lat, 18.4654);
    assert.equal(zip.lon, -66.1046);
    assert.equal(MeshWXZip.label(zip), 'San Juan, PR 00901');
    assert.equal(tables.zip('901'), null);
  });

  test('zipPlusFourLooksUpItsFirstFiveDigits', () => {
    const plain = tables.zip('78701');
    assert.deepStrictEqual(tables.zip('78701-1234'), plain);
    assert.deepStrictEqual(tables.zip(' 78701-1234 '), plain);
  });

  test('zipsNotInTheTableAreUnknown', () => {
    assert.equal(tables.zip('99999'), null);
    assert.equal(tables.zip('20500'), null, 'the White House: a business ZIP with no ZCTA');
    assert.equal(tables.zip('20500-0001'), null);
  });

  test('onlyFiveDigitsOrZipPlusFourIsAZip', () => {
    assert.equal(MeshWXTables.zipCode({ in: '78701' }), '78701');
    assert.equal(MeshWXTables.zipCode({ in: ' 02134 ' }), '02134');
    assert.equal(MeshWXTables.zipCode({ in: '78701-1234' }), '78701');
    assert.equal(MeshWXTables.zipCode({ in: '7870' }), null);
    assert.equal(MeshWXTables.zipCode({ in: '787011' }), null);
    assert.equal(MeshWXTables.zipCode({ in: '78701-12' }), null);
    assert.equal(MeshWXTables.zipCode({ in: '78701-' }), null);
    assert.equal(MeshWXTables.zipCode({ in: '78701 1234' }), null);
    assert.equal(MeshWXTables.zipCode({ in: 'KAUS' }), null);
    assert.equal(MeshWXTables.zipCode({ in: 'TXZ192' }), null);
    assert.equal(MeshWXTables.zipCode({ in: '' }), null);
    // Never by prefix: four digits find nothing, though hundreds of ZIPs start with them.
    assert.equal(tables.zip('7870'), null);
  });

  describe('labelIsTheBots', () => {
    const cases = [
      ['78701', 'Austin, TX 78701'],
      ['00901', 'San Juan, PR 00901'],
      ['02134', 'Allston, MA 02134'],
      ['00601', 'Adjuntas, PR 00601'], // ADJUNTAS ZONA URBANA
      ['00603', 'Caban, PR 00603'], // CABAN COMUNIDAD
      ['99801', 'Juneau, AK 99801'], // JUNEAU CITY AND
      ['10019', "Hell's Kitchen, NY 10019"], // 's after a letter stays lower
      ['20010', 'Central 14th Street / Spring Road, DC 20010'], // an ordinal after digits
      ['00650', 'Estancias de Florida, PR 00650'], // ESTANCIAS DE FLORIDA COMUNIDAD
      ['08562', 'McGuire AFB, NJ 08562'], // Mc, and an initialism
      ['96706', '‘Ewa Gentry, HI 96706'], // a mark starting the word
      ['06461', 'Milford, CT 06461'], // MILFORD CITY (BALANCE)
      ['02138', 'West Cambridge/Harvard Square, MA 02138'],
      ['01944', 'Manchester-by-the-Sea, MA 01944'],
      ['12930', 'St. Regis Falls, NY 12930'],
      ['37352', 'Lynchburg, Moore County, TN 37352'], // … METROPOLITAN GOVERNMENT
      ['10001', 'Times Square, NY 10001'],
      ['99501', 'Anchorage, AK 99501'],
    ];
    for (const [code, label] of cases) {
      test(code, () => {
        const zip = tables.zip(code);
        assert.equal(zip == null ? null : MeshWXZip.label(zip), label);
      });
    }
  });

  test('everyLabelIsTheBots', () => {
    const labels = tables.zipCodes()
      .map((code) => tables.zip(code))
      .filter((zip) => zip != null)
      .map((zip) => MeshWXZip.label(zip));
    assert.equal(labels.length, 33_144);
    assert.equal(sha256(labels.join('\n')), BOT_LABELS_SHA256);
  });

  /** The spec §16.2 cases, as meshwx `tests/test_place_names.py` asserts them for the bot. */
  describe('placeNamesFollowTheLabelRule', () => {
    const cases = [
      ["HELL'S KITCHEN", "Hell's Kitchen"],
      ['CENTRAL 14TH STREET / SPRING ROAD', 'Central 14th Street / Spring Road'],
      ['MCGUIRE AFB', 'McGuire AFB'],
      ['VILLA HUGO II COMUNIDAD', 'Villa Hugo II'],
      ['DOWNTOWN DC', 'Downtown DC'],
      ['H STREET NE', 'H Street NE'],
      ['LA GRANGE', 'La Grange'],
      ['DE QUEEN', 'De Queen'],
      ['VALLEY HI', 'Valley Hi'],
      ['TRUTH OR CONSEQUENCES', 'Truth or Consequences'],
      ['ADJUNTAS ZONA URBANA', 'Adjuntas'],
      ['CABAN COMUNIDAD', 'Caban'],
      ['JUNEAU CITY AND', 'Juneau'],
      ['OLINDA, CDP', 'Olinda'],
      ['MILFORD CITY (BALANCE)', 'Milford'],
      ['NASHVILLE-DAVIDSON METROPOLITAN GOVERNMENT (BALANCE)', 'Nashville-Davidson'],
      ['LEXINGTON-FAYETTE URBAN COUNTY', 'Lexington-Fayette'],
      ['KEARNS METRO TOWNSHIP', 'Kearns'],
      ['CAMERON PARK COLONIA', 'Cameron Park'],
      ['ESTANCIAS DE FLORIDA COMUNIDAD', 'Estancias de Florida'],
      ['PALMAS DEL MAR', 'Palmas del Mar'],
      ['BAYOU LA BATRE', 'Bayou La Batre'],
      ['DEL RIO', 'Del Rio'],
      ['LAKE OF THE WOODS', 'Lake of the Woods'],
      ['MANCHESTER-BY-THE-SEA', 'Manchester-by-the-Sea'],
      ["O'FALLON", "O'Fallon"],
      ["D'IBERVILLE", "D'Iberville"],
      ["LAND O' LAKES", "Land O' Lakes"],
      ['‘EWA GENTRY', '‘Ewa Gentry'],
      ['KAPA‘A', 'Kapa‘a'],
      ['KO ʻOLINA-HONOKAI HALE', 'Ko ʻOlina-Honokai Hale'],
      ['round rock', 'Round Rock'],
    ];
    for (const [raw, shown] of cases) {
      test(raw, () => {
        assert.equal(MeshWXPlaceNames.placeName(raw), shown);
        assert.equal(MeshWXPlaceNames.placeName(shown), shown, 'any casing in, the same out');
      });
    }
  });

  test('titleCasingAloneKeepsSuffixesAndLabelsAddStateAndZip', () => {
    assert.equal(MeshWXPlaceNames.titleCased('ADJUNTAS ZONA URBANA'), 'Adjuntas Zona Urbana');
    assert.equal(
      MeshWXPlaceNames.label({ name: 'SAN JUAN ZONA URBANA', state: 'PR' }), 'San Juan, PR',
    );
    assert.equal(
      MeshWXPlaceNames.label({ name: 'AUSTIN', state: 'TX', zip: '78701' }), 'Austin, TX 78701',
    );
  });

  test('aMissingTableMakesEveryZipUnknown', () => {
    const empty = new MeshWXTables({});
    assert.equal(empty.zip('78701'), null);
    assert.equal(empty.zipCount, 0);
  });

  /** The bot drops a row whose place index is past the end of `places`; so does the app. */
  test('aRowNamingAPlaceTheBundleLacksIsUnknown', async () => {
    const small = await MeshWXTables.from(objectLoader({
      places: { places: [['AUSTIN', 'TX', 30.2711, -97.7437, 961855]] },
      zips: {
        version: 1,
        source: 'test',
        zips: [['78701', 30.2706, -97.7426, 0], ['78702', 30.2634, -97.7151, 9]],
      },
    }));
    assert.equal(MeshWXZip.label(small.zip('78701')), 'Austin, TX 78701');
    assert.equal(small.zip('78702'), null);
    assert.equal(small.zipCount, 2);
  });
});
