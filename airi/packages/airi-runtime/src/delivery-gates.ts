import type { AiriConversationOutboundDeliveryRequest } from "@icecore/temporal";
import { asNullableRecord, asRecord } from "@icecore/shared/lib/value-utils";
import { parseDate } from "./internal/value-normalization";

/** Rechecked at the provider boundary after potentially slow media preparation. */
export function resolveScenarioDeliveryOwnership(input: {
  capturedConversation: unknown;
  currentConversation: unknown;
  scenarioId: string;
  actionNodeId: string;
  capturedMessageDate?: unknown;
}):
  | { allow: true }
  | {
      allow: false;
      reason:
        | "newer_inbound"
        | "scenario_changed"
        | "manual_handoff_started"
        | "conversation_missing"
        | "inbound_checkpoint_invalid";
    } {
  const current = asNullableRecord(input.currentConversation);
  if (!current) return { allow: false, reason: "conversation_missing" };
  const captured = asRecord(input.capturedConversation);
  const state = asRecord(current.airi_scenario_state);
  if (
    !input.scenarioId ||
    !input.actionNodeId ||
    state.lockedScenarioId !== input.scenarioId ||
    // Pending waits own the selected action. Other sends already persist the
    // next continuation during preparation, before this outbound is delivered.
    (state.pendingConditionNodeId &&
      state.currentActionNodeId !== input.actionNodeId)
  )
    return { allow: false, reason: "scenario_changed" };

  const liveInbound = parseDate(current.last_inbound_at);
  const capturedInbound =
    parseDate(captured.last_inbound_at) ?? parseDate(input.capturedMessageDate);
  if (
    (current.last_inbound_at != null && !liveInbound) ||
    (liveInbound && !capturedInbound)
  )
    return { allow: false, reason: "inbound_checkpoint_invalid" };
  if (
    liveInbound &&
    capturedInbound &&
    liveInbound.getTime() > capturedInbound.getTime()
  )
    return { allow: false, reason: "newer_inbound" };

  if (
    current.airi_handoff_active === true &&
    (captured.airi_handoff_active !== true ||
      (parseDate(current.airi_handoff_started_at)?.getTime() ?? null) !==
        (parseDate(captured.airi_handoff_started_at)?.getTime() ?? null))
  )
    return { allow: false, reason: "manual_handoff_started" };
  return { allow: true };
}

export type GenerativeDeliveryClaimGuard = {
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
};

export type GenerativeDeliveryClaimGuardResolution =
  | { classification: "not_applicable" }
  | { classification: "invalid" }
  | {
      classification: "required";
      claim: GenerativeDeliveryClaimGuard;
    };

function readEntityId(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (typeof value === "object") {
    const raw = value as Record<string, unknown>;
    if (raw._id !== null && raw._id !== undefined) {
      return String(raw._id).trim();
    }
  }
  return "";
}

export function readAiriDeliveryConversationId(
  request: AiriConversationOutboundDeliveryRequest,
): string {
  const context = request.context || {};
  return (
    readEntityId(context.conversationId) ||
    readEntityId(
      (context.conversation as Record<string, unknown> | undefined)?._id,
    ) ||
    readEntityId(context.conversation)
  );
}

export function readAiriDeliveryWorkspaceId(
  request: AiriConversationOutboundDeliveryRequest,
): string {
  return readEntityId(request.context?.workspaceId);
}

function readCanonicalString(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : "";
}

export function resolveGenerativeDeliveryClaimGuard(
  request: AiriConversationOutboundDeliveryRequest,
): GenerativeDeliveryClaimGuardResolution {
  const effects = (request.postDeliveryEffects || []).filter(
    (
      effect,
    ): effect is Extract<
      NonNullable<
        AiriConversationOutboundDeliveryRequest["postDeliveryEffects"]
      >[number],
      { kind: "finalize_generative_ai_result" }
    > => effect.kind === "finalize_generative_ai_result",
  );
  if (effects.length === 0) {
    return { classification: "not_applicable" };
  }
  if (
    effects.length !== 1 ||
    effects.length !== (request.postDeliveryEffects || []).length
  ) {
    return { classification: "invalid" };
  }

  const payload = effects[0].payload;
  const assetId =
    payload.assetId === null ? null : readCanonicalString(payload.assetId);
  const videoWorkflowId =
    payload.videoWorkflowId === null
      ? null
      : readCanonicalString(payload.videoWorkflowId);
  const attemptToken =
    payload.attemptToken === null
      ? null
      : readCanonicalString(payload.attemptToken);
  const claim: GenerativeDeliveryClaimGuard = {
    workspaceId: readCanonicalString(payload.workspaceId),
    conversationId: readCanonicalString(payload.conversationId),
    executionId: readCanonicalString(payload.executionId),
    scenarioId: readCanonicalString(payload.scenarioId),
    scenarioRevisionFingerprint: readCanonicalString(
      payload.scenarioRevisionFingerprint,
    ),
    actionNodeId: readCanonicalString(payload.actionNodeId),
    deliveryClaimToken: readCanonicalString(payload.deliveryClaimToken),
    deliveryKey: readCanonicalString(request.deliveryKey),
    reservedMessageId: readCanonicalString(request.reservedMessageId),
    assetId,
    videoWorkflowId,
    attemptToken,
  };
  const hasVideoIdentity = Boolean(assetId && videoWorkflowId && attemptToken);
  const hasNoVideoIdentity =
    assetId === null && videoWorkflowId === null && attemptToken === null;
  const hasRequiredClaimStrings = Object.entries(claim).every(
    ([key, value]) =>
      key === "assetId" ||
      key === "videoWorkflowId" ||
      key === "attemptToken" ||
      Boolean(value),
  );
  return hasRequiredClaimStrings &&
    (hasVideoIdentity || hasNoVideoIdentity) &&
    readAiriDeliveryWorkspaceId(request) === claim.workspaceId &&
    readAiriDeliveryConversationId(request) === claim.conversationId
    ? { classification: "required", claim }
    : { classification: "invalid" };
}

export function hasScenarioDeliveryContext(
  request: AiriConversationOutboundDeliveryRequest,
): boolean {
  const context = request.context || {};
  if (context.scenarioOrigin) return true;

  const whatsappFlowCta = context.whatsappFlowCta;
  if (whatsappFlowCta && typeof whatsappFlowCta === "object") {
    const scenarioId = (whatsappFlowCta as { scenarioId?: unknown }).scenarioId;
    if (readEntityId(scenarioId)) return true;
  }

  return false;
}

function readContextMessageId(
  request: AiriConversationOutboundDeliveryRequest,
): string {
  const context = request.context || {};
  const newMessage = context.newMessage;
  if (newMessage && typeof newMessage === "object") {
    const rawId = (newMessage as { _id?: unknown })._id;
    const id = readEntityId(rawId);
    if (id) return id;
  }

  return readEntityId(context.messageId);
}

export function isPostActionScenarioTimeoutDelivery(
  request: AiriConversationOutboundDeliveryRequest,
): boolean {
  return readContextMessageId(request).startsWith(
    "scenario-timeout:post_action_no_reply_timeout:",
  );
}

export function shouldBypassManualHandoffForAiriDelivery(
  request: AiriConversationOutboundDeliveryRequest,
): boolean {
  if (request.manualHandoffPolicy === "respect") {
    return false;
  }
  return (
    isPostActionScenarioTimeoutDelivery(request) ||
    hasScenarioDeliveryContext(request)
  );
}
