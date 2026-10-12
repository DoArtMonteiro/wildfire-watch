import assert from "node:assert/strict";
import test from "node:test";
import { INGEST_FAILING_AFTER, SNAPSHOT_STALE_AFTER_MS, assessFeedHealth } from "./feed-health";
import { nextIngestHealth, parseIngestHealth, toPublicIngestHealth, type IngestHealthRecord } from "./ingest-health";

const T = (iso: string) => Date.parse(iso);
const success = (attemptedAt: string, previous: IngestHealthRecord | null = null) =>
  nextIngestHealth(previous, { attemptedAt, outcome: "success", sourceRows: 220_000, filteredRows: 200_000, selectedPoints: 15_000 });
const failure = (attemptedAt: string, previous: IngestHealthRecord | null) =>
  nextIngestHealth(previous, { attemptedAt, outcome: "failure", errorCode: "http_error" });

test("healthy refresh and fresh snapshot read as healthy", () => {
  const ingest = success("2026-10-02T13:00:00.000Z");
  const result = assessFeedHealth({
    snapshotGeneratedAt: "2026-10-02T13:00:40.000Z",
    ingest,
    loadStatus: "ready",
    now: T("2026-10-02T13:10:00.000Z"),
  });
  assert.equal(result.state, "healthy");
  assert.equal(result.freshness, "fresh");
  assert.equal(result.ingest, "healthy");
  assert.equal(result.errorCode, null);
});

test("a healthy pipeline with an old snapshot still reads as stale", () => {
  const result = assessFeedHealth({
    snapshotGeneratedAt: "2026-10-02T10:00:40.000Z",
    ingest: success("2026-10-02T13:00:00.000Z"),
    loadStatus: "ready",
    now: T("2026-10-02T13:10:00.000Z"),
  });
  assert.equal(result.state, "stale");
  assert.equal(result.ingest, "healthy");
});

test("an ingest that stopped recording attempts reads as stalled", () => {
  // Last recorded run succeeded at 09:00; nothing since, e.g. runs killed mid-way.
  const result = assessFeedHealth({
    snapshotGeneratedAt: "2026-10-02T09:00:40.000Z",
    ingest: success("2026-10-02T09:00:00.000Z"),
    loadStatus: "ready",
    now: T("2026-10-02T13:10:00.000Z"),
  });
  assert.equal(result.state, "stale");
  assert.equal(result.ingest, "stalled");
});

test("a failed refresh after a recent success reads as degraded, not current", () => {
  // 13:00 success, 13:05 failure, visitor arrives 13:10.
  const ingest = failure("2026-10-02T13:05:00.000Z", success("2026-10-02T13:00:00.000Z"));
  const result = assessFeedHealth({
    snapshotGeneratedAt: "2026-10-02T13:00:40.000Z",
    ingest,
    loadStatus: "ready",
    now: T("2026-10-02T13:10:00.000Z"),
  });
  assert.equal(result.state, "degraded");
  assert.equal(result.freshness, "fresh");
  assert.equal(result.ingest, "degraded");
  assert.equal(result.lastSuccessAt, "2026-10-02T13:00:00.000Z");
  assert.equal(result.errorCode, "http_error");
});

test("repeated failures over an old last-known-good snapshot read as stale and failing", () => {
  let ingest: IngestHealthRecord = success("2026-10-02T09:00:00.000Z");
  for (const hour of ["10", "11", "12", "13"]) ingest = failure(`2026-10-02T${hour}:00:00.000Z`, ingest);
  const result = assessFeedHealth({
    snapshotGeneratedAt: "2026-10-02T09:00:40.000Z",
    ingest,
    loadStatus: "ready",
    now: T("2026-10-02T13:10:00.000Z"),
  });
  assert.equal(result.state, "stale");
  assert.equal(result.ingest, "failing");
  assert.equal(result.consecutiveFailures, 4);
  assert.ok(result.consecutiveFailures >= INGEST_FAILING_AFTER);
});

test("missing health falls back to snapshot age alone", () => {
  const base = { snapshotGeneratedAt: "2026-10-02T13:00:00.000Z", ingest: null, loadStatus: "ready" as const };
  assert.equal(assessFeedHealth({ ...base, now: T("2026-10-02T13:30:00.000Z") }).state, "healthy");
  assert.equal(assessFeedHealth({ ...base, now: T("2026-10-02T13:30:00.000Z") }).ingest, "unknown");
  assert.equal(
    assessFeedHealth({ ...base, now: T("2026-10-02T13:00:00.000Z") + SNAPSHOT_STALE_AFTER_MS + 1 }).state,
    "stale",
  );
});

