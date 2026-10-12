"use client";

import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { FeedHealthAssessment } from "@/lib/wildfire/feed-health";
import type { OperationalPhase } from "@/lib/wildfire/types";

/** The phase as the authority reports it; "other" shows the source's own words. */
export function PhaseBadge({ phase, sourceLabel }: { phase: OperationalPhase; sourceLabel: string }) {
  const { t } = useLocale();
  const active = phase === "in_progress" || phase === "dispatch";
  return (
    <span
      data-phase={phase}
      className={`inline-flex min-w-0 max-w-[11rem] shrink-0 items-center truncate rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ring-1 ring-inset ${
        active
          ? "bg-sky-500/10 text-sky-800 ring-sky-600/40 dark:text-sky-200 dark:ring-sky-300/40"
          : "bg-background/60 text-foreground ring-border/70"
      }`}
    >
      {phase === "other" ? <span className="truncate" title={sourceLabel}>{sourceLabel}</span> : t.operational.phase[phase]}
    </span>
  );
}

/** Health of the operational source, separate from the satellite feed's. */
export function OperationalHealthBadge({ state }: { state: FeedHealthAssessment["state"] }) {
  const { t } = useLocale();
  const label = state === "loading"
    ? t.operational.healthLoading
    : state === "unavailable" ? t.operational.healthUnavailable
      : state === "stale" ? t.operational.healthStale
        : state === "degraded" ? t.operational.healthDegraded : t.operational.healthCurrent;
  const warning = state === "stale" || state === "degraded";
  const tone = warning
    ? "text-amber-700 dark:text-amber-200"
    : state === "unavailable" ? "text-red-700 dark:text-red-200" : "text-foreground/70";
  const dot = warning ? "bg-amber-400" : state === "unavailable" ? "bg-red-400" : "bg-sky-500";
  return (
    <span
      aria-live="polite"
      data-testid="operational-health-badge"
      data-state={state}
      className={`inline-flex max-w-[10rem] shrink-0 items-center gap-1.5 text-right font-mono text-[11px] font-semibold uppercase tabular-nums tracking-[0.07em] ${tone}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
