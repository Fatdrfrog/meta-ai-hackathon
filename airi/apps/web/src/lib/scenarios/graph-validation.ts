import {
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
  isBulkCampaignRootNode,
  ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  isTelegramBranchSourceHandleId,
  normalizeWhatsAppFlowProviderReference,
  normalizeWhatsAppQrEntryPointId,
  normalizeGenerativeAIActionConfig,
  normalizeGenerativeAIActionDraft,
  listScenarioPromptInputReferences,
  parseTelegramBranchSourceHandleId,
  resolveSendableWhatsAppFlowProviderId,
  resolveWhatsAppFlowSourceBinding,
  validateScenarioWhatsAppServiceMessage,
  validateScenarioWhatsAppTemplateBindings,
  buildScenarioPickedOptionSourcesByNodeId,
  buildScenarioPromptInputsByNodeId,
  getScenarioActionOutcomeVirtualNodeId,
  isPostActionConditionNodeData,
  isWhatsAppTemplateFormSubmittedSourceHandleId,
  normalizeScenarioActionOutcomes,
  readScenarioActionPromptInputAsk,
  type GenerativeAIPickedOptionIssue,
  type ScenarioRoutingCompilerDiagnosticCode,
} from "@icecore/scenario-contracts";
import { isRecord, readStringOrEmpty } from "@icecore/shared/lib/value-utils";
import { parseBirthdayCampaignScheduleConfig } from "@/lib/campaign/campaign-birthday-schedule";
import { getBlockingScenarioRoutingDiagnosticCode } from "@icecore/scenario-contracts";
import { resolveScenarioActionTypeFromNodeData } from "@icecore/airi-runtime/scenario-action-semantics";
import { extractInstagramBranchOptions } from "@/lib/scenarios/instagram-reply-config";
import { extractTelegramBranchOptions } from "@/lib/scenarios/telegram-quick-replies";
import type {
  ScenarioGraphNode,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { getCompiledScenarioFlowStructureIssue } from "@/lib/scenarios/flow-structure-validation";
import {
  compileScenarioGraph,
  type ScenarioRuntimeEdge,
} from "@icecore/airi-runtime/scenario-graph";
import {
  normalizeActionReplyChannelForActionNode,
  normalizeReplyModeForActionNode,
} from "@/lib/scenarios/normalization";
import {
  createWhatsAppFlowEditableContentDigest,
  normalizeManagedWhatsAppFlowProvisioningProjection,
} from "@/lib/scenarios/whatsapp-flow-projection";
import { resolveScenarioWhatsAppInteractiveFlowTarget } from "@/lib/scenarios/whatsapp-service-message";
import { getSingleFlowIdFromWhatsAppTemplateComponents } from "@/lib/scenarios/whatsapp-template-flow";
import { whatsappTemplateOffersFormSubmittedRoute } from "@/lib/scenarios/transition-registry";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import { normalizeScenarioTriggerConfig } from "@/lib/scenarios/trigger-utils";
import { isProbablyEmail, normalizeEmail } from "@/lib/customers/shared";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { validateBehaviorTriggers } from "./behavior-graph";
import {
  listDuplicateScenarioFormAnswersKeyNodeIds,
  listUnavailableScenarioFormAnswerTokensByNodeId,
} from "./scenario-form-answer-checks";

export type ScenarioGraphValidationErrorKey =
  | "birthdayScheduleInvalid"
  | "birthdayChannelUnsupported"
  | "birthdayActionRequired"
  | "birthdayTelegramSourceRequired"
  | "birthdayRecipientsRequired"
  | "businessEventIntegrationPending"
  | "behaviorConfigInvalid"
  | "behaviorTemplateRequired"
  | "messageTriggerIncomplete"
  | "oneTriggerRequired"
  | "onlyOneTriggerAllowed"
  | "singleFlowRequired"
  | "telegramBranchIncomplete"
  | "instagramBranchIncomplete"
  | "ambiguousNextActionFork"
  | "bulkPrimaryActionAlreadyConnected"
  | "bulkPrimaryActionRequiresAction"
  | "generativeAIUnsupportedInBulk"
  | "actionTypeInvalid"
  | "handoffNotificationInvalid"
  | "generativeAIConfigInvalid"
  | "generativeAIPromptInputUnavailable"
  | "generativeAIPickedOptionUnavailable"
  | "generativeAIPickedCardImageInvalid"
  | "formAnswerUnavailable"
  | "formAnswersKeyDuplicate"
  | "promptInputChoiceWaitUnsupported"
  | "whatsappServiceMessageInvalid"
  | "whatsappTemplateRequired"
  | "whatsappTemplateBindingsInvalid"
  | "whatsappTemplateBindingsRequireConversation"
  | "whatsappTemplateFormRouteUnavailable"
  | "whatsappTemplateFormRouteConditionTarget"
  | "whatsappTemplateFormRouteInBulk"
  | "whatsappQrEntryPointIncomplete"
  | "whatsappQrEntryPointDuplicate"
  | "stackedInteractiveActions"
  | ScenarioRoutingCompilerDiagnosticCode;

/**
 * A connectivity failure and the blocks that cause it. The editor uses these
 * node ids to select and centre the offending block instead of hunting for it.
 */
type ScenarioGraphConnectivityAnalysis = {
  code: ScenarioGraphValidationErrorKey;
  nodeIds: string[];
};

export type ScenarioGraphNodeLike = ScenarioGraphNode;

export type ScenarioGraphEdgeLike = {
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
};

export type WhatsAppQrEntryPointReadinessEvidence = {
  entryPointId: string;
  ready: boolean;
  currentCodeId?: string;
  currentCodeVersion?: number;
};

export type ScenarioGraphValidationOptions = {
  mode?: "draft" | "graph" | "runnable";
  /** Legacy bulk-campaign graphs may source birthdays from existing profiles. */
  scenarioMode?: "conversation" | "bulk_campaign";
  completedWhatsAppFlowProvisioningOperations?: readonly CompletedWhatsAppFlowProvisioningOperationEvidence[];
  currentWhatsAppSourceWabaBindings?: Readonly<Record<string, string>>;
  whatsappQrEntryPointReadiness?: Readonly<
    Record<string, WhatsAppQrEntryPointReadinessEvidence>
  >;
};

export type CompletedWhatsAppFlowProvisioningOperationEvidence = {
  operationId: string;
  nodeId: string;
  sourceId: string;
  wabaId: string;
  contentDigest: string;
  providerFlowId?: string;
  status: "COMPLETED";
  stage: "COMPLETED";
};

function areAllBranchOptionsConnected(params: {
  branchOptionIds: string[];
  connectedBranchIds: string[];
}): boolean {
  const connectedSet = new Set(params.connectedBranchIds);
  return params.branchOptionIds.every(optionId => connectedSet.has(optionId));
}

type BranchPayloadField = "telegramBranchPayload" | "instagramBranchPayload";

function collectConnectedBranchIds(params: {
  edges: ScenarioGraphEdgeLike[];
  nodeId: string;
  nodesById: Map<string, ScenarioGraphNodeLike>;
  branchOptionIds: string[];
  isBranchSourceEdge: (edge: ScenarioGraphEdgeLike) => boolean;
  getHandleBranchId?: (edge: ScenarioGraphEdgeLike) => string | null;
  targetBranchPayloadField: BranchPayloadField;
}): string[] {
  return params.edges
    .filter(
      edge => edge.source === params.nodeId && params.isBranchSourceEdge(edge)
    )
    .flatMap(edge => {
      const handleBranchId = params.getHandleBranchId?.(edge);
      if (handleBranchId && params.branchOptionIds.includes(handleBranchId)) {
        return [handleBranchId];
      }
      if (!edge.target) return [];
      const targetNode = params.nodesById.get(edge.target);
      if (!targetNode) return [];
      const targetBranchPayload =
        targetNode.data[params.targetBranchPayloadField];
      const branchId =
        typeof targetBranchPayload === "string"
          ? targetBranchPayload.trim()
          : "";
      return branchId && params.branchOptionIds.includes(branchId)
        ? [branchId]
        : [];
    });
}

type ReplyBranchValidationDescriptor = {
  incompleteErrorKey: ScenarioGraphValidationErrorKey;
  isBranchingActionNode: (nodeData: ScenarioNodeData) => boolean;
  getBranchOptionIds: (node: ScenarioGraphNodeLike) => string[];
  isBranchSourceEdge: (edge: ScenarioGraphEdgeLike) => boolean;
  getHandleBranchId?: (edge: ScenarioGraphEdgeLike) => string | null;
  targetBranchPayloadField: BranchPayloadField;
};

function validateReplyBranches(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[],
  descriptor: ReplyBranchValidationDescriptor
): ScenarioGraphValidationErrorKey | null {
  const nodesById = new Map(nodes.map(node => [node.id, node]));

  for (const node of nodes) {
    if (!descriptor.isBranchingActionNode(node.data)) continue;
    const branchOptionIds = descriptor.getBranchOptionIds(node);
    if (branchOptionIds.length === 0) continue;

    const connectedBranchIds = collectConnectedBranchIds({
      edges,
      nodeId: node.id,
      nodesById,
      branchOptionIds,
      isBranchSourceEdge: descriptor.isBranchSourceEdge,
      getHandleBranchId: descriptor.getHandleBranchId,
      targetBranchPayloadField: descriptor.targetBranchPayloadField,
    });

    if (
      !areAllBranchOptionsConnected({ branchOptionIds, connectedBranchIds })
    ) {
      return descriptor.incompleteErrorKey;
    }
  }

  return null;
}

function validateTelegramBranches(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): ScenarioGraphValidationErrorKey | null {
  return validateReplyBranches(nodes, edges, {
    incompleteErrorKey: "telegramBranchIncomplete",
    isBranchingActionNode: nodeData => {
      if (nodeData.kind !== "action") return false;
      if (resolveScenarioActionTypeFromNodeData(nodeData) !== "reply") {
        return false;
      }
      if (normalizeActionReplyChannelForActionNode(nodeData) !== "telegram") {
        return false;
      }
      const replyMode = normalizeReplyModeForActionNode(nodeData);
      return replyMode === "fixed" || replyMode === "ai";
    },
    getBranchOptionIds: node =>
      extractTelegramBranchOptions(node.data.actionTelegramQuickReplies).map(
        option => option.payload
      ),
    isBranchSourceEdge: edge =>
      isTelegramBranchSourceHandleId(edge.sourceHandle),
    getHandleBranchId: edge =>
      parseTelegramBranchSourceHandleId(edge.sourceHandle)?.payload ?? null,
    targetBranchPayloadField: "telegramBranchPayload",
  });
}

function validateInstagramBranches(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): ScenarioGraphValidationErrorKey | null {
  return validateReplyBranches(nodes, edges, {
    incompleteErrorKey: "instagramBranchIncomplete",
    isBranchingActionNode: nodeData =>
      nodeData.kind === "action" &&
      resolveScenarioActionTypeFromNodeData(nodeData) === "reply" &&
      nodeData.actionReplyChannel === "instagram",
    getBranchOptionIds: node =>
      extractInstagramBranchOptions(node.data.actionInstagramConfig).map(
        option => option.id
      ),
    isBranchSourceEdge: edge =>
      edge.sourceHandle === ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
    targetBranchPayloadField: "instagramBranchPayload",
  });
}

function analyzeScenarioGraphConnectivity(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): ScenarioGraphConnectivityAnalysis | null {
  if (nodes.length === 0) {
    return { code: "oneTriggerRequired", nodeIds: [] };
  }

  const triggerNodeIds = nodes
    .filter(node => node.data.kind === "trigger")
    .map(node => node.id);
  const bulkRootNodeIds = nodes
    .filter(node => node.data.kind === "bulk")
    .map(node => node.id);

  if (triggerNodeIds.length === 0 && bulkRootNodeIds.length === 0) {
    return { code: "oneTriggerRequired", nodeIds: [] };
  }

  if (triggerNodeIds.length === 0 && bulkRootNodeIds.length > 1) {
    return { code: "onlyOneTriggerAllowed", nodeIds: bulkRootNodeIds };
  }

  const nodeIds = new Set(nodes.map(node => node.id));
  const adjacency = new Map<string, string[]>();
  const nodesById = new Map(nodes.map(node => [node.id, node]));

  for (const edge of edges) {
    if (!edge.source || !edge.target) continue;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const next = adjacency.get(edge.source) ?? [];
    next.push(edge.target);
    adjacency.set(edge.source, next);
  }

  const rootNodeIds =
    triggerNodeIds.length > 0 ? triggerNodeIds : bulkRootNodeIds;
  const reachable = new Set<string>();
  const queue = [...rootNodeIds];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    const next = adjacency.get(nodeId) ?? [];
    next.forEach(nextId => {
      if (!reachable.has(nextId)) {
        queue.push(nextId);
      }
    });
  }

  if (reachable.size !== nodes.length) {
    return {
      code: "singleFlowRequired",
      nodeIds: nodes
        .filter(node => !reachable.has(node.id))
        .map(node => node.id),
    };
  }

  for (const triggerNodeId of triggerNodeIds) {
    const triggerReachable = new Set<string>();
    const triggerQueue = [triggerNodeId];

    while (triggerQueue.length > 0) {
      const nodeId = triggerQueue.shift();
      if (!nodeId || triggerReachable.has(nodeId)) continue;
      triggerReachable.add(nodeId);
      const next = adjacency.get(nodeId) ?? [];
      next.forEach(nextId => {
        if (!triggerReachable.has(nextId)) {
          triggerQueue.push(nextId);
        }
      });
    }

    const hasReachableAction = Array.from(triggerReachable).some(nodeId => {
      const node = nodesById.get(nodeId);
      return node?.data.kind === "action";
    });
    if (!hasReachableAction) {
      return { code: "singleFlowRequired", nodeIds: [triggerNodeId] };
    }
  }

  return null;
}

