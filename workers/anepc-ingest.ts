import {
  AnepcFeedError,
  ANEPC_PAGE_SIZE,
  buildAnepcQueryUrl,
  parseAnepcOccurrences,
  type AnepcParseResult,
} from "../src/lib/operational/anepc";
import {
  FUSION_INDEX_KEY,
  INCIDENTS_CACHE_KEY,
  INCIDENTS_INGEST_HEALTH_KEY,
  readFusionIndex,
  type IncidentsCachePayload,
} from "../src/lib/operational/incidents-cache";
import { reconcile, type FusionObservation } from "../src/lib/fusion/reconcile";
import {
  nextIngestHealth,
  parseIngestHealth,
  type IngestAttempt,
  type IngestErrorCode,
  type IngestHealthRecord,
} from "../src/lib/wildfire/ingest-health";
import { ANEPC_ALERT_POLICY, planIngestAlerts, planStallAlert, type IngestAlert } from "../src/lib/monitoring/ingest-alerts";
import { deliverAlerts, type AlertChannel, type AlertDelivery } from "../src/lib/monitoring/alert-channels";
import { accumulateSignals, type RunObservation } from "../src/lib/monitoring/daily-digest";

/**
 * Scheduled ingest of ANEPC's open rural-fire occurrences (mainland
 * Portugal). Runs every 15 minutes, independently of FIRMS: it has its own
 * snapshot, health record and alert thresholds, and a failure here never
 * touches the FIRMS data. Each successful run also reconciles the incidents
 * with the latest FIRMS detections inside the same coverage, so the browser
 * receives the links already decided, with their evidence.
 */

export const ANEPC_FETCH_TIMEOUT_MS = 20_000;
/** The open-occurrence list is normally tens of kilobytes; anything far larger is not this layer. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const USER_AGENT = "WildfireWatch (+https://github.com/WhiteBlindness/wildfire-watch)";

interface KvNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}

export interface AnepcIngestEnv {
  FIRMS_CACHE: KvNamespace;
}

export interface FusionInput {
  firmsGeneratedAt: string;
  observations: FusionObservation[];
}

export interface AnepcRefreshOptions {
  /** Defaults to Date.now; injectable for tests. */
  now?: () => number;
  channels?: AlertChannel[];
  /**
   * Detections from a FIRMS run in the same invocation. When omitted, the
   * index the last FIRMS run stored is read instead.
   */
  fusion?: FusionInput | null;
}

export interface AnepcRunReport {
  health: IngestHealthRecord;
  payload: IncidentsCachePayload | null;
  alerts: IngestAlert[];
  deliveries: AlertDelivery[];
}

class AnepcIngestFailure extends Error {
  constructor(readonly code: IngestErrorCode) {
    super(`ANEPC ingest failed (${code})`);
    this.name = "AnepcIngestFailure";
  }
}

/** fetch() rejects with a TypeError; a timeout aborts with one of these names. */
const NETWORK_ERROR_NAMES = new Set(["TypeError", "AbortError", "TimeoutError"]);

function classify(error: unknown): IngestErrorCode {
  if (error instanceof AnepcIngestFailure || error instanceof AnepcFeedError) return error.code;
  // Only the error's name is inspected; messages are never stored.
  return error instanceof Error && NETWORK_ERROR_NAMES.has(error.name) ? "network" : "unknown";
}

/** Reads the body as text, stopping as soon as it passes the cap, whatever Content-Length said. */
async function readCappedText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AnepcIngestFailure("parse_error");
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

async function readHealth(kv: KvNamespace): Promise<IngestHealthRecord | null> {
  try {
    return parseIngestHealth(await kv.get(INCIDENTS_INGEST_HEALTH_KEY, "json"));
  } catch {
    return null;
  }
}

/** True when the record was stored. Alerts are sent only after it is, so a failed write never repeats them. */
async function writeHealth(kv: KvNamespace, record: IngestHealthRecord): Promise<boolean> {
  try {
    await kv.put(INCIDENTS_INGEST_HEALTH_KEY, JSON.stringify(record));
    return true;
  } catch {
    console.warn("ANEPC ingest health could not be written");
    return false;
  }
}

async function readStoredFusion(kv: KvNamespace): Promise<FusionInput | null> {
  try {
    return readFusionIndex(await kv.get(FUSION_INDEX_KEY, "json"));
  } catch {
    return null;
  }
}

/**
 * At most this many pages (10 000 open occurrences; the layer held 53 on
 * 12/10/2026). A layer that still has more is an incomplete feed, never a
 * silently shortened list.
 */
