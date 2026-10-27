import {
  SCENARIO_TRIGGER_EVENT_KIND,
  parseFlowBranchSourceHandleId,
  normalizeGenerativeAIActionConfig,
  resolveGenerativeAIExpectedInputKind,
  buildFlowPromptInputInboundText,
  buildScenarioFormAnswerFieldMap,
  captureFlowTextPromptInputs,
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  listScenarioFlowTextPromptInputs,
  listScenarioAnswerReferences,
  normalizeWhatsAppFlowReplyValues,
  type GenerativeAIInputKind,
  type ScenarioFormAnswerFieldMap,
  type ScenarioFormAnswerFieldMapEntry,
  type ScenarioActionType,
  type ScenarioNodeData,
  type ScenarioRuntimeEventKind,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { classifyGenerativeAIInbound } from "@/lib/airi/reply/runtime/generative-ai-input";
import {
  type GenerativeAIInboundCandidate,
  type GenerativeAIInboundDisposition,
} from "@icecore/airi-runtime/scenario-generative-ai-input-types";
import { extractInstagramBranchOptions } from "@/lib/scenarios/instagram-reply-config";
import {
  hasConfiguredAudienceFilter,
  nodePassesFlowFilters,
} from "@/lib/airi/scenario/scenario-audience";
import {
  resolveFirstReachableActionFromNode,
  scenarioActionHasFormSubmittedRoute,
} from "@/lib/airi/scenario/scenario-post-action-routing";
import { isPostActionConditionNodeData } from "@icecore/scenario-contracts";
import {
  getPostActionConditionBranchTransitionByHandle,
  postActionConditionBranchHandleMatchesEvent as registryPostActionConditionBranchHandleMatchesEvent,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION,
  whatsAppTemplateButtonReplyMatchesSourceHandle,
} from "@/lib/scenarios/transition-registry";
import {
  type CompiledScenarioGraph,
  getCompiledScenarioGraph,
  reconstructForwardPath,
  reconstructPathFromPrevious,
  type ScenarioRuntimeEdge,
  type ScenarioFlowMatch,
  type ScenarioRecord,
  type ScenarioRuntimeNode,
  stitchTriggerPathThroughPreferred,
} from "@icecore/airi-runtime/scenario-graph";
import { hasBlockingScenarioRoutingDiagnostics } from "@icecore/scenario-contracts";
import {
  flattenTelegramQuickReplyRows,
  normalizeActionReplyChannelForActionNode,
  normalizeActionType,
  normalizeTelegramQuickReplies,
} from "@/lib/scenarios/normalization";
import {
  isScenarioInteractiveReplyEventKind,
  isScenarioPostActionEventKind,
} from "@icecore/scenario-contracts";
import {
  resolveScenarioActionDefaultRouteBlocker,
  scenarioActionUsesWhatsAppServiceMessageBranchHandles,
} from "@/lib/scenarios/branch-handle-predicates";
import { resolveScenarioStructuredReplyActionNodeId } from "@/lib/scenarios/structured-replies";
import { hasWhatsAppTemplateQuickReplyButtons } from "@/lib/scenarios/whatsapp-template-button-branches";
import {
  resolveScenarioWhatsAppInteractiveFlowConfig,
  scenarioActionAwaitsWhatsAppFlowReply,
} from "@/lib/scenarios/whatsapp-service-message";
import type { Channel, ConversationDocument } from "@/types/models";
function parseWhatsAppFlowReplySelections(
  responseJson?: string | null
): Map<string, Set<string>> {
  const normalizedJson =
    typeof responseJson === "string" ? responseJson.trim() : "";
  if (!normalizedJson) return new Map();

  try {
    const parsed = JSON.parse(normalizedJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }

    const root = parsed as Record<string, unknown>;
    const entryTuples: Array<[string, unknown]> = [...Object.entries(root)];
    const nestedValues = root.values;
    if (
      nestedValues &&
      typeof nestedValues === "object" &&
      !Array.isArray(nestedValues)
    ) {
      entryTuples.push(
        ...Object.entries(nestedValues as Record<string, unknown>)
      );
    }

    const selections = new Map<string, Set<string>>();
    for (const [fieldId, rawValue] of entryTuples) {
      if (fieldId === "values") continue;
      const normalizedFieldId = fieldId.trim();
      if (!normalizedFieldId) continue;

      const values = normalizeWhatsAppFlowReplyValues(rawValue);
      if (values.length === 0) continue;

      const existing = selections.get(normalizedFieldId) || new Set<string>();
      values.forEach(v => existing.add(v));
      selections.set(normalizedFieldId, existing);
    }

    return selections;
  } catch {
    return new Map();
  }
}

function collectUniqueFlowFieldIdsByOptionId(
  flowConfig: WhatsAppFlowConfig | null | undefined
): Map<string, string> {
  if (!flowConfig?.screens?.length) {
    return new Map();
  }

  const fieldIdsByOptionId = new Map<string, Set<string>>();

  for (const screen of flowConfig.screens) {
    for (const field of screen.fields || []) {
      if (field.fieldType !== "RadioButtonsGroup") continue;

      const fieldId = typeof field.id === "string" ? field.id.trim() : "";
      if (!fieldId) continue;

      for (const option of field.options || []) {
        const optionId = typeof option.id === "string" ? option.id.trim() : "";
        if (!optionId) continue;

        const fieldIds = fieldIdsByOptionId.get(optionId) || new Set<string>();
        fieldIds.add(fieldId);
        fieldIdsByOptionId.set(optionId, fieldIds);
      }
    }
  }

  const uniqueFieldIdsByOptionId = new Map<string, string>();
  for (const [optionId, fieldIds] of fieldIdsByOptionId.entries()) {
    if (fieldIds.size !== 1) continue;
    uniqueFieldIdsByOptionId.set(optionId, [...fieldIds][0]);
  }

  return uniqueFieldIdsByOptionId;
}

function normalizeWhatsAppFlowOptionAlias(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectUniqueFlowOptionBindingsByAlias(
  flowConfig: WhatsAppFlowConfig | null | undefined
): Map<string, { fieldId: string; optionId: string }> {
  if (!flowConfig?.screens?.length) {
    return new Map();
  }

  const aliases = new Map<
    string,
    Map<string, { fieldId: string; optionId: string }>
  >();

  for (const screen of flowConfig.screens) {
    for (const field of screen.fields || []) {
      if (field.fieldType !== "RadioButtonsGroup") continue;

      const fieldId = typeof field.id === "string" ? field.id.trim() : "";
      if (!fieldId) continue;

      for (const option of field.options || []) {
        const optionId = typeof option.id === "string" ? option.id.trim() : "";
        if (!optionId) continue;

        const optionAliases = [
          normalizeWhatsAppFlowOptionAlias(option.id),
          normalizeWhatsAppFlowOptionAlias(option.title),
        ].filter(Boolean);

        for (const alias of optionAliases) {
          const matches = aliases.get(alias) || new Map();
          matches.set(`${fieldId}\u0000${optionId}`, { fieldId, optionId });
          aliases.set(alias, matches);
        }
      }
    }
  }

  const uniqueAliases = new Map<
    string,
    { fieldId: string; optionId: string }
  >();
  for (const [alias, matches] of aliases.entries()) {
    if (matches.size !== 1) continue;
    uniqueAliases.set(alias, [...matches.values()][0]);
  }

  return uniqueAliases;
}

/**
 * Meta often sends `response_json` with generic keys (e.g. `message`) instead of
 * the RadioButtonsGroup field id from the flow definition. When an option id is
 * unique across radio fields in our configured flow, copy that selection under
 * the canonical field id so branch matching (`flowBranchSourceFieldId`) works.
 */
function expandWhatsAppFlowReplySelectionsWithFlowConfig(
  selections: Map<string, Set<string>>,
  flowConfig: WhatsAppFlowConfig | null | undefined
): Map<string, Set<string>> {
  const optionToUniqueField = collectUniqueFlowFieldIdsByOptionId(flowConfig);
  const uniqueOptionBindingsByAlias =
    collectUniqueFlowOptionBindingsByAlias(flowConfig);
  if (
    optionToUniqueField.size === 0 &&
    uniqueOptionBindingsByAlias.size === 0
  ) {
    return selections;
  }

  const expanded = new Map<string, Set<string>>();
  for (const [key, values] of selections.entries()) {
    const bucket = expanded.get(key) || new Set<string>();
    values.forEach(value => bucket.add(value));
    expanded.set(key, bucket);
  }

  for (const values of selections.values()) {
    for (const value of values) {
      const mappedField = optionToUniqueField.get(value);
      if (mappedField) {
        const bucket = expanded.get(mappedField) || new Set<string>();
        bucket.add(value);
        expanded.set(mappedField, bucket);
      }

      const mappedOption = uniqueOptionBindingsByAlias.get(
        normalizeWhatsAppFlowOptionAlias(value)
      );
      if (!mappedOption) continue;

      const originalValueBucket =
        expanded.get(mappedOption.fieldId) || new Set<string>();
      originalValueBucket.add(mappedOption.optionId);
      expanded.set(mappedOption.fieldId, originalValueBucket);
    }
  }

  return expanded;
}

function buildReachabilityFromTriggers(params: {
  graph: CompiledScenarioGraph;
  conversation: ConversationDocument;
  channel: Channel;
  matchedTriggerNodeId?: string;
  stopAtActions?: boolean;
}): Map<string, string | null> {
  const previous = new Map<string, string | null>();
  const queue: string[] = [];

  const entryNodeIds = resolveScenarioEntryNodeIds({
    graph: params.graph,
    matchedTriggerNodeId: params.matchedTriggerNodeId,
  });

  entryNodeIds.forEach(entryNodeId => {
    const entryNode = params.graph.nodesById.get(entryNodeId);
    if (!entryNode) return;
    if (
      !nodePassesFlowFilters(entryNode, params.conversation, params.channel)
    ) {
      return;
    }
    previous.set(entryNodeId, null);
    queue.push(entryNodeId);
  });

  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (
      params.stopAtActions &&
      params.graph.nodesById.get(nodeId)?.data.kind === "action"
    ) {
      continue;
    }
    const nextNodes = params.graph.adjacency.get(nodeId) || [];
    nextNodes.forEach(nextNodeId => {
      if (previous.has(nextNodeId)) return;
      const nextNode = params.graph.nodesById.get(nextNodeId);
      if (!nextNode) return;
      if (
        !nodePassesFlowFilters(nextNode, params.conversation, params.channel)
      ) {
        return;
      }
      previous.set(nextNodeId, nodeId);
      queue.push(nextNodeId);
    });
  }

  return previous;
}

function resolveScenarioEntryNodeIds(params: {
  graph: CompiledScenarioGraph;
  matchedTriggerNodeId?: string;
}): string[] {
  if (params.matchedTriggerNodeId) {
    return [params.matchedTriggerNodeId];
  }

  if (params.graph.triggerNodeIds.length > 0) {
    return params.graph.triggerNodeIds;
  }

  return params.graph.nodes
    .filter(node => node.data.kind === "bulk")
    .map(node => node.id);
}

function resolveNearestTelegramQuickReplyAncestorId(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
}): string | null {
  for (let index = params.pathNodeIds.length - 2; index >= 0; index -= 1) {
    const nodeId = params.pathNodeIds[index];
    const node = params.graph.nodesById.get(nodeId);
    if (!node || node.data.kind !== "action") {
      continue;
    }

    if (!normalizeActionType(node.data)) {
      continue;
    }

    const quickReplyRows =
      normalizeActionReplyChannelForActionNode(node.data) === "telegram"
        ? normalizeTelegramQuickReplies(node.data.actionTelegramQuickReplies)
        : undefined;
    if (flattenTelegramQuickReplyRows(quickReplyRows).length > 0) {
      return node.id;
    }
  }

  return null;
}

