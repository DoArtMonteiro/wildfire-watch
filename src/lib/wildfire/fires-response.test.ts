import assert from "node:assert/strict";
import test from "node:test";
import { composeFiresResponseBody, readStoredIngestHealth } from "./fires-response";

const snapshot = JSON.stringify({
  version: 1,
  source: "NASA FIRMS VIIRS_NOAA20_NRT",
  generatedAt: "2026-10-02T13:00:40.000Z",
  sourceRows: 3,
  filteredRows: 2,
  points: [{ id: "a", lat: 39.5, lng: -8.1, frpMw: 12, confidencePct: 65, detectedAt: "2026-10-02T12:10:00.000Z" }],
});

test("appends the public ingest health without altering the snapshot", () => {
  const health = readStoredIngestHealth(JSON.stringify({
    version: 2,
    attemptedAt: "2026-10-02T13:05:00.000Z",
    outcome: "failure",
    errorCode: "network",
    consecutiveFailures: 1,
    lastSuccessAt: "2026-10-02T13:00:00.000Z",
    alerts: { failureNotifiedAt: "2026-10-02T13:05:00.000Z" },
  }));
  const body = composeFiresResponseBody(snapshot, health);
  assert.ok(body);
  const parsed = JSON.parse(body);
  assert.deepEqual(parsed.points, JSON.parse(snapshot).points);
  assert.equal(parsed.ingestHealth.outcome, "failure");
  assert.equal(parsed.ingestHealth.consecutiveFailures, 1);
  assert.equal("alerts" in parsed.ingestHealth, false, "alert bookkeeping stays private");
});

test("serves the snapshot unchanged when health is missing or malformed", () => {
  assert.equal(composeFiresResponseBody(snapshot, readStoredIngestHealth(null)), snapshot);
  assert.equal(composeFiresResponseBody(snapshot, readStoredIngestHealth("{not json")), snapshot);
  assert.equal(composeFiresResponseBody(snapshot, readStoredIngestHealth('{"outcome":"success"}')), snapshot);
});

test("refuses values that are not a stored snapshot", () => {
  assert.equal(composeFiresResponseBody("", null), null);
  assert.equal(composeFiresResponseBody('{"error":"x"}', null), null);
  assert.equal(composeFiresResponseBody('{"version":1,"points":[', null), null);
  assert.equal(composeFiresResponseBody(`${snapshot}\n`, null), null);
});
