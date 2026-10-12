import assert from "node:assert/strict";
import test from "node:test";
import { nextIngestHealth, parseIngestHealth, toPublicIngestHealth, type IngestHealthRecord } from "../wildfire/ingest-health";
import { DIGEST_HOUR_UTC, SLOW_FETCH_MS, accumulateSignals, emptySignals, formatDigestText, isDigestDue, planDigest } from "./daily-digest";

const T0 = Date.parse("2026-08-12T07:00:00.000Z");
const QUARTER = 15 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Folds a sequence of runs the way the scheduled ingest does, including the signal counters. */
function runAll(runs: Array<{ outcome: "success" | "failure"; durationMs?: number; invalidRecords?: number; truncated?: boolean; unrecognisedPhases?: string[] }>) {
  let record: IngestHealthRecord | null = null;
  runs.forEach((run, index) => {
    const now = T0 + index * QUARTER;
    const next = nextIngestHealth(record, run.outcome === "success"
      ? { attemptedAt: iso(now), outcome: "success" }
      : { attemptedAt: iso(now), outcome: "failure", errorCode: "network" });
    record = { ...next, signals: accumulateSignals(record, run, now) };
  });
  return record!;
}

test("signals count what an operator should look at later, without alerting now", () => {
  const record = runAll([
    { outcome: "success", durationMs: 800 },
    { outcome: "failure" },
    { outcome: "success", durationMs: SLOW_FETCH_MS + 1, invalidRecords: 2 },
    { outcome: "failure" },
    { outcome: "failure" },
    { outcome: "success", truncated: true, unrecognisedPhases: ["Chegada ao TO"] },
  ]);
  assert.deepEqual(record.signals, {
    since: iso(T0),
    failedAttempts: 3,
    recoveredBeforeAlert: 2,
    invalidRecords: 2,
    truncatedResponses: 1,
    unrecognisedPhases: ["Chegada ao TO"],
    slowAttempts: 1,
  });
});

test("an outage that already raised an alert is not counted again as a quiet recovery", () => {
  let record = runAll([{ outcome: "success" }, { outcome: "failure" }]);
  record = { ...record, alerts: { failureNotifiedAt: iso(T0 + QUARTER) } };
  assert.equal(accumulateSignals(record, { outcome: "success" }, T0 + 2 * QUARTER).recoveredBeforeAlert, 0);
});

test("signals survive storage and never reach the public health record", () => {
  const record = runAll([{ outcome: "failure" }, { outcome: "success", invalidRecords: 1 }]);
  const stored = parseIngestHealth(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(stored?.signals, record.signals);
  assert.equal("signals" in toPublicIngestHealth(stored!), false);
  assert.equal(parseIngestHealth({ ...record, signals: { since: "yesterday" } }), null, "a malformed record is rejected");
});

test("the digest is due once a day, at the first run from 07:00 UTC", () => {
  const today = Date.parse("2026-08-12T00:00:00.000Z");
  assert.equal(DIGEST_HOUR_UTC, 7);
  assert.equal(isDigestDue(null, today + 6 * 3_600_000), false);
  assert.equal(isDigestDue(null, today + 7 * 3_600_000), true);
  assert.equal(isDigestDue(iso(today + 7 * 3_600_000), today + 8 * 3_600_000), false, "already planned today");
  assert.equal(isDigestDue(iso(today - 17 * 3_600_000), today + 9 * 3_600_000), true, "a missed 07:00 run is caught up later the same day");
});

test("a quiet day sends nothing", () => {
  const quiet = runAll([{ outcome: "success" }, { outcome: "failure" }, { outcome: "success" }]);
  assert.equal(planDigest([{ source: "anepc", signals: quiet.signals }, { source: "firms", signals: undefined }]), null);
});

test("a day with recurring or data-quality signals sends one compact summary", () => {
  const anepc = runAll([
    { outcome: "failure" }, { outcome: "success" },
    { outcome: "failure" }, { outcome: "success", invalidRecords: 3, unrecognisedPhases: ["Chegada ao TO"] },
  ]);
  const firms = { ...emptySignals(iso(T0)), slowAttempts: 4 };
  const digest = planDigest([{ source: "firms", signals: firms }, { source: "anepc", signals: anepc.signals }]);
  assert.ok(digest);
  const text = formatDigestText(digest, T0 + 24 * 3_600_000);
  assert.match(text, /^WildfireWatch · Daily operations summary/);
  assert.match(text, /ANEPC: 2 failed attempts, 2 recovered before an alert/);
  assert.match(text, /ANEPC: up to 3 records per run dropped as unreadable/);
  assert.match(text, /ANEPC: unrecognised phase labels: Chegada ao TO/);
  assert.match(text, /FIRMS: 4 slow upstream responses/);
  assert.doesNotMatch(text, /https?:|token/i);
});

test("one unreadable record read on every run counts once, and stored labels are plain words", () => {
  const record = runAll([
    { outcome: "success", invalidRecords: 1 },
    { outcome: "success", invalidRecords: 1, unrecognisedPhases: ["Chegada <b>ao</b> TO"] },
    { outcome: "success", invalidRecords: 1 },
  ]);
  assert.equal(record.signals?.invalidRecords, 1);
  assert.deepEqual(record.signals?.unrecognisedPhases, ["Chegada bao/b TO"]);
});
