import assert from "node:assert/strict";
import test from "node:test";
import type { CachedFirmsPoint } from "@/lib/wildfire/firms-cache";
import { FIRMS_CACHE_KEY, FIRMS_INGEST_HEALTH_KEY } from "@/lib/wildfire/firms-cache";
import { reconcile } from "@/lib/fusion/reconcile";
import type { OperationalIncident } from "@/lib/wildfire/types";
import {
  FUSION_INDEX_KEY,
  INCIDENTS_CACHE_KEY,
  INCIDENTS_INGEST_HEALTH_KEY,
  buildFusionIndex,
  parseIncidentsPayload,
  readFusionIndex,
  type IncidentsCachePayload,
} from "./incidents-cache";

const NOW = Date.parse("2026-08-12T15:00:00Z");

const INCIDENT: OperationalIncident = {
  kind: "operational_incident",
  id: "anepc:1",
  datasetId: "anepc:ocorrencias-em-aberto",
  sourceId: "1",
  location: { lat: 40.22, lng: -8.05 },
  phase: "in_progress",
  phaseLabel: "Em Curso",
  natureCode: "3101",
  natureLabel: "Povoamento Florestal",
  startedAt: "2026-08-12T11:00:00.000Z",
  updatedAt: "2026-08-12T14:50:00.000Z",
  municipality: "Arganil",
  parish: null,
  resources: { personnel: 84, groundVehicles: 25, aircraft: 2 },
};

function point(id: string, lat: number, lng: number): CachedFirmsPoint {
  return { id, lat, lng, frpMw: 50, confidencePct: 90, detectedAt: "2026-08-12T13:00:00.000Z" };
}

function payload(): IncidentsCachePayload {
  const observations = [{ id: "d1", location: { lat: 40.225, lng: -8.05 }, acquiredAt: "2026-08-12T13:00:00.000Z", frpMw: 50 }];
  return {
    version: 1,
    source: "ANEPC Ocorrências em aberto",
    generatedAt: "2026-08-12T15:00:05.000Z",
    incidents: [INCIDENT],
    reconciliation: reconcile([INCIDENT], observations, NOW),
    fusedWith: { firmsGeneratedAt: "2026-08-12T14:00:30.000Z", detections: 1 },
  };
}

test("each source keeps its own keys, so one failing can never overwrite another", () => {
  const keys = [FIRMS_CACHE_KEY, FIRMS_INGEST_HEALTH_KEY, INCIDENTS_CACHE_KEY, INCIDENTS_INGEST_HEALTH_KEY, FUSION_INDEX_KEY];
  assert.equal(new Set(keys).size, keys.length);
});

test("a stored incidents snapshot round-trips", () => {
  const stored = JSON.parse(JSON.stringify(payload()));
  assert.deepEqual(parseIncidentsPayload(stored), payload());
});

test("malformed snapshots are refused, and one malformed incident does not hide the others", () => {
  assert.equal(parseIncidentsPayload(null), null);
  assert.equal(parseIncidentsPayload({ ...payload(), version: 2 }), null);
  assert.equal(parseIncidentsPayload({ ...payload(), incidents: "x" }), null);
  assert.equal(parseIncidentsPayload({ ...payload(), reconciliation: { incidents: [] } }), null);

  const withBroken = { ...payload(), incidents: [INCIDENT, { ...INCIDENT, id: "anepc:2", location: { lat: "x", lng: 0 } }] };
  assert.deepEqual(parseIncidentsPayload(withBroken)?.incidents, [INCIDENT]);
  const unknownPhase = { ...payload(), incidents: [{ ...INCIDENT, phase: "burning" }] };
  assert.deepEqual(parseIncidentsPayload(unknownPhase)?.incidents, []);
});

test("the fusion index keeps only detections inside the operational source's coverage, compactly", () => {
  const index = buildFusionIndex([
    point("arganil", 40.21, -8.05),
    point("madrid", 40.4, -3.7),
    point("algarve", 37.1, -8.2),
  ], "2026-08-12T14:00:30.000Z");
  assert.deepEqual(index, {
    version: 1,
    firmsGeneratedAt: "2026-08-12T14:00:30.000Z",
    points: [
      ["arganil", 40.21, -8.05, "2026-08-12T13:00:00.000Z", 50],
      ["algarve", 37.1, -8.2, "2026-08-12T13:00:00.000Z", 50],
    ],
  });

  const read = readFusionIndex(JSON.parse(JSON.stringify(index)));
  assert.deepEqual(read, {
    firmsGeneratedAt: "2026-08-12T14:00:30.000Z",
    observations: [
      { id: "arganil", location: { lat: 40.21, lng: -8.05 }, acquiredAt: "2026-08-12T13:00:00.000Z", frpMw: 50 },
      { id: "algarve", location: { lat: 37.1, lng: -8.2 }, acquiredAt: "2026-08-12T13:00:00.000Z", frpMw: 50 },
    ],
  });
  assert.equal(readFusionIndex({ version: 1, points: [] }), null);
  assert.deepEqual(readFusionIndex({ ...index, points: [["bad", "x", 0, "", 1], ...index.points] })?.observations.length, 2);
  // A time that is not an ISO UTC timestamp is dropped as well.
  assert.deepEqual(readFusionIndex({ ...index, points: [["bad-time", 40, -8, "12/08/2026 13:00", 1], ...index.points] })?.observations.length, 2);
});
