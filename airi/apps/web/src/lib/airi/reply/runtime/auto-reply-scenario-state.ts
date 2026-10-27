import {
  ScenarioPendingWriteCoordinationError,
  isScenarioPendingWriteCoordinationError,
  type PendingScenarioStateExpectation,
  type PersistScenarioStateParams,
  type ClearPendingConditionStateAndPersistParams,
  type PersistPendingConditionStateParams,
  type CompleteLockedScenarioAndPersistParams,
  type FinalizeScenarioResolutionParams,
  type PersistScenarioFormSubmissionParams,
  type RecordScenarioLocationDecisionParams,
} from "@icecore/airi-runtime/scenario-runtime-dependencies";
import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import type { Channel, ConversationDocument } from "@/types/models";
import type { ClientSession } from "mongoose";
import {
  getScenarioActionOutcomeVirtualNodeId,
  normalizeScenarioActionOutcomes,
  normalizeScenarioRoutedLocations,
  recordScenarioFormSubmission,
  recordScenarioRoutedLocation,
} from "@icecore/scenario-contracts";
import { resolveActiveScenarioRuntime } from "@/lib/airi/scenario/scenario-runtime";
import { type AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import {
  normalizeConversationScenarioState,
  normalizeScenarioPendingLegacyRouting,
  type ScenarioPendingLegacyRouting,
  type ScenarioCompletionEntry,
  type ScenarioStartedEntry,
  type ConversationScenarioState,
} from "@icecore/airi-runtime/scenario-state";
import { hasBlockingScenarioRoutingDiagnostics } from "@icecore/scenario-contracts";
import {
  compileScenarioGraph,
  parseEdges,
  parseNodes,
} from "@icecore/airi-runtime/scenario-graph";
import {
  analyzeDedicatedInteractiveNoReplyAssignment,
  type LegacyActionRoutingGraph,
} from "@/lib/scenarios/legacy-action-routing";
import { readDate } from "@icecore/shared/lib/value-utils";

type PersistedScenarioCompletionEntry = Omit<
  ScenarioCompletionEntry,
  "completedAt"
> & {
  completedAt: Date;
};

type PersistedScenarioStartedEntry = Omit<ScenarioStartedEntry, "startedAt"> & {
  startedAt: Date;
};

type PersistedScenarioState = {
  behaviorRunId: string | null;
  lockedScenarioId: string | null;
  lockedScenarioName: string | null;
  currentActionNodeId: string | null;
  scenarioRevisionFingerprint: string | null;
  currentPathNodeIds: string[];
  currentBranchNodeIds: string[];
  pendingConditionNodeId: string | null;
  pendingSourceActionNodeId: string | null;
  pendingStartedAt: Date | null;
  pendingScenarioUpdatedAt: Date | null;
  pendingLastOutboundMessageId: string | null;
  pendingLinkedConditionId: string | null;
  pendingLegacyRouting: ScenarioPendingLegacyRouting | null;
  lastMatchedAt: Date | null;
  lastMessageId: string | null;
  startedScenarios: PersistedScenarioStartedEntry[];
  completedScenarios: PersistedScenarioCompletionEntry[];
  collectedPromptInputs: ConversationScenarioState["collectedPromptInputs"];
  pickedOptions: ConversationScenarioState["pickedOptions"];
  formAnswers: ConversationScenarioState["formAnswers"];
  routedLocations: ConversationScenarioState["routedLocations"];
};

/**
 * Collected answers, picks, form answers and routed locations belong to the
 * scenario that recorded them.
 */
function keepForScenario<T extends { scenarioId: string }>(
  value: T | null | undefined,
  scenarioId: string
): T | null {
  return value?.scenarioId === scenarioId ? value : null;
}

type PendingWriteConversationExpectation = {
  workspaceId: string;
  expectedCurrentActionNodeId: string;
};

type PendingWriteProjection<T> = {
  update: Record<string, unknown>;
  value: T;
};

type PendingWriteCoordinatorParams<T> = {
  conversationId: string;
  scenarioId: string;
  sourceActionNodeId: string;
  conditionNodeId: string;
  baseState: unknown;
  pendingLegacyRouting?: ScenarioPendingLegacyRouting | null;
  expectation?: PendingWriteConversationExpectation;
  project: (params: {
    baseState: PersistedScenarioState;
    conditionNodeId: string;
  }) => PendingWriteProjection<T>;
};

const MAX_COMPLETED_SCENARIOS_HISTORY = 25;

function normalizeCompletedScenarios(
  value: unknown
): PersistedScenarioCompletionEntry[] {
  if (!Array.isArray(value)) return [];

  const normalized = value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const scenarioId =
      typeof raw.scenarioId === "string" ? raw.scenarioId.trim() : "";
    if (!scenarioId) return [];

    const completedAt = readDate(raw.completedAt);
    if (!completedAt) return [];

    return [
      {
        scenarioId,
        scenarioName:
          typeof raw.scenarioName === "string" ? raw.scenarioName : null,
        completedAt,
        lastActionNodeId:
          typeof raw.lastActionNodeId === "string"
            ? raw.lastActionNodeId
            : null,
        lastMessageId:
          typeof raw.lastMessageId === "string" ? raw.lastMessageId : null,
      } satisfies PersistedScenarioCompletionEntry,
    ];
  });

  normalized.sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());
  return normalized.slice(0, MAX_COMPLETED_SCENARIOS_HISTORY);
}

function normalizeStartedScenarios(
  value: unknown
): PersistedScenarioStartedEntry[] {
  if (!Array.isArray(value)) return [];

  const normalized = value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const scenarioId =
      typeof raw.scenarioId === "string" ? raw.scenarioId.trim() : "";
    if (!scenarioId) return [];

    const startedAt = readDate(raw.startedAt);
    if (!startedAt) return [];

    return [
      {
        scenarioId,
        scenarioName:
          typeof raw.scenarioName === "string" ? raw.scenarioName : null,
        startedAt,
        firstActionNodeId:
          typeof raw.firstActionNodeId === "string"
            ? raw.firstActionNodeId
            : null,
        firstMessageId:
          typeof raw.firstMessageId === "string" ? raw.firstMessageId : null,
      } satisfies PersistedScenarioStartedEntry,
    ];
  });

  return normalized.filter(
    (entry, index, source) =>
      source.findIndex(
        candidate => candidate.scenarioId === entry.scenarioId
      ) === index
  );
}

