import type { ConversationChannel } from "@icecore/shared/types/sources";
import type {
  GenerativeAIActionMode,
  ScenarioBusinessLocation,
  ScenarioFormFieldSchema,
  ScenarioFormSubmission,
  ScenarioPromptInputExtraction,
  ScenarioPromptInputField,
  ScenarioRoutedLocationEntry,
  ScenarioRuntimeEventKind,
  ScenarioWhatsAppServiceOption,
} from "@icecore/scenario-contracts";
import type { WhatsAppReferralFields } from "@icecore/whatsapp/referralFields";
import type { ScenarioGraphRecord } from "./scenario-graph";
import type { GenerativeAIInboundCandidate } from "./scenario-generative-ai-input-types";
import type { ScenarioPendingLegacyRouting } from "./scenario-state";
import type {
  AiriScenarioRuntimeConfig,
  AiriScenarioRuntimeResolution,
} from "./scenario-runtime-types";

export type ResolveActiveScenarioRuntimeParams<TConversation> = {
  workspaceId: string;
  conversation: TConversation;
  channel: ConversationChannel;
  scenarioState?: unknown;
  forcedScenarioId?: string | null;
  forcedTriggerNodeId?: string | null;
  forcedActionNodeId?: string | null;
  /** Fence a forced continuation to the scenario revision that authorized it. */
  expectedScenarioUpdatedAt?: string;
  limitToPriority?: number | null;
  excludeScenarioIds?: string[];
  triggerEventKind?: ScenarioRuntimeEventKind;
  triggerMessageText?: string;
  /** Provider reported an inbound but withheld its content; only a first template may run. */
  contentIndependentEntryOnly?: boolean;
  quickReplyPayload?: string | null;
  whatsAppFlowResponseJson?: string | null;
  /**
   * The scenario step that sent the form a Flow reply submitted. Only a reply
   * to that step's own form takes its "Form submitted" route.
   */
  whatsAppFlowReplySource?: { scenarioId: string; actionNodeId: string } | null;
  generativeInbound?: GenerativeAIInboundCandidate | null;
  triggerWhatsAppReferral?: Partial<WhatsAppReferralFields> | null;
  triggerLanguage?: string | null;
  skipTriggerMatch?: boolean;
  ignoreLockedScenario?: boolean;
  /**
   * The locked scenario waits with a No-reply follow-up. A tap on another
   * scenario's button then stays with the lock, as a miss, instead of running
   * that scenario's route and ending the follow-up.
   */
  lockedScenarioFollowUpPending?: boolean;
};

export type PendingScenarioStateExpectation = {
  scenarioId: string;
  conditionNodeId: string;
  sourceActionNodeId: string;
  pendingStartedAt: string | Date | null;
  lastOutboundMessageId: string | null;
};

export type PersistScenarioStateParams = {
  conversationId: string;
  scenarioRuntime: AiriScenarioRuntimeConfig;
  messageId: string;
  baseState?: unknown;
  /**
   * A turn that sends nothing keeps the runtime's armed wait: its start and
   * anchor message stay, instead of restarting a wait no delivery completes.
   */
  keepPendingWait?: KeptScenarioPendingWait;
};

export type KeptScenarioPendingWait = {
  startedAt: Date;
  lastOutboundMessageId: string;
};

export type ClearPendingConditionStateAndPersistParams = {
  conversationId: string;
  baseState: unknown;
};

export type PersistPendingConditionStateParams = {
  conversationId: string;
  baseState: unknown;
  scenarioId: string;
  scenarioName: string;
  sourceActionNodeId: string;
  conditionNodeId: string;
  pathNodeIds?: string[] | null;
  branchNodeIds?: string[] | null;
  pendingLinkedConditionId?: string | null;
  pendingLegacyRouting?: ScenarioPendingLegacyRouting | null;
  pendingLastOutboundMessageId?: string | null;
  messageId?: string | null;
  startedAt?: Date | string | null;
};

/** A decided shared location, recorded only while its wait still holds. */
export type RecordScenarioLocationDecisionParams = {
  conversationId: string;
  baseState: unknown;
  entry: ScenarioRoutedLocationEntry;
  expectedPendingState: PendingScenarioStateExpectation;
};

/** An inbound WhatsApp message that shared a usable location. */
export type ScenarioSharedLocationMessage = {
  messageId: string;
  date: Date;
  latitude: number;
  longitude: number;
  /** The share cited a message (a reply to the request); logged only. */
  hasReplyContext: boolean;
  /** The stored display text, `[Location] …`, which a merged turn may carry. */
  text?: string;
};

