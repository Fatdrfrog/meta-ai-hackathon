import { normalizeScenarioGraphLayout } from "@/lib/scenarios/graph-layout";
import { DEFAULT_SCENARIO_EDGE_STYLE } from "../../graph/config";
import {
  createNodeFromPaletteItem,
  SCENARIO_NODE_PALETTE,
} from "../../graph/node-palette";
import type { ScenarioActionSourceId, ScenarioFlowEdge } from "../../types";
import { resolveDefaultReplyActionPatch } from "../action/selector-utils";

export function buildEmptyFlow() {
  return normalizeScenarioGraphLayout({
    nodes: [],
    edges: [],
  });
}

/** The reply step follows the workspace's connected channel, like the palette. */
export function buildStarterFlow(
  connectedActionSources?: readonly ScenarioActionSourceId[] | null
) {
  const triggerItem = SCENARIO_NODE_PALETTE.find(
    p => p.id === "trigger-incoming-message"
  ) ?? {
    id: "trigger-incoming-message",
    kind: "trigger" as const,
  };
  const triggerNode = createNodeFromPaletteItem(triggerItem, { x: 80, y: 120 });

  const knowledgeItem = SCENARIO_NODE_PALETTE.find(
    p => p.kind === "context" && p.id === "context-knowledge"
  ) ?? {
    id: "context-knowledge",
    kind: "context" as const,
    defaults: {
      contextSources: [
        {
          optionId: "conversation_timeline",
          selectionMode: "all" as const,
          itemIds: [],
        },
        {
          optionId: "answer_snippets",
          selectionMode: "all" as const,
          itemIds: [],
        },
      ],
    },
  };
  const contextNode = createNodeFromPaletteItem(knowledgeItem, {
    x: 420,
    y: 120,
  });

  const actionItem = SCENARIO_NODE_PALETTE.find(
    item => item.id === "action-reply"
  ) ?? {
    id: "action-reply",
    kind: "action" as const,
  };
  const actionNodeBase = createNodeFromPaletteItem(actionItem, {
    x: 760,
    y: 120,
  });
  const actionNode = {
    ...actionNodeBase,
    data: {
      ...actionNodeBase.data,
      ...resolveDefaultReplyActionPatch(connectedActionSources),
    },
  };

  const edges: ScenarioFlowEdge[] = [
    {
      id: `edge-${triggerNode.id}-${contextNode.id}`,
      source: triggerNode.id,
      sourceHandle: "right-source",
      target: contextNode.id,
      targetHandle: "left-target",
      ...DEFAULT_SCENARIO_EDGE_STYLE,
    },
    {
      id: `edge-${contextNode.id}-${actionNode.id}`,
      source: contextNode.id,
      sourceHandle: "right-source",
      target: actionNode.id,
      targetHandle: "left-target",
      ...DEFAULT_SCENARIO_EDGE_STYLE,
    },
  ];

  return normalizeScenarioGraphLayout({
    nodes: [triggerNode, contextNode, actionNode],
    edges,
  });
}
