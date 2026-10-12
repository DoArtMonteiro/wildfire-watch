import assert from "node:assert/strict";
import test from "node:test";
import { haversineKm } from "./distance";

test("great-circle distance in kilometres", () => {
  assert.equal(haversineKm({ lat: 40, lng: -8 }, { lat: 40, lng: -8 }), 0);
  // One degree of latitude is about 111.2 km everywhere.
  assert.ok(Math.abs(haversineKm({ lat: 40, lng: -8 }, { lat: 41, lng: -8 }) - 111.2) < 0.2);
  // Lisbon to Porto, about 274 km.
  const lisbonPorto = haversineKm({ lat: 38.7223, lng: -9.1393 }, { lat: 41.1579, lng: -8.6291 });
  assert.ok(lisbonPorto > 270 && lisbonPorto < 278, String(lisbonPorto));
  assert.equal(haversineKm({ lat: 40, lng: -8 }, { lat: 40.01, lng: -8 }), haversineKm({ lat: 40.01, lng: -8 }, { lat: 40, lng: -8 }), "symmetric");
});
