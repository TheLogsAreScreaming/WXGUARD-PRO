# Developing the web client

The MeshWX weather client for Chromium browsers, port for port of the weather tool in the iOS app.
It follows the same documents: the wire spec (`../../docs/MeshWX_v5_Spec.md`), the test vectors
(`../../docs/meshwx_v5_vectors.json`) and the screen spec in the app repository
(`docs/MESHWX_UI.md`). The porting rules are in [PORTING.md](PORTING.md), the UI framework in
[UI_KIT.md](UI_KIT.md), and what a person needs in order to run the thing is in
[../README.md](../README.md).

## Run it

```
node tools/dev-server.mjs          # http://localhost:8137
node --test test/                  # the whole suite
```

No build step, no dependencies, Node 22 or newer. `http://localhost` is a secure context, which
Web Bluetooth and Web Serial require; anywhere else it has to be served over https.

The dev server maps `/data/` to `../meshcore_weather/client_data/`, the same bundle the bot
reads, and proxies `/api/bridge/` to the bot's debug bridge when a token file is present
(`web/.bridge-token`, ignored by git, or `MESHWX_BRIDGE_TOKEN_FILE`). The token is added
server-side and never reaches the page. It also takes the page's own account of its radio link
at `/__devlog` and appends it to `.devlog.jsonl`, which is how a browser tab nobody else can see
is read while hardware is brought up; the page asks whether that path is there before it posts
anything, so the same files served by anything else stay quiet.

## The one-file build

```
npm run single                     # ../dist/MeshWX.html
node tools/single-file.mjs --no-outlines --out /tmp/small.html
```

`tools/single-file.mjs` is the download most people should get: esbuild flattens the module graph
into one classic script, every JSON file the client reads goes into the page as
`<script type="application/json" id="meshwx:<path>">`, and `readJSON` (`src/platform/files.js`)
looks there before it tries the network. Double-clicked, it runs: Chrome treats a `file://` page as
a secure context and gives it Web Bluetooth and Web Serial, while refusing it modules and `fetch`.

Three things that bit, all of them checked by `test/SingleFile.test.js`:

- **`$&` in a replacement string.** `String.prototype.replace` expands `$&` to the match, and the
  client's own `escapeForRegExp` contains one, so the `<script src>` tag being replaced was spliced
  into the middle of the bundle. Every replacement that inserts a file's contents is a function.
- **Raw control characters.** An HTML parser turns a NUL inside a `<script>` into U+FFFD, which
  reversed a range in a regex and threw out the whole file. The build escapes them; `src/radio/`
  no longer writes them literally either.
- **`</script` in embedded JSON.** A script element ends at the first one, wherever it sits, so
  `<` is escaped as `\u003c` in every embedded block. It is never structural in JSON, so the data
  is unchanged.

## Give it to somebody else

They need none of this repository, and nothing the bot needs:

```
npm run package                    # ../dist/meshwx-web/ and ../dist/meshwx-web.zip
node tools/package.mjs --no-outlines --zip
```

`tools/package.mjs` copies this folder and the bundle files it reads into one plain static site:
`index.html`, `src/`, `styles/`, `strings/`, `assets/`, `demo/`, the tables under `data/`, a
README for whoever receives it (`tools/package/README.md`, stamped with the date, the commit and
the bundle version) and a `serve.mjs` that hands the folder to a browser and does nothing else. The test suite has the folder's file list (`test/Package.test.js`): the way this breaks is
quiet, a client that boots and then cannot find one table.

Nothing is bundled, minified or transpiled. What ships is the source in this repository, file for
file, which is also what makes the download readable by the person who runs it.

| | Zipped | Unfolded |
|---|---|---|
| Everything | 5.7 MB | 20.5 MB |
| `--no-outlines` | 1.9 MB | 5.8 MB |

The outlines are `zones.geojson` and `counties.geojson`, 15 MB of zone and county polygons for the
map. A missing bundle file is an empty table to the client, so without them the maps draw the
basemap and the weather and no shapes.

At the other end: unzip, `node serve.mjs`, open `http://localhost:8137`. Anything that serves a
folder does as well (`python3 -m http.server 8137`).

The internet is in none of this. There is no absolute URL in the client, every fetch is
same-origin and relative, and the server listens on 127.0.0.1, so a machine that has never been
online runs it. The one-time file copy needs no network either: a stick, a card, AirDrop, the LAN,
or the Pi handing the zip out over plain http, since a download is not what the secure-context
rule is about. The page that asks for Bluetooth is the one that has to be secure, and it is at
`localhost`.

