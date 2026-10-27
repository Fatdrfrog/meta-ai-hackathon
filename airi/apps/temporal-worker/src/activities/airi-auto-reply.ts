import {
  buildAiriConversationTimerTurn,
  deliverAiriConversationOutbound,
  finalizeAiriConversationOutbound,
  handleAiriConversationExternalEvent,
  planAiriConversationTimer,
  prepareAiriAutoReplyJob,
  isAiriTurnPreparationNotStartedError,
  type AiriTurnExecutionStore,
  readAiriConversationProjection,
  terminalizeGenerativeAcknowledgment,
} from "@icecore/airi-runtime";
import { ApplicationFailure } from "@temporalio/activity";
import { getWorkspaceAiRequiredDetails } from "@icecore/shared/lib/workspace-ai-errors";
import { isCompanyRuntimeCapacityDeferredError } from "@icecore/shared/lib/company-runtime-capacity";
import {
  AIRI_TURN_PREPARATION_NOT_STARTED,
  AIRI_COMPANY_CAPACITY_DEFERRED,
  AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
  AIRI_OUTBOUND_PREPARATION_FAILED,
  isAiriOutboundPreparationFailedError,
  AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE,
  isAiriOutboundProviderRejectedError,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import type {
  AiriConversationExternalEvent,
  AiriConversationExternalEventResult,
  AiriConversationFinalizeOutboundInput,
  AiriConversationOutboundDeliveryRequest,
  AiriConversationOutboundDeliveryResult,
  AiriConversationPreparedTimerTurnResult,
  AiriConversationProjectionReadInput,
  AiriConversationTimerDescriptor,
  AiriConversationTurnExecutionOutcome,
  AiriConversationTurnProcessResult,
  AiriConversationTurnSignal,
  AiriConversationTurnDisposition,
  AiriConversationTerminalizeGenerativeAckInput,
} from "@icecore/temporal";

import { configureGcsCreativeAssetReadUrlPort } from "../creative-asset-read-url-gcs-adapter.js";
import { configureGcsWhatsAppVoiceReplyStorage } from "../whatsapp-voice-reply-gcs-adapter.js";
import * as timerRuntimeDependenciesModule from "@/lib/airi/scenario/timer-runtime-dependencies";
import * as autoReplyRuntimeDependenciesModule from "@/lib/airi/scenario/auto-reply-runtime-dependencies";

const { airiScenarioTimerDependencies } = readDefaultExport<
  typeof timerRuntimeDependenciesModule
>(timerRuntimeDependenciesModule);
const {
  AIChatProviderAggregateError,
  isRetryableAIProviderError,
  scenarioRuntimeDependencies,
  airiTurnExecutionStore,
  withWorkspaceRuntimeCapacity,
} = readDefaultExport<typeof autoReplyRuntimeDependenciesModule>(
  autoReplyRuntimeDependenciesModule,
);

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function readResponseBodyValue<T>(
  outcome: AiriConversationTurnExecutionOutcome,
  key: string,
): T | undefined {
  if (!outcome.responseBody || typeof outcome.responseBody !== "object") {
    return undefined;
  }

  return (outcome.responseBody as Record<string, unknown>)[key] as
    | T
    | undefined;
}

function logStructuredTurnOutcome(params: {
  operation: "prepare";
  turn: AiriConversationTurnSignal;
  outcome: AiriConversationTurnExecutionOutcome;
  durationMs: number;
}): void {
  const { operation, turn, outcome, durationMs } = params;

  let kind:
    | "completed"
    | "suppressed"
    | "skipped_concurrent"
    | "manager_guard"
    | "grounding_guard"
    | "failed" = outcome.executionStatus === "failed" ? "failed" : "completed";

  if (outcome.skippedConcurrent) {
    kind = "skipped_concurrent";
  } else if (
    readResponseBodyValue<boolean>(outcome, "skipped_by_manager_guard")
  ) {
    kind = "manager_guard";
  } else if (
    readResponseBodyValue<string>(outcome, "skipped_delivery_reason") ===
    "confidence_below_threshold"
  ) {
    kind = "grounding_guard";
  } else if (
    readResponseBodyValue<string>(outcome, "skipped_delivery_reason")
  ) {
    kind = "suppressed";
  }

  airiWorkerLogger.info("airi.worker.turn_outcome", {
    note:
      outcome.executionStatus === "failed" ? "turn_failed" : "turn_processed",
    operation,
    kind,
    workspaceId: turn.workspaceId,
    conversationId: turn.conversationId,
    messageId: turn.messageId,
    channel: turn.channel || null,
    triggerEventKind: turn.triggerEventKind || null,
    responseStatus: outcome.responseStatus,
    skippedConcurrent: outcome.skippedConcurrent,
    deliveryReason:
      readResponseBodyValue<string>(outcome, "skipped_delivery_reason") || null,
    replyOutcome:
      readResponseBodyValue<string>(outcome, "reply_outcome") || null,
    managerGuardReason:
      readResponseBodyValue<string>(outcome, "reason") || null,
    durationMs,
  });
}

function buildExecutionOutcome(params: {
  result: unknown;
}): AiriConversationTurnExecutionOutcome {
  if (params.result instanceof Response) {
    return {
      responseStatus: params.result.status,
      skippedConcurrent: false,
      executionStatus: params.result.status >= 400 ? "failed" : "response",
    };
  }

  return {
    responseStatus: null,
    skippedConcurrent: false,
    executionStatus: "completed",
  };
}

async function enrichResponseOutcome(params: {
  result: Response;
  baseOutcome: AiriConversationTurnExecutionOutcome;
}): Promise<AiriConversationTurnExecutionOutcome> {
  const responseBody = await params.result
    .clone()
    .json()
    .catch(() => null);

  const skippedConcurrent =
    params.result.status === 200 &&
    responseBody &&
    typeof responseBody === "object" &&
    (responseBody as { skipped_concurrent?: unknown }).skipped_concurrent ===
      true;

  return {
    ...params.baseOutcome,
    executionStatus:
      responseBody &&
      typeof responseBody === "object" &&
      ((responseBody as { status?: unknown }).status === "failed" ||
        (responseBody as { executionStatus?: unknown }).executionStatus ===
          "failed")
        ? "failed"
        : params.baseOutcome.executionStatus,
    skippedConcurrent,
    responseBody,
  };
}

export async function prepareAiriConversationTurn(
  turn: AiriConversationTurnSignal,
  executionStore: AiriTurnExecutionStore = airiTurnExecutionStore,
): Promise<AiriConversationTurnProcessResult> {
  try {
    return await withWorkspaceRuntimeCapacity(
      turn.workspaceId,
      "conversation",
      () => prepareAiriConversationTurnWithCapacity(turn, executionStore),
    );
  } catch (error) {
    if (isCompanyRuntimeCapacityDeferredError(error)) {
      throw ApplicationFailure.nonRetryable(
        error.message,
        AIRI_COMPANY_CAPACITY_DEFERRED,
      );
    }
    throw error;
  }
}

async function prepareAiriConversationTurnWithCapacity(
  turn: AiriConversationTurnSignal,
  executionStore: AiriTurnExecutionStore,
): Promise<AiriConversationTurnProcessResult> {
  const {
    claimAiriTurnPreparation,
    completeAiriTurnPreparation,
    failAiriTurnPreparation,
  } = executionStore;
  const startedAt = Date.now();
  let claim: Awaited<ReturnType<typeof claimAiriTurnPreparation>>;
  try {
    claim = await claimAiriTurnPreparation(turn);
  } catch (error) {
    // No mutable reply runtime was entered. An ambiguous claim remains fenced
    // in Mongo and will be inspected by the next attempt instead of stolen.
    throw ApplicationFailure.retryable(
      normalizeErrorMessage(error),
      AIRI_TURN_PREPARATION_NOT_STARTED,
    );
  }
  if (claim.status === "prepared") return claim.result;
  if (claim.status === "terminal") {
    throw ApplicationFailure.nonRetryable(
      "Airi turn preparation is already terminal",
      "AIRI_TURN_PREPARATION_TERMINAL",
    );
  }
  if (claim.status !== "claimed") {
    throw ApplicationFailure.nonRetryable(
      "Airi turn preparation has no safe replay checkpoint",
      AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
    );
  }
  let paymentWaitingForLock = false;
  try {
    const result = await prepareAiriAutoReplyJob(
      turn,
      scenarioRuntimeDependencies,
    );

    let outcome = buildExecutionOutcome({ result: result.result });
    if (result.result instanceof Response) {
      outcome = await enrichResponseOutcome({
        result: result.result,
        baseOutcome: outcome,
      });
    }
    if (
      turn.messageId.startsWith("confirmed-payment:") &&
      !result.pendingDelivery &&
      !result.deferredCommand &&
      (outcome.skippedConcurrent ||
        readResponseBodyValue<boolean>(outcome, "duplicate_processing") ===
          true)
    ) {
      // The payment branch has not acquired the conversation lock or mutated
      // its wait. Release the preparation receipt instead of caching "busy".
      paymentWaitingForLock = true;
      throw new Error("Confirmed payment is waiting for the conversation lock");
    }
    logStructuredTurnOutcome({
      operation: "prepare",
      turn,
      outcome,
      durationMs: Date.now() - startedAt,
    });

    const process: AiriConversationTurnProcessResult = {
      messageId: turn.messageId,
      completedAt: new Date().toISOString(),
      outcome,
      pendingDelivery: result.pendingDelivery
        ? {
            ...result.pendingDelivery,
            postDeliveryEffects:
              result.pendingDelivery.postDeliveryEffects ||
              result.postDeliveryEffects ||
              [],
          }
        : null,
      deferredCommand: result.deferredCommand || null,
    };
    await completeAiriTurnPreparation(claim, process);
    return process;
  } catch (error) {
    if (
      turn.messageId.startsWith("confirmed-payment:") &&
      isAiriTurnPreparationNotStartedError(error) &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "AIRI_CONFIRMED_PAYMENT_NOT_ELIGIBLE"
    ) {
      const skipped: AiriConversationTurnProcessResult = {
        messageId: turn.messageId,
        completedAt: new Date().toISOString(),
        outcome: {
          responseStatus: 200,
          executionStatus: "response",
          skippedConcurrent: false,
          responseBody: {
            status: "ok",
            skipped_confirmed_payment_scenario: true,
            reason: "payment_context_unavailable",
          },
        },
        pendingDelivery: null,
      };
      await completeAiriTurnPreparation(claim, skipped);
      return skipped;
    }
    airiWorkerLogger.error("airi.worker.turn_outcome", error, {
      note: "turn_failed",
      operation: "prepare",
      outcome: "failed",
      kind: "failed",
      workspaceId: turn.workspaceId,
      conversationId: turn.conversationId,
      messageId: turn.messageId,
      channel: turn.channel || null,
      triggerEventKind: turn.triggerEventKind || null,
      errorMessage: normalizeErrorMessage(error),
      durationMs: Date.now() - startedAt,
    });
    const safeToRetry =
      paymentWaitingForLock || isAiriTurnPreparationNotStartedError(error);
    try {
      await failAiriTurnPreparation(
        claim,
        normalizeErrorMessage(error),
        safeToRetry,
      );
    } catch (persistenceError) {
      airiWorkerLogger.error(
        "airi.worker.turn_disposition_failed",
        persistenceError,
        {
          conversationId: turn.conversationId,
          messageId: turn.messageId,
        },
      );
      throw ApplicationFailure.nonRetryable(
        "Airi preparation failure could not be durably classified",
        AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
      );
    }
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) {
      throw ApplicationFailure.nonRetryable(required.error, required.code);
    }
    if (
      error instanceof AIChatProviderAggregateError &&
      !isRetryableAIProviderError(error)
    ) {
      throw ApplicationFailure.nonRetryable(error.message, error.code, {
        providerErrors: error.providerErrors,
      });
    }
    if (safeToRetry) {
      throw ApplicationFailure.retryable(
        normalizeErrorMessage(error),
        AIRI_TURN_PREPARATION_NOT_STARTED,
      );
    }
    throw ApplicationFailure.nonRetryable(
      normalizeErrorMessage(error),
      AIRI_TURN_PREPARATION_OUTCOME_UNKNOWN,
    );
  }
}

