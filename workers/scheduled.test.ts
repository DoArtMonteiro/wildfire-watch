import assert from "node:assert/strict";
import test from "node:test";
import { DIGEST_STATE_KEY, FIRMS_CRON, OPERATIONAL_CRON, runScheduled, type ScheduledEnv } from "./scheduled";
import { FIRMS_CACHE_KEY, FIRMS_INGEST_HEALTH_KEY } from "../src/lib/wildfire/firms-cache";
import { INCIDENTS_CACHE_KEY, INCIDENTS_INGEST_HEALTH_KEY, parseIncidentsPayload } from "../src/lib/operational/incidents-cache";
import { parseIngestHealth } from "../src/lib/wildfire/ingest-health";
import type { AlertChannel } from "../src/lib/monitoring/alert-channels";

const MAP_KEY = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

class FakeKv {
  readonly store = new Map<string, string>();
  readonly failingReads = new Set<string>();
  readonly failingWrites = new Set<string>();
  async get(key: string, type?: "json"): Promise<unknown> {
    if (this.failingReads.has(key)) throw new Error("KV read failed");
    const value = this.store.get(key) ?? null;
    return type === "json" && value !== null ? JSON.parse(value) : value;
  }
  async put(key: string, value: string): Promise<void> {
    if (this.failingWrites.has(key)) throw new Error("KV put() limit exceeded for the day");
    this.store.set(key, value);
  }
}

function env(kv: FakeKv): ScheduledEnv {
  return { FIRMS_CACHE: kv as unknown as ScheduledEnv["FIRMS_CACHE"], FIRMS_MAP_KEY: MAP_KEY };
}

/** Worldwide synthetic feed with a detection near the ANEPC occurrence below. */
function worldCsv(now: number): string {
  const day = new Date(now - 6 * 3_600_000).toISOString().slice(0, 10);
  const lines = ["latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight"];
  for (let index = 0; index < 6_000; index += 1) {
    const lat = (-55 + (index % 60) * 2 + (index % 7) * 0.01).toFixed(4);
    const lng = (-178 + Math.floor(index / 60) % 120 * 3 + (index % 11) * 0.01).toFixed(4);
    lines.push(`${lat},${lng},330,0.4,0.4,${day},0900,N,VIIRS,n,2.0NRT,290,${(6 + (index % 90)).toFixed(1)},D`);
  }
  lines.push(`40.2250,-8.0500,360,0.4,0.4,${day},0900,N,VIIRS,h,2.0NRT,300,912.4,D`);
  return `${lines.join("\n")}\n`;
}

function occurrences(now: number): string {
  return JSON.stringify({ features: [{
    attributes: { Numero: "1", EstadoAgrupado: "Em Curso", CodNatureza: "3101", DataOcorrencia: now - 8 * 3_600_000, Concelho: "Arganil" },
    geometry: { x: -8.05, y: 40.22 },
  }] });
}

function withUpstreams(options: { firms: "up" | "down"; anepc: "up" | "down" }, now: number): { restore: () => void; hosts: string[] } {
  const original = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    hosts.push(url.hostname);
    if (url.hostname === "firms.modaps.eosdis.nasa.gov") {
      return options.firms === "up" ? new Response(worldCsv(now), { status: 200 }) : new Response("", { status: 500 });
    }
    if (url.pathname.includes("/FeatureServer/")) {
      return options.anepc === "up" ? new Response(occurrences(now), { status: 200 }) : new Response("", { status: 503 });
    }
    throw new Error(`unexpected request to ${url.hostname}`);
  }) as typeof fetch;
  return { hosts, restore: () => { globalThis.fetch = original; } };
}

function health(kv: FakeKv, key: string) {
  return parseIngestHealth(JSON.parse(kv.store.get(key) ?? "null"));
}

async function run(cron: string, kv: FakeKv, at: number, options: { firms: "up" | "down"; anepc: "up" | "down" }): Promise<string[]> {
  const upstreams = withUpstreams(options, at);
  try {
    await runScheduled(cron, env(kv), { now: () => at, channels: [] });
  } finally {
    upstreams.restore();
  }
  return upstreams.hosts;
}

