import { parseIngestHealth } from "@/lib/wildfire/ingest-health";
import { parseIncidentsPayload } from "./incidents-cache";
import type { OperationalFeedSnapshot } from "./operational-view";

/**
 * Reads the reconciled operational snapshot from the Worker. ANEPC is never
 * contacted from the browser: the scheduled ingest stores the snapshot and
 * /api/incidents serves it, independently of the FIRMS feed.
 */
export async function fetchOperationalSnapshot(signal?: AbortSignal): Promise<OperationalFeedSnapshot> {
  const response = await fetch("/api/incidents", { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Operational incidents request failed: ${response.status}`);
  const raw: unknown = await response.json();
  const payload = parseIncidentsPayload(raw);
  if (!payload) throw new Error("Operational incidents response has an unrecognised shape");
  return { ...payload, ingest: parseIngestHealth((raw as { ingestHealth?: unknown }).ingestHealth) };
}
