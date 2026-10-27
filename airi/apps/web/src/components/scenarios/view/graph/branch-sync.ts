import {
  clearScenarioBranchBindingData,
  FLOW_BRANCH_TRANSITION,
  getScenarioActionBranchTransitionsForNode,
  hasSameScenarioBranchBindingData,
  hasScenarioBranchBindingData,
  hasScenarioFlowBranchBindingData,
  INSTAGRAM_BRANCH_TRANSITION,
  TELEGRAM_BRANCH_TRANSITION,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION,
  WHATSAPP_TEMPLATE_FORM_SUBMITTED_OUTPUT_TRANSITION,
  type ScenarioActionBranchTransitionDescriptor,
  type ScenarioBranchOption,
  type ScenarioWhatsAppTemplateFormSubmittedTransitionDescriptor,
} from "@/lib/scenarios/transition-registry";
import {
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  normalizeScenarioActionOutcomes,
  parseFlowBranchOptionKey,
  retainScenarioActionBranchDelays,
} from "@icecore/scenario-contracts";
import {
  DEFAULT_SCENARIO_EDGE_STYLE,
  SCENARIO_HANDLE_RULES,
} from "../../graph/config";
import { createScenarioGraphId } from "../../graph/id";
import {
  resolveAvailableSourceHandleIds,
  resolveEffectiveOutputHandleId,
} from "../../graph/source-handles";
import {
  createNodeFromPaletteItem,
  SCENARIO_NODE_PALETTE,
} from "../../graph/node-palette";
import type {
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
} from "../../types";

// ---------------------------------------------------------------------------
// Generic branch descriptor: captures the differences between WhatsApp Flow
// branches and Telegram quick-reply branches so all sync / validation logic
// can be shared.
// ---------------------------------------------------------------------------

/** A single branch option with a unique identifier and display label. */
export type GenericBranchOption = ScenarioBranchOption;
export type BranchDescriptor = ScenarioActionBranchTransitionDescriptor;

export const FLOW_BRANCH_DESCRIPTOR = FLOW_BRANCH_TRANSITION;
export const TELEGRAM_BRANCH_DESCRIPTOR = TELEGRAM_BRANCH_TRANSITION;
export const WHATSAPP_SERVICE_MESSAGE_BRANCH_DESCRIPTOR =
  WHATSAPP_SERVICE_MESSAGE_BRANCH_TRANSITION;
export const INSTAGRAM_BRANCH_DESCRIPTOR = INSTAGRAM_BRANCH_TRANSITION;
export const WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR =
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_TRANSITION;

/** Every branch kind an action's patch can add or remove routes for. */
export const ACTION_BRANCH_DESCRIPTORS: BranchDescriptor[] = [
  FLOW_BRANCH_DESCRIPTOR,
  TELEGRAM_BRANCH_DESCRIPTOR,
  INSTAGRAM_BRANCH_DESCRIPTOR,
  WHATSAPP_SERVICE_MESSAGE_BRANCH_DESCRIPTOR,
  WHATSAPP_TEMPLATE_BUTTON_BRANCH_DESCRIPTOR,
];

function resolveBranchOptionIdentity(params: {
  descriptor: BranchDescriptor;
  nodeData: ScenarioNodeData;
  branchOptions: GenericBranchOption[];
}): string | undefined {
  const directBranchId = params.descriptor.getBranchId(params.nodeData);
  if (
    directBranchId &&
    params.branchOptions.some(option => option.id === directBranchId)
  ) {
    return directBranchId;
  }

  if (params.descriptor !== FLOW_BRANCH_DESCRIPTOR) {
    return directBranchId;
  }

  const legacyOptionId =
    typeof params.nodeData.flowBranchOptionId === "string"
      ? params.nodeData.flowBranchOptionId.trim()
      : "";
  if (!legacyOptionId) {
    return directBranchId;
  }

  const matchingOptions = params.branchOptions.filter(option => {
    const parsed = parseFlowBranchOptionKey(option.id);
    return parsed?.optionId === legacyOptionId;
  });

  return matchingOptions.length === 1 ? matchingOptions[0].id : directBranchId;
}

export function clearBranchBindingData(): Partial<ScenarioNodeData> {
  return clearScenarioBranchBindingData();
}

