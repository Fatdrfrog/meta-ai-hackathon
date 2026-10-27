import type {
  ScenarioActionOutcomes,
  ScenarioActionRunConditions,
  ScenarioDetailResponseWarning,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID } from "@icecore/scenario-contracts";
import { isDeepStrictEqual } from "node:util";
import { Types, type ClientSession } from "mongoose";

import type { RecoverPostActionTimerResult } from "@/lib/airi/scenario/timer-recovery/recover";
import {
  assertTimerReplanIngressIndexes,
  enqueueTimerReplanIngress,
  processTimerReplanIngressKeys,
  type TimerReplanIngressDocument,
  type TimerReplanIngressProcessResult,
} from "@/lib/airi/scenario/timer-recovery/ingress";
import { normalizeScenarioGraphLayout } from "@/lib/scenarios/graph-layout";
import { normalizeScenarioGraphForPersistence } from "@/lib/scenarios/scenario-graph-persistence";
import {
  type CompletedWhatsAppFlowProvisioningOperationEvidence,
  validateScenarioGraph,
} from "@/lib/scenarios/graph-validation";
import {
  canonicalizeLegacyInteractiveNoReplyAssignmentEdges,
  convertLegacyActionRouting,
  convertLegacyAudienceGate,
  type LegacyActionRoutingGraph,
} from "@/lib/scenarios/legacy-action-routing";
import {
  classifyLegacyRoutingMigrationExternalState,
  loadLegacyRoutingMigrationState,
} from "@/lib/scenarios/legacy-routing-migration-preimage";
import {
  nextRevisionDate,
  normalizeScenarioRevision,
} from "@/lib/scenarios/scenario-revision";
import {
  dedupeParentRefs,
  normalizeParentRefs,
  type LinkedConditionParentRef,
} from "@/lib/scenarios/linked-conditions-types";
import { resolveSubscenarioLinkSummary } from "@/lib/scenarios/subscenario-linking";
import {
  collectScenarioWhatsAppFlowProviderSourceIds,
  normalizeManagedWhatsAppFlowProvisioningProjection,
} from "@/lib/scenarios/whatsapp-flow-projection";
import { resolveScenarioWhatsAppInteractiveFlowTarget } from "@/lib/scenarios/whatsapp-service-message";
import { loadCurrentWhatsAppSourceWabaBindings } from "@/lib/whatsapp/flows/source-rebind-guard";
import { collectWhatsAppQrGraphBindings } from "@/lib/whatsapp/qr-entry-points/scenario-binding";
import { loadWhatsAppQrEntryPointReadinessByBindings } from "@/lib/whatsapp/qr-entry-points/queries";
import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import ScenarioLinkedCondition from "@/models/scenario-linked-condition";
import { WhatsAppFlowProvisioningOperation } from "@/models/whatsapp-flow-provisioning-operation";
import {
  asNullableRecord,
  readArray,
  isPlainRecord,
} from "@icecore/shared/lib/value-utils";
import { readId } from "@/lib/scenarios/read-id";

const MAX_ACTIVATION_PROVISIONING_EVIDENCE = 100;
const RAW_GRAPH_MEMBER_INDEX: unique symbol = Symbol(
  "legacyRoutingRawGraphMemberIndex"
);

type ScenarioGraphNodeRecord = {
  id: string;
  data: ScenarioNodeData;
  [key: string]: unknown;
};

type ScenarioGraphEdgeRecord = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [key: string]: unknown;
};

type StoredScenario = Record<string, unknown> & {
  nodes?: unknown;
  edges?: unknown;
  status?: unknown;
  updatedAt?: unknown;
};

type IndexedGraphMember = Record<string, unknown> & {
  [RAW_GRAPH_MEMBER_INDEX]?: number;
};

type ConvertedLegacyRouting = {
  sourceActionNodeId: string;
  sourceNodeId: string;
  virtualConditionNodeId?: string;
};

type RemappedPendingConversation = {
  conversationId: string;
  sourceActionNodeId: string;
  virtualConditionNodeId: string;
  timerIngressKey: string;
};

export type LegacyRoutingConversionInstruction = {
  sourceActionNodeId: string;
  sourceNodeId: string;
  sourceKind: "post_action_condition" | "audience_filter";
  actionOutcomes?: ScenarioActionOutcomes;
  actionRunConditions?: ScenarioActionRunConditions;
};

type LegacyRoutingConversionTimerReplanResult = RecoverPostActionTimerResult;

type LegacyRoutingConversionTimerReplanFailure =
  | {
      conversationId: string;
      status: "rejected";
      reason: string;
    }
  | {
      conversationId: string;
      status: "non_success";
      result: LegacyRoutingConversionTimerReplanResult;
    };

