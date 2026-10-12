import type { IngestHealthRecord, IngestSignals } from "../wildfire/ingest-health";
import type { AlertSource } from "./ingest-alerts";

/**
 * Non-urgent operational signals, sent at most once a day as one compact
 * message, and only when something is worth a look: recurring instability
 * that never reached the alert threshold, slow upstream responses, or data
 * the parser had to drop or did not recognise. A quiet day sends nothing.
 * Urgent problems (failing, stalled, stale, recovered) are alerted at once by
 * the ingest alert planner; they are not repeated here.
 */

/** 07:00 UTC is 08:00 in Lisbon during summer time and 07:00 in winter. */
export const DIGEST_HOUR_UTC = 7;
/** An upstream response slower than this counts as slow. */
export const SLOW_FETCH_MS = 20_000;

const MIN_RECOVERIES_TO_REPORT = 2;
const MIN_SLOW_ATTEMPTS_TO_REPORT = 3;
const MAX_PHASES = 10;
const SOURCE_NAMES: Record<AlertSource, string> = { firms: "FIRMS", anepc: "ANEPC" };

/** What one run contributes to the counters. */
export interface RunObservation {
  outcome: "success" | "failure";
  durationMs?: number;
  invalidRecords?: number;
  truncated?: boolean;
  unrecognisedPhases?: string[];
}

export interface DigestPlan {
  since: string;
  lines: string[];
}

export function emptySignals(since: string): IngestSignals {
  return { since, failedAttempts: 0, recoveredBeforeAlert: 0, invalidRecords: 0, truncatedResponses: 0, unrecognisedPhases: [], slowAttempts: 0 };
}

/** Adds one run to the counters carried in the previous health record. */
export function accumulateSignals(previous: IngestHealthRecord | null, run: RunObservation, now: number): IngestSignals {
  const base = previous?.signals ?? emptySignals(new Date(now).toISOString());
  const quietRecovery = run.outcome === "success"
    && (previous?.consecutiveFailures ?? 0) > 0
    && !previous?.alerts?.failureNotifiedAt;
  // Labels come from a public feed: they are reduced to plain words before they are stored.
  const phases = [...new Set([...base.unrecognisedPhases, ...(run.unrecognisedPhases ?? []).map(safeLabel)])]
    .filter(Boolean).sort().slice(0, MAX_PHASES);
  return {
    since: base.since,
    failedAttempts: base.failedAttempts + (run.outcome === "failure" ? 1 : 0),
    recoveredBeforeAlert: base.recoveredBeforeAlert + (quietRecovery ? 1 : 0),
    invalidRecords: Math.max(base.invalidRecords, run.invalidRecords ?? 0),
    truncatedResponses: base.truncatedResponses + (run.truncated ? 1 : 0),
    unrecognisedPhases: phases,
    slowAttempts: base.slowAttempts + ((run.durationMs ?? 0) > SLOW_FETCH_MS ? 1 : 0),
  };
}

/** True at the first run from DIGEST_HOUR_UTC each day, including a late catch-up run. */
export function isDigestDue(lastPlannedAt: string | null, now: number): boolean {
  const date = new Date(now);
  if (date.getUTCHours() < DIGEST_HOUR_UTC) return false;
  const todayAtHour = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), DIGEST_HOUR_UTC);
  return lastPlannedAt === null || !(Date.parse(lastPlannedAt) >= todayAtHour);
}

/** Labels come from a public feed; keep plain words only, short, so nothing else can ride along. */
function safeLabel(label: string): string {
  return label.replace(/[^\p{L}\p{N} .,ºª/-]/gu, "").slice(0, 40);
}

function linesFor(source: AlertSource, signals: IngestSignals): string[] {
  const name = SOURCE_NAMES[source];
  const lines: string[] = [];
  if (signals.recoveredBeforeAlert >= MIN_RECOVERIES_TO_REPORT) {
    lines.push(`${name}: ${signals.failedAttempts} failed attempts, ${signals.recoveredBeforeAlert} recovered before an alert`);
  }
  if (signals.slowAttempts >= MIN_SLOW_ATTEMPTS_TO_REPORT) {
    lines.push(`${name}: ${signals.slowAttempts} slow upstream responses (over ${SLOW_FETCH_MS / 1_000} s)`);
  }
  if (signals.invalidRecords > 0) lines.push(`${name}: up to ${signals.invalidRecords} records per run dropped as unreadable`);
  if (signals.truncatedResponses > 0) lines.push(`${name}: ${signals.truncatedResponses} truncated responses (records may be missing)`);
  if (signals.unrecognisedPhases.length > 0) {
    lines.push(`${name}: unrecognised phase labels: ${signals.unrecognisedPhases.map(safeLabel).join(", ")}`);
  }
  return lines;
}

/** Null when nothing is worth a message. */
export function planDigest(sources: Array<{ source: AlertSource; signals: IngestSignals | undefined }>): DigestPlan | null {
  const present = sources.filter((entry): entry is { source: AlertSource; signals: IngestSignals } => Boolean(entry.signals));
  const lines = present.flatMap((entry) => linesFor(entry.source, entry.signals));
  if (lines.length === 0) return null;
  const since = present.map((entry) => entry.signals.since).sort()[0];
  return { since, lines };
}

export function formatDigestText(plan: DigestPlan, now: number): string {
  const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return [
    "WildfireWatch · Daily operations summary",
    `Window: ${utc(Date.parse(plan.since))} to ${utc(now)}`,
    ...plan.lines,
  ].join("\n");
}
