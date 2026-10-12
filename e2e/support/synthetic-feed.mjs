// Deterministic synthetic FIRMS data for end-to-end tests. Nothing here comes
// from NASA: coordinates, times and FRP values are generated from fixed rules so
// every run renders the same map, metrics and strongest-detection list.

const MINUTE = 60 * 1_000;

/** Detections the tests look for by name. They are the strongest in the feed. */
export const NAMED_DETECTIONS = [
  { id: "e2e-arganil", lat: 40.2183, lng: -8.0541, frpMw: 912.4, confidencePct: 90, scanKm: 0.52, trackKm: 0.43 },
  { id: "e2e-monchique", lat: 37.3172, lng: -8.5554, frpMw: 640.2, confidencePct: 65, scanKm: 0.39, trackKm: 0.36 },
  { id: "e2e-madeira", lat: 32.7401, lng: -17.0021, frpMw: 402.8, confidencePct: 90 },
  // 2.6 km from the Arganil occurrence (operational-feed.ts): a second detection
  // linked to it, far enough from the registered place to show the location note.
  { id: "e2e-arganil-flank", lat: 40.2, lng: -8.0541, frpMw: 210.5, confidencePct: 90 },
  // No occurrence within 5 km: a detection the operational source says nothing about.
  { id: "e2e-viseu", lat: 40.6566, lng: -7.9125, frpMw: 188.3, confidencePct: 65 },
];

function grid(count) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    // 60 latitude rows x 100 longitude columns, offset so no point repeats.
    const lat = -55 + (index % 60) * 2 + (index % 7) * 0.013;
    const lng = -178 + (Math.floor(index / 60) % 100) * 3.5 + (index % 11) * 0.017;
    points.push({
      id: `e2e-grid-${index}`,
      lat: Number(lat.toFixed(4)),
      lng: Number(lng.toFixed(4)),
      // Always below the named detections, so the strongest list is stable.
      frpMw: Number((5 + (index % 95) * 1.7).toFixed(1)),
      confidencePct: [30, 65, 90][index % 3],
      offsetMinutes: (index * 7) % (60 * 70),
    });
  }
  return points;
}

/** A snapshot in the shape the scheduled ingest writes to KV. */
export function buildSnapshot(nowMs, { ageMinutes = 10 } = {}) {
  const generatedAtMs = nowMs - ageMinutes * MINUTE;
  const named = NAMED_DETECTIONS.map((detection, index) => ({
    ...detection,
    detectedAt: new Date(generatedAtMs - (40 + index * 25) * MINUTE).toISOString(),
  }));
  const spread = grid(6_000).map(({ offsetMinutes, ...point }) => ({
    ...point,
    detectedAt: new Date(generatedAtMs - (30 + offsetMinutes) * MINUTE).toISOString(),
  }));
  return {
    version: 1,
    source: "NASA FIRMS VIIRS_SNPP_NRT",
    generatedAt: new Date(generatedAtMs).toISOString(),
    sourceRows: 214_806,
    filteredRows: 181_233,
    points: [...named, ...spread],
  };
}

/** The ingest health record for a healthy pipeline that built `snapshot`. */
export function buildHealthyIngest(snapshot) {
  const attemptedAt = new Date(Date.parse(snapshot.generatedAt) - 40 * 1_000).toISOString();
  return {
    version: 2,
    attemptedAt,
    outcome: "success",
    consecutiveFailures: 0,
    lastSuccessAt: attemptedAt,
    sourceRows: snapshot.sourceRows,
    filteredRows: snapshot.filteredRows,
    selectedPoints: snapshot.points.length,
  };
}
