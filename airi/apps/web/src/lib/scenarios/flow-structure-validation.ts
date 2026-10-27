import type { ScenarioNodeData } from "@icecore/scenario-contracts";
import {
  compileScenarioGraph,
  type CompiledScenarioGraph,
  type ScenarioRuntimeEdge,
  type ScenarioRuntimeNode,
} from "@icecore/airi-runtime/scenario-graph";
import { normalizeActionType } from "@/lib/scenarios/normalization";
import {
  getNoReplyAnswerMatchRules,
  getPostActionAnswerMatchHandleId,
  getPostActionConditionHandleId,
  parsePostActionLocationHandleId,
  SCENARIO_POST_ACTION_CONDITION_TYPES,
  isPostActionConditionNodeData,
  isWhatsAppTemplateFormSubmittedSourceHandleId,
} from "@icecore/scenario-contracts";
import {
  getRecipientColumnSplitConfig,
  isRecipientColumnSplitNodeData,
} from "@/lib/scenarios/recipient-column-split";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import { resolveScenarioWhatsAppServiceFlowConfig } from "@/lib/scenarios/whatsapp-service-message";
import { getRecipientColumnSplitSourceHandleIds } from "@icecore/scenario-contracts";

export type ScenarioFlowStructureErrorKey =
  | "ambiguousNextActionFork"
  | "bulkPrimaryActionAlreadyConnected"
  | "bulkPrimaryActionRequiresAction"
  | "generativeAIUnsupportedInBulk"
  | "whatsappTemplateBindingsRequireConversation"
  | "whatsappTemplateFormRouteInBulk"
  | "stackedInteractiveActions";

function isRuntimeActionNode(node: ScenarioRuntimeNode): boolean {
  if (node.data.kind !== "action") return false;
  return Boolean(normalizeActionType(node.data));
}

/**
 * Only WhatsApp Flow participates in the “stacked interactive” graph check.
 * Telegram messages with inline keyboards already block until a callback, so
 * chaining builders or a builder → reply does not need a post-action wait node
 * for routing; that node is for explicit follow-ups / timeouts, not a mechanical
 * requirement between Telegram steps.
 */
function isStackedStructureWhatsAppFlowNode(
  node: ScenarioRuntimeNode
): boolean {
  if (node.data.kind !== "action") return false;
  return resolveScenarioWhatsAppServiceFlowConfig(node.data) !== null;
}

function isPostActionConditionRuntimeNode(node: ScenarioRuntimeNode): boolean {
  return isPostActionConditionNodeData(node.data);
}

/**
 * Mirrors `resolveFirstReachableActionFromNode` level-wise walk: if two or more
 * runnable actions appear at the same shortest distance from `startId`, the
 * runtime picks one arbitrarily — block this in the editor.
 */
export function hasAmbiguousFirstActionsFromStart(params: {
  graph: CompiledScenarioGraph;
  startId: string;
}): boolean {
  return collectAmbiguousFirstActionNodesAtStart(params) !== null;
}

/**
 * When multiple runnable actions are reached at the same BFS level from
 * `startId`, returns those action nodes (unsorted); otherwise null.
 */
