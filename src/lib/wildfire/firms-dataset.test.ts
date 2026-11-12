import assert from "node:assert/strict";
import test from "node:test";
import { FIRMS_LEGACY_SOURCE_LABEL, FIRMS_SOURCE_LABEL, isFirmsCachePayload } from "./firms-cache";
import { FIRMS_VIIRS_DATASET, FIRMS_VIIRS_SNPP_DATASET, datasetForSource, firmsSnapshotProvenance } from "./firms-dataset";

const point = { id: "a", lat: 38.7, lng: -9.1, frpMw: 12, confidencePct: 65, detectedAt: "2026-11-04T12:00:00.000Z" };

function snapshot(source: string) {
  return { version: 1, source, generatedAt: "2026-11-04T23:00:54.422Z", sourceRows: 10, filteredRows: 9, points: [point] };
}

test("snapshots from both the current and the retired product are valid", () => {
  assert.equal(isFirmsCachePayload(snapshot(FIRMS_SOURCE_LABEL)), true);
  assert.equal(isFirmsCachePayload(snapshot(FIRMS_LEGACY_SOURCE_LABEL)), true);
  assert.equal(isFirmsCachePayload(snapshot("NASA FIRMS SOMETHING_ELSE")), false);
});

test("provenance follows the snapshot, so an old Suomi NPP snapshot is never labelled NOAA-20", () => {
  assert.equal(datasetForSource(FIRMS_SOURCE_LABEL), FIRMS_VIIRS_DATASET);
  assert.equal(datasetForSource(FIRMS_LEGACY_SOURCE_LABEL), FIRMS_VIIRS_SNPP_DATASET);
  assert.equal(FIRMS_VIIRS_DATASET.product, "VIIRS_NOAA20_NRT");
  assert.equal(FIRMS_VIIRS_SNPP_DATASET.instrument, "VIIRS · Suomi NPP");
  const legacy = snapshot(FIRMS_LEGACY_SOURCE_LABEL);
  assert.equal(firmsSnapshotProvenance(legacy as Parameters<typeof firmsSnapshotProvenance>[0], null).dataset.product, "VIIRS_SNPP_NRT");
});