function normalizeScenarioState(value: unknown): PersistedScenarioState {
  const normalized = normalizeConversationScenarioState(value);
  if (!normalized) {
    return {
      lockedScenarioId: null,
      behaviorRunId: null,
      lockedScenarioName: null,
      currentActionNodeId: null,
      scenarioRevisionFingerprint: null,
      currentPathNodeIds: [],
      currentBranchNodeIds: [],
      pendingConditionNodeId: null,
      pendingSourceActionNodeId: null,
      pendingStartedAt: null,
      pendingScenarioUpdatedAt: null,
      pendingLastOutboundMessageId: null,
      pendingLinkedConditionId: null,
      pendingLegacyRouting: null,
      lastMatchedAt: null,
      lastMessageId: null,
      startedScenarios: [],
      completedScenarios: [],
      collectedPromptInputs: null,
      pickedOptions: null,
      formAnswers: null,
      routedLocations: null,
    };
  }

  const completedScenarios = normalizeCompletedScenarios(
    normalized.completedScenarios
  );
  const startedScenarios = normalizeStartedScenarios(
    normalized.startedScenarios
  );
  const lockedScenarioId = normalized.lockedScenarioId || null;
  const lockedScenarioName = normalized.lockedScenarioName || null;
  const currentActionNodeId = normalized.currentActionNodeId || null;
  const scenarioRevisionFingerprint =
    normalized.scenarioRevisionFingerprint || null;
  const lastMessageId = normalized.lastMessageId || null;

  return {
    lockedScenarioId,
    behaviorRunId: normalized.behaviorRunId || null,
    lockedScenarioName,
    currentActionNodeId,
    scenarioRevisionFingerprint,
    currentPathNodeIds: normalized.currentPathNodeIds || [],
    currentBranchNodeIds: normalized.currentBranchNodeIds || [],
    pendingConditionNodeId: normalized.pendingConditionNodeId || null,
    pendingSourceActionNodeId: normalized.pendingSourceActionNodeId || null,
    pendingStartedAt: readDate(normalized.pendingStartedAt),
    pendingScenarioUpdatedAt: readDate(normalized.pendingScenarioUpdatedAt),
    pendingLastOutboundMessageId:
      normalized.pendingLastOutboundMessageId || null,
    pendingLinkedConditionId: normalized.pendingLinkedConditionId || null,
    pendingLegacyRouting: normalized.pendingLegacyRouting || null,
    lastMatchedAt: readDate(normalized.lastMatchedAt),
    lastMessageId,
    startedScenarios,
    completedScenarios,
    collectedPromptInputs: normalized.collectedPromptInputs ?? null,
    pickedOptions: normalized.pickedOptions ?? null,
    formAnswers: normalized.formAnswers ?? null,
    routedLocations: normalized.routedLocations ?? null,
  };
}

function appendStartedScenarioEntry(params: {
  entries: PersistedScenarioStartedEntry[];
  scenarioRuntime: AiriScenarioRuntimeConfig;
  startedAt: Date;
  messageId: string;
}): PersistedScenarioStartedEntry[] {
  const scenarioId = params.scenarioRuntime.scenarioId.trim();
  if (!scenarioId) {
    return params.entries;
  }
  if (params.entries.some(entry => entry.scenarioId === scenarioId)) {
    return params.entries;
  }
  return [
    {
      scenarioId,
      scenarioName: params.scenarioRuntime.scenarioName || null,
      startedAt: params.startedAt,
      firstActionNodeId:
        params.scenarioRuntime.selectedActionNodeId ??
        params.scenarioRuntime.nextActionNodeId ??
        null,
      firstMessageId: params.messageId || null,
    },
    ...params.entries,
  ];
}

function buildStateWithRuntimeMatch(params: {
  baseState: PersistedScenarioState;
  scenarioRuntime: AiriScenarioRuntimeConfig;
  messageId: string;
  now?: Date;
}): PersistedScenarioState {
  const now = params.now || new Date();

  return {
    ...params.baseState,
    lockedScenarioId: params.scenarioRuntime.scenarioId,
    behaviorRunId: /^customer-behavior:[a-f0-9]{24}$/.test(params.messageId)
      ? params.messageId.slice("customer-behavior:".length)
      : params.baseState.lockedScenarioId === params.scenarioRuntime.scenarioId
        ? params.baseState.behaviorRunId
        : null,
    lockedScenarioName: params.scenarioRuntime.scenarioName,
    scenarioRevisionFingerprint:
      params.scenarioRuntime.scenarioRevisionFingerprint ??
      (params.baseState.lockedScenarioId === params.scenarioRuntime.scenarioId
        ? params.baseState.scenarioRevisionFingerprint
        : null),
    currentActionNodeId:
      params.scenarioRuntime.nextActionNodeId ??
      params.scenarioRuntime.selectedActionNodeId ??
      null,
    currentPathNodeIds: params.scenarioRuntime.selectedPathNodeIds || [],
    currentBranchNodeIds: params.scenarioRuntime.selectedBranchNodeIds || [],
    pendingConditionNodeId: null,
    pendingSourceActionNodeId: null,
    pendingStartedAt: null,
    pendingScenarioUpdatedAt: null,
    pendingLastOutboundMessageId: null,
    pendingLinkedConditionId: null,
    pendingLegacyRouting: null,
    lastMatchedAt: now,
    lastMessageId: params.messageId,
    startedScenarios: appendStartedScenarioEntry({
      entries: params.baseState.startedScenarios,
      scenarioRuntime: params.scenarioRuntime,
      startedAt: now,
      messageId: params.messageId,
    }),
    collectedPromptInputs: keepForScenario(
      params.baseState.collectedPromptInputs,
      params.scenarioRuntime.scenarioId
    ),
    pickedOptions: keepForScenario(
      params.baseState.pickedOptions,
      params.scenarioRuntime.scenarioId
    ),
    formAnswers: keepForScenario(
      params.baseState.formAnswers,
      params.scenarioRuntime.scenarioId
    ),
    routedLocations: keepForScenario(
      params.baseState.routedLocations,
      params.scenarioRuntime.scenarioId
    ),
  };
}

function buildStateWithPendingCondition(params: {
  baseState: PersistedScenarioState;
  scenarioRuntime: AiriScenarioRuntimeConfig;
  startedAt: Date;
  lastMessageId?: string | null;
  pendingLastOutboundMessageId?: string | null;
}): PersistedScenarioState {
  return {
    ...params.baseState,
    lockedScenarioId: params.scenarioRuntime.scenarioId,
    lockedScenarioName: params.scenarioRuntime.scenarioName,
    scenarioRevisionFingerprint:
      params.scenarioRuntime.scenarioRevisionFingerprint ??
      (params.baseState.lockedScenarioId === params.scenarioRuntime.scenarioId
        ? params.baseState.scenarioRevisionFingerprint
        : null),
    currentActionNodeId: params.scenarioRuntime.selectedActionNodeId || null,
    currentPathNodeIds: params.scenarioRuntime.selectedPathNodeIds || [],
    currentBranchNodeIds: params.scenarioRuntime.selectedBranchNodeIds || [],
    pendingConditionNodeId:
      params.scenarioRuntime.pendingConditionNodeId || null,
    pendingSourceActionNodeId:
      params.scenarioRuntime.pendingSourceActionNodeId || null,
    pendingStartedAt: params.startedAt,
    pendingScenarioUpdatedAt: readDate(
      params.scenarioRuntime.scenarioUpdatedAt
    ),
    pendingLastOutboundMessageId:
      params.pendingLastOutboundMessageId || params.lastMessageId || null,
    pendingLinkedConditionId:
      params.scenarioRuntime.pendingLinkedConditionId || null,
    pendingLegacyRouting: normalizeScenarioPendingLegacyRouting({
      value: params.scenarioRuntime.pendingLegacyRouting,
      conditionNodeId: params.scenarioRuntime.pendingConditionNodeId || "",
      sourceActionNodeId:
        params.scenarioRuntime.pendingSourceActionNodeId || "",
    }),
    lastMatchedAt: params.startedAt,
    lastMessageId:
      params.lastMessageId || params.baseState.lastMessageId || null,
  };
}

