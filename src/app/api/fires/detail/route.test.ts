import assert from "node:assert/strict";
import test from "node:test";
import { createDetailLookups, handleFireDetailRequest, resolveFirmsMapKey } from "./route";

// ---------------------------------------------------------------------------
// Environment: each test gets its own in-memory cache and FIRMS call budget.
// ---------------------------------------------------------------------------

function makeEnv(mapKey: string, lookups = createDetailLookups()): { FIRMS_MAP_KEY: string; lookups: ReturnType<typeof createDetailLookups> } {
  return { FIRMS_MAP_KEY: mapKey, lookups };
}

// ---------------------------------------------------------------------------
// CSV fixture helpers
// ---------------------------------------------------------------------------

function makeCsv(rowCount: number): string {
  const header = "latitude,longitude,frp,confidence,acq_date,acq_time";
  // Produce valid HHMM timestamps by computing total minutes from midnight,
  // ensuring each time passes the hours<=23 and minutes<=59 filters.
  const rows = Array.from({ length: rowCount }, (_, i) => {
    // Spread unique lat/lng so dedup never collapses them.
    const lat = -10 + (i % 1000) * 0.001;
    const lng = -60 + Math.floor(i / 1000) * 0.001;
    // Generate a valid HHMM time: advance by 1 minute per row, wrapping
    // within a 24-hour window but keeping dates consistent.
    const totalMinutes = (720 + i) % (24 * 60); // start at noon, never overflow
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const time = `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
    return `${lat},${lng},${10 + (i % 100)},90,2026-08-01,${time}`;
  });
  return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

function request(query: string): Request {
  return new Request(`http://localhost/api/fires/detail?${query}`);
}

function validParams(overrides: Record<string, string> = {}): string {
  return new URLSearchParams({
    west: "-10.5",
    south: "37.0",
    east: "-8.5",
    north: "39.0",
    ...overrides,
  }).toString();
}

// ---------------------------------------------------------------------------
// Param validation — 400 rejections
// ---------------------------------------------------------------------------

test("rejects missing west parameter", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("south=37.0&east=-8.5&north=39.0"),
    env,
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.ok(body.error.toLowerCase().includes("west"));
});

test("rejects NaN coordinate (non-numeric string)", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("west=abc&south=37.0&east=-8.5&north=39.0"),
    env,
  );
  assert.equal(res.status, 400);
});

test("rejects out-of-range longitude", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("west=-200&south=37.0&east=-8.5&north=39.0"),
    env,
  );
  assert.equal(res.status, 400);
});

test("rejects out-of-range latitude", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("west=-10.5&south=-100&east=-8.5&north=39.0"),
    env,
  );
  assert.equal(res.status, 400);
});

test("rejects inverted bbox (east <= west)", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("west=-8.5&south=37.0&east=-10.5&north=39.0"),
    env,
  );
  assert.equal(res.status, 400);
});

test("rejects inverted bbox (north <= south)", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("west=-10.5&south=39.0&east=-8.5&north=37.0"),
    env,
  );
  assert.equal(res.status, 400);
});

test("rejects days outside the 1-5 range FIRMS accepts", async () => {
  const env = makeEnv("test-key");
  const resHigh = await handleFireDetailRequest(
    request(validParams({ days: "6" })),
    env,
  );
  assert.equal(resHigh.status, 400);

  const resLow = await handleFireDetailRequest(
    request(validParams({ days: "0" })),
    env,
  );
  assert.equal(resLow.status, 400);
});

test("rejects non-integer days", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request(validParams({ days: "2.5" })),
    env,
  );
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Oversized bbox rejection
// ---------------------------------------------------------------------------

test("rejects bbox whose longitude span exceeds 5 degrees", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("west=-15.0&south=37.0&east=-9.0&north=39.0"),
    env,
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.ok(body.error.toLowerCase().includes("too large") || body.error.toLowerCase().includes("span"));
});