export function hasBranchBindingData(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): boolean {
  return hasScenarioBranchBindingData(nodeData);
}

function hasFlowBranchBindingData(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): boolean {
  return hasScenarioFlowBranchBindingData(nodeData);
}

export function hasSameBranchBindingData(
  previous: Partial<ScenarioNodeData>,
  next: Partial<ScenarioNodeData>
): boolean {
  return hasSameScenarioBranchBindingData(previous, next);
}

function clearBranchBindingDataIfPresent(
  nodeData: Partial<ScenarioNodeData> | null | undefined
): Partial<ScenarioNodeData> | null {
  return hasBranchBindingData(nodeData) ? clearBranchBindingData() : null;
}

function getBranchDescriptors(nodeData: ScenarioNodeData): BranchDescriptor[] {
  return getScenarioActionBranchTransitionsForNode(nodeData);
}

type BranchConnectionResolution = {
  descriptor: BranchDescriptor;
  optionCount: number;
  patch: Partial<ScenarioNodeData> | null;
  sourceHandleId: string | null;
};

function isBranchSourceHandle(
  descriptor: BranchDescriptor,
  sourceHandleId: string | null | undefined
): boolean {
  return descriptor.matchesSourceHandle(sourceHandleId);
}

function buildBranchSourceHandleForOption(
  descriptor: BranchDescriptor,
  option: GenericBranchOption | null
): string | null {
  return descriptor.buildSourceHandleForOption(option);
}

function resolveRequestedBranchIdForDescriptor(params: {
  descriptor: BranchDescriptor;
  requestedSourceHandle?: string | null;
  branchOptions: GenericBranchOption[];
}): string | null {
  const normalizedRequestedSourceHandle =
    typeof params.requestedSourceHandle === "string"
      ? params.requestedSourceHandle.trim()
      : "";
  if (!normalizedRequestedSourceHandle) return null;

  return params.descriptor.resolveBranchIdFromSourceHandle(
    normalizedRequestedSourceHandle,
    params.branchOptions
  );
}

function resolveBranchOptionIdForEdge(params: {
  descriptor: BranchDescriptor;
  branchOptions: GenericBranchOption[];
  sourceHandleId?: string | null;
  targetNodeData: ScenarioNodeData;
}): string | undefined {
  return (
    resolveRequestedBranchIdForDescriptor({
      descriptor: params.descriptor,
      requestedSourceHandle: params.sourceHandleId,
      branchOptions: params.branchOptions,
    }) ??
    resolveBranchOptionIdentity({
      descriptor: params.descriptor,
      nodeData: params.targetNodeData,
      branchOptions: params.branchOptions,
    })
  );
}

