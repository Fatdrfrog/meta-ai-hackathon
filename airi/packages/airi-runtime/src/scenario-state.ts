import {
  normalizeCollectedPromptInputs,
  normalizeScenarioFormAnswers,
  normalizeScenarioPickedOptions,
  normalizeScenarioRoutedLocations,
  type CollectedPromptInputs,
  type ScenarioFormAnswers,
  type ScenarioPickedOptions,
  type ScenarioRoutedLocations,
} from "@icecore/scenario-contracts";
import { readStringArray as toStringArray } from "@icecore/shared/lib/value-utils";

export type ScenarioOutboundCheckpoint = {
  channel?: unknown;
  messageId?: unknown;
  temporalDispatch?: { state?: unknown } | null;
  delivery?: { status?: unknown; failedAt?: unknown } | null;
};

/** A reserved document is not evidence that the preceding action was sent. */
export function isScenarioOutboundCheckpointConfirmed(
  outbound: ScenarioOutboundCheckpoint | null | undefined,
): boolean {
  if (!outbound || outbound.delivery?.status === "failed") return false;
  const dispatchState = outbound.temporalDispatch?.state;
  if (dispatchState && dispatchState !== "sent") return false;
  return (
    outbound.channel !== "whatsapp" ||
    (typeof outbound.messageId === "string" &&
      Boolean(outbound.messageId.trim()))
  );
}

export type ScenarioPendingLegacyRouting = {
  kind: "interactive_no_reply_assignment";
  conditionNodeId: string;
  sourceActionNodeId: string;
};

export function normalizeScenarioPendingLegacyRouting(params: {
  value: unknown;
  conditionNodeId: string;
  sourceActionNodeId: string;
}): ScenarioPendingLegacyRouting | null {
  if (!params.value || typeof params.value !== "object") return null;
  const value = params.value as Record<string, unknown>;
  const conditionNodeId =
    typeof value.conditionNodeId === "string"
      ? value.conditionNodeId.trim()
      : "";
  const sourceActionNodeId =
    typeof value.sourceActionNodeId === "string"
      ? value.sourceActionNodeId.trim()
      : "";
  if (
    value.kind !== "interactive_no_reply_assignment" ||
    conditionNodeId !== params.conditionNodeId ||
    sourceActionNodeId !== params.sourceActionNodeId
  ) {
    return null;
  }
  return {
    kind: "interactive_no_reply_assignment",
    conditionNodeId,
    sourceActionNodeId,
  };
}

export interface ConversationScenarioState {
  behaviorRunId?: string | null;
  lockedScenarioId?: string | null;
  lockedScenarioName?: string | null;
  currentActionNodeId?: string | null;
  scenarioRevisionFingerprint?: string | null;
  currentPathNodeIds?: string[];
  currentBranchNodeIds?: string[];
  pendingConditionNodeId?: string | null;
  pendingSourceActionNodeId?: string | null;
  pendingStartedAt?: string | Date | null;
  pendingScenarioUpdatedAt?: string | Date | null;
  pendingLastOutboundMessageId?: string | null;
  pendingLinkedConditionId?: string | null;
  pendingLegacyRouting?: ScenarioPendingLegacyRouting | null;
  lastMatchedAt?: string | Date | null;
  lastMessageId?: string | null;
  startedScenarios?: ScenarioStartedEntry[];
  completedScenarios?: ScenarioCompletionEntry[];
  collectedPromptInputs?: CollectedPromptInputs | null;
  pickedOptions?: ScenarioPickedOptions | null;
  formAnswers?: ScenarioFormAnswers | null;
  routedLocations?: ScenarioRoutedLocations | null;
}

export interface ScenarioStartedEntry {
  scenarioId: string;
  scenarioName?: string | null;
  startedAt: string | Date;
  firstActionNodeId?: string | null;
  firstMessageId?: string | null;
}

export interface ScenarioCompletionEntry {
  scenarioId: string;
  scenarioName?: string | null;
  completedAt: string | Date;
  lastActionNodeId?: string | null;
  lastMessageId?: string | null;
}

