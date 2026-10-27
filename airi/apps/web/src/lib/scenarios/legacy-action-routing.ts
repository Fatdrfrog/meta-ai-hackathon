import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  MAX_SCENARIO_ACTION_RUN_CONDITIONS,
  buildScenarioActionAnswerOutcomeHandleId,
  getConfiguredScenarioActionOutcomeHandleIds,
  getScenarioActionOutcomeVirtualNodeId,
  normalizeScenarioActionOutcomes,
  normalizeScenarioActionRuleId,
  normalizeScenarioActionRunConditions,
  parseFlowBranchSourceHandleId,
  type ScenarioActionOutcomes,
  type ScenarioActionRunCondition,
  type ScenarioActionRunConditions,
  type ScenarioActionRoutingPatch,
  type ScenarioLegacyActionRoutingPresentation,
  type ScenarioNodeData,
} from "@icecore/scenario-contracts";
import {
  FLOW_BRANCH_TRANSITION,
  getScenarioActionBranchTransitionBySourceHandle,
} from "./transition-registry";
import {
  getNoReplyAnswerMatchRules,
  getPostActionConditionBranch,
  getScenarioLogicType,
  getVisiblePostActionConditionTypes,
  isInteractiveNoReplyConditionNodeData,
  isPostActionConditionNodeData,
  normalizeMissingTextPhrases,
  parsePostActionAnswerMatchHandleId,
  resolvePostActionConditionTypeFromHandle,
} from "@icecore/scenario-contracts";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";
import { normalizeAudienceDays } from "./normalization";

type LegacyActionRoutingGraphNode = {
  id: string;
  data: ScenarioNodeData;
  [key: string]: unknown;
};

type LegacyActionRoutingGraphEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [key: string]: unknown;
};

export type LegacyActionRoutingGraph = {
  nodes: LegacyActionRoutingGraphNode[];
  edges: LegacyActionRoutingGraphEdge[];
};

type LegacyActionRoutingAssignmentEdge = Record<string, unknown> & {
  source?: unknown;
  target?: unknown;
  sourceHandle?: unknown;
};

function graphPairKey(source: unknown, target: unknown): string {
  return `${readTrimmedString(source)}\u0000${readTrimmedString(target)}`;
}

function asAssignmentEdge(
  value: unknown
): LegacyActionRoutingAssignmentEdge | null {
  return value !== null && typeof value === "object"
    ? (value as LegacyActionRoutingAssignmentEdge)
    : null;
}

/**
 * Canonicalizes the historical generic WhatsApp Flow edge only when the graph
 * proves its old no-reply meaning: the configured Flow action and the same
 * post-action condition are also connected by an option-specific Flow edge.
 * Explicit legacy handles are normalized through the same boundary.
 */
export function canonicalizeLegacyInteractiveNoReplyAssignmentEdges<
  TEdge extends object,
>(params: { nodes: readonly unknown[]; edges: readonly TEdge[] }): TEdge[] {
  const nodesById = new Map<string, ScenarioNodeData>();
  for (const value of params.nodes) {
    if (value === null || typeof value !== "object") continue;
    const node = value as { id?: unknown; data?: unknown };
    const id = readTrimmedString(node.id);
    if (!id || node.data === null || typeof node.data !== "object") continue;
    nodesById.set(id, node.data as ScenarioNodeData);
  }

  const specificFlowPairs = new Set<string>();
  for (const value of params.edges) {
    const edge = asAssignmentEdge(value);
    if (
      !edge ||
      !parseFlowBranchSourceHandleId(
        typeof edge.sourceHandle === "string" ? edge.sourceHandle : undefined
      )
    ) {
      continue;
    }
    specificFlowPairs.add(graphPairKey(edge.source, edge.target));
  }

  return params.edges.map(value => {
    const edge = asAssignmentEdge(value);
    if (!edge) return value;
    const sourceHandle = readTrimmedString(edge.sourceHandle);
    if (sourceHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID) {
      return sourceHandle === edge.sourceHandle
        ? value
        : ({ ...edge, sourceHandle } as TEdge);
    }
    if (sourceHandle !== ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID) return value;

    const sourceId = readTrimmedString(edge.source);
    const targetId = readTrimmedString(edge.target);
    const sourceData = nodesById.get(sourceId);
    const targetData = nodesById.get(targetId);
    if (
      !sourceData ||
      sourceData.kind !== "action" ||
      !targetData ||
      !FLOW_BRANCH_TRANSITION.usesBranchHandles(sourceData) ||
      !isPostActionConditionNodeData(targetData) ||
      !specificFlowPairs.has(graphPairKey(sourceId, targetId))
    ) {
      return value;
    }

    return {
      ...edge,
      sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
    } as TEdge;
  });
}

function canonicalizeLegacyActionRoutingGraph(
  graph: LegacyActionRoutingGraph
): LegacyActionRoutingGraph {
  return {
    nodes: graph.nodes,
    edges: canonicalizeLegacyInteractiveNoReplyAssignmentEdges(graph),
  };
}

