"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import TopBar from "@/components/layout/TopBar";
import Legend from "@/components/map/Legend";
import MapLoadingState from "@/components/map/MapLoadingState";
import MapUnavailableNotice from "@/components/map/MapUnavailableNotice";
import SidePanel from "@/components/panel/SidePanel";
import { OperationalFeedProvider } from "@/components/operational/OperationalFeedProvider";
import { fetchDetectionSnapshot } from "@/lib/wildfire/firms-adapter";
import { detectionToSelection } from "@/lib/wildfire/selection";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type {
  DetectionFeedSnapshot,
  DetectionSelection,
  FeedLoadStatus,
  ThermalDetection,
} from "@/lib/wildfire/types";
import type { BasemapMode } from "@/components/ui/BasemapToggle";
import GlobalTimelineControl from "@/components/map/GlobalTimelineControl";
import { GLOBAL_TIMELINE_HOURS, GLOBAL_TIMELINE_NOW } from "@/lib/wildfire/temporal";

// MapLibre touches `window` on import, so the map must never render during SSR.
// The branded fallback also covers the JavaScript chunk-loading window.
const FireMap = dynamic(() => import("@/components/map/FireMap"), {
  ssr: false,
  loading: () => <MapLoadingState announce={false} />,
});

/**
 * The ingest refreshes hourly. Re-reading the snapshot keeps a long-open tab
 * honest: it picks up new data instead of ageing into "stale" while a fresher
 * snapshot already exists. Hidden tabs skip the refresh.
 */
const FEED_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;

/** "unavailable": this browser or device cannot draw the map; the data is unaffected. */
type MapStatus = "loading" | "ready" | "unavailable";

