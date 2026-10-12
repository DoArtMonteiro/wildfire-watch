import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import en from "../src/lib/i18n/en";
import pt from "../src/lib/i18n/pt";
import { stubThirdParties, watchCspViolations } from "./support/stubs";
import { waitForServer } from "./support/server";

// Chromium without WebGL2, as on an old or GPU-blocklisted device: MapLibre 6
// cannot create its rendering context. The map area must say so, without
// suggesting that the wildfire data is missing, and everything else must work.
test.use({ launchOptions: { args: ["--disable-webgl2"] } });

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let cspViolations: string[] = [];
let runtimeErrors: string[] = [];
/** Console errors a test causes on purpose, unrelated to the map renderer. */
let expectedConsoleErrors: RegExp[] = [];

test.beforeEach(async ({ request }, testInfo) => waitForServer(request, testInfo));

test.beforeEach(async ({ page }) => {
  runtimeErrors = [];
  expectedConsoleErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !expectedConsoleErrors.some((pattern) => pattern.test(text))) {
      runtimeErrors.push(`console: ${text}`);
    }
  });
  cspViolations = await watchCspViolations(page);
  await stubThirdParties(page);
});

test.afterEach(() => {
  expect(cspViolations, "the Content Security Policy blocked a request").toEqual([]);
  expect(runtimeErrors, "the missing renderer is handled without page or console errors").toEqual([]);
});

function notice(page: Page) {
  return page.getByTestId("map-unavailable");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
}

test("the map area says the interactive map is unavailable, and the data, details and navigation still work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  expect(await page.evaluate(() => Boolean(document.createElement("canvas").getContext("webgl2"))), "WebGL2 is disabled").toBe(false);

  await expect(notice(page)).toBeVisible();
  await expect(notice(page).getByRole("heading", { name: pt.map.unavailableTitle })).toBeVisible();
  await expect(notice(page)).toContainText(pt.map.unavailableDescription);
  await expect(notice(page)).toContainText(pt.map.unavailableDataNote);
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: pt.map.unavailableTitle }), "the change is announced").toHaveCount(1);
  await expect(page.getByTestId("map-loading-state")).toHaveCount(0);
  await expect(page.getByText(pt.map.loadingLabel)).toHaveCount(0);

  // The renderer is missing, not the data.
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");
  await expect(page.getByTestId("map-load-error")).toHaveCount(0);

  // Map-only controls and the empty map region are gone; the rest of the page stays.
  await expect(page.getByRole("region", { name: pt.map.canvasLabel })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: pt.topBar.basemapToggleLabel })).toHaveCount(0);
  await expect(page.getByRole("region", { name: pt.timeline.controlLabel })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: pt.topBar.themeToggleLabel })).toBeVisible();
  await expect(page.getByRole("group", { name: pt.topBar.languageToggleLabel })).toBeVisible();
  await expect(page.getByRole("navigation", { name: pt.legal.navLabel })).toBeVisible();

  expect(await axeViolations(page), "global overview without a map, dark theme").toEqual([]);
  // The theme is remembered; reloading checks the light theme without its colour transition in flight.
  await page.getByRole("switch", { name: pt.topBar.themeToggleLabel }).click();
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await expect(notice(page)).toBeVisible();
  expect(await axeViolations(page), "global overview without a map, light theme").toEqual([]);

  await page.getByRole("button", { name: /912,4 MW/ }).click();
  await expect(page.getByRole("heading", { name: pt.fireDetail.pointTitle })).toBeVisible();
  await expect(page.getByTestId("operational-status")).toBeVisible();
  await expect(page.getByTestId("detection-provenance")).toContainText("NASA FIRMS");
  expect(await axeViolations(page), "detection detail without a map").toEqual([]);
});

test("from the keyboard, the notice leads to the detection list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const showList = notice(page).getByRole("link", { name: pt.map.unavailableShowList });
  await expect(showList).toBeVisible();

  let reached = false;
  for (let presses = 0; presses < 12 && !reached; presses += 1) {
    await page.keyboard.press("Tab");
    reached = await showList.evaluate((element) => element === document.activeElement);
  }
  expect(reached, "the notice's link is in the tab order").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.locator("#mission-control-panel-content")).toBeFocused();
});

test("on a 390 px phone the notice fits and opens the collapsed panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  const box = await notice(page).boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390, "the notice is inside the viewport").toBe(true);
  await expectNoHorizontalOverflow(page);

  await notice(page).getByRole("link", { name: pt.map.unavailableShowList }).click();
  await expect(page.locator("#mission-control-panel-content")).toBeFocused();
  await expect(page.getByRole("heading", { name: pt.overview.strongestTitle })).toBeVisible();
  await page.getByRole("button", { name: /912,4 MW/ }).click();
  await expect(page.getByRole("heading", { name: pt.fireDetail.pointTitle })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("the notice follows the interface language", async ({ page }) => {
  await page.goto("/");
  await expect(notice(page)).toBeVisible();
  await page.getByRole("group", { name: pt.topBar.languageToggleLabel }).getByRole("button", { name: /^en\b/i }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(notice(page).getByRole("heading", { name: en.map.unavailableTitle })).toBeVisible();
  await expect(notice(page)).toContainText(en.map.unavailableDescription);
  await expect(notice(page).getByRole("link", { name: en.map.unavailableShowList })).toBeVisible();
});

test("a feed failure without a map does not claim the map is available", async ({ page }) => {
  // The browser logs the failed response and the app logs the failed load; both are forced here.
  expectedConsoleErrors = [/^Failed to load resource/, /^Unable to load the detection snapshot/];
  await page.route("**/api/fires", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Fire cache unavailable"}' }));
  await page.goto("/");

  const feedError = page.getByTestId("map-load-error");
  await expect(feedError).toContainText(pt.map.errorTitle);
  await expect(feedError).toContainText(pt.map.errorDescriptionWithoutMap);
  await expect(feedError).not.toContainText(pt.map.errorDescription);
  await expect(feedError.getByRole("button", { name: pt.map.retryLabel })).toBeVisible();
  // The map notice still explains the renderer, but no longer vouches for data that failed to load.
  await expect(notice(page)).toContainText(pt.map.unavailableDescription);
  await expect(notice(page)).not.toContainText(pt.map.unavailableDataNote);
  await expect(notice(page).getByRole("link", { name: pt.map.unavailableShowList })).toHaveCount(0);
});
