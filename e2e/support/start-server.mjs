// Starts the production OpenNext build under `wrangler dev` with a local KV
// namespace seeded from the synthetic feed. Playwright runs this as its web
// server; it needs `npm run build:cloudflare` to have run first.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildHealthyIngest, buildSnapshot } from "./synthetic-feed.mjs";

const PORT = process.env.E2E_PORT ?? "8788";
const STATE_DIR = path.join(".wrangler", "e2e-state");
const SNAPSHOT_KEY = "active-fires:v1";
const HEALTH_KEY = "active-fires:ingest-health:v1";
const INCIDENTS_KEY = "operational-incidents:v1";
const INCIDENTS_HEALTH_KEY = "operational-incidents:ingest-health:v1";

if (!existsSync(path.join(".open-next", "worker.js"))) {
  console.error("No OpenNext build found. Run `npm run build:cloudflare` first.");
  process.exit(1);
}

const fixtureDir = mkdtempSync(path.join(tmpdir(), "wildfire-watch-e2e-"));

// The operational fixture runs the app's own TypeScript parser and
// reconciliation; esbuild bundles it (resolving the "@/" alias) for Node.
const operationalModule = path.join(fixtureDir, "operational-feed.mjs");
await build({
  entryPoints: [path.join("e2e", "support", "operational-feed.ts")],
  outfile: operationalModule,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
});
const { buildOperationalSnapshot } = await import(pathToFileURL(operationalModule).href);

const now = Date.now();
const snapshot = buildSnapshot(now);
const health = buildHealthyIngest(snapshot);
const operational = buildOperationalSnapshot(now, snapshot);
const files = {
  [SNAPSHOT_KEY]: snapshot,
  [HEALTH_KEY]: health,
  [INCIDENTS_KEY]: operational.snapshot,
  [INCIDENTS_HEALTH_KEY]: operational.health,
};

rmSync(STATE_DIR, { recursive: true, force: true });
for (const [key, value] of Object.entries(files)) {
  const file = path.join(fixtureDir, `${key.replace(/[^a-z0-9]/gi, "_")}.json`);
  writeFileSync(file, JSON.stringify(value));
  const result = spawnSync("npx", ["wrangler", "kv", "key", "put", key, "--binding=FIRMS_CACHE", "--local", `--persist-to=${STATE_DIR}`, `--path=${file}`], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
rmSync(fixtureDir, { recursive: true, force: true });

// `wrangler dev` occasionally exits mid-run when its local proxy loses the
// connection to the Worker ("Error inside ProxyWorker: Network connection
// lost"), on branches with and without app changes. It is restarted with the
// same seeded state, so one lost connection costs the test attempt in flight,
// not every test after it; e2e/support/server.ts makes the next test wait for
// the restart. Each restart is logged, and repeated exits still fail the run.
const MAX_RESTARTS = 3;
let restarts = 0;
let stopping = false;
let server;

function startServer() {
  server = spawn("npx", [
    "wrangler", "dev",
    "--ip=127.0.0.1",
    `--port=${PORT}`,
    `--persist-to=${STATE_DIR}`,
    "--log-level=warn",
    "--show-interactive-dev-session=false",
  ], { stdio: "inherit" });
  server.on("exit", (code, signal) => {
    if (stopping) process.exit(code ?? 0);
    if (restarts >= MAX_RESTARTS) {
      console.error(`wrangler dev exited (${signal ?? code}) after ${MAX_RESTARTS} restarts; giving up.`);
      process.exit(code || 1);
    }
    restarts += 1;
    console.error(`wrangler dev exited (${signal ?? code}); restarting (${restarts}/${MAX_RESTARTS}).`);
    startServer();
  });
}

startServer();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    server.kill(signal);
  });
}
