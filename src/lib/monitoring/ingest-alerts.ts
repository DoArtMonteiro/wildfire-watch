import { INGEST_FAILING_AFTER, INGEST_STALLED_AFTER_MS } from "../wildfire/feed-health";
import type { IngestAlertState, IngestErrorCode, IngestHealthRecord } from "../wildfire/ingest-health";

/**
 * Turns one source's ingest health into at most a handful of operator
 * notifications per outage. The planner is pure: it decides what to send and what to remember,
 * and the caller persists the returned alert state inside the health record,
 * so debouncing costs no extra storage writes.
 *
 * One outage produces, at most:
 *   - "ingest_failing" once, after INGEST_FAILING_AFTER failures in a row;
 *   - "snapshot_stale" once, when the last good data is older than SNAPSHOT_ALERT_AFTER_MS;
 *   - "ingest_stalled" once, when no attempt has been recorded for INGEST_STALLED_AFTER_MS
 *     (for example, runs stopped by a platform limit before they could write);
 *   - "recovered" once, on the first success after any of the above.
 * A single failed run never alerts.
 */

/** The map is still useful with a few hours' delay; past this the operator should act. */
export const SNAPSHOT_ALERT_AFTER_MS = 6 * 60 * 60 * 1_000;

export type IngestAlertEvent = "ingest_failing" | "snapshot_stale" | "ingest_stalled" | "recovered";

/** Which ingest an alert is about. Each source has its own health record and thresholds. */
export type AlertSource = "firms" | "anepc";

export interface AlertPolicy {
  source: AlertSource;
  /** Consecutive failed runs before "ingest_failing". */
  failingAfter: number;
  /** No recorded attempt for this long means the runs are not happening. */
  stalledAfterMs: number;
  /** The newest good data is older than this. */
  snapshotAlertAfterMs: number;
}

/** FIRMS runs hourly. */
export const FIRMS_ALERT_POLICY: AlertPolicy = {
  source: "firms",
  failingAfter: INGEST_FAILING_AFTER,
  stalledAfterMs: INGEST_STALLED_AFTER_MS,
  snapshotAlertAfterMs: SNAPSHOT_ALERT_AFTER_MS,
};

/**
 * ANEPC runs every 15 minutes: an hour of failures alerts, an hour without
 * any attempt is a stall, and operational status older than three hours is
 * no longer worth showing as current.
 */
export const ANEPC_ALERT_POLICY: AlertPolicy = {
  source: "anepc",
  failingAfter: 4,
  stalledAfterMs: 60 * 60 * 1_000,
  snapshotAlertAfterMs: 3 * 60 * 60 * 1_000,
};

/** Everything an alert may contain. Deliberately no free text from upstream responses. */
export interface IngestAlert {
  source: AlertSource;
  event: IngestAlertEvent;
  /** When the condition was detected, ISO 8601 UTC. */
  detectedAt: string;
  outcome: "success" | "failure" | null;
  errorCode: IngestErrorCode | null;
  consecutiveFailures: number;
  /** Age of the newest good data, from the last successful retrieval; null if never recorded. */
  snapshotAgeMs: number | null;
  lastAttemptAt: string | null;
  sourceRows: number | null;
  selectedPoints: number | null;
}

export interface AlertPlan {
  alerts: IngestAlert[];
  /** Alert state to store with the record; undefined clears it. */
  alertState: IngestAlertState | undefined;
}

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

function describe(event: IngestAlertEvent, record: IngestHealthRecord | null, now: number, policy: AlertPolicy): IngestAlert {
  return {
    source: policy.source,
    event,
    detectedAt: new Date(now).toISOString(),
    outcome: record?.outcome ?? null,
    errorCode: record?.outcome === "failure" ? record.errorCode ?? "unknown" : null,
    consecutiveFailures: record?.consecutiveFailures ?? 0,
    snapshotAgeMs: ageMs(record?.lastSuccessAt, now),
    lastAttemptAt: record?.attemptedAt ?? null,
    sourceRows: record?.sourceRows ?? null,
    selectedPoints: record?.selectedPoints ?? null,
  };
}

function hasOpenOutage(alerts: IngestAlertState | undefined): boolean {
  return Boolean(alerts?.failureNotifiedAt || alerts?.staleNotifiedAt || alerts?.stalledNotifiedAt);
}

function compact(state: IngestAlertState): IngestAlertState | undefined {
  return hasOpenOutage(state) ? state : undefined;
}

/**
 * Checked at the start of a run, before any heavy work: if the previous
 * attempt is older than the stall threshold, earlier runs did not get far
 * enough to record anything, and this run might not either.
 */
export function planStallAlert(previous: IngestHealthRecord | null, now: number, policy: AlertPolicy = FIRMS_ALERT_POLICY): AlertPlan {
  const alertState = previous?.alerts;
  if (!previous || alertState?.stalledNotifiedAt) return { alerts: [], alertState };
  const sinceAttempt = ageMs(previous.attemptedAt, now);
  if (sinceAttempt === null || sinceAttempt <= policy.stalledAfterMs) return { alerts: [], alertState };

  const detectedAt = new Date(now).toISOString();
  return {
    alerts: [describe("ingest_stalled", previous, now, policy)],
    alertState: { ...alertState, stalledNotifiedAt: detectedAt },
  };
}

/** Checked after a run has recorded its outcome. */
export function planIngestAlerts(current: IngestHealthRecord, now: number, policy: AlertPolicy = FIRMS_ALERT_POLICY): AlertPlan {
  const previousState = current.alerts ?? {};
  const detectedAt = new Date(now).toISOString();

  if (current.outcome === "success") {
    return hasOpenOutage(previousState)
      ? { alerts: [describe("recovered", current, now, policy)], alertState: undefined }
      : { alerts: [], alertState: undefined };
  }

  const alerts: IngestAlert[] = [];
  const state: IngestAlertState = { ...previousState };

  if (current.consecutiveFailures >= policy.failingAfter && !state.failureNotifiedAt) {
    alerts.push(describe("ingest_failing", current, now, policy));
    state.failureNotifiedAt = detectedAt;
  }

  const snapshotAgeMs = ageMs(current.lastSuccessAt, now);
  if (snapshotAgeMs !== null && snapshotAgeMs > policy.snapshotAlertAfterMs && !state.staleNotifiedAt) {
    alerts.push(describe("snapshot_stale", current, now, policy));
    state.staleNotifiedAt = detectedAt;
  }

  return { alerts, alertState: compact(state) };
}