export function normalizeConversationScenarioState(
  value: unknown,
): ConversationScenarioState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  const lockedScenarioId =
    typeof state.lockedScenarioId === "string"
      ? state.lockedScenarioId.trim()
      : "";
  const currentActionNodeId =
    typeof state.currentActionNodeId === "string"
      ? state.currentActionNodeId.trim()
      : "";
  const scenarioRevisionFingerprint =
    typeof state.scenarioRevisionFingerprint === "string"
      ? state.scenarioRevisionFingerprint.trim()
      : "";
  const pendingConditionNodeId =
    typeof state.pendingConditionNodeId === "string"
      ? state.pendingConditionNodeId.trim()
      : "";
  const pendingSourceActionNodeId =
    typeof state.pendingSourceActionNodeId === "string"
      ? state.pendingSourceActionNodeId.trim()
      : "";
  const pendingLastOutboundMessageId =
    typeof state.pendingLastOutboundMessageId === "string"
      ? state.pendingLastOutboundMessageId.trim()
      : "";
  const pendingLinkedConditionId =
    typeof state.pendingLinkedConditionId === "string"
      ? state.pendingLinkedConditionId.trim()
      : "";
  const pendingLegacyRouting = normalizeScenarioPendingLegacyRouting({
    value: state.pendingLegacyRouting,
    conditionNodeId: pendingConditionNodeId,
    sourceActionNodeId: pendingSourceActionNodeId,
  });
  const explicitStartedScenarios = Array.isArray(state.startedScenarios)
    ? state.startedScenarios.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const raw = item as Record<string, unknown>;
        const scenarioId =
          typeof raw.scenarioId === "string" ? raw.scenarioId.trim() : "";
        if (!scenarioId) return [];
        const startedAt =
          raw.startedAt instanceof Date || typeof raw.startedAt === "string"
            ? raw.startedAt
            : null;
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
              typeof raw.firstMessageId === "string"
                ? raw.firstMessageId
                : null,
          } satisfies ScenarioStartedEntry,
        ];
      })
    : [];
  const completedScenarios = Array.isArray(state.completedScenarios)
    ? state.completedScenarios
        .flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const raw = item as Record<string, unknown>;
          const scenarioId =
            typeof raw.scenarioId === "string" ? raw.scenarioId.trim() : "";
          if (!scenarioId) return [];
          const completedAt =
            raw.completedAt instanceof Date ||
            typeof raw.completedAt === "string"
              ? raw.completedAt
              : null;
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
                typeof raw.lastMessageId === "string"
                  ? raw.lastMessageId
                  : null,
            } satisfies ScenarioCompletionEntry,
          ];
        })
        .slice(0, 50)
    : [];
  const startedScenarios = explicitStartedScenarios.filter(
    (entry, index, source) =>
      source.findIndex(
        (candidate) => candidate.scenarioId === entry.scenarioId,
      ) === index,
  );
  return {
    lockedScenarioId: lockedScenarioId || null,
    behaviorRunId:
      lockedScenarioId &&
      typeof state.behaviorRunId === "string" &&
      /^[a-f0-9]{24}$/.test(state.behaviorRunId)
        ? state.behaviorRunId
        : null,
    lockedScenarioName:
      typeof state.lockedScenarioName === "string"
        ? state.lockedScenarioName
        : null,
    currentActionNodeId: currentActionNodeId || null,
    scenarioRevisionFingerprint: scenarioRevisionFingerprint || null,
    currentPathNodeIds: toStringArray(state.currentPathNodeIds),
    currentBranchNodeIds: toStringArray(state.currentBranchNodeIds),
    pendingConditionNodeId: pendingConditionNodeId || null,
    pendingSourceActionNodeId: pendingSourceActionNodeId || null,
    pendingStartedAt:
      state.pendingStartedAt instanceof Date ||
      typeof state.pendingStartedAt === "string"
        ? state.pendingStartedAt
        : null,
    pendingScenarioUpdatedAt:
      state.pendingScenarioUpdatedAt instanceof Date ||
      typeof state.pendingScenarioUpdatedAt === "string"
        ? state.pendingScenarioUpdatedAt
        : null,
    pendingLastOutboundMessageId: pendingLastOutboundMessageId || null,
    pendingLinkedConditionId: pendingLinkedConditionId || null,
    pendingLegacyRouting,
    lastMatchedAt:
      state.lastMatchedAt instanceof Date ||
      typeof state.lastMatchedAt === "string"
        ? state.lastMatchedAt
        : null,
    lastMessageId:
      typeof state.lastMessageId === "string" ? state.lastMessageId : null,
    startedScenarios,
    completedScenarios,
    collectedPromptInputs: normalizeCollectedPromptInputs(
      state.collectedPromptInputs,
    ),
    pickedOptions: normalizeScenarioPickedOptions(state.pickedOptions),
    formAnswers: normalizeScenarioFormAnswers(state.formAnswers),
    routedLocations: normalizeScenarioRoutedLocations(state.routedLocations),
  };
}