export function resolveBranchBindingForConnection(params: {
  sourceNode: ScenarioFlowNode;
  targetNode: ScenarioFlowNode;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  requestedSourceHandle?: string | null;
}): BranchConnectionResolution | null {
  const { sourceNode, targetNode, nodes, edges, requestedSourceHandle } =
    params;
  const sourceData = sourceNode.data as ScenarioNodeData;
  const targetData = targetNode.data as ScenarioNodeData;
  const normalizedRequestedSourceHandle =
    typeof requestedSourceHandle === "string"
      ? requestedSourceHandle.trim()
      : "";
  const descriptors = getBranchDescriptors(sourceData);
  const descriptorFromRequestedHandle = descriptors.find(item =>
    isBranchSourceHandle(item, normalizedRequestedSourceHandle)
  );
  const descriptor =
    descriptorFromRequestedHandle ||
    (normalizedRequestedSourceHandle
      ? null
      : descriptors.find(
          item =>
            resolveEffectiveOutputHandleId(sourceNode) === item.outputHandleId
        )) ||
    null;

  if (!descriptor) return null;
  if (
    resolveEffectiveOutputHandleId(sourceNode) !== descriptor.outputHandleId &&
    !isBranchSourceHandle(descriptor, normalizedRequestedSourceHandle)
  ) {
    return null;
  }

  const branchOptions = descriptor.extractOptions(sourceData, sourceNode.id);
  if (branchOptions.length === 0) return null;

  if (
    descriptor === FLOW_BRANCH_DESCRIPTOR &&
    normalizedRequestedSourceHandle === descriptor.outputHandleId
  ) {
    return {
      descriptor,
      optionCount: branchOptions.length,
      sourceHandleId: descriptor.outputHandleId,
      patch: clearBranchBindingData(),
    };
  }

  const nodesById = new Map(nodes.map(node => [node.id, node] as const));
  const usedIds = new Set<string>();

  for (const edge of edges) {
    if (
      edge.source !== sourceNode.id ||
      edge.target === targetNode.id ||
      !isBranchSourceHandle(descriptor, edge.sourceHandle)
    ) {
      continue;
    }

    const siblingTarget = nodesById.get(edge.target);
    if (!siblingTarget) continue;

    const siblingBranchId = resolveBranchOptionIdForEdge({
      descriptor,
      branchOptions,
      sourceHandleId: edge.sourceHandle,
      targetNodeData: siblingTarget.data as ScenarioNodeData,
    });
    if (siblingBranchId) {
      usedIds.add(siblingBranchId);
    }
  }

  const requestedBranchId = resolveRequestedBranchIdForDescriptor({
    descriptor,
    requestedSourceHandle,
    branchOptions,
  });
  const currentBranchId = resolveBranchOptionIdentity({
    descriptor,
    nodeData: targetData,
    branchOptions,
  });
  const requestedOption = requestedBranchId
    ? (branchOptions.find(option => option.id === requestedBranchId) ?? null)
    : null;
  const assignedOption = requestedOption
    ? !usedIds.has(requestedOption.id) || currentBranchId === requestedOption.id
      ? requestedOption
      : null
    : (currentBranchId &&
        !usedIds.has(currentBranchId) &&
        branchOptions.find(option => option.id === currentBranchId)) ||
      branchOptions.find(option => !usedIds.has(option.id)) ||
      null;

  return {
    descriptor,
    optionCount: branchOptions.length,
    sourceHandleId: buildBranchSourceHandleForOption(
      descriptor,
      assignedOption
    ),
    patch: assignedOption
      ? {
          ...clearBranchBindingData(),
          ...descriptor.makeBranchNodeData(assignedOption),
        }
      : null,
  };
}

export function resolveBranchBindingForTargetNode(params: {
  targetNodeId: string;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
}): Partial<ScenarioNodeData> | null {
  const { targetNodeId, nodes, edges } = params;
  const nodesById = new Map(nodes.map(node => [node.id, node] as const));
  const targetNode = nodesById.get(targetNodeId);

  if (!targetNode) return null;

  const incomingBranchEdge = edges.find(edge => {
    if (edge.target !== targetNodeId) return false;

    const sourceNode = nodesById.get(edge.source);
    if (!sourceNode) return false;

    const descriptors = getBranchDescriptors(
      sourceNode.data as ScenarioNodeData
    );

    return descriptors.some(descriptor =>
      isBranchSourceHandle(descriptor, edge.sourceHandle)
    );
  });

  if (!incomingBranchEdge) {
    return clearBranchBindingDataIfPresent(targetNode.data as ScenarioNodeData);
  }

  const sourceNode = nodesById.get(incomingBranchEdge.source);
  if (!sourceNode) {
    return clearBranchBindingDataIfPresent(targetNode.data as ScenarioNodeData);
  }

  const resolution = resolveBranchBindingForConnection({
    sourceNode,
    targetNode,
    nodes,
    edges,
    requestedSourceHandle: incomingBranchEdge.sourceHandle,
  });

  if (resolution?.patch) {
    return resolution.patch;
  }

  return clearBranchBindingDataIfPresent(targetNode.data as ScenarioNodeData);
}

// ---------------------------------------------------------------------------
// Generic branch node synchronization
// ---------------------------------------------------------------------------

export type BranchSyncResult = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  addedNodeIds: string[];
  removedNodeIds: string[];
  updatedNodeIds: string[];
};

/** A route from one of the action's options, or a template's form route. */
export type BranchRoute = {
  descriptorKind:
    | BranchDescriptor["kind"]
    | ScenarioWhatsAppTemplateFormSubmittedTransitionDescriptor["kind"];
  /**
   * The label of the option the route starts from. Empty for "Form
   * submitted", which the caller names.
   */
  label: string;
  targetNodeId: string;
};

export type BranchTransitionResult = {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  changed: boolean;
  dirty: boolean;
  structuralHistoryRequired: boolean;
  /** Routes the transition removed because their option went away. */
  removedRoutes: BranchRoute[];
};