export function collectAmbiguousFirstActionNodesAtStart(params: {
  graph: CompiledScenarioGraph;
  startId: string;
  sourceHandle?: string | null;
}): ScenarioRuntimeNode[] | null {
  const { graph, startId } = params;
  if (!graph.nodesById.has(startId)) return null;

  const visited = new Set<string>([startId]);
  const queue: string[] =
    typeof params.sourceHandle === "string"
      ? params.graph.edges.flatMap(edge =>
          edge.source === startId &&
          edge.sourceHandle === params.sourceHandle &&
          edge.target
            ? [edge.target]
            : []
        )
      : [...(graph.adjacency.get(startId) || [])];

  while (queue.length > 0) {
    const levelSize = queue.length;
    const levelActionNodes: ScenarioRuntimeNode[] = [];

    for (let i = 0; i < levelSize; i += 1) {
      const nodeId = queue.shift();
      if (!nodeId || visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = graph.nodesById.get(nodeId);
      if (!node) continue;

      if (isRuntimeActionNode(node)) {
        levelActionNodes.push(node);
        continue;
      }

      for (const nextId of graph.adjacency.get(node.id) || []) {
        if (!visited.has(nextId)) {
          queue.push(nextId);
        }
      }
    }

    if (levelActionNodes.length > 1) {
      return levelActionNodes;
    }
  }

  return null;
}

function isRecipientColumnSplitRuntimeNode(node: ScenarioRuntimeNode): boolean {
  return isRecipientColumnSplitNodeData(node.data);
}

function findAmbiguousForkDetails(
  graph: CompiledScenarioGraph
): { forkSourceId: string; conflictingActionIds: string[] } | null {
  for (const node of graph.nodes) {
    const kind = node.data.kind;
    if (kind === "trigger" || kind === "action" || kind === "bulk") continue;

    const branchHandles: Array<string | null> =
      isPostActionConditionRuntimeNode(node)
        ? [
            // The compiled graph also contains payment outcomes hidden from
            // the legacy condition editor. Validate every runtime branch.
            ...SCENARIO_POST_ACTION_CONDITION_TYPES.map(type =>
              getPostActionConditionHandleId(type)
            ),
            ...getNoReplyAnswerMatchRules(node.data).map(rule =>
              getPostActionAnswerMatchHandleId(rule.id)
            ),
            // Location routes live on the step, so the wait's own edges
            // name them.
            ...new Set(
              graph.edges.flatMap(edge =>
                edge.source === node.id &&
                edge.sourceHandle &&
                parsePostActionLocationHandleId(edge.sourceHandle)
                  ? [edge.sourceHandle]
                  : []
              )
            ),
          ]
        : isRecipientColumnSplitRuntimeNode(node)
          ? getRecipientColumnSplitSourceHandleIds(
              getRecipientColumnSplitConfig(node.data)
            )
          : [null];
    const branchHandleSet = new Set(branchHandles);
    const sourceHandles =
      isPostActionConditionRuntimeNode(node) ||
      isRecipientColumnSplitRuntimeNode(node)
        ? [
            ...branchHandles,
            ...(graph.edges.some(
              edge =>
                edge.source === node.id &&
                !branchHandleSet.has(edge.sourceHandle || null)
            )
              ? [null]
              : []),
          ]
        : branchHandles;

    for (const sourceHandle of sourceHandles) {
      const ambiguous = collectAmbiguousFirstActionNodesAtStart({
        graph,
        startId: node.id,
        sourceHandle,
      });
      if (ambiguous && ambiguous.length > 1) {
        const conflictingActionIds = ambiguous
          .map(n => n.id)
          .sort((a, b) => a.localeCompare(b));
        return { forkSourceId: node.id, conflictingActionIds };
      }
    }
  }
  return null;
}

/**
 * True when there is a forward path from `fromId` to `toId` such that no node
 * strictly between the walk (after leaving `fromId`, before arriving at `toId`)
 * is a post-action condition logic node. Those nodes reset "which action we're
 * waiting on" for WhatsApp Flow / Telegram keyboards.
 */
export function hasUnprotectedPathBetween(params: {
  graph: CompiledScenarioGraph;
  fromId: string;
  toId: string;
}): boolean {
  const { graph, fromId, toId } = params;
  if (fromId === toId) return false;

  type Q = { id: string; crossedPostAction: boolean };
  const seen = new Set<string>();
  const queue: Q[] = [];

  for (const next of graph.adjacency.get(fromId) || []) {
    const nextNode = graph.nodesById.get(next);
    if (!nextNode) continue;
    queue.push({
      id: next,
      crossedPostAction: isPostActionConditionRuntimeNode(nextNode),
    });
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const { id, crossedPostAction } = item;

    const node = graph.nodesById.get(id);
    if (!node) continue;

    const key = `${id}:${crossedPostAction ? "1" : "0"}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (id === toId && !crossedPostAction) {
      return true;
    }

    for (const next of graph.adjacency.get(id) || []) {
      const nextNode = graph.nodesById.get(next);
      if (!nextNode) continue;
      const nextCrossed =
        crossedPostAction || isPostActionConditionRuntimeNode(nextNode);
      queue.push({ id: next, crossedPostAction: nextCrossed });
    }
  }

  return false;
}

function findStackedInteractivePair(
  graph: CompiledScenarioGraph
): { fromId: string; toId: string } | null {
  const interactives = graph.nodes.filter(isStackedStructureWhatsAppFlowNode);
  for (const a of interactives) {
    for (const b of interactives) {
      if (a.id === b.id) continue;
      if (
        hasUnprotectedPathBetween({
          graph,
          fromId: a.id,
          toId: b.id,
        })
      ) {
        return { fromId: a.id, toId: b.id };
      }
    }
  }
  return null;
}

type BulkSendPathStep = Readonly<{
  bulkNodeId: string;
  node: ScenarioRuntimeNode;
  actionType: ReturnType<typeof resolveScenarioActionTypeFromNodeData>;
  /** The path went through an action before this node. */
  passedAction: boolean;
}>;

/** Walks every path out of each bulk node until `visit` returns a result. */
function walkBulkSendPaths<T>(
  graph: CompiledScenarioGraph,
  visit: (step: BulkSendPathStep) => T | null
): T | null {
  for (const bulkNode of graph.nodes) {
    if (bulkNode.data.kind !== "bulk") continue;
    const visited = new Set<string>();
    const queue = (graph.adjacency.get(bulkNode.id) ?? []).map(nodeId => ({
      nodeId,
      passedAction: false,
    }));

    while (queue.length > 0) {
      const step = queue.shift();
      if (!step) continue;
      const { nodeId, passedAction } = step;
      const key = `${nodeId}:${passedAction}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const node = graph.nodesById.get(nodeId);
      if (!node) continue;
      const actionType =
        node.data.kind === "action"
          ? resolveScenarioActionTypeFromNodeData(node.data)
          : null;
      const result = visit({
        bulkNodeId: bulkNode.id,
        node,
        actionType,
        passedAction,
      });
      if (result !== null) return result;
      for (const nextId of graph.adjacency.get(nodeId) ?? []) {
        queue.push({
          nodeId: nextId,
          passedAction: passedAction || Boolean(actionType),
        });
      }
    }
  }
  return null;
}