const MAX_PAGES = 5;

async function fetchPage(offset: number): Promise<Record<string, unknown>> {
  const response = await fetch(buildAnepcQueryUrl(offset), {
    cache: "no-store",
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(ANEPC_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AnepcIngestFailure("http_error");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AnepcIngestFailure("parse_error");
  }
  if (!response.body) throw new AnepcIngestFailure("parse_error");
  const text = await readCappedText(response.body);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AnepcIngestFailure("parse_error");
  }
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

async function fetchOccurrences(now: number): Promise<AnepcParseResult> {
  const features: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await fetchPage(page * ANEPC_PAGE_SIZE);
    // An error body or an unexpected shape is judged by the parser, as for a single page.
    if (body.error || !Array.isArray(body.features)) return parseAnepcOccurrences(body, now);
    features.push(...body.features);
    if (body.exceededTransferLimit !== true) return parseAnepcOccurrences({ features }, now);
  }
  throw new AnepcIngestFailure("incomplete_feed");
}

interface IngestResult {
  payload: IncidentsCachePayload;
  parsed: AnepcParseResult;
}

async function ingest(env: AnepcIngestEnv, now: number, fusionOption: FusionInput | null | undefined): Promise<IngestResult> {
  const parsed = await fetchOccurrences(now);
  const fusion = fusionOption !== undefined ? fusionOption : await readStoredFusion(env.FIRMS_CACHE);
  const payload: IncidentsCachePayload = {
    version: 1,
    source: "ANEPC Ocorrências em aberto",
    generatedAt: new Date(now).toISOString(),
    incidents: parsed.incidents,
    reconciliation: reconcile(parsed.incidents, fusion?.observations ?? [], now),
    fusedWith: fusion ? { firmsGeneratedAt: fusion.firmsGeneratedAt, detections: fusion.observations.length } : null,
  };
  try {
    // No TTL: a failing source must not erase its last good snapshot; freshness is reported separately.
    await env.FIRMS_CACHE.put(INCIDENTS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    throw new AnepcIngestFailure("storage_error");
  }
  return { payload, parsed };
}

/** One scheduled run. Never throws for upstream problems; the report says what happened. */
export async function refreshOperationalIncidents(env: AnepcIngestEnv, options: AnepcRefreshOptions = {}): Promise<AnepcRunReport> {
  const now = options.now ?? Date.now;
  const channels = options.channels ?? [];
  const attemptedAt = new Date(now()).toISOString();
  let previous = await readHealth(env.FIRMS_CACHE);

  const deliveries: AlertDelivery[] = [];
  const stall = planStallAlert(previous, now(), ANEPC_ALERT_POLICY);
  if (stall.alerts.length > 0 && previous) {
    previous = { ...previous, alerts: stall.alertState };
    if (await writeHealth(env.FIRMS_CACHE, previous)) deliveries.push(...await deliverAlerts(stall.alerts, channels));
  }

  const startedMs = Date.now();
  let payload: IncidentsCachePayload | null = null;
  let attempt: IngestAttempt;
  let observation: RunObservation;
  try {
    const result = await ingest(env, now(), options.fusion);
    payload = result.payload;
    attempt = { attemptedAt, outcome: "success", ...result.parsed.counts };
    observation = {
      outcome: "success",
      durationMs: Date.now() - startedMs,
      invalidRecords: result.parsed.quality.invalidRecords,
      truncated: result.parsed.quality.truncated,
      unrecognisedPhases: result.parsed.quality.unrecognisedPhases,
    };
  } catch (error) {
    attempt = { attemptedAt, outcome: "failure", errorCode: classify(error) };
    observation = { outcome: "failure", durationMs: Date.now() - startedMs };
  }

  const recorded = nextIngestHealth(previous, attempt);
  const plan = planIngestAlerts(recorded, now(), ANEPC_ALERT_POLICY);
  const { alerts: _previousAlerts, ...withoutAlerts } = recorded;
  void _previousAlerts;
  const health: IngestHealthRecord = {
    ...withoutAlerts,
    ...(plan.alertState ? { alerts: plan.alertState } : {}),
    signals: accumulateSignals(previous, observation, now()),
  };

  // Record first: an alert whose debounce state could not be stored would be sent again on every run.
  if (await writeHealth(env.FIRMS_CACHE, health)) deliveries.push(...await deliverAlerts(plan.alerts, channels));
  return { health, payload, alerts: [...stall.alerts, ...plan.alerts], deliveries };
}