function buildStateWithClearedLock(
  baseState: PersistedScenarioState
): PersistedScenarioState {
  return {
    ...baseState,
    lockedScenarioId: null,
    behaviorRunId: null,
    lockedScenarioName: null,
    scenarioRevisionFingerprint: null,
    currentActionNodeId: null,
    currentPathNodeIds: [],
    currentBranchNodeIds: [],
    pendingConditionNodeId: null,
    pendingSourceActionNodeId: null,
    pendingStartedAt: null,
    pendingScenarioUpdatedAt: null,
    pendingLastOutboundMessageId: null,
    pendingLinkedConditionId: null,
    pendingLegacyRouting: null,
    collectedPromptInputs: null,
    pickedOptions: null,
    formAnswers: null,
    routedLocations: null,
  };
}

function buildStateWithClearedPendingCondition(
  baseState: PersistedScenarioState
): PersistedScenarioState {
  return {
    ...baseState,
    pendingConditionNodeId: null,
    pendingSourceActionNodeId: null,
    pendingStartedAt: null,
    pendingScenarioUpdatedAt: null,
    pendingLastOutboundMessageId: null,
    pendingLinkedConditionId: null,
    pendingLegacyRouting: null,
  };
}

function buildStateWithCompletedScenario(params: {
  baseState: PersistedScenarioState;
  scenarioId: string;
  scenarioName: string;
  completedAt: Date;
  lastActionNodeId?: string | null;
  lastMessageId?: string | null;
}): PersistedScenarioState {
  const nextHistory: PersistedScenarioCompletionEntry[] = [
    {
      scenarioId: params.scenarioId,
      scenarioName: params.scenarioName || null,
      completedAt: params.completedAt,
      lastActionNodeId: params.lastActionNodeId || null,
      lastMessageId: params.lastMessageId || null,
    },
    ...params.baseState.completedScenarios.filter(
      item => item.scenarioId !== params.scenarioId
    ),
  ].slice(0, MAX_COMPLETED_SCENARIOS_HISTORY);

  return {
    ...buildStateWithClearedLock(params.baseState),
    completedScenarios: nextHistory,
    lastMatchedAt: params.completedAt,
    lastMessageId:
      params.lastMessageId || params.baseState.lastMessageId || null,
  };
}

function serializeScenarioStateForMongo(
  state: PersistedScenarioState
): Record<string, unknown> {
  return {
    lockedScenarioId: state.lockedScenarioId,
    behaviorRunId: state.behaviorRunId,
    lockedScenarioName: state.lockedScenarioName,
    currentActionNodeId: state.currentActionNodeId,
    scenarioRevisionFingerprint: state.scenarioRevisionFingerprint,
    currentPathNodeIds: state.currentPathNodeIds,
    currentBranchNodeIds: state.currentBranchNodeIds,
    pendingConditionNodeId: state.pendingConditionNodeId,
    pendingSourceActionNodeId: state.pendingSourceActionNodeId,
    pendingStartedAt: state.pendingStartedAt,
    pendingScenarioUpdatedAt: state.pendingScenarioUpdatedAt,
    pendingLastOutboundMessageId: state.pendingLastOutboundMessageId,
    pendingLinkedConditionId: state.pendingLinkedConditionId,
    pendingLegacyRouting: state.pendingLegacyRouting,
    lastMatchedAt: state.lastMatchedAt,
    lastMessageId: state.lastMessageId,
    startedScenarios: state.startedScenarios.map(item => ({
      scenarioId: item.scenarioId,
      scenarioName: item.scenarioName,
      startedAt: item.startedAt,
      firstActionNodeId: item.firstActionNodeId,
      firstMessageId: item.firstMessageId,
    })),
    completedScenarios: state.completedScenarios.map(item => ({
      scenarioId: item.scenarioId,
      scenarioName: item.scenarioName,
      completedAt: item.completedAt,
      lastActionNodeId: item.lastActionNodeId,
      lastMessageId: item.lastMessageId,
    })),
    collectedPromptInputs: state.collectedPromptInputs ?? null,
    pickedOptions: state.pickedOptions ?? null,
    formAnswers: state.formAnswers ?? null,
    routedLocations: state.routedLocations ?? null,
  };
}

function buildScenarioStateUpdate(
  state: PersistedScenarioState
): Record<string, unknown> {
  return {
    $set: {
      airi_scenario_state: serializeScenarioStateForMongo(state),
    },
  };
}

function isCanonicalActionOutcomeWait(params: {
  conditionNodeId: string;
  sourceActionNodeId: string;
}): boolean {
  return (
    params.conditionNodeId.trim() ===
    getScenarioActionOutcomeVirtualNodeId(params.sourceActionNodeId)
  );
}