type LegacyRoutingConversionPostCommitWarning = Extract<
  ScenarioDetailResponseWarning,
  { affectedConversationIds: string[] }
>;

function isSuccessfulTimerIngressResult(
  result: TimerReplanIngressProcessResult
): boolean {
  return result.status === "signaled" || result.status === "superseded";
}

function timerReplanResultFromIngress(params: {
  remapped: RemappedPendingConversation;
  processed: TimerReplanIngressProcessResult;
}): LegacyRoutingConversionTimerReplanResult {
  const common = {
    conversationId: params.remapped.conversationId,
    conditionNodeId: params.remapped.virtualConditionNodeId,
    sourceActionNodeId: params.remapped.sourceActionNodeId,
  };
  if (params.processed.status === "signaled") {
    return { ...common, status: "replanned" };
  }
  if (params.processed.status === "superseded") {
    return {
      ...common,
      status: "conflict",
      reason: "conversation_state_changed",
    };
  }
  return {
    ...common,
    status: "skipped",
    reason: `timer_replan_ingress_${params.processed.status}`,
  };
}

export type LegacyRoutingConversionTransactionResult = {
  scenario: StoredScenario;
  beforeRevision: string;
  afterRevision: string;
  convertedConditionNodeIds: string[];
  convertedActionNodeIds: string[];
  remappedConversationIds: string[];
  timerReplanResults: LegacyRoutingConversionTimerReplanResult[];
  postCommitWarnings: LegacyRoutingConversionPostCommitWarning[];
};

export class LegacyRoutingConversionError extends Error {
  readonly committed: boolean;
  readonly committedResult: LegacyRoutingConversionTransactionResult | null;
  readonly timerReplanResults: LegacyRoutingConversionTimerReplanResult[];
  readonly timerReplanFailures: LegacyRoutingConversionTimerReplanFailure[];

  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    options?: {
      committed?: boolean;
      committedResult?: LegacyRoutingConversionTransactionResult;
      timerReplanResults?: LegacyRoutingConversionTimerReplanResult[];
      timerReplanFailures?: LegacyRoutingConversionTimerReplanFailure[];
      cause?: unknown;
    }
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "LegacyRoutingConversionError";
    this.committed = options?.committed === true;
    this.committedResult = options?.committedResult || null;
    this.timerReplanResults = options?.timerReplanResults || [];
    this.timerReplanFailures = options?.timerReplanFailures || [];
  }
}

const asScenarioGraphNodes = readArray<ScenarioGraphNodeRecord>;
const asScenarioGraphEdges = readArray<ScenarioGraphEdgeRecord>;

function indexGraphMembers<T extends Record<string, unknown>>(
  members: T[]
): Array<T & IndexedGraphMember> {
  return members.map((member, index) => ({
    ...member,
    [RAW_GRAPH_MEMBER_INDEX]: index,
  }));
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return isPlainRecord(value) ? value : null;
}

function projectConvertedValueOntoRaw(params: {
  raw: unknown;
  semantic: unknown;
  converted: unknown;
}): unknown {
  if (isDeepStrictEqual(params.semantic, params.converted)) {
    return params.raw;
  }
  if (Array.isArray(params.converted)) {
    const raw = params.raw;
    const semantic = params.semantic;
    if (
      !Array.isArray(raw) ||
      !Array.isArray(semantic) ||
      raw.length !== semantic.length ||
      semantic.length !== params.converted.length
    ) {
      return params.converted.map(converted =>
        projectConvertedValueOntoRaw({
          raw: undefined,
          semantic: undefined,
          converted,
        })
      );
    }
    return params.converted.map((converted, index) =>
      projectConvertedValueOntoRaw({
        raw: raw[index],
        semantic: semantic[index],
        converted,
      })
    );
  }

  const convertedRecord = asPlainRecord(params.converted);
  if (!convertedRecord) return params.converted;
  const rawRecord = asPlainRecord(params.raw);
  const semanticRecord = asPlainRecord(params.semantic);
  return Object.fromEntries(
    Object.entries(convertedRecord).map(([key, converted]) => [
      key,
      projectConvertedValueOntoRaw({
        raw: rawRecord?.[key],
        semantic: semanticRecord?.[key],
        converted,
      }),
    ])
  );
}

