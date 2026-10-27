import type { GenerativeAIExecution } from "@icecore/scenario-contracts";
import type {
  AiriConversationTurnSignal,
  AiriConversationDeferredCommand,
  AiriConversationTerminalizeGenerativeAckInput,
  AiriConversationFinalizeOutboundInput,
  AiriConversationOutboundDeliveryRequest,
  AiriConversationOutboundDeliveryResult,
  AiriConversationPostDeliveryEffect,
  AiriConversationProjection,
} from "@icecore/temporal";
import { previewText, traceableChain } from "./tracing";
import { airiWorkerLogger } from "./logging";
import airiAutoReply, { type AiriAutoReplyParams } from "./auto-reply";
import { runAiriTurnPreflight } from "./job-runner-preflight";
import type { ScenarioRuntimeDependencies } from "./scenario-runtime-dependencies";
import {
  hasScenarioDeliveryContext,
  readAiriDeliveryConversationId,
  readAiriDeliveryWorkspaceId,
  resolveGenerativeDeliveryClaimGuard,
  shouldBypassManualHandoffForAiriDelivery,
} from "./delivery-gates";
import { isScenarioAutomationPausedByHandoff } from "./scenario-handoff-policy";
import { createWebRequire, readDefaultExport } from "./internal/module-interop";
import {
  normalizeDateIso,
  normalizeOptionalString,
  normalizeStringArray,
} from "./internal/value-normalization";
import {
  classifyAiriTemporalDispatch,
  isAiriDeliveryCompatiblySkipped,
  resolveAiriOutboundDate,
  shouldApplyAiriPostDeliveryEffects,
  type TemporalDispatchState,
} from "./job-runner-delivery-result";

const requireWeb = createWebRequire(import.meta.url);
const connectDB = readDefaultExport<() => Promise<unknown>>(
  requireWeb("../../../apps/web/src/lib/mongoose"),
);
const { hydrateAiriAutoReplyParamsFromTurn } = requireWeb(
  "../../../apps/web/src/lib/temporal/airi-turn-context",
) as {
  hydrateAiriAutoReplyParamsFromTurn: (
    turn: AiriConversationTurnSignal,
  ) => Promise<AiriAutoReplyParams>;
};
const conversationModelModule = requireWeb(
  "../../../apps/web/src/models/conversation",
) as {
  Conversation?: {
    findById: (...args: unknown[]) => {
      select: (...selectArgs: unknown[]) => {
        lean: <T>() => Promise<T>;
      };
    };
  };
  default?: unknown;
};
const Conversation = conversationModelModule.Conversation;
const { applyTemporalPostDeliveryEffects, runWithTemporalOutboundCapture } =
  requireWeb(
    "../../../apps/web/src/lib/airi/reply/delivery/temporal-outbound",
  ) as {
    applyTemporalPostDeliveryEffects: (
      input: AiriConversationFinalizeOutboundInput,
    ) => Promise<void>;
    runWithTemporalOutboundCapture: <T>(params: {
      workspaceId: string;
      conversationId: string;
      messageId: string;
      behaviorRunId?: string | null;
      capturePostDeliveryEffects?: boolean;
      run: () => Promise<T>;
    }) => Promise<{
      result: T;
      pendingDelivery: AiriConversationOutboundDeliveryRequest | null;
      postDeliveryEffects: AiriConversationPostDeliveryEffect[];
      deferredCommand: AiriConversationDeferredCommand | null;
    }>;
  };
const {
  inspectGenerativeDeliveryPreflight,
  readGenerativeExecutionOwnerRecord,
  terminalizeAcceptedGenerativeExecution,
} = requireWeb(
  "../../../apps/web/src/lib/airi/reply/runtime/generative-ai-execution-store",
) as {
  inspectGenerativeDeliveryPreflight: (input: {
    workspaceId: string;
    conversationId: string;
    executionId: string;
    scenarioId: string;
    scenarioRevisionFingerprint: string;
    actionNodeId: string;
    deliveryClaimToken: string;
    deliveryKey: string;
    reservedMessageId: string;
    assetId: string | null;
    videoWorkflowId: string | null;
    attemptToken: string | null;
    context: Record<string, unknown>;
  }) => Promise<{
    classification:
      | "valid"
      | "stale_claim"
      | "invalid_payload"
      | "malformed_owner";
  }>;
  terminalizeAcceptedGenerativeExecution: (input: {
    workspaceId: string;
    conversationId: string;
    executionId: string;
    scenarioId: string;
    scenarioRevisionFingerprint: string;
    actionNodeId: string;
    outcome: "manual_handoff" | "failure";
  }) => Promise<boolean>;
  readGenerativeExecutionOwnerRecord: (input: {
    workspaceId: string;
    conversationId: string;
  }) => Promise<
    | { classification: "absent"; execution: null }
    | { classification: "malformed"; execution: null }
    | {
        classification: "present";
        execution: Pick<
          GenerativeAIExecution,
          | "executionId"
          | "phase"
          | "scenarioId"
          | "scenarioRevisionFingerprint"
          | "actionNodeId"
        >;
      }
  >;
};
const { buildWhatsAppLlmFeedbackPostDeliveryEffect, sendAndPersistOutbound } =
  requireWeb(
    "../../../apps/web/src/lib/airi/reply/delivery/outbound-message",
  ) as {
    buildWhatsAppLlmFeedbackPostDeliveryEffect: (
      ctx: Record<string, unknown>,
    ) => AiriConversationPostDeliveryEffect | null;
    sendAndPersistOutbound: (ctx: Record<string, unknown>) => Promise<{
      _id?: unknown;
      date?: Date | string | null;
      temporalDispatch?: { state?: TemporalDispatchState | null } | null;
    }>;
  };
