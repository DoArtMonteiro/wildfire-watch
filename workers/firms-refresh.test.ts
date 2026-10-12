import assert from "node:assert/strict";
import test from "node:test";
import { refreshFirmsCache, type FirmsIngestEnv } from "./firms-ingest";
import { FIRMS_CACHE_KEY, FIRMS_INGEST_HEALTH_KEY } from "../src/lib/wildfire/firms-cache";
import { parseIngestHealth, type IngestHealthRecord } from "../src/lib/wildfire/ingest-health";
import type { AlertChannel } from "../src/lib/monitoring/alert-channels";

const MAP_KEY = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
const HOUR = 60 * 60 * 1_000;

class FakeKv {
  readonly store = new Map<string, string>();
  readonly writes: string[] = [];
  readonly failingKeys = new Set<string>();

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.store.get(key) ?? null;
    return type === "json" && value !== null ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.failingKeys.has(key)) throw new Error("KV put failed: 429 Too Many Requests");
    this.writes.push(key);
    this.store.set(key, value);
  }
}

function env(kv: FakeKv, mapKey = MAP_KEY): FirmsIngestEnv {
  return { FIRMS_CACHE: kv as unknown as FirmsIngestEnv["FIRMS_CACHE"], FIRMS_MAP_KEY: mapKey };
}

/** A synthetic worldwide feed: enough distinct detections, spread over enough bands, to pass the global guard. */
function worldCsv(rows: number): string {
  const day = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
  const lines = ["latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight"];
  for (let index = 0; index < rows; index += 1) {
    const lat = (-55 + (index % 60) * 2 + (index % 7) * 0.01).toFixed(4);
    const lng = (-178 + Math.floor(index / 60) % 120 * 3 + (index % 11) * 0.01).toFixed(4);
    const time = String(index % 2_400).padStart(4, "0").replace(/^(\d\d)([6-9]\d)$/, "$100");
    lines.push(`${lat},${lng},330,0.4,0.4,${day},${time},N,VIIRS,n,2.0NRT,290,${(6 + (index % 90)).toFixed(1)},D`);
  }
  return `${lines.join("\n")}\n`;
}