function hasNodeDataPatchChanges(
  nodeData: ScenarioNodeData,
  patch: Partial<ScenarioNodeData>
): boolean {
  return Object.entries(patch).some(
    ([key, value]) => !Object.is(nodeData[key as keyof ScenarioNodeData], value)
  );
}

function hasStructuralEdgeChanges(
  currentEdges: ScenarioFlowEdge[],
  nextEdges: ScenarioFlowEdge[]
): boolean {
  if (currentEdges.length !== nextEdges.length) return true;

  const currentById = new Map(currentEdges.map(edge => [edge.id, edge]));
  return nextEdges.some(nextEdge => {
    const currentEdge = currentById.get(nextEdge.id);
    return (
      !currentEdge ||
      currentEdge.source !== nextEdge.source ||
      currentEdge.target !== nextEdge.target ||
      currentEdge.sourceHandle !== nextEdge.sourceHandle ||
      currentEdge.targetHandle !== nextEdge.targetHandle
    );
  });
}

function haveSameSourceHandleOwnership(
  currentNode: ScenarioFlowNode,
  nextNode: ScenarioFlowNode
): boolean {
  const currentHandles = new Set(resolveAvailableSourceHandleIds(currentNode));
  const nextHandles = new Set(resolveAvailableSourceHandleIds(nextNode));
  return (
    currentHandles.size === nextHandles.size &&
    [...currentHandles].every(handleId => nextHandles.has(handleId))
  );
}

function removeEdgesOutsideSourceHandleOwnership(params: {
  actionNodeId: string;
  actionNode: ScenarioFlowNode;
  edges: ScenarioFlowEdge[];
}): ScenarioFlowEdge[] {
  const ownedHandles = new Set(
    resolveAvailableSourceHandleIds(params.actionNode)
  );
  return params.edges.filter(
    edge =>
      edge.source !== params.actionNodeId ||
      (typeof edge.sourceHandle === "string" &&
        ownedHandles.has(edge.sourceHandle))
  );
}

