# Security notes for the text bot (going live 2026-09-14)

What an attacker can reach, what the bot does about it, and what is left.
Checked against the code on 2026-09-15.

## Inputs the bot accepts

| Input | Who can send it | What happens to it |
|---|---|---|
| Channel text on `#meshwx` | anyone with the channel name (the key is derived from it) | sender name and text are stripped of control characters and capped (40 / 200 chars), then parsed by an anchored regex into a command and a location; the location is reduced to letters, digits, space `,.-'` and 50 chars before it reaches the resolver |
| DM | anyone who has the bot's advert | same cleaning; the sender is identified by public key, not by name |
| App requests (`>` prefix) | anyone, by DM or on `#meshwx` | same control-character cleaning; the first word picks the answer and the rest is looked up as a warning identity, a UGC code, an ICAO code, a point index or a place. An unknown word gets a Not available message, and an exception while building an answer becomes a Not available (bot error) |
| Adverts | anyone | contact name cleaned; the contact table on the node is bounded by firmware, the bot's name→key map is capped |
| `@lat,lon` prefix | DM senders | parsed as floats, range-checked, capped table |
| `sat` / `>sat` | anyone | answered from the receiver dashboard sample the bot already holds, with no request to goesrecv: lock, signal quality, dropped packets, goesproc state, age of the newest EMWIN file, how far behind the uplink the products run, and since when the internet fill is filling in. Nothing about the host, the network or the settings |
| EMWIN products | the satellite (unauthenticated broadcast) | every parser is wrapped per product or per point; a bad product is skipped, never fatal |
| Portal HTTP API | whoever can reach the portal port (8081 on the Pi; `127.0.0.1` by default since 2026-10-17; no login by design) with a `Host` it answers | see below |
| Public dashboard | anyone the goestools dashboard is exposed to | read-only; see below |

Nothing the bot receives is ever passed to a shell, a SQL engine, `eval`,
or a template. Replies are built from parsed weather data and resolver
names; the only user text echoed back is a location string, in "Unknown
location: …" and in the note after the last page of a reply. For text
commands that string has had the 50-character reduction above; for `>storm`
and `>rain` it has only had control characters removed.

## Airtime abuse

Every reply costs the mesh. Budgets, all enforced before a reply is built:

- text commands: one reply per sender per 5 s (2 s for `more`); at most 40
  replies per sender per hour and 400 per hour in total;
- a phone's resend of a DM request never meets the 5 s spacing. A resend
  that gets nothing costs nothing. One that sends something (a reply that
  was never acknowledged, or a request the spacing had dropped) counts
  against the hourly budgets, which can refuse it;
- DM replies go one at a time per contact, at most 5 waiting, each message
  tried at most 3 times (attempts 0 and 1, then 2 by flood). A failed reply
  goes again only when a resend of its request arrives;
- a `>` request sent again, by datagram or by DM, is answered again only
  12 s after the last answer went out;
- app `>` requests: one per sender per 2 s, and 240 answer packets per hour
  across all senders (packets, not requests). A `>` request sent as a DM
  first passes the text limits above and counts against them; a Request
  datagram (spec 7B) and a `>` line on the channel do not;
- a Request datagram names its sender by six bytes of a public key, which
  the node decrypted with the channel key: it proves membership of
  `#meshwx`, not identity, exactly as a channel line does. The prefix is
  the same one a DM from that phone carries, so one phone is one sender to
  every budget above however it asks, and a spoofed prefix can only spend
  the budget of the phone it names, never raise the bot's;
- a stranger (no DM path) gets a channel reply only if the request arrived
  within 2 hops, at most one per 10 minutes per sender and 12 per hour;
- a channel packet no repeater echoed is sent again at most 30 times per
  hour in total (DM tries are bounded by the DM rules above instead);
- `reply_mode=channel` (every reply a flood) is a test setting, shown as a
  red dot in the portal's status strip;
- status lines (`MCW_STATUS_CHANNEL`, empty by default; 2026-10-17) answer
  nobody, so nobody can call one up: they follow the station's state, at
  most six an hour, on a channel of their own and never the request
  channel. The channel is public, and a line can name the Pi's disk use,
  CPU temperature and throttle flags once they cross their limits; nothing
  about the network or the settings.

Per-sender state (rate limits, paging, learned names, cached locations,
recent DM requests: 32 per sender, 5000 senders) is pruned so a flood of
invented names cannot grow memory. One exception: the
app request limiter keeps each sender's last request time until the bot
restarts, so invented names on `>` channel lines each leave a small entry.

## What a new operator's mistakes can put on the air