export function validateScenarioGraphConnectivity(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): ScenarioGraphValidationErrorKey | null {
  return analyzeScenarioGraphConnectivity(nodes, edges)?.code ?? null;
}

/**
 * The blocks a connectivity failure named, when the given code is one it owns.
 * Other validation codes have no node to point at, so this returns an empty
 * list and the editor falls back to a message-only toast.
 */
export function resolveScenarioGraphBlockingNodeIds(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[],
  code: ScenarioGraphValidationErrorKey
): string[] {
  if (code.startsWith("birthday")) {
    return nodes
      .filter(node => birthdayCampaignRootIssue(node, nodes, edges) === code)
      .map(node => node.id);
  }
  if (code === "businessEventIntegrationPending") {
    return nodes
      .filter(
        node =>
          node.data.kind === "trigger" &&
          node.data.triggerConfig?.entryPointType === "business_event"
      )
      .map(node => node.id);
  }
  if (code === "whatsappTemplateBindingsInvalid") {
    return templateBindingBlockingNodeIds(nodes, edges);
  }
  if (code === "generativeAIPromptInputUnavailable") {
    return generativePromptInputBlockingNodeIds(nodes, edges);
  }
  if (code === "generativeAIPickedOptionUnavailable") {
    return generativePickedOptionBlockingNodeIds(
      nodes,
      edges,
      "picked_option_missing"
    );
  }
  if (code === "generativeAIPickedCardImageInvalid") {
    return generativePickedOptionBlockingNodeIds(
      nodes,
      edges,
      "picked_card_image_invalid"
    );
  }
  const formAnswerBlocking = FORM_ANSWER_BLOCKING_NODE_IDS[code];
  if (formAnswerBlocking) return formAnswerBlocking(nodes, edges);
  if (code === "promptInputChoiceWaitUnsupported") {
    return promptInputWaitBlockingNodeIds(
      nodes,
      compileValidationGraph(nodes, edges)
    );
  }
  if (
    code === "whatsappTemplateFormRouteUnavailable" ||
    code === "whatsappTemplateFormRouteConditionTarget"
  ) {
    return whatsappTemplateFormRouteBlockingNodeIds(nodes, edges, code);
  }
  const analysis = analyzeScenarioGraphConnectivity(nodes, edges);
  return analysis && analysis.code === code ? analysis.nodeIds : [];
}