export function syncBranchNodes(params: {
  actionNodeId: string;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  descriptor: BranchDescriptor;
}): BranchSyncResult {
  const { actionNodeId, nodes, edges, descriptor } = params;
  const emptyResult: BranchSyncResult = {
    nodes,
    edges,
    addedNodeIds: [],
    removedNodeIds: [],
    updatedNodeIds: [],
  };

  const actionNode = nodes.find(n => n.id === actionNodeId);
  if (!actionNode) return emptyResult;

  const actionData = actionNode.data as ScenarioNodeData;
  if (actionData.kind !== "action") return emptyResult;

  const branchOptions = descriptor.extractOptions(actionData, actionNodeId);
  const branchIdSet = new Set(branchOptions.map(o => o.id));
  const nodesById = new Map(nodes.map(node => [node.id, node] as const));

  // Find existing outgoing edges from this action node
  const outgoingEdges = edges.filter(
    edge =>
      edge.source === actionNodeId &&
      isBranchSourceHandle(descriptor, edge.sourceHandle)
  );

  // Map existing branch nodes by their branch identifier
  const existingById = new Map<string, ScenarioFlowNode>();
  const orphanedNodeIds: string[] = [];

  for (const edge of outgoingEdges) {
    const targetNode = nodesById.get(edge.target);
    if (!targetNode) continue;
    const targetData = targetNode.data as ScenarioNodeData;
    const branchId = resolveBranchOptionIdForEdge({
      descriptor,
      branchOptions,
      sourceHandleId: edge.sourceHandle,
      targetNodeData: targetData,
    });
    if (!branchId) {
      if (
        descriptor === FLOW_BRANCH_DESCRIPTOR &&
        hasFlowBranchBindingData(targetData)
      ) {
        orphanedNodeIds.push(targetNode.id);
      }
      continue;
    }

    if (branchIdSet.has(branchId)) {
      existingById.set(branchId, targetNode);
    } else {
      orphanedNodeIds.push(targetNode.id);
    }
  }

  const missingOptions = branchOptions.filter(opt => !existingById.has(opt.id));
  const branchOptionById = new Map(branchOptions.map(opt => [opt.id, opt]));
  const updatesByNodeId = new Map<string, Partial<ScenarioNodeData>>();

  for (const [branchId, existingNode] of existingById.entries()) {
    const option = branchOptionById.get(branchId);
    if (!option) continue;

    const patch = descriptor.makeBranchNodeData(option);
    const currentData = existingNode.data as ScenarioNodeData;
    if (hasNodeDataPatchChanges(currentData, patch)) {
      updatesByNodeId.set(existingNode.id, patch);
    }
  }

  const replyItem = SCENARIO_NODE_PALETTE.find(
    p => p.id === "action-reply"
  ) ?? {
    id: "action-reply",
    kind: "action" as const,
    defaults: {
      actionType: "reply" as const,
      actionReplyMode: "fixed" as const,
    },
  };

  const addedNodeIds: string[] = [];
  const newNodes: ScenarioFlowNode[] = [];
  const newEdges: ScenarioFlowEdge[] = [];

  const actionX = actionNode.position.x;
  const actionY = actionNode.position.y;
  const existingBranchCount = existingById.size;

  if (descriptor.autoCreateMissingNodes !== false) {
    for (let i = 0; i < missingOptions.length; i++) {
      const opt = missingOptions[i];
      const offsetIndex = existingBranchCount + i;
      const newNode = createNodeFromPaletteItem(replyItem, {
        x: actionX + 380,
        y: actionY + 120 + offsetIndex * 180,
      });

      const branchNode: ScenarioFlowNode = {
        ...newNode,
        data: {
          ...newNode.data,
          ...descriptor.makeBranchNodeData(opt),
        },
      };

      newNodes.push(branchNode);
      addedNodeIds.push(branchNode.id);

      newEdges.push({
        id: createScenarioGraphId("edge"),
        source: actionNodeId,
        sourceHandle: descriptor.outputHandleId,
        target: branchNode.id,
        targetHandle: SCENARIO_HANDLE_RULES.action.inputHandleId!,
        ...DEFAULT_SCENARIO_EDGE_STYLE,
      });
    }
  }

  // Build result: remove orphaned, add new
  const shouldRemoveOrphanedNodes =
    descriptor.autoRemoveOrphanedNodes === true ||
    (descriptor.autoRemoveOrphanedNodes === "whenNoOptions" &&
      branchOptions.length === 0);

  // We want to preserve persistent nodes (nodes with user configuration) instead of deleting them.
  // Instead of deleting them, we keep them on the canvas and clear their branch binding data.
  const removableOrphanedNodeIds: string[] = [];

  for (const nodeId of orphanedNodeIds) {
    const node = nodesById.get(nodeId);
    if (!node) continue;

    const nodeData = node.data as ScenarioNodeData;
    const isPersistent =
      node.type === "actionNode" ||
      node.type === "triggerNode" ||
      node.type === "contextNode" ||
      node.type === "logicNode" ||
      node.type === "scenarioNode" ||
      nodeData?.kind === "action" ||
      nodeData?.kind === "logic" ||
      nodeData?.kind === "trigger" ||
      nodeData?.kind === "context" ||
      nodeData?.kind === "scenario_link";

    if (isPersistent) {
      // Ensure we clear branch binding data for protected orphaned nodes
      const patch = clearBranchBindingData();
      if (hasNodeDataPatchChanges(nodeData, patch)) {
        updatesByNodeId.set(nodeId, patch);
      }
    } else {
      if (shouldRemoveOrphanedNodes) {
        removableOrphanedNodeIds.push(nodeId);
      }
    }
  }

  const orphanedSet = new Set(removableOrphanedNodeIds);
  const orphanedNodeIdsSet = new Set(orphanedNodeIds);

  const resultNodes = [
    ...nodes
      .filter(n => !orphanedSet.has(n.id))
      .map(node => {
        const patch = updatesByNodeId.get(node.id);
        if (!patch) return node;
        return {
          ...node,
          data: {
            ...(node.data as ScenarioNodeData),
            ...patch,
          },
        };
      }),
    ...newNodes,
  ];
  const resultEdges = [
    ...edges.filter(
      e =>
        !orphanedSet.has(e.target) &&
        !orphanedSet.has(e.source) &&
        // Drop only this descriptor's stale branch edges; edges from other
        // handles (default output, other branch types) must stay attached.
        !(
          e.source === actionNodeId &&
          orphanedNodeIdsSet.has(e.target) &&
          isBranchSourceHandle(descriptor, e.sourceHandle)
        )
    ),
    ...newEdges,
  ];

  return {
    nodes: resultNodes,
    edges: resultEdges,
    addedNodeIds,
    removedNodeIds: removableOrphanedNodeIds,
    updatedNodeIds: [...updatesByNodeId.keys()],
  };
}