test("FIRMS and ANEPC run in separate invocations; ANEPC reconciles against the index FIRMS stored", async () => {
  const kv = new FakeKv();
  const hourly = Date.parse("2026-08-12T15:00:00.000Z");
  const firmsHosts = await run(FIRMS_CRON, kv, hourly, { firms: "up", anepc: "up" });
  assert.ok(!firmsHosts.some((host) => host.includes("arcgis")), "the FIRMS invocation never calls ANEPC");
  assert.ok(kv.store.has(FIRMS_CACHE_KEY));
  assert.ok(!kv.store.has(INCIDENTS_CACHE_KEY));

  const operationalHosts = await run(OPERATIONAL_CRON, kv, hourly + 5 * 60_000, { firms: "up", anepc: "up" });
  assert.ok(!operationalHosts.includes("firms.modaps.eosdis.nasa.gov"), "the ANEPC invocation never calls FIRMS");
  const firms = JSON.parse(kv.store.get(FIRMS_CACHE_KEY) ?? "null");
  const incidents = parseIncidentsPayload(JSON.parse(kv.store.get(INCIDENTS_CACHE_KEY) ?? "null"));
  assert.equal(incidents?.fusedWith?.firmsGeneratedAt, firms.generatedAt);
  assert.equal(incidents?.reconciliation.incidents[0].satellite, "recent");
  assert.equal(health(kv, FIRMS_INGEST_HEALTH_KEY)?.outcome, "success");
  assert.equal(health(kv, INCIDENTS_INGEST_HEALTH_KEY)?.outcome, "success");
});
test("one source failing never stops or alters the other", async () => {
  const hourly = Date.parse("2026-08-12T15:00:00.000Z");
  const firmsDown = new FakeKv();
  await run(FIRMS_CRON, firmsDown, hourly, { firms: "down", anepc: "up" });
  await run(OPERATIONAL_CRON, firmsDown, hourly + 5 * 60_000, { firms: "down", anepc: "up" });
  assert.equal(health(firmsDown, FIRMS_INGEST_HEALTH_KEY)?.outcome, "failure");
  assert.equal(health(firmsDown, INCIDENTS_INGEST_HEALTH_KEY)?.outcome, "success");
  assert.equal(parseIncidentsPayload(JSON.parse(firmsDown.store.get(INCIDENTS_CACHE_KEY) ?? "null"))?.fusedWith, null, "stored, honestly unreconciled");

  const anepcDown = new FakeKv();
  await run(FIRMS_CRON, anepcDown, hourly, { firms: "up", anepc: "down" });
  await run(OPERATIONAL_CRON, anepcDown, hourly + 5 * 60_000, { firms: "up", anepc: "down" });
  assert.equal(health(anepcDown, FIRMS_INGEST_HEALTH_KEY)?.outcome, "success");
  assert.equal(health(anepcDown, INCIDENTS_INGEST_HEALTH_KEY)?.outcome, "failure");
  assert.ok(anepcDown.store.has(FIRMS_CACHE_KEY));
});
test("the daily summary is sent once, only with something to report, and starts a new window", async () => {
  const sent: string[] = [];
  const channel: AlertChannel = { name: "telegram", send: async (text) => { sent.push(text); return new Response(null, { status: 200 }); } };
  const kv = new FakeKv();
  const day = Date.parse("2026-08-12T00:00:00.000Z");
  // Every scheduled run from fromHour:00 to toHour:05: FIRMS at :00, ANEPC at :05, :20, :35 and :50.
  const quarters = (fromHour: number, toHour: number) => Array.from({ length: (toHour - fromHour) * 60 + 6 }, (_, minute) => day + fromHour * 3_600_000 + minute * 60_000)
    .filter((at) => [0, 5, 20, 35, 50].includes(new Date(at).getUTCMinutes()));
  // Two short ANEPC outages before 07:00 UTC that recovered before alerting.
  const anepcDownAt = new Set([day + 5 * 3_600_000 + 20 * 60_000, day + 5 * 3_600_000 + 50 * 60_000]);

  async function runAt(at: number): Promise<void> {
    const cron = new Date(at).getUTCMinutes() === 0 ? FIRMS_CRON : OPERATIONAL_CRON;
    const upstreams = withUpstreams({ firms: "up", anepc: anepcDownAt.has(at) ? "down" : "up" }, at);
    try {
      await runScheduled(cron, env(kv), { now: () => at, channels: [channel] });
    } finally {
      upstreams.restore();
    }
  }

  for (const at of quarters(5, 7)) {
    await runAt(at);
    if (at < day + 7 * 3_600_000) assert.deepEqual(sent, [], "nothing urgent before the summary hour");
  }
  assert.equal(sent.length, 1, sent.join("\n---\n"));
  assert.match(sent[0], /Daily operations summary/);
  assert.match(sent[0], /ANEPC: 2 failed attempts, 2 recovered before an alert/);
  assert.doesNotMatch(sent[0], /FIRMS:/, "a source with nothing to report is not mentioned");
  assert.ok(kv.store.has(DIGEST_STATE_KEY));

  // The rest of the day: a new, quiet window, and no second summary.
  for (const at of quarters(7, 9).filter((at) => at > day + 7 * 3_600_000 + 5 * 60_000)) await runAt(at);
  assert.equal(sent.length, 1);
  assert.equal(health(kv, INCIDENTS_INGEST_HEALTH_KEY)?.signals?.failedAttempts, 0);
});

test("the daily summary is never repeated when its state cannot be read or written", async () => {
  const at = Date.parse("2026-08-12T07:00:00.000Z");
  for (const failure of ["read", "write"] as const) {
    const sent: string[] = [];
    const channel: AlertChannel = { name: "telegram", send: async (text) => { sent.push(text); return new Response(null, { status: 200 }); } };
    const kv = new FakeKv();
    // Something worth reporting is waiting.
    kv.store.set(INCIDENTS_INGEST_HEALTH_KEY, JSON.stringify({
      version: 2, attemptedAt: new Date(at - 15 * 60_000).toISOString(), outcome: "success", consecutiveFailures: 0,
      lastSuccessAt: new Date(at - 15 * 60_000).toISOString(),
      signals: { since: new Date(at - 24 * 3_600_000).toISOString(), failedAttempts: 0, recoveredBeforeAlert: 0, invalidRecords: 4, truncatedResponses: 0, unrecognisedPhases: [], slowAttempts: 0 },
    }));
    (failure === "read" ? kv.failingReads : kv.failingWrites).add(DIGEST_STATE_KEY);
    for (const hour of [0, 1, 2]) {
      const now = at + hour * 3_600_000;
      const upstreams = withUpstreams({ firms: "up", anepc: "up" }, now);
      try {
        await runScheduled(FIRMS_CRON, env(kv), { now: () => now, channels: [channel] });
      } finally {
        upstreams.restore();
      }
    }
    assert.deepEqual(sent.filter((text) => /Daily operations summary/.test(text)), [], failure);
  }
});