export const LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_CODE =
  "legacy_action_routing_new_assignment_forbidden";
export const LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_MESSAGE =
  "Legacy no-reply assignments can no longer be created";

export class LegacyActionRoutingAssignmentForbiddenError extends Error {
  readonly code = LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_CODE;

  constructor() {
    super(LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_MESSAGE);
    this.name = "LegacyActionRoutingAssignmentForbiddenError";
  }
}

function legacyActionRoutingAssignmentKey(value: unknown): string | null {
  const edge = asAssignmentEdge(value);
  if (!edge) return null;
  if (
    typeof edge.sourceHandle !== "string" ||
    edge.sourceHandle.trim() !== ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
  ) {
    return null;
  }
  const source = typeof edge.source === "string" ? edge.source.trim() : "";
  const target = typeof edge.target === "string" ? edge.target.trim() : "";
  return `${source}\u0000${target}`;
}

/**
 * Allows legacy assignments already stored on a scenario to survive ordinary
 * saves, while rejecting every newly introduced assignment (including an
 * extra duplicate). Canonical action outcomes are the only authoring path.
 */
export function hasNewLegacyActionRoutingAssignments(params: {
  previousNodes: readonly unknown[];
  previousEdges: readonly unknown[];
  nextNodes: readonly unknown[];
  nextEdges: readonly unknown[];
}): boolean {
  const previousEdges = canonicalizeLegacyInteractiveNoReplyAssignmentEdges({
    nodes: params.previousNodes,
    edges: params.previousEdges.filter(
      (edge): edge is object => edge !== null && typeof edge === "object"
    ),
  });
  const nextEdges = canonicalizeLegacyInteractiveNoReplyAssignmentEdges({
    nodes: params.nextNodes,
    edges: params.nextEdges.filter(
      (edge): edge is object => edge !== null && typeof edge === "object"
    ),
  });
  const available = new Map<string, number>();
  for (const edge of previousEdges) {
    const key = legacyActionRoutingAssignmentKey(edge);
    if (key) available.set(key, (available.get(key) ?? 0) + 1);
  }
  for (const edge of nextEdges) {
    const key = legacyActionRoutingAssignmentKey(edge);
    if (!key) continue;
    const count = available.get(key) ?? 0;
    if (count === 0) return true;
    available.set(key, count - 1);
  }
  return false;
}

export function assertNoNewLegacyActionRoutingAssignments(params: {
  previousNodes: readonly unknown[];
  previousEdges: readonly unknown[];
  nextNodes: readonly unknown[];
  nextEdges: readonly unknown[];
}): void {
  if (hasNewLegacyActionRoutingAssignments(params)) {
    throw new LegacyActionRoutingAssignmentForbiddenError();
  }
}

type LegacyActionRoutingAnalysis =
  | {
      eligible: true;
      sourceActionNodeId: string;
      conditionNodeId: string;
      actionOutcomes: ScenarioActionOutcomes;
    }
  | {
      eligible: false;
      conditionNodeId: string;
      reason:
        | "missing_condition"
        | "multiple_sources"
        | "multiple_conditions"
        | "mixed_ownership"
        | "unsupported_branch"
        | "multiple_targets";
    };

type LegacyAudienceGateAnalysis =
  | {
      eligible: true;
      sourceActionNodeId: string;
      gateNodeId: string;
      actionRunConditions: ScenarioActionRunConditions;
    }
  | {
      eligible: false;
      gateNodeId: string;
      reason:
        | "missing_gate"
        | "unconfigured_gate"
        | "multiple_sources"
        | "multiple_targets"
        | "shared_action"
        | "mixed_ownership";
    };

function cloneGraph(graph: LegacyActionRoutingGraph): LegacyActionRoutingGraph {
  return {
    nodes: graph.nodes.map(node => ({
      ...node,
      data: { ...node.data },
    })),
    edges: graph.edges.map(edge => ({ ...edge })),
  };
}

/**
 * New lists that keep every node and edge. A conversion replaces only the
 * nodes and edges it changes, so the display projection keeps the rest.
 */
function shareGraph(graph: LegacyActionRoutingGraph): LegacyActionRoutingGraph {
  return { nodes: [...graph.nodes], edges: [...graph.edges] };
}

type CopyLegacyActionRoutingGraph = (
  graph: LegacyActionRoutingGraph
) => LegacyActionRoutingGraph;

