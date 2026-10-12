import assert from "node:assert/strict";
import test from "node:test";
import { nextIngestHealth, type IngestHealthRecord } from "../wildfire/ingest-health";
import { SNAPSHOT_ALERT_AFTER_MS, planIngestAlerts, planStallAlert } from "./ingest-alerts";
import { createAlertChannels, deliverAlerts, formatAlertText, parseDiscordWebhookUrl, type AlertChannel } from "./alert-channels";

const HOUR = 60 * 60 * 1_000;
const T0 = Date.parse("2026-10-02T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Runs a sequence of hourly outcomes through the same folding the scheduled ingest uses. */
function simulate(outcomes: Array<"success" | "failure">): Array<{ record: IngestHealthRecord; events: string[] }> {
  let record: IngestHealthRecord | null = null;
  return outcomes.map((outcome, hour) => {
    const now = T0 + hour * HOUR;
    const recorded: IngestHealthRecord = nextIngestHealth(record, outcome === "success"
      ? { attemptedAt: iso(now), outcome, sourceRows: 220_000, selectedPoints: 15_000 }
      : { attemptedAt: iso(now), outcome, errorCode: "http_error" });
    const plan = planIngestAlerts(recorded, now);
    const { alerts: _stored, ...rest } = recorded;
    void _stored;
    record = plan.alertState ? { ...rest, alerts: plan.alertState } : rest;
    return { record, events: plan.alerts.map((alert) => alert.event) };
  });
}

test("one or two failed runs never alert", () => {
  const runs = simulate(["success", "failure", "failure", "success"]);
  assert.deepEqual(runs.map((run) => run.events), [[], [], [], []]);
});

test("the third consecutive failure alerts once, and recovery alerts once", () => {
  const runs = simulate(["success", "failure", "failure", "failure", "failure", "success", "success"]);
  assert.deepEqual(runs.map((run) => run.events), [[], [], [], ["ingest_failing"], [], ["recovered"], []]);
  assert.equal(runs[5].record.alerts, undefined, "recovery clears the outage state");
});

test("a long outage escalates once to a stale-data alert", () => {
  const runs = simulate(["success", ...Array.from({ length: 9 }, () => "failure" as const)]);
  const events = runs.flatMap((run) => run.events);
  assert.deepEqual(events, ["ingest_failing", "snapshot_stale"]);
  const staleRun = runs.findIndex((run) => run.events.includes("snapshot_stale"));
  assert.ok(staleRun * HOUR > SNAPSHOT_ALERT_AFTER_MS);
});

test("a run that finds no recent attempt reports a stall once", () => {
  const previous = nextIngestHealth(null, { attemptedAt: iso(T0), outcome: "success" });
  const quiet = planStallAlert(previous, T0 + HOUR);
  assert.deepEqual(quiet.alerts, []);

  const stalled = planStallAlert(previous, T0 + 3 * HOUR);
  assert.deepEqual(stalled.alerts.map((alert) => alert.event), ["ingest_stalled"]);
  assert.ok(stalled.alertState?.stalledNotifiedAt);

  const again = planStallAlert({ ...previous, alerts: stalled.alertState }, T0 + 4 * HOUR);
  assert.deepEqual(again.alerts, [], "the stall is reported once per outage");

  const recovered = planIngestAlerts(
    nextIngestHealth({ ...previous, alerts: stalled.alertState }, { attemptedAt: iso(T0 + 5 * HOUR), outcome: "success" }),
    T0 + 5 * HOUR,
  );
  assert.deepEqual(recovered.alerts.map((alert) => alert.event), ["recovered"]);
});

test("alert text carries operational fields only", () => {
  const record = nextIngestHealth(
    nextIngestHealth(nextIngestHealth(null, { attemptedAt: iso(T0), outcome: "success" }), {
      attemptedAt: iso(T0 + HOUR), outcome: "failure", errorCode: "network",
    }),
    { attemptedAt: iso(T0 + 2 * HOUR), outcome: "failure", errorCode: "network", sourceRows: 12, selectedPoints: 3 },
  );
  const [alert] = planIngestAlerts(nextIngestHealth(record, {
    attemptedAt: iso(T0 + 3 * HOUR), outcome: "failure", errorCode: "network",
  }), T0 + 3 * HOUR).alerts;
  const text = formatAlertText(alert);
  assert.match(text, /FIRMS refresh failing/);
  assert.match(text, /Error code: network/);
  assert.match(text, /Consecutive failures: 3/);
  assert.match(text, /Data age: 3 h 00 min/);
  assert.doesNotMatch(text, /https?:|MAP_KEY|token/i);
});

test("channels are created only from well-formed secrets", () => {
  assert.equal(createAlertChannels({}).length, 0);
  assert.equal(parseDiscordWebhookUrl("http://discord.com/api/webhooks/1/abc"), null, "https only");
  assert.equal(parseDiscordWebhookUrl("https://evil.example/api/webhooks/1/abc"), null, "Discord hosts only");
  assert.equal(parseDiscordWebhookUrl("https://discord.com/channels/1/2"), null, "webhook paths only");
  assert.ok(parseDiscordWebhookUrl("https://discord.com/api/webhooks/123456/AbC-_x"));

  const channels = createAlertChannels({
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456/AbC-_x",
    TELEGRAM_BOT_TOKEN: "123456789:AAH-abcdefghijklmnopqrstuvwxyz_01234",
    TELEGRAM_CHAT_ID: "-1001234567890",
  });
  assert.deepEqual(channels.map((channel) => channel.name), ["discord", "telegram"]);
  assert.equal(createAlertChannels({ TELEGRAM_BOT_TOKEN: "not-a-token", TELEGRAM_CHAT_ID: "1" }).length, 0);
});

test("delivery failures are reported, never thrown, and never echo secrets", async () => {
  const [alert] = planStallAlert(nextIngestHealth(null, { attemptedAt: iso(T0), outcome: "success" }), T0 + 3 * HOUR).alerts;
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.join(" ")); };
  const channels: AlertChannel[] = [
    { name: "discord", send: async () => new Response("rejected https://discord.com/api/webhooks/1/secret", { status: 401 }) },
    { name: "telegram", send: async () => { throw new TypeError("fetch failed: https://api.telegram.org/bot123:secret/sendMessage"); } },
  ];
  try {
    const deliveries = await deliverAlerts([alert], channels);
    assert.deepEqual(deliveries, [
      { channel: "discord", delivered: false, detail: "HTTP 401" },
      { channel: "telegram", delivered: false, detail: "TypeError" },
    ]);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(logged.length, 2);
  assert.ok(logged.every((line) => !/secret|https?:/.test(line)), logged.join("\n"));
});