export default function HomeClient() {
  const { resolvedTheme } = useTheme();
  const { t } = useLocale();
  const [feedSnapshot, setFeedSnapshot] = useState<DetectionFeedSnapshot | null>(null);
  const [feedState, setFeedState] = useState<FeedLoadStatus>("loading");
  const detections = useMemo(() => feedSnapshot?.detections ?? [], [feedSnapshot]);
  const [feedRetryNonce, setFeedRetryNonce] = useState(0);
  const [mapStatus, setMapStatus] = useState<MapStatus>("loading");
  const [selection, setSelection] = useState<DetectionSelection | null>(null);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [isPanelMinimized, setIsPanelMinimized] = useState(true);
  const [selectedCountry, setSelectedCountry] = useState("global");
  const [basemapMode, setBasemapMode] = useState<BasemapMode>("satellite");
  // Start at the right edge of the slider so every detection in the snapshot
  // is visible before the visitor opts into historical playback.
  const [timelineHour, setTimelineHour] = useState(GLOBAL_TIMELINE_NOW);
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false);

  useEffect(() => {
    if (!isTimelinePlaying) return;
    const timer = window.setInterval(() => {
      setTimelineHour((current) => current >= GLOBAL_TIMELINE_HOURS ? 0 : current + 1);
    }, 650);
    return () => window.clearInterval(timer);
  }, [isTimelinePlaying]);

  // The page request remains tiny: detections arrive from the Worker KV
  // endpoint after hydration. NASA is only contacted by the hourly ingest.
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    const load = (): void => {
      controller?.abort();
      controller = new AbortController();
      fetchDetectionSnapshot(controller.signal).then((snapshot) => {
        if (cancelled) return;
        setFeedSnapshot(snapshot);
        setFeedState("ready");
      }).catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        console.error("Unable to load the detection snapshot", error);
        // Keep the last snapshot: the overview reports it as degraded or
        // stale instead of replacing it with an empty map.
        setFeedState("error");
      });
    };

    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, FEED_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [feedRetryNonce]);

  const countries = useMemo(
    () => [...new Set(detections
      .map((detection) => detection.country)
      .filter((country): country is string => country !== null))]
      .sort((a, b) => a.localeCompare(b, "pt")),
    [detections],
  );
  const scopedDetections = useMemo(
    () => selectedCountry === "global"
      ? detections
      : detections.filter((detection) => detection.country === selectedCountry),
    [detections, selectedCountry],
  );
  const mapTheme = resolvedTheme === "light" ? "light" : "dark";
  const isMapUnavailable = mapStatus === "unavailable";
  const isInitialLoading = mapStatus === "loading" || (feedState === "loading" && !feedSnapshot);
  const panelState = selection || selectedIncidentId
    ? "detail-expanded"
    : isPanelMinimized
      ? "minimized"
      : "global-expanded";

  const handleMapLoad = useCallback(() => {
    setMapStatus("ready");
  }, []);

  const handleMapUnavailable = useCallback(() => {
    setMapStatus("unavailable");
    // The timeline is hidden with the map; a running playback would keep re-rendering.
    setIsTimelinePlaying(false);
  }, []);

  function handleMapSelect(next: DetectionSelection | null): void {
    setSelection(next);
    setSelectedIncidentId(null);
    if (next) setIsPanelMinimized(false);
  }

  // An official occurrence, from the overview list, a detection's details or the map.
  function handleIncidentSelect(incidentId: string): void {
    setSelection(null);
    setSelectedIncidentId(incidentId);
    setIsPanelMinimized(false);
  }

  // Keyboard and screen-reader route to a detection that bypasses the canvas.
  function handleDetectionSelect(detection: ThermalDetection): void {
    handleMapSelect(detectionToSelection(detection));
  }

  function handleCountryChange(country: string): void {
    setSelectedCountry(country);
    setSelection(null);
    setSelectedIncidentId(null);
    setIsPanelMinimized(false);
  }

  function handleFeedRetry(): void {
    setFeedState("loading");
    setFeedRetryNonce((value) => value + 1);
  }

  const detailOpen = selection !== null || selectedIncidentId !== null;

  return (
    <OperationalFeedProvider>
    <main
      className="wildfire-watch relative h-dvh w-full overflow-hidden"
      data-map-panel-open={detailOpen || !isPanelMinimized ? "true" : "false"}
      data-map-panel-state={panelState}
      data-map-panel-view={detailOpen ? "detail" : "global"}
      data-map-panel-minimized={isPanelMinimized ? "true" : "false"}
      data-basemap-mode={basemapMode}
    >
      <a
        href="#mission-control-panel-content"
        onClick={() => setIsPanelMinimized(false)}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-neutral-900 focus:shadow-lg dark:focus:bg-neutral-900 dark:focus:text-neutral-100"
      >
        {t.panel.skipToPanel}
      </a>
      {/* Keep MapLibre mounted under the branded lifecycle layer so it can
          measure the viewport and finish style work while data is pending.
          If it cannot draw on this device it is hidden, not unmounted: a map
          that failed after loading is left alone rather than torn down. */}
      <div
        className={`wildfire-watch-map absolute inset-0 z-0 transition-opacity duration-[400ms] motion-reduce:duration-0 ${isInitialLoading ? "opacity-0" : "opacity-100"} ${isMapUnavailable ? "hidden" : ""}`}
      >
        <FireMap
          detections={scopedDetections}
          allDetections={detections}
          selection={selection}
          onSelect={handleMapSelect}
          selectedIncidentId={selectedIncidentId}
          onSelectIncident={handleIncidentSelect}
          onMapLoad={handleMapLoad}
          onRendererUnavailable={handleMapUnavailable}
          theme={mapTheme}
          basemapMode={basemapMode}
          countryScope={selectedCountry}
          timelineHour={timelineHour}
        />
      </div>

      {isInitialLoading && <MapLoadingState />}
      {!isInitialLoading && !isMapUnavailable && feedState === "error" && (
        <MapLoadingState mode="error" onRetry={handleFeedRetry} />
      )}

      <TopBar basemapMode={basemapMode} onBasemapChange={setBasemapMode} showBasemapToggle={!isMapUnavailable} />

      {/* Persistent, so the change is announced when the notice appears. */}
      <p aria-live="polite" className="sr-only">
        {!isInitialLoading && isMapUnavailable ? t.map.unavailableTitle : ""}
      </p>
      {!isInitialLoading && isMapUnavailable && (
        // The map is not drawn, so this layer may take pointer events and scroll
        // when zoomed text or a stacked feed error does not fit.
        <div className="absolute inset-x-0 bottom-20 top-20 z-20 flex flex-col overflow-y-auto px-4 py-2 md:inset-y-0 md:right-[416px]">
          <div className="mx-auto flex w-full max-w-[28rem] flex-col gap-3 md:my-auto">
            {feedState === "error" && (
              <MapLoadingState
                mode="error"
                placement="inline"
                description={t.map.errorDescriptionWithoutMap}
                onRetry={handleFeedRetry}
              />
            )}
            <MapUnavailableNotice hasData={feedSnapshot !== null} onShowList={() => setIsPanelMinimized(false)} />
          </div>
        </div>
      )}

      {/* The timeline and legend only act on the map. */}
      {!isMapUnavailable && (
        <>
          <div className="pointer-events-none fixed inset-x-0 top-[4.75rem] z-30 flex justify-center px-3 md:top-auto md:bottom-6 md:right-[416px] md:left-0 md:px-4">
            <GlobalTimelineControl
              value={timelineHour}
              isPlaying={isTimelinePlaying}
              onChange={(nextValue) => {
                setTimelineHour(nextValue);
                setIsTimelinePlaying(false);
              }}
              onTogglePlayback={() => setIsTimelinePlaying((current) => !current)}
            />
          </div>

          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 hidden items-end justify-start p-4 md:right-[416px] md:flex">
            <Legend />
          </div>
        </>
      )}

      <SidePanel
        detections={scopedDetections}
        selection={selection}
        selectedIncidentId={selectedIncidentId}
        onSelectIncident={handleIncidentSelect}
        isMinimized={isPanelMinimized}
        onClose={() => handleMapSelect(null)}
        onToggleMinimized={() => setIsPanelMinimized((current) => !current)}
        countries={countries}
        selectedCountry={selectedCountry}
        onCountryChange={handleCountryChange}
        onSelectDetection={handleDetectionSelect}
        feedSnapshot={feedSnapshot}
        feedState={feedState}
      />
    </main>
    </OperationalFeedProvider>
  );
}