function projectConvertedGraphOntoRaw(params: {
  rawNodes: unknown;
  rawEdges: unknown;
  semanticNodes: ScenarioGraphNodeRecord[];
  semanticEdges: ScenarioGraphEdgeRecord[];
  convertedNodes: unknown[];
  convertedEdges: unknown[];
}): { nodes: unknown[]; edges: unknown[] } {
  const rawNodes = Array.isArray(params.rawNodes) ? params.rawNodes : [];
  const rawEdges = Array.isArray(params.rawEdges) ? params.rawEdges : [];
  const projectMember = (
    converted: unknown,
    rawMembers: unknown[],
    semanticMembers: Array<Record<string, unknown>>
  ): unknown => {
    const convertedMember = converted as IndexedGraphMember;
    const index = convertedMember?.[RAW_GRAPH_MEMBER_INDEX];
    return projectConvertedValueOntoRaw({
      raw:
        typeof index === "number" && Number.isSafeInteger(index)
          ? rawMembers[index]
          : undefined,
      semantic:
        typeof index === "number" && Number.isSafeInteger(index)
          ? semanticMembers[index]
          : undefined,
      converted,
    });
  };

  return {
    nodes: params.convertedNodes.map(node =>
      projectMember(node, rawNodes, params.semanticNodes)
    ),
    edges: params.convertedEdges.map(edge =>
      projectMember(edge, rawEdges, params.semanticEdges)
    ),
  };
}

function conversionPairKey(params: {
  sourceActionNodeId: string;
  sourceNodeId: string;
}): string {
  return `${params.sourceActionNodeId.trim()}\u0000${params.sourceNodeId.trim()}`;
}

function assertExpectedDedicatedAssignments(params: {
  graph: LegacyActionRoutingGraph;
  conversions: LegacyRoutingConversionInstruction[];
  expectedCount: number | undefined;
}): void {
  if (params.expectedCount === undefined) return;

  const expectedCount = params.expectedCount;
  const assignments = canonicalizeLegacyInteractiveNoReplyAssignmentEdges(
    params.graph
  ).filter(
    edge => edge.sourceHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
  );
  const conversionKeys = params.conversions
    .filter(conversion => conversion.sourceKind === "post_action_condition")
    .map(conversion => conversionPairKey(conversion));
  const assignmentKeys = assignments.map(edge =>
    conversionPairKey({
      sourceActionNodeId: edge.source,
      sourceNodeId: edge.target,
    })
  );
  const plannedKeys = new Set(conversionKeys);
  const actualKeys = new Set(assignmentKeys);
  const exactPlan =
    Number.isSafeInteger(expectedCount) &&
    expectedCount >= 0 &&
    assignments.length === expectedCount &&
    conversionKeys.length === expectedCount &&
    plannedKeys.size === expectedCount &&
    actualKeys.size === expectedCount &&
    assignmentKeys.every(key => plannedKeys.has(key)) &&
    conversionKeys.every(key => actualKeys.has(key));

  if (!exactPlan) {
    throw new LegacyRoutingConversionError(
      "legacy_action_routing_candidate_count_mismatch",
      409,
      "Dedicated legacy routing assignments changed before conversion."
    );
  }
}

export async function loadCompletedWhatsAppFlowProvisioningOperations(params: {
  workspaceId: string;
  scenarioId: string;
  nodes: Array<{ data?: Record<string, unknown> }>;
  session?: ClientSession;
}): Promise<CompletedWhatsAppFlowProvisioningOperationEvidence[]> {
  const operationIds = Array.from(
    new Set(
      params.nodes.flatMap(node => {
        if (!node.data) return [];
        const target = resolveScenarioWhatsAppInteractiveFlowTarget(
          node.data as ScenarioNodeData
        );
        if (!target) return [];
        const projection = normalizeManagedWhatsAppFlowProvisioningProjection(
          target.config.managedProvisioning
        );
        return projection ? [projection.operationId] : [];
      })
    )
  ).slice(0, MAX_ACTIVATION_PROVISIONING_EVIDENCE);
  if (operationIds.length === 0) return [];

  const query = WhatsAppFlowProvisioningOperation.find({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    operationId: { $in: operationIds },
    status: "COMPLETED",
    stage: "COMPLETED",
  }).select({
    _id: 0,
    operationId: 1,
    nodeId: 1,
    sourceId: 1,
    wabaId: 1,
    contentDigest: 1,
    providerFlowId: 1,
    status: 1,
    stage: 1,
  });
  const scopedQuery = params.session ? query.session(params.session) : query;
  return scopedQuery.lean<CompletedWhatsAppFlowProvisioningOperationEvidence[]>(
    { defaults: false }
  );
}