test("rejects bbox whose latitude span exceeds 5 degrees", async () => {
  const env = makeEnv("test-key");
  const res = await handleFireDetailRequest(
    request("west=-10.5&south=33.0&east=-8.5&north=39.0"),
    env,
  );
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Missing map key -> 503
// ---------------------------------------------------------------------------

test("returns 503 when FIRMS_MAP_KEY is empty", async () => {
  const env = makeEnv("");
  const res = await handleFireDetailRequest(request(validParams()), env);
  assert.equal(res.status, 503);
  const body = await res.json() as { error: string };
  // Must not expose the key or the upstream URL in the error message.
  assert.ok(!body.error.includes("http"));
  assert.ok(!body.error.includes("firms.modaps"));
});

test("returns 503 when FIRMS_MAP_KEY is whitespace-only", async () => {
  const env = makeEnv("   ");
  const res = await handleFireDetailRequest(request(validParams()), env);
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// Happy path — no downsampling
// ---------------------------------------------------------------------------

test("returns all 3000 points without downsampling", async () => {
  const originalFetch = globalThis.fetch;
  const ROW_COUNT = 3_000;
  globalThis.fetch = async () => new Response(makeCsv(ROW_COUNT), {
    status: 200,
    headers: { "Content-Type": "text/csv" },
  });

  try {
    const env = makeEnv("valid-key");
    const res = await handleFireDetailRequest(request(validParams()), env);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");

    const body = await res.json() as {
      version: number;
      source: string;
      bbox: number[];
      days: number;
      points: Array<{ id: string; lat: number; lng: number; frpMw: number }>;
    };

    assert.equal(body.version, 1);
    assert.equal(body.source, "NASA FIRMS VIIRS_NOAA20_NRT");
    assert.equal(body.points.length, ROW_COUNT, "all rows must be returned without downsampling");
    assert.deepEqual(body.bbox, [-10.5, 37.0, -8.5, 39.0]);
    assert.equal(body.days, 3);

    // Verify point shape
    const first = body.points[0];
    assert.equal(typeof first.id, "string");
    assert.ok(first.id.startsWith("firms-"));
    assert.equal(typeof first.frpMw, "number");
    assert.ok(first.frpMw > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upstream URL is never exposed in responses or logs", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    return new Response("bad gateway", { status: 502 });
  };

  try {
    const env = makeEnv("my-secret-key");
    const res = await handleFireDetailRequest(request(validParams()), env);

    // Key must appear in the upstream URL (confirm fetch was called) but must
    // NOT appear in the response body.
    assert.ok(capturedUrl.includes("my-secret-key"), "fetch must use the map key");

    const body = await res.text();
    assert.ok(!body.includes("my-secret-key"), "key must not leak into response body");
    assert.ok(!body.includes("firms.modaps"), "upstream URL must not leak into response body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Safety cap
// ---------------------------------------------------------------------------

test("caps response at 20,000 points when upstream returns more", async () => {
  const originalFetch = globalThis.fetch;
  const OVER_LIMIT = 25_000;
  globalThis.fetch = async () => new Response(makeCsv(OVER_LIMIT), {
    status: 200,
    headers: { "Content-Type": "text/csv" },
  });

  try {
    const env = makeEnv("valid-key");
    const res = await handleFireDetailRequest(request(validParams()), env);

    assert.equal(res.status, 200);
    const body = await res.json() as { points: unknown[] };
    assert.equal(body.points.length, 20_000, "safety cap must be applied at 20,000 points");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Caching, quantisation and the upstream budget
// ---------------------------------------------------------------------------

test("serves a repeated or nearly identical box from memory without calling NASA again", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return new Response(makeCsv(5), { status: 200, headers: { "Content-Type": "text/csv" } });
  };

  try {
    const env = makeEnv("valid-key");
    const first = await handleFireDetailRequest(request(validParams({ west: "-10.53", east: "-8.47" })), env);
    const second = await handleFireDetailRequest(request(validParams({ west: "-10.51", east: "-8.42" })), env);

    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-wildfire-source"), "nasa-firms");
    assert.equal(second.headers.get("x-wildfire-source"), "memory");
    assert.equal(requested.length, 1, "both boxes snap to the same 0.1° grid");
    assert.ok(requested[0].includes("/-10.6,37,-8.4,39/3"), requested[0]);
    const body = await second.json() as { bbox: number[] };
    assert.deepEqual(body.bbox, [-10.6, 37, -8.4, 39]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("answers 503 with Retry-After once this isolate's FIRMS budget is spent", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(makeCsv(1), { status: 200, headers: { "Content-Type": "text/csv" } });
  };

  try {
    const env = makeEnv("valid-key");
    const statuses: number[] = [];
    for (let index = 0; index < 22; index += 1) {
      const response = await handleFireDetailRequest(request(validParams({ west: String(-10 - index * 0.2), east: String(-9 - index * 0.2) })), env);
      statuses.push(response.status);
      if (response.status === 503) assert.ok(Number(response.headers.get("retry-after")) >= 1);
    }
    assert.equal(calls, 20);
    assert.deepEqual(statuses.slice(-2), [503, 503]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a network error never logs the map key", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logged: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    throw new TypeError(`fetch failed: ${input instanceof Request ? input.url : String(input)}`);
  };
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };

  try {
    const res = await handleFireDetailRequest(request(validParams()), makeEnv("my-secret-key"));
    assert.equal(res.status, 502);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  assert.ok(logged.length > 0);
  assert.ok(logged.every((line) => !line.includes("my-secret-key")), logged.join("\n"));
});

// ---------------------------------------------------------------------------
// days default
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveFirmsMapKey — key resolution fallback
// ---------------------------------------------------------------------------

test("resolveFirmsMapKey returns the binding value when it is non-empty", () => {
  // Binding is present (deployed Worker) — process.env must be ignored.
  const original = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = "env-key-should-not-be-used";
  try {
    assert.equal(resolveFirmsMapKey("binding-key"), "binding-key");
  } finally {
    if (original === undefined) {
      delete process.env.FIRMS_MAP_KEY;
    } else {
      process.env.FIRMS_MAP_KEY = original;
    }
  }
});

test("resolveFirmsMapKey falls back to process.env when binding is empty (next dev path)", () => {
  // Simulates `next dev`: binding resolved to "" (secret absent from wrangler.jsonc vars),
  // but .env.local has FIRMS_MAP_KEY set — process.env carries it.
  const original = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = "env-local-key";
  try {
    assert.equal(resolveFirmsMapKey(""), "env-local-key");
  } finally {
    if (original === undefined) {
      delete process.env.FIRMS_MAP_KEY;
    } else {
      process.env.FIRMS_MAP_KEY = original;
    }
  }
});

test("resolveFirmsMapKey falls back to process.env when binding is undefined", () => {
  const original = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = "env-only-key";
  try {
    assert.equal(resolveFirmsMapKey(undefined), "env-only-key");
  } finally {
    if (original === undefined) {
      delete process.env.FIRMS_MAP_KEY;
    } else {
      process.env.FIRMS_MAP_KEY = original;
    }
  }
});

test("resolveFirmsMapKey returns empty string when both sources are absent — handler will 503", () => {
  // Neither binding nor process.env has the key → empty string → 503 in handleFireDetailRequest.
  const original = process.env.FIRMS_MAP_KEY;
  delete process.env.FIRMS_MAP_KEY;
  try {
    assert.equal(resolveFirmsMapKey(""), "");
    assert.equal(resolveFirmsMapKey(undefined), "");
  } finally {
    if (original !== undefined) {
      process.env.FIRMS_MAP_KEY = original;
    }
  }
});

test("resolveFirmsMapKey trims whitespace from both binding and process.env values", () => {
  const original = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = "  env-trimmed  ";
  try {
    // Whitespace-only binding falls through to process.env, which is trimmed.
    assert.equal(resolveFirmsMapKey("   "), "env-trimmed");
    // Non-empty binding is trimmed directly.
    assert.equal(resolveFirmsMapKey("  binding-trimmed  "), "binding-trimmed");
  } finally {
    if (original === undefined) {
      delete process.env.FIRMS_MAP_KEY;
    } else {
      process.env.FIRMS_MAP_KEY = original;
    }
  }
});

// Confirms the full integration: binding empty + env absent → 503, not an uncaught error.
test("returns 503 when both binding and process.env are absent", async () => {
  const original = process.env.FIRMS_MAP_KEY;
  delete process.env.FIRMS_MAP_KEY;
  try {
    // makeEnv("") simulates an empty binding value.
    const env = makeEnv("");
    const res = await handleFireDetailRequest(request(validParams()), env);
    assert.equal(res.status, 503);
    const body = await res.json() as { error: string };
    assert.ok(!body.error.includes("http"));
    assert.ok(!body.error.includes("firms.modaps"));
  } finally {
    if (original !== undefined) {
      process.env.FIRMS_MAP_KEY = original;
    }
  }
});

// ---------------------------------------------------------------------------
// start date — valid, forwarded as trailing URL segment
// ---------------------------------------------------------------------------

test("valid start date is forwarded as the trailing segment in the upstream URL", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    return new Response(makeCsv(1), { status: 200, headers: { "Content-Type": "text/csv" } });
  };

  try {
    const env = makeEnv("valid-key");
    // Use a date 5 days ago — well within the NRT archive window and not in the future.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
    const res = await handleFireDetailRequest(
      request(validParams({ start: fiveDaysAgo })),
      env,
    );
    assert.equal(res.status, 200);
    assert.ok(
      capturedUrl.endsWith(`/${fiveDaysAgo}`),
      `upstream URL must end with /${fiveDaysAgo}, got: ${capturedUrl}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("omitted start preserves the rolling-window URL shape (no trailing date segment)", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    return new Response(makeCsv(1), { status: 200, headers: { "Content-Type": "text/csv" } });
  };

  try {
    const env = makeEnv("valid-key");
    const res = await handleFireDetailRequest(
      // No start param — rely on the default rolling-window behaviour.
      request("west=-10.5&south=37.0&east=-8.5&north=39.0"),
      env,
    );
    assert.equal(res.status, 200);
    // URL must end with /3 (the day-range segment), not /3/<date>.
    assert.ok(
      capturedUrl.endsWith("/3"),
      `upstream URL must end with /3 (no trailing date), got: ${capturedUrl}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// start date — invalid inputs rejected with 400
// ---------------------------------------------------------------------------

test("rejects a malformed start date (not YYYY-MM-DD)", async () => {
  const env = makeEnv("valid-key");
  const res = await handleFireDetailRequest(
    request(validParams({ start: "31-07-2026" })),
    env,
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.ok(body.error.toLowerCase().includes("start"));
});

test("rejects a start date in the future", async () => {
  const env = makeEnv("valid-key");
  // Ten days from now — clearly future, beyond the 6-hour tolerance.
  const tenDaysFromNow = new Date(Date.now() + 10 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const res = await handleFireDetailRequest(
    request(validParams({ start: tenDaysFromNow })),
    env,
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.ok(body.error.toLowerCase().includes("future") || body.error.toLowerCase().includes("start"));
});

test("rejects a start date older than the NRT archive window", async () => {
  const env = makeEnv("valid-key");
  // 100 days ago — well beyond the 60-day NRT archive limit.
  const tooOld = new Date(Date.now() - 100 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const res = await handleFireDetailRequest(
    request(validParams({ start: tooOld })),
    env,
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.ok(body.error.toLowerCase().includes("start") || body.error.toLowerCase().includes("archive") || body.error.toLowerCase().includes("nrt"));
});

// ---------------------------------------------------------------------------
// start date — cache key isolation
// ---------------------------------------------------------------------------

test("requests differing only by start date do not share a cache entry", async () => {
  const originalFetch = globalThis.fetch;
  let nasaCallCount = 0;
  globalThis.fetch = async () => {
    nasaCallCount += 1;
    return new Response(makeCsv(1), { status: 200, headers: { "Content-Type": "text/csv" } });
  };

  try {
    const env = makeEnv("valid-key");
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);

    // First request: with start date.
    const res1 = await handleFireDetailRequest(
      request(validParams({ start: fiveDaysAgo })),
      env,
    );
    assert.equal(res1.status, 200);

    // Second request: no start date (rolling window) — MUST NOT hit the dated cache entry.
    const res2 = await handleFireDetailRequest(
      request(validParams()),
      env,
    );
    assert.equal(res2.status, 200);

    // Both requests must have gone to NASA (two distinct cache keys, neither
    // hits the other's entry).
    assert.equal(nasaCallCount, 2, "each unique start date must have its own cache entry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// days default
// ---------------------------------------------------------------------------

test("defaults days to 3 when the parameter is omitted", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    return new Response(makeCsv(1), {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });
  };

  try {
    const env = makeEnv("valid-key");
    // Omit "days" from the query string.
    const res = await handleFireDetailRequest(
      request("west=-10.5&south=37.0&east=-8.5&north=39.0"),
      env,
    );

    assert.equal(res.status, 200);
    assert.ok(capturedUrl.endsWith("/3"), `upstream URL must end with /3, got: ${capturedUrl}`);

    const body = await res.json() as { days: number };
    assert.equal(body.days, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
