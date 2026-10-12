import {
  FIRMS_CACHE_KEY,
  FIRMS_INGEST_HEALTH_KEY,
  FIRMS_RECURRENCE_HISTORY_KEY,
  isGlobalFirmsCachePayload,
  type CachedFirmsPoint,
  type FirmsCachePayload,
  type RecurrenceHistory,
  type CellRecurrenceRecord,
} from "../src/lib/wildfire/firms-cache";
import {
  nextIngestHealth,
  parseIngestHealth,
  type IngestAttempt,
  type IngestCounts,
  type IngestErrorCode,
  type IngestHealthRecord,
} from "../src/lib/wildfire/ingest-health";
import { planIngestAlerts, planStallAlert, type IngestAlert } from "../src/lib/monitoring/ingest-alerts";
import { accumulateSignals, type RunObservation } from "../src/lib/monitoring/daily-digest";
import { FUSION_INDEX_KEY, buildFusionIndex } from "../src/lib/operational/incidents-cache";
import { deliverAlerts, type AlertChannel, type AlertDelivery } from "../src/lib/monitoring/alert-channels";
import {
  parseCsv as parseCsvShared,
  parseFirmsCsvHeader,
  parseDataLine,
  toPoint as toPointShared,
  toTimestamp as toTimestampShared,
  type ParsedRow as ParsedRowShared,
} from "../src/lib/wildfire/firms-csv";

const FIRMS_BASE_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const FIRMS_SOURCE = "VIIRS_SNPP_NRT";
const FIRMS_DAY_RANGE = 3;
const FIRMS_AREA = "world";

// ---------------------------------------------------------------------------
// Overall point budget
//
// Arithmetic:
//   Wire format: ~126 bytes/point raw JSON (measured against real schema).
//   Gzip ratio:  ~25 bytes/point after gzip (JSON of repeated structure
//                compresses ~5×).
//   15,000 points → ~1.80 MB raw, ~0.36 MB gzipped.
//   Cloudflare KV limit: 25 MB/value → 1.80 MB leaves 23.2 MB headroom (93%).
//   Mobile download: 0.36 MB gzipped ≈ one JPEG thumbnail — acceptable.
//   Improvement over previous 6,000-point cap: 2.5×.
// ---------------------------------------------------------------------------
export const MAX_POINTS = 15_000;

// Tier b: how many of the budget slots to pre-fill with the globally-largest
// fires, before the spatial spread round-robin runs.  1,500 is unchanged from
// the previous PRIORITY_POINTS constant — it captures the most intense fires
// reliably without crowding every other continent out.
export const HIGH_FRP_TIER_POINTS = 1_500;

export const GRID_CELL_DEGREES = 2;

// ---------------------------------------------------------------------------
// Tier c: minimum FRP floor for the geographic-spread round-robin.
//
// Purpose: stop spending budget on 1 MW thermal noise from industrial sites
// or smouldering ash that the user cannot meaningfully distinguish from
// background.  A floor just above the global p50 (~3.5 MW, measured today)
// ensures every spread-tier point represents a real fire event rather than
// detector noise, while still keeping coverage of every continent.
//
// Choosing 5 MW (just above p50, below p75):
//   - Drops ~half of global detections from the spread tier, roughly halving
//     the number of occupied 2° cells that compete for slots — the round-robin
//     still completes and covers all longitude/latitude bands easily.
//   - Keeps every fire that a human would describe as "medium intensity" or
//     higher.  At the measured Portugal FRP distribution (p50 = 8 MW, well
//     above this floor) essentially all Iberian fires already land in Tier a
//     or b, so the floor does not reduce Portuguese coverage.
//   - Does NOT apply to the priority region (Tier a) — low-FRP Portuguese
//     detections are kept unconditionally by design.
// ---------------------------------------------------------------------------
export const SPREAD_TIER_FRP_FLOOR_MW = 5;

// ---------------------------------------------------------------------------
// Per-cell cap for Tier c streaming accumulation.
//
// The global 2° grid is finite (≤16,200 cells).  Capping each cell at 32
// candidates means the worst-case in-memory structure is 16,200 × 32 entries.
// In practice each cell contributes only 1–2 points to the final output
// (MAX_POINTS=15,000 spread across thousands of occupied cells), so 32 is far
// more than needed; it provides generous headroom even when one region has
// an unusually dense cluster.
// ---------------------------------------------------------------------------
const TIER_C_BUCKET_CAP = 32;

