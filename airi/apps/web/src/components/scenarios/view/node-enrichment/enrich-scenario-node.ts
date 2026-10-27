import { isScenarioNodeKind } from "@icecore/scenario-contracts";
import { resolveScenarioFlowNodeType } from "../../graph/node-type";
import type { ScenarioFlowNode, ScenarioNodeKind } from "../../types";
import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import { enrichActionNodeData, selectActionEnrichmentView } from "./action";
import { enrichBulkRootNodeData, selectBulkEnrichmentView } from "./bulk";
import { enrichContextNodeData, selectContextEnrichmentView } from "./context";
import { enrichScenarioLinkNodeData, selectLinkEnrichmentView } from "./link";
import { enrichLogicNodeData, selectLogicEnrichmentView } from "./logic";
import { enrichTriggerNodeData, selectTriggerEnrichmentView } from "./trigger";
import type {
  ScenarioEditorFlowNode,
  ScenarioEditorNodeData,
  ScenarioPersistedNodeDataOfKind,
} from "./types";

type AnyKindData = ScenarioPersistedNodeDataOfKind<ScenarioNodeKind>;

/**
 * What a node of this kind reads from the context, or null when its editor
 * data must be built again on every pass.
 */
export function selectScenarioNodeEnrichmentView(
  kind: ScenarioNodeKind,
  nodeId: string,
  rawData: AnyKindData,
  ctx: ScenarioNodeEnrichmentContextValue
): object | null {
  switch (kind) {
    case "trigger":
      return selectTriggerEnrichmentView(
        nodeId,
        rawData as ScenarioPersistedNodeDataOfKind<"trigger">,
        ctx
      );
    case "action":
      return selectActionEnrichmentView(nodeId, ctx);
    case "bulk":
      return selectBulkEnrichmentView(nodeId, ctx);
    case "context":
      return selectContextEnrichmentView(ctx);
    case "logic":
      return selectLogicEnrichmentView(nodeId, ctx);
    case "scenario_link":
      return selectLinkEnrichmentView(nodeId, ctx);
  }
}

/**
 * A node's editor data from its persisted data and either the whole context
 * or its view from `selectScenarioNodeEnrichmentView`: both give the same
 * result.
 */
export function enrichScenarioNodeData(
  kind: ScenarioNodeKind,
  nodeId: string,
  rawData: AnyKindData,
  ctx: object
): ScenarioEditorNodeData {
  switch (kind) {
    case "trigger":
      return enrichTriggerNodeData(nodeId, rawData as never, ctx as never);
    case "action":
      return enrichActionNodeData(nodeId, rawData as never, ctx as never);
    case "bulk":
      return enrichBulkRootNodeData(nodeId, rawData as never, ctx as never);
    case "context":
      return enrichContextNodeData(nodeId, rawData as never, ctx as never);
    case "logic":
      return enrichLogicNodeData(nodeId, rawData as never, ctx as never);
    case "scenario_link":
      return enrichScenarioLinkNodeData(nodeId, rawData as never, ctx as never);
  }
}

/** The persisted node's editor node: its renderer type and editor data. */
export function toScenarioEditorNode(
  node: ScenarioFlowNode,
  kind: ScenarioNodeKind,
  data: ScenarioEditorNodeData
): ScenarioEditorFlowNode {
  const nodeWithoutSelection = { ...node };
  delete nodeWithoutSelection.selected;
  return {
    ...nodeWithoutSelection,
    type: resolveScenarioFlowNodeType(kind),
    data,
  } as ScenarioEditorFlowNode;
}

export function readScenarioNodeKind(
  node: ScenarioFlowNode
): ScenarioNodeKind | null {
  const kind = node.data?.kind;
  return isScenarioNodeKind(kind) ? kind : null;
}

/**
 * Projects one persisted node into its editor node. The canvas and the node
 * settings panel share this projection, so both receive the same commands.
 */
export function enrichScenarioEditorNode(
  node: ScenarioFlowNode,
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioEditorFlowNode | null {
  const kind = readScenarioNodeKind(node);
  if (!kind) return null;
  return toScenarioEditorNode(
    node,
    kind,
    enrichScenarioNodeData(kind, node.id, node.data as AnyKindData, ctx)
  );
}
