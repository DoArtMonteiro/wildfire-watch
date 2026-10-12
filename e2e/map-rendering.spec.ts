import { expect, test, type Page } from "@playwright/test";
import pt from "../src/lib/i18n/pt";
import { STYLE_WATER_COLOUR } from "./support/basemap-style";
import { countColour, countWarm, decodePng } from "./support/png";
import { SATELLITE_TILE_COLOUR, stubThirdParties, watchCspViolations } from "./support/stubs";
import { waitForServer } from "./support/server";

// Pixel checks on the WebGL canvas. They prove that MapLibre actually drew:
// its worker loaded and tiled the GeoJSON sources, the raster imagery
// arrived, the app's water override ran after every style load, and the
// detection layers sit on top. Colours come from the stubs, so the counts
// are deterministic; thresholds leave room for antialiasing and markers.

const PLAIN_WATER_DARK = [26, 58, 82] as const; // #1a3a52, set by getWaterColorOverrides
const PLAIN_WATER_LIGHT = [168, 216, 240] as const; // #a8d8f0

// The map area left of the desktop panel, clear of the top bar, legend, timeline and attribution.
const MAP_AREA = { x: 180, y: 110, width: 640, height: 460 };

let cspViolations: string[] = [];
let runtimeErrors: string[] = [];

test.beforeEach(async ({ request }, testInfo) => waitForServer(request, testInfo));

test.beforeEach(async ({ page }) => {
  runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  });
  cspViolations = await watchCspViolations(page);
  await stubThirdParties(page);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(() => {
  expect(cspViolations, "the Content Security Policy blocked a request").toEqual([]);
  expect(runtimeErrors, "the page logged runtime errors").toEqual([]);
});

async function mapPixels(page: Page) {
  return decodePng(await page.screenshot({ clip: MAP_AREA }));
}

async function expectMapColours(
  page: Page,
  expected: { satellite: "present" | "absent"; water: readonly [number, number, number] | null; detections?: boolean },
): Promise<void> {
  await expect.poll(async () => {
    const pixels = await mapPixels(page);
    const satellite = countColour(pixels, SATELLITE_TILE_COLOUR, 30);
    const water = expected.water ? countColour(pixels, expected.water, 12) : 0;
    return {
      satellite: expected.satellite === "present" ? satellite > 20_000 : satellite < 100,
      water: expected.water ? water > 5_000 : true,
      unstyledWater: countColour(pixels, STYLE_WATER_COLOUR, 40) === 0,
      detections: expected.detections === false || countWarm(pixels) > 150,
    };
  }, { timeout: 20_000, intervals: [500] }).toEqual({ satellite: true, water: true, unstyledWater: true, detections: true });
}

test("MapLibre draws imagery, recoloured water and detections, and keeps them through basemap and theme changes", async ({ page }) => {
  // MapLibre 6 runs its tile worker as a module served from this origin.
  const workerFiles = new Map<string, { status: number; type: string }>();
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith("/maplibre/")) {
      workerFiles.set(pathname, { status: response.status(), type: response.headers()["content-type"] ?? "" });
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");

  // Satellite mode is the default: imagery visible, provider water hidden, detections on top.
  await expectMapColours(page, { satellite: "present", water: null });
  await expect(page.getByTestId("map-unavailable"), "WebGL2 is available, so no fallback").toHaveCount(0);
  for (const file of ["/maplibre/maplibre-gl-worker.mjs", "/maplibre/maplibre-gl-shared.mjs"]) {
    expect(workerFiles.get(file)?.status, file).toBe(200);
    expect(workerFiles.get(file)?.type, file).toMatch(/javascript/);
  }

  const basemapSwitch = page.getByRole("switch", { name: pt.topBar.basemapToggleLabel });
  await basemapSwitch.click();
  await expect(page.locator("main")).toHaveAttribute("data-basemap-mode", "plain");
  await expectMapColours(page, { satellite: "absent", water: PLAIN_WATER_DARK });

  await page.getByRole("switch", { name: pt.topBar.themeToggleLabel }).click();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await expectMapColours(page, { satellite: "absent", water: PLAIN_WATER_LIGHT });

  await basemapSwitch.click();
  await expect(page.locator("main")).toHaveAttribute("data-basemap-mode", "satellite");
  await expectMapColours(page, { satellite: "present", water: null });
});

test("selecting a detection flies to it and draws its sensor-pixel footprints", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");

  await page.getByRole("button", { name: /912,4 MW/ }).click();
  await expect(page.getByTestId("operational-status")).toBeVisible();

  // At detail zoom the stubbed full-resolution points are drawn as filled pixel squares.
  await expect.poll(async () => countWarm(await mapPixels(page)), { timeout: 20_000, intervals: [500] }).toBeGreaterThan(400);
});

test("rapid theme and basemap changes leave the map in the state the controls show", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");
  const basemapSwitch = page.getByRole("switch", { name: pt.topBar.basemapToggleLabel });
  const themeSwitch = page.getByRole("switch", { name: pt.topBar.themeToggleLabel });

  await basemapSwitch.click();
  await themeSwitch.click();
  await expectMapColours(page, { satellite: "absent", water: PLAIN_WATER_LIGHT });

  // Two style changes in a row, then a scope change that moves the camera and
  // replaces the detection data, all while the new style is still loading.
  await themeSwitch.click();
  await basemapSwitch.click();
  const countrySelect = page.getByRole("combobox", { name: pt.overview.countryLabel });
  await countrySelect.selectOption("Portugal");
  await expect(page.locator("main")).toHaveAttribute("data-basemap-mode", "satellite");
  // The country view frames Portugal's two stubbed detections at the edges of
  // the map, outside the sampled area; the world view brings them back into it.
  await expectMapColours(page, { satellite: "present", water: null, detections: false });
  await countrySelect.selectOption("global");
  await expectMapColours(page, { satellite: "present", water: null });

  await basemapSwitch.click();
  await themeSwitch.click();
  await expectMapColours(page, { satellite: "absent", water: PLAIN_WATER_LIGHT });
});
