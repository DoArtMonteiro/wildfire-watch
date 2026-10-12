import { LOCATION_NOTE_KM, MATCH_RULES, type DetectionMatch, type IncidentEvidence } from "@/lib/fusion/reconcile";
import type { IngestHealthRecord } from "@/lib/wildfire/ingest-health";
import type { GeoPoint, OperationalIncident, OperationalPhase } from "@/lib/wildfire/types";
import { ANEPC_COVERAGE } from "./anepc";
import type { IncidentsCachePayload } from "./incidents-cache";

/**
 * Turns the reconciled snapshot into the states the interface shows. Pure,
 * so every conflict case can be tested without a browser. The wording lives
 * in the dictionaries; this module only decides which case applies.
 */

/** What the browser holds for the operational source. */
export interface OperationalFeedSnapshot extends IncidentsCachePayload {
  ingest: IngestHealthRecord | null;
}

/** The parts of a map selection (one detection or a cluster) the operational state needs. */
export interface OperationalSelection {
  detectionIds: string[];
  location: GeoPoint;
  country: string | null;
  lastAcquiredAt: string;
}

export type SelectionOperationalState =
  /** No operational source covers this place (outside mainland Portugal). */
  | { kind: "not_covered" }
  /** The operational source could not be loaded. */
  | { kind: "unavailable" }
  /** The detection may not have been compared yet: it comes from a newer FIRMS snapshot than the one reconciled. */
  | { kind: "not_reconciled" }
  /** Compared, and no occurrence met the rules: within radiusKm, started no more than windowHours after the detection. */
  | { kind: "none_nearby"; radiusKm: number; windowHours: number }
  /** Linked to one or more occurrences; locationNoteKm is set when the nearest is farther than usual. */
  | { kind: "matched"; incidents: OperationalIncident[]; nearestKm: number; locationNoteKm: number | null }
  /** Near two or more occurrences at similar distances; none was chosen. */
  | { kind: "ambiguous"; incidents: OperationalIncident[]; nearestKm: number };

export interface IncidentView {
  incident: OperationalIncident;
  evidence: IncidentEvidence | null;
}

/** Active work first, so the list leads with what is happening now. */
const PHASE_ORDER: Record<OperationalPhase, number> = {
  in_progress: 0,
  dispatch: 1,
  resolving: 2,
  concluding: 3,
  surveillance: 4,
  other: 5,
};

export function isInOperationalCoverage(location: GeoPoint, country: string | null): boolean {
  return country === "Portugal"
    && location.lng >= ANEPC_COVERAGE.west && location.lng <= ANEPC_COVERAGE.east
    && location.lat >= ANEPC_COVERAGE.south && location.lat <= ANEPC_COVERAGE.north;
}

function incidentsFor(matches: DetectionMatch[], byId: Map<string, OperationalIncident>): OperationalIncident[] {
  const ids = [...new Set(matches.flatMap((match) => match.incidentIds))].sort();
  return ids.map((id) => byId.get(id)).filter((entry): entry is OperationalIncident => Boolean(entry));
}

/**
 * `firmsGeneratedAt` is when the FIRMS snapshot the selection comes from was
 * built. Without it, the detection's acquisition time is the best available
 * evidence that it was compared.
 */
export function operationalStateForSelection(
  selection: OperationalSelection,
  feed: OperationalFeedSnapshot | null,
  firmsGeneratedAt: string | null = null,
): SelectionOperationalState {
  if (!isInOperationalCoverage(selection.location, selection.country)) return { kind: "not_covered" };
  if (!feed) return { kind: "unavailable" };

  const ids = new Set(selection.detectionIds);
  const matches = feed.reconciliation.detections.filter((match) => ids.has(match.detectionId));
  const byId = new Map(feed.incidents.map((entry) => [entry.id, entry]));
  const linked = matches.filter((match) => match.status === "matched");
  if (linked.length > 0) {
    const nearestKm = Math.min(...linked.map((match) => match.distanceKm));
    return { kind: "matched", incidents: incidentsFor(linked, byId), nearestKm, locationNoteKm: nearestKm > LOCATION_NOTE_KM ? nearestKm : null };
  }
  const ambiguous = matches.filter((match) => match.status === "ambiguous");
  if (ambiguous.length > 0) {
    return { kind: "ambiguous", incidents: incidentsFor(ambiguous, byId), nearestKm: Math.min(...ambiguous.map((match) => match.distanceKm)) };
  }
  // An unlinked detection was compared only if its FIRMS snapshot is no newer
  // than the one reconciled. NASA publishes late, so a newer snapshot can hold
  // detections acquired hours earlier that the reconciliation never saw.
  const reconciledUpTo = feed.fusedWith ? Date.parse(feed.fusedWith.firmsGeneratedAt) : Number.NEGATIVE_INFINITY;
  const shownSnapshotMs = firmsGeneratedAt ? Date.parse(firmsGeneratedAt) : Number.NaN;
  const evidenceMs = Number.isFinite(shownSnapshotMs) ? shownSnapshotMs : Date.parse(selection.lastAcquiredAt);
  if (!(evidenceMs <= reconciledUpTo)) return { kind: "not_reconciled" };
  return { kind: "none_nearby", radiusKm: MATCH_RULES.matchRadiusKm, windowHours: MATCH_RULES.preReportWindowHours };
}

/** Every incident with its evidence, active first, then newest first. */
export function incidentViews(feed: OperationalFeedSnapshot | null): IncidentView[] {
  if (!feed) return [];
  const evidence = new Map(feed.reconciliation.incidents.map((entry) => [entry.incidentId, entry]));
  return feed.incidents
    .map((incident) => ({ incident, evidence: evidence.get(incident.id) ?? null }))
    .sort((a, b) => PHASE_ORDER[a.incident.phase] - PHASE_ORDER[b.incident.phase]
      || (a.incident.startedAt < b.incident.startedAt ? 1 : a.incident.startedAt > b.incident.startedAt ? -1 : 0)
      || (a.incident.id < b.incident.id ? -1 : a.incident.id > b.incident.id ? 1 : 0));
}

export function findIncidentView(feed: OperationalFeedSnapshot | null, incidentId: string): IncidentView | null {
  return incidentViews(feed).find((view) => view.incident.id === incidentId) ?? null;
}
