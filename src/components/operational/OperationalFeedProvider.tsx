"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchOperationalSnapshot } from "@/lib/operational/incidents-client";
import type { OperationalFeedSnapshot } from "@/lib/operational/operational-view";
import { OPERATIONAL_FEED_TIMING, assessFeedHealth, type FeedHealthAssessment } from "@/lib/wildfire/feed-health";
import type { FeedLoadStatus } from "@/lib/wildfire/types";

/** The ingest refreshes every 15 minutes; re-reading every 5 keeps an open tab close to it. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const CLOCK_INTERVAL_MS = 60 * 1_000;

interface OperationalFeedValue {
  /** The last good snapshot; kept when a later refresh fails. */
  feed: OperationalFeedSnapshot | null;
  loadState: FeedLoadStatus;
  health: FeedHealthAssessment;
}

const OperationalFeedContext = createContext<OperationalFeedValue | null>(null);

/**
 * Loads the operational source on its own, so that it failing or being slow
 * never affects the satellite feed, and exposes its health with the
 * operational timing (stale after 45 minutes).
 */
export function OperationalFeedProvider({ children }: { children: ReactNode }) {
  const [feed, setFeed] = useState<OperationalFeedSnapshot | null>(null);
  const [loadState, setLoadState] = useState<FeedLoadStatus>("loading");
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = (): void => {
      controller?.abort();
      controller = new AbortController();
      fetchOperationalSnapshot(controller.signal).then((snapshot) => {
        if (cancelled) return;
        setFeed(snapshot);
        setLoadState("ready");
      }).catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        // A warning, not an error: the page works without this source.
        console.warn("Operational incidents unavailable", error instanceof Error ? error.message : "unknown");
        setLoadState("error");
      });
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  const value = useMemo<OperationalFeedValue>(() => ({
    feed,
    loadState,
    health: assessFeedHealth({
      snapshotGeneratedAt: feed?.generatedAt ?? null,
      ingest: feed?.ingest ?? null,
      loadStatus: loadState,
      // Before the first clock tick, judge the snapshot against its own build time.
      now: now ?? (feed ? Date.parse(feed.generatedAt) : 0),
    }, OPERATIONAL_FEED_TIMING),
  }), [feed, loadState, now]);

  return <OperationalFeedContext.Provider value={value}>{children}</OperationalFeedContext.Provider>;
}

export function useOperationalFeed(): OperationalFeedValue {
  const value = useContext(OperationalFeedContext);
  if (!value) throw new Error("useOperationalFeed must be used inside OperationalFeedProvider");
  return value;
}