function withFetch(handler: (url: string) => Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(input instanceof Request ? input.url : String(input))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

function storedHealth(kv: FakeKv): IngestHealthRecord {
  const record = parseIngestHealth(JSON.parse(kv.store.get(FIRMS_INGEST_HEALTH_KEY) ?? "null"));
  assert.ok(record, "a valid health record must be stored");
  return record;
}

function recordingChannel(): { channel: AlertChannel; sent: string[] } {
  const sent: string[] = [];
  return { sent, channel: { name: "discord", send: async (text) => { sent.push(text); return new Response(null, { status: 204 }); } } };
}

test("a successful run writes the snapshot and a v2 health record", async () => {
  const kv = new FakeKv();
  const restore = withFetch(async () => new Response(worldCsv(6_000), { status: 200 }));
  try {
    const report = await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    assert.equal(report.health.outcome, "success");
    assert.ok(report.payload && report.payload.points.length >= 5_000);
    assert.ok(kv.store.has(FIRMS_CACHE_KEY));
    const health = storedHealth(kv);
    assert.equal(health.consecutiveFailures, 0);
    assert.equal(health.lastSuccessAt, "2026-10-02T13:00:00.000Z");
    assert.equal(health.selectedPoints, report.payload.points.length);
  } finally {
    restore();
  }
});

test("an upstream failure keeps the last known-good snapshot and counts the failure", async () => {
  const kv = new FakeKv();
  kv.store.set(FIRMS_CACHE_KEY, "previous-snapshot");
  kv.store.set(FIRMS_INGEST_HEALTH_KEY, JSON.stringify({
    version: 2, attemptedAt: "2026-10-02T12:00:00.000Z", outcome: "success", consecutiveFailures: 0, lastSuccessAt: "2026-10-02T12:00:00.000Z",
  }));
  const restore = withFetch(async () => new Response("Service Unavailable", { status: 503 }));
  try {
    const report = await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    assert.equal(report.payload, null);
    assert.equal(kv.store.get(FIRMS_CACHE_KEY), "previous-snapshot");
    const health = storedHealth(kv);
    assert.equal(health.outcome, "failure");
    assert.equal(health.errorCode, "http_error");
    assert.equal(health.consecutiveFailures, 1);
    assert.equal(health.lastSuccessAt, "2026-10-02T12:00:00.000Z");
  } finally {
    restore();
  }
});

test("a network error never stores or logs the map key", async () => {
  const kv = new FakeKv();
  const logged: string[] = [];
  const originals = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  const restore = withFetch(async (url) => { throw new TypeError(`fetch failed for ${url}`); });
  try {
    const report = await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    assert.equal(report.health.errorCode, "network");
  } finally {
    restore();
    Object.assign(console, originals);
  }
  for (const value of [...kv.store.values(), ...logged]) assert.ok(!value.includes(MAP_KEY), "the map key leaked");
});

test("a regional or truncated feed is refused and the counts are recorded", async () => {
  const kv = new FakeKv();
  kv.store.set(FIRMS_CACHE_KEY, "previous-snapshot");
  const restore = withFetch(async () => new Response(worldCsv(40), { status: 200 }));
  try {
    const report = await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    assert.equal(report.health.errorCode, "incomplete_feed");
    assert.equal(report.health.sourceRows, 40);
    assert.equal(kv.store.get(FIRMS_CACHE_KEY), "previous-snapshot");
  } finally {
    restore();
  }
});

test("a failed snapshot write is reported as a storage error", async () => {
  const kv = new FakeKv();
  kv.failingKeys.add(FIRMS_CACHE_KEY);
  const restore = withFetch(async () => new Response(worldCsv(6_000), { status: 200 }));
  try {
    const report = await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    assert.equal(report.health.errorCode, "storage_error");
    assert.equal(storedHealth(kv).outcome, "failure");
  } finally {
    restore();
  }
});

test("a missing map key is recorded without calling NASA", async () => {
  const kv = new FakeKv();
  let calls = 0;
  const restore = withFetch(async () => { calls += 1; return new Response("", { status: 200 }); });
  try {
    const report = await refreshFirmsCache(env(kv, " "), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    assert.equal(report.health.errorCode, "configuration");
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test("three hourly failures alert once; the next success sends one recovery", async () => {
  const kv = new FakeKv();
  const { channel, sent } = recordingChannel();
  let upstreamUp = false;
  const restore = withFetch(async (url) => {
    if (url.startsWith("https://firms.modaps.eosdis.nasa.gov/")) {
      return upstreamUp ? new Response(worldCsv(6_000), { status: 200 }) : new Response("", { status: 500 });
    }
    throw new Error(`unexpected request to ${url}`);
  });
  const start = Date.parse("2026-10-02T10:00:00.000Z");
  try {
    for (let hour = 0; hour < 4; hour += 1) {
      await refreshFirmsCache(env(kv), { now: () => start + hour * HOUR, channels: [channel] });
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0], /FIRMS refresh failing/);
    assert.equal(storedHealth(kv).consecutiveFailures, 4);
    assert.ok(storedHealth(kv).alerts?.failureNotifiedAt);

    upstreamUp = true;
    await refreshFirmsCache(env(kv), { now: () => start + 4 * HOUR, channels: [channel] });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /recovered/);
    assert.equal(storedHealth(kv).alerts, undefined);
  } finally {
    restore();
  }
});

test("a run that finds no attempt for hours reports the stall before doing any work", async () => {
  const kv = new FakeKv();
  kv.store.set(FIRMS_INGEST_HEALTH_KEY, JSON.stringify({
    version: 2, attemptedAt: "2026-10-02T08:00:00.000Z", outcome: "success", consecutiveFailures: 0, lastSuccessAt: "2026-10-02T08:00:00.000Z",
  }));
  const { channel, sent } = recordingChannel();
  const order: string[] = [];
  const restore = withFetch(async () => {
    order.push(`fetch after ${sent.length} alert(s)`);
    return new Response("", { status: 500 });
  });
  try {
    await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z"), channels: [channel] });
  } finally {
    restore();
  }
  assert.match(sent[0], /FIRMS refresh not running/);
  assert.deepEqual(order, ["fetch after 1 alert(s)"]);
  assert.ok(storedHealth(kv).alerts?.stalledNotifiedAt);
});

test("a successful run also stores the compact index of detections in mainland Portugal for the reconciliation", async () => {
  const { FUSION_INDEX_KEY, readFusionIndex } = await import("../src/lib/operational/incidents-cache");
  const { ANEPC_COVERAGE } = await import("../src/lib/operational/anepc");
  const kv = new FakeKv();
  const restore = withFetch(async () => new Response(worldCsv(6_000), { status: 200 }));
  try {
    const report = await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    const index = readFusionIndex(JSON.parse(kv.store.get(FUSION_INDEX_KEY) ?? "null"));
    assert.ok(index && index.observations.length > 0);
    assert.equal(index.firmsGeneratedAt, report.payload?.generatedAt);
    for (const { location } of index.observations) {
      assert.ok(location.lat >= ANEPC_COVERAGE.south && location.lat <= ANEPC_COVERAGE.north && location.lng >= ANEPC_COVERAGE.west && location.lng <= ANEPC_COVERAGE.east);
    }
    assert.ok(storedHealth(kv).signals, "the run is counted for the daily summary");
  } finally {
    restore();
  }
});

test("a failing index write never fails the FIRMS run", async () => {
  const { FUSION_INDEX_KEY } = await import("../src/lib/operational/incidents-cache");
  const kv = new FakeKv();
  kv.failingKeys.add(FUSION_INDEX_KEY);
  const restore = withFetch(async () => new Response(worldCsv(6_000), { status: 200 }));
  try {
    const report = await refreshFirmsCache(env(kv), { now: () => Date.parse("2026-10-02T13:00:00.000Z") });
    assert.equal(report.health.outcome, "success");
  } finally {
    restore();
  }
});
