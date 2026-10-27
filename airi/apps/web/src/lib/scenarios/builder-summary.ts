import {
  isBulkCampaignRootNode,
  type ScenarioBuilderBulkRootSummary,
  type ScenarioBuilderSummary,
  type ScenarioBuilderTriggerSummary,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import { resolveScenarioTrigger } from "@/lib/scenarios/trigger-utils";

type ScenarioNodeLike = {
  id?: string | null;
  data?: ScenarioNodeData | null;
};

function readNodeId(node: ScenarioNodeLike): string | null {
  return typeof node.id === "string" && node.id.trim() ? node.id.trim() : null;
}

function readBulkRootWorkflowKind(
  node: ScenarioNodeLike
): ScenarioBuilderBulkRootSummary["workflowKind"] {
  if (isBulkCampaignRootNode(node)) return "bulk_campaign";
  return node.data?.bulkRootConfig?.workflowKind === "follow_up_workflow"
    ? "follow_up_workflow"
    : null;
}

export function resolveScenarioBuilderSummaryFromNodes(
  nodes: ScenarioNodeLike[]
): ScenarioBuilderSummary {
  const triggers: ScenarioBuilderTriggerSummary[] = nodes.flatMap(node => {
    if (node.data?.kind !== "trigger") return [];
    const triggerConfig = resolveScenarioTrigger(node.data);
    return [
      {
        triggerNodeId: readNodeId(node),
        triggerConfig,
        label: null,
      },
    ];
  });
  const bulkRoots: ScenarioBuilderBulkRootSummary[] = nodes.flatMap(node =>
    node.data?.kind === "bulk"
      ? [
          {
            bulkNodeId: readNodeId(node),
            workflowKind: readBulkRootWorkflowKind(node),
          },
        ]
      : []
  );
  const actionNode = nodes.find(node => node.data?.kind === "action");
  const primaryActionType = actionNode?.data
    ? resolveScenarioActionTypeFromNodeData(actionNode.data)
    : null;

  return {
    triggers,
    bulkRoots,
    primaryActionType,
  };
}