function toScopeEdges(edges: ScenarioGraphEdgeLike[]) {
  return edges.flatMap(edge =>
    edge.source && edge.target
      ? [
          {
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle,
          },
        ]
      : []
  );
}

/** Answer keys every path to each node has collected (the editor's scope). */
function readAvailablePromptInputKeysByNodeId(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): (nodeId: string) => string[] {
  const scopedInputs = buildScenarioPromptInputsByNodeId({
    nodes,
    edges: toScopeEdges(edges),
  });
  return nodeId => (scopedInputs.get(nodeId) ?? []).map(field => field.key);
}

function templateBindingBlockingNodeIds(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): string[] {
  const candidates = nodes.filter(
    node =>
      node.data.kind === "action" &&
      resolveScenarioActionTypeFromNodeData(node.data) ===
        "whatsapp_template" &&
      node.data.actionWhatsAppTemplateBindings !== undefined
  );
  if (candidates.length === 0) return [];
  const availableKeys = readAvailablePromptInputKeysByNodeId(nodes, edges);
  return candidates
    .filter(
      node =>
        validateScenarioWhatsAppTemplateBindings({
          components: node.data.actionWhatsAppTemplateComponents,
          bindings: node.data.actionWhatsAppTemplateBindings,
          availablePromptInputKeys: availableKeys(node.id),
        }).length > 0
    )
    .map(node => node.id);
}

