import {
  AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY,
  getAiriConversationTurnKey,
  AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY,
  AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
  AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY,
  AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL,
  AIRI_CONVERSATION_INGEST_TURN_SIGNAL,
  AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY,
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY,
  AIRI_CONVERSATION_READ_PROJECTION_ACTIVITY,
  AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY,
  AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY,
  AIRI_CONVERSATION_TASK_QUEUE,
  AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION,
  AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW,
  AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL,
  buildAiriConversationWorkflowId,
  resolveAiriConversationRouting,
  toAiriConversationTurnReference,
  type AiriConversationExternalEvent,
  type AiriConversationExternalEventResult,
  type AiriConversationFinalizeOutboundInput,
  type AiriConversationOutboundDeliveryResult,
  type AiriConversationOutboundDeliveryRequest,
  type AiriConversationPreparedTimerTurnResult,
  type AiriConversationPaymentConfirmedEvent,
  type AiriConversationProjection,
  type AiriConversationProjectionReadInput,
  type AiriConversationRuntimeState,
  type AiriConversationTimerDescriptor,
  type AiriConversationTurnProcessResult,
  type AiriConversationTurnSignal,
  type AiriConversationTurnTransitionResult,
  type AiriConversationTurnDisposition,
  type AiriConversationTurnRetryWork,
  type AiriConversationTerminalizeGenerativeAckInput,
  type AiriConversationWorkflowInput,
  type AiriScenarioGenerativeAIResultEvent,
} from "@icecore/temporal";
import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  patched,
  proxyActivities,
  setWorkflowOptions,
  setHandler,
  sleep,
  workflowInfo,
  ParentClosePolicy,
  startChild,
  WorkflowIdReusePolicy,
} from "@temporalio/workflow";
import { executeGenerativeAIDeferredDelivery } from "./airi-conversation-generative-ai.js";
import {
  createAiriConversationExternalEventLifecycle,
  AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT,
  type AiriConversationExternalEventLifecycle,
} from "./airi-conversation-external-events.js";
import {
  classifyTurnFailure,
  isKnownUnsentDeliveryFailure,
  isCompanyCapacityDeferredFailure,
  createTurnRecovery,
  getPreparedTurnFailure,
  MAX_TURN_RECOVERY_ATTEMPTS,
  nextTurnRetryAt,
  TurnDispositionError,
  type TurnRecovery,
} from "./airi-conversation-turn-recovery.js";

export const ingestTurnSignal = defineSignal<[AiriConversationTurnSignal]>(
  AIRI_CONVERSATION_INGEST_TURN_SIGNAL,
);

export const ingestExternalEventSignal = defineSignal<
  [AiriConversationExternalEvent]
>(AIRI_CONVERSATION_INGEST_EXTERNAL_EVENT_SIGNAL);

export const getRuntimeStateQuery = defineQuery<AiriConversationRuntimeState>(
  AIRI_CONVERSATION_GET_RUNTIME_STATE_QUERY,
);

const READ_PROJECTION_BEFORE_TIMER_PATCH_ID =
  "airi-conversation-read-projection-before-plan-timer";
const PLAN_TIMER_AFTER_FAILED_TURN_PATCH_ID =
  "airi-conversation-plan-timer-after-failed-turn";
const MERGED_DELIVERY_FINALIZATION_PATCH_ID =
  "airi-conversation-merged-delivery-finalization";
const PLAN_TIMER_WITH_PROJECTION_PATCH_ID =
  "airi-conversation-plan-timer-with-projection";
const CANCEL_STALE_TIMER_SLEEP_PATCH_ID =
  "airi-conversation-cancel-stale-timer-sleeps";
const DURABLE_GENERATIVE_EXTERNAL_EVENTS_PATCH_ID =
  "airi-conversation-durable-generative-external-events-v1";
const DURABLE_TIMER_REPLAN_RETRY_PATCH_ID =
  "airi-conversation-durable-timer-replan-retry-v1";
const IDLE_CLOSE_TIMEOUT = "30 minutes";
const DURABLE_TURN_RECOVERY_PATCH_ID =
  "airi-conversation-durable-turn-recovery-v1";
const DURABLE_TURN_FAILURE_MIGRATION_PATCH_ID =
  "airi-conversation-durable-turn-failure-migration-v1";
const REPLAN_TIMER_AFTER_UNRETRIED_TURN_FAILURE_PATCH_ID =
  "airi-conversation-replan-timer-after-unretried-turn-failure-v1";
const RETRY_KNOWN_UNSENT_DELIVERY_PATCH_ID =
  "airi-conversation-retry-known-unsent-delivery-v1";
const SUPPRESS_TIMER_REFIRE_PATCH_ID =
  "airi-conversation-suppress-timer-refire-v1";
const IN_ORDER_BUTTON_TAPS_PATCH_ID =
  "airi-conversation-in-order-button-taps-v1";
const COMPANY_CAPACITY_DEFERRED_PATCH_ID =
  "airi-conversation-company-capacity-deferred-v1";
/**
 * The webhook gives this kind only to taps whose payload names a scenario step
 * (stb/wsc/wbc), so each such turn routes by its own button.
 */
const BUTTON_TAP_EVENT_KIND = "whatsapp_button_reply";

type WorkflowProjection = Omit<AiriConversationProjection, "updatedAt">;

type AiriConversationWorkflowState = Omit<
  AiriConversationRuntimeState,
  keyof WorkflowProjection
> & {
  projection: WorkflowProjection;
};
type CarryoverRuntimeState = NonNullable<
  NonNullable<AiriConversationWorkflowInput["carryover"]>["state"]
>;

const turnProcessingActivities = proxyActivities<{
  [AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY]: (
    turn: AiriConversationTurnSignal,
  ) => Promise<AiriConversationTurnProcessResult>;
}>({
  // Prepare runs full RAG (retrieval + generation); sub-2m turns time out in prod under load.
  startToCloseTimeout: "600s",
  retry: {
    maximumAttempts: 1,
  },
});

const deliveryActivities = proxyActivities<{
  [AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY]: (
    request: AiriConversationOutboundDeliveryRequest,
  ) => Promise<AiriConversationOutboundDeliveryResult>;
}>({
  startToCloseTimeout: "180s",
  retry: {
    maximumAttempts: 3,
  },
});

const finalizationActivities = proxyActivities<{
  [AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY]: (
    input: AiriConversationFinalizeOutboundInput,
  ) => Promise<void>;
  [AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY]: (
    input: AiriConversationTerminalizeGenerativeAckInput,
  ) => Promise<void>;
}>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 3,
  },
});

const coordinationActivities = proxyActivities<{
  [AIRI_CONVERSATION_READ_PROJECTION_ACTIVITY]: (
    input: AiriConversationProjectionReadInput,
  ) => Promise<AiriConversationProjection | null>;
  [AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY]: (
    turn: AiriConversationTurnSignal,
  ) => Promise<{
    timer: AiriConversationTimerDescriptor | null;
    projection?: AiriConversationProjection | null;
    reason?: string | null;
  }>;
  [AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY]: (
    timer: AiriConversationTimerDescriptor,
  ) => Promise<AiriConversationPreparedTimerTurnResult>;
  [AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY]: (
    event: AiriConversationExternalEvent,
  ) => Promise<AiriConversationExternalEventResult>;
}>({
  startToCloseTimeout: "120s",
  retry: {
    maximumAttempts: 3,
  },
});

