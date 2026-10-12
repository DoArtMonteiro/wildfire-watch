import type { CachedFirmsPoint } from "@/lib/wildfire/firms-cache";
import type { DetectionMatch, FusionObservation, IncidentEvidence, ReconciliationResult } from "@/lib/fusion/reconcile";
import type { OperationalIncident, OperationalPhase } from "@/lib/wildfire/types";
import { ANEPC_COVERAGE } from "./anepc";

/**
 * Storage format of the operational-incident snapshot and of the compact
 * detection index the reconciliation reads. Every source has its own keys,
 * separate from FIRMS', so a failing source can never overwrite another's
 * data or health.
 */
export const INCIDENTS_CACHE_KEY = "operational-incidents:v1";
export const INCIDENTS_INGEST_HEALTH_KEY = "operational-incidents:ingest-health:v1";
/** Written by the FIRMS ingest: the detections inside the operational source's coverage. */
export const FUSION_INDEX_KEY = "active-fires:fusion-index:v1";

export interface IncidentsCachePayload {
  version: 1;
  source: "ANEPC Ocorrências em aberto";
  /** When this snapshot was built. */
  generatedAt: string;
  incidents: OperationalIncident[];
  reconciliation: ReconciliationResult;
  /** The FIRMS snapshot whose detections were reconciled; null when none was available. */
  fusedWith: { firmsGeneratedAt: string; detections: number } | null;
}

/** [id, lat, lng, acquiredAt, frpMw]: about a fifth of the size of the full point objects. */
type IndexPoint = [string, number, number, string, number];

export interface FusionIndexPayload {
  version: 1;
  firmsGeneratedAt: string;
  points: IndexPoint[];
}

const PHASES: readonly OperationalPhase[] = ["dispatch", "in_progress", "resolving", "concluding", "surveillance", "other"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * The shape of the ISO times the FIRMS ingest writes. Cheaper than Date.parse
 * for thousands of index entries; a time that matches but does not parse is
 * never a candidate in the reconciliation.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isNullableCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isIncident(value: unknown): value is OperationalIncident {
  if (!isRecord(value) || value.kind !== "operational_incident") return false;
  const { location, resources } = value;
  return typeof value.id === "string"
    && value.datasetId === "anepc:ocorrencias-em-aberto"
    && typeof value.sourceId === "string"
    && isRecord(location) && isFiniteNumber(location.lat) && isFiniteNumber(location.lng)
    && PHASES.includes(value.phase as OperationalPhase)
    && typeof value.phaseLabel === "string"
    && typeof value.natureCode === "string"
    && isNullableString(value.natureLabel)
    && isTimestamp(value.startedAt)
    && (value.updatedAt === null || isTimestamp(value.updatedAt))
    && isNullableString(value.municipality)
    && isNullableString(value.parish)
    && isRecord(resources)
    && isNullableCount(resources.personnel) && isNullableCount(resources.groundVehicles) && isNullableCount(resources.aircraft);
}

function isEvidence(value: unknown): value is IncidentEvidence {
  return isRecord(value)
    && typeof value.incidentId === "string"
    && isStringArray(value.matchedDetectionIds)
    && isStringArray(value.ambiguousDetectionIds)
    && (value.nearestDetectionKm === null || isFiniteNumber(value.nearestDetectionKm))
    && (value.latestDetectionAt === null || isTimestamp(value.latestDetectionAt))
    && (value.maxFrpMw === null || isFiniteNumber(value.maxFrpMw))
    && (value.satellite === "recent" || value.satellite === "earlier" || value.satellite === "none");
}

function isMatch(value: unknown): value is DetectionMatch {
  return isRecord(value)
    && typeof value.detectionId === "string"
    && (value.status === "matched" || value.status === "ambiguous")
    && isStringArray(value.incidentIds) && value.incidentIds.length > 0
    && isFiniteNumber(value.distanceKm);
}

function isReconciliation(value: unknown): value is ReconciliationResult {
  if (!isRecord(value) || !isRecord(value.rules)) return false;
  const { rules } = value;
  return ["matchRadiusKm", "ambiguityMarginKm", "preReportWindowHours", "recentDetectionHours"].every((key) => isFiniteNumber(rules[key]))
    && Array.isArray(value.incidents) && value.incidents.every(isEvidence)
    && Array.isArray(value.detections) && value.detections.every(isMatch);
}

function isFusedWith(value: unknown): boolean {
  return value === null || (isRecord(value) && isTimestamp(value.firmsGeneratedAt) && isFiniteNumber(value.detections));
}

/**
 * Validates a stored or transmitted snapshot. The envelope and the
 * reconciliation must be intact; an individual malformed incident is dropped
 * so it cannot hide the others.
 */
export function parseIncidentsPayload(raw: unknown): IncidentsCachePayload | null {
  if (!isRecord(raw) || raw.version !== 1 || raw.source !== "ANEPC Ocorrências em aberto") return null;
  if (!isTimestamp(raw.generatedAt) || !Array.isArray(raw.incidents) || !isReconciliation(raw.reconciliation) || !isFusedWith(raw.fusedWith)) {
    return null;
  }
  return {
    version: 1,
    source: raw.source,
    generatedAt: raw.generatedAt,
    incidents: raw.incidents.filter(isIncident),
    reconciliation: raw.reconciliation,
    fusedWith: raw.fusedWith as IncidentsCachePayload["fusedWith"],
  };
}

function insideCoverage(lat: number, lng: number): boolean {
  return lng >= ANEPC_COVERAGE.west && lng <= ANEPC_COVERAGE.east && lat >= ANEPC_COVERAGE.south && lat <= ANEPC_COVERAGE.north;
}

export function buildFusionIndex(points: CachedFirmsPoint[], firmsGeneratedAt: string): FusionIndexPayload {
  return {
    version: 1,
    firmsGeneratedAt,
    points: points
      .filter((point) => insideCoverage(point.lat, point.lng))
      .map((point): IndexPoint => [point.id, point.lat, point.lng, point.detectedAt, point.frpMw]),
  };
}

export function readFusionIndex(raw: unknown): { firmsGeneratedAt: string; observations: FusionObservation[] } | null {
  if (!isRecord(raw) || raw.version !== 1 || !isTimestamp(raw.firmsGeneratedAt) || !Array.isArray(raw.points)) return null;
  const observations: FusionObservation[] = [];
  for (const entry of raw.points) {
    if (!Array.isArray(entry) || entry.length !== 5) continue;
    const [id, lat, lng, acquiredAt, frpMw] = entry as unknown[];
    if (typeof id !== "string" || !isFiniteNumber(lat) || !isFiniteNumber(lng) || typeof acquiredAt !== "string" || !ISO_UTC.test(acquiredAt) || !isFiniteNumber(frpMw)) continue;
    observations.push({ id, location: { lat, lng }, acquiredAt, frpMw });
  }
  return { firmsGeneratedAt: raw.firmsGeneratedAt, observations };
}
