"use client";

import { useMemo } from "react";
import { interpolate } from "@/lib/i18n/dictionaries";
import { formatDateTime, formatDecimal } from "@/lib/i18n/format";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import { operationalStateForSelection, type SelectionOperationalState } from "@/lib/operational/operational-view";
import type { DetectionSelection, OperationalIncident } from "@/lib/wildfire/types";
import { PhaseBadge } from "./OperationalBadges";
import { useOperationalFeed } from "./OperationalFeedProvider";

export interface DetectionOperationalView {
  state: SelectionOperationalState;
  /** The operational snapshot is older than its refresh allows. */
  stale: boolean;
  staleSince: string | null;
}

/** What the operational source says about a selected detection or cluster. */
export function useDetectionOperationalState(selection: DetectionSelection, firmsGeneratedAt: string | null): DetectionOperationalView {
  const { feed, loadState, health } = useOperationalFeed();
  return useMemo(() => ({
    // While loading, say nothing definite yet: treat it like unavailable only once loading failed with no snapshot.
    state: loadState === "loading" && !feed ? { kind: "not_reconciled" } : operationalStateForSelection(selection, feed, firmsGeneratedAt),
    stale: health.state === "stale",
    staleSince: feed?.generatedAt ?? null,
  }), [feed, firmsGeneratedAt, health.state, loadState, selection]);
}

function place(incident: OperationalIncident): string {
  return [incident.municipality, incident.parish].filter(Boolean).join(" · ") || incident.sourceId;
}

function IncidentLink({ incident, onSelectIncident }: { incident: OperationalIncident; onSelectIncident: (id: string) => void }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      onClick={() => onSelectIncident(incident.id)}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface/75 px-3 py-2 text-left transition-colors hover:border-foreground/25 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
    >
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-foreground">{place(incident)}</span>
        <span className="mt-0.5 block text-[11px] text-foreground/65">{t.operational.openIncident}</span>
      </span>
      <PhaseBadge phase={incident.phase} sourceLabel={incident.phaseLabel} />
    </button>
  );
}

/** The body of the operational-status card in a detection's details. */
export default function DetectionOperationalDetails({
  view,
  onSelectIncident,
}: {
  view: DetectionOperationalView;
  onSelectIncident: (incidentId: string) => void;
}) {
  const { locale, t } = useLocale();
  const { state } = view;
  const km = (value: number) => formatDecimal(value, locale);
  const text = "mt-2 text-xs leading-5 text-foreground/70";

  return (
    <div data-testid="operational-detail" data-state={state.kind}>
      {state.kind === "matched" && (
        <>
          <p className="mt-2 text-xs font-medium text-foreground">
            {interpolate(t.operational.matched, { distance: km(state.nearestKm) })}
            <span className="ml-1.5 text-foreground/65">· {t.operational.reportedBy}</span>
          </p>
          <div className="mt-2 space-y-1.5">
            {state.incidents.map((incident) => <IncidentLink key={incident.id} incident={incident} onSelectIncident={onSelectIncident} />)}
          </div>
          {state.locationNoteKm !== null && (
            <p className={text}>{interpolate(t.operational.locationNote, { distance: km(state.locationNoteKm) })}</p>
          )}
        </>
      )}
      {state.kind === "ambiguous" && (
        <>
          <p className={text}>{t.operational.ambiguous}</p>
          <div className="mt-2 space-y-1.5">
            {state.incidents.map((incident) => <IncidentLink key={incident.id} incident={incident} onSelectIncident={onSelectIncident} />)}
          </div>
        </>
      )}
      {state.kind === "none_nearby" && <p className={text}>{interpolate(t.operational.noneNearby, { radius: String(state.radiusKm), window: String(state.windowHours) })}</p>}
      {state.kind === "not_reconciled" && <p className={text}>{t.operational.notReconciled}</p>}
      {state.kind === "not_covered" && <p className={text}>{t.operational.notCovered}</p>}
      {state.kind === "unavailable" && <p className={text}>{t.operational.unavailable}</p>}
      {view.stale && view.staleSince && state.kind !== "not_covered" && state.kind !== "unavailable" && (
        <p className="mt-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
          {interpolate(t.operational.staleNote, { time: formatDateTime(view.staleSince, locale) })}
        </p>
      )}
    </div>
  );
}
