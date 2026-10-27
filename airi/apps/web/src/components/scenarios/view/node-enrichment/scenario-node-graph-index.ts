import type {
  ScenarioAudienceOptions,
  ScenarioBulkConnectedAction,
  ScenarioCampaignRecipient,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
} from "../../types";
import { resolveScenarioDestinationLabel } from "../../scenario-node-labels";
import { normalizeScenarioEdges } from "../../graph/edge-normalization";
import {
  buildScenarioFormAnswersKeysByNodeId,
  buildScenarioFormAnswersKeyStamps,
  buildScenarioFormAnswerTokensByFormKey,
  buildSentScenarioFormAnswerSourcesByNodeId,
  buildWhatsAppOnlyScenarioFormSourcesByNodeId,
  type ScenarioFormAnswersKeyStamp,
} from "@/lib/scenarios/scenario-form-answer-checks";
import {
  resolveBulkConnectedActionFromNode,
  resolveBulkColumnSplitRouting,
  type BulkColumnSplitRouting,
} from "@/lib/scenarios/bulk-column-split-routing";
import {
  findInstagramReplyActionIdsAttachedToBulkRoot,
  isAllActionsNonAiReply,
} from "../graph/utils";
import {
  resolveReplyModeFromNodeData,
  resolveScenarioActionTypeFromNodeData,
} from "@icecore/airi-runtime/scenario-action-semantics";
import { normalizeActionReplyChannelForActionNode } from "@/lib/scenarios/normalization";
import { listBulkPrimaryWhatsAppTemplateIds } from "@/lib/scenarios/flow-structure-validation";
import {
  getInteractiveNoReplySurface,
  getScenarioLogicType,
  isPostActionConditionNodeData,
} from "@icecore/scenario-contracts";
import {
  isRecipientColumnSplitNodeData,
  matchRecipientColumnSplit,
} from "@/lib/scenarios/recipient-column-split";
import {
  buildPreviewProfileFromCustomer,
  hasConfiguredAudienceFilterInNode,
  pickSampleAudienceCustomer,
  type ScenarioPreviewAudienceFilter,
  type ScenarioPreviewProfile,
} from "../preview/utils";
import {
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  buildFlowBranchOptionKey,
  normalizeScenarioActionOutcomes,
  parseFlowBranchSourceHandleId,
  parseRecipientColumnSplitPathHandleId,
  parseTelegramBranchSourceHandleId,
  parseWhatsAppSessionChoiceSourceHandleId,
  type CampaignVariableSourceConfig,
  buildScenarioPickedOptionSourcesByNodeId,
  listInsertableScenarioPromptInputs,
  readScenarioActionForm,
  type ScenarioFormAnswerSource,
  type ScenarioPickedOptionSource,
  type ScenarioPromptInputField,
} from "@icecore/scenario-contracts";

import { buildPromptInputsByNodeId } from "./scenario-prompt-input-scope";

/** WhatsApp allows only templates once 24 hours pass without a reply. */
const LONG_NO_REPLY_MINUTES = 24 * 60;

function isLongNoReplyRoute(
  sourceData: ScenarioNodeData,
  sourceHandleIds: readonly (string | undefined)[]
): boolean {
  if (
    sourceData.kind !== "action" ||
    !sourceHandleIds.includes(ACTION_NO_REPLY_OUTCOME_HANDLE_ID)
  ) {
    return false;
  }
  const outcomes = normalizeScenarioActionOutcomes(sourceData.actionOutcomes);
  return (
    outcomes.status === "supported" &&
    outcomes.value.noReply?.enabled === true &&
    outcomes.value.noReply.timeoutMinutes >= LONG_NO_REPLY_MINUTES
  );
}

export type PostActionConditionScope =
  | "default"
  | "flow_branch"
  | "telegram_branch"
  | "instagram_branch"
  | "whatsapp_session_choice";

export type PostActionConditionScopeMeta = {
  scope: PostActionConditionScope;
  branchLabel: string | null;
};

/**
 * The step a route leads to. `postActionCondition`: it is a post-action
 * condition, which the route arms as the step's follow-up wait.
 */
export type ScenarioRouteDestination = Readonly<{
  nodeId: string;
  label: string;
  postActionCondition?: boolean;
}>;

