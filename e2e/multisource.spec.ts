import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { interpolate } from "../src/lib/i18n/dictionaries";
import en from "../src/lib/i18n/en";
import pt from "../src/lib/i18n/pt";
import { stubThirdParties, watchCspViolations } from "./support/stubs";
import { waitForServer } from "./support/server";

// Satellite detections (FIRMS) and official occurrences (ANEPC) together, from
// the synthetic snapshots seeded by e2e/support/start-server.mjs. The ANEPC
// snapshot is built by the app's own parser and reconciliation
// (e2e/support/operational-feed.ts), so these are the states real data
// produces: a linked detection, one 2.6 km from the registered place, one
// between two occurrences, one with no occurrence nearby, one outside the
// operational source's coverage, and an occurrence with no detection.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let cspViolations: string[] = [];
let runtimeErrors: string[] = [];
let expectedConsoleErrors: RegExp[] = [];

test.beforeEach(async ({ request }, testInfo) => waitForServer(request, testInfo));

test.beforeEach(async ({ page }) => {
  runtimeErrors = [];
  expectedConsoleErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !expectedConsoleErrors.some((pattern) => pattern.test(text))) runtimeErrors.push(`console: ${text}`);
  });
  cspViolations = await watchCspViolations(page);
  await stubThirdParties(page);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(() => {
  expect(cspViolations, "the Content Security Policy blocked a request").toEqual([]);
  expect(runtimeErrors, "the page logged runtime errors").toEqual([]);
});

async function openHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");
}

async function openDetection(page: Page, frp: RegExp): Promise<void> {
  await openHome(page);
  await page.getByRole("button", { name: frp }).click();
  await expect(page.getByTestId("operational-status")).toBeVisible();
}

function operationalDetail(page: Page) {
  return page.getByTestId("operational-detail");
}

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude(".maplibregl-canvas").analyze();
  return results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
}

/** Rewrites the /api/incidents body, e.g. to age it. */
async function rewriteIncidents(page: Page, rewrite: (payload: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await page.route("**/api/incidents", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: rewrite(await response.json() as Record<string, unknown>) });
  });
}

test("the overview shows the official source beside the satellite feed, with its own health", async ({ page }) => {
  await openHome(page);
  const source = page.getByTestId("operational-source");
  await expect(source).toContainText(pt.operational.sourceTitle);
  await expect(page.getByTestId("operational-health-badge")).toHaveAttribute("data-state", "healthy");
  await expect(source).toContainText(pt.operational.openFiresLabel);
  // Active work first: two in progress, then dispatching, then being resolved.
  const items = source.getByRole("listitem");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText(pt.operational.phase.in_progress);
  await expect(items.nth(2)).toContainText("Bragança");
  await expect(items.nth(2)).toContainText(pt.operational.phase.dispatch);
  await expect(items.nth(3)).toContainText(pt.operational.phase.resolving);
  expect(await axeViolations(page), "overview with the official source").toEqual([]);
});

test("a linked detection shows the occurrence's status, and its details show what both sources say", async ({ page }) => {
  await openDetection(page, /912,4 MW/);
  const status = page.getByTestId("operational-status");
  await expect(operationalDetail(page)).toHaveAttribute("data-state", "matched");
  await expect(status).toContainText("Ocorrência oficial a 0,5 km");
  await status.getByRole("button", { name: /Arganil · Pomares/ }).click();

  await expect(page.getByRole("heading", { name: pt.operational.incidentTitle })).toBeVisible();
  const incident = page.getByTestId("incident-status");
  await expect(incident).toContainText(pt.operational.phase.in_progress);
  await expect(incident).toContainText(pt.operational.reportedBy);
  await expect(incident).toContainText("Incêndio Rural - Povoamento Florestal");
  const resources = page.getByTestId("incident-resources");
  for (const value of ["84", "25", "2"]) await expect(resources).toContainText(value);

  const satellite = page.getByTestId("incident-satellite");
  await expect(satellite).toHaveAttribute("data-evidence", "recent");
  await expect(satellite).toContainText(pt.operational.linkedDetectionsLabel);
  await expect(satellite).toContainText("912,4 MW");
  await expect(satellite).toContainText("0,5 km");

  // Rules and provenance are one step away, not in the way.
  await page.getByText(pt.operational.howLinkedTitle).click();
  await expect(page.getByText(/menos de 5 km do local registado/)).toBeVisible();
  await expect(page.getByText(pt.operational.attribution)).toBeVisible();
  // One notice, about this source's delay, not the satellite feed's as well.
  await expect(page.getByText(pt.operational.officialDisclaimer)).toBeVisible();
  await expect(page.getByText(pt.legal.emergencyNotice)).toHaveCount(0);
  expect(await axeViolations(page), "occurrence details").toEqual([]);

  await page.getByRole("button", { name: pt.fireDetail.backToGlobalMap }).click();
  await expect(page.getByRole("heading", { name: pt.overview.strongestTitle })).toBeVisible();
});

