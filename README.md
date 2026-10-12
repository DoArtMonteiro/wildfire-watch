# WildfireWatch

A full-screen map of global wildfire activity, updated hourly from NASA FIRMS satellite detections, with the official rural-fire occurrences of Portugal's civil protection authority (ANEPC) beside them for mainland Portugal.

**Live:** https://wildfire-watch.duartemonteiro.workers.dev

**Status:** Live, deployed from `main` by GitHub Actions.

Select any detection on the map, or pick one from the panel's keyboard-accessible list of the most intense detections, to see what the satellite measured (radiative power, acquisition time, the source's confidence), where the data came from, a labelled burned-area estimate, model weather, the nearest air-quality reading and related news. In mainland Portugal the detection also says whether an open ANEPC occurrence lies nearby and, if so, its phase and the resources deployed. Each source shows its own state: current, refresh failing, out of date or unavailable. Interface in European Portuguese and English, dark by default.

WildfireWatch is an unofficial portfolio project. Satellite detections arrive a few hours late, not every thermal anomaly is a wildfire, and a satellite cannot tell whether a fire is active, contained or out. The phase shown for a Portuguese occurrence is what ANEPC reports, a few minutes behind, linked to detections by fixed distance and time rules. Every area or air-quality figure is an estimate. In an emergency, call 112.

## Motivation

Portugal burns every summer, but information about a fire can be hard to piece together. It may be split between news tickers, civil protection PDFs, and satellite portals built for researchers rather than people trying to understand smoke on the horizon. Meanwhile, Flightradar24 has shown people that a live system can be understood by looking at a map.

That gap is the whole project: take fire data that already exists in the open and make it legible at a glance, for a casual visitor, in their own language.

This is also a portfolio project. The goal is a working product that uses real data, not a demo with a "coming soon" label behind every button.

## Problems worth solving

**The global feed is too big for a browser.** FIRMS returns every thermal anomaly on Earth for the requested window, which can create a multi-megabyte payload full of redundant points. Simple truncation can drop whole regions. Sorting by intensity alone would let agricultural burns in Africa crowd out other detections. Instead, the Worker keeps every detection in Portugal, reserves part of the budget for the highest radiative power worldwide, and fills the rest round-robin over a 2° grid so no continent goes dark.

**Satellites report heat, not fires.** FIRMS provides hot pixels, while people look for incidents. Calling a pixel an "active fire" with a "severity" claims more than the data supports. The model keeps observations (what VIIRS measured), derived values (what WildfireWatch computes, labelled as estimates) and operational status (which only an authority can report) apart. The map clusters detections only for display, and at detail zoom draws each one as its real sensor pixel, not as a perimeter.

**Two sources disagree in useful ways.** A satellite can see heat before anyone reports a fire, an occurrence can be registered before a satellite passes over it, and the registered place is often the nearest village rather than the fire front. WildfireWatch never merges the two: each keeps its own record, and fixed rules only link them (within 5 km, acquired no more than 6 hours before the occurrence started, and linked to neither when two occurrences are about as close). Every outcome has its own wording: linked, linked but some kilometres from the registered place, between two occurrences, no occurrence linked, outside the official source's coverage, not yet compared, or official data unavailable.

**A recent snapshot is not the same as current data.** If the 13:00 refresh succeeded and the 13:05 one failed, a visitor at 13:10 should not be told the data is current. Snapshot freshness and ingest health are tracked separately for each source, the panel combines them honestly, and one source failing never hides the other. Repeated failures notify the maintainer on Telegram (or Discord); a short daily summary is sent only when there is something worth reading.

**A page load must never wait on NASA.** The upstream API is slow and rate-limited. An hourly Worker cron decouples them: ingestion writes a processed payload to KV, requests only ever read KV. Users never feel the upstream latency, and the map key is never exposed.

**The edge has no Node.** Running Next.js on Cloudflare Workers through OpenNext means server code cannot rely on Node built-ins such as `fs` or `path`. Every dependency must respect that constraint.

**Portuguese is not one language.** The UI is European Portuguese, and the most common way that slips is a stray Brazilian form or a gerund construction. That's guarded by a test (`npm run test:language`) that scans the Portuguese interface and legal copy, rather than by vigilance.

## Why it's built this way

Wildfire data sources differ in field names, units, confidence scales, update frequency, and geographic coverage. Without an adapter layer, the interface tends to depend on whichever feed it started with.

Here every source is mapped into one normalized model (`src/lib/wildfire/types.ts`) before it reaches a component, and every record keeps a reference to its dataset's provenance. The map and panel never parse a provider format.

```
NASA FIRMS CSV ──→ FIRMS adapter ──→ thermal observations ──┐
  (hourly)                            (what VIIRS measured)  │
                                                             ├─→ reconciliation ──→ links + evidence ──→ map / panel
ANEPC ArcGIS JSON ─→ ANEPC adapter ─→ operational incidents ─┘   (fixed rules,       (per detection,      (each source with
  (every 15 min)                      (what ANEPC reports)        no merging)          per incident)        its own health)
```