/** Drops the delays of routes whose handle the action no longer offers. */
function retainOwnedBranchDelays(
  actionNode: ScenarioFlowNode
): ScenarioFlowNode {
  const nodeData = actionNode.data as ScenarioNodeData;
  const outcomes = nodeData.actionOutcomes;
  if (
    !outcomes?.branchDelays ||
    normalizeScenarioActionOutcomes(outcomes).status !== "supported"
  ) {
    return actionNode;
  }

  const retained = retainScenarioActionBranchDelays(
    outcomes,
    resolveAvailableSourceHandleIds(actionNode)
  );
  if ((retained.branchDelays?.length ?? 0) === outcomes.branchDelays.length) {
    return actionNode;
  }
  return { ...actionNode, data: { ...nodeData, actionOutcomes: retained } };
}

/**
 * When the action stops offering some handles, drops their edges and their
 * delays.
 */
function reconcileSourceHandleOwnership(params: {
  actionNodeId: string;
  previousActionNode: ScenarioFlowNode;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
}): {
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  changed: boolean;
  edgesChanged: boolean;
} {
  const { nodes, edges } = params;
  const actionNode = nodes.find(node => node.id === params.actionNodeId);
  if (
    !actionNode ||
    haveSameSourceHandleOwnership(params.previousActionNode, actionNode)
  ) {
    return { nodes, edges, changed: false, edgesChanged: false };
  }

  const reconciledEdges = removeEdgesOutsideSourceHandleOwnership({
    actionNodeId: params.actionNodeId,
    actionNode,
    edges,
  });
  const edgesChanged = hasStructuralEdgeChanges(edges, reconciledEdges);
  const retainedActionNode = retainOwnedBranchDelays(actionNode);
  const nodesChanged = retainedActionNode !== actionNode;
  return {
    nodes: nodesChanged
      ? nodes.map(node => (node === actionNode ? retainedActionNode : node))
      : nodes,
    edges: edgesChanged ? reconciledEdges : edges,
    changed: edgesChanged || nodesChanged,
    edgesChanged,
  };
}

/** The action's option routes among these edges, labelled by its options. */
function describeBranchRoutes(params: {
  actionNode: ScenarioFlowNode;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  descriptors: BranchDescriptor[];
}): BranchRoute[] {
  const { actionNode } = params;
  const actionEdges = params.edges.filter(
    edge => edge.source === actionNode.id
  );
  if (actionEdges.length === 0) return [];
  const nodesById = new Map(params.nodes.map(node => [node.id, node]));
  const optionsByDescriptor = new Map<
    BranchDescriptor,
    GenericBranchOption[]
  >();
  const optionsOf = (descriptor: BranchDescriptor) => {
    const cached = optionsByDescriptor.get(descriptor);
    if (cached) return cached;
    const options = descriptor.extractOptions(
      actionNode.data as ScenarioNodeData,
      actionNode.id
    );
    optionsByDescriptor.set(descriptor, options);
    return options;
  };
  return actionEdges.flatMap(edge => {
    const descriptor = params.descriptors.find(item =>
      isBranchSourceHandle(item, edge.sourceHandle)
    );
    const target = nodesById.get(edge.target);
    if (!descriptor || !target) return [];
    const branchOptions = optionsOf(descriptor);
    const branchId = resolveBranchOptionIdForEdge({
      descriptor,
      branchOptions,
      sourceHandleId: edge.sourceHandle,
      targetNodeData: target.data as ScenarioNodeData,
    });
    const option = branchOptions.find(item => item.id === branchId);
    return option
      ? [
          {
            descriptorKind: descriptor.kind,
            label: option.label,
            targetNodeId: edge.target,
          },
        ]
      : [];
  });
}

/**
 * Routes from the action's options, and its "Form submitted" route, that the
 * transition removed.
 */
