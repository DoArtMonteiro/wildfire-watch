// Builds the benchmark inputs: synthetic quiet, busy and extreme days (the same
// generator as the documented Node measurements) and, when present, today's
// real ANEPC response with the real FIRMS points from production.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildFusionIndex } from "@/lib/operational/incidents-cache";

const MINUTE = 60_000;
const SEPARATOR = "\n\u0000\n";
const now = Date.parse("2026-08-15T15:00:00Z");
let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const STATES = ["Em Despacho", "Em Curso", "Em Resolução", "Em Conclusão", "Vigilância"];

function features(rural: number, other: number) {
  const out = [];
  for (let i = 0; i < rural + other; i++) {
    const isRural = i < rural;
    out.push({
      attributes: {
        OBJECTID: i + 1, Numero: String(2026080010000 + i), ID_oc: 2026080010000 + i,
        CodNatureza: isRural ? ["3101", "3103", "3105"][i % 3] : "2101",
        Natureza: isRural ? "Incêndio Rural - Povoamento Florestal" : "Acidente - Colisão Rodoviária",
        EstadoAgrupado: STATES[i % STATES.length], EstadoOcorrencia: STATES[i % STATES.length],
        DataOcorrencia: now - Math.floor(rand() * 48 * 60) * MINUTE, DataDosDados: now - 6 * MINUTE,
        Distrito: "Distrito Exemplo", Concelho: "Concelho Exemplo", Freguesia: "Freguesia de Exemplo", Localidade: "Localidade Exemplo",
        Endereco: "Estrada Nacional sem número, junto ao cruzamento", Operacionais: Math.floor(rand() * 200), MeiosTerrestres: Math.floor(rand() * 60),
        MeiosAereos: Math.floor(rand() * 6), MeiosAquaticos: 0, Latitude: 0, Longitude: 0,
        CSREPC: "Sub-região Exemplo", Regiao: "Região Exemplo", Sub_Regiao: "Sub-região Exemplo",
      },
      geometry: { x: -9.3 + rand() * 3, y: 37 + rand() * 5 },
    });
  }
  return { objectIdFieldName: "OBJECTID", geometryType: "esriGeometryPoint", spatialReference: { wkid: 4326 }, features: out };
}

function firmsPoints(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `firms-${(1e9 + i * 7919).toString(36)}`, lat: Math.round((37 + rand() * 5) * 1e5) / 1e5, lng: Math.round((-9.3 + rand() * 3) * 1e5) / 1e5,
    frpMw: Math.round(rand() * 5000) / 10, confidencePct: 80, detectedAt: new Date(now - Math.floor(rand() * 72 * 60) * MINUTE).toISOString(),
  }));
}

const scenarios: Array<{ name: string; now: number; body: string; describe: string }> = [];
for (const [name, rural, other, firms] of [["quiet", 15, 60, 200], ["busy", 120, 150, 2000], ["extreme", 300, 200, 8000]] as const) {
  const anepc = JSON.stringify(features(rural, other));
  const index = JSON.stringify(buildFusionIndex(firmsPoints(firms) as never, new Date(now - 30 * MINUTE).toISOString()));
  scenarios.push({ name, now, body: anepc + SEPARATOR + index, describe: `${rural} rural / ${other} other records, ${firms} detections` });
}
if (existsSync("anepc-live.json") && existsSync("production-fires.json")) {
  const anepc = readFileSync("anepc-live.json", "utf8");
  const fires = JSON.parse(readFileSync("production-fires.json", "utf8"));
  const index = JSON.stringify(buildFusionIndex(fires.points, fires.generatedAt));
  const records = JSON.parse(anepc).features?.length ?? 0;
  scenarios.push({ name: "real-today", now: Date.now(), body: anepc + SEPARATOR + index, describe: `live ANEPC (${records} records) with production FIRMS points` });
}
// A worldwide FIRMS CSV the size of production's on 12/10/2026 (134 651 rows), for the existing hourly ingest.
{
  const firmsNow = Date.now();
  const day = new Date(firmsNow - 6 * 3_600_000).toISOString().slice(0, 10);
  const lines = ["latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight"];
  for (let index = 0; index < 134_651; index += 1) {
    const lat = (-55 + rand() * 120).toFixed(5);
    const lng = (-179 + rand() * 358).toFixed(5);
    const confidence = ["l", "n", "h"][index % 3];
    lines.push(`${lat},${lng},${(300 + rand() * 60).toFixed(2)},0.4,0.4,${day},${String(index % 24).padStart(2, "0")}${String(index % 60).padStart(2, "0")},N,VIIRS,${confidence},2.0NRT,290.1,${(0.5 + rand() * 80).toFixed(2)},D`);
  }
  writeFileSync("firms-world.csv", `${lines.join("\n")}\n`);
  writeFileSync("firms-now.txt", String(firmsNow));
  console.log(`firms: ${(lines.length - 1)} rows, ${(lines.join("\n").length / 1048576).toFixed(1)} MiB`);
}
writeFileSync("bench-scenarios.json", JSON.stringify(scenarios.map(({ name, now: t, describe, body }) => ({ name, now: t, describe, bytes: body.length }))));
for (const s of scenarios) writeFileSync(`scenario-${s.name}.txt`, s.body);
console.log(scenarios.map((s) => `${s.name}: ${s.describe}, ${(s.body.length / 1024).toFixed(0)} KiB`).join("\n"));