function convertGraph(params: {
  graph: LegacyActionRoutingGraph;
  conversions: LegacyRoutingConversionInstruction[];
}) {
  let graph = params.graph;
  const converted: ConvertedLegacyRouting[] = [];

  for (const instruction of params.conversions) {
    const patch = {
      actionOutcomes: instruction.actionOutcomes,
      actionRunConditions: instruction.actionRunConditions,
    };
    try {
      if (instruction.sourceKind === "post_action_condition") {
        const conversion = convertLegacyActionRouting({
          graph,
          sourceActionNodeId: instruction.sourceActionNodeId,
          conditionNodeId: instruction.sourceNodeId,
          patch,
        });
        graph = conversion.graph;
        converted.push({
          sourceActionNodeId: conversion.sourceActionNodeId,
          sourceNodeId: conversion.conditionNodeId,
          virtualConditionNodeId: conversion.virtualConditionNodeId,
        });
      } else {
        const conversion = convertLegacyAudienceGate({
          graph,
          sourceActionNodeId: instruction.sourceActionNodeId,
          gateNodeId: instruction.sourceNodeId,
          patch,
        });
        graph = conversion.graph;
        converted.push({
          sourceActionNodeId: conversion.sourceActionNodeId,
          sourceNodeId: conversion.gateNodeId,
        });
      }
    } catch (error) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_not_eligible",
        409,
        "Legacy routing is no longer eligible for automatic conversion.",
        { cause: error }
      );
    }
  }

  return { graph, converted };
}

function isFinitePosition(value: unknown): value is { x: number; y: number } {
  if (value === null || typeof value !== "object") return false;
  const position = value as { x?: unknown; y?: unknown };
  return (
    typeof position.x === "number" &&
    Number.isFinite(position.x) &&
    typeof position.y === "number" &&
    Number.isFinite(position.y)
  );
}

function relayoutConvertedGraph(
  graph: LegacyActionRoutingGraph
): LegacyActionRoutingGraph {
  const layoutNodes = graph.nodes.map(node => ({
    ...node,
    position: isFinitePosition(node.position) ? node.position : { x: 0, y: 0 },
  }));
  const layoutEdges = graph.edges.map((edge, index) => ({
    id:
      typeof edge.id === "string" && edge.id.trim()
        ? edge.id
        : `legacy-relayout-${index}`,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  }));
  const laidOut = normalizeScenarioGraphLayout({
    nodes: layoutNodes,
    edges: layoutEdges,
  });
  const positions = new Map(
    laidOut.nodes.map(node => [node.id, node.position] as const)
  );
  return {
    nodes: graph.nodes.map(node => {
      const position = positions.get(node.id);
      return position ? { ...node, position } : node;
    }),
    edges: graph.edges,
  };
}

async function validateConvertedGraph(params: {
  graph: LegacyActionRoutingGraph;
  scenario: StoredScenario;
  scenarioId: string;
  workspaceId: string;
  session: ClientSession;
}): Promise<void> {
  const isRunnable = params.scenario.status === "active";
  const whatsappQrBindings = isRunnable
    ? collectWhatsAppQrGraphBindings(params.graph.nodes)
    : [];
  const completedWhatsAppFlowProvisioningOperations = isRunnable
    ? await loadCompletedWhatsAppFlowProvisioningOperations({
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        nodes: params.graph.nodes,
        session: params.session,
      })
    : [];
  const currentWhatsAppSourceWabaBindings = isRunnable
    ? await loadCurrentWhatsAppSourceWabaBindings({
        workspaceId: params.workspaceId,
        sourceIds: collectScenarioWhatsAppFlowProviderSourceIds(
          params.graph.nodes,
          completedWhatsAppFlowProvisioningOperations.map(
            operation => operation.sourceId
          )
        ),
      })
    : {};
  const whatsappQrEntryPointReadiness =
    whatsappQrBindings.length > 0
      ? await loadWhatsAppQrEntryPointReadinessByBindings({
          workspaceId: params.workspaceId,
          scenarioId: params.scenarioId,
          bindings: whatsappQrBindings,
          session: params.session,
        })
      : {};
  const graphValidationError = validateScenarioGraph(
    params.graph.nodes,
    params.graph.edges,
    {
      mode: isRunnable ? "runnable" : "draft",
      ...(params.scenario.mode === "bulk_campaign"
        ? { scenarioMode: "bulk_campaign" as const }
        : {}),
      ...(isRunnable
        ? {
            completedWhatsAppFlowProvisioningOperations,
            currentWhatsAppSourceWabaBindings,
            whatsappQrEntryPointReadiness,
          }
        : {}),
    }
  );
  if (graphValidationError) {
    throw new LegacyRoutingConversionError(
      graphValidationError,
      400,
      "Converted scenario graph is invalid."
    );
  }

  const linkResolution = resolveSubscenarioLinkSummary({
    scenarioId: params.scenarioId,
    nodes: params.graph.nodes,
    edges: params.graph.edges,
  });
  if (linkResolution.errors.length > 0) {
    throw new LegacyRoutingConversionError(
      linkResolution.errors[0],
      400,
      "Converted sub-scenario links are invalid."
    );
  }
}