function resolveLegacyActionOutcomes(
  conditionData: ScenarioNodeData
): ScenarioActionOutcomes {
  const outcomes: ScenarioActionOutcomes = { version: 1 };
  const visibleTypes = getVisiblePostActionConditionTypes(conditionData);

  if (
    conditionData.postActionConditionVariant !== "interactive_no_reply" &&
    visibleTypes.includes("user_replied")
  ) {
    const branch = getPostActionConditionBranch(conditionData, "user_replied");
    outcomes.anyReply = {
      enabled: true,
      ...(branch.linkedConditionId
        ? { linkedConditionId: branch.linkedConditionId }
        : {}),
    };
  }

  if (visibleTypes.includes("no_reply_timeout")) {
    const branch = getPostActionConditionBranch(
      conditionData,
      "no_reply_timeout"
    );
    const cancelIfPhrases = normalizeMissingTextPhrases(
      branch.missingTextPhrases
    );
    outcomes.noReply = {
      enabled: true,
      timeoutMinutes: Math.max(1, Math.trunc(branch.timeoutMinutes ?? 30)),
      ...(cancelIfPhrases.length > 0 ? { cancelIfPhrases } : {}),
      ...(branch.linkedConditionId
        ? { linkedConditionId: branch.linkedConditionId }
        : {}),
    };
  }

  const answerMatches = getNoReplyAnswerMatchRules(conditionData);
  if (answerMatches.length > 0) {
    outcomes.answerMatches = answerMatches;
  }

  if (visibleTypes.includes("payment_detected")) {
    outcomes.paymentDetected = { enabled: true };
  }

  return outcomes;
}

function isDedicatedInteractiveNoReplyAssignmentEdge(params: {
  edge: LegacyActionRoutingGraphEdge;
  sourceActionNodeId: string;
  conditionNode: LegacyActionRoutingGraphNode;
}): boolean {
  return (
    isInteractiveNoReplyConditionNodeData(params.conditionNode.data) &&
    params.edge.source === params.sourceActionNodeId &&
    params.edge.target === params.conditionNode.id &&
    params.edge.sourceHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
  );
}

function isIndependentActionBranchConditionEdge(params: {
  edge: LegacyActionRoutingGraphEdge;
  sourceActionNodeId: string;
  sourceAction: LegacyActionRoutingGraphNode;
}): boolean {
  const transition = getScenarioActionBranchTransitionBySourceHandle(
    params.edge.sourceHandle
  );
  const branchOptions = transition?.extractOptions(
    params.sourceAction.data,
    params.sourceActionNodeId
  );
  const branchId = transition?.resolveBranchIdFromSourceHandle(
    params.edge.sourceHandle,
    branchOptions ?? []
  );
  return Boolean(
    transition &&
      transition.usesBranchHandles(params.sourceAction.data) &&
      transition.matchesSourceHandle(params.edge.sourceHandle, branchOptions) &&
      branchId &&
      branchOptions?.some(option => option.id === branchId)
  );
}

function mapLegacyBranchHandle(
  sourceHandle: string | null | undefined
): string | null {
  const branchType = resolvePostActionConditionTypeFromHandle(sourceHandle);
  if (branchType === "user_replied") {
    return ACTION_ANY_REPLY_OUTCOME_HANDLE_ID;
  }
  if (branchType === "no_reply_timeout") {
    return ACTION_NO_REPLY_OUTCOME_HANDLE_ID;
  }
  if (branchType === "payment_detected") {
    return ACTION_PAYMENT_OUTCOME_HANDLE_ID;
  }
  const answerRuleId = parsePostActionAnswerMatchHandleId(sourceHandle);
  return answerRuleId
    ? buildScenarioActionAnswerOutcomeHandleId(answerRuleId)
    : null;
}

function isLegacyAudienceGateNodeData(data: ScenarioNodeData): boolean {
  return (
    data.kind === "logic" &&
    (data.logicType == null || data.logicType === "audience_filter") &&
    getScenarioLogicType(data) === "audience_filter"
  );
}

function normalizeDistinctStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.flatMap(entry =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : []
      )
    )
  );
}

function resolveLegacyAudienceGateCondition(
  gateNodeId: string,
  data: ScenarioNodeData
): ScenarioActionRunCondition | null {
  const id = normalizeScenarioActionRuleId(`legacy_${gateNodeId}`);
  const mode = data.audienceMode;
  if (mode === "classification") {
    const category = data.classificationCategory?.trim();
    return category ? { id, type: "classification", category } : null;
  }
  if (mode === "internalLabel") {
    const label = data.internalLabel?.trim();
    return label ? { id, type: "internal_label", label } : null;
  }
  if (mode === "specificCustomers") {
    const customerIds = normalizeDistinctStrings(data.customerIds);
    return customerIds.length > 0 &&
      customerIds.length <= MAX_SCENARIO_ACTION_RUN_CONDITIONS
      ? { id, type: "specific_customers", customerIds }
      : null;
  }
  if (mode === "has_purchase_history") {
    return { id, type: "has_purchase_history" };
  }
  if (mode === "funnel_stage") {
    const stage = (
      data.audienceFunnelStage ||
      data.classificationCategory ||
      ""
    ).trim();
    return stage ? { id, type: "funnel_stage", stage } : null;
  }
  if (mode === "last_seen_greater_than_x_days" || mode === "last_seen_days") {
    const minimumDays = normalizeAudienceDays(data.audienceLastSeenDays);
    return minimumDays ? { id, type: "last_seen_days", minimumDays } : null;
  }
  return null;
}

function runConditionSignature(condition: ScenarioActionRunCondition): string {
  const { id, ...value } = condition;
  void id;
  return JSON.stringify(value);
}

