import type { AiriScenarioGenerativeAIResultEvent } from "./generative-ai-contracts";

export const AIRI_CONVERSATION_TASK_QUEUE = "airi-conversation";
export const AIRI_CONVERSATION_WORKFLOW = "airiConversationWorkflow";
export const AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION = 3;
export const AIRI_CONVERSATION_INGEST_TURN_SIGNAL = "airi.ingestTurn";
export const AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL =
  "airi.ingestExternalEvent";
export const AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY = "airi.getRuntimeState";
export const AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY =
  "airi.prepareConversationTurn";
export const AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY =
  "airi.recordTurnDisposition";
export const AIRI_TURN_PREPARATION_NOT_STARTED =
  "AIRI_TURN_PREPARATION_NOT_STARTED";
export const AIRI_COMPANY_CAPACITY_DEFERRED = "AIRI_COMPANY_CAPACITY_DEFERRED";
export const AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN =
  "AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN";
export const AIRI_OUTBOUND_PREPARATION_FAILED =
  "AIRI_OUTBOUND_PREPARATION_FAILED";
export const AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE =
  "AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE";

/** Meta returned a documented retryable rejection; no provider receipt exists. */
export class AiriOutboundProviderRejectedError extends Error {
  readonly code = AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE;

  constructor(message: string) {
    super(message);
    this.name = "AiriOutboundProviderRejectedError";
  }
}

export function isAiriOutboundProviderRejectedError(
  error: unknown,
): error is AiriOutboundProviderRejectedError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE
  );
}

/** A durable dispatch owner proves the message POST has not begun. */
export class AiriOutboundPreparationFailedError extends Error {
  readonly code = AIRI_OUTBOUND_PREPARATION_FAILED;

  constructor(message: string) {
    super(message);
    this.name = "AiriOutboundPreparationFailedError";
  }
}

export function isAiriOutboundPreparationFailedError(
  error: unknown,
): error is AiriOutboundPreparationFailedError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === AIRI_OUTBOUND_PREPARATION_FAILED
  );
}
export const AIRI_CONVERSATION_READ_PROJECTION_ACTIVITY =
  "airi.readConversationProjection";
export const AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY =
  "airi.planConversationTimer";
export const AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY =
  "airi.deliverOutbound";
export const AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY =
  "airi.finalizeOutbound";
export const AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY =
  "airi.buildTimerTurn";
export const AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY =
  "airi.handleExternalEvent";
export const AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY =
  "airi.terminalizeGenerativeAcknowledgment";
export const AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW =
  "airiScenarioGenerativeAIWorkflow";

export type AiriConversationLifecycleStatus = "idle" | "pending" | "processing";
export type AiriConversationTimerWaitMode = "legacy_race" | "condition_timeout";

export type AiriConversationTurnSignal = {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  /** Verified richer content for the same canonical inbound message. */
  messageRecoveryRevision?: string | null;
  /** The accepted delivery contained no readable customer message. */
  whatsappMessageContentUnavailable?: boolean;
  channel?: string | null;
  sourceId?: string | null;
  textPreview?: string | null;
  messageDate?: string | null;
  triggerEventKind?: string | null;
  scenarioOverrideId?: string | null;
  turnContextId?: string | null;
  enqueuedAt?: string | null;
  autoReplyPayload?: Record<string, unknown> | null;
};

/** Safe identity for persisted receipts and runtime queries; excludes turn content. */
export type AiriConversationTurnReference = Pick<
  AiriConversationTurnSignal,
  | "workspaceId"
  | "conversationId"
  | "messageId"
  | "messageRecoveryRevision"
  | "whatsappMessageContentUnavailable"
  | "channel"
  | "sourceId"
  | "messageDate"
  | "triggerEventKind"
  | "scenarioOverrideId"
  | "turnContextId"
  | "enqueuedAt"
>;

export function toAiriConversationTurnReference(
  turn: AiriConversationTurnSignal,
): AiriConversationTurnReference {
  const {
    workspaceId,
    conversationId,
    messageId,
    messageRecoveryRevision,
    whatsappMessageContentUnavailable,
    channel,
    sourceId,
    messageDate,
    triggerEventKind,
    scenarioOverrideId,
    turnContextId,
    enqueuedAt,
  } = turn;
  return {
    workspaceId,
    conversationId,
    messageId,
    ...(messageRecoveryRevision ? { messageRecoveryRevision } : {}),
    ...(whatsappMessageContentUnavailable
      ? { whatsappMessageContentUnavailable: true }
      : {}),
    channel,
    sourceId,
    messageDate,
    triggerEventKind,
    scenarioOverrideId,
    turnContextId,
    enqueuedAt,
  };
}

