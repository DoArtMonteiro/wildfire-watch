"use client";

import { useMemo } from "react";
import { interpolate } from "@/lib/i18n/dictionaries";
import { formatDateTime, formatShortUtcTime } from "@/lib/i18n/format";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { incidentViews } from "@/lib/operational/operational-view";
import { formatThousands } from "@/lib/wildfire/format";
import { OperationalHealthBadge, PhaseBadge } from "./OperationalBadges";
import { useOperationalFeed } from "./OperationalFeedProvider";

/** Enough to see what is happening without turning the overview into a list of records. */
const LIST_LIMIT = 6;

/**
 * The official-occurrence source in the overview: its own health, how many
 * rural fires are open, and the most active ones, each a keyboard route to
 * the occurrence's details.
 */
export default function OperationalSourceCard({ onSelectIncident }: { onSelectIncident: (incidentId: string) => void }) {
  const { locale, t } = useLocale();
  const { feed, health } = useOperationalFeed();
  const views = useMemo(() => incidentViews(feed), [feed]);
  const shown = views.slice(0, LIST_LIMIT);
  const warning = health.state === "stale" || health.state === "degraded" ? "border-amber-400/35 bg-amber-500/8"
    : health.state === "unavailable" ? "border-red-400/35 bg-red-500/8" : "border-border/60 bg-surface-muted/35";
  const message = health.state === "stale" && feed
    ? interpolate(t.operational.staleNote, { time: formatDateTime(feed.generatedAt, locale) })
    : health.state === "degraded" && feed
      ? interpolate(t.operational.degradedNote, { time: formatDateTime(feed.generatedAt, locale) })
      : health.state === "unavailable" ? t.operational.unavailableNote : null;

  return (
    <section aria-labelledby="operational-source-title" data-testid="operational-source" className={`rounded-xl border p-3.5 backdrop-blur-xl ${warning}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/65">{t.operational.sourceProvider}</p>
          <h3 id="operational-source-title" className="mt-1 text-sm font-semibold text-foreground">{t.operational.sourceTitle}</h3>
          <p className="mt-0.5 text-xs leading-5 text-foreground/65">{t.operational.sourceNote}</p>
        </div>
        <OperationalHealthBadge state={health.state} />
      </div>
      {message && <p data-testid="operational-health-message" className="mt-3 text-xs leading-5 text-amber-800 dark:text-amber-200">{message}</p>}

      {feed && (
        <>
          <dl className="mt-3 grid gap-2 border-t border-border/45 pt-3 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-foreground/65">{t.operational.openFiresLabel}</dt>
              <dd className="font-mono text-[11px] tabular-nums text-foreground/80">{formatThousands(views.length)}</dd>
            </div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <dt className="text-[11px] font-semibold uppercase tracking-[0.07em] text-foreground/65">{t.operational.updatedLabel}</dt>
              <dd className="font-mono text-[11px] tabular-nums text-foreground/80">
                <time dateTime={feed.generatedAt}>{formatDateTime(feed.generatedAt, locale)}</time>
              </dd>
            </div>
          </dl>

          {shown.length === 0 ? (
            <p className="mt-3 text-xs text-foreground/65">{t.operational.listEmpty}</p>
          ) : (
            <>
              <h4 id="operational-list-title" className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/65">{t.operational.listTitle}</h4>
              <ul aria-labelledby="operational-list-title" className="space-y-1.5">
                {shown.map(({ incident }) => (
                  <li key={incident.id}>
                    <button
                      type="button"
                      onClick={() => onSelectIncident(incident.id)}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface/75 px-3 py-2 text-left transition-colors hover:border-foreground/25 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {[incident.municipality, incident.parish].filter(Boolean).join(" · ") || incident.sourceId}
                        </span>
                        <time dateTime={incident.startedAt} className="mt-0.5 block font-mono text-[11px] tabular-nums text-foreground/65">
                          {t.operational.startedLabel} {formatShortUtcTime(incident.startedAt, locale)}
                        </time>
                      </span>
                      <PhaseBadge phase={incident.phase} sourceLabel={incident.phaseLabel} />
                    </button>
                  </li>
                ))}
              </ul>
              {views.length > shown.length && (
                <p className="mt-2 text-[11px] text-foreground/65">
                  {interpolate(t.operational.listMore, { count: formatThousands(views.length - shown.length) })}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