function rowVersionFilter(
  row: Record<string, unknown>
): Record<string, unknown> {
  return {
    updatedAt: Object.hasOwn(row, "updatedAt")
      ? row.updatedAt
      : { $exists: false },
    __v: Object.hasOwn(row, "__v") ? row.__v : { $exists: false },
  };
}

function conditionConversionsByPair(
  converted: ConvertedLegacyRouting[]
): Map<string, ConvertedLegacyRouting & { virtualConditionNodeId: string }> {
  const indexed = new Map<
    string,
    ConvertedLegacyRouting & { virtualConditionNodeId: string }
  >();
  for (const conversion of converted) {
    const virtualConditionNodeId = conversion.virtualConditionNodeId;
    if (!virtualConditionNodeId) continue;
    indexed.set(conversionPairKey(conversion), {
      ...conversion,
      virtualConditionNodeId,
    });
  }
  return indexed;
}

async function remapPendingConversations(params: {
  workspaceId: string;
  scenarioId: string;
  rows: Array<Record<string, unknown>>;
  converted: ConvertedLegacyRouting[];
  updatedAt: Date;
  session: ClientSession;
}): Promise<RemappedPendingConversation[]> {
  const conversions = conditionConversionsByPair(params.converted);
  const remapped: RemappedPendingConversation[] = [];

  for (const row of params.rows) {
    const state = asNullableRecord(row.airi_scenario_state);
    const conversion = state
      ? conversions.get(
          conversionPairKey({
            sourceActionNodeId: readId(state.pendingSourceActionNodeId),
            sourceNodeId: readId(state.pendingConditionNodeId),
          })
        )
      : undefined;
    if (!state || !conversion) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_preimage_invalid",
        409,
        "The reviewed pending-conversation preimage no longer matches the conversion target."
      );
    }

    const anchorId = readId(state.pendingLastOutboundMessageId);
    const pendingStartedAt = normalizeScenarioRevision(state.pendingStartedAt);
    if (!anchorId || !pendingStartedAt) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_pending_timer_identity_invalid",
        409,
        "A pending conversation is missing the exact timer identity required for lossless recovery."
      );
    }

    const update = await Conversation.updateOne(
      {
        _id: row._id,
        workspaceId: params.workspaceId,
        ...rowVersionFilter(row),
        "airi_scenario_state.lockedScenarioId": readId(state.lockedScenarioId),
        "airi_scenario_state.pendingConditionNodeId": conversion.sourceNodeId,
        "airi_scenario_state.pendingSourceActionNodeId":
          conversion.sourceActionNodeId,
      },
      {
        $set: {
          "airi_scenario_state.pendingConditionNodeId":
            conversion.virtualConditionNodeId,
          updatedAt: params.updatedAt,
        },
        $unset: { "airi_scenario_state.pendingLegacyRouting": "" },
        $inc: { __v: 1 },
      },
      { session: params.session, timestamps: false }
    );
    if (update.matchedCount !== 1 || update.modifiedCount !== 1) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_pending_remap_conflict",
        409,
        "A pending conversation changed while legacy routing was being converted."
      );
    }
    let timerIngress: TimerReplanIngressDocument;
    try {
      timerIngress = await enqueueTimerReplanIngress({
        workspaceId: params.workspaceId,
        conversationId: readId(row._id),
        expectedScenarioId: params.scenarioId,
        expectedConditionNodeId: conversion.virtualConditionNodeId,
        expectedSourceActionNodeId: conversion.sourceActionNodeId,
        anchorId,
        messageDate: pendingStartedAt,
        enqueuedAt: params.updatedAt,
        session: params.session,
      });
    } catch (error) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_timer_ingress_enqueue_failed",
        503,
        "The pending timer recovery record could not be committed atomically.",
        { cause: error }
      );
    }
    remapped.push({
      conversationId: readId(row._id),
      sourceActionNodeId: conversion.sourceActionNodeId,
      virtualConditionNodeId: conversion.virtualConditionNodeId,
      timerIngressKey: timerIngress.ingressKey,
    });
  }
  return remapped;
}

