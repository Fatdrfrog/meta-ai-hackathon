"use client";

import { prefetchScenarioDetail } from "@/lib/scenarios/client/scenario-detail-sources";
import { useCallback, useEffect, useRef } from "react";

/**
 * How long the pointer or focus rests on a sidebar scenario before its
 * detail is read ahead, so passing over the list reads nothing.
 */
export const SCENARIO_PREFETCH_DWELL_MS = 100;

type PendingScenarioPrefetch = {
  scenarioId: string;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Reads a scenario's detail ahead of a likely open: once the pointer or
 * focus has rested on its sidebar entry, or at once when it is being
 * selected. The open scenario is never read ahead.
 */
export function useScenarioDetailPrefetch({
  workspaceId,
  activeScenarioIdRef,
}: {
  workspaceId: string;
  activeScenarioIdRef: { readonly current: string | null };
}) {
  const pendingRef = useRef<PendingScenarioPrefetch | null>(null);

  /** Drops a waiting read-ahead: any, or only this scenario's. */
  const cancelScenarioPrefetch = useCallback((scenarioId?: string) => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (scenarioId !== undefined && pending.scenarioId !== scenarioId) return;
    clearTimeout(pending.timer);
    pendingRef.current = null;
  }, []);

  const prefetchScenarioNow = useCallback(
    (scenarioId: string) => {
      cancelScenarioPrefetch();
      if (scenarioId === activeScenarioIdRef.current) return;
      prefetchScenarioDetail({ workspaceId, scenarioId });
    },
    [activeScenarioIdRef, cancelScenarioPrefetch, workspaceId]
  );

  const prefetchScenario = useCallback(
    (scenarioId: string) => {
      if (pendingRef.current?.scenarioId === scenarioId) return;
      cancelScenarioPrefetch();
      if (scenarioId === activeScenarioIdRef.current) return;
      pendingRef.current = {
        scenarioId,
        timer: setTimeout(
          () => prefetchScenarioNow(scenarioId),
          SCENARIO_PREFETCH_DWELL_MS
        ),
      };
    },
    [activeScenarioIdRef, cancelScenarioPrefetch, prefetchScenarioNow]
  );

  // Another workspace, or leaving the editor, drops a waiting read-ahead.
  useEffect(
    () => () => cancelScenarioPrefetch(),
    [cancelScenarioPrefetch, workspaceId]
  );

  return { prefetchScenario, cancelScenarioPrefetch, prefetchScenarioNow };
}