export type ScenarioNodeGraphIndex = Readonly<{
  destinationsBySourceHandleByNodeId: ReadonlyMap<
    string,
    ReadonlyMap<string, ScenarioRouteDestination>
  >;
  incomingRouteCountByNodeId: ReadonlyMap<string, number>;
  /** Steps an action's No reply route reaches after a day or more. */
  reachedAfterLongNoReplyNodeIds: ReadonlySet<string>;
  connectedSourceHandleIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  connectedTelegramBranchPayloadsByActionId: ReadonlyMap<
    string,
    readonly string[]
  >;
  connectedInstagramBranchPayloadsByActionId: ReadonlyMap<
    string,
    readonly string[]
  >;
  connectedWhatsAppSessionChoicePayloadsByActionId: ReadonlyMap<
    string,
    readonly string[]
  >;
  connectedFlowBranchIdsByActionId: ReadonlyMap<string, readonly string[]>;
  connectedWhatsAppTemplateButtonPayloadsByActionId: ReadonlyMap<
    string,
    readonly string[]
  >;
  bulkActionByRootId: ReadonlyMap<
    string,
    Readonly<ScenarioBulkConnectedAction>
  >;
  bulkColumnSplitNodeByRootId: ReadonlyMap<string, string>;
  bulkColumnSplitRoutingByRootId: ReadonlyMap<
    string,
    Readonly<BulkColumnSplitRouting>
  >;
  bulkRootByColumnSplitNodeId: ReadonlyMap<
    string,
    Readonly<{
      bulkRootId: string;
      birthdayAudience: boolean;
      uploadedRecipients: readonly ScenarioCampaignRecipient[];
    }>
  >;
  bulkRouteRecipientsByActionId: ReadonlyMap<
    string,
    readonly ScenarioCampaignRecipient[]
  >;
  actionVariableConfigsByNodeId: Readonly<
    Record<string, Readonly<Record<string, CampaignVariableSourceConfig>>>
  >;
  previewProfileByActionId: ReadonlyMap<
    string,
    Readonly<ScenarioPreviewProfile>
  >;
  connectedColumnSplitHandlesBySplitNodeId: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  bulkPrimaryActionIds: ReadonlySet<string>;
  /**
   * Templates bulk sends send, by the flow check's rule: each one a bulk
   * node reaches before any other action, behind logic too. They offer no
   * "Form submitted" route and read no form fields.
   */
  bulkPrimaryWhatsAppTemplateIds: ReadonlySet<string>;
  actionNodeCount: number;
  instagramReplyActionIdsBlockedByBulkRoot: ReadonlySet<string>;
  postActionConditionScopeByNodeId: ReadonlyMap<
    string,
    Readonly<PostActionConditionScopeMeta>
  >;
  allActionsNonAiReply: boolean;
  scenarioPromptInputs: readonly ScenarioPromptInputField[];
  scenarioPromptInputsByNodeId: ReadonlyMap<
    string,
    readonly ScenarioPromptInputChoice[]
  >;
  /** Buttons, list and carousel messages every path to a node passes. */
  scenarioPickedOptionSourcesByNodeId: ReadonlyMap<
    string,
    readonly ScenarioPickedOptionChoice[]
  >;
  /**
   * Forms before a node whose answers its AI prompts can read, in node
   * order, and forms built only in WhatsApp, whose fields aren't listed.
   */
  scenarioFormAnswerSourcesByNodeId: ReadonlyMap<
    string,
    readonly ScenarioFormAnswerChoice[]
  >;
  /**
   * Each form's key in `{{form.<key>.<field>}}` as the runtime resolves it,
   * by sending node; an empty new form that may still name itself has none.
   */
  scenarioFormKeysByNodeId: ReadonlyMap<string, string>;
  /** The patch storing a form's current key, by that key, for forms that store none. */
  scenarioFormKeyStampsByFormKey: ReadonlyMap<
    string,
    ScenarioFormAnswersKeyStamp
  >;
  /** The form answer tokens AI prompts read, by the form key they name. */
  scenarioFormAnswerTokensByFormKey: ReadonlyMap<string, readonly string[]>;
}>;

/**
 * An answer collected before a node. `fromForm` marks a form's text field
 * read as `{{input.<id>}}`: it still renders, but menus offer the form's own
 * answers instead.
 */
export type ScenarioPromptInputChoice = Readonly<
  ScenarioPromptInputField & { fromForm?: true }
>;

/** A message whose tapped option a node can read, named as the canvas names it. */
export type ScenarioPickedOptionChoice = Readonly<
  ScenarioPickedOptionSource & { label: string }
>;

/** A form whose answers a node can read, named as the canvas names its step. */
export type ScenarioFormAnswerChoice = Readonly<
  ScenarioFormAnswerSource & { label: string }
>;