function resolveNearestWhatsAppButtonBranchAncestorId(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
}): string | null {
  for (let index = params.pathNodeIds.length - 2; index >= 0; index -= 1) {
    const nodeId = params.pathNodeIds[index];
    const node = params.graph.nodesById.get(nodeId);
    if (!node || node.data.kind !== "action") {
      continue;
    }

    if (normalizeActionType(node.data) !== "whatsapp_template") {
      if (scenarioActionUsesWhatsAppServiceMessageBranchHandles(node.data)) {
        return node.id;
      }

      continue;
    }

    if (
      hasWhatsAppTemplateQuickReplyButtons(
        node.data.actionWhatsAppTemplateComponents
      )
    ) {
      return node.id;
    }
  }

  return null;
}

type WhatsAppFlowPathBranchResolution =
  | {
      kind: "matched";
      nodeId: string;
      branchPriority: 0 | 1;
    }
  | {
      kind: "no_bindings";
    }
  | {
      kind: "mismatch";
    };

type WhatsAppButtonPathBranchResolution =
  | {
      kind: "matched";
      nodeId: string;
    }
  | {
      kind: "no_bindings";
    }
  | {
      kind: "mismatch";
    };

type WhatsAppButtonReplyEdgeMatch = "matched" | "mismatch" | "no_binding";

type InstagramPathBranchResolution =
  | {
      kind: "matched";
      nodeId: string;
    }
  | {
      kind: "no_bindings";
    }
  | {
      kind: "mismatch";
    };

export type ScenarioInteractiveReplyConditionTarget = {
  conditionNode: ScenarioRuntimeNode;
  sourceActionNode: ScenarioRuntimeNode;
  pathNodeIds: string[];
};

function getPathIncomingEdges(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
  index: number;
}): ScenarioRuntimeEdge[] {
  const target = params.pathNodeIds[params.index];
  const source = params.pathNodeIds[params.index - 1];
  if (!source || !target) return [];

  return params.graph.edges.filter(
    edge => edge.source === source && edge.target === target
  );
}

function getReachablePathDistance(params: {
  previous: Map<string, string | null>;
  targetNodeId: string;
}): number {
  const pathNodeIds = reconstructPathFromPrevious(params);
  return pathNodeIds.length > 0 ? pathNodeIds.length : Number.MAX_SAFE_INTEGER;
}

function isPostActionConditionBranchHandle(
  sourceHandle: string | null | undefined
): boolean {
  return getPostActionConditionBranchTransitionByHandle(sourceHandle) !== null;
}

function postActionConditionBranchMatchesEvent(params: {
  sourceHandle: string | null | undefined;
  eventKind?: ScenarioRuntimeEventKind | null;
}): boolean {
  if (!isPostActionConditionBranchHandle(params.sourceHandle)) {
    return true;
  }
  if (!params.eventKind) {
    return true;
  }

  return registryPostActionConditionBranchHandleMatchesEvent(
    params.sourceHandle,
    params.eventKind
  );
}

function pathPostActionConditionBranchesMatchEvent(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
  preferredActionNodeId?: string;
  eventKind?: ScenarioRuntimeEventKind | null;
}): boolean {
  // The reply's sender, or the action a continuation leaves, has already
  // traversed its incoming conditions. Only branches after that action must
  // accept this event, including return paths.
  const preferredActionIndex = params.preferredActionNodeId
    ? params.pathNodeIds.indexOf(params.preferredActionNodeId)
    : -1;
  for (
    let index = Math.max(1, preferredActionIndex + 1);
    index < params.pathNodeIds.length;
    index += 1
  ) {
    const sourceNodeId = params.pathNodeIds[index - 1];
    const sourceNode = params.graph.nodesById.get(sourceNodeId);
    if (!sourceNode || !isPostActionConditionNodeData(sourceNode.data)) {
      continue;
    }

    const conditionBranchEdges = getPathIncomingEdges({
      graph: params.graph,
      pathNodeIds: params.pathNodeIds,
      index,
    }).filter(edge => isPostActionConditionBranchHandle(edge.sourceHandle));
    if (conditionBranchEdges.length === 0) {
      continue;
    }

    if (
      !conditionBranchEdges.some(edge =>
        postActionConditionBranchMatchesEvent({
          sourceHandle: edge.sourceHandle,
          eventKind: params.eventKind,
        })
      )
    ) {
      return false;
    }
  }

  return true;
}

/** The action's default output: SCENARIO_HANDLE_RULES.action.outputHandleId. */
const ACTION_DEFAULT_OUTPUT_HANDLE = "right-source";

/**
 * Two path steps joined only by routes that just the first one's form reply
 * runs: its "Form submitted" route, and its default route ("Then"), which
 * can't run once that route is linked, as the builder warns
 * (`resolveScenarioActionDefaultRouteBlocker`). A default route into a
 * post-action condition still arms the step's follow-up wait.
 */
function isFormSubmittedRouteSegment(
  graph: CompiledScenarioGraph,
  sourceNodeId: string,
  targetNodeId: string
): boolean {
  if (!scenarioActionHasFormSubmittedRoute(graph, sourceNodeId)) return false;
  const edges = graph.edges.filter(
    edge => edge.source === sourceNodeId && edge.target === targetNodeId
  );
  if (edges.length === 0) return false;
  const sourceNode = graph.nodesById.get(sourceNodeId);
  const targetNode = graph.nodesById.get(targetNodeId);
  const defaultRouteCannotRun =
    sourceNode !== undefined &&
    targetNode !== undefined &&
    !isPostActionConditionNodeData(targetNode.data) &&
    resolveScenarioActionDefaultRouteBlocker({
      nodeId: sourceNodeId,
      nodeData: sourceNode.data,
      sourceHandleIds: graph.edges.flatMap(edge =>
        edge.source === sourceNodeId ? [edge.sourceHandle] : []
      ),
    }) === "form_submitted";
  return edges.every(edge => {
    if (isWhatsAppTemplateFormSubmittedSourceHandleId(edge.sourceHandle)) {
      return true;
    }
    const handle = edge.sourceHandle?.trim();
    return (
      defaultRouteCannotRun &&
      (!handle || handle === ACTION_DEFAULT_OUTPUT_HANDLE)
    );
  });
}