const prepareTurnActivity = turnProcessingActivities[
  AIRI_CONVERSATION_PREPARE_TURN_ACTIVITY
] as (
  turn: AiriConversationTurnSignal,
) => Promise<AiriConversationTurnProcessResult>;
const recordTurnDispositionActivity = proxyActivities<{
  [AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY]: (
    disposition: AiriConversationTurnDisposition,
  ) => Promise<void>;
}>({
  startToCloseTimeout: "30s",
  // A receipt is idempotent storage. Do not discard work while Mongo is unavailable.
  retry: { initialInterval: "5s", maximumInterval: "5 minutes" },
})[AIRI_CONVERSATION_RECORD_TURN_DISPOSITION_ACTIVITY];
const deliverOutboundActivity = deliveryActivities[
  AIRI_CONVERSATION_DELIVER_OUTBOUND_ACTIVITY
] as (
  request: AiriConversationOutboundDeliveryRequest,
) => Promise<AiriConversationOutboundDeliveryResult>;
const finalizeOutboundActivity = finalizationActivities[
  AIRI_CONVERSATION_FINALIZE_OUTBOUND_ACTIVITY
] as (input: AiriConversationFinalizeOutboundInput) => Promise<void>;
const terminalizeGenerativeAckActivity = finalizationActivities[
  AIRI_CONVERSATION_TERMINALIZE_GENERATIVE_ACK_ACTIVITY
] as (input: AiriConversationTerminalizeGenerativeAckInput) => Promise<void>;
const readProjectionActivity = coordinationActivities[
  AIRI_CONVERSATION_READ_PROJECTION_ACTIVITY
] as (
  input: AiriConversationProjectionReadInput,
) => Promise<AiriConversationProjection | null>;
const planTimerActivity = coordinationActivities[
  AIRI_CONVERSATION_PLAN_TIMER_ACTIVITY
] as (turn: AiriConversationTurnSignal) => Promise<{
  timer: AiriConversationTimerDescriptor | null;
  projection?: AiriConversationProjection | null;
  reason?: string | null;
}>;
const buildTimerTurnActivity = coordinationActivities[
  AIRI_CONVERSATION_BUILD_TIMER_TURN_ACTIVITY
] as (
  timer: AiriConversationTimerDescriptor,
) => Promise<AiriConversationPreparedTimerTurnResult>;
const handleExternalEventActivity = coordinationActivities[
  AIRI_CONVERSATION_HANDLE_EXTERNAL_EVENT_ACTIVITY
] as (
  event: AiriConversationExternalEvent,
) => Promise<AiriConversationExternalEventResult>;

function nowIso(): string {
  return new Date().toISOString();
}

function copyStringArray(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? [...value] : [];
}

function limitStringArray(value: Iterable<string>, maxItems = 256): string[] {
  const deduped = Array.from(new Set(value));
  if (deduped.length <= maxItems) {
    return deduped;
  }

  return deduped.slice(deduped.length - maxItems);
}

function normalizeTurnText(turn: AiriConversationTurnSignal): string | null {
  const normalized = String(turn.textPreview || "").trim();
  return normalized || null;
}

function isValidTurnSignal(
  turn: AiriConversationTurnSignal | null | undefined,
): turn is AiriConversationTurnSignal {
  return Boolean(
    turn &&
      typeof turn.conversationId === "string" &&
      turn.conversationId &&
      typeof turn.messageId === "string" &&
      turn.messageId,
  );
}

function normalizeExternalEventIso(
  event: AiriConversationExternalEvent,
): string | null {
  if (event.kind === "generative_ai_result") return null;
  const normalized = String(event.messageDate || event.enqueuedAt || "").trim();
  return normalized || null;
}

function buildExternalEventKey(event: AiriConversationExternalEvent): string {
  if (event.kind === "payment_confirmed")
    return `payment_confirmed:${event.conversionId}`;
  return `${event.kind}:${event.messageId}`;
}

function isSyntheticTimerTurn(turn: AiriConversationTurnSignal): boolean {
  return String(turn.messageId || "").startsWith("scenario-timeout:");
}

/** Taps and entry-only message events each need their own admission checks. */
function isInOrderTurn(
  turn: AiriConversationTurnSignal | null | undefined,
): boolean {
  return (
    isValidTurnSignal(turn) &&
    (turn.triggerEventKind === BUTTON_TAP_EVENT_KIND ||
      Boolean(turn.messageRecoveryRevision) ||
      turn.whatsappMessageContentUnavailable === true)
  );
}

function normalizeTimerWaitMode(
  value: unknown,
): AiriConversationRuntimeState["timerWaitMode"] {
  return value === "condition_timeout" ? "condition_timeout" : "legacy_race";
}

function buildProjectionFromCarryover(
  carryoverState: CarryoverRuntimeState | null | undefined,
): AiriConversationWorkflowState["projection"] {
  return {
    currentGoal: carryoverState?.currentGoal || null,
    preferredLanguage: carryoverState?.preferredLanguage || null,
    activeScenarioId: carryoverState?.activeScenarioId || null,
    activeScenarioName: carryoverState?.activeScenarioName || null,
    currentActionNodeId: carryoverState?.currentActionNodeId || null,
    currentPathNodeIds: carryoverState?.currentPathNodeIds || [],
    currentBranchNodeIds: carryoverState?.currentBranchNodeIds || [],
    pendingConditionNodeId: carryoverState?.pendingConditionNodeId || null,
    pendingSourceActionNodeId:
      carryoverState?.pendingSourceActionNodeId || null,
    pendingLinkedConditionId: carryoverState?.pendingLinkedConditionId || null,
    handoffActive: Boolean(carryoverState?.handoffActive),
    handoffSource: carryoverState?.handoffSource || null,
    handoffReason: carryoverState?.handoffReason || null,
    handoffStartedAt: carryoverState?.handoffStartedAt || null,
  };
}

function toRuntimeState(
  state: AiriConversationWorkflowState,
): AiriConversationRuntimeState {
  const { projection, ...baseState } = state;
  return {
    ...baseState,
    ...projection,
  };
}