export function analyzeLegacyAudienceGate(params: {
  graph: LegacyActionRoutingGraph;
  gateNodeId: string;
}): LegacyAudienceGateAnalysis {
  const gateNodeId = params.gateNodeId.trim();
  const nodeById = new Map(params.graph.nodes.map(node => [node.id, node]));
  const gateNode = nodeById.get(gateNodeId);
  if (!gateNode || !isLegacyAudienceGateNodeData(gateNode.data)) {
    return { eligible: false, gateNodeId, reason: "missing_gate" };
  }

  const rawGateCondition = resolveLegacyAudienceGateCondition(
    gateNodeId,
    gateNode.data
  );
  if (!rawGateCondition) {
    return { eligible: false, gateNodeId, reason: "unconfigured_gate" };
  }
  const normalizedGate = normalizeScenarioActionRunConditions({
    version: 1,
    match: "all",
    conditions: [rawGateCondition],
  });
  const gateCondition =
    normalizedGate.status === "supported"
      ? normalizedGate.value.conditions[0]
      : null;
  if (
    !gateCondition ||
    runConditionSignature(gateCondition) !==
      runConditionSignature(rawGateCondition)
  ) {
    return { eligible: false, gateNodeId, reason: "unconfigured_gate" };
  }

  const incomingEdges = params.graph.edges.filter(
    edge => edge.target === gateNodeId
  );
  if (incomingEdges.length !== 1 || !nodeById.has(incomingEdges[0].source)) {
    return { eligible: false, gateNodeId, reason: "multiple_sources" };
  }

  const outgoingEdges = params.graph.edges.filter(
    edge => edge.source === gateNodeId
  );
  if (outgoingEdges.length !== 1) {
    return { eligible: false, gateNodeId, reason: "multiple_targets" };
  }
  const sourceActionNodeId = outgoingEdges[0].target;
  const sourceAction = nodeById.get(sourceActionNodeId);
  if (
    !sourceAction ||
    sourceAction.data.kind !== "action" ||
    incomingEdges[0].source === sourceActionNodeId
  ) {
    return { eligible: false, gateNodeId, reason: "multiple_targets" };
  }

  const actionIncomingEdges = params.graph.edges.filter(
    edge => edge.target === sourceActionNodeId
  );
  if (
    actionIncomingEdges.length !== 1 ||
    actionIncomingEdges[0].source !== gateNodeId
  ) {
    return { eligible: false, gateNodeId, reason: "shared_action" };
  }

  const normalizedExisting = normalizeScenarioActionRunConditions(
    sourceAction.data.actionRunConditions
  );
  if (normalizedExisting.status === "unsupported") {
    return { eligible: false, gateNodeId, reason: "mixed_ownership" };
  }
  const existingConditions =
    normalizedExisting.status === "supported"
      ? normalizedExisting.value.conditions
      : [];
  const gateSignature = runConditionSignature(gateCondition);
  const alreadyPresent = existingConditions.some(
    condition => runConditionSignature(condition) === gateSignature
  );
  if (
    !alreadyPresent &&
    existingConditions.length >= MAX_SCENARIO_ACTION_RUN_CONDITIONS
  ) {
    return { eligible: false, gateNodeId, reason: "mixed_ownership" };
  }

  const normalizedCombined = normalizeScenarioActionRunConditions({
    version: 1,
    match: "all",
    conditions: alreadyPresent
      ? existingConditions
      : [...existingConditions, gateCondition],
  });
  if (normalizedCombined.status !== "supported") {
    return { eligible: false, gateNodeId, reason: "unconfigured_gate" };
  }

  return {
    eligible: true,
    sourceActionNodeId,
    gateNodeId,
    actionRunConditions: normalizedCombined.value,
  };
}

