// Benchmark Worker: runs the ANEPC run's local computation, stage by stage, on
// the request body, so the time of each request is the runtime's CPU for that
// work (nothing in it waits on the network).
import { parseAnepcOccurrences } from "@/lib/operational/anepc";
import { readFusionIndex } from "@/lib/operational/incidents-cache";
import { reconcile } from "@/lib/fusion/reconcile";
import { refreshFirmsCache, type FirmsIngestEnv } from "../../workers/firms-ingest";

class MemoryKv {
  readonly store = new Map<string, string>();
  async get(key: string, type?: "json") {
    const value = this.store.get(key) ?? null;
    return type === "json" && value !== null ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) { this.store.set(key, value); }
}

/** The existing hourly FIRMS ingest on a CSV body, with FIRMS replaced by that body and KV in memory. */
async function firms(request: Request, url: URL): Promise<Response> {
  const csv = await request.text();
  if (url.searchParams.get("stage") === "0") return new Response(String(csv.length));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(csv, { status: 200, headers: { "content-type": "text/csv" } })) as typeof fetch;
  try {
    const kv = new MemoryKv();
    const report = await refreshFirmsCache({ FIRMS_CACHE: kv as unknown as FirmsIngestEnv["FIRMS_CACHE"], FIRMS_MAP_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" }, { now: () => Number(url.searchParams.get("now")) });
    return new Response(JSON.stringify({ outcome: report.health.outcome, errorCode: report.health.errorCode, rows: report.health.sourceRows, points: report.health.selectedPoints }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

const SEPARATOR = "\n\u0000\n";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/firms") return firms(request, url);
    const text = await request.text();
    const stage = Number(url.searchParams.get("stage") ?? "5");
    if (stage === 0) return new Response(String(text.length));
    const now = Number(url.searchParams.get("now"));
    const cut = text.indexOf(SEPARATOR);
    const anepc = JSON.parse(text.slice(0, cut));
    if (stage === 1) return new Response("1");
    const parsed = parseAnepcOccurrences(anepc, now);
    if (stage === 2) return new Response(String(parsed.incidents.length));
    const fusion = readFusionIndex(JSON.parse(text.slice(cut + SEPARATOR.length)));
    if (stage === 3) return new Response(String(fusion?.observations.length));
    const reconciliation = reconcile(parsed.incidents, fusion?.observations ?? [], now);
    if (stage === 4) return new Response(String(reconciliation.detections.length));
    const snapshot = JSON.stringify({
      version: 1, source: "ANEPC Ocorrências em aberto", generatedAt: new Date(now).toISOString(),
      incidents: parsed.incidents, reconciliation,
      fusedWith: fusion ? { firmsGeneratedAt: fusion.firmsGeneratedAt, detections: fusion.observations.length } : null,
    });
    return new Response(String(snapshot.length));
  },
};