/**
 * A template the bulk send sends: its walk reaches it before any other
 * action. It takes no conversation bindings and offers no "Form submitted"
 * route.
 */
function isBulkPrimaryWhatsAppTemplate(step: BulkSendPathStep): boolean {
  return !step.passedAction && step.actionType === "whatsapp_template";
}

/**
 * The templates bulk sends send, by the rule the flow check refuses their
 * "Form submitted" route with. The builder hides that route on them and
 * reads no form fields for them.
 */
export function listBulkPrimaryWhatsAppTemplateIds(
  params: EditorScenarioGraph
): Set<string> {
  const ids = new Set<string>();
  // Most scenarios have no bulk node, so they skip compiling the graph.
  if (!params.nodes.some(node => node.data.kind === "bulk")) return ids;
  walkBulkSendPaths(compileEditorScenarioGraph(params), step => {
    if (isBulkPrimaryWhatsAppTemplate(step)) ids.add(step.node.id);
    return null;
  });
  return ids;
}

type UnsupportedBulkActionPath = {
  bulkNodeId: string;
  actionNodeId: string;
  errorKey: ScenarioFlowStructureErrorKey;
};

function findUnsupportedBulkActionPath(
  graph: CompiledScenarioGraph
): UnsupportedBulkActionPath | null {
  return walkBulkSendPaths<UnsupportedBulkActionPath>(graph, step => {
    const { bulkNodeId, node, actionType, passedAction } = step;
    if (
      isBulkPrimaryWhatsAppTemplate(step) &&
      node.data.actionWhatsAppTemplateBindings !== undefined
    ) {
      return {
        bulkNodeId,
        actionNodeId: node.id,
        errorKey: "whatsappTemplateBindingsRequireConversation",
      };
    }
    // A bulk send offers no "Form submitted" route: the builder hides it.
    if (
      isBulkPrimaryWhatsAppTemplate(step) &&
      graph.edges.some(
        edge =>
          edge.source === node.id &&
          isWhatsAppTemplateFormSubmittedSourceHandleId(edge.sourceHandle)
      )
    ) {
      return {
        bulkNodeId,
        actionNodeId: node.id,
        errorKey: "whatsappTemplateFormRouteInBulk",
      };
    }
    if (
      actionType === "generative_ai" ||
      (actionType === "end_scenario" && !passedAction)
    ) {
      return {
        bulkNodeId,
        actionNodeId: node.id,
        errorKey:
          actionType === "generative_ai"
            ? "generativeAIUnsupportedInBulk"
            : "bulkPrimaryActionRequiresAction",
      };
    }
    return null;
  });
}