export async function recordAiriConversationTurnDispositionActivity(
  input: AiriConversationTurnDisposition,
  executionStore: AiriTurnExecutionStore = airiTurnExecutionStore,
): Promise<void> {
  await executionStore.recordAiriConversationTurnDisposition(input);
}

export async function terminalizeGenerativeAcknowledgmentActivity(
  input: AiriConversationTerminalizeGenerativeAckInput,
): Promise<void> {
  await terminalizeGenerativeAcknowledgment(input);
}

/**
 * Delivery activity edge. Creative-asset read-URL port is wired at worker
 * composition root (GCS signer) and re-asserted here so duplicate module
 * graphs cannot leave outbound media resolution unconfigured.
 * Outbound WhatsApp media goes through `sendWhatsAppServiceMessage`
 * (resolve object URLs → Meta HTTPS dispatch).
 */
export async function deliverAiriConversationOutboundActivity(
  request: AiriConversationOutboundDeliveryRequest,
): Promise<AiriConversationOutboundDeliveryResult> {
  const startedAt = Date.now();
  configureGcsCreativeAssetReadUrlPort();
  configureGcsWhatsAppVoiceReplyStorage();
  try {
    const result = await deliverAiriConversationOutbound(request);
    airiWorkerLogger.info("airi.worker.delivery", {
      note: "completed",
      deliveryKey: request.deliveryKey,
      reservedMessageId: request.reservedMessageId,
      skipped: Boolean(result.skipped),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    airiWorkerLogger.error("airi.worker.delivery", error, {
      note: "failed",
      deliveryKey: request.deliveryKey,
      reservedMessageId: request.reservedMessageId,
      errorMessage: normalizeErrorMessage(error),
      durationMs: Date.now() - startedAt,
    });
    if (isAiriOutboundPreparationFailedError(error)) {
      throw ApplicationFailure.retryable(
        normalizeErrorMessage(error),
        AIRI_OUTBOUND_PREPARATION_FAILED,
      );
    }
    if (isAiriOutboundProviderRejectedError(error)) {
      throw ApplicationFailure.retryable(
        normalizeErrorMessage(error),
        AIRI_OUTBOUND_PROVIDER_REJECTED_RETRYABLE,
      );
    }
    throw error;
  }
}

export async function finalizeAiriConversationOutboundActivity(
  input: AiriConversationFinalizeOutboundInput,
): Promise<void> {
  const startedAt = Date.now();
  try {
    await finalizeAiriConversationOutbound(input);
    airiWorkerLogger.info("airi.worker.delivery", {
      note: "finalized",
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    airiWorkerLogger.error("airi.worker.delivery", error, {
      note: "finalize_failed",
      errorMessage: normalizeErrorMessage(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function readAiriConversationProjectionActivity(
  input: AiriConversationProjectionReadInput,
) {
  return readAiriConversationProjection({
    conversationId: input.conversationId,
  });
}

export async function planAiriConversationTimerActivity(
  turn: AiriConversationTurnSignal | null | undefined,
) {
  return planAiriConversationTimer(
    {
      turn,
    },
    airiScenarioTimerDependencies,
  );
}

export async function buildAiriConversationTimerTurnActivity(
  timer: AiriConversationTimerDescriptor,
): Promise<AiriConversationPreparedTimerTurnResult> {
  return buildAiriConversationTimerTurn(timer, airiScenarioTimerDependencies);
}

export async function handleAiriConversationExternalEventActivity(
  event: AiriConversationExternalEvent,
): Promise<AiriConversationExternalEventResult> {
  return handleAiriConversationExternalEvent(
    event,
    airiScenarioTimerDependencies,
  );
}
