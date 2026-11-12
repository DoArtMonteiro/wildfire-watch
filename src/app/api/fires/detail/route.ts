import { getCloudflareContext } from "@opennextjs/cloudflare";
import { FIRMS_PRODUCT, FIRMS_SOURCE_LABEL, type CachedFirmsPoint } from "@/lib/wildfire/firms-cache";
import { parseCsv, toPoint } from "@/lib/wildfire/firms-csv";
import {
  UpstreamBusyError,
  ceilTo,
  createGuardedLookup,
  edgeCachedInit,
  errorName,
  floorTo,
  guardedLookup,
  upstreamBusyResponse,
  type GuardedLookup,
} from "@/lib/server/upstream-guard";

export const dynamic = "force-dynamic";

const FIRMS_BASE_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const FIRMS_SOURCE = FIRMS_PRODUCT;
const DETAIL_CACHE_TTL_SECONDS = 1_800; // 30 minutes
const MAX_BBOX_SPAN_DEGREES = 5;
/**
 * Bounding boxes are grown outward to this grid, so boxes that differ by a few
 * metres share one FIRMS call and one cache entry. The extra margin only adds
 * neighbouring detections to the map.
 */
const BBOX_GRID_DEGREES = 0.1;
/** The FIRMS area API accepts 1 to 5 days. */
const MAX_DAYS = 5;
const SAFETY_CAP_POINTS = 20_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
// The FIRMS NRT archive realistically serves roughly 60 days of data.
// Requests older than this produce confusing upstream errors rather than clean
// empty results, so reject them early with a clear 400.
const NRT_ARCHIVE_MAX_AGE_DAYS = 60;
// Match the tolerance used in firms-csv.ts so start-date validation stays
// consistent with individual detection timestamp validation.
const FIRMS_TIMESTAMP_FUTURE_TOLERANCE_MS = 6 * 60 * 60 * 1_000;

const DETAIL_CACHE_HEADERS = {
  "Cache-Control": `public, max-age=${DETAIL_CACHE_TTL_SECONDS}, s-maxage=${DETAIL_CACHE_TTL_SECONDS}, stale-while-revalidate=3600`,
};
const DETAIL_ERROR_HEADERS = { "Cache-Control": "no-store" };

export interface FireDetailPayload {
  version: 1;
  source: typeof FIRMS_SOURCE_LABEL;
  generatedAt: string;
  bbox: [number, number, number, number];
  days: number;
  start: string | null;
  points: CachedFirmsPoint[];
}

interface DetailEnv {
  FIRMS_MAP_KEY: string;
  /** Per-isolate cache and FIRMS call budget; injectable for tests. */
  lookups?: GuardedLookup<string>;
}

/**
 * Responses are kept in memory, never in KV: every distinct box would otherwise
 * cost a KV write, and the free plan's daily write quota is shared with the
 * scheduled ingest. Entries can be a few megabytes, hence the small count.
 */
export function createDetailLookups(): GuardedLookup<string> {
  return createGuardedLookup<string>({
    maxEntries: 12,
    ttlMs: DETAIL_CACHE_TTL_SECONDS * 1_000,
    budgetLimit: 20,
    budgetWindowMs: 60_000,
  });
}

const detailLookups = createDetailLookups();

/**
 * Resolves the FIRMS map key from whichever source has it.
 *
 * Priority: Cloudflare binding (available in deployed Workers, where secrets
 * are attached to `env`) → process.env (available in `next dev`, where secrets
 * live in .env.local but the Cloudflare binding returns an empty string because
 * FIRMS_MAP_KEY is not declared in wrangler.jsonc vars).
 *
 * Trimmed and treated as absent when empty — prevents an accidental
 * whitespace-only value from reaching the NASA API call.
 */
export function resolveFirmsMapKey(bindingValue: string | undefined): string {
  const fromBinding = bindingValue?.trim();
  if (fromBinding) return fromBinding;
  return process.env.FIRMS_MAP_KEY?.trim() ?? "";
}

class FirmsUpstreamError extends Error {
  constructor(status: number) {
    super(`NASA FIRMS area request failed: ${status}`);
    this.name = "FirmsUpstreamError";
  }
}

function invalidRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400, headers: DETAIL_ERROR_HEADERS });
}

function parseFiniteCoord(value: string | null, min: number, max: number): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseDays(value: string | null): number | null {
  if (value === null) return 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DAYS) return null;
  return parsed;
}

/**
 * Parses and validates the optional `start` query parameter (YYYY-MM-DD).
 *
 * Returns the string unchanged when valid, null when absent (rolling-window
 * behaviour is preserved), or a descriptive error message string when the
 * value is present but invalid.
 *
 * Validation rules:
 *   - Must match YYYY-MM-DD exactly.
 *   - Must not be in the future (allows a 6-hour tolerance matching
 *     FIRMS_TIMESTAMP_FUTURE_TOLERANCE_MS in firms-csv.ts).
 *   - Must not be older than NRT_ARCHIVE_MAX_AGE_DAYS days from today.
 */
function parseStartDate(value: string | null): string | null | { error: string } {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { error: "Invalid parameter: start must be a date in YYYY-MM-DD format" };
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) {
    return { error: "Invalid parameter: start is not a valid calendar date" };
  }
  const now = Date.now();
  if (parsed.getTime() > now + FIRMS_TIMESTAMP_FUTURE_TOLERANCE_MS) {
    return { error: "Invalid parameter: start must not be in the future" };
  }
  const oldestAllowedMs = now - NRT_ARCHIVE_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
  if (parsed.getTime() < oldestAllowedMs) {
    return { error: `Invalid parameter: start is older than the ${NRT_ARCHIVE_MAX_AGE_DAYS}-day NRT archive window` };
  }
  return value;
}

