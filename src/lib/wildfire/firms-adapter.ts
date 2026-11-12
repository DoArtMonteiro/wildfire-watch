import { isFirmsSourceLabel, isGlobalFirmsCachePayload } from "./firms-cache";
import type { CachedFirmsPoint, FirmsSourceLabel } from "./firms-cache";
import { cachedPointToDetection, firmsSnapshotProvenance } from "./firms-dataset";
import { parseIngestHealth } from "./ingest-health";
import type { DetectionFeedSnapshot } from "./types";

interface FireDetailPayload {
  version: 1;
  source: FirmsSourceLabel;
  generatedAt: string;
  bbox: [number, number, number, number];
  days: number;
  points: CachedFirmsPoint[];
}

function isFireDetailPayload(value: unknown): value is FireDetailPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FireDetailPayload>;
  return candidate.version === 1
    && isFirmsSourceLabel(candidate.source)
    && typeof candidate.generatedAt === "string"
    && Array.isArray(candidate.bbox)
    && candidate.bbox.length === 4
    && Array.isArray(candidate.points);
}

/**
 * Reads the detection snapshot from the Worker. NASA is never contacted from
 * the browser or from a page request: the scheduled ingest writes the snapshot
 * to KV and /api/fires serves it with the latest ingest health attached.
 */
export async function fetchDetectionSnapshot(signal?: AbortSignal): Promise<DetectionFeedSnapshot> {
  const response = await fetch("/api/fires", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Fire cache request failed: ${response.status}`);

  const payload: unknown = await response.json();
  if (!isGlobalFirmsCachePayload(payload)) {
    throw new Error("Fire cache returned an invalid or incomplete worldwide payload");
  }

  const ingest = parseIngestHealth((payload as { ingestHealth?: unknown }).ingestHealth);
  const provenance = firmsSnapshotProvenance(payload, ingest);
  return {
    detections: payload.points.map((point) => cachedPointToDetection(point, provenance.dataset.id)),
    provenance,
    ingest,
  };
}

export interface FetchFireDetailOptions {
  /** Number of days of NRT data to request (1–10). Defaults to 3 when absent. */
  days?: number;
  /**
   * Anchors the day-range window to a specific calendar date (YYYY-MM-DD, UTC).
   * When present, the N-day window starts at this date; when absent, the window
   * is the most recent N days measured from now.
   */
  start?: string;
  /** AbortSignal so a rapid re-selection can cancel the in-flight request. */
  signal?: AbortSignal;
}

/**
 * Fetches full-resolution VIIRS detections for a fire's bounding box from
 * GET /api/fires/detail. No downsampling is applied — the entire point cloud
 * is returned for dense burn-scar visualisation.
 *
 * @param bbox     [west, south, east, north] in WGS-84 degrees.
 * @param options  Optional fetch controls — days, start date, and AbortSignal.
 * @throws  Error on non-OK responses. Never returns an empty array on error.
 */
export async function fetchFireDetailPoints(
  bbox: [number, number, number, number],
  options: FetchFireDetailOptions = {},
): Promise<CachedFirmsPoint[]> {
  const { days, start, signal } = options;
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    west: String(west),
    south: String(south),
    east: String(east),
    north: String(north),
  });
  if (days !== undefined) params.set("days", String(days));
  if (start !== undefined) params.set("start", start);

  const response = await fetch(`/api/fires/detail?${params}`, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Fire detail request failed: ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isFireDetailPayload(payload)) {
    throw new Error("Fire detail response has an unrecognised shape");
  }

  return payload.points;
}
