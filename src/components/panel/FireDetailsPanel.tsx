"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { DetectionSelection, SnapshotProvenance, ValueBasis } from "@/lib/wildfire/types";
import { formatThousands } from "@/lib/wildfire/format";
import { estimateBurnedAreaHectares } from "@/lib/wildfire/fire-estimation";
import { fetchModelledWeather, type ModelledWeather } from "@/lib/weather/open-meteo";
import { formatCompactDecimal, formatDecimal, formatUtcDateTime } from "@/lib/i18n/format";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import FireTelemetryDashboard from "./FireTelemetryDashboard";
import PanelFooter from "./PanelFooter";
import DetectionOperationalDetails, { useDetectionOperationalState } from "@/components/operational/DetectionOperationalDetails";
import { PhaseBadge } from "@/components/operational/OperationalBadges";

interface FireDetailsPanelProps {
  selection: DetectionSelection;
  /** Provenance of the snapshot the selection came from; null if it is not known. */
  provenance: SnapshotProvenance | null;
  onClose: () => void;
  onSelectIncident: (incidentId: string) => void;
}

interface LocationResult {
  key: string;
  label: string | null;
  failed: boolean;
}

export default function FireDetailsPanel({ selection, provenance, onClose, onSelectIncident }: FireDetailsPanelProps) {
  const { locale, t } = useLocale();
  const operational = useDetectionOperationalState(selection, provenance?.processedAt ?? null);
  // Status comes only from a source that reports it: the linked official occurrence, if any.
  const linkedIncident = operational.state.kind === "matched" && operational.state.incidents.length === 1
    ? operational.state.incidents[0]
    : null;
  const [weather, setWeather] = useState<ModelledWeather | null>(null);
  const [weatherFailed, setWeatherFailed] = useState(false);
  const [locationResult, setLocationResult] = useState<LocationResult | null>(null);
  const locationKey = `${selection.id}:${locale}`;
  const hasCurrentLocation = locationResult?.key === locationKey;
  const locationName = hasCurrentLocation ? locationResult.label : null;
  const isCluster = selection.kind === "cluster";
  const estimatedAreaHectares = useMemo(
    () => estimateBurnedAreaHectares(selection.totalFrpMw, selection.firstAcquiredAt),
    [selection.firstAcquiredAt, selection.totalFrpMw],
  );
  const fallbackLocationName = selection.country
    ?? `${selection.location.lat.toFixed(2)}, ${selection.location.lng.toFixed(2)}`;
  const acquisitionWindow = selection.firstAcquiredAt === selection.lastAcquiredAt
    ? formatUtcDateTime(selection.lastAcquiredAt, locale)
    : `${formatUtcDateTime(selection.firstAcquiredAt, locale)} – ${formatUtcDateTime(selection.lastAcquiredAt, locale)}`;

  useEffect(() => {
    const controller = new AbortController();
    fetchModelledWeather(selection.location, controller.signal)
      .then(setWeather)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Unable to load model weather", error instanceof Error ? error.name : "unknown");
        setWeatherFailed(true);
      });
    return () => controller.abort();
  }, [selection.location]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      lat: String(selection.location.lat),
      lon: String(selection.location.lng),
      locale,
    });

    fetch(`/api/reverse-geocode?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Reverse geocode failed: ${response.status}`);
        return response.json() as Promise<{ label?: string }>;
      })
      .then((payload) => setLocationResult({
        key: locationKey,
        label: payload.label ?? null,
        failed: !payload.label,
      }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Unable to resolve the nearest place; using the country instead", error instanceof Error ? error.name : "unknown");
        setLocationResult({ key: locationKey, label: null, failed: true });
      });

    return () => controller.abort();
  }, [locale, locationKey, selection.location.lat, selection.location.lng]);

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-5">
      <button
        type="button"
        onClick={onClose}
        className="-mx-2 -my-2 flex min-h-11 items-center gap-1.5 self-start rounded-lg px-2 py-2 text-xs font-medium text-foreground/65 transition-[color,background-color,transform] duration-200 hover:bg-surface-muted/60 hover:text-foreground active:translate-x-[-2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t.fireDetail.backToGlobalMap}
      </button>

      <div
        data-testid="selected-fire-technical-readout"
        className="rounded-xl border border-red-500/20 bg-neutral-950/[0.04] p-3 dark:bg-black/20"
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/65">
              {t.fireDetail.locationReadoutLabel}
            </p>
            <p className="mt-1 truncate text-xs font-medium text-foreground/85">
              {locationName ?? fallbackLocationName}
            </p>
          </div>
          <div className="min-w-0 text-right">
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/65">
              {t.fireDetail.dateTimeUtcLabel}
            </p>
            <p className="mt-1 font-mono text-xs font-medium tabular-nums text-foreground/85">
              {formatUtcDateTime(selection.lastAcquiredAt, locale)}
            </p>
          </div>
        </div>
        <div className="mt-3 border-t border-red-500/15 pt-3">
          <p className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/65">
            {t.fireDetail.areaLabel}
            <BasisTag basis="estimated" />
          </p>
          <p className="mt-1 font-mono text-xl font-semibold leading-none tabular-nums text-foreground">
            ≈ {formatCompactDecimal(estimatedAreaHectares, locale)} <span className="text-xs font-medium text-foreground/65">ha</span>
          </p>
          <p className="mt-2 text-[11px] leading-4 text-foreground/65">
            {isCluster ? t.fireDetail.clusterAreaNote : t.fireDetail.estimatedAreaNote}
          </p>
        </div>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-snug tracking-[-0.02em] text-foreground">
            {isCluster ? t.fireDetail.clusterTitle : t.fireDetail.pointTitle}
          </h2>
          <p className="mt-1 text-sm text-foreground/65">
            {locationName ?? fallbackLocationName}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.fireDetail.closeLabel}
          className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-muted/55 text-foreground/65 ring-1 ring-inset ring-border/70 transition-[color,background-color,transform] duration-200 hover:bg-surface-muted hover:text-foreground active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <section
        data-testid="operational-status"
        aria-labelledby="operational-status-title"
        className="rounded-xl bg-surface-muted/45 p-3.5 ring-1 ring-inset ring-border/70"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="operational-status-title" className="text-xs font-semibold uppercase tracking-wide text-foreground/65">
            {t.fireDetail.operationalStatusLabel}
          </h3>
          {linkedIncident ? (
            <PhaseBadge phase={linkedIncident.phase} sourceLabel={linkedIncident.phaseLabel} />
          ) : (
            <span className="rounded-full bg-background/60 px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground ring-1 ring-inset ring-border/70">
              {t.operationalStatus[selection.operationalStatus]}
            </span>
          )}
        </div>
        {!linkedIncident && selection.operationalStatus === "unknown" && (
          <p className="mt-2 text-xs leading-5 text-foreground/65">{t.fireDetail.operationalUnknownNote}</p>
        )}
        <DetectionOperationalDetails view={operational} onSelectIncident={onSelectIncident} />
      </section>

      <section aria-labelledby="satellite-observation-title" className="rounded-xl bg-red-500/8 p-3.5 ring-1 ring-inset ring-red-500/25">
        <h3 id="satellite-observation-title" className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-300">
          {t.fireDetail.satelliteTelemetryTitle}
        </h3>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Stat
            label={isCluster ? t.fireDetail.combinedFrpLabel : t.fireDetail.frpLabel}
            basis="measured"
            value={`${formatDecimal(selection.totalFrpMw, locale)} MW`}
          />
          {isCluster ? (
            <Stat label={t.fireDetail.detectionCountLabel} value={formatThousands(selection.detectionCount)} />
          ) : (
            <Stat
              label={t.fireDetail.confidenceLabel}
              basis="reported"
              value={selection.confidence ? t.confidence[selection.confidence] : "—"}
            />
          )}
          {isCluster && (
            <Stat label={t.fireDetail.firstDetectionLabel} basis="measured" value={formatUtcDateTime(selection.firstAcquiredAt, locale)} />
          )}
          <Stat label={t.fireDetail.acquiredLabel} basis="measured" value={formatUtcDateTime(selection.lastAcquiredAt, locale)} />
          <Stat label={t.fireDetail.coordinatesLabel} value={`${selection.location.lat.toFixed(4)}, ${selection.location.lng.toFixed(4)}`} />
          <Stat label={t.fireDetail.countryLabel} basis="inferred" value={selection.country ?? "—"} />
        </dl>
        <p className="mt-3 text-xs leading-5 text-foreground/65">{t.fireDetail.footprintNote}</p>
      </section>

      {provenance && (
        <section
          data-testid="detection-provenance"
          aria-labelledby="detection-provenance-title"
          className="rounded-xl bg-surface-muted/35 p-3.5 ring-1 ring-inset ring-border/60"
        >
          <h3 id="detection-provenance-title" className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/65">
            {t.fireDetail.provenanceTitle}
          </h3>
          <dl className="space-y-2 text-xs">
            <ProvenanceRow label={t.fireDetail.provenanceSource}>
              <a
                href={provenance.dataset.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
              >
                {provenance.dataset.provider} · {provenance.dataset.product}
              </a>
            </ProvenanceRow>
            <ProvenanceRow label={t.fireDetail.provenanceInstrument}>{provenance.dataset.instrument}</ProvenanceRow>
            <ProvenanceRow label={t.fireDetail.provenanceAcquired}>{acquisitionWindow} UTC</ProvenanceRow>
            <ProvenanceRow label={t.fireDetail.provenanceRetrieved}>
              {provenance.retrievedAt ? `${formatUtcDateTime(provenance.retrievedAt, locale)} UTC` : t.fireDetail.provenanceNotRecorded}
            </ProvenanceRow>
            <ProvenanceRow label={t.fireDetail.provenanceProcessed}>
              {formatUtcDateTime(provenance.processedAt, locale)} UTC
            </ProvenanceRow>
          </dl>
          <p className="mt-2.5 text-[11px] leading-4 text-foreground/65">{provenance.dataset.attribution}</p>
        </section>
      )}

      <FireTelemetryDashboard
        key={selection.id}
        coordinates={selection.location}
        weather={weather}
        weatherFailed={weatherFailed}
        locationName={locationName ?? fallbackLocationName}
        country={selection.country}
        selectionId={selection.id}
      />

      <PanelFooter />
    </div>
  );
}

function BasisTag({ basis }: { basis: ValueBasis }) {
  const { t } = useLocale();
  return (
    <span className="rounded-full bg-background/55 px-1.5 py-0.5 font-mono text-[10px] font-semibold normal-case tracking-normal text-foreground/70 ring-1 ring-inset ring-border/70">
      {t.basis[basis]}
    </span>
  );
}

function Stat({ label, value, basis }: { label: string; value: string; basis?: ValueBasis }) {
  return (
    <div className="min-w-0">
      <dt className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground/65">
        {label}
        {basis && <BasisTag basis={basis} />}
      </dt>
      <dd className="mt-1 break-words font-mono text-xs font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function ProvenanceRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
      <dt className="text-foreground/65">{label}</dt>
      <dd className="min-w-0 break-words font-mono tabular-nums text-foreground/85">{children}</dd>
    </div>
  );
}
