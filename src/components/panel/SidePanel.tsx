"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { DetectionFeedSnapshot, DetectionSelection, FeedLoadStatus, ThermalDetection } from "@/lib/wildfire/types";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import FireDetailsPanel from "./FireDetailsPanel";
import GlobalOverview from "./GlobalOverview";
import IncidentDetailsPanel from "@/components/operational/IncidentDetailsPanel";

interface SidePanelProps {
  detections: ThermalDetection[];
  selection: DetectionSelection | null;
  /** An official occurrence chosen in the panel or on the map; shown instead of a detection. */
  selectedIncidentId: string | null;
  onSelectIncident: (incidentId: string) => void;
  isMinimized: boolean;
  onClose: () => void;
  onToggleMinimized: () => void;
  countries: string[];
  selectedCountry: string;
  onCountryChange: (country: string) => void;
  onSelectDetection: (detection: ThermalDetection) => void;
  feedSnapshot: DetectionFeedSnapshot | null;
  feedState: FeedLoadStatus;
}

export default function SidePanel({
  detections,
  selection,
  selectedIncidentId,
  onSelectIncident,
  isMinimized,
  onClose,
  onToggleMinimized,
  countries,
  selectedCountry,
  onCountryChange,
  onSelectDetection,
  feedSnapshot,
  feedState,
}: SidePanelProps) {
  const { t } = useLocale();
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // Always docked — "Mission Control" reads as a permanent instrument, not a
  // modal that appears/disappears. Only the content and the mobile sheet's
  // height change between the global dashboard and a single fire's detail.
  const detailOpen = selection !== null || selectedIncidentId !== null;

  return (
    <aside
      className={`mission-panel-shell fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden rounded-t-[1.5rem] border-t border-neutral-200 bg-white shadow-[0_-20px_60px_rgba(0,0,0,0.28)] transition-[max-height,transform,background-color] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none dark:border-neutral-800 dark:bg-neutral-900 md:inset-y-0 md:right-0 md:left-auto md:top-0 md:h-full md:max-h-none md:w-[400px] md:translate-y-0 md:rounded-none md:rounded-l-2xl md:border-t-0 md:border-l md:bg-white/90 md:shadow-[-18px_0_56px_rgba(0,0,0,0.24)] md:backdrop-blur-md md:dark:bg-neutral-900/90 ${
        detailOpen ? "max-h-[75vh]" : "max-h-[60vh]"
      } ${isMinimized ? "translate-y-[calc(100%-4rem)]" : "translate-y-0"}`}
    >
      <div className="relative flex h-[4.25rem] shrink-0 items-center justify-center border-b border-neutral-200 px-4 pt-1 dark:border-neutral-800 md:hidden">
        <span aria-hidden="true" className="absolute top-2 h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        <button
          type="button"
          aria-controls="mission-control-panel-content"
          aria-expanded={!isMinimized}
          onClick={onToggleMinimized}
          className="flex min-h-11 min-w-44 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-neutral-600 transition-[color,background-color,transform] duration-200 hover:bg-neutral-100/80 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/80 dark:hover:text-neutral-100 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/70"
        >
          {isMinimized ? t.panel.expand : t.panel.collapse}
          {isMinimized ? (
            <ChevronUp aria-hidden="true" className="h-4 w-4" />
          ) : (
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* tabIndex -1: the skip link can move focus here, and keyboard users can
          scroll the panel without first tabbing to a control inside it. */}
      <div id="mission-control-panel-content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth">
        <div key={selectedIncidentId ?? selection?.id ?? "overview"} className="min-h-full motion-safe:animate-[panel-content-enter_280ms_ease-out_both]">
          {isDesktop || !isMinimized ? selectedIncidentId ? (
            <IncidentDetailsPanel incidentId={selectedIncidentId} onClose={onClose} />
          ) : selection ? (
            <FireDetailsPanel
              selection={selection}
              provenance={feedSnapshot?.provenance ?? null}
              onClose={onClose}
              onSelectIncident={onSelectIncident}
            />
          ) : (
            <GlobalOverview
              detections={detections}
              countries={countries}
              selectedCountry={selectedCountry}
              onCountryChange={onCountryChange}
              onSelectDetection={onSelectDetection}
              onSelectIncident={onSelectIncident}
              feedSnapshot={feedSnapshot}
              feedState={feedState}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
}