test("a detection far from the registered place is still linked, with the distance noted", async ({ page }) => {
  await openDetection(page, /210,5 MW/);
  await expect(operationalDetail(page)).toHaveAttribute("data-state", "matched");
  await expect(operationalDetail(page)).toContainText("2,6 km do local registado pela ANEPC");
});

test("a detection between two occurrences says so, links to both and picks neither", async ({ page }) => {
  await openDetection(page, /640,2 MW/);
  const status = page.getByTestId("operational-status");
  await expect(operationalDetail(page)).toHaveAttribute("data-state", "ambiguous");
  await expect(status).toContainText(pt.operational.ambiguous);
  await expect(status).toContainText(pt.operationalStatus.unknown);
  await expect(status.getByRole("button", { name: /Monchique · Alferce/ })).toBeVisible();
  await expect(status.getByRole("button", { name: /Monchique · Marmelete/ })).toBeVisible();

  // From either occurrence, the detection is reported as nearby but not linked.
  await status.getByRole("button", { name: /Monchique · Alferce/ }).click();
  const satellite = page.getByTestId("incident-satellite");
  await expect(satellite).toHaveAttribute("data-evidence", "none");
  await expect(satellite).toContainText(interpolate(pt.operational.satelliteAmbiguousOnly, { count: "1" }));
  await expect(satellite).not.toContainText(pt.operational.satelliteNone);
});

test("a covered detection with no occurrence nearby says what that does and does not mean", async ({ page }) => {
  await openDetection(page, /188,3 MW/);
  await expect(operationalDetail(page)).toHaveAttribute("data-state", "none_nearby");
  await expect(operationalDetail(page)).toContainText("a menos de 5 km");
  await expect(page.getByTestId("operational-status")).toContainText(pt.fireDetail.operationalUnknownNote);
});

test("outside mainland Portugal no operational source applies", async ({ page }) => {
  await openDetection(page, /402,8 MW/);
  await expect(operationalDetail(page)).toHaveAttribute("data-state", "not_covered");
  await expect(page.getByTestId("operational-status")).toContainText(pt.operationalStatus.unknown);
  await expect(operationalDetail(page)).toContainText(pt.operational.notCovered);
});

test("an occurrence with no satellite detection explains why that can happen", async ({ page }) => {
  await openHome(page);
  await page.getByTestId("operational-source").getByRole("button", { name: /Bragança/ }).click();
  await expect(page.getByTestId("incident-status")).toContainText(pt.operational.phase.dispatch);
  const satellite = page.getByTestId("incident-satellite");
  await expect(satellite).toHaveAttribute("data-evidence", "none");
  await expect(satellite).toContainText(pt.operational.satelliteNone);
  // Aircraft not reported is unknown, not zero.
  await expect(page.getByTestId("incident-resources")).toContainText(pt.operational.notReported);
});