test("malformed health records are rejected and treated as unknown", () => {
  for (const raw of [
    null,
    "failure",
    { outcome: "failure" },
    { attemptedAt: "yesterday", outcome: "failure" },
    { attemptedAt: "2026-10-02T13:00:00.000Z", outcome: "maybe" },
    { attemptedAt: "2026-10-02T13:00:00.000Z", outcome: "failure", errorCode: "https://firms…/MAPKEY" },
    { version: 2, attemptedAt: "2026-10-02T13:00:00.000Z", outcome: "failure", consecutiveFailures: -1, lastSuccessAt: null },
    { version: 2, attemptedAt: "2026-10-02T13:00:00.000Z", outcome: "success", consecutiveFailures: 2, lastSuccessAt: null },
    { version: 3, attemptedAt: "2026-10-02T13:00:00.000Z", outcome: "success" },
    { attemptedAt: "2026-10-02T13:00:00.000Z", outcome: "success", sourceRows: "many" },
  ]) {
    assert.equal(parseIngestHealth(raw), null, JSON.stringify(raw));
  }
});

test("records written before the failure counter existed still parse", () => {
  assert.deepEqual(parseIngestHealth({ attemptedAt: "2026-10-02T13:05:00.000Z", outcome: "failure", errorCode: "network" }), {
    version: 2,
    attemptedAt: "2026-10-02T13:05:00.000Z",
    outcome: "failure",
    errorCode: "network",
    consecutiveFailures: 1,
    lastSuccessAt: null,
  });
  assert.equal(parseIngestHealth({ attemptedAt: "2026-10-02T13:00:00.000Z", outcome: "success", selectedPoints: 15_000 })?.lastSuccessAt,
    "2026-10-02T13:00:00.000Z");
});

test("recovery after failure resets the counter and reads as healthy", () => {
  let ingest: IngestHealthRecord = success("2026-10-02T09:00:00.000Z");
  ingest = failure("2026-10-02T10:00:00.000Z", ingest);
  ingest = failure("2026-10-02T11:00:00.000Z", ingest);
  ingest = success("2026-10-02T12:00:00.000Z", ingest);
  assert.equal(ingest.consecutiveFailures, 0);
  assert.equal(ingest.errorCode, undefined);
  const result = assessFeedHealth({
    snapshotGeneratedAt: "2026-10-02T12:00:40.000Z",
    ingest,
    loadStatus: "ready",
    now: T("2026-10-02T12:05:00.000Z"),
  });
  assert.equal(result.state, "healthy");
});

test("a failure recorded before the snapshot was built does not mark it degraded", () => {
  // The success that built the snapshot could not write its health record.
  const ingest = failure("2026-10-02T12:00:00.000Z", null);
  const result = assessFeedHealth({
    snapshotGeneratedAt: "2026-10-02T13:00:40.000Z",
    ingest,
    loadStatus: "ready",
    now: T("2026-10-02T13:05:00.000Z"),
  });
  assert.equal(result.state, "healthy");
});

test("no snapshot is loading while pending and unavailable after an error", () => {
  const base = { snapshotGeneratedAt: null, ingest: null, now: T("2026-10-02T13:00:00.000Z") };
  assert.equal(assessFeedHealth({ ...base, loadStatus: "loading" }).state, "loading");
  assert.equal(assessFeedHealth({ ...base, loadStatus: "error" }).state, "unavailable");
});

test("the public record never exposes alert bookkeeping", () => {
  const record = { ...failure("2026-10-02T13:05:00.000Z", null), alerts: { failureNotifiedAt: "2026-10-02T13:05:00.000Z" } };
  assert.equal("alerts" in toPublicIngestHealth(record), false);
  assert.equal(parseIngestHealth(record)?.alerts?.failureNotifiedAt, "2026-10-02T13:05:00.000Z");
});

test("operational data has its own, shorter timing", async () => {
  const { OPERATIONAL_FEED_TIMING } = await import("./feed-health");
  const generated = "2026-08-12T14:00:20.000Z";
  const ingest = success("2026-08-12T14:00:00.000Z");
  const at = (time: string) => assessFeedHealth({ snapshotGeneratedAt: generated, ingest, loadStatus: "ready", now: T(time) }, OPERATIONAL_FEED_TIMING);
  assert.equal(at("2026-08-12T14:40:00.000Z").state, "healthy");
  // Three missed 15-minute runs: the phase shown may no longer be true.
  assert.equal(at("2026-08-12T14:50:00.000Z").state, "stale");
  assert.equal(at("2026-08-12T15:10:00.000Z").ingest, "stalled");
  // The same age is still fresh for the hourly FIRMS snapshot.
  assert.equal(assessFeedHealth({ snapshotGeneratedAt: generated, ingest, loadStatus: "ready", now: T("2026-08-12T14:50:00.000Z") }).state, "healthy");

  let failing: IngestHealthRecord | null = success("2026-08-12T14:00:00.000Z");
  for (const minute of ["15", "30", "45"]) failing = failure(`2026-08-12T14:${minute}:00.000Z`, failing);
  const threeFailures = assessFeedHealth({ snapshotGeneratedAt: generated, ingest: failing, loadStatus: "ready", now: T("2026-08-12T14:46:00.000Z") }, OPERATIONAL_FEED_TIMING);
  assert.equal(threeFailures.ingest, "degraded", "four failures in a row before 'failing'");
});
