// Measures the CPU each request costs inside workerd with the V8 sampling
// profiler (Chrome DevTools Protocol over wrangler's inspector port): the sum
// of sample intervals spent outside "(idle)" while the request runs. Each
// scenario runs stage by stage, RUNS times, in a fresh order.
import { readFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// The `ws` client from the app's dependencies: it connects without an Origin header.
const WebSocket = createRequire(path.join(process.env.REPO_ROOT ?? process.cwd(), "package.json"))("ws");

const base = process.env.BENCH_URL ?? "http://127.0.0.1:8799";
const inspector = process.env.INSPECTOR_URL ?? "http://127.0.0.1:9229";
const RUNS = Number(process.env.RUNS ?? 15);
const scenarios = JSON.parse(readFileSync("bench-scenarios.json", "utf8"));

const targets = await (await fetch(`${inspector}/json`)).json();
const target = targets.find((t) => /core:user/.test(t.title ?? t.id ?? "") || /core:user/.test(t.webSocketDebuggerUrl ?? "")) ?? targets[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
let nextId = 1;
const pending = new Map();
ws.on("message", (data) => {
  const message = JSON.parse(String(data));
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
});
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 50 });

function cpuMs(profile) {
  const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === "(idle)").map((n) => n.id));
  let total = 0;
  const byFunction = new Map();
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((nodeId, i) => {
    if (idle.has(nodeId)) return;
    const delta = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    total += delta;
    const name = nodeById.get(nodeId)?.callFrame.functionName || "(anonymous)";
    byFunction.set(name, (byFunction.get(name) ?? 0) + delta);
  });
  return { total, top: [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, ms]) => `${n} ${ms.toFixed(1)}`) };
}

async function profiled(url, body) {
  await send("Profiler.start");
  const response = await fetch(url, { method: "POST", body });
  await response.text();
  const { result } = await send("Profiler.stop");
  return cpuMs(result.profile);
}

async function profiledWithBody(url, body) {
  await send("Profiler.start");
  const response = await fetch(url, { method: "POST", body });
  const text = await response.text();
  const { result } = await send("Profiler.stop");
  return { ...cpuMs(result.profile), body: text };
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const max = (v) => Math.max(...v);
const rows = [];
for (const s of scenarios) {
  const body = readFileSync(`scenario-${s.name}.txt`, "utf8");
  const first = await profiled(`${base}/?stage=5&now=${s.now}`, body);
  const stages = {};
  for (const stage of [0, 1, 2, 3, 4, 5]) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push((await profiled(`${base}/?stage=${stage}&now=${s.now}`, body)).total);
    stages[stage] = { median: median(runs), max: max(runs) };
  }
  const full = await profiled(`${base}/?stage=5&now=${s.now}`, body);
  rows.push({
    scenario: s.name, describe: s.describe, kib: Math.round(s.bytes / 1024),
    firstRunMs: +first.total.toFixed(1), firstRunTop: first.top,
    readBodyMs: +stages[0].median.toFixed(1),
    jsonParseAnepcMs: +(stages[1].median - stages[0].median).toFixed(1),
    adapterMs: +(stages[2].median - stages[1].median).toFixed(1),
    readIndexMs: +(stages[3].median - stages[2].median).toFixed(1),
    reconcileMs: +(stages[4].median - stages[3].median).toFixed(1),
    stringifyMs: +(stages[5].median - stages[4].median).toFixed(1),
    totalMedianMs: +stages[5].median.toFixed(1), totalMaxMs: +stages[5].max.toFixed(1),
    warmTop: full.top,
  });
}
// The existing hourly FIRMS ingest on a production-sized CSV.
try {
  const csv = readFileSync("firms-world.csv", "utf8");
  const firmsNow = readFileSync("firms-now.txt", "utf8");
  const readOnly = [];
  const full = [];
  let result = "";
  for (let i = 0; i < 5; i++) readOnly.push((await profiled(`${base}/firms?stage=0&now=${firmsNow}`, csv)).total);
  for (let i = 0; i < 5; i++) {
    const t = await profiledWithBody(`${base}/firms?stage=1&now=${firmsNow}`, csv);
    full.push(t.total);
    result = t.body;
  }
  rows.push({ scenario: "firms-hourly-ingest", describe: "existing FIRMS ingest, 134 651-row worldwide CSV", result,
    readBodyMs: +median(readOnly).toFixed(1), totalMedianMs: +median(full).toFixed(1), totalMaxMs: +max(full).toFixed(1), ingestMinusReadMs: +(median(full) - median(readOnly)).toFixed(1) });
} catch (error) {
  rows.push({ scenario: "firms-hourly-ingest", error: String(error).slice(0, 200) });
}
ws.close();
const json = JSON.stringify(rows, null, 2);
console.log(json);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### workerd CPU from the V8 sampling profiler (ms)\n```json\n" + json + "\n```\n");
