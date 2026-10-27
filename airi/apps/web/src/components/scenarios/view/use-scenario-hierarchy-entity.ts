"use client";

import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ScenarioSummary } from "../types";
import {
  buildScenarioHierarchy,
  buildScenarioListLayout,
  type ScenarioHierarchyDropPayload,
} from "./hierarchy/utils";

export type ScenarioReorderOutcome = {
  prioritySyncScenarios: ScenarioSummary[] | null;
};

type UseScenarioHierarchyEntityParams = {
  scenarios: ScenarioSummary[];
  activeScenarioId: string | null;
  setScenarios: Dispatch<SetStateAction<ScenarioSummary[]>>;
};

function moveScenarioByPlacement(params: {
  scenarios: ScenarioSummary[];
  draggedScenarioId: string;
  overScenarioId: string;
  placement: "before" | "after";
}): { nextScenarios: ScenarioSummary[]; moved: boolean } {
  const draggedIndex = params.scenarios.findIndex(
    scenario => scenario._id === params.draggedScenarioId
  );
  const overIndex = params.scenarios.findIndex(
    scenario => scenario._id === params.overScenarioId
  );

  if (draggedIndex < 0 || overIndex < 0) {
    return {
      nextScenarios: params.scenarios,
      moved: false,
    };
  }

  let targetIndex = overIndex + (params.placement === "after" ? 1 : 0);
  if (draggedIndex < targetIndex) {
    targetIndex -= 1;
  }

  if (targetIndex === draggedIndex) {
    return {
      nextScenarios: params.scenarios,
      moved: false,
    };
  }

  const nextScenarios = [...params.scenarios];
  const [draggedScenario] = nextScenarios.splice(draggedIndex, 1);
  if (!draggedScenario) {
    return {
      nextScenarios: params.scenarios,
      moved: false,
    };
  }

  nextScenarios.splice(targetIndex, 0, draggedScenario);
  return {
    nextScenarios,
    moved: true,
  };
}

export function useScenarioHierarchyEntity({
  scenarios,
  activeScenarioId,
  setScenarios,
}: UseScenarioHierarchyEntityParams) {
  const activeScenario = useMemo(
    () => scenarios.find(scenario => scenario._id === activeScenarioId) ?? null,
    [scenarios, activeScenarioId]
  );

  const scenarioHierarchyItems = useMemo(
    () => buildScenarioHierarchy(scenarios),
    [scenarios]
  );

  const scenarioListLayoutItems = useMemo(
    () => buildScenarioListLayout(scenarioHierarchyItems),
    [scenarioHierarchyItems]
  );

  const handleScenarioReorder = useCallback(
    (params: ScenarioHierarchyDropPayload): ScenarioReorderOutcome => {
      const moveResult = moveScenarioByPlacement({
        scenarios,
        draggedScenarioId: params.draggedScenarioId,
        overScenarioId: params.overScenarioId,
        placement: params.placement,
      });
      if (!moveResult.moved) {
        return { prioritySyncScenarios: null };
      }

      setScenarios(moveResult.nextScenarios);
      return { prioritySyncScenarios: moveResult.nextScenarios };
    },
    [scenarios, setScenarios]
  );

  return {
    activeScenario,
    scenarioHierarchyItems,
    scenarioListLayoutItems,
    handleScenarioReorder,
  };
}
