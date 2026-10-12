import assert from "node:assert/strict";
import test from "node:test";
import { refreshOperationalIncidents, type AnepcIngestEnv } from "./anepc-ingest";
import { FIRMS_CACHE_KEY, FIRMS_INGEST_HEALTH_KEY } from "../src/lib/wildfire/firms-cache";
import { FUSION_INDEX_KEY, INCIDENTS_CACHE_KEY, INCIDENTS_INGEST_HEALTH_KEY, parseIncidentsPayload } from "../src/lib/operational/incidents-cache";
import { parseIngestHealth, type IngestHealthRecord } from "../src/lib/wildfire/ingest-health";
import type { AlertChannel } from "../src/lib/monitoring/alert-channels";

const NOW = Date.parse("2026-08-12T15:00:00.000Z");
const QUARTER = 15 * 60_000;
const HOUR = 3_600_000;

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

function env(kv: FakeKv): AnepcIngestEnv {
  return { FIRMS_CACHE: kv as unknown as AnepcIngestEnv["FIRMS_CACHE"] };
}

function occurrences(features: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    features: features.map((attributes) => ({
      attributes: {
        Numero: "2026080012345", EstadoAgrupado: "Em Curso", CodNatureza: "3101", Natureza: "Povoamento Florestal",
        DataOcorrencia: NOW - 3 * HOUR, DataDosDados: NOW - 5 * 60_000, Concelho: "Arganil", Freguesia: "Pomares",
        Operacionais: 84, MeiosTerrestres: 25, MeiosAereos: 2, ...attributes,
      },
      geometry: { x: -8.05, y: 40.22 },
    })),
  });
}

function withFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function storedHealth(kv: FakeKv): IngestHealthRecord {
  const record = parseIngestHealth(JSON.parse(kv.store.get(INCIDENTS_INGEST_HEALTH_KEY) ?? "null"));
  assert.ok(record, "a valid health record must be stored");
  return record;
}

const FUSION = { firmsGeneratedAt: "2026-08-12T14:00:30.000Z", observations: [{ id: "d1", location: { lat: 40.225, lng: -8.05 }, acquiredAt: "2026-08-12T14:10:00.000Z", frpMw: 912.4 }] };

test("a successful run stores the incidents, their reconciliation and a health record, and touches nothing of FIRMS", async () => {
  const kv = new FakeKv();
  const { restore, calls } = withFetch(async () => new Response(occurrences([{}, { Numero: "2", CodNatureza: "2101" }]), { status: 200 }));
  try {
    const report = await refreshOperationalIncidents(env(kv), { now: () => NOW, fusion: FUSION });
    assert.equal(report.health.outcome, "success");
    assert.match(calls[0], /\/FeatureServer\/0\/query\?/);
    const stored = parseIncidentsPayload(JSON.parse(kv.store.get(INCIDENTS_CACHE_KEY) ?? "null"));
    assert.equal(stored?.incidents.length, 1);
    assert.deepEqual(stored?.reconciliation.detections, [{ detectionId: "d1", status: "matched", incidentIds: ["anepc:2026080012345"], distanceKm: 0.6 }]);
    assert.deepEqual(stored?.fusedWith, { firmsGeneratedAt: FUSION.firmsGeneratedAt, detections: 1 });
    const health = storedHealth(kv);
    assert.deepEqual([health.sourceRows, health.filteredRows, health.selectedPoints], [2, 1, 1]);
    const written: string[] = [...kv.writes];
    assert.deepEqual([...new Set(written)].sort(), [INCIDENTS_INGEST_HEALTH_KEY, INCIDENTS_CACHE_KEY].sort());
    assert.ok(!written.includes(FIRMS_CACHE_KEY) && !written.includes(FIRMS_INGEST_HEALTH_KEY));
  } finally {
    restore();
  }
});