const {
  COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE,
  ensureCompanyAiriAutoReplyCapacity,
} = requireWeb("../../../apps/web/src/lib/limits/company-limits") as {
  COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE: string;
  ensureCompanyAiriAutoReplyCapacity: (
    supabase: unknown,
    workspaceId: string,
  ) => Promise<{ allowed: boolean }>;
};
const { supabaseAdmin } = requireWeb(
  "../../../apps/web/src/lib/supabase/admin",
) as {
  supabaseAdmin: unknown;
};

if (!Conversation) {
  throw new Error("Failed to load Conversation model for Airi runtime");
}

type WorkerTurnMode = "prepare";
const CAPACITY_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1000;
type HandoffProjection = {
  airi_handoff_active?: boolean | null;
  airi_handoff_source?: string | null;
  airi_handoff_reason?: string | null;
  airi_handoff_started_at?: Date | string | null;
} | null;

async function isBlockedByManualHandoff(
  request: AiriConversationOutboundDeliveryRequest,
): Promise<boolean> {
  const conversationId = readAiriDeliveryConversationId(request);
  if (!conversationId) return false;

  const conversation = (await Conversation!
    .findById(conversationId)
    .select(
      "airi_handoff_active airi_handoff_source airi_handoff_reason airi_handoff_started_at",
    )
    .lean<HandoffProjection>()) as HandoffProjection;

  return Boolean(
    isScenarioAutomationPausedByHandoff(conversation?.airi_handoff_active) &&
      conversation?.airi_handoff_source === "manual",
  );
}

function buildWorkerTurnLogContext(
  turn: AiriConversationTurnSignal,
  jobMode: WorkerTurnMode,
) {
  return {
    workspaceId: String(turn.workspaceId || ""),
    conversationId: String(turn.conversationId || ""),
    messageId: String(turn.messageId || ""),
    inboundMessageId: String(turn.messageId || ""),
    channel: turn.channel || null,
    sourceId: turn.sourceId || null,
    turnContextId: turn.turnContextId || null,
    triggerEventKind: turn.triggerEventKind || null,
    enqueuedAt: turn.enqueuedAt || null,
    jobMode,
    hasTextPreview: Boolean(previewText(turn.textPreview, 1)),
  };
}

