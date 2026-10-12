"use client";

import type { ReactNode } from "react";
import { LOCATION_NOTE_KM, MATCH_RULES } from "@/lib/fusion/reconcile";
import { interpolate } from "@/lib/i18n/dictionaries";
import { formatDateTime, formatDecimal, formatUtcDateTime } from "@/lib/i18n/format";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { ANEPC_DATASET } from "@/lib/operational/anepc";
import { findIncidentView, type IncidentView } from "@/lib/operational/operational-view";
import { formatThousands } from "@/lib/wildfire/format";
import PanelFooter from "@/components/panel/PanelFooter";
import { PhaseBadge } from "./OperationalBadges";
import { useOperationalFeed } from "./OperationalFeedProvider";

interface IncidentDetailsPanelProps {
  incidentId: string;
  onClose: () => void;
}

/**
 * One official occurrence. It leads with what the authority reports (phase,
 * time, place, resources), then what satellites saw nearby, and keeps the
 * linking rules and provenance one step away, in an expandable section.
 */
export default function IncidentDetailsPanel({ incidentId, onClose }: IncidentDetailsPanelProps) {
  const { locale, t } = useLocale();
  const { feed, health } = useOperationalFeed();
  const view = findIncidentView(feed, incidentId);

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-5">
      <button
        type="button"
        onClick={onClose}
        className="-mx-2 -my-2 flex min-h-11 items-center gap-1.5 self-start rounded-lg px-2 py-2 text-xs font-medium text-foreground/65 transition-colors hover:bg-surface-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t.fireDetail.backToGlobalMap}
      </button>

      {view ? <IncidentBody view={view} /> : (
        <p data-testid="incident-closed" className="text-sm text-foreground/70">{t.operational.incidentClosed}</p>
      )}

      {view && health.state === "stale" && feed && (
        <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
          {interpolate(t.operational.staleNote, { time: formatDateTime(feed.generatedAt, locale) })}
        </p>
      )}

      {feed && (
        <details className="rounded-xl bg-surface-muted/35 px-3.5 ring-1 ring-inset ring-border/60 open:pb-3.5">
          <summary className="cursor-pointer py-3.5 text-xs font-semibold uppercase tracking-wide text-foreground/70">
            {t.operational.howLinkedTitle}
          </summary>
          <p className="mt-1 text-xs leading-5 text-foreground/70">
            {interpolate(t.operational.howLinkedText, {
              radius: formatDecimal(feed.reconciliation.rules.matchRadiusKm, locale, 0),
              window: formatDecimal(feed.reconciliation.rules.preReportWindowHours, locale, 0),
              margin: formatDecimal(feed.reconciliation.rules.ambiguityMarginKm, locale, 0),
            })}
          </p>
          <dl className="mt-3 space-y-2 text-xs">
            <Row label={t.fireDetail.provenanceSource}>
              <a href={ANEPC_DATASET.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 transition-colors hover:text-foreground">
                {ANEPC_DATASET.provider} · {ANEPC_DATASET.product}
              </a>
            </Row>
            <Row label={t.fireDetail.provenanceProcessed}>{formatUtcDateTime(feed.generatedAt, locale)} UTC</Row>
          </dl>
          <p className="mt-2.5 text-[11px] leading-4 text-foreground/65">{t.operational.attribution}</p>
        </details>
      )}

      <PanelFooter notice={t.operational.officialDisclaimer} />
    </div>
  );
}