async function remapLinkedConditionParentRefs(params: {
  workspaceId: string;
  scenarioId: string;
  rows: Array<Record<string, unknown>>;
  converted: ConvertedLegacyRouting[];
  updatedAt: Date;
  session: ClientSession;
}): Promise<void> {
  const conversions = conditionConversionsByPair(params.converted);

  for (const row of params.rows) {
    if (!(row._id instanceof Types.ObjectId)) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_preimage_invalid",
        409,
        "The reviewed linked-condition preimage has an invalid identifier."
      );
    }
    if (!Array.isArray(row.parentRefs)) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_preimage_invalid",
        409,
        "The reviewed linked-condition preimage no longer matches the conversion target."
      );
    }
    let changed = false;
    const convertedParentRefs = row.parentRefs.map(value => {
      const parentRef = asNullableRecord(value);
      if (
        !parentRef ||
        readId(parentRef.parentScenarioId) !== params.scenarioId
      ) {
        return value;
      }
      const conversion = conversions.get(
        conversionPairKey({
          sourceActionNodeId: readId(parentRef.sourceActionNodeId),
          sourceNodeId: readId(parentRef.conditionNodeId),
        })
      );
      if (!conversion) return value;
      changed = true;
      return {
        ...parentRef,
        conditionNodeId: conversion.virtualConditionNodeId,
      };
    });
    if (!changed) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_preimage_invalid",
        409,
        "The reviewed linked-condition preimage no longer matches the conversion target."
      );
    }

    const normalizedRefs: LinkedConditionParentRef[] = [];
    const nextParentRefs: unknown[] = [];
    for (const parentRef of convertedParentRefs) {
      const normalized = normalizeParentRefs([
        parentRef as LinkedConditionParentRef,
      ])[0];
      if (normalized) {
        const deduped = dedupeParentRefs([...normalizedRefs, normalized]);
        if (deduped.length === normalizedRefs.length) continue;
        normalizedRefs.push(normalized);
      }
      nextParentRefs.push(parentRef);
    }

    const update = await ScenarioLinkedCondition.collection.updateOne(
      {
        _id: row._id,
        workspaceId: params.workspaceId,
        ...rowVersionFilter(row),
        parentRefs: row.parentRefs,
      },
      {
        $set: { parentRefs: nextParentRefs, updatedAt: params.updatedAt },
        $inc: { __v: 1 },
      },
      { session: params.session }
    );
    if (update.matchedCount !== 1 || update.modifiedCount !== 1) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_linked_remap_conflict",
        409,
        "A linked condition changed while legacy routing was being converted."
      );
    }
  }
}

