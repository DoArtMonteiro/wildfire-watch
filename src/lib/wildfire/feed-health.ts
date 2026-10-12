import type { IngestErrorCode, IngestHealthRecord } from "./ingest-health";
import type { FeedLoadStatus } from "./types";

/**
 * The ingest runs hourly. A snapshot older than this has missed at least one
 * refresh, so the interface must stop calling it current.
 */
export const SNAPSHOT_STALE_AFTER_MS = 90 * 60 * 1_000;

/** Failed attempts in a row before a degraded refresh is reported as failing. */
export const INGEST_FAILING_AFTER = 3;

/**
 * No recorded attempt for this long means the scheduled ingest is not running,
 * or is being stopped (for example by a CPU limit) before it can record anything.
 */
export const INGEST_STALLED_AFTER_MS = 2 * 60 * 60 * 1_000;

/** How long each source's data stays current, and when its refresh counts as failing or stalled. */
export interface FeedTimingPolicy {
  staleAfterMs: number;
  stalledAfterMs: number;
  failingAfter: number;
}

/** FIRMS is refreshed hourly. */
export const FIRMS_FEED_TIMING: FeedTimingPolicy = {
  staleAfterMs: SNAPSHOT_STALE_AFTER_MS,
  stalledAfterMs: INGEST_STALLED_AFTER_MS,
  failingAfter: INGEST_FAILING_AFTER,
};

/**
 * Operational status (ANEPC) is refreshed every 15 minutes and changes
 * quickly: after three missed runs the phase shown may no longer be true.
 */
export const OPERATIONAL_FEED_TIMING: FeedTimingPolicy = {
  staleAfterMs: 45 * 60 * 1_000,
  stalledAfterMs: 60 * 60 * 1_000,
  failingAfter: 4,
};

/** How old the snapshot is, independent of whether refreshes are working. */
export type SnapshotFreshness = "fresh" | "stale";

/** Whether the scheduled refresh is working, independent of snapshot age. */
export type IngestStatus = "healthy" | "degraded" | "failing" | "stalled" | "unknown";

/**
 * What the visitor is told:
 *   healthy     fresh snapshot, latest refresh succeeded (or no failure is known);
 *   degraded    fresh snapshot, but the latest refresh failed;
 *   stale       snapshot older than the refresh interval allows;
 *   unavailable no usable snapshot.
 */
export type FeedHealthState = "healthy" | "degraded" | "stale" | "unavailable";

export interface FeedHealthAssessment {
  state: FeedHealthState | "loading";
  freshness: SnapshotFreshness | null;
  ingest: IngestStatus;
  snapshotGeneratedAt: string | null;
  snapshotAgeMs: number | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  errorCode: IngestErrorCode | null;
}

export interface FeedHealthInput {
  /** When the snapshot being shown was built; null when there is none. */
  snapshotGeneratedAt: string | null;
  ingest: IngestHealthRecord | null;
  loadStatus: FeedLoadStatus;
  now: number;
}

function ingestStatus(ingest: IngestHealthRecord | null, generatedAtMs: number | null, now: number, timing: FeedTimingPolicy): IngestStatus {
  if (!ingest) return "unknown";
  const attemptedAtMs = Date.parse(ingest.attemptedAt);
  // A failure recorded before the snapshot was built was followed by a success
  // whose health write did not land; the snapshot itself proves the refresh worked.
  const failureSuperseded = ingest.outcome === "failure" && generatedAtMs !== null && attemptedAtMs < generatedAtMs;
  const latestActivityMs = failureSuperseded ? generatedAtMs : attemptedAtMs;
  if (now - latestActivityMs > timing.stalledAfterMs) return "stalled";
  if (ingest.outcome === "success" || failureSuperseded) return "healthy";
  return ingest.consecutiveFailures >= timing.failingAfter ? "failing" : "degraded";
}

export function assessFeedHealth(
  { snapshotGeneratedAt, ingest, loadStatus, now }: FeedHealthInput,
  timing: FeedTimingPolicy = FIRMS_FEED_TIMING,
): FeedHealthAssessment {
  const generatedAtMs = snapshotGeneratedAt ? Date.parse(snapshotGeneratedAt) : Number.NaN;
  const hasSnapshot = Number.isFinite(generatedAtMs);
  const snapshotAgeMs = hasSnapshot ? Math.max(0, now - generatedAtMs) : null;
  const freshness: SnapshotFreshness | null = snapshotAgeMs === null
    ? null
    : snapshotAgeMs > timing.staleAfterMs ? "stale" : "fresh";
  const ingestState = ingestStatus(ingest, hasSnapshot ? generatedAtMs : null, now, timing);

  let state: FeedHealthAssessment["state"];
  if (!hasSnapshot) state = loadStatus === "loading" ? "loading" : "unavailable";
  else if (freshness === "stale") state = "stale";
  else if (ingestState === "degraded" || ingestState === "failing" || loadStatus === "error") state = "degraded";
  else state = "healthy";

  return {
    state,
    freshness,
    ingest: ingestState,
    snapshotGeneratedAt: hasSnapshot ? snapshotGeneratedAt : null,
    snapshotAgeMs,
    lastAttemptAt: ingest?.attemptedAt ?? null,
    lastSuccessAt: ingest?.lastSuccessAt ?? null,
    consecutiveFailures: ingest?.consecutiveFailures ?? 0,
    errorCode: ingest?.outcome === "failure" ? ingest.errorCode ?? "unknown" : null,
  };
}
