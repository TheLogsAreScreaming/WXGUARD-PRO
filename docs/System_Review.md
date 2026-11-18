# MeshWX System Review: one system, not parts

> **Status, 2026-09-15:**
> - Committed: resolver and core services (4ecb1d2), PFM and multi-VTEC fixes (d99d110), every product through the services (5e84db5), event byte (00c367e), radius coverage (c170e67), places with population and territories (e19f8a0), space weather (a0474aa, 7b9a275). The §4 rules still hold.
> - Changed:
>   - The wire is now MeshWX v5 (ad6dc24), so 0x20, 0x21, 0x30, 0x31, 0x37 and 0x3E are no longer sent. The event code lives on as the v5 `event` byte.
>   - Text replies page at 147 chars with `more` (c8066a5, d8e4da0).
>   - A stranger with no DM path gets one budgeted channel reply again (48a1e34).
>   - 2026-10-17: an observation no longer has to be under 2 h old to be used. With no station in reach that fresh, `observation_for()` and `raw_metar_for()` return the newest report up to 12 h old, flagged stale, and the reply says how old it is: `63F dp37 N23g35 bkn (KAUS 45km, 5h old)` (95cb6b3). The owner's reason, from NOAA's ten-hour backlog of 2026-10-16: a `wx` reply with the observation left out read as complete. §2's "≤2 h" and §3 item 7 are the rule as it was.
> - Done from the open lists: Guam and USVI places (e19f8a0), and a low-above-high swap in the PFM daily downsampler (6908e27).
> - Still open:
>   - PGUM is still missing from `stations.json`.
>   - There is no SPC day-1 outlook, because the feed carries no outlook points (`Satellite_Feed_Findings.md` §10).
>   - Local duplicate names still rank distance-first; the resolver is untouched since, apart from 72246e7.
> - Where the current truth lives: `docs/MeshWX_v5_Spec.md` revision 3 (§10.4 text commands, §11 places), `core/services.py`, `geodata/__init__.py`.

Adversarial review of the whole bot as a system, 2026-09-13. Companion to `MeshWX_Airtime_Review.md` (the wire) and `Satellite_Feed_Findings.md` (the feed). This one is about whether the pieces between the feed and the wire agree with each other, and what was done about it today.

## 1. What the system looked like

Data flow before today:

```
EMWIN files ──► WeatherStore (keyed by filename, 12 h window)
                    │
        ┌───────────┼──────────────────────┐
        ▼           ▼                      ▼
  text commands   scheduler builders   on-demand builders
  parser/weather  schedule/executor    protocol/broadcaster
  (own regexes,   (pyIEM warnings,     (a second copy of the
   own VTEC,       PFM forecasts,       executor builders)
   own METAR       encode_metar)
   decoder)
        │           │                      │
        ▼           ▼                      ▼
     DM / channel  0x2x/0x30/0x31       0x2x/0x30/0x31 ×2
```

Three implementations of "what is the weather at X", each with its own parsing, each calling the same resolver, each drifting independently. Findings, all verified against today's satellite data:

| # | Disjoint | Evidence |
|---|---|---|
| S1 | **Text path used different parsers than the binary path.** `WeatherStore.get_summary/get_warnings/get_forecast` used hand-rolled VTEC/UGC regexes, a "warnings by product type" dedupe, and ZFP narrative scraping. | `warn austin tx` showed 1 heat advisory while the binary path showed 2; `forecast austin tx` returned an advisory headline, not a forecast. |
| S2 | **Two copies of every binary builder.** `broadcaster.py` and `schedule/executor.py` each had `_build_observation`, `_build_forecast`, `_build_warnings_near`, … with diverging fallbacks. The module docstring admitted it. | Scheduled and on-demand responses could differ in bytes for the same place. |
| S3 | **Zone by nearest centroid.** `resolver._nearest_zones` picked the closest zone centroid, not the polygon containing the point. | Wrong zone for 14 % of Texas places (Cedar Park → Travis instead of Williamson). Zone drives forecasts and warnings-near. |
| S4 | **Bare and duplicate names picked the first alphabetical match.** | `round rock` → Arizona; `Lago Vista TX` → a colonia on the Rio Grande 400 km away. |
| S5 | **Nearest station regardless of whether it reports.** | Would have handed a silent AWOS's city-roundup row to the user instead of the next airport. |
| S6 | **Forecast required the zone to have its own PFM point.** | 11 of the 20 zones around Austin have none; Kyle, San Marcos, Bastrop, New Braunfels fell back to narrative regex. |
| S7 | **PFM parser: one bad point killed the product; 6-hourly table never parsed; when parsed, stamped with the wrong dates; glued Date/header rows corrupted neighbouring points.** | Fixed earlier today; see `Satellite_Feed_Findings.md` §8–9. Forecasts were 2 periods instead of 7. |
| S8 | **Multi-VTEC segments dropped events.** | Fixed earlier today. |
| S9 | **No visible confidence.** Replies never said which station, how far, or whether a name was ambiguous. | Wrong answers were indistinguishable from right ones. |
| S10 | **Coverage vs resolver disagreement.** Coverage is zone-set based (`covers_any`), resolver is point based; the two computed "is this in my area" differently. | State-wide coverage broadcast Lake Charles floods to Austin (airtime review F1). |

