import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import en from "../src/lib/i18n/en";
import pt from "../src/lib/i18n/pt";
import { rewriteFeed, stubThirdParties, watchCspViolations } from "./support/stubs";
import { waitForServer } from "./support/server";

const MINUTE = 60_000;
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

let cspViolations: string[] = [];

test.beforeEach(async ({ request }, testInfo) => waitForServer(request, testInfo));

test.beforeEach(async ({ page }) => {
  cspViolations = await watchCspViolations(page);
  await stubThirdParties(page);
});

test.afterEach(() => {
  expect(cspViolations, "the Content Security Policy blocked a request").toEqual([]);
});

async function openHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("feed-health-badge")).toHaveAttribute("data-state", "healthy");
}

function healthBadge(page: Page) {
  return page.getByTestId("feed-health-badge");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // The WebGL canvas is drawn pixels; its accessible alternative is the panel.
    .exclude(".maplibregl-canvas")
    .analyze();
  return results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
}

test("loads the synthetic feed in Portuguese, served with security headers", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");

  await expect(page.locator("html")).toHaveAttribute("lang", "pt-PT");
  expect((await page.request.get("/favicon.ico")).status()).toBe(200);
  await expect(healthBadge(page)).toHaveAttribute("data-state", "healthy");
  await expect(healthBadge(page)).toHaveText(pt.overview.healthHealthy);
  await expect(page.getByRole("heading", { name: pt.overview.strongestTitle })).toBeVisible();
  await expect(page.getByRole("button", { name: /912,4 MW/ })).toBeVisible();
  await expect(page.getByText(pt.overview.sampleNote)).toBeVisible();
});

test("switches the interface to English", async ({ page }) => {
  await openHome(page);
  await page.getByRole("group", { name: pt.topBar.languageToggleLabel }).getByRole("button", { name: /^en\b/i }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: en.overview.strongestTitle })).toBeVisible();
  await expect(healthBadge(page)).toHaveText(en.overview.healthHealthy);
  await expect(page.getByRole("button", { name: /912\.4 MW/ })).toBeVisible();
});

test("toggles between dark and light themes and remembers the choice", async ({ page }) => {
  await openHome(page);
  const html = page.locator("html");
  await expect(html).toHaveClass(/\bdark\b/);

  await page.getByRole("switch", { name: pt.topBar.themeToggleLabel }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(html).not.toHaveClass(/\bdark\b/);
});

test("the skip link moves keyboard focus to the information panel", async ({ page }) => {
  await openHome(page);
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: pt.panel.skipToPanel });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#mission-control-panel-content")).toBeFocused();
});

test("selects a detection from the keyboard and explains what is known about it", async ({ page }) => {
  await openHome(page);
  const strongest = page.getByRole("button", { name: /912,4 MW/ });
  await strongest.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: pt.fireDetail.pointTitle })).toBeVisible();

  // The satellite reports heat only; the status comes from the official occurrence it is linked to.
  const status = page.getByTestId("operational-status");
  await expect(status).toContainText(pt.operational.phase.in_progress);
  await expect(status).toContainText(pt.operational.reportedBy);
  await expect(status.getByTestId("operational-detail")).toHaveAttribute("data-state", "matched");

  const observation = page.getByRole("region", { name: pt.fireDetail.satelliteTelemetryTitle });
  await expect(observation).toContainText("912,4 MW");
  await expect(observation).toContainText(pt.basis.measured);
  await expect(observation).toContainText(pt.confidence.high);

  const provenance = page.getByTestId("detection-provenance");
  await expect(provenance).toContainText("NASA FIRMS · VIIRS_SNPP_NRT");
  await expect(provenance).toContainText("VIIRS");

  await expect(page.getByText("27,4 °C")).toBeVisible();
  await expect(page.getByText(pt.fireDetail.weatherModelNote, { exact: false })).toBeVisible();
  await expect(page.getByTestId("air-quality-reading")).toContainText("116");
  await expect(page.getByRole("link", { name: /Incêndio em Arganil/ })).toBeVisible();
  await expect(page.getByText("Arganil/Coimbra, Portugal").first()).toBeVisible();

  await page.getByRole("button", { name: pt.fireDetail.closeLabel }).click();
  await expect(page.getByRole("heading", { name: pt.overview.strongestTitle })).toBeVisible();
});

