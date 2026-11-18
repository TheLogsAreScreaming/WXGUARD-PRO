// Port of MC1Services/Tests/MC1ServicesTests/Weather/Screen/WeatherZipPlaceTests.swift
//
// A searched ZIP as the place the screen answers for, and town rows named as the weather bot
// names places (spec §16.2).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { MeshWXZip } from '../src/meshwx/index.js'
import { WeatherNames, WeatherPlace, WeatherPlaceSearch } from '../src/screen/index.js'
import { loadTables } from './helpers/screen-fixture.js'

const tables = await loadTables()

test("a zip is a searched place at its own point with the bot's label", () => {
  const zip = tables.zip('02134')
  assert.ok(zip != null)
  const place = WeatherPlace.zip(zip)
  assert.equal(place.kind, 'searched')
  assert.equal(place.label, 'Allston, MA 02134')
  assert.deepEqual(place.coordinate, { latitude: 42.358, longitude: -71.1286 })
  assert.equal(place.uncertaintyKilometres, WeatherPlace.searched(zip.place).uncertaintyKilometres)
})

test('the zip label is the town row with the zip', () => {
  // A ZIP reads as its town's row does, with the ZIP after it: one rule (spec §16.2) for both.
  const kitchen = tables.zip('10019')
  assert.ok(kitchen != null)
  assert.equal(MeshWXZip.label(kitchen), "Hell's Kitchen, NY 10019")
  assert.equal(WeatherPlace.searched(kitchen.place).label, "Hell's Kitchen, NY")

  const adjuntas = tables.zip('00601')
  assert.ok(adjuntas != null)
  assert.equal(MeshWXZip.label(adjuntas), 'Adjuntas, PR 00601')
  assert.equal(WeatherPlace.searched(adjuntas.place).label, 'Adjuntas, PR')

  for (const code of ['08562', '20010', '00650', '00901', '78701', '96706', '37352']) {
    const zip = tables.zip(code)
    assert.ok(zip != null, code)
    assert.equal(MeshWXZip.label(zip), `${WeatherPlace.searched(zip.place).label} ${code}`)
    assert.equal(WeatherPlace.zip(zip).zipCode, code)
  }
  assert.equal(WeatherPlace.searched(adjuntas.place).zipCode, null)
})

/**
 * SHA-256 of the bot's label for every `places.json` entry, in file order, joined by newlines
 * (`geodata.names.place_label(name, state)`; meshwx `tests/test_place_names.py` pins it too).
 */
const botTownLabelsSHA256 = '26c6cde0f481cca8377b5c491117cd89d41c1e2e9f994281419f4553978e150a'

test('every town row reads as the bot names it', () => {
  const places = tables.places
  assert.equal(places.length, 34_937)
  const labels = places.map((place) => WeatherNames.placeLabel({ name: place.name, state: place.state }))
  assert.equal(createHash('sha256').update(labels.join('\n'), 'utf8').digest('hex'), botTownLabelsSHA256)
})

test('town rows read as the bot names them', () => {
  // Town rows the bot's `resolver` names the same way (meshwx `tests/test_place_names.py`).
  const cases = [
    ["HELL'S KITCHEN", 'NY', "Hell's Kitchen, NY"],
    ['CENTRAL 14TH STREET / SPRING ROAD', 'DC', 'Central 14th Street / Spring Road, DC'],
    ['MCGUIRE AFB', 'NJ', 'McGuire AFB, NJ'],
    ['ADJUNTAS ZONA URBANA', 'PR', 'Adjuntas, PR'],
    ['SAN JUAN ZONA URBANA', 'PR', 'San Juan, PR'],
    ['SAN JUAN', 'PR', 'San Juan, PR'],
    ['VILLA HUGO II COMUNIDAD', 'PR', 'Villa Hugo II, PR'],
    ['AUSTIN', 'TX', 'Austin, TX'],
    ['LA FAYETTE', 'AL', 'La Fayette, AL'],
    ['DE QUEEN', 'AR', 'De Queen, AR'],
    ['DOWNTOWN DC', 'DC', 'Downtown DC, DC'],
    ['BAYOU LA BATRE', 'AL', 'Bayou La Batre, AL'],
    ['MARINA DEL REY', 'CA', 'Marina del Rey, CA'],
    ['LAKE OF THE WOODS', 'AZ', 'Lake of the Woods, AZ'],
    ['MANCHESTER-BY-THE-SEA', 'MA', 'Manchester-by-the-Sea, MA'],
    ["O'FALLON", 'IL', "O'Fallon, IL"],
    ['‘EWA GENTRY', 'HI', '‘Ewa Gentry, HI'],
    ['OLINDA, CDP', 'HI', 'Olinda, HI'],
    ['KEARNS METRO TOWNSHIP', 'UT', 'Kearns, UT'],
    ['NASHVILLE-DAVIDSON METROPOLITAN GOVERNMENT (BALANCE)', 'TN', 'Nashville-Davidson, TN'],
  ]
  for (const [name, state, label] of cases) {
    const place = tables.places.find((one) => one.name === name && one.state === state)
    assert.ok(place != null, `${name}, ${state}`)
    assert.equal(WeatherPlace.searched(place).label, label)
  }
})

