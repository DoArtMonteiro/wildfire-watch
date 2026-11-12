import assert from "node:assert/strict";
import test from "node:test";
import type { DetectionConfidence, ThermalDetection } from "./types";
import { calculateOverviewMetrics, selectStrongestDetections } from "./overview-metrics";

function detection(id: string, frpMw: number, confidence: DetectionConfidence = "nominal"): ThermalDetection {
  return {
    kind: "satellite_thermal_detection",
    id,
    datasetId: "nasa-firms:viirs-noaa20-nrt",
    location: { lng: -9, lat: 39 },
    acquiredAt: "2026-08-01T00:00:00.000Z",
    frpMw,
    confidence,
    pixelKm: null,
    intensityBand: "low",
    country: "Portugal",
  };
}

test("summarises measured FRP and source-reported confidence", () => {
  assert.deepEqual(calculateOverviewMetrics([detection("a", 12, "high"), detection("b", 8, "low")]), {
    totalFrpMw: 20,
    maxFrpMw: 12,
    averageFrpMw: 10,
    validIntensityCount: 2,
    highConfidenceCount: 1,
  });
});

test("excludes non-finite and negative FRP from the totals", () => {
  const metrics = calculateOverviewMetrics([
    detection("nan", Number.NaN, "high"),
    detection("negative", -4),
    detection("zero", 0),
    detection("five", 5, "high"),
  ]);
  assert.deepEqual(metrics, {
    totalFrpMw: 5,
    maxFrpMw: 5,
    averageFrpMw: 2.5,
    validIntensityCount: 2,
    highConfidenceCount: 2,
  });
});

test("returns null when no detection has a valid FRP", () => {
  assert.equal(calculateOverviewMetrics([]), null);
  assert.equal(calculateOverviewMetrics([detection("invalid", Number.NaN)]), null);
});

test("lists the strongest detections first without reordering the input", () => {
  const input = [detection("weak", 3), detection("invalid", Number.NaN), detection("strong", 250), detection("middle", 40)];

  assert.deepEqual(selectStrongestDetections(input, 2).map((item) => item.id), ["strong", "middle"]);
  assert.deepEqual(selectStrongestDetections(input, 10).map((item) => item.id), ["strong", "middle", "weak"]);
  assert.deepEqual(input.map((item) => item.id), ["weak", "invalid", "strong", "middle"], "input order must not change");
  assert.deepEqual(selectStrongestDetections([], 5), []);
  assert.deepEqual(selectStrongestDetections(input, 0), []);
});