/** Generative prompts may reference only answers collected before them. */
function generativePromptInputBlockingNodeIds(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): string[] {
  const candidates = nodes.flatMap(node => {
    if (
      node.data.kind !== "action" ||
      resolveScenarioActionTypeFromNodeData(node.data) !== "generative_ai"
    ) {
      return [];
    }
    const prompt =
      normalizeGenerativeAIActionDraft(node.data.actionGenerativeAIConfig)
        ?.prompt ?? "";
    const keys = listScenarioPromptInputReferences(prompt);
    return keys.length > 0 ? [{ id: node.id, keys }] : [];
  });
  if (candidates.length === 0) return [];
  const availableKeys = readAvailablePromptInputKeysByNodeId(nodes, edges);
  return candidates
    .filter(candidate => {
      const available = new Set(availableKeys(candidate.id));
      return candidate.keys.some(key => !available.has(key));
    })
    .map(candidate => candidate.id);
}

/**
 * Generations whose picked option has the given issue: the named buttons, list
 * or carousel message is not passed on every path (missing), or the card image
 * is taken while a card has no usable image (invalid card image).
 */
function generativePickedOptionBlockingNodeIds(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[],
  issue: GenerativeAIPickedOptionIssue
): string[] {
  const candidates = nodes.flatMap(node => {
    if (
      node.data.kind !== "action" ||
      resolveScenarioActionTypeFromNodeData(node.data) !== "generative_ai"
    ) {
      return [];
    }
    const pickedOption = normalizeGenerativeAIActionDraft(
      node.data.actionGenerativeAIConfig
    )?.pickedOption;
    return pickedOption ? [{ id: node.id, pickedOption }] : [];
  });
  if (candidates.length === 0) return [];
  const sourcesByNodeId = buildScenarioPickedOptionSourcesByNodeId({
    nodes,
    edges: toScopeEdges(edges),
  });
  return candidates
    .filter(({ id, pickedOption }) => {
      const source = sourcesByNodeId
        .get(id)
        ?.find(item => item.nodeId === pickedOption.sourceActionNodeId);
      if (!source) return issue === "picked_option_missing";
      return (
        issue === "picked_card_image_invalid" &&
        pickedOption.includeCardImage &&
        !source.cardImagesUsable
      );
    })
    .map(candidate => candidate.id);
}