/**
 * Keeps the part of a path this event routes off "Form submitted" routes
 * and the default routes they keep from running: only a Flow reply to the
 * route's own step takes one (`isFormSubmittedRouteSegment`). Steps up to the
 * answered action were routed by earlier events. A path that would cross a
 * route goes around it when it can, and is dropped otherwise.
 */
function keepPathOffFormSubmittedRoutes(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
  answeredActionNodeId?: string;
  canVisit: (nodeId: string) => boolean;
}): string[] {
  const { graph, pathNodeIds } = params;
  const start = params.answeredActionNodeId
    ? Math.max(0, pathNodeIds.lastIndexOf(params.answeredActionNodeId))
    : 0;
  if (
    !pathNodeIds.some(
      (nodeId, index) =>
        index > start &&
        isFormSubmittedRouteSegment(graph, pathNodeIds[index - 1], nodeId)
    )
  ) {
    return pathNodeIds;
  }

  const adjacencyAroundRoutes = new Map(
    [...graph.adjacency].map(([sourceNodeId, targetNodeIds]) => [
      sourceNodeId,
      targetNodeIds.filter(
        targetNodeId =>
          !isFormSubmittedRouteSegment(graph, sourceNodeId, targetNodeId)
      ),
    ])
  );
  const detour = reconstructForwardPath({
    adjacency: adjacencyAroundRoutes,
    startId: pathNodeIds[start],
    targetId: pathNodeIds[pathNodeIds.length - 1],
    canVisit: params.canVisit,
  });
  return detour ? [...pathNodeIds.slice(0, start), ...detour] : [];
}

/**
 * Where a Flow reply goes from a step with a "Form submitted" route: the
 * first action the route reaches, as on a labeled route, and the path there.
 * Null when the route reaches no action, or only the step that sent the form.
 */
function resolveFormSubmittedRoutePath(params: {
  graph: CompiledScenarioGraph;
  previous: Map<string, string | null>;
  routeActionNodeId: string;
  conversation: ConversationDocument;
  channel: Channel;
  canVisit: (nodeId: string) => boolean;
}): { actionNodeId: string; pathNodeIds: string[] } | null {
  const { graph } = params;
  const pathToRouteAction = reconstructPathFromPrevious({
    previous: params.previous,
    targetNodeId: params.routeActionNodeId,
  });
  const routeTargetId = graph.edges.find(
    edge =>
      edge.source === params.routeActionNodeId &&
      isWhatsAppTemplateFormSubmittedSourceHandleId(edge.sourceHandle) &&
      Boolean(edge.target && graph.nodesById.has(edge.target))
  )?.target;
  if (
    pathToRouteAction.length === 0 ||
    !routeTargetId ||
    !params.canVisit(routeTargetId)
  ) {
    return null;
  }

  const isRuntimeAction = (nodeId: string) => {
    const node = graph.nodesById.get(nodeId);
    return (
      node?.data.kind === "action" && Boolean(normalizeActionType(node.data))
    );
  };
  const actionNodeId = isRuntimeAction(routeTargetId)
    ? routeTargetId
    : resolveFirstReachableActionFromNode({
        graph,
        startNodeId: routeTargetId,
        conversation: params.conversation,
        channel: params.channel,
      })?.id;
  if (!actionNodeId || actionNodeId === params.routeActionNodeId) return null;
  const routePathNodeIds = reconstructForwardPath({
    adjacency: graph.adjacency,
    startId: routeTargetId,
    targetId: actionNodeId,
    canVisit: nodeId =>
      nodeId === actionNodeId ||
      (!isRuntimeAction(nodeId) && params.canVisit(nodeId)),
  });
  return routePathNodeIds
    ? {
        actionNodeId,
        pathNodeIds: [...pathToRouteAction, ...routePathNodeIds],
      }
    : null;
}

function resolveWhatsAppButtonReplyEdgeMatch(params: {
  edge: ScenarioRuntimeEdge;
  quickReplyPayload: string;
}): WhatsAppButtonReplyEdgeMatch {
  if (
    whatsAppTemplateButtonReplyMatchesSourceHandle({
      sourceActionNodeId: params.edge.source,
      sourceHandleId: params.edge.sourceHandle,
      quickReplyPayload: params.quickReplyPayload,
    })
  ) {
    return "matched";
  }

  if (
    getPostActionConditionBranchTransitionByHandle(params.edge.sourceHandle)
  ) {
    return "no_binding";
  }

  if (
    WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION.matchesSourceHandle(
      params.edge.sourceHandle
    )
  ) {
    return "mismatch";
  }

  if (
    (typeof params.edge.sourceHandle === "string"
      ? params.edge.sourceHandle.trim()
      : "") === WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.outputHandleId
  ) {
    return "no_binding";
  }
  if (
    WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.matchesSourceHandle(
      params.edge.sourceHandle,
      [{ id: params.quickReplyPayload, label: params.quickReplyPayload }]
    )
  ) {
    return "matched";
  }
  if (
    WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION.matchesSourceHandle(
      params.edge.sourceHandle
    )
  ) {
    return "mismatch";
  }

  return "no_binding";
}

/**
 * Preferred → … → target route for this WhatsApp button tap.
 * Starts on a matching stb/wsc edge from preferred, then may continue through
 * non-button bridges (right-source / other no_binding edges). Survives
 * dual-parented follow-ups at any depth whose stored stamp belongs to another
 * parent, including preferred → mid → … → target layouts.
 */
function findWhatsAppButtonRouteFromPreferred(params: {
  graph: CompiledScenarioGraph;
  preferredActionNodeId: string;
  targetNodeId: string;
  quickReplyPayload: string;
}): string[] | null {
  if (
    !params.preferredActionNodeId ||
    !params.targetNodeId ||
    !params.quickReplyPayload
  ) {
    return null;
  }

  const matchingBranchTargets = new Set<string>();
  for (const edge of params.graph.edges) {
    if (edge.source !== params.preferredActionNodeId) continue;
    const branchTargetId = edge.target;
    if (!branchTargetId) continue;
    if (
      resolveWhatsAppButtonReplyEdgeMatch({
        edge,
        quickReplyPayload: params.quickReplyPayload,
      }) !== "matched"
    ) {
      continue;
    }
    if (branchTargetId === params.targetNodeId) {
      return [params.preferredActionNodeId, params.targetNodeId];
    }
    matchingBranchTargets.add(branchTargetId);
  }

  if (matchingBranchTargets.size === 0) {
    return null;
  }

  // BFS from each matched branch head through no_binding bridges only.
  const queue: Array<{ nodeId: string; path: string[] }> = [];
  const visited = new Set<string>();
  for (const branchTarget of matchingBranchTargets) {
    queue.push({
      nodeId: branchTarget,
      path: [params.preferredActionNodeId, branchTarget],
    });
    visited.add(branchTarget);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.nodeId === params.targetNodeId) {
      return current.path;
    }

    for (const edge of params.graph.edges) {
      if (edge.source !== current.nodeId) continue;
      const nextNodeId = edge.target;
      if (!nextNodeId || visited.has(nextNodeId)) continue;
      if (
        resolveWhatsAppButtonReplyEdgeMatch({
          edge,
          quickReplyPayload: params.quickReplyPayload,
        }) !== "no_binding"
      ) {
        // Do not cross a different button/list branch while bridging.
        continue;
      }
      visited.add(nextNodeId);
      queue.push({
        nodeId: nextNodeId,
        path: [...current.path, nextNodeId],
      });
    }
  }

  return null;
}

function hasMatchingWhatsAppButtonEdgeFromPreferred(params: {
  graph: CompiledScenarioGraph;
  preferredActionNodeId: string;
  targetNodeId: string;
  quickReplyPayload: string;
}): boolean {
  return findWhatsAppButtonRouteFromPreferred(params) !== null;
}

/**
 * When BFS recorded a path through another inbound parent, rewrite through the
 * preferred button route (direct or via bridges) so ancestor + branch checks
 * use the edge that matches this tap at any depth / dual-parent layout.
 */
