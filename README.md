# Meshcore Weather

**Off-grid weather for [Meshcore](https://meshcore.co) LoRa mesh networks.** The bot takes NWS EMWIN products (warnings, observations, forecasts, storm reports and more), parses them with canonical NWS tooling, and puts them on a MeshCore channel two ways: compact MeshWX v5 binary datagrams that apps decode offline, and plain-text replies for anyone who sends it a command. In production the products come from a GOES-19 dish received by goestools on a Raspberry Pi, so nothing depends on the internet; NOAA's internet EMWIN feed is the alternative for a bot without a dish.

```
GOES-19 dish ─ goesrecv ─ goesproc ─┐                          ┌─► MeshWX apps: v5 datagrams
  (the Pi, production)              │    ┌──────────────────┐  │   (GRP_DATA on #meshwx)
                                    ├───►│ meshcore-weather │──┤
NOAA EMWIN over the internet ───────┘    │ parse, schedule, │  │
  (the alternative)                      │ answer requests  │  └─► people: text replies
                                         └────────┬─────────┘      (#meshwx and DMs)
                                                  │
                                   admin portal, public dashboard
```

## What this gives you

- **An operator node.** In production: a Raspberry Pi 4 (2 GB) running goestools for the dish and this bot for the mesh, with a MeshCore companion radio on USB, under systemd. Any Linux or macOS box with internet EMWIN works for development.
- **MeshWX v5 for apps.** Warnings with storm tags, polygons and county/zone runs, cancels, an active-warning digest for loss recovery, batched observations, point forecasts, text and "not available", each one MeshCore `GRP_DATA` packet on `#meshwx`. The mesh carries identifiers and numbers; the phone carries the tables. Spec: [`docs/MeshWX_v5_Spec.md`](docs/MeshWX_v5_Spec.md).
- **Two clients.** A native iOS app ([DigitainoMesh](https://github.com/digitaino/DigitainoMesh)) and a web client in this repository (`web/`), which runs in any Chromium browser and talks to a MeshCore radio over Web Bluetooth or Web Serial. Same wire format, same tables, same words: see [The web client](#the-web-client).
- **Text replies for people.** Anyone on `#meshwx` can send `wx austin tx`, `warn TX` or `sat`, on the channel or by DM, and get a text reply, by DM where the bot can reach them. Long replies are paged with `more`. This is how people without the app use the bot.
- **One request grammar for apps and people.** An app sends `>f 102` and gets a binary answer on the channel for every listener; a person sends `forecast austin tx` and gets text. An app's `>` arrives as a flooded Request datagram (v5 type 9), by DM, or as channel text; the answer is the same either way.
- **Delivery confirmation.** The radio hears a repeater's copy of each channel packet the bot sends. When none comes back within the echo window, the packet goes out once more, byte for byte the same, so nobody sees it twice. DM replies wait for the recipient's ACK instead: about 2 s after the request, one at a time per person, one timestamp for all tries (attempts 0 and 1 on the route, then one by flood). A phone's resend of a request is not answered twice.
- **Discovery by advert.** The node is named `WX-<city>` (e.g. `WX-AUS`); apps list adverts whose name starts with `WX-`. No discovery channel, no beacon.
- **A broadcast schedule**: five built-in broadcasts (warnings on change, the digest, observations, the home forecast, the coverage statement), plus what an operator adds in the portal: radar while there is precipitation near home, a forecast for another place, a single airport. Kept in `data/broadcast_config.json`.
- **Radio swaps.** The bot keeps a profile of its node (identity key, name, position, LoRa settings, contacts) and can write it onto a replacement radio, asking first by default. See [`docs/Radio_Swap.md`](docs/Radio_Swap.md).
- **Receiver status on the mesh.** `sat` (or `>sat` from an app) answers with the dish's lock, signal quality, packets dropped in the last minute and the age of the newest EMWIN file, how far behind the uplink the products run when that is half an hour or more (`products ~5h behind`: on 2026-10-16 NOAA replayed a backlog for ten hours while every file was seconds old), and since when the internet fill is filling in. With `MCW_STATUS_CHANNEL` set, the bot also reports trouble unasked: one short line on a status channel of its own when the lock is lost or back, the internet fill starts or stops filling in, or the products fall an hour behind.
- **An admin portal** for the radio, receiver, text bot, schedule, logs and settings, and a **public dashboard** on the Pi that shows the receiver and a redacted live feed of the bot.
- **An accuracy audit.** `scripts/audit.py` compares the bot's answers with api.weather.gov, IEM, aviationweather.gov and SWPC; `deploy/` has an hourly timer for it and the portal's Overview shows the result.
- **CoreScope hooks.** Optional MQTT publishing of every raw packet the radio hears, for the CoreScope packet analyzer (`corescope/`), and an optional CoreScope lookup that records who heard each packet and can veto a resend.
- **Preload bundle** (`client_data/`, about 18 MB, 15 MB of it the optional zone and county polygons) that ships with every app: the office, station and state index tables, zones, counties, places, US ZIP codes, METAR stations, PFM forecast points and the protocol enums.
- **pyIEM-powered parsing** — the reference Python library for NWS text products (VTEC, UGC, polygons), run fully offline with a UGC provider built from the bundled zones.

## Status

| Area | State |
|---|---|
| EMWIN from the GOES-19 dish (goestools, `MCW_EMWIN_SOURCE=sdr`) | production |
| EMWIN over the internet (`MCW_EMWIN_SOURCE=internet`) | works; the alternative for a bot without a dish |
| pyIEM product parsing | shipped |
| MeshWX v5 wire format (`docs/MeshWX_v5_Spec.md`) | shipped |
| Text replies for people, paged with `more` | shipped |
| Echo tracking and one byte-identical resend | shipped |
| DM replies: ACK tries, one reply at a time per person, resends of a request recognised | shipped |
| Radio swap: node profile, adoption, health verdict | shipped |
| Receiver status (`sat`, `>sat`), feed lag, status channel (`MCW_STATUS_CHANNEL`) | shipped |
| Coverage statement (`cov`, `>cov`, broadcast every 3 h) | shipped |
| Radar tiles from the dish's EMWIN radar pictures (`radar`, `>radar`), the last hour as a loop; broadcast while there is precipitation near home, if the operator adds it | shipped |
| Admin portal and public dashboard | shipped |
| Accuracy audit (`scripts/audit.py`) | shipped |
| MQTT packet publishing for CoreScope | shipped, off by default |
| iOS client | in beta |
| Web client (`web/`), Chromium over Bluetooth or USB | shipped |
| A downloadable copy of the web client (`web/tools/package.mjs`) | shipped |
| Standalone e-ink dashboard | idea parked in `docs/Future_EInk_Dashboard.md` |

## The web client

`web/` is the whole weather tool as a web page: alerts, conditions, forecasts,
the area map and radar, from a `WX-` bot over a MeshCore radio on **Web
Bluetooth** or **Web Serial**. It is a port of the iOS tool layer for layer and
follows the same documents, so the two say the same things in the same words.
No build step, no dependencies, no internet: the tables, the map outlines and
the eleven languages are all in the folder, and after the first visit the
browser keeps it and it works offline.

What a person needs:

| | |
|---|---|
| A computer, and a browser on it | Chrome, Edge, Brave or Vivaldi on macOS, Windows, Linux or Chrome OS. Safari and Firefox have no Web Bluetooth or Web Serial |
| A radio | A MeshCore companion radio, firmware 1.15 or newer, over Bluetooth or USB. A radio talks to one companion at a time, so it has to be disconnected from the phone's MeshCore app first |
| A bot in reach | Any `WX-` node on `#meshwx`. Without one there is still the recorded morning in the connect panel |
| Nothing else | `MeshWX.html` is double-clicked and runs. The folder version wants Node or Python to hand it to the browser, and the page then has to come from `http://localhost` |

From this checkout, for development:

```bash
cd web
node tools/dev-server.mjs          # http://localhost:8137
node --test test/                  # the suite
```

The dev server serves `/data/` straight out of `meshcore_weather/client_data/`,
so a table the bot regenerates is on the page at the next reload, and it
proxies the debug bridge. Details, and the porting rules, in
[`web/README.md`](web/README.md).

### Giving it to somebody else

Nothing installed, no terminal, no server, no internet:

```bash
cd web
npm run single                     # dist/MeshWX.html, about 20 MB
npm run package                    # dist/meshwx-web/ and dist/meshwx-web.zip, the folder version
```

**`MeshWX.html`** is the whole client in one file: the modules bundled into one
script, and every table, the basemap and the eleven string tables embedded as
`<script type="application/json">` blocks, which `readJSON`
(`web/src/platform/files.js`) reads before it tries the network. Somebody
double-clicks it and it runs. That works because Chrome counts a `file://` page
as a secure context and gives it Web Bluetooth and Web Serial, while refusing
it modules and `fetch` — measured, not assumed (from disk: `secureContext:
true, bluetooth: true, serial: true`, 34,937 places read out of the page
itself). It is the only artifact that is not this repository's files as they
are, and nothing in it is minified.

**`meshwx-web.zip`** is the same client as ordinary files, with a README, a
small `serve.mjs` and `start-macos.command` / `start-windows.bat`. It wants
Node or Python and a command, and it is there for anyone who would rather serve
the files, host them, or read them. 5.7 MB, 20.5 MB unfolded; `--no-outlines`
leaves out the zone and county polygons for 1.9 MB, and the maps then draw
without the shapes.

Both are attached to the
[latest release](https://github.com/digitaino/meshwx/releases/latest), which is
the link to give people: [`web/README.md`](web/README.md) is written for them.

None of it touches the internet, which is the point. The client holds no
absolute URL, every fetch it makes is same-origin and relative, and the one
file fetches nothing at all. Getting it to somebody wants no network either: a
USB stick, an SD card, AirDrop, a share on the LAN, or a Pi on the mesh handing
it out over plain http.

## Wire format at a glance

The whole protocol, byte by byte, with the requests, the bundle and the
rules a client follows, is **[`docs/MeshWX_v5_Spec.md`](docs/MeshWX_v5_Spec.md)**.
This is the summary.

Every message is one MeshCore `GRP_DATA` packet (`data_type 0xFF10`) on
`#meshwx`, with a 4-byte header: a sequence number, the first two bytes of
the bot's public key, and the message type (high nibble) with flags (low
nibble). Little-endian throughout; times are Unix minutes. A decoder reads up
to 165 bytes, the transport's limit; a bot sends at most 157, so that it can
hear a repeater pass each packet on, and sends a packet once more, byte for
byte, when it hears no echo.

| Type | Message | Size | When |
|---|---|---|---|
| 1 | Warning: VTEC event, office, ETN, absolute expiry, storm tags, polygon and/or county or zone runs, issue time, and the start when it takes effect later | 15 B + polygon + runs + 2 or 4 (a typical storm warning is 53 B) | on change; a new tornado, severe thunderstorm, flash flood or extreme wind warning once more about two minutes later |
| 2 | Cancel | 8 B | when a warning ends before its expiry |
| 3 | Digest: up to 25 active identities with their expiry, plus feed health | 10 B + 6 per warning | every 3 h, a minute after a cancel, on request |
| 4 | Observations: up to 12 stations in one packet, each with its own age | 9 B + 11 per station + the ages | hourly, on request |
| 5 | Forecast: up to 7 whole days for a PFM point | 12 B + 5 per day | every 6 h for the home point, on request |
| 6 | Text: warning narrative, forecast discussion, space weather, storm reports, rainfall, METAR/TAF, outlook, receiver status | up to 8 chunks of 149 B of text | on request only |
| 7 | Not available | 6 B | answer to a request the bot cannot serve |
| 8 | Coverage: centre, radius, NWS offices and the zone runs this bot carries | 14 B + 1 per office + 4 per run | every 3 h, on request |
| 9 | Request: an app's `>` request, the one message that travels app -> bot | 14 B + the text (a `>d` is 16 B) | sent by the app, flooded on `#meshwx` |
| 10 | Area sweep: what is active, for the country or the states asked about, as runs of UGC numbers | up to 8 packets of 36 runs | on request only |
| 11 | Radar: one tile of a radar picture, 32 x 32 cells in four precipitation levels | always one packet, 13 to 157 B | on request; each new picture while there is precipitation near home, if the operator adds it |

Requests start with `>` and are normally flooded on `#meshwx` as a Request
datagram, which names the bot it asks; a DM and channel text work too. The
answer is the same either way: v5 messages flooded on `#meshwx`, to
everyone, so one request serves every app listening.

| Request | Answer |
|---|---|
| `>d` | Digest |
| `>w`, `>w SV.W.EWX.42`, `>w TXC453`, `>w TXZ192` | Warnings in coverage then a Digest; one warning by identity; or the warnings touching a county or zone |
| `>wt SV.W.EWX.42` | That warning's narrative as Text |
| `>wmap`, `>wmap all`, `>wmap TXOK` | Area sweep: warnings and watches, with advisories, or only for some states |
| `>part 212 1,4,6` | Those packets of a multi-packet answer again |
| `>o`, `>o KAUS` | Observations for the coverage stations, or for one station (or the nearest that reports) |
| `>f`, `>f 102`, `>f round rock tx`, `>f 78701`, `>f 35.687,-105.938` | Forecast for the home point, a point index, a place, a ZIP or a coordinate |
| `>afd EWX`, `>metar KAUS`, `>taf KAUS`, `>space`, `>storm TX`, `>rain TX`, `>hwo` | Text products |
| `>radar`, `>radar 30.270,-97.740 z1`, `>radar austin tx loop` | A radar tile, wider with `z1` to `z3`, or the last hour of it as a loop |
| `>sat`, `>cov` | The bot's receiver as one line of Text; what the bot covers |

Limits, by default: one request per sender every 2 s and 240 answer packets
an hour across all senders, then "busy" (Not available, reason 4). The
operator sets them on the portal's Text bot page. A throttled request gets
no reply.

## For client developers (iOS, web, embedded)

Start and finish with **[`docs/MeshWX_v5_Spec.md`](docs/MeshWX_v5_Spec.md)**:
Part 1 is the wire format, the requests and the bundle; Part 2 the rules
the reference clients follow for storing, showing and asking; section 23 is
a checklist. Decode the test vectors
([`docs/meshwx_v5_vectors.json`](docs/meshwx_v5_vectors.json)), ship the
`client_data/` bundle, and send requests as Request datagrams. The
reference codec is
[`meshcore_weather/protocol/v5.py`](meshcore_weather/protocol/v5.py),
standard library only.

Two implementations to read against it, both complete and both carrying the
vectors as tests: the iOS app in
[DigitainoMesh](https://github.com/digitaino/DigitainoMesh) and the web client
in [`web/`](web/README.md), which is the smaller of the two to read and needs
nothing but a browser to run.

| Bundle file | Contents (spec section 16) |
|---|---|
| `protocol.json` | Version, the `v5` block (message types, flags, limits, sentinels, radar products), event codes and names, sky codes |
| `index.json` | The tables the wire indexes into: `offices` (the 125 WFOs in alphabetical order, then `NHC` at 125 and `WNS` at 126), `stations`, `states`. Append-only |
| `stations.json`, `pfm_points.json`, `places.json` | Station, forecast point and place lookup |
| `zips.json` | US ZIP (Census 2020 ZCTA) to its point and nearest place; the bot resolves ZIPs from the same table |
| `zones.json`, `counties.json` | Names and centroids for zone and county codes |
| `zones.geojson`, `counties.geojson` | Polygons; optional downloads |
| `wfos.json` | Office states and positions, in `index.json` `offices` order |
| `regions.json`, `state_index.json`, `weather_dict.json` | Not used by MeshWX v5 |

`index.json` and the test vectors are generated by `scripts/v5_vectors.py`;
never edit them by hand. `protocol.json` is kept by hand next to the codec.

### The debug bridge: an app client with no radio

A development client (the iOS app in a simulator, a script, a web page on
your laptop) can be a live client of a **real** bot without a radio: it
reads the datagrams the bot transmits and asks for one through the same
path a DM takes. Requests are not simulated — `AppResponder.handle_request`
runs, the per-sender spacing and the hourly budget apply, and the answer
goes on the air to everybody as usual, which is why the client sees it.

Off unless **both** `MCW_PORTAL_ENABLED=true` and `MCW_BRIDGE_TOKEN` are
set. Every call carries the token in `X-Bridge-Token` (or
`Authorization: Bearer …`); a bridge that is off answers 404. Bind the
portal to localhost and reach it through an SSH tunnel — nothing here is
meant to face a network.

| Call | What it does |
|---|---|
| `GET /api/bridge/stream?since=<cursor>` | SSE. One JSON frame per datagram transmitted — `cursor`, `ts`, `ts_iso`, `data_type`, `hex`, `length`, `resend`, `attempt` — after the stream's `{"hello": true}`. The last 200 datagrams are kept, so `since` resumes where you left off |
| `GET /api/bridge/datagrams?since=&limit=` | The same ring as one JSON page: `datagrams`, `cursor`, `latest`, `gap` (`true` when what you missed has already left the ring) |
| `POST /api/bridge/request` | `{"text": ">o KAUS", "client": "sim"}`. Always 200 with `outcome`: `sent` (with `packets`, `bytes`), `rate_limited` (with `retry_after`) or `budget_spent`. The client id is the sender, so two clients are two senders. Like every portal POST it also needs `X-Requested-With: meshcore-portal` |
| `GET /api/bridge/info` | The bot's name, public key, bot id, channel and data type |

The feed is hooked at the one choke point every datagram passes through
(`MeshcoreRadio.send_channel_data`), so its bytes are exactly what went on
the air, sequence number already stamped, and an echo resend shows up as its
own frame with `resend: true`.

On the bot (the Pi's `.env`):

```bash
MCW_PORTAL_ENABLED=true
MCW_PORTAL_HOST=127.0.0.1      # the tunnel's far end; never 0.0.0.0 for this
MCW_BRIDGE_TOKEN=<a long random string>
```

From your laptop — the remote port is whatever `MCW_PORTAL_PORT` says (the
receiver Pi runs the portal on 8081, because 8080 there is the goestools
dashboard):

```bash
ssh -N -L 8080:127.0.0.1:8080 digitaino@mesh-wx.digitaino.com   # Pi: …:127.0.0.1:8081
curl -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8080/api/bridge/info
curl -N -H "X-Bridge-Token: $TOKEN" http://127.0.0.1:8080/api/bridge/stream
curl -H "X-Bridge-Token: $TOKEN" -H "X-Requested-With: meshcore-portal" \
     -H "Content-Type: application/json" -d '{"text":">cov","client":"sim"}' \
     http://127.0.0.1:8080/api/bridge/request
```

The iOS app takes the same two values from its launch environment
(`MESHWX_BRIDGE_URL`, `MESHWX_BRIDGE_TOKEN`) and uses them instead of the
radio; see `RemoteBotWeatherTransport` in the app repo.

## For operators

### Configure your coverage once via `.env`

```bash
# The first city is the home point: the radius centre and the home forecast.
MCW_HOME_CITIES=Austin TX
# Every forecast zone within this many km of the home point.
MCW_HOME_RADIUS_KM=120
# Optional: whole states and whole NWS offices on top.
MCW_HOME_STATES=TX,OK
MCW_HOME_WFOS=EWX,FWD
```

Coverage decides which warnings the scheduled broadcasts and the bare `>w`
carry; the observation stations are the ones within the radius of the home
point. Commands and requests that name a place are answered nationwide.

Coverage **fails closed**. A home city that does not resolve, a bare name
that is a place in several states (`Austin` is in seven: write `Austin TX`),
or an unknown state or office code is an error: logged as `Coverage error:`
at start, shown on the portal's System page and by `meshcore-weather
--check`, and until it is fixed the scheduled warnings, digest, observations
and coverage statement send **nothing**. So does a bot with no coverage at
all. To broadcast every warning in the country you have to say so:
`MCW_COVERAGE=national`. If a coverage rebuild fails while the bot runs, it
keeps the last good one. At start the log says what it built:

```
[INFO] meshcore_weather.protocol.coverage: Coverage: 36 zones, 36 counties (120 km around 30.27,-97.74, 1 cities)
[INFO] meshcore_weather.protocol.coverage: Home point: Austin, TX (30.2672, -97.7431)
```

The portal refuses a home city that does not resolve before it reaches
`.env`, and a live change of the home city moves the home point (the radius
centre, the observations, the home forecast and how bare place names are
ranked) and, when `MCW_TIMEZONE` is empty, the time zone with it.

### The default schedule

On first start the bot writes `data/broadcast_config.json` with five jobs.
Radar can be added (below); everything narrative is request-only.

| Job | Every | Sends |
|---|---|---|
| `warnings` | 2 min | New and changed warnings in coverage, a Cancel for one that ended early, and one repeat of a tornado, severe thunderstorm, flash flood or extreme wind warning 90 s later |
| `digest` | 180 min | The active-warning Digest (also a minute after any Cancel) |
| `observations` | 60 min | One packet for up to 12 stations within the radius that reported in the last 120 min |
| `forecast` | 360 min | The forecast for the home point (location `home`: the first home city, resolved when the job runs) |
| `coverage` | 180 min | The Coverage statement: centre, radius, offices and zones this bot carries |

The scheduler checks every 30 s and spaces packets 2 s apart; the radio
keeps the same gap between any two transmissions, resends, text replies
and DMs included. A job's
location is `coverage`, `city`, `pfm_point` or `station` (observations for
one station). A `radar` job also carries `min_level` (1 any precipitation, 2
moderate and heavier, 3 heavy) and `within_km` (absent: the coverage radius).
A v4 job file is migrated when it loads: retired products are
dropped and a forecast job runs no more often than every 3 h. A forecast job
that names the configured home city (`Austin TX`, as every file written
before 2026-10-17 does) becomes the `home` job when it loads, so a copied
file never forecasts somebody else's city.

Two guards hold whatever the schedule says:

- **A ceiling**: `MCW_SCHEDULED_PACKETS_PER_HOUR` (120) packets an hour for
  every scheduled job together. Tornado, severe thunderstorm, flash flood
  and extreme wind warnings and their one repeat always go out (and count);
  past the ceiling everything else waits for room, keeps its state and goes
  out later. The log says so once an hour, and the Mesh tab's Limits and
  cooldowns shows it as "Scheduled broadcasts".
- **Restarts are quiet**: when each job last ran, the hour's count and the
  last advert are kept in `data/warning_state.json`, so a restart (or a
  reconnect of the radio) sends no digest, observations, forecast, coverage
  statement or advert that was not due anyway. Each periodic job's first run
  after a start also waits a few minutes, by an offset taken from the node's
  public key, so two bots that boot together do not stay in step.

### Then manage everything else from the admin portal

The portal (`MCW_PORTAL_PORT`, 8081 on the Pi) is one page with six tabs,
grouped by job the way the public dashboard is, and it shares that page's
look. Every `.env` setting is under Settings; what is applied to the node
itself (name, LoRa, transmit, channel slots, contacts) stays under Radio.

| Tab | What it shows | What you do there |
|---|---|---|
| **Overview** | Four status cards (bot, radio, dish and feed, host); **Needs attention**, the short list of what to act on (radio down or unwell, transmit off, no lock, a late feed or the internet fill at work, configuration problems, errors in the log, a stale or failing audit, a full disk), each linking to the tab that fixes it; the last 24 hours on the mesh; the accuracy audit. Refreshes every 15 s; the header repeats dish, radio and transmit on every tab. | nothing |
| **Mesh** | Request/reply counters and the live feed of the channel and DMs (with why a request was not answered); the scheduled broadcast jobs with last/next run and bytes, and the data channel log; every limit and cooldown with where it stands; a "try a command" box that runs the DM path, and the `help` text | jobs (add, edit, on/off, run now, delete), "run due jobs", reset a limit |
| **Radio** | Health verdict and counters, the node (link, frequency, power, battery), LoRa parameters, hardware and the saved profile, all channel slots, the contact table with housekeeping status | test transmit, adopt a replacement radio or start a new profile, node name and location, LoRa preset or parameters, TX power, transmit on/off, advert, reboot, the text and data channel names, contact housekeeping |
| **Station** | The receiver: lock, Viterbi errors and drops over the last 15 minutes, goesrecv and goesproc; while the dish is aimed, the live signal meter and spectrum; the EMWIN feed's last hour and what the internet fill took | pointing / receive mode, the meter's tuner gain and peak (the public page offers these only on the home network) |
| **Settings** | Every setting the portal may write, in groups: replies, delivery, limits, coverage, feed and internet fill, radio link, CoreScope, host. Each field says whether it applies at once or after a restart; "Show help" opens every field's explanation. | edit, then one Save bar lists the changes; restart the bot |
| **Logs** | The live log of the satellite, radio and bot parts, filterable by part, level and text | pause, clear |

Settings are written to `.env` and applied live where the bot can (the
response says which keys need a restart). Values are validated before the
file is touched. The portal has no login, so it listens on `127.0.0.1` by
default (`MCW_PORTAL_HOST`): from another machine, open an SSH tunnel
(`ssh -N -L 8081:127.0.0.1:8081 you@the-pi`, then `http://localhost:8081`).
It answers only requests whose `Host` is `localhost`, `127.0.0.1`, `[::1]`,
its bind address or a name in `MCW_PORTAL_ALLOWED_HOSTS` (anything else gets
400, which is what stops a DNS-rebinding page), and every state-changing
request must carry the header `X-Requested-With: meshcore-portal`, so a web
page opened in someone's browser cannot change anything.

## Quick start

### With Docker

```bash
git clone https://github.com/digitaino/meshwx.git
cd meshwx
cp .env.example .env
# Edit .env: MCW_HOME_CITIES, MCW_ADMIN_KEY (leave the channels on #meshwx)
docker compose run --rm meshcore-weather --check
docker compose up -d meshcore-weather
```

`docker-compose.yml` also defines the CoreScope stack (`mosquitto`,
`corescope`, `obs-broker`), which needs its own git-ignored configuration
under `corescope/`; naming the service starts the bot alone. The compose
file points the bot at `tcp://host.docker.internal:4403`, a TCP bridge to
the radio on the host: on macOS `scripts/start.sh` runs socat for it and
then starts the whole compose stack. The portal is on
`http://localhost:8080` when `MCW_PORTAL_ENABLED=true`, published on the
host's `127.0.0.1` only: inside the container the compose file sets
`MCW_PORTAL_HOST=0.0.0.0` (Docker forwards the published port to the
container's own address, not its loopback), and the `ports:` line keeps it
off the LAN.

### Without Docker

Needs a **64-bit OS** (Raspberry Pi OS 64-bit, Debian or Ubuntu arm64 or
x86_64, macOS) and **Python 3.11 or newer**. The scientific wheels pyIEM
pulls in, and `psycopg[binary]` (which brings its own libpq, so no
`apt install libpq5`), have no builds for 32-bit ARM.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[portal]"
cp .env.example .env
# Edit .env
meshcore-weather --check
meshcore-weather
```

On start the bot loads its geodata, connects to the radio (or retries every
minute until one answers), starts the scheduler once a data channel is up,
and starts the portal if enabled. The EMWIN products come in **behind** the
radio: the node is listening within seconds of a restart, and the backlog
already on disk (`internet`: NOAA's 1-hour bundle, then the 2-minute bundle
every `MCW_EMWIN_POLL_INTERVAL` seconds; `sdr`: the goesproc directory) is
read and parsed in a worker thread while it listens.

Until that backlog is in — a few seconds for the internet source, up to a
couple of minutes for a Pi with tens of thousands of files:

- a DM that needs products is answered "Starting up: my weather products
  are still loading. Ask again in a minute." without spending any of that
  sender's hourly reply budget (a command on the channel gets the same
  sentence, and is rate-limited as a channel reply always is);
- a `>` request — by datagram, by DM or as channel text — is answered Not
  available, reason 0 (no data yet), off the hourly packet budget, so the
  app's own retry still gets a real answer;
- `help`, `cov` and `sat` are answered normally: none of them reads a product;
- the scheduler broadcasts nothing, so no digest, observation or coverage
  message is ever built from an empty store.

### First-run verification

On the first start you should see log lines like these (slot numbers vary):

```
[INFO] meshcore_weather.geodata: Location data loaded: 4029 zones, 34937 places, 2237 stations
[INFO] meshcore_weather.main:   Time zone: America/Chicago (from the home city's state (TX))
[INFO] meshcore_weather.protocol.coverage: Coverage: 36 zones, 36 counties (120 km around 30.27,-97.74, 1 cities)
[INFO] meshcore_weather.protocol.coverage: Home point: Austin, TX (30.2672, -97.7431)
[INFO] meshcore_weather.meshcore.radio: Listening on channel 1 (#meshwx)
[INFO] meshcore_weather.meshcore.radio: Data channel 1 (#meshwx, shared with text)
[INFO] meshcore_weather.main: Meshcore radio connected 10.4 s after start
[INFO] meshcore_weather.schedule.store: Bootstrap schedule: 5 default jobs
[INFO] meshcore_weather.schedule.scheduler: Broadcast scheduler started: 5 jobs, tick every 30s
[INFO] meshcore_weather.schedule.scheduler: Broadcasts held until the product backlog is loaded
[INFO] meshcore_weather.portal.server: Portal running at http://127.0.0.1:8080 (answers Host: localhost, 127.0.0.1, [::1], ::1)
[INFO] meshcore_weather.main: Weather bot is running. Listening on channel 1 (#meshwx) + DMs
[INFO] meshcore_weather.main: Backlog loaded: 14508 products in 39.3 s
```

`Meshcore radio connected … after start` is how long the node was off the
air, and `Backlog loaded` is when the answers became real ones. A stop
(`systemctl stop`, Ctrl-C, or Restart from the portal) cancels every task,
logs `Weather bot stopped` and exits 0.

Any `[ERROR]` line before `Weather bot is running` is a configuration
mistake: `Coverage error:` (nothing is broadcast until it is fixed),
`Radio: … outside the US band` (transmit is switched off), `MCW_ADMIN_KEY
ignored`. A `Node name: … WX-<IATA>` warning means apps will not find the
bot by name.

Open `http://localhost:8080/#broadcasts` to see the five jobs, and type
`help` or `wx austin tx` into Mesh > Try a command.

## CLI tools

`meshcore-weather-cli` runs the bot's code without the mesh:

```bash
meshcore-weather-cli fetch              # Load products from the configured EMWIN source and list them
meshcore-weather-cli query "Austin TX"  # The wx reply for a place, from those products (no radio)
meshcore-weather-cli interactive        # Type commands as a person would; "more" pages, "sat" reads the receiver
meshcore-weather-cli sat                # The sat reply: one read of the goestools dashboard, no products loaded
meshcore-weather-cli check              # Same as meshcore-weather --check (below)
meshcore-weather-cli contacts           # List the contacts on the radio
meshcore-weather-cli remove <name>      # Remove a contact by name
meshcore-weather-cli clear-contacts     # Remove every contact
```

The last three open the radio themselves; stop the bot first.

`meshcore-weather --check` (`--no-radio` to leave the radio alone) reads the
configuration the bot would start with and prints one line per check: home
city and coverage, home point, time zone, EMWIN source and directory, serial
port, channels, radio region, ceiling, reply mode, admin key, portal bind,
and the node's name and frequency when it can read them. It exits 1 if any
line is an `ERROR`. It never transmits: the node is read from the running
bot's portal on this machine, or by opening a serial port no other process
holds (APP_START only); a port the bot holds is left alone.

## Running on the receiver Pi (no Docker)

The production shape is one Raspberry Pi running goestools for the dish and
this bot for the mesh, radio on USB. Docker is not needed there (and a 2 GB Pi
has no room for the image build); a venv is enough:

```bash
git clone https://github.com/digitaino/meshwx.git ~/meshcore-weather
cd ~/meshcore-weather
python3 -m venv .venv && .venv/bin/pip install -e ".[portal]"
cp deploy/pi.env.example .env        # edit: serial port, home city, admin key (TX stays off)
.venv/bin/meshcore-weather --check   # exit 1 on any error; never transmits
sudo cp deploy/meshcore-weather.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now meshcore-weather
journalctl -u meshcore-weather -f
```

The unit runs as `digitaino` from `/home/digitaino/meshcore-weather`; change
`User`, `WorkingDirectory`, `EnvironmentFile` and `ExecStart` for another
account. systemd reads `.env` as well, and it does not strip comments after
a value, so keep comments on their own lines.

`MCW_EMWIN_SOURCE=sdr` makes the bot read goesproc's `emwin/YYYY-MM-DD/` tree
directly; the internet is only the backup while the dish is quiet.
`MCW_SDR_DASHBOARD_URL` (`http://127.0.0.1:8080`) is the goestools dashboard
that the `sat` reply, the receiver log lines and the portal's Station tab read:
keep it the local address, and put the dashboard's public hostname in
`MCW_SDR_DASHBOARD_PUBLIC_URL` for the links people see. The bot starts without a
radio and keeps retrying every minute, trying `/dev/meshcore` and every USB
serial port when the configured one does not answer, so the radio can be
plugged in later. To try text commands from the Pi's shell:

```bash
.venv/bin/meshcore-weather-cli interactive
.venv/bin/meshcore-weather-cli sat      # GOES receiver status, as the sat command replies
```

The rest of `deploy/`:

| File | What it is |
|---|---|
| `99-meshcore-radio.rules` | udev rule: `/dev/meshcore` for any supported USB radio board |
| `meshcore-weather-audit.service`, `meshcore-weather-audit.timer` | `scripts/audit.py` hourly, results in `data/audit.json` for the Overview |
| `goes-dashboard/` | The public page (below) |
| `goes-cleanup/` | Hourly retention for goestools output: images 1 day, EMWIN and text 3 days, oldest days removed while the disk is over 70 % |

The audit timer is installed like the bot's unit:

```bash
sudo cp deploy/meshcore-weather-audit.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now meshcore-weather-audit.timer
```

### Updating the Pi

The Pi's checkout tracks `main` on GitHub over HTTPS (the repository is
public, so the Pi needs no key). Push to GitHub, then:

```bash
ssh digitaino@mesh-wx.digitaino.com meshcore-weather/scripts/pi_update.sh
```

It fetches, refuses to run over tracked files edited on the Pi, stops the
bot, checks out the new commit, reinstalls when `pyproject.toml` changed,
checks that the code imports (and goes back to the old commit if it does
not), and starts the bot again. It prints the commit to roll back to
(`pi_update.sh <commit>`). Files git ignores stay as they are: `.env`,
`data/`, `.venv`, CoreScope's config, passwords and bundles.

The node is deaf only between the stop and the radio connect of the new
process — seconds, not the time the product backlog takes (see *First-run
verification*). `journalctl -u meshcore-weather` shows the two numbers that
matter, `Meshcore radio connected … after start` and `Backlog loaded`.

### The public page (port 8080)

The goestools dashboard on the Pi (`deploy/goes-dashboard/`, installed as
`~/goes/dashboard.py` + `dashboard.html`, `goes-dashboard.service`) is the
public, read-only page: receiver stats and imagery, plus a card that explains
the mesh weather bot and how to reach it, its request/reply counters, and a
live feed of what it sees on its channel. That card is fed by the admin
portal's `/api/public/bot` bundle (read from `BOT_URL`, default
`http://127.0.0.1:8081`), proxied at `/api/bot` on the same port, so the
portal itself never has to be exposed. DMs are redacted in the bundle
(command and reply length only), and it carries no key and no position, the
bot's or its peers' ([`docs/Security_Notes.md`](docs/Security_Notes.md)).
Its `feed` object says where the products come from (the dish, and what the
internet fill took from NWS because the dish had not brought it in time,
with why, its last good fetch and its errors) and how far behind the uplink
they run (`lag_min`, the median over the dish's last 50 files of
the last hour; times in the bundle are Unix seconds), and the card shows
both.

The page has three tabs. Overview is the above. Weather is everything to look
at: a warnings map drawn from the portal's `/api/public/warnings` (every active event the bot holds, as outlines, and the
area it covers; proxied at `/api/warnings`) over a Natural Earth base map from
goestools' own files, radar loops and charts from the EMWIN and HRIT images, an
imagery viewer that loops the last 3, 6 or 24 hours of every sector and channel
goesproc writes (`imagery.py`; the 1080 px loop frames of the last six hours are
made ahead in the thumbnail cache), and a browser over the last two days of
products on disk (`emwin_tab.py`, office names from `offices.json`). Station is
everything about whether the dish and the feed work, from 7 days of history
(`station_history.py`, kept in `~/goes/history.db`): a health row, the live
signal, signal history, the EMWIN feed's delay and volume, traffic per virtual
channel, and one list of events with the sun-outage predictions. The old
`#hrit` and `#emwin` addresses land on Station and Weather. To update the page:

```bash
scp deploy/goes-dashboard/{dashboard.py,dashboard.html,station_history.py,emwin_tab.py,imagery.py,offices.json} digitaino@mesh-wx.digitaino.com:goes/
ssh digitaino@mesh-wx.digitaino.com sudo systemctl restart goes-dashboard
```

The admin portal's Mesh tab shows the same feed unredacted (sender names,
DM text, admin and console commands, and why a request was not answered).

## Running a bot in another city

A weather bot spends airtime on a mesh other people built, so a new one
starts quiet and checked. In order:

1. **A radio of its own**, not your phone's companion: flashed with the
   MeshCore **companion (USB)** firmware, version 1.15 or newer, on your
   mesh's local preset (in the US the MeshCore default, 910.525 MHz,
   62.5 kHz, SF7). Name it `WX-<IATA>`, the code of your nearest airport
   (`WX-DEN`, `WX-SAT`); listen for adverts first and make sure nobody near
   you already uses that name. Apps find bots by the `WX-` prefix, and the
   bot warns at start (and in `--check`) about a name off the convention.
2. **Install** on a 64-bit OS with Python 3.11+ (*Without Docker* above, or
   *Running on the receiver Pi* below).
3. **Copy `.env.example` to `.env`** (on a receiver Pi, `deploy/pi.env.example`).
4. **`MCW_HOME_CITIES="City ST"`**, your city and state, then run
   `meshcore-weather --check`: the Coverage and Home point lines must be
   the place you meant. A bare name or a typo is an error, and the bot sends
   nothing scheduled until it is fixed.
5. **`MCW_HOME_RADIUS_KM`** = how far your mesh really reaches, not how far
   you would like it to. Warnings for the whole circle go to everyone on it.
6. **`MCW_TIMEZONE`**: empty takes your state's zone; set it if your state
   has two (the check says so).
7. **The serial port**: `MCW_SERIAL_PORT=/dev/ttyUSB0` (or `/dev/ttyACM0`),
   or install `deploy/99-meshcore-radio.rules` for a stable `/dev/meshcore`,
   and put the bot's user in the `dialout` group.
8. **The portal stays on `127.0.0.1`** (the default). Reach it with
   `ssh -N -L 8081:127.0.0.1:8081 you@the-bot` and `http://localhost:8081`.
   It has no login; do not put it on the LAN or the internet.
9. **`MCW_ADMIN_KEY`** = the first 12 hex characters of *your own* public
   key (your phone's, as the bot logs it with every DM). Shorter than 8 is
   refused.
10. **Leave the channels on `#meshwx`.** Every bot and app uses that one
    name (*When two bots meet*, below).
11. **The feed**: `MCW_EMWIN_SOURCE=internet` (NOAA's bundles; set
    `MCW_OPERATOR_CONTACT` to your email) needs nothing else; `sdr` needs
    your own GOES dish and goestools writing EMWIN into `MCW_SDR_EMWIN_DIR`.
12. **Start with transmit off** (`MCW_TX_ENABLED=false`, as the example
    ships), run `--check` until it says `0 error(s)`, start the bot and
    watch the log for a day: no `[ERROR]` lines, `Coverage:` and
    `Home point:` as expected, products coming in, requests heard.
13. **Talk to your repeater operators** before the first packet: what the
    bot will send (warnings on change, a digest and coverage statement
    every 3 h, observations hourly, a forecast every 6 h, at most
    `MCW_SCHEDULED_PACKETS_PER_HOUR` in any hour, plus answers to requests),
    the area it covers, and whether they want it inside a region scope.
14. **Then switch transmit on**, in the portal (Radio > Transmit) or with
    `MCW_TX_ENABLED=true` and a restart. The portal refuses while the node
    is on a frequency outside `MCW_RADIO_REGION`.

### When two bots meet

There is one request channel, `#meshwx`, for every bot everywhere, on
purpose. A MeshCore channel's key is derived from its name, so a phone needs
one slot to talk to any bot it can hear, and an app needs no per-city
setup. A city name in the channel (`#meshwx-aus`) would not keep anything
local either: repeaters cannot read a channel packet, they forward the
ciphertext of every flood they hear within the hop limit, whatever channel
it is on, so per-city names only cost every user another slot. What keeps
floods local is the radius of each bot's coverage, the hop limits and,
where the operators adopt it, MeshCore region scope on the repeaters.

Where two meshes overlap, use `MCW_REPLY_MODE=dm` (the default): a DM goes
along one path, while a channel reply floods both meshes. Requests that name
a place are already answered only by the nearest bot the others have heard
adverts from; requests without a place are answered by each bot that hears
them. Proper cross-bot coordination (who carries which warnings where
coverages overlap) is coming; until then, keep the radius honest and agree
the overlap with the other bot's operator.

## Configuration reference

All settings are environment variables prefixed with `MCW_`, read from the
environment and from `.env` in the working directory. `.env.example` (dev
box) and `deploy/pi.env.example` (receiver Pi) are starting points.

**Radio and channels**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_SERIAL_PORT` | `/dev/cu.usbserial-0001` | Serial port of the companion radio, or `tcp://host:port` for a radio behind a TCP bridge. When a serial port is missing or silent the bot also tries `/dev/meshcore` and every USB serial port |
| `MCW_SERIAL_BAUD` | `115200` | Serial baud rate |
| `MCW_MESHCORE_CHANNEL` | `#meshwx` | The request channel for people and apps; created on a free slot if the node lacks it. Never slot 0 (public) |
| `MCW_MESHWX_CHANNEL` | `#meshwx` | The data channel for v5 datagrams and `>` answers. The same name as `MCW_MESHCORE_CHANNEL` shares one slot, which is where v5 apps listen; a different name takes a second slot. Empty = no broadcasts and no `>` answers |
| `MCW_STATUS_CHANNEL` | *(empty)* | A public channel for the station's status lines, e.g. `#meshwx-status`: GOES lock lost (after 10 min) or back, the internet fill filling in or done, products running an hour or more behind the uplink (and current again under half an hour), the receiver dashboard unreachable (after 5 min), the Pi's disk, temperature or throttle flags. One line per change, `WX-AUS status: GOES lock lost 10m`, the same condition at most every 30 min and six lines an hour in all. Created on a free slot like the others; never the request channel. Only with `MCW_EMWIN_SOURCE=sdr`: the lines come from the dashboard poll. Empty = no status lines |
| `MCW_TX_ENABLED` | `true` | `false` = receive only: adverts, replies, datagrams, status lines and resends become logged no-ops. Receiving, MQTT and the portal continue. `.env.example` ships `false`: switch it on after `--check` |
| `MCW_RADIO_REGION` | `US` | Where the radio may transmit: `US` (902-928 MHz) or `EU` (863-870 MHz). A frequency outside the band (the whole channel, centre ± half the bandwidth) is refused from the portal and the radio driver, the portal offers only the region's presets, and a node found on such a frequency at start has transmit switched off until it is retuned |
| `MCW_ADVERT_INTERVAL_HOURS` | `6` | Hours between flood adverts |
| `MCW_CONTACT_HOUSEKEEPING` | `true` | Keep the node's contact table for people: store companions only, remove repeaters, rooms and sensors, and the people heard longest ago when free slots run low. The admin and peer bots are never removed. `false` = firmware behaviour |
| `MCW_CONTACT_SLOTS` | `100` | Contact capacity to assume when the firmware does not report one |
| `MCW_CONTACT_KEEP_FREE` | `10` | Slots housekeeping leaves free for newcomers |
| `MCW_RADIO_ADOPT` | `manual` | A different radio on the port: `manual` waits for Adopt in the portal, `auto` writes the saved profile onto it at once, `off` never adopts |
| `MCW_RADIO_RX_SILENT_MIN` | `30` | Minutes with nothing heard before the health verdict calls the receiver silent |

**Text replies**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_REPLY_MODE` | `dm` | `dm`, `dm_only` or `channel` (see "How replies go out") |
| `MCW_CHANNEL_REPLY_MAX_HOPS` | `2` | A sender the bot cannot DM gets a channel reply only within this many hops |
| `MCW_PEER_BOT_PREFIX` | `WX-` | Name prefix of other weather bots; their channel messages are ignored |
| `MCW_ADMIN_KEY` | *(empty)* | Hex public-key prefix allowed to run admin commands by DM: the first 12 characters of your own key. Fewer than 8, or not hex, is logged as an error and ignored |
| `MCW_TIMEZONE` | *(empty)* | Time zone for times in text replies (IANA name); the wire is always UTC. Empty = the zone of the home city's state; set it where a state has more than one |

**Delivery**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_RETRANSMIT_MAX` | `1` | Resends of a channel packet nobody repeated; `0` = measure only, and a DM reply gets attempt 0 only |
| `MCW_ECHO_WINDOW_S` | `8.0` | Seconds to wait for a repeater's echo before resending |
| `MCW_RETRANSMIT_PER_HOUR` | `30` | Resends allowed per hour |
| `MCW_MESH_QUIET_S` | `600` | When no repeat has been heard from anyone for this many seconds, skip the resend |
| `MCW_SCOPE_URL` | *(empty)* | CoreScope instance to ask who heard a packet; empty = off |
| `MCW_SCOPE_MODE` | `stats` | `stats` records the observers; `decide` also skips a resend CoreScope saw repeated |
| `MCW_SCOPE_MIN_OBSERVERS` | `1` | Observers of a repeated copy needed before it counts |
| `MCW_RELAYED_REPLY_DELAY_S` | `1.0` | An answer to a request that came through repeaters waits this long plus up to half as much again, so it does not go out while the request is still being passed on; `0` = at once |
| `MCW_DM_REPLY_DELAY_S` | `2.0` | A DM reply's first try leaves at least this long after its request arrived |
| `MCW_DM_COPY_WINDOW_S` | `120` | A DM with the same sender and text within this many seconds of the first is a copy of that request |
| `MCW_DM_COPY_RETAIN_S` | `1800` | A DM with the same sender, timestamp and text within this many seconds is a copy |

**EMWIN**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_EMWIN_SOURCE` | `internet` | `internet` (NOAA bundles) or `sdr` (the goesproc directory) |
| `MCW_EMWIN_POLL_INTERVAL` | `60` | Seconds between store refreshes; with `internet`, also between bundle downloads |
| `MCW_OPERATOR_CONTACT` | *(empty)* | Optional; appended to the User-Agent sent to NOAA, e.g. an email address, so NOAA can reach you instead of blocking. Printable, at most 100 characters; read at start |
| `MCW_EMWIN_BASE_URL` | `https://tgftp.nws.noaa.gov/SL.us008001/CU.EMWIN/DF.xt/DC.gsatR/OPS/txthrs01.zip` | Bundle loaded at start (`internet`) |
| `MCW_EMWIN_POLL_URL` | `https://tgftp.nws.noaa.gov/SL.us008001/CU.EMWIN/DF.xt/DC.gsatR/OPS/txtmin02.zip` | Bundle polled after that (`internet`) |
| `MCW_EMWIN_MAX_AGE_HOURS` | `12` | Hours a product stays in the store; warning-class products stay at least 48 h and storm reports at least 24 h |
| `MCW_SDR_EMWIN_DIR` | `~/goes-images/emwin` | goesproc's EMWIN output (`YYYY-MM-DD/` directories). Created when missing, so the watcher still runs |
| `MCW_SDR_POLL_INTERVAL` | `30` | Seconds between directory scans |
| `MCW_FILL_ENABLED` | `true` | The internet fill, the feed's one backup (`emwin/fill.py`): a product the feed (the dish, or NOAA's bundles on a bot without one) has not delivered within its grace of being issued is taken from NWS over the internet. Text products of the types the bot reads from api.weather.gov (one listing a minute; a product's text is fetched only when its grace is up and the feed still lacks it), airport reports and forecasts from NWS's tgftp feeds (`MCW_NWS_METAR_URL`, `MCW_NWS_TAF_URL`; listed only while the feed has no bundle that new), radar from radar.weather.gov's standard mosaics, the same pictures EMWIN carries (only while a region's newest is older than `MCW_FILL_RADAR_GRACE_MIN`). Products are matched to the feed's by WMO heading, office and minute; a copy the feed brings later is dropped. What it takes is kept under `data/emwin_internet/` so a restart keeps it, and says "internet" on the wire. It replaced, on 2026-10-19, the dish's NOAA-bundle backup (the uplink's own queue, as late as the dish when NOAA fell behind) and the METAR feed's on/off switch |
| `MCW_FILL_GRACE_WARNING_MIN` | `2` | How long a warning, watch or statement may take to come down the feed before the fill takes NWS's copy |
| `MCW_FILL_GRACE_MIN` | `15` | The same for everything else, airport reports and forecasts included |
| `MCW_FILL_RADAR_GRACE_MIN` | `20` | A radar region whose newest picture on the feed is older than this is taken from the web every five minutes |
| `MCW_RADAR_DIR` | empty | Where the EMWIN radar GIFs are (`YYYY-MM-DD/*-RAD*.GIF`). Empty means `MCW_SDR_EMWIN_DIR` when the source is `sdr`, and no radar otherwise: the internet bundle carries no images. With the dish, the internet fill's pictures in `data/emwin_internet/` are read too |
| `MCW_SDR_DASHBOARD_URL` | `http://127.0.0.1:8080` | The goestools dashboard the bot polls (every 10 s) and posts mode changes to: the `sat` reply, receiver log lines, the status channel, the portal's Station tab and Overview. Keep it the local address |
| `MCW_SDR_DASHBOARD_PUBLIC_URL` | *(empty)* | The dashboard's address for people (the portal's link, the public bundle, the end of the `help` and `status` replies), e.g. its public hostname. Empty = `MCW_SDR_DASHBOARD_URL`, which never goes on the mesh |

**Coverage**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_HOME_CITIES` | *(empty)* | Comma-separated places; the first is the home point (radius centre, home forecast, `>f` and `>o` without an argument) |
| `MCW_HOME_RADIUS_KM` | `120` | Every forecast zone within this radius of the home point is covered; `0` = no radius |
| `MCW_HOME_STATES` | *(empty)* | Comma-separated states, covered whole |
| `MCW_HOME_WFOS` | *(empty)* | Comma-separated NWS offices, covered whole |
| `MCW_COVERAGE` | *(empty)* | `national` = no area filter: the scheduled broadcasts carry every warning the feed has. The only way to get that; empty = the home area, and no home area means nothing is broadcast |
| `MCW_SCHEDULED_PACKETS_PER_HOUR` | `120` | Ceiling on scheduled packets an hour, every job together; life-safety warnings and their repeat always go. Also on the portal's Limits card |

**Portal**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_PORTAL_ENABLED` | `false` | Run the admin portal (needs the `[portal]` extra) |
| `MCW_PORTAL_HOST` | `127.0.0.1` | Portal bind address. No login: keep it on this machine and use an SSH tunnel |
| `MCW_PORTAL_PORT` | `8080` | Portal port |
| `MCW_PORTAL_ALLOWED_HOSTS` | *(empty)* | Comma-separated `Host` names the portal answers besides `localhost`, `127.0.0.1`, `[::1]` and a specific bind address, e.g. `mesh-wx.local,10.0.0.51`. Anything else gets 400 |
| `MCW_BRIDGE_TOKEN` | *(empty)* | Set it to turn on the debug bridge (needs the portal too): a development client reads the transmitted datagrams and posts `>` requests over HTTP. Empty = the bridge answers 404. See "The debug bridge" |

**MQTT (CoreScope)**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_MQTT_ENABLED` | `false` | Publish every raw packet the radio hears to an MQTT broker |
| `MCW_MQTT_HOST` | `mosquitto` | Broker host |
| `MCW_MQTT_PORT` | `1883` | Broker port |
| `MCW_MQTT_TOPIC_PREFIX` | `meshcore` | Topics are `<prefix>/<iata>/<public key>/packets` |
| `MCW_MQTT_IATA` | *(empty)* | Region code in the topic. Empty = the code in the node's `WX-<IATA>` name; with neither, MQTT stays off (logged) |
| `MCW_MQTT_USERNAME`, `MCW_MQTT_PASSWORD` | *(empty)* | Broker credentials |
| `MCW_MQTT_ORIGIN` | `meshcore-weather` | Observer name in each published message |

**Other**

| Variable | Default | Description |
|----------|---------|-------------|
| `MCW_DATA_DIR` | `data` | Where the bot keeps its state: schedule, warning state and sequence number, known contacts, node profile, EMWIN cache |
| `MCW_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING` or `ERROR` |
| `MCW_MESHWX_REFRESH_COOLDOWN` | `300` | Not read by the current code (left from v4) |

Once the bot is running, **the broadcast schedule is managed in the portal** (Mesh › Scheduled broadcasts) and kept in `data/broadcast_config.json`, not in environment variables. The five built-in broadcasts can be turned off or run less often, not removed. Add a broadcast offers three things: radar while there is precipitation near home, a forecast for another place (city and state, ZIP code or lat,lon) and one airport's observations. It shows what one run sends, its airtime and its share of the hourly ceiling before you save. Each row then says what the last run sent, or why it sent nothing.

Radar sends the radar tile over your area, one packet per picture, while there is precipitation within a distance of home you set (the coverage radius by default), and one picture more when it clears; nothing while it is dry. You choose what counts (any precipitation, moderate and heavier, or heavy only) and how often a picture may go: every new picture (15 min), every 30 min or every hour. The bot looks for a new picture every minute. The tile is the narrowest that holds the whole circle. In the lower 48, 40 km around home is the 2° Local tile almost everywhere, 80 km mostly the 4° Regional one, and 120 km the Regional or the 8° Wide one about equally often. It needs the dish's radar pictures.

## Data sources

Every message is derived from an official NWS product received over EMWIN. Parsing is done by [pyIEM](https://github.com/akrherz/pyIEM) wherever it covers the product, with custom parsers for the rest (notably the PFM column-position parser in `parser/pfm.py`).

| Product | Used for |
|---|---|
| Warnings, watches and advisories with VTEC (TOR, SVR, SVS, FFW, FLW, FLS, WSW, NPW, RFW, MWW, WCN, ...) and SPS | `warn`, `wx`; v5 Warning, Cancel and Digest; `>w`, `>wt` |
| METAR collectives (SAH) | `wx` conditions, `metar`; v5 Observations; `>metar` |
| PFM (Point Forecast Matrix) | `forecast`, `wx`; v5 Forecast |
| TAF | `taf`; `>taf` |
| HWO (Hazardous Weather Outlook) | `outlook`; `>hwo` |
| LSR (Local Storm Reports) | `storm`; `>storm` |
| RWR (Regional Weather Roundup) | `rain`; `>rain` |
| AFD (Area Forecast Discussion) | `>afd` |
| SWPC products (3-Day Forecast, Daily Indices, alerts) | `space`; `>space` |

Warnings carry VTEC event tracking across product segments (`protocol/vtec_events.py`), polygons, county (`TXC453`) and zone (`TXZ192`) codes, and absolute expiry times. Warning-class products stay in the store for 48 h and storm reports for 24 h, so the VTEC expiry and the report time decide what is current (`emwin/retention.py`). Point forecasts (PFM) also stay 48 h: one is issued about every 12 h, and a dish that misses an issuance (rain fade, an outage) would otherwise have no forecast at all.

## Text commands for people

Anyone can send these on `#meshwx` or by DM. A message that is not a
command is read as a place: `austin tx` means `wx austin tx`.

People talk on `#meshwx` too, and the bot leaves that alone. On the channel
a message with no command word is answered only when it is a ZIP or a
`city ST` that names a place (`austin tx`, `78644`); a bare word is not
enough, because nice, cool and hope are towns and lol and hey are airports.
A word people also use in sentences (`weather`, `forecast`, `warn`,
`radar`, `outlook`, `rain`, `storm`, `more`) followed by a sentence that
names no place gets no reply either: `forecast looks bad tonight`. Emoji and
`@[Name]` replies to somebody else are never requests. A mention of the bot
is dropped, so `@[WX-AUS] wx austin tx` works. These go in the traffic log
as dropped, "conversation, not a request". By DM every message is a request.

| Command | Example | Reply |
|---------|---------|-------|
| `wx <city ST, station or ZIP>` | `wx Austin TX`, `wx KAUS`, `wx AUS`, `wx 78701` | Current conditions, today's high/low, active warnings. With no nearby report under 2 h old, the newest up to 12 h old, labelled with its age: `63F dp37 N23g35 bkn (KAUS 45km, 5h old)`; past 12 h, none. A forecast more than 13 h old adds its issue time: `70/49 20% fc issued Wed 1:33AM` |
| `wx`, `wx <state>` | `wx TX`, `TX`, `wx texas` | National or state overview |
| `forecast <city ST or ZIP>` | `forecast Miami FL`, `forecast 02134` | Daily forecast from the nearest PFM point, from today on. One more than 13 h old (the dish missed an issuance) gives its issue time and as many days as fit one packet, four at most: `Lockhart, TX (San Marcos Airport 19km, issued Wed 1:33AM): Thu …`. With a point nearby and no forecast held: `no recent forecast received` |
| `warn`, `warn <ST>`, `warn <city ST or ZIP>` | `warn KS`, `warn 78701` | Active watches, warnings and advisories: national, a state, or a place |
| `outlook <city ST or ZIP>` | `outlook Des Moines IA` | Hazardous weather outlook |
| `storm [ST or city ST]` | `storm SD` | Storm reports from the last 6 hours (the home state without an argument) |
| `rain [ST or city ST]` | `rain FL` | Rainfall reports (the home state without an argument) |
| `metar <ICAO, city ST or ZIP>` | `metar KJFK`, `metar 78701` | Raw METAR from the nearest station with one under 2 h old; with none, the newest up to 12 h old, labelled: `METAR (KAUS 45km, 5h old) KAUS 170153Z …`. Past 12 h: `no METAR within 12h from nearby stations` |
| `taf <ICAO, city ST or ZIP>` | `taf KJFK` | Terminal aerodrome forecast |
| `space` | `space` | Space weather |
| `radar [city ST or ZIP]` | `radar Dallas TX` | The newest radar picture in words: its time and age, what is over the place, the nearest precipitation and the nearest heavy core (the home city without an argument). A bot without a dish says it has none |
| `sat` | `sat` | The bot's GOES receiver: lock, signal quality, packets dropped in the last minute, age of the newest file the dish wrote, and how far behind the uplink the products run when that is 30 min or more (`products ~5h behind`); with the internet fill filling in, since when. A reply that would not fit one message leaves out the packet count. A bot on internet EMWIN says it has no receiver |
| `status` | `status` | The operator's notices, as on the public page (written on the admin portal's Station tab): the first headline and the public page's address on page 1, the details on `more`; with none up, `No notices from the operator.`, whether EMWIN is on time and the address |
| `cov` | `cov` | What this bot covers: the area and how far it reaches, the NWS offices in it, how many stations it reports hourly, how often the alert list goes out |
| `more` | `more` | The next page of the last long reply |
| `help` | `help` | The command list, ending with the public page's address (`MCW_SDR_DASHBOARD_PUBLIC_URL`) when it fits |

Aliases: `weather` for `wx` (on its own, and with `here`, `now` or
`today`, the help line: the bot cannot know where "here" is); `warning`, `warnings` and `wanr` for `warn`; `storms` for `storm`;
`swx` and `solar` for `space`; `satellite`, `goes` and `signal` for `sat`;
`coverage` and `covers` for `cov`; `notice` and `notices` for `status`. The receiver, coverage and status words count
only on their own, so `satellite beach fl` and `cove tx` are still places. `<command> more` (or `next`) also means `more`. Both 3-letter
(IATA/FAA) and 4-letter (ICAO) station codes work.

### Long replies

A reply is rendered in full and cut into numbered pages at the message
budget, on item boundaries; page 1 ends `(1/3) more`. `more` from the same
person sends the next page on whichever transport it arrives, so a reply
started on the channel continues by DM. A paging session lasts 15 minutes.

### How replies go out

- **A DM** is answered by DM.
- **A command on the channel** depends on `MCW_REPLY_MODE`:
  - `dm` (default): a DM when the bot can DM the sender (its node has them
    stored, or they have DMed or adverted before). Otherwise a sender at
    most `MCW_CHANNEL_REPLY_MAX_HOPS` hops away (default 2) gets one reply
    on the channel, cut to one message ending `… DM me for all`, at most
    one per sender per 10 minutes and 12 per hour in total, and the bot
    adverts if it has not in the last hour. A sender farther away gets
    nothing.
  - `dm_only`: a DM or nothing.
  - `channel`: every reply floods on the channel, paged like a DM. For testing.
- A DM reply leaves about 2 s after the request and waits for the phone's
  ACK: attempts 0 and 1 on the stored route, then a route reset and
  attempt 2 by flood (0 and 1 by flood without a route), all with one
  timestamp. Replies to one person go one at a time, in order.
- A phone that hears no ACK sends its DM again. The same text within 2
  minutes, or the same timestamp and text within 30 minutes, is the same
  request: it gets nothing if the reply was acknowledged or is still going
  out, and the same reply again if it was never acknowledged. `more` with a
  new timestamp is a new request once the page before it was acknowledged,
  and sends the first page not acknowledged.
- A DM the node refuses to send is not retried on the channel; the bot
  forgets that sender's DM path, so their next channel command is handled
  like a stranger's.
- Messages from nodes whose name starts with `MCW_PEER_BOT_PREFIX` are
  ignored. When a peer bot's advert carries a position, a channel command
  that names a place is answered only by the bot nearest to that place.

Limits: one reply per sender every 5 seconds (2 seconds for `more`), at most
40 per sender and 400 in total per hour; a `>` request sent by DM counts
too. A `>` request that arrives as a Request datagram or as channel text does
not: it meets only the app limits (2 s per sender, 240 answer packets an
hour, then "busy"). Anything else over a limit gets no reply. Every number
here is a setting, changed live on the portal's Text bot page under Limits
and cooldowns. A resend of a request is never
held to the 5 seconds and costs nothing unless something is sent for it; a
`>` request sent again, by datagram or by DM, is answered again only 12
seconds after the last answer went out.

### Admin commands

DM only, from a public key that starts with `MCW_ADMIN_KEY`:

| Command | Description |
|---------|-------------|
| `admin` | Show admin help |
| `contacts` | List all contacts on the node |
| `remove <name>` | Remove a specific contact |
| `clear-contacts` | Remove ALL contacts from the node |
| `advert` | Send a flood advert + refresh contacts |
| `refresh` | Reload contacts from the node |
| `broadcast` | Run a scheduler tick now (the jobs that are due) |
| `warnings-broadcast` | Run the `warnings` job now |
| `test-data-ch` | Send a `test ping` text on the data channel |

## Architecture

```
meshcore_weather/
├── main.py                # Entry point: startup order (radio first, products behind it), shutdown; channel/DM routing, text commands, paging, limits, admin commands
├── config.py              # Settings from MCW_ environment variables and .env (pydantic-settings)
├── nlp.py                 # Text command parser: command words, aliases, bare-word sat
├── cli.py                 # meshcore-weather-cli
├── traffic.py             # What the text bot heard and said: live feed, counters, redacted public view
├── activity.py            # Broadcast log (data-channel events) for the portal
├── sdr_monitor.py         # Reads the goestools dashboard: receiver log lines and the sat reply
├── status_channel.py      # Status lines on MCW_STATUS_CHANNEL: lock, internet fill, feed lag, dashboard, the Pi
│
├── core/                  # One implementation per product, shared by text and binary
│   ├── services.py        # Observation, forecast, warnings, outlook, storm reports, rain, METAR/TAF for a place
│   ├── render_text.py     # One-message text renderings
│   ├── overview.py        # National and state overviews
│   ├── pages.py           # Numbered pages for long replies
│   ├── space_weather.py   # SWPC products into the space reply
│   └── vtec_names.py      # Names for VTEC phenomenon.significance pairs
│
├── emwin/
│   ├── fetcher.py         # InternetSource (NOAA zip bundles) and SDRSource (goesproc directory, feed lag)
│   ├── fill.py            # The internet fill: NWS's copy of what the feed has not delivered within its grace
│   ├── nws_metar.py       # NWS's airport report and forecast feeds (tgftp DS.metar, DS.tafst)
│   └── retention.py       # How long each product type stays in the store
│
├── parser/
│   ├── weather.py         # WeatherStore: products by EMWIN identifier, lookups
│   └── pfm.py             # PFM column-position parser + daily downsampler
│
├── protocol/
│   ├── v5.py              # MeshWX v5 codec (stdlib only; the reference encoder and decoder, Request included)
│   ├── v5_builders.py     # Store data -> v5 messages (one implementation for jobs and requests)
│   ├── broadcaster.py     # AppResponder: answers `>` requests, owns the Scheduler
│   ├── warnings.py        # pyIEM-backed warning extraction with storm tags
│   ├── vtec_events.py     # VTEC event lifecycle across product segments
│   ├── coverage.py        # Operator coverage (home radius, states, WFOs -> zone set)
│   └── meshwx.py, encoders.py, fec.py   # v3/v4 code, still imported for METAR parsing and shared tables
│
├── radar/
│   ├── picture.py         # One EMWIN radar GIF -> precipitation levels: its own colour scale, furniture masks, the printed time
│   ├── tiles.py           # The 32 x 32 tile a phone asked for, cut from a picture; the words of the `radar` reply
│   ├── source.py          # Newest picture per product in the dish's EMWIN directory, decoded on demand
│   ├── service.py         # What `>radar` and `radar` both ask: the best fresh picture for a tile, and its last hour
│   └── products.json, masks/, stamp_digits.json   # Calibration, written by scripts/radar_calibrate.py
│
├── schedule/
│   ├── models.py          # BroadcastJob, BroadcastConfig; the four schedulable products
│   ├── store.py           # Atomic JSON persistence, default jobs, v4 migration
│   ├── executor.py        # Job -> v5 messages; warning state and life-safety repeats
│   └── scheduler.py       # Tick loop and the one transmit path: spacing, seq stamping, state saved across restarts
│
├── meshcore/
│   ├── radio.py           # MeshCore companion: port discovery, channels, DMs, adverts, GRP_DATA in and out, contacts
│   ├── delivery.py        # Echo and ACK tracking, the single resend, CoreScope lookups
│   ├── health.py          # Radio health verdict (tx_suspect, rx_silent, idle, tx_off)
│   └── profile.py         # Node profile and its adoption onto a replacement radio
│
├── mqtt/
│   └── publisher.py       # Raw RX packets to an MQTT broker for CoreScope
│
├── portal/                # FastAPI admin portal (one page, hash routing, no build step)
│   ├── server.py          # App factory, state-change header check, uvicorn lifecycle
│   ├── sse.py             # SSE helper with heartbeats (logs, traffic, broadcast log)
│   ├── logbuf.py          # Log ring buffer behind the Logs tab
│   ├── routes/
│   │   ├── pages.py       # GET / (the page)
│   │   ├── api.py         # Product browser, broadcast log, channels, schedule CRUD
│   │   └── admin.py       # Overview, radio, satellite, console, traffic, public bundle, logs, settings, audit
│   ├── templates/app.html
│   └── static/            # portal.js + portal.css, nothing vendored
│
├── client_data/           # Preload bundle for apps (package data; spec section 16)
│   ├── protocol.json, index.json, wfos.json
│   ├── stations.json, pfm_points.json, places.json, zips.json
│   ├── zones.json, zones.geojson, counties.json, counties.geojson
│   └── regions.json, state_index.json, weather_dict.json   # v3/v4, not used by v5
│
└── geodata/               # Offline resolver for places, stations and zones (__init__.py)
    └── zones.json, places.json, stations.json, state_index.json
```

```
deploy/      systemd units, udev rule, goestools dashboard and cleanup for the Pi
scripts/     pi_update.sh, audit.py, v5_vectors.py, radar_calibrate.py, build_client_data.py, build_places.py, start.sh
tests/       pytest suite
corescope/   CoreScope packet analyzer and observer brokers (separate Docker stack)
docs/        below
```

## Docs

- [`docs/MeshWX_v5_Spec.md`](docs/MeshWX_v5_Spec.md) — the protocol and the client developer's guide: wire format, requests, bundle, and the rules for storing, showing and asking. The current contract.
- [`docs/meshwx_v5_vectors.json`](docs/meshwx_v5_vectors.json) — test vectors every client must pass, generated by `scripts/v5_vectors.py`
- [`docs/Radio_Swap.md`](docs/Radio_Swap.md) — replacing the radio (same or different board): the node profile, adoption, the udev rule, the Health card
- [`docs/Delivery_Confirmation_Design.md`](docs/Delivery_Confirmation_Design.md) — echo tracking and the single resend: the design and the firmware facts it rests on
- [`docs/USB_Radio_Restart.md`](docs/USB_Radio_Restart.md) — what happens on the Pi when the USB radio is unplugged, dies or reboots, and what to check
- [`docs/Future_EInk_Dashboard.md`](docs/Future_EInk_Dashboard.md) — parked idea for a standalone e-ink display, written against the v4 message codes
- [`web/README.md`](web/README.md) — the web client: running it, packaging it for somebody else, the radio settings screen, the radar card, and how the folder is laid out
- [`web/docs/PORTING.md`](web/docs/PORTING.md) — the rules the port follows: Swift names kept, layer order, what a screen may import
- [`web/docs/UI_KIT.md`](web/docs/UI_KIT.md) — the client's own small UI framework, for anyone adding a screen to it

Dated reviews, kept as records of what was found and changed at the time.
Where they disagree with the spec or the code, the spec and the code are
right.

- [`docs/MeshWX_Airtime_Review.md`](docs/MeshWX_Airtime_Review.md) — 2026-09-10: the airtime review that led to v5
- [`docs/Satellite_Feed_Findings.md`](docs/Satellite_Feed_Findings.md) — 2026-09-13: what the GOES-19 EMWIN feed on the Pi delivers
- [`docs/System_Review.md`](docs/System_Review.md) — 2026-09-13: whether the pieces between the feed and the wire agree
- [`docs/Nationwide_Design_Review.md`](docs/Nationwide_Design_Review.md) — 2026-09-14: one request channel for every bot, attacked
- [`docs/Security_Notes.md`](docs/Security_Notes.md) — 2026-09-14: what an attacker can reach before going live, and what is left
- [`docs/Accuracy_Audit_2026-09-14.md`](docs/Accuracy_Audit_2026-09-14.md) — 2026-09-14: answers checked against independent sources, the fixes, and `scripts/audit.py`
- [`docs/Admin_Portal_Review_2026-09-14.md`](docs/Admin_Portal_Review_2026-09-14.md) — 2026-09-14: the portal revamp record

## Safety

- **Channel isolation**: the radio driver never transmits on channel 0 (public) and sends only on the bot's configured text and data channel slots, and on the status channel's slot when `MCW_STATUS_CHANNEL` is set (status lines only, never the request channel).
- **Receive-only switch**: `MCW_TX_ENABLED=false` turns every advert, reply, datagram, status line and resend into a logged no-op.
- **Text reply limits**: 5 seconds per sender, 40 per sender and 400 in total per hour; a sender the bot cannot DM gets at most one channel reply per 10 minutes, 12 per hour overall, and only within the hop limit.
- **App request limits**: 2 seconds per sender and 240 answer packets per hour, checked before an answer is built; over the budget, one "busy" a minute per radio. Every limit is a setting (`MCW_APP_PACKETS_PER_HOUR`, `MCW_APP_SENDER_GAP_S`, `MCW_SWEEP_WINDOW_S`, `MCW_RADAR_WINDOW_S`, `MCW_PART_RESEND_FLOOR_S`, `MCW_TEXT_REPLIES_PER_HOUR`, `MCW_TEXT_REPLIES_PER_SENDER_PER_HOUR`, `MCW_STRANGER_REPLIES_PER_HOUR`, `MCW_STRANGER_REPLY_GAP_S`), set live on the portal.
- **Resend limits**: one resend per packet by default, 30 per hour, none while no repeater has been heard for 10 minutes.
- **Input sanitization**: control characters are stripped, messages cut to 200 characters and places to 50.
- **Admin authentication**: admin commands only by DM, matched on the sender's public key, not their name.
- **Identity**: a radio that is not the node in the saved profile sends no adverts until it is adopted or a new profile is started.
- **Portal**: no login, so it binds `127.0.0.1` by default and answers only a known `Host` (`MCW_PORTAL_ALLOWED_HOSTS`); state-changing requests need the `X-Requested-With: meshcore-portal` header. The public page gets a redacted bundle.
- **Coverage fails closed**: a home city that does not resolve, or no coverage at all, means the scheduled area broadcasts send nothing; every warning in the country only with `MCW_COVERAGE=national`.
- **Scheduled ceiling**: 120 scheduled packets an hour (`MCW_SCHEDULED_PACKETS_PER_HOUR`), life-safety warnings always included; restarts do not re-broadcast.
- **Radio region**: frequencies outside `MCW_RADIO_REGION`'s band are refused, and a node found on one has transmit switched off.

## Roadmap

Shipped:

- [x] Internet-based EMWIN data fetching with disk cache
- [x] EMWIN from the GOES-19 dish via goestools (`MCW_EMWIN_SOURCE=sdr`)
- [x] pyIEM canonical NWS product parsing (VTEC, UGC, polygons) and a VTEC event lifecycle tracker
- [x] PFM forecast source, sent as whole days
- [x] MeshWX v5: warnings, cancels, digest, observations with per-station ages, forecasts, text, coverage, alert maps and radar tiles with loops, each one `GRP_DATA` packet on `#meshwx`, and the `>` request grammar with the Request datagram
- [x] App requests answered on the channel so one request serves every listener
- [x] Discovery by advert (`WX-<city>` chat node)
- [x] Echo tracking and one byte-identical resend; DM ACKs; optional CoreScope check
- [x] Absolute Unix-minute expiry timestamps (no client-side countdown drift)
- [x] Per-job broadcast schedule, edited in the portal
- [x] Preload bundle (`client_data/`) with the index tables, PFM points, zone and county polygons, places, stations
- [x] Text commands for people with numbered pages and `more`
- [x] DM-first replies: reply modes, hop-limited channel replies for strangers, admin commands
- [x] Contact housekeeping
- [x] Radio swap: node profile, adoption, udev rule, health verdict
- [x] Receiver status: `sat` and `>sat`, with how far behind the uplink the products run, and a status channel that reports outages unasked
- [x] Observations up to 12 h old served with their age when nothing nearby is current (`wx`, `metar`, `>o`), instead of left out
- [x] Coverage statement: `cov`, `>cov`, and one packet every 3 h, so an app never guesses the bot's area
- [x] Admin portal: overview, text bot feed and console, broadcasts, radio, satellite, logs and settings
- [x] Public dashboard card with a redacted live feed
- [x] Accuracy audit against api.weather.gov, IEM, aviationweather.gov and SWPC
- [x] MQTT packet publishing for CoreScope
- [x] Pi deployment: systemd unit, git-based updates with `scripts/pi_update.sh`
- [x] Docker container (radio over a TCP bridge)
- [x] iOS client against v5 (in beta)
- [x] Web client for Chromium browsers over Web Bluetooth or Web Serial, and a downloadable copy of it

Planned:

- [ ] A permanent `GRP_DATA` data type requested upstream (spec section 2.1)
- [ ] Storm motion from the warnings' `TIME...MOT...LOC` line
- [ ] GOES infrared as a fallback where there is no radar
- [ ] Calibrate the Guam radar picture
- [ ] H-VTEC hydrologic metadata (flood severity, river ID, stage forecast)
- [ ] 3-hourly hour-by-hour PFM forecast format
- [ ] Standalone e-ink weather display hardware product (see `docs/Future_EInk_Dashboard.md`)

## License

Apache License 2.0. Copyright 2026 Rafael Pesquera. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Authors

Created and maintained by Rafael Pesquera ([@digitaino](https://github.com/digitaino)). Contributions from the Austin mesh community are welcome; see the open protocol docs under `docs/`.

## Related

- **[DigitainoMesh](https://github.com/digitaino/DigitainoMesh)** — a native MeshCore client for iOS and iPadOS.
- **[meshwx-client](https://github.com/digitaino/meshwx-client)** — desktop and web client for the earlier MeshWX v4 protocol; it does not decode v5.