/**
 * AI prompts that read a form answer no form before them provides, on any
 * path: an image or video prompt or "AI writes" instructions. An answer
 * that only some paths provide is allowed and may be empty.
 */
function formAnswerUnavailableNodeIds(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): string[] {
  return Array.from(
    listUnavailableScenarioFormAnswerTokensByNodeId({
      nodes,
      edges: toScopeEdges(edges),
    }).keys()
  );
}

/** The steps each form answer check names. */
const FORM_ANSWER_BLOCKING_NODE_IDS: Partial<
  Record<
    ScenarioGraphValidationErrorKey,
    (nodes: ScenarioGraphNodeLike[], edges: ScenarioGraphEdgeLike[]) => string[]
  >
> = {
  formAnswerUnavailable: formAnswerUnavailableNodeIds,
  formAnswersKeyDuplicate: nodes =>
    listDuplicateScenarioFormAnswersKeyNodeIds(nodes),
};

/**
 * Answers AI prompts read that the steps before them never give: collected
 * details, picked options and form answers, and form keys two forms share.
 */
function validateScenarioPromptAnswers(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): ScenarioGraphValidationErrorKey | null {
  if (generativePromptInputBlockingNodeIds(nodes, edges).length > 0) {
    return "generativeAIPromptInputUnavailable";
  }
  if (
    generativePickedOptionBlockingNodeIds(nodes, edges, "picked_option_missing")
      .length > 0
  ) {
    return "generativeAIPickedOptionUnavailable";
  }
  if (
    generativePickedOptionBlockingNodeIds(
      nodes,
      edges,
      "picked_card_image_invalid"
    ).length > 0
  ) {
    return "generativeAIPickedCardImageInvalid";
  }
  if (formAnswerUnavailableNodeIds(nodes, edges).length > 0) {
    return "formAnswerUnavailable";
  }
  return listDuplicateScenarioFormAnswersKeyNodeIds(nodes).length > 0
    ? "formAnswersKeyDuplicate"
    : null;
}

/** Whether an action's only wait is its No reply reminder. */
function waitsOnlyForNoReply(node: ScenarioGraphNodeLike, targetId: string) {
  if (
    node.data.kind !== "action" ||
    targetId !== getScenarioActionOutcomeVirtualNodeId(node.id)
  ) {
    return false;
  }
  const outcomes = normalizeScenarioActionOutcomes(node.data.actionOutcomes);
  if (outcomes.status !== "supported") return false;
  // The normalizer keeps only enabled outcomes and non-empty lists.
  const {
    anyReply,
    noReply,
    answerMatches,
    paymentDetected,
    branchDelays,
    locationRoutes,
  } = outcomes.value;
  return Boolean(
    noReply &&
      !anyReply &&
      !answerMatches &&
      !paymentDetected &&
      !branchDelays &&
      !locationRoutes
  );
}

/**
 * A message that asks for details waits for the customer's words itself, and
 * a buttons, list or carousel ask also for the tap. Only its No reply reminder
 * may wait beside it. The "Choice" error code also covers text asks.
 */
function promptInputWaitBlockingNodeIds(
  nodes: ScenarioGraphNodeLike[],
  compiled: ReturnType<typeof compileScenarioGraph>
): string[] {
  return nodes
    .filter(
      node =>
        node.data.kind === "action" &&
        readScenarioActionPromptInputAsk(node.data) !== null &&
        (compiled.adjacency.get(node.id) ?? []).some(
          targetId =>
            isPostActionConditionNodeData(
              compiled.nodesById.get(targetId)?.data
            ) && !waitsOnlyForNoReply(node, targetId)
        )
    )
    .map(node => node.id);
}

function compileValidationGraph(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
) {
  return compileScenarioGraph(
    nodes.map(node => ({ id: node.id, data: node.data })),
    edges.map(
      (edge): ScenarioRuntimeEdge => ({
        source: edge.source ?? undefined,
        target: edge.target ?? undefined,
        sourceHandle: edge.sourceHandle ?? null,
      })
    )
  );
}

type WhatsAppTemplateFormRouteErrorKey = Extract<
  ScenarioGraphValidationErrorKey,
  | "whatsappTemplateFormRouteUnavailable"
  | "whatsappTemplateFormRouteConditionTarget"
>;