test("stale operational data is labelled as such; the satellite feed is unaffected", async ({ page }) => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await rewriteIncidents(page, (payload) => ({
    ...payload,
    generatedAt: twoHoursAgo,
    ingestHealth: { ...(payload.ingestHealth as Record<string, unknown>), attemptedAt: twoHoursAgo, lastSuccessAt: twoHoursAgo },
  }));
  await openDetection(page, /912,4 MW/);
  await expect(page.getByTestId("feed-health-badge")).toHaveCount(0); // the detail view is open
  await expect(operationalDetail(page)).toContainText("Pode estar desatualizado");

  await page.getByRole("button", { name: pt.fireDetail.backToGlobalMap }).click();
  await expect(page.getByTestId("operational-health-badge")).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");
});

test("a failed refresh over recent occurrences says so, instead of reading as current", async ({ page }) => {
  const aMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  await rewriteIncidents(page, (payload) => ({
    ...payload,
    ingestHealth: { ...(payload.ingestHealth as Record<string, unknown>), attemptedAt: aMinuteAgo, outcome: "failure", errorCode: "http_error", consecutiveFailures: 1 },
  }));
  await openHome(page);
  await expect(page.getByTestId("operational-health-badge")).toHaveAttribute("data-state", "degraded");
  await expect(page.getByTestId("operational-health-badge")).toContainText(pt.operational.healthDegraded);
  await expect(page.getByTestId("operational-health-message")).toContainText("A última atualização falhou");
  // The occurrences are still listed, and the satellite feed is unaffected.
  await expect(page.getByTestId("operational-source").getByRole("listitem")).toHaveCount(4);
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");
});

test("an unavailable operational source never breaks the satellite feed", async ({ page }) => {
  expectedConsoleErrors = [/^Failed to load resource/];
  await page.route("**/api/incidents", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Operational incidents unavailable"}' }));
  await openHome(page);
  await expect(page.getByTestId("operational-health-badge")).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByTestId("operational-health-message")).toContainText(pt.operational.unavailableNote);

  await page.getByRole("button", { name: /912,4 MW/ }).click();
  await expect(operationalDetail(page)).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByTestId("operational-status")).toContainText(pt.operationalStatus.unknown);
  await expect(page.getByTestId("detection-provenance")).toContainText("NASA FIRMS");
});

test("a refresh of the official source leaves the camera where the visitor put it", async ({ page }) => {
  // Reduced motion makes every flight instant, so jumping the clock cannot land mid-animation.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await openHome(page);
  await page.getByTestId("operational-source").getByRole("button", { name: /Arganil/ }).click();
  await expect(page.getByTestId("incident-status")).toBeVisible();
  await expect(page.locator("[data-map-style-url]")).toHaveAttribute("data-map-camera-action", "flyTo");
  // Count every camera move from here on.
  await page.evaluate(() => {
    const root = document.querySelector("[data-map-style-url]")!;
    const moves = { count: 0 };
    (window as unknown as { cameraMoves: typeof moves }).cameraMoves = moves;
    new MutationObserver(() => { moves.count += 1; }).observe(root, { attributes: true, attributeFilter: ["data-map-camera-action", "data-map-camera-padding"] });
  });

  const refreshed = page.waitForResponse("**/api/incidents");
  await page.clock.fastForward("05:01");
  await refreshed;
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => (window as unknown as { cameraMoves: { count: number } }).cameraMoves.count)).toBe(0);
  await expect(page.getByTestId("incident-status")).toBeVisible();
});

test("in English, and at 390 px, an occurrence reads the same way", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("group", { name: pt.topBar.languageToggleLabel }).getByRole("button", { name: /^en\b/i }).click();
  await page.getByRole("button", { name: en.panel.expand }).click();
  await page.getByTestId("operational-source").getByRole("button", { name: /Arganil/ }).click();

  await expect(page.getByRole("heading", { name: en.operational.incidentTitle })).toBeVisible();
  await expect(page.getByTestId("incident-status")).toContainText(en.operational.phase.in_progress);
  await expect(page.getByTestId("incident-satellite")).toContainText(en.operational.linkedDetectionsLabel);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