function applyProjection(
  state: AiriConversationWorkflowState,
  projection: AiriConversationTurnTransitionResult["projection"],
): void {
  if (!projection) {
    return;
  }

  state.projection = {
    currentGoal: projection.currentGoal || state.projection.currentGoal,
    preferredLanguage:
      projection.preferredLanguage || state.projection.preferredLanguage,
    activeScenarioId: projection.activeScenarioId,
    activeScenarioName: projection.activeScenarioName,
    currentActionNodeId: projection.currentActionNodeId,
    currentPathNodeIds: projection.currentPathNodeIds,
    currentBranchNodeIds: projection.currentBranchNodeIds,
    pendingConditionNodeId: projection.pendingConditionNodeId,
    pendingSourceActionNodeId: projection.pendingSourceActionNodeId,
    pendingLinkedConditionId: projection.pendingLinkedConditionId,
    handoffActive: projection.handoffActive,
    handoffSource: projection.handoffSource,
    handoffReason: projection.handoffReason,
    handoffStartedAt: projection.handoffStartedAt,
  };
  state.projectionUpdatedAt = projection.updatedAt;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildSplitTurnTransitionResult(params: {
  process: AiriConversationTurnProcessResult;
  projection: AiriConversationProjection | null;
  timerPlan: {
    timer: AiriConversationTimerDescriptor | null;
    projection?: AiriConversationProjection | null;
    reason?: string | null;
  };
}): AiriConversationTurnTransitionResult {
  return {
    messageId: params.process.messageId,
    completedAt: params.process.completedAt,
    outcome: params.process.outcome,
    projection: params.timerPlan.projection || params.projection,
    timer: params.timerPlan.timer,
    timerReason: params.timerPlan.reason || null,
  };
}

function resolvePreparedTurnPostDeliveryEffects(
  process: AiriConversationTurnProcessResult,
): AiriConversationFinalizeOutboundInput["effects"] {
  return (
    process.pendingDelivery?.postDeliveryEffects ||
    (
      process as {
        postDeliveryEffects?: AiriConversationFinalizeOutboundInput["effects"];
      }
    ).postDeliveryEffects ||
    []
  );
}

async function executeWorkflowLocalDelivery(params: {
  request: AiriConversationOutboundDeliveryRequest;
  effects: AiriConversationFinalizeOutboundInput["effects"];
  finalizeGenerativeTerminalOnUnsent: boolean;
}): Promise<AiriConversationOutboundDeliveryResult> {
  const mergedRequest = {
    ...params.request,
    postDeliveryEffects: params.effects,
  };
  let deliveryResult: AiriConversationOutboundDeliveryResult;

  if (patched(MERGED_DELIVERY_FINALIZATION_PATCH_ID)) {
    deliveryResult = await deliverOutboundActivity(mergedRequest);
  } else {
    deliveryResult = await deliverOutboundActivity(params.request);
    if (!deliveryResult.skipped && params.effects.length > 0) {
      await finalizeOutboundActivity({
        delivery: deliveryResult,
        effects: params.effects,
      });
    }
  }

  if (!deliveryResult.classification) {
    if (params.finalizeGenerativeTerminalOnUnsent) {
      throw new Error("Generative result delivery classification is required");
    }
    return deliveryResult;
  }

  if (
    params.finalizeGenerativeTerminalOnUnsent &&
    deliveryResult.classification !== "sent"
  ) {
    const terminalEffects = params.effects.filter(
      (
        effect,
      ): effect is Extract<
        AiriConversationFinalizeOutboundInput["effects"][number],
        { kind: "finalize_generative_ai_result" }
      > => effect.kind === "finalize_generative_ai_result",
    );
    if (terminalEffects.length !== 1) {
      throw new Error(
        "Generative result requires one exact terminalization effect",
      );
    }
    await finalizeOutboundActivity({
      delivery: deliveryResult,
      effects: terminalEffects,
    });
  }

  return deliveryResult;
}

async function deliverPreparedTurn(
  process: AiriConversationTurnProcessResult,
): Promise<AiriConversationOutboundDeliveryResult | null> {
  if (!process.pendingDelivery) return null;
  return executeWorkflowLocalDelivery({
    request: process.pendingDelivery,
    effects: resolvePreparedTurnPostDeliveryEffects(process),
    finalizeGenerativeTerminalOnUnsent: false,
  });
}

async function executeTurnWithSplitActivities(
  turn: AiriConversationTurnSignal,
  work?: AiriConversationTurnRetryWork,
  classifyFailures = false,
  onPrepared?: (process: AiriConversationTurnProcessResult) => void,
  onDelivery?: (delivery: AiriConversationOutboundDeliveryResult) => void,
): Promise<AiriConversationTurnTransitionResult> {
  const process = work?.process || (await prepareTurnActivity(turn));
  if (work) work.process = process;
  const failure = getPreparedTurnFailure(process);
  if (
    failure &&
    (classifyFailures || patched(DURABLE_TURN_FAILURE_MIGRATION_PATCH_ID))
  ) {
    throw new TurnDispositionError(
      `Preparation returned unsuccessful outcome (${process.outcome.responseStatus ?? process.outcome.executionStatus})`,
      failure,
    );
  }
  onPrepared?.(process);

  if (!work || work.stage !== "timer_plan") {
    if (work) work.stage = "delivery";

    if (process.deferredCommand) {
      let observedDelivery: AiriConversationOutboundDeliveryResult | undefined;
      await executeGenerativeAIDeferredDelivery({
        command: process.deferredCommand,
        pendingDelivery: process.pendingDelivery,
        postDeliveryEffects: resolvePreparedTurnPostDeliveryEffects(process),
        dependencies: {
          deliver: onDelivery
            ? async (request) => {
                const delivery = await deliverOutboundActivity(request);
                observedDelivery = delivery;
                return delivery;
              }
            : deliverOutboundActivity,
          finalizeEffects: finalizeOutboundActivity,
          startDetachedWorkflow: async ({ workflowId, input }) => {
            await startChild(AIRI_SCENARIO_GENERATIVE_AI_WORKFLOW, {
              workflowId,
              parentClosePolicy: ParentClosePolicy.ABANDON,
              workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
              args: [input],
            });
          },
          terminalizeAcceptedExecution: terminalizeGenerativeAckActivity,
        },
      });
      if (observedDelivery) onDelivery?.(observedDelivery);
    } else {
      const delivery = await deliverPreparedTurn(process);
      if (delivery) onDelivery?.(delivery);
      if (
        (delivery?.classification === "outcome_unknown" ||
          delivery?.classification === "not_attempted") &&
        (classifyFailures || patched(DURABLE_TURN_FAILURE_MIGRATION_PATCH_ID))
      ) {
        throw new TurnDispositionError(
          delivery.skipReason || `Delivery ${delivery.classification}`,
          delivery.classification === "outcome_unknown"
            ? "outcome_unknown"
            : "terminal",
        );
      }
    }
    if (work) work.stage = "timer_plan";
  }

  patched(READ_PROJECTION_BEFORE_TIMER_PATCH_ID);

  if (patched(PLAN_TIMER_WITH_PROJECTION_PATCH_ID)) {
    const timerPlan = await planTimerActivity(turn);
    return buildSplitTurnTransitionResult({
      process,
      projection: timerPlan.projection || null,
      timerPlan,
    });
  }

  const [projection, timerPlan] = await Promise.all([
    readProjectionActivity({
      conversationId: turn.conversationId,
    }),
    planTimerActivity(turn),
  ]);

  return buildSplitTurnTransitionResult({
    process,
    projection,
    timerPlan,
  });
}

function isGenerativeResultEvent(
  event: AiriConversationExternalEvent,
): event is AiriScenarioGenerativeAIResultEvent {
  return event.kind === "generative_ai_result";
}

class ConfirmedPaymentSkippedError extends Error {}

async function executeConfirmedPaymentEvent(
  event: AiriConversationPaymentConfirmedEvent,
  lifecycle: AiriConversationExternalEventLifecycle,
  checkpoint?: AiriConversationTurnRetryWork,
): Promise<AiriConversationExternalEventResult> {
  const result = await handleExternalEventActivity(event);
  if (result.paymentDisposition === "terminal") return result;
  if (event.phase === "complete") {
    throw new Error(
      "Payment acknowledgement did not return a terminal disposition",
    );
  }
  const turn = result.paymentTurn;
  if (
    result.paymentDisposition !== "ready" ||
    !turn ||
    turn.workspaceId !== event.workspaceId ||
    turn.conversationId !== event.conversationId ||
    turn.sourceId !== event.sourceId ||
    turn.channel !== "whatsapp" ||
    turn.messageId !== `confirmed-payment:${event.conversionId}`
  ) {
    throw new Error("Payment event activity returned an invalid turn");
  }
  const work = checkpoint || {
    turn,
    stage: "prepare" as const,
    attempt: 0,
    dueAtMs: Date.now(),
  };
  lifecycle.checkpointPayment(event, work);
  let completionStatus: "processed" | "skipped" | "failed" = "processed";
  let completionReason: string | undefined;
  try {
    const transition = await executeTurnWithSplitActivities(
      work.turn,
      work,
      true,
      (process) => {
        const body = process.outcome.responseBody as
          | Record<string, unknown>
          | null
          | undefined;
        if (
          process.outcome.skippedConcurrent ||
          body?.skipped_concurrent === true ||
          body?.duplicate_processing === true
        ) {
          if (process.pendingDelivery || process.deferredCommand) {
            throw new TurnDispositionError(
              "Busy payment preparation returned delivery work",
              "outcome_unknown",
            );
          }
          // These responses explicitly prove execution did not start; never cache a busy result.
          delete work.process;
          work.stage = "prepare";
          throw new TurnDispositionError(
            "Confirmed payment preparation is busy",
            "retryable",
          );
        }
      },
      (delivery) => {
        if (delivery.classification === "skipped") {
          throw new ConfirmedPaymentSkippedError(
            "Payment delivery was skipped",
          );
        }
        if (delivery.classification !== "sent") {
          throw new TurnDispositionError(
            "Payment delivery did not confirm a send",
            delivery.classification === "not_attempted"
              ? "terminal"
              : "outcome_unknown",
          );
        }
      },
    );
    const body = transition.outcome.responseBody as
      | Record<string, unknown>
      | null
      | undefined;
    if (
      !work.process?.pendingDelivery &&
      !work.process?.deferredCommand &&
      (body?.skipped_confirmed_payment_scenario === true ||
        body?.skipped_authoritative_scenario_continuation === true ||
        body?.skipped_airi_disabled === true ||
        body?.skipped === true ||
        body?.cancelled === true ||
        body?.skipped_by_handoff_lock === true ||
        body?.skipped_by_manager_guard === true ||
        (typeof body?.skipped_scenario_action === "string" &&
          body.skipped_scenario_action.length > 0))
    ) {
      completionStatus = "skipped";
      completionReason = "payment_scenario_no_longer_runnable";
    }
  } catch (error) {
    if (error instanceof ConfirmedPaymentSkippedError) {
      completionStatus = "skipped";
      completionReason = "payment_delivery_skipped";
    } else {
      const disposition = classifyTurnFailure(work.stage, error, {
        retryKnownUnsentDelivery: patched(RETRY_KNOWN_UNSENT_DELIVERY_PATCH_ID),
        retryCompanyCapacity:
          isCompanyCapacityDeferredFailure(error) &&
          patched(COMPANY_CAPACITY_DEFERRED_PATCH_ID),
      });
      if (disposition === "retryable") throw error;
      completionStatus = "failed";
      completionReason = `payment_${work.stage}_${disposition}`;
    }
  }
  // Persist acknowledgement intent before the activity. An acknowledgement outage
  // resumes here, without preparing or delivering this payment a second time.
  const acknowledgement: AiriConversationPaymentConfirmedEvent = {
    ...event,
    phase: "complete",
    completionStatus,
    completionReason,
  };
  lifecycle.checkpointPayment(acknowledgement);
  const acknowledged = await handleExternalEventActivity(acknowledgement);
  if (acknowledged.paymentDisposition !== "terminal") {
    throw new Error(
      "Payment acknowledgement did not return a terminal disposition",
    );
  }
  return acknowledged;
}

async function executeExternalEventWithDelivery(
  event: AiriConversationExternalEvent,
): Promise<AiriConversationExternalEventResult> {
  const result = await handleExternalEventActivity(event);
  if (!isGenerativeResultEvent(event)) {
    return result;
  }
  if (result.generativeResultDisposition === "pending_delivery") {
    if (!result.pendingDelivery) {
      throw new Error(
        "Generative result pending disposition requires a delivery",
      );
    }
    await executeWorkflowLocalDelivery({
      request: result.pendingDelivery,
      effects: result.pendingDelivery.postDeliveryEffects || [],
      finalizeGenerativeTerminalOnUnsent: true,
    });
  } else if (
    result.generativeResultDisposition !== "suppressed_stale" ||
    result.pendingDelivery
  ) {
    throw new Error("Generative result activity returned an invalid outcome");
  }

  return handleExternalEventActivity({
    kind: "timer_replan",
    workspaceId: event.workspaceId,
    conversationId: event.conversationId,
    messageId: `generative-result-replan:${event.executionId}`,
  });
}

async function acknowledgeProcessedGenerativeResult(
  event: AiriScenarioGenerativeAIResultEvent,
): Promise<void> {
  await getExternalWorkflowHandle(event.scenarioWorkflowId).signal(
    AIRI_SCENARIO_GENERATIVE_AI_RESULT_PROCESSED_SIGNAL,
    {
      contractVersion: 1,
      executionId: event.executionId,
    },
  );
}

function timersEqual(
  left: AiriConversationTimerDescriptor | null,
  right: AiriConversationTimerDescriptor | null,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;

  return (
    left.kind === right.kind &&
    left.scenarioId === right.scenarioId &&
    left.dueAt === right.dueAt &&
    left.triggerNodeId === right.triggerNodeId &&
    left.conditionNodeId === right.conditionNodeId &&
    left.sourceActionNodeId === right.sourceActionNodeId &&
    left.waitStartedAt === right.waitStartedAt &&
    left.lastInboundMessageId === right.lastInboundMessageId &&
    left.pendingLastOutboundMessageId === right.pendingLastOutboundMessageId
  );
}

function setActiveTimer(
  state: AiriConversationWorkflowState,
  nextTimer: AiriConversationTimerDescriptor | null,
  reason?: string | null,
): void {
  const nextReason = nextTimer ? reason || null : null;
  if (
    timersEqual(state.activeTimer, nextTimer) &&
    state.activeTimerReason === nextReason
  ) {
    return;
  }

  state.activeTimer = nextTimer;
  state.activeTimerReason = nextReason;
  if (
    state.timerPreparationRetry &&
    !timersEqual(state.timerPreparationRetry.timer, nextTimer)
  ) {
    state.timerPreparationRetry = null;
  }
  state.updatedAt = nowIso();
}

/**
 * A timer turn that left its wait untouched (skipped or failed) plans the very
 * timer that fired it. Arming that again would fire it again at once, forever.
 */
function withoutRefiredTimer(
  state: AiriConversationWorkflowState,
  turn: AiriConversationTurnSignal,
  timer: AiriConversationTimerDescriptor | null,
): AiriConversationTimerDescriptor | null {
  if (
    timer &&
    isSyntheticTimerTurn(turn) &&
    timersEqual(timer, state.lastFiredTimer || null) &&
    patched(SUPPRESS_TIMER_REFIRE_PATCH_ID)
  ) {
    return null;
  }

  return timer;
}

async function recoverTimerAfterFailedTurn(params: {
  state: AiriConversationWorkflowState;
  turn: AiriConversationTurnSignal;
  failureMessage: string;
}): Promise<boolean> {
  if (!patched(PLAN_TIMER_AFTER_FAILED_TURN_PATCH_ID)) {
    return false;
  }

  return replanTimerAfterFailedTurn(params);
}

/** Planning is read-only, so it is safe even when the turn's outcome is unknown. */
async function replanTimerAfterFailedTurn(params: {
  state: AiriConversationWorkflowState;
  turn: AiriConversationTurnSignal;
  failureMessage: string;
}): Promise<boolean> {
  try {
    const timerPlan = await planTimerActivity(params.turn);
    if (timerPlan.projection) {
      applyProjection(params.state, timerPlan.projection);
    }
    const timer = withoutRefiredTimer(
      params.state,
      params.turn,
      timerPlan.timer || null,
    );
    setActiveTimer(params.state, timer, timerPlan.reason || null);

    if (timer) {
      params.state.lastExecutionError = `${params.failureMessage}; timer recovered: ${
        timerPlan.reason || "timer_replanned"
      }`;
    }

    return Boolean(timer);
  } catch (recoveryError) {
    params.state.lastExecutionError = `${
      params.failureMessage
    }; timer recovery failed: ${normalizeErrorMessage(recoveryError)}`;
    return false;
  }
}

function getTimerDelayMs(timer: AiriConversationTimerDescriptor): number {
  const dueAtMs = new Date(timer.dueAt).getTime();
  if (Number.isNaN(dueAtMs)) {
    return 0;
  }

  return Math.max(0, dueAtMs - Date.now());
}

async function waitForNextSignalOrTimer(params: {
  state: AiriConversationWorkflowState;
  pendingTurns: AiriConversationTurnSignal[];
  pendingExternalEvents: AiriConversationExternalEvent[];
  externalEventLifecycle: AiriConversationExternalEventLifecycle;
  useDurableGenerativeEvents: boolean;
  useDurableTurnRecovery: boolean;
  turnRecovery: TurnRecovery;
}): Promise<"continue" | "idle_timeout"> {
  const {
    state,
    pendingTurns,
    pendingExternalEvents,
    externalEventLifecycle,
    useDurableGenerativeEvents,
    useDurableTurnRecovery,
    turnRecovery,
  } = params;

  if (useDurableGenerativeEvents || useDurableTurnRecovery) {
    const nowMs = Date.now();
    const hasTurnRetry = () =>
      useDurableTurnRecovery && turnRecovery.hasReady(Date.now());
    if (
      pendingTurns.length > 0 ||
      externalEventLifecycle.hasReady(nowMs) ||
      hasTurnRetry()
    ) {
      return "continue";
    }
    const retryDueAtMs = externalEventLifecycle.nextDueAtMs();
    const activeTimerDueAtMs = state.activeTimer
      ? Math.max(
          new Date(state.activeTimer.dueAt).getTime(),
          useDurableTurnRecovery && state.timerPreparationRetry
            ? new Date(state.timerPreparationRetry.nextAttemptAt).getTime()
            : 0,
        )
      : null;
    const turnRetryDueAtMs = useDurableTurnRecovery
      ? turnRecovery.nextDueAtMs()
      : null;
    const finiteDueAtMs = [
      retryDueAtMs,
      activeTimerDueAtMs,
      turnRetryDueAtMs,
    ].filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
    const nextDueAtMs =
      finiteDueAtMs.length > 0 ? Math.min(...finiteDueAtMs) : null;

    if (nextDueAtMs === null) {
      const hasSignal = await condition(
        () =>
          pendingTurns.length > 0 ||
          externalEventLifecycle.hasReady(Date.now()) ||
          hasTurnRetry(),
        IDLE_CLOSE_TIMEOUT,
      );
      return hasSignal ? "continue" : "idle_timeout";
    }

    const retrySnapshot = retryDueAtMs;
    const timerSnapshot = state.activeTimer;
    await condition(
      () =>
        pendingTurns.length > 0 ||
        hasTurnRetry() ||
        externalEventLifecycle.hasReady(Date.now()) ||
        externalEventLifecycle.nextDueAtMs() !== retrySnapshot ||
        !timersEqual(state.activeTimer, timerSnapshot),
      Math.max(0, nextDueAtMs - nowMs),
    );
    return "continue";
  }

  if (pendingTurns.length > 0 || pendingExternalEvents.length > 0) {
    return "continue";
  }

  const activeTimer = state.activeTimer;
  if (!activeTimer) {
    const hasSignal = await condition(
      () => pendingTurns.length > 0 || pendingExternalEvents.length > 0,
      IDLE_CLOSE_TIMEOUT,
    );
    return hasSignal ? "continue" : "idle_timeout";
  }

  const snapshot = activeTimer;
  const delayMs = getTimerDelayMs(snapshot);

  if (delayMs <= 0) {
    return "continue";
  }

  const signalOrTimerChanged = () =>
    pendingTurns.length > 0 ||
    pendingExternalEvents.length > 0 ||
    !timersEqual(state.activeTimer, snapshot);

  const hasCancelStaleTimerSleepPatch = patched(
    CANCEL_STALE_TIMER_SLEEP_PATCH_ID,
  );
  const shouldUseConditionTimeout =
    state.timerWaitMode === "condition_timeout" ||
    hasCancelStaleTimerSleepPatch;

  if (shouldUseConditionTimeout) {
    await condition(signalOrTimerChanged, delayMs);
    return "continue";
  }

  await Promise.race([sleep(delayMs), condition(signalOrTimerChanged)]);
  return "continue";
}

export async function airiConversationWorkflow(
  input: AiriConversationWorkflowInput,
): Promise<void> {
  const useDurableTurnRecovery = patched(DURABLE_TURN_RECOVERY_PATCH_ID);
  const turnRecovery = createTurnRecovery(input.carryover?.turnLifecycle);
  const useDurableGenerativeEvents = patched(
    DURABLE_GENERATIVE_EXTERNAL_EVENTS_PATCH_ID,
  );
  const pendingTurns: AiriConversationTurnSignal[] = Array.isArray(
    input.carryover?.pendingTurns,
  )
    ? input.carryover.pendingTurns.filter(isValidTurnSignal)
    : [];
  const pendingExternalEvents: AiriConversationExternalEvent[] = Array.isArray(
    input.carryover?.pendingExternalEvents,
  )
    ? [...input.carryover.pendingExternalEvents]
    : [];
  const seenMessageIds = new Set<string>(
    copyStringArray(input.carryover?.seenMessageIds),
  );
  const seenExternalEventKeys = new Set<string>(
    copyStringArray(input.carryover?.seenExternalEventKeys),
  );
  const externalEventLifecycle = createAiriConversationExternalEventLifecycle(
    useDurableGenerativeEvents
      ? input.carryover?.externalEventLifecycle || {
          version: 1,
          queued: pendingExternalEvents.map((event) => ({
            event,
            attempt: 0,
            dueAtMs: 0,
          })),
          inFlight: null,
          controlSeenKeys: copyStringArray(
            input.carryover?.seenExternalEventKeys,
          ),
          processedGenerativeKeys: [],
        }
      : null,
  );
  const hasPendingExternalWork = (): boolean => {
    if (!useDurableGenerativeEvents) {
      return pendingExternalEvents.length > 0;
    }
    const snapshot = externalEventLifecycle.snapshot();
    return snapshot.inFlight !== null || snapshot.queued.length > 0;
  };
  let acceptedPaymentEvents = 0;
  const workflowId = buildAiriConversationWorkflowId(input.conversationId);
  const routing = resolveAiriConversationRouting({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    sourceId: input.sourceId,
  });
  const carryoverState = input.carryover?.state || null;
  const initialUpdatedAt =
    carryoverState?.updatedAt || input.startedAt || nowIso();
  const initialStartedAt =
    carryoverState?.startedAt || input.startedAt || nowIso();

  const state: AiriConversationWorkflowState = {
    workflowId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    sourceId: input.sourceId || null,
    taskQueue: routing.taskQueue || AIRI_CONVERSATION_TASK_QUEUE,
    status:
      carryoverState?.status ||
      (pendingTurns.length > 0 || hasPendingExternalWork()
        ? "pending"
        : "idle"),
    pendingTurns: pendingTurns.length,
    lastSignalAt: carryoverState?.lastSignalAt || input.startedAt || nowIso(),
    activeMessageId: carryoverState?.activeMessageId || null,
    lastProcessedMessageId: carryoverState?.lastProcessedMessageId || null,
    lastProcessedAt: carryoverState?.lastProcessedAt || null,
    lastExecutionStatus: carryoverState?.lastExecutionStatus || "idle",
    lastExecutionError: carryoverState?.lastExecutionError || null,
    updatedAt: initialUpdatedAt,
    startedAt: initialStartedAt,
    currentTopic: carryoverState?.currentTopic || null,
    projection: buildProjectionFromCarryover(carryoverState),
    lastResponseStatus: carryoverState?.lastResponseStatus ?? null,
    lastResponseSkippedConcurrent:
      carryoverState?.lastResponseSkippedConcurrent ?? false,
    projectionUpdatedAt: carryoverState?.projectionUpdatedAt || null,
    activeTimer: carryoverState?.activeTimer || null,
    activeTimerReason: carryoverState?.activeTimerReason || null,
    lastFiredTimer: carryoverState?.lastFiredTimer || null,
    ...(useDurableTurnRecovery
      ? {
          timerPreparationRetry: carryoverState?.timerPreparationRetry || null,
        }
      : {}),
    timerWaitMode: normalizeTimerWaitMode(
      carryoverState?.timerWaitMode || input.timerWaitMode,
    ),
  };

  const recordDisposition = async (
    disposition: AiriConversationTurnDisposition,
  ) => {
    await recordTurnDispositionActivity(disposition);
    turnRecovery.record(disposition);
  };

  const supersede = async (
    work: AiriConversationTurnRetryWork,
    replacement: string,
  ) => {
    await recordDisposition({
      turn: toAiriConversationTurnReference(work.turn),
      stage: work.stage,
      attempt: work.attempt,
      status: "superseded",
      updatedAt: nowIso(),
      error: null,
      nextAttemptAt: null,
      supersededByMessageId: replacement,
    });
  };

  const continueAsNewIfSuggested = async (force = false) => {
    // Count new signals in this run: a restored backlog must not copy itself
    // into another run after every item merely because it still exceeds 256.
    const paymentBurst =
      acceptedPaymentEvents >= AIRI_CONVERSATION_EXTERNAL_EVENT_PENDING_LIMIT;
    if (!force && !paymentBurst && !workflowInfo().continueAsNewSuggested) {
      return;
    }

    const lifecycleSnapshot = externalEventLifecycle.snapshot();
    const hasLifecycleSnapshot =
      lifecycleSnapshot.queued.length > 0 ||
      lifecycleSnapshot.inFlight !== null ||
      lifecycleSnapshot.controlSeenKeys.length > 0 ||
      lifecycleSnapshot.processedGenerativeKeys.length > 0 ||
      !!lifecycleSnapshot.processedPaymentKeys?.length;
    const hasPendingExternalEvents = useDurableGenerativeEvents
      ? lifecycleSnapshot.queued.length > 0 ||
        lifecycleSnapshot.inFlight !== null
      : pendingExternalEvents.length > 0;

    const carryoverRuntimeState = toRuntimeState({
      ...state,
      status:
        pendingTurns.length > 0 ||
        hasPendingExternalEvents ||
        turnRecovery.nextDueAtMs() !== null
          ? "pending"
          : "idle",
      activeMessageId: null,
      updatedAt: nowIso(),
    });

    await continueAsNew<typeof airiConversationWorkflow>({
      contractVersion: AIRI_CONVERSATION_WORKFLOW_CONTRACT_VERSION,
      workspaceId: state.workspaceId,
      conversationId: state.conversationId,
      sourceId: state.sourceId,
      startedAt: state.startedAt,
      carryover: {
        state: carryoverRuntimeState,
        pendingTurns: pendingTurns.length > 0 ? [...pendingTurns] : [],
        seenMessageIds: limitStringArray(seenMessageIds),
        ...(useDurableTurnRecovery ||
        turnRecovery.snapshot().retries.length > 0 ||
        turnRecovery.snapshot().recentDispositions.length > 0
          ? { turnLifecycle: turnRecovery.snapshot() }
          : {}),
        ...(useDurableGenerativeEvents
          ? hasLifecycleSnapshot
            ? { externalEventLifecycle: lifecycleSnapshot }
            : {}
          : {
              pendingExternalEvents:
                pendingExternalEvents.length > 0
                  ? [...pendingExternalEvents]
                  : [],
              seenExternalEventKeys: limitStringArray(seenExternalEventKeys),
            }),
      },
    });
  };

  const enqueueTurn = (turn: AiriConversationTurnSignal) => {
    if (!isValidTurnSignal(turn)) {
      return;
    }

    const turnKey = getAiriConversationTurnKey(turn);
    if (
      seenMessageIds.has(turnKey) ||
      (useDurableTurnRecovery && turnRecovery.hasMessage(turnKey))
    )
      return;
    seenMessageIds.add(turnKey);
    pendingTurns.push(turn);
    if (
      !isSyntheticTimerTurn(turn) &&
      !turn.messageRecoveryRevision &&
      !turn.whatsappMessageContentUnavailable
    ) {
      setActiveTimer(state, null);
    }
    state.pendingTurns = pendingTurns.length;
    state.lastSignalAt = turn.messageDate || nowIso();
    state.updatedAt = nowIso();
    state.status = "pending";

    const turnText = normalizeTurnText(turn);
    if (turnText) {
      state.currentTopic = turnText;
      state.projection.currentGoal = turnText;
    }
  };

  const enqueueExternalEvent = (event: AiriConversationExternalEvent) => {
    if (useDurableGenerativeEvents) {
      const result = externalEventLifecycle.enqueue(event, Date.now());
      if (result.classification !== "enqueued") return;
      if (event.kind === "payment_confirmed") acceptedPaymentEvents++;
      if (event.kind !== "payment_confirmed") setActiveTimer(state, null);
      state.lastSignalAt = normalizeExternalEventIso(event) || nowIso();
      state.updatedAt = nowIso();
      state.status = "pending";
      return;
    }

    const eventKey = buildExternalEventKey(event);
    if (!isGenerativeResultEvent(event)) {
      if (seenExternalEventKeys.has(eventKey)) return;
      seenExternalEventKeys.add(eventKey);
    }
    pendingExternalEvents.push(event);
    if (event.kind !== "payment_confirmed") setActiveTimer(state, null);
    state.lastSignalAt = normalizeExternalEventIso(event) || nowIso();
    state.updatedAt = nowIso();
    state.status = pendingTurns.length > 0 ? "pending" : "idle";
  };

  const dequeueLatestTurn = (): AiriConversationTurnSignal | null => {
    if (pendingTurns.length === 0) {
      state.pendingTurns = 0;
      return null;
    }

    let latestTurn: AiriConversationTurnSignal | null = null;
    while (pendingTurns.length > 0 && !latestTurn) {
      const candidate = pendingTurns.pop();
      latestTurn = isValidTurnSignal(candidate) ? candidate : null;
    }
    pendingTurns.length = 0;
    state.pendingTurns = 0;
    state.updatedAt = nowIso();
    return latestTurn;
  };

  /**
   * Takes the oldest ordered event alone, or the oldest run of other turns
   * up to that boundary. A run is answered by its newest turn, as before.
   */
  const dequeueNextTurnInOrder = (): {
    turn: AiriConversationTurnSignal | null;
    coalesced: AiriConversationTurnSignal[];
  } => {
    let count = 1;
    if (!isInOrderTurn(pendingTurns[0])) {
      while (count < pendingTurns.length && !isInOrderTurn(pendingTurns[count]))
        count++;
    }
    const taken = pendingTurns.splice(0, count);
    const nextTurn = taken.filter(isValidTurnSignal).at(-1) || null;
    state.pendingTurns = pendingTurns.length;
    state.updatedAt = nowIso();
    return {
      turn: nextTurn,
      coalesced: taken.filter(
        (item): item is AiriConversationTurnSignal =>
          item !== nextTurn && isValidTurnSignal(item),
      ),
    };
  };

  if (input.initialTurn) {
    enqueueTurn(input.initialTurn);
  }

  setHandler(ingestTurnSignal, (turn) => {
    enqueueTurn(turn);
  });

  setHandler(ingestExternalEventSignal, (event) => {
    if (event.kind === "payment_confirmed") {
      // A signal conveys identity only. Completion is an internal workflow checkpoint.
      const {
        phase: _phase,
        completionStatus: _status,
        completionReason: _reason,
        ...identity
      } = event;
      enqueueExternalEvent(identity);
      return;
    }
    enqueueExternalEvent(event);
  });

  setHandler(getRuntimeStateQuery, () => {
    const recovery = turnRecovery.snapshot();
    const errorsByTurnKey = new Map(
      recovery.recentDispositions.map((item) => [
        getAiriConversationTurnKey(item.turn),
        item.error,
      ]),
    );
    return toRuntimeState({
      ...state,
      pendingTurns: pendingTurns.length,
      ...(useDurableTurnRecovery
        ? {
            turnRecovery: {
              pendingRetries: recovery.retries.map((work) => ({
                turn: toAiriConversationTurnReference(work.turn),
                stage: work.stage,
                status: "retryable" as const,
                attempt: work.attempt,
                updatedAt: state.updatedAt,
                error:
                  errorsByTurnKey.get(getAiriConversationTurnKey(work.turn)) ||
                  null,
                nextAttemptAt: new Date(work.dueAtMs).toISOString(),
              })),
              recentDispositions: recovery.recentDispositions,
            },
          }
        : {}),
    });
  });

  while (true) {
    const waitResult = await waitForNextSignalOrTimer({
      state,
      pendingTurns,
      pendingExternalEvents,
      externalEventLifecycle,
      useDurableGenerativeEvents,
      useDurableTurnRecovery,
      turnRecovery,
    });
    if (waitResult === "idle_timeout") {
      state.status = "idle";
      if (!useDurableTurnRecovery) state.lastExecutionStatus = "idle";
      state.activeMessageId = null;
      state.updatedAt = nowIso();
      return;
    }

    if (
      !useDurableGenerativeEvents &&
      (pendingExternalEvents.some(isGenerativeResultEvent) ||
        pendingExternalEvents.some(
          (event) => event.kind === "payment_confirmed",
        ))
    ) {
      await continueAsNewIfSuggested(true);
    }

    const hasReadyExternalEvent = useDurableGenerativeEvents
      ? externalEventLifecycle.hasReady(Date.now())
      : pendingExternalEvents.length > 0;
    if (hasReadyExternalEvent) {
      const readyEvent = useDurableGenerativeEvents
        ? externalEventLifecycle.takeReady(Date.now())
        : null;
      const nextEvent = useDurableGenerativeEvents
        ? readyEvent?.event || null
        : pendingExternalEvents.shift() || null;
      if (!nextEvent) {
        continue;
      }
      let forceDurableContinueAsNew = false;

      state.status = "processing";
      state.lastExecutionStatus = "running";
      state.lastExecutionError = null;
      state.activeMessageId = nextEvent.messageId;
      state.updatedAt = nowIso();

      try {
        const result =
          nextEvent.kind === "payment_confirmed"
            ? await executeConfirmedPaymentEvent(
                nextEvent,
                externalEventLifecycle,
                readyEvent?.paymentTurnWork,
              )
            : await executeExternalEventWithDelivery(nextEvent);
        if (result.projection) {
          applyProjection(state, result.projection);
        }
        if (result.timer) {
          setActiveTimer(state, result.timer, "external_event_replanned");
        } else if (result.clearTimer) {
          setActiveTimer(state, null);
        }
        if (useDurableGenerativeEvents && isGenerativeResultEvent(nextEvent)) {
          await acknowledgeProcessedGenerativeResult(nextEvent);
        }
        if (useDurableGenerativeEvents) {
          externalEventLifecycle.completeInFlight();
        }
        state.lastProcessedMessageId = nextEvent.messageId;
        state.lastProcessedAt =
          normalizeExternalEventIso(nextEvent) || nowIso();
        state.lastExecutionStatus = "completed";
        state.lastExecutionError = null;
      } catch (error) {
        const retryTimerReplan =
          nextEvent.kind === "timer_replan" &&
          patched(DURABLE_TIMER_REPLAN_RETRY_PATCH_ID);
        if (useDurableGenerativeEvents) {
          externalEventLifecycle.failInFlight(Date.now(), retryTimerReplan);
        } else if (retryTimerReplan) {
          pendingExternalEvents.unshift(nextEvent);
          forceDurableContinueAsNew = true;
        }
        if (
          !useDurableGenerativeEvents ||
          (!isGenerativeResultEvent(nextEvent) &&
            nextEvent.kind !== "payment_confirmed")
        ) {
          state.lastProcessedMessageId = nextEvent.messageId;
          state.lastProcessedAt = nowIso();
        }
        state.lastExecutionStatus = "failed";
        state.lastExecutionError = normalizeErrorMessage(error);
      } finally {
        state.activeMessageId = null;
        state.status =
          pendingTurns.length > 0 || hasPendingExternalWork()
            ? "pending"
            : "idle";
        state.pendingTurns = pendingTurns.length;
        state.updatedAt = nowIso();
      }

      await continueAsNewIfSuggested(forceDurableContinueAsNew);

      continue;
    }

    if (pendingTurns.length === 0 && state.activeTimer) {
      const activeTimer = state.activeTimer;
      const delayMs = Math.max(
        getTimerDelayMs(activeTimer),
        useDurableTurnRecovery && state.timerPreparationRetry
          ? new Date(state.timerPreparationRetry.nextAttemptAt).getTime() -
              Date.now()
          : 0,
      );

      if (delayMs <= 0) {
        state.status = "processing";
        state.lastExecutionStatus = "running";
        state.lastExecutionError = null;
        state.activeMessageId = `timer:${activeTimer.scenarioId}:${activeTimer.kind}`;
        state.updatedAt = nowIso();
        let forceDurableContinueAsNew = false;

        try {
          const prepared = await buildTimerTurnActivity(activeTimer);
          // An inbound signal can invalidate this exact wait while the activity runs.
          if (
            useDurableTurnRecovery &&
            !timersEqual(state.activeTimer, activeTimer)
          )
            continue;
          if (useDurableTurnRecovery) state.timerPreparationRetry = null;
          if (prepared.projection) {
            applyProjection(state, prepared.projection);
          }
          setActiveTimer(
            state,
            prepared.timer || null,
            prepared.reason || null,
          );

          if (prepared.turn) {
            state.lastFiredTimer = activeTimer;
            pendingTurns.push(prepared.turn);
            state.pendingTurns = pendingTurns.length;
            state.status = "pending";
          } else {
            state.lastProcessedMessageId = state.activeMessageId;
            state.lastProcessedAt = nowIso();
            state.lastExecutionStatus = "completed";
            state.lastExecutionError = prepared.reason || null;
            state.status = "idle";
          }
        } catch (error) {
          state.lastExecutionStatus = "failed";
          state.lastExecutionError = normalizeErrorMessage(error);
          if (
            useDurableTurnRecovery ||
            patched(DURABLE_TURN_FAILURE_MIGRATION_PATCH_ID)
          ) {
            if (timersEqual(state.activeTimer, activeTimer)) {
              const attempt = Math.min(
                (state.timerPreparationRetry?.attempt || 0) + 1,
                1_000_000,
              );
              state.timerPreparationRetry = {
                timer: activeTimer,
                attempt,
                nextAttemptAt: new Date(
                  nextTurnRetryAt(Date.now(), attempt),
                ).toISOString(),
                lastError: state.lastExecutionError,
              };
              state.status = "pending";
            }
            forceDurableContinueAsNew = !useDurableTurnRecovery;
          } else {
            state.lastProcessedMessageId = state.activeMessageId;
            state.lastProcessedAt = nowIso();
            setActiveTimer(state, null);
            state.status = "idle";
          }
        } finally {
          state.activeMessageId = null;
          state.updatedAt = nowIso();
        }

        await continueAsNewIfSuggested(forceDurableContinueAsNew);

        continue;
      }
    }

    if (
      pendingTurns.length === 0 &&
      !(useDurableTurnRecovery && turnRecovery.hasReady(Date.now()))
    ) {
      continue;
    }

    state.status = "processing";
    state.lastExecutionStatus = "running";
    state.lastExecutionError = null;
    state.updatedAt = nowIso();

    // Taps and entry-only message events need processing. Ordinary turns between
    // them still fold, retaining the existing behavior for older histories.
    const takeTurnsInOrder =
      (pendingTurns.some(isInOrderTurn) ||
        (useDurableTurnRecovery &&
          pendingTurns.length > 0 &&
          turnRecovery.hasUnstartedRetry((old) => isInOrderTurn(old.turn)))) &&
      patched(IN_ORDER_BUTTON_TAPS_PATCH_ID);
    // An older ordered turn awaiting preparation heads that queue, without
    // waiting out its backoff, so newer turns cannot overtake or supersede it.
    const orderedRetry =
      takeTurnsInOrder && useDurableTurnRecovery && pendingTurns.length > 0
        ? turnRecovery.takeUnstartedRetry((old) => isInOrderTurn(old.turn))
        : null;
    const inOrder =
      takeTurnsInOrder && !orderedRetry ? dequeueNextTurnInOrder() : null;
    const coalesced = inOrder
      ? inOrder.coalesced
      : useDurableTurnRecovery && !orderedRetry
        ? [...pendingTurns]
        : [];
    const freshTurn = orderedRetry
      ? null
      : inOrder
        ? inOrder.turn
        : dequeueLatestTurn();
    const work: AiriConversationTurnRetryWork | null =
      orderedRetry ??
      (freshTurn
        ? { turn: freshTurn, stage: "prepare", attempt: 0, dueAtMs: Date.now() }
        : useDurableTurnRecovery
          ? turnRecovery.takeReady(Date.now())
          : null);
    if (!work) {
      state.status = "idle";
      state.pendingTurns = 0;
      state.activeMessageId = null;
      state.lastExecutionStatus = "idle";
      continue;
    }
    const nextTurn = work.turn;
    if (useDurableTurnRecovery && freshTurn) {
      // Entry-only events cannot replace an unrelated ordinary preparation retry.
      const supersededRetries =
        freshTurn.messageRecoveryRevision ||
        freshTurn.whatsappMessageContentUnavailable
          ? []
          : turnRecovery.takeSupersedableRetries(
              takeTurnsInOrder ? (old) => !isInOrderTurn(old.turn) : undefined,
            );
      for (const old of coalesced) {
        if (
          getAiriConversationTurnKey(old) !==
          getAiriConversationTurnKey(freshTurn)
        )
          await supersede(
            { turn: old, stage: "prepare", attempt: 0, dueAtMs: 0 },
            freshTurn.messageId,
          );
      }
      for (const old of supersededRetries)
        await supersede(old, freshTurn.messageId);
    }

    state.activeMessageId = nextTurn.messageId;
    state.lastSignalAt = nextTurn.messageDate || state.lastSignalAt;

    const turnText = normalizeTurnText(nextTurn);
    if (turnText) {
      state.currentTopic = turnText;
      state.projection.currentGoal = turnText;
    }

    let forceDurableContinueAsNew = false;
    try {
      const result = await executeTurnWithSplitActivities(
        nextTurn,
        work,
        useDurableTurnRecovery,
      );
      if (useDurableTurnRecovery) {
        await recordDisposition({
          turn: toAiriConversationTurnReference(nextTurn),
          stage: work.stage,
          attempt: work.attempt,
          status: "completed",
          updatedAt: nowIso(),
          error: null,
          nextAttemptAt: null,
        });
      }

      state.lastProcessedMessageId = result.messageId;
      state.lastProcessedAt = result.completedAt;
      state.lastExecutionStatus = "completed";
      state.lastExecutionError = null;
      state.lastResponseStatus = result.outcome.responseStatus;
      state.lastResponseSkippedConcurrent = result.outcome.skippedConcurrent;
      applyProjection(state, result.projection || null);
      setActiveTimer(
        state,
        withoutRefiredTimer(state, nextTurn, result.timer || null),
        result.timerReason || null,
      );
    } catch (error) {
      const failureMessage = normalizeErrorMessage(error);
      state.lastExecutionStatus = "failed";
      state.lastExecutionError = failureMessage;
      state.lastResponseStatus = null;
      state.lastResponseSkippedConcurrent = false;
      if (
        useDurableTurnRecovery ||
        patched(DURABLE_TURN_FAILURE_MIGRATION_PATCH_ID)
      ) {
        const capacityDeferred =
          work.stage === "prepare" &&
          isCompanyCapacityDeferredFailure(error) &&
          patched(COMPANY_CAPACITY_DEFERRED_PATCH_ID);
        const attempt = capacityDeferred ? work.attempt : work.attempt + 1;
        let status = classifyTurnFailure(work.stage, error, {
          retryKnownUnsentDelivery: patched(
            RETRY_KNOWN_UNSENT_DELIVERY_PATCH_ID,
          ),
          retryCompanyCapacity: capacityDeferred,
        });
        if (
          !capacityDeferred &&
          status === "retryable" &&
          attempt >= MAX_TURN_RECOVERY_ATTEMPTS
        )
          status = "terminal";
        const dueAtMs =
          status === "retryable"
            ? capacityDeferred
              ? Date.now() + 60_000
              : nextTurnRetryAt(Date.now(), attempt)
            : null;
        await recordDisposition({
          turn: toAiriConversationTurnReference(nextTurn),
          stage: work.stage,
          attempt,
          status,
          updatedAt: nowIso(),
          error: failureMessage,
          nextAttemptAt:
            dueAtMs === null ? null : new Date(dueAtMs).toISOString(),
        });
        if (dueAtMs !== null)
          turnRecovery.schedule({
            ...work,
            attempt,
            dueAtMs,
            ...(work.stage === "delivery" && isKnownUnsentDeliveryFailure(error)
              ? { deliveryNotAttempted: true as const }
              : {}),
          });
        // Ingress cleared the timer; without a retry, nothing else re-plans the wait.
        else if (patched(REPLAN_TIMER_AFTER_UNRETRIED_TURN_FAILURE_PATCH_ID))
          await replanTimerAfterFailedTurn({
            state,
            turn: nextTurn,
            failureMessage,
          });
        forceDurableContinueAsNew = !useDurableTurnRecovery;
      } else {
        state.lastProcessedMessageId = nextTurn.messageId;
        state.lastProcessedAt = nowIso();
        const recoveredTimer = await recoverTimerAfterFailedTurn({
          state,
          turn: nextTurn,
          failureMessage,
        });
        if (!recoveredTimer) {
          setActiveTimer(state, null);
        }
      }
    } finally {
      state.activeMessageId = null;
      state.status =
        pendingTurns.length > 0 ||
        hasPendingExternalWork() ||
        turnRecovery.nextDueAtMs() !== null
          ? "pending"
          : "idle";
      state.pendingTurns = pendingTurns.length;
      state.updatedAt = nowIso();
    }

    await continueAsNewIfSuggested(forceDurableContinueAsNew);
  }
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  airiConversationWorkflow,
);
