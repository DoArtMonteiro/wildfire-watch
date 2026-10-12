// Runs the real ANEPC ingest once against the live layer, with an in-memory KV
// holding a fusion index built from production's FIRMS points. Read-only
// towards ANEPC; prints aggregates only. Also reads who owns the layer.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { refreshOperationalIncidents, type AnepcIngestEnv } from "../workers/anepc-ingest";
import { FUSION_INDEX_KEY, INCIDENTS_CACHE_KEY, buildFusionIndex } from "@/lib/operational/incidents-cache";

class MemoryKv {
  readonly store = new Map<string, string>();
  async get(key: string, type?: "json") {
    const value = this.store.get(key) ?? null;
    return type === "json" && value !== null ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) { this.store.set(key, value); }
}

const out: Record<string, unknown> = {};
const kv = new MemoryKv();
if (existsSync("production-fires.json")) {
  const fires = JSON.parse(readFileSync("production-fires.json", "utf8"));
  kv.store.set(FUSION_INDEX_KEY, JSON.stringify(buildFusionIndex(fires.points, fires.generatedAt)));
}
const realFetch = globalThis.fetch;
const calls: Array<{ offset: string | null; outFields: string | null; status?: number }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const response = await realFetch(input, init);
  calls.push({ offset: url.searchParams.get("resultOffset"), outFields: url.searchParams.get("outFields"), status: response.status });
  return response;
}) as typeof fetch;
const started = Date.now();
const report = await refreshOperationalIncidents({ FIRMS_CACHE: kv as unknown as AnepcIngestEnv["FIRMS_CACHE"] }, { now: Date.now });
globalThis.fetch = realFetch;
const snapshotText = kv.store.get(INCIDENTS_CACHE_KEY) ?? "";
out.ingest = {
  wallMs: Date.now() - started, calls, health: report.health, alerts: report.alerts.length,
  snapshotBytes: snapshotText.length, containsEndereco: snapshotText.includes("Endereco"),
  incidents: report.payload?.incidents.map((i) => ({
    phase: i.phase, phaseLabel: i.phaseLabel, natureCode: i.natureCode,
    startedMinutesAgo: Math.round((Date.now() - Date.parse(i.startedAt)) / 60_000),
    updatedMinutesAgo: i.updatedAt ? Math.round((Date.now() - Date.parse(i.updatedAt)) / 60_000) : null,
    hasMunicipality: Boolean(i.municipality), resources: i.resources,
  })),
  fusedWith: report.payload?.fusedWith, linkedDetections: report.payload?.reconciliation.detections.length,
};

// Ownership and licence metadata of the layer's service and item.
async function json(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "WildfireWatch probe (+https://github.com/WhiteBlindness/wildfire-watch)" } });
    return r.ok ? await r.json() : { status: r.status };
  } catch (error) { return { error: error instanceof Error ? error.name : "unknown" }; }
}
const service = await json("https://services-eu1.arcgis.com/VlrHb7fn5ewYhX6y/arcgis/rest/services/OcorrenciasSite/FeatureServer?f=json");
out.service = { serviceItemId: service.serviceItemId, serviceDescription: String(service.serviceDescription ?? "").slice(0, 300), copyrightText: service.copyrightText };
if (service.serviceItemId) {
  const item = await json(`https://www.arcgis.com/sharing/rest/content/items/${service.serviceItemId}?f=json`);
  out.item = { title: item.title, owner: item.owner, orgId: item.orgId, access: item.access, accessInformation: item.accessInformation,
    licenseInfo: String(item.licenseInfo ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600),
    snippet: item.snippet, modified: item.modified ? new Date(item.modified).toISOString() : null, error: item.error ?? item.status };
}
const portal = await json("https://www.arcgis.com/sharing/rest/portals/VlrHb7fn5ewYhX6y?f=json");
out.portal = { name: portal.name, urlKey: portal.urlKey, error: portal.error ?? portal.status };

const text = JSON.stringify(out, null, 2);
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Live ingest with the PR code\n```json\n" + text + "\n```\n");
