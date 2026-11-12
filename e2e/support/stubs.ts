import type { Page, Route } from "@playwright/test";
import { BASEMAP_STYLE } from "./basemap-style";
import { solidPng } from "./png";

/**
 * Browser-side stand-ins for every third-party host and for the Worker routes
 * that would call one. Requests still pass through the page's Content Security
 * Policy, so a host missing from the policy fails the test like it would in
 * production.
 */

/** Every satellite tile is this flat colour, so imagery is easy to find in a screenshot. */
export const SATELLITE_TILE_COLOUR = [46, 139, 87] as const;
const SATELLITE_TILE = solidPng(256, SATELLITE_TILE_COLOUR);

export const OPEN_METEO_CURRENT = {
  time: "2026-10-02T12:00",
  temperature_2m: 27.4,
  relative_humidity_2m: 31,
  precipitation: 0,
  precipitation_probability: 5,
  wind_speed_10m: 18.2,
  wind_direction_10m: 312,
  wind_gusts_10m: 34.6,
};

export interface StubLog {
  thirdPartyHosts: Set<string>;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export async function stubThirdParties(page: Page): Promise<StubLog> {
  const log: StubLog = { thirdPartyHosts: new Set() };
  const note = (route: Route) => log.thirdPartyHosts.add(new URL(route.request().url()).hostname);

  await page.route("https://basemaps.cartocdn.com/**", (route) => { note(route); return json(route, BASEMAP_STYLE); });
  await page.route("https://*.basemaps.cartocdn.com/**", (route) => {
    note(route);
    return route.fulfill({ status: 200, contentType: "application/x-protobuf", body: Buffer.alloc(0) });
  });
  await page.route("https://server.arcgisonline.com/**", (route) => { note(route); return route.fulfill({ status: 200, contentType: "image/png", body: SATELLITE_TILE }); });
  await page.route("https://api.open-meteo.com/**", (route) => { note(route); return json(route, { current: OPEN_METEO_CURRENT }); });

  // Worker routes that call third parties from the server.
  await page.route("**/api/reverse-geocode?**", (route) => json(route, { label: "Arganil/Coimbra, Portugal" }));
  await page.route("**/api/air-quality?**", (route) => json(route, {
    availability: "available",
    searchRadiusKm: 100,
    reading: {
      pm25: 41.3,
      aqi: 116,
      category: "unhealthy-sensitive",
      observedAt: "2026-10-02T11:00:00.000Z",
      stationName: "Coimbra/Instituto Geofísico",
      distanceKm: 38.2,
      unit: "µg/m³",
      source: "OpenAQ",
      aqiMethod: "US EPA PM2.5 breakpoint estimate",
    },
  }));
  await page.route("**/api/news?**", (route) => json(route, {
    location: "Arganil/Coimbra, Portugal",
    articles: [{ title: "Incêndio em Arganil mobiliza meios aéreos", link: "https://example.com/arganil", publishedAt: new Date().toISOString() }],
  }));
  await page.route("**/api/fires/detail?**", (route) => json(route, {
    version: 1,
    source: "NASA FIRMS VIIRS_NOAA20_NRT",
    generatedAt: new Date().toISOString(),
    bbox: [-8.2, 40.1, -7.9, 40.3],
    days: 3,
    start: null,
    points: [
      { id: "e2e-detail-1", lat: 40.2183, lng: -8.0541, frpMw: 912.4, confidencePct: 90, detectedAt: new Date().toISOString(), scanKm: 0.52, trackKm: 0.43 },
      { id: "e2e-detail-2", lat: 40.2221, lng: -8.0502, frpMw: 120.5, confidencePct: 65, detectedAt: new Date().toISOString() },
    ],
  }));

  return log;
}

/** Rewrites the /api/fires body, e.g. to age the snapshot or record a failed refresh. */
export async function rewriteFeed(page: Page, rewrite: (payload: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await page.route("**/api/fires", async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: rewrite(payload) });
  });
}

/** Collects Content Security Policy violations reported by the page. */
export async function watchCspViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("__reportCspViolation", (detail: string) => { violations.push(detail); });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __reportCspViolation: (detail: string) => void })
        .__reportCspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}