Added 2026-10-17, before handing the bot to volunteers in other cities. An
adversarial review found that a configuration mistake went straight on the
air; each of these now fails closed, and `meshcore-weather --check` reports
all of them before the first start (exit 1 on any error; it never
transmits, and it never opens a serial port another process holds).

- **Coverage.** A home city that did not resolve was skipped in silence, and
  an empty coverage meant "accept everything": the national warning feed on
  a city mesh. Now an unresolvable or ambiguous home city (a bare name in
  several states), or an unknown state or office code, is an error logged at
  start and shown on the portal, and with errors or with no coverage at all
  the scheduled warnings, digest, observations and coverage statement send
  nothing. Every warning in the country takes `MCW_COVERAGE=national`, which
  the portal cannot set. A rebuild that raises keeps the last good coverage
  (none yet: nothing is sent). The portal refuses a home city that does not
  resolve before writing `.env`.
- **Volume.** `MCW_SCHEDULED_PACKETS_PER_HOUR` (120) caps every scheduled job
  together; tornado, severe thunderstorm, flash flood and extreme wind
  warnings and their one repeat always go and count. A restart no longer
  re-broadcasts the digest, observations, forecast, coverage statement and
  an advert: each job's last run and the last advert are kept in
  `data/warning_state.json`.
- **Frequency.** `MCW_RADIO_REGION` (US: 902-928 MHz, EU: 863-870 MHz) bounds
  the whole channel, centre ± half the bandwidth. The radio driver and the
  portal refuse anything outside it, the portal offers only the region's
  presets, and a node found outside it at connect has transmit switched off
  (the portal will not switch it on again until the node is retuned). The
  region is `.env`-only.
- **Austin defaults.** `MCW_TIMEZONE` and `MCW_MQTT_IATA` no longer default to
  Austin's: the zone comes from the home city's state, the MQTT region from
  the node's `WX-<IATA>` name (MQTT stays off without one). The default
  forecast job is `home`, resolved when it runs, and an old job naming the
  configured home city is migrated to it. The example `.env` files ship an
  empty home city and transmit off.

## Identity and spoofing

- A channel message carries the sender's *name* only. The bot maps it to a
  key through its contact list. Someone posting under another user's name
  can make the bot DM that user weather lines — bounded by the budgets,
  harmless in content.