function resolveWhatsAppButtonReplyPreferredPath(params: {
  graph: CompiledScenarioGraph;
  previous: Map<string, string | null>;
  preferredActionNodeId: string;
  targetNodeId: string;
  quickReplyPayload: string;
  fallbackPathNodeIds: string[];
}): string[] {
  const routeFromPreferred = findWhatsAppButtonRouteFromPreferred({
    graph: params.graph,
    preferredActionNodeId: params.preferredActionNodeId,
    targetNodeId: params.targetNodeId,
    quickReplyPayload: params.quickReplyPayload,
  });
  if (!routeFromPreferred || routeFromPreferred.length < 2) {
    return params.fallbackPathNodeIds;
  }

  const pathToPreferred = reconstructPathFromPrevious({
    previous: params.previous,
    targetNodeId: params.preferredActionNodeId,
  });
  if (pathToPreferred.length === 0) {
    return params.fallbackPathNodeIds;
  }

  return [...pathToPreferred, ...routeFromPreferred.slice(1)];
}

function whatsAppFlowSelectionMatchesBranch(params: {
  fieldId: string;
  optionId: string;
  whatsAppFlowReplySelections: Map<string, Set<string>>;
  preferredFlowUniqueFieldIdsByOptionId: Map<string, string>;
}): 0 | 1 | null {
  if (
    params.whatsAppFlowReplySelections.get(params.fieldId)?.has(params.optionId)
  ) {
    return 0;
  }

  const legacyFlowFieldId = params.preferredFlowUniqueFieldIdsByOptionId.get(
    params.optionId
  );
  if (
    legacyFlowFieldId &&
    params.whatsAppFlowReplySelections
      .get(legacyFlowFieldId)
      ?.has(params.optionId)
  ) {
    return 1;
  }

  return null;
}

function actionHasInstagramBranches(data: ScenarioNodeData): boolean {
  return (
    normalizeActionType(data) === "reply" &&
    data.actionReplyChannel === "instagram" &&
    extractInstagramBranchOptions(data.actionInstagramConfig).length > 0
  );
}

function resolveNearestInstagramBranchAncestorId(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
}): string | null {
  for (let index = params.pathNodeIds.length - 2; index >= 0; index -= 1) {
    const nodeId = params.pathNodeIds[index];
    const node = params.graph.nodesById.get(nodeId);
    if (!node || node.data.kind !== "action") {
      continue;
    }

    if (actionHasInstagramBranches(node.data)) {
      return node.id;
    }
  }

  return null;
}

function resolveNearestWhatsAppButtonBranchMatch(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
  preferredActionNodeId?: string;
  quickReplyPayload: string;
}): WhatsAppButtonPathBranchResolution {
  const stopIndex = params.preferredActionNodeId
    ? params.pathNodeIds.lastIndexOf(params.preferredActionNodeId)
    : -1;
  let encounteredTemplateButtonBinding = false;

  for (
    let index = params.pathNodeIds.length - 1;
    index > stopIndex;
    index -= 1
  ) {
    const nodeId = params.pathNodeIds[index];
    const node = params.graph.nodesById.get(nodeId);
    if (!node) continue;

    let encounteredIncomingBranchBinding = false;
    for (const edge of getPathIncomingEdges({
      graph: params.graph,
      pathNodeIds: params.pathNodeIds,
      index,
    })) {
      const edgeMatch = resolveWhatsAppButtonReplyEdgeMatch({
        edge,
        quickReplyPayload: params.quickReplyPayload,
      });
      if (edgeMatch === "no_binding") continue;
      encounteredIncomingBranchBinding = true;
      if (edgeMatch === "matched") {
        return {
          kind: "matched",
          nodeId,
        };
      }
    }
    if (encounteredIncomingBranchBinding) {
      // Dual-parent rescue at the selected action: BFS may have recorded a
      // different inbound parent, so path edges mismatch even though preferred
      // still has a matching branch edge to this node.
      if (
        index === params.pathNodeIds.length - 1 &&
        params.preferredActionNodeId &&
        hasMatchingWhatsAppButtonEdgeFromPreferred({
          graph: params.graph,
          preferredActionNodeId: params.preferredActionNodeId,
          targetNodeId: nodeId,
          quickReplyPayload: params.quickReplyPayload,
        })
      ) {
        return {
          kind: "matched",
          nodeId,
        };
      }
      return {
        kind: "mismatch",
      };
    }

    // Prefer a matching preferred→node edge over a stale stamp from another
    // parent before treating stored payload as authoritative.
    if (
      index === params.pathNodeIds.length - 1 &&
      params.preferredActionNodeId &&
      hasMatchingWhatsAppButtonEdgeFromPreferred({
        graph: params.graph,
        preferredActionNodeId: params.preferredActionNodeId,
        targetNodeId: nodeId,
        quickReplyPayload: params.quickReplyPayload,
      })
    ) {
      return {
        kind: "matched",
        nodeId,
      };
    }

    const payload =
      typeof node.data.whatsAppTemplateButtonPayload === "string"
        ? node.data.whatsAppTemplateButtonPayload.trim()
        : typeof node.data.whatsAppSessionChoicePayload === "string"
          ? node.data.whatsAppSessionChoicePayload.trim()
          : "";
    if (!payload) continue;
    encounteredTemplateButtonBinding = true;

    if (payload === params.quickReplyPayload) {
      return {
        kind: "matched",
        nodeId,
      };
    }

    return {
      kind: "mismatch",
    };
  }

  return encounteredTemplateButtonBinding
    ? { kind: "mismatch" }
    : { kind: "no_bindings" };
}

function resolveNearestInstagramBranchMatch(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
  preferredActionNodeId?: string;
  quickReplyPayload: string;
}): InstagramPathBranchResolution {
  const stopIndex = params.preferredActionNodeId
    ? params.pathNodeIds.lastIndexOf(params.preferredActionNodeId)
    : -1;
  let encounteredInstagramBinding = false;

  for (
    let index = params.pathNodeIds.length - 1;
    index > stopIndex;
    index -= 1
  ) {
    const nodeId = params.pathNodeIds[index];
    const node = params.graph.nodesById.get(nodeId);
    if (!node) continue;

    const payload =
      typeof node.data.instagramBranchPayload === "string"
        ? node.data.instagramBranchPayload.trim()
        : "";
    if (!payload) continue;
    encounteredInstagramBinding = true;

    if (payload === params.quickReplyPayload) {
      return {
        kind: "matched",
        nodeId,
      };
    }

    return {
      kind: "mismatch",
    };
  }

  return encounteredInstagramBinding
    ? { kind: "mismatch" }
    : { kind: "no_bindings" };
}

function resolvePathToActionConditionTarget(params: {
  previous: Map<string, string | null>;
  sourceActionNode: ScenarioRuntimeNode;
  conditionNode: ScenarioRuntimeNode;
}): string[] {
  const pathToSource = reconstructPathFromPrevious({
    previous: params.previous,
    targetNodeId: params.sourceActionNode.id,
  });

  return pathToSource.length > 0
    ? [...pathToSource, params.conditionNode.id]
    : [params.sourceActionNode.id, params.conditionNode.id];
}

