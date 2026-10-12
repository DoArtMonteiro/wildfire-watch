import assert from "node:assert/strict";
import test from "node:test";
import { reconcile } from "@/lib/fusion/reconcile";
import { nextIngestHealth } from "@/lib/wildfire/ingest-health";
import { composeIncidentsResponseBody } from "./incidents-response";
import type { IncidentsCachePayload } from "./incidents-cache";

const NOW = Date.parse("2026-08-12T15:00:00Z");

function snapshot(): IncidentsCachePayload {
  return {
    version: 1,
    source: "ANEPC Ocorrências em aberto",
    generatedAt: "2026-08-12T14:56:00.000Z",
    incidents: [],
    reconciliation: reconcile([], [], NOW),
    fusedWith: null,
  };
}

test("the body carries the snapshot and the public part of the health record", () => {
  const health = {
    ...nextIngestHealth(null, { attemptedAt: "2026-08-12T14:56:00.000Z", outcome: "success", sourceRows: 12, selectedPoints: 0 }),
    alerts: { failureNotifiedAt: "2026-08-12T10:00:00.000Z" },
    signals: { since: "2026-08-12T07:00:00.000Z", failedAttempts: 2, recoveredBeforeAlert: 1, invalidRecords: 0, truncatedResponses: 0, unrecognisedPhases: [], slowAttempts: 0 },
  };
  const body = composeIncidentsResponseBody(JSON.stringify(snapshot()), JSON.stringify(health));
  assert.ok(body);
  const parsed = JSON.parse(body);
  assert.equal(parsed.generatedAt, "2026-08-12T14:56:00.000Z");
  assert.equal(parsed.ingestHealth.outcome, "success");
  assert.equal("alerts" in parsed.ingestHealth, false);
  assert.equal("signals" in parsed.ingestHealth, false);
});

test("a missing or corrupt health record never blocks the snapshot", () => {
  for (const raw of [null, "not json", JSON.stringify({ outcome: "maybe" })]) {
    const parsed = JSON.parse(composeIncidentsResponseBody(JSON.stringify(snapshot()), raw) ?? "null");
    assert.equal(parsed?.ingestHealth, undefined);
    assert.equal(parsed?.version, 1);
  }
});

test("a stored value that is not a valid snapshot gives no body", () => {
  assert.equal(composeIncidentsResponseBody("previous-snapshot", null), null);
  assert.equal(composeIncidentsResponseBody(JSON.stringify({ ...snapshot(), version: 9 }), null), null);
});