// ---------------------------------------------------------------------------
// Task 3: Persistent-source suppression heuristic
//
// Design: 0.5° grid cells (≈55 km at equator) — fine enough to isolate
// individual industrial sites, coarse enough to tolerate satellite-overpass
// drift of a few km between observations. Rolling window of 30 ingest runs
// (≈30 hours at hourly cron cadence). A cell is classified as persistent
// when it fires in ≥ RECURRENCE_PERSIST_THRESHOLD_PCT% of the window.
//
// Safety exemptions (CRITICAL — must never hide a real wildfire):
//   1. Detections inside PRIORITY_REGIONS are NEVER suppressed.
//   2. Any detection with FRP ≥ RECURRENCE_FRP_ESCAPE_MW is kept regardless.
//      Justification: gas flares rarely exceed ~200 MW in a single VIIRS pixel.
//      Setting the escape at 300 MW means almost every genuine large wildfire
//      survives even if the cell looks persistent. Industrial flares that
//      happen to exceed 300 MW (rare) are also retained — a false-negative on
//      a flare is far cheaper than a false-negative on a wildfire.
//
// The flag ENABLE_PERSISTENT_SOURCE_SUPPRESSION defaults to false because
// wildfires that burn for weeks (e.g. a peat fire) would be incorrectly
// suppressed at aggressive thresholds. History is accumulated regardless of
// the flag so that the window fills while the feature is off and the operator
// can evaluate it before enabling.
// ---------------------------------------------------------------------------
export const ENABLE_PERSISTENT_SOURCE_SUPPRESSION = false;

/**
 * Cell size for the recurrence heuristic (degrees).
 * Kept separate from GRID_CELL_DEGREES (2°) to allow independent tuning.
 *
 * 0.1° is roughly 11 km. A flare wanders a little between overpasses, so the
 * cell has to be coarser than a single 375 m footprint — but it must stay far
 * below the scale of a wildfire complex, otherwise one persistent industrial
 * source would mark an entire fire-prone region as non-wildfire.
 */
export const RECURRENCE_CELL_DEGREES = 0.1;

/**
 * A cell is considered "persistent" (likely non-wildfire) when it has
 * produced detections in this fraction of recent ingest runs.
 * 90% → the cell must have been active in at least 27 of 30 runs.
 * Gas flares appear in essentially every VIIRS overpass; wildfires have
 * variable detection rates due to cloud cover and burning cycles.
 */
export const RECURRENCE_PERSIST_THRESHOLD_PCT = 90;

/**
 * How many ingest runs to retain in the rolling history window.
 *
 * 336 runs at hourly cadence is 14 days. Combined with the 90% threshold, a
 * cell must be active for roughly 12.6 of those 14 days before it is called
 * persistent — a pattern a gas flare produces continuously and a wildfire
 * essentially never does.
 *
 * A shorter window is actively dangerous: at 30 runs (~30 hours) any ordinary
 * wildfire burning for two days sits above the threshold and would be
 * suppressed as if it were a flare. The window has to outlast the fire.
 */
export const RECURRENCE_WINDOW_RUNS = 336;

/**
 * FRP escape hatch: any detection above this threshold is kept even if the
 * cell is classified as persistent. Justification: gas flares rarely exceed
 * ~200 MW in a single VIIRS pixel; 300 MW is deliberately above that ceiling
 * so genuine large fires (routinely 500+ MW in active crown fires) are
 * never suppressed.
 */
export const RECURRENCE_FRP_ESCAPE_MW = 300;

/**
 * Maximum number of cells retained in the history structure.
 * Global 2° grid → ≤16,200 cells; 0.5° grid → ≤259,200 theoretically possible,
 * but the VIIRS feed covers active fire locations only, which cluster in
 * fire-prone regions. 10,000 is a generous upper bound based on observed data.
 * When this cap would be exceeded, the N least-recently-seen cells are evicted.
 * At ~60 bytes/cell the KV value stays well under 1 MB.
 */
export const RECURRENCE_MAX_CELLS = 40_000;

// ---------------------------------------------------------------------------
// Tier a: priority regions — every detection inside ANY of these bounding
// boxes is kept unconditionally (subject only to the upstream confidence≥50
// && frp>0 filter applied by parseCsv before selectPoints is called).
//
// Design rationale:
//   A single bbox covering mainland Portugal (-9.6 W, 36.9 S, -6.0 E, 42.2 N)
//   cannot also cover Madeira (~17.3°W, 32.6°N) or the Azores (~25–31°W,
//   36.9–39.8°N) without swallowing a vast rectangle of open Atlantic that
//   would pull in many non-Portuguese detections.  A list of bboxes covers
//   exactly the territories the user cares about at no extra cost — measured
//   live data shows ~1,048 detections for the Iberia bbox over 3 days, which
//   is trivial against the 15,000-point budget.
//
//   Madeira is included: it is a Portuguese autonomous region with documented
//   wildfire history (2017, 2023 fires) and the user said "todos em Portugal".
//
//   The Azores are included for the same reason, even though satellite detections
//   there are historically rare — keeping them costs nothing in practice.
// ---------------------------------------------------------------------------
export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Named list of priority regions whose detections are kept unconditionally
 * (Tier a).  Expressed as separate bboxes rather than a single bbox because
 * mainland Portugal, Madeira, and the Azores cannot be enclosed in one
 * rectangle without capturing a large swath of open Atlantic.
 */
export const PRIORITY_REGIONS: readonly BoundingBox[] = [
  // Mainland Portugal + western Iberia (includes Spanish border zone so fires
  // that straddle the boundary are not accidentally dropped).
  { west: -9.6, south: 36.9, east: -6.0, north: 42.2 },
  // Madeira archipelago (principal island ~-17.3°E, 32.6°N; adds ~0.5° margin).
  { west: -17.4, south: 32.4, east: -16.2, north: 33.2 },
  // Azores archipelago (westernmost point ~-31°W, easternmost ~-25°W).
  { west: -31.3, south: 36.8, east: -24.8, north: 40.0 },
];