export async function convertLegacyRoutingInTransaction(params: {
  scenarioId: string;
  workspaceId: string;
  updatedBy: string;
  expectedUpdatedAt: string | Date;
  expectedPreimageSha256?: string;
  conversions: LegacyRoutingConversionInstruction[];
  expectedDedicatedAssignmentCount?: number;
  relayout?: boolean;
}): Promise<LegacyRoutingConversionTransactionResult> {
  const expectedUpdatedAt = normalizeScenarioRevision(params.expectedUpdatedAt);
  if (!expectedUpdatedAt || params.conversions.length === 0) {
    throw new LegacyRoutingConversionError(
      !expectedUpdatedAt
        ? "scenario_updated_conflict"
        : "legacy_action_routing_invalid_request",
      !expectedUpdatedAt ? 409 : 400,
      !expectedUpdatedAt
        ? "Reload the latest scenario before converting legacy routing."
        : "At least one legacy routing conversion is required."
    );
  }

  if (
    params.conversions.some(
      conversion => conversion.sourceKind === "post_action_condition"
    )
  ) {
    try {
      await assertTimerReplanIngressIndexes();
    } catch (error) {
      throw new LegacyRoutingConversionError(
        "legacy_action_routing_timer_ingress_unavailable",
        503,
        "Legacy routing conversion requires the durable timer-replan ingress indexes.",
        { cause: error }
      );
    }
  }

  const session = (await Scenario.startSession()) as ClientSession;
  let sessionCleanupError: unknown;
  let committed:
    | {
        scenario: StoredScenario;
        beforeRevision: string;
        afterRevision: string;
        converted: ConvertedLegacyRouting[];
        remapped: RemappedPendingConversation[];
      }
    | undefined;

  try {
    committed = await session.withTransaction(async () => {
      const candidatePairs = params.conversions.flatMap(conversion =>
        conversion.sourceKind === "post_action_condition"
          ? [
              {
                sourceActionNodeId: conversion.sourceActionNodeId,
                sourceNodeId: conversion.sourceNodeId,
              },
            ]
          : []
      );
      const loaded = await loadLegacyRoutingMigrationState({
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        candidatePairs,
        session,
      });
      if (!loaded) {
        throw new LegacyRoutingConversionError(
          "scenario_not_found",
          404,
          "Scenario not found"
        );
      }
      const { preimage } = loaded;
      if (
        params.expectedPreimageSha256 &&
        preimage.preimageSha256 !== params.expectedPreimageSha256
      ) {
        throw new LegacyRoutingConversionError(
          "legacy_action_routing_preimage_mismatch",
          409,
          "The scenario or its external routing state changed after review."
        );
      }
      const externalStateIssues =
        classifyLegacyRoutingMigrationExternalState(preimage);
      if (externalStateIssues.length > 0) {
        throw new LegacyRoutingConversionError(
          "legacy_action_routing_external_state_invalid",
          409,
          "A pending conversation or linked condition targets a removed condition from the wrong source action."
        );
      }
      const rawCurrent = loaded.raw.scenario as StoredScenario;
      const current = loaded.semantic.scenario as StoredScenario;
      const rawScenarioId = rawCurrent._id;
      if (!(rawScenarioId instanceof Types.ObjectId)) {
        throw new LegacyRoutingConversionError(
          "legacy_action_routing_preimage_invalid",
          409,
          "The reviewed scenario preimage has an invalid identifier."
        );
      }

      const currentUpdatedAt = normalizeScenarioRevision(current.updatedAt);
      if (
        !currentUpdatedAt ||
        currentUpdatedAt.getTime() !== expectedUpdatedAt.getTime()
      ) {
        throw new LegacyRoutingConversionError(
          "scenario_updated_conflict",
          409,
          "This scenario changed before legacy routing could be converted."
        );
      }

      const originalGraph = {
        nodes: indexGraphMembers(asScenarioGraphNodes(current.nodes)),
        edges: indexGraphMembers(asScenarioGraphEdges(current.edges)),
      } as LegacyActionRoutingGraph;
      assertExpectedDedicatedAssignments({
        graph: originalGraph,
        conversions: params.conversions,
        expectedCount: params.expectedDedicatedAssignmentCount,
      });
      const conversion = convertGraph({
        graph: originalGraph,
        conversions: params.conversions,
      });
      if (params.relayout) {
        conversion.graph = relayoutConvertedGraph(conversion.graph);
      }
      await validateConvertedGraph({
        graph: conversion.graph,
        scenario: current,
        scenarioId: params.scenarioId,
        workspaceId: params.workspaceId,
        session,
      });

      const updatedAt = nextRevisionDate(currentUpdatedAt);
      const remapped = await remapPendingConversations({
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        rows: loaded.raw.pendingConversations,
        converted: conversion.converted,
        updatedAt,
        session,
      });
      await remapLinkedConditionParentRefs({
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        rows: loaded.raw.linkedConditions,
        converted: conversion.converted,
        updatedAt,
        session,
      });
      const normalizedGraph = normalizeScenarioGraphForPersistence({
        nodes: conversion.graph.nodes,
        edges: conversion.graph.edges,
      });
      const losslessGraph = projectConvertedGraphOntoRaw({
        rawNodes: rawCurrent.nodes,
        rawEdges: rawCurrent.edges,
        semanticNodes: originalGraph.nodes,
        semanticEdges: originalGraph.edges,
        // Persist only the explicit routing conversion onto the raw BSON
        // graph. The general persistence normalizer is still used for the
        // schema version, but projecting its whole graph here would also
        // rewrite unrelated historical or forward-compatible node fields.
        convertedNodes: conversion.graph.nodes,
        convertedEdges: conversion.graph.edges,
      });
      const nextScenario = (await Scenario.collection.findOneAndUpdate(
        {
          _id: rawScenarioId,
          workspaceId: params.workspaceId,
          deletedAt: null,
          updatedAt: rawCurrent.updatedAt,
          ...(Object.hasOwn(rawCurrent, "__v")
            ? { __v: rawCurrent.__v }
            : { __v: { $exists: false } }),
        },
        {
          $set: {
            graphSchemaVersion: normalizedGraph.graphSchemaVersion,
            nodes: losslessGraph.nodes,
            edges: losslessGraph.edges,
            updatedBy: params.updatedBy,
            updatedAt,
          },
          $inc: { __v: 1 },
        },
        {
          returnDocument: "after",
          includeResultMetadata: false,
          promoteValues: true,
          promoteLongs: true,
          promoteBuffers: false,
          session,
        }
      )) as StoredScenario | null;
      if (!nextScenario) {
        throw new LegacyRoutingConversionError(
          "scenario_updated_conflict",
          409,
          "This scenario changed before legacy routing could be committed."
        );
      }

      const nextUpdatedAt = normalizeScenarioRevision(nextScenario.updatedAt);
      return {
        scenario: nextScenario,
        beforeRevision: currentUpdatedAt.toISOString(),
        afterRevision: (nextUpdatedAt || updatedAt).toISOString(),
        converted: conversion.converted,
        remapped,
      };
    });
  } finally {
    try {
      await session.endSession();
    } catch (error) {
      sessionCleanupError = error;
    }
  }

  if (!committed) {
    throw new LegacyRoutingConversionError(
      "legacy_action_routing_transaction_failed",
      500,
      "Legacy routing conversion did not commit."
    );
  }

  const timerReplanResults: LegacyRoutingConversionTimerReplanResult[] = [];
  let timerReplanFailures: LegacyRoutingConversionTimerReplanFailure[] = [];
  const postCommitWarnings: LegacyRoutingConversionPostCommitWarning[] = [];
  const buildCommittedResult =
    (): LegacyRoutingConversionTransactionResult => ({
      scenario: committed.scenario,
      beforeRevision: committed.beforeRevision,
      afterRevision: committed.afterRevision,
      convertedConditionNodeIds: committed.converted.flatMap(conversion =>
        conversion.virtualConditionNodeId ? [conversion.sourceNodeId] : []
      ),
      convertedActionNodeIds: Array.from(
        new Set(
          committed.converted.map(conversion => conversion.sourceActionNodeId)
        )
      ),
      remappedConversationIds: committed.remapped.map(
        remapped => remapped.conversationId
      ),
      timerReplanResults,
      postCommitWarnings: [...postCommitWarnings],
    });

  let timerProcessingError: unknown;
  if (committed.remapped.length > 0) {
    try {
      const batch = await processTimerReplanIngressKeys({
        ingressKeys: committed.remapped.map(
          remapped => remapped.timerIngressKey
        ),
      });
      const processedByKey = new Map(
        batch.results.map(result => [result.ingressKey, result] as const)
      );
      for (const remapped of committed.remapped) {
        const processed = processedByKey.get(remapped.timerIngressKey);
        if (!processed) {
          timerReplanFailures.push({
            conversationId: remapped.conversationId,
            status: "rejected",
            reason:
              "The durable timer-replan ingress was not claimed for immediate processing.",
          });
          continue;
        }
        const result = timerReplanResultFromIngress({ remapped, processed });
        timerReplanResults.push(result);
        if (!isSuccessfulTimerIngressResult(processed)) {
          timerReplanFailures.push({
            conversationId: remapped.conversationId,
            status: "non_success",
            result,
          });
        }
      }
    } catch (error) {
      timerProcessingError = error;
      const reason = error instanceof Error ? error.message : String(error);
      timerReplanFailures = committed.remapped.map(remapped => ({
        conversationId: remapped.conversationId,
        status: "rejected",
        reason,
      }));
    }
  }

  if (timerReplanFailures.length > 0) {
    const terminalFailure = timerReplanFailures.some(
      failure =>
        failure.status === "non_success" &&
        failure.result.reason === "timer_replan_ingress_failed"
    );
    postCommitWarnings.push({
      code: "legacy_action_routing_timer_replan_failed",
      message:
        "Legacy routing committed, but at least one pending timer is waiting for durable recovery.",
      affectedConversationIds: Array.from(
        new Set(timerReplanFailures.map(failure => failure.conversationId))
      ).sort(),
      recoveryStatus: terminalFailure ? "failed" : "pending",
      retryable: terminalFailure,
    });
  }
  if (sessionCleanupError !== undefined) {
    postCommitWarnings.push({
      code: "legacy_action_routing_session_cleanup_failed",
      message:
        "Legacy routing committed, but the database session could not be cleaned up.",
      affectedConversationIds: [],
    });
  }

  const committedResult = buildCommittedResult();
  if (postCommitWarnings.length === 0) return committedResult;

  const timerFailed = timerReplanFailures.length > 0;
  const causes = [
    ...(timerFailed ? [timerProcessingError ?? timerReplanFailures[0]] : []),
    ...(sessionCleanupError === undefined ? [] : [sessionCleanupError]),
  ];
  throw new LegacyRoutingConversionError(
    timerFailed
      ? "legacy_action_routing_timer_replan_failed"
      : "legacy_action_routing_session_cleanup_failed",
    500,
    timerFailed
      ? "Legacy routing committed, but pending timer replanning could not complete immediately."
      : "Legacy routing committed, but the database session could not be cleaned up.",
    {
      committed: true,
      committedResult,
      timerReplanResults,
      timerReplanFailures,
      cause:
        causes.length > 1
          ? new AggregateError(causes, "Multiple post-commit operations failed")
          : causes[0],
    }
  );
}
