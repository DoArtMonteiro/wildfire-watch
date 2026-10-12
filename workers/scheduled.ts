import { refreshFirmsCache, type FirmsIngestEnv, type IngestRunReport } from "./firms-ingest";
import { refreshOperationalIncidents, type AnepcRunReport } from "./anepc-ingest";
import { FIRMS_INGEST_HEALTH_KEY } from "../src/lib/wildfire/firms-cache";
import { INCIDENTS_INGEST_HEALTH_KEY } from "../src/lib/operational/incidents-cache";
import { parseIngestHealth, type IngestHealthRecord } from "../src/lib/wildfire/ingest-health";
import { deliverText, type AlertChannel } from "../src/lib/monitoring/alert-channels";
import { emptySignals, formatDigestText, isDigestDue, planDigest } from "../src/lib/monitoring/daily-digest";

/**
 * What each cron trigger does. Each source has its own invocation, so its CPU
 * time is counted on its own and a run stopped for exceeding a limit can only
 * cost that source's refresh:
 *
 *   FIRMS_CRON        FIRMS only; it stores the fusion index of detections in
 *                     mainland Portugal for the ANEPC runs.
 *   OPERATIONAL_CRON  ANEPC, reconciled with that index, then the daily
 *                     summary when it is due (five minutes after FIRMS, so
 *                     the :05 run uses the index written at :00).
 *
 * Free-plan budget (per day, account-wide KV limit 1,000 writes): the hourly
 * FIRMS run writes 4 keys, each of the four ANEPC runs an hour 2 keys, and the
 * daily summary at most 3 more: about 291 writes a day.
 */
export const FIRMS_CRON = "0 * * * *";
export const OPERATIONAL_CRON = "5,20,35,50 * * * *";
export const DIGEST_STATE_KEY = "operations:digest:v1";

export type ScheduledEnv = FirmsIngestEnv;

export interface ScheduledOptions {
  now?: () => number;
  channels: AlertChannel[];
}

export interface ScheduledSummary {
  firms: IngestRunReport | null;
  anepc: AnepcRunReport | null;
  digestSent: boolean;
}

/** Each source runs in isolation: an unexpected crash in one is logged by name and the other still runs. */
async function isolated<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(`${label} scheduled run crashed`, error instanceof Error ? error.name : "unknown");
    return null;
  }
}

async function readHealth(env: ScheduledEnv, key: string): Promise<IngestHealthRecord | null> {
  try {
    return parseIngestHealth(await env.FIRMS_CACHE.get(key, "json"));
  } catch {
    return null;
  }
}

/** Starts a new signal window in a stored health record, if there is one. */
async function resetSignals(env: ScheduledEnv, key: string, record: IngestHealthRecord | null, now: number): Promise<void> {
  if (!record) return;
  await env.FIRMS_CACHE.put(key, JSON.stringify({ ...record, signals: emptySignals(new Date(now).toISOString()) })).catch(() => undefined);
}

/**
 * At most once a day: the day is recorded before anything is sent, and if
 * that record cannot be read or written (for example when the daily KV write
 * limit is reached) nothing is sent. A summary can be lost, never repeated.
 */
async function runDigest(env: ScheduledEnv, channels: AlertChannel[], now: number): Promise<boolean> {
  let lastPlannedAt: string | null;
  try {
    const state = await env.FIRMS_CACHE.get<{ lastPlannedAt?: unknown }>(DIGEST_STATE_KEY, "json");
    lastPlannedAt = typeof state?.lastPlannedAt === "string" ? state.lastPlannedAt : null;
  } catch {
    return false;
  }
  if (!isDigestDue(lastPlannedAt, now)) return false;

  const [firms, anepc] = await Promise.all([readHealth(env, FIRMS_INGEST_HEALTH_KEY), readHealth(env, INCIDENTS_INGEST_HEALTH_KEY)]);
  const plan = planDigest([{ source: "firms", signals: firms?.signals }, { source: "anepc", signals: anepc?.signals }]);
  try {
    await env.FIRMS_CACHE.put(DIGEST_STATE_KEY, JSON.stringify({ version: 1, lastPlannedAt: new Date(now).toISOString() }));
  } catch {
    return false;
  }
  if (plan) await deliverText(formatDigestText(plan, now), channels);
  await resetSignals(env, FIRMS_INGEST_HEALTH_KEY, firms, now);
  await resetSignals(env, INCIDENTS_INGEST_HEALTH_KEY, anepc, now);
  return plan !== null;
}

export async function runScheduled(cron: string, env: ScheduledEnv, options: ScheduledOptions): Promise<ScheduledSummary> {
  const now = options.now ?? Date.now;
  const { channels } = options;

  if (cron === FIRMS_CRON) {
    const firms = await isolated("FIRMS", () => refreshFirmsCache(env, { now, channels }));
    return { firms, anepc: null, digestSent: false };
  }

  const anepc = await isolated("ANEPC", () => refreshOperationalIncidents(env, { now, channels }));
  const digestSent = (await isolated("Daily summary", () => runDigest(env, channels, now()))) ?? false;
  return { firms: null, anepc, digestSent };
}