/**
 * Why a template's "Form submitted" edge can't run as drawn, or null when it
 * can or the edge is another route. The runtime walks the edge of a step that
 * doesn't offer the route like any other, sending the next step right after
 * the template. A "Reply or no reply" block after a step starts its wait at
 * the send, whichever route leads to it.
 */
export function resolveWhatsAppTemplateFormRouteIssue(params: {
  sourceHandle: string | null | undefined;
  sourceData: ScenarioNodeData;
  targetData: ScenarioNodeData;
}): WhatsAppTemplateFormRouteErrorKey | null {
  if (!isWhatsAppTemplateFormSubmittedSourceHandleId(params.sourceHandle)) {
    return null;
  }
  if (!whatsappTemplateOffersFormSubmittedRoute(params.sourceData)) {
    return "whatsappTemplateFormRouteUnavailable";
  }
  return isPostActionConditionNodeData(params.targetData)
    ? "whatsappTemplateFormRouteConditionTarget"
    : null;
}

/** The "Form submitted" edges that can't run, with the steps they leave. */
function listWhatsAppTemplateFormRouteIssues(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): Array<{ code: WhatsAppTemplateFormRouteErrorKey; nodeId: string }> {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  return edges.flatMap(edge => {
    const source = edge.source ? nodesById.get(edge.source) : undefined;
    const target = edge.target ? nodesById.get(edge.target) : undefined;
    // A route whose step was deleted leads nowhere.
    if (!source || !target) return [];
    const code = resolveWhatsAppTemplateFormRouteIssue({
      sourceHandle: edge.sourceHandle,
      sourceData: source.data,
      targetData: target.data,
    });
    return code ? [{ code, nodeId: source.id }] : [];
  });
}

function validateWhatsAppTemplateFormRoutes(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): ScenarioGraphValidationErrorKey | null {
  return listWhatsAppTemplateFormRouteIssues(nodes, edges)[0]?.code ?? null;
}

function whatsappTemplateFormRouteBlockingNodeIds(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[],
  code: WhatsAppTemplateFormRouteErrorKey
): string[] {
  return Array.from(
    new Set(
      listWhatsAppTemplateFormRouteIssues(nodes, edges)
        .filter(issue => issue.code === code)
        .map(issue => issue.nodeId)
    )
  );
}

export function validateScenarioGraphBranches(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[]
): ScenarioGraphValidationErrorKey | null {
  return (
    validateTelegramBranches(nodes, edges) ||
    validateInstagramBranches(nodes, edges)
  );
}

export function validateScenarioGraphActionPayloads(
  nodes: ScenarioGraphNodeLike[]
): ScenarioGraphValidationErrorKey | null {
  for (const node of nodes) {
    if (node.data.kind !== "action") continue;
    const actionType = resolveScenarioActionTypeFromNodeData(node.data);
    if (!actionType) {
      return "actionTypeInvalid";
    }
    if (actionType === "assign_human") {
      const email = node.data.actionHandoffNotifyEmail;
      const whatsapp = node.data.actionHandoffNotifyWhatsapp;
      if (
        (typeof email === "string" &&
          email.trim() &&
          !isProbablyEmail(normalizeEmail(email))) ||
        (typeof whatsapp === "string" &&
          whatsapp.trim() &&
          !normalizeWhatsAppPhone(whatsapp))
      ) {
        return "handoffNotificationInvalid";
      }
    }
    if (
      actionType === "whatsapp_template" &&
      (typeof node.data.actionWhatsAppTemplateName !== "string" ||
        !node.data.actionWhatsAppTemplateName.trim())
    ) {
      return "whatsappTemplateRequired";
    }
    if (
      actionType === "whatsapp_template" &&
      validateScenarioWhatsAppTemplateBindings({
        components: node.data.actionWhatsAppTemplateComponents,
        bindings: node.data.actionWhatsAppTemplateBindings,
      }).length > 0
    ) {
      return "whatsappTemplateBindingsInvalid";
    }
    if (
      actionType === "generative_ai" &&
      !normalizeGenerativeAIActionConfig(node.data.actionGenerativeAIConfig)
    ) {
      return "generativeAIConfigInvalid";
    }
    if (node.data.actionWhatsAppServiceMessage !== undefined) {
      if (
        validateScenarioWhatsAppServiceMessage(
          node.data.actionWhatsAppServiceMessage
        ).length > 0
      ) {
        return "whatsappServiceMessageInvalid";
      }
      continue;
    }
  }

  return null;
}

export function collectWhatsAppQrTriggerNodeIds(
  nodes: ScenarioGraphNodeLike[]
): string[] {
  return nodes
    .filter(
      node =>
        node.data.kind === "trigger" &&
        node.data.triggerConfig?.entryPointType === "whatsapp_qr"
    )
    .map(node => node.id);
}