export function resolveInteractiveReplyConditionTarget(params: {
  graph: CompiledScenarioGraph;
  conversation: ConversationDocument;
  channel: Channel;
  preferredActionNodeId?: string | null;
  matchedTriggerNodeId?: string;
  triggerEventKind?: ScenarioRuntimeEventKind | null;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
}): ScenarioInteractiveReplyConditionTarget | null {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return null;
  }
  const preferredActionNodeId =
    typeof params.preferredActionNodeId === "string"
      ? params.preferredActionNodeId.trim()
      : "";
  if (!preferredActionNodeId) return null;

  const sourceActionNode = params.graph.nodesById.get(preferredActionNodeId);
  if (
    !sourceActionNode ||
    sourceActionNode.data.kind !== "action" ||
    !normalizeActionType(sourceActionNode.data)
  ) {
    return null;
  }

  const isWhatsAppFlowReplyEvent =
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply;
  const isWhatsAppButtonReplyEvent =
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply;
  const isInstagramQuickReplyEvent =
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply;
  if (
    !isWhatsAppFlowReplyEvent &&
    !isWhatsAppButtonReplyEvent &&
    !isInstagramQuickReplyEvent
  ) {
    return null;
  }

  const previous = buildReachabilityFromTriggers({
    graph: params.graph,
    conversation: params.conversation,
    channel: params.channel,
    matchedTriggerNodeId: params.matchedTriggerNodeId,
  });
  const outgoingEdges = params.graph.edges.filter(
    edge => edge.source === preferredActionNodeId
  );

  if (isWhatsAppButtonReplyEvent || isInstagramQuickReplyEvent) {
    const quickReplyPayload =
      typeof params.quickReplyPayload === "string"
        ? params.quickReplyPayload.trim()
        : "";
    if (!quickReplyPayload) return null;

    for (const edge of outgoingEdges) {
      const conditionNode = edge.target
        ? params.graph.nodesById.get(edge.target)
        : null;
      if (
        !conditionNode ||
        conditionNode.data.kind !== "logic" ||
        !isPostActionConditionNodeData(conditionNode.data) ||
        !nodePassesFlowFilters(
          conditionNode,
          params.conversation,
          params.channel
        )
      ) {
        continue;
      }

      if (isWhatsAppButtonReplyEvent) {
        const edgeMatch = resolveWhatsAppButtonReplyEdgeMatch({
          edge,
          quickReplyPayload,
        });
        if (edgeMatch === "matched") {
          return {
            conditionNode,
            sourceActionNode,
            pathNodeIds: resolvePathToActionConditionTarget({
              previous,
              sourceActionNode,
              conditionNode,
            }),
          };
        }
        if (edgeMatch === "mismatch") continue;
      }

      const payload = isInstagramQuickReplyEvent
        ? typeof conditionNode.data.instagramBranchPayload === "string"
          ? conditionNode.data.instagramBranchPayload.trim()
          : ""
        : typeof conditionNode.data.whatsAppTemplateButtonPayload === "string"
          ? conditionNode.data.whatsAppTemplateButtonPayload.trim()
          : typeof conditionNode.data.whatsAppSessionChoicePayload === "string"
            ? conditionNode.data.whatsAppSessionChoicePayload.trim()
            : "";
      if (payload !== quickReplyPayload) continue;

      return {
        conditionNode,
        sourceActionNode,
        pathNodeIds: resolvePathToActionConditionTarget({
          previous,
          sourceActionNode,
          conditionNode,
        }),
      };
    }

    return null;
  }

  let whatsAppFlowReplySelections = parseWhatsAppFlowReplySelections(
    params.whatsAppFlowResponseJson
  );
  const sourceFlowConfig = resolveScenarioWhatsAppInteractiveFlowConfig(
    sourceActionNode.data
  );
  whatsAppFlowReplySelections = expandWhatsAppFlowReplySelectionsWithFlowConfig(
    whatsAppFlowReplySelections,
    sourceFlowConfig
  );
  const preferredFlowUniqueFieldIdsByOptionId =
    collectUniqueFlowFieldIdsByOptionId(sourceFlowConfig);

  for (const edge of outgoingEdges) {
    const branch = parseFlowBranchSourceHandleId(edge.sourceHandle);
    if (!branch) continue;

    const branchPriority = whatsAppFlowSelectionMatchesBranch({
      fieldId: branch.fieldId,
      optionId: branch.optionId,
      whatsAppFlowReplySelections,
      preferredFlowUniqueFieldIdsByOptionId,
    });
    if (branchPriority === null) continue;

    const conditionNode = edge.target
      ? params.graph.nodesById.get(edge.target)
      : null;
    if (
      !conditionNode ||
      conditionNode.data.kind !== "logic" ||
      !isPostActionConditionNodeData(conditionNode.data) ||
      !nodePassesFlowFilters(conditionNode, params.conversation, params.channel)
    ) {
      continue;
    }

    return {
      conditionNode,
      sourceActionNode,
      pathNodeIds: resolvePathToActionConditionTarget({
        previous,
        sourceActionNode,
        conditionNode,
      }),
    };
  }

  return null;
}

function resolveNearestWhatsAppFlowBranchMatch(params: {
  graph: CompiledScenarioGraph;
  pathNodeIds: string[];
  preferredActionNodeId?: string;
  whatsAppFlowReplySelections: Map<string, Set<string>>;
  preferredFlowUniqueFieldIdsByOptionId: Map<string, string>;
}): WhatsAppFlowPathBranchResolution {
  const stopIndex = params.preferredActionNodeId
    ? params.pathNodeIds.lastIndexOf(params.preferredActionNodeId)
    : -1;
  let encounteredFlowBranchBinding = false;

  for (
    let index = params.pathNodeIds.length - 1;
    index > stopIndex;
    index -= 1
  ) {
    const nodeId = params.pathNodeIds[index];
    const node = params.graph.nodesById.get(nodeId);
    if (!node) continue;

    const incomingFlowBranchHandles = getPathIncomingEdges({
      graph: params.graph,
      pathNodeIds: params.pathNodeIds,
      index,
    })
      .map(edge => parseFlowBranchSourceHandleId(edge.sourceHandle))
      .filter((branch): branch is { fieldId: string; optionId: string } =>
        Boolean(branch)
      );
    if (incomingFlowBranchHandles.length > 0) {
      encounteredFlowBranchBinding = true;

      for (const branch of incomingFlowBranchHandles) {
        const branchPriority = whatsAppFlowSelectionMatchesBranch({
          fieldId: branch.fieldId,
          optionId: branch.optionId,
          whatsAppFlowReplySelections: params.whatsAppFlowReplySelections,
          preferredFlowUniqueFieldIdsByOptionId:
            params.preferredFlowUniqueFieldIdsByOptionId,
        });
        if (branchPriority !== null) {
          return {
            kind: "matched",
            nodeId,
            branchPriority,
          };
        }
      }

      return {
        kind: "mismatch",
      };
    }

    const flowBranchSourceFieldId =
      typeof node.data.flowBranchSourceFieldId === "string"
        ? node.data.flowBranchSourceFieldId.trim()
        : "";
    const flowBranchOptionId =
      typeof node.data.flowBranchOptionId === "string"
        ? node.data.flowBranchOptionId.trim()
        : "";
    if (!flowBranchSourceFieldId || !flowBranchOptionId) {
      continue;
    }
    encounteredFlowBranchBinding = true;

    const branchPriority = whatsAppFlowSelectionMatchesBranch({
      fieldId: flowBranchSourceFieldId,
      optionId: flowBranchOptionId,
      whatsAppFlowReplySelections: params.whatsAppFlowReplySelections,
      preferredFlowUniqueFieldIdsByOptionId:
        params.preferredFlowUniqueFieldIdsByOptionId,
    });
    if (branchPriority !== null) {
      return {
        kind: "matched",
        nodeId,
        branchPriority,
      };
    }

    return {
      kind: "mismatch",
    };
  }

  if (!encounteredFlowBranchBinding) {
    return {
      kind: "no_bindings",
    };
  }

  return {
    kind: "mismatch",
  };
}

