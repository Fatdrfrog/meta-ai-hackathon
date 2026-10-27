import type { ScenarioNodeEnrichmentContextValue } from "../scenario-node-enrichment-context";
import {
  buildCommonNodeEnrichment,
  selectCommonEnrichmentView,
  selectOwnNodeId,
  type ScenarioCommonEnrichmentView,
} from "./common";
import type {
  ScenarioLinkEditorNodeData,
  ScenarioPersistedNodeDataOfKind,
} from "./types";

export type ScenarioLinkEnrichmentView = ScenarioCommonEnrichmentView &
  Pick<
    ScenarioNodeEnrichmentContextValue,
    "scenarioLinkOptions" | "selectedNodeId"
  >;

export function selectLinkEnrichmentView(
  nodeId: string,
  ctx: ScenarioNodeEnrichmentContextValue
): ScenarioLinkEnrichmentView {
  return {
    ...selectCommonEnrichmentView(ctx),
    scenarioLinkOptions: ctx.scenarioLinkOptions,
    selectedNodeId: selectOwnNodeId(ctx.selectedNodeId, nodeId),
  };
}

export function enrichScenarioLinkNodeData(
  nodeId: string,
  rawData: ScenarioPersistedNodeDataOfKind<"scenario_link">,
  ctx: ScenarioLinkEnrichmentView
): ScenarioLinkEditorNodeData {
  return {
    ...rawData,
    ...buildCommonNodeEnrichment(nodeId, ctx),
    uiScenarioOptions: ctx.scenarioLinkOptions,
    uiIsEditorExpanded: ctx.selectedNodeId === nodeId,
  };
}