/** Legacy turns retain their exact identity; a content recovery is admitted once. */
export function getAiriConversationTurnKey(
  turn: Pick<
    AiriConversationTurnSignal,
    "messageId" | "messageRecoveryRevision"
  >,
): string {
  return turn.messageRecoveryRevision
    ? `${turn.messageId}:recovery:${turn.messageRecoveryRevision}`
    : turn.messageId;
}

export type AiriConversationTurnStage = "prepare" | "delivery" | "timer_plan";

export type AiriConversationTurnDispositionStatus =
  | "retryable"
  | "outcome_unknown"
  | "terminal"
  | "completed"
  | "superseded";

export type AiriConversationTurnDisposition = {
  turn: AiriConversationTurnReference;
  status: AiriConversationTurnDispositionStatus;
  stage: AiriConversationTurnStage;
  attempt: number;
  updatedAt: string;
  error: string | null;
  nextAttemptAt: string | null;
  supersededByMessageId?: string;
};

/** Workflow-private retry state; prepared output must never enter runtime queries. */
export type AiriConversationTurnRetryWork = {
  turn: AiriConversationTurnSignal;
  stage: AiriConversationTurnStage;
  attempt: number;
  dueAtMs: number;
  process?: AiriConversationTurnProcessResult;
  /** Proven pre-provider failure or explicit retryable provider rejection; safe to supersede. */
  deliveryNotAttempted?: true;
};

export type AiriConversationTurnLifecycleSnapshot = {
  version: 1;
  retries: AiriConversationTurnRetryWork[];
  recentDispositions: AiriConversationTurnDisposition[];
};

export type AiriConversationControlExternalEvent = {
  kind: "human_outbound" | "timer_replan";
  workspaceId: string;
  conversationId: string;
  messageId: string;
  channel?: string | null;
  sourceId?: string | null;
  messageDate?: string | null;
  enqueuedAt?: string | null;
};

/** Confirmed ledger identity only; payment facts are loaded by the host activity. */
export type AiriConversationPaymentConfirmedEvent = {
  kind: "payment_confirmed";
  conversionId: string;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  sourceId: string;
  channel: "whatsapp";
  messageDate: string;
  enqueuedAt?: string | null;
  /** Internal activity acknowledgement, never accepted from external ingress. */
  phase?: "complete";
  completionStatus?: "processed" | "skipped" | "failed";
  completionReason?: string;
};

export type AiriConversationExternalEvent =
  | AiriConversationControlExternalEvent
  | AiriConversationPaymentConfirmedEvent
  | AiriScenarioGenerativeAIResultEvent;

export type AiriConversationExternalEventRetryItem = {
  event: AiriConversationExternalEvent;
  attempt: number;
  dueAtMs: number;
  /** Workflow-private prepared turn checkpoint; kept outside the coalescing queue. */
  paymentTurnWork?: AiriConversationTurnRetryWork;
};

export type AiriConversationExternalEventLifecycleSnapshot = {
  version: 1;
  queued: AiriConversationExternalEventRetryItem[];
  inFlight: AiriConversationExternalEventRetryItem | null;
  controlSeenKeys: string[];
  processedGenerativeKeys: string[];
  processedPaymentKeys?: string[];
};

export type AiriConversationWorkflowInput = {
  contractVersion?: number | null;
  workspaceId: string;
  conversationId: string;
  sourceId?: string | null;
  startedAt?: string | null;
  timerWaitMode?: AiriConversationTimerWaitMode | null;
  initialTurn?: AiriConversationTurnSignal | null;
  carryover?: {
    state?: Partial<
      Pick<
        AiriConversationRuntimeState,
        | "status"
        | "lastSignalAt"
        | "activeMessageId"
        | "lastProcessedMessageId"
        | "lastProcessedAt"
        | "lastExecutionStatus"
        | "lastExecutionError"
        | "updatedAt"
        | "startedAt"
        | "currentTopic"
        | "currentGoal"
        | "preferredLanguage"
        | "activeScenarioId"
        | "activeScenarioName"
        | "currentActionNodeId"
        | "currentPathNodeIds"
        | "currentBranchNodeIds"
        | "pendingConditionNodeId"
        | "pendingSourceActionNodeId"
        | "pendingLinkedConditionId"
        | "handoffActive"
        | "handoffSource"
        | "handoffReason"
        | "handoffStartedAt"
        | "lastResponseStatus"
        | "lastResponseSkippedConcurrent"
        | "projectionUpdatedAt"
        | "activeTimer"
        | "activeTimerReason"
        | "timerWaitMode"
        | "turnRecovery"
        | "timerPreparationRetry"
        | "lastFiredTimer"
      >
    > | null;
    pendingTurns?: AiriConversationTurnSignal[] | null;
    pendingExternalEvents?: AiriConversationExternalEvent[] | null;
    seenMessageIds?: string[] | null;
    seenExternalEventKeys?: string[] | null;
    externalEventLifecycle?: AiriConversationExternalEventLifecycleSnapshot | null;
    turnLifecycle?: AiriConversationTurnLifecycleSnapshot | null;
  } | null;
};