The reconciliation runs on the server after each ANEPC refresh and is stored with the occurrence snapshot, so the browser receives the result, not either source's raw feed. EFFIS was evaluated and left out: its active-fire layers republish FIRMS, and its burnt-area service was too unreliable in 2026 to add without making the map worse.

## How the data flows

A Cloudflare Worker cron job runs hourly (`workers/firms-ingest.ts`), streams the last three days of VIIRS thermal anomalies for the whole world, and writes a processed snapshot to KV, with an ingest-health record beside it. A snapshot is replaced only by a complete worldwide feed; any failure keeps the last known-good one. The app reads from KV, so a page load never waits on NASA.

A second schedule reads ANEPC's open occurrences every 15 minutes (`workers/anepc-ingest.ts`), keeps the rural fires, links them to the detections in mainland Portugal and stores the result under its own KV keys. `/api/incidents` serves it to the browser.

The raw global feed is far larger than a browser should receive, so ingestion samples it: up to 15,000 points, every detection in Portugal, 1,500 slots for the highest radiative power, and a round-robin over 2° cells for the rest. Overview figures describe this sample, and the panel says so.

When a visitor selects a detection, the panel fetches full-resolution FIRMS detections around it, a place name (Nominatim), the nearest PM2.5 reading (OpenAQ) and headlines (Google News RSS) through Worker routes that round inputs, cache results and cap upstream calls. Model weather comes straight from Open-Meteo in the browser.

[docs/operations.md](docs/operations.md) covers the data model, feed health, alerts, API protection, the free-plan budget and the live smoke checklist. [docs/compliance.md](docs/compliance.md) covers the legal and third-party review.

## Stack

Next.js App Router · TypeScript · MapLibre GL JS 6 via react-map-gl · Turf.js · Tailwind · Playwright

Deployed to Cloudflare Workers through the OpenNext adapter, which is the constraint that shapes the server code: no Node built-ins, no `fs`, no `path`. Everything runs on free tier.

The map needs a browser with WebGL2. Without it, the map area says the interactive map is unavailable on that browser, and the panel, the detection list and the detection details work as usual.

## Running it

```bash
npm install
npm run dev
```

Live FIRMS data requires a NASA map key in `FIRMS_MAP_KEY` (available free from firms.modaps.eosdis.nasa.gov); see `.env.example` for the other optional secrets. Without a key the map has no snapshot to show. For interface work offline, the end-to-end setup serves the production build with a deterministic synthetic snapshot:

```bash
npm run build:cloudflare
node e2e/support/start-server.mjs   # http://127.0.0.1:8788, synthetic data in local KV
```

```bash
npm test                 # unit and static tests
npm run test:unit        # every *.test.ts; `npm run test:unit -- viirs` filters by path
npm run test:static      # contrast floor, icon semantics, PT-PT copy, legal links, no trackers
npm run test:e2e         # Playwright against the production build, third parties stubbed
npm run typecheck
npm run lint

npm run deploy           # build + ship to Cloudflare
```

## Deployment

GitHub Actions (`.github/workflows/deploy.yml`) is the only deploy path. On every push to `main` it runs, in order, and stops at the first failure:

1. `npm test`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build:cloudflare` (`opennextjs-cloudflare build`, which creates `.open-next/worker.js` and `.open-next/assets`; on `main`, the CARTO basemap key `CARTO_API_KEY` is passed to the build)
5. `npm run test:e2e` (Playwright report, traces and videos are kept when it fails)
6. `npm run deploy:cloudflare` (needs the `CLOUDFLARE_API_TOKEN` secret)

Pull requests to `main` run steps 1 to 5 and never deploy. `npm run deploy` still builds and deploys in one go for local use.

Cloudflare's own Git integration (Workers Builds) is disconnected on purpose. Reconnecting it would deploy every push twice, and with its default commands the build fails, because plain `next build` never produces `.open-next/assets`.

## Legal, privacy and accessibility

The site sets no cookies, has no analytics, accounts, forms or advertising, and stores only the visitor's language and theme in `localStorage`. The visitor's browser does talk directly to CARTO, Esri and Open-Meteo, which the privacy policy discloses and the Content Security Policy enforces.

- `/sobre`: what the data is and is not, methodology, data sources and attributions, contact and accessibility statement.
- `/privacidade`: privacy and cookie policy (GDPR, Portuguese Law 41/2004).
- `/termos`: terms of use.

Legal copy lives in `src/lib/legal/` in both languages; the operator's identity and contact channel live in `src/lib/site.ts`. Adding advertising or visitor statistics would require a consent banner and an update to the privacy policy first.

## Status

FIRMS is live. The ANEPC source is built, tested against synthetic data in CI and checked against the live layer (see [docs/operations.md](docs/operations.md#live-validation-12102026)); it ships with the next deploy from `main`. EFFIS was evaluated and is not integrated.