## 2. What it looks like now

```
EMWIN files ──► WeatherStore
                    │
                    ▼
            geodata.resolver.resolve()        ONE location answer:
              polygon zone, ranked stations,  zone (by polygon) + method
              home-aware disambiguation       stations [(icao, km)…]
                    │                         ambiguous [states…]
                    ▼
            core.services                     ONE parse per product:
              observation_for()  → Observation  (nearest station that reported ≤2 h) [2026-10-17: else the newest ≤12 h, with its age]
              forecast_for()     → Forecast     (nearest PFM point ≤80 km, 7 days)
              warnings_for()     → [warning]    (pyIEM; zone match or polygon contains point)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  core.render_text          .to_bytes()  (protocol.meshwx packers)
  one DM, ≤120 chars        0x30 / 0x31 / 0x37 / 0x20 / 0x21
        │                       │
   text commands      scheduler builders  +  on-demand builders (thin wrappers)
```

Changes landed (all in the working tree, tests in `tests/test_core.py`, 160 tests passing):

- `geodata/__init__.py`: zone by point-in-polygon over the bundled public-zone shapes (STRtree, 1.7 s to load, ~11 ms per lookup, ~110 MB resident); `rank_stations()`; `set_home()` and home-aware candidate ranking; every result now carries `zone_method`, `station_km`, `stations`, `ambiguous`.
- `core/services.py`: `Observation`, `Forecast`, `warnings_for()` as described; PFM parse cache.
- `core/render_text.py`: the DM renderings, with station and distance in every reply and an "(also AR/MO; add state)" note when a bare name was ambiguous.
- `core/vtec_names.py`: the event name table (also the seed of the v5 event byte table).
- `protocol/encoders.py`: `parse_metar()` split out so text and binary decode a METAR once.
- `main.py`: `wx`, `warn`, `forecast` for a place go through the services; resolver home is set from the first `MCW_HOME_CITIES` entry at startup.
- `schedule/executor.py` and `protocol/broadcaster.py`: observation, forecast, warnings-near builders call the services; the broadcaster's private copies are gone.
- `parser/pfm.py`: glued Date/header repair on top of this morning's fixes.
- `config.py`: `MCW_TIMEZONE` for human-readable times (wire stays UTC).

Verified on today's satellite data, same object rendered both ways:

```
Round Rock, TX 1:55PM (KGTU 17km): 95F dp70 SSE12g17 bkn 10mi 30.01          16 bytes on the wire
Kyle, TX (San Marcos Airport 10km): Mon 98/77 | Tue 101/77 | Wed 94/77 | …    56 bytes, 7 periods
2 active, Round Rock, TX: HEAT ADV til 7:00PM; HEAT ADV Mon 12:00PM-Mon 7:00PM
Springfield, LA (also AR/MO/CO; add state) 1:55PM (KREG 47km): 93F …
```

## 3. Section-3 list, resolved (2026-09-13, second pass)

