# Porting rules: Swift to JavaScript

The web client is a port of the iOS app's weather tool, layer for layer. Several
people (and agents) port different layers at the same time, so the mapping from
Swift to JavaScript is mechanical and fixed here. Two modules written apart must
call each other correctly without either author reading the other's code. When
a rule below is awkward, follow it anyway and leave a note; do not invent a
local convention.

Source of truth, in this order: the wire spec (`docs/MeshWX_v5_Spec.md`, whose Part 2 is the
client rules both clients follow), the test vectors (`docs/meshwx_v5_vectors.json`), the iOS
screen spec (`DigitainoMesh/docs/MESHWX_UI.md`, `docs/MESHWX.md`), then the Swift source.

## 1. Runtime

- Plain ES modules, no bundler, no transpiler, no runtime dependencies. Target
  is current Chromium (desktop and Android). Node 22+ runs the tests.
- Code under `src/meshwx`, `src/weather`, `src/screen` and `src/radio` is
  **pure**: no DOM, no `window`, no `fetch`, no `localStorage`. Anything from
  the platform is injected (a loader function, a clock, a store). These layers
  must import and run under `node --test`.
- Only `src/ui`, `src/app`, `src/platform` and `src/link` may touch browser APIs.
- Tests: `node:test` and `node:assert/strict`, one file per ported Swift test
  file, in `web/test/<SwiftTestFileName>.test.js`. Port the Swift tests, do not
  paraphrase them: same cases, same numbers.
- Comments: keep the Swift doc comments that explain *why* (they record owner
  decisions and field failures). Drop comments that only restate Swift syntax.

## 2. Files and names

- One JS module per Swift file, same base name: `WeatherConditions.swift` →
  `src/screen/WeatherConditions.js`. Directories:

  | Swift | JS |
  |---|---|
  | `MC1Services/Sources/MeshWX/*` | `src/meshwx/` |
  | `MC1Services/Sources/MC1Services/Services/Weather/*.swift` | `src/weather/` |
  | `MC1Services/Sources/MC1Services/Services/Weather/Screen/*` | `src/screen/` |
  | `MeshCore/Sources/MeshCore/*` (the parts we need) | `src/radio/` |
  | `MC1/Views/Tools/Weather/*` (model, builder, copy, formatting) | `src/app/` |
  | `MC1/Views/Tools/Weather/*View.swift` | `src/ui/` |

- Every type keeps its Swift name and is a **named export** of its file's
  module. Each directory has an `index.js` that re-exports everything in it, so
  other layers import from `../meshwx/index.js`, never from a file inside
  another layer.
- Function, property and enum case names are the Swift names, unchanged
  (`lowerCamelCase`).

## 3. Types

- **A Swift struct that is data** is a plain JSON-serialisable object with the
  Swift property names. No classes for data, no methods on data, no
  `undefined` fields: an absent optional is `null` or omitted, and readers
  accept both (`x == null`).
- **Computed properties and methods of a data struct** become functions on the
  exported namespace object, taking the value first:
  `stored.expiresAt` → `WeatherStoredWarning.expiresAt(stored)`. A Swift
  `mutating func` returns the new value instead of mutating (copy the fields
  you change); reducers stay pure.
- **A type that is only static functions** (`enum WeatherConditions { static
  func make … }`) is an exported object of functions:
  `export const WeatherConditions = { make({…}) {…} }`.
- **Initialisers** become `Type.make({...})`, filling the Swift defaults.
- **Actors and classes with state** (`WeatherService`, the stores, the radio
  session) are JS classes. `AsyncStream` becomes either an `EventTarget`-style
  `subscribe(fn) → unsubscribe` or an async iterator; say which in the class
  comment. Prefer `subscribe`.
- **Enums without associated values** are the case name as a string:
  `.outside` → `'outside'`. Export the list when it is iterated:
  `export const WeatherCoverageVerdict = Object.freeze({ inside: 'inside', … })`.
  Enums with a raw value used on the wire keep the raw number and export a
  name table.
- **Enums with associated values** are objects with `kind` set to the case
  name and the associated values under their Swift labels; an unlabelled value
  is `value` (a second one `value2`): `.nearby(reading, nearer: x)` →
  `{ kind: 'nearby', value: reading, nearer: x }`.
- **Optionals**: `null`. **Tuples**: objects with the labels as keys.
- **`Date`** is a number, **milliseconds since the Unix epoch**, everywhere.
  `TimeInterval` stays **seconds**, as in Swift, so conversions are explicit:
  `date + seconds * 1000`. `Date(unixMinutes: m)` is `m * 60000`. Every rule
  that needs "now" takes `now` as a parameter; nothing pure calls `Date.now()`.
- **`Data`** is a `Uint8Array`. Hex strings are lower case without separators.
- **Fixed-width arithmetic**: `&+`/`&-` on `UInt8` is `(a + b) & 0xff`.
  `UInt64` fingerprints are `BigInt` only if the Swift needs all 64 bits;
  otherwise use a string key.
