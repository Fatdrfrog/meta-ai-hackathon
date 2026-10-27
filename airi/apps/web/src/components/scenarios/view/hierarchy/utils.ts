"use client";

import type { ScenarioSummary } from "../../types";

export const ATTACHED_SCENARIO_GAP_PX = 8;
export const DETACHED_SCENARIO_GAP_PX = 16;
export const ROOT_SCENARIO_GAP_PX = 24;

export type ScenarioDropPlacement = "before" | "after";

export type ScenarioHierarchyDropPayload = {
  draggedScenarioId: string;
  overScenarioId: string;
  placement: ScenarioDropPlacement;
};

export type ScenarioHierarchyIssueSummary = {
  count: number;
  tooltip: string;
};

export type ScenarioHierarchyIssueSummaryByScenarioId = Record<
  string,
  ScenarioHierarchyIssueSummary
>;

export type ScenarioHierarchySubscenarioIndicatorByScenarioId = Record<
  string,
  string
>;

export type ScenarioHierarchyItem = {
  scenario: ScenarioSummary;
  depth: number;
  rootScenarioId: string;
  directParentScenarioId: string | null;
};

export type ScenarioListLayoutItem = {
  item: ScenarioHierarchyItem;
  marginTopPx: number;
};

function resolveLinkedParentScenarioIds(scenario: ScenarioSummary): string[] {
  return Array.isArray(scenario.linkedParentScenarioIds)
    ? scenario.linkedParentScenarioIds.filter(Boolean)
    : [];
}

function resolveDirectParentScenarioId(
  scenario: ScenarioSummary,
  scenarioById: Map<string, ScenarioSummary>
): string | null {
  const linkedParentScenarioIds = resolveLinkedParentScenarioIds(scenario);
  if (linkedParentScenarioIds.length !== 1) return null;

  const parentScenarioId = linkedParentScenarioIds[0];
  if (!parentScenarioId || parentScenarioId === scenario._id) return null;
  return scenarioById.has(parentScenarioId) ? parentScenarioId : null;
}

export function buildScenarioHierarchy(
  scenarios: ScenarioSummary[]
): ScenarioHierarchyItem[] {
  const scenarioById = new Map(
    scenarios.map(scenario => [scenario._id, scenario] as const)
  );
  const orderedScenarioIds = scenarios.map(scenario => scenario._id);
  const childrenByParent = new Map<string, string[]>();
  const directParentByScenarioId = new Map<string, string | null>();

  for (const scenario of scenarios) {
    const directParentScenarioId = resolveDirectParentScenarioId(
      scenario,
      scenarioById
    );
    directParentByScenarioId.set(scenario._id, directParentScenarioId);
    if (!directParentScenarioId) continue;

    const children = childrenByParent.get(directParentScenarioId) ?? [];
    children.push(scenario._id);
    childrenByParent.set(directParentScenarioId, children);
  }

  const rootScenarioIds = orderedScenarioIds.filter(scenarioId => {
    const directParentScenarioId =
      directParentByScenarioId.get(scenarioId) ?? null;
    return !directParentScenarioId || directParentScenarioId === scenarioId;
  });

  const hierarchy: ScenarioHierarchyItem[] = [];
  const visited = new Set<string>();

  const walk = (scenarioId: string, depth: number, rootScenarioId: string) => {
    if (visited.has(scenarioId)) return;
    visited.add(scenarioId);

    const scenario = scenarioById.get(scenarioId);
    if (!scenario) return;

    hierarchy.push({
      scenario,
      depth,
      rootScenarioId,
      directParentScenarioId: directParentByScenarioId.get(scenarioId) ?? null,
    });

    const childScenarioIds = childrenByParent.get(scenarioId) ?? [];
    for (const childScenarioId of childScenarioIds) {
      walk(childScenarioId, depth + 1, rootScenarioId);
    }
  };

  for (const rootScenarioId of rootScenarioIds) {
    walk(rootScenarioId, 0, rootScenarioId);
  }

  for (const scenarioId of orderedScenarioIds) {
    if (!visited.has(scenarioId)) {
      walk(scenarioId, 0, scenarioId);
    }
  }

  return hierarchy;
}

export function buildScenarioListLayout(
  hierarchyItems: ScenarioHierarchyItem[]
): ScenarioListLayoutItem[] {
  if (hierarchyItems.length === 0) return [];

  const areSiblingItems = (
    item: ScenarioHierarchyItem,
    otherItem: ScenarioHierarchyItem
  ) =>
    !!item.directParentScenarioId &&
    item.depth === otherItem.depth &&
    item.directParentScenarioId === otherItem.directParentScenarioId;

  const marginTopByIndex = hierarchyItems.map((item, index) => {
    if (index === 0) return 0;
    const previousItem = hierarchyItems[index - 1];
    if (!previousItem) return 0;

    const attachedToPrevious =
      item.directParentScenarioId === previousItem.scenario._id;
    const groupedWithSibling = areSiblingItems(item, previousItem);
    if (attachedToPrevious || groupedWithSibling) {
      return ATTACHED_SCENARIO_GAP_PX;
    }

    const startsNewRootGroup =
      previousItem.rootScenarioId !== item.rootScenarioId;
    return startsNewRootGroup ? ROOT_SCENARIO_GAP_PX : DETACHED_SCENARIO_GAP_PX;
  });

  return hierarchyItems.map((item, index) => {
    return {
      item,
      marginTopPx: marginTopByIndex[index] ?? 0,
    };
  });
}

export function computeSidebarPrioritiesFromSummaries(
  scenarios: ScenarioSummary[]
): Map<string, number> {
  const layout = buildScenarioListLayout(buildScenarioHierarchy(scenarios));
  const total = layout.length;
  const priorities = new Map<string, number>();

  layout.forEach((layoutItem, index) => {
    priorities.set(layoutItem.item.scenario._id, Math.max(1, total - index));
  });

  return priorities;
}