export type AiriConversationQueueClass =
  | "shared"
  | "workflow"
  | "ai"
  | "delivery";

export type AiriConversationRouting = {
  taskQueue: string;
  activityQueueClass: AiriConversationQueueClass;
  searchAttributes: Record<string, string | string[] | number | boolean>;
};

export type AiriConversationProjection = {
  currentGoal: string | null;
  preferredLanguage: string | null;
  activeScenarioId: string | null;
  activeScenarioName: string | null;
  currentActionNodeId: string | null;
  currentPathNodeIds: string[];
  currentBranchNodeIds: string[];
  pendingConditionNodeId: string | null;
  pendingSourceActionNodeId: string | null;
  pendingLinkedConditionId: string | null;
  handoffActive: boolean;
  handoffSource: string | null;
  handoffReason: string | null;
  handoffStartedAt: string | null;
  updatedAt: string | null;
};

export type AiriConversationTimerDescriptor = {
  kind: "post_action_no_reply_timeout";
  workspaceId: string;
  conversationId: string;
  channel: string | null;
  sourceId: string | null;
  scenarioId: string;
  scenarioName: string | null;
  dueAt: string;
  triggerNodeId: string | null;
  conditionNodeId: string | null;
  sourceActionNodeId: string | null;
  linkedConditionId: string | null;
  waitStartedAt: string | null;
  pendingLastOutboundMessageId: string | null;
  lastInboundMessageId: string | null;
  lastInboundAt: string | null;
  lastInboundText: string | null;
};

/** Retry scheduling is separate from the original timer identity and due date. */
export type AiriConversationTimerPreparationRetry = {
  timer: AiriConversationTimerDescriptor;
  attempt: number;
  nextAttemptAt: string;
  lastError: string | null;
};

export type AiriConversationTimerPlanResult = {
  timer: AiriConversationTimerDescriptor | null;
  projection?: AiriConversationProjection | null;
  reason?: string | null;
};

export type AiriConversationPreparedTimerTurnResult = {
  turn: AiriConversationTurnSignal | null;
  projection?: AiriConversationProjection | null;
  reason?: string | null;
  timer?: AiriConversationTimerDescriptor | null;
};

export type AiriConversationExternalEventResult = {
  handled: boolean;
  projection?: AiriConversationProjection | null;
  clearTimer?: boolean;
  timer?: AiriConversationTimerDescriptor | null;
  pendingDelivery?: AiriConversationOutboundDeliveryRequest | null;
  generativeResultDisposition?: "pending_delivery" | "suppressed_stale";
  paymentTurn?: AiriConversationTurnSignal | null;
  paymentDisposition?: "ready" | "terminal";
};

export type AiriConversationRuntimeState = {
  workflowId: string;
  workspaceId: string;
  conversationId: string;
  sourceId: string | null;
  taskQueue: string;
  status: AiriConversationLifecycleStatus;
  pendingTurns: number;
  lastSignalAt: string | null;
  activeMessageId: string | null;
  lastProcessedMessageId: string | null;
  lastProcessedAt: string | null;
  lastExecutionStatus: "idle" | "running" | "completed" | "failed";
  lastExecutionError: string | null;
  updatedAt: string;
  startedAt: string;
  currentTopic: string | null;
  currentGoal: string | null;
  preferredLanguage: string | null;
  activeScenarioId: string | null;
  activeScenarioName: string | null;
  currentActionNodeId: string | null;
  currentPathNodeIds: string[];
  currentBranchNodeIds: string[];
  pendingConditionNodeId: string | null;
  pendingSourceActionNodeId: string | null;
  pendingLinkedConditionId: string | null;
  handoffActive: boolean;
  handoffSource: string | null;
  handoffReason: string | null;
  handoffStartedAt: string | null;
  lastResponseStatus: number | null;
  lastResponseSkippedConcurrent: boolean;
  projectionUpdatedAt: string | null;
  activeTimer: AiriConversationTimerDescriptor | null;
  activeTimerReason: string | null;
  timerWaitMode: AiriConversationTimerWaitMode;
  turnRecovery?: {
    pendingRetries: AiriConversationTurnDisposition[];
    recentDispositions: AiriConversationTurnDisposition[];
  } | null;
  timerPreparationRetry?: AiriConversationTimerPreparationRetry | null;
  /** The latest timer that fired a turn; that turn may not re-arm it unchanged. */
  lastFiredTimer?: AiriConversationTimerDescriptor | null;
};

