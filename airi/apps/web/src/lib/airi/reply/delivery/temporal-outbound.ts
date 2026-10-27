import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";
import { buildCacheKey } from "@icecore/shared/lib/cache";
import { parseWhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";
import { coerceNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";
import type {
  AiriConversationDeferredCommand,
  AiriConversationOutboundDeliveryResult,
  AiriConversationOutboundDeliveryRequest,
  AiriConversationPostDeliveryEffect,
} from "@icecore/temporal";
import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import type { trackMissingKnowledgeGap } from "@/lib/airi/rag/knowledge/knowledge-gap-tracker";
import { airiReplyLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { enqueueWhatsAppLlmHelpfulnessPromptWithOutbox } from "@/lib/cross-store-outbox";
import type { PersistAiriReplyTraceParams } from "@/lib/airi/reply/runtime/reply-trace";
import { upsertWhatsAppLlmAnswerReviewItem } from "@/lib/llm-analytics/whatsapp-feedback";
import { buildDeterministicMongoObjectId } from "@/lib/mongo-deterministic-id";
import Message from "@/models/message";

type CaptureStore = {
  messageId: string;
  behaviorRunId?: string | null;
  workspaceId: string;
  conversationId: string;
  baseDeliveryKey: string;
  sequence: number;
  pendingDelivery: AiriConversationOutboundDeliveryRequest | null;
  capturePostDeliveryEffects: boolean;
  postDeliveryEffects: AiriConversationPostDeliveryEffect[];
  deferredCommand: AiriConversationDeferredCommand | null;
};

type CompleteScenarioAfterDeliveryParams = {
  conversationId: string;
  scenarioRuntime: AiriScenarioRuntimeConfig | null;
  baseState: unknown;
  completionTimestamp?: string | Date | null;
  lastMessageId?: string | null;
};

type ApplyTemporalPostDeliveryEffectsInput = {
  delivery: AiriConversationOutboundDeliveryResult;
  effects: AiriConversationPostDeliveryEffect[];
};

type TrackMissingKnowledgeGapParams = Parameters<
  typeof trackMissingKnowledgeGap
>[0];

type PublishAiriSuggestionParams = {
  idempotencyKey?: string | null;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  realtimePayload: Record<string, unknown>;
  score: number;
  category?: string | null;
  approved: boolean;
  autoSent: boolean;
};

const temporalOutboundCapture = new AsyncLocalStorage<CaptureStore>();

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildDeliveryKey(params: {
  baseDeliveryKey: string;
  sequence: number;
}): string {
  return buildCacheKey("airi-delivery", [
    params.baseDeliveryKey,
    params.sequence,
  ]);
}

export function getTemporalOutboundCapture(): AiriConversationOutboundDeliveryRequest | null {
  return temporalOutboundCapture.getStore()?.pendingDelivery || null;
}

export function getTemporalPostDeliveryEffects():
  | AiriConversationPostDeliveryEffect[]
  | null {
  const store = temporalOutboundCapture.getStore();
  if (!store) {
    return null;
  }

  return cloneJson(store.postDeliveryEffects);
}

export function captureTemporalPostDeliveryEffect(
  effect: AiriConversationPostDeliveryEffect
): boolean {
  const store = temporalOutboundCapture.getStore();
  if (!store || !store.capturePostDeliveryEffects) {
    return false;
  }

  store.postDeliveryEffects.push(cloneJson(effect));
  return true;
}

export function captureTemporalDeferredCommand(
  command: AiriConversationDeferredCommand
): void {
  const store = temporalOutboundCapture.getStore();
  if (!store) {
    throw new Error("Temporal outbound capture is not active");
  }
  if (store.deferredCommand) {
    throw new Error("Multiple deferred commands were attempted in one turn");
  }
  store.deferredCommand = cloneJson(command);
}

export function reserveTemporalOutboundDispatch(params: {
  context: Record<string, unknown>;
  dispatchPolicy?: "default" | "at_most_once";
  dispatchIdentity?: string | null;
}): {
  delivery: AiriConversationOutboundDeliveryRequest;
  placeholderMessageId: string;
  placeholderDate: Date;
} {
  const store = temporalOutboundCapture.getStore();
  if (!store) {
    throw new Error("Temporal outbound capture is not active");
  }

  const hasDispatchIdentity =
    params.dispatchIdentity !== undefined && params.dispatchIdentity !== null;
  const dispatchIdentity = normalizeOptionalString(params.dispatchIdentity);
  if (hasDispatchIdentity && !dispatchIdentity) {
    throw new Error("Temporal dispatch identity must be nonempty");
  }
  if (dispatchIdentity && params.dispatchPolicy !== "at_most_once") {
    throw new Error(
      "Temporal dispatch identity requires at_most_once dispatch"
    );
  }
  store.sequence += 1;
  const deliveryKey = dispatchIdentity
    ? buildCacheKey("airi-delivery", [
        store.workspaceId,
        store.conversationId,
        dispatchIdentity,
      ])
    : buildDeliveryKey({
        baseDeliveryKey: store.baseDeliveryKey,
        sequence: store.sequence,
      });
  const reservedMessageId = dispatchIdentity
    ? buildDeterministicMongoObjectId("airi-delivery", deliveryKey)
    : new mongoose.Types.ObjectId().toString();
  const context = cloneJson({
    ...params.context,
    sourceMessageId: store.messageId,
    behaviorRunId: store.messageId.startsWith("scenario-timeout:")
      ? store.behaviorRunId || undefined
      : undefined,
    temporalDeliveryKey: deliveryKey,
    temporalReservedMessageId: reservedMessageId,
  });

  const delivery: AiriConversationOutboundDeliveryRequest = {
    deliveryKey,
    reservedMessageId,
    context,
    ...(params.dispatchPolicy && params.dispatchPolicy !== "default"
      ? { dispatchPolicy: params.dispatchPolicy }
      : {}),
  };

  if (store.pendingDelivery) {
    throw new Error(
      `Multiple outbound dispatches were attempted in one Temporal turn (existing=${store.pendingDelivery.deliveryKey}, next=${deliveryKey})`
    );
  }

  store.pendingDelivery = delivery;

  return {
    delivery,
    placeholderMessageId: reservedMessageId,
    placeholderDate: new Date(),
  };
}

export async function runWithTemporalOutboundCapture<T>(params: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  behaviorRunId?: string | null;
  capturePostDeliveryEffects?: boolean;
  run: () => Promise<T>;
}): Promise<{
  result: T;
  pendingDelivery: AiriConversationOutboundDeliveryRequest | null;
  postDeliveryEffects: AiriConversationPostDeliveryEffect[];
  deferredCommand: AiriConversationDeferredCommand | null;
}> {
  const baseDeliveryKey =
    normalizeOptionalString(
      buildCacheKey("airi-delivery-turn", [
        params.workspaceId,
        params.conversationId,
        params.messageId,
      ])
    ) || `${params.workspaceId}:${params.conversationId}:${params.messageId}`;

  const store: CaptureStore = {
    messageId: params.messageId,
    behaviorRunId: params.behaviorRunId,
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    baseDeliveryKey,
    sequence: 0,
    pendingDelivery: null,
    capturePostDeliveryEffects: Boolean(params.capturePostDeliveryEffects),
    postDeliveryEffects: [],
    deferredCommand: null,
  };

  return temporalOutboundCapture.run(store, async () => {
    const result = await params.run();
    return {
      result,
      pendingDelivery: store.pendingDelivery,
      postDeliveryEffects: cloneJson(store.postDeliveryEffects),
      deferredCommand: store.deferredCommand
        ? cloneJson(store.deferredCommand)
        : null,
    };
  });
}

function normalizeCompletionPayload(
  params: CompleteScenarioAfterDeliveryParams
): Record<string, unknown> {
  return cloneJson({
    conversationId: params.conversationId,
    scenarioRuntime: params.scenarioRuntime,
    baseState: params.baseState,
    completionTimestamp: params.completionTimestamp || null,
    lastMessageId: params.lastMessageId || null,
  });
}

function normalizeCompletionTimestamp(value: unknown): string | Date | null {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }

  return null;
}

async function runOrCapturePostDeliveryEffect(
  effect: AiriConversationPostDeliveryEffect,
  runNow: () => Promise<void>
): Promise<void> {
  if (captureTemporalPostDeliveryEffect(effect)) {
    return;
  }

  await runNow();
}

async function executeClearSuppressedState(
  conversationId: string
): Promise<void> {
  const { clearSuppressedState } = await import(
    "@/lib/airi/reply/runtime/auto-reply-realtime"
  );
  await clearSuppressedState(conversationId);
}

async function executeCompleteScenarioAfterDelivery(
  params: CompleteScenarioAfterDeliveryParams
): Promise<void> {
  const { completeScenarioAfterDispatch } = await import(
    "@/lib/airi/reply/runtime/auto-reply-scenario-state"
  );
  await completeScenarioAfterDispatch(params);
}

async function executeFinalizeGenerativeAIResult(params: {
  delivery: AiriConversationOutboundDeliveryResult;
  payload: Extract<
    AiriConversationPostDeliveryEffect,
    { kind: "finalize_generative_ai_result" }
  >["payload"];
}): Promise<void> {
  const { readGenerativeExecutionOwnerRecord, terminalizeGenerativeDelivery } =
    await import("@/lib/airi/reply/runtime/generative-ai-execution-store");
  const finalized = await terminalizeGenerativeDelivery({
    workspaceId: params.payload.workspaceId,
    conversationId: params.payload.conversationId,
    executionId: params.payload.executionId,
    scenarioId: params.payload.scenarioId,
    scenarioRevisionFingerprint: params.payload.scenarioRevisionFingerprint,
    actionNodeId: params.payload.actionNodeId,
    deliveryClaimToken: params.payload.deliveryClaimToken,
    delivery: params.delivery,
  });
  if (finalized) return;

  const ownerRecord = await readGenerativeExecutionOwnerRecord({
    workspaceId: params.payload.workspaceId,
    conversationId: params.payload.conversationId,
  });
  if (ownerRecord.classification === "malformed") {
    throw new Error("Generative result owner is malformed");
  }
  const owner =
    ownerRecord.classification === "present" ? ownerRecord.execution : null;
  if (
    owner?.executionId === params.payload.executionId &&
    owner.phase === "delivering" &&
    owner.scenarioId === params.payload.scenarioId &&
    owner.scenarioRevisionFingerprint ===
      params.payload.scenarioRevisionFingerprint &&
    owner.actionNodeId === params.payload.actionNodeId &&
    owner.deliveryClaim?.token === params.payload.deliveryClaimToken
  ) {
    throw new Error(
      "Generative result terminalization lost its exact compare-and-set"
    );
  }
}

async function executeUpdateSuggestionMessageId(params: {
  sourceMessageId: string;
  outboundMessageId?: string | null;
}): Promise<void> {
  const outboundMessageId = normalizeOptionalString(params.outboundMessageId);
  if (!outboundMessageId) return;

  const { default: AiriSuggestion } = await import("@/models/airi-suggestion");
  await AiriSuggestion.findOneAndUpdate(
    { messageId: params.sourceMessageId },
    { messageId: outboundMessageId }
  );
}

async function executePersistAiriReplyTrace(
  params: PersistAiriReplyTraceParams
): Promise<void> {
  const { persistAiriReplyTrace } = await import(
    "@/lib/airi/reply/runtime/reply-trace"
  );
  await persistAiriReplyTrace(params);
}

export async function clearSuppressedStateAfterDelivery(
  conversationId: string
): Promise<void> {
  await runOrCapturePostDeliveryEffect(
    {
      kind: "clear_suppressed_state",
      conversationId,
    },
    () => executeClearSuppressedState(conversationId)
  );
}

export async function completeScenarioAfterDelivery(
  params: CompleteScenarioAfterDeliveryParams
): Promise<void> {
  await runOrCapturePostDeliveryEffect(
    {
      kind: "complete_scenario_after_dispatch",
      payload: normalizeCompletionPayload(params),
    },
    () => executeCompleteScenarioAfterDelivery(params)
  );
}

export async function updateSuggestionMessageIdAfterDelivery(params: {
  sourceMessageId: string;
  outboundMessageId?: string | null;
}): Promise<void> {
  const sourceMessageId = normalizeOptionalString(params.sourceMessageId);
  if (!sourceMessageId) {
    return;
  }

  await runOrCapturePostDeliveryEffect(
    {
      kind: "update_suggestion_message_id",
      sourceMessageId,
    },
    () =>
      executeUpdateSuggestionMessageId({
        sourceMessageId,
        outboundMessageId: params.outboundMessageId,
      })
  );
}

export async function persistAiriReplyTraceAfterDelivery(
  params: PersistAiriReplyTraceParams
): Promise<void> {
  await runOrCapturePostDeliveryEffect(
    {
      kind: "persist_reply_trace",
      payload: cloneJson(params),
    },
    () => executePersistAiriReplyTrace(params)
  );
}

async function trackMissingKnowledgeGapAndNotify(
  params: TrackMissingKnowledgeGapParams
): Promise<void> {
  const [
    { createMissingKnowledgeCoachPayload },
    { trackMissingKnowledgeGap },
    { realtime },
  ] = await Promise.all([
    import("@/lib/airi/ops/suggestion-payloads"),
    import("@/lib/airi/rag/knowledge/knowledge-gap-tracker"),
    import("@/lib/realtime/server"),
  ]);
  const tracked = await trackMissingKnowledgeGap(params);
  if (
    !tracked.shouldPromptWorkspace ||
    !params.conversationId ||
    !params.messageId ||
    params.intent === "unknown"
  ) {
    return;
  }

  await realtime.trigger(
    `private-conversation-${params.conversationId}`,
    "airi.suggestion",
    createMissingKnowledgeCoachPayload({
      messageId: params.messageId,
      workspaceId: params.workspaceId,
      intent: params.intent,
      askCount: tracked.askCount,
      topic: params.topic,
    })
  );
}

export async function trackMissingKnowledgeGapAfterDelivery(
  params: TrackMissingKnowledgeGapParams
): Promise<void> {
  await runOrCapturePostDeliveryEffect(
    {
      kind: "track_knowledge_gap",
      payload: cloneJson(params),
    },
    () => trackMissingKnowledgeGapAndNotify(params)
  );
}

async function publishAiriSuggestion(
  params: PublishAiriSuggestionParams
): Promise<void> {
  const [{ realtime }, { default: AiriSuggestion }] = await Promise.all([
    import("@/lib/realtime/server"),
    import("@/models/airi-suggestion"),
  ]);
  const suggestionDocument = {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    messageId: params.messageId,
    source: "kb" as const,
    score: params.score,
    category: params.category || null,
    approved: params.approved,
    autoSent: params.autoSent,
  };
  if (params.idempotencyKey) {
    await AiriSuggestion.findOneAndUpdate(
      {
        _id: buildDeterministicMongoObjectId(
          "airi-suggestion",
          params.idempotencyKey
        ),
      },
      { $set: suggestionDocument },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } else {
    await AiriSuggestion.create(suggestionDocument);
  }
  await realtime.trigger(
    `private-conversation-${params.conversationId}`,
    "airi.suggestion",
    params.realtimePayload
  );
}

export async function publishAiriSuggestionAfterDelivery(
  params: PublishAiriSuggestionParams
): Promise<void> {
  await runOrCapturePostDeliveryEffect(
    {
      kind: "publish_airi_suggestion",
      payload: cloneJson(params),
    },
    () => publishAiriSuggestion(params)
  );
}

async function executeSendWhatsAppLlmFeedback(params: {
  delivery: AiriConversationOutboundDeliveryResult;
  payload: Extract<
    AiriConversationPostDeliveryEffect,
    { kind: "send_whatsapp_llm_feedback" }
  >["payload"];
  effectIdempotencyKey: string;
}): Promise<void> {
  const conversationId = normalizeOptionalString(params.payload.conversationId);
  const workspaceId = normalizeOptionalString(params.payload.workspaceId);
  const outboundMessageId = normalizeOptionalString(
    params.delivery.outboundMessageId
  );

  if (!conversationId || !workspaceId || !outboundMessageId) {
    airiReplyLogger.warn("airi.reply.delivery", {
      conversationId: conversationId || null,
      note: "whatsapp_llm_feedback_skipped",
      reason: "incomplete_feedback_effect_payload",
      deliveryKey: params.delivery.deliveryKey,
    });
    return;
  }

  const outbound = (await Message.findById(outboundMessageId)
    .select("messageId")
    .lean()) as { messageId?: string | null } | null;
  const platformMessageId = normalizeOptionalString(outbound?.messageId);
  if (!platformMessageId) {
    airiReplyLogger.warn("airi.reply.delivery", {
      conversationId,
      note: "whatsapp_llm_feedback_skipped",
      reason: "missing_platform_message_id",
      outboundMessageId,
      deliveryKey: params.delivery.deliveryKey,
    });
    return;
  }

  const recipient = parseWhatsAppRecipientTarget(params.payload.recipient);
  if (!recipient) {
    airiReplyLogger.warn("airi.reply.delivery", {
      conversationId,
      note: "whatsapp_llm_feedback_skipped",
      reason: "invalid_feedback_recipient",
      deliveryKey: params.delivery.deliveryKey,
    });
    return;
  }

  await enqueueWhatsAppLlmHelpfulnessPromptWithOutbox({
    workspaceId,
    conversationId,
    sourceId: normalizeOptionalString(params.payload.sourceId),
    recipient,
    sourceMessageId: platformMessageId,
  });

  await upsertWhatsAppLlmAnswerReviewItem({
    workspaceId,
    conversationId,
    sourceMessageId: platformMessageId,
  }).catch(error => {
    airiReplyLogger.warn("airi.reply.delivery", {
      conversationId,
      note: "whatsapp_llm_answer_review_item_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  airiReplyLogger.info("airi.reply.delivery", {
    conversationId,
    note: "whatsapp_llm_feedback_queued",
    reason: "post_delivery_effect",
    recipientDigits: params.payload.recipientDigits || null,
    sourceMessageId: platformMessageId,
    temporalDelivery: true,
    effectIdempotencyKey: params.effectIdempotencyKey,
  });
}

export async function applyTemporalPostDeliveryEffects(
  input: ApplyTemporalPostDeliveryEffectsInput
): Promise<void> {
  for (const [effectIndex, effect] of input.effects.entries()) {
    const effectIdempotencyKey = `${input.delivery.deliveryKey}:${effect.kind}:${effectIndex}`;
    switch (effect.kind) {
      case "clear_suppressed_state":
        await executeClearSuppressedState(effect.conversationId);
        break;
      case "complete_scenario_after_dispatch": {
        const payload = cloneJson(effect.payload || {}) as {
          conversationId?: unknown;
          scenarioRuntime?: unknown;
          baseState?: unknown;
          completionTimestamp?: unknown;
          lastMessageId?: unknown;
        };

        const conversationId = normalizeOptionalString(payload.conversationId);
        if (!conversationId) {
          break;
        }

        await executeCompleteScenarioAfterDelivery({
          conversationId,
          scenarioRuntime:
            (payload.scenarioRuntime as AiriScenarioRuntimeConfig | null) ||
            null,
          baseState: payload.baseState,
          completionTimestamp:
            input.delivery.outboundDate ||
            normalizeCompletionTimestamp(payload.completionTimestamp),
          lastMessageId:
            normalizeOptionalString(input.delivery.outboundMessageId) ||
            normalizeOptionalString(payload.lastMessageId),
        });
        break;
      }
      case "update_suggestion_message_id":
        await executeUpdateSuggestionMessageId({
          sourceMessageId: effect.sourceMessageId,
          outboundMessageId: input.delivery.outboundMessageId,
        });
        break;
      case "persist_reply_trace":
        await executePersistAiriReplyTrace({
          ...(cloneJson(effect.payload) as PersistAiriReplyTraceParams),
          outboundMessageId: input.delivery.outboundMessageId,
          idempotencyKey: effectIdempotencyKey,
        });
        break;
      case "track_knowledge_gap":
        await trackMissingKnowledgeGapAndNotify(
          cloneJson(effect.payload) as TrackMissingKnowledgeGapParams
        );
        break;
      case "publish_airi_suggestion":
        await publishAiriSuggestion({
          ...(cloneJson(effect.payload) as PublishAiriSuggestionParams),
          idempotencyKey: effectIdempotencyKey,
        });
        break;
      case "send_whatsapp_llm_feedback":
        await executeSendWhatsAppLlmFeedback({
          delivery: input.delivery,
          payload: cloneJson(effect.payload),
          effectIdempotencyKey,
        });
        break;
      case "finalize_generative_ai_result":
        await executeFinalizeGenerativeAIResult({
          delivery: input.delivery,
          payload: effect.payload,
        });
        break;
      default: {
        const exhaustiveCheck: never = effect;
        throw new Error(
          `Unsupported Temporal post-delivery effect: ${String(exhaustiveCheck)}`
        );
      }
    }
  }
}