export function analyzeLegacyActionRouting(params: {
  graph: LegacyActionRoutingGraph;
  conditionNodeId: string;
}): LegacyActionRoutingAnalysis {
  const graph = canonicalizeLegacyActionRoutingGraph(params.graph);
  const conditionNodeId = params.conditionNodeId.trim();
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const conditionNode = nodeById.get(conditionNodeId);
  if (!conditionNode || !isPostActionConditionNodeData(conditionNode.data)) {
    return { eligible: false, conditionNodeId, reason: "missing_condition" };
  }

  const incomingEdges = graph.edges.filter(
    edge => edge.target === conditionNodeId
  );
  const incomingActionIds = Array.from(
    new Set(
      incomingEdges.flatMap(edge =>
        nodeById.get(edge.source)?.data.kind === "action" ? [edge.source] : []
      )
    )
  );
  if (
    incomingActionIds.length !== 1 ||
    incomingEdges.some(
      edge => nodeById.get(edge.source)?.data.kind !== "action"
    )
  ) {
    return { eligible: false, conditionNodeId, reason: "multiple_sources" };
  }

  const sourceActionNodeId = incomingActionIds[0];
  const sourceAction = nodeById.get(sourceActionNodeId);
  if (!sourceAction) {
    return { eligible: false, conditionNodeId, reason: "multiple_sources" };
  }
  if (sourceAction.data.actionOutcomes != null) {
    return { eligible: false, conditionNodeId, reason: "mixed_ownership" };
  }

  const dedicatedAssignmentEdges = incomingEdges.filter(edge =>
    isDedicatedInteractiveNoReplyAssignmentEdge({
      edge,
      sourceActionNodeId,
      conditionNode,
    })
  );
  const isDedicatedInteractiveNoReplyAssignment =
    dedicatedAssignmentEdges.length === 1 &&
    incomingEdges.every(
      edge =>
        edge === dedicatedAssignmentEdges[0] ||
        isIndependentActionBranchConditionEdge({
          edge,
          sourceActionNodeId,
          sourceAction,
        })
    );
  const ownedConditionIds = new Set(
    graph.edges.flatMap(edge => {
      if (edge.source !== sourceActionNodeId) return [];
      const target = nodeById.get(edge.target);
      const isOwnedCondition = isDedicatedInteractiveNoReplyAssignment
        ? Boolean(
            target &&
              isPostActionConditionNodeData(target.data) &&
              !isIndependentActionBranchConditionEdge({
                edge,
                sourceActionNodeId,
                sourceAction,
              })
          )
        : Boolean(target && isPostActionConditionNodeData(target.data));
      return isOwnedCondition && target ? [target.id] : [];
    })
  );
  if (ownedConditionIds.size !== 1) {
    return { eligible: false, conditionNodeId, reason: "multiple_conditions" };
  }

  const outgoingEdges = graph.edges.filter(
    edge => edge.source === conditionNodeId
  );
  const targetsByHandle = new Map<string, Set<string>>();
  const edgeCountByHandle = new Map<string, number>();
  for (const edge of outgoingEdges) {
    const mappedHandle = mapLegacyBranchHandle(edge.sourceHandle);
    if (!mappedHandle) {
      return { eligible: false, conditionNodeId, reason: "unsupported_branch" };
    }
    const targets = targetsByHandle.get(mappedHandle) ?? new Set<string>();
    targets.add(edge.target);
    targetsByHandle.set(mappedHandle, targets);
    const edgeCount = (edgeCountByHandle.get(mappedHandle) ?? 0) + 1;
    edgeCountByHandle.set(mappedHandle, edgeCount);
    if (targets.size > 1 || edgeCount > 1) {
      return { eligible: false, conditionNodeId, reason: "multiple_targets" };
    }
  }

  return {
    eligible: true,
    sourceActionNodeId,
    conditionNodeId,
    actionOutcomes: resolveLegacyActionOutcomes(conditionNode.data),
  };
}

export function analyzeDedicatedInteractiveNoReplyAssignment(params: {
  graph: LegacyActionRoutingGraph;
  conditionNodeId: string;
  sourceActionNodeId: string;
}): Extract<LegacyActionRoutingAnalysis, { eligible: true }> | null {
  const graph = canonicalizeLegacyActionRoutingGraph(params.graph);
  const sourceActionNodeId = params.sourceActionNodeId.trim();
  const analysis = analyzeLegacyActionRouting({
    graph,
    conditionNodeId: params.conditionNodeId,
  });
  if (
    !analysis.eligible ||
    analysis.sourceActionNodeId !== sourceActionNodeId
  ) {
    return null;
  }

  const conditionNode = graph.nodes.find(
    node => node.id === analysis.conditionNodeId
  );
  if (!conditionNode) return null;
  const assignmentEdges = graph.edges.filter(
    edge => edge.target === analysis.conditionNodeId
  );
  const sourceAction = graph.nodes.find(
    node => node.id === sourceActionNodeId && node.data.kind === "action"
  );
  const dedicatedAssignmentEdges = assignmentEdges.filter(edge =>
    isDedicatedInteractiveNoReplyAssignmentEdge({
      edge,
      sourceActionNodeId,
      conditionNode,
    })
  );
  if (
    !sourceAction ||
    dedicatedAssignmentEdges.length !== 1 ||
    assignmentEdges.some(
      edge =>
        edge !== dedicatedAssignmentEdges[0] &&
        !isIndependentActionBranchConditionEdge({
          edge,
          sourceActionNodeId,
          sourceAction,
        })
    )
  ) {
    return null;
  }

  return analysis;
}

type LegacyActionRoutingConversion = {
  graph: LegacyActionRoutingGraph;
  sourceActionNodeId: string;
  conditionNodeId: string;
  virtualConditionNodeId: string;
};

type LegacyAudienceGateConversion = {
  graph: LegacyActionRoutingGraph;
  sourceActionNodeId: string;
  gateNodeId: string;
};

export function convertLegacyActionRouting(params: {
  graph: LegacyActionRoutingGraph;
  sourceActionNodeId: string;
  conditionNodeId: string;
  patch?: ScenarioActionRoutingPatch;
}): LegacyActionRoutingConversion {
  return convertLegacyActionRoutingGraph(params, cloneGraph);
}

