"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { DetectionFeedSnapshot, FeedLoadStatus, ThermalDetection } from "@/lib/wildfire/types";
import { formatThousands } from "@/lib/wildfire/format";
import { calculateOverviewMetrics, selectStrongestDetections } from "@/lib/wildfire/overview-metrics";
import { assessFeedHealth, type FeedHealthAssessment } from "@/lib/wildfire/feed-health";
import { interpolate } from "@/lib/i18n/dictionaries";
import { formatDateTime, formatDecimal, formatRelative, formatShortUtcTime } from "@/lib/i18n/format";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { Dictionary, Locale } from "@/lib/i18n/types";
import PanelFooter from "./PanelFooter";
import OperationalSourceCard from "@/components/operational/OperationalSourceCard";

const STRONGEST_DETECTION_LIMIT = 5;

interface GlobalOverviewProps {
  detections: ThermalDetection[];
  countries: string[];
  selectedCountry: string;
  onCountryChange: (country: string) => void;
  onSelectDetection: (detection: ThermalDetection) => void;
  onSelectIncident: (incidentId: string) => void;
  feedSnapshot: DetectionFeedSnapshot | null;
  feedState: FeedLoadStatus;
}

export default function GlobalOverview({
  detections,
  countries,
  selectedCountry,
  onCountryChange,
  onSelectDetection,
  onSelectIncident,
  feedSnapshot,
  feedState,
}: GlobalOverviewProps) {
  const { locale, t } = useLocale();
  const [now, setNow] = useState<number | null>(null);
  const metrics = useMemo(() => calculateOverviewMetrics(detections), [detections]);
  const strongest = useMemo(() => selectStrongestDetections(detections, STRONGEST_DETECTION_LIMIT), [detections]);
  const provenance = feedSnapshot?.provenance ?? null;
  const health = useMemo(() => assessFeedHealth({
    snapshotGeneratedAt: provenance?.processedAt ?? null,
    ingest: feedSnapshot?.ingest ?? null,
    loadStatus: feedState,
    // Before the first clock tick, judge the snapshot against its own build time.
    now: now ?? (provenance ? Date.parse(provenance.processedAt) : 0),
  }), [feedSnapshot, feedState, now, provenance]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, []);

  const message = healthMessage(health, t.overview, locale);
  const tone = health.state === "degraded" || health.state === "stale"
    ? "border-amber-400/35 bg-amber-500/8"
    : health.state === "unavailable" ? "border-red-400/35 bg-red-500/8" : "border-border/60 bg-surface-muted/35";

  return (
    <div className="flex h-full flex-col gap-4 p-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t.overview.title}</h2>
        <p className="text-sm text-foreground/65">{t.overview.subtitle}</p>
      </div>

      <section aria-labelledby="feed-source-title" className={`rounded-xl border p-3.5 backdrop-blur-xl ${tone}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/65">{t.overview.sourceLabel}</p>
            <p id="feed-source-title" className="mt-1 break-words text-sm font-semibold text-foreground">
              {provenance ? `${provenance.dataset.provider} · ${provenance.dataset.product}` : "NASA FIRMS"}
            </p>
            {provenance && <p className="mt-0.5 text-xs text-foreground/65">{provenance.dataset.instrument}</p>}
          </div>
          <HealthBadge state={health.state} labels={t.overview} />
        </div>
        {message && (
          <p data-testid="feed-health-message" className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-200">{message}</p>
        )}
        {provenance && (
          <dl className="mt-3 grid gap-2 border-t border-border/45 pt-3 text-xs">
            <HealthRow label={t.overview.metricLastUpdate}>
              <time dateTime={provenance.processedAt}>{formatDateTime(provenance.processedAt, locale)}</time>
              {now !== null && (
                <span className="text-foreground/65"> · {formatRelative(provenance.processedAt, now, locale, t.overview.updatedRelative)}</span>
              )}
            </HealthRow>
            <HealthRow label={t.overview.lastAttemptLabel}>
              {health.lastAttemptAt ? (
                <>
                  <time dateTime={health.lastAttemptAt}>{formatDateTime(health.lastAttemptAt, locale)}</time>
                  {" · "}
                  {feedSnapshot?.ingest?.outcome === "failure" ? t.overview.attemptFailed : t.overview.attemptSucceeded}
                </>
              ) : t.overview.ingestUnknown}
            </HealthRow>
            {provenance.retrievedAt && (
              <HealthRow label={t.overview.lastSuccessLabel}>
                <time dateTime={provenance.retrievedAt}>{formatDateTime(provenance.retrievedAt, locale)}</time>
              </HealthRow>
            )}
          </dl>
        )}
      </section>

      <OperationalSourceCard onSelectIncident={onSelectIncident} />

      <label className="block">
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
          {t.overview.countryLabel}
        </span>
        <select
          value={selectedCountry}
          onChange={(event) => onCountryChange(event.currentTarget.value)}
          className="h-11 w-full rounded-xl border border-border/70 bg-surface/90 px-3 text-base font-medium text-foreground shadow-[0_8px_24px_rgba(0,0,0,0.16)] outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-red-500/70 sm:text-sm"
        >
          <option value="global">{t.overview.globalOption}</option>
          {countries.map((country) => <option key={country} value={country}>{country}</option>)}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <MetricCard label={t.overview.metricFoci} value={feedSnapshot ? formatThousands(detections.length) : "—"} tone="neutral" />
        <MetricCard
          label={t.overview.metricMaxFrp}
          value={metrics ? `${formatDecimal(metrics.maxFrpMw, locale)} MW` : "—"}
          tone="critical"
        />
        <MetricCard
          label={t.overview.metricAverageFrp}
          value={metrics ? `${formatDecimal(metrics.averageFrpMw, locale)} MW` : "—"}
          tone="neutral"
        />
        <MetricCard
          label={t.overview.metricHighConfidence}
          value={metrics ? formatThousands(metrics.highConfidenceCount) : "—"}
          tone="neutral"
        />
      </div>
      <p className="-mt-1 text-[11px] leading-4 text-foreground/65">{t.overview.sampleNote}</p>

      <p className="text-xs text-foreground/65">{t.overview.hint}</p>

      {feedSnapshot && (
        <section aria-labelledby="strongest-detections-title">
          <h3 id="strongest-detections-title" className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/65">
            {t.overview.strongestTitle}
          </h3>
          {strongest.length === 0 ? (
            <p className="text-xs text-foreground/65">{t.overview.strongestEmpty}</p>
          ) : (
            <ol className="space-y-1.5">
              {strongest.map((detection) => (
                <li key={detection.id}>
                  <button
                    type="button"
                    onClick={() => onSelectDetection(detection)}
                    className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface/75 px-3 py-2 text-left transition-colors hover:border-foreground/25 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {detection.country ?? formatCoordinates(detection)}
                      </span>
                      <time dateTime={detection.acquiredAt} className="mt-0.5 block font-mono text-[11px] tabular-nums text-foreground/65">
                        {formatCoordinates(detection)} · {formatShortUtcTime(detection.acquiredAt, locale)}
                      </time>
                    </span>
                    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-foreground">
                      {formatDecimal(detection.frpMw, locale)} MW
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <PanelFooter />
    </div>
  );
}

function healthMessage(health: FeedHealthAssessment, labels: Dictionary["overview"], locale: Locale): string | null {
  const time = (iso: string | null) => (iso ? formatDateTime(iso, locale) : "—");
  if (health.state === "degraded") {
    return interpolate(labels.degradedDetail, { time: time(health.snapshotGeneratedAt) });
  }
  if (health.state !== "stale") return null;
  const parts = [interpolate(labels.staleDetail, { time: time(health.snapshotGeneratedAt) })];
  if (health.ingest === "failing" || health.ingest === "degraded") {
    parts.push(interpolate(labels.staleFailingDetail, { time: time(health.lastSuccessAt ?? health.snapshotGeneratedAt) }));
  } else if (health.ingest === "stalled") {
    parts.push(interpolate(labels.staleStalledDetail, { time: time(health.lastAttemptAt) }));
  }
  return parts.join(" ");
}

function HealthBadge({ state, labels }: { state: FeedHealthAssessment["state"]; labels: Dictionary["overview"] }) {
  const label = {
    loading: labels.healthLoading,
    healthy: labels.healthHealthy,
    degraded: labels.healthDegraded,
    stale: labels.healthStale,
    unavailable: labels.healthUnavailable,
  }[state];
  const warning = state === "degraded" || state === "stale";
  const tone = warning ? "text-amber-700 dark:text-amber-200" : state === "unavailable" ? "text-red-700 dark:text-red-200" : "text-foreground/70";
  const dot = warning ? "bg-amber-400" : state === "unavailable" ? "bg-red-400" : "bg-foreground/50";

  return (
    <span
      aria-live="polite"
      data-testid="feed-health-badge"
      data-state={state}
      className={`inline-flex max-w-[10rem] shrink-0 items-center gap-1.5 text-right font-mono text-[11px] font-semibold uppercase tabular-nums tracking-[0.07em] ${tone}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function HealthRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-foreground/65">{label}</dt>
      <dd className="font-mono text-[11px] tabular-nums text-foreground/80">{children}</dd>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: "neutral" | "critical" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface/75 p-4 shadow-lg backdrop-blur-xl">
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground/65">{label}</p>
      <p className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${tone === "critical" ? "text-rose-500" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

function formatCoordinates(detection: ThermalDetection): string {
  return `${detection.location.lat.toFixed(2)}, ${detection.location.lng.toFixed(2)}`;
}