export type CompleteLockedScenarioAndPersistParams = {
  expectedBehaviorRunId?: string;
  conversationId: string;
  baseState: unknown;
  scenarioId: string;
  scenarioName: string;
  completionTimestamp?: string | Date | null;
  lastActionNodeId?: string | null;
  lastMessageId?: string | null;
  expectedPendingState?: Omit<PendingScenarioStateExpectation, "scenarioId">;
};

export type PersistScenarioFormSubmissionParams = {
  conversationId: string;
  /** The conversation's scenario state when the turn started. */
  baseState: unknown;
  submitted: { scenarioId: string; submission: ScenarioFormSubmission };
};

export type FinalizeScenarioResolutionParams<TConversation> = {
  conversationId: string;
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  messageId: string;
  baseState: unknown;
  resolveParams: {
    workspaceId: string;
    conversation: TConversation;
    channel: ConversationChannel;
  };
  lockedScenarioNoMatch?: {
    scenarioId: string;
    scenarioName: string;
    lastMatchedAt?: string | Date | null;
    lastActionNodeId?: string | null;
    lastMessageId?: string | null;
  };
  lockedScenarioMissing?: {
    scenarioId: string;
    scenarioName?: string | null;
  };
};

export type ScenarioRuntimeSnapshot = ScenarioGraphRecord & {
  priority?: unknown;
};

/** Scenario host effects, supplied by the caller for each runtime invocation. */
export interface ScenarioRuntimeDependencies<TConversation> {
  runTextAiAction: <T>(
    scope: { workspaceId: string; actionId: string },
    run: () => Promise<T>,
  ) => Promise<T>;
  loadBehaviorTemplateValues?: (scope: {
    workspaceId: string;
    conversationId: string;
    scenarioId?: string;
    sourceMessageId: string;
    behaviorRunId?: string | null;
  }) => Promise<Record<string, string>>;
  loadActiveScenarioSnapshot: (scope: {
    workspaceId: string;
    scenarioId: string;
  }) => Promise<ScenarioRuntimeSnapshot | null>;
  resolveActiveScenarioRuntime: (
    params: ResolveActiveScenarioRuntimeParams<TConversation>,
  ) => Promise<AiriScenarioRuntimeResolution>;
  persistScenarioState: (params: PersistScenarioStateParams) => Promise<void>;
  clearPendingConditionStateAndPersist: (
    params: ClearPendingConditionStateAndPersistParams,
  ) => Promise<unknown>;
  persistPendingConditionState: (
    params: PersistPendingConditionStateParams,
  ) => Promise<unknown>;
  completeLockedScenarioAndPersist: (
    params: CompleteLockedScenarioAndPersistParams,
  ) => Promise<{ state: unknown; completedAt: Date; persisted: boolean }>;
  finalizeScenarioResolution: (
    params: FinalizeScenarioResolutionParams<TConversation>,
  ) => Promise<AiriScenarioRuntimeConfig | null>;
  /**
   * The id of the latest outbound message this scenario action produced in the
   * conversation, whether the runtime or a bulk send delivered it.
   */
  findLatestScenarioActionOutbound: (scope: {
    workspaceId: string;
    conversationId: string;
    scenarioId: string;
    actionNodeId: string;
    /** When provided, verify this exact wait checkpoint instead of the latest send. */
    outboundMessageId?: string;
  }) => Promise<string | null>;
  /**
   * The stored copy of the scenario service message a tap chose from: the
   * outbound message the reply cites, else that node's latest scenario send.
   * Null when neither was sent by `actionNodeId`.
   */
  findTappedScenarioServiceMessage?: (scope: {
    workspaceId: string;
    conversationId: string;
    contextMessageId: string | null;
    actionNodeId: string;
  }) => Promise<{
    scenarioId: string;
    whatsappServiceMessage: unknown;
  } | null>;
  /**
   * The scenario form a Flow reply submitted: the outbound message the reply
   * cites, else the latest outbound that sent the same `flow_token`. Its
   * fields are read as the form was sent, from the stored copy of the form,
   * else from the sending node's form; null fields when neither lists them.
   * Null when no scenario message sent the form.
   */
  findSubmittedScenarioForm?: (scope: {
    workspaceId: string;
    conversationId: string;
    contextMessageId: string | null;
    flowToken: string | null;
  }) => Promise<SubmittedScenarioFormSource | null>;
  /**
   * Records a submitted form's answers on a turn that routes nowhere. Writes
   * only while the scenario that sent the form holds the conversation and its
   * state is still `baseState`, which keeps any wait and its timer as they
   * were. True when the answers were saved.
   */
  persistScenarioFormSubmission?: (
    params: PersistScenarioFormSubmissionParams,
  ) => Promise<boolean>;
  /**
   * The newest inbound WhatsApp location shared in the conversation from
   * `since` to `until`, skipping `excludeMessageIds`. Null when there is
   * none, or when an outbound message already followed it, so a share a
   * manager answered is never routed late.
   */
  findLatestInboundLocation?: (scope: {
    workspaceId: string;
    conversationId: string;
    since: Date;
    until: Date;
    excludeMessageIds: string[];
  }) => Promise<ScenarioSharedLocationMessage | null>;
  /** The workspace's active offices, read when a shared location is decided. */
  loadBusinessLocations?: (scope: {
    workspaceId: string;
  }) => Promise<ScenarioBusinessLocation[]>;
  /** Records a decided shared location while its wait still holds. */
  recordScenarioLocationDecision?: (
    params: RecordScenarioLocationDecisionParams,
  ) => Promise<{ persisted: boolean; state: unknown }>;
  /**
   * Reads named details from the customer reply, and the option it names
   * when `choices` are offered. A null result means extraction was
   * unavailable. Only a successful object may mark the ask unmet.
   */
  extractScenarioPromptInputs?: (params: {
    workspaceId: string;
    fields: ScenarioPromptInputField[];
    sourceText: string;
    choices: ScenarioWhatsAppServiceOption[];
  }) => Promise<ScenarioPromptInputExtraction | null>;
  /**
   * Checks the customer's words before a paid generation. Null means the
   * check was unavailable, and the generation goes ahead.
   */
  screenGenerativeAICustomerText?: (params: {
    workspaceId: string;
    mode: GenerativeAIActionMode;
    parts: GenerativeAICustomerTextPart[];
  }) => Promise<GenerativeAICustomerTextScreening | null>;
  /** Generations a conversation started on a node since `since`. */
  countGenerativeAIStarts?: (params: {
    conversationId: string;
    scenarioId: string;
    actionNodeId: string;
    since: Date;
  }) => Promise<number>;
}

