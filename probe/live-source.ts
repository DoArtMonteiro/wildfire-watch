// Read-only live probe of the ANEPC layer, the dados.gov.pt dataset record and
// the production FIRMS health. Prints aggregates only: no raw records, no
// addresses. Bounded: one metadata request and one query per host.
import { writeFileSync, appendFileSync } from "node:fs";
import { buildAnepcQueryUrl, parseAnepcOccurrences } from "@/lib/operational/anepc";

const UA = "WildfireWatch probe (+https://github.com/WhiteBlindness/wildfire-watch)";
const out: Record<string, unknown> = {};

async function get(url: string, timeoutMs = 30_000) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "content-length", "content-encoding", "cache-control", "last-modified", "etag", "access-control-allow-origin", "date"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    return { ok: response.ok, status: response.status, ms: Date.now() - started, bytes: Buffer.byteLength(text), headers, text };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, bytes: 0, headers: {}, text: "", error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown" };
  }
}

function typeOf(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

const LAYER = buildAnepcQueryUrl().split("/query?")[0];

// 1. Layer metadata.
const meta = await get(`${LAYER}?f=pjson`);
out.layerMeta = { status: meta.status, ms: meta.ms, bytes: meta.bytes, headers: meta.headers, error: (meta as { error?: string }).error };
if (meta.ok) {
  const m = JSON.parse(meta.text);
  out.layer = {
    name: m.name, type: m.type, geometryType: m.geometryType, maxRecordCount: m.maxRecordCount, standardMaxRecordCount: m.standardMaxRecordCount,
    supportsPagination: m.advancedQueryCapabilities?.supportsPagination, copyrightText: m.copyrightText, description: String(m.description ?? "").slice(0, 400),
    lastEditDate: m.editingInfo?.lastEditDate ? new Date(m.editingInfo.lastEditDate).toISOString() : null,
    dataLastEditDate: m.editingInfo?.dataLastEditDate ? new Date(m.editingInfo.dataLastEditDate).toISOString() : null,
    spatialReference: m.extent?.spatialReference ?? m.sourceSpatialReference, dateFieldsTimeReference: m.dateFieldsTimeReference ?? null,
    preferredTimeReference: m.preferredTimeReference ?? null, timeInfo: m.timeInfo ?? null,
    fields: (m.fields ?? []).map((f: { name: string; type: string; length?: number; alias?: string }) => `${f.name}:${String(f.type).replace("esriFieldType", "")}`),
  };
}

// 2. The exact query the ingest makes.
const fetchedAt = Date.now();
const query = await get(buildAnepcQueryUrl());
out.query = { url: buildAnepcQueryUrl(), status: query.status, ms: query.ms, bytes: query.bytes, headers: query.headers, error: (query as { error?: string }).error };
if (query.ok) {
  const body = JSON.parse(query.text);
  const features: Array<{ attributes: Record<string, unknown>; geometry?: { x: number; y: number } }> = body.features ?? [];
  out.queryShape = { features: features.length, exceededTransferLimit: body.exceededTransferLimit ?? null, geometryType: body.geometryType, spatialReference: body.spatialReference, error: body.error ?? null };
  // Field types and nulls (names and types only).
  const fieldStats: Record<string, Record<string, number>> = {};
  for (const feature of features) for (const [key, value] of Object.entries(feature.attributes)) {
    const stats = (fieldStats[key] ??= {});
    stats[typeOf(value)] = (stats[typeOf(value)] ?? 0) + 1;
  }
  out.fieldTypes = fieldStats;
  const count = (key: string, pick: (a: Record<string, unknown>) => unknown) => {
    const tally: Record<string, number> = {};
    for (const f of features) { const v = String(pick(f.attributes) ?? "∅"); tally[v] = (tally[v] ?? 0) + 1; }
    return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 40));
  };
  out.natureCodes = count("CodNatureza", (a) => a.CodNatureza);
  out.ruralNatures = count("Natureza31", (a) => (String(a.CodNatureza ?? "").startsWith("31") ? `${a.CodNatureza} ${a.Natureza}` : undefined));
  out.estadoAgrupado = count("EstadoAgrupado", (a) => a.EstadoAgrupado);
  out.estadoOcorrencia = count("EstadoOcorrencia", (a) => a.EstadoOcorrencia);
  out.faseIncendio = count("FaseIncendio", (a) => a.FaseIncendio);
  out.estadoRural = count("EstadoRural", (a) => (String(a.CodNatureza ?? "").startsWith("31") ? `${a.EstadoAgrupado} | ${a.EstadoOcorrencia}` : undefined));
  // Time interpretation: epoch values relative to the fetch time.
  const timeStats = (key: string) => {
    const values = features.map((f) => f.attributes[key]).filter((v): v is number => typeof v === "number");
    if (values.length === 0) return { numeric: 0, examples: features.slice(0, 3).map((f) => f.attributes[key]) };
    const offsetsMin = values.map((v) => (v - fetchedAt) / 60_000).sort((a, b) => a - b);
    return { numeric: values.length, minOffsetMin: Math.round(offsetsMin[0]), maxOffsetMin: Math.round(offsetsMin.at(-1)!), inFuture: offsetsMin.filter((o) => o > 2).length,
      newestIso: new Date(Math.max(...values)).toISOString() };
  };
  out.fetchedAtIso = new Date(fetchedAt).toISOString();
  out.times = { DataOcorrencia: timeStats("DataOcorrencia"), DataDosDados: timeStats("DataDosDados"), Data: timeStats("Data"), DataFechoOperacional: timeStats("DataFechoOperacional") };
  // If the layer carries separate date/time strings, compare them with the epoch in UTC and in Lisbon time.
  const pairs = features.filter((f) => typeof f.attributes.DataOcorrencia === "number" && (typeof f.attributes.Hora === "string" || typeof f.attributes.Data === "string")).slice(0, 5);
  out.dateStringComparison = pairs.map((f) => {
    const epoch = f.attributes.DataOcorrencia as number;
    return { Data: f.attributes.Data, Hora: f.attributes.Hora, epochUtc: new Date(epoch).toISOString(),
      epochLisbon: new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", dateStyle: "short", timeStyle: "short" }).format(epoch) };
  });
  // Coordinates.
  const geomOk = features.filter((f) => f.geometry && Number.isFinite(f.geometry.x) && Number.isFinite(f.geometry.y));
  const outside = geomOk.filter((f) => f.geometry!.x < -9.6 || f.geometry!.x > -6.1 || f.geometry!.y < 36.9 || f.geometry!.y > 42.2).length;
  const attrMismatch = geomOk.filter((f) => typeof f.attributes.Latitude === "number" && Math.abs((f.attributes.Latitude as number) - f.geometry!.y) > 0.01).length;
  out.coordinates = { withGeometry: geomOk.length, outsideMainlandBox: outside, latitudeAttributeDisagrees: attrMismatch };
  // Resources.
  const res = (key: string) => {
    const nums = features.map((f) => f.attributes[key]).filter((v): v is number => typeof v === "number");
    return { numeric: nums.length, nulls: features.filter((f) => f.attributes[key] === null || f.attributes[key] === undefined).length, max: nums.length ? Math.max(...nums) : null };
  };
  out.resources = { Operacionais: res("Operacionais"), MeiosTerrestres: res("MeiosTerrestres"), MeiosAereos: res("MeiosAereos"), OperacionaisTerrestres: res("OperacionaisTerrestres"), OPAereos: res("OPAereos") };
  out.duplicateNumeros = features.length - new Set(features.map((f) => String(f.attributes.Numero))).size;
  // The adapter on the real response.
  try {
    const parseStart = performance.now();
    const parsed = parseAnepcOccurrences(body, fetchedAt);
    out.adapter = { ms: +(performance.now() - parseStart).toFixed(2), counts: parsed.counts, quality: parsed.quality,
      phases: parsed.incidents.reduce<Record<string, number>>((t, i) => ({ ...t, [`${i.phase} (${i.phaseLabel})`]: (t[`${i.phase} (${i.phaseLabel})`] ?? 0) + 1 }), {}),
      startedAgeHours: parsed.incidents.map((i) => Math.round((fetchedAt - Date.parse(i.startedAt)) / 360_000) / 10).sort((a, b) => a - b),
      updatedNull: parsed.incidents.filter((i) => i.updatedAt === null).length,
      resourcesNull: parsed.incidents.filter((i) => i.resources.personnel === null).length };
  } catch (error) {
    out.adapter = { error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown" };
  }
  // A server-side filter for later: is it accepted, and how much smaller?
  const filtered = await get(`${LAYER}/query?${new URLSearchParams({ where: "CodNatureza LIKE '31%'", outFields: "*", returnGeometry: "true", outSR: "4326", f: "json" })}`);
  out.filteredQuery = { status: filtered.status, bytes: filtered.bytes, ms: filtered.ms, features: filtered.ok ? (JSON.parse(filtered.text).features?.length ?? JSON.parse(filtered.text).error) : null };
}

// 3. Other ANEPC hosts seen in public code: reachability only.
for (const [name, url] of [["sgifr", "https://api.sgifr.gov.pt/arcgis/rest/services/ANEPC/ocorrencias-ativas/FeatureServer/0?f=pjson"], ["legacy", "https://prociv-agserver.geomai.mai.gov.pt/arcgis/rest/services/Ocorrencias_Base/FeatureServer/0?f=pjson"]] as const) {
  const r = await get(url, 15_000);
  (out.otherHosts ??= {} as Record<string, unknown>) as Record<string, unknown>;
  (out.otherHosts as Record<string, unknown>)[name] = { status: r.status, bytes: r.bytes, error: (r as { error?: string }).error, looksLikeLayer: r.text.includes('"fields"') };
}

// 4. dados.gov.pt dataset record.
const ds = await get("https://dados.gov.pt/api/1/datasets/prociv-ocorrencias-em-aberto/");
out.datasetMeta = { status: ds.status, error: (ds as { error?: string }).error };
if (ds.ok) {
  const d = JSON.parse(ds.text);
  out.dataset = { title: d.title, organization: d.organization?.name, license: d.license, last_update: d.last_update, frequency: d.frequency, page: d.page,
    resources: (d.resources ?? []).map((r: { title: string; url: string; format: string; last_modified: string }) => ({ title: r.title, url: r.url, format: r.format, last_modified: r.last_modified })) };
  const lic = await get(`https://dados.gov.pt/api/1/datasets/licenses/`);
  if (lic.ok) out.licenseDetail = (JSON.parse(lic.text) as Array<{ id: string; title: string; url: string }>).find((l) => l.id === d.license) ?? null;
} else {
  const search = await get("https://dados.gov.pt/api/1/datasets/?q=ocorr%C3%AAncias%20em%20aberto&page_size=5");
  if (search.ok) out.datasetSearch = (JSON.parse(search.text).data ?? []).map((d: { title: string; slug: string; license: string; organization?: { name: string } }) => ({ title: d.title, slug: d.slug, license: d.license, org: d.organization?.name }));
}

// 5. Production FIRMS health (public endpoint), to see whether the hourly cron succeeds on the Free plan.
const site = process.env.SITE_URL;
if (site) {
  const fires = await get(`${site}/api/fires`);
  const firesHeaders: Record<string, string> = {};
  out.production = { status: fires.status, ms: fires.ms, bytes: fires.bytes };
  if (fires.ok) {
    const f = JSON.parse(fires.text);
    const pts = (f.points ?? []) as Array<{ lat: number; lng: number }>;
    out.production = { ...(out.production as object), generatedAt: f.generatedAt, ageMin: Math.round((Date.now() - Date.parse(f.generatedAt)) / 60_000), ingestHealth: f.ingestHealth ?? null,
      points: pts.length, inAnepcBox: pts.filter((p) => p.lng >= -9.6 && p.lng <= -6.1 && p.lat >= 36.9 && p.lat <= 42.2).length };
    writeFileSync("production-fires.json", fires.text);
  }
  const inc = await get(`${site}/api/incidents`);
  out.productionIncidents = { status: inc.status };
  void firesHeaders;
}

if (query.ok) writeFileSync("anepc-live.json", query.text); // local to the runner, for the CPU job; never committed or uploaded
const json = JSON.stringify(out, null, 2);
writeFileSync("probe-summary.json", json);
console.log(json);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```json\n" + json + "\n```\n");
