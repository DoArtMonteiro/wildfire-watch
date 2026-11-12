import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFirmsWorldUrl,
  selectPoints,
  toTimestamp,
  MAX_POINTS,
  SPREAD_TIER_FRP_FLOOR_MW,
  PRIORITY_REGIONS,
  type ParsedRow,
} from "./firms-ingest";
import {
  FIRMS_MIN_GLOBAL_POINTS,
  isGlobalFirmsCachePayload,
  type CachedFirmsPoint,
  type FirmsCachePayload,
} from "../src/lib/wildfire/firms-cache";

const BASE_TIME = Date.parse("2026-08-01T00:00:00Z");

function row(index: number, lat: number, lng: number, frpMw: number): ParsedRow {
  return {
    lat,
    lng,
    frpMw,
    confidencePct: 90,
    detectedAt: new Date(BASE_TIME + index * 1_000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tier-policy tests
// ---------------------------------------------------------------------------

test("priority-region detections survive even when global budget is exhausted by hotter fires elsewhere", () => {
  const rows: ParsedRow[] = [];

  // Flood MAX_POINTS + extra with extremely hot fires spread across many cells
  // in South America (not inside any priority region) so that without tier-a
  // logic they would crowd everything else out.
  for (let i = 0; i < MAX_POINTS + 2_000; i += 1) {
    const lat = -20 + (i % 50) * 0.5;
    const lng = -60 + Math.floor(i / 50) * 0.4;
    rows.push(row(i, lat, lng, 50_000 - i));
  }

  // Add low-FRP Portuguese detections (Tier a — mainland bbox).
  // These have FRP below SPREAD_TIER_FRP_FLOOR_MW so they would never
  // appear in Tier c, and their FRP is far below the South American fires
  // so they would not make Tier b either.
  const ptRows: ParsedRow[] = [];
  for (let i = 0; i < 10; i += 1) {
    ptRows.push(row(MAX_POINTS + 3_000 + i, 38.7 + i * 0.01, -9.1 - i * 0.01, 2.0));
  }
  rows.push(...ptRows);

  const selected = selectPoints(rows);

  // All priority-region rows must survive.
  const ptLngs = new Set(ptRows.map((r) => Math.round(r.lng * 10_000) / 10_000));
  const selectedLngs = new Set(selected.map((p) => p.lng));
  for (const lng of ptLngs) {
    assert.ok(selectedLngs.has(lng), `Portuguese detection at lng=${lng} was dropped`);
  }

  // Total must not exceed budget.
  assert.ok(selected.length <= MAX_POINTS, `selected ${selected.length} > MAX_POINTS ${MAX_POINTS}`);
});

test("FRP floor applies to spread tier but NOT to the priority region", () => {
  // This test must produce more rows than MAX_POINTS so the tier logic engages
  // (when total unique rows <= MAX_POINTS the fast path returns all of them
  // before any floor check — the floor is a selection criterion, not a global
  // quality gate).
  const rows: ParsedRow[] = [];

  // A below-floor detection inside mainland Portugal (Tier a — must survive).
  // Fixed coordinates well away from any generated spread-row position.
  const ptLat = 39.30;
  const ptLng = -7.80;
  const belowFloorPt = row(0, ptLat, ptLng, SPREAD_TIER_FRP_FLOOR_MW - 0.1);
  rows.push(belowFloorPt);

  // A below-floor detection outside every priority region.
  // Must not appear via tier c (floor) or tier b (all other rows have higher FRP).
  const otherLat = 55.00;
  const otherLng = 90.00;
  const belowFloorOther = row(1, otherLat, otherLng, SPREAD_TIER_FRP_FLOOR_MW - 0.1);
  rows.push(belowFloorOther);

  // Enough above-floor global detections across distinct cells to exceed
  // MAX_POINTS and engage the tier logic.  frpMw values (10 + i) are all
  // well above SPREAD_TIER_FRP_FLOOR_MW.  The below-floor rows have frpMw=4.9
  // which ranks last among all points, so they cannot enter tier b.
  for (let i = 2; i < MAX_POINTS + 2_000; i += 1) {
    const cell = (i - 2) % 2_000;
    const lat = -80 + (cell % 80) * 2;
    const lng = -160 + Math.floor(cell / 80) * 8;
    rows.push(row(i, lat, lng, 10 + i));
  }

  const selected = selectPoints(rows);

  // The priority-region low-FRP point must be present (Tier a, no floor).
  const ptPoint = selected.find((p) =>
    Math.abs(p.lat - ptLat) < 0.0001
    && Math.abs(p.lng - ptLng) < 0.0001,
  );
  assert.ok(ptPoint, "below-floor Portuguese detection should survive (Tier a)");

  // The non-priority below-floor point must not appear.
  // frpMw < SPREAD_TIER_FRP_FLOOR_MW excludes it from tier c, and it ranks
  // last by FRP so tier b never reaches it (all HIGH_FRP_TIER_POINTS slots
  // are taken by higher-FRP rows long before it).
  const otherInSelected = selected.find((p) =>
    Math.abs(p.lat - otherLat) < 0.0001
    && Math.abs(p.lng - otherLng) < 0.0001
    && p.frpMw < SPREAD_TIER_FRP_FLOOR_MW,
  );
  assert.equal(otherInSelected, undefined, "below-floor non-priority detection should not appear");
});

test("no duplicates across tiers", () => {
  const rows: ParsedRow[] = [];

  // Hot fires inside Portugal — these qualify for BOTH Tier a AND Tier b.
  // The deduplication invariant requires each id appears exactly once.
  for (let i = 0; i < 5; i += 1) {
    rows.push(row(i, 38.5 + i * 0.1, -8.0 - i * 0.1, 10_000 - i * 100));
  }

  // Plenty of global rows to ensure tiers b and c run.
  for (let i = 5; i < 3_000; i += 1) {
    const lat = -60 + (i % 60) * 2;
    const lng = -150 + Math.floor(i / 60) * 10;
    rows.push(row(i, lat, lng, 500 + i));
  }

  const selected = selectPoints(rows);
  const ids = selected.map((p) => p.id);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, uniqueIds.size, "duplicate ids found across tiers");
});

test("total never exceeds MAX_POINTS regardless of input size", () => {
  const rows: ParsedRow[] = [];
  // More rows than MAX_POINTS, diverse enough to fill all tiers.
  for (let i = 0; i < MAX_POINTS + 10_000; i += 1) {
    const lat = -80 + (i % 80) * 2;
    const lng = -170 + Math.floor(i / 80) * 4;
    rows.push(row(i, lat, lng, 1 + (i % 500)));
  }
  const selected = selectPoints(rows);
  assert.ok(
    selected.length <= MAX_POINTS,
    `selected ${selected.length} points, expected <= ${MAX_POINTS}`,
  );
});

test("all three priority regions are covered — Madeira and Azores bbox constants are correct", () => {
  // Verify the exported constants include at least one bbox covering each territory.
  const madeiraPt = { lat: 32.65, lng: -16.90 };  // central Madeira
  const azoresPt  = { lat: 37.74, lng: -25.67 };  // Faial / central Azores
  const mainlandPt = { lat: 39.50, lng: -7.90 };  // central Portugal

  function coveredByAnyRegion(pt: { lat: number; lng: number }): boolean {
    return PRIORITY_REGIONS.some(
      (r) => pt.lng >= r.west && pt.lng <= r.east && pt.lat >= r.south && pt.lat <= r.north,
    );
  }

  assert.ok(coveredByAnyRegion(mainlandPt), "Mainland Portugal not covered by any priority region");
  assert.ok(coveredByAnyRegion(madeiraPt), "Madeira not covered by any priority region");
  assert.ok(coveredByAnyRegion(azoresPt), "Azores not covered by any priority region");
});

// ---------------------------------------------------------------------------
// Existing tests — adapted for the new MAX_POINTS budget and tiered policy
// ---------------------------------------------------------------------------

test("hybrid sampling retains the top high-FRP threats and fills spatial cells evenly", () => {
  const rows: ParsedRow[] = [];

  // A very dense high-intensity cluster in South America — well outside every
  // priority region (lat=-10.2, lng=-60.4 is not inside any PRIORITY_REGIONS
  // bbox).  The top HIGH_FRP_TIER_POINTS (1,500) of these must survive via
  // tier b since they are the globally-hottest fires.
  for (let index = 0; index < 2_000; index += 1) {
    rows.push(row(index, -10.2, -60.4, 10_000 - index));
  }

  // Lower-FRP detections spread across 1,000 grid cells worldwide.  FRP values
  // (900.1 – 1,000 MW) are above SPREAD_TIER_FRP_FLOOR_MW so they all qualify
  // for tier c.  Some cells happen to fall inside the priority regions — those
  // points are taken in tier a instead (still counted once, not twice).
  for (let index = 0; index < 20_000; index += 1) {
    const cell = index % 1_000;
    const lat = -70 + (cell % 50) * 2.2;
    const lng = -160 + Math.floor(cell / 50) * 8;
    rows.push(row(2_000 + index, lat, lng, 1_000 - (index % 1_000) / 10));
  }

  // A few moderate-FRP Turkish detections (above the spread floor at 5.4-6.2 MW)
  // must survive geographic spread even though their FRP is low globally.
  rows.push(row(22_001, 39.1, 35.2, 6.2));
  rows.push(row(22_002, 37.0, 37.4, 5.8));
  rows.push(row(22_003, 38.5, 27.2, 5.4));

  const selected = selectPoints(rows);
  const repeated = selectPoints([...rows].reverse());

  // Total must equal the budget (input greatly exceeds it).
  assert.equal(selected.length, MAX_POINTS);

  // The hottest fire globally (10,000 MW) must appear somewhere — it lands in
  // tier b (dense Brazilian cluster is not inside any priority region).
  assert.ok(
    selected.some((p) => p.frpMw === 10_000),
    "hottest fire (10,000 MW) should be present via tier b",
  );

  // All top-1,500 dense-cluster fires (10,000 down to 8,501 MW) must survive.
  // They are the globally hottest and must occupy tier-b slots.
  const top1500frp = selected
    .filter((p) => p.frpMw >= 8_501 && p.frpMw <= 10_000)
    .length;
  assert.equal(top1500frp, 1_500, "All 1,500 tier-b (hottest) fires must be present");

  // Turkish region (lat 36-42°N, lng 25-45°E) must appear via spread tier.
  assert.ok(
    selected.some((p) => p.lat >= 35.7 && p.lat <= 42.2 && p.lng >= 25.5 && p.lng <= 45),
    "Turkish spread-tier detection should be present",
  );

  // Determinism: the same ids must appear regardless of input row order.
  assert.deepEqual(repeated.map((p) => p.id), selected.map((p) => p.id));
});

test("world ingestion omits a local date and never narrows the FIRMS area", () => {
  const url = buildFirmsWorldUrl("key/with spaces");
  assert.equal(
    url,
    "https://firms.modaps.eosdis.nasa.gov/api/area/csv/key%2Fwith%20spaces/VIIRS_NOAA20_NRT/world/3",
  );
  assert.ok(!url.includes(","));
  assert.ok(!url.match(/\/\d{4}-\d{2}-\d{2}(?:\/|$)/));
});

test("global cache validation rejects a fixture-sized regional snapshot", () => {
  const points = Array.from({ length: FIRMS_MIN_GLOBAL_POINTS }, (_, index): CachedFirmsPoint => ({
    id: `point-${index}`,
    lat: -75 + ((index % 5) * 30),
    lng: -165 + ((index % 12) * 30),
    frpMw: 10 + (index % 100),
    confidencePct: 80,
    detectedAt: "2026-08-01T12:34:00.000Z",
  }));
  const payload: FirmsCachePayload = {
    version: 1,
    source: "NASA FIRMS VIIRS_NOAA20_NRT",
    generatedAt: "2026-08-01T13:00:00.000Z",
    sourceRows: 10_000,
    filteredRows: 9_000,
    points,
  };

  assert.equal(isGlobalFirmsCachePayload(payload), true);
  assert.equal(isGlobalFirmsCachePayload({ ...payload, points: points.slice(0, 8) }), false);
});

test("FIRMS timestamps reject impossible or future UTC values", () => {
  assert.equal(toTimestamp("2026-02-30", "1200"), null);
  assert.equal(toTimestamp("2026-08-01", "2360"), null);
  assert.equal(toTimestamp("2099-01-01", "0000"), null);
  assert.equal(toTimestamp("2026-08-01", "1234"), "2026-08-01T12:34:00.000Z");
});