function validateWhatsAppQrEntryPointReadiness(
  nodes: ScenarioGraphNodeLike[],
  readiness: Readonly<Record<string, WhatsAppQrEntryPointReadinessEvidence>>
): ScenarioGraphValidationErrorKey | null {
  const qrNodes = nodes.filter(
    node =>
      node.data.kind === "trigger" &&
      node.data.triggerConfig?.entryPointType === "whatsapp_qr"
  );
  const entryPointIds = new Set<string>();
  for (const node of qrNodes) {
    const entryPointId = normalizeWhatsAppQrEntryPointId(
      node.data.triggerConfig?.entryPointId
    );
    if (!entryPointId) return "whatsappQrEntryPointIncomplete";
    if (entryPointIds.has(entryPointId)) {
      return "whatsappQrEntryPointDuplicate";
    }
    entryPointIds.add(entryPointId);
  }

  for (const node of qrNodes) {
    const entryPointId = normalizeWhatsAppQrEntryPointId(
      node.data.triggerConfig?.entryPointId
    );
    const evidence = readiness[node.id];
    if (
      !entryPointId ||
      evidence?.entryPointId !== entryPointId ||
      evidence.ready !== true
    ) {
      return "whatsappQrEntryPointIncomplete";
    }
  }
  return null;
}

function validateWhatsAppFlowProviderBinding(
  nodes: ScenarioGraphNodeLike[],
  completedOperations: readonly CompletedWhatsAppFlowProvisioningOperationEvidence[],
  currentSourceWabaBindings: Readonly<Record<string, string>>
): ScenarioGraphValidationErrorKey | null {
  for (const node of nodes) {
    const target = resolveScenarioWhatsAppInteractiveFlowTarget(node.data);
    if (!target) {
      continue;
    }
    if (target.config.managedProvisioning === undefined) {
      if (target.config.providerReference !== undefined) {
        const providerReference = normalizeWhatsAppFlowProviderReference(
          target.config.providerReference
        );
        if (
          !providerReference ||
          resolveSendableWhatsAppFlowProviderId({
            flowConfig: target.config,
          }) !== providerReference.flowId ||
          resolveWhatsAppFlowSourceBinding({
            flowConfig: target.config,
            outboundSourceId: providerReference.sourceId,
            outboundWabaId:
              currentSourceWabaBindings[providerReference.sourceId],
          }) !== "matched" ||
          (target.owner === "template" &&
            getSingleFlowIdFromWhatsAppTemplateComponents(
              node.data.actionWhatsAppTemplateComponents
            ) !== providerReference.flowId)
        ) {
          return "whatsappServiceMessageInvalid";
        }
        continue;
      }

      if (
        typeof target.config.metaFlowId !== "string" ||
        !target.config.metaFlowId.trim()
      ) {
        return "whatsappServiceMessageInvalid";
      }
      continue;
    }
    const projection = normalizeManagedWhatsAppFlowProvisioningProjection(
      target.config.managedProvisioning
    );
    if (!projection?.flowId || projection.providerStatus !== "PUBLISHED") {
      return "whatsappServiceMessageInvalid";
    }
    if (currentSourceWabaBindings[projection.sourceId] !== projection.wabaId) {
      return "whatsappServiceMessageInvalid";
    }
    if (
      target.owner === "template" &&
      getSingleFlowIdFromWhatsAppTemplateComponents(
        node.data.actionWhatsAppTemplateComponents
      ) !== projection.flowId
    ) {
      return "whatsappServiceMessageInvalid";
    }

    try {
      if (
        createWhatsAppFlowEditableContentDigest(target.config) !==
        projection.contentDigest
      ) {
        return "whatsappServiceMessageInvalid";
      }
    } catch {
      return "whatsappServiceMessageInvalid";
    }

    const hasCompletedOperation = completedOperations.some(
      operation =>
        operation.operationId === projection.operationId &&
        operation.nodeId === node.id &&
        operation.sourceId === projection.sourceId &&
        operation.wabaId === projection.wabaId &&
        operation.contentDigest === projection.contentDigest &&
        operation.providerFlowId === projection.flowId &&
        operation.status === "COMPLETED" &&
        operation.stage === "COMPLETED"
    );
    if (!hasCompletedOperation) {
      return "whatsappServiceMessageInvalid";
    }
  }

  return null;
}

