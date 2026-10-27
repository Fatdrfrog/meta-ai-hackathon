"use client";

import { useCallback, useState } from "react";
import type { ScenarioStatus } from "../../types";
import type { ScenarioListLayoutItem } from "./utils";

export type SaveScenarioStatus = (params: {
  scenarioId: string;
  status: ScenarioStatus;
  priority: number;
}) => Promise<boolean> | boolean;

/** Higher in the list runs first; null when the scenario is not listed. */
export function resolveScenarioStatusPriority(
  orderedItems: ScenarioListLayoutItem[],
  scenarioId: string
): number | null {
  const positionIndex = orderedItems.findIndex(
    layoutItem => layoutItem.item.scenario._id === scenarioId
  );
  return positionIndex < 0
    ? null
    : Math.max(1, orderedItems.length - positionIndex);
}

export function useScenarioStatusToggle(
  orderedItems: ScenarioListLayoutItem[],
  onScenarioSettingsSave?: SaveScenarioStatus
) {
  const [savingSettingsScenarioId, setSavingSettingsScenarioId] = useState<
    string | null
  >(null);

  const handleStatusToggle = useCallback(
    async (scenarioId: string, checked: boolean) => {
      if (!onScenarioSettingsSave) return;
      const priority = resolveScenarioStatusPriority(orderedItems, scenarioId);
      if (priority === null) return;

      setSavingSettingsScenarioId(scenarioId);
      try {
        await onScenarioSettingsSave({
          scenarioId,
          status: checked ? "active" : "draft",
          priority,
        });
      } finally {
        setSavingSettingsScenarioId(current =>
          current === scenarioId ? null : current
        );
      }
    },
    [onScenarioSettingsSave, orderedItems]
  );

  return { handleStatusToggle, savingSettingsScenarioId };
}
