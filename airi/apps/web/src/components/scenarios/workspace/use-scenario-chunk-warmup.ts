"use client";

import { useEffect } from "react";
import {
  preloadScenarioIdleChunks,
  preloadScenarioOpenChunks,
  preloadScenarioSummaryChunks,
} from "../scenario-editor-chunks";
import { scheduleScenarioIdleTask } from "../scenario-lazy-chunk";
import type { ScenarioSummary } from "../types";

/**
 * Downloads the lazily loaded editors ahead of need: the common ones with
 * the page (in parallel with the scenario request), the ones the active
 * scenario's list entry calls for as soon as it is known, and the rest when
 * the browser is idle after the canvas shows.
 */
export function useScenarioChunkWarmup({
  scenarios,
  activeScenarioId,
  loadingScenarios,
  loadingFlow,
  nodeSettingsPanelEnabled = false,
}: {
  scenarios: readonly ScenarioSummary[];
  activeScenarioId: string | null;
  loadingScenarios: boolean;
  loadingFlow: boolean;
  nodeSettingsPanelEnabled?: boolean;
}) {
  useEffect(() => {
    preloadScenarioOpenChunks();
  }, []);

  const activeScenario = scenarios.find(item => item._id === activeScenarioId);
  const mode = activeScenario?.mode;
  const primaryActionType = activeScenario?.builderSummary?.primaryActionType;
  useEffect(() => {
    preloadScenarioSummaryChunks({ mode, primaryActionType });
  }, [mode, primaryActionType]);

  const canvasReady = !loadingScenarios && !loadingFlow;
  useEffect(() => {
    if (!canvasReady) return;
    return scheduleScenarioIdleTask(() =>
      preloadScenarioIdleChunks({ nodeSettingsPanel: nodeSettingsPanelEnabled })
    );
  }, [canvasReady, nodeSettingsPanelEnabled]);
}