This is the client for a computer. A phone is the iOS app's job, and the app needs none of this:
no folder, no server, no address. Chrome on Android can run these files too, since it has Web
Bluetooth, but only from an `https://` address, which off-grid means a certificate the phone
already trusts on the local network. Worth knowing if an Android ever has to be served; not a
thing anybody unzips onto a phone.

## Three ways to get weather into it

| Link | What it is |
|---|---|
| Bluetooth, USB | A MeshCore companion radio, firmware 1.15 or newer. A radio has one companion at a time: disconnect it from the phone first |
| Development bridge | The bot's own feed of what it transmits, through the dev server. Requests go out on the real air |
| Recorded data | `demo/datagrams.json`, what WX-AUS sent one morning, replayed with its times moved to now |

## Radio settings

A MeshCore radio hears only the radios that are on **exactly** the same frequency, bandwidth,
spreading factor and coding rate. A factory-fresh one is on the firmware's own default, not on any
mesh, and from a browser it looks perfect: it connects, it answers, it names itself, and it hears
nobody. The radio settings screen is where that is set right — the name, the four radio values from
a preset picker or by hand, transmit power, position, whether the radio adds the contacts it hears,
an advert, and a restart.

It is pushed from the radio pill (connect sheet → **Radio settings**) and from `?open=radiosettings`,
and only for a real radio: Bluetooth, USB or `?link=simulated`. Every card owns one write and
nothing goes out until its own button is tapped; every write re-reads the radio's self info, so
what the fields show afterwards is what the radio says and not what was typed. The radio card also
carries the tally of adverts and messages heard since this page connected — "Heard since
connecting: Nothing" is the cue that the four values are worth checking.

The preset table is the app's `RadioPresets.swift`, 25 entries grouped by region
(`src/radio/RadioPresets.js`); the owner's Austin mesh and the weather bot are on `us-ca`,
910.525 MHz, 62.5 kHz, SF 7, CR 5. Matching a radio to a preset is exact, on the integers the
firmware persists, where the Swift allows a tolerance: a radio 75 kHz off `us-ca` is deaf to it, and
calling it "USA/Canada" would hide the failure the screen exists to show.

## Radar

A place page's Radar card (the screen spec's §18.1, `docs/MESHWX_UI.md` in the app repository) draws one
radar tile: a 2° square of the earth as a 32 × 32 grid of cells, each the strongest echo in it,
cut from the Weather Service mosaics the bot's dish already receives. One tile is one packet, it
is only ever sent when somebody asks, and the tiles sit on a fixed lattice so a picture the radio
next door asked for is this place's picture too.

Tapping the card opens the radar screen: the same cells on an interactive map, with this device's
alerts over them as outlines so neither hides the other, a Light / Moderate / Heavy legend, and a
Local / Regional / Wide control that asks for the same place at zoom 0, 1 or 2. Cells a partial
picture does not reach are hatched and never drawn as dry ground.

The screen also plays the last hour (the screen spec's §18.5). Under the map, for whatever width is on screen, the loop: Play / Pause from two frames (0.8 s each,
the newest 2 s, never by itself), "Ask for the last hour" (`>radar … loop HHMM …`, up to five
packets) while it has fewer than five. `radarTiles` holds frames, one per square and picture. The
screen's decisions are in `radarScreenModel` (`src/ui/radio/WeatherRadarView.js`), tested in
`test/RadarScreenView.test.js`. A saved state that holds tiles off the wire lattice (zoom −1)
loads with them left behind.

`?link=demo` replays three real Austin tiles from the squall line of 20 September 2026 — the
echoes sit in the north-west of the Local tile, which is where Dallas is — and `?open=radar`
opens the radar screen for the page on arrival (the other values are in `openDeepLink`,
`src/app/main.js`).

## Layout

```
src/meshwx    wire codec, bundle tables, place names, ZIPs, outlines     (pure)
src/weather   per-bot state, reducer, requests and retries, the service  (pure)
src/screen    what a screen says: alerts, conditions, coverage, plans    (pure)
src/radio     MeshCore companion protocol, Web Bluetooth and Web Serial
src/link      the service's transports: radio, bridge, replay
src/app       the tool's model, copy and formatting, the connection, boot
src/ui        screens; src/ui/kit is the whole UI framework
strings/      the iOS app's Weather.strings in 11 languages (tools/strings-to-json.mjs)
assets/       basemap.json, state outlines for the offline map (tools/build-basemap.mjs)
```

The pure layers run under Node and carry the ported test suites.