function convertLegacyActionRoutingGraph(
  params: Parameters<typeof convertLegacyActionRouting>[0],
  copyGraph: CopyLegacyActionRoutingGraph
): LegacyActionRoutingConversion {
  const analysis = analyzeLegacyActionRouting({
    graph: params.graph,
    conditionNodeId: params.conditionNodeId,
  });
  if (
    !analysis.eligible ||
    analysis.sourceActionNodeId !== params.sourceActionNodeId.trim()
  ) {
    throw new Error("legacy_action_routing_not_eligible");
  }

  const normalizedOutcomes = normalizeScenarioActionOutcomes(
    params.patch?.actionOutcomes ?? analysis.actionOutcomes
  );
  if (normalizedOutcomes.status !== "supported") {
    throw new Error("legacy_action_routing_invalid_outcomes");
  }
  const normalizedRunConditions = normalizeScenarioActionRunConditions(
    params.patch?.actionRunConditions
  );
  if (normalizedRunConditions.status === "unsupported") {
    throw new Error("legacy_action_routing_invalid_run_conditions");
  }

  const graph = copyGraph(params.graph);
  graph.nodes = graph.nodes
    .filter(node => node.id !== analysis.conditionNodeId)
    .map(node =>
      node.id === analysis.sourceActionNodeId
        ? {
            ...node,
            data: {
              ...node.data,
              actionOutcomes: normalizedOutcomes.value,
              ...(normalizedRunConditions.status === "supported"
                ? { actionRunConditions: normalizedRunConditions.value }
                : {}),
            },
          }
        : node
    );
  // A builder edit that turns an outcome off drops its legacy branch, as the
  // editor prunes edges of unconfigured outcomes on converted actions.
  const configuredOutcomeHandles = params.patch?.actionOutcomes
    ? new Set(
        getConfiguredScenarioActionOutcomeHandleIds(normalizedOutcomes.value)
      )
    : null;
  graph.edges = graph.edges.flatMap(edge => {
    if (edge.target === analysis.conditionNodeId) return [];
    if (edge.source !== analysis.conditionNodeId) return [edge];
    const sourceHandle = mapLegacyBranchHandle(edge.sourceHandle);
    if (!sourceHandle) {
      throw new Error("legacy_action_routing_unsupported_branch");
    }
    if (configuredOutcomeHandles && !configuredOutcomeHandles.has(sourceHandle))
      return [];
    return [
      {
        ...edge,
        source: analysis.sourceActionNodeId,
        sourceHandle,
      },
    ];
  });

  return {
    graph,
    sourceActionNodeId: analysis.sourceActionNodeId,
    conditionNodeId: analysis.conditionNodeId,
    virtualConditionNodeId: getScenarioActionOutcomeVirtualNodeId(
      analysis.sourceActionNodeId
    ),
  };
}

export function convertLegacyAudienceGate(params: {
  graph: LegacyActionRoutingGraph;
  sourceActionNodeId: string;
  gateNodeId: string;
  patch?: ScenarioActionRoutingPatch;
}): LegacyAudienceGateConversion {
  return convertLegacyAudienceGateGraph(params, cloneGraph);
}

function convertLegacyAudienceGateGraph(
  params: Parameters<typeof convertLegacyAudienceGate>[0],
  copyGraph: CopyLegacyActionRoutingGraph
): LegacyAudienceGateConversion {
  const analysis = analyzeLegacyAudienceGate({
    graph: params.graph,
    gateNodeId: params.gateNodeId,
  });
  if (
    !analysis.eligible ||
    analysis.sourceActionNodeId !== params.sourceActionNodeId.trim()
  ) {
    throw new Error("legacy_audience_gate_not_eligible");
  }

  const normalizedRunConditions = normalizeScenarioActionRunConditions(
    params.patch?.actionRunConditions ?? analysis.actionRunConditions
  );
  if (normalizedRunConditions.status !== "supported") {
    throw new Error("legacy_audience_gate_invalid_run_conditions");
  }

  const graph = copyGraph(params.graph);
  graph.nodes = graph.nodes
    .filter(node => node.id !== analysis.gateNodeId)
    .map(node =>
      node.id === analysis.sourceActionNodeId
        ? {
            ...node,
            data: {
              ...node.data,
              actionRunConditions: normalizedRunConditions.value,
            },
          }
        : node
    );
  graph.edges = graph.edges.flatMap(edge => {
    if (edge.source === analysis.gateNodeId) return [];
    if (edge.target !== analysis.gateNodeId) return [edge];
    return [{ ...edge, target: analysis.sourceActionNodeId }];
  });

  return {
    graph,
    sourceActionNodeId: analysis.sourceActionNodeId,
    gateNodeId: analysis.gateNodeId,
  };
}

type LegacyDisplayConversion = {
  inputs: readonly unknown[];
  data: ScenarioNodeData;
  presentation: ScenarioLegacyActionRoutingPresentation;
};

/**
 * A converted action's display data and presentation, by its persisted
 * data. They depend only on that data and the data of the wait and gate it
 * absorbs, so a later projection with the same inputs keeps them, and the
 * canvas does not redraw the step.
 */