test("a failed refresh over a recent snapshot reads as degraded, not current", async ({ page }) => {
  await rewriteFeed(page, (payload) => ({
    ...payload,
    ingestHealth: {
      version: 2,
      attemptedAt: new Date(Date.now() - 5 * MINUTE).toISOString(),
      outcome: "failure",
      errorCode: "http_error",
      consecutiveFailures: 1,
      lastSuccessAt: new Date(Date.parse(String(payload.generatedAt)) - 40_000).toISOString(),
    },
  }));
  await page.goto("/");

  await expect(healthBadge(page)).toHaveAttribute("data-state", "degraded");
  await expect(healthBadge(page)).toHaveText(pt.overview.healthDegraded);
  await expect(page.getByTestId("feed-health-message")).toContainText(pt.overview.degradedDetail.split("{time}")[0].trim());
});

test("an old snapshot reads as out of date even when the last recorded refresh succeeded", async ({ page }) => {
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * MINUTE).toISOString();
  await rewriteFeed(page, (payload) => ({
    ...payload,
    generatedAt: fiveHoursAgo,
    ingestHealth: { version: 2, attemptedAt: fiveHoursAgo, outcome: "success", consecutiveFailures: 0, lastSuccessAt: fiveHoursAgo },
  }));
  await page.goto("/");

  await expect(healthBadge(page)).toHaveAttribute("data-state", "stale");
  await expect(healthBadge(page)).toHaveText(pt.overview.healthStale);
});

test("an unavailable feed is reported, with a retry, instead of an empty map", async ({ page }) => {
  await page.route("**/api/fires", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Fire cache unavailable"}' }));
  await page.goto("/");

  await expect(page.getByText(pt.map.errorTitle)).toBeVisible();
  await expect(page.getByRole("button", { name: pt.map.retryLabel })).toBeVisible();
  await expect(healthBadge(page)).toHaveAttribute("data-state", "unavailable");
});

test("fits a 390 px phone without horizontal scrolling, in both views", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // On phones the panel starts collapsed so the map is visible first.
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: pt.panel.expand }).click();
  await expect(healthBadge(page)).toHaveAttribute("data-state", "healthy");
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: /912,4 MW/ }).click();
  await expect(page.getByRole("heading", { name: pt.fireDetail.pointTitle })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("legal pages are linked from the panel and readable", async ({ page }) => {
  await openHome(page);
  const legalNav = page.getByRole("navigation", { name: pt.legal.navLabel });
  for (const [label, path] of [[pt.legal.about, "/sobre"], [pt.legal.privacy, "/privacidade"], [pt.legal.terms, "/termos"]] as const) {
    await expect(legalNav.getByRole("link", { name: label })).toHaveAttribute("href", path);
  }

  await legalNav.getByRole("link", { name: pt.legal.privacy }).click();
  await expect(page).toHaveURL(/\/privacidade$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  for (const path of ["/sobre", "/termos"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});

test("has no automatically detectable WCAG 2.2 AA violations", async ({ page }) => {
  await openHome(page);
  expect(await axeViolations(page), "global overview").toEqual([]);

  await page.getByRole("button", { name: /912,4 MW/ }).click();
  await expect(page.getByTestId("operational-status")).toBeVisible();
  await expect(page.getByTestId("air-quality-reading")).toBeVisible();
  expect(await axeViolations(page), "detection detail").toEqual([]);

  await page.goto("/privacidade");
  expect(await axeViolations(page), "privacy page").toEqual([]);
});
