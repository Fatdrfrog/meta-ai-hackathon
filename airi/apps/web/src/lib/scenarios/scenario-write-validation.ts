import {
  readScenarioGraphEnvelope,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import {
  resolveScenarioGraphBlockingNodeIds,
  validateScenarioGraph,
} from "@/lib/scenarios/graph-validation";
import { validateConditionalScenarioLinks } from "@/lib/scenarios/linked-conditions";
import {
  resolveSubscenarioLinkSummary,
  type ScenarioGraphNodeLike,
} from "@/lib/scenarios/subscenario-linking";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
export type ScenarioGraphNodeRecord = {
  id?: string;
  data?: Record<string, unknown>;
};
export type ScenarioGraphEdgeRecord = {
  source?: string;
  target?: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type ScenarioMutation = {
  $set: Record<string, unknown>;
  $unset?: Record<string, 1>;
};

export function assertScenarioStoredGraphEnvelope(
  scenario: Record<string, unknown>
): void {
  if (
    !readScenarioGraphEnvelope({
      nodes: scenario.nodes === undefined ? [] : scenario.nodes,
      edges: scenario.edges === undefined ? [] : scenario.edges,
    })
  ) {
    throw new ScenarioOperationError({ kind: "graph_payload_invalid" });
  }
}

/** Compose the existing graph/link validators in their established order. */
export async function validateScenarioWriteGraph(params: {
  workspaceId: string;
  scenarioId: string;
  nodes: ScenarioGraphNodeRecord[];
  edges: ScenarioGraphEdgeRecord[];
  options: NonNullable<Parameters<typeof validateScenarioGraph>[2]>;
}): Promise<void> {
  const graphError = validateScenarioGraph(
    params.nodes as Array<{ id: string; data: ScenarioNodeData }>,
    params.edges,
    params.options
  );
  if (graphError)
    throw new ScenarioOperationError({
      kind: "graph_invalid",
      code: graphError,
      nodeIds: resolveScenarioGraphBlockingNodeIds(
        params.nodes as Array<{ id: string; data: ScenarioNodeData }>,
        params.edges,
        graphError
      ),
    });
  const links = resolveSubscenarioLinkSummary({
    scenarioId: params.scenarioId,
    nodes: params.nodes as ScenarioGraphNodeLike[],
    edges: params.edges,
  });
  if (links.errors.length)
    throw new ScenarioOperationError({
      kind: "subscenario_links_invalid",
      codes: links.errors,
    });
  const linkedErrors = await validateConditionalScenarioLinks({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    nodes: params.nodes,
    edges: params.edges,
  });
  if (linkedErrors.length)
    throw new ScenarioOperationError({
      kind: "linked_conditions_invalid",
      codes: linkedErrors,
    });
}