const legacyDisplayConversions = new WeakMap<
  ScenarioNodeData,
  LegacyDisplayConversion
>();

function keepLegacyDisplayConversions(
  graph: LegacyActionRoutingGraph,
  projected: LegacyActionRoutingGraph,
  legacyRoutingByActionId: Map<string, ScenarioLegacyActionRoutingPresentation>
): void {
  const originalById = new Map(graph.nodes.map(node => [node.id, node]));
  for (const [actionId, presentation] of legacyRoutingByActionId) {
    const original = originalById.get(actionId);
    const index = projected.nodes.findIndex(node => node.id === actionId);
    if (!original || index < 0) continue;
    const outcomesSourceId = presentation.actionOutcomesSource?.sourceNodeId;
    const gateSourceId = presentation.actionRunConditionsSource?.sourceNodeId;
    const inputs = [
      actionId,
      outcomesSourceId,
      outcomesSourceId ? originalById.get(outcomesSourceId)?.data : undefined,
      gateSourceId,
      gateSourceId ? originalById.get(gateSourceId)?.data : undefined,
    ];
    const known = legacyDisplayConversions.get(original.data);
    if (
      known &&
      known.inputs.length === inputs.length &&
      known.inputs.every((input, position) => input === inputs[position])
    ) {
      projected.nodes[index] = { ...projected.nodes[index], data: known.data };
      legacyRoutingByActionId.set(actionId, known.presentation);
      continue;
    }
    legacyDisplayConversions.set(original.data, {
      inputs,
      data: projected.nodes[index].data,
      presentation,
    });
  }
}

/**
 * The graph as the editor shows it: each eligible legacy wait and audience
 * gate folds into its action. Nodes and edges no conversion changes are
 * the same objects as in `graph`.
 */
export function projectLegacyActionRoutingForDisplay(
  graph: LegacyActionRoutingGraph
): LegacyActionRoutingGraph & {
  legacyRoutingByActionId: Map<string, ScenarioLegacyActionRoutingPresentation>;
} {
  const originalConditionIds = graph.nodes
    .filter(node => isPostActionConditionNodeData(node.data))
    .map(node => node.id);
  const originalGateIds = graph.nodes
    .filter(node => isLegacyAudienceGateNodeData(node.data))
    .map(node => node.id);
  let projected = shareGraph(graph);
  const legacyRoutingByActionId = new Map<
    string,
    ScenarioLegacyActionRoutingPresentation
  >();

  for (const conditionNodeId of originalConditionIds) {
    const analysis = analyzeLegacyActionRouting({ graph, conditionNodeId });
    if (!analysis.eligible) continue;

    const conversion = convertLegacyActionRoutingGraph(
      {
        graph: projected,
        sourceActionNodeId: analysis.sourceActionNodeId,
        conditionNodeId,
      },
      shareGraph
    );
    projected = conversion.graph;
    legacyRoutingByActionId.set(analysis.sourceActionNodeId, {
      ...legacyRoutingByActionId.get(analysis.sourceActionNodeId),
      actionOutcomes: analysis.actionOutcomes,
      actionOutcomesSource: {
        sourceNodeId: conditionNodeId,
        sourceKind: "post_action_condition",
      },
    });
  }

  for (const gateNodeId of originalGateIds) {
    const analysis = analyzeLegacyAudienceGate({
      graph: projected,
      gateNodeId,
    });
    if (!analysis.eligible) continue;

    const conversion = convertLegacyAudienceGateGraph(
      {
        graph: projected,
        sourceActionNodeId: analysis.sourceActionNodeId,
        gateNodeId,
      },
      shareGraph
    );
    projected = conversion.graph;
    legacyRoutingByActionId.set(analysis.sourceActionNodeId, {
      ...legacyRoutingByActionId.get(analysis.sourceActionNodeId),
      actionRunConditions: analysis.actionRunConditions,
      actionRunConditionsSource: {
        sourceNodeId: gateNodeId,
        sourceKind: "audience_filter",
      },
    });
  }

  keepLegacyDisplayConversions(graph, projected, legacyRoutingByActionId);
  return { ...projected, legacyRoutingByActionId };
}

export function getLegacyRoutingOwnedNodeIds(params: {
  graph: LegacyActionRoutingGraph;
  sourceActionNodeIds: ReadonlySet<string>;
}): Set<string> {
  const ownedNodeIds = new Set<string>();
  for (const node of params.graph.nodes) {
    if (isPostActionConditionNodeData(node.data)) {
      const analysis = analyzeLegacyActionRouting({
        graph: params.graph,
        conditionNodeId: node.id,
      });
      if (
        analysis.eligible &&
        params.sourceActionNodeIds.has(analysis.sourceActionNodeId)
      ) {
        ownedNodeIds.add(analysis.conditionNodeId);
      }
      continue;
    }
    if (isLegacyAudienceGateNodeData(node.data)) {
      const analysis = analyzeLegacyAudienceGate({
        graph: params.graph,
        gateNodeId: node.id,
      });
      if (
        analysis.eligible &&
        params.sourceActionNodeIds.has(analysis.sourceActionNodeId)
      ) {
        ownedNodeIds.add(analysis.gateNodeId);
      }
    }
  }
  return ownedNodeIds;
}