function buildPendingWriteConversationFilter(params: {
  conversationId: string;
  scenarioId: string;
  expectation?: PendingWriteConversationExpectation;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = { _id: params.conversationId };
  if (!params.expectation) return filter;

  return {
    ...filter,
    workspaceId: params.expectation.workspaceId,
    airi_handoff_active: { $ne: true },
    "airi_scenario_state.lockedScenarioId": params.scenarioId,
    "airi_scenario_state.currentActionNodeId":
      params.expectation.expectedCurrentActionNodeId,
    $or: [
      { "airi_scenario_state.pendingConditionNodeId": null },
      { "airi_scenario_state.pendingConditionNodeId": "" },
      { "airi_scenario_state.pendingConditionNodeId": { $exists: false } },
    ],
  };
}

function currentGraphProvesCanonicalOutcomeWait(params: {
  graph: ReturnType<typeof compileScenarioGraph>;
  sourceActionNodeId: string;
}): boolean {
  const actionNode = params.graph.nodesById.get(params.sourceActionNodeId);
  if (actionNode?.data.kind !== "action") return false;

  const outcomes = normalizeScenarioActionOutcomes(
    actionNode.data.actionOutcomes
  );
  if (
    outcomes.status !== "supported" ||
    (outcomes.value.noReply?.enabled !== true &&
      !outcomes.value.answerMatches?.length)
  ) {
    return false;
  }

  const virtualConditionNodeId = getScenarioActionOutcomeVirtualNodeId(
    params.sourceActionNodeId
  );
  return params.graph.nodesById.has(virtualConditionNodeId);
}

function currentGraphProvesExactLegacyAssignment(params: {
  nodes: ReturnType<typeof parseNodes>;
  edges: ReturnType<typeof parseEdges>;
  conditionNodeId: string;
  sourceActionNodeId: string;
}): boolean {
  const graph: LegacyActionRoutingGraph = {
    nodes: params.nodes,
    edges: params.edges.flatMap(edge =>
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
  };
  const analysis = analyzeDedicatedInteractiveNoReplyAssignment({
    graph,
    conditionNodeId: params.conditionNodeId,
    sourceActionNodeId: params.sourceActionNodeId,
  });
  return analysis !== null;
}

function resolveCurrentPendingConditionNodeId(params: {
  scenario: { nodes?: unknown; edges?: unknown };
  requestedConditionNodeId: string;
  sourceActionNodeId: string;
}): string {
  const nodes = parseNodes(params.scenario.nodes);
  const edges = parseEdges(params.scenario.edges);
  const graph = compileScenarioGraph(nodes, edges);
  if (hasBlockingScenarioRoutingDiagnostics(graph.diagnostics)) {
    throw new ScenarioPendingWriteCoordinationError(
      "scenario_routing_changed",
      "Scenario routing is invalid while persisting a pending wait."
    );
  }

  if (graph.nodesById.has(params.requestedConditionNodeId)) {
    if (
      currentGraphProvesExactLegacyAssignment({
        nodes,
        edges,
        conditionNodeId: params.requestedConditionNodeId,
        sourceActionNodeId: params.sourceActionNodeId,
      })
    ) {
      return params.requestedConditionNodeId;
    }
    throw new ScenarioPendingWriteCoordinationError(
      "scenario_routing_changed",
      "The current scenario no longer routes this action to the pending condition."
    );
  }

  if (
    currentGraphProvesCanonicalOutcomeWait({
      graph,
      sourceActionNodeId: params.sourceActionNodeId,
    })
  ) {
    return getScenarioActionOutcomeVirtualNodeId(params.sourceActionNodeId);
  }

  throw new ScenarioPendingWriteCoordinationError(
    "scenario_routing_changed",
    "The pending condition no longer exists in the current scenario."
  );
}

async function coordinatePendingScenarioWrite<T>(
  params: PendingWriteCoordinatorParams<T>
): Promise<T> {
  const scenarioId = params.scenarioId.trim();
  const sourceActionNodeId = params.sourceActionNodeId.trim();
  const conditionNodeId = params.conditionNodeId.trim();
  if (!scenarioId || !sourceActionNodeId || !conditionNodeId) {
    throw new ScenarioPendingWriteCoordinationError(
      "scenario_routing_changed",
      "Pending scenario routing identifiers are incomplete."
    );
  }

  const conversationFilter = buildPendingWriteConversationFilter({
    conversationId: params.conversationId,
    scenarioId,
    expectation: params.expectation,
  });
  const pendingLegacyRouting = normalizeScenarioPendingLegacyRouting({
    value: params.pendingLegacyRouting,
    conditionNodeId,
    sourceActionNodeId,
  });
  const pendingLegacyRoutingWasProvided =
    params.pendingLegacyRouting !== null &&
    params.pendingLegacyRouting !== undefined;
  if (
    pendingLegacyRoutingWasProvided &&
    (!pendingLegacyRouting ||
      isCanonicalActionOutcomeWait({ conditionNodeId, sourceActionNodeId }))
  ) {
    throw new ScenarioPendingWriteCoordinationError(
      "scenario_routing_changed",
      "Legacy pending-routing provenance does not match the requested wait."
    );
  }
  if (!pendingLegacyRouting) {
    const projection = params.project({
      baseState: normalizeScenarioState(params.baseState),
      conditionNodeId,
    });
    let update: { matchedCount?: number };
    try {
      update = await Conversation.updateOne(
        conversationFilter,
        projection.update
      );
    } catch (error) {
      throw new ScenarioPendingWriteCoordinationError(
        "conversation_write_failed",
        "Pending conversation state could not be saved.",
        error
      );
    }
    if (update.matchedCount === 0) {
      throw new ScenarioPendingWriteCoordinationError(
        "conversation_state_changed",
        "Conversation state changed before the pending wait could be saved."
      );
    }
    return projection.value;
  }

  const scenarioFilter: Record<string, unknown> = {
    _id: scenarioId,
    status: "active",
    deletedAt: null,
    ...(params.expectation
      ? { workspaceId: params.expectation.workspaceId }
      : {}),
  };
  let session: ClientSession;
  try {
    session = (await Scenario.startSession()) as ClientSession;
  } catch (error) {
    throw new ScenarioPendingWriteCoordinationError(
      "scenario_write_conflict",
      "Pending wait transaction could not start.",
      error
    );
  }
  let committed: { value: T } | null | undefined;
  try {
    committed = await session.withTransaction(async () => {
      const scenario = await Scenario.findOne(scenarioFilter)
        .select("nodes edges")
        .session(session)
        .lean<{ nodes?: unknown; edges?: unknown } | null>();
      if (!scenario) {
        throw new ScenarioPendingWriteCoordinationError(
          "scenario_not_found",
          "The active scenario no longer exists."
        );
      }

      const conversation = await Conversation.findOne(conversationFilter)
        .select("airi_scenario_state")
        .session(session)
        .lean<{ airi_scenario_state?: unknown } | null>();
      if (!conversation) {
        throw new ScenarioPendingWriteCoordinationError(
          "conversation_state_changed",
          "Conversation state changed before the pending wait could be saved."
        );
      }

      const resolvedConditionNodeId = resolveCurrentPendingConditionNodeId({
        scenario,
        requestedConditionNodeId: conditionNodeId,
        sourceActionNodeId,
      });
      const projection = params.project({
        baseState: normalizeScenarioState(conversation.airi_scenario_state),
        conditionNodeId: resolvedConditionNodeId,
      });

      const scenarioTouch = await Scenario.updateOne(
        scenarioFilter,
        { $inc: { __v: 1 } },
        { session, timestamps: false }
      );
      if (scenarioTouch.matchedCount !== 1) {
        throw new ScenarioPendingWriteCoordinationError(
          "scenario_write_conflict",
          "Scenario changed before the pending wait could be serialized."
        );
      }

      const conversationWrite = await Conversation.updateOne(
        conversationFilter,
        projection.update,
        { session }
      );
      if (conversationWrite.matchedCount !== 1) {
        throw new ScenarioPendingWriteCoordinationError(
          "conversation_state_changed",
          "Conversation state changed before the pending wait could be saved."
        );
      }
      return { value: projection.value };
    });
  } catch (error) {
    if (isScenarioPendingWriteCoordinationError(error)) throw error;
    throw new ScenarioPendingWriteCoordinationError(
      "scenario_write_conflict",
      "Pending wait transaction could not be serialized.",
      error
    );
  } finally {
    await session.endSession();
  }

  if (!committed) {
    throw new ScenarioPendingWriteCoordinationError(
      "scenario_write_conflict",
      "Pending wait transaction did not commit."
    );
  }
  return committed.value;
}

/**
 * Builds the canonical persisted state for a frozen asynchronous scenario
 * transition. The caller owns the atomic compare-and-set with its separate
 * execution record.
 */
export function buildFrozenScenarioTransitionState(params: {
  baseState: unknown;
  scenarioId: string;
  scenarioName: string | null;
  actionNodeId: string;
  transition: {
    nextActionNodeId: string | null;
    completesScenario: boolean;
  };
  completedAt: Date;
  lastMessageId: string | null;
}): Record<string, unknown> {
  const baseState = normalizeScenarioState(params.baseState);
  if (params.transition.completesScenario) {
    return serializeScenarioStateForMongo(
      buildStateWithCompletedScenario({
        baseState,
        scenarioId: params.scenarioId,
        scenarioName: params.scenarioName || "Scenario",
        completedAt: params.completedAt,
        lastActionNodeId: params.actionNodeId,
        lastMessageId: params.lastMessageId,
      })
    );
  }

  return serializeScenarioStateForMongo({
    ...buildStateWithClearedPendingCondition(baseState),
    currentActionNodeId: params.transition.nextActionNodeId,
    currentPathNodeIds: [],
    currentBranchNodeIds: [],
    lastMatchedAt: params.completedAt,
    lastMessageId: params.lastMessageId || baseState.lastMessageId,
  });
}

async function persistRawScenarioState(params: {
  conversationId: string;
  state: PersistedScenarioState;
  expectedPendingState?: PendingScenarioStateExpectation;
  expectedBehaviorRunId?: string;
  expectedTerminalBaseState?: PersistedScenarioState;
  expectedConversationSnapshot?: {
    workspaceId: string;
    airi_scenario_state: unknown;
    airi_handoff_active: unknown;
    airi_handoff_started_at: unknown;
  };
}): Promise<boolean> {
  const filter: Record<string, unknown> = {
    _id: params.conversationId,
    ...params.expectedConversationSnapshot,
  };
  if (params.expectedTerminalBaseState) {
    for (const key of [
      "lockedScenarioId",
      "lockedScenarioName",
      "currentActionNodeId",
      "scenarioRevisionFingerprint",
      "currentPathNodeIds",
      "currentBranchNodeIds",
      "lastMessageId",
      "pendingConditionNodeId",
      "pendingSourceActionNodeId",
      "pendingStartedAt",
      "pendingLastOutboundMessageId",
      "pendingLinkedConditionId",
    ] as const) {
      filter[`airi_scenario_state.${key}`] =
        params.expectedTerminalBaseState[key];
    }
  }
  if (params.expectedBehaviorRunId)
    filter["airi_scenario_state.behaviorRunId"] = params.expectedBehaviorRunId;
  if (params.expectedPendingState) {
    Object.assign(filter, buildPendingStateFence(params.expectedPendingState));
  }

  const result = await Conversation.updateOne(
    filter,
    buildScenarioStateUpdate(params.state)
  );
  return result.matchedCount === 1;
}

/**
 * Refunds only the first admission owned by a proven-unsent delivery. The
 * caller must fence its durable dispatch owner before calling this function.
 * Rebuild from the frozen preparation, never infer ownership from current state.
 */
export async function releaseUnsentInitialScenarioAdmission(params: {
  workspaceId: string;
  conversationId: string;
  sourceMessageId: string;
  scenarioRuntime: AiriScenarioRuntimeConfig;
  baseState: unknown;
  capturedConversation: {
    airi_handoff_active?: unknown;
    airi_handoff_started_at?: unknown;
  };
}): Promise<boolean> {
  const baseState = normalizeScenarioState(params.baseState);
  const runtime = params.scenarioRuntime;
  if (
    !runtime.scenarioId ||
    !runtime.selectedActionNodeId ||
    baseState.startedScenarios.some(
      entry => entry.scenarioId === runtime.scenarioId
    ) ||
    baseState.completedScenarios.some(
      entry => entry.scenarioId === runtime.scenarioId
    )
  )
    return false;

  const conversation = await Conversation.findOne({
    _id: params.conversationId,
    workspaceId: params.workspaceId,
  })
    .select("airi_scenario_state airi_handoff_active airi_handoff_started_at")
    .lean<{
      airi_scenario_state?: unknown;
      airi_handoff_active?: boolean;
      airi_handoff_started_at?: Date | null;
    } | null>();
  if (!conversation) return false;
  const state = normalizeScenarioState(conversation.airi_scenario_state);
  const entry = state.startedScenarios.find(
    item => item.scenarioId === runtime.scenarioId
  );
  if (
    !entry ||
    entry.firstMessageId !== params.sourceMessageId ||
    entry.firstActionNodeId !== runtime.selectedActionNodeId ||
    state.lastMessageId !== params.sourceMessageId ||
    state.pendingLastOutboundMessageId ||
    (conversation.airi_handoff_active === true) !==
      (params.capturedConversation.airi_handoff_active === true) ||
    (readDate(conversation.airi_handoff_started_at)?.getTime() ?? null) !==
      (readDate(
        params.capturedConversation.airi_handoff_started_at
      )?.getTime() ?? null)
  )
    return false;

  let expected = buildStateWithRuntimeMatch({
    baseState,
    scenarioRuntime: runtime,
    messageId: params.sourceMessageId,
    now: entry.startedAt,
  });
  if (runtime.pendingConditionNodeId) {
    if (!state.pendingStartedAt) return false;
    expected = buildStateWithPendingCondition({
      baseState: expected,
      scenarioRuntime: runtime,
      startedAt: state.pendingStartedAt,
    });
  }
  if (
    JSON.stringify(serializeScenarioStateForMongo(state)) !==
    JSON.stringify(serializeScenarioStateForMongo(expected))
  )
    return false;

  return persistRawScenarioState({
    conversationId: params.conversationId,
    // The attempted entry may have replaced another scenario's wait or saved
    // answers. Restore its frozen predecessor, not an empty scenario lock.
    state: baseState,
    expectedConversationSnapshot: {
      workspaceId: params.workspaceId,
      airi_scenario_state: conversation.airi_scenario_state,
      airi_handoff_active: conversation.airi_handoff_active ?? null,
      airi_handoff_started_at: conversation.airi_handoff_started_at ?? null,
    },
  });
}

/** Matches only while the conversation still holds this exact wait. */
function buildPendingStateFence(
  expected: PendingScenarioStateExpectation
): Record<string, unknown> {
  return {
    "airi_scenario_state.lockedScenarioId": expected.scenarioId,
    "airi_scenario_state.pendingConditionNodeId": expected.conditionNodeId,
    "airi_scenario_state.pendingSourceActionNodeId":
      expected.sourceActionNodeId,
    "airi_scenario_state.pendingStartedAt": expected.pendingStartedAt,
    "airi_scenario_state.pendingLastOutboundMessageId":
      expected.lastOutboundMessageId,
  };
}

/**
 * Records a decided shared location while the conversation still holds the
 * wait that decided it. Only the scenario's location ledger is written, so
 * the wait and every other field stay as they are.
 */
export async function recordScenarioLocationDecisionAndPersist(
  params: RecordScenarioLocationDecisionParams
): Promise<{ persisted: boolean; state: unknown }> {
  const state = recordScenarioRoutedLocation(params.baseState, {
    scenarioId: params.expectedPendingState.scenarioId,
    entry: params.entry,
  });
  const result = await Conversation.updateOne(
    {
      _id: params.conversationId,
      ...buildPendingStateFence(params.expectedPendingState),
    },
    {
      $set: {
        "airi_scenario_state.routedLocations": normalizeScenarioRoutedLocations(
          state.routedLocations
        ),
      },
    }
  );
  return { persisted: result.matchedCount === 1, state };
}

async function loadLatestScenarioState(params: {
  conversationId: string;
  fallbackState?: unknown;
}): Promise<PersistedScenarioState> {
  const latest = await Conversation.findById(params.conversationId)
    .select("airi_scenario_state")
    .lean<{ airi_scenario_state?: unknown } | null>();

  return normalizeScenarioState(
    latest?.airi_scenario_state ?? params.fallbackState ?? null
  );
}

export async function persistScenarioState(params: PersistScenarioStateParams) {
  const pendingConditionNodeId =
    params.scenarioRuntime.actionType === "end_scenario"
      ? ""
      : params.scenarioRuntime.pendingConditionNodeId?.trim() || "";
  if (pendingConditionNodeId) {
    const pendingStartedAt = params.keepPendingWait?.startedAt ?? new Date();
    await coordinatePendingScenarioWrite({
      conversationId: params.conversationId,
      scenarioId: params.scenarioRuntime.scenarioId,
      sourceActionNodeId:
        params.scenarioRuntime.pendingSourceActionNodeId || "",
      conditionNodeId: pendingConditionNodeId,
      baseState: params.baseState,
      pendingLegacyRouting: params.scenarioRuntime.pendingLegacyRouting,
      project: ({ baseState, conditionNodeId }) => {
        const scenarioRuntime = {
          ...params.scenarioRuntime,
          pendingConditionNodeId: conditionNodeId,
        };
        const nextState = buildStateWithRuntimeMatch({
          baseState,
          scenarioRuntime,
          messageId: params.messageId,
        });
        const stateToPersist = buildStateWithPendingCondition({
          baseState: nextState,
          scenarioRuntime,
          startedAt: pendingStartedAt,
          pendingLastOutboundMessageId:
            params.keepPendingWait?.lastOutboundMessageId,
        });
        return {
          update: buildScenarioStateUpdate(stateToPersist),
          value: stateToPersist,
        };
      },
    });
    return;
  }

  const baseState = normalizeScenarioState(params.baseState);
  const matchedState = buildStateWithRuntimeMatch({
    baseState,
    scenarioRuntime: params.scenarioRuntime,
    messageId: params.messageId,
  });
  // An explicit ending has no delivery to await. Commit the match and terminal
  // state together so it cannot leave a pending timer or a resumable action.
  const stateToPersist =
    params.scenarioRuntime.actionType === "end_scenario"
      ? buildStateWithCompletedScenario({
          baseState: matchedState,
          scenarioId: params.scenarioRuntime.scenarioId,
          scenarioName: params.scenarioRuntime.scenarioName,
          completedAt: matchedState.lastMatchedAt || new Date(),
          lastActionNodeId: params.scenarioRuntime.selectedActionNodeId,
          lastMessageId: params.messageId,
        })
      : matchedState;
  let persisted: boolean;
  try {
    persisted = await persistRawScenarioState({
      conversationId: params.conversationId,
      state: stateToPersist,
      ...(params.scenarioRuntime.actionType === "end_scenario"
        ? { expectedTerminalBaseState: baseState }
        : {}),
    });
  } catch (error) {
    if (
      params.scenarioRuntime.actionType !== "end_scenario" ||
      isScenarioPendingWriteCoordinationError(error)
    ) {
      throw error;
    }
    throw new ScenarioPendingWriteCoordinationError(
      "conversation_write_failed",
      "Conversation state could not be saved before ending the scenario.",
      error
    );
  }
  if (params.scenarioRuntime.actionType === "end_scenario" && !persisted) {
    throw new ScenarioPendingWriteCoordinationError(
      "conversation_state_changed",
      "Conversation changed before the scenario could end"
    );
  }
}

export async function clearPendingConditionStateAndPersist(
  params: ClearPendingConditionStateAndPersistParams
) {
  const normalizedBase = normalizeScenarioState(params.baseState);
  const clearedState = buildStateWithClearedPendingCondition(normalizedBase);
  await persistRawScenarioState({
    conversationId: params.conversationId,
    state: clearedState,
  });
  return clearedState;
}

export async function persistPendingConditionState(
  params: PersistPendingConditionStateParams
) {
  const startedAt = getCompletionTimestamp(params.startedAt);
  return coordinatePendingScenarioWrite({
    conversationId: params.conversationId,
    scenarioId: params.scenarioId,
    sourceActionNodeId: params.sourceActionNodeId,
    conditionNodeId: params.conditionNodeId,
    baseState: params.baseState,
    pendingLegacyRouting: params.pendingLegacyRouting,
    project: ({ baseState, conditionNodeId }) => {
      const nextState: PersistedScenarioState = {
        ...baseState,
        lockedScenarioId: params.scenarioId,
        lockedScenarioName: params.scenarioName || "Scenario",
        currentActionNodeId: params.sourceActionNodeId,
        currentPathNodeIds: Array.isArray(params.pathNodeIds)
          ? params.pathNodeIds
          : baseState.currentPathNodeIds,
        currentBranchNodeIds: Array.isArray(params.branchNodeIds)
          ? params.branchNodeIds
          : baseState.currentBranchNodeIds,
        pendingConditionNodeId: conditionNodeId,
        pendingSourceActionNodeId: params.sourceActionNodeId,
        pendingStartedAt: startedAt,
        pendingScenarioUpdatedAt:
          baseState.lockedScenarioId === params.scenarioId &&
          baseState.pendingSourceActionNodeId === params.sourceActionNodeId
            ? baseState.pendingScenarioUpdatedAt
            : null,
        pendingLastOutboundMessageId:
          params.pendingLastOutboundMessageId || null,
        pendingLinkedConditionId: params.pendingLinkedConditionId || null,
        pendingLegacyRouting: normalizeScenarioPendingLegacyRouting({
          value: params.pendingLegacyRouting,
          conditionNodeId,
          sourceActionNodeId: params.sourceActionNodeId,
        }),
        lastMatchedAt: startedAt,
        lastMessageId: params.messageId || baseState.lastMessageId || null,
        collectedPromptInputs: baseState.collectedPromptInputs,
      };
      return {
        update: buildScenarioStateUpdate(nextState),
        value: nextState,
      };
    },
  });
}

export async function persistRecoveredPendingConditionState(params: {
  workspaceId: string;
  conversationId: string;
  scenarioId: string;
  sourceActionNodeId: string;
  conditionNodeId: string;
  pendingStartedAt: Date;
  pendingLastOutboundMessageId: string;
  pendingLinkedConditionId: string | null;
  pendingLegacyRouting?: ScenarioPendingLegacyRouting | null;
  expectedCurrentActionNodeId: string;
}): Promise<{ conditionNodeId: string; sourceActionNodeId: string }> {
  return coordinatePendingScenarioWrite({
    conversationId: params.conversationId,
    scenarioId: params.scenarioId,
    sourceActionNodeId: params.sourceActionNodeId,
    conditionNodeId: params.conditionNodeId,
    baseState: null,
    pendingLegacyRouting: params.pendingLegacyRouting,
    expectation: {
      workspaceId: params.workspaceId,
      expectedCurrentActionNodeId: params.expectedCurrentActionNodeId,
    },
    project: ({ conditionNodeId }) => ({
      update: {
        $set: {
          "airi_scenario_state.pendingConditionNodeId": conditionNodeId,
          "airi_scenario_state.pendingSourceActionNodeId":
            params.sourceActionNodeId,
          "airi_scenario_state.pendingStartedAt": params.pendingStartedAt,
          // Timer recovery cannot reconstruct the revision of an old outbound.
          "airi_scenario_state.pendingScenarioUpdatedAt": null,
          "airi_scenario_state.pendingLastOutboundMessageId":
            params.pendingLastOutboundMessageId,
          "airi_scenario_state.pendingLinkedConditionId":
            params.pendingLinkedConditionId,
          "airi_scenario_state.pendingLegacyRouting":
            normalizeScenarioPendingLegacyRouting({
              value: params.pendingLegacyRouting,
              conditionNodeId,
              sourceActionNodeId: params.sourceActionNodeId,
            }),
        },
      },
      value: {
        conditionNodeId,
        sourceActionNodeId: params.sourceActionNodeId,
      },
    }),
  });
}

export async function completeScenarioAfterDispatch(params: {
  conversationId: string;
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  baseState: unknown;
  completionTimestamp?: string | Date | null;
  lastMessageId?: string | null;
  resolveParams?: {
    workspaceId: string;
    conversation: ConversationDocument;
    channel: Channel;
  };
}): Promise<void> {
  const scenarioRuntime = params.scenarioRuntime;
  if (scenarioRuntime?.pendingConditionNodeId) {
    const pendingStartedAt = getCompletionTimestamp(params.completionTimestamp);
    const pendingBaseState = isCanonicalActionOutcomeWait({
      conditionNodeId: scenarioRuntime.pendingConditionNodeId,
      sourceActionNodeId: scenarioRuntime.pendingSourceActionNodeId || "",
    })
      ? await loadLatestScenarioState({
          conversationId: params.conversationId,
          fallbackState: params.baseState,
        })
      : params.baseState;
    await coordinatePendingScenarioWrite({
      conversationId: params.conversationId,
      scenarioId: scenarioRuntime.scenarioId,
      sourceActionNodeId: scenarioRuntime.pendingSourceActionNodeId || "",
      conditionNodeId: scenarioRuntime.pendingConditionNodeId,
      baseState: pendingBaseState,
      pendingLegacyRouting: scenarioRuntime.pendingLegacyRouting,
      project: ({ baseState, conditionNodeId }) => {
        const pendingState = buildStateWithPendingCondition({
          baseState,
          scenarioRuntime: {
            ...scenarioRuntime,
            pendingConditionNodeId: conditionNodeId,
          },
          startedAt: pendingStartedAt,
          lastMessageId: params.lastMessageId || null,
        });
        return {
          update: buildScenarioStateUpdate(pendingState),
          value: pendingState,
        };
      },
    });
    return;
  }

  if (!scenarioRuntime?.completesScenario) {
    return;
  }

  const latestBaseState = await loadLatestScenarioState({
    conversationId: params.conversationId,
    fallbackState: params.baseState,
  });
  await completeLockedScenarioAndPersist({
    conversationId: params.conversationId,
    baseState: latestBaseState,
    scenarioId: scenarioRuntime.scenarioId,
    scenarioName: scenarioRuntime.scenarioName,
    completionTimestamp: params.completionTimestamp,
    lastActionNodeId: scenarioRuntime.selectedActionNodeId || null,
    lastMessageId: params.lastMessageId || null,
  });
}

function toSerializableScenarioState(state: PersistedScenarioState): {
  lockedScenarioId: string | null;
  lockedScenarioName: string | null;
  currentActionNodeId: string | null;
  scenarioRevisionFingerprint: string | null;
  currentPathNodeIds: string[];
  currentBranchNodeIds: string[];
  pendingConditionNodeId: string | null;
  pendingSourceActionNodeId: string | null;
  pendingStartedAt: string | null;
  pendingScenarioUpdatedAt: string | null;
  pendingLastOutboundMessageId: string | null;
  pendingLinkedConditionId: string | null;
  lastMatchedAt: string | null;
  lastMessageId: string | null;
  collectedPromptInputs: ConversationScenarioState["collectedPromptInputs"];
  pickedOptions: ConversationScenarioState["pickedOptions"];
  formAnswers: ConversationScenarioState["formAnswers"];
  routedLocations: ConversationScenarioState["routedLocations"];
  startedScenarios: Array<{
    scenarioId: string;
    scenarioName: string | null;
    startedAt: string;
    firstActionNodeId: string | null;
    firstMessageId: string | null;
  }>;
  completedScenarios: Array<{
    scenarioId: string;
    scenarioName: string | null;
    completedAt: string;
    lastActionNodeId: string | null;
    lastMessageId: string | null;
  }>;
} {
  return {
    lockedScenarioId: state.lockedScenarioId,
    lockedScenarioName: state.lockedScenarioName,
    currentActionNodeId: state.currentActionNodeId,
    scenarioRevisionFingerprint: state.scenarioRevisionFingerprint,
    currentPathNodeIds: state.currentPathNodeIds,
    currentBranchNodeIds: state.currentBranchNodeIds,
    pendingConditionNodeId: state.pendingConditionNodeId,
    pendingSourceActionNodeId: state.pendingSourceActionNodeId,
    pendingStartedAt: state.pendingStartedAt
      ? state.pendingStartedAt.toISOString()
      : null,
    pendingScenarioUpdatedAt: state.pendingScenarioUpdatedAt
      ? state.pendingScenarioUpdatedAt.toISOString()
      : null,
    pendingLastOutboundMessageId: state.pendingLastOutboundMessageId,
    pendingLinkedConditionId: state.pendingLinkedConditionId,
    lastMatchedAt: state.lastMatchedAt
      ? state.lastMatchedAt.toISOString()
      : null,
    lastMessageId: state.lastMessageId,
    collectedPromptInputs: state.collectedPromptInputs ?? null,
    pickedOptions: state.pickedOptions ?? null,
    formAnswers: state.formAnswers ?? null,
    routedLocations: state.routedLocations ?? null,
    startedScenarios: state.startedScenarios.map(item => ({
      scenarioId: item.scenarioId,
      scenarioName: item.scenarioName ?? null,
      startedAt: item.startedAt.toISOString(),
      firstActionNodeId: item.firstActionNodeId ?? null,
      firstMessageId: item.firstMessageId ?? null,
    })),
    completedScenarios: state.completedScenarios.map(item => ({
      scenarioId: item.scenarioId,
      scenarioName: item.scenarioName ?? null,
      completedAt: item.completedAt.toISOString(),
      lastActionNodeId: item.lastActionNodeId ?? null,
      lastMessageId: item.lastMessageId ?? null,
    })),
  };
}

function getCompletionTimestamp(
  preferredTimestamp?: string | Date | null
): Date {
  const preferred = readDate(preferredTimestamp);
  if (preferred) return preferred;
  return new Date();
}

export async function completeLockedScenarioAndPersist(
  params: CompleteLockedScenarioAndPersistParams
) {
  const normalizedBase = normalizeScenarioState(params.baseState);
  const completionAt = getCompletionTimestamp(params.completionTimestamp);
  const completedState = buildStateWithCompletedScenario({
    baseState: normalizedBase,
    scenarioId: params.scenarioId,
    scenarioName: params.scenarioName,
    completedAt: completionAt,
    lastActionNodeId: params.lastActionNodeId || null,
    lastMessageId: params.lastMessageId || null,
  });
  const persisted = await persistRawScenarioState({
    conversationId: params.conversationId,
    state: completedState,
    expectedBehaviorRunId: params.expectedBehaviorRunId,
    expectedPendingState: params.expectedPendingState
      ? {
          scenarioId: params.scenarioId,
          ...params.expectedPendingState,
        }
      : undefined,
  });
  return { state: completedState, completedAt: completionAt, persisted };
}

/**
 * Records a submitted form on a turn that routes nowhere. Only the scenario
 * holding the conversation records its own form, as when a turn routes, and
 * only while the conversation still holds the turn's starting state. Every
 * other field, any wait and its timer included, stays as it was.
 */
export async function persistScenarioFormSubmission(
  params: PersistScenarioFormSubmissionParams
): Promise<boolean> {
  const normalizedBase = normalizeScenarioState(params.baseState);
  if (normalizedBase.lockedScenarioId !== params.submitted.scenarioId) {
    return false;
  }
  return persistRawScenarioState({
    conversationId: params.conversationId,
    state: recordScenarioFormSubmission(
      normalizedBase,
      params.submitted
    ) as PersistedScenarioState,
    expectedTerminalBaseState: normalizedBase,
  });
}

async function clearLockedScenarioAndPersist(params: {
  conversationId: string;
  baseState: unknown;
}) {
  const normalizedBase = normalizeScenarioState(params.baseState);
  const cleared = buildStateWithClearedLock(normalizedBase);
  await persistRawScenarioState({
    conversationId: params.conversationId,
    state: cleared,
  });
  return cleared;
}

export async function reconcileRagScenarioSelectionAndPersist(params: {
  conversationId: string;
  initialScenarioRuntime: AiriScenarioRuntimeConfig | null;
  finalScenarioRuntime: AiriScenarioRuntimeConfig | null;
  messageId: string;
  candidateScenarioIds?: string[];
}): Promise<void> {
  const initialScenarioId = params.initialScenarioRuntime?.scenarioId || null;
  const finalScenarioId = params.finalScenarioRuntime?.scenarioId || null;

  if (initialScenarioId === finalScenarioId) {
    return;
  }

  const latestStateDoc = await Conversation.findById(params.conversationId)
    .select("airi_scenario_state")
    .lean<{ airi_scenario_state?: unknown } | null>();
  const latestState = normalizeScenarioState(
    latestStateDoc?.airi_scenario_state
  );

  if (params.finalScenarioRuntime) {
    await persistScenarioState({
      conversationId: params.conversationId,
      scenarioRuntime: params.finalScenarioRuntime,
      messageId: params.messageId,
      baseState: latestState,
    });
    return;
  }

  const candidateScenarioIds = new Set(
    [...(params.candidateScenarioIds || []), initialScenarioId]
      .map(item => String(item || "").trim())
      .filter(Boolean)
  );

  if (
    latestState.lockedScenarioId &&
    candidateScenarioIds.has(latestState.lockedScenarioId)
  ) {
    await clearLockedScenarioAndPersist({
      conversationId: params.conversationId,
      baseState: latestState,
    });
  }
}

export async function finalizeScenarioResolution(
  params: FinalizeScenarioResolutionParams<ConversationDocument>
): Promise<AiriScenarioRuntimeConfig | null> {
  if (params.scenarioRuntime) {
    await persistScenarioState({
      conversationId: params.conversationId,
      scenarioRuntime: params.scenarioRuntime,
      messageId: params.messageId,
      baseState: params.baseState,
    });
    return params.scenarioRuntime;
  }

  if (params.lockedScenarioNoMatch) {
    const completionResult = await completeLockedScenarioAndPersist({
      conversationId: params.conversationId,
      baseState: params.baseState,
      scenarioId: params.lockedScenarioNoMatch.scenarioId,
      scenarioName: params.lockedScenarioNoMatch.scenarioName,
      completionTimestamp: params.lockedScenarioNoMatch.lastMatchedAt,
      lastActionNodeId: params.lockedScenarioNoMatch.lastActionNodeId || null,
      lastMessageId:
        params.lockedScenarioNoMatch.lastMessageId || params.messageId,
    });
    const completedState = completionResult.state;

    const followupResolution = await resolveActiveScenarioRuntime({
      workspaceId: params.resolveParams.workspaceId,
      conversation: params.resolveParams.conversation,
      channel: params.resolveParams.channel,
      scenarioState: toSerializableScenarioState(completedState),
    });

    if (followupResolution.runtime) {
      await persistScenarioState({
        conversationId: params.conversationId,
        scenarioRuntime: followupResolution.runtime,
        messageId: params.messageId,
        baseState: completedState,
      });
      return followupResolution.runtime;
    }
  }

  if (params.lockedScenarioMissing) {
    await clearLockedScenarioAndPersist({
      conversationId: params.conversationId,
      baseState: params.baseState,
    });
  }

  return null;
}
