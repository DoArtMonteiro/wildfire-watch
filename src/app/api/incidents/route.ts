import { getCloudflareContext } from "@opennextjs/cloudflare";
import { INCIDENTS_CACHE_KEY, INCIDENTS_INGEST_HEALTH_KEY } from "@/lib/operational/incidents-cache";
import { composeIncidentsResponseBody } from "@/lib/operational/incidents-response";
import { TtlCache, errorName } from "@/lib/server/upstream-guard";

export const dynamic = "force-dynamic";

const UNAVAILABLE_HEADERS = { "Cache-Control": "no-store" };

/**
 * Operational incidents (ANEPC, mainland Portugal), already reconciled with
 * the FIRMS detections by the scheduled ingest. Served independently of
 * /api/fires so that either source can be unavailable without the other.
 * Kept in memory for a minute per isolate, which bounds KV reads.
 */
const SNAPSHOT_MEMORY_MS = 60_000;
const responses = new TtlCache<string>(1, SNAPSHOT_MEMORY_MS);

function snapshotResponse(body: string, source: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
      "X-Wildfire-Source": source,
    },
  });
}

export async function GET(): Promise<Response> {
  const remembered = responses.get("snapshot");
  if (remembered) return snapshotResponse(remembered, "memory");

  try {
    const { env } = await getCloudflareContext({ async: true });
    const [snapshot, rawHealth] = await Promise.all([
      env.FIRMS_CACHE.get(INCIDENTS_CACHE_KEY),
      env.FIRMS_CACHE.get(INCIDENTS_INGEST_HEALTH_KEY).catch(() => null),
    ]);
    if (!snapshot) {
      return Response.json({ error: "Operational incidents have not been ingested yet" }, { status: 503, headers: UNAVAILABLE_HEADERS });
    }
    const body = composeIncidentsResponseBody(snapshot, rawHealth);
    if (!body) {
      return Response.json({ error: "Operational incidents snapshot is not valid" }, { status: 503, headers: UNAVAILABLE_HEADERS });
    }
    responses.set("snapshot", body);
    return snapshotResponse(body, "cloudflare-kv");
  } catch (error) {
    console.error("Unable to read operational incidents", errorName(error));
    return Response.json({ error: "Operational incidents unavailable" }, { status: 503, headers: UNAVAILABLE_HEADERS });
  }
}