async function runWorkerTurnWithWideEvent<T>(
  jobMode: WorkerTurnMode,
  turn: AiriConversationTurnSignal,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const logContext = buildWorkerTurnLogContext(turn, jobMode);

  try {
    const result = await run();
    airiWorkerLogger.info("airi.worker.turn_request", {
      ...logContext,
      outcome: "success",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    airiWorkerLogger.error("airi.worker.turn_request", error, {
      ...logContext,
      outcome: "error",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export function reviveAiriAutoReplyPayloadDates(
  body: AiriAutoReplyParams,
): void {
  if (!body || typeof body !== "object") {
    return;
  }

  if (body.newMessage && body.newMessage.date) {
    body.newMessage.date = new Date(body.newMessage.date);
  }

  if (!body.conversation) {
    return;
  }

  if (body.conversation.createdAt) {
    body.conversation.createdAt = new Date(body.conversation.createdAt);
  }
  if (body.conversation.updatedAt) {
    body.conversation.updatedAt = new Date(body.conversation.updatedAt);
  }
  if (body.conversation.lastMessageAt) {
    body.conversation.lastMessageAt = new Date(body.conversation.lastMessageAt);
  }
}

async function resolveAiriAutoReplyBody(
  turn: AiriConversationTurnSignal,
): Promise<AiriAutoReplyParams> {
  const body = await hydrateAiriAutoReplyParamsFromTurn(turn);
  reviveAiriAutoReplyPayloadDates(body);
  return body;
}

async function prepareAiriAutoReplyJobImpl(
  turn: AiriConversationTurnSignal,
  scenarioDependencies: ScenarioRuntimeDependencies<
    AiriAutoReplyParams["conversation"]
  >,
) {
  return runWorkerTurnWithWideEvent("prepare", turn, async () => {
    const body = await runAiriTurnPreflight(() =>
      resolveAiriAutoReplyBody(turn),
    );
    body.runtimeCapacityVerifiedAt = undefined;

    const prepared = await runWithTemporalOutboundCapture({
      workspaceId: String(body.workspaceId),
      conversationId: String(body.conversation?._id),
      messageId: String(body.newMessage?._id),
      behaviorRunId: body.conversation?.airi_scenario_state?.behaviorRunId,
      capturePostDeliveryEffects: true,
      run: () => airiAutoReply(body, scenarioDependencies),
    });
    if (prepared.pendingDelivery) {
      if (body.runtimeCapacityVerifiedAt) {
        prepared.pendingDelivery.capacityVerifiedAt =
          body.runtimeCapacityVerifiedAt;
      }
      // Keep effects on the delivery request so deliver/finalize stay one unit.
      const postDeliveryEffects = [...(prepared.postDeliveryEffects || [])];
      const feedbackEffect = buildWhatsAppLlmFeedbackPostDeliveryEffect(
        prepared.pendingDelivery.context as Record<string, unknown>,
      );
      if (feedbackEffect?.kind === "send_whatsapp_llm_feedback") {
        postDeliveryEffects.push(feedbackEffect);
        airiWorkerLogger.info("airi.worker.prepare_post_delivery_effect", {
          kind: feedbackEffect.kind,
          conversationId: String(body.conversation?._id || ""),
          deliveryKey: prepared.pendingDelivery.deliveryKey,
          recipientDigits: feedbackEffect.payload.recipientDigits || null,
        });
      }
      prepared.postDeliveryEffects = postDeliveryEffects;
      prepared.pendingDelivery.postDeliveryEffects = postDeliveryEffects;
    }
    return prepared;
  });
}

export async function terminalizeGenerativeAcknowledgment(
  input: AiriConversationTerminalizeGenerativeAckInput,
): Promise<void> {
  await connectDB();
  const ownerInput = {
    workspaceId: input.command.workspaceId,
    conversationId: input.command.conversationId,
    executionId: input.command.executionId,
    scenarioId: input.command.scenarioId,
    scenarioRevisionFingerprint: input.command.scenarioRevisionFingerprint,
    actionNodeId: input.command.actionNodeId,
    outcome: input.outcome,
  };
  const terminalized = await terminalizeAcceptedGenerativeExecution(ownerInput);
  if (terminalized) return;

  const ownerRecord = await readGenerativeExecutionOwnerRecord(ownerInput);
  if (ownerRecord.classification === "malformed") {
    throw new Error("Generative acknowledgment owner is malformed");
  }
  const owner =
    ownerRecord.classification === "present" ? ownerRecord.execution : null;
  if (
    owner?.executionId === ownerInput.executionId &&
    owner.phase === "accepted" &&
    owner.scenarioId === ownerInput.scenarioId &&
    owner.scenarioRevisionFingerprint ===
      ownerInput.scenarioRevisionFingerprint &&
    owner.actionNodeId === ownerInput.actionNodeId
  ) {
    throw new Error(
      "Generative acknowledgment terminalization lost its exact compare-and-set",
    );
  }
}

function hasFreshCapacityVerification(
  request: AiriConversationOutboundDeliveryRequest,
): boolean {
  if (!request.capacityVerifiedAt) return false;
  const verifiedAt = Date.parse(request.capacityVerifiedAt);
  if (!Number.isFinite(verifiedAt)) return false;
  const ageMs = Date.now() - verifiedAt;
  return ageMs >= -60_000 && ageMs <= CAPACITY_VERIFICATION_MAX_AGE_MS;
}

export const prepareAiriAutoReplyJob = traceableChain(
  prepareAiriAutoReplyJobImpl,
  {
    name: "airi.temporal.prepare_auto_reply_job",
    tags: ["airi", "temporal", "job"],
    getMetadata: (turn) => ({
      channel: turn.channel || null,
      job_mode: "prepare",
    }),
    getSessionIdentity: (turn) => ({
      conversationId: String(turn.conversationId || ""),
      workspaceId: String(turn.workspaceId || ""),
    }),
    processInputs: (inputs) => {
      const payload = (
        "input" in inputs ? inputs.input : inputs
      ) as AiriConversationTurnSignal;
      return {
        workspace_id: String(payload.workspaceId || ""),
        conversation_id: String(payload.conversationId || ""),
        message_id: String(payload.messageId || ""),
        channel: payload.channel || null,
        inbound_text_preview: previewText(payload.textPreview, 200),
      };
    },
    processOutputs: (outputs) => {
      const result = ("outputs" in outputs ? outputs.outputs : outputs) as {
        pendingDelivery?: AiriConversationOutboundDeliveryRequest | null;
        postDeliveryEffects?: AiriConversationPostDeliveryEffect[];
      };
      return {
        mode: "prepare",
        has_pending_delivery: Boolean(result.pendingDelivery),
        post_delivery_effect_count: result.postDeliveryEffects?.length || 0,
      };
    },
  },
);

async function applyPostDeliveryEffectsForResult(params: {
  request: AiriConversationOutboundDeliveryRequest;
  result: AiriConversationOutboundDeliveryResult;
}): Promise<void> {
  if (
    !shouldApplyAiriPostDeliveryEffects(params.result) ||
    !params.request.postDeliveryEffects?.length
  ) {
    return;
  }

  await applyTemporalPostDeliveryEffects({
    delivery: params.result,
    effects: params.request.postDeliveryEffects,
  });
}

export async function deliverAiriConversationOutbound(
  request: AiriConversationOutboundDeliveryRequest,
): Promise<AiriConversationOutboundDeliveryResult> {
  await connectDB();

  const generativeClaimGuard = resolveGenerativeDeliveryClaimGuard(request);
  if (generativeClaimGuard.classification === "invalid") {
    throw new Error("Generative result delivery claim is malformed");
  }
  const generativePreflight =
    generativeClaimGuard.classification === "required"
      ? await inspectGenerativeDeliveryPreflight({
          ...generativeClaimGuard.claim,
          context: request.context,
        })
      : null;
  if (generativePreflight?.classification === "malformed_owner") {
    throw new Error("Generative result delivery owner is malformed");
  }
  if (generativePreflight?.classification === "stale_claim") {
    airiWorkerLogger.info("airi.worker.delivery_skipped", {
      deliveryKey: request.deliveryKey,
      reservedMessageId: request.reservedMessageId,
      reason: "generative_delivery_claim_stale",
      conversationId: readAiriDeliveryConversationId(request) || null,
    });
    return {
      deliveryKey: request.deliveryKey,
      outboundMessageId: request.reservedMessageId,
      outboundDate: null,
      classification: "not_attempted",
      skipped: true,
      skipReason: "generative_delivery_claim_stale",
    };
  }

  const bypassManualHandoff = shouldBypassManualHandoffForAiriDelivery(request);

  if (!bypassManualHandoff && (await isBlockedByManualHandoff(request))) {
    airiWorkerLogger.info("airi.worker.delivery_skipped", {
      deliveryKey: request.deliveryKey,
      reservedMessageId: request.reservedMessageId,
      reason: "manual_handoff_active",
      conversationId: readAiriDeliveryConversationId(request) || null,
    });
    return {
      deliveryKey: request.deliveryKey,
      outboundMessageId: request.reservedMessageId,
      outboundDate: null,
      classification: "skipped",
      skipped: true,
      skipReason: "manual_handoff_active",
    };
  }

  if (generativePreflight?.classification === "invalid_payload") {
    airiWorkerLogger.info("airi.worker.delivery_skipped", {
      deliveryKey: request.deliveryKey,
      reservedMessageId: request.reservedMessageId,
      reason: "generative_delivery_payload_invalid",
      conversationId: readAiriDeliveryConversationId(request) || null,
    });
    return {
      deliveryKey: request.deliveryKey,
      outboundMessageId: request.reservedMessageId,
      outboundDate: null,
      classification: "not_attempted",
      skipped: true,
      skipReason: "generative_delivery_payload_invalid",
    };
  }

  const workspaceId = readAiriDeliveryWorkspaceId(request);
  const hasScenarioContext = hasScenarioDeliveryContext(request);
  if (
    workspaceId &&
    !hasScenarioContext &&
    !hasFreshCapacityVerification(request)
  ) {
    const airiCapacity = await ensureCompanyAiriAutoReplyCapacity(
      supabaseAdmin,
      workspaceId,
    );
    if (!airiCapacity.allowed) {
      airiWorkerLogger.info("airi.worker.delivery_skipped", {
        deliveryKey: request.deliveryKey,
        reservedMessageId: request.reservedMessageId,
        reason: COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE,
        workspaceId,
        conversationId: readAiriDeliveryConversationId(request) || null,
      });
      return {
        deliveryKey: request.deliveryKey,
        outboundMessageId: request.reservedMessageId,
        outboundDate: null,
        classification: "skipped",
        skipped: true,
        skipReason: COMPANY_AIRI_AUTO_REPLY_LIMIT_EXCEEDED_CODE,
      };
    }
  }

  const outbound = await sendAndPersistOutbound({
    ...(request.context as Record<string, unknown>),
    ...(request.dispatchPolicy === "at_most_once"
      ? { temporalDispatchPolicy: "at_most_once" }
      : {}),
  });
  const classification =
    request.dispatchPolicy === "at_most_once" || outbound.temporalDispatch
      ? classifyAiriTemporalDispatch(
          outbound.temporalDispatch?.state || "outcome_unknown",
        )
      : "sent";

  const result = {
    deliveryKey: request.deliveryKey,
    outboundMessageId: String(outbound?._id || request.reservedMessageId),
    outboundDate: resolveAiriOutboundDate(
      classification,
      normalizeDateIso(outbound?.date) || null,
    ),
    classification,
    skipped: isAiriDeliveryCompatiblySkipped(classification),
    ...(classification !== "sent" ? { skipReason: classification } : {}),
  };
  await applyPostDeliveryEffectsForResult({ request, result });
  return result;
}

export async function finalizeAiriConversationOutbound(
  input: AiriConversationFinalizeOutboundInput,
): Promise<void> {
  await connectDB();
  await applyTemporalPostDeliveryEffects(input);
}

export async function readAiriConversationProjection(params: {
  conversationId: string;
}): Promise<AiriConversationProjection | null> {
  await connectDB();

  const conversation = (await Conversation!
    .findById(params.conversationId)
    .select(
      "preferred_language updatedAt airi_context_memory airi_scenario_state airi_handoff_active airi_handoff_source airi_handoff_reason airi_handoff_started_at",
    )
    .lean()) as {
    preferred_language?: string | null;
    updatedAt?: Date | string | null;
    airi_context_memory?: {
      currentGoal?: string | null;
      preferredLanguage?: string | null;
    } | null;
    airi_scenario_state?: {
      lockedScenarioId?: string | null;
      lockedScenarioName?: string | null;
      currentActionNodeId?: string | null;
      currentPathNodeIds?: string[];
      currentBranchNodeIds?: string[];
      pendingConditionNodeId?: string | null;
      pendingSourceActionNodeId?: string | null;
      pendingLinkedConditionId?: string | null;
    } | null;
    airi_handoff_active?: boolean;
    airi_handoff_source?: string | null;
    airi_handoff_reason?: string | null;
    airi_handoff_started_at?: Date | string | null;
  } | null;

  if (!conversation) {
    return null;
  }

  const scenarioState = conversation.airi_scenario_state || null;
  const contextMemory = conversation.airi_context_memory || null;

  return {
    currentGoal:
      normalizeOptionalString(contextMemory?.currentGoal) ||
      normalizeOptionalString(scenarioState?.lockedScenarioName),
    preferredLanguage:
      normalizeOptionalString(contextMemory?.preferredLanguage) ||
      normalizeOptionalString(conversation.preferred_language),
    activeScenarioId: normalizeOptionalString(scenarioState?.lockedScenarioId),
    activeScenarioName: normalizeOptionalString(
      scenarioState?.lockedScenarioName,
    ),
    currentActionNodeId: normalizeOptionalString(
      scenarioState?.currentActionNodeId,
    ),
    currentPathNodeIds: normalizeStringArray(scenarioState?.currentPathNodeIds),
    currentBranchNodeIds: normalizeStringArray(
      scenarioState?.currentBranchNodeIds,
    ),
    pendingConditionNodeId: normalizeOptionalString(
      scenarioState?.pendingConditionNodeId,
    ),
    pendingSourceActionNodeId: normalizeOptionalString(
      scenarioState?.pendingSourceActionNodeId,
    ),
    pendingLinkedConditionId: normalizeOptionalString(
      scenarioState?.pendingLinkedConditionId,
    ),
    handoffActive: isScenarioAutomationPausedByHandoff(
      conversation.airi_handoff_active,
    ),
    handoffSource: normalizeOptionalString(conversation.airi_handoff_source),
    handoffReason: normalizeOptionalString(conversation.airi_handoff_reason),
    handoffStartedAt: normalizeDateIso(conversation.airi_handoff_started_at),
    updatedAt: normalizeDateIso(conversation.updatedAt),
  };
}
