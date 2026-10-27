import "server-only";

import type { AiriAutoReplyParams } from "@icecore/airi-runtime/auto-reply";
import type {
  AiriConversationExternalEventResult,
  AiriConversationPaymentConfirmedEvent,
  AiriConversationTurnSignal,
} from "@icecore/temporal";
import type { ConfirmedPaymentScenarioSnapshot } from "@icecore/shared/types/conversion-events";
import { supabaseAdmin } from "@/lib/supabase/admin";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import type { ConversationDocument } from "@/types/models";
import { parseConfirmedPaymentScenarioSnapshot } from "./confirmed-payment-scenario";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const PREFIX = "confirmed-payment:";
const PENDING = ["pending", "queued"];

function unavailablePaymentContext(message: string): Error {
  return Object.assign(new Error(message), {
    code: "AIRI_CONFIRMED_PAYMENT_NOT_ELIGIBLE",
  });
}
type PaymentRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  conversion_type: string;
  conversion_value: number | null;
  scenario_effect_status: string;
  scenario_effect_reason: string | null;
  scenario_effect_snapshot: unknown;
};

async function readPayment(turn: AiriConversationTurnSignal): Promise<{
  row: PaymentRow;
  snapshot: ConfirmedPaymentScenarioSnapshot;
}> {
  const conversionId = turn.messageId.startsWith(PREFIX)
    ? turn.messageId.slice(PREFIX.length)
    : "";
  if (
    !UUID.test(conversionId) ||
    !UUID.test(turn.workspaceId) ||
    !OBJECT_ID.test(turn.conversationId) ||
    turn.channel !== "whatsapp"
  ) {
    throw new Error("Invalid confirmed payment identity");
  }
  const result = await supabaseAdmin
    .from("conversions")
    .select(
      "id,workspace_id,conversation_id,conversion_type,conversion_value,scenario_effect_status,scenario_effect_reason,scenario_effect_snapshot"
    )
    .eq("workspace_id", turn.workspaceId)
    .eq("id", conversionId)
    .eq("conversation_id", turn.conversationId)
    .maybeSingle();
  if (result.error) throw new Error("Confirmed payment ledger lookup failed");
  const row = result.data as PaymentRow | null;
  const snapshot = parseConfirmedPaymentScenarioSnapshot(
    row?.scenario_effect_snapshot
  );
  if (
    !row ||
    row.conversion_type !== "sale" ||
    !(Number(row.conversion_value) > 0) ||
    !snapshot ||
    snapshot.sourceId !== turn.sourceId
  ) {
    throw new Error("Confirmed payment has no matching sale authority");
  }
  if (
    row.scenario_effect_status === "failed" &&
    ["dispatch_failed", "dispatch_retries_exhausted"].includes(
      row.scenario_effect_reason || ""
    )
  ) {
    // A prior signal may have reached this workflow even if the outbox later
    // exhausted retries. Its accepted event may resume; execution failures may not.
    const recovered = await supabaseAdmin
      .from("conversions")
      .update({
        scenario_effect_status: "queued",
        scenario_effect_reason: null,
      })
      .eq("workspace_id", turn.workspaceId)
      .eq("id", conversionId)
      .eq("conversation_id", turn.conversationId)
      .eq("scenario_effect_status", "failed")
      .in("scenario_effect_reason", [
        "dispatch_failed",
        "dispatch_retries_exhausted",
      ])
      .select("id")
      .maybeSingle();
    if (recovered.error || !recovered.data) {
      throw new Error("Confirmed payment dispatch recovery must be retried");
    }
    row.scenario_effect_status = "queued";
    row.scenario_effect_reason = null;
  }
  return { row, snapshot };
}

