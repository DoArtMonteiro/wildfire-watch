import { radiativeIntensityBand } from "./firms-dataset";
import type { ThermalDetection } from "./types";

/** A valid detection for tests; override only what a test is about. */
export function thermalDetection(overrides: Partial<ThermalDetection> & Pick<ThermalDetection, "id">): ThermalDetection {
  const frpMw = overrides.frpMw ?? 25;
  return {
    kind: "satellite_thermal_detection",
    datasetId: "nasa-firms:viirs-noaa20-nrt",
    location: { lng: -9, lat: 39 },
    acquiredAt: "2026-08-01T12:00:00.000Z",
    confidence: "nominal",
    pixelKm: null,
    country: "Portugal",
    ...overrides,
    frpMw,
    intensityBand: overrides.intensityBand ?? radiativeIntensityBand(frpMw),
  };
}