export function evaluateScenarioFlow(params: {
  graph: CompiledScenarioGraph;
  conversation: ConversationDocument;
  channel: Channel;
  preferredActionNodeId?: string;
  requiredActionNodeId?: string | null;
  /**
   * The waiting action whose claimed outcome forces a post-action
   * continuation to `requiredActionNodeId`.
   */
  continuationSourceActionNodeId?: string | null;
  matchedTriggerNodeId?: string;
  triggerEventKind?: ScenarioRuntimeEventKind | null;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
  /** The step that sent the form a Flow reply submitted, when known. */
  flowReplySourceActionNodeId?: string;
  generativeInbound?: GenerativeAIInboundCandidate | null;
}): ScenarioFlowMatch | null {
  if (hasBlockingScenarioRoutingDiagnostics(params.graph.diagnostics)) {
    return null;
  }
  if (
    resolveScenarioEntryNodeIds({
      graph: params.graph,
      matchedTriggerNodeId: params.matchedTriggerNodeId,
    }).length === 0
  ) {
    return null;
  }
  if (params.graph.runtimeActionNodes.length === 0) return null;
  const isTelegramQuickReplyEvent =
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply;
  const isInstagramQuickReplyEvent =
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply;
  const isWhatsAppButtonReplyEvent =
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply;
  const isWhatsAppFlowReplyEvent =
    params.triggerEventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply;
  const isInteractiveReplyEvent = isScenarioInteractiveReplyEventKind(
    params.triggerEventKind
  );
  const normalizedQuickReplyPayload = (params.quickReplyPayload || "").trim();
  const requiredActionNodeId =
    typeof params.requiredActionNodeId === "string" &&
    params.requiredActionNodeId.trim()
      ? params.requiredActionNodeId.trim()
      : undefined;
  const explicitPreferredActionNodeId =
    typeof params.preferredActionNodeId === "string" &&
    params.preferredActionNodeId.trim()
      ? params.preferredActionNodeId.trim()
      : undefined;
  const payloadPreferredActionNodeId =
    isWhatsAppButtonReplyEvent &&
    !requiredActionNodeId &&
    !explicitPreferredActionNodeId
      ? resolveScenarioStructuredReplyActionNodeId({
          triggerEventKind: params.triggerEventKind,
          quickReplyPayload: normalizedQuickReplyPayload,
        }) || undefined
      : undefined;
  const preferredActionNodeId =
    requiredActionNodeId ||
    explicitPreferredActionNodeId ||
    payloadPreferredActionNodeId ||
    undefined;
  // The action this event answers has already traversed its incoming
  // conditions: an interactive reply's sender, or the waiting action whose
  // claimed outcome forces a post-action continuation. Earlier events took
  // those branches, so only branches after it must accept this event.
  const answeredActionNodeId = isInteractiveReplyEvent
    ? preferredActionNodeId
    : requiredActionNodeId &&
        isScenarioPostActionEventKind(params.triggerEventKind) &&
        typeof params.continuationSourceActionNodeId === "string" &&
        params.continuationSourceActionNodeId.trim()
      ? params.continuationSourceActionNodeId.trim()
      : undefined;
  const preferredActionNode = preferredActionNodeId
    ? params.graph.nodesById.get(preferredActionNodeId)
    : null;
  const preferredFlowConfig =
    preferredActionNode?.data.kind === "action"
      ? resolveScenarioWhatsAppInteractiveFlowConfig(preferredActionNode.data)
      : null;
  let whatsAppFlowReplySelections = parseWhatsAppFlowReplySelections(
    params.whatsAppFlowResponseJson
  );
  if (isWhatsAppFlowReplyEvent && preferredActionNode?.data.kind === "action") {
    whatsAppFlowReplySelections =
      expandWhatsAppFlowReplySelectionsWithFlowConfig(
        whatsAppFlowReplySelections,
        preferredFlowConfig
      );
  }
  const preferredFlowUniqueFieldIdsByOptionId =
    preferredActionNode?.data.kind === "action"
      ? collectUniqueFlowFieldIdsByOptionId(preferredFlowConfig)
      : new Map<string, string>();

  const previous = buildReachabilityFromTriggers({
    graph: params.graph,
    conversation: params.conversation,
    channel: params.channel,
    matchedTriggerNodeId: params.matchedTriggerNodeId,
  });

  // A return edge stamps its destination with the button binding. That same
  // action can still be the first action on an independent trigger path. Stop
  // at actions so this exception cannot expose their button-only descendants.
  const entryPrevious =
    !preferredActionNodeId && !isInteractiveReplyEvent
      ? buildReachabilityFromTriggers({
          graph: params.graph,
          conversation: params.conversation,
          channel: params.channel,
          matchedTriggerNodeId: params.matchedTriggerNodeId,
          stopAtActions: true,
        })
      : null;
  const canVisit = (nodeId: string) => {
    const node = params.graph.nodesById.get(nodeId);
    return Boolean(
      node && nodePassesFlowFilters(node, params.conversation, params.channel)
    );
  };
  // A Flow reply to a step with a "Form submitted" route takes that route and
  // no other; null when the route leads to nothing the reply can run, or the
  // reply submits a form that step is not known to have sent.
  const formSubmittedRoute =
    isWhatsAppFlowReplyEvent &&
    preferredActionNodeId &&
    scenarioActionHasFormSubmittedRoute(params.graph, preferredActionNodeId)
      ? params.flowReplySourceActionNodeId === preferredActionNodeId
        ? resolveFormSubmittedRoutePath({
            graph: params.graph,
            previous,
            routeActionNodeId: preferredActionNodeId,
            conversation: params.conversation,
            channel: params.channel,
            canVisit,
          })
        : null
      : undefined;

  const sortedActionCandidates = params.graph.runtimeActionNodes
    .flatMap(node => {
      const actionType = normalizeActionType(node.data);
      if (!actionType) return [];
      if (requiredActionNodeId && node.id !== requiredActionNodeId) return [];
      // Branch stamps from other parents never veto a path that reaches the
      // node without them: an entry path, or this Flow reply's "Form
      // submitted" route.
      const hasUnstampedPath =
        entryPrevious?.has(node.id) === true ||
        node.id === formSubmittedRoute?.actionNodeId;
      const telegramBranchPayload =
        typeof node.data.telegramBranchPayload === "string"
          ? node.data.telegramBranchPayload.trim()
          : "";
      const instagramBranchPayload =
        typeof node.data.instagramBranchPayload === "string"
          ? node.data.instagramBranchPayload.trim()
          : "";
      const hasFlowBranchBinding =
        typeof node.data.flowBranchSourceFieldId === "string" ||
        typeof node.data.flowBranchOptionId === "string";
      const hasWhatsAppTemplateButtonBranchBinding =
        typeof node.data.whatsAppTemplateButtonPayload === "string";
      const hasWhatsAppSessionChoiceBranchBinding =
        typeof node.data.whatsAppSessionChoicePayload === "string";
      const hasInstagramBranchBinding =
        typeof node.data.instagramBranchPayload === "string";

      if (isTelegramQuickReplyEvent) {
        if (!normalizedQuickReplyPayload || !telegramBranchPayload) return [];
        if (telegramBranchPayload !== normalizedQuickReplyPayload) return [];
      } else if (
        !requiredActionNodeId &&
        !hasUnstampedPath &&
        telegramBranchPayload
      ) {
        // Telegram branch action nodes should only be selected for callback events.
        return [];
      }

      if (isWhatsAppButtonReplyEvent) {
        if (!normalizedQuickReplyPayload) {
          return [];
        }
        // Do not early-filter on stored stb/wsc mismatch. Follow-ups can be
        // dual-parented (template QR + session choice, or two session parents);
        // the stamp from one parent must not veto edge-handle matching from
        // the preferred sender. Exact payload / handle checks happen below.
      } else if (
        !requiredActionNodeId &&
        !hasUnstampedPath &&
        (hasWhatsAppTemplateButtonBranchBinding ||
          hasWhatsAppSessionChoiceBranchBinding)
      ) {
        // Unforced WhatsApp button/list branch action nodes should only be
        // selected for WhatsApp button/list reply events. Required targets can
        // also be owned by a post-action outcome edge.
        return [];
      }

      if (isInstagramQuickReplyEvent) {
        if (!normalizedQuickReplyPayload || !instagramBranchPayload) return [];
        if (instagramBranchPayload !== normalizedQuickReplyPayload) return [];
      } else if (
        !requiredActionNodeId &&
        !hasUnstampedPath &&
        hasInstagramBranchBinding
      ) {
        return [];
      }

      if (
        !requiredActionNodeId &&
        !hasUnstampedPath &&
        !isWhatsAppFlowReplyEvent &&
        hasFlowBranchBinding
      ) {
        // WhatsApp Flow branch action nodes should only be selected for flow replies.
        return [];
      }

      return [
        {
          node,
          actionType,
          pathDistance: getReachablePathDistance({
            previous,
            targetNodeId: node.id,
          }),
          branchPriority:
            isTelegramQuickReplyEvent ||
            isWhatsAppButtonReplyEvent ||
            isInstagramQuickReplyEvent
              ? 0
              : 2,
        },
      ] as Array<{
        node: ScenarioRuntimeNode;
        actionType: ScenarioActionType;
        pathDistance: number;
        branchPriority: number;
      }>;
    })
    .sort((a, b) => {
      const aPreferred = preferredActionNodeId === a.node.id;
      const bPreferred = preferredActionNodeId === b.node.id;
      if (aPreferred && !bPreferred) return -1;
      if (!aPreferred && bPreferred) return 1;
      if (a.branchPriority !== b.branchPriority) {
        return a.branchPriority - b.branchPriority;
      }
      if (a.pathDistance !== b.pathDistance) {
        return a.pathDistance - b.pathDistance;
      }
      return (
        (params.graph.nodeOrder.get(a.node.id) || 0) -
        (params.graph.nodeOrder.get(b.node.id) || 0)
      );
    });

  for (const actionNode of sortedActionCandidates) {
    let pathNodeIds = answeredActionNodeId
      ? stitchTriggerPathThroughPreferred({
          previous,
          adjacency: params.graph.adjacency,
          targetId: actionNode.node.id,
          preferredId: answeredActionNodeId,
          canVisit,
        })
      : reconstructPathFromPrevious({
          previous: entryPrevious?.has(actionNode.node.id)
            ? entryPrevious
            : previous,
          targetNodeId: actionNode.node.id,
        });
    if (
      preferredActionNodeId &&
      isWhatsAppButtonReplyEvent &&
      normalizedQuickReplyPayload
    ) {
      pathNodeIds = resolveWhatsAppButtonReplyPreferredPath({
        graph: params.graph,
        previous,
        preferredActionNodeId,
        targetNodeId: actionNode.node.id,
        quickReplyPayload: normalizedQuickReplyPayload,
        fallbackPathNodeIds: pathNodeIds,
      });
    }
    if (formSubmittedRoute !== undefined) {
      if (actionNode.node.id !== formSubmittedRoute?.actionNodeId) continue;
      pathNodeIds = formSubmittedRoute.pathNodeIds;
    } else {
      pathNodeIds = keepPathOffFormSubmittedRoutes({
        graph: params.graph,
        pathNodeIds,
        answeredActionNodeId: answeredActionNodeId ?? preferredActionNodeId,
        canVisit,
      });
    }
    if (pathNodeIds.length === 0) continue;
    if (
      !pathPostActionConditionBranchesMatchEvent({
        graph: params.graph,
        pathNodeIds,
        preferredActionNodeId: answeredActionNodeId,
        eventKind: params.triggerEventKind,
      })
    ) {
      continue;
    }
    if (preferredActionNodeId) {
      if (
        isInteractiveReplyEvent &&
        !pathNodeIds.includes(preferredActionNodeId)
      ) {
        continue;
      }

      if (isTelegramQuickReplyEvent) {
        const nearestTelegramQuickReplyAncestorId =
          resolveNearestTelegramQuickReplyAncestorId({
            graph: params.graph,
            pathNodeIds,
          });
        if (
          nearestTelegramQuickReplyAncestorId &&
          nearestTelegramQuickReplyAncestorId !== preferredActionNodeId
        ) {
          continue;
        }
      }

      if (isWhatsAppButtonReplyEvent) {
        const nearestWhatsAppButtonBranchAncestorId =
          resolveNearestWhatsAppButtonBranchAncestorId({
            graph: params.graph,
            pathNodeIds,
          });
        if (
          nearestWhatsAppButtonBranchAncestorId &&
          nearestWhatsAppButtonBranchAncestorId !== preferredActionNodeId
        ) {
          continue;
        }
      }

      if (isInstagramQuickReplyEvent) {
        const nearestInstagramBranchAncestorId =
          resolveNearestInstagramBranchAncestorId({
            graph: params.graph,
            pathNodeIds,
          });
        if (
          nearestInstagramBranchAncestorId &&
          nearestInstagramBranchAncestorId !== preferredActionNodeId
        ) {
          continue;
        }
      }

      if (isWhatsAppButtonReplyEvent) {
        const whatsAppButtonBranchResolution =
          resolveNearestWhatsAppButtonBranchMatch({
            graph: params.graph,
            pathNodeIds,
            preferredActionNodeId,
            quickReplyPayload: normalizedQuickReplyPayload,
          });
        if (whatsAppButtonBranchResolution.kind === "mismatch") {
          if (
            !hasMatchingWhatsAppButtonEdgeFromPreferred({
              graph: params.graph,
              preferredActionNodeId,
              targetNodeId: actionNode.node.id,
              quickReplyPayload: normalizedQuickReplyPayload,
            })
          ) {
            continue;
          }
          actionNode.branchPriority = 0;
        } else if (whatsAppButtonBranchResolution.kind === "matched") {
          actionNode.branchPriority = 0;
        } else if (
          hasMatchingWhatsAppButtonEdgeFromPreferred({
            graph: params.graph,
            preferredActionNodeId,
            targetNodeId: actionNode.node.id,
            quickReplyPayload: normalizedQuickReplyPayload,
          })
        ) {
          // Prefer edge route from preferred over stamp-only no_bindings miss.
          actionNode.branchPriority = 0;
        } else {
          const branchPayload =
            typeof actionNode.node.data.whatsAppSessionChoicePayload ===
            "string"
              ? actionNode.node.data.whatsAppSessionChoicePayload.trim()
              : typeof actionNode.node.data.whatsAppTemplateButtonPayload ===
                  "string"
                ? actionNode.node.data.whatsAppTemplateButtonPayload.trim()
                : "";
          if (branchPayload !== normalizedQuickReplyPayload) {
            continue;
          }
          actionNode.branchPriority = 0;
        }
      }

      if (isInstagramQuickReplyEvent) {
        const instagramBranchResolution = resolveNearestInstagramBranchMatch({
          graph: params.graph,
          pathNodeIds,
          preferredActionNodeId,
          quickReplyPayload: normalizedQuickReplyPayload,
        });
        if (instagramBranchResolution.kind === "mismatch") {
          continue;
        }
        if (instagramBranchResolution.kind === "matched") {
          actionNode.branchPriority = 0;
        } else {
          if (!preferredActionNodeId) {
            continue;
          }
          if (actionNode.node.id === preferredActionNodeId) {
            continue;
          }
        }
      }
    }

    if (isWhatsAppFlowReplyEvent && !formSubmittedRoute) {
      const flowBranchResolution = resolveNearestWhatsAppFlowBranchMatch({
        graph: params.graph,
        pathNodeIds,
        preferredActionNodeId,
        whatsAppFlowReplySelections,
        preferredFlowUniqueFieldIdsByOptionId,
      });
      if (flowBranchResolution.kind === "mismatch") {
        continue;
      }
      if (flowBranchResolution.kind === "matched") {
        actionNode.branchPriority = flowBranchResolution.branchPriority;
      } else {
        if (!preferredActionNodeId) {
          continue;
        }
        if (actionNode.node.id === preferredActionNodeId) {
          continue;
        }
      }
    }

    const branchNodeIds = pathNodeIds.filter(nodeId => {
      const node = params.graph.nodesById.get(nodeId);
      if (!node) return false;
      return hasConfiguredAudienceFilter(node);
    });

    const generativeConfig =
      actionNode.actionType === "generative_ai"
        ? normalizeGenerativeAIActionConfig(
            actionNode.node.data.actionGenerativeAIConfig
          )
        : null;
    const flowPromptInputCapture =
      generativeConfig && isWhatsAppFlowReplyEvent
        ? captureFlowTextPromptInputs({
            pathNodes: pathNodeIds.flatMap(nodeId => {
              const node = params.graph.nodesById.get(nodeId);
              return node ? [node] : [];
            }),
            selectedActionNodeId: actionNode.node.id,
            responseJson: params.whatsAppFlowResponseJson,
          })
        : null;
    const flowPromptSource = flowPromptInputCapture
      ? params.graph.nodesById.get(flowPromptInputCapture.sourceActionNodeId)
      : null;
    // Form answers the prompt names reach it from the saved answers, so the
    // reply's "Label: answer" lines leave those fields out.
    const promptFormAnswers =
      generativeConfig && isWhatsAppFlowReplyEvent
        ? listScenarioAnswerReferences(generativeConfig.prompt).flatMap(
            reference => (reference.kind === "form" ? [reference] : [])
          )
        : [];
    const flowPromptForm =
      flowPromptInputCapture && promptFormAnswers.length > 0
        ? readScenarioFormAnswerFieldMapEntry(
            params.graph,
            flowPromptInputCapture.sourceActionNodeId
          )
        : null;
    const flowPromptText = flowPromptInputCapture
      ? buildFlowPromptInputInboundText({
          fields: listScenarioFlowTextPromptInputs(
            flowPromptSource?.data
          ).filter(
            field =>
              !namesFormAnswerField(
                promptFormAnswers,
                flowPromptForm,
                field.key
              )
          ),
          values: flowPromptInputCapture.values,
        })
      : "";
    const generativeAI = generativeConfig
      ? {
          config: generativeConfig,
          input: resolveGenerativeInboundAfterFlowText({
            expectedInputKind: resolveGenerativeAIExpectedInputKind(
              generativeConfig.mode
            ),
            inbound: params.generativeInbound,
            flowPromptText,
            formAnswersInPrompt: promptFormAnswers.length > 0,
          }),
        }
      : undefined;

    return {
      selectedAction: actionNode.node,
      selectedActionType: actionNode.actionType,
      pathNodeIds,
      branchNodeIds,
      ...(generativeAI ? { generativeAI } : {}),
    };
  }

  return null;
}

