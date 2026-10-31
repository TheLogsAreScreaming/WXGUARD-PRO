# MeshWX v5: the weather protocol for MeshCore apps

**Protocol version 5.** Bundle: `protocol.json` version 17, `index.json` version 2,
`pfm_points.json` version 2, `zips.json` version 1. Updated 19 October 2026.

MeshWX is how a weather bot on a [MeshCore](https://meshcore.co) mesh tells apps about the
weather: National Weather Service warnings, current conditions, forecasts, alert maps, radar and
text products, as small binary datagrams on one channel. This document is everything a client
needs to take part: what goes on the air byte by byte, what a bot sends and when, how to ask it
for something, and how a client should store and show what it hears.

**How to read it.**

- **Part 1, the protocol** (sections 1 to 16): the wire format, the requests, what a bot sends
  unasked, and the bundle. Everything in it is needed to interoperate.
- **Part 2, client behaviour** (sections 17 to 23): how to store, show and ask. These are the
  rules the two reference clients follow. A client that ignores them still decodes everything,
  but it will tell people wrong things: that a warning has ended when it has not, that a
  two-hour-old reading is current, that a state nobody reported on is clear.
- **Appendix A** lists the test vectors.

**Must** marks a rule a client or a bot has to follow to interoperate; **should** marks a rule
the reference clients follow and recommend. Where this document and the reference code disagree,
this document is the contract and the code has a bug.

**Reference implementation.** `meshcore_weather/protocol/v5.py` (pure Python, standard library
only) encodes and decodes every message. The test vectors are `docs/meshwx_v5_vectors.json`
(Appendix A): a decoder is correct when it decodes every vector to the JSON shown, and an encoder
when it re-encodes every vector within the send limit to the same hex. Two clients implement all of it and carry the vectors as tests: the iOS app
([DigitainoMesh](https://github.com/digitaino/DigitainoMesh)) and the web client in this
repository ([`web/`](../web/README.md)), the smaller of the two to read.

**Two design rules.** The mesh carries identifiers and numbers; the phone carries the tables and
the words. And nothing is flooded twice unless a person asked for it, the mesh demonstrably did
not repeat it, or it is a new life-safety warning (section 3.6).

## Contents

**Part 1: the protocol**

1. [Overview](#1-overview)
2. [Transport and header](#2-transport-and-header)
3. [Warning (type 1)](#3-warning-type-1)
4. [Cancel (type 2)](#4-cancel-type-2)
5. [Digest (type 3)](#5-digest-type-3)
6. [Observations (type 4)](#6-observations-type-4)
7. [Forecast (type 5)](#7-forecast-type-5)
8. [Text (type 6)](#8-text-type-6)
9. [Not available (type 7)](#9-not-available-type-7)
10. [Coverage (type 8)](#10-coverage-type-8)
11. [Request (type 9)](#11-request-type-9)
12. [Area sweep (type 10)](#12-area-sweep-type-10)
13. [Radar (type 11)](#13-radar-type-11)
14. [Requests](#14-requests)
15. [What a bot sends unasked](#15-what-a-bot-sends-unasked)
16. [The preload bundle](#16-the-preload-bundle)

**Part 2: client behaviour**

17. [Receiving and storing](#17-receiving-and-storing)
18. [Showing the weather](#18-showing-the-weather)
19. [Asking, and airtime](#19-asking-and-airtime)
20. [Discovery and several bots](#20-discovery-and-several-bots)
21. [Search and places](#21-search-and-places)
22. [Text commands for people](#22-text-commands-for-people)
23. [Implementation checklist](#23-implementation-checklist)

[Appendix A: test vectors](#appendix-a-test-vectors)

Sections 3 to 13 are the message types in type order: the section for type *n* is *n* + 2.

---

# Part 1: the protocol

## 1. Overview

A **bot** is a MeshCore companion radio driven by the MeshWX bot software and advertised as a chat
node named `WX-<place>`, for example `WX-AUS` for Austin. It receives NWS products, off the GOES
satellite with its own dish, from the internet, or both (section 2.3), and puts two things on the
mesh:

1. **Binary datagrams for apps**: warnings and their cancellations, a digest of what is active,
   observations, forecasts and the bot's coverage, all broadcast on a schedule; and, on request,
   alert maps, radar tiles and text products. Each is a MeshCore `GRP_DATA` packet on the channel
   `#meshwx`. Apps decode them with the tables in the preload bundle (section 16) and draw them.
2. **Text for people**: anyone can send a command such as `wx austin tx` to the bot, on `#meshwx`
   or by DM, and get a plain-text reply (section 22).

An app asks with short request words prefixed with `>` (section 14), normally flooded on `#meshwx`
as a Request datagram (section 11). The bot answers on the channel, as binary, so one
request serves every app listening. Nothing is addressed back to one phone.

A client finds bots by their adverts (section 20). There is no discovery channel and no beacon.

### 1.1 What a client needs

- A MeshCore companion radio with firmware **v1.15.0 or newer**. Older firmware never delivers
  `GRP_DATA` to the app: it drops it silently, with no error.
- To send Request datagrams, firmware with `CMD_SEND_CHANNEL_DATA` (0x3E). Without it, send
  requests as a DM (section 14.1).
- The channel `#meshwx`, added by name. Its key is derived from the name, as for any MeshCore
  hashtag channel.
- The preload bundle (`client_data/`, section 16).

### 1.2 The radio

US preset: 910.525 MHz, bandwidth 62.5 kHz, SF7, coding rate 4/5. A 50-byte packet costs about
260 ms of airtime and a 100-byte packet about 460 ms, and every repeater in range sends a flood
once more. Airtime is shared by everyone on the mesh: ask when a person asks, and never poll
(section 19).

### 1.3 Conventions

- All multi-byte integers are **little-endian**, MeshCore's own convention. Signed integers are
  two's complement; `i24` is a three-byte signed integer.
- Times are **Unix minutes** (Unix seconds divided by 60) in a u32, unless a field says otherwise.
  A relative time says what it is relative to.
- An index (`event`, `office`, `station`, `state`, `point`, `product`) points into a table of the
  bundle (section 16). The tables are append-only, so an index never changes meaning.
- A field that can be unknown has a stated sentinel, such as 255 or −128. Never show a sentinel
  as a value.
- Offsets in the layout tables count from the first byte of `data`, the bytes the companion
  delivers (section 2.1).
- Where an encoder rounds (degrees to a compass point, mph to 5-mph steps, a coordinate to its
  fixed point), the reference encoder rounds half to even. The vectors avoid exact halves, so a
  client that rounds half up still matches them. Per-station ages (6.1) are the exception: they
  round half up. Unix minutes and other divisions (`feed_health`) round down.

### 1.4 Terms

| Term | Meaning |
|---|---|
| bot | A MeshWX weather node, advertised as `WX-<place>` |
| client, app | Anything that decodes MeshWX: a phone app, the web client, a script |
| companion | The MeshCore radio a client talks to over Bluetooth, USB or serial |
| flood | A packet every repeater passes on once. Channel packets travel this way |
| echo | A repeater's retransmission of a packet, heard back by the node that sent it |
| NWS | The US National Weather Service |
| office, WFO | An NWS Weather Forecast Office, by its three-letter code: `EWX` is Austin/San Antonio |
| VTEC | The NWS code that identifies an event: a phenomenon and significance (`SV.W`, severe thunderstorm warning), the issuing office and an event tracking number (ETN) |
| significance | The last letter of a VTEC event code: W warning, A watch, Y advisory, S statement |
| UGC | An NWS area code: state, `C` for a county or `Z` for a forecast zone, and a number. `TXC453` is Travis County, `TXZ192` a zone |
| METAR, TAF | An airport's weather observation and its terminal forecast, by ICAO code (`KAUS`) |
| PFM | Point forecast matrix: the NWS product a bot's forecasts are built from, for fixed points |
| AFD | Area forecast discussion: an office's narrative forecast |
| EMWIN | The NWS product stream the GOES satellites rebroadcast, which a bot's dish receives |
| advert | A MeshCore node's signed announcement of its name and public key, flooded now and then; every MeshCore app collects them |
| home | A bot's configured home point (its city), the office it lies in (home office), its state (home state), and the radius around it within which it takes stations for Observations (home radius, the Coverage `radius`) |
| VTEC action | What a product does to an event: NEW, CON (continues), EXT, EXP (expires), CAN (cancels), UPG (upgraded), and so on |
| segment, UGC expiry | One part of an NWS product, for one set of areas, and the time that part's area list stops being valid |
| `DDHHMMZ` | A report's day of the month, hour and minute, UTC, as written in METARs and product headers |
| dBZ | Radar reflectivity; higher means heavier precipitation |
| ZCTA | Census ZIP Code Tabulation Area: the Census Bureau's approximation of a ZIP code's area |

## 2. Transport and header

### 2.1 The packet

Every MeshWX message is the `data` of one MeshCore `GRP_DATA` packet (payload type 6) on
`#meshwx`, with `data_type = 0xFF10`. That number is in MeshCore's development range; if a
permanent one is assigned, `protocol.json` will say so.

What the companion delivers to a client, `RESP_CODE_CHANNEL_DATA_RECV` (0x1B):
`[0x1B][SNR i8, in quarter dB][2 reserved][channel index u8][path length u8][data_type u16]
[data_len u8][data]`. Ignore every `data_type` other than `0xFF10`. A bot's operator link test uses
`0xFF1E`, a 6-byte datagram that carries nothing for a client.

How a client sends one (a Request, section 11), `CMD_SEND_CHANNEL_DATA` (0x3E):
`[0x3E][channel index u8][path length u8: 0xFF for a flood][data_type u16][data]`, with no path
bytes when flooding. The companion floods it on that channel. The other companion frames are
MeshCore's companion protocol; the web client's `web/src/radio/` is a readable implementation.

What goes on the air, for reference (a client never sees this layer):
`[channel hash 1][MAC 2][AES-128-ECB(channel key) of [data_type u16 LE][data_len u8][data]]`.

**Sizes.** `data` is at most **165 bytes**, the transport's limit, and a decoder must accept
anything up to that. A bot sends at most **157 bytes**, with one exception below, and every
maximum in this document is what fits in 157. `protocol.json` has both: `v5.max_data` is 165,
`v5.max_send` is 157.

Why 157: a bot confirms a packet got out by hearing a repeater pass it on (section 2.4), and the
companion firmware reports a heard packet only when the raw packet plus 3 bytes fits its 172-byte
frame. The cipher text is `data` plus its 3 bytes of type and length, padded to a multiple of 16,
and a repeater's copy adds a header byte, a path-length byte and one path hash (2 bytes on this
mesh). 157 bytes of `data` encrypt to 160 and come back as 167 raw bytes, which is reported; 158
to 165 encrypt to 176 and come back as 183, which is not.

The exception is a full Digest, 25 entries in 160 bytes (section 5). Its sender cannot hear its
echo.

Every message fits in one packet. Two kinds of answer can need more than one: Text (section 8) and
Area sweep (section 12). Each of their packets is a complete message that carries its own group,
index and total.

### 2.2 Common header

Every message starts with these 4 bytes.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0 | 1 | `seq` | The bot's sequence number, one more for every packet it transmits, wrapping from 255 to 0 (section 2.4). In a Request, the sender's own counter (section 11) |
| 1 | 2 | `bot` | u16, the first two bytes of the bot's public key read as a little-endian number. In a Request, the bot being asked |
| 3 | 1 | `type` | High nibble: the message type. Low nibble: flags. Bits 0 and 1 mean something different in each type; bits 2 and 3 are the data source (section 2.3) in every type but Cancel |

`bot` is read little-endian like every other integer, so the key that starts `1D 04` is
`bot = 0x041D`. MeshCore apps print keys in key order, so show it to people as `1D04`.

| Type | Message | Direction | Section |
|---|---|---|---|
| 0 | Not used | | |
| 1 | Warning | bot → app | 3 |
| 2 | Cancel | bot → app | 4 |
| 3 | Digest | bot → app | 5 |
| 4 | Observations | bot → app | 6 |
| 5 | Forecast | bot → app | 7 |
| 6 | Text | bot → app | 8 |
| 7 | Not available | bot → app | 9 |
| 8 | Coverage | bot → app | 10 |
| 9 | Request | app → bot | 11 |
| 10 | Area sweep | bot → app | 12 |
| 11 | Radar | bot → app | 13 |
| 12 to 15 | Free for third-party experiments. A bot never sends them | | |

### 2.3 Data source

Flags bits 2 and 3, `(type & 0x0C) >> 2`, say where the weather in a message came from. They mean
the same in every type that carries them.

| Value | Name | Meaning |
|---|---|---|
| 0 | unstated | The bot makes no claim |
| 1 | GOES | Received off the GOES satellite by the bot's own dish |
| 2 | internet | Fetched from the NWS over the internet: its EMWIN feed, or its web services |
| 3 | mixed | Built from products of both kinds |

A bot can get its products either way. A bot with a dish takes everything it can from the dish, and
fills in from the NWS website whatever the dish has not brought within a grace period of its issue
time (2 minutes for warnings, watches and statements, 15 minutes for the rest). A bot without a dish
takes the NWS's EMWIN feed over the internet, filled in the same way.

A message rendered from one product (a Warning, a Forecast, a narrative, a radar tile) states that
product's source, except a raw METAR and a TAF asked for by station, which state the store-wide
source described next. A message built from many (a Digest, an Observations batch, an Area sweep, a list
of storm reports) states `mixed` when its products did not all arrive the same way. A bot may judge
that from everything it holds rather than from the products in the message, so `mixed` on such a
message means at least that the bot holds products of both kinds.

Three types always send 0, because no weather product is behind them: **Request** (type 9, sent
by an app), **Not available** (type 7) and **Coverage** (type 8, which describes the bot's own
configuration).

**Cancel (type 2) has no data source.** Its whole flags nibble is a reason code (section 4), so
bits 2 and 3 of a Cancel are part of that number. Never read a source out of a Cancel.

Read 0 as the absence of a claim, never as a claim of absence: it is not evidence that a bot has
no dish. Section 18.7 says how to use the source on screen.

### 2.4 Sequence numbers and copies

- A bot assigns `seq` when a packet is transmitted, not when it is built. Scheduled broadcasts and
  answers share one counter, and a number is used only by a packet the bot's radio accepted, so a
  bot never leaves a gap of its own making.
- A bot transmits one batch at a time: an answer never interleaves with a scheduled broadcast, and
  packets leave in `seq` order, except a resend (below), which can follow later packets. The mesh
  can still deliver packets out of order, since two floods may take different paths.
- The counter survives a restart. Before a batch starts, a bot saves the first number the batch will
  not use, so a bot killed part-way comes back ahead of every number it may have used: a client sees
  a gap, never a repeated `seq`.
- **A resend is the same bytes.** A bot listens for a repeater's echo of every packet and, when it
  hears none within about 8 seconds (plus up to 2 seconds of jitter), sends the packet once more,
  byte for byte identical, with the same `seq`. It skips the resend when its hourly resend budget
  is spent, when it has heard nothing repeated on the mesh for 10 minutes, and for a packet too long
  for its echo to be reported (a full Digest, section 2.1). MeshCore nodes drop a packet whose hash
  they have seen, so a client's radio normally never delivers the copy; if it does, `(bot, seq)` and
  the content are the same and the client drops it.
- **A new message always has a new `seq`.** A gap in one bot's numbers means a missed message
  (section 17.2).
- Warnings are identified by `(event, office, etn)`, not by `seq` (section 3).

### 2.5 What a decoder must tolerate

A newer bot may send more than this document describes, and an older client must keep working.
So a decoder:

- **ignores a message of an unknown type**, whole;
- **ignores flag bits** this document does not define (a sender sets them to 0);
- **reads every list by its own count** and ignores bytes after the last field it knows. That is
  how a decoder that does not know a Warning's start skips it (section 3.4). Text, Request and Area
  sweep end in a field that runs to the end of the packet, so they cannot grow at the tail;
- **never rejects a message for being longer than a bot sends.** Anything up to 165 bytes of
  `data` is valid;
- **rejects a message that is shorter than its own fields and counts require.** It may also reject
  one whose counts are outside the ranges given here, such as a polygon of fewer than 3 vertices.

A decoder should not validate indices and codes against its own tables when it decodes: an
`event`, `office`, `station`, sky code, subject or `product` it does not know comes from a newer
bundle (section 16.3), and is a matter for display. These rules are for messages a bot sends; a
bot applies stricter ones to the Requests it reads (section 11).

## 3. Warning (type 1)

One active NWS warning, watch, advisory or statement in the bot's coverage, or one a request
asked for: what it is, who issued it, when it expires, its storm tags, and where it is, as a
polygon, a list of counties or zones, or both.

A warning is identified by **`(event, office, etn)`**. A Warning with an identity a client
already holds replaces the stored one; a Cancel (section 4) or a Digest (section 5) ends it.

Flags nibble: bit 0 = update. It is set on a warning the bot has sent before and on every answer to
`>w`, and clear on a first broadcast and on its repeat (3.6). It is informational and not reliable:
replace by identity either way. Bit 1 = the issue time is present (section 3.4). Bits 2 and 3: data
source (section 2.3).

### 3.1 Layout

After the header (section 2.2):

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 1 | `event` | The VTEC event, by the number `protocol.json` `events` gives its code (`"SV.W"` is 3). Names from `event_names`. The significance is the code's last letter: W warning, A watch, Y advisory, S statement |
| 5 | 1 | `office` | Index into `index.json` `offices`: the issuing office, a WFO (`EWX`) or a national centre (`NHC`, or `WNS` for the Storm Prediction Center). A bot does not send a product from an office the bundle does not list |
| 6 | 2 | `etn` | u16, the event tracking number |
| 8 | 4 | `expires` | u32 Unix minutes, absolute. Treat the warning as ended when it has passed |
| 12 | 1 | `tags` | Bits 7-6 tornado: 0 none, 1 possible, 2 radar indicated, 3 observed. Bits 5-4 flood source: 0 none, 1 radar, 2 radar and gauge, 3 observed. Bits 3-2 flood damage: 0 none, 1 considerable, 2 catastrophic. Bit 1: a polygon follows. Bit 0: an area list follows |
| 13 | 1 | `hail` | Hail tag in quarter inches (4 = 1.00 in). 0 = none |
| 14 | 1 | `wind` | Wind tag in mph. 0 = none |

Then, in this order: the polygon when `tags` bit 1 is set (3.2), the area list when `tags` bit 0
is set (3.3), and the issue time when flags bit 1 is set, with the start after it when the
product has one (3.4).

### 3.2 Polygon

| Size | Field | Meaning |
|---|---|---|
| 1 | `n` | Vertex count, 3 to 30 |
| 3 | `lat0` | i24, degrees × 10000 |
| 3 | `lon0` | i24, degrees × 10000 |
| 4 × (n − 1) | deltas | For each further vertex: `dlat` i16, `dlon` i16, in 0.001° from the previous vertex |

The ring closes by itself: the last vertex is not a repeat of the first. Every vertex is a whole
number of 0.0001° units (a delta is 10 units), so accumulate in integer units, or round each
vertex to 4 decimals, to get the exact coordinates back.

### 3.3 Area list

| Size | Field | Meaning |
|---|---|---|
| 1 | `k` | Number of runs, 1 to 30 |
| 4 × k | runs | Each: `state` u8 (bit 7 = 1 for a county, 0 for a forecast zone; bits 6-0 an index into `index.json` `states`), `start` u16, `run` u8 |

A run covers the UGC numbers `start` to `start + run − 1` in one state. `TXZ191` to `TXZ194` is
state TX, zone, `start` 191, `run` 4. Coverage (section 10) uses the same record; an Area sweep
entry (section 12) is a different one.

Storm-based warnings (tornado, severe thunderstorm, flash flood) carry a polygon and usually the
counties it crosses. Tornado and severe thunderstorm watches have no polygon: their counties are
their whole area. Zone-based products (winter, heat, wind, fire and most advisories) carry zones
only. Draw the polygon when there is one and name the counties under it; otherwise fill the listed
zones or counties from `zones.geojson` or `counties.geojson` (section 16).

### 3.4 Issue time and start

When flags bit 1 is set, two bytes follow the area list (or the polygon, or `wind`, whichever
came last):

| Size | Field | Meaning |
|---|---|---|
| 2 | `issued_before` | u16, the minutes from the issuance to `expires`. The issue time is `expires − issued_before`. 65535 means 65535 minutes or more (45.5 days): read it as "at least that long ago" |

When two more bytes follow the issue time, they are the start:

| Size | Field | Meaning |
|---|---|---|
| 2 | `begins_before` | u16, the minutes from the moment the product takes effect to `expires`. The start is `expires − begins_before`. Always smaller than `issued_before` |

The start has no flag bit; a decoder finds it by length, reading it when at least two bytes remain
after the issue time and ignoring anything after it. A `begins_before` of 0, or one not smaller
than `issued_before`, is not a start after issuance: ignore it. (A start can therefore not be
sent when `issued_before` has saturated at 65535.) A bot sends the start only when the
product takes effect **later than it was issued**, such as a watch issued on Tuesday morning for
Wednesday evening through Friday. With no start, the product is in effect from its issue time. A
product that starts at different times in different zones carries the earliest.

Both times are relative to `expires` in the same packet, so a message drained from an offline
queue hours later still decodes to the same instants.

The issue time is the **product's own issuance**: the time in the header of the NWS product that
created the event, kept across its updates, so a follow-up statement does not restamp a warning as
newly issued. It is not when the bot received the product and not when the phone heard the packet.
A radio that was out of range for three hours must still say *issued 1:29 PM*.

### 3.5 Fitting in a packet

A warning with a large polygon or a long area list can pass the send limit. The bot then tries
these in order and sends the first that fits:

1. the first 30 vertices and 30 runs;
2. the polygon thinned to 16 vertices (every few vertices, by index), and 30 runs;
3. 16 vertices and 12 runs;
4. 10 vertices and 6 runs;
5. 8 vertices and no runs;
6. no polygon, and 30 runs.

When runs are dropped, the ones that touch the bot's coverage, or the area a request asked about,
are kept first, then put back in ascending order. Nothing on the wire says an area list was cut.
A warning that fits none of these is not sent.

The issue time and the start are never shed: four bytes at most, and *issued 1:29 PM* and *from
Wed 19:00* matter more than the shape of the eighteenth corner.

Sizes: the fixed part is 15 bytes, header included; a polygon of `n` vertices is 3 + 4 × `n`; an
area list of `k` runs is 1 + 4 × `k`. A severe thunderstorm warning with 6 vertices and 2 counties
is 15 + 27 + 9 = 51 bytes, 53 with the issue time and 55 with a start.

### 3.6 When a bot sends a Warning

- When a warning, watch, advisory or statement becomes active in the bot's coverage (section 10),
  with flags bit 0 clear; and on request (section 14), with bit 0 set.
- Again, with bit 0 set, whenever something material changes: the expiry (to the minute), the
  start (to the minute), the tags, the list of zones or counties, or the number of polygon
  vertices. Not for a change of wording.
- A product in force "until further notice" has no expiry, so the bot gives it the time it will
  keep it until: 24 hours after the UGC expiry of its segment, or after the product's own issue
  time when there is none, unless it is cancelled first. That invented expiry moves only when a new
  statement arrives, and it counts as a material change only when it moves into a different half
  hour (`expires / 30`, rounded down, changes).
- A **new tornado (`TO.W`), severe thunderstorm (`SV.W`), flash flood (`FF.W`) or extreme wind
  (`EW.W`) warning** is sent once more about two minutes after the first: the same warning under a
  new `seq`, flags bit 0 clear. This is the one thing a bot floods twice unasked.

The bot checks for new and changed warnings every 2 minutes.

## 4. Cancel (type 2)

A warning this bot sent is no longer active in its coverage, more than 5 minutes before its stored
expiry: the NWS cancelled it, let it expire early or upgraded it (VTEC CAN, EXP, UPG), or it ended
for the part of its area the bot covers. Sent once. Remove the identity.

| Offset | Size | Field |
|---|---|---|
| 4 | 1 | `event` |
| 5 | 1 | `office` |
| 6 | 2 | `etn` u16 |

8 bytes in all.

The flags nibble, all four bits, is the reason: 0 cancelled, 1 expired early, 2 upgraded (a new
warning with the replacement follows). A bot sends 0 for all three today, so never wait for a
replacement. Values 3 to 15 are undefined; read any of them as "ended", which is the part of a
Cancel that matters. A Cancel carries no data source (section 2.3).

## 5. Digest (type 3)

The list of everything active in the bot's coverage. A client uses it to recover from packets it
missed: an identity in the digest it does not hold is one `>w <identity>` away (section 14), and
an identity it holds that the digest no longer lists has ended (section 17.3).

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 4 | `now` | u32 Unix minutes when the digest was built. The entries are relative to it, so a digest drained from an offline queue hours later still decodes correctly |
| 8 | 1 | `feed_health` | How old the newest product the bot holds from its home office is, by that product's own issue time, in units of 4 minutes: `min(255, minutes / 4)`. 255 = 17 hours or more, or none held |
| 9 | 1 | `count` | 0 to 25 |
| 10 | 6 × count | entries | Each: `event` u8, `office` u8, `etn` u16, `expires_rel` u16, minutes after `now` (0 to 65535; an expiry already past reads as `now`). A bot sorts them by expiry, soonest first; a decoder must not depend on the order |

**At most 25.** A digest lists the 25 identities that expire soonest (the reference bot does list
25), so a digest of 25 may have been cut. A full digest is 10 + 6 × 25 = 160 bytes, the one message past the 157-byte send limit
(section 2.1); a bot that keeps every message within 157 lists 24. So a client reads a `count` of
**24 or more** as possibly cut (section 17.3).

**It speaks for the bot's coverage.** The list is what is active in the area the bot's Coverage
statement describes (section 10). A bot also answers requests that name places outside that area
(section 14.6), so a client can hold warnings from a bot that no digest of that bot will ever list.
Section 17.3 says how a client applies a digest without ending those.

**`feed_health`** measures how quiet one office is, not the satellite link. The home office is
the one the bot's home point lies in, unless the operator named offices; for WX-AUS it is EWX.
Products from the internet count as well as products off the dish, so a dead dish does not raise
it while the internet fills in (section 2.3). A calm night at one office pushes it past 60 (4
hours) while everything is working, so word it as "the bot has not heard from EWX for 5 h", not as
a broken feed. 255 means nothing from the home office in at least 17 hours, and only 255 justifies telling a person that alerts may not
be reaching them. A
quiet office and a dead feed look the same in this byte, and nothing else on the wire tells them
apart; a person can ask `>sat` (section 14), which describes the bot's receiver and how far behind
the products are running.

A bot sends a Digest every 3 hours, one minute after any Cancel, after the warnings of a bare `>w`,
and on request (`>d`).

## 6. Observations (type 4)

Current conditions for the METAR stations around the bot's home, in one packet, every hour and on
request.

The station list is rebuilt for every batch: stations within the bot's home radius that have filed
a METAR in the last 120 minutes, nearest the bot first, as many as fit: 12, with the ages below,
which a bot always sends. A batch can hold fewer, because a station chosen by when its report
arrived is left out when the report's own time turns out older than 120 minutes. Stations drop out when they stop reporting, so a batch is not a
description of what the bot covers; Coverage is (section 10).

Flags nibble: bit 0 = per-station ages present (6.1). Bits 2 and 3: data source.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 4 | `ts` | u32 Unix minutes of the newest report in the batch, by the report's own `DDHHMMZ` time, not by when the bot received it |
| 8 | 1 | `n` | Station count: 1 to 12 with the ages, 1 to 13 without |
| 9 | 11 × n | stations | Below |
| 9 + 11 × n | ceil(n / 2) | ages | Only when flags bit 0 is set (6.1) |

Per station, 11 bytes:

| Size | Field | Meaning |
|---|---|---|
| 2 | `station` | u16 index into `index.json` `stations` (ICAO codes) |
| 1 | `temp` | i8 °F; −128 = unknown (a report without a temperature is not sent, so in practice never) |
| 1 | `dewpoint` | i8 °F; −128 = unknown |
| 1 | `dir_sky` | High nibble: wind direction on a 16-point compass (0 N, 4 E, 8 S, 12 W). Low nibble: sky code (`protocol.json` `sky_codes`, section 18.6); 15 when the report has no cloud or weather group |
| 1 | `wind` | u8 mph; 255 = unknown |
| 1 | `gust` | u8 mph; 0 = none |
| 1 | `visibility` | u8 whole statute miles, rounded down (1/2SM and M1/4SM are 0, 1 1/2SM is 1); 255 = unknown |
| 1 | `pressure` | u8, (inHg − 29.00) × 100: 92 is 29.92. 255 = unknown, and also sent for a reading outside 29.00 to 31.54 inHg |
| 1 | `humidity` | u8 percent; 255 = unknown (temperature or dewpoint unknown) |
| 1 | `feels` | i8, feels-like minus temperature in °F (heat index or wind chill); 0 = the same |

The direction nibble has no unknown value: a calm wind sends 0 with speed 0, and a variable wind
(VRB) or a report with no wind group also sends 0. So direction 0 with a speed above 0 means north
or variable.

A group the METAR did not carry is sent as that field's unknown value; a bot never fills in a
default. A station whose report still cannot be encoded is left out and the rest of the batch is
sent.

A batch of 13 stations is 9 + 11 × 13 = 152 bytes; with ages for 13 it would be 159, past the
send limit, so the ages cost the thirteenth station and a full batch with ages is
9 + 11 × 12 + 6 = 147 bytes. The bot drops the farthest station, never the ages.

### 6.1 Per-station ages

`ts` is one time for the whole batch, the newest report in it, while another station in the same
batch may have filed its report up to 120 minutes earlier. The ages say how far behind `ts` each
station's **own** report is.

The block is `ceil(n / 2)` bytes, one nibble per station, in station order: station `i` is the low
nibble of byte `i / 2` when `i` is even and the high nibble when it is odd. With an odd `n` the
last high nibble is 0 padding.

A nibble is the age in **10-minute steps**, 0 to 15, rounded half up: 0 to 150 minutes, and 15
means 150 minutes or more. A station's report time is `ts − 10 × age` minutes. The newest station
always reads 0.

The ages are all or nothing: flags bit 0 set means every station in the batch has one.

### 6.2 One station

`>o KAUS` (section 14) answers with the same message and `n = 1`, but not always for the station
named. When KAUS has no report from the last 120 minutes, the answer is the **nearest station
within 40 km of it that has one**, under that station's own index. A phone that asked for KFFO
(Wright-Patterson AFB, which does not report on the feed) gets KDAY (Dayton International,
16.6 km away) and files it under KDAY. When nothing within 40 km has a report that young, the bot
walks the same stations again, the named one first and then the rest nearest first, and answers
with the first report **up to 12 hours old** it finds; a young report from a neighbour has already
beaten the station's own old one. That answer is the same message, with `ts` the report's own time and its
age 0, so a client dates it exactly and shows it with its age (section 18.3). Nothing within 40 km
in 12 hours: Not available, reason 0.

The hourly batch and the bare `>o` admit only reports from the last 120 minutes.

## 7. Forecast (type 5)

A point forecast (NWS PFM) as **whole days**, up to seven, for the bot's home point every 6 hours
and on request for any point.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 2 | `point` | u16 index into `pfm_points.json` `points`. 0xFFFF = a point the bundle does not have (below) |
| 6 | 4 | `issued` | u32 Unix minutes the forecast was issued |
| 10 | 1 | `first` | Period id of the first entry (below) |
| 11 | 1 | `n` | Entry count, 1 to 14; in practice 1 to 7, one per day |
| 12 | 5 × n | periods | Below |

Per period, 5 bytes:

| Size | Field | Meaning |
|---|---|---|
| 1 | `high` | i8 °F, the day's high; 127 = not available |
| 1 | `low` | i8 °F, the night's low; 127 = not available |
| 1 | `pop` | u8 probability of precipitation, percent; 255 = not given (a bot sends 0 when the product gives none) |
| 1 | `cond` | Low nibble: sky code. High nibble: bit 4 thunder, bit 5 wintry, bit 6 windy, bit 7 fog |
| 1 | `wind` | High nibble: direction (16-point compass). Low nibble: speed / 5 mph, 15 = 75 mph or more |

**Days.** Period ids count half-days from the issue date, the local date of `issued` at the
point: even ids are days, odd ids nights, and the day offset is `id / 2`. A bot works the date out
from the point's own time zone. The bundle carries no time zones, so the reference clients use the
phone's; a phone far from the point can label the days one off near midnight. A bot
sends whole days, so `first` is even and entry `i` is the day `first / 2 + i` days after the issue
date. An evening issuance usually has no useful rest of today, so its first entry is tomorrow and
`first` is 2. Every entry carries a high and a low: a bot fills both, from the product's daily
extremes or else its 3-hourly temperatures, and ends the list at a day it cannot fill. 127 is
reserved for a half of the day the product does not cover; it does not mark a night.

The half-day ids leave room for day and night entries without a format change. Read whole days
unless `first` is odd or the entries alternate between a missing high and a missing low; then read
half-day periods, entry `i` being period `first + i`, and show alternating day and night rows. Both vectors decode (Appendix A): `forecast_seven_days` is what a bot sends,
`forecast_seven_periods` the half-day form.

**The flags in `cond`**, as a bot sets them: thunder when any 3- or 6-hourly slot of the local day
has a thunderstorm chance, likely or definite; wintry for sleet, freezing rain, freezing drizzle
or blowing snow (a cold, dry night does not set it); windy for a sustained wind of 30 mph or more
or gusts of 40 mph or more; fog for fog or patchy fog, never haze.

**`point`.** For `>f <index>` it is the index asked for when the forecast's point is within 1.5 km
of it (some points share coordinates); a forecast from another point carries that point's own
index. 0xFFFF means the bot answered from a point the bundle does not list; label it with the place
or coordinate the request named (section 14.3).

## 8. Text (type 6)

Anything narrative: a warning's text (its headline and the key lines: what, where, when), a forecast
discussion, storm reports, rainfall, a raw
METAR or TAF, the hazardous weather outlook, space weather, the bot's receiver status. Request
only; never broadcast on a schedule. A reply can be up to 8 packets, called chunks.

Flags nibble: bit 0 = **cut** (below). Bits 2 and 3: data source.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 1 | `subject` | 0 warning narrative, 1 forecast discussion (AFD), 2 space weather, 3 storm reports, 4 rainfall, 5 METAR/TAF raw, 6 hazardous weather outlook, 7 nowcast (defined; a bot does not send it), 8 general |
| 5 | 1 | `group` | The same value on every chunk of one reply: the `seq` its first chunk was transmitted with |
| 6 | 1 | `idx` | Chunk number, from 0 |
| 7 | 1 | `total` | Chunks in this reply, 1 to 8 |
| 8 | ≤ 149 | `text` | UTF-8. The chunk ends where the packet ends |

The text is one line: a bot collapses every run of whitespace, newlines included, into one space
before it cuts the reply into chunks. It fills each chunk to 149 bytes but the last, cutting only
between code points, so each chunk is valid UTF-8 on its own (a decoder may reject one that is not)
and a word can run on into the next chunk; join the chunks with nothing between them.

Reassemble by `(bot, group)` in `idx` order. A chunk that never arrives can be asked for alone with
`>part` (section 14.5); it comes back under the same `group`.

**Cut.** A reply holds at most 8 × 149 = 1192 bytes of text, and a forecast discussion is often
longer. When a bot has to drop the tail it trims at the last sentence boundary that fits (a `.`,
`!` or `?` followed by a space) or, failing that, at the last word boundary, and sets the cut flag
on **every** chunk, so a phone that loses the last packet still knows it holds an excerpt. The
trimmed reply carries no ellipsis: the flag is the signal. (Only a single word longer than the
whole reply is cut inside itself.) A cut reply and a reply with a chunk missing are different
things (section 18.5).

## 9. Not available (type 7)

The bot cannot answer a request. 6 bytes in all; flags nibble 0.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 1 | `request` | Which request: the ASCII code of its letter (below) |
| 5 | 1 | `reason` | 0 no data, 1 unknown location or argument, 2 not supported by this bot, 3 bot error, 4 refused for now (try later) |

The letter is the request's first letter after `>`: `d`, `w`, `o`, `f`, `a` (`>afd`), `s`
(`>space`, `>storm` and `>sat` share it), `r` (`>rain`), `m` (`>metar`), `t` (`>taf`), `h`
(`>hwo`), `c` (`>cov`), `p` (`>part`). The one exception is **`x` for `>radar`**, because `r` is
`>rain`. Letters are shared: `w` is `>w`, `>wt` and `>wmap`; `s` is `>space`, `>storm` and
`>sat`. A request word the bot does not know gets reason 2 under its own first letter (`?` when
there is no word), so `>xyz` reads like radar's "no radar": pair a refusal with your own request,
not with the letter alone. Section 14.2 lists the reasons each request can give.

**Reason 0 is broad.** It is sent when nothing is active for a place, when the bot holds no data
for it, and when a named station has no current METAR or TAF. Read it as "no answer available
now", not "try again shortly". A bot that has just restarted answers every request with reason 0
until its products are loaded (seconds to a couple of minutes), and holds its scheduled broadcasts
for the same stretch; a client cannot tell that case from the others and need not.

**Reason 4 comes from three places only**: an Area sweep refused by its cooldown or its budget
(section 12.4), the same radar picture asked for again within 5 minutes or a loop whose every
picture the asker already holds (sections 13.4 and 13.5), and any
request but `>radar` once the hour's budget is spent (section 14.4; at most once a minute per
sender). Every other limit answers with nothing at all, so silence means out of range or throttled,
and a client cannot tell which.

## 10. Coverage (type 8)

What the bot carries, in its own words: the centre of its area, how far it reaches, the NWS
offices in it, and its forecast zones as UGC runs. Broadcast every 3 hours and answered to `>cov`.

**A bot's area is what this message says.** The stations in an hourly batch change every hour
(section 6) and warnings come and go; neither describes coverage. Guessed from
them, WX-AUS can look as if it does not carry its own home county, because the one warning active
at the moment came from a neighbouring office. Section 20.2 says what a client may do before a
statement arrives.

Flags nibble: bit 0 = the zone runs were cut, bit 1 = the office list was cut (below). Bits 2 and
3 are 0: coverage is configuration, not weather.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 3 | `lat` | i24, degrees × 10000: the centre of the coverage circle, the bot's home point |
| 7 | 3 | `lon` | i24, degrees × 10000 |
| 10 | 2 | `radius` | u16 kilometres. 0 = no circle: the area is whatever the runs list |
| 12 | 1 | `stations` | The most stations one hourly Observations packet carries: 12 for a bot that sends the ages (section 6). 0 when the bot states no circle. A cap, not a count: the batch is rebuilt every hour |
| 13 | 1 | `n` | Office count, 0 to 22 |
| 14 | `n` | offices | u8 each, an index into `index.json` `offices`, ascending: every office whose zones the bot covers, and any the operator named. An office the bundle does not list is left out |
| 14 + `n` | 1 | `k` | Zone-run count, 0 to 30 |
| 15 + `n` | 4 × `k` | runs | The Warning's area runs (section 3.3) |

Example: the vector `coverage_wx_aus` is 39 bytes: 14 fixed, 4 offices (EWX, FWD, HGX, SJT), then
36 zones in 5 runs (TXZ155-160, TXZ170-175, TXZ186-197, TXZ205-211, TXZ221-225) inside 120 km of
30.2672, −97.7431, with a station cap of 13 (what fits without ages; a bot that sends ages states
12).

A bot configured by forecast zone sends runs with the county bit clear; a bot configured by county
may set it, so read it either way.

**Cut lists.** 22 offices and 30 runs together are 14 + 22 + 1 + 120 = 157 bytes, the send limit
exactly. A larger coverage is cut: the bot keeps the runs that account for the most zones (in
ascending order) and sets flags bit 0, and keeps the 22 lowest office indices and sets bit 1.
**Read a cut list as incomplete, never as a denial.** With bit 0 set, a zone absent from the runs
may still be covered: say "not listed", never "not covered". With both bits clear the lists are
complete, and a zone that is absent really is outside the bot's area. An app may say what a bot
covers; it must not say what a bot does not cover unless the statement is complete.

**Special forms.**

- `n` = 0 and `k` = 0: either the operator chose national coverage (no filter: the bot broadcasts
  every warning its feed carries), or the bot has no usable coverage (none set, or it failed to
  build), in which case it broadcasts nothing on its schedule and says so only in answer to
  `>cov`. Either way the statement says nothing about where the bot is: treat its coverage as
  unknown, never as "everywhere" (section 20).
- `lat` and `lon` 0,0 with `radius` 0: the bot states no centre (its area came from states or
  offices, not a circle). Use the runs alone.
- A bot that knows neither a centre nor a single zone does not send Coverage and answers `>cov`
  with Not available, reason 0.

Coverage decides what a bot broadcasts on its schedule and what the argument-free `>d` and `>w`
answer. A request that names a place is answered wherever the place is (section 14.6).

## 11. Request (type 9)

An app's request, **flooded on `#meshwx` as a datagram**. It carries the same `>` text a person
could send (section 14); only the transport differs. A flood needs no route: a DM rides one stored
route hop by hop and is lost silently when that route has gone stale, while a flood reaches the bot
whichever way the mesh is shaped today, for about what a DM costs by its second try. It arrives in
the one to three seconds a text request takes.

The answer is the same as for any request: v5 messages flooded on `#meshwx`, to everyone.

The header, read for a Request:

| Field | Meaning in a Request |
|---|---|
| `seq` | The **sender's** counter, one more for every Request it sends, including a resend. Informational: a bot recognises copies by `sender`, `ts` and `text`, not by `seq` |
| `bot` | The bot asked, as `bot` in every message. `0xFFFF` = any bot. A bot ignores a Request that names another bot |
| `type` | 9; flags nibble 0. A bot ignores the flags |

Body:

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 6 | `sender` | The first six bytes of the sender's public key, in key order: the same prefix a DM from that phone carries, so a phone is one sender to the bot however it asks |
| 10 | 4 | `ts` | u32, Unix **seconds**: the request's own time, by the app's clock. A resend repeats it |
| 14 | ≤ 40 | `text` | The request exactly as section 14 writes it: UTF-8, starting with `>`, no terminator. The packet ends where the text ends |

`request_digest` (Appendix A) is `>d` to bot `0x041D` from sender `01 02 03 04 05 06` at
`ts` 1789660000, `seq` 1, 16 bytes:

```
01 1D 04 90 01 02 03 04 05 06 60 0B AC 6A 3E 64
```

**Copies.** A bot treats the same `sender` + `ts` + `text` as one request for 30 minutes, and the
same `sender` + `text` within 2 minutes of the first copy as one request whatever the `ts` (case
and runs of spaces in `text` do not count). A copy of a request that was answered is answered
again only when that answer finished going out at least 12 seconds earlier, and then it is built
afresh and meets every limit again: a copy of `>wmap` inside the sweep cooldown is refused. A
quicker copy gets nothing, so a resend never doubles the airtime of an answer. A copy of a request
that got no answer (a limit, the bot starting up) is answered at once. The same rule covers a `>`
request sent by DM; a `>` line sent as channel text has no copy rule.

**Resend with a new `seq`.** MeshCore repeaters drop a packet whose hash they have already seen, so
a byte-identical resend never leaves the first hop. A resend keeps `sender`, `ts` and `text` and
takes the next `seq`, which changes the packet's hash and lets it travel, while the bot still
recognises it as a copy.

A bot ignores a Request that is shorter than 15 bytes, whose text is over 40 bytes or not UTF-8,
or that does not start with `>`. When to send and resend is in section 19. A Request meets the
request limits of section 14.4.

## 12. Area sweep (type 10)

A picture of what is active, for the whole country or for the states a person asked about, as runs
of UGC numbers. The phone already ships every zone and county outline (`zones.geojson`,
`counties.geojson`, section 16), so the mesh carries no map: four bytes cover anything from one
zone to 64 consecutive ones (county numbers are odd, so a county takes an entry of its own), and the
phone fills in its own outlines. Real products run at about 3.6 runs
per alert, so the 125 alerts active on an ordinary afternoon are some 450 runs: a national `>wmap`
(warnings and watches, a third of them) is around five packets, and `>wmap all` fills eight and
comes back cut. A sweep of one or two states is usually one packet.

Request only, never scheduled. It answers `>wmap` (warnings and watches) and `>wmap all`
(advisories and statements as well), for the country or for a list of states (12.3). Like every
answer it is flooded, so one request serves everyone listening, which is why a bot limits it hard
(12.4).

Flags nibble: bit 0 = **cut**, bit 1 = **advisories**. Bits 2 and 3: data source.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 4 | `built` | u32 Unix minutes when the bot built the sweep. A picture taken then, not a live feed |
| 8 | 1 | `group` | The same on every packet of one sweep: the `seq` its first packet went out with |
| 9 | 1 | `idx` | Packet number, from 0 |
| 10 | 1 | `total` | Bits 0-3: packets in the sweep, 1 to 8. Bit 7: **scoped** (12.3). Bits 4-6: 0 |
| 11 | 4 × m | `entries` | At most 36 per packet (11 + 4 × 36 = 155 bytes) |

Reassemble by `(bot, group)` in `idx` order (section 17.4). A sweep is at most 8 packets and 288
entries. A
packet that never arrives can be asked for alone with `>part` (section 14.5).

### 12.1 Entries

One entry is one run of consecutive UGC numbers in one state:

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0 | 1 | `event` | The event code a Warning uses (section 3.1): the most severe event covering this run. 0 marks a scope entry (12.3) |
| 1 | 1 | `state << 1 \| kind` | State index (`index.json` `states`) in the high 7 bits; `kind` in bit 0: 0 forecast zone (`Z`), 1 county (`C`) |
| 2 | 2 | u16 | Bits 0-9: `start`, the UGC number (0 to 1023). Bits 10-15: `run − 1`, so a run is 1 to 64 numbers |

The run covers `start` to `start + run − 1`, as a Warning's area run does, but **it is not the
same record**: a Warning run spends a whole byte on `run` and flags a county in bit 7 of the state
byte; a sweep entry carries an event code instead and caps the run at 64. Decode them with
different code.

A packet ends where its last whole entry ends. Fewer than four bytes left over are padding: ignore
them.

**Order.** Entries are sorted most severe first, by the significance letter of the event code
(warning, watch, advisory, then statement; a code with no significance letter ranks as a
statement), then by state index, then by `start`, then zones before counties. That is
what makes a cut sweep useful: what survives is the worst of it.

**One entry is one event, not every event.** An area under both a tornado warning and a flood
advisory appears once, under the tornado warning. A sweep is a picture of the worst thing in each
place, not an index of everything: for the detail of one area, ask `>w TXC453`.

### 12.2 Cut and advisories

**Cut (bit 0).** More runs were active than the sweep could hold (288, less one for each scope
entry) and the least severe were dropped. The flag is set on **every** packet, so a phone that loses
a packet still knows it is not holding the whole picture. Read a cut sweep as incomplete, never as
a denial: an area absent from it may still be under something.

**Advisories (bit 1).** The sweep includes advisories and statements (significance `Y` and `S`)
as well as warnings and watches. With the bit clear, an area absent from the sweep may still have
an advisory, and usually does. Say which kind of sweep is on screen; the two are not comparable.

### 12.3 Scoped sweeps

A request may name the states it wants: `>wmap TX`, `>wmap tx, ok`, `>wmap all TXOKLA` (section
14.3). `total` bit 7 is then set on **every** packet, and packet 0 begins with one **scope entry**
per state asked for:

| Field | Value |
|---|---|
| `event` | 0. No event has code 0 |
| `state << 1 \| kind` | The state's index, `kind` 0 |
| `start` | 0 |
| `run` | 1 |

That is `XXZ000`, the Weather Service's own way of writing "all of state XX". Scope entries are
in `index.json` `states` order, one per state however often it was named, and come before every
alert entry and count toward the 36 a packet holds, so a sweep of 15 states has room
for 273 alert entries. Only packet 0 carries them; the other packets carry bit 7 and nothing else
about the scope.

A decoder reads the leading run of event-0 entries in packet 0 of a scoped sweep as the scope. An
event-0 entry anywhere else is malformed: ignore it.

**A state in the scope with no alert entries is an answer**: nothing is active there at this level.
A state outside the scope is unknown, never clear. Draw a scoped sweep as a picture of the states it
names and of nothing else.

### 12.4 Limits

- A sweep request is refused (Not available `w`, reason 4) when **every** state it names was
  covered by a sweep in the last 5 minutes at the same or a higher level (`all` is higher than
  plain). A national sweep covers every state. A national request is refused when a national sweep
  at that level or a higher one went out in the last 5 minutes: scoped sweeps do not add up to the country.
- A national sweep needs 8 packets left in the hour's budget (section 14.4) before the bot starts
  one, because half a national sweep is a wrong map. A scoped sweep is built first and needs its
  own packet count, usually one or two. Short of that: reason 4.

## 13. Radar (type 11)

One tile of a radar picture: where there is precipitation, in four levels, over a fixed square of
the earth. Always one packet.

**Where the pictures come from.** The EMWIN stream a bot's dish receives carries the Weather
Service's radar mosaics, a national picture and fourteen regional ones, a new one of each every 15
minutes. The bot cuts the tile out of the newest picture that holds it, regional before national.
When the dish has not brought a picture for 20 minutes, a bot with internet takes the same mosaic
from the Weather Service's website. That backup is for a bot with a dish; a bot without one takes
no radar from the internet, has none, and answers `>radar` with Not available `x`, reason 2.

| `product` | Picture | | `product` | Picture |
|---|---|---|---|---|
| 0 | `RADREFUS` United States | | 8 | `RADGRTLK` Great Lakes |
| 1 | `RADSTHPL` Southern Plains | | 9 | `RADNTHES` Northeast |
| 2 | `RADRCKST` Southern Rockies | | 10 | `RADSTHES` Southeast |
| 3 | `RADRCKNT` Northern Rockies | | 11 | `RADALLAK` Alaska |
| 4 | `RADPACSW` Pacific Southwest | | 12 | `RADALLHI` Hawaii |
| 5 | `RADPACNW` Pacific Northwest | | 13 | `RADALLPR` Puerto Rico |
| 6 | `RADUMSVY` Upper Mississippi Valley | | 14 | `RADALLGU` Guam |
| 7 | `RADSMSVY` Southern Mississippi Valley | | | |

These are `protocol.json` `v5.radar.products` and `product_names`, in wire order; the list is
append-only.

It answers `>radar` (section 14.2), and a bot can also broadcast the tile over its own area while
there is precipitation in it (section 15). Either way it is flooded, and tiles sit on a fixed
lattice precisely so that a tile one phone asked for, or the bot sent unasked, is a tile every
phone can use.

### 13.1 The tile

- `zoom` is 0 to 3. A tile spans `2^(zoom + 1)` degrees on each side: 2, 4, 8 or 16.
- The grid is 32 × 32 cells, so a cell is `span / 32` degrees: 1/16 of a degree at zoom 0 (about
  7 km north to south), then 1/8, 1/4 and 1/2.
- Tiles sit on a lattice of **half** their span, `step = 2^zoom` degrees, so they overlap. The tile
  for a coordinate is the one whose **centre** is the nearest lattice point:

  ```
  centre_lat = floor(lat / step + 0.5) * step      south = centre_lat - step
  centre_lon = floor(lon / step + 0.5) * step      west  = centre_lon - step
  ```

  Use `floor(x + 0.5)`, not your language's `round`: a tie must fall the same way on the bot and on
  every phone. The place asked about is then never closer to an edge than a quarter of the span,
  55 km at zoom 0. `south` and `west` are whole degrees at every zoom. A client computes the same
  tile to know which answer is its own.
- A tile holds `south <= lat < south + span` and `west <= lon < west + span`: edges are
  half-open. A coordinate's cell, with `size` 32 (16 in a coarse tile) and `cell = span / size`, is
  `row = floor((south + span − lat) / cell)` and `col = floor((lon − west) / cell)`, each clamped
  to 0 … size − 1.
- Row 0 is the **northern** row and column 0 the **western** column. Cell `(row, col)` covers
  latitude `south + span − (row + 1) × cell` to `south + span − row × cell` and longitude
  `west + col × cell` to `west + (col + 1) × cell`. Cells are square in degrees, so on the ground
  they are narrower than they are tall everywhere but the equator.
- A cell holds a **level**, 2 bits: 0 none, 1 light (20 dBZ and up), 2 moderate (35 and up), 3
  heavy (50 and up); the thresholds are `protocol.json` `v5.radar.levels_dbz`. A cell's level is
  the **strongest** level present in at least two of its pixels (one, in a cell of fewer than 12
  pixels), never the average: a thunderstorm core is smaller than a cell, and averaging it away is
  the one thing this message must not do. A tile therefore reads a little wetter than the picture
  it came from. A light cell with no wet neighbour is dropped as clutter.

### 13.2 The packet

Flags nibble: bit 0 = **coarse**, bit 1 = **partial**. Bits 2 and 3: data source.

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 4 | 4 | `taken` | u32 Unix minutes: the time printed on the radar picture (13.3) |
| 8 | 1 | `south` | i8, the tile's southern edge in whole degrees |
| 9 | 2 | `west` | i16, the tile's western edge in whole degrees, −180 to 179 |
| 11 | 1 | `shape` | Bits 0-1: `zoom`. Bits 2-7: `product`, an index into `protocol.json` `v5.radar.products`, the picture the tile was cut from |
| 12 | 4 | `bounds` | **Only when the partial flag is set**: `row0`, `row1`, `col0`, `col1`, one byte each, inclusive, in this packet's own grid |
| 12 or 16 | 1 to 145 | `cells` | The quadtree (below): up to 145 bytes, or 141 after `bounds` |

**The quadtree**, read most significant bit first. `node(size)`:

- `size` 1: two bits, the level.
- Otherwise one bit. `0`: the whole square is one level, and two bits of level follow. `1`: the
  square is split and four nodes follow, north-west, north-east, south-west, south-east, each
  `node(size / 2)`.

The root is `node(32)`, or `node(16)` in a coarse tile. A tile with nothing on it is the three bits
`0 00`, one byte, and the whole packet is 13 bytes. A bot pads the last byte with zero bits.
An encoder writes `0` and a level for every square of one level, at every size, and splits only a
square that is not; that makes the bytes for a picture unique. Reject a packet whose bits run out
before the tree is complete, or whose bounds are not `row0 ≤ row1 < size` and `col0 ≤ col1 <
size`; ignore anything after the tree.

**Coarse (bit 0).** The 32 × 32 tree did not fit the packet, so the bot sent the tile as 16 × 16,
each cell the highest of the four it replaces. A coarse tree is at most 75 bytes and always fits,
which is what keeps radar to one packet. It takes echo texture across most of the tile to need it.

**Partial (bit 1).** Part of the tile lies outside the picture it was cut from. `bounds` names the
rows and columns that are inside; every cell outside them is **unknown**. Those cells are level 0
on the wire, because the tree has no fifth level, so read `bounds` before you read a 0 as dry. A bot
serves a partial tile only when no picture holds the whole tile and one holds at least a quarter of
it.

### 13.3 What a tile says

**`taken` is the picture's own time.** It is printed in the corner of each picture and the bot reads
it from there, because nothing else says it: a picture is anywhere from 2 to 34 minutes old when the
dish receives it. When the corner cannot be read the bot sends the product's issue time instead,
which runs 2 to 8 minutes after the picture; nothing on the wire says which. Show `taken` with every
tile (section 18.4).

**What a tile cannot say.** Level 0 inside the bounds means the picture shows no echo there. Over
open water, behind mountains and between radars that is not the same as no rain. Echo under the
stroke of a warning polygon is interpolated from its neighbours, because the Weather Service draws
polygons on the picture; a client draws the polygon itself from the Warning.

**Guam.** Product 14 is not calibrated (its islands are too small to place the picture by), so a
tile there is answered Not available, reason 0.

**The antimeridian.** Near 180° (the western Aleutians) the lattice can put a tile's west edge
below −180, which the packet cannot carry, so those tiles are not served: the bot answers reason 0,
or reason 3 where the Alaska picture reaches far enough to be cut.

### 13.4 Limits

- A bot answers from a picture at most **60 minutes** old by `taken`. With nothing newer: Not
  available `x`, reason 0. An old radar picture is worse than none, because it looks like an answer.
- The same tile cut from the same picture is the same bytes, and everyone in range already has
  them. Asked for again within **5 minutes**, it is answered Not available `x`, reason 4. The window
  is keyed on `(south, west, zoom, taken)`, so a newer picture is never held back by an older one,
  and a wider tile is a different tile.
- Otherwise the hourly budget and the per-sender rule apply (section 14.4). A `>radar` request
  over the budget gets no reply, because reason 4 under `x` already means "the same picture went
  out minutes ago".

### 13.5 The last hour

`>radar <place> [z<n>] loop [HHMM ...]` asks for the pictures of the last hour of one tile, so a
client can play them as a loop. Nothing new goes on the wire: each picture is an ordinary Radar
packet, and its `taken` says which picture it is. The bot:

1. Finds the tile and the product as for one picture (13.1, and the start of section 13), from the
   newest picture of that product at most 60 minutes old. None: Not available `x`, reason 0.
2. Walks back through older pictures of **the same product only**: each one whose `taken` is at
   least 10 minutes before the last one picked, back to 60 minutes before the newest, at most five
   in all, the newest included (`protocol.json` `v5.radar.loop`). A picture the dish missed is a
   gap; it is never filled from another product, because a loop that switches between a regional
   and the national picture changes its detail in front of the person watching.
3. Leaves out every picture whose `taken`, as a UTC hour and minute, matches one of the `HHMM`
   groups after `loop` (the client holds it), and every tile of a picture that went out in the last 5 minutes
   (everyone listening holds it).
4. Sends the rest **oldest first**, one packet each. Each counts against the hourly budget and
   starts its own 5-minute window.
5. With nothing left to send, answers reason 4 when something was left out under step 3, and
   reason 0 when there was nothing to find.

The `HHMM` groups are four digits each, at most five, newest first, and as many as keep the
request inside its 40 bytes (section 11). `>radar 30.270,-97.740 loop` is 26 bytes, so two always
fit; a held picture left off the list is only sent again. The hour is needed as well as the
minute: at 15-minute steps the newest picture and the one an hour before it end in the same two
digits.

## 14. Requests

### 14.1 How to send a request

A request is text that starts with `>`, at most 40 bytes of UTF-8. A client sends it one of three
ways:

1. **As a Request datagram** (section 11), flooded on `#meshwx`. This is the normal way: it needs
   no route, and its `bot` field says which bot should answer.
2. **As a DM to the bot**, for a radio whose firmware cannot send channel datagrams. Only that bot
   can read it. A DM rides one stored route and is lost silently when the route has gone stale.
3. **As text on `#meshwx`.** Every bot on the channel reads it, and each one that can answer does.
   A bot has no copy rule for channel text, so a repeated line is answered again.

However it was sent, the answer comes back the same way: v5 messages flooded on `#meshwx`, to
everyone, never as a DM. Some request words are also people's text commands without the `>`
(`metar`, `taf`, `storm`, `rain`, `space`, `radar`, `sat`, `cov`; section 22).

### 14.2 The requests

The text after `>` is a request word, in any case, and at most one argument. The **Refused** column
gives the Not available letter and reasons each can draw (section 9); any request can also draw
reason 0 while the bot starts up, 3 on a bot error, and 4 once the hour's budget is spent (14.4;
except `>radar`, which then gets no reply).

| Request | Answer | Refused |
|---|---|---|
| `>d` | A Digest of the bot's coverage (section 5) | `d` |
| `>w` | One Warning per active warning in the bot's coverage, at most 6, most recent first, then a Digest. With nothing active, the Digest alone | `w` |
| `>w SV.W.EWX.42` | That warning, wherever it is. The identity is `event.office.etn`, with the office's three-letter code | `w` 0 not active, 1 not an identity |
| `>w TXC453`, `>w TXZ192` | Every active warning whose area lists that county or zone, at most 6. No place names or ZIPs | `w` 0 nothing active there (any six characters are read as a code), 1 not six characters |
| `>wt SV.W.EWX.42` | That warning's headline and key lines (what, where, when), Text subject 0 | `w` 0, 1 |
| `>wmap` | An Area sweep of the country, warnings and watches (section 12) | `w` 0 nothing active, 4 cooldown or budget (12.4) |
| `>wmap all` | The same with advisories and statements (flags bit 1 set) | `w` 0, 4 |
| `>wmap TXOK`, `>wmap tx, ok`, `>wmap all TXOKLA` | A sweep of those states only (12.3) | `w` 1 bad states, 4 |
| `>part 212 1,4,6` | Those packets of answer 212 again (14.5) | `p` 0 gone, or malformed |
| `>o` | Observations for the stations around the bot's home (section 6) | `o` 0 |
| `>o KAUS` | Observations for that station or a neighbour (section 6.2). A station only: no places | `o` 0 nothing in 12 hours, 1 not a station the bundle lists |
| `>f` | Forecast for the bot's home point (section 7) | `f` 0 |
| `>f 102` | Forecast for point index 102 | `f` 0, 1 past the end of the list |
| `>f round rock tx`, `>f 78701`, `>f 78701-1234` | Forecast for a place or US ZIP the bot resolves | `f` 0 no forecast near it, 1 unknown place or ZIP |
| `>f 35.687,-105.938` | Forecast at a coordinate | `f` 0 no forecast within 80 km |
| `>afd EWX`, `>afd` | That office's forecast discussion (bare: the bot's home office), Text subject 1. An office code only | `a` 0 none, or an unknown office |
| `>hwo`, `>hwo round rock tx` | The hazardous weather outlook for the bot's home or a place, Text subject 6 | `h` 0 none, 1 unknown place |
| `>metar KAUS` | That station's own METAR from the last 120 minutes, Text subject 5, starting `METAR KAUS`. Never another station's | `m` 0 none |
| `>taf KAUS` | That station's own TAF from the last 30 hours, Text subject 5, starting `TAF KAUS` (an amendment: `TAF KAUS AMD …`). Never another station's | `t` 0 none |
| `>metar round rock tx`, `>taf 78701`, bare `>metar`, `>taf` | The nearest station with a report, of the five nearest within 150 km of the place (the bot's home when bare), Text subject 5, labelled with the station and its distance: `METAR (KGTU 15km) KGTU 151155Z …`, `(KGTU 15km) TAF KGTU …` (the TAF as the bulletin prints it, which may lack the word TAF). A METAR is from the last 120 minutes or, with none, the newest up to 12 hours old, labelled with its age: `METAR (KAUS 45km, 5h old) …`. At 0 km the distance is left out: `METAR KAUS …` | `m`/`t` 0 none, 1 unknown place |
| `>storm TX`, `>rain TX` | Storm reports from the last 6 hours (at most 16) and rainfall totals for a state, Text subjects 3 and 4. The argument is a state code or name, or a place or ZIP, which stands for its state; bare, the bot's home state. "Nothing reported" is a Text answer, not a refusal | `s`, `r`: only the reasons every request can draw |
| `>space` | The space weather summary, Text subject 2 | `s` |
| `>radar` | Radar (section 13): the zoom 0 tile around the bot's home point | `x` 0 no picture, 2 no radar, 4 sent in the last 5 minutes |
| `>radar 30.270,-97.740` | The zoom 0 tile for a coordinate | `x` 0, 2, 4 |
| `>radar 30.270,-97.740 z2` | The same at zoom 2 | `x` 1 a zoom past 3 |
| `>radar round rock tx`, `>radar 78701 z1` | A place or ZIP the bot resolves, as `>f` does | `x` 1 unknown place |
| `>radar 30.270,-97.740 loop`, `>radar 30.270,-97.740 z1 loop 2353 2338` | The last hour of the tile (13.5) | `x` 0, 2, 4 |
| `>sat` | The bot's satellite receiver, one line of Text subject 8 (below) | `s` |
| `>cov` | Coverage (section 10). It describes the bot, so coverage never filters it | `c` 0 no centre and no zone |

`>d`, `>space`, `>sat` and `>cov` ignore an argument. Bare `>f`, `>hwo`, `>metar`, `>taf` and
`>radar` use the bot's home point, and a bot with no home refuses them with reason 1. Bare `>storm`
and `>rain` use its home state; with no home, or an unknown place, they answer with a one-line Text
note, never a refusal. Bare `>afd` uses a home office; with none it answers reason 0.

**`>sat`** answers with one line about the bot's dish and feed, for example
`GOES locked 13h47m, signal good (vit 150), dropped 0 of 3360 packets last min, newest EMWIN 12s
ago, products ~5h behind. Internet filling in since 14:00Z`. In order: whether the receiver is
locked and for how long; the signal, good, fair or poor; the packets dropped in the last minute;
the age of the newest EMWIN file the dish wrote; how far behind the products run, when that is 30
minutes or more (a backlog at the uplink can deliver every file seconds old and every product in
it hours old); and, while the bot is filling in from the internet (section 2.3), since when. A
line too long for one page leaves out the packet count. A receiver that is not reporting is
described as such, and a bot with no dish answers
`No satellite receiver on this bot: its EMWIN comes over the internet`. The line describes the
bot, not the weather, so its data source is 0.

### 14.3 Arguments

- **A station** is a 4-character ICAO code the bundle lists, in any case.
- **A place** is `city ST` or a city. A bot resolves an argument in this order: a ZIP or ZIP+4, a
  zone code, a station's ICAO code, a station's 3-letter code, `city ST`, a city; among places, by
  prefix on the name, nearest the bot, then by population (section 21).
- **A ZIP** is 5 digits, or a ZIP+4 (`78701-1234`), looked up exactly in `zips.json`. It works
  wherever a place does (`>f`, `>metar`, `>taf`, `>hwo`, `>radar`, `>storm`, `>rain`). `>w` and
  `>o` take neither places nor ZIPs: a client resolves a place to counties, zones and stations
  itself.
- For `>f`, **1 to 4 digits are a point index** and 5 digits a ZIP.
- **A coordinate** is two signed decimals with a comma between them, `35.687,-105.938`, so a place
  with a comma in it is still a place. A coordinate out of range (latitude beyond ±90, longitude
  beyond ±180) is read as a place, and fails as one.
- **`>f` and `point`.** The answer is the nearest point the bot holds a forecast for within 80 km.
  Its `point` is the index asked for when the forecast's point is within 1.5 km of it; otherwise
  that point's own bundle index, or 0xFFFF when the bundle does not list it.
- **`>radar`** reads its argument from the end. First `loop` and up to five four-digit `HHMM`
  groups: a group whose hour is over 23 or minute over 59 is skipped, and a token after `loop` that
  is not four digits, or a sixth group, makes `loop` part of the place (`>radar loop tx` is Loop,
  Texas). Then a last token `z0` to `z3` is
  the zoom; `z4` to `z9` is refused reason 1, and anything else is part of the place, so
  `>radar zion il` is a town. What remains is the place; nothing is the bot's home.
- **`>wmap`** splits its argument at spaces and commas. `all` anywhere is the advisories level, as a
  whole token (`ALLA` is four letters: Alabama and Louisiana). The rest are two-letter codes from
  `index.json` `states`, run together or apart, at most 15; an odd-length token, an unknown code or
  more than 15 is refused reason 1. Send the compact upper-case form, `>wmap all TXOKLA`, so 15
  states still fit in 40 bytes.
- **`>part`**: a group and at least one index, decimal, 0 to 255, separated by spaces or commas.
- **County versus zone codes.** Storm-based warnings and tornado and severe thunderstorm watches
  carry county codes such as `TXC453`; advisories, flood and winter watches and most other products
  carry zone codes such as `TXZ192`. A county query matches nothing while only zone-coded products
  are active, and the reverse. When you do not know which is in force, ask for both.

### 14.4 Limits

These are the defaults; a bot's operator can change them.

- **One request per sender every 2 seconds.** A request inside that gets no reply at all.
- **A budget of 240 answer packets an hour**, across all senders. It counts packets, not requests
  (a bare `>w` can be 7), is checked before an answer is built, and the answer that crosses it
  still goes out whole. Once it is spent, a request is answered Not available, reason 4, at most
  once a minute per sender, and that 6-byte packet is not counted. `>radar` gets no reply instead
  (section 13.4).
- **A `>` request sent as a DM** also passes the limits for people's text commands (section 22):
  one reply per sender every 5 seconds, at most 40 per sender per hour and 400 an hour in total,
  counted together with text commands. A Request datagram and a `>` line on the channel meet only
  the two limits above.
- **Copies** of a request, by datagram or by DM, follow the rule in section 11: answered again only
  when the last answer finished going out at least 12 seconds earlier.

A bot builds every answer from what it holds at the moment it replies; only `>part` (14.5)
repeats bytes already sent, and even a copy of a request is answered afresh (section 11). So a Digest you receive is current
when it arrives, and asking again for something you hold spends airtime for everyone.

### 14.5 Missing packets: `>part`

`>part <group> <idx>[,<idx>…]`, in decimal, for example `>part 212 1,4,6`. `group` is the `group`
byte of an Area sweep (type 10) or a Text reply (type 6), and each `idx` is a packet number in it.
A phone holding 4 of 7 packets asks for the other 3 instead of the whole answer again.

A bot keeps the bytes of its last **8** multi-packet answers for **10 minutes**, keyed by the
`group` they went out with. It answers by sending the named packets again: the same bytes, with a
new `seq` in byte 0 and **nothing else changed**. In particular `group` does not change, so the
packets file under the answer they belong to. With the group gone, or none of the indexes in it:
Not available `p`, reason 0. Ask for the whole answer again then, not for the parts.

The per-sender rule applies, and every packet sent again counts against the hourly budget. A
sweep's cooldown does not apply and is not restarted: a resend is not a new sweep. The same
`(group, idx)` is sent again at most once every **30 seconds** whoever asks, so ten phones that all
missed packet 3 cost one packet; a request whose every index is inside that window gets no reply,
which is the bot declining to send twice what is already on the air.

### 14.6 Coverage and places

Coverage (section 10) decides two things only: what a bot broadcasts on its schedule, and what the
argument-free `>d` and `>w` answer (`>o` and the hourly Observations use the stations within the
bot's home radius). **A request that names a place, a station, an area or a warning is answered
wherever it is.** What limits a distant answer is what the bot's feed carries, not policy: the
EMWIN stream carries products for the whole country.

## 15. What a bot sends unasked

A client that only listens gets the common case without asking for anything. A bot broadcasts, for
its own coverage (section 10):

| What | When |
|---|---|
| Warning (section 3) | When one becomes active, and again when it changes materially (3.6). A new tornado, severe thunderstorm, flash flood or extreme wind warning once more about two minutes later |
| Cancel (section 4) | Once, when a warning it sent ends more than 5 minutes before its expiry |
| Digest (section 5) | Every 3 hours, and one minute after any Cancel |
| Observations (section 6) | Every hour |
| Forecast (section 7) | For the bot's home point, every 6 hours |
| Coverage (section 10) | Every 3 hours |
| Radar (section 13) | Only when the operator adds it: each new picture while there is precipitation near home, at most one every 15 minutes, and one picture more when it clears |

The intervals are the defaults; an operator can change them. Text and Area sweeps answer requests
only.

- **Radar.** The operator sets a distance from the home point (the coverage radius unless they
  change it) and what counts: any precipitation, moderate and heavier, or heavy only. The tile is
  the narrowest one on the lattice (13.1) that holds the whole circle, one packet per picture. The
  bot looks for a new picture every minute and judges each picture once: precipitation at or above
  the level in a cell within the distance sends it, at most one picture per 15, 30 or 60 minutes
  as the operator chooses. A tile sent as an answer in the last 5 minutes is not sent again, and a
  broadcast tile starts the same 5 minutes for `>radar` (13.4).

- **A ceiling on the schedule.** A bot sends at most 120 scheduled packets an hour (by default). New,
  changed and repeated tornado, severe thunderstorm, flash flood and extreme wind warnings always
  go out; everything else waits for room.
- **Pacing.** Packets leave at least 2 seconds apart, across batches too, and one batch at a time
  (section 2.4).
- **Restarts.** After a restart a bot holds its broadcasts until its products are loaded. Each job
  keeps its timer across a restart, so a restart does not send the digest, observations, forecast
  or coverage again early; each also waits a few minutes of jitter fixed by the bot's key, so two
  bots do not broadcast in step.

## 16. The preload bundle

Ship these files in the app. Everything the wire refers to by index lives here; a bot never sends
names. The bundle is `meshcore_weather/client_data/` in the bot's repository, about 18 MB, 14 MB
of it the two optional polygon files.

### 16.1 Files

| File | Size | Contents | Used for |
|---|---|---|---|
| `protocol.json` | 21 KB | Under **`v5`**: the message types, flags, data source values, text subjects, Not-available reasons, warning tag values, limits, record sizes, sentinels and the `radar` block (grid, zooms, levels, loop limits, the fifteen products and their names, in wire order). At the top level: `version`, `events` (`"TO.W"` → its `event` byte), `event_names` (`short`, `long`), `event_severity_from_significance`, `sky_codes` and `index_file`. The other top-level tables (`messages`, `data_types`, `text_subjects`, `not_available_reasons` and the rest) are not MeshWX v5 and have other numbers: never use them | Every decode |
| `index.json` | 17 KB | `offices`: the `office` byte, the 125 WFOs in alphabetical order, then `NHC` (125, National Hurricane Center) and `WNS` (126, Storm Prediction Center). `stations`: the `station` u16, an ICAO list. `states`: the `state` index, state and territory codes | Warnings, digests, observations, coverage, sweeps |
| `stations.json` | 184 KB | ICAO → name, state, lat, lon | Station search, labels, map pins |
| `pfm_points.json` | 108 KB | `version` and `points`: `[name, office, lat, lon, zone]`, the list position being the `point` u16. Built from one day's products, so it is not the whole truth about what a bot can forecast: with no point near a place, ask `>f <lat>,<lon>` rather than deciding there is no forecast | Forecast labels, "forecast here" |
| `places.json` | 1.3 MB | `places`: `[NAME, ST, lat, lon, population]` | Place search. Label a place by 16.2 |
| `zips.json` | 1.0 MB | `version`, `source`, and `zips`: `["78701", 30.2706, -97.7426, 29645]` sorted by ZIP: the ZIP as a 5-character string (leading zeros kept, `00901`), the ZCTA's internal point, and the index in `places.json` `places` of the nearest place. US Census Bureau 2020 ZCTA Gazetteer (public domain), 33,144 ZIPs including Puerto Rico. PO-box-only and some business ZIPs have no entry | ZIP search: the first 5 digits (of a ZIP+4 too), looked up exactly, never by prefix. Label: the place's label, a space and the ZIP, `San Juan, PR 00901`. A bot resolves ZIPs from the same table |
| `zones.json` | 348 KB | Zone (`TXZ192`) → name, office, state, lat, lon | Naming a warning's zones; the zone of a place |
| `zones.geojson` | 9.5 MB | Zone polygons, `code` property (`TXZ192`) | Filling zones on a map. Optional; without it, pin the zone's centre |
| `counties.json` | 224 KB | County (`TXC453`) → name, state, representative lat, lon | Naming a warning's counties |
| `counties.geojson` | 4.5 MB | County polygons (Census cartographic boundaries, 1:5M), `code`, `name` and `state` properties, Polygon or MultiPolygon | Filling counties on a map. Optional, like `zones.geojson` |
| `wfos.json` | 9 KB | Office code → `states`, `lat`, `lon`, `zone_count`, in `index.json` `offices` order. `NHC` and `WNS` have no states or zones and carry a `name` | Office names, the `>afd` picker (skip entries with no states) |
| `weather_dict.json`, `regions.json`, `state_index.json` | | Not used by MeshWX v5 | |

**UGC codes from runs.** A run decodes to codes: the state code from `index.json` `states`, then
`C` or `Z`, then the 3-digit number. `TXC453` is in `counties.json`, `TXZ192` in `zones.json`, and
both have polygons in the matching GeoJSON. Louisiana parishes, Alaska boroughs and Virginia's
independent cities are all "counties" here, as in NWS products.

### 16.2 Place labels

A `places.json` entry is shown as `Name, ST`, and a ZIP as its place's label, a space and the ZIP.
A bot builds every place name in its text replies this way (`meshcore_weather/geodata/names.py`),
so a client that follows these steps shows the same characters for the same place.

1. **Suffixes.** Upper-case the name. Then, in this order, if the name ends with the suffix,
   remove it and any spaces and commas left at the end, each suffix at most once:
   ` CITY (BALANCE)`, ` (BALANCE)`, ` (HISTORICAL)`, ` (VILLAGE)`, ` CONSOLIDATED GOVERNMENT`,
   ` METROPOLITAN GOVERNMENT`, ` METRO GOVERNMENT`, ` UNIFIED GOVERNMENT`, ` URBAN COUNTY`,
   ` METRO TOWNSHIP`, ` ZONA URBANA`, ` COMUNIDAD`, ` COLONIA`, ` MUNICIPIO`, ` CDP`, ` CITY AND`,
   ` URBAN`. They are Census legal and statistical forms nobody says.
2. **Words.** A word is a run of letters (Unicode category L), decimal digits (Nd) and the marks
   `'` `’` `‘` `ʻ` `` ` `` (apostrophes, the Hawaiian ʻokina and its stand-ins). Any other character
   (space, `-`, `/`, `.`, `,`, parentheses) is kept as it is between words.
3. **Case**, word by word:
   - an initialism stays in capitals: `AFB AAF ARB ANGB NAS NAF NOLF MCAS USCG MCBH WMATA DC NE NW
     SE SW VA UC KC II III`;
   - a joining word that is not the name's first word is lower case: `OF THE IN ON AT BY AND OR DE
     DEL DU`;
   - any other word is lower case except its first character, the letter after a leading `MC`, and
     a letter right after a mark that begins the word or follows its one-letter start.

   Case changes use each code point's full Unicode mapping.

State codes are not kept in capitals: in place names `LA`, `DE`, `IN`, `HI` and `OR` are words (La
Grange, De Queen, Valley Hi); `DC` is listed as an initialism. Spanish and French articles keep
their capital (Bayou La Batre, East Los Angeles); joining words do not (Lake of the Woods,
Estancias de Florida, Fond du Lac), except as the first word (De Queen, Del Rio).

| Bundle entry | Label |
|---|---|
| `HELL'S KITCHEN`, NY, ZIP 10019 | Hell's Kitchen, NY 10019 |
| `CENTRAL 14TH STREET / SPRING ROAD`, DC | Central 14th Street / Spring Road, DC |
| `MCGUIRE AFB`, NJ, ZIP 08562 | McGuire AFB, NJ 08562 |
| `ADJUNTAS ZONA URBANA`, PR, ZIP 00601 | Adjuntas, PR 00601 |
| `ESTANCIAS DE FLORIDA COMUNIDAD`, PR | Estancias de Florida, PR |
| `‘EWA GENTRY`, HI | ‘Ewa Gentry, HI |
| `O'FALLON`, IL | O'Fallon, IL |
| `NASHVILLE-DAVIDSON METROPOLITAN GOVERNMENT (BALANCE)`, TN | Nashville-Davidson, TN |

### 16.3 Versions

The files that carry a `version` are at: `protocol.json` 17, `index.json` 2, `pfm_points.json` 2,
`zips.json` 1. A version goes up when the protocol or the file's contents change in a way a client
reads.

Every indexed table is **append-only**: a new entry goes at the end and no index ever changes
meaning, so a stored warning, reading or forecast keeps reading correctly under a newer bundle. An
index past the end of a client's table comes from a newer bundle than the client ships. A bot's
advert does not carry a version; a new version is announced in the repository.

---

# Part 2: client behaviour

## 17. Receiving and storing

### 17.1 What to accept

- Accept `data_type` 0xFF10 only on the channel slot whose secret is `#meshwx`.
- **Drop other phones' Requests** (type 9) before they reach any state. Their `bot` field names the
  bot they asked, so a Request must never count as hearing that bot or move its sequence numbers.
- Keep state **per bot**, keyed by `bot`.
- **Messages drained from the radio's queue** when the client connects are old news that arrived
  late. Apply them to state, and let them settle a pending request, but do not treat them as live:
  they do not make a bot live (20.2), they do not count toward the five-minute rule (19.1), and a
  notification for one says it is late.

### 17.2 Copies, gaps and restarts

Per bot, keep the last `seq` and a short window of the messages accepted (the reference clients keep
16, and empty it after 6 hours of silence).

- **A copy** is the same `seq` with the same content as a message in the window: a bot's resend
  (section 2.4). Drop it.
- **The newest `seq` again with different content** means the bot started counting again: a
  restart.
- By `forward = (seq − last) mod 256`: 1 is the next message; 2 to 128 is **a gap**; a message up to
  32 behind is **out of order** (apply it, and count a gap, since what came between may still be
  missing); anything else is a restart. A restart marks a gap and empties the window. After 6 hours of
  silence from a bot, anything but the next number is a gap.
- **A gap means a missed message.** Show it ("messages missed") and let the person ask for the
  bot's Digest (`>d`), or for the one warning the Digest names that never arrived. Do not ask
  automatically. A Digest built more than 2 minutes after the gap clears it.
- An out-of-order Warning is not stored when its identity was cancelled in the last hour, or when
  the copy held came from a later `seq` in the last 10 minutes.

### 17.3 Warnings and digests

- **Store a warning by `(event, office, etn)`.** A Warning with a held identity replaces it; a
  Cancel removes it, even one that arrives out of order, and is remembered for an hour so a late
  copy of the warning does not bring it back; its own `expires` ends it.
- **Resolve the issue time and the start to absolute times on arrival** and keep them: a later
  copy without them does not erase them, and they are not recomputed when a Digest changes the
  expiry (step 3 below).
- A warning that ended stays listed, as ended, for 15 minutes past its expiry where it covers the
  place on screen. Prune ended warnings an hour after their expiry.
- **Cancel reason 2, upgraded.** A bot sends 0 for every Cancel today, but a client that reads
  reason 2 should keep an "upgraded, awaiting replacement" marker for up to 6 hours in place of the
  warning: shown, counted as something missed (it blocks an all-clear, 18.8), and a reason to ask
  `>w <county>`. It clears when an overlapping warning from the same office arrives, or a Digest
  built after it speaks for its area.

**Applying a Digest.**

1. Ignore a digest whose `now` is older than the digest held from that bot, and one more than 15
   minutes ahead of the phone's clock (17.5).
2. An identity the digest lists that the client does not hold is one `>w SV.W.EWX.42` away.
3. A listed identity the client holds takes its expiry from the digest, earlier or later, clamped
   to 14 days past receipt (17.5); for a warning heard at or after `now − 2 minutes` the digest may
   only extend it.
4. An identity the client holds **from that bot** that the digest does not list has ended, with
   these exceptions:
   - **It is newer than the digest.** Only warnings heard before `now − 2 minutes` can be ended: a
     warning that went out just before the digest was built may not be in it.
   - **The list may have been cut.** With `count` 24 or more (section 5), keep a held identity whose
     expiry is at or after the latest expiry the digest lists: it may simply not have fitted.
   - **It is outside the bot's area.** A digest speaks for its bot's coverage only (section 5).
     Apply it only to a held identity whose area touches the bot's last **complete** Coverage
     statement (section 10, both cut flags clear), judged as the bot judges its own broadcasts: a
     zone the statement lists; a county run without a polygon that it lists; for a warning with a
     polygon, the polygon against the stated circle; for a product with no polygon, such as a
     tornado watch by county, the county's centre within the circle plus 25 km for the county's
     size; and, failing those, within 25 km of the centre of an area it lists. The
     office list never counts: WX-AUS lists HGX because a few Houston zones reach its circle. A held
     identity outside the area ends by its own expiry, its Cancel, or a fresh `>w` answer. With no
     complete statement held, or one with `n` = 0 and `k` = 0, the digest speaks for every identity
     held from that bot.
5. **One bot's digest ends only its own copies.** Section 20 says how copies from several bots
   combine.

### 17.4 Multi-packet answers

- **Text**: assemble by `(bot, group)`, with the chunks' `subject` and `total`. A chunk that never
  arrives stays a hole; the cut flag on any chunk marks the whole reply. A `group` is a `seq`, so a
  busy bot reuses it within hours: start a new assembly when one is more than 10 minutes old (the
  bot's own `>part` window, 14.5).
- **Area sweep**: assemble by `(bot, group, built, total & 0x0F)`. A different `built` or `total`
  under the same `group` is a new sweep. Whether it is scoped can be read from any packet (bit 7);
  which states it covers only from packet 0. The cut and advisories flags on any packet hold for the
  whole sweep.
- Each packet is a complete message: show what has arrived, mark what is missing, and offer `>part`
  for it (section 19.5), **addressed to the bot that sent the assembly**: a `group` number belongs to
  the bot that sent it.
- **Keeping sweeps.** A national sweep replaces older sweeps from its bot; a scoped sweep replaces
  older scoped sweeps whose states it covers. The reference clients keep at most 8 per bot. On a
  map, each state shows the newest sweep whose scope includes it (a national sweep includes every
  state).

### 17.5 Times ahead of the phone's clock

Every bot is two self-asserted bytes on the wire (section 2.2), so anyone on `#meshwx` can send a
message in a bot's name, and a bot with a corrupt clock can do the same damage. Every time a bot
sends is something that has already happened (a Digest's `now`, an Observations `ts` and so every
station's report time, a Forecast's `issued`, an Area sweep's `built`, a radar picture's `taken`, a
Warning's issue time) except a Warning's expiry and its start. So a client does not believe a time
more than **15 minutes** ahead of its own clock; the 15 minutes absorb clocks that disagree, and
nothing honest is further ahead.

- **A Digest, Observations, Forecast, Area sweep or Radar** stamped that far ahead is dropped whole.
  Kept, it would stand as the newest of its kind over everything real until the clock caught up: a
  digest stamped far ahead with no entries would end every warning a phone holds and then make
  every real digest look older.
- **A Warning** whose issue time is that far ahead is kept, without the issue time and the start
  that rides on it. Dropping it would lose a warning; dropping the time loses one line.
- **An expiry** is believed at most **14 days** past the moment the phone heard the warning, or
  the digest that extended it; clamp it there. Count from receipt, not issuance: a product in force
  until further notice keeps its original issue time while its expiry is moved along (section 3.6),
  and a river flood warning can be in force for weeks. A start that no longer falls before the
  clamped expiry is dropped.

State saved before a client applied these rules is cleaned the same way when it is read back.

### 17.6 Readings, forecasts and coverage

- **Readings**: keep the newest per station by its own report time (`ts − age`, section 6.1), and
  never let an older report replace a newer one.
- **Forecasts**: keep the newest `issued` per bundled point. Keep a 0xFFFF forecast under the
  coordinate this phone asked for; one nobody here asked for is never shown as a place's forecast.
- **Coverage**: keep the newest statement per bot by when it arrived; a statement that arrives out
  of order does not replace the one held. A statement never goes stale.
- **Retention** in the reference clients: texts and forecasts 48 hours, at most 24 of each per bot;
  at most 12 coordinate forecasts and 64 stations per bot. Whatever a screen still shows is kept
  however old it is.

### 17.7 Radar tiles

- Keep tiles by `(south, west, zoom, taken)`: the newest `taken` of a tile is the picture to show,
  and the older ones are its loop (section 13.5). A coarse tile never replaces a fine one with the
  same `taken`. The reference clients keep at most 40 pictures per bot, none more than 3 hours
  older than that bot's newest.
- **Tiles are everyone's.** Pool tiles from every bot: a tile somebody else asked for is as good as
  your own whenever it holds the place, which is what the fixed lattice is for. To show a place,
  take the newest picture (by 15-minute step), then the narrowest zoom, fine before coarse; a
  partial tile counts only when its `bounds` reach the place.

## 18. Showing the weather

### 18.1 Which time to show

Three words carry the honesty of the whole screen, and they are not interchangeable:

- **as of**: an observation, from `ts − age` (section 6.1). When that station measured it.
- **issued**: a warning, from `expires − issued_before` (section 3.4), and a forecast, from
  `issued` (section 7). When the NWS published it.
- **from**: a warning that is not in effect yet, from `expires − begins_before` (section 3.4). When
  it starts to apply, which for a watch can be days after it was issued.

None of them is ever the time the packet arrived. A phone that has been out of range shows old
data, and saying so is the feature. With no issue time on a warning (or a saturated one,
section 3.4), the most a client knows is when the phone heard it: label that **received**, never
**issued**.

### 18.2 Warnings

Colour by event, falling back to the significance: warnings (W) in the red family, watches (A)
yellow, advisories (Y) orange, statements (S) grey. The NWS conventions for the common ones:

| Event | Colour | Icon (SF Symbol) |
|---|---|---|
| `TO.W` tornado warning | red | `tornado` |
| `TO.A` tornado watch | yellow | `tornado` |
| `SV.W` severe thunderstorm warning | orange | `cloud.bolt` |
| `SV.A` severe thunderstorm watch | light orange | `cloud.bolt` |
| `FF.W` flash flood warning | dark green | `water.waves` |
| `FA.W`, `FL.W` flood warning | green | `water.waves` |
| `FA.Y`, `FL.Y` flood advisory | light green | `drop` |
| `HT.Y` heat advisory, `EH.W` extreme heat warning | orange-red | `thermometer.sun` |
| `WS.W` winter storm, `BZ.W` blizzard | pink, purple | `snowflake` |
| `WW.Y` winter weather advisory | lavender | `snowflake` |
| `HW.W` high wind, `WI.Y` wind advisory | tan | `wind` |
| `FW.W` red flag warning | magenta | `flame` |
| anything else | by significance | `exclamationmark.triangle` |

Show the tags when they are not zero: "Hail 1.00 in", "Wind 60 mph", "Tornado: radar indicated",
"Flood source: radar", "Flash flood damage: considerable" (flood damage 3 is undefined: hide it).

**Where a warning is.** The reference clients place each warning against the place on screen:
**here** when its polygon or areas cover the place (within the place's own uncertainty), **near**
within 50 km, **elsewhere** beyond that, and **checking** while the outlines it needs are still
loading. An area with no outline in the bundle is **unplaced**. Checking and unplaced are never
read as "not here".

**Order.** Ended warnings last; then those here first; then by rank: `TO.W`, `EW.W`, a
catastrophic `FF.W`, an `SV.W` with a tornado tag, `FF.W`, `SV.W`, other warnings, watches,
advisories, statements, and a code with no significance letter after statements; then by
placement (checking and unplaced, near, elsewhere); then by expiry. The reference clients show the
list in sections: Here, Unsure, Near, Elsewhere. A warning that covered the place stays listed, as
ended, for 15 minutes past its expiry; one near or elsewhere drops out when it expires.

**When it applies**, from the expiry, the start and the phone's clock:

- **Not in effect yet** (a start later than now): "from Wed 19:00 until Fri 19:00". Nothing counts
  down to an expiry that has not begun.
- **In effect, ending within 12 hours**: "until 23:41 · 40 min left".
- **In effect, ending later**: "until Fri 19:00". Eighty-one hours is not a countdown anyone reads.

These two times are named by the clock alone when they are today or within 12 hours, by the
weekday within the next six days, and by the date beyond that, in the phone's own 12- or 24-hour
format. Every other time on screen ("issued", "as of", "received", a radar picture's time) is the
clock alone for today or within 12 hours ahead, "yesterday 1:29 PM", or the date and time,
"Oct 13, 1:29 PM"; never a weekday. With an issue time, label it **issued**: "issued 1:29 PM". A
notification never counts down: it may be read hours later.

### 18.3 Observations and forecasts

Temperatures are whole °F (°C under a metric locale); show feels-like when `feels` is not zero.
Wind: "WNW 15 gusting 26", or "calm" at speed 0. Pressure: `29.00 + pressure / 100` inHg. Leave
out a field sent as unknown rather than showing its sentinel, and show visibility 0 as "under 1
mi". An observation's night icon is used from 19:00 to 06:00 on the phone's clock.

**Time a station by its own report**, not by the batch: the line under its temperature is **as of
`ts − age`** (section 6.1). A batch arriving now can hold a two-hour-old reading, and the age is
the only thing that says so. A batch without ages is dated at `ts` for every station.

**Stale is shown, not hidden.** A reading is stale when its own time is more than 2 hours old. A
stale reading up to 12 hours old is the weather as last seen: show it with its age beside the time,
"as of 2:24 PM · 5 h old", in a colour that marks it old, rather than "No current conditions". Past
12 hours, leave it out of the place's conditions and offer to ask the bot, which answers `>o KAUS`
with a report up to that old (section 6.2). A list of stations may show every station's newest
reading at any age, with its age.

**Which reading is a place's.** The reference clients look within 80 km, nearest first at each
step, for: a fresh reading with a temperature; a fresh reading; one up to 12 hours old with a
temperature; one up to 12 hours old; anything. The place shows the reading found when it is within
25 km, and up to 40 km under its station's name ("Nearest report: KGTU, 26 km away"); beyond that
it shows none.

A forecast is stale 12 hours after `issued`: "issued 14 h ago".

### 18.4 Radar

- Three colours for three levels, with a legend that says so in words: light, moderate, heavy.
  Draw alert shapes over a tile as outlines, not as fills that hide it, so precipitation and
  alerts can be told apart.
- Put `taken` on screen with every tile, as a time and as an age, and never draw a tile as if it
  were live: precipitation moves 10 to 20 km in the time a picture takes to reach a phone. From 30
  minutes old, say the precipitation has moved; past 2 hours, do not draw the tile at all.
- Cells outside `bounds` are unknown. Hatch or grey them; never leave them looking dry. A partial
  tile whose bounds do not reach the place says so ("This picture does not reach Austin"), never
  that the place is dry.
- Say in words what a tile means for the place: what is over it; when the place is dry, how far and
  which way the nearest precipitation is; and the nearest heavy core when that is somewhere else
  and not already the nearest cell. With nothing anywhere: "No precipitation on this picture." The
  bot's own `radar` text reply says the same, and a client should use the same arithmetic so the
  two agree: distances are great-circle from the place to a cell's centre, the place's own cell is
  never "the nearest", and directions are eight points rounded from the bearing itself,
  `floor((bearing + 22.5) / 45) mod 8` (folding a sixteen-point direction instead shifts every
  sector by 11.25°).
- Radar sees snow as well as rain, so the word is precipitation.
- **Loops.** A loop is the pictures of one tile within 60 minutes of the newest held, at most five,
  oldest first. Offer to play it from two pictures, and only when the person asks. The reference
  clients show each picture for 0.8 seconds and the newest for 2, with its own time on screen
  ("6:08 PM · 2 of 5"), and say "Some pictures from this hour are missing" when two are more than
  20 minutes apart.

### 18.5 Text replies

Show partial text with a "missing part" marker where a chunk never arrived, and offer `>part` for
it (section 19.5). Show a **cut** reply (section 8) as an excerpt: the text, then a quiet line
saying it was shortened for the radio. Do not show it as a fault or a missing chunk: every chunk
arrived, and asking again gets the same 1192 bytes. Cut and missing are different things and must
not share a marker.

### 18.6 Sky codes and icons

| Code | Meaning | SF Symbol |
|---|---|---|
| 0 | clear | `sun.max` (day), `moon.stars` (night) |
| 1 | few clouds | `cloud.sun` / `cloud.moon` |
| 2 | scattered | `cloud.sun` / `cloud.moon` |
| 3 | broken | `cloud` |
| 4 | overcast | `cloud.fill` |
| 5 | fog | `cloud.fog` |
| 6 | smoke | `smoke` |
| 7 | haze | `sun.haze` |
| 8 | rain | `cloud.rain` |
| 9 | snow | `cloud.snow` |
| 10 | thunderstorm | `cloud.bolt.rain` |
| 11 | drizzle | `cloud.drizzle` |
| 12 | mist | `cloud.fog` |
| 13 | squall | `wind` |
| 14 | sand or dust | `sun.dust` |
| 15 | other, or no cloud or weather group | none for an observation; `cloud` for a forecast |

Haze at night is `moon.haze`. The `cond` flags of a forecast override the base icon, in this order:
thunder → `cloud.bolt.rain`; wintry → `cloud.snow` when the sky code is snow, else `cloud.sleet`;
fog → `cloud.fog`. Windy adds a `wind` accent to whichever icon results.

### 18.7 Where the data came from

The data source (section 2.3) is provenance, not a quality grade. Do not put it on screen as a
badge on its own. It is useful for telling a person why an answer is thin, and for a bot's
operator checking that the dish is actually feeding the bot. A source of 0 says nothing either
way.

### 18.8 Saying there is nothing

"No alerts" is a claim about the weather, and a client can only make it on evidence. Neither
reference client shows an all-clear: on a quiet day the page says nothing about alerts, and a line
about the radio turns orange when the alert list is old or messages were missed. When a client
cannot vouch for the list, it says why in one line: outside the bot's area, no list yet, the feed
never heard from, the radio offline, messages missed, the list old, the phone's location old, the
area unknown, the place's office perhaps not carried, or the office quiet.

The reference clients treat the list as complete for a place only when all of these hold:

- the place is inside a bot's area (section 10, or the estimate of 20.2); unknown is not enough;
- the newest Digest from the bots covering the place (from every bot, when none covers it) was
  built in the last 3 hours 15 minutes and arrived since the radio connected;
- the radio is connected and nothing is missed (a gap, a warning the Digest named that never
  arrived, or an upgrade marker, 17.3);
- that Digest's `feed_health` is neither 255 nor over 60 (section 5);
- no bot that states its offices completely leaves out the place's office;
- the place is not a last-known location from a fix more than an hour old;
- no warning is placed here, near, checking or unplaced (18.2).

### 18.9 Notifications

A notification is the most a client can say unasked, and it is easy to make worthless. The
reference clients notify, for a place the person watches:

- with sound, for a `TO.W`, `EW.W`, `FF.W` or `SV.W` covering the place; other warnings only if the
  person chooses, silently; and, if the person chooses, with sound for a `TO.W` or `EW.W` within 50
  km that does not cover it;
- never for watches, advisories or statements;
- once per warning per place: a later copy, from the same bot or another, replaces it silently
  while it is still showing (one the person dismissed is not put back), and it sounds again only
  when the tornado tag rises, flood damage becomes catastrophic, the warning moves from near the
  place to covering it, or the expiry is extended more than 20 minutes after it last sounded;
- late, and said to be late, for a warning drained from the radio's queue (17.1), and then only for
  `TO.W`, `EW.W`, `FF.W` and `SV.W`.

A notification stays up until its expiry, which it names. It comes down earlier on a Cancel or on a
Digest that no longer lists the warning, but only once no bot holds a copy in force (section 20),
and when an update no longer covers the place or the person turns the place's alerts off. A warning
the client cannot place yet (18.2: checking or unplaced) neither posts nor takes a notification
down.

## 19. Asking, and airtime

Every answer is flooded to everyone in range, so every request spends airtime the whole mesh
shares, in exactly the weather that loads it most.

### 19.1 When to ask

- **Listen first.** The scheduled broadcasts (section 15) cover the common case without a request.
- **Ask when a person asks.** Never poll, and never refresh in the background. An "update" may ask
  for what is stale on the screen the person is looking at.
- **Use what others asked for.** Every answer is on the channel. Do not send a request the bot
  answered live in the last **5 minutes**, whoever asked: an alert list, readings, a forecast for a
  bundled point, a sweep of the same states, a Coverage statement, or the newest radar picture of
  the same tile; and a Text reply only when it answered your own request. Always send `>part`, radar
  loops and every `>f` other than `>f <index>`. Send `>d`, `>w`, `>w <area>` and `>w <identity>`
  anyway while a gap is outstanding (17.2), and `>d`, `>w` and `>w <area>` while the Digest names a
  warning you do not hold or an upgrade's replacement has not arrived (17.3).
- **Ask only for what is stale.** The reference clients refresh readings older than 70 minutes, a
  forecast older than 12 hours, and the alert list when the newest Digest is older than 3 hours 15
  minutes (or there is none). They ask `>w <zone>` or `>w <county>` for a place outside the bot's
  area, where no broadcast will bring its warnings, and `>w <county>` when an upgraded warning's
  replacement never arrived.
- **Prefer the Digest** over `>w` when all you need is what is active, and ask `>cov` when no
  statement from that bot is held, at most once per visit: a Coverage statement does not go stale.
- **One request at a time, per phone.** A new request waits 5 seconds after any send, to any bot,
  resends included; a resend itself goes out on its own timer. Several asks in a row (an update
  that needs readings, a forecast and the alert list) go out 5 seconds apart without waiting for
  each answer.

### 19.2 How to send

- Send every request as a **Request datagram** naming the bot you chose (section 20). Never
  `0xFFFF`, which would make every bot on the channel answer, and never as channel text.
- **Resend once.** If no answer has arrived after **10 seconds**, send it again with the same
  `sender`, `ts` and `text` under the next `seq` (section 11). Give up 10 seconds later; never a
  third time to the same bot. There is no acknowledgement for a datagram: the answer is the
  acknowledgement.
- **A DM** only when the radio cannot send a datagram: no `CMD_SEND_CHANNEL_DATA`, no slot carrying
  `#meshwx`, or no public key of its own yet. Only to a bot whose full key the client has from an
  advert. Give each attempt **15 seconds**, at most three sends in all, keeping one timestamp and
  one text. The first goes along the stored route. If it is not confirmed, the second goes along
  the route again, unless the bot has been heard since; then, or after an unconfirmed second, reset
  the route and send the last by flood. A request the bot's radio confirmed gets at most one more
  send along the route, none if the bot has been heard since, and never a flood.

### 19.3 Matching an answer to a request

An answer is not addressed, so a client recognises its own by what it asked. Drained messages
settle requests too (17.1); copies settle nothing.

- A Not available settles the pending request with that letter to that bot that was sent (or resent)
  longest ago. Letters are shared (section 9), so a `w` refusal of a sweep can settle a `>w`.
- `>w <county or zone>` is answered by a warning whose area list names that code or, from the bot
  asked, by any warning whose list may have been cut (0, 6, 12 or 30 runs, section 3.5). A Digest
  follows only the bare `>w`: do not wait for one after `>w TXC453` or `>w SV.W.EWX.42`.
- `>w <identity>` is answered by that warning from any bot.
- `>o ICAO` is answered by any batch that holds the station, or, from the bot asked, by a single
  station within 40 km of it (section 6.2).
- `>f <index>` is answered by a forecast for that point from any bot or, from the bot asked, by one
  for a point within 80 km or with `point` 0xFFFF. `>f <lat>,<lon>` is answered, from the bot asked,
  by a 0xFFFF forecast or one for a bundled point within 80 km of the coordinate; file a 0xFFFF
  answer under the coordinate asked.
- A Text reply is matched by its words: a METAR by `METAR`, `SPECI` or the station and a
  `DDHHMMZ` time first, with the station in its first three words; a TAF by `TAF` first, with the
  station in its first four words; `>wt` by the event's name, and an area's name when the warning is
  held; storm reports and rainfall by the state code as a word; `>afd`, `>space` and `>hwo` by
  subject alone. `>wt` and `>hwo` are matched only from the bot asked.
- A sweep is settled by its first packet from the bot asked; a radar request by a tile for the
  coordinate asked, from any bot; a loop by its first picture; `>part` by any packet it named, from
  the bot asked.

### 19.4 Alert maps

`>wmap` is the most expensive answer on the mesh, up to eight packets for everyone in range. Ask
for it only when a person taps to ask, never when a map opens. **Ask for the states being shown**,
not the country: the reference clients start from the place's own state, and more than 15 states
becomes the country. A sweep of two states is usually one packet, the country five, or eight with
advisories, so the country is the right ask only when the person is looking at the country. Say
when the map on screen was built; inside the bot's 5-minute cooldown it refuses with reason 4,
which the clients show as "busy".

### 19.5 Missing packets

Offer `>part` for an assembly with a gap in it; never send it automatically. Offer it when the
assembly's newest packet arrived at least **15 seconds** ago (the bot's own resend has had its
chance) and its first packet no more than **10 minutes** ago; after that only the whole answer again
is left to offer, because the bot no longer holds the bytes. Send it to the bot that sent the
assembly, and keep the index list inside the 40-byte request. `>part 212 1,4,6` is three packets where `>wmap` would be eight, and the bot sends the
bytes it sent before, so nobody has to redraw what they hold. File what comes back under the same
`group`.

### 19.6 Radar

One packet, and a new picture exists only every 15 minutes. Ask when a person asks, and use any tile
you hear that holds the place on screen, including those a bot broadcasts while there is
precipitation near it (section 15). Send the coordinate with three decimals, and leave out
`z0`. A refusal inside 5 minutes of the same picture going out costs the mesh a packet too, so tell
the person when the picture they hold was taken instead of inviting a refresh. A loop is up to five
packets: offer it on its own control, send the pictures you already hold after `loop` (UTC `HHMM`,
newest first, as many as fit in 40 bytes), and play an hour you already hold without asking.

### 19.7 Forecasts

Use the nearest bundled forecast point within 115 km of a place and ask `>f <index>`. With none that
near, ask `>f <lat>,<lon>` with three decimals.

## 20. Discovery and several bots

Other cities run their own `WX-` bots on `#meshwx`, meshes are bridged so a phone hears two bots and
then loses one, and people travel. A bot is also only two self-asserted bytes on the wire (section
2.2): anyone with the channel name can send a message under any `bot`. So a client judges a bot by
evidence the phone has, not by the name it gives.

### 20.1 Finding bots

- **A bot is a chat node whose advert names it `WX-…`.** An advert is signed by the node's key, so
  it ties the name to the key; a datagram is not. Only a chat advert counts, not a repeater or a
  room server that happens to be named `WX-`.
- A client also hears datagrams from ids it has no advert for. Keep them as **heard-only** bots: a
  client can ask one by Request datagram (whose `bot` is all a request needs) but not by DM.
- Do not rely on an advert's position. A bot does not turn on the firmware's advert location
  policy, so its adverts normally carry 0,0.
- **Name a bot by its name and its id**, the first two bytes of its key in key order, wherever it
  is identified (its row, a notification's source line, an alert's "from"): "WX-AUS 1D04". A
  heard-only bot is "Weather radio 1D04".
- **Two radios under one name or one id.** Two adverts with one name and different keys, or two
  keys whose first two bytes agree, mean two radios answer to that name or id. Say so ("two radios
  use WX-AUS"), choose neither automatically, and notify nothing from that id until the person picks
  one.

### 20.2 Which bot to ask

- **The person's pick** holds near where it was made (within 75 km of the place on screen when they
  picked it) and lapses once its bot has gone 6 hours unheard. Elsewhere, and after that, the
  client chooses.
- **The client chooses**, in this order: a bot **heard live** in the last 2 hours (any message, not
  one drained from the radio's queue) that has not gone silent since a request to it went
  unanswered; then one whose Coverage puts the place inside its area, then unknown, then outside
  (section 10); then one with an advert; then the one heard most recently.
- **Coverage for choosing.** A statement with `n` = 0 and `k` = 0 places nothing: read it as
  unknown, never as covering every place. It is the cheapest statement to forge, and read as
  "everywhere" it would make a spoof sending it under a random id everyone's bot.
- **Before a statement arrives.** The reference clients estimate a bot's area from the stations
  of its multi-station Observations of the last 24 hours: a place inside their convex hull, or
  within 20 km of one, is inside. The estimate ranks bots and decides what the screen says until
  the bot's statement is held, and the statement replaces it. Ask `>cov` rather than lean on it
  (19.1).
- **After an unanswered request** (both sends, section 19.2), ask once more of another bot heard
  live in the last 2 hours whose area covers the place, if there is one, as a new request. Never a
  third bot, and never for `>part`, whose `group` belongs to the bot that sent it.

### 20.3 Warnings from several bots

- **Keep each bot's copies separately**, and show the union by identity: two bots that hold the
  same `(event, office, etn)` hold the same warning. Show the copy in force first; between two in
  force, one from a bot heard live in the last 2 hours; then the later expiry.
- **One bot's Cancel or Digest ends only its own copy**, with one exception: a Cancel (even one
  drained from the radio's queue) from a bot heard live in the 2 hours before it, whose last complete Coverage statement with an area filter
  touches the warning's area (the rule of 17.3), ends every bot's copy issued before the Cancel.
  Such a copy is shown as ended ("cancelled 5 h ago by WX-SAT 2B11"), never as active, and never
  notifies, however much later it arrives: a bot whose feed runs five hours behind repeats what its
  neighbour cancelled at noon. A copy with no issue time counts as issued before the Cancel.
  Remember such endings for 14 days, at most 64 per bot.
- **A notification comes down only once no bot holds a copy in force**, and a notification already
  posted for an identity never sounds again because a second bot sent it, even after it was taken
  down; only an escalation does (18.9).

### 20.4 What one id can cost

- Keep at most **16** bots' states. When there are more, drop the one heard live least recently,
  but never the picked bot, a bot a screen is asking, or one holding a warning in force near a
  watched place.
- An answer fills the five-minute "already heard" rule (19.1) only for the bot that sent it.
- **The missed-messages line** counts a gap, a warning the Digest named that never arrived, or an
  upgrade marker (17.3), only from a bot that covers the place and was heard live in the last 3
  hours, and names that bot; its ask goes to that bot. When no bot is known to cover the place,
  every bot counts.

### 20.5 Say what a request carries

A Request datagram carries the first six bytes of the radio's public key (section 11), and a request
for "my location" carries the coordinates it asks about. Both go to everyone in range. Say so where
the client explains itself.

## 21. Search and places

- **Places.** `places.json` entries are `[NAME, ST, lat, lon, population]`. Match by prefix on the
  name (folded to ASCII), then rank by distance from the phone's position, or from the place on
  screen when there is none, then by population; with neither, show the 25 largest matches in
  alphabetical order. Always show the state: 4,292 names appear in more than one state, and Round
  Rock is in both TX and AZ. Label a result by section 16.2, and merge rows with the same label
  within 15 km.
- **ZIPs.** Five digits, or a ZIP+4, is an exact `zips.json` lookup. The ZIP's point is then a
  coordinate like any other for its forecast point, station and zones, and its label is its
  place's label and the ZIP (section 16.1). A ZIP not in the table is unknown.
- **Stations.** By ICAO code: three or four letters or digits, matched by prefix, at most five
  results, nearest first, each with its distance.
- **Forecast points.** For "forecast here", take the nearest `pfm_points` entry by great-circle
  distance, within 115 km, and send `>f <index>`; label the answer with the point's name and
  distance. With no point that near, send `>f <lat>,<lon>` with three decimals: "no forecast point
  nearby" is a fact about the bundle, not about the weather. A 0xFFFF answer is the forecast for
  the coordinate asked, and stands for places within 25 km of it.
- **A coordinate's name.** The nearest place of at least 1,000 people within 25 km; failing that,
  the nearest place of any size within 25 km; then the nearest station the client holds; then
  "This location".
- **Zones and counties** are looked up by code. The zone or county of a coordinate comes from the
  polygons (`zones.geojson`, `counties.geojson`) once they are loaded.
- When a client sends a place as text (`>f round rock tx`), the bot resolves it its own way (prefix
  match, nearest to the bot, then population) and answers from the nearest point; the answer's
  `point` says which. The reference clients send coordinates instead.

## 22. Text commands for people

A bot answers plain-text commands from anyone, on `#meshwx` or by DM. They are how people without
an app use it, and a client can offer them as a "message the bot" screen for anything the binary
path does not cover. They are not MeshWX messages: they are ordinary MeshCore text.

```
wx [city ST | ZIP | ICAO | ST]   conditions, today's high and low, warnings (a state: its overview; nothing: the country)
forecast <city ST | ZIP>         the next days, one line each
warn [city ST | ZIP | ST]        active watches, warnings and advisories (nothing: the country)
outlook <city ST | ZIP>          hazardous weather outlook
storm [ST | city ST]             storm reports, last 6 hours (nothing: the bot's home state)
rain [ST | city ST]              rainfall totals (nothing: the bot's home state)
metar <ICAO | city ST | ZIP>     latest airport observation
taf <ICAO | city ST | ZIP>       terminal aerodrome forecast
radar [city ST | ZIP]            what the radar shows around a place, in words (nothing: the bot's home)
space                            space weather
sat                              the satellite receiver: lock, signal, drops, newest EMWIN, how far behind
status                           the operator's notices, and whether the feed is on time
cov                              what this bot covers: area, offices, stations, alert list
more                             the next page of the last long reply
help                             the command list
```

Words a bot also accepts: `weather` for `wx`; `warning`, `warnings` for `warn`; `storms`; `swx`,
`solar` for `space`; `satellite`, `goes`, `signal` for `sat`; `notice`, `notices` for `status`;
`coverage`, `covers` for `cov`; `next` and `<command> more` for `more`. A state may be written as
its code or its name, a station as its ICAO or IATA code. A message with no command word is read
as `wx` when it names a place (a ZIP, or a real "city ST"), and otherwise ignored on the channel, so
a bot does not answer conversation.

### 22.1 Where the reply goes

A DM is always answered by DM. A command on the channel is answered according to the bot's reply
mode, which its operator sets:

- **channel**: every command on the channel is answered on the channel, from the bot, paged like a
  DM. WX-AUS runs this way. Every bot that hears a command answers it.
- **dm** (the default): by DM, when the bot knows the sender's key from an advert or an earlier DM.
  A sender it cannot DM gets one short reply on the channel instead, ending ` … DM me for all`,
  when it is at most two hops away, no more than once per sender every 10 minutes and 12 times an
  hour in all; otherwise nothing.
- **dm_only**: by DM, or not at all.

### 22.2 Pages and `more`

A long reply is cut into pages, at `; `, ` | `, `, ` or a space, tagged ` (1/3) more` and the last
` (3/3)`. A page is at most 147 bytes, tag included, and shorter for a bot with a long name, because
a channel message carries the sender's name. Send `more` for the next page. A reply is kept 15
minutes; after the last page, `more` says the reply is finished.

### 22.3 DM delivery

How a bot answers by DM, which a client need not do anything about but may want to understand:

- A reply leaves at least 2 seconds after the request arrived, so the bot's own ACK of the request
  clears the first repeater first.
- Replies to one person go out one at a time, in order: the next starts when the phone has
  acknowledged the one before or the bot has given up on it. At most 5 wait.
- A reply keeps one timestamp and one text for all its tries, so a phone that already has it hides
  the repeats. With a stored route the bot tries the route twice, then once by flood; with no route,
  by flood twice.
- A phone that hears no ACK sends its DM again. The bot takes it as the same request when the
  timestamp and the text are the same within 30 minutes, or the text is the same within 2 minutes of
  the first copy; case and extra spaces do not count. A copy gets nothing when its reply was
  acknowledged or is still on its way, the same reply again when that reply failed, and an answer
  when the first copy was not answered (a limit, or the bot was starting up). After 2 minutes the
  same text is a new request. Commands on the channel have no copy rule.
- `more` is the exception, because people send it again on purpose. A `more` with the timestamp of
  an earlier one is a copy. A `more` with a new timestamp is a new request once the page before it
  was acknowledged, and a copy while that page is still on its way or failed. `more` sends the
  first page the phone has not acknowledged: it may repeat a page whose ACK was lost, and never
  skips one. On the channel there is no ACK, so `more` simply sends the next page.

Limits on text commands, counted per sender and in all: one reply every 5 seconds (2 for `more`),
40 per sender per hour, 400 per hour in total. Over a limit, nothing.

A bot may also post plain-text status lines (`WX-AUS: status: GOES lock lost 10m`) on a separate
channel of its operator's choosing. They are for people, not for clients, and never on `#meshwx`.

## 23. Implementation checklist

1. Add `#meshwx` to the radio; confirm companion firmware 1.15 or newer (section 1.1).
2. Decode `GRP_DATA` with `data_type` 0xFF10 on the `#meshwx` slot, up to 165 bytes; ignore
   unknown types and flag bits, read lists by their counts, ignore trailing bytes (2.5). Pass every
   test vector (Appendix A).
3. Drop other phones' Requests; keep state per bot; drop copies by `seq` and content; mark gaps
   and let the person ask for the Digest (17.1, 17.2).
4. Store warnings by `(event, office, etn)`; apply Cancels; apply Digests with the cut, area and
   2-minute rules, one bot's digest for its own copies only (17.3).
5. Render from the bundle's tables, never from strings on the wire; hide fields sent as unknown
   (sections 16, 18).
6. Times: **as of** per station from its own age, **issued** from the issue time, **from** for a
   warning not yet in effect, never the packet's arrival (18.1). Stale readings shown with their age
   up to 12 hours (18.3). Times more than 15 minutes ahead refused, expiries clamped to 14 days
   (17.5).
7. Take a bot's area from its Coverage statement; read a cut list as incomplete, never as a denial,
   and `n` = 0, `k` = 0 as unknown (section 10, 20.2).
8. Requests as datagrams naming one bot; 5 seconds apart; one resend after 10 seconds under the next
   `seq`; DM only when the radio cannot send datagrams (19.2). Use what others asked for in the
   last 5 minutes (19.1).
9. Alert maps: ask for the states on screen; assemble by `(bot, group, built, total)`; read the
   scope from packet 0 and shade no state outside it; honour the cut and advisories flags (12,
   17.4, 19.4).
10. Offer `>part` for a gap after 15 seconds and within 10 minutes, to the bot that sent it (19.5).
11. Text replies: assemble by `(bot, group)`; show a missing chunk and a cut reply differently
    (18.5).
12. Radar: compute tiles with `floor(x / step + 0.5)`; decode the quadtree most significant bit
    first; read `bounds` before reading a 0 as dry; show `taken` with every tile; keep tiles by
    `(south, west, zoom, taken)` and pool them across bots; pair a `>radar` refusal by the letter
    `x` (section 13, 17.7, 18.4).
13. Forecasts: the nearest bundled point within 115 km, else `>f <lat>,<lon>` (19.7).
14. Several bots: chat adverts only; name bots with their id; choose by liveness, coverage and the
    person's pick; one bot's Cancel ends another's copy only on evidence; at most 16 bot states
    (section 20).
15. A "message the bot" screen for the text commands and `more` (section 22).

---

## Appendix A: test vectors

`docs/meshwx_v5_vectors.json` is a list of entries, each with `name`, `hex` (the `data` bytes),
`decoded` (what the reference decoder returns) and, for most, a `note`. A decoder is correct when
it decodes every vector to the JSON shown; an encoder is correct when it re-encodes every vector
within the send limit to the same hex.

Two vectors are longer than a bot sends and are **decode only**: `text_warning_narrative_chunk0`
(165 bytes, the transport maximum) and `area_sweep_national_packet0` (163 bytes, 38 entries). A
decoder must read them (section 2.5); an encoder held to the 157-byte send limit refuses them, as
the reference encoder does.

The vectors are built to exercise a decoder, not copied from the air: their times, texts and
values are not always what a bot would send for the same input. `observations_three_stations`
carries a wind direction with an unknown speed and an unknown humidity beside a known temperature
and dewpoint; `forecast_seven_days` has `first` 0 for an evening issue time; the narrative's "until
145 AM CDT" does not match its Warning's expiry; `cancel_expired_early` uses reason 1, which a bot
does not send. Decode them as they are.

### A.1 How the JSON names the fields

Every decoded message has `seq`, `bot`, `type` (the high nibble), `name` (`warning`, `cancel`,
`digest`, `observations`, `forecast`, `text`, `not_available`, `coverage`, `request`,
`area_sweep`, `radar`) and `flags` (the whole low nibble, source bits included), and `source`
(the data source, 2.3) for every type but Cancel, Not available, Coverage and Request. A sentinel
decodes as `null`, except `gust` 0 and `feels` 0, which stay 0. Times in Unix minutes get a `_min`
suffix. Coordinates are degrees rounded to 4 decimals. A compass nibble decodes as `wind_dir_deg`
(nibble × 22.5) and `wind_dir`, its name: N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSW, SW, WSW, W, WNW,
NW, NNW. A flag bit decodes as a boolean named after it.

| Type | Wire field → JSON |
|---|---|
| Warning | `expires` → `expires_min`; `tags` → `tornado`, `flood_source`, `flood_damage` (numbers); `hail` → `hail_qin`; `wind` → `wind_mph`; polygon → `polygon`, a list of absolute `[lat, lon]`; area runs → `areas`, each `{state, county, start, run}`; `issued_before` → `issued_min` (absolute) and `begins_before` → `begins_min` (absolute, `null` when absent or ignored); flags bit 0 → `update` |
| Cancel | the flags nibble → `reason` (and `flags`) |
| Digest | `now` → `now_min`; entries keep `expires_rel` and add `expires_min` (absolute) |
| Observations | `ts` → `ts_min`; per station `temp_f`, `dewpoint_f`, `sky`, `wind_mph`, `gust_mph`, `visibility_mi`, `pressure` → `pressure_inhg` (29 + p / 100, 2 decimals), `humidity_pct`, `feels` → `feels_delta_f`, age nibble → `age_min` (× 10, `null` without ages) |
| Forecast | `issued` → `issued_min`; `first` → `first_period`; per period `high_f`, `low_f`, `pop` → `pop_pct`, `cond` → `sky`, `thunder`, `wintry`, `windy`, `fog`, wind → `wind_dir_deg`, `wind_dir`, `wind_mph` (speed nibble × 5) |
| Text | as on the wire, flags bit 0 → `cut` |
| Not available | `request` → `request` (the letter) and `request_code` (its byte) |
| Coverage | `radius` → `radius_km`; runs → `areas`; flags → `zones_cut`, `offices_cut` |
| Request | `sender` → lower-case hex; `ts` stays Unix seconds |
| Area sweep | `built` → `built_min`; `total` → `total` (masked) and `scoped`; entries `{event, state, county, start, run}`; scope entries are lifted out of `entries` into `scope`, a list of state indices; flags → `cut`, `advisories` |
| Radar | `taken` → `taken_min`; `shape` → `zoom`, `product`; `bounds` → `[row0, row1, col0, col1]`; the cells → `size` (32 or 16) and `rows`, one string of level digits per row, north row first; flags → `coarse`, `partial` |

### A.2 The vectors

| Vector | Type | Bytes | What it exercises |
|---|---|---|---|
| `severe_thunderstorm_warning_polygon` | Warning | 51 | Polygon of 6 vertices, 2 county runs, hail, wind and tornado tags |
| `severe_thunderstorm_warning_issued` | Warning | 53 | The same with the issue time (flags bit 1) |
| `severe_thunderstorm_warning_from_goes` | Warning | 53 | The same with data source 1 in the flags |
| `warning_upcoming_watch` | Warning | 28 | A watch with a start after its issue time (3.4) |
| `winter_storm_warning_zones` | Warning | 24 | Zone runs only, no polygon |
| `cancel_expired_early` | Cancel | 8 | Reason 1 |
| `digest_three_entries` | Digest | 28 | Three entries, not in expiry order |
| `observations_three_stations` | Observations | 42 | Calm wind, missing groups as unknown |
| `observations_three_stations_ages` | Observations | 44 | The same with per-station ages |
| `forecast_seven_days` | Forecast | 47 | Seven whole days, even `first`: what a bot sends |
| `forecast_seven_periods` | Forecast | 47 | The half-day form: odd `first`, alternating temperatures |
| `coverage_wx_aus` | Coverage | 39 | 4 offices, 5 zone runs, a circle, neither list cut |
| `text_warning_narrative_chunk0`, `_chunk1` | Text | 165, 103 | A two-chunk reply; chunk 0 at the transport maximum |
| `text_afd_cut_from_goes` | Text | 146 | The cut flag and data source 1 together |
| `not_available_unknown_location` | Not available | 6 | Letter `f`, reason 1 |
| `area_sweep_national_packet0`, `_packet1` | Area sweep | 163, 19 | A cut national sweep in two packets; packet 0 past the send limit |
| `area_sweep_scoped_packet0` | Area sweep | 35 | A scoped sweep of two states, one of them with nothing active |
| `request_digest` | Request | 16 | `>d` |
| `request_parts` | Request | 29 | `>part` |
| `request_forecast_at` | Request | 32 | `>f <lat>,<lon>` |
| `request_radar` | Request | 35 | `>radar <lat>,<lon>` |
| `request_radar_loop` | Request | 50 | `>radar ... loop` with two pictures held |
| `radar_tile` | Radar | 131 | A real tile: a squall line across Dallas, cut from the Southern Plains picture |
| `radar_tile_coarse_partial` | Radar | 32 | The coarse and partial flags, with `bounds` |
| `not_available_radar` | Not available | 6 | Letter `x`, reason 4 |
