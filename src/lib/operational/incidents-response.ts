import { readStoredIngestHealth } from "@/lib/wildfire/fires-response";
import { parseIncidentsPayload } from "./incidents-cache";

/**
 * Builds the /api/incidents body. The snapshot is a few kilobytes (tens of
 * occurrences), so unlike the FIRMS snapshot it is parsed and validated on
 * every rebuild; health is optional metadata and never blocks it.
 */
export function composeIncidentsResponseBody(snapshot: string, rawHealth: string | null): string | null {
  let payload;
  try {
    payload = parseIncidentsPayload(JSON.parse(snapshot));
  } catch {
    return null;
  }
  if (!payload) return null;
  const health = readStoredIngestHealth(rawHealth);
  return JSON.stringify(health ? { ...payload, ingestHealth: health } : payload);
}
