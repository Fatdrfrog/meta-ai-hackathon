"use client";

import { toScenarioSummary } from "@/lib/scenarios/scenario-summary-serialization";
import type { ScenarioSidebarPatch } from "@/lib/scenarios/client";
import type { ScenarioDocument, ScenarioSummary } from "../types";

type ScenarioSummaryOverrides = Partial<
  Pick<ScenarioSummary, "nodeCount" | "edgeCount">
>;

type ScenarioEntryFieldValues = {
  priority?: number | null;
};

export type ScenarioSidebarSnapshot = Pick<
  ScenarioSummary,
  keyof ScenarioSidebarPatch | "updatedAt"
>;

export function patchScenarioSummaryFields(
  scenario: ScenarioSummary,
  patch: Partial<ScenarioSidebarSnapshot>
): ScenarioSummary {
  return {
    ...scenario,
    ...patch,
  };
}

export function replaceScenarioSummary(
  scenarios: ScenarioSummary[],
  scenario: ScenarioDocument,
  overrides?: ScenarioSummaryOverrides
): ScenarioSummary[] {
  const nextSummary = {
    ...toScenarioSummary(scenario),
    ...(overrides ?? {}),
  };

  return scenarios.map(item =>
    item._id === nextSummary._id ? nextSummary : item
  );
}

export function prependScenarioSummary(
  scenarios: ScenarioSummary[],
  scenario: ScenarioDocument
): ScenarioSummary[] {
  const nextSummary = toScenarioSummary(scenario);
  return [
    nextSummary,
    ...scenarios.filter(item => item._id !== nextSummary._id),
  ];
}

export function applyScenarioEntryInputs(params: {
  scenario: ScenarioEntryFieldValues;
  setEntryPriorityInput: (value: string) => void;
}) {
  params.setEntryPriorityInput(String(params.scenario.priority ?? 0));
}