function IncidentBody({ view }: { view: IncidentView }) {
  const { locale, t } = useLocale();
  const { incident } = view;
  const place = [incident.municipality, incident.parish].filter(Boolean).join(" · ");
  const count = (value: number | null) => (value === null ? t.operational.notReported : formatThousands(value));

  return (
    <>
      <div>
        <h2 className="text-lg font-semibold leading-snug tracking-[-0.02em] text-foreground">{t.operational.incidentTitle}</h2>
        {place && <p className="mt-1 text-sm text-foreground/65">{place}</p>}
      </div>

      <section data-testid="incident-status" aria-labelledby="incident-status-title" className="rounded-xl bg-sky-500/8 p-3.5 ring-1 ring-inset ring-sky-600/25 dark:ring-sky-300/25">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="incident-status-title" className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
            {t.fireDetail.operationalStatusLabel}
          </h3>
          <PhaseBadge phase={incident.phase} sourceLabel={incident.phaseLabel} />
        </div>
        <p className="mt-1 text-[11px] text-foreground/65">{t.operational.reportedBy}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <Stat label={t.operational.startedLabel} value={`${formatUtcDateTime(incident.startedAt, locale)} UTC`} />
          <Stat label={t.operational.updatedAtLabel} value={incident.updatedAt ? `${formatUtcDateTime(incident.updatedAt, locale)} UTC` : t.operational.notReported} />
          <Stat label={t.operational.natureLabel} value={incident.natureLabel ?? incident.natureCode} />
          <Stat label={t.operational.municipalityLabel} value={incident.municipality ?? t.operational.notReported} />
        </dl>
      </section>

      <section data-testid="incident-resources" aria-labelledby="incident-resources-title" className="rounded-xl bg-surface-muted/45 p-3.5 ring-1 ring-inset ring-border/70">
        <h3 id="incident-resources-title" className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/70">{t.operational.resourcesTitle}</h3>
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <Stat label={t.operational.personnelLabel} value={count(incident.resources.personnel)} />
          <Stat label={t.operational.groundLabel} value={count(incident.resources.groundVehicles)} />
          <Stat label={t.operational.aircraftLabel} value={count(incident.resources.aircraft)} />
        </dl>
      </section>

      <SatelliteEvidence view={view} />
    </>
  );
}

function SatelliteEvidence({ view }: { view: IncidentView }) {
  const { locale, t } = useLocale();
  const { feed } = useOperationalFeed();
  const recentHours = feed?.reconciliation.rules.recentDetectionHours ?? MATCH_RULES.recentDetectionHours;
  const { evidence } = view;
  const hasLinks = Boolean(evidence && evidence.matchedDetectionIds.length > 0);
  const ambiguousCount = evidence?.ambiguousDetectionIds.length ?? 0;

  return (
    <section data-testid="incident-satellite" data-evidence={evidence?.satellite ?? "none"} aria-labelledby="incident-satellite-title" className="rounded-xl bg-red-500/8 p-3.5 ring-1 ring-inset ring-red-500/25">
      <h3 id="incident-satellite-title" className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">{t.operational.satelliteTitle}</h3>
      {evidence && hasLinks ? (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Stat label={t.operational.linkedDetectionsLabel} value={formatThousands(evidence.matchedDetectionIds.length)} />
            {evidence.latestDetectionAt && <Stat label={t.operational.latestDetectionLabel} value={`${formatUtcDateTime(evidence.latestDetectionAt, locale)} UTC`} />}
            {evidence.maxFrpMw !== null && <Stat label={t.operational.maxFrpLabel} value={`${formatDecimal(evidence.maxFrpMw, locale)} MW`} />}
            {evidence.nearestDetectionKm !== null && <Stat label={t.operational.nearestLabel} value={`${formatDecimal(evidence.nearestDetectionKm, locale)} km`} />}
          </dl>
          {evidence.satellite === "earlier" && (
            <p className="mt-2 text-xs leading-5 text-foreground/70">{interpolate(t.operational.satelliteEarlier, { hours: String(recentHours) })}</p>
          )}
          {evidence.nearestDetectionKm !== null && evidence.nearestDetectionKm > LOCATION_NOTE_KM && (
            <p className="mt-2 text-xs leading-5 text-foreground/70">
              {interpolate(t.operational.locationNote, { distance: formatDecimal(evidence.nearestDetectionKm, locale) })}
            </p>
          )}
        </>
      ) : ambiguousCount > 0 ? (
        <p className="text-xs leading-5 text-foreground/70">
          {interpolate(t.operational.satelliteAmbiguousOnly, { count: formatThousands(ambiguousCount) })}
        </p>
      ) : (
        <p className="text-xs leading-5 text-foreground/70">{t.operational.satelliteNone}</p>
      )}
      {hasLinks && ambiguousCount > 0 && (
        <p className="mt-2 text-xs leading-5 text-foreground/70">
          {interpolate(t.operational.satelliteAmbiguous, { count: formatThousands(ambiguousCount) })}
        </p>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">{label}</dt>
      <dd className="mt-1 break-words font-mono text-xs font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
      <dt className="text-foreground/65">{label}</dt>
      <dd className="min-w-0 break-words font-mono tabular-nums text-foreground/85">{children}</dd>
    </div>
  );
}
