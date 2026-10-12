import assert from "node:assert/strict";
import test from "node:test";
import { reconcile } from "@/lib/fusion/reconcile";
import type { OperationalIncident } from "@/lib/wildfire/types";
import {
  incidentViews,
  isInOperationalCoverage,
  operationalStateForSelection,
  type OperationalFeedSnapshot,
} from "./operational-view";

const NOW = Date.parse("2026-08-12T15:00:00Z");
const HOUR = 3_600_000;

function incident(id: string, lat: number, lng: number, phase: OperationalIncident["phase"] = "in_progress", startedAgoHours = 4): OperationalIncident {
  return {
    kind: "operational_incident", id: `anepc:${id}`, datasetId: "anepc:ocorrencias-em-aberto", sourceId: id,
    location: { lat, lng }, phase, phaseLabel: "Em Curso", natureCode: "3101", natureLabel: null,
    startedAt: new Date(NOW - startedAgoHours * HOUR).toISOString(), updatedAt: null, municipality: null, parish: null,
    resources: { personnel: null, groundVehicles: null, aircraft: null },
  };
}

const INCIDENTS = [
  incident("arganil", 40.223, -8.0541),
  incident("monchique-n", 37.3262, -8.5554, "resolving"),
  incident("monchique-s", 37.3037, -8.5554),
  incident("braganca", 41.806, -6.757, "dispatch", 0.5),
  incident("far", 39.0, -8.2, "concluding"),
];

const OBSERVATIONS = [
  { id: "arganil", location: { lat: 40.2183, lng: -8.0541 }, acquiredAt: new Date(NOW - HOUR).toISOString(), frpMw: 912.4 },
  { id: "flank", location: { lat: 40.2, lng: -8.0541 }, acquiredAt: new Date(NOW - 2 * HOUR).toISOString(), frpMw: 210.5 },
  { id: "monchique", location: { lat: 37.3172, lng: -8.5554 }, acquiredAt: new Date(NOW - HOUR).toISOString(), frpMw: 640.2 },
  { id: "viseu", location: { lat: 40.6566, lng: -7.9125 }, acquiredAt: new Date(NOW - HOUR).toISOString(), frpMw: 188.3 },
];

function feed(overrides: Partial<OperationalFeedSnapshot> = {}): OperationalFeedSnapshot {
  return {
    version: 1,
    source: "ANEPC Ocorrências em aberto",
    generatedAt: new Date(NOW - 4 * 60_000).toISOString(),
    incidents: INCIDENTS,
    reconciliation: reconcile(INCIDENTS, OBSERVATIONS, NOW),
    fusedWith: { firmsGeneratedAt: new Date(NOW - 10 * 60_000).toISOString(), detections: OBSERVATIONS.length },
    ingest: null,
    ...overrides,
  };
}

function selection(ids: string[], lat: number, lng: number, country: string | null = "Portugal", acquiredAgoHours = 1) {
  return { detectionIds: ids, location: { lat, lng }, country, lastAcquiredAt: new Date(NOW - acquiredAgoHours * HOUR).toISOString() };
}

test("only detections in mainland Portugal are covered by the operational source", () => {
  assert.equal(isInOperationalCoverage({ lat: 40.2, lng: -8.05 }, "Portugal"), true);
  assert.equal(isInOperationalCoverage({ lat: 32.74, lng: -17.0 }, "Portugal"), false, "Madeira");
  assert.equal(isInOperationalCoverage({ lat: 41.0, lng: -6.5 }, "Spain"), false, "inside the box but in Spain");
  assert.equal(isInOperationalCoverage({ lat: 40.2, lng: -8.05 }, null), false);
  assert.deepEqual(operationalStateForSelection(selection(["madeira"], 32.74, -17.0), feed()), { kind: "not_covered" });
});