test("posts one message per run to each channel", async () => {
  const sent: string[] = [];
  const channel: AlertChannel = { name: "discord", send: async (text) => { sent.push(text); return new Response(null, { status: 204 }); } };
  const runs = simulate(["success", ...Array.from({ length: 9 }, () => "failure" as const)]);
  assert.deepEqual(await deliverAlerts([], [channel]), []);
  const record = runs[3].record;
  const plan = planIngestAlerts({ ...record, alerts: undefined }, T0 + 3 * HOUR);
  const deliveries = await deliverAlerts(plan.alerts, [channel]);
  assert.deepEqual(deliveries, [{ channel: "discord", delivered: true, detail: "HTTP 204" }]);
  assert.equal(sent.length, 1);
});

test("each source has its own thresholds and names itself in the alert", async () => {
  const { ANEPC_ALERT_POLICY } = await import("./ingest-alerts");
  const QUARTER = 15 * 60 * 1_000;
  let record: IngestHealthRecord | null = nextIngestHealth(null, { attemptedAt: iso(T0), outcome: "success", sourceRows: 40, selectedPoints: 6 });
  const events: string[][] = [];
  for (let run = 1; run <= 5; run += 1) {
    const recorded = nextIngestHealth(record, { attemptedAt: iso(T0 + run * QUARTER), outcome: "failure", errorCode: "network" });
    const plan = planIngestAlerts(recorded, T0 + run * QUARTER, ANEPC_ALERT_POLICY);
    events.push(plan.alerts.map((alert) => `${alert.source}:${alert.event}`));
    const { alerts: _stored, ...rest } = recorded;
    void _stored;
    record = plan.alertState ? { ...rest, alerts: plan.alertState } : rest;
  }
  // Runs every 15 minutes: four failures in a row (an hour) before alerting.
  assert.deepEqual(events, [[], [], [], ["anepc:ingest_failing"], []]);

  // Four failures in a row with no alert sent yet: the planner raises one, worded for ANEPC.
  let failing: IngestHealthRecord | null = null;
  for (let run = 0; run < 4; run += 1) {
    failing = nextIngestHealth(failing, { attemptedAt: iso(T0 + run * QUARTER), outcome: "failure", errorCode: "parse_error" });
  }
  const [alert] = planIngestAlerts(failing!, T0 + 3 * QUARTER, ANEPC_ALERT_POLICY).alerts;
  assert.ok(alert);
  const text = formatAlertText(alert);
  assert.match(text, /ANEPC refresh failing/);
  assert.match(text, /Error code: parse_error/);
  assert.doesNotMatch(text, /FIRMS/);

  const stalled = planStallAlert(nextIngestHealth(null, { attemptedAt: iso(T0), outcome: "success" }), T0 + 70 * 60 * 1_000, ANEPC_ALERT_POLICY);
  assert.deepEqual(stalled.alerts.map((entry) => `${entry.source}:${entry.event}`), ["anepc:ingest_stalled"]);
  assert.match(formatAlertText(stalled.alerts[0]), /ANEPC refresh not running/);
});

test("FIRMS alerts keep their wording and name their source", () => {
  const [alert] = planStallAlert(nextIngestHealth(null, { attemptedAt: iso(T0), outcome: "success" }), T0 + 3 * HOUR).alerts;
  assert.equal(alert.source, "firms");
  assert.match(formatAlertText(alert), /FIRMS refresh not running/);
});
