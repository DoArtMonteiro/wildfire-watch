import {
  FIRMS_LEGACY_SOURCE_LABEL,
  FIRMS_PRODUCT,
  type CachedFirmsPoint,
  type FirmsCachePayload,
  type FirmsSourceLabel,
} from "./firms-cache";
import { lookupCountry } from "./geo-lookup";
import type { IngestHealthRecord } from "./ingest-health";
import type {
  DatasetId,
  DatasetProvenance,
  DetectionConfidence,
  RadiativeIntensityBand,
  SnapshotProvenance,
  ThermalDetection,
} from "./types";

/** Provenance shared by every detection in the FIRMS snapshot, sent once rather than per point. */
export const FIRMS_VIIRS_DATASET: DatasetProvenance = {
  id: "nasa-firms:viirs-noaa20-nrt",
  provider: "NASA FIRMS",
  product: FIRMS_PRODUCT,
  instrument: "VIIRS · NOAA-20",
  observationKind: "satellite_thermal_detection",
  reportsOperationalStatus: false,
  attribution: "NASA Fire Information for Resource Management System (FIRMS)",
  sourceUrl: "https://www.earthdata.nasa.gov/firms",
};

/**
 * Snapshots written before 2 November 2026 (end of Suomi NPP data delivery)
 * come from Suomi NPP. They stay labelled as such for as long as they are served.
 */
export const FIRMS_VIIRS_SNPP_DATASET: DatasetProvenance = {
  ...FIRMS_VIIRS_DATASET,
  id: "nasa-firms:viirs-snpp-nrt",
  product: "VIIRS_SNPP_NRT",
  instrument: "VIIRS · Suomi NPP",
};

export function datasetForSource(source: FirmsSourceLabel): DatasetProvenance {
  return source === FIRMS_LEGACY_SOURCE_LABEL ? FIRMS_VIIRS_SNPP_DATASET : FIRMS_VIIRS_DATASET;
}

/** Lower bounds (MW) of each radiative intensity band; below `moderate` is `low`. */
export const RADIATIVE_INTENSITY_BANDS_MW = { moderate: 10, high: 50, very_high: 150 } as const;

export function radiativeIntensityBand(frpMw: number): RadiativeIntensityBand {
  if (frpMw >= RADIATIVE_INTENSITY_BANDS_MW.very_high) return "very_high";
  if (frpMw >= RADIATIVE_INTENSITY_BANDS_MW.high) return "high";
  if (frpMw >= RADIATIVE_INTENSITY_BANDS_MW.moderate) return "moderate";
  return "low";
}

/**
 * VIIRS reports confidence as low, nominal or high. The ingest stores those
 * categories as 30, 65 and 90 (see firms-csv.ts) so the cached wire format
 * stays numeric; this maps them back to what the source actually said.
 */
export function confidenceFromStoredValue(storedPct: number): DetectionConfidence {
  if (storedPct >= 80) return "high";
  if (storedPct >= 50) return "nominal";
  return "low";
}

export function cachedPointToDetection(
  point: CachedFirmsPoint,
  datasetId: DatasetId = FIRMS_VIIRS_DATASET.id,
): ThermalDetection {
  return {
    kind: "satellite_thermal_detection",
    id: point.id,
    datasetId,
    location: { lat: point.lat, lng: point.lng },
    acquiredAt: point.detectedAt,
    frpMw: point.frpMw,
    confidence: confidenceFromStoredValue(point.confidencePct),
    pixelKm: point.scanKm !== undefined && point.trackKm !== undefined
      ? { scan: point.scanKm, track: point.trackKm }
      : null,
    intensityBand: radiativeIntensityBand(point.frpMw),
    country: lookupCountry(point.lat, point.lng),
  };
}

export function firmsSnapshotProvenance(
  payload: FirmsCachePayload,
  ingest: IngestHealthRecord | null,
): SnapshotProvenance {
  // The last successful attempt is when the data on screen was retrieved, but
  // only if that attempt is the one that produced this snapshot.
  const retrievedAt = ingest?.lastSuccessAt && Date.parse(ingest.lastSuccessAt) <= Date.parse(payload.generatedAt)
    ? ingest.lastSuccessAt
    : null;
  return {
    dataset: datasetForSource(payload.source),
    retrievedAt,
    processedAt: payload.generatedAt,
    sourceRows: payload.sourceRows,
    filteredRows: payload.filteredRows,
    selectedRows: payload.points.length,
  };
}