| # | Was | Now |
|---|---|---|
| 1 | Warnings-near used the v3 4-bit type nibble | **One-byte VTEC event code** on 0x20, 0x21 and 0x37 (byte 1), from the append-only table in `core/vtec_names.py`, exported as `events` in `client_data/protocol.json` (76 codes). Severity is implied by the significance letter. Text and wire now name the same event. |
| 2 | Outlook, storm reports, rain, METAR/TAF raw, nowcast had separate text and binary code | All are `core.services` objects (`Outlook`, `StormReports`, `RainObs`, `Nowcast`, `Taf`, `raw_metar_for`) with `to_bytes()` and a `render_text` function. Text commands, scheduler builders and on-demand builders call them. Fire weather and daily climate remain scheduler-only (no text command exists for them). [2026-09-15: no longer scheduled; v5 has four job products and drops other jobs on load, `schedule/store.py`] |
| 3 | Channel reply path, nudges, reactive adverts | Deleted. Replies are DM-only; a channel command from a sender with no DM path is logged and ignored; a failed DM is dropped, never retried on a channel. [2026-09-15: 48a1e34 brought back one budgeted channel reply, plus an advert, for a sender with no DM path] |
| 4 | Coverage was zone-set-by-state; a WFO implied its whole state | `MCW_HOME_RADIUS_KM` (default 120) around the first home city: every public zone whose polygon intersects the circle. Storm polygons are tested against the circle itself, so a small SVR that contains no zone centroid is still caught. A WFO now adds only its zones; only `MCW_HOME_STATES` widens to a state. |
| 5 | Old regex text helpers in `WeatherStore` | Deleted (1,160 → 400 lines). State and national overviews come from `core/overview.py` on the pyIEM extraction; marine UGC prefixes are excluded from state counts. |
| 6 | Places table had no population and no territories | `scripts/build_places.py` merges GeoNames cities500 (population, PR/GU/VI/AS/MP) with the Census list (34,937 rows). Resolver ranks local candidates by distance, non-local by population, and still flags ambiguity. `wx hagatna` and `wx charlotte amalie` resolve. |
| 7 | Observation had no roundup fallback | Left out deliberately; a station must be within 150 km and have reported within 2 h, otherwise the reply says so. [2026-10-17: still no roundup fallback, but with nothing within 2 h the newest report up to 12 h old is used, labelled with its age; past 12 h, none (95cb6b3)] |

Verified through the real command dispatcher on the production cache (12,133 products): `wx`, `wx TX`, `warn`, `warn TX`, `outlook`, `storm TX`, `rain TX`, `metar kyle tx`, `taf round rock`, `wx springfield` (→ MO by population, alternatives listed), `wx hagatna`, `wx charlotte amalie`, `forecast san juan pr`. 161 tests pass.

Still open, smaller: Guam has no METAR station in `stations.json` (PGUM missing from the source list), so `wx hagatna` reports no observation; the SPC day-1 outlook product; population-aware ranking for *local* duplicates is distance-first, which is right for a city bot but could surprise a state-wide deployment.


### Space weather (added 2026-09-14)

The `space_weather` job type used to dump the newest SWPC file as 0x40 text chunks; on real data it shipped 132 bytes of header plus "No Data." It is now a structured product in `core/space_weather.py`: the SWPC 3-Day Forecast (max Kp last 24 h, max Kp per day for three days, G scale, S1+ and R1-R2/R3+ probabilities) merged with the Daily Indices (sunspot number, 10.7 cm flux, X-ray background) and the live SWPC alert envelope (observed and expected K-index, R2/R3 flare, S-scale proton event). 27 bytes on the wire (message 0x3E, request type 9), one DM line via the `space` / `swx` / `solar` command [2026-09-15: v5 sends no 0x3E; apps ask `>space` and get Text subject 2, and the line reads `Kp 24h max` where it said `Kp now` (6908e27)]:

```
Kp now 3.0, next 3d 3.7/3.7/4.7 (G1 Tue). SFI 114 SSN 77 xray B3.0. R1-2 10%
```

Both products arrive on the satellite feed daily around 22:00Z and 00:30Z. The alert envelope is confirmed on HRIT (an ALTEF3 electron alert, 2026-09-14). Alerts, warnings, watches and summaries all share one layout, so `parse_swpc_alert` covers ALTKnn / WARKnn / WATAxx / ALTXMF / SUMXnn / WARPX1 / ALTPXn / SUMPXn. `alert_state` turns the newest message per code into four small numbers with fixed validity (K alert 3 h, warning until Valid To, watch until its last listed day, flare 3 h, proton event 24 h or until the SUMPX end time). During a storm the line starts with the live state:

