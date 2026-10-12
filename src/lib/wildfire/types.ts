import type { IngestHealthRecord } from "./ingest-health";

// Normalized internal model. Every upstream source is mapped into these types
// before it reaches the UI, so components never parse provider formats.
//
// The model keeps three kinds of information apart, because blurring them is
// how a map of satellite heat signals starts to look like an incident board:
//
//   - observations: what an instrument or authority reported, with provenance;
//   - derived values: what WildfireWatch computes from observations, labelled
//     as estimated or inferred;
//   - operational status: what only an operational authority can report.
//
// A satellite thermal detection is an observation of heat. It is not a
// confirmed wildfire and it never carries an operational status of its own.

export interface GeoPoint {
  lng: number;
  lat: number;
}

/** How a value shown to the visitor was obtained. */
export type ValueBasis =
  /** Measured by an instrument, e.g. Fire Radiative Power from VIIRS. */
  | "measured"
  /** Stated by the source, e.g. a detection confidence category or an authority's status. */
  | "reported"
  /** Computed by WildfireWatch with a model, e.g. a burned-area estimate. */
  | "estimated"
  /** Derived by WildfireWatch from other data, e.g. a country from coordinates. */
  | "inferred";

/** Operational fire status. Only an operational source can report anything but "unknown". */
export type OperationalStatus = "unknown" | "active" | "contained" | "extinguished";

/** A display band for measured Fire Radiative Power. It is not a fire severity. */
export type RadiativeIntensityBand = "low" | "moderate" | "high" | "very_high";

/** Detection confidence as the source reports it. VIIRS publishes categories, not percentages. */
export type DetectionConfidence = "low" | "nominal" | "high";

/**
 * Kinds of observation the model can hold: heat seen by a satellite, and an
 * occurrence as an operational authority records it.
 */
export type ObservationKind = "satellite_thermal_detection" | "operational_incident_report";

/** Stable identifier of an upstream dataset; observations reference it instead of repeating provenance. */
export type DatasetId = "nasa-firms:viirs-snpp-nrt" | "anepc:ocorrencias-em-aberto";

/** Who produced a dataset and how it may be credited. Shared by every observation from it. */
export interface DatasetProvenance {
  id: DatasetId;
  /** Organisation that measured or distributes the data. */
  provider: string;
  /** Upstream product identifier, exactly as the provider names it. */
  product: string;
  /** Instrument and platform that made the measurement. */
  instrument: string;
  observationKind: ObservationKind;
  /** Whether this source can report operational status. Satellite sources cannot. */
  reportsOperationalStatus: boolean;
  /** Human-readable credit line. */
  attribution: string;
  /** Where a visitor can learn about the dataset. */
  sourceUrl: string;
}

/** One thermal anomaly detected by a satellite sensor. */
export interface ThermalDetection {
  kind: "satellite_thermal_detection";
  /** WildfireWatch identifier, derived from acquisition time and position (FIRMS rows have no native id). */
  id: string;
  datasetId: DatasetId;
  /** Measured: centre of the sensor pixel. */
  location: GeoPoint;
  /** Measured: satellite acquisition time, ISO 8601 UTC. */
  acquiredAt: string;
  /** Measured: Fire Radiative Power in megawatts. */
  frpMw: number;
  /** Reported by the source. */
  confidence: DetectionConfidence;
  /** Measured footprint of the sensor pixel in km, when the source reports it. */
  pixelKm: { scan: number; track: number } | null;
  /** Derived by WildfireWatch from frpMw; drives map colour only. */
  intensityBand: RadiativeIntensityBand;
  /** Inferred by WildfireWatch from coordinates; null outside any land boundary. */
  country: string | null;
}

/**
 * Phase of an official occurrence, as the operational authority groups it.
 * WildfireWatch never derives a phase; it only maps the source's own labels.
 * "other" keeps a label the mapping does not recognise, shown verbatim.
 */
export type OperationalPhase = "dispatch" | "in_progress" | "resolving" | "concluding" | "surveillance" | "other";

/** Resources an authority reports as committed to an occurrence; null when it gives no count. */
export interface OperationalResources {
  personnel: number | null;
  groundVehicles: number | null;
  aircraft: number | null;
}

/**
 * A rural-fire occurrence as an operational authority records it (ANEPC, in
 * mainland Portugal). Everything here is reported by the authority; its
 * location is where the occurrence was registered, often the nearest
 * locality, not a fire perimeter.
 */
export interface OperationalIncident {
  kind: "operational_incident";
  /** WildfireWatch identifier: the dataset prefix and the source's occurrence number. */
  id: string;
  datasetId: DatasetId;
  /** The authority's own occurrence number. */
  sourceId: string;
  location: GeoPoint;
  phase: OperationalPhase;
  /** The phase exactly as the source words it (Portuguese). */
  phaseLabel: string;
  /** Nature code and label, e.g. 3101 "Povoamento Florestal". */
  natureCode: string;
  natureLabel: string | null;
  /** When the occurrence started, ISO 8601 UTC. */
  startedAt: string;
  /** When the source last published this occurrence's state, if it says. */
  updatedAt: string | null;
  municipality: string | null;
  parish: string | null;
  resources: OperationalResources;
}

/** Provenance of the snapshot the browser is showing. */
export interface SnapshotProvenance {
  dataset: DatasetProvenance;
  /** When WildfireWatch last retrieved the dataset from the provider, if recorded. */
  retrievedAt: string | null;
  /** When WildfireWatch built this snapshot. */
  processedAt: string;
  /** Rows the provider returned, rows that passed quality filters, rows kept for the map. */
  sourceRows: number;
  filteredRows: number;
  selectedRows: number;
}

/** A map selection: one detection, or a MapLibre cluster of nearby detections. */
export interface DetectionSelection {
  kind: "detection" | "cluster";
  id: string;
  /** Detection pixel centre, or the cluster's display position. */
  location: GeoPoint;
  /** Inferred; null when the detections fall outside any land boundary or span countries. */
  country: string | null;
  detectionIds: string[];
  detectionCount: number;
  /** Measured: sum of Fire Radiative Power over the selected detections. */
  totalFrpMw: number;
  /** Reported; only meaningful for a single detection. */
  confidence: DetectionConfidence | null;
  /** Measured: earliest and latest acquisition times among the selected detections. */
  firstAcquiredAt: string;
  lastAcquiredAt: string;
  /** Satellite-only selections never know their operational status. */
  operationalStatus: OperationalStatus;
}

export type FeedLoadStatus = "loading" | "ready" | "error";

/** Everything the browser knows about the current detection feed. */
export interface DetectionFeedSnapshot {
  detections: ThermalDetection[];
  provenance: SnapshotProvenance;
  /** Latest ingest attempt as recorded by the scheduled ingest; null when unknown. */
  ingest: IngestHealthRecord | null;
}