export type CompiledScenarioFlowStructureIssue = {
  errorKey: ScenarioFlowStructureErrorKey;
  /** Stable order for editor navigation: fork/source first, then targets. */
  relatedNodeIds: string[];
};

export function getCompiledScenarioFlowStructureIssue(
  graph: CompiledScenarioGraph
): CompiledScenarioFlowStructureIssue | null {
  const unsupportedBulkAction = findUnsupportedBulkActionPath(graph);
  if (unsupportedBulkAction) {
    return {
      errorKey: unsupportedBulkAction.errorKey,
      relatedNodeIds: [
        unsupportedBulkAction.bulkNodeId,
        unsupportedBulkAction.actionNodeId,
      ],
    };
  }
  const ambiguous = findAmbiguousForkDetails(graph);
  if (ambiguous) {
    return {
      errorKey: "ambiguousNextActionFork",
      relatedNodeIds: [
        ambiguous.forkSourceId,
        ...ambiguous.conflictingActionIds,
      ],
    };
  }
  const stacked = findStackedInteractivePair(graph);
  if (stacked) {
    return {
      errorKey: "stackedInteractiveActions",
      relatedNodeIds: [stacked.fromId, stacked.toId],
    };
  }
  return null;
}

export function validateCompiledScenarioFlowStructure(
  graph: CompiledScenarioGraph
): ScenarioFlowStructureErrorKey | null {
  return getCompiledScenarioFlowStructureIssue(graph)?.errorKey ?? null;
}

export function validateScenarioFlowStructure(params: {
  nodes: ScenarioRuntimeNode[];
  edges: ScenarioRuntimeEdge[];
}): ScenarioFlowStructureErrorKey | null {
  const graph = compileScenarioGraph(params.nodes, params.edges);
  return validateCompiledScenarioFlowStructure(graph);
}

export function validateEditorScenarioFlowStructure(params: {
  nodes: Array<{ id: string; data: ScenarioNodeData }>;
  edges: Array<{
    source?: string;
    target?: string;
    sourceHandle?: string | null;
  }>;
}): ScenarioFlowStructureErrorKey | null {
  return getEditorScenarioFlowStructureIssue(params)?.errorKey ?? null;
}

export function getEditorScenarioFlowStructureIssue(params: {
  nodes: Array<{ id: string; data: ScenarioNodeData }>;
  edges: Array<{
    source?: string;
    target?: string;
    sourceHandle?: string | null;
  }>;
}): CompiledScenarioFlowStructureIssue | null {
  return getCompiledScenarioFlowStructureIssue(
    compileEditorScenarioGraph(params)
  );
}

type EditorScenarioGraph = {
  nodes: ReadonlyArray<{ id: string; data: ScenarioNodeData }>;
  edges: ReadonlyArray<{
    source?: string;
    target?: string;
    sourceHandle?: string | null;
  }>;
};

function compileEditorScenarioGraph(
  params: EditorScenarioGraph
): CompiledScenarioGraph {
  const nodes: ScenarioRuntimeNode[] = params.nodes.map(n => ({
    id: n.id,
    data: n.data,
  }));
  const edges: ScenarioRuntimeEdge[] = params.edges.flatMap(e => {
    if (!e.source || !e.target) return [];
    return [
      {
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
      },
    ];
  });
  return compileScenarioGraph(nodes, edges);
}