test("between FIRMS runs the detections come from the stored fusion index", async () => {
  const kv = new FakeKv();
  kv.store.set(FUSION_INDEX_KEY, JSON.stringify({ version: 1, firmsGeneratedAt: FUSION.firmsGeneratedAt, points: [["d1", 40.225, -8.05, "2026-08-12T14:10:00.000Z", 912.4]] }));
  const { restore } = withFetch(async () => new Response(occurrences([{}]), { status: 200 }));
  try {
    const report = await refreshOperationalIncidents(env(kv), { now: () => NOW });
    assert.equal(report.payload?.reconciliation.incidents[0].satellite, "recent");
    assert.equal(report.payload?.fusedWith?.detections, 1);
  } finally {
    restore();
  }
});

test("with no detections available the incidents are still stored, honestly unreconciled", async () => {
  const kv = new FakeKv();
  const { restore } = withFetch(async () => new Response(occurrences([{}]), { status: 200 }));
  try {
    const report = await refreshOperationalIncidents(env(kv), { now: () => NOW });
    assert.equal(report.payload?.fusedWith, null);
    assert.equal(report.payload?.reconciliation.incidents[0].satellite, "none");
  } finally {
    restore();
  }
});

/** A body that would grow past 5 MiB, in 1 MiB chunks, without declaring its length. */
function oversizedStream(): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= 5) return controller.close();
      sent += 1;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
    },
  });
}

test("failures keep the last good snapshot and are classified without upstream text", async () => {
  for (const [response, code] of [
    [() => new Response("Service Unavailable", { status: 503 }), "http_error"],
    [() => new Response(JSON.stringify({ error: { code: 400, message: "Invalid query" } }), { status: 200 }), "http_error"],
    [() => new Response("<html>maintenance</html>", { status: 200 }), "parse_error"],
    [() => new Response(JSON.stringify({ features: [{ attributes: { Renamed: "1" } }] }), { status: 200 }), "parse_error"],
    [() => new Response(JSON.stringify({ features: [] }), { status: 200 }), "incomplete_feed"],
    // Over 4 MiB with no Content-Length: the stream is cut off, not buffered whole.
    [() => new Response(oversizedStream(), { status: 200 }), "parse_error"],
    [() => { throw new TypeError("fetch failed"); }, "network"],
    [() => { throw new DOMException("The operation timed out.", "TimeoutError"); }, "network"],
    [() => { throw new RangeError("a bug, not the network"); }, "unknown"],
  ] as const) {
    const kv = new FakeKv();
    kv.store.set(INCIDENTS_CACHE_KEY, "previous-snapshot");
    const { restore } = withFetch(async () => response());
    try {
      const report = await refreshOperationalIncidents(env(kv), { now: () => NOW });
      assert.equal(report.payload, null);
      assert.equal(kv.store.get(INCIDENTS_CACHE_KEY), "previous-snapshot", code);
      assert.equal(storedHealth(kv).errorCode, code);
    } finally {
      restore();
    }
  }
});

test("a failed snapshot write is a storage error", async () => {
  const kv = new FakeKv();
  kv.failingKeys.add(INCIDENTS_CACHE_KEY);
  const { restore } = withFetch(async () => new Response(occurrences([{}]), { status: 200 }));
  try {
    const report = await refreshOperationalIncidents(env(kv), { now: () => NOW });
    assert.equal(report.health.errorCode, "storage_error");
  } finally {
    restore();
  }
});

test("an hour of failures alerts once on Telegram, naming ANEPC; the next success sends one recovery", async () => {
  const kv = new FakeKv();
  const sent: string[] = [];
  const channel: AlertChannel = { name: "telegram", send: async (text) => { sent.push(text); return new Response(null, { status: 200 }); } };
  let upstreamUp = false;
  const { restore } = withFetch(async () => upstreamUp ? new Response(occurrences([{}]), { status: 200 }) : new Response("", { status: 502 }));
  try {
    for (let run = 0; run < 6; run += 1) {
      await refreshOperationalIncidents(env(kv), { now: () => NOW + run * QUARTER, channels: [channel] });
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0], /ANEPC refresh failing/);
    upstreamUp = true;
    await refreshOperationalIncidents(env(kv), { now: () => NOW + 6 * QUARTER, channels: [channel] });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /ANEPC refresh recovered/);
  } finally {
    restore();
  }
});

