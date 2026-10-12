// Deterministic synthetic ANEPC data for end-to-end tests. Nothing here comes
// from ANEPC. The records are shaped like the occurrences layer's ArcGIS JSON
// and go through the real parser and reconciliation, so the snapshot the
// tests read is exactly what the scheduled ingest would store for them.
import { parseAnepcOccurrences } from "../../src/lib/operational/anepc";
import { buildFusionIndex, readFusionIndex, type IncidentsCachePayload } from "../../src/lib/operational/incidents-cache";
import { reconcile } from "../../src/lib/fusion/reconcile";
import { nextIngestHealth, type IngestHealthRecord } from "../../src/lib/wildfire/ingest-health";
import type { CachedFirmsPoint } from "../../src/lib/wildfire/firms-cache";

const MINUTE = 60_000;

interface FirmsSnapshot {
  generatedAt: string;
  points: CachedFirmsPoint[];
}

function occurrence(nowMs: number, fields: Record<string, unknown>, lat: number, lng: number) {
  return {
    attributes: {
      CodNatureza: "3101",
      Natureza: "Incêndio Rural - Povoamento Florestal",
      DataDosDados: nowMs - 6 * MINUTE,
      Endereco: "Not kept by the parser",
      ...fields,
    },
    geometry: { x: lng, y: lat },
  };
}

/** The occurrences the tests name. */
export function buildOccurrences(nowMs: number) {
  return {
    features: [
      // About 0.5 km from the Arganil detection and 2.6 km from its flank: two linked detections.
      occurrence(nowMs, {
        Numero: "2026080000101", EstadoAgrupado: "Em Curso", DataOcorrencia: nowMs - 3 * 60 * MINUTE,
        Concelho: "Arganil", Freguesia: "Pomares", Operacionais: 84, MeiosTerrestres: 25, MeiosAereos: 2,
      }, 40.223, -8.0541),
      // The Monchique detection lies 1.0 km from one and 1.5 km from the other: ambiguous.
      occurrence(nowMs, {
        Numero: "2026080000102", EstadoAgrupado: "Em Resolução", CodNatureza: "3103", Natureza: "Incêndio Rural - Mato",
        DataOcorrencia: nowMs - 2 * 60 * MINUTE, Concelho: "Monchique", Freguesia: "Alferce", Operacionais: 31, MeiosTerrestres: 9, MeiosAereos: 0,
      }, 37.3262, -8.5554),
      occurrence(nowMs, {
        Numero: "2026080000103", EstadoAgrupado: "Em Curso", DataOcorrencia: nowMs - 2 * 60 * MINUTE,
        Concelho: "Monchique", Freguesia: "Marmelete", Operacionais: 47, MeiosTerrestres: 14, MeiosAereos: 1,
      }, 37.3037, -8.5554),
      // Registered 30 minutes ago, no satellite detection anywhere near it.
      occurrence(nowMs, {
        Numero: "2026080000104", EstadoAgrupado: "Em Despacho", CodNatureza: "3105", Natureza: "Incêndio Rural - Agrícola",
        DataOcorrencia: nowMs - 30 * MINUTE, Concelho: "Bragança", Freguesia: "Gimonde", Operacionais: 12, MeiosTerrestres: 3, MeiosAereos: null,
      }, 41.806, -6.757),
      // Not wildfires: a road accident and a debris burn.
      occurrence(nowMs, { Numero: "2026080000105", EstadoAgrupado: "Em Curso", CodNatureza: "2101", Natureza: "Acidente", DataOcorrencia: nowMs - 60 * MINUTE }, 38.72, -9.14),
      occurrence(nowMs, { Numero: "2026080000106", EstadoAgrupado: "Em Curso", CodNatureza: "3111", Natureza: "Queima", DataOcorrencia: nowMs - 60 * MINUTE }, 39.5, -8.0),
    ],
  };
}

/** The snapshot and health record the scheduled ingest would store, built ageMinutes ago. */
export function buildOperationalSnapshot(nowMs: number, firms: FirmsSnapshot, { ageMinutes = 4 } = {}): { snapshot: IncidentsCachePayload; health: IngestHealthRecord } {
  const builtAt = nowMs - ageMinutes * MINUTE;
  const parsed = parseAnepcOccurrences(buildOccurrences(nowMs), builtAt);
  const fusion = readFusionIndex(buildFusionIndex(firms.points, firms.generatedAt));
  const snapshot: IncidentsCachePayload = {
    version: 1,
    source: "ANEPC Ocorrências em aberto",
    generatedAt: new Date(builtAt).toISOString(),
    incidents: parsed.incidents,
    reconciliation: reconcile(parsed.incidents, fusion?.observations ?? [], builtAt),
    fusedWith: fusion ? { firmsGeneratedAt: fusion.firmsGeneratedAt, detections: fusion.observations.length } : null,
  };
  const health = nextIngestHealth(null, { attemptedAt: new Date(builtAt - 5_000).toISOString(), outcome: "success", ...parsed.counts });
  return { snapshot, health };
}
