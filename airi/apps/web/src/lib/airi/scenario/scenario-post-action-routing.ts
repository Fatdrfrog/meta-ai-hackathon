import type {
  ScenarioActionType,
  ScenarioLocationRouteDecision,
  ScenarioNodeData,
  ScenarioPostActionConditionType,
} from "@icecore/scenario-contracts";
import {
  buildPostActionLocationRouteHandleId,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID,
  POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID,
  PROMPT_INPUTS_UNMET_HANDLE,
} from "@icecore/scenario-contracts";
import { nodePassesFlowFilters } from "@/lib/airi/scenario/scenario-audience";
import type { ScenarioDispatchTransition } from "@icecore/airi-runtime/scenario-runtime-types";
import { hasBlockingScenarioRoutingDiagnostics } from "@icecore/scenario-contracts";
import {
  analyzeDedicatedInteractiveNoReplyAssignment,
  canonicalizeLegacyInteractiveNoReplyAssignmentEdges,
} from "@/lib/scenarios/legacy-action-routing";
import {
  getPostActionConditionHandleId,
  getScenarioActionOutcomeVirtualNodeId,
  isInteractiveNoReplyConditionNodeData,
  isPostActionConditionNodeData,
  isScenarioActionBranchDelayVirtualNodeId,
  normalizePostActionConditionBranches,
  SCENARIO_INTERACTIVE_NO_REPLY_SOURCE_HANDLE_ID,
} from "@icecore/scenario-contracts";
import { getPostActionConditionBranchTransitionByHandle } from "@/lib/scenarios/transition-registry";
import {
  compileScenarioGraph,
  type CompiledScenarioGraph,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import {
  flattenTelegramQuickReplyRows,
  normalizeActionReplyChannelForActionNode,
  normalizeActionType,
  normalizeTelegramQuickReplies,
} from "@/lib/scenarios/normalization";
import { scenarioActionUsesWhatsAppServiceMessageBranchHandles } from "@/lib/scenarios/branch-handle-predicates";
import { hasWhatsAppTemplateQuickReplyButtons } from "@/lib/scenarios/whatsapp-template-button-branches";
import { readFormSubmittedRouteNodeIds } from "@/lib/scenarios/whatsapp-template-form-route";
import {
  resolveScenarioWhatsAppServiceFlowConfig,
  whatsappTemplateAwaitingFlowReply,
} from "@/lib/scenarios/whatsapp-service-message";
import type { Channel, ConversationDocument } from "@/types/models";

export { whatsappTemplateAwaitingFlowReply } from "@/lib/scenarios/whatsapp-service-message";

export function collectRuntimeActionTypesForScenarioNodes(
  nodes: Array<{ id: string; data: ScenarioNodeData }>
): ScenarioActionType[] {
  const graph = compileScenarioGraph(nodes, []);
  return graph.runtimeActionNodes
    .flatMap(node => {
      const actionType = normalizeActionType(node.data);
      return actionType ? [actionType] : [];
    })
    .filter((value, index, source) => source.indexOf(value) === index);
}

function resolvePendingLinkedConditionId(
  node: ScenarioRuntimeNode
): string | null {
  const branches = normalizePostActionConditionBranches(
    node.data.conditionBranches
  );
  const linkedConditionId =
    (isInteractiveNoReplyConditionNodeData(node.data)
      ? branches.find(
          branch =>
            branch.type === "no_reply_timeout" && branch.linkedConditionId
        )?.linkedConditionId
      : null) ??
    branches.find(branch => branch.linkedConditionId)?.linkedConditionId;

  return typeof linkedConditionId === "string" && linkedConditionId.trim()
    ? linkedConditionId.trim()
    : null;
}

function buildPendingConditionTransition(params: {
  graph: CompiledScenarioGraph;
  sourceActionNodeId: string;
  conditionNode: ScenarioRuntimeNode;
}): ScenarioDispatchTransition {
  const analysis = analyzeDedicatedInteractiveNoReplyAssignment({
    graph: {
      nodes: params.graph.nodes,
      edges: params.graph.edges.flatMap(edge =>
        typeof edge.source === "string" && typeof edge.target === "string"
          ? [
              {
                ...edge,
                source: edge.source,
                target: edge.target,
              },
            ]
          : []
      ),
    },
    conditionNodeId: params.conditionNode.id,
    sourceActionNodeId: params.sourceActionNodeId,
  });
  const pendingLegacyRouting = analysis
    ? {
        kind: "interactive_no_reply_assignment" as const,
        conditionNodeId: analysis.conditionNodeId,
        sourceActionNodeId: analysis.sourceActionNodeId,
      }
    : null;

  return {
    nextActionNodeId: params.sourceActionNodeId,
    completesScenario: false,
    pendingConditionNodeId: params.conditionNode.id,
    pendingSourceActionNodeId: params.sourceActionNodeId,
    pendingLinkedConditionId: resolvePendingLinkedConditionId(
      params.conditionNode
    ),
    ...(pendingLegacyRouting ? { pendingLegacyRouting } : {}),
  };
}

function resolvePostActionConditionNodesFromAction(params: {
  graph: CompiledScenarioGraph;
  actionNodeId: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode[] {
  const nextNodeIds = params.graph.adjacency.get(params.actionNodeId) || [];
  const conditionsById = new Map<string, ScenarioRuntimeNode>();

  for (const nodeId of nextNodeIds) {
    const node = params.graph.nodesById.get(nodeId);
    if (
      !node ||
      node.data.kind !== "logic" ||
      !isPostActionConditionNodeData(node.data) ||
      // Only a tap on its CTA arms a delayed follow-up, never the send itself.
      isScenarioActionBranchDelayVirtualNodeId(node.id) ||
      !nodePassesFlowFilters(node, params.conversation, params.channel)
    ) {
      continue;
    }

    conditionsById.set(node.id, node);
  }

  return [...conditionsById.values()].sort(
    (left, right) =>
      (params.graph.nodeOrder.get(left.id) || 0) -
      (params.graph.nodeOrder.get(right.id) || 0)
  );
}

export function resolvePostActionConditionNodeFromAction(params: {
  graph: CompiledScenarioGraph;
  actionNodeId: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode | null {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return null;
  }
  const candidates = resolvePostActionConditionNodesFromAction(params);
  return (
    candidates.find(
      node => !isInteractiveNoReplyConditionNodeData(node.data)
    ) || null
  );
}

function resolvePathScopedPostActionConditionNode(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds?: string[];
  selectedActionNodeId: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode | null {
  const pathNodeIds = Array.isArray(params.pathNodeIds)
    ? params.pathNodeIds
    : [];
  const selectedActionIndex = pathNodeIds.lastIndexOf(
    params.selectedActionNodeId
  );
  if (selectedActionIndex <= 0) {
    return null;
  }

  for (let index = selectedActionIndex - 1; index >= 0; index -= 1) {
    const nodeId = pathNodeIds[index];
    const node = params.graph.nodesById.get(nodeId);
    if (!node) continue;
    if (!nodePassesFlowFilters(node, params.conversation, params.channel)) {
      continue;
    }
    if (
      node.data.kind === "logic" &&
      isPostActionConditionNodeData(node.data) &&
      !isInteractiveNoReplyConditionNodeData(node.data)
    ) {
      if (
        pathLeavesConditionThroughBranchHandle({
          graph: params.graph,
          pathNodeIds,
          conditionIndex: index,
        })
      ) {
        continue;
      }
      return node;
    }
  }

  return null;
}

function isPostActionConditionBranchHandle(
  sourceHandle: string | null | undefined
): boolean {
  return getPostActionConditionBranchTransitionByHandle(sourceHandle) !== null;
}

function pathLeavesConditionThroughBranchHandle(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
  conditionIndex: number;
}): boolean {
  const conditionNodeId = params.pathNodeIds[params.conditionIndex];
  const nextNodeId = params.pathNodeIds[params.conditionIndex + 1];
  if (!conditionNodeId || !nextNodeId) return false;

  return params.graph.edges.some(
    edge =>
      edge.source === conditionNodeId &&
      edge.target === nextNodeId &&
      isPostActionConditionBranchHandle(edge.sourceHandle)
  );
}

function resolveInteractiveNoReplyConditionNodeFromAction(params: {
  graph: CompiledScenarioGraph;
  actionNodeId: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode | null {
  const canonicalEdges = canonicalizeLegacyInteractiveNoReplyAssignmentEdges({
    nodes: [...params.graph.nodesById.values()],
    edges: params.graph.edges,
  });
  const explicitFromHandle = canonicalEdges
    .filter(
      edge =>
        edge.source === params.actionNodeId &&
        edge.sourceHandle === SCENARIO_INTERACTIVE_NO_REPLY_SOURCE_HANDLE_ID
    )
    .map(edge => {
      const targetId =
        typeof edge.target === "string" ? edge.target.trim() : "";
      return targetId ? params.graph.nodesById.get(targetId) : null;
    })
    .filter(
      (node): node is ScenarioRuntimeNode =>
        node !== null &&
        node !== undefined &&
        node.data.kind === "logic" &&
        isPostActionConditionNodeData(node.data) &&
        nodePassesFlowFilters(node, params.conversation, params.channel)
    )
    .sort(
      (left, right) =>
        (params.graph.nodeOrder.get(left.id) || 0) -
        (params.graph.nodeOrder.get(right.id) || 0)
    );

  if (explicitFromHandle.length > 0) {
    return explicitFromHandle[0] ?? null;
  }

  const candidates = resolvePostActionConditionNodesFromAction(params);
  return (
    candidates.find(node => isInteractiveNoReplyConditionNodeData(node.data)) ||
    null
  );
}

function hasConnectedNoReplyTimeoutBranch(params: {
  graph: CompiledScenarioGraph;
  conditionNodeId: string;
}): boolean {
  const sourceHandle = getPostActionConditionHandleId("no_reply_timeout");
  return params.graph.edges.some(
    edge =>
      edge.source === params.conditionNodeId &&
      edge.sourceHandle === sourceHandle &&
      typeof edge.target === "string" &&
      Boolean(params.graph.nodesById.get(edge.target))
  );
}

function resolveSingleQuietPeriodConditionNodeFromAction(params: {
  graph: CompiledScenarioGraph;
  actionNodeId: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode | null {
  const candidates = resolvePostActionConditionNodesFromAction(params)
    .filter(node => !isInteractiveNoReplyConditionNodeData(node.data))
    .filter(node =>
      hasConnectedNoReplyTimeoutBranch({
        graph: params.graph,
        conditionNodeId: node.id,
      })
    );

  return candidates.length === 1 ? candidates[0] : null;
}

export function resolvePostActionConditionBranchTarget(params: {
  graph: CompiledScenarioGraph;
  conditionNodeId: string;
  branchType: ScenarioPostActionConditionType;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode | null {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return null;
  }
  return resolvePostActionConditionSourceHandleTarget({
    graph: params.graph,
    conditionNodeId: params.conditionNodeId,
    sourceHandle: getPostActionConditionHandleId(params.branchType),
    conversation: params.conversation,
    channel: params.channel,
  });
}

export function resolvePostActionConditionSourceHandleTarget(params: {
  graph: CompiledScenarioGraph;
  conditionNodeId: string;
  sourceHandle: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode | null {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return null;
  }
  const sourceHandle =
    typeof params.sourceHandle === "string" ? params.sourceHandle.trim() : "";
  if (!sourceHandle) return null;

  const targetEdges = params.graph.edges
    .filter(
      edge =>
        edge.source === params.conditionNodeId &&
        edge.sourceHandle === sourceHandle &&
        typeof edge.target === "string"
    )
    .sort(
      (left, right) =>
        (params.graph.nodeOrder.get(left.target || "") || 0) -
        (params.graph.nodeOrder.get(right.target || "") || 0)
    );

  for (const edge of targetEdges) {
    const targetNode = edge.target
      ? params.graph.nodesById.get(edge.target)
      : null;
    if (!targetNode) continue;
    if (
      !nodePassesFlowFilters(targetNode, params.conversation, params.channel)
    ) {
      continue;
    }
    return targetNode;
  }

  return null;
}

export type ScenarioLocationRouteTarget = {
  /** The decision as applied: a route with no connection reads as "Any other office". */
  decision: ScenarioLocationRouteDecision;
} & (
  | {
      status: "routed";
      sourceHandle: string;
      nextActionNode: ScenarioRuntimeNode;
    }
  | {
      status: "unroutable";
      reason:
        | "no_office"
        | "not_connected"
        | "filtered"
        | "scenario_link"
        | "no_reachable_step";
    }
);

function locationRouteSourceHandle(
  decision: ScenarioLocationRouteDecision
): string | null {
  switch (decision.outcome) {
    case "route":
      return buildPostActionLocationRouteHandleId(decision.routeId);
    case "any_office":
      return POST_ACTION_LOCATION_ANY_OFFICE_HANDLE_ID;
    case "outside":
      return POST_ACTION_LOCATION_OUTSIDE_HANDLE_ID;
    case "no_office":
      return null;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

/**
 * The step a decided shared location continues to, checked before the wait
 * claims the share. A route with no connection at all falls back to "Any
 * other office"; a connected route whose step can't run stays unroutable
 * instead of sending the customer down another route's step.
 */
export function resolveScenarioLocationRouteTarget(params: {
  graph: CompiledScenarioGraph;
  conditionNodeId: string;
  decision: ScenarioLocationRouteDecision;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioLocationRouteTarget {
  const hasEdge = (sourceHandle: string) =>
    params.graph.edges.some(
      edge =>
        edge.source === params.conditionNodeId &&
        edge.sourceHandle === sourceHandle &&
        typeof edge.target === "string"
    );
  const routeHandle = locationRouteSourceHandle(params.decision);
  const decision: ScenarioLocationRouteDecision =
    params.decision.outcome === "route" && routeHandle && !hasEdge(routeHandle)
      ? {
          outcome: "any_office",
          office: params.decision.office,
          distanceMeters: params.decision.distanceMeters,
        }
      : params.decision;
  const sourceHandle = locationRouteSourceHandle(decision);
  if (!sourceHandle) {
    return { decision, status: "unroutable", reason: "no_office" };
  }
  if (!hasEdge(sourceHandle)) {
    return { decision, status: "unroutable", reason: "not_connected" };
  }

  const targetNode = resolvePostActionConditionSourceHandleTarget({
    graph: params.graph,
    conditionNodeId: params.conditionNodeId,
    sourceHandle,
    conversation: params.conversation,
    channel: params.channel,
  });
  if (!targetNode) {
    return { decision, status: "unroutable", reason: "filtered" };
  }
  // Location routes don't open linked scenarios.
  if (targetNode.data.kind === "scenario_link") {
    return { decision, status: "unroutable", reason: "scenario_link" };
  }
  const nextActionNode =
    targetNode.data.kind === "action"
      ? normalizeActionType(targetNode.data)
        ? targetNode
        : null
      : resolveFirstReachableActionFromNode({
          graph: params.graph,
          startNodeId: targetNode.id,
          conversation: params.conversation,
          channel: params.channel,
        });
  return nextActionNode
    ? { decision, status: "routed", sourceHandle, nextActionNode }
    : { decision, status: "unroutable", reason: "no_reachable_step" };
}

export function resolveFirstReachableActionFromNode(params: {
  graph: CompiledScenarioGraph;
  startNodeId: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioRuntimeNode | null {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return null;
  }
  const visited = new Set<string>([params.startNodeId]);
  const queue: string[] = [
    ...(params.graph.adjacency.get(params.startNodeId) || []),
  ];

  while (queue.length > 0) {
    const levelSize = queue.length;
    const levelActionNodes: ScenarioRuntimeNode[] = [];

    for (let index = 0; index < levelSize; index += 1) {
      const nodeId = queue.shift();
      if (!nodeId || visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = params.graph.nodesById.get(nodeId);
      if (!node) continue;
      if (!nodePassesFlowFilters(node, params.conversation, params.channel)) {
        continue;
      }

      if (node.data.kind === "action" && normalizeActionType(node.data)) {
        levelActionNodes.push(node);
        continue;
      }

      for (const nextNodeId of params.graph.adjacency.get(node.id) || []) {
        if (!visited.has(nextNodeId)) {
          queue.push(nextNodeId);
        }
      }
    }

    if (levelActionNodes.length > 0) {
      return [...levelActionNodes].sort(
        (left, right) =>
          (params.graph.nodeOrder.get(left.id) || 0) -
          (params.graph.nodeOrder.get(right.id) || 0)
      )[0];
    }
  }

  return null;
}

function resolveLabeledHandleTransition(params: {
  graph: CompiledScenarioGraph;
  selectedAction: ScenarioRuntimeNode;
  sourceHandle: string;
  conversation: ConversationDocument;
  channel: Channel;
  unconnectedCompletesScenario: boolean;
}): ScenarioDispatchTransition {
  const edge = params.graph.edges.find(
    candidate =>
      candidate.source === params.selectedAction.id &&
      candidate.sourceHandle === params.sourceHandle &&
      typeof candidate.target === "string"
  );
  if (!edge?.target) {
    return {
      nextActionNodeId: null,
      completesScenario: params.unconnectedCompletesScenario,
    };
  }

  const target = params.graph.nodesById.get(edge.target);
  if (
    !target ||
    !nodePassesFlowFilters(target, params.conversation, params.channel)
  ) {
    return {
      nextActionNodeId: null,
      completesScenario: params.unconnectedCompletesScenario,
    };
  }
  if (target.data.kind === "action" && normalizeActionType(target.data)) {
    return { nextActionNodeId: target.id, completesScenario: false };
  }

  const nextAction = resolveFirstReachableActionFromNode({
    graph: params.graph,
    startNodeId: target.id,
    conversation: params.conversation,
    channel: params.channel,
  });
  return nextAction
    ? { nextActionNodeId: nextAction.id, completesScenario: false }
    : {
        nextActionNodeId: null,
        completesScenario: params.unconnectedCompletesScenario,
      };
}

function resolveGenerativeAIHandleTransition(params: {
  graph: CompiledScenarioGraph;
  selectedAction: ScenarioRuntimeNode;
  sourceHandle: string;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioDispatchTransition {
  return resolveLabeledHandleTransition({
    ...params,
    unconnectedCompletesScenario: true,
  });
}

export function resolvePromptInputsUnmetTransition(params: {
  graph: CompiledScenarioGraph;
  selectedAction: ScenarioRuntimeNode;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioDispatchTransition {
  return resolveLabeledHandleTransition({
    ...params,
    sourceHandle: PROMPT_INPUTS_UNMET_HANDLE,
    unconnectedCompletesScenario: false,
  });
}

/**
 * Where a text message that asks for details continues once every detail is
 * read. Its own outcome wait, such as the No reply reminder, holds the
 * dispatch on the message, so the collected route is resolved without it.
 */
export function resolvePromptInputsMetTransition(params: {
  graph: CompiledScenarioGraph;
  selectedAction: ScenarioRuntimeNode;
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioDispatchTransition {
  return resolveNearestActionTransition({
    ...params,
    skipNodeId: getScenarioActionOutcomeVirtualNodeId(params.selectedAction.id),
  });
}

export function resolveGenerativeAIOutcomeTransitions(params: {
  graph: CompiledScenarioGraph;
  selectedAction: ScenarioRuntimeNode;
  conversation: ConversationDocument;
  channel: Channel;
}): {
  successTransition: ScenarioDispatchTransition;
  failureTransition: ScenarioDispatchTransition;
} {
  return {
    successTransition: resolveGenerativeAIHandleTransition({
      ...params,
      sourceHandle: GENERATIVE_AI_SUCCESS_HANDLE,
    }),
    failureTransition: resolveGenerativeAIHandleTransition({
      ...params,
      sourceHandle: GENERATIVE_AI_FAILURE_HANDLE,
    }),
  };
}

export function whatsappTemplateUsesMultipleBranchHandles(
  data: ScenarioNodeData
): boolean {
  if (!whatsappTemplateAwaitingFlowReply(data)) return false;
  const config = data.actionFlowConfig;
  if (!config || typeof config !== "object" || !Array.isArray(config.screens)) {
    return false;
  }

  return config.screens.some(
    screen =>
      Array.isArray(screen.fields) &&
      screen.fields.some(
        field =>
          field.fieldType === "RadioButtonsGroup" &&
          Array.isArray(field.options) &&
          field.options.length > 0
      )
  );
}

/**
 * Whether the template step's "Form submitted" route is connected. Its form's
 * submission then answers the step, like a tap on one of its buttons.
 */
export function scenarioActionHasFormSubmittedRoute(
  graph: CompiledScenarioGraph,
  actionNodeId: string
): boolean {
  return readFormSubmittedRouteNodeIds(graph).has(actionNodeId);
}

export function resolveScenarioDispatchTransition(params: {
  graph: CompiledScenarioGraph;
  selectedAction: ScenarioRuntimeNode;
  selectedActionType: ScenarioActionType;
  selectedPathNodeIds?: string[];
  conversation: ConversationDocument;
  channel: Channel;
}): ScenarioDispatchTransition {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return { nextActionNodeId: null, completesScenario: false };
  }
  if (params.selectedActionType === "end_scenario") {
    return { nextActionNodeId: null, completesScenario: true };
  }
  if (params.selectedActionType === "generative_ai") {
    return {
      nextActionNodeId: params.selectedAction.id,
      completesScenario: false,
    };
  }
  // Authored action outcomes own the default wait. Conditions behind a
  // product/button branch become eligible only after that branch is selected.
  const actionOutcomeCondition = params.graph.nodesById.get(
    getScenarioActionOutcomeVirtualNodeId(params.selectedAction.id)
  );
  if (actionOutcomeCondition) {
    return buildPendingConditionTransition({
      graph: params.graph,
      sourceActionNodeId: params.selectedAction.id,
      conditionNode: actionOutcomeCondition,
    });
  }
  const selectedActionData = params.selectedAction.data;
  const normalizedRows = normalizeTelegramQuickReplies(
    normalizeActionReplyChannelForActionNode(selectedActionData) === "telegram"
      ? selectedActionData.actionTelegramQuickReplies
      : undefined
  );
  const hasTelegramQuickReplies =
    flattenTelegramQuickReplyRows(normalizedRows).length > 0;
  const hasWhatsAppTemplateButtonBranches =
    params.selectedActionType === "whatsapp_template" &&
    hasWhatsAppTemplateQuickReplyButtons(
      selectedActionData.actionWhatsAppTemplateComponents
    );
  const hasWhatsAppServiceMessageBranches =
    scenarioActionUsesWhatsAppServiceMessageBranchHandles(selectedActionData);
  const hasWhatsAppServiceFlow =
    resolveScenarioWhatsAppServiceFlowConfig(selectedActionData) !== null;
  // The step waits for its form instead of walking the route right away.
  const hasWhatsAppTemplateFormSubmittedRoute =
    params.selectedActionType === "whatsapp_template" &&
    scenarioActionHasFormSubmittedRoute(params.graph, params.selectedAction.id);
  if (
    hasTelegramQuickReplies ||
    hasWhatsAppServiceMessageBranches ||
    hasWhatsAppServiceFlow ||
    hasWhatsAppTemplateButtonBranches ||
    hasWhatsAppTemplateFormSubmittedRoute ||
    (params.selectedActionType === "whatsapp_template" &&
      whatsappTemplateAwaitingFlowReply(selectedActionData))
  ) {
    const interactiveNoReplyNode =
      resolveInteractiveNoReplyConditionNodeFromAction({
        graph: params.graph,
        actionNodeId: params.selectedAction.id,
        conversation: params.conversation,
        channel: params.channel,
      });
    const flowTemplateFallbackPostActionNode =
      params.selectedActionType === "whatsapp_template" &&
      whatsappTemplateAwaitingFlowReply(selectedActionData) &&
      !whatsappTemplateUsesMultipleBranchHandles(selectedActionData) &&
      !interactiveNoReplyNode
        ? resolvePostActionConditionNodeFromAction({
            graph: params.graph,
            actionNodeId: params.selectedAction.id,
            conversation: params.conversation,
            channel: params.channel,
          })
        : null;
    const quietPeriodFallbackPostActionNode =
      !interactiveNoReplyNode && !flowTemplateFallbackPostActionNode
        ? resolveSingleQuietPeriodConditionNodeFromAction({
            graph: params.graph,
            actionNodeId: params.selectedAction.id,
            conversation: params.conversation,
            channel: params.channel,
          })
        : null;
    const pendingConditionNode =
      interactiveNoReplyNode ||
      flowTemplateFallbackPostActionNode ||
      quietPeriodFallbackPostActionNode;

    return pendingConditionNode
      ? buildPendingConditionTransition({
          graph: params.graph,
          sourceActionNodeId: params.selectedAction.id,
          conditionNode: pendingConditionNode,
        })
      : {
          nextActionNodeId: params.selectedAction.id,
          completesScenario: false,
          pendingConditionNodeId: null,
          pendingSourceActionNodeId: null,
          pendingLinkedConditionId: null,
        };
  }

  const postActionConditionNode = resolvePostActionConditionNodeFromAction({
    graph: params.graph,
    actionNodeId: params.selectedAction.id,
    conversation: params.conversation,
    channel: params.channel,
  });
  if (postActionConditionNode) {
    return buildPendingConditionTransition({
      graph: params.graph,
      sourceActionNodeId: params.selectedAction.id,
      conditionNode: postActionConditionNode,
    });
  }

  const pathScopedConditionNode = resolvePathScopedPostActionConditionNode({
    graph: params.graph,
    pathNodeIds: params.selectedPathNodeIds,
    selectedActionNodeId: params.selectedAction.id,
    conversation: params.conversation,
    channel: params.channel,
  });
  if (pathScopedConditionNode) {
    return buildPendingConditionTransition({
      graph: params.graph,
      sourceActionNodeId: params.selectedAction.id,
      conditionNode: pathScopedConditionNode,
    });
  }

  return resolveNearestActionTransition(params);
}

/**
 * The nearest runnable action after an action, level by level in node order,
 * or the end of the scenario when none follows. A `skipNodeId` is not entered.
 */
function resolveNearestActionTransition(params: {
  graph: CompiledScenarioGraph;
  selectedAction: ScenarioRuntimeNode;
  conversation: ConversationDocument;
  channel: Channel;
  skipNodeId?: string;
}): ScenarioDispatchTransition {
  const visited = new Set([params.selectedAction.id]);
  if (params.skipNodeId) visited.add(params.skipNodeId);
  const queue: string[] = [
    ...(params.graph.adjacency.get(params.selectedAction.id) || []),
  ];

  while (queue.length > 0) {
    const levelSize = queue.length;
    const levelActionNodes: ScenarioRuntimeNode[] = [];

    for (let index = 0; index < levelSize; index += 1) {
      const nodeId = queue.shift();
      if (!nodeId || visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = params.graph.nodesById.get(nodeId);
      if (!node) continue;
      if (!nodePassesFlowFilters(node, params.conversation, params.channel)) {
        continue;
      }

      const actionType = normalizeActionType(node.data);
      if (node.data.kind === "action" && actionType) {
        levelActionNodes.push(node);
        continue;
      }

      const nextNodeIds = params.graph.adjacency.get(node.id) || [];
      nextNodeIds.forEach(nextNodeId => {
        if (!visited.has(nextNodeId)) {
          queue.push(nextNodeId);
        }
      });
    }

    if (levelActionNodes.length === 0) {
      continue;
    }

    const nextActionNode = [...levelActionNodes].sort(
      (left, right) =>
        (params.graph.nodeOrder.get(left.id) || 0) -
        (params.graph.nodeOrder.get(right.id) || 0)
    )[0];

    return {
      nextActionNodeId: nextActionNode?.id || null,
      completesScenario: false,
    };
  }

  return {
    nextActionNodeId: null,
    completesScenario: true,
  };
}