test("unreadable records and unknown phases are counted for the daily summary, not alerted", async () => {
  const kv = new FakeKv();
  const sent: string[] = [];
  const channel: AlertChannel = { name: "telegram", send: async (text) => { sent.push(text); return new Response(null, { status: 200 }); } };
  const { restore } = withFetch(async () => new Response(occurrences([
    {},
    { Numero: "2", EstadoAgrupado: "Chegada ao TO" },
    { Numero: "3", DataOcorrencia: "ontem" },
  ]), { status: 200 }));
  try {
    await refreshOperationalIncidents(env(kv), { now: () => NOW, channels: [channel] });
    assert.deepEqual(sent, []);
    const { signals } = storedHealth(kv);
    assert.equal(signals?.invalidRecords, 1);
    assert.deepEqual(signals?.unrecognisedPhases, ["Chegada ao TO"]);
  } finally {
    restore();
  }
});

test("a layer with more occurrences than one page is read page by page, and never cut short", async () => {
  const kv = new FakeKv();
  const page = (numero: string, more: boolean) => {
    const body = JSON.parse(occurrences([{ Numero: numero }]));
    return new Response(JSON.stringify(more ? { ...body, exceededTransferLimit: true } : body), { status: 200 });
  };
  const paged = withFetch(async (url) => (new URL(url).searchParams.get("resultOffset") === "0" ? page("1", true) : page("2", false)));
  try {
    const report = await refreshOperationalIncidents(env(kv), { now: () => NOW });
    assert.equal(report.health.outcome, "success");
    assert.deepEqual(paged.calls.map((url) => new URL(url).searchParams.get("resultOffset")), ["0", "2000"]);
    assert.deepEqual(report.payload?.incidents.map((incident) => incident.sourceId).sort(), ["1", "2"]);
  } finally {
    paged.restore();
  }

  // A layer that never stops saying "more" fails the run; the last snapshot stays.
  const endless = new FakeKv();
  endless.store.set(INCIDENTS_CACHE_KEY, "previous-snapshot");
  const neverEnding = withFetch(async (url) => page(new URL(url).searchParams.get("resultOffset") ?? "?", true));
  try {
    const report = await refreshOperationalIncidents(env(endless), { now: () => NOW });
    assert.equal(report.health.errorCode, "incomplete_feed");
    assert.equal(neverEnding.calls.length, 5);
    assert.equal(endless.store.get(INCIDENTS_CACHE_KEY), "previous-snapshot");
  } finally {
    neverEnding.restore();
  }
});

test("an alert is sent only once its state is stored, so a failing KV write never repeats it", async () => {
  const kv = new FakeKv();
  const sent: string[] = [];
  const channel: AlertChannel = { name: "telegram", send: async (text) => { sent.push(text); return new Response(null, { status: 200 }); } };
  const { restore } = withFetch(async () => new Response("", { status: 502 }));
  try {
    for (let run = 0; run < 6; run += 1) {
      // From the run that would alert, the health record can no longer be written (the daily KV limit, say).
      if (run === 3) kv.failingKeys.add(INCIDENTS_INGEST_HEALTH_KEY);
      await refreshOperationalIncidents(env(kv), { now: () => NOW + run * QUARTER, channels: [channel] });
    }
    assert.deepEqual(sent, [], "nothing is sent while its state cannot be stored");
    kv.failingKeys.delete(INCIDENTS_INGEST_HEALTH_KEY);
    await refreshOperationalIncidents(env(kv), { now: () => NOW + 6 * QUARTER, channels: [channel] });
    await refreshOperationalIncidents(env(kv), { now: () => NOW + 7 * QUARTER, channels: [channel] });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /ANEPC refresh failing/);
  } finally {
    restore();
  }
});
