"use client";

import {
  isPostActionConditionNodeData,
  parsePostActionAnswerMatchHandleId,
  resolvePostActionConditionTypeFromHandle,
} from "@icecore/scenario-contracts";
import { parseScenarioActionOutcomeHandleId } from "@icecore/scenario-contracts";
import { Link2 } from "lucide-react";
import { useMemo } from "react";
import {
  canCreateScenarioPaletteItemFromHandle,
  SCENARIO_NODE_PALETTE,
} from "../../graph/node-palette";
import type {
  ScenarioFlowNode,
  ScenarioNodeData,
  TranslateFn,
} from "../../types";
import type { ScenarioNodePaletteMenuSection } from "./scenario-node-palette-menu";
import { resolveScenarioSourceHandleCopy } from "../scenario-source-handle-copy";
import { translateScenarioNodePaletteItem } from "./use-scenario-node-palette-sections";
import type { ScenarioGraphContextMenuState } from "../use-scenario-graph-controller";

type UseScenarioContextMenuParams = {
  nodesById: Map<string, ScenarioFlowNode>;
  contextMenu: ScenarioGraphContextMenuState | null;
  nodePaletteSections: ScenarioNodePaletteMenuSection[];
  t: TranslateFn;
};

function canCreateScenarioLinkFromContextMenu(
  sourceNode: ScenarioFlowNode | null,
  sourceHandleId: string | null | undefined
) {
  const sourceData = sourceNode?.data as ScenarioNodeData | undefined;
  const actionOutcome =
    sourceData?.kind === "action"
      ? parseScenarioActionOutcomeHandleId(sourceHandleId)
      : null;
  return (
    (isPostActionConditionNodeData(sourceData) &&
      Boolean(
        resolvePostActionConditionTypeFromHandle(sourceHandleId) ||
          parsePostActionAnswerMatchHandleId(sourceHandleId)
      )) ||
    actionOutcome?.type === "any_reply" ||
    actionOutcome?.type === "no_reply"
  );
}

export function useScenarioContextMenu({
  nodesById,
  contextMenu,
  nodePaletteSections,
  t,
}: UseScenarioContextMenuParams): {
  contextMenuSections: ScenarioNodePaletteMenuSection[];
  contextMenuSourceLabel: string | null;
} {
  const scenarioLinkItem = useMemo(() => {
    const item = SCENARIO_NODE_PALETTE.find(
      paletteItem => paletteItem.id === "scenario-link"
    );
    return item ? translateScenarioNodePaletteItem(item, t) : null;
  }, [t]);

  const contextMenuSections = useMemo(() => {
    if (!contextMenu) {
      return nodePaletteSections;
    }

    if (!contextMenu.connectFromNodeId) {
      return nodePaletteSections;
    }

    const sourceNode = nodesById.get(contextMenu.connectFromNodeId) ?? null;
    const connectableSections = nodePaletteSections.flatMap(section => {
      const items = section.items.filter(
        canCreateScenarioPaletteItemFromHandle
      );
      return items.length > 0 ? [{ ...section, items }] : [];
    });
    if (
      scenarioLinkItem &&
      canCreateScenarioLinkFromContextMenu(
        sourceNode,
        contextMenu.connectFromSourceHandle
      )
    ) {
      return [
        ...connectableSections,
        {
          id: "scenario_link" as const,
          title: t("scenarioLinkSection"),
          subtitle: t("scenarioLinkSectionHint"),
          icon: Link2,
          items: [scenarioLinkItem],
        },
      ];
    }

    return connectableSections;
  }, [contextMenu, nodePaletteSections, nodesById, scenarioLinkItem, t]);

  const contextMenuSourceLabel = useMemo(() => {
    if (!contextMenu?.connectFromNodeId) return null;
    const sourceNode = nodesById.get(contextMenu.connectFromNodeId) ?? null;
    const sourceCopy = resolveScenarioSourceHandleCopy({
      sourceNode,
      sourceHandleId: contextMenu.connectFromSourceHandle,
      t,
    });
    if (!sourceCopy) return null;
    return t("contextMenuSourcePrefix", { source: sourceCopy.label });
  }, [contextMenu, nodesById, t]);

  return {
    contextMenuSections,
    contextMenuSourceLabel,
  };
}
