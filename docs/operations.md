# Operations

How WildfireWatch gets its data, how it knows when that data is wrong, and how it stays inside Cloudflare's free plan. For the legal and third-party side, see [compliance.md](./compliance.md).

## Data flow

```
cron "0 * * * *"            FIRMS only, in its own invocation

NASA FIRMS ──CSV──→ refreshFirmsCache ──→ KV active-fires:v1                     snapshot, last known good
 (world, 3 days)                          KV active-fires:ingest-health:v1       health, alert state, daily signals
                                          KV active-fires:fusion-index:v1        detections in mainland Portugal, compact

cron "5,20,35,50 * * * *"   ANEPC, then the daily summary when due, in their own invocation

ANEPC ArcGIS ──JSON──→ refreshOperationalIncidents ──→ KV operational-incidents:v1                occurrences + reconciliation
 (open occurrences,     (page, parse, filter,          KV operational-incidents:ingest-health:v1  health, alert state, daily signals
  named fields)          reconcile with the index)
                        ▼
                     daily summary, due from 07:00 UTC ──→ KV operations:digest:v1

any run ──→ Telegram / Discord (optional): failure, stall, stale data, recovery, daily summary

browser ──→ /api/fires ─────→ FIRMS snapshot + public health ──→ adapter ──→ detections + provenance + health ──┐
browser ──→ /api/incidents ─→ occurrences + reconciliation + public health ─────────────────────────────────────┴─→ map / panel
```

A page load never waits on NASA or ANEPC. The FIRMS snapshot is replaced only by a complete worldwide feed (at least 5 000 points across 8 longitude and 4 latitude bands); anything else is recorded as a failure and the previous snapshot stays. Each source has its own KV keys, health record and cron invocation, so a failing or stopped source can never overwrite another's data, hide its state or use its CPU time.

Every ANEPC run reads the fusion index the last successful FIRMS run stored (detections inside the ANEPC coverage box, as `[id, lat, lng, acquiredAt, frpMw]` tuples); the :05 run picks up the index written at :00. If there is no index, the occurrences are still stored and served, marked as not reconciled.

## Domain model

`src/lib/wildfire/types.ts` keeps three kinds of information apart:

| Kind | Example | Who can provide it |
|---|---|---|
| Observation | A `ThermalDetection`: pixel centre, acquisition time, FRP, the source's confidence category, pixel size | An instrument or authority (today: FIRMS VIIRS) |
| Derived value | FRP intensity band (map colour), country from coordinates, burned-area estimate | WildfireWatch, labelled *estimated* or *inferred* |
| Operational status | `unknown`, `active`, `contained`, `extinguished` | Only an operational source; satellite data alone is always `unknown` |
| Operational incident | An `OperationalIncident`: ANEPC occurrence number, registered location, phase (and ANEPC's own label), nature, start and update times, municipality, parish, resources deployed | ANEPC, mainland Portugal only |

A detection never takes on an incident's fields. The reconciliation stores links and the evidence behind them (`src/lib/fusion/reconcile.ts`); the panel shows the linked occurrence's phase as "reported by ANEPC", next to what the satellite measured.

Provenance is shared, not repeated per point: each detection references a `DatasetId`, and the snapshot carries one `SnapshotProvenance` (provider, product, instrument, attribution, source URL, retrieval and processing times, row counts). The detail panel shows it with the acquisition window of the selection.

## Operational source (ANEPC)

`workers/anepc-ingest.ts` and `src/lib/operational/anepc.ts`.

**What it reads.** ANEPC's public layer of open occurrences, the ArcGIS feature service `OcorrenciasSite`, owned by the account `ANEPCdados` of ANEPC's "geoPROCIV" organisation on ArcGIS Online (fogos.pt and other public projects read it too). ANEPC lists the information product on dados.gov.pt as "ProCiv – Ocorrências em aberto" under CC BY 4.0. Each run asks for every open occurrence, a page at a time, naming only the fields the parser reads:

```
GET https://services-eu1.arcgis.com/VlrHb7fn5ewYhX6y/arcgis/rest/services/OcorrenciasSite/FeatureServer/0/query
    ?where=1=1&outFields=ID_oc,Numero,EstadoAgrupado,EstadoOcorrencia,CodNatureza,Natureza,DataOcorrencia,
     DataDosDados,Concelho,Freguesia,Operacionais,MeiosTerrestres,MeiosAereos,Latitude,Longitude
    &returnGeometry=true&outSR=4326&orderByFields=ID_oc&resultOffset=0&resultRecordCount=2000&f=json
```

Naming the fields keeps the street address and a dozen unused fields out of the response, and makes a renamed field fail the query loudly (an ArcGIS error body, recorded as `http_error`) instead of producing empty records. The filter on rural fires stays local: the full list is small, and an empty full list is a reliable sign of a fault (see Safeguards).

**What it keeps.** Rural fires only: nature codes 31xx, except 3107 (mop-up consolidation of an earlier fire), 3109 (fuel management) and 3111 (debris burning). Closed occurrences are dropped. The street address is never stored. Each occurrence keeps ANEPC's number, location, phase, nature, start and update times, municipality, parish and resources (personnel, ground vehicles, aircraft; a missing count is "not reported", never zero).

| ANEPC label (`EstadoAgrupado`) | Phase | Shown as |
|---|---|---|
| Em Despacho, Despacho de 1.º Alerta | `dispatch` | Em despacho / Dispatching |
| Em Curso | `in_progress` | Em curso / In progress |
| Em Resolução | `resolving` | Em resolução / Being resolved |
| Em Conclusão | `concluding` | Em conclusão / Concluding |
| Vigilância | `surveillance` | Em vigilância / Under surveillance |
| Encerrada, Fechada | dropped | not shown |
| anything else (for example "Chegada ao TO") | `other` | ANEPC's own label |

**Safeguards.** A 20-second timeout per page, a 4 MiB cap per page (checked against `Content-Length` and enforced while the body streams), an identifying `User-Agent`, and schema checks. Pages are read in `ID_oc` order while the layer reports `exceededTransferLimit`, up to five pages (10 000 open occurrences); a layer that still has more fails the run as `incomplete_feed` rather than publishing a shortened list. An empty layer is `incomplete_feed` too: the layer lists every kind of open occurrence (road accidents and rescues as well), so an empty response is far likelier a fault than a quiet country. A response with no nature codes, or where three or more rural-fire records arrive and none is readable, is a `parse_error`; one or two unreadable records are dropped and counted. Any failure keeps the last good snapshot and records a safe error code (`network`, `http_error`, `incomplete_feed`, `parse_error`, `storage_error` or `unknown`); upstream response text is never stored or sent.

**Times.** The layer declares its dates in UTC. `DataOcorrencia` (the start) is UTC: its newest value was 10 minutes before the fetch, and its UTC values match the layer's own local `Data` and `Hora` fields shifted by the Lisbon offset. `DataDosDados` (the publication time, the same on every record) is not: on 12/10/2026 it was 59 minutes after the fetch, that is Lisbon summer time written as UTC. The parser reads a publication time that lies ahead of the fetch as Lisbon time, so it shows correctly in summer and winter, and a corrected upstream value (never in the future) is left as it is.

**Coverage.** Mainland Portugal (the layer excludes the Azores and Madeira). A detection is compared with ANEPC only when its inferred country is Portugal and it lies inside the box 36.9–42.2° N, 9.6–6.1° W; anywhere else the panel says no operational source covers the area.

### Live validation (12/10/2026)

The development environment cannot reach ANEPC, so the checks ran on a GitHub Actions runner with read-only requests (two metadata reads and a handful of queries), printing only aggregates:

| Check | Result |
|---|---|
| Layer metadata | Feature layer "Ocorrencias", point geometry, WGS 84, `maxRecordCount` 2 000, pagination supported, date fields declared UTC, ArcGIS cache `max-age=120` |
| Fields | All 15 fields the parser reads exist with the expected types (`CodNatureza` is a small integer, `DataOcorrencia` and `DataDosDados` are dates, counts are small integers) |
| Full query | HTTP 200 in 241 ms; 53 open occurrences of 15 natures, 57 KiB uncompressed (8 KiB with Brotli); no truncation; every record has geometry, all inside the mainland box, coordinates agree with the `Latitude` attribute; no duplicate numbers; no null counts |
| Phases | `EstadoAgrupado`: Em Curso, Em Despacho, Em Conclusão, Em Resolução (all mapped); `EstadoOcorrencia` adds "Despacho de 1º Alerta", "Chegada ao TO" and "Vigilância", which the parser uses only when `EstadoAgrupado` is missing |
| Rural fires | 5 records with codes 31xx (4 × 3103 Mato, 1 × 3101 Povoamento Florestal; 3111 Queima excluded); one has been open, "Em Conclusão", for 19 days |
| The ingest itself | The PR's `refreshOperationalIncidents` ran once against the live layer: one page, `success`, 53 source rows, 5 rural fires, publication time 2 minutes old after the correction, 3.5 KiB snapshot with no address, reconciled against production's 11 detections in mainland Portugal (none within the rules) |

Still to watch after the first deploy: the scheduled runs on Cloudflare (see the checklist under Testing) and how the layer behaves during a severe fire day, which no check on a quiet October day can show.

## Reconciliation

`src/lib/fusion/reconcile.ts`. Deterministic: no probability score, no learned model, and the same two inputs always give the same output, sorted by identifier. Nothing is merged; the result only links records and keeps the evidence.

| Rule | Value | Why |
|---|---|---|
| Candidate distance | within 5 km of the registered location | The registered place is often the nearest locality, not the fire front; VIIRS pixels are about 375 m |
| Candidate time | acquired no more than 6 h before the occurrence started | Heat is often seen before a fire is reported; much older heat belongs to an earlier event |
| Ambiguity | two or more candidates within 1 km of the nearest | The detection is linked to none; both occurrences are listed |
| Recent satellite evidence | a linked detection in the last 12 h | Otherwise "earlier" or "none" |
| Location note | nearest linked detection more than 2 km away | The panel says how far the heat is from the registered place |

Incidents are bucketed in 0.1° cells so each detection is only measured against the incidents around it; a unit test checks that the result is identical to comparing every pair, including at high latitude and across the antimeridian. The rules travel with every snapshot, and the occurrence panel explains them in plain language behind a "How the sources are linked" disclosure.

**What each case looks like** (the states the end-to-end suite covers in `e2e/multisource.spec.ts`):

| Case | Detection panel | Occurrence panel |
|---|---|---|
| One occurrence nearby | Phase badge, "official occurrence 0.5 km away", link to it | Linked detections, latest, strongest, nearest |
| Several detections, one occurrence | Each detection links to it | Count of linked detections, newest first |
| Linked, but more than 2 km from the registered place | Same, with the distance noted | Same note |
| Two occurrences about as close | "Unknown" status, both occurrences listed, neither chosen | "Nearby detections at similar distances from this and another occurrence" |
| Covered, no occurrence linked | "No linked official occurrence", with the rule (within 5 km, started no more than 6 h after the detection), and that a thermal anomaly is not always a fire | n/a |
| Detection from a newer FIRMS snapshot than the one reconciled | "Not yet compared with official occurrences" (NASA publishes late, so even an old detection can be new to the reconciliation) | n/a |
| Occurrence with no detection | n/a | "No linked satellite detection" and why that can happen (clouds, small or new fires, overpass gaps) |
| Outside mainland Portugal | "No operational source covers this area" | n/a |
| Latest operational refresh failed | The card's badge reads "Refresh failing" with the time of the occurrences shown | Same data, unchanged |
| Operational data out of date | Shown, with "may be out of date: last update …"; the map rings fade | Same |
| Operational source unavailable | "Operational information unavailable; satellite data unaffected" | The last snapshot received in this visit stays, labelled; an occurrence no longer listed says so |
| FIRMS out of date | The FIRMS badge says so; the reconciliation used the last snapshot it had | Same |

## Feed health

Each source is assessed on its own, with its own timing. Two independent questions, combined only for display (`src/lib/wildfire/feed-health.ts`):

- **Snapshot freshness**: is the data shown older than 90 minutes?
- **Ingest health**: did the latest scheduled refresh work? The KV record counts consecutive failures and keeps the last success time.

| Panel state | When |
|---|---|
| Current data | Fresh snapshot, latest refresh succeeded (or no failure is known) |
| Refresh failing | Fresh snapshot, but the latest refresh failed: "showing the last successful snapshot, from 13:00" |
| Out-of-date data | Snapshot older than 90 minutes, whatever the refresh says; the message adds whether refreshes are failing or have stopped |
| Source unavailable | No usable snapshot |

The ingest is *stalled* when no attempt has been recorded for two hours (for example, runs stopped by a platform limit before they could write). A failure recorded before the current snapshot was built is treated as superseded. Malformed or missing health records degrade to "status unknown"; they never hide the snapshot.

| Timing | FIRMS (hourly) | ANEPC (every 15 min) |
|---|---|---|
| Snapshot shown as out of date after | 90 min | 45 min |
| Refreshes shown as stopped after | 2 h without an attempt | 1 h without an attempt |
| A failed refresh counts as persistent after | 3 consecutive failures | 4 consecutive failures (one bad quarter-hour is not news) |

Each health record keeps, per source: latest attempt, latest success, outcome, safe error code, consecutive failures, record counts (source rows, kept rows) and, for the daily summary, counters that are never served to the browser. `/api/fires` and `/api/incidents` each serve only their own source's public health.

## Alerts

Optional, free, and off unless configured. Telegram is the main channel; Discord works the same way and can be used instead or as well. The app runs normally with neither. Set them as Worker secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN    # from @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID      # numeric chat id, or @channel
npx wrangler secret put DISCORD_WEBHOOK_URL   # optional: https://discord.com/api/webhooks/<id>/<token>
```

Channels with missing or malformed secrets are skipped. The Discord URL must be an https webhook on a Discord host, so a mistyped secret cannot send data elsewhere.

### Immediate alerts

Each source has its own policy, so one outage produces at most one message per event:

| Event | FIRMS | ANEPC |
|---|---|---|
| Refresh failing | the 3rd consecutive failed run | the 4th consecutive failed run (one hour) |
| Data is stale | the last good snapshot is more than 6 h old | the last good snapshot is more than 3 h old |
| Refresh not running | no attempt recorded for 2 h | no attempt recorded for 1 h |
| Recovered | the first success after any of the above | the same |

A failure of one source never raises the other's alert, and the title names the source ("ANEPC refresh failing", "Operational data is stale"). The stall check runs before the heavy work, in case the current run is stopped too. The debounce state lives inside each health record, so alerts add no KV writes. ANEPC alerts are sent only after that record is stored: if the write fails (for example when the daily KV write limit is reached), the alert waits for a run that can record it instead of repeating on every run.

### Daily summary

Once a day, from 07:00 UTC, the first ANEPC run looks at counters accumulated since the last summary and sends one message **only if something is worth reading**:

| Reported when | Example line |
|---|---|
| 2 or more failures recovered before they reached the alert threshold | `ANEPC: 3 failed attempts, 2 recovered before an alert` |
| 3 or more upstream responses slower than 20 s | `FIRMS: 4 slow upstream responses (over 20 s)` |
| any records dropped as unreadable (the most in one run, since the same bad record is read on every run) | `ANEPC: up to 2 records per run dropped as unreadable` |
| any truncated responses | `ANEPC: 1 truncated responses (records may be missing)` |
| any phase label WildfireWatch does not recognise | `ANEPC: unrecognised phase labels: Chegada ao TO` |

With nothing to report, nothing is sent. Either way the counters restart and the day is marked as summarised. The day is recorded before anything is sent, and if that record cannot be read or written (for example when the daily KV write limit has been reached) nothing is sent: a summary can be lost, never repeated. Anything urgent has already gone out as an immediate alert and is not repeated here.

### What messages contain

Only the event, the source, times, outcome, a safe error code, consecutive failures, data age and record counts, plus, in the summary, phase labels from the public feed reduced to letters, digits and basic punctuation. Never a secret, an API key, upstream response text or anything about visitors. Delivery failures are logged by channel name and HTTP status only.

## API protection

Every route that reaches a third party quantises its input, caches results in memory per isolate, joins identical in-flight lookups and caps upstream calls per isolate (`src/lib/server/upstream-guard.ts`). Over the cap it answers `503` with `Retry-After` and the panel shows its existing "temporarily unavailable" state. Visitors are never identified: limits apply to how often an isolate calls upstream, not to who is asking.

| Route | Upstream | Input normalisation | Cache | Upstream cap per isolate |
|---|---|---|---|---|
| `/api/fires` | Workers KV | none | composed body, 60 s | about 2 KV reads/min |
| `/api/incidents` | Workers KV | none | composed body, 60 s; browser and edge `max-age=60` | about 2 KV reads/min |
| `/api/fires/detail` | NASA FIRMS area API | bbox grown to a 0.1° grid, span ≤ 5°, 1–5 days, start date validated | 30 min (12 entries) + edge cache | 20 calls/min |
| `/api/reverse-geocode` | Nominatim | coordinates rounded to 0.02° (~2 km) | 24 h (1 000 entries) + edge cache 7 days | 30/min, serialised 1 per 1.1 s, queue of 4 |
| `/api/air-quality` | OpenAQ | coordinates rounded to 0.02°; distance re-measured from the detection | 15 min (500 entries) + edge cache | 8 lookups/min (up to 7 OpenAQ calls each) |
| `/api/news` | Google News RSS, Bing RSS fallback | place names only (letters, digits, separators), ≤ 100/60 characters; case and spacing ignored | 15 min (300 entries) + edge cache | 12 lookups/min (up to 6 feed calls each) |

No user-triggered route writes to KV. The free plan allows 1 000 KV writes a day for the whole account, and the scheduled runs need about 291 of them (see below); when every distinct reverse-geocode or detail request used to write a cache entry, a crawler could exhaust the quota and freeze the map.

Error logs record error names and HTTP statuses only: a fetch error message can contain the request URL, and the FIRMS URL contains the map key.

### Optional upgrades (not enabled)

- **Workers Rate Limiting binding** (`ratelimits` in `wrangler.jsonc`, periods of 10 or 60 s). It is generally available, but its availability and cost on the Free plan could not be confirmed from the documentation, and it would key limits on visitor IPs. Test with a non-production Worker before enabling:
  ```jsonc
  "ratelimits": [{ "name": "API_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } }]
  ```
- **WAF rate-limiting rules** need a zone (a custom domain); they cannot be attached to a `*.workers.dev` address.

## Free-plan budget

No paid feature is enabled. The plan the Cloudflare account is on could not be checked from here (the Cloudflare tools were not authorised in this environment); the figures below are compared with the Free plan's documented limits.

| Resource (Free plan) | Limit | WildfireWatch |
|---|---|---|
| Cron Triggers | 5 per account | 2 schedules: `0 * * * *` (FIRMS) and `5,20,35,50 * * * *` (ANEPC, then the daily summary when due) |
| KV writes | 1 000/day, account-wide | about **291/day** when everything succeeds: FIRMS 4 per run (snapshot, health, recurrence history, fusion index) × 24 = 96; ANEPC 2 per run (snapshot, health) × 96 = 192; daily summary 3. A failed run writes 1 (its health record), +1 when a stall alert is recorded. User routes: 0 |
| KV reads | 100 000/day | scheduled runs: about 340/day (FIRMS 2 per run × 24; ANEPC health, fusion index and the summary's state, 3 per run × 96); `/api/fires` and `/api/incidents`: ≤ 2 per minute per isolate each |
| Worker requests | 100 000/day | page loads, API calls and 120 scheduled invocations a day (24 FIRMS, 96 ANEPC); static assets are free |
| CPU time | 10 ms per request and per cron run, "with some built-in flexibility" for infrequent overruns | see below |
| Subrequests | 50 external per invocation | FIRMS run: 1 FIRMS call + alerts; ANEPC run: 1 call per page (1 today, at most 5) + alerts |

### CPU

Measured on 12/10/2026 in `workerd`, the open-source Workers runtime, on a GitHub Actions runner, with the V8 sampling profiler: the CPU time a request spends outside "idle", median of 15 runs (first run in brackets). The ANEPC figures are the run's local work (reading the response, parsing, reading the fusion index, reconciling, serialising); waiting on ANEPC or KV is not CPU time. These are runtime measurements, not Cloudflare's billing figures.

| Run | Input | CPU median (max) |
|---|---|---|
| ANEPC, live data | 53 occurrences (5 rural fires), production's 11 detections in mainland Portugal | **1.7 ms** (5.5) |
| ANEPC, quiet day | 75 occurrences (15 rural fires), 200 detections | 1.0 ms (5.2) |
| ANEPC, busy day | 270 occurrences (120 rural fires), 2 000 detections | 4.4 ms (5.5) |
| ANEPC, extreme day | 500 occurrences (300 rural fires), 8 000 detections | 13.1 ms (15.3; first run 20.4) |
| FIRMS (existing hourly run, unchanged by this work) | 134 651-row worldwide CSV, the size production processed at 12:00 UTC on 12/10/2026 | **781 ms** (963) |

What this means:

- The ANEPC run is well under 10 ms on every day except a nationwide extreme, where it is about 13–20 ms. It runs in its own invocation, so it can never push the FIRMS run over a limit or the other way round.
- The existing FIRMS run needs about 0.8 s of CPU every hour, eighty times the documented Free-plan limit, and production's health record shows it succeeding (attempted and succeeded at 12:00:51 UTC, no consecutive failures). Either the account is not held to 10 ms for cron runs, or it is on a plan with a higher limit. In both cases the ANEPC run, at roughly 1 % of that, is not the limiting factor.
- If Cloudflare ever does stop runs for CPU, the safeguards already cover it: a stopped run keeps the previous snapshot, the panel labels it out of date (45 minutes for ANEPC, 90 for FIRMS), and the stall alert fires (1 h, 2 h). The fixes would be, in order: a smaller FIRMS feed (a regional area or fewer days), which is where the CPU is; then the Workers Paid plan. Neither is applied.
- Where the ANEPC time goes on an extreme day: reconciliation about 6 ms, reading the 540 KiB fusion index about 4 ms, the rest parsing and serialising. Reconciliation already uses a spatial grid (it took about 630 ms without one).

## Security headers

`src/lib/security/headers.ts` builds the Content Security Policy from the hosts the browser really contacts: this origin, CARTO (`basemaps.cartocdn.com`, `*.basemaps.cartocdn.com`), Esri (`server.arcgisonline.com`) and Open-Meteo (`api.open-meteo.com`). It also sets `frame-ancestors 'none'`, `frame-src 'none'`, `object-src 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS, COOP and CORP. `next.config.ts` applies them to Worker responses and `public/_headers` to static assets; a unit test keeps the two identical, and every end-to-end test fails on a CSP violation.

`'unsafe-inline'` remains in `script-src` because statically rendered Next.js pages inline their bootstrap and cannot carry a per-request nonce; no third-party script is loaded.

**MapLibre.** The map uses MapLibre GL JS 6, which fixes GHSA-jrc7-96c5-q579 (an XSS bypass in the sanitiser MapLibre applies to attribution and popup HTML, fixed in 6.4.1). Version 6 runs its tile worker as an ES module from this origin: `scripts/copy-maplibre-worker.mjs` copies `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` into `public/maplibre/` before every `dev` and `build`, and `FireMap` points `setWorkerUrl` at them. The policy therefore allows workers from `'self'` only, with no `blob:` workers. The copied files are build output and are not committed.

MapLibre 6 needs WebGL2. When the browser or device cannot create a WebGL2 context, MapLibre throws a `GPUInitializationError`; the app catches it once (no retries, no console error), replaces the loading state with a notice in the map area, and hides the map-only controls (basemap switch, timeline, legend). The notice is about the map renderer, not the data: the panel, the detection list, the detection details and the legal pages keep working. `e2e/map-unavailable.spec.ts` runs Chromium with WebGL2 disabled to cover this.

**CARTO key.** CARTO requires an API key on basemap requests. The free key is configured in GitHub as `CARTO_API_KEY`; the production build passes it as `NEXT_PUBLIC_CARTO_API_KEY` and the map adds it to CARTO URLs only. The key ends up in the public JavaScript bundle and in every tile request, so it is not a secret, but it is kept out of logs where possible:

- only the deploy build on `main` receives it; pull-request builds stub CARTO and do not need it;
- the workflow prefers an Actions **secret** named `CARTO_API_KEY` and falls back to the repository **variable** of the same name. GitHub prints the values of non-secret variables in each step's environment listing, so storing the key as a secret keeps it out of the deploy log as well.

## Testing

| Command | What it covers |
|---|---|
| `npm run test:unit` | Every `*.test.ts` under `src/` and `workers/`: model, health, alerts, ingest with a fake KV, routes with stubbed upstreams, headers. `npm run test:unit -- viirs` filters by path. |
| `npm run test:static` | Source-level checks: contrast floor, icon semantics, legal links, PT-PT copy, typography, no trackers, no "severity" in the model or copy. |
| `npm run test:e2e` | Playwright against the production build (`npm run build:cloudflare` first) under `wrangler dev`. `e2e/multisource.spec.ts` covers every reconciliation case above with a synthetic ANEPC snapshot built by the app's own parser and reconciliation (`e2e/support/operational-feed.ts`); CI never contacts ANEPC or EFFIS. |
| `npm test` | Unit and static tests. |

### End-to-end (synthetic) versus live smoke

The end-to-end suite proves the app's own behaviour with deterministic synthetic snapshots in local KV and every third-party host stubbed in the browser. It cannot prove that NASA, ANEPC, CARTO, Esri, Open-Meteo, OpenAQ, Nominatim or the news feeds are reachable, that production secrets are set, or that the scheduled ingest runs. After each production deploy, check by hand:

1. The map draws the CARTO basemap (no "API key required" watermark) and, in satellite mode, Esri imagery.
2. The overview badge reads "Dados atuais" and the snapshot time is within the last hour or two.
3. `curl -sI https://wildfire-watch.duartemonteiro.workers.dev/api/fires` shows `x-wildfire-ingest-outcome: success` and a `content-security-policy` header.
4. Selecting a detection shows a place name, model weather, an air-quality reading or "no monitor", and news or "no recent coverage".
5. The browser console shows no Content Security Policy violations.
6. In the Cloudflare dashboard (Workers → wildfire-watch → Logs), the latest cron runs logged "Scheduled refresh succeeded", with `firms` on the :00 run and `anepc` on the :05, :20, :35 and :50 runs.

### First deploy of the ANEPC source

Nothing to configure: the ANEPC layer needs no key, and the crons and KV keys ship with the code. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (or `DISCORD_WEBHOOK_URL`) are optional. After the merge to `main` deploys, run the checks above, then:

| Area | Check | Expected |
|---|---|---|
| Real ANEPC ingest | Wait for the first ANEPC run (:05, :20, :35 or :50) | Logs show "Scheduled refresh succeeded" with `anepc.outcome: success` and a `sourceRows` in the tens or hundreds |
| `/api/incidents` | `curl -s <site>/api/incidents \| jq '{generatedAt, n: (.incidents \| length), health: .ingestHealth.outcome}'` | `200`, `generatedAt` under 20 minutes old, `success`; `n` can be 0 outside the fire season |
| Times | Open an occurrence panel | "Início" matches the ANEPC website (in UTC); "Última atualização da ANEPC" is a few minutes old, never in the future |
| Source health and freshness | The "Ocorrências oficiais" card | Badge "Atual"; the FIRMS badge unchanged |
| FIRMS non-regression | `curl -sI <site>/api/fires`; the map | `x-wildfire-ingest-outcome: success`; detections, timeline and detail panels as before |
| Map layers and panels | Rings on the map; an occurrence in the card; a detection in mainland Portugal | Sky-blue rings; the occurrence panel shows phase, resources and satellite evidence; the detection says whether an occurrence is linked, ambiguous, not linked, or not yet compared |
| Error and stale behaviour | Already covered by the end-to-end suite with synthetic data; in production, only observe | If ANEPC fails, the card turns "Atualização com falhas", then "Pode estar desatualizado" after 45 minutes, and FIRMS is unaffected |
| Scheduled execution and CPU | Workers → wildfire-watch → Metrics: invocation statuses and CPU time per invocation | No `exceededCpu` outcomes; ANEPC invocations in single-digit milliseconds of CPU; the FIRMS invocation as before this change |
| Alerts | With Telegram configured, nothing arrives on a healthy day | No message; the daily summary only when something is worth reading |

### Rollback

The previous version runs the FIRMS refresh on *every* cron it receives, so it must not be left with the ANEPC schedule (`5,20,35,50 * * * *`): FIRMS would then run five times an hour, with five times the KV writes and CPU.

1. Preferred: revert the merge commit on `main` with a pull request. The deploy workflow redeploys the previous code together with its `wrangler.jsonc`, which has the single `0 * * * *` trigger.
2. Faster, if the site is misbehaving: in the Cloudflare dashboard (Workers → wildfire-watch → Deployments) roll back to the previous version, then open Settings → Triggers and check that only `0 * * * *` remains; remove `5,20,35,50 * * * *` if it is still listed. Follow up with step 1 so the next deploy does not bring the change back.
3. Nothing needs cleaning in KV: the previous version ignores the ANEPC keys (`operational-incidents:*`, `active-fires:fusion-index:v1`, `operations:digest:v1`), and FIRMS keeps its own keys.