```
!G2 storm now (K6) !R3 radio blackout. Kp now 5.7, next 3d 6.3/5.0/4.0 (G2 Tue). SFI 180 SSN 140 xray C2.1. R1-2 55%
```

The storm-class messages have not been seen on the dish yet; their tests use SWPC's published layout and should be checked against the first real ones.

## 4. Rules going forward

- A product is parsed in exactly one place, into one object. Text and bytes are renderings.
- Every reply states its source and distance. If the resolver was unsure, the reply says so.
- Nothing is looked up by array index that could be looked up by a stable code.
- New products get a service, a text renderer, a binary packer, and a test that decodes the bytes and compares them to the text, before they get a schedule entry.

## 5. National validation (2026-09-13, production cache of 12,133 products)

The operator's requirement is the whole US plus Puerto Rico, since other mesh communities will run this. Checked against the bot's live store with the resolver home set to Austin:

| Place | Zone (method) | Station (km) | Obs | Forecast point (km, days) |
|---|---|---|---|---|
| San Juan PR | PRZ001 (polygon) | TJSJ (6) | yes | Luis Muñoz Marín (7, 7) |
| Ponce PR | PRZ007 (polygon) | TJIG (75) | yes | Mercedita (7, 7) |
| Mayagüez PR | PRZ010 (polygon) | TJBQ (33) | yes | Eugenio María de Hostos (8, 7) |
| Anchorage AK | AKZ702 (polygon) | PAFR (22) | yes | Girdwood (24, 6) |
| Fairbanks AK | AKZ844 (polygon) | PAFB (2) | yes | Fairbanks (10, 7) |
| Juneau AK | AKZ325 (polygon) | PAJN (22) | yes | Juneau (24, 6) |
| Honolulu HI | HIZ032 (nearest edge) | PHNG (19) | yes | Kaneohe (19, 7) |
| Hilo HI | HIZ053 (polygon) | PHTO (5) | yes | Hilo (5, 7) |
| Miami, Key West, New York, Boston, Chicago, Denver, Minneapolis, New Orleans, OKC, Omaha, Burlington, El Paso, Brownsville, Amarillo | polygon | 2–13 km | yes | 2–13 km, 6–7 days |
| Seattle, Los Angeles, Phoenix | polygon | 3–13 km | yes | 9–20 km, 6 days |
| Guam, US Virgin Islands | **unresolved** | — | — | places.json has no GU/VI entries (zones and stations exist; station codes `PGUM`, `TIST` work) [2026-09-15: places.json now has 28 GU and 8 VI rows, e19f8a0] |

Across every forecast point in the cache: 7,062 points give 7 days, 1,929 give 6, 254 give fewer (mostly products that only carry 3 days, plus 26 with header glitches now skipped per point instead of per product).

Parser changes this required, beyond the morning's fixes:

- Alaska, Hawaii, and Guam write the local header as `AKDT3hrly` / `ChST3hrly` (no space): header regex made tolerant.
- Guam is east longitude, Samoa is south latitude: coordinate regex accepts `[NS]`/`[EW]`.
- The Date row's labels are centred over each day's columns, and a table can start with an unlabeled leftover column from the previous day (Phoenix 6-hourly: `23 | 05 11 17 23 …`). Slot times are now computed from the LOCAL hour header: columns are grouped into days where the hour wraps, the group a date label sits over gets that date, days are counted outward, and each column is converted to UTC with the zone offset. The UTC-header method is kept only as a fallback.
- Census place names lose their legal suffixes (`San Juan Zona Urbana` → `San Juan`).
- Points outside every public-zone polygon (coastal simplification, e.g. East Honolulu) take the zone whose boundary is nearest instead of the nearest centroid.

Open for a national deployment: add Guam and USVI places (and population) to the bundle build; Alaska's early-morning issuance produced one day with low > high (52/57) in the downsampler's day-0 partial day, worth a guard.
