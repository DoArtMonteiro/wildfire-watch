/**
 * Health of the scheduled FIRMS ingest, persisted in KV next to (never inside)
 * the snapshot so a failing refresh can never overwrite good data.
 *
 * The record answers "is the pipeline currently refreshing?", which is a
 * different question from "how old is the snapshot?". The browser needs both:
 * a snapshot written ten minutes ago is not reassuring if the refresh that
 * followed it failed.
 */

export const INGEST_ERROR_CODES = [
  "network",
  "http_error",
  "incomplete_feed",
  "parse_error",
  /** The KV write of the snapshot failed, e.g. the daily write limit was reached. */
  "storage_error",
  /** FIRMS_MAP_KEY is missing. */
  "configuration",
  "unknown",
] as const;
export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

export interface IngestCounts {
  sourceRows?: number;
  filteredRows?: number;
  selectedPoints?: number;
  suppressedRows?: number;
}

/** Debounce state for operator alerts, so one outage produces one notification. */
export interface IngestAlertState {
  /** When the "refresh keeps failing" alert was sent for the current outage. */
  failureNotifiedAt?: string;
  /** When the "snapshot is stale" alert was sent for the current outage. */
  staleNotifiedAt?: string;
  /** When the "no attempt recorded" alert was sent for the current outage. */
  stalledNotifiedAt?: string;
}

/**
 * Non-urgent counters for the daily operations summary, kept in the health
 * record (which every run already writes) since the last summary.
 */
export interface IngestSignals {
  /** Start of the window these counters cover. */
  since: string;
  failedAttempts: number;
  /** Outages that ended before the failure alert threshold. */
  recoveredBeforeAlert: number;
  /** The most records dropped as unreadable in a single run (not a sum: one bad record is read on every run). */
  invalidRecords: number;
  /** Responses that said more records existed than were returned. */
  truncatedResponses: number;
  /** Source labels the parser did not recognise, a sign the source changed. */
  unrecognisedPhases: string[];
  /** Upstream responses slower than the slow-fetch threshold. */
  slowAttempts: number;
}

export interface IngestHealthRecord extends IngestCounts {
  version: 2;
  /** Start of the latest ingest attempt. */
  attemptedAt: string;
  outcome: "success" | "failure";
  /** Short classified code; never a raw upstream message, which could contain the map key. */
  errorCode?: IngestErrorCode;
  /** Failed attempts since the last success; 0 after a success. */
  consecutiveFailures: number;
  /** Start of the latest successful attempt, i.e. when the shown data was retrieved. */
  lastSuccessAt: string | null;
  alerts?: IngestAlertState;
  signals?: IngestSignals;
}

/** What the API routes expose: the record without internal alert and summary bookkeeping. */
export type PublicIngestHealth = Omit<IngestHealthRecord, "alerts" | "signals">;

export interface IngestAttempt extends IngestCounts {
  attemptedAt: string;
  outcome: "success" | "failure";
  errorCode?: IngestErrorCode;
}

const COUNT_KEYS = ["sourceRows", "filteredRows", "selectedPoints", "suppressedRows"] as const;

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readCounts(source: Record<string, unknown>): IngestCounts | null {
  const counts: IngestCounts = {};
  for (const key of COUNT_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (!isCount(value)) return null;
    counts[key] = value;
  }
  return counts;
}

function readErrorCode(value: unknown): IngestErrorCode | undefined | null {
  if (value === undefined) return undefined;
  return (INGEST_ERROR_CODES as readonly unknown[]).includes(value) ? value as IngestErrorCode : null;
}

function readAlerts(value: unknown): IngestAlertState | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const alerts: IngestAlertState = {};
  for (const key of ["failureNotifiedAt", "staleNotifiedAt", "stalledNotifiedAt"] as const) {
    if (source[key] === undefined) continue;
    if (!isTimestamp(source[key])) return null;
    alerts[key] = source[key];
  }
  return alerts;
}

const SIGNAL_COUNT_KEYS = ["failedAttempts", "recoveredBeforeAlert", "invalidRecords", "truncatedResponses", "slowAttempts"] as const;

function readSignals(value: unknown): IngestSignals | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!isTimestamp(source.since)) return null;
  if (!SIGNAL_COUNT_KEYS.every((key) => isCount(source[key]))) return null;
  const phases = source.unrecognisedPhases;
  if (!Array.isArray(phases) || phases.length > 10 || !phases.every((phase) => typeof phase === "string" && phase.length <= 80)) return null;
  return {
    since: source.since,
    failedAttempts: source.failedAttempts as number,
    recoveredBeforeAlert: source.recoveredBeforeAlert as number,
    invalidRecords: source.invalidRecords as number,
    truncatedResponses: source.truncatedResponses as number,
    unrecognisedPhases: [...phases] as string[],
    slowAttempts: source.slowAttempts as number,
  };
}

/**
 * Parses a stored or transmitted health record. Accepts the current format and
 * the earlier one (no version, no failure counter), and returns null for
 * anything malformed so a corrupt record degrades to "health unknown" instead
 * of breaking the feed.
 */
export function parseIngestHealth(raw: unknown): IngestHealthRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (!isTimestamp(source.attemptedAt)) return null;
  if (source.outcome !== "success" && source.outcome !== "failure") return null;

  const errorCode = readErrorCode(source.errorCode);
  const counts = readCounts(source);
  const alerts = readAlerts(source.alerts);
  const signals = readSignals(source.signals);
  if (errorCode === null || counts === null || alerts === null || signals === null) return null;

  const outcome = source.outcome;
  let consecutiveFailures: number;
  let lastSuccessAt: string | null;

  if (source.version === 2) {
    if (!isCount(source.consecutiveFailures)) return null;
    if (source.lastSuccessAt !== null && !isTimestamp(source.lastSuccessAt)) return null;
    if (outcome === "success" && source.consecutiveFailures !== 0) return null;
    consecutiveFailures = source.consecutiveFailures;
    lastSuccessAt = source.lastSuccessAt as string | null;
  } else if (source.version === undefined) {
    // Records written before the failure counter existed describe one attempt.
    consecutiveFailures = outcome === "failure" ? 1 : 0;
    lastSuccessAt = outcome === "success" ? source.attemptedAt : null;
  } else {
    return null;
  }

  return {
    version: 2,
    attemptedAt: source.attemptedAt,
    outcome,
    ...(errorCode ? { errorCode } : {}),
    consecutiveFailures,
    lastSuccessAt,
    ...counts,
    ...(alerts ? { alerts } : {}),
    ...(signals ? { signals } : {}),
  };
}

/** Folds one attempt into the running record. Alert state and signals are carried over; their planners own them. */
export function nextIngestHealth(previous: IngestHealthRecord | null, attempt: IngestAttempt): IngestHealthRecord {
  const { attemptedAt, outcome, errorCode, ...counts } = attempt;
  const succeeded = outcome === "success";
  return {
    version: 2,
    attemptedAt,
    outcome,
    ...(succeeded || !errorCode ? {} : { errorCode }),
    consecutiveFailures: succeeded ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
    lastSuccessAt: succeeded ? attemptedAt : previous?.lastSuccessAt ?? null,
    ...counts,
    ...(previous?.alerts ? { alerts: previous.alerts } : {}),
    ...(previous?.signals ? { signals: previous.signals } : {}),
  };
}

export function toPublicIngestHealth(record: IngestHealthRecord): PublicIngestHealth {
  const { alerts: _alerts, signals: _signals, ...publicRecord } = record;
  void _alerts;
  void _signals;
  return publicRecord;
}