const formAnswerFieldsByGraph = new WeakMap<
  CompiledScenarioGraph,
  ScenarioFormAnswerFieldMap
>();

/** The graph's forms by sending step, read once per compiled graph. */
export function readScenarioFormAnswerFieldMap(
  graph: CompiledScenarioGraph
): ScenarioFormAnswerFieldMap {
  let fields = formAnswerFieldsByGraph.get(graph);
  if (!fields) {
    fields = buildScenarioFormAnswerFieldMap(graph.nodes);
    formAnswerFieldsByGraph.set(graph, fields);
  }
  return fields;
}

function readScenarioFormAnswerFieldMapEntry(
  graph: CompiledScenarioGraph,
  nodeId: string
): ScenarioFormAnswerFieldMapEntry | null {
  const fields = readScenarioFormAnswerFieldMap(graph);
  return Object.hasOwn(fields, nodeId) ? (fields[nodeId] ?? null) : null;
}

/** Whether a prompt names this reply key of the form as a form answer. */
function namesFormAnswerField(
  references: ReadonlyArray<{ formKey: string; fieldKey: string }>,
  form: ScenarioFormAnswerFieldMapEntry | null,
  responseKey: string
): boolean {
  const field =
    form && Object.hasOwn(form.fields, responseKey)
      ? form.fields[responseKey]
      : undefined;
  return Boolean(
    form &&
      field &&
      references.some(
        reference =>
          reference.formKey === form.formKey && reference.fieldKey === field.key
      )
  );
}

