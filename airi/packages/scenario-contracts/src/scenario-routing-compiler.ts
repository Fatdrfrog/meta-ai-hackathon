import {
  getScenarioActionBranchDelayVirtualNodeId,
  getScenarioActionOutcomeVirtualNodeId,
  normalizeScenarioActionOutcomes,
  normalizeScenarioActionRunConditions,
  SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION,
  visitScenarioActionOutcomeBranches,
  type ScenarioActionBranchDelay,
  type ScenarioActionOutcomes,
} from "./scenario-action-routing";
import {
  ACTION_OUTCOME_HANDLE_PREFIX,
  buildPostActionAnswerMatchHandleId,
  buildPostActionConditionHandleId,
  buildPostActionLocationHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  isScenarioActionBranchDelaySourceHandle,
  parseScenarioActionOutcomeHandleId,
  type ScenarioActionOutcomeHandle,
} from "./scenario-branch-handles";
import type { ScenarioNodeData } from "./scenario-node-data";
import type { ScenarioConditionBranchConfig } from "./scenario-triggers";
import { GENERATIVE_AI_OUTPUT_HANDLE_IDS } from "./scenario-generative-ai";
import { listDuplicateScenarioLocationRouteIds } from "./scenario-location-routing";
import { resolveWhatsAppTemplateButtons } from "./whatsapp-template-button-ids";
import {
  extractScenarioWhatsAppServiceBranchOptions,
  normalizeScenarioWhatsAppServiceMessage,
} from "./whatsapp-service-message";
import { isRecord } from "./value-guards";

export const SCENARIO_ACTION_OUTCOME_VIRTUAL_NODE_DATA = {
  kind: "logic",
  logicType: "post_action_condition",
} as const satisfies Pick<ScenarioNodeData, "kind" | "logicType">;

const RESERVED_NODE_ID_PREFIX = "__system:";
const VIRTUAL_EDGE_ID_PREFIX = "__system:action-outcomes-edge:";
const BRANCH_DELAY_VIRTUAL_EDGE_ID_PREFIX =
  "__system:action-branch-delay-edge:";

export type ScenarioRoutingCompilerNode = {
  id: string;
  data?: object;
};