- **Dictionaries**: a plain object keyed by string when the value is persisted
  or crosses a module boundary; a `Map` is fine inside one function. Keys:
  - warning identity `(event, office, etn)` → `"<event>.<office>.<etn>"`,
    decimal numbers, e.g. `"3.35.42"` (`MeshWXWarningIdentity.key(identity)`).
  - bot id, station index, point index, text group: `String(number)`.
- **Sets** are arrays without duplicates when persisted, `Set` otherwise.

## 4. Functions

- A Swift function whose parameters all have labels takes **one object** with
  those labels as keys: `make(place:states:now:)` → `make({ place, states, now })`.
- A leading unlabelled parameter stays positional, before the object:
  `apply(_ message:, to state:, now:)` → `apply(message, { to, now })`.
  When the label and the local name differ, the **label** is the key.
- `throws` throws an `Error` subclass named like the Swift error type, with
  `kind` set to the case name.
- `async` stays `async`.

## 5. Decoded wire messages

The one place that does **not** follow the Swift names. `decode(bytes)` returns
exactly the `decoded` object of `docs/meshwx_v5_vectors.json` (snake_case keys:
`expires_min`, `issued_min`, `areas`, `temp_f` …), and `encode(object)` returns
the vector's bytes. Wherever the Swift holds a `MeshWXWarning`, `MeshWXDigest`,
`MeshWXStationObservation`, `MeshWXForecast`, `MeshWXCoverage`,
`MeshWXAreaSweep.Entry` and so on, the JS holds that decoded object (or the
element of its array). So Swift `stored.warning.expiresMinutes` is JS
`stored.warning.expires_min`. The mapping of Swift field → vector key is listed
at the top of `src/meshwx/MeshWXMessage.js`; read it before touching a message.

Everything around the message keeps Swift names: `WeatherStoredWarning` is
`{ warning, receivedAt, updateCount, seq, issuedAt, source, beginsAt }`.

`source` is the spec's number (0 unstated, 1 GOES, 2 internet, 3 mixed).

## 6. Strings

All user-facing text comes from the iOS app's `Weather.strings`, converted to
`web/strings/<locale>.json` by `tools/strings-to-json.mjs`. Never type English
into a module. Swift `L10n.Weather.Weather.AreaMap.title` is key
`weather.areaMap.title` (SwiftGen capitalised each segment; the key in the
`.strings` file is authoritative, look it up). Call `t('weather.areaMap.title')`
or `t('weather.alert.until', time)` from `src/l10n.js`; arguments fill `%@`,
`%d`, `%1$@` in order. `t` throws on an unknown key under test.

A string the web needs and iOS does not have (Bluetooth pairing, "Connect a
radio") goes in `web/strings/web.en.json` under a `web.` key.

## 7. What not to port

Notifications plumbing (`UNUserNotificationCenter`), SwiftUI layout code,
`OSLog`, SwiftData, the DEBUG simulator bridge wiring. Port the *rules* those
files contain (what notifies, what a row says), not the iOS mechanism.

## 8. The two singletons: tables and outlines

Swift reads the bundle synchronously on first use. A browser cannot, so:

- **`MeshWXTables`** is a class. `await MeshWXTables.load(loader)` reads every
  JSON table, builds the instance, stores it in `MeshWXTables.shared` and
  returns it. After that every lookup is **synchronous**, exactly as in Swift.
  Wherever Swift has a parameter `tables: MeshWXTables = .shared`, JS has
  `tables = MeshWXTables.shared` in the options object.
- **`MeshWXGeometry`** is a class; `MeshWXGeometry.shared` exists from import
  (constructed with the loader given to `MeshWXGeometry.configure(loader)`).
  The two GeoJSON files (14 MB) load only through `await geometry.preload()`
  (both) or `preloadZones()` / `preloadCounties()`. Until a file has loaded,
  lookups that need it answer "not known" the way the Swift does for a missing
  file (`null`, or an empty list), and `isZoneFileLoaded` / `isCountyFileLoaded`
  say so. Callers already treat that as *checking*, never as "not here".
- **`loader`** is `async (fileName) => parsedJSON`, e.g. `loader('index.json')`.
  `src/meshwx/nodeLoader.js` exports `nodeBundleLoader()` for tests, reading
  `meshcore_weather/client_data/` from the repository; the browser's loader
  fetches `./data/<fileName>`. Tests that need tables start with
  `await MeshWXTables.load(nodeBundleLoader())`.

## 9. Layer boundaries

```
ui  →  app  →  screen  →  weather  →  meshwx
               link  →  radio
               app   →  link, platform
               ui    →  radio, but only its pure rules
```

A layer imports only from layers to its right (and `src/l10n.js`). `weather`
never imports `radio`: the service talks to a `WeatherTransport` (the port of
the Swift protocol of that name), and `src/link/` holds the implementations —
the bot's debug bridge, a replay of recorded datagrams, and the radio.

The radio settings screen (`src/ui/radio/RadioSettingsView.js`) is the one
screen that imports `src/radio`, for the preset table, the firmware's ranges,
the heard-event tally and the name of an error code. Rules and names only:
a screen never holds a session or builds a packet, and every byte it causes
goes through `RadioConnection`.
