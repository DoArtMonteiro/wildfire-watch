import type { GeoPoint } from "@/lib/wildfire/types";

const EARTH_RADIUS_KM = 6_371.0088;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance on a spherical Earth; accurate to well under 1 % at these scales. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