function resolveGenerativeInboundAfterFlowText(params: {
  expectedInputKind: GenerativeAIInputKind;
  inbound?: GenerativeAIInboundCandidate | null;
  flowPromptText: string;
  /**
   * A Flow reply to a prompt that reads form answers is its input, even with
   * no text left to add: the prompt already holds the answers.
   */
  formAnswersInPrompt?: boolean;
}): GenerativeAIInboundDisposition {
  if (!params.inbound) {
    return {
      status: "waiting_for_compatible_input",
      expectedInputKind: params.expectedInputKind,
    };
  }
  const classified = classifyGenerativeAIInbound({
    expectedInputKind: params.expectedInputKind,
    inbound: params.inbound,
  });
  const messageId = params.inbound.messageId.trim();
  if (params.expectedInputKind !== "text" || !messageId) {
    return classified;
  }
  // A Flow reply is stored as a "[Flow response: …]" summary of every
  // answer, flow token included, which reads as typed text. A prompt that
  // reads form answers holds them quoted already, so that summary is never
  // its text.
  if (params.formAnswersInPrompt) {
    return flowTextInput(messageId, params.flowPromptText || null);
  }
  if (classified.status === "compatible" || !params.flowPromptText) {
    return classified;
  }
  return flowTextInput(messageId, params.flowPromptText);
}

function flowTextInput(
  messageId: string,
  textOrCaption: string | null
): GenerativeAIInboundDisposition {
  return {
    status: "compatible",
    input: {
      messageId,
      kind: "text",
      textOrCaption,
      whatsappMediaId: null,
      declaredMimeType: null,
      fileName: null,
    },
  };
}

function actionHasTelegramQuickReplyBranches(data: ScenarioNodeData): boolean {
  return (
    normalizeActionReplyChannelForActionNode(data) === "telegram" &&
    flattenTelegramQuickReplyRows(
      normalizeTelegramQuickReplies(data.actionTelegramQuickReplies)
    ).length > 0
  );
}

function actionHasWhatsAppTemplateButtonBranches(
  data: ScenarioNodeData
): boolean {
  return (
    normalizeActionType(data) === "whatsapp_template" &&
    hasWhatsAppTemplateQuickReplyButtons(data.actionWhatsAppTemplateComponents)
  );
}

function actionHasWhatsAppServiceMessageBranches(
  data: ScenarioNodeData
): boolean {
  return scenarioActionUsesWhatsAppServiceMessageBranchHandles(data);
}

function actionRequiresStructuredReplyEvent(
  graph: CompiledScenarioGraph,
  node: ScenarioRuntimeNode
): boolean {
  const { data } = node;
  return (
    actionHasTelegramQuickReplyBranches(data) ||
    actionHasInstagramBranches(data) ||
    actionHasWhatsAppTemplateButtonBranches(data) ||
    actionHasWhatsAppServiceMessageBranches(data) ||
    scenarioActionAwaitsWhatsAppFlowReply(data) ||
    scenarioActionHasFormSubmittedRoute(graph, node.id)
  );
}

function doesActionAcceptCurrentEvent(params: {
  graph: CompiledScenarioGraph;
  node: ScenarioRuntimeNode;
  eventKind: ScenarioRuntimeEventKind;
  /** The step that sent the form a Flow reply submitted, when known. */
  flowReplySourceActionNodeId?: string;
}): boolean {
  const { data } = params.node;
  const { eventKind } = params;
  if (eventKind === SCENARIO_TRIGGER_EVENT_KIND.telegramQuickReply) {
    return actionHasTelegramQuickReplyBranches(data);
  }

  if (eventKind === SCENARIO_TRIGGER_EVENT_KIND.instagramQuickReply) {
    return actionHasInstagramBranches(data);
  }

  if (eventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply) {
    return (
      actionHasWhatsAppTemplateButtonBranches(data) ||
      actionHasWhatsAppServiceMessageBranches(data)
    );
  }

  if (eventKind === SCENARIO_TRIGGER_EVENT_KIND.whatsAppFlowReply) {
    // A "Form submitted" route takes only a reply to the step's own form.
    return (
      scenarioActionAwaitsWhatsAppFlowReply(data) ||
      (params.flowReplySourceActionNodeId === params.node.id &&
        scenarioActionHasFormSubmittedRoute(params.graph, params.node.id))
    );
  }

  return !actionRequiresStructuredReplyEvent(params.graph, params.node);
}

function isPendingActionDispatch(params: {
  graph: CompiledScenarioGraph;
  currentActionNodeId: string;
  currentPathNodeIds?: string[];
  eventKind: ScenarioRuntimeEventKind;
}): boolean {
  if (
    params.eventKind !== SCENARIO_TRIGGER_EVENT_KIND.inboundMessage &&
    params.eventKind !== SCENARIO_TRIGGER_EVENT_KIND.postActionUserReply
  ) {
    return false;
  }

  // Persistence stores the next action separately from the path of the action
  // just dispatched. An interactive next action is not awaiting its own reply yet.
  const lastDispatchedNodeId = params.currentPathNodeIds?.at(-1);
  if (
    !lastDispatchedNodeId ||
    lastDispatchedNodeId === params.currentActionNodeId
  ) {
    return false;
  }
  const lastDispatchedNode = params.graph.nodesById.get(lastDispatchedNodeId);
  if (
    lastDispatchedNode?.data.kind !== "action" ||
    actionRequiresStructuredReplyEvent(params.graph, lastDispatchedNode)
  ) {
    return false;
  }

  return (
    reconstructForwardPath({
      adjacency: params.graph.adjacency,
      startId: lastDispatchedNodeId,
      targetId: params.currentActionNodeId,
      canVisit: nodeId => {
        if (
          nodeId === lastDispatchedNodeId ||
          nodeId === params.currentActionNodeId
        )
          return true;
        const node = params.graph.nodesById.get(nodeId);
        return Boolean(
          node &&
            node.data.kind !== "action" &&
            !isPostActionConditionNodeData(node.data)
        );
      },
    }) !== null
  );
}

export function resolvePreferredContinuationActionNodeId(params: {
  scenario: ScenarioRecord | null;
  currentActionNodeId?: string | null;
  currentPathNodeIds?: string[];
  eventKind: ScenarioRuntimeEventKind;
  /** The step of this scenario that sent the form a Flow reply submitted. */
  flowReplySourceActionNodeId?: string;
}): string | undefined {
  const currentActionNodeId =
    typeof params.currentActionNodeId === "string" &&
    params.currentActionNodeId.trim()
      ? params.currentActionNodeId.trim()
      : "";
  if (!currentActionNodeId) {
    return undefined;
  }

  if (!params.scenario) {
    return currentActionNodeId;
  }

  const graph = getCompiledScenarioGraph(params.scenario);
  const node = graph.nodesById.get(currentActionNodeId);
  if (!node || node.data.kind !== "action") {
    return undefined;
  }

  return doesActionAcceptCurrentEvent({ ...params, graph, node }) ||
    isPendingActionDispatch({ ...params, graph, currentActionNodeId })
    ? currentActionNodeId
    : undefined;
}

export function shouldPinLockedScenarioForEvent(params: {
  scenario: ScenarioRecord | null;
  currentActionNodeId?: string | null;
  currentPathNodeIds?: string[];
  eventKind: ScenarioRuntimeEventKind;
  /** The step of this scenario that sent the form a Flow reply submitted. */
  flowReplySourceActionNodeId?: string;
}): boolean {
  const currentActionNodeId =
    typeof params.currentActionNodeId === "string" &&
    params.currentActionNodeId.trim()
      ? params.currentActionNodeId.trim()
      : "";
  if (!currentActionNodeId) {
    return true;
  }

  if (!params.scenario) {
    return true;
  }

  const graph = getCompiledScenarioGraph(params.scenario);
  const node = graph.nodesById.get(currentActionNodeId);
  if (!node || node.data.kind !== "action") {
    return true;
  }

  return (
    doesActionAcceptCurrentEvent({ ...params, graph, node }) ||
    isPendingActionDispatch({ ...params, graph, currentActionNodeId })
  );
}

// ---------------------------------------------------------------------------
// Quick reply loading
// ---------------------------------------------------------------------------