- A DM is authenticated by the sender's key (ECDH). Admin commands
  (`contacts`, `remove`, `clear-contacts`, `advert`, `refresh`, `broadcast`,
  `warnings-broadcast`, `test-data-ch`, `admin`) are accepted only from a
  sender whose key starts with `MCW_ADMIN_KEY`. The firmware reports a DM's
  sender as the first 6 bytes of its key, so the bot compares at most **12
  hex characters**. Set `MCW_ADMIN_KEY` to exactly the first 12 of your own
  key (the Radio page shows every contact's key): a longer value never
  matches, and an 8-character prefix is a 32-bit search for anyone willing
  to grind keypairs. A value shorter than 8 hex characters, or not hex at
  all, is refused when the settings are read: logged as an error, shown by
  `--check`, and treated as unset (no admin), never as a prefix that a
  short key would match by chance.
- The node's name should follow `WX-<IATA>` (`^WX-[A-Z0-9]{2,8}$`); apps find
  bots by it and other bots ignore `WX-` senders on the channel. A name off
  the convention is a warning in the log, on the portal and in `--check`.
- Other bots (`WX-*`) are ignored as command sources on the channel, text
  and `>` lines alike. A DM from one is handled like anyone's.

## Portal

The portal has no login on purpose; access control belongs at the edge.
Since 2026-10-17 it **binds `127.0.0.1` by default** (`MCW_PORTAL_HOST`):
the operator comes in over an SSH tunnel, and the goestools dashboard on
the same Pi calls `http://127.0.0.1:8081` for the public bundle. In Docker
the app must listen on `0.0.0.0` inside the container (Docker forwards a
published port to the container's address, not its loopback), so
`docker-compose.yml` sets that and publishes the port on the host's
`127.0.0.1:8080` only.

Since 2026-10-19 the Pi's portal is also reachable as
**`wx-admin.digitaino.com`**, through the same Cloudflare tunnel as the
public dashboard (a rule in the Pi's `/etc/cloudflared/config.yml`, which
is not in this repo). Cloudflare Access is the login: an Access application
for that hostname (team `digitaino`) lets only the operator in. The tunnel
rule sets `originRequest.access.required` with that application's AUD tag,
so cloudflared itself refuses any request without a valid Access token for
it: an Access application deleted or misconfigured leaves the portal shut,
not open. Tested on the day: every path, and a request carrying a forged
`Cf-Access-Jwt-Assertion`, is sent to the Access login. The rule presents
requests to the portal as `Host: localhost:8081`, as an SSH tunnel does, so
the portal's own checks below apply unchanged and `MCW_PORTAL_ALLOWED_HOSTS`
stays empty. What the portal guards against itself:

- **DNS rebinding.** A page on an attacker's domain can re-point that domain
  at 127.0.0.1 and then talk to the portal as same-origin, which the header
  check below cannot stop. Every request must carry a `Host` the portal was
  told about: `localhost`, `127.0.0.1`, `[::1]`, a specific bind address,
  or a name in `MCW_PORTAL_ALLOWED_HOSTS`. Anything else gets 400 before a
  route runs (Starlette's TrustedHostMiddleware, with IPv6 literals
  understood). Tested over TCP: the dashboard's own request and an SSH
  tunnel's (`Host: localhost:<port>`) are answered, a foreign `Host` is not.

- **Cross-site requests.** Every POST/PUT/DELETE must carry
  `X-Requested-With: meshcore-portal`, a header a web page on another origin
  cannot add without a CORS preflight the server never grants. So a page
  someone on the LAN happens to open cannot flip transmit on, rewrite `.env`,
  or restart the bot through their browser.
- **`.env` writes** are limited to a whitelist of keys, to single-line
  printable values of at most 200 characters, and to checked numbers and
  choices, so a value cannot smuggle a second `KEY=value` or leave a file
  the next start refuses.
- **HTML injection.** Everything the portal renders from data (names, log
  lines, replies, headlines) goes through `escapeHtml` or `textContent`.
- **Side effects.** Besides settings, the portal can restart the bot,
  reboot or reconnect the node, switch transmit, send a test datagram or an
  advert, change channels and radio parameters, remove contacts, adopt a
  replacement radio or start a new profile, run and edit broadcast jobs,
  and switch the dish to pointing mode, which stops goesrecv. None spawns a
  shell with user input (`git rev-parse` is the one subprocess, fixed
  arguments).

## Public dashboard

The goestools dashboard (`deploy/goes-dashboard/dashboard.py`, port 8080
on the Pi) is the public page. It treats a request as public when it
carries Cloudflare's headers or comes from an address outside its LAN
prefixes; a public viewer gets a read-only page, and every POST is refused.

For the bot it proxies one portal endpoint, `/api/public/bot`, fetched at
most every 3 s however many viewers there are. That bundle holds the bot's
name, the radio preset, channels, coverage, the command list, counters,
where the products come from (the dish, what the internet fill took from
NWS, and how far behind the uplink they run) and the recent traffic in redacted form:
channel traffic as anyone on `#meshwx` heard it, DMs as the command and
reply length only, admin and console traffic not at all. No settings, no
contacts, no key and no position, the bot's own included (peer bots appear
by name only). The portal serves the same endpoint on its own port, like
the rest of it.

## What the traffic log writes to disk

Beside the lifetime counters (`traffic_stats.json` in the data directory),
`traffic_recent.json` keeps a week of per-message tallies (time, kind,
command, and the sender's channel name or the first 12 hex of a DM sender's
key) and the newest 300 events, so the rolling counters, the reply latency
and the live feed survive a restart. The events are what the portal's Text
Bot page shows, without the text of anything received or sent by DM (DM
requests, DM replies, admin commands): that text is only ever held in
memory. After a restart an old DM shows its command and reply length, as on
the public page.

## Residual risks, stated plainly

1. Anyone who can reach the portal can operate it, including pointing mode,
   which stops reception. That is the chosen model; the defaults now keep
   "anyone who can reach it" to the machine itself. An operator who binds
   it to a LAN address (and lists the name in `MCW_PORTAL_ALLOWED_HOSTS`)
   is back to "anyone on the LAN".
2. A determined attacker can generate a keypair matching the admin prefix.
   The most the bot can compare is 12 hex characters (48 bits); use all 12.
3. The satellite feed is unauthenticated. A local transmitter on 1.694 GHz
   could feed the receiver forged products; the parsers will not crash, but
   the bot would repeat what it was fed. There is no fix for this in
   software short of cross-checking sources, which an offline deployment
   cannot do.
4. Channel names are public knowledge; anyone can post requests, text or
   `>`. The budgets bound the cost; region scope on the repeaters bounds the
   reach. A channel name cannot: repeaters forward the ciphertext of every
   flood they hear, whatever its channel.
6. The scheduled ceiling is per bot. Two bots whose coverages overlap each
   send their own warnings for the overlap until cross-bot coordination
   exists; `dm` reply mode and an honest radius keep the rest apart.
5. The dashboard's LAN test compares text prefixes, and `172.2` also matches
   public addresses (172.2.x.x, 172.200.x.x and up). Such an address
   reaching port 8080 directly, not through Cloudflare, gets the controls.
