import { normalizeOptionalString } from "../../internal/value-normalization";
import {
  getPostActionConditionHandleId,
  hasBlockingScenarioRoutingDiagnostics,
  isPostActionConditionNodeData,
  isPostActionReplyClaimHandleId,
  parsePostActionConditionHandleId,
} from "@icecore/scenario-contracts";
import type {
  CompiledScenarioGraph,
  ScenarioRuntimeNode,
} from "../../scenario-graph";

export function hasConnectedNoReplyBranch(params: {
  conditionNodeId: string;
  edges: unknown;
  nodesById?: ReadonlyMap<string, unknown>;
}): boolean {
  const sourceHandle = getPostActionConditionHandleId("no_reply_timeout");

  return Array.isArray(params.edges)
    ? params.edges.some((edge) => {
        if (!edge || typeof edge !== "object") return false;
        const record = edge as {
          source?: unknown;
          sourceHandle?: unknown;
          target?: unknown;
        };
        const targetNodeId = normalizeOptionalString(record.target);
        return (
          normalizeOptionalString(record.source) === params.conditionNodeId &&
          normalizeOptionalString(record.sourceHandle) === sourceHandle &&
          Boolean(
            targetNodeId &&
              (!params.nodesById || params.nodesById.has(targetNodeId)),
          )
        );
      })
    : false;
}

function hasConnectedOutcomeOtherThanNoReply(params: {
  conditionNodeId: string;
  graph: Pick<CompiledScenarioGraph, "edges" | "nodesById">;
}): boolean {
  return params.graph.edges.some((edge) => {
    const targetNodeId = normalizeOptionalString(edge.target);
    if (
      normalizeOptionalString(edge.source) !== params.conditionNodeId ||
      !targetNodeId ||
      !params.graph.nodesById.has(targetNodeId)
    ) {
      return false;
    }
    const branchType = parsePostActionConditionHandleId(edge.sourceHandle);
    return (
      (branchType !== null && branchType !== "no_reply_timeout") ||
      isPostActionReplyClaimHandleId(edge.sourceHandle)
    );
  });
}

/** How a builder edit left the post-action wait a conversation is pending on. */
export type PendingPostActionWait =
  /** Routing diagnostics make the graph untrustworthy; leave the wait as is. */
  | { status: "blocked" }
  /** The wait node is gone or is no longer a post-action condition. */
  | { status: "removed" }
  | {
      status: "waiting";
      conditionNode: ScenarioRuntimeNode;
      /** The no-reply follow-up still leads to an existing node. */
      hasNoReplyBranch: boolean;
      /**
       * An any-reply, answer-match, location or payment outcome still leads
       * somewhere.
       */
      hasOtherOutcome: boolean;
    };

export function resolvePendingPostActionWait(params: {
  graph: Pick<CompiledScenarioGraph, "diagnostics" | "edges" | "nodesById">;
  conditionNodeId: string;
}): PendingPostActionWait {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return { status: "blocked" };
  }

  const conditionNode = params.graph.nodesById.get(params.conditionNodeId);
  if (
    !conditionNode ||
    conditionNode.data.kind !== "logic" ||
    !isPostActionConditionNodeData(conditionNode.data)
  ) {
    return { status: "removed" };
  }

  return {
    status: "waiting",
    conditionNode,
    hasNoReplyBranch: hasConnectedNoReplyBranch({
      conditionNodeId: params.conditionNodeId,
      edges: params.graph.edges,
      nodesById: params.graph.nodesById,
    }),
    hasOtherOutcome: hasConnectedOutcomeOtherThanNoReply({
      conditionNodeId: params.conditionNodeId,
      graph: params.graph,
    }),
  };
}