export type AiriConversationTurnExecutionOutcome = {
  responseStatus: number | null;
  skippedConcurrent: boolean;
  executionStatus: "completed" | "response" | "failed";
  responseBody?: unknown;
};

export type AiriConversationOutboundDeliveryRequest = {
  deliveryKey: string;
  reservedMessageId: string;
  context: Record<string, unknown>;
  dispatchPolicy?: "default" | "at_most_once";
  /**
   * Scenario follow-up deliveries may continue through an active manual
   * handoff. Generative result delivery opts into `respect` without changing
   * other callers.
   */
  manualHandoffPolicy?: "default" | "respect";
  capacityVerifiedAt?: string | null;
  postDeliveryEffects?: AiriConversationPostDeliveryEffect[];
};

export type AiriConversationOutboundDeliveryResult = {
  deliveryKey: string;
  outboundMessageId: string;
  outboundDate: string | null;
  classification?: "sent" | "skipped" | "not_attempted" | "outcome_unknown";
  skipped?: boolean;
  skipReason?: string | null;
};

export type AiriConversationDeferredCommand = {
  version: 1;
  kind: "start_generative_ai_scenario";
  workflowId: string;
  workspaceId: string;
  conversationId: string;
  executionId: string;
  scenarioId: string;
  scenarioRevisionFingerprint: string;
  actionNodeId: string;
};

export type AiriConversationTerminalizeGenerativeAckInput = {
  command: AiriConversationDeferredCommand;
  outcome: "manual_handoff" | "failure";
};

export type AiriConversationPostDeliveryEffect =
  | {
      kind: "clear_suppressed_state";
      conversationId: string;
    }
  | {
      kind: "complete_scenario_after_dispatch";
      payload: Record<string, unknown>;
    }
  | {
      kind: "update_suggestion_message_id";
      sourceMessageId: string;
    }
  | {
      kind: "persist_reply_trace";
      payload: Record<string, unknown>;
    }
  | {
      kind: "track_knowledge_gap";
      payload: Record<string, unknown>;
    }
  | {
      kind: "publish_airi_suggestion";
      payload: Record<string, unknown>;
    }
  | {
      /**
       * Queued at prepare (before Meta send). Runs after deliver so retries
       * that find an existing outbound still send the tester feedback prompt.
       */
      kind: "send_whatsapp_llm_feedback";
      payload: {
        workspaceId: string;
        conversationId: string;
        sourceId?: string | null;
        recipient:
          | {
              kind: "phone" | "bsuid" | "parent_bsuid";
              value: string;
            }
          | string;
        recipientDigits?: string | null;
      };
    }
  | {
      kind: "finalize_generative_ai_result";
      payload: {
        workspaceId: string;
        conversationId: string;
        executionId: string;
        scenarioId: string;
        scenarioRevisionFingerprint: string;
        actionNodeId: string;
        deliveryClaimToken: string;
        assetId: string | null;
        videoWorkflowId: string | null;
        attemptToken: string | null;
      };
    };

export type AiriConversationFinalizeOutboundInput = {
  delivery: AiriConversationOutboundDeliveryResult;
  effects: AiriConversationPostDeliveryEffect[];
};

export type AiriConversationTurnProcessResult = {
  messageId: string;
  completedAt: string;
  outcome: AiriConversationTurnExecutionOutcome;
  pendingDelivery?: AiriConversationOutboundDeliveryRequest | null;
  deferredCommand?: AiriConversationDeferredCommand | null;
};

export type AiriConversationProjectionReadInput = {
  conversationId: string;
};

export type AiriConversationTurnTransitionResult = {
  messageId: string;
  completedAt: string;
  outcome: AiriConversationTurnExecutionOutcome;
  projection?: AiriConversationProjection | null;
  timer: AiriConversationTimerDescriptor | null;
  timerReason?: string | null;
};

export function buildAiriConversationWorkflowId(
  conversationId: string,
): string {
  const normalized = String(conversationId || "").trim();
  if (!normalized) {
    throw new Error(
      "conversationId is required to build a Temporal workflow id",
    );
  }
  return `airi-conversation:${normalized}`;
}

export function buildAiriConversationTaskQueue(): string {
  return AIRI_CONVERSATION_TASK_QUEUE;
}

export function resolveAiriConversationRouting(_params?: {
  workspaceId?: string | null;
  conversationId?: string | null;
  sourceId?: string | null;
  channel?: string | null;
}): AiriConversationRouting {
  return {
    taskQueue: buildAiriConversationTaskQueue(),
    activityQueueClass: "shared",
    searchAttributes: {},
  };
}
