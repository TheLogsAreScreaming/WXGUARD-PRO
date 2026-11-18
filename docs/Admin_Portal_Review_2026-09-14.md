# Admin portal review and revamp, 2026-09-14

> **Status, 2026-09-15:**
> - Implemented as described, in d5171e4. `portal/templates/app.html` and `portal/static/portal.js` still render the six sections and the ten Overview tiles.
> - Added since: Radio has Health and Hardware cards for radio swaps and adoption (cf1da42, ddd48a3, `docs/Radio_Swap.md`). Text Bot > Behaviour and System carry the echo and resend settings (6af542e).
> - Superseded: the "Kept on purpose" paragraph at the end. ad6dc24 replaced the v4 protocol and scheduler with MeshWX v5 (four job products) and stopped decoding WXQ/MWX requests; the last prefix check went on 2026-09-15. The same commit deleted the iOS brief and dropped the discovery channel role, so Radio now edits two roles, text and data. `MCW_MESHWX_CHANNEL` is still read.
> - Superseded, 2026-10-19: the six sections and the ten Overview tiles. The portal now has the public dashboard's look and six tabs by job (Overview, Mesh, Radio, Station, Settings, Logs): the Overview opens on a server-built "Needs attention" list (`admin.attention`), every `.env` setting is under Settings with one save bar, and Station proxies the dish's pointing meter and gain.
> - Where the current truth lives: the portal code above, the README's admin portal section, and `docs/MeshWX_v5_Spec.md` revision 3.

Two adversarial reviews (one on navigation and UX, one on dead code and
leftovers from the original meshwx project) were run against the admin
portal on :8081, and the portal was rebuilt from their findings. This is the
short record of what was wrong and what the portal is now.

## What the reviews found

Structure. Eight sections, five different code paths that wrote `.env`, the
same setting editable in two places (channel names on Radio and on Text Bot,
"Broadcast Now" on Overview and on System), coverage shown in three cards and
edited in a fourth, two activity logs with identical data (an Overview table
and a bottom panel on every page), and "EMWIN products" counted in four
places. "Console" in the nav meant the log stream; a card called "Console"
inside Text Bot was the command tester.

Wrong or stale. The System coverage preview map drew a bounding box computed
without the radius, so it showed an area the bot does not use. "Broadcast Now"
only ran jobs that were already due and reported "Done" regardless. The
contacts card said the node stores 100 contacts; the firmware reports 350. An
Overview hint said "Meshtastic channel". The bottom panel was styled with CSS
variables that were never defined. Settings were written to `.env` before they
were validated, so a bad value could be persisted and refuse the next start.
The Broadcast section's refresh timer was never cleared. Live dots were
hard-coded green. The job form offered location types the executor does not
support for three products.

Dead weight. MapLibre and three GeoJSON files (2.1 MB) served only the Weather
Map and the wrong preview map. HTMX (50 KB) was referenced by nothing. Eight
routes and five legacy redirects had no caller. `/api/actions/v2-request`
tried to clear a rate limit that no longer existed. `meshwx_broadcast_interval`
had no reader. The activity event types were still named `v1_refresh`,
`v2_request`, `v2_response`.

## What the portal is now

Six sections. Each setting is rendered by exactly one card, in the section
that owns the subsystem it configures; everywhere else it appears read-only
with a link.

- **Overview**: ten tiles (dish, feed, radio, transmit and reply mode,
  answering, broadcasts, problems, audit, host, bot), the last twelve traffic
  lines, the audit result. One `/api/overview` call every 15 s also feeds a
  status strip in the header on every page.
- **Text Bot**: counters, the live feed, "Try a command", the `help` text,
  and the one Behaviour card (reply mode with a confirmation before
  `channel`, stranger hop limit, advert interval, peer-bot prefix). A
  read-only "listening on" card points at Radio for channel names.
- **Broadcasts**: counters, jobs, "Run due jobs" that reports what it sent,
  and the broadcast log (renamed from Activity Log, honest labels, live dot).
- **Radio**: link and node tiles, reconnect, identity, LoRa preset merged into
  the Apply flow, transmit, the single channel editor (three role names plus
  the slot table under a disclosure) [2026-09-15: two roles now, text and
  data, since ad6dc24], contacts with housekeeping and the real
  slot count from the firmware.
- **Satellite**: signal, feed, goesrecv/goesproc, and the product browser
  (moved from Broadcasts). Pointing mode asks first because it stops the feed.
- **System**: Logs (with a problems chip) and Settings (coverage with states
  and offices now editable, host and feed with live/restart badges, restart).
  Forms send only the keys that changed; the server validates every value
  before touching `.env`.

Removed: Weather Map, coverage preview map, MapLibre, GeoJSON, HTMX, the
bottom panel, Developer Tools, `/api/status`, `/api/warnings`,
`/api/coverage/*`, `/api/autocomplete/*`, `/api/actions/v2-request`,
`/api/radio/stats`, `/api/sdr/gain`, the `/config` `/schedule` `/data`
`/products` `/status` redirects, the boot JSON. Added: `/api/overview`,
coverage in `/api/system`, a shared SSE helper with heartbeats
(`portal/sse.py`) behind all three streams.

Kept on purpose: the WXQ/MWX text-prefixed app requests (the iOS brief still
publishes them), the `MCW_MESHWX_*` env keys (live `.env` files use them),
the v4 binary protocol and scheduler (live, three jobs enabled on the Pi).
[2026-09-15: superseded by ad6dc24; see the status note at the top.]