function collectRemovedBranchRoutes(params: {
  actionNode: ScenarioFlowNode;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  nextEdges: ScenarioFlowEdge[];
  descriptors: BranchDescriptor[];
}): BranchRoute[] {
  const nextEdgeIds = new Set(params.nextEdges.map(edge => edge.id));
  const removedEdges = params.edges.filter(edge => !nextEdgeIds.has(edge.id));
  return [
    ...describeBranchRoutes({
      actionNode: params.actionNode,
      nodes: params.nodes,
      edges: removedEdges,
      descriptors: params.descriptors,
    }),
    ...removedEdges.flatMap(edge =>
      edge.source === params.actionNode.id &&
      isWhatsAppTemplateFormSubmittedSourceHandleId(edge.sourceHandle)
        ? [
            {
              descriptorKind:
                WHATSAPP_TEMPLATE_FORM_SUBMITTED_OUTPUT_TRANSITION.kind,
              label: "",
              targetNodeId: edge.target,
            },
          ]
        : []
    ),
  ];
}

/**
 * Routes from the action's options that a transition kept, labelled by the
 * options the action offers after it.
 */
export function collectKeptBranchRoutes(params: {
  actionNodeId: string;
  previousEdges: ScenarioFlowEdge[];
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  descriptors: BranchDescriptor[];
}): BranchRoute[] {
  const actionNode = params.nodes.find(node => node.id === params.actionNodeId);
  if (!actionNode) return [];
  const previousEdgeIds = new Set(params.previousEdges.map(edge => edge.id));
  return describeBranchRoutes({
    actionNode,
    nodes: params.nodes,
    edges: params.edges.filter(edge => previousEdgeIds.has(edge.id)),
    descriptors: params.descriptors,
  });
}

export function transitionBranchNodes(params: {
  actionNodeId: string;
  nodes: ScenarioFlowNode[];
  edges: ScenarioFlowEdge[];
  descriptors: BranchDescriptor[];
  actionNodePatch?: Partial<ScenarioNodeData>;
}): BranchTransitionResult {
  const { actionNodeId, nodes, edges, descriptors, actionNodePatch } = params;
  const actionNode = nodes.find(node => node.id === actionNodeId);
  if (!actionNode || (actionNode.data as ScenarioNodeData).kind !== "action") {
    return {
      nodes,
      edges,
      changed: false,
      dirty: false,
      structuralHistoryRequired: false,
      removedRoutes: [],
    };
  }

  const shouldPatchActionNode = Boolean(
    actionNodePatch &&
      hasNodeDataPatchChanges(
        actionNode.data as ScenarioNodeData,
        actionNodePatch
      )
  );

  let nextNodes = shouldPatchActionNode
    ? nodes.map(node =>
        node.id === actionNodeId
          ? {
              ...node,
              data: {
                ...(node.data as ScenarioNodeData),
                ...actionNodePatch,
              },
            }
          : node
      )
    : nodes;
  let nextEdges = edges;
  let changed = shouldPatchActionNode;
  let structuralHistoryRequired = false;

  for (const descriptor of descriptors) {
    const result = syncBranchNodes({
      actionNodeId,
      nodes: nextNodes,
      edges: nextEdges,
      descriptor,
    });
    const descriptorHasStructuralChanges =
      result.addedNodeIds.length > 0 ||
      result.removedNodeIds.length > 0 ||
      hasStructuralEdgeChanges(nextEdges, result.edges);
    const descriptorHasChanges =
      descriptorHasStructuralChanges || result.updatedNodeIds.length > 0;

    if (!descriptorHasChanges) continue;

    nextNodes = result.nodes;
    nextEdges = result.edges;
    changed = true;
    structuralHistoryRequired ||= descriptorHasStructuralChanges;
  }

  const ownership = reconcileSourceHandleOwnership({
    actionNodeId,
    previousActionNode: actionNode,
    nodes: nextNodes,
    edges: nextEdges,
  });
  changed ||= ownership.changed;
  structuralHistoryRequired ||= ownership.edgesChanged;

  return {
    nodes: ownership.nodes,
    edges: ownership.edges,
    changed,
    dirty: changed,
    structuralHistoryRequired,
    removedRoutes: collectRemovedBranchRoutes({
      actionNode,
      nodes,
      edges,
      nextEdges: ownership.edges,
      descriptors,
    }),
  };
}