function buildCacheKey(bbox: [number, number, number, number], days: number, start: string | null): string {
  return `${bbox.join(",")}:${days}:${start ?? "latest"}`;
}

function buildAreaUrl(
  mapKey: string,
  west: number,
  south: number,
  east: number,
  north: number,
  days: number,
  start: string | null,
): string {
  const area = `${west},${south},${east},${north}`;
  const base = `${FIRMS_BASE_URL}/${encodeURIComponent(mapKey.trim())}/${FIRMS_SOURCE}/${area}/${days}`;
  return start !== null ? `${base}/${start}` : base;
}

export async function handleFireDetailRequest(request: Request, env: DetailEnv): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  const west = parseFiniteCoord(params.get("west"), -180, 180);
  const south = parseFiniteCoord(params.get("south"), -90, 90);
  const east = parseFiniteCoord(params.get("east"), -180, 180);
  const north = parseFiniteCoord(params.get("north"), -90, 90);
  const days = parseDays(params.get("days"));

  if (west === null) return invalidRequest("Invalid or missing parameter: west (must be -180..180)");
  if (south === null) return invalidRequest("Invalid or missing parameter: south (must be -90..90)");
  if (east === null) return invalidRequest("Invalid or missing parameter: east (must be -180..180)");
  if (north === null) return invalidRequest("Invalid or missing parameter: north (must be -90..90)");
  if (days === null) return invalidRequest(`Invalid parameter: days (must be integer 1-${MAX_DAYS})`);

  if (east <= west) return invalidRequest("Inverted or zero-width bbox: east must be greater than west");
  if (north <= south) return invalidRequest("Inverted or zero-height bbox: north must be greater than south");

  const spanLng = east - west;
  const spanLat = north - south;
  if (spanLng > MAX_BBOX_SPAN_DEGREES) {
    return invalidRequest(`Bbox too large: longitude span ${spanLng.toFixed(2)}° exceeds ${MAX_BBOX_SPAN_DEGREES}° limit`);
  }
  if (spanLat > MAX_BBOX_SPAN_DEGREES) {
    return invalidRequest(`Bbox too large: latitude span ${spanLat.toFixed(2)}° exceeds ${MAX_BBOX_SPAN_DEGREES}° limit`);
  }

  const startResult = parseStartDate(params.get("start"));
  if (startResult !== null && typeof startResult === "object" && "error" in startResult) {
    return invalidRequest(startResult.error);
  }
  // TypeScript narrowing: startResult is now string | null.
  const start = startResult as string | null;

  const mapKey = env.FIRMS_MAP_KEY?.trim();
  if (!mapKey) {
    return Response.json(
      { error: "Fire detail unavailable: upstream API key not configured" },
      { status: 503, headers: DETAIL_ERROR_HEADERS },
    );
  }

  const bbox: [number, number, number, number] = [
    Math.max(-180, floorTo(west, BBOX_GRID_DEGREES)),
    Math.max(-90, floorTo(south, BBOX_GRID_DEGREES)),
    Math.min(180, ceilTo(east, BBOX_GRID_DEGREES)),
    Math.min(90, ceilTo(north, BBOX_GRID_DEGREES)),
  ];

  try {
    const { value: body, cached } = await guardedLookup(
      env.lookups ?? detailLookups,
      buildCacheKey(bbox, days, start),
      () => loadDetail(mapKey, bbox, days, start),
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...DETAIL_CACHE_HEADERS,
        "X-Wildfire-Source": cached ? "memory" : "nasa-firms",
      },
    });
  } catch (error) {
    if (error instanceof UpstreamBusyError) return upstreamBusyResponse(error);
    // Name and status only: a fetch error message can contain the request URL, and with it the map key.
    console.error(`NASA FIRMS area request failed (${error instanceof FirmsUpstreamError ? error.message : errorName(error)})`);
    const invalidData = error instanceof FirmsCsvError;
    return Response.json(
      { error: invalidData ? "Fire detail unavailable: invalid upstream data" : "Fire detail unavailable: upstream error" },
      { status: 502, headers: DETAIL_ERROR_HEADERS },
    );
  }
}

class FirmsCsvError extends Error {
  constructor() {
    super("FIRMS area CSV could not be parsed");
    this.name = "FirmsCsvError";
  }
}

async function loadDetail(
  mapKey: string,
  bbox: [number, number, number, number],
  days: number,
  start: string | null,
): Promise<string> {
  const [west, south, east, north] = bbox;
  const response = await fetch(
    buildAreaUrl(mapKey, west, south, east, north, days, start),
    edgeCachedInit({ headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }, DETAIL_CACHE_TTL_SECONDS),
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FirmsUpstreamError(response.status);
  }
  const csv = await response.text();

  let points: CachedFirmsPoint[];
  try {
    // Apply safety cap — no downsampling or spatial selection on this path.
    points = parseCsv(csv).rows.slice(0, SAFETY_CAP_POINTS).map(toPoint);
  } catch {
    throw new FirmsCsvError();
  }

  const payload: FireDetailPayload = {
    version: 1,
    source: FIRMS_SOURCE_LABEL,
    generatedAt: new Date().toISOString(),
    bbox,
    days,
    start,
    points,
  };
  return JSON.stringify(payload);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return handleFireDetailRequest(request, {
      // Binding is empty in `next dev` (secret not in wrangler.jsonc vars);
      // resolveFirmsMapKey falls back to process.env so local dev works too.
      FIRMS_MAP_KEY: resolveFirmsMapKey(env.FIRMS_MAP_KEY),
    });
  } catch (error) {
    console.error("Unable to obtain Cloudflare context for fire detail route", errorName(error));
    return Response.json({ error: "Fire detail unavailable" }, { status: 503, headers: DETAIL_ERROR_HEADERS });
  }
}