export interface FirmsIngestEnv {
  FIRMS_CACHE: FirmsKvNamespace;
  FIRMS_MAP_KEY: string;
}

interface FirmsKvNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}

// Re-export for backwards compatibility with firms-ingest.test.ts.
export type ParsedRow = ParsedRowShared;
export { parseCsvShared as parseCsv, toTimestampShared as toTimestamp };

/**
 * Omit FIRMS' optional DATE segment. The API then selects the most recent
 * available NRT snapshot; deriving "today" in local time can request a
 * future GMT date around midnight. `world` is deliberately unrestricted.
 */
export function buildFirmsWorldUrl(mapKey: string): string {
  return `${FIRMS_BASE_URL}/${encodeURIComponent(mapKey.trim())}/${FIRMS_SOURCE}/${FIRMS_AREA}/${FIRMS_DAY_RANGE}`;
}

function comparePoints(a: CachedFirmsPoint, b: CachedFirmsPoint): number {
  return b.frpMw - a.frpMw
    || b.confidencePct - a.confidencePct
    || b.detectedAt.localeCompare(a.detectedAt)
    || a.id.localeCompare(b.id);
}

function gridCellKey(point: CachedFirmsPoint): string {
  const latCell = Math.floor((point.lat + 90) / GRID_CELL_DEGREES);
  const lngCell = Math.floor((point.lng + 180) / GRID_CELL_DEGREES);
  return `${latCell}:${lngCell}`;
}

