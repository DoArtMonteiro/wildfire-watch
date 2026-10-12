import type { AlertSource, IngestAlert, IngestAlertEvent } from "./ingest-alerts";

/**
 * Optional operator notification channels. Each is configured by Worker
 * secrets and is skipped when its secrets are absent or malformed; the app
 * never depends on any of them. A failing channel is logged by name and HTTP
 * status only, never with its URL or token.
 */
export interface AlertChannelEnv {
  DISCORD_WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export interface AlertChannel {
  name: "discord" | "telegram";
  send(text: string, signal: AbortSignal): Promise<Response>;
}

export interface AlertDelivery {
  channel: AlertChannel["name"];
  delivered: boolean;
  /** HTTP status, or a short reason; never upstream response text. */
  detail: string;
}

export const ALERT_TIMEOUT_MS = 5_000;
const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT_PATTERN = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

const EVENT_TITLES: Record<AlertSource, Record<IngestAlertEvent, string>> = {
  firms: {
    ingest_failing: "FIRMS refresh failing",
    snapshot_stale: "Map data is stale",
    ingest_stalled: "FIRMS refresh not running",
    recovered: "FIRMS refresh recovered",
  },
  anepc: {
    ingest_failing: "ANEPC refresh failing",
    snapshot_stale: "Operational data is stale",
    ingest_stalled: "ANEPC refresh not running",
    recovered: "ANEPC refresh recovered",
  },
};

const KEPT_LABEL: Record<AlertSource, string> = { firms: "Selected points", anepc: "Incidents kept" };

/** Accepts only an https Discord webhook URL, so a misconfigured secret cannot send data elsewhere. */
export function parseDiscordWebhookUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !DISCORD_HOSTS.has(url.hostname)) return null;
    if (!/^\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function createAlertChannels(env: AlertChannelEnv): AlertChannel[] {
  const channels: AlertChannel[] = [];

  const discordUrl = parseDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL);
  if (discordUrl) {
    channels.push({
      name: "discord",
      send: (text, signal) => fetch(discordUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // An empty parse list stops the text from pinging anyone.
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
        signal,
      }),
    });
  }

  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (token && chatId && TELEGRAM_TOKEN_PATTERN.test(token) && TELEGRAM_CHAT_PATTERN.test(chatId)) {
    channels.push({
      name: "telegram",
      send: (text, signal) => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal,
      }),
    });
  }

  return channels;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-GB");

function formatAge(ms: number | null): string {
  if (ms === null) return "not recorded";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${String(minutes).padStart(2, "0")} min` : `${minutes} min`;
}

function formatUtc(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "not recorded";
}

/** Plain text built only from typed fields; nothing from an upstream response is copied in. */
export function formatAlertText(alert: IngestAlert): string {
  const lines = [
    `WildfireWatch · ${EVENT_TITLES[alert.source][alert.event]}`,
    `Detected: ${formatUtc(alert.detectedAt)}`,
    `Last attempt: ${formatUtc(alert.lastAttemptAt)}${alert.outcome ? ` (${alert.outcome})` : ""}`,
  ];
  if (alert.errorCode) lines.push(`Error code: ${alert.errorCode}`);
  if (alert.consecutiveFailures > 0) lines.push(`Consecutive failures: ${alert.consecutiveFailures}`);
  lines.push(`Data age: ${formatAge(alert.snapshotAgeMs)}`);
  if (alert.sourceRows !== null || alert.selectedPoints !== null) {
    lines.push(`Source rows: ${alert.sourceRows === null ? "n/a" : NUMBER_FORMAT.format(alert.sourceRows)}`
      + ` · ${KEPT_LABEL[alert.source]}: ${alert.selectedPoints === null ? "n/a" : NUMBER_FORMAT.format(alert.selectedPoints)}`);
  }
  return lines.join("\n");
}

/** Sends every alert to every configured channel, as one message. Never throws. */
export async function deliverAlerts(alerts: IngestAlert[], channels: AlertChannel[]): Promise<AlertDelivery[]> {
  if (alerts.length === 0) return [];
  return deliverText(alerts.map(formatAlertText).join("\n\n"), channels);
}

/** Sends one message, built only from typed fields, to every configured channel. Never throws. */
export async function deliverText(text: string, channels: AlertChannel[]): Promise<AlertDelivery[]> {
  if (channels.length === 0) return [];
  return Promise.all(channels.map(async (channel): Promise<AlertDelivery> => {
    try {
      const response = await channel.send(text, AbortSignal.timeout(ALERT_TIMEOUT_MS));
      // The body is not read: it can echo request details and is not needed.
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) console.warn(`Alert channel ${channel.name} rejected the message (HTTP ${response.status})`);
      return { channel: channel.name, delivered: response.ok, detail: `HTTP ${response.status}` };
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown";
      console.warn(`Alert channel ${channel.name} unreachable (${reason})`);
      return { channel: channel.name, delivered: false, detail: reason };
    }
  }));
}
