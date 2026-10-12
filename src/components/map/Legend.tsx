"use client";

import { INTENSITY_BAND_COLOR } from "@/lib/wildfire/colors";
import { useLocale } from "@/lib/i18n/LocaleProvider";
import type { RadiativeIntensityBand } from "@/lib/wildfire/types";

const ORDER: RadiativeIntensityBand[] = ["low", "moderate", "high", "very_high"];

export default function Legend() {
  const { t } = useLocale();

  return (
    <div className="pointer-events-auto rounded-xl border border-border bg-surface/90 px-3 py-2 shadow-lg backdrop-blur">
      <p id="map-legend-title" className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-foreground/65">
        {t.legend.title}
      </p>
      <ul aria-labelledby="map-legend-title" className="flex flex-col gap-1">
        {ORDER.map((band) => (
          <li key={band} className="flex items-center gap-2 font-mono text-xs text-foreground/80">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-full ring-1 ring-white/30"
              style={{ backgroundColor: INTENSITY_BAND_COLOR[band] }}
            />
            {t.legend[band]}
          </li>
        ))}
        <li className="mt-1 flex items-center gap-2 border-t border-border/60 pt-1.5 font-mono text-xs text-foreground/80">
          {/* A hollow ring, as on the map: official occurrences are a different kind of information. */}
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full border-2 border-sky-700 dark:border-sky-300" />
          {t.operational.legendLabel}
        </li>
      </ul>
    </div>
  );
}