/** Returns true when the point falls inside any of the priority regions. */
function isInPriorityRegion(point: CachedFirmsPoint): boolean {
  for (const region of PRIORITY_REGIONS) {
    if (
      point.lng >= region.west
      && point.lng <= region.east
      && point.lat >= region.south
      && point.lat <= region.north
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Min-heap helpers (used for Tier b bounded top-K selection during streaming).
// A min-heap of CachedFirmsPoint ordered by comparePoints lets us maintain
// the top HIGH_FRP_TIER_POINTS without storing all rows simultaneously.
// Inserting a new point: if the heap has room, push; otherwise, if the new
// point is *better than* the heap minimum (i.e. comparePoints(new, min) < 0),
// replace the minimum.  "Better" = higher FRP (or higher confidence, etc.).
// ---------------------------------------------------------------------------

function heapParent(i: number): number {
  return Math.floor((i - 1) / 2);
}
function heapLeft(i: number): number {
  return 2 * i + 1;
}
function heapRight(i: number): number {
  return 2 * i + 2;
}

function heapSiftDown(heap: CachedFirmsPoint[], index: number): void {
  const n = heap.length;
  let current = index;
  for (;;) {
    let smallest = current;
    const left = heapLeft(current);
    const right = heapRight(current);
    if (left < n && comparePoints(heap[left], heap[smallest]) > 0) smallest = left;
    if (right < n && comparePoints(heap[right], heap[smallest]) > 0) smallest = right;
    if (smallest === current) break;
    [heap[current], heap[smallest]] = [heap[smallest], heap[current]];
    current = smallest;
  }
}

function heapSiftUp(heap: CachedFirmsPoint[], index: number): void {
  let current = index;
  while (current > 0) {
    const parent = heapParent(current);
    // Min-heap: parent should be "worse" (compare > 0 means parent is LESS
    // desirable, i.e. lower FRP) → swap.
    if (comparePoints(heap[parent], heap[current]) > 0) {
      [heap[current], heap[parent]] = [heap[parent], heap[current]];
      current = parent;
    } else {
      break;
    }
  }
}

/**
 * Offer a candidate to the bounded min-heap.
 * The heap tracks the HIGH_FRP_TIER_POINTS *best* (highest FRP) points seen
 * so far. When full, we keep a point only if it beats the current minimum
 * (the "worst of the best so far").
 */
function heapOffer(heap: CachedFirmsPoint[], point: CachedFirmsPoint, cap: number): void {
  if (heap.length < cap) {
    heap.push(point);
    heapSiftUp(heap, heap.length - 1);
  } else if (heap.length > 0 && comparePoints(point, heap[0]) < 0) {
    // point is better than the current minimum → replace it.
    heap[0] = point;
    heapSiftDown(heap, 0);
  }
}

// ---------------------------------------------------------------------------
// Recurrence heuristic helpers (Task 3)
// ---------------------------------------------------------------------------

function recurrenceCellKey(lat: number, lng: number): string {
  const latBucket = Math.floor((lat + 90) / RECURRENCE_CELL_DEGREES);
  const lngBucket = Math.floor((lng + 180) / RECURRENCE_CELL_DEGREES);
  return `${latBucket},${lngBucket}`;
}

/**
 * Decide whether a point should be suppressed by the recurrence heuristic.
 * Returns true ONLY when ALL of the following hold:
 *   1. The flag is enabled.
 *   2. The point is NOT in a priority region.
 *   3. The point's FRP is below the escape hatch.
 *   4. The cell's persistence rate meets the threshold.
 */
function isSuppressed(
  point: CachedFirmsPoint,
  history: RecurrenceHistory,
  totalRuns: number,
): boolean {
  if (!ENABLE_PERSISTENT_SOURCE_SUPPRESSION) return false;
  if (isInPriorityRegion(point)) return false;
  if (point.frpMw >= RECURRENCE_FRP_ESCAPE_MW) return false;

  const key = recurrenceCellKey(point.lat, point.lng);
  const cell = history.cells[key];
  if (!cell) return false;

  // Use the window as the denominator, capped at the actual number of runs
  // observed so far. This prevents over-suppression early in history.
  const window = Math.min(totalRuns, RECURRENCE_WINDOW_RUNS);
  if (window < RECURRENCE_WINDOW_RUNS) return false; // not enough history yet

  const rate = (cell.recentHits / window) * 100;
  return rate >= RECURRENCE_PERSIST_THRESHOLD_PCT;
}

/**
 * Update the recurrence history with the set of cells active in this run.
 * Rules:
 *   - Increment recentHits for every active cell (capped at RECURRENCE_WINDOW_RUNS).
 *   - Decrement (or leave at 0) for every *existing* cell NOT active this run.
 *   - Cells not seen before get a new record with recentHits=1.
 *   - If adding new cells would exceed RECURRENCE_MAX_CELLS, evict the N
 *     least-recently-seen cells first.
 *
 * We accumulate history regardless of ENABLE_PERSISTENT_SOURCE_SUPPRESSION so
 * the window fills while the heuristic is off and the operator can evaluate it
 * before enabling.
 */
function updateRecurrenceHistory(
  history: RecurrenceHistory,
  activeCellKeys: ReadonlySet<string>,
  nowIso: string,
): RecurrenceHistory {
  const updatedCells: Record<string, CellRecurrenceRecord> = {};

  // Update existing cells.
  for (const [key, record] of Object.entries(history.cells)) {
    if (activeCellKeys.has(key)) {
      updatedCells[key] = {
        recentHits: Math.min(record.recentHits + 1, RECURRENCE_WINDOW_RUNS),
        totalRuns: record.totalRuns + 1,
        lastSeenAt: nowIso,
      };
    } else {
      // Cell was not active this run — decrement hit count so old activity fades.
      const newHits = Math.max(0, record.recentHits - 1);
      if (newHits > 0) {
        // Keep the record only if it still has any recent activity.
        updatedCells[key] = {
          recentHits: newHits,
          totalRuns: record.totalRuns,
          lastSeenAt: record.lastSeenAt,
        };
      }
      // Drop cells that have decayed to zero — they impose no storage cost.
    }
  }

  // Add new cells (ones active this run that have no prior record).
  for (const key of activeCellKeys) {
    if (!(key in updatedCells)) {
      updatedCells[key] = {
        recentHits: 1,
        totalRuns: 1,
        lastSeenAt: nowIso,
      };
    }
  }

  // Enforce the max-cell cap: evict least-recently-seen cells.
  const keys = Object.keys(updatedCells);
  if (keys.length > RECURRENCE_MAX_CELLS) {
    // Sort by lastSeenAt ascending (oldest first) then evict.
    keys.sort((a, b) => updatedCells[a].lastSeenAt.localeCompare(updatedCells[b].lastSeenAt));
    const toEvict = keys.slice(0, keys.length - RECURRENCE_MAX_CELLS);
    for (const key of toEvict) {
      delete updatedCells[key];
    }
  }

  return {
    cells: updatedCells,
    totalRuns: history.totalRuns + 1,
  };
}

// ---------------------------------------------------------------------------
// Streaming CSV consumer (Task 1)
//
// Memory model:
//   - Only one chunk of raw bytes is held at a time (~64 KB from the reader).
//   - A partial-line carry buffer holds at most one incomplete CSV line (~1 KB).
//   - Tier a: accumulates all priority-region points (expected ≤~2,000).
//   - Tier b: min-heap of HIGH_FRP_TIER_POINTS entries.
//   - Tier c: per-2°-cell buckets capped at TIER_C_BUCKET_CAP entries each.
//   - Deduplication: per-tier id sets (NOT a global 200k-entry map).
//
// Estimated peak:
//   Carry buffer:          ~1 KB
//   Tier a accumulator:    ~2,000 × 120 B ≈ 240 KB
//   Tier b min-heap:       1,500 × 120 B  ≈ 180 KB
//   Tier c buckets:        16,200 × 32 × 120 B ≈ 62 MB worst case
//                          (realistically ~2–5k occupied cells) ≈ ~12 MB
//   Recurrence history:    10,000 × ~60 B ≈ 600 KB
//   Active cell key set:   10,000 × ~20 B ≈ 200 KB
//   Total peak:            ~14–15 MB  (vs. ~120–150 MB for the old path)
// ---------------------------------------------------------------------------

interface StreamingAccumulators {
  /** Tier a: all priority-region points kept unconditionally. */
  tierA: CachedFirmsPoint[];
  tierAIds: Set<string>;
  /** Tier b: bounded min-heap of globally-hottest points. */
  tierBHeap: CachedFirmsPoint[];
  tierBIds: Set<string>;
  /** Tier c: per-cell buckets capped at TIER_C_BUCKET_CAP. */
  tierCBuckets: Map<string, CachedFirmsPoint[]>;
  /** Active recurrence cell keys seen this run. */
  activeCellKeys: Set<string>;
  /** Counters for health reporting. */
  sourceRows: number;
  filteredRows: number;
  suppressedRows: number;
}

function makeAccumulators(): StreamingAccumulators {
  return {
    tierA: [],
    tierAIds: new Set(),
    tierBHeap: [],
    tierBIds: new Set(),
    tierCBuckets: new Map(),
    activeCellKeys: new Set(),
    sourceRows: 0,
    filteredRows: 0,
    suppressedRows: 0,
  };
}

/**
 * Process a single parsed row against the three-tier accumulators.
 * This is called once per valid row during streaming — never batched.
 */
function accumulateRow(
  acc: StreamingAccumulators,
  row: ParsedRowShared,
  history: RecurrenceHistory,
  historyTotalRuns: number,
): void {
  acc.filteredRows += 1;
  const point = toPointShared(row);

  // Track the 0.5° recurrence cell regardless of suppression flag or outcome.
  acc.activeCellKeys.add(recurrenceCellKey(point.lat, point.lng));

  // Deduplication: if this id was already selected by a higher-priority tier,
  // skip it to avoid double-counting.
  const alreadySelected = acc.tierAIds.has(point.id) || acc.tierBIds.has(point.id);

  // Tier a: priority regions (unconditional, no FRP floor, no suppression).
  if (isInPriorityRegion(point)) {
    if (!alreadySelected) {
      acc.tierA.push(point);
      acc.tierAIds.add(point.id);
    }
    return;
  }

  // Check recurrence suppression for non-priority detections.
  if (isSuppressed(point, history, historyTotalRuns)) {
    acc.suppressedRows += 1;
    return;
  }

  if (alreadySelected) return;

  // Tier b: global high-FRP (bounded min-heap).
  heapOffer(acc.tierBHeap, point, HIGH_FRP_TIER_POINTS);
  // Track the id so tier c can skip it.  Note: when a point is evicted from
  // the heap, its id remains in tierBIds.  This is intentional: the evicted
  // point was already considered and lost; tracking its id prevents a weaker
  // copy from the same location entering tier c.
  acc.tierBIds.add(point.id);

  // Tier c: geographic spread (above FRP floor, capped per cell).
  if (point.frpMw >= SPREAD_TIER_FRP_FLOOR_MW) {
    const cellKey = gridCellKey(point);
    let bucket = acc.tierCBuckets.get(cellKey);
    if (!bucket) {
      bucket = [];
      acc.tierCBuckets.set(cellKey, bucket);
    }
    // Keep the bucket sorted by FRP descending so the cap always retains the
    // best candidates and round-robin picks the best remaining point.
    if (bucket.length < TIER_C_BUCKET_CAP) {
      // Maintain sorted order via insertion (bucket is small).
      let insertAt = bucket.length;
      while (insertAt > 0 && comparePoints(point, bucket[insertAt - 1]) < 0) {
        insertAt -= 1;
      }
      bucket.splice(insertAt, 0, point);
    } else if (comparePoints(point, bucket[bucket.length - 1]) < 0) {
      // New point is better than the current worst in this bucket: replace it.
      let insertAt = bucket.length - 1;
      while (insertAt > 0 && comparePoints(point, bucket[insertAt - 1]) < 0) {
        insertAt -= 1;
      }
      bucket.splice(insertAt, 0, point);
      bucket.pop();
    }
  }
}

/**
 * Materialise the final point set from the streaming accumulators, applying
 * the same three-tier round-robin logic as selectPoints (pure-batch path).
 *
 * The two functions share the same TIER POLICY; only the data-gathering step
 * differs (streaming vs. batch array).
 */
function finaliseAccumulators(acc: StreamingAccumulators): CachedFirmsPoint[] {
  const selected: CachedFirmsPoint[] = [];
  const selectedIds = new Set<string>();

  // Tier a: all priority-region points, sorted for determinism.
  const tierASorted = acc.tierA.slice().sort(comparePoints);
  for (const point of tierASorted) {
    if (selected.length >= MAX_POINTS) break;
    if (!selectedIds.has(point.id)) {
      selected.push(point);
      selectedIds.add(point.id);
    }
  }

  if (selected.length >= MAX_POINTS) return selected;

  // Tier b: extract heap contents in FRP descending order.
  const tierBSorted = acc.tierBHeap.slice().sort(comparePoints);
  for (const point of tierBSorted) {
    if (selected.length >= MAX_POINTS) break;
    if (!selectedIds.has(point.id)) {
      selected.push(point);
      selectedIds.add(point.id);
    }
  }

  if (selected.length >= MAX_POINTS) return selected;

  // Tier c: round-robin over cell buckets (already sorted per-bucket by FRP).
  // Order buckets by their best point to match the deterministic sort in
  // selectPoints (pure-batch path).
  const orderedBuckets: CachedFirmsPoint[][] = [...acc.tierCBuckets.values()]
    .filter((b) => b.length > 0)
    .sort((a, b) => comparePoints(a[0], b[0]) || a[0].id.localeCompare(b[0].id));

  for (let round = 0; selected.length < MAX_POINTS; round += 1) {
    let addedThisRound = 0;
    for (const bucket of orderedBuckets) {
      const point = bucket[round];
      if (!point) continue;
      if (selectedIds.has(point.id)) continue;
      selected.push(point);
      selectedIds.add(point.id);
      addedThisRound += 1;
      if (selected.length === MAX_POINTS) break;
    }
    if (addedThisRound === 0) break;
  }

  return selected;
}

/**
 * Consume a ReadableStream<Uint8Array> of CSV bytes line-by-line, calling
 * `onRow` for each complete data line (skipping the header).
 * The partial carry buffer ensures a line split across chunk boundaries is
 * assembled correctly before being parsed.
 *
 * @param body         The response.body from fetch().
 * @param onRow        Called once per complete data line with the raw line string
 *                     and column indices. Return value is ignored.
 * @param onHeaderCols Called once with the parsed header column count so the
 *                     caller knows how many cells are expected per row.
 */
export async function consumeFirmsCsvStream(
  body: ReadableStream<Uint8Array>,
  onRow: (line: string, cols: ReturnType<typeof parseFirmsCsvHeader>, expectedCells: number) => void,
): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let carry = "";
  let cols: ReturnType<typeof parseFirmsCsvHeader> | null = null;
  let expectedCells = 0;
  let sourceRows = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode this chunk, carrying pending multi-byte sequences across boundaries.
      const chunk = carry + decoder.decode(value, { stream: true });
      const lines = chunk.split(/\r?\n/);
      // The last element is an incomplete line (or empty string at end).
      // Save it as the new carry buffer.
      carry = lines.pop() ?? "";

      for (const line of lines) {
        if (cols === null) {
          // First line is the header.
          cols = parseFirmsCsvHeader(line);
          expectedCells = line.split(",").length;
        } else {
          if (line.length > 0) {
            sourceRows += 1;
            onRow(line, cols, expectedCells);
          }
        }
      }
    }

    // Flush the carry buffer (handles no-trailing-newline case).
    const remainder = carry + decoder.decode();
    const remainderTrimmed = remainder.trim();
    if (remainderTrimmed.length > 0) {
      if (cols === null) {
        // The entire body was one line (the header only — valid empty feed).
        cols = parseFirmsCsvHeader(remainderTrimmed);
      } else {
        sourceRows += 1;
        onRow(remainderTrimmed, cols, expectedCells);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return sourceRows;
}

/**
 * Selects up to MAX_POINTS from the de-duplicated set of detections using a
 * three-tier priority policy:
 *
 *   Tier a — PRIORITY REGION
 *     Every detection inside PRIORITY_REGIONS (Portugal mainland, Madeira,
 *     Azores) is included unconditionally.  No FRP floor.  These are kept
 *     first so they can never be crowded out by hotter fires elsewhere,
 *     even if the global budget is already full.
 *
 *   Tier b — GLOBAL HIGH-FRP
 *     The largest remaining detections worldwide, sorted by FRP descending.
 *     No geographic floor — a single forest fire in Siberia at 5,000 MW
 *     deserves a slot.  Fills up to HIGH_FRP_TIER_POINTS slots (or until
 *     the total reaches MAX_POINTS).
 *
 *   Tier c — GEOGRAPHIC SPREAD
 *     Round-robin over 2° grid cells so no continent goes dark.  Only
 *     detections with FRP ≥ SPREAD_TIER_FRP_FLOOR_MW are eligible — this
 *     stops the budget being spent on 1 MW thermal noise.  Within each
 *     cell the bucket is pre-sorted by FRP descending so each round picks
 *     the best remaining point from that cell.
 *
 * Deduplication: a point that lands in Tier a is excluded from Tier b and
 * Tier c, so the same detection is never double-counted.
 *
 * The function is pure and deterministic: given the same rows (in any order)
 * it always returns the same set of ids (comparePoints provides a full
 * tie-break down to id, which is a hash of the fingerprint).
 */
export function selectPoints(rows: ParsedRow[]): CachedFirmsPoint[] {
  // Step 0: de-duplicate by fingerprint id, keeping the best reading per id.
  const unique = new Map<string, CachedFirmsPoint>();
  for (const row of rows) {
    const point = toPointShared(row);
    const existing = unique.get(point.id);
    if (!existing || comparePoints(point, existing) < 0) unique.set(point.id, point);
  }
  const all = [...unique.values()].sort(comparePoints);

  // Fast path: nothing to trim.
  if (all.length <= MAX_POINTS) return all;

  // Step 1: Tier a — priority region (unconditional, no FRP floor).
  const selected: CachedFirmsPoint[] = [];
  const selectedIds = new Set<string>();

  for (const point of all) {
    if (isInPriorityRegion(point)) {
      selected.push(point);
      selectedIds.add(point.id);
    }
  }

  if (selected.length >= MAX_POINTS) return selected.slice(0, MAX_POINTS);

  // Step 2: Tier b — global high-FRP (excluding already-selected priority points).
  // `all` is already sorted by FRP descending so we just take the first
  // HIGH_FRP_TIER_POINTS that have not yet been selected.
  let tierBAdded = 0;
  for (const point of all) {
    if (selected.length >= MAX_POINTS) break;
    if (tierBAdded >= HIGH_FRP_TIER_POINTS) break;
    if (!selectedIds.has(point.id)) {
      selected.push(point);
      selectedIds.add(point.id);
      tierBAdded += 1;
    }
  }

  if (selected.length >= MAX_POINTS) return selected;

  // Step 3: Tier c — geographic spread with FRP floor.
  // Bucket the remaining eligible points by 2° grid cell, then round-robin.
  const buckets = new Map<string, CachedFirmsPoint[]>();
  for (const point of all) {
    if (selectedIds.has(point.id)) continue;
    // Apply FRP floor: skip near-noise detections in this tier.
    if (point.frpMw < SPREAD_TIER_FRP_FLOOR_MW) continue;
    const key = gridCellKey(point);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }

  // Order buckets by their best point's FRP so the most active cells lead
  // each round; tie-break by key for full determinism.
  const orderedBuckets = [...buckets.entries()].sort(([keyA, pointsA], [keyB, pointsB]) => (
    comparePoints(pointsA[0], pointsB[0]) || keyA.localeCompare(keyB)
  ));

  for (let round = 0; selected.length < MAX_POINTS; round += 1) {
    let addedThisRound = 0;
    for (const [, bucket] of orderedBuckets) {
      const point = bucket[round];
      if (!point) continue;
      selected.push(point);
      addedThisRound += 1;
      if (selected.length === MAX_POINTS) break;
    }
    if (addedThisRound === 0) break;
  }

  return selected;
}

/**
 * Classify an unknown error into a short, sanitised code for the health record.
 * The raw error message is never stored or logged because it may contain the
 * FIRMS map key (buildFirmsWorldUrl embeds it and a network failure can echo the URL).
 */
function classifyError(error: unknown, mapKey: string): IngestErrorCode {
  if (error instanceof IngestFailure) return error.code;
  const msg = error instanceof Error ? error.message : String(error);
  // Strip the map key before any pattern matching to prevent key leakage.
  const sanitised = msg.replace(new RegExp(mapKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[REDACTED]");
  if (/incomplete/i.test(sanitised)) return "incomplete_feed";
  if (/parse/i.test(sanitised) || /column/i.test(sanitised)) return "parse_error";
  if (/\b[45]\d{2}\b/.test(sanitised)) return "http_error";
  if (error instanceof TypeError || /network|fetch|ENOTFOUND|ETIMEDOUT/i.test(sanitised)) return "network";
  return "unknown";
}

/** A failure whose cause is already classified; carries counts when the feed was read. */
class IngestFailure extends Error {
  constructor(readonly code: IngestErrorCode, readonly counts: IngestCounts = {}) {
    super(`FIRMS ingest failed (${code})`);
    this.name = "IngestFailure";
  }
}

export interface IngestRunReport {
  /** Health record as written for this run. */
  health: IngestHealthRecord;
  /** The snapshot written to KV, or null when the last known-good snapshot was kept. */
  payload: FirmsCachePayload | null;
  /** Alerts planned for this run (delivered only when channels are configured). */
  alerts: IngestAlert[];
  deliveries: AlertDelivery[];
}

export interface RefreshOptions {
  /** Defaults to Date.now; injectable for tests. */
  now?: () => number;
  /** Where alerts go; defaults to none. */
  channels?: AlertChannel[];
}

async function readPreviousHealth(kv: FirmsKvNamespace): Promise<IngestHealthRecord | null> {
  try {
    return parseIngestHealth(await kv.get(FIRMS_INGEST_HEALTH_KEY, "json"));
  } catch {
    return null;
  }
}

async function writeHealth(kv: FirmsKvNamespace, record: IngestHealthRecord): Promise<void> {
  // Best effort: a failed health write must never mask the run's real outcome.
  await kv.put(FIRMS_INGEST_HEALTH_KEY, JSON.stringify(record)).catch(() => {
    console.warn("FIRMS ingest health could not be written");
  });
}

async function readRecurrenceHistory(kv: FirmsKvNamespace): Promise<RecurrenceHistory> {
  try {
    const stored = await kv.get<RecurrenceHistory>(FIRMS_RECURRENCE_HISTORY_KEY, "json");
    if (stored && typeof stored === "object" && typeof stored.totalRuns === "number") return stored;
  } catch {
    // A missing or corrupt history is treated as empty; it never fails the ingest.
  }
  return { cells: {}, totalRuns: 0 };
}

/**
 * Downloads the worldwide feed, selects the map sample and writes the
 * snapshot. Throws IngestFailure (or an unclassified error) without touching
 * the existing snapshot when anything is wrong with the feed.
 */
async function ingestSnapshot(env: FirmsIngestEnv, now: () => number): Promise<{ payload: FirmsCachePayload; counts: IngestCounts }> {
  // Load recurrence history once, before consuming the stream.  Use the
  // history *as it was before this run* for suppression decisions (updating
  // first would make new cells suppress themselves on their first appearance).
  const history = await readRecurrenceHistory(env.FIRMS_CACHE);

  let response: Response;
  try {
    response = await fetch(buildFirmsWorldUrl(env.FIRMS_MAP_KEY), { cache: "no-store", headers: { Accept: "text/csv" } });
  } catch {
    throw new IngestFailure("network");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new IngestFailure("http_error");
  }
  if (!response.body) throw new IngestFailure("network");

  // Stream the CSV body through the three-tier accumulators.
  const acc = makeAccumulators();
  try {
    acc.sourceRows = await consumeFirmsCsvStream(response.body, (line, cols, expectedCells) => {
      const parsed = parseDataLine(line, cols, expectedCells);
      if (parsed !== null) accumulateRow(acc, parsed, history, history.totalRuns);
    });
  } catch (streamError: unknown) {
    throw new IngestFailure(classifyError(streamError, env.FIRMS_MAP_KEY));
  }

  const points = finaliseAccumulators(acc);
  const generatedAt = new Date(now()).toISOString();
  const payload: FirmsCachePayload = {
    version: 1,
    source: "NASA FIRMS VIIRS_SNPP_NRT",
    generatedAt,
    sourceRows: acc.sourceRows,
    filteredRows: acc.filteredRows,
    points,
  };
  const counts: IngestCounts = {
    sourceRows: acc.sourceRows,
    filteredRows: acc.filteredRows,
    selectedPoints: points.length,
    suppressedRows: acc.suppressedRows,
  };

  // Never replace a good worldwide snapshot with an empty or regional one.
  if (!isGlobalFirmsCachePayload(payload)) throw new IngestFailure("incomplete_feed", counts);

  // Update recurrence history AFTER successful selection.
  // Run unconditionally (regardless of ENABLE_PERSISTENT_SOURCE_SUPPRESSION)
  // so the window fills while the feature is off.
  const updatedHistory = updateRecurrenceHistory(history, acc.activeCellKeys, generatedAt);
  await env.FIRMS_CACHE.put(FIRMS_RECURRENCE_HISTORY_KEY, JSON.stringify(updatedHistory)).catch(() => {});

  // Deliberately omit a KV TTL. A failed NASA refresh must not erase the
  // last known-good worldwide snapshot; freshness is communicated separately.
  try {
    await env.FIRMS_CACHE.put(FIRMS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Most likely the free-plan daily KV write limit; the previous snapshot stays.
    throw new IngestFailure("storage_error", counts);
  }

  // The ANEPC runs reconcile against these detections (those of the snapshot
  // inside mainland Portugal: 11 on 12/10/2026, a few thousand on a severe fire
  // day) instead of parsing the whole snapshot. Best effort: a stale index only
  // delays reconciliation with the newest detections.
  await env.FIRMS_CACHE.put(FUSION_INDEX_KEY, JSON.stringify(buildFusionIndex(points, generatedAt))).catch(() => {
    console.warn("FIRMS fusion index could not be written");
  });
  return { payload, counts };
}

/**
 * One scheduled run: records the attempt in the health record (which carries
 * the failure counter and the alert debounce state), keeps the last good
 * snapshot on any failure, and notifies the operator when the planner says so.
 * Never throws for upstream problems; the report says what happened.
 */
export async function refreshFirmsCache(env: FirmsIngestEnv, options: RefreshOptions = {}): Promise<IngestRunReport> {
  const now = options.now ?? Date.now;
  const channels = options.channels ?? [];
  const attemptedAt = new Date(now()).toISOString();
  let previous = await readPreviousHealth(env.FIRMS_CACHE);

  const stall = planStallAlert(previous, now());
  const deliveries: AlertDelivery[] = [];
  if (stall.alerts.length > 0 && previous) {
    // Record the notification before the heavy work, in case this run is stopped too.
    previous = { ...previous, alerts: stall.alertState };
    deliveries.push(...await deliverAlerts(stall.alerts, channels));
    await writeHealth(env.FIRMS_CACHE, previous);
  }

  let payload: FirmsCachePayload | null = null;
  let attempt: IngestAttempt;
  const startedMs = Date.now();
  if (!env.FIRMS_MAP_KEY?.trim()) {
    attempt = { attemptedAt, outcome: "failure", errorCode: "configuration" };
  } else {
    try {
      const result = await ingestSnapshot(env, now);
      payload = result.payload;
      attempt = { attemptedAt, outcome: "success", ...result.counts };
    } catch (error) {
      attempt = {
        attemptedAt,
        outcome: "failure",
        errorCode: classifyError(error, env.FIRMS_MAP_KEY),
        ...(error instanceof IngestFailure ? error.counts : {}),
      };
    }
  }

  const recorded = nextIngestHealth(previous, attempt);
  const plan = planIngestAlerts(recorded, now());
  const { alerts: _previousAlerts, ...withoutAlerts } = recorded;
  void _previousAlerts;
  const observation: RunObservation = { outcome: attempt.outcome, durationMs: Date.now() - startedMs };
  const health: IngestHealthRecord = {
    ...withoutAlerts,
    ...(plan.alertState ? { alerts: plan.alertState } : {}),
    signals: accumulateSignals(previous, observation, now()),
  };

  deliveries.push(...await deliverAlerts(plan.alerts, channels));
  await writeHealth(env.FIRMS_CACHE, health);

  return { health, payload, alerts: [...stall.alerts, ...plan.alerts], deliveries };
}
