"use client";

import { BrainCircuit, GitBranch, Send, Users, Zap } from "lucide-react";
import { useMemo } from "react";
import {
  SCENARIO_NODE_PALETTE,
  type ScenarioNodePaletteItem,
} from "../../graph/node-palette";
import type { TranslateFn } from "../../types";
import type { ScenarioNodePaletteMenuSection } from "./scenario-node-palette-menu";

export function translateScenarioNodePaletteItem(
  item: ScenarioNodePaletteItem,
  t: TranslateFn
): ScenarioNodePaletteItem {
  return {
    ...item,
    title: item.titleKey ? t(item.titleKey) : item.title,
  };
}

export function scenarioGraphHasFlowRoot(
  nodes: Array<{ data?: { kind?: string } | null } | null | undefined>
): boolean {
  return nodes.some(
    node => node?.data?.kind === "trigger" || node?.data?.kind === "bulk"
  );
}

export function useScenarioNodePaletteSections(
  t: TranslateFn,
  options?: { hasFlowRoot?: boolean }
): {
  nodePaletteSections: ScenarioNodePaletteMenuSection[];
} {
  const hasFlowRoot = options?.hasFlowRoot ?? true;
  const rootLockedHint = t("canvasEmptyHintSecondary");

  const applyRootGate = useMemo(
    () =>
      (item: ScenarioNodePaletteItem): ScenarioNodePaletteItem => {
        if (hasFlowRoot || item.kind === "trigger" || item.kind === "bulk") {
          return item;
        }
        return {
          ...item,
          disabled: true,
          disabledHint: rootLockedHint,
        };
      },
    [hasFlowRoot, rootLockedHint]
  );

  const contextItems = useMemo<ScenarioNodePaletteItem[]>(() => {
    const item = SCENARIO_NODE_PALETTE.find(
      item => item.kind === "context" && item.id === "context-knowledge"
    );
    return item
      ? [applyRootGate(translateScenarioNodePaletteItem(item, t))]
      : [];
  }, [applyRootGate, t]);

  const translatedPaletteItems = useMemo(
    () =>
      SCENARIO_NODE_PALETTE.filter(item => !item.hiddenFromMenu).map(item =>
        applyRootGate(translateScenarioNodePaletteItem(item, t))
      ),
    [applyRootGate, t]
  );

  const nodePaletteSections = useMemo<ScenarioNodePaletteMenuSection[]>(
    () => [
      {
        id: "trigger",
        title: t("startTriggerSection"),
        subtitle: t("startTriggerSectionHint"),
        icon: Zap,
        items: translatedPaletteItems.filter(item => item.kind === "trigger"),
      },
      {
        id: "bulk",
        title: t("audienceCampaignSection"),
        subtitle: t("audienceCampaignSectionHint"),
        icon: Users,
        items: translatedPaletteItems.filter(item => item.kind === "bulk"),
      },
      {
        id: "action",
        title: t("messageSection"),
        subtitle: t("messageSectionHint"),
        icon: Send,
        items: translatedPaletteItems.filter(item => item.kind === "action"),
      },
      {
        id: "logic",
        title: t("scenarioGatesSection"),
        icon: GitBranch,
        items: translatedPaletteItems.filter(item => item.kind === "logic"),
      },
      {
        id: "context",
        title: t("aiContext"),
        subtitle: t("aiContextSectionHint"),
        icon: BrainCircuit,
        items: contextItems,
      },
    ],
    [contextItems, t, translatedPaletteItems]
  );

  return {
    nodePaletteSections,
  };
}