test("a linked detection shows its incident, and a far one notes the distance", () => {
  const state = operationalStateForSelection(selection(["arganil"], 40.2183, -8.0541), feed());
  assert.equal(state.kind, "matched");
  assert.deepEqual(state.kind === "matched" && state.incidents.map((entry) => entry.id), ["anepc:arganil"]);
  assert.equal(state.kind === "matched" && state.locationNoteKm, null);

  const flank = operationalStateForSelection(selection(["flank"], 40.2, -8.0541, "Portugal", 2), feed());
  assert.equal(flank.kind === "matched" && flank.locationNoteKm, 2.6);
});

test("a detection between two incidents names both and picks neither", () => {
  const state = operationalStateForSelection(selection(["monchique"], 37.3172, -8.5554), feed());
  assert.equal(state.kind, "ambiguous");
  assert.deepEqual(state.kind === "ambiguous" && state.incidents.map((entry) => entry.id), ["anepc:monchique-n", "anepc:monchique-s"]);
});

test("a covered detection with no incident nearby says so, with the radius used", () => {
  assert.deepEqual(operationalStateForSelection(selection(["viseu"], 40.6566, -7.9125), feed()), { kind: "none_nearby", radiusKm: 5, windowHours: 6 });
});

test("a detection newer than the reconciled snapshot is not yet compared, rather than unmatched", () => {
  const older = feed({ fusedWith: { firmsGeneratedAt: new Date(NOW - 3 * HOUR).toISOString(), detections: 4 } });
  assert.deepEqual(operationalStateForSelection(selection(["new"], 40.6, -7.9, "Portugal", 1), older), { kind: "not_reconciled" });
  assert.deepEqual(operationalStateForSelection(selection(["new"], 40.6, -7.9), feed({ fusedWith: null })), { kind: "not_reconciled" });
});

test("a detection from a newer FIRMS snapshot than the one reconciled is not yet compared, however old it is", () => {
  // NASA publishes late: a detection acquired three hours ago can first appear
  // in a snapshot built after the last reconciliation.
  const reconciledAt = new Date(NOW - 10 * 60_000).toISOString();
  const newerSnapshot = new Date(NOW - 5 * 60_000).toISOString();
  const old = selection(["late"], 40.6, -7.9, "Portugal", 3);
  assert.deepEqual(operationalStateForSelection(old, feed(), newerSnapshot), { kind: "not_reconciled" });
  assert.deepEqual(operationalStateForSelection(old, feed(), reconciledAt), { kind: "none_nearby", radiusKm: 5, windowHours: 6 });
  // An older snapshot than the reconciled one was compared as part of it.
  assert.equal(operationalStateForSelection(old, feed(), new Date(NOW - 70 * 60_000).toISOString()).kind, "none_nearby");
  // Links found by the reconciliation stand whatever snapshot is shown.
  assert.equal(operationalStateForSelection(selection(["arganil"], 40.2183, -8.0541), feed(), newerSnapshot).kind, "matched");
});

test("without the operational feed the state is unavailable, not 'no incident'", () => {
  assert.deepEqual(operationalStateForSelection(selection(["viseu"], 40.6566, -7.9125), null), { kind: "unavailable" });
});

test("a cluster joins the incidents of its detections", () => {
  const state = operationalStateForSelection(selection(["arganil", "flank", "viseu"], 40.3, -8.0), feed());
  assert.equal(state.kind, "matched");
  assert.deepEqual(state.kind === "matched" && state.incidents.map((entry) => entry.id), ["anepc:arganil"]);
});

test("incidents are listed active first, each with its satellite evidence", () => {
  const views = incidentViews(feed());
  assert.deepEqual(views.map((view) => view.incident.id), [
    "anepc:arganil", "anepc:monchique-s", "anepc:braganca", "anepc:monchique-n", "anepc:far",
  ]);
  const arganil = views[0];
  assert.equal(arganil.evidence?.matchedDetectionIds.length, 2);
  assert.equal(arganil.evidence?.satellite, "recent");
  assert.equal(views.find((view) => view.incident.id === "anepc:braganca")?.evidence?.satellite, "none");
  assert.equal(views.find((view) => view.incident.id === "anepc:monchique-n")?.evidence?.ambiguousDetectionIds.length, 1);
});