function birthdayCampaignRootIssue(
  node: ScenarioGraphNodeLike,
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[],
  options?: ScenarioGraphValidationOptions
): ScenarioGraphValidationErrorKey | null {
  if (!isBulkCampaignRootNode(node)) return null;
  const config = node.data.bulkRootConfig;
  if (
    !isRecord(config) ||
    config.recipientAudienceSource !==
      SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE
  )
    return null;
  if (
    !Array.isArray(config.channels) ||
    config.channels.length !== 1 ||
    (config.channels[0] !== "whatsapp" && config.channels[0] !== "telegram")
  )
    return "birthdayChannelUnsupported";
  if (!parseBirthdayCampaignScheduleConfig(config.scheduleConfig))
    return "birthdayScheduleInvalid";
  const channel = config.channels[0];
  if (
    channel === "telegram" &&
    !readStringOrEmpty(config.telegramSubscriberSourceId, { trim: true })
  )
    return "birthdayTelegramSourceRequired";
  if (
    options?.scenarioMode !== "bulk_campaign" &&
    (!Array.isArray(config.uploadedRecipients) ||
      config.uploadedRecipients.length === 0)
  )
    return "birthdayRecipientsRequired";
  const primaryEdges = edges.filter(
    edge =>
      edge.source === node.id &&
      edge.sourceHandle === BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID
  );
  if (primaryEdges.length !== 1) return "birthdayActionRequired";
  const action = nodes.find(
    candidate => candidate.id === primaryEdges[0]!.target
  );
  if (action?.data.kind !== "action") return "birthdayActionRequired";
  const actionType = resolveScenarioActionTypeFromNodeData(action.data);
  if (channel === "whatsapp") {
    const draft = isRecord(action.data.generatedTemplateDraft)
      ? action.data.generatedTemplateDraft
      : null;
    if (
      actionType !== "whatsapp_template" ||
      !(
        readStringOrEmpty(action.data.actionWhatsAppTemplateName, {
          trim: true,
        }) || readStringOrEmpty(draft?.name, { trim: true })
      )
    )
      return "birthdayActionRequired";
  } else if (
    actionType !== "reply" ||
    normalizeActionReplyChannelForActionNode(action.data) !== "telegram" ||
    normalizeReplyModeForActionNode(action.data) !== "fixed" ||
    !readStringOrEmpty(action.data.actionReplyText, { trim: true })
  )
    return "birthdayActionRequired";
  return null;
}

export function validateScenarioGraph(
  nodes: ScenarioGraphNodeLike[],
  edges: ScenarioGraphEdgeLike[],
  options: ScenarioGraphValidationOptions = {}
): ScenarioGraphValidationErrorKey | null {
  // Persistence checks the envelope before normalization. Drafts can retain
  // unfinished routing and payloads until graph quality or activation is checked.
  if (options.mode === "draft") return null;
  if (options.mode === "runnable") {
    for (const node of nodes) {
      const birthdayIssue = birthdayCampaignRootIssue(
        node,
        nodes,
        edges,
        options
      );
      if (birthdayIssue) return birthdayIssue;
    }
  }

  // The business-event editor stores integration intent until ingress is built.
  // Neither activation nor edits to an active scenario may make it runnable.
  if (
    options.mode === "runnable" &&
    nodes.some(
      node =>
        node.data.kind === "trigger" &&
        node.data.triggerConfig?.entryPointType === "business_event"
    )
  )
    return "businessEventIntegrationPending";

  const compiled = compileValidationGraph(nodes, edges);
  const routingError = getBlockingScenarioRoutingDiagnosticCode(
    compiled.diagnostics
  );
  if (routingError) return routingError;

  const connectivity = validateScenarioGraphConnectivity(nodes, edges);
  if (connectivity) return connectivity;

  const structure = getCompiledScenarioFlowStructureIssue(compiled);
  if (structure) return structure.errorKey;

  const formRoutes = validateWhatsAppTemplateFormRoutes(nodes, edges);
  if (formRoutes) return formRoutes;

  if (options.mode === "runnable") {
    for (const node of nodes) {
      if (node.data.kind !== "trigger") continue;
      const criteria = projectActiveClientMessageFilters(
        normalizeScenarioTriggerConfig({ nodeData: node.data })
      );
      if (criteria.enabled && criteria.text.status !== "valid") {
        return "messageTriggerIncomplete";
      }
    }
    const behaviorError = validateBehaviorTriggers(nodes, edges);
    if (behaviorError) return behaviorError;
    const providerBinding = validateWhatsAppFlowProviderBinding(
      nodes,
      options.completedWhatsAppFlowProvisioningOperations ?? [],
      options.currentWhatsAppSourceWabaBindings ?? {}
    );
    if (providerBinding) return providerBinding;

    const qrReadiness = validateWhatsAppQrEntryPointReadiness(
      nodes,
      options.whatsappQrEntryPointReadiness ?? {}
    );
    if (qrReadiness) return qrReadiness;

    const actionPayloads = validateScenarioGraphActionPayloads(nodes);
    if (actionPayloads) return actionPayloads;
    if (templateBindingBlockingNodeIds(nodes, edges).length > 0) {
      return "whatsappTemplateBindingsInvalid";
    }
    const promptAnswers = validateScenarioPromptAnswers(nodes, edges);
    if (promptAnswers) return promptAnswers;
    if (promptInputWaitBlockingNodeIds(nodes, compiled).length > 0) {
      return "promptInputChoiceWaitUnsupported";
    }
  }

  return validateScenarioGraphBranches(nodes, edges);
}