export type EligibleLegacyRoutingConversion = {
  sourceActionNodeId: string;
  sourceNodeId: string;
  sourceKind: "post_action_condition" | "audience_filter";
  actionOutcomes?: ScenarioActionOutcomes;
  actionRunConditions?: ScenarioActionRunConditions;
};

export type LegacyRoutingLeftoverNode = {
  nodeId: string;
  sourceKind: "post_action_condition" | "audience_filter";
  reason: string;
};

export type LegacyRoutingRedrawPlan = {
  conversions: EligibleLegacyRoutingConversion[];
  leftovers: LegacyRoutingLeftoverNode[];
  convertedGraph: LegacyActionRoutingGraph;
};

function compareNodeId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Converts every eligible persisted post-action wait and unary audience gate
 * onto its owning action. Shared or branch-scoped logic nodes stay leftovers.
 */
export function collectEligibleLegacyRoutingConversions(
  graph: LegacyActionRoutingGraph
): LegacyRoutingRedrawPlan {
  let convertedGraph = cloneGraph(graph);
  const conversions: EligibleLegacyRoutingConversion[] = [];
  const leftovers: LegacyRoutingLeftoverNode[] = [];

  const conditionIds = graph.nodes
    .filter(node => isPostActionConditionNodeData(node.data))
    .map(node => node.id)
    .sort(compareNodeId);
  for (const conditionNodeId of conditionIds) {
    const analysis = analyzeLegacyActionRouting({
      graph: convertedGraph,
      conditionNodeId,
    });
    if (!analysis.eligible) {
      leftovers.push({
        nodeId: conditionNodeId,
        sourceKind: "post_action_condition",
        reason: analysis.reason,
      });
      continue;
    }
    const conversion = convertLegacyActionRouting({
      graph: convertedGraph,
      sourceActionNodeId: analysis.sourceActionNodeId,
      conditionNodeId,
    });
    conversions.push({
      sourceActionNodeId: conversion.sourceActionNodeId,
      sourceNodeId: conversion.conditionNodeId,
      sourceKind: "post_action_condition",
      actionOutcomes: analysis.actionOutcomes,
    });
    convertedGraph = conversion.graph;
  }

  const gateIds = graph.nodes
    .filter(node => isLegacyAudienceGateNodeData(node.data))
    .map(node => node.id)
    .sort(compareNodeId);
  for (const gateNodeId of gateIds) {
    const analysis = analyzeLegacyAudienceGate({
      graph: convertedGraph,
      gateNodeId,
    });
    if (!analysis.eligible) {
      leftovers.push({
        nodeId: gateNodeId,
        sourceKind: "audience_filter",
        reason: analysis.reason,
      });
      continue;
    }
    const conversion = convertLegacyAudienceGate({
      graph: convertedGraph,
      sourceActionNodeId: analysis.sourceActionNodeId,
      gateNodeId,
    });
    conversions.push({
      sourceActionNodeId: conversion.sourceActionNodeId,
      sourceNodeId: conversion.gateNodeId,
      sourceKind: "audience_filter",
      actionRunConditions: analysis.actionRunConditions,
    });
    convertedGraph = conversion.graph;
  }

  return { conversions, leftovers, convertedGraph };
}

export function prepareLegacyRoutingGraphForDeletion(params: {
  graph: LegacyActionRoutingGraph;
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
}): { graph: LegacyActionRoutingGraph; nodeIds: Set<string> } {
  const nodeIds = new Set(params.nodeIds);
  getLegacyRoutingOwnedNodeIds({
    graph: params.graph,
    sourceActionNodeIds: nodeIds,
  }).forEach(nodeId => nodeIds.add(nodeId));

  let graph = params.graph;
  const gateNodeIds = params.graph.nodes
    .filter(node => isLegacyAudienceGateNodeData(node.data))
    .map(node => node.id);
  for (const gateNodeId of gateNodeIds) {
    if (nodeIds.has(gateNodeId)) continue;
    const analysis = analyzeLegacyAudienceGate({ graph, gateNodeId });
    if (!analysis.eligible || nodeIds.has(analysis.sourceActionNodeId)) {
      continue;
    }
    const incomingEdge = graph.edges.find(edge => edge.target === gateNodeId);
    if (!incomingEdge) continue;
    const deletesVisiblePredecessor = nodeIds.has(incomingEdge.source);
    const deletesVisibleEdge =
      typeof incomingEdge.id === "string" &&
      params.edgeIds.has(incomingEdge.id);
    if (!deletesVisiblePredecessor && !deletesVisibleEdge) continue;

    graph = convertLegacyAudienceGate({
      graph,
      sourceActionNodeId: analysis.sourceActionNodeId,
      gateNodeId,
    }).graph;
  }

  return { graph, nodeIds };
}