/** The message that sent a form a Flow reply submitted. */
export type SubmittedScenarioFormSource = {
  scenarioId: string;
  sourceActionNodeId: string;
  flowId: string | null;
  fields: ScenarioFormFieldSchema[] | null;
};

/** Customer words a generation would use: an answer, or their own request. */
export type GenerativeAICustomerTextPart = {
  kind: "answer" | "request";
  label: string;
  text: string;
};

export type GenerativeAICustomerTextScreening = {
  flagged: boolean;
  /** Why the words were flagged, for logs. */
  reason: string | null;
};

export type ScenarioPendingWriteCoordinationErrorCode =
  | "conversation_state_changed"
  | "conversation_write_failed"
  | "scenario_not_found"
  | "scenario_routing_changed"
  | "scenario_write_conflict";

export class ScenarioPendingWriteCoordinationError extends Error {
  readonly scenarioPendingWriteCoordinationError = true;

  constructor(
    readonly code: ScenarioPendingWriteCoordinationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ScenarioPendingWriteCoordinationError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isScenarioPendingWriteCoordinationError(
  error: unknown,
): error is ScenarioPendingWriteCoordinationError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "scenarioPendingWriteCoordinationError" in error &&
      (error as { scenarioPendingWriteCoordinationError?: unknown })
        .scenarioPendingWriteCoordinationError === true,
  );
}

export function isScenarioStateLocked(
  value: unknown,
): value is { lockedScenarioId?: string | null } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "lockedScenarioId" in (value as Record<string, unknown>),
  );
}

/** Keep failed answer-state writes out of the runtime's best-effort catch path. */
export function withPromptInputStateDurability(
  persist: (params: PersistScenarioStateParams) => Promise<void>,
): (params: PersistScenarioStateParams) => Promise<void> {
  return async (params) => {
    try {
      await persist(params);
    } catch (error) {
      if (isScenarioPendingWriteCoordinationError(error)) throw error;
      const state = params.baseState;
      const collection =
        state &&
        typeof state === "object" &&
        Object.hasOwn(state, "collectedPromptInputs")
          ? (state as Record<string, unknown>).collectedPromptInputs
          : null;
      // Inspect only the scope here. Normalizing an invalid collection while
      // handling a failed write could mask the original failure with a
      // non-coordination error, which the caller would swallow again.
      if (
        !collection ||
        typeof collection !== "object" ||
        !Object.hasOwn(collection, "scenarioId") ||
        (collection as { scenarioId?: unknown }).scenarioId !==
          params.scenarioRuntime.scenarioId
      ) {
        throw error;
      }
      // The shared reply runtime already stops delivery on this error class.
      // Apply that existing fence to both waiting collectors and saved answers.
      throw new ScenarioPendingWriteCoordinationError(
        "conversation_write_failed",
        "Could not persist scenario prompt inputs before continuing delivery.",
        error,
      );
    }
  };
}