/** Read the ledger again at preparation; a signal or legacy payload is not authority. */
export async function hydrateConfirmedPaymentTurn(
  turn: AiriConversationTurnSignal
): Promise<AiriAutoReplyParams> {
  const { row, snapshot } = await readPayment(turn);
  if (!PENDING.includes(row.scenario_effect_status)) {
    throw new Error("Confirmed payment effect is already terminal");
  }
  await connectDB();
  const conversation = await Conversation.findOne({
    _id: turn.conversationId,
    workspaceId: turn.workspaceId,
    sourceId: snapshot.sourceId,
    channel: "whatsapp",
  })
    .select("-messages -embedding")
    .lean<ConversationDocument | null>();
  if (!conversation)
    throw unavailablePaymentContext(
      "Confirmed payment conversation no longer matches"
    );
  const { resolveChatDocument, buildChannelSpecificParams } = await import(
    "@/lib/airi/scenario/scenario-channel-utils"
  );
  const { chatDocument, chatId, chatType } =
    await resolveChatDocument(conversation);
  const channelParams = await buildChannelSpecificParams({
    workspaceId: turn.workspaceId,
    conversation,
    chatDocument,
    channelOverride: "whatsapp",
    sourceBindingNotAfter: snapshot.pendingStartedAt,
  });
  if (!channelParams.ok)
    throw unavailablePaymentContext("Confirmed payment channel unavailable");
  return {
    type: "whatsapp",
    workspaceId: turn.workspaceId,
    conversation,
    chatDocument,
    chatId,
    chatType,
    whatsAppInfo: channelParams.whatsAppInfo,
    newMessage: {
      _id: turn.messageId,
      text: "",
      date: new Date(snapshot.occurredAt),
      direction: "inbound",
      channel: "whatsapp",
      conversation: conversation._id,
      workspaceId: turn.workspaceId,
    } as unknown as AiriAutoReplyParams["newMessage"],
    confirmedPaymentScenario: snapshot,
    scenarioOverrideId: snapshot.scenarioId,
    triggerEventKind: "payment_detected",
    suppressGeneralAutoReply: true,
    runtimeHydrated: true,
  };
}

async function replan(
  event: AiriConversationPaymentConfirmedEvent
): Promise<AiriConversationExternalEventResult> {
  const [
    { handleAiriConversationExternalEvent },
    { airiScenarioTimerDependencies },
  ] = await Promise.all([
    import("@icecore/airi-runtime/temporal-scenario-timers"),
    import("@/lib/airi/scenario/timer-runtime-dependencies"),
  ]);
  return handleAiriConversationExternalEvent(
    {
      kind: "timer_replan",
      workspaceId: event.workspaceId,
      conversationId: event.conversationId,
      messageId: `payment-replan:${event.conversionId}`,
    },
    airiScenarioTimerDependencies
  );
}

/** Existing turn preparation/delivery receipts own execution; SQL owns terminal acknowledgement. */
export async function handleConfirmedPaymentScenarioEvent(
  event: AiriConversationPaymentConfirmedEvent
): Promise<AiriConversationExternalEventResult> {
  if (event.messageId !== `${PREFIX}${event.conversionId}`) {
    throw new Error("Confirmed payment signal identity mismatch");
  }
  const { row, snapshot } = await readPayment(event);
  if (
    event.phase === "complete" &&
    PENDING.includes(row.scenario_effect_status)
  ) {
    if (
      !["processed", "skipped", "failed"].includes(event.completionStatus || "")
    ) {
      throw new Error("Confirmed payment completion status is required");
    }
    const saved = await supabaseAdmin
      .from("conversions")
      .update({
        scenario_effect_status: event.completionStatus,
        scenario_effect_reason: event.completionReason?.slice(0, 200) || null,
      })
      .eq("workspace_id", event.workspaceId)
      .eq("id", event.conversionId)
      .eq("conversation_id", event.conversationId)
      .in("scenario_effect_status", PENDING);
    if (saved.error)
      throw new Error("Confirmed payment acknowledgement failed");
  }
  if (
    event.phase === "complete" ||
    !PENDING.includes(row.scenario_effect_status)
  ) {
    return { ...(await replan(event)), paymentDisposition: "terminal" };
  }
  // Do not reject a changed wait here: a retry may own an already prepared
  // outbound. The runtime validates the wait under lock on the first attempt.
  return {
    handled: true,
    clearTimer: false,
    paymentDisposition: "ready",
    paymentTurn: {
      workspaceId: event.workspaceId,
      conversationId: event.conversationId,
      sourceId: snapshot.sourceId,
      channel: "whatsapp",
      messageId: event.messageId,
      messageDate: snapshot.occurredAt,
      enqueuedAt: snapshot.occurredAt,
      triggerEventKind: "payment_detected",
      scenarioOverrideId: snapshot.scenarioId,
    },
  };
}