function readonlyMapSnapshot<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  return new Proxy(source, {
    get(target, property) {
      if (property === "set" || property === "delete" || property === "clear") {
        return () => {
          throw new TypeError("Scenario graph index snapshots are read-only");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReadonlyMap<K, V>;
}

function readonlySetSnapshot<T>(source: Set<T>): ReadonlySet<T> {
  return new Proxy(source, {
    get(target, property) {
      if (property === "add" || property === "delete" || property === "clear") {
        return () => {
          throw new TypeError("Scenario graph index snapshots are read-only");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ReadonlySet<T>;
}

function freezeSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(item => freezeSnapshot(item))) as T;
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freezeSnapshot(item)])
      )
    ) as T;
  }
  return value;
}

/**
 * Frozen copies of uploaded recipients, one per recipient object. Node data
 * is replaced, never edited, so an index rebuilt after an unrelated edit
 * reuses them instead of copying every recipient again.
 */
const frozenRecipients = new WeakMap<object, ScenarioCampaignRecipient>();

function freezeRecipient(
  recipient: ScenarioCampaignRecipient
): ScenarioCampaignRecipient {
  if (!recipient || typeof recipient !== "object") return recipient;
  const known = frozenRecipients.get(recipient);
  if (known) return known;
  const frozen = freezeSnapshot(recipient);
  frozenRecipients.set(recipient, frozen);
  return frozen;
}

function freezeRecipients(
  recipients: readonly ScenarioCampaignRecipient[]
): readonly ScenarioCampaignRecipient[] {
  return Object.freeze(recipients.map(freezeRecipient));
}

function freezeMapArrays(
  source: Map<string, string[]>
): ReadonlyMap<string, readonly string[]> {
  return readonlyMapSnapshot(
    new Map(
      Array.from(source, ([key, values]) => [key, Object.freeze([...values])])
    )
  );
}

function buildNearestDescendantValueMap<T>(params: {
  nodes: readonly ScenarioFlowNode[];
  outgoingTargetIdsBySource: ReadonlyMap<string, readonly string[]>;
  readSourceValue: (node: ScenarioFlowNode) => T | undefined;
}): Map<string, T> {
  const nearestValueByNodeId = new Map<string, T>();
  const queue: string[] = [];

  for (const node of params.nodes) {
    const sourceValue = params.readSourceValue(node);
    if (sourceValue === undefined) continue;
    nearestValueByNodeId.set(node.id, sourceValue);
    queue.push(node.id);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const sourceNodeId = queue[index];
    if (!sourceNodeId) continue;
    const sourceValue = nearestValueByNodeId.get(sourceNodeId);
    if (sourceValue === undefined) continue;

    for (const targetNodeId of params.outgoingTargetIdsBySource.get(
      sourceNodeId
    ) ?? []) {
      if (nearestValueByNodeId.has(targetNodeId)) continue;
      nearestValueByNodeId.set(targetNodeId, sourceValue);
      queue.push(targetNodeId);
    }
  }

  return nearestValueByNodeId;
}

function buildPreviewAudienceFilterSnapshot(
  nodeData: ScenarioNodeData
): Readonly<ScenarioPreviewAudienceFilter> | undefined {
  if (!hasConfiguredAudienceFilterInNode(nodeData)) return undefined;
  return freezeSnapshot({
    audienceMode: nodeData.audienceMode,
    audienceFunnelStage: nodeData.audienceFunnelStage,
    audienceLastSeenDays: nodeData.audienceLastSeenDays,
    classificationCategory: nodeData.classificationCategory,
    customerIds: nodeData.customerIds,
    internalLabel: nodeData.internalLabel,
  });
}

function addUniqueToMapList(
  map: Map<string, string[]>,
  key: string,
  value: string
): void {
  const current = map.get(key);
  if (!current) {
    map.set(key, [value]);
    return;
  }
  if (!current.includes(value)) {
    current.push(value);
  }
}

export function resolvePostActionConditionScope(params: {
  conditionData: ScenarioNodeData | undefined;
  incomingActionData: ScenarioNodeData | undefined;
}): PostActionConditionScopeMeta {
  const interactiveSurface = getInteractiveNoReplySurface(params.conditionData);
  if (interactiveSurface === "whatsapp_flow") {
    return {
      scope: "flow_branch",
      branchLabel: null,
    };
  }

  if (interactiveSurface === "telegram_builder") {
    return {
      scope: "telegram_branch",
      branchLabel: null,
    };
  }

  if (interactiveSurface === "instagram_reply") {
    return {
      scope: "instagram_branch",
      branchLabel: null,
    };
  }

  if (interactiveSurface === "whatsapp_session_choices") {
    return {
      scope: "whatsapp_session_choice",
      branchLabel: null,
    };
  }

  if (params.incomingActionData?.flowBranchOptionLabel) {
    return {
      scope: "flow_branch",
      branchLabel: params.incomingActionData.flowBranchOptionLabel,
    };
  }

  if (params.incomingActionData?.telegramBranchLabel) {
    return {
      scope: "telegram_branch",
      branchLabel: params.incomingActionData.telegramBranchLabel,
    };
  }

  if (params.incomingActionData?.instagramBranchLabel) {
    return {
      scope: "instagram_branch",
      branchLabel: params.incomingActionData.instagramBranchLabel,
    };
  }

  if (params.incomingActionData?.whatsAppSessionChoiceLabel) {
    return {
      scope: "whatsapp_session_choice",
      branchLabel: params.incomingActionData.whatsAppSessionChoiceLabel,
    };
  }

  return {
    scope: "default",
    branchLabel: null,
  };
}

function resolveIncomingActionData(params: {
  nodeId: string;
  nodesById: Map<string, ScenarioFlowNode>;
  incomingEdgesByTarget: Map<string, ScenarioFlowEdge[]>;
}): ScenarioNodeData | undefined {
  const incomingActionNode = (
    params.incomingEdgesByTarget.get(params.nodeId) ?? []
  )
    .map(edge => (edge.source ? params.nodesById.get(edge.source) : null))
    .find(
      (candidate): candidate is ScenarioFlowNode =>
        Boolean(candidate) &&
        (candidate?.data as ScenarioNodeData | undefined)?.kind === "action"
    );

  return incomingActionNode?.data as ScenarioNodeData | undefined;
}

/** Names a step as the canvas does, reading each node once. */
function createStepLabelReader(
  nodesById: ReadonlyMap<string, ScenarioFlowNode>,
  translate: ((key: string) => string) | undefined
): (nodeId: string) => string {
  const labels = new Map<string, string>();
  const t = translate ?? ((key: string) => key);
  return nodeId => {
    const known = labels.get(nodeId);
    if (known !== undefined) return known;
    const nodeData = nodesById.get(nodeId)?.data as
      | ScenarioNodeData
      | undefined;
    const label = nodeData
      ? resolveScenarioDestinationLabel({ nodeData, t })
      : "";
    labels.set(nodeId, label);
    return label;
  };
}

/** Each node's sources with their step's canvas name, frozen and detached. */
function labelSourcesByNodeId<TSource extends { nodeId: string }>(
  sourcesByNodeId: ReadonlyMap<string, readonly TSource[]>,
  readStepLabel: (nodeId: string) => string
): ReadonlyMap<string, readonly Readonly<TSource & { label: string }>[]> {
  return readonlyMapSnapshot(
    new Map(
      Array.from(sourcesByNodeId, ([nodeId, sources]) => [
        nodeId,
        freezeSnapshot(
          sources.map(source => ({
            ...source,
            label: readStepLabel(source.nodeId),
          }))
        ),
      ])
    )
  );
}

/**
 * The answer keys each node reads from messages that ask for details. Forms
 * are left out, so any other answer a node reads is a form's text field.
 * Null when the scenario sends no form.
 */
function buildAskAnswerKeysByNodeId(
  nodes: readonly ScenarioFlowNode[],
  edges: readonly ScenarioFlowEdge[]
): Map<string, ReadonlySet<string>> | null {
  const formNodeIds = new Set(
    nodes.filter(node => readScenarioActionForm(node.data)).map(node => node.id)
  );
  if (formNodeIds.size === 0) return null;
  // A form never asks for details, so only its graph position is kept.
  const askNodes = nodes.map(node =>
    formNodeIds.has(node.id)
      ? { id: node.id, data: { kind: (node.data as ScenarioNodeData).kind } }
      : node
  );
  return new Map(
    Array.from(
      buildPromptInputsByNodeId({ nodes: askNodes, edges }),
      ([nodeId, fields]) => [nodeId, new Set(fields.map(field => field.key))]
    )
  );
}

/**
 * The forms before each node: forms built here, then forms built only in
 * WhatsApp, in node order.
 */
function buildFormAnswerSourcesByNodeId(
  nodes: readonly ScenarioFlowNode[],
  edges: readonly ScenarioFlowEdge[]
): Map<string, ScenarioFormAnswerSource[]> {
  const sourcesByNodeId = buildSentScenarioFormAnswerSourcesByNodeId({
    nodes,
    edges,
  });
  const whatsAppOnly = buildWhatsAppOnlyScenarioFormSourcesByNodeId({
    nodes,
    edges,
  });
  if (whatsAppOnly.size === 0) return sourcesByNodeId;
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  for (const [nodeId, extra] of whatsAppOnly) {
    if (extra.length === 0) continue;
    const merged = [...(sourcesByNodeId.get(nodeId) ?? []), ...extra];
    merged.sort(
      (left, right) =>
        (order.get(left.nodeId) ?? 0) - (order.get(right.nodeId) ?? 0)
    );
    sourcesByNodeId.set(nodeId, merged);
  }
  return sourcesByNodeId;
}

/** Each node's collected answers, with a form's text fields marked. */
function buildPromptInputChoicesByNodeId(
  nodes: readonly ScenarioFlowNode[],
  edges: readonly ScenarioFlowEdge[]
): ReadonlyMap<string, readonly ScenarioPromptInputChoice[]> {
  const askKeysByNodeId = buildAskAnswerKeysByNodeId(nodes, edges);
  return readonlyMapSnapshot(
    new Map(
      Array.from(
        buildPromptInputsByNodeId({ nodes, edges }),
        ([nodeId, fields]) => {
          const askKeys = askKeysByNodeId?.get(nodeId);
          return [
            nodeId,
            freezeSnapshot(
              fields.map(
                (field): ScenarioPromptInputChoice =>
                  !askKeysByNodeId || askKeys?.has(field.key)
                    ? field
                    : { ...field, fromForm: true }
              )
            ),
          ];
        }
      )
    )
  );
}

export function buildScenarioNodeGraphIndex(
  params: Readonly<{
    nodes: readonly ScenarioFlowNode[];
    edges: readonly ScenarioFlowEdge[];
    whatsAppTemplates?: readonly ScenarioWhatsAppTemplate[];
    audienceOptions?: ScenarioAudienceOptions;
    translate?: (key: string) => string;
  }>
): ScenarioNodeGraphIndex {
  const {
    nodes,
    edges,
    whatsAppTemplates = [],
    audienceOptions,
    translate,
  } = params;
  const nodesById = new Map(nodes.map(node => [node.id, node] as const));
  const normalizedSourceHandles = new Map(
    normalizeScenarioEdges([...nodes], [...edges]).map(edge => [
      edge.id,
      edge.sourceHandle,
    ])
  );
  const incomingEdgesByTarget = new Map<string, ScenarioFlowEdge[]>();
  const outgoingTargetIdsBySource = new Map<string, string[]>();
  const connectedSourceHandleIdsByNodeId = new Map<string, string[]>();
  const destinationsBySourceHandleByNodeId = new Map<
    string,
    Map<string, ScenarioRouteDestination>
  >();
  const connectedTelegramBranchPayloadsByActionId = new Map<string, string[]>();
  const connectedInstagramBranchPayloadsByActionId = new Map<
    string,
    string[]
  >();
  const connectedWhatsAppSessionChoicePayloadsByActionId = new Map<
    string,
    string[]
  >();
  const connectedFlowBranchIdsByActionId = new Map<string, string[]>();
  const connectedWhatsAppTemplateButtonPayloadsByActionId = new Map<
    string,
    string[]
  >();
  const bulkActionNodeByRootId = new Map<
    string,
    { nodeId: string; data: ScenarioNodeData }
  >();
  const bulkColumnSplitNodeByRootId = new Map<string, string>();
  const connectedColumnSplitHandlesBySplitNodeId = new Map<
    string,
    Set<string>
  >();
  const bulkPrimaryActionIds = new Set<string>();
  const reachedAfterLongNoReplyNodeIds = new Set<string>();
  const rightSideBulkActionByRootId = new Map<
    string,
    { nodeId: string; data: ScenarioNodeData }
  >();
  let actionNodeCount = 0;

  for (const edge of edges) {
    if (edge.target) {
      const incoming = incomingEdgesByTarget.get(edge.target);
      if (incoming) {
        incoming.push(edge);
      } else {
        incomingEdgesByTarget.set(edge.target, [edge]);
      }
    }

    if (!edge.source) continue;
    const outgoing = outgoingTargetIdsBySource.get(edge.source);
    if (outgoing) {
      outgoing.push(edge.target);
    } else {
      outgoingTargetIdsBySource.set(edge.source, [edge.target]);
    }
    const sourceNode = nodesById.get(edge.source);
    const sourceData = sourceNode?.data as ScenarioNodeData | undefined;
    const targetNode = nodesById.get(edge.target);
    const targetData = targetNode?.data as ScenarioNodeData | undefined;
    if (!targetData) continue;

    const sourceHandleId = edge.sourceHandle?.trim();
    const destinationHandleId =
      normalizedSourceHandles.get(edge.id)?.trim() ?? sourceHandleId;
    if (sourceData && destinationHandleId) {
      const destinations =
        destinationsBySourceHandleByNodeId.get(edge.source) ?? new Map();
      const t = translate ?? ((key: string) => key);
      destinations.set(
        destinationHandleId,
        Object.freeze({
          nodeId: edge.target,
          label: resolveScenarioDestinationLabel({ nodeData: targetData, t }),
          ...(isPostActionConditionNodeData(targetData)
            ? { postActionCondition: true }
            : {}),
        })
      );
      if (sourceHandleId && sourceHandleId !== destinationHandleId)
        destinations.set(
          sourceHandleId,
          destinations.get(destinationHandleId)!
        );
      destinationsBySourceHandleByNodeId.set(edge.source, destinations);
    }
    if (sourceData && sourceHandleId) {
      addUniqueToMapList(
        connectedSourceHandleIdsByNodeId,
        edge.source,
        sourceHandleId
      );
    }
    if (
      sourceData &&
      isLongNoReplyRoute(sourceData, [sourceHandleId, destinationHandleId])
    ) {
      reachedAfterLongNoReplyNodeIds.add(edge.target);
    }

    if (sourceData?.kind === "bulk" && targetData.kind === "action") {
      const actionType = resolveScenarioActionTypeFromNodeData(targetData);
      const bulkAction = {
        nodeId: edge.target,
        data: targetData,
      };
      if (
        edge.sourceHandle === BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID &&
        (actionType === "whatsapp_template" ||
          (actionType === "reply" &&
            normalizeActionReplyChannelForActionNode(targetData) ===
              "telegram" &&
            resolveReplyModeFromNodeData(targetData) === "fixed"))
      ) {
        if (!rightSideBulkActionByRootId.has(edge.source)) {
          rightSideBulkActionByRootId.set(edge.source, bulkAction);
        }
      }
    }

    if (
      sourceData?.kind === "bulk" &&
      targetData.kind === "logic" &&
      getScenarioLogicType(targetData) === "recipient_column_split" &&
      edge.sourceHandle === BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID
    ) {
      bulkColumnSplitNodeByRootId.set(edge.source, edge.target);
    }

    if (
      sourceData?.kind === "logic" &&
      isRecipientColumnSplitNodeData(sourceData) &&
      parseRecipientColumnSplitPathHandleId(edge.sourceHandle)
    ) {
      const connected =
        connectedColumnSplitHandlesBySplitNodeId.get(edge.source) ??
        new Set<string>();
      if (edge.sourceHandle) connected.add(edge.sourceHandle);
      connectedColumnSplitHandlesBySplitNodeId.set(edge.source, connected);
      if (
        targetData.kind === "action" &&
        resolveScenarioActionTypeFromNodeData(targetData) ===
          "whatsapp_template"
      ) {
        bulkPrimaryActionIds.add(edge.target);
      }
    }

    const telegramPayload =
      parseTelegramBranchSourceHandleId(edge.sourceHandle)?.payload ||
      (typeof targetData.telegramBranchPayload === "string"
        ? targetData.telegramBranchPayload.trim()
        : "");
    if (telegramPayload) {
      addUniqueToMapList(
        connectedTelegramBranchPayloadsByActionId,
        edge.source,
        telegramPayload
      );
    }

    const instagramPayload =
      typeof targetData.instagramBranchPayload === "string"
        ? targetData.instagramBranchPayload.trim()
        : "";
    if (instagramPayload) {
      addUniqueToMapList(
        connectedInstagramBranchPayloadsByActionId,
        edge.source,
        instagramPayload
      );
    }

    const whatsAppSessionChoicePayload =
      parseWhatsAppSessionChoiceSourceHandleId(edge.sourceHandle)?.payload ||
      (typeof targetData.whatsAppSessionChoicePayload === "string"
        ? targetData.whatsAppSessionChoicePayload.trim()
        : "");
    if (whatsAppSessionChoicePayload) {
      addUniqueToMapList(
        connectedWhatsAppSessionChoicePayloadsByActionId,
        edge.source,
        whatsAppSessionChoicePayload
      );
    }

    // The source handle identifies the exact radio option. Target metadata is
    // retained as a fallback for legacy edges that used a generic handle.
    const flowBranchHandle = parseFlowBranchSourceHandleId(edge.sourceHandle);
    const flowBranchFieldId =
      flowBranchHandle?.fieldId ||
      (typeof targetData.flowBranchSourceFieldId === "string"
        ? targetData.flowBranchSourceFieldId.trim()
        : "");
    const flowBranchOptionId =
      flowBranchHandle?.optionId ||
      (typeof targetData.flowBranchOptionId === "string"
        ? targetData.flowBranchOptionId.trim()
        : "");
    if (flowBranchFieldId && flowBranchOptionId) {
      addUniqueToMapList(
        connectedFlowBranchIdsByActionId,
        edge.source,
        buildFlowBranchOptionKey(flowBranchFieldId, flowBranchOptionId)
      );
    }

    const whatsAppTemplateButtonPayload =
      typeof targetData.whatsAppTemplateButtonPayload === "string"
        ? targetData.whatsAppTemplateButtonPayload.trim()
        : "";
    if (whatsAppTemplateButtonPayload) {
      addUniqueToMapList(
        connectedWhatsAppTemplateButtonPayloadsByActionId,
        edge.source,
        whatsAppTemplateButtonPayload
      );
    }
  }

  for (const [bulkRootId, action] of rightSideBulkActionByRootId) {
    if (bulkColumnSplitNodeByRootId.has(bulkRootId)) continue;
    bulkActionNodeByRootId.set(bulkRootId, action);
    bulkPrimaryActionIds.add(action.nodeId);
  }

  const postActionConditionScopeByNodeId = new Map<
    string,
    PostActionConditionScopeMeta
  >();
  const actionVariableConfigsByNodeId: Record<
    string,
    Readonly<Record<string, CampaignVariableSourceConfig>>
  > = {};
  for (const node of nodes) {
    const nodeData = node.data as ScenarioNodeData;
    if (nodeData.kind === "action") {
      actionNodeCount += 1;
      if (nodeData.actionCampaignVariableConfigs) {
        actionVariableConfigsByNodeId[node.id] = freezeSnapshot(
          nodeData.actionCampaignVariableConfigs
        );
      }
    }
    if (
      nodeData.kind === "logic" &&
      getScenarioLogicType(nodeData) === "post_action_condition"
    ) {
      postActionConditionScopeByNodeId.set(
        node.id,
        resolvePostActionConditionScope({
          conditionData: nodeData,
          incomingActionData: resolveIncomingActionData({
            nodeId: node.id,
            nodesById,
            incomingEdgesByTarget,
          }),
        })
      );
    }
  }

  const preferredChannelByNodeId = buildNearestDescendantValueMap({
    nodes,
    outgoingTargetIdsBySource,
    readSourceValue: node => {
      const nodeData = node.data as ScenarioNodeData;
      if (nodeData.kind !== "trigger") return undefined;
      return nodeData.triggerConfig?.channelFilter?.find(Boolean);
    },
  });
  const audienceFilterByNodeId = buildNearestDescendantValueMap({
    nodes,
    outgoingTargetIdsBySource,
    readSourceValue: node =>
      buildPreviewAudienceFilterSnapshot(node.data as ScenarioNodeData),
  });
  const previewProfileByActionId = new Map<
    string,
    Readonly<ScenarioPreviewProfile>
  >();
  for (const node of nodes) {
    if ((node.data as ScenarioNodeData).kind !== "action") continue;
    const preferredChannel = preferredChannelByNodeId.get(node.id);
    const sampleCustomer = pickSampleAudienceCustomer({
      audienceNode: audienceFilterByNodeId.get(node.id),
      customers: audienceOptions?.customers ?? [],
      preferredChannel,
    });
    previewProfileByActionId.set(
      node.id,
      freezeSnapshot(
        buildPreviewProfileFromCustomer({
          customer: sampleCustomer,
          preferredChannel,
          fallbackChannel: audienceOptions?.channels?.[0] || "whatsapp",
          translate,
        })
      )
    );
  }

  const bulkActionByRootId = new Map<
    string,
    Readonly<ScenarioBulkConnectedAction>
  >();
  const bulkColumnSplitRoutingByRootId = new Map<
    string,
    Readonly<BulkColumnSplitRouting>
  >();
  const bulkRootByColumnSplitNodeId = new Map<
    string,
    Readonly<{
      bulkRootId: string;
      birthdayAudience: boolean;
      uploadedRecipients: readonly ScenarioCampaignRecipient[];
    }>
  >();
  const mutableBulkRouteRecipientsByActionId = new Map<
    string,
    ScenarioCampaignRecipient[]
  >();
  const addRouteRecipients = (
    actionNodeId: string,
    recipients: readonly ScenarioCampaignRecipient[]
  ) => {
    const current =
      mutableBulkRouteRecipientsByActionId.get(actionNodeId) ?? [];
    current.push(...recipients);
    mutableBulkRouteRecipientsByActionId.set(actionNodeId, current);
  };

  for (const node of nodes) {
    const nodeData = node.data as ScenarioNodeData;
    if (nodeData.kind !== "bulk") continue;
    const uploadedRecipients =
      nodeData.bulkRootConfig?.uploadedRecipients ?? [];
    const splitNodeId = bulkColumnSplitNodeByRootId.get(node.id);
    if (!splitNodeId) {
      const actionNode = bulkActionNodeByRootId.get(node.id);
      if (!actionNode) continue;
      const connectedAction = resolveBulkConnectedActionFromNode({
        actionNodeId: actionNode.nodeId,
        actionData: actionNode.data,
        whatsAppTemplates: [...whatsAppTemplates],
      });
      if (connectedAction) {
        bulkActionByRootId.set(node.id, freezeSnapshot(connectedAction));
      }
      addRouteRecipients(actionNode.nodeId, uploadedRecipients);
      continue;
    }

    const routing = resolveBulkColumnSplitRouting({
      bulkRootId: node.id,
      nodes: [...nodes],
      edges: [...edges],
      whatsAppTemplates: [...whatsAppTemplates],
    });
    if (!routing) continue;
    bulkColumnSplitRoutingByRootId.set(node.id, freezeSnapshot(routing));
    bulkRootByColumnSplitNodeId.set(
      splitNodeId,
      Object.freeze({
        bulkRootId: node.id,
        birthdayAudience:
          nodeData.bulkRootConfig?.recipientAudienceSource ===
          "customer_birthdays",
        uploadedRecipients: freezeRecipients(uploadedRecipients),
      })
    );
    for (const recipient of uploadedRecipients) {
      const match = matchRecipientColumnSplit(recipient, routing.config);
      const route = match.isElse
        ? routing.elseRoute
        : routing.routes.find(candidate => candidate.pathId === match.pathId);
      if (route?.actionNodeId) {
        addRouteRecipients(route.actionNodeId, [recipient]);
      }
    }
  }

  const bulkRouteRecipientsByActionId = new Map<
    string,
    readonly ScenarioCampaignRecipient[]
  >(
    Array.from(
      mutableBulkRouteRecipientsByActionId,
      ([actionNodeId, recipients]) => [
        actionNodeId,
        freezeRecipients(recipients),
      ]
    )
  );
  const readonlyConnectedColumnSplitHandles = new Map<
    string,
    ReadonlySet<string>
  >(
    Array.from(
      connectedColumnSplitHandlesBySplitNodeId,
      ([splitNodeId, handles]) => [
        splitNodeId,
        readonlySetSnapshot(new Set(handles)),
      ]
    )
  );
  const readonlyPostActionScopes = new Map<
    string,
    Readonly<PostActionConditionScopeMeta>
  >(
    Array.from(postActionConditionScopeByNodeId, ([nodeId, scope]) => [
      nodeId,
      freezeSnapshot(scope),
    ])
  );

  const textPromptInputs = listInsertableScenarioPromptInputs(nodes);
  const readStepLabel = createStepLabelReader(nodesById, translate);

  return Object.freeze({
    incomingRouteCountByNodeId: readonlyMapSnapshot(
      new Map(
        Array.from(incomingEdgesByTarget, ([nodeId, incoming]) => [
          nodeId,
          incoming.length,
        ])
      )
    ),
    reachedAfterLongNoReplyNodeIds: readonlySetSnapshot(
      reachedAfterLongNoReplyNodeIds
    ),
    connectedSourceHandleIdsByNodeId: freezeMapArrays(
      connectedSourceHandleIdsByNodeId
    ),
    destinationsBySourceHandleByNodeId: readonlyMapSnapshot(
      new Map(
        Array.from(
          destinationsBySourceHandleByNodeId,
          ([nodeId, destinations]) => [
            nodeId,
            readonlyMapSnapshot(destinations),
          ]
        )
      )
    ),
    connectedTelegramBranchPayloadsByActionId: freezeMapArrays(
      connectedTelegramBranchPayloadsByActionId
    ),
    connectedInstagramBranchPayloadsByActionId: freezeMapArrays(
      connectedInstagramBranchPayloadsByActionId
    ),
    connectedWhatsAppSessionChoicePayloadsByActionId: freezeMapArrays(
      connectedWhatsAppSessionChoicePayloadsByActionId
    ),
    connectedFlowBranchIdsByActionId: freezeMapArrays(
      connectedFlowBranchIdsByActionId
    ),
    connectedWhatsAppTemplateButtonPayloadsByActionId: freezeMapArrays(
      connectedWhatsAppTemplateButtonPayloadsByActionId
    ),
    bulkActionByRootId: readonlyMapSnapshot(bulkActionByRootId),
    bulkColumnSplitNodeByRootId: readonlyMapSnapshot(
      new Map(bulkColumnSplitNodeByRootId)
    ),
    bulkColumnSplitRoutingByRootId: readonlyMapSnapshot(
      bulkColumnSplitRoutingByRootId
    ),
    bulkRootByColumnSplitNodeId: readonlyMapSnapshot(
      bulkRootByColumnSplitNodeId
    ),
    bulkRouteRecipientsByActionId: readonlyMapSnapshot(
      bulkRouteRecipientsByActionId
    ),
    actionVariableConfigsByNodeId: Object.freeze(actionVariableConfigsByNodeId),
    previewProfileByActionId: readonlyMapSnapshot(previewProfileByActionId),
    connectedColumnSplitHandlesBySplitNodeId: readonlyMapSnapshot(
      readonlyConnectedColumnSplitHandles
    ),
    bulkPrimaryActionIds: readonlySetSnapshot(new Set(bulkPrimaryActionIds)),
    bulkPrimaryWhatsAppTemplateIds: readonlySetSnapshot(
      listBulkPrimaryWhatsAppTemplateIds({ nodes, edges })
    ),
    actionNodeCount,
    instagramReplyActionIdsBlockedByBulkRoot: readonlySetSnapshot(
      findInstagramReplyActionIdsAttachedToBulkRoot([...nodes], [...edges])
    ),
    postActionConditionScopeByNodeId: readonlyMapSnapshot(
      readonlyPostActionScopes
    ),
    allActionsNonAiReply: isAllActionsNonAiReply([...nodes]),
    scenarioPromptInputs: textPromptInputs,
    scenarioPromptInputsByNodeId: buildPromptInputChoicesByNodeId(nodes, edges),
    scenarioPickedOptionSourcesByNodeId: labelSourcesByNodeId(
      buildScenarioPickedOptionSourcesByNodeId({ nodes, edges }),
      readStepLabel
    ),
    scenarioFormAnswerSourcesByNodeId: labelSourcesByNodeId(
      buildFormAnswerSourcesByNodeId(nodes, edges),
      readStepLabel
    ),
    scenarioFormKeysByNodeId: readonlyMapSnapshot(
      buildScenarioFormAnswersKeysByNodeId(nodes)
    ),
    scenarioFormKeyStampsByFormKey: readonlyMapSnapshot(
      buildScenarioFormAnswersKeyStamps(nodes)
    ),
    scenarioFormAnswerTokensByFormKey: freezeMapArrays(
      buildScenarioFormAnswerTokensByFormKey(nodes)
    ),
  });
}