export type ScenarioRoutingCompilerEdge = {
  id?: string;
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type ScenarioRoutingCompilerInput = {
  nodes: ScenarioRoutingCompilerNode[];
  edges: ScenarioRoutingCompilerEdge[];
};

export type ScenarioRoutingCompilerDiagnosticCode =
  | "reserved_persisted_node_id"
  | "unsupported_action_run_conditions_version"
  | "unsupported_action_outcomes_version"
  | "mixed_action_outcome_ownership"
  | "duplicate_action_answer_rule_id"
  | "duplicate_action_exact_answer"
  | "multiple_action_outcome_targets"
  | "malformed_action_outcome_handle"
  | "terminal_action_has_outgoing_edges"
  | "terminal_action_has_outcomes"
  | "invalid_generative_ai_output_handle"
  | "multiple_generative_ai_output_targets"
  | "unsupported_action_branch_delay_handle"
  | "multiple_action_branch_delay_targets"
  | "duplicate_action_location_route_id";

export type ScenarioRoutingCompilerDiagnostic = {
  code: ScenarioRoutingCompilerDiagnosticCode;
  severity: "error";
  nodeId?: string;
  edgeId?: string;
  sourceHandle?: string | null;
};

export type ScenarioRoutingCompilerResult = {
  nodes: ScenarioRoutingCompilerNode[];
  edges: ScenarioRoutingCompilerEdge[];
  diagnostics: ScenarioRoutingCompilerDiagnostic[];
};

type RoutingRecord = Record<string, unknown>;

function cloneRoutingNode(
  node: ScenarioRoutingCompilerNode,
): ScenarioRoutingCompilerNode {
  return {
    ...node,
    ...(isRecord(node.data) ? { data: { ...node.data } } : {}),
  };
}

function cloneRoutingEdge(
  edge: ScenarioRoutingCompilerEdge,
): ScenarioRoutingCompilerEdge {
  return { ...edge };
}

function getNodeData(node: ScenarioRoutingCompilerNode): RoutingRecord | null {
  return isRecord(node.data) ? node.data : null;
}

function isActionNode(node: ScenarioRoutingCompilerNode): boolean {
  return getNodeData(node)?.kind === "action";
}

function isGenerativeAIActionNode(node: ScenarioRoutingCompilerNode): boolean {
  const nodeData = getNodeData(node);
  return (
    nodeData?.kind === "action" &&
    typeof nodeData.actionType === "string" &&
    nodeData.actionType.trim() === "generative_ai"
  );
}

function isTerminalActionNode(node: ScenarioRoutingCompilerNode): boolean {
  const data = getNodeData(node);
  return (
    data?.kind === "action" &&
    data.actionWhatsAppServiceMessage === undefined &&
    typeof data.actionType === "string" &&
    data.actionType.trim() === "end_scenario"
  );
}

function isGenerativeAIOutputHandle(
  sourceHandle: string | null | undefined,
): sourceHandle is (typeof GENERATIVE_AI_OUTPUT_HANDLE_IDS)[number] {
  return GENERATIVE_AI_OUTPUT_HANDLE_IDS.some(
    (handleId) => handleId === sourceHandle,
  );
}

function isActionOutcomeHandleLike(
  sourceHandle: string | null | undefined,
): boolean {
  return (
    typeof sourceHandle === "string" &&
    (sourceHandle.trim() === ACTION_OUTCOME_HANDLE_PREFIX ||
      sourceHandle.trim().startsWith(`${ACTION_OUTCOME_HANDLE_PREFIX}::`))
  );
}

/** One target per outcome; routes and answers each count on their own. */
function getOutcomeKey(handle: ScenarioActionOutcomeHandle): string {
  switch (handle.type) {
    case "answer":
      return `answer:${handle.ruleId}`;
    case "location_route":
      return `location:${handle.routeId}`;
    case "any_reply":
    case "no_reply":
    case "payment_detected":
    case "location_any_office":
    case "location_outside":
      return handle.type;
    default: {
      const exhaustive: never = handle;
      throw new Error(`Unhandled action outcome handle: ${exhaustive}`);
    }
  }
}

function getPostActionConditionHandle(
  handle: ScenarioActionOutcomeHandle,
): string {
  switch (handle.type) {
    case "answer":
      return buildPostActionAnswerMatchHandleId(handle.ruleId);
    case "location_route":
    case "location_any_office":
    case "location_outside":
      return buildPostActionLocationHandleId(handle);
    case "any_reply":
      return buildPostActionConditionHandleId("user_replied");
    case "payment_detected":
      return buildPostActionConditionHandleId("payment_detected");
    case "no_reply":
      return buildPostActionConditionHandleId("no_reply_timeout");
    default: {
      const exhaustive: never = handle;
      throw new Error(`Unhandled action outcome handle: ${exhaustive}`);
    }
  }
}

function getVirtualEdgeId(actionNodeId: string, suffix: string): string {
  return `${VIRTUAL_EDGE_ID_PREFIX}${encodeURIComponent(actionNodeId)}:${suffix}`;
}

function appendDiagnostic(
  diagnostics: ScenarioRoutingCompilerDiagnostic[],
  diagnostic: ScenarioRoutingCompilerDiagnostic,
): void {
  diagnostics.push(diagnostic);
}

function validateReservedIds(
  nodes: ScenarioRoutingCompilerNode[],
): ScenarioRoutingCompilerDiagnostic[] {
  const diagnostics: ScenarioRoutingCompilerDiagnostic[] = [];
  for (const node of nodes) {
    const canonicalNodeId = node.id.trim();
    if (canonicalNodeId.startsWith(RESERVED_NODE_ID_PREFIX)) {
      appendDiagnostic(diagnostics, {
        code: "reserved_persisted_node_id",
        severity: "error",
        nodeId: canonicalNodeId,
      });
    }
  }
  return diagnostics;
}

function validateActionRunConditionsVersion(
  action: ScenarioRoutingCompilerNode,
  diagnostics: ScenarioRoutingCompilerDiagnostic[],
): void {
  const rawRunConditions = getNodeData(action)?.actionRunConditions;
  const normalized = normalizeScenarioActionRunConditions(rawRunConditions);
  if (normalized.status !== "unsupported") return;

  appendDiagnostic(diagnostics, {
    code: "unsupported_action_run_conditions_version",
    severity: "error",
    nodeId: action.id,
  });
}

function validateRawAnswerMatches(
  action: ScenarioRoutingCompilerNode,
  rawOutcomes: RoutingRecord,
  diagnostics: ScenarioRoutingCompilerDiagnostic[],
): void {
  const rawRules = rawOutcomes.answerMatches;
  if (!Array.isArray(rawRules)) return;

  const ruleIds = new Set<string>();
  const exactAnswers = new Set<string>();
  for (const rawRule of rawRules) {
    if (!isRecord(rawRule)) continue;

    if (typeof rawRule.id === "string" || typeof rawRule.id === "number") {
      const ruleId = String(rawRule.id);
      if (ruleIds.has(ruleId)) {
        appendDiagnostic(diagnostics, {
          code: "duplicate_action_answer_rule_id",
          severity: "error",
          nodeId: action.id,
        });
      }
      ruleIds.add(ruleId);
    }

    if (rawRule.mode === "intent" || typeof rawRule.text !== "string") {
      continue;
    }
    if (exactAnswers.has(rawRule.text)) {
      appendDiagnostic(diagnostics, {
        code: "duplicate_action_exact_answer",
        severity: "error",
        nodeId: action.id,
      });
    }
    exactAnswers.add(rawRule.text);
  }
}

/** Normalization makes route ids unique, so duplicates are found raw. */
function validateRawLocationRoutes(
  action: ScenarioRoutingCompilerNode,
  rawOutcomes: RoutingRecord,
  diagnostics: ScenarioRoutingCompilerDiagnostic[],
): void {
  if (
    listDuplicateScenarioLocationRouteIds(rawOutcomes.locationRoutes).length
  ) {
    appendDiagnostic(diagnostics, {
      code: "duplicate_action_location_route_id",
      severity: "error",
      nodeId: action.id,
    });
  }
}

function isConfiguredOutcome(
  outcomes: ScenarioActionOutcomes,
  handle: ScenarioActionOutcomeHandle,
): boolean {
  switch (handle.type) {
    case "any_reply":
      return outcomes.anyReply?.enabled === true;
    case "no_reply":
      return outcomes.noReply?.enabled === true;
    case "payment_detected":
      return outcomes.paymentDetected?.enabled === true;
    case "answer":
      return (
        outcomes.answerMatches?.some((rule) => rule.id === handle.ruleId) ===
        true
      );
    case "location_route":
      return (
        outcomes.locationRoutes?.routes.some(
          (route) => route.id === handle.routeId,
        ) === true
      );
    case "location_any_office":
      return outcomes.locationRoutes !== undefined;
    case "location_outside":
      return outcomes.locationRoutes?.outside !== undefined;
    default: {
      const exhaustive: never = handle;
      return exhaustive;
    }
  }
}

function createConditionBranches(
  outcomes: ScenarioActionOutcomes,
): ScenarioConditionBranchConfig[] {
  const branches: ScenarioConditionBranchConfig[] = [];
  visitScenarioActionOutcomeBranches({
    anyReply: () => {
      if (!outcomes.anyReply?.enabled) return;
      branches.push({
        id: "user_replied",
        type: SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION.anyReply,
        ...(outcomes.anyReply.linkedConditionId
          ? { linkedConditionId: outcomes.anyReply.linkedConditionId }
          : {}),
      });
    },
    noReply: () => {
      if (!outcomes.noReply?.enabled && !outcomes.answerMatches?.length) return;
      branches.push({
        id: "no_reply_timeout",
        type: SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION.noReply,
        ...(outcomes.noReply?.enabled
          ? {
              timeoutMinutes: outcomes.noReply.timeoutMinutes,
              ...(outcomes.noReply.cancelIfPhrases?.length
                ? { missingTextPhrases: outcomes.noReply.cancelIfPhrases }
                : {}),
              ...(outcomes.noReply.linkedConditionId
                ? { linkedConditionId: outcomes.noReply.linkedConditionId }
                : {}),
            }
          : {}),
        ...(outcomes.answerMatches?.length
          ? { answerMatchRules: outcomes.answerMatches }
          : {}),
      });
    },
    answerMatches: () => {
      // Answer matches share the no-reply timeout virtual branch.
    },
    paymentDetected: () => {
      if (!outcomes.paymentDetected?.enabled) return;
      branches.push({
        id: "payment_detected",
        type: SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION.paymentDetected,
      });
    },
    branchDelays: () => {
      // Each delayed CTA lowers to its own wait in lowerActionBranchDelays.
    },
    locationRoutes: () => {
      // A shared location claims a route by handle, as a matched answer
      // does; the runtime reads the routes from the step itself.
    },
  });
  return branches;
}

function lowerActionOutcomes(params: {
  action: ScenarioRoutingCompilerNode;
  persistedEdges: ScenarioRoutingCompilerEdge[];
  loweredNodes: ScenarioRoutingCompilerNode[];
  loweredEdges: ScenarioRoutingCompilerEdge[];
  diagnostics: ScenarioRoutingCompilerDiagnostic[];
}): void {
  const actionData = getNodeData(params.action);
  const rawOutcomes = actionData?.actionOutcomes;
  if (isRecord(rawOutcomes)) {
    validateRawAnswerMatches(params.action, rawOutcomes, params.diagnostics);
    validateRawLocationRoutes(params.action, rawOutcomes, params.diagnostics);
  }
  const normalized = normalizeScenarioActionOutcomes(rawOutcomes);
  const outgoingOutcomeEdges = params.persistedEdges.flatMap((edge) => {
    if (edge.source !== params.action.id) return [];
    const handle = parseScenarioActionOutcomeHandleId(edge.sourceHandle);
    return handle ? [{ edge, handle }] : [];
  });

  if (normalized.status === "unsupported") {
    appendDiagnostic(params.diagnostics, {
      code: "unsupported_action_outcomes_version",
      severity: "error",
      nodeId: params.action.id,
    });
    return;
  }
  if (normalized.status === "absent") {
    if (outgoingOutcomeEdges.length > 0) {
      appendDiagnostic(params.diagnostics, {
        code: "mixed_action_outcome_ownership",
        severity: "error",
        nodeId: params.action.id,
      });
    }
    return;
  }

  const seenTargets = new Set<string>();
  for (const { edge, handle } of outgoingOutcomeEdges) {
    const outcomeKey = getOutcomeKey(handle);
    if (seenTargets.has(outcomeKey)) {
      appendDiagnostic(params.diagnostics, {
        code: "multiple_action_outcome_targets",
        severity: "error",
        nodeId: params.action.id,
        edgeId: edge.id,
        sourceHandle: edge.sourceHandle,
      });
    }
    seenTargets.add(outcomeKey);
    if (!isConfiguredOutcome(normalized.value, handle)) {
      appendDiagnostic(params.diagnostics, {
        code: "mixed_action_outcome_ownership",
        severity: "error",
        nodeId: params.action.id,
        edgeId: edge.id,
        sourceHandle: edge.sourceHandle,
      });
    }
  }

  if (outgoingOutcomeEdges.length === 0) return;

  const virtualId = getScenarioActionOutcomeVirtualNodeId(params.action.id);
  if (params.loweredNodes.some((node) => node.id === virtualId)) return;

  const conditionBranches = createConditionBranches(normalized.value);
  params.loweredNodes.push({
    id: virtualId,
    data: {
      ...SCENARIO_ACTION_OUTCOME_VIRTUAL_NODE_DATA,
      conditionBranches,
    } satisfies ScenarioNodeData,
  });
  params.loweredEdges.push({
    id: getVirtualEdgeId(params.action.id, "entry"),
    source: params.action.id,
    target: virtualId,
  });
  for (const [index, { edge, handle }] of outgoingOutcomeEdges.entries()) {
    params.loweredEdges.push({
      ...edge,
      id: getVirtualEdgeId(
        params.action.id,
        `${getOutcomeKey(handle)}:${index}`,
      ),
      source: virtualId,
      sourceHandle: getPostActionConditionHandle(handle),
    });
  }
}

function getBranchDelayVirtualEdgeId(
  actionNodeId: string,
  sourceHandle: string,
  suffix: string,
): string {
  return `${BRANCH_DELAY_VIRTUAL_EDGE_ID_PREFIX}${encodeURIComponent(
    actionNodeId,
  )}:${encodeURIComponent(sourceHandle)}:${suffix}`;
}

/** The template quick-reply buttons or session choices this action offers. */
function collectBranchDelayCtaHandles(actionData: RoutingRecord): Set<string> {
  const handles = new Set<string>();
  if (actionData.actionWhatsAppServiceMessage !== undefined) {
    const serviceMessage = normalizeScenarioWhatsAppServiceMessage(
      actionData.actionWhatsAppServiceMessage,
    );
    if (serviceMessage.status !== "supported") return handles;
    for (const option of extractScenarioWhatsAppServiceBranchOptions({
      config: serviceMessage.value,
    })) {
      handles.add(buildWhatsAppSessionChoiceSourceHandleId(option.id));
    }
    return handles;
  }

  for (const button of resolveWhatsAppTemplateButtons(
    actionData.actionWhatsAppTemplateComponents,
    actionData.actionWhatsAppTemplateButtonIds,
  )) {
    if (button.id === null) continue;
    handles.add(buildWhatsAppTemplateButtonSourceHandleId(button.id));
  }
  return handles;
}

function createBranchDelayConditionBranch(
  delay: ScenarioActionBranchDelay,
): ScenarioConditionBranchConfig {
  return {
    id: "no_reply_timeout",
    type: SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION.branchDelays,
    timeoutMinutes: delay.delayMinutes,
    ...(delay.cancelIfPhrases?.length
      ? { missingTextPhrases: delay.cancelIfPhrases }
      : {}),
  };
}

/**
 * Rewrites a delayed CTA edge `A --h--> T` in place as `A --h--> V --no
 * reply--> T`. The entry edge keeps the CTA handle, so a tap still matches it
 * and arms V; the existing no-reply timer then sends T after the quiet period.
 */
function lowerActionBranchDelays(params: {
  action: ScenarioRoutingCompilerNode;
  persistedEdges: ScenarioRoutingCompilerEdge[];
  loweredNodes: ScenarioRoutingCompilerNode[];
  loweredEdges: ScenarioRoutingCompilerEdge[];
  diagnostics: ScenarioRoutingCompilerDiagnostic[];
}): void {
  const actionData = getNodeData(params.action);
  const normalized = normalizeScenarioActionOutcomes(
    actionData?.actionOutcomes,
  );
  if (normalized.status !== "supported" || !normalized.value.branchDelays) {
    return;
  }

  const ownedHandles = collectBranchDelayCtaHandles(actionData ?? {});
  for (const delay of normalized.value.branchDelays) {
    const delayedEdges = params.persistedEdges.filter(
      (edge) =>
        edge.source === params.action.id &&
        Boolean(edge.target) &&
        typeof edge.sourceHandle === "string" &&
        edge.sourceHandle.trim() === delay.sourceHandle,
    );
    const [ctaEdge, ...extraEdges] = delayedEdges;
    // A delay configured before its CTA is connected keeps drafts valid.
    if (!ctaEdge) continue;

    if (
      !isScenarioActionBranchDelaySourceHandle(delay.sourceHandle) ||
      !ownedHandles.has(delay.sourceHandle)
    ) {
      appendDiagnostic(params.diagnostics, {
        code: "unsupported_action_branch_delay_handle",
        severity: "error",
        nodeId: params.action.id,
        edgeId: ctaEdge.id,
        sourceHandle: ctaEdge.sourceHandle,
      });
      continue;
    }
    if (extraEdges.length > 0) {
      for (const edge of extraEdges) {
        appendDiagnostic(params.diagnostics, {
          code: "multiple_action_branch_delay_targets",
          severity: "error",
          nodeId: params.action.id,
          edgeId: edge.id,
          sourceHandle: edge.sourceHandle,
        });
      }
      continue;
    }

    const loweredIndex = params.loweredEdges.indexOf(ctaEdge);
    const virtualId = getScenarioActionBranchDelayVirtualNodeId(
      params.action.id,
      delay.sourceHandle,
    );
    if (
      loweredIndex < 0 ||
      params.loweredNodes.some((node) => node.id === virtualId)
    ) {
      continue;
    }

    params.loweredNodes.push({
      id: virtualId,
      data: {
        ...SCENARIO_ACTION_OUTCOME_VIRTUAL_NODE_DATA,
        conditionBranches: [createBranchDelayConditionBranch(delay)],
      } satisfies ScenarioNodeData,
    });
    params.loweredEdges.splice(
      loweredIndex,
      1,
      {
        id: getBranchDelayVirtualEdgeId(
          params.action.id,
          delay.sourceHandle,
          "entry",
        ),
        source: ctaEdge.source,
        sourceHandle: ctaEdge.sourceHandle,
        target: virtualId,
      },
      {
        ...ctaEdge,
        id: getBranchDelayVirtualEdgeId(
          params.action.id,
          delay.sourceHandle,
          "follow-up",
        ),
        source: virtualId,
        sourceHandle: buildPostActionConditionHandleId(
          SCENARIO_ACTION_OUTCOME_TO_POST_ACTION_CONDITION.branchDelays,
        ),
      },
    );
  }
}

function validateOutcomeEdgeOwnership(params: {
  nodes: ScenarioRoutingCompilerNode[];
  edges: ScenarioRoutingCompilerEdge[];
  diagnostics: ScenarioRoutingCompilerDiagnostic[];
}): void {
  const actionIds = new Set(
    params.nodes.filter(isActionNode).map((node) => node.id),
  );
  for (const edge of params.edges) {
    if (!isActionOutcomeHandleLike(edge.sourceHandle)) continue;

    const parsedHandle = parseScenarioActionOutcomeHandleId(edge.sourceHandle);
    if (!parsedHandle) {
      appendDiagnostic(params.diagnostics, {
        code: "malformed_action_outcome_handle",
        severity: "error",
        edgeId: edge.id,
        sourceHandle: edge.sourceHandle,
      });
      continue;
    }
    if (!edge.source || !actionIds.has(edge.source)) {
      appendDiagnostic(params.diagnostics, {
        code: "mixed_action_outcome_ownership",
        severity: "error",
        edgeId: edge.id,
        sourceHandle: edge.sourceHandle,
      });
    }
  }

  for (const node of params.nodes) {
    const nodeData = getNodeData(node);
    if (nodeData?.actionOutcomes !== undefined && !isActionNode(node)) {
      appendDiagnostic(params.diagnostics, {
        code: "mixed_action_outcome_ownership",
        severity: "error",
        nodeId: node.id,
      });
    }
  }
}

function validateGenerativeAIOutputEdges(params: {
  action: ScenarioRoutingCompilerNode;
  edges: ScenarioRoutingCompilerEdge[];
  diagnostics: ScenarioRoutingCompilerDiagnostic[];
}): Set<ScenarioRoutingCompilerEdge> {
  const firstEdgeByHandle = new Map<string, ScenarioRoutingCompilerEdge>();
  const blockedEdges = new Set<ScenarioRoutingCompilerEdge>();
  for (const edge of params.edges) {
    if (edge.source !== params.action.id) continue;
    const sourceHandle = edge.sourceHandle;
    if (!isGenerativeAIOutputHandle(sourceHandle)) {
      appendDiagnostic(params.diagnostics, {
        code: "invalid_generative_ai_output_handle",
        severity: "error",
        nodeId: params.action.id,
        edgeId: edge.id,
        sourceHandle: edge.sourceHandle,
      });
      blockedEdges.add(edge);
      continue;
    }
    const firstEdge = firstEdgeByHandle.get(sourceHandle);
    if (firstEdge) {
      appendDiagnostic(params.diagnostics, {
        code: "multiple_generative_ai_output_targets",
        severity: "error",
        nodeId: params.action.id,
        edgeId: edge.id,
        sourceHandle: edge.sourceHandle,
      });
      blockedEdges.add(firstEdge);
      blockedEdges.add(edge);
    } else {
      firstEdgeByHandle.set(sourceHandle, edge);
    }
  }
  return blockedEdges;
}

export function lowerScenarioRoutingGraph(
  input: ScenarioRoutingCompilerInput,
): ScenarioRoutingCompilerResult {
  const persistedNodes = input.nodes.map(cloneRoutingNode);
  const persistedEdges = input.edges.map(cloneRoutingEdge);
  const diagnostics = validateReservedIds(persistedNodes);
  validateOutcomeEdgeOwnership({
    nodes: persistedNodes,
    edges: persistedEdges,
    diagnostics,
  });
  const blockedGenerativeEdges = new Set<ScenarioRoutingCompilerEdge>();
  for (const action of persistedNodes.filter(isGenerativeAIActionNode)) {
    for (const edge of validateGenerativeAIOutputEdges({
      action,
      edges: persistedEdges,
      diagnostics,
    })) {
      blockedGenerativeEdges.add(edge);
    }
  }
  const terminalNodeIds = new Set(
    persistedNodes.filter(isTerminalActionNode).map((node) => node.id),
  );
  for (const edge of persistedEdges) {
    if (!edge.source || !terminalNodeIds.has(edge.source)) continue;
    appendDiagnostic(diagnostics, {
      code: "terminal_action_has_outgoing_edges",
      severity: "error",
      nodeId: edge.source,
      edgeId: edge.id,
      sourceHandle: edge.sourceHandle,
    });
  }
  const loweredNodes = [...persistedNodes];
  const loweredEdges = persistedEdges.filter(
    (edge) =>
      !parseScenarioActionOutcomeHandleId(edge.sourceHandle) &&
      !isActionOutcomeHandleLike(edge.sourceHandle) &&
      !terminalNodeIds.has(edge.source || "") &&
      !blockedGenerativeEdges.has(edge),
  );

  for (const action of persistedNodes.filter(isActionNode)) {
    validateActionRunConditionsVersion(action, diagnostics);
    if (isTerminalActionNode(action)) {
      if (getNodeData(action)?.actionOutcomes !== undefined) {
        appendDiagnostic(diagnostics, {
          code: "terminal_action_has_outcomes",
          severity: "error",
          nodeId: action.id,
        });
      }
      continue;
    }
    if (isGenerativeAIActionNode(action)) {
      continue;
    }
    lowerActionOutcomes({
      action,
      persistedEdges,
      loweredNodes,
      loweredEdges,
      diagnostics,
    });
    lowerActionBranchDelays({
      action,
      persistedEdges,
      loweredNodes,
      loweredEdges,
      diagnostics,
    });
  }

  return { nodes: loweredNodes, edges: loweredEdges, diagnostics };
}

export function getBlockingScenarioRoutingDiagnosticCode(
  diagnostics: readonly ScenarioRoutingCompilerDiagnostic[],
): ScenarioRoutingCompilerDiagnosticCode | null {
  return (
    diagnostics.find((diagnostic) => diagnostic.severity === "error")?.code ??
    null
  );
}

export function hasBlockingScenarioRoutingDiagnostics(
  diagnostics: readonly ScenarioRoutingCompilerDiagnostic[],
): boolean {
  return getBlockingScenarioRoutingDiagnosticCode(diagnostics) !== null;
}