// MARK: - What the Places search offers a reader (docs/MESHWX_UI.md §3.1 U-22, U-23)

test('a town the table holds twice is one row', () => {
  // The bundle's own San Juan, PR: the municipio and its zona urbana, which spec §16.2 strips, so
  // both rows read "San Juan, PR" — 7 km apart, and the live search showed both.
  const found = tables.searchPlaces({ query: 'San Juan', limit: 25 })
  const labels = found.map((place) => WeatherNames.placeLabel({ name: place.name, state: place.state }))
  assert.equal(labels.filter((label) => label === 'San Juan, PR').length, 2)

  const rows = WeatherPlaceSearch.collapsingDuplicates(found)
  const kept = rows.map((place) => WeatherNames.placeLabel({ name: place.name, state: place.state }))
  assert.equal(kept.filter((label) => label === 'San Juan, PR').length, 1)
  assert.equal(new Set(kept).size, kept.length)
  // The one kept is the table's first, so the ranking still decides which place a tap opens.
  assert.equal(rows[0]?.name, found[0]?.name)
  // Every other row survives: collapsing is about rows that read alike, not about trimming.
  assert.deepEqual(new Set(kept), new Set(labels))
})

test('two towns of one name far apart are both kept', () => {
  const near = { name: 'SPRINGFIELD', state: 'TX', lat: 30.0, lon: -97.0, population: 100 }
  const far = { name: 'SPRINGFIELD', state: 'TX', lat: 31.0, lon: -97.0, population: 50 }
  const close = { name: 'SPRINGFIELD ZONA URBANA', state: 'TX', lat: 30.02, lon: -97.0, population: 0 }
  assert.equal(WeatherPlaceSearch.collapsingDuplicates([near, far]).length, 2)
  assert.equal(WeatherPlaceSearch.collapsingDuplicates([near, close]).length, 1)
})

test('with nothing to measure from the rows are alphabetical', () => {
  // With no fix and no page to measure from, the rows carry no distance: population order is then
  // an order nobody can read off the screen, so the list goes A to Z instead.
  const places = [
    { name: 'SAN JUAN', state: 'PR', lat: 18.46, lon: -66.1, population: 418_140 },
    { name: 'SAN JUAN', state: 'TX', lat: 26.18, lon: -98.15, population: 36_556 },
    { name: 'SAN JUAN BAUTISTA', state: 'CA', lat: 36.84, lon: -121.53, population: 1_961 },
    { name: 'SAN JUAN', state: 'NM', lat: 36.05, lon: -106.06, population: 592 },
  ]
  const ordered = WeatherPlaceSearch.ordered(places, { hasOrigin: false })
  assert.deepEqual(
    ordered.map((place) => WeatherNames.placeLabel({ name: place.name, state: place.state })),
    ['San Juan Bautista, CA', 'San Juan, NM', 'San Juan, PR', 'San Juan, TX'],
  )
  // With somewhere to measure from, the table's own ranking is what the distances say, and it is
  // left exactly as it came.
  assert.deepEqual(WeatherPlaceSearch.ordered(places, { hasOrigin: true }).map((place) => place.state), ['PR', 'TX', 'CA', 'NM'])
})
