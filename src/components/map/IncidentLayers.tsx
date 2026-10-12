"use client";

import { useMemo } from "react";
import { Layer, Source } from "react-map-gl/maplibre";
import { useOperationalFeed } from "@/components/operational/OperationalFeedProvider";
import type { BasemapMode, MapTheme } from "./mapPresentation";

export const INCIDENT_SOURCE_ID = "operational-incidents-src";
export const INCIDENT_LAYER_ID = "operational-incidents";
export const INCIDENT_HIT_AREA_LAYER_ID = "operational-incidents-hit-area";
const INCIDENT_HALO_LAYER_ID = "operational-incidents-halo";

/**
 * Official occurrences as hollow rings, so they read as a different kind of
 * information from the filled, warm-coloured satellite detections and never
 * hide them. A halo keeps the ring visible on imagery and on both themes.
 */
const RING_COLOUR = { onDark: "#7dd3fc", onLight: "#0369a1" } as const;
const HALO_COLOUR = { onDark: "#0f172a", onLight: "#ffffff" } as const;

export function incidentRingColours(theme: MapTheme, basemapMode: BasemapMode): { ring: string; halo: string } {
  const light = basemapMode === "plain" && theme === "light";
  return light
    ? { ring: RING_COLOUR.onLight, halo: HALO_COLOUR.onLight }
    : { ring: RING_COLOUR.onDark, halo: HALO_COLOUR.onDark };
}

export default function IncidentLayers({
  selectedIncidentId,
  theme,
  basemapMode,
}: {
  selectedIncidentId: string | null;
  theme: MapTheme;
  basemapMode: BasemapMode;
}) {
  const { feed, health } = useOperationalFeed();
  // Out-of-date occurrences stay visible, faded, so the map does not present them as current.
  const opacity = health.state === "stale" ? 0.4 : 1;
  const data = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(() => ({
    type: "FeatureCollection",
    features: (feed?.incidents ?? []).map((incident) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [incident.location.lng, incident.location.lat] },
      properties: { incidentId: incident.id, selected: incident.id === selectedIncidentId },
    })),
  }), [feed, selectedIncidentId]);
  const { ring, halo } = incidentRingColours(theme, basemapMode);
  const radius: ["case", ["get", string], number, number] = ["case", ["get", "selected"], 12, 9];

  return (
    <Source id={INCIDENT_SOURCE_ID} type="geojson" data={data}>
      <Layer
        id={INCIDENT_HIT_AREA_LAYER_ID}
        type="circle"
        paint={{ "circle-radius": 18, "circle-opacity": 0, "circle-stroke-opacity": 0 }}
      />
      <Layer
        id={INCIDENT_HALO_LAYER_ID}
        type="circle"
        paint={{ "circle-radius": radius, "circle-opacity": 0, "circle-stroke-width": 5.5, "circle-stroke-color": halo, "circle-stroke-opacity": 0.75 * opacity }}
      />
      <Layer
        id={INCIDENT_LAYER_ID}
        type="circle"
        paint={{
          "circle-radius": radius,
          "circle-opacity": 0,
          "circle-stroke-width": ["case", ["get", "selected"], 4, 2.5],
          "circle-stroke-color": ring,
          "circle-stroke-opacity": opacity,
        }}
      />
    </Source>
  );
}
