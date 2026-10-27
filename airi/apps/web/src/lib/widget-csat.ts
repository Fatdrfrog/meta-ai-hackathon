import type { WidgetCsatActivityResult } from "@icecore/temporal";
import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { persistOrRecoverAndLink } from "@icecore/shared/lib/persist-recover-link";

import { appendMessageToConversationById } from "@/lib/conversation-messages";
import { buildDeterministicMongoObjectId } from "@/lib/mongo-deterministic-id";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { realtime } from "@/lib/realtime/server";
import { triggerConversationResolved } from "@/lib/webhook-events";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import {
  readNonEmptyString as normalizeOptionalString,
  requireNonEmptyString,
} from "@icecore/shared/lib/value-utils";

export const WIDGET_CSAT_REQUEST_TEXT =
  "We'd love to hear your feedback! Please rate your experience.";

export type WidgetCsatRequestParams = {
  conversationId: string;
  workspaceId?: string | null;
  ensureAwaiting?: boolean;
};

export type WidgetCsatTimeoutParams = {
  conversationId: string;
  workspaceId?: string | null;
};

function buildCsatMessageDto(params: {
  messageId: string;
  conversationId: string;
  workspaceId: string;
  text: string;
  timestamp: string;
}) {
  return {
    id: params.messageId,
    conversationId: params.conversationId,
    workspaceId: params.workspaceId,
    text: params.text,
    direction: "outbound",
    timestamp: params.timestamp,
    authorName: "System",
    actionType: "csat_request",
  };
}

export async function sendWidgetCsatRequest(
  params: WidgetCsatRequestParams
): Promise<WidgetCsatActivityResult> {
  const conversationId = requireNonEmptyString(
    params.conversationId,
    "conversationId"
  );
  const workspaceId = normalizeOptionalString(params.workspaceId);

  await connectDB();

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    return { ok: true, skipped: true, reason: "conversation_not_found" };
  }

  if (workspaceId && conversation.workspaceId !== workspaceId) {
    return { ok: true, skipped: true, reason: "workspace_mismatch" };
  }

  if (conversation.channel !== "web_widget") {
    return { ok: true, skipped: true, reason: "not_web_widget" };
  }

  if (conversation.customer_satisfaction_score) {
    return { ok: true, skipped: true, reason: "already_rated" };
  }

  if (!conversation.awaiting_csat && !params.ensureAwaiting) {
    return { ok: true, skipped: true, reason: "not_awaiting_csat" };
  }

  const deterministicMessageId = buildDeterministicMongoObjectId(
    "widget-csat-request",
    String(conversation._id)
  );
  type CsatMessageRecord = {
    _id: Parameters<typeof appendMessageToConversationById>[1];
    date?: Date | null;
    text?: string | null;
  };

  const { record: csatMessage, linkResult } = await persistOrRecoverAndLink({
    findExisting: () =>
      Message.findOne({
        conversation: conversation._id,
        $or: [{ _id: deterministicMessageId }, { actionType: "csat_request" }],
      })
        .select("_id date text")
        .lean<CsatMessageRecord | null>(),
    persist: async () => {
      const message = new Message({
        _id: deterministicMessageId,
        text: WIDGET_CSAT_REQUEST_TEXT,
        date: new Date(),
        workspaceId: conversation.workspaceId,
        conversation: conversation._id,
        channel: "web_widget",
        direction: "outbound",
        origin: {
          kind: "system",
        },
        actionType: "csat_request",
      });
      await message.save();
      return message as CsatMessageRecord;
    },
    isDuplicateError: isMongoDuplicateKeyError,
    link: message =>
      appendMessageToConversationById(conversation._id, message._id, {
        ...(message.date instanceof Date
          ? { lastMessageAt: message.date }
          : {}),
        direction: "outbound",
        set: { awaiting_csat: true },
      }),
  });

  if (!linkResult.appended) {
    return {
      ok: true,
      skipped: true,
      reason: "csat_already_sent",
      messageId: String(csatMessage._id),
    };
  }

  const csatMessageDate =
    csatMessage.date instanceof Date ? csatMessage.date : new Date();
  const csatMessageText = csatMessage.text || WIDGET_CSAT_REQUEST_TEXT;

  try {
    await realtime.trigger(
      `conversation-${conversationId}`,
      "message.new",
      buildCsatMessageDto({
        messageId: String(csatMessage._id),
        conversationId,
        workspaceId: conversation.workspaceId,
        text: csatMessageText,
        timestamp: csatMessageDate.toISOString(),
      })
    );
  } catch (error) {
    console.error("[Widget CSAT] Failed to publish request event", {
      conversationId,
      error,
    });
  }

  return {
    ok: true,
    messageId: String(csatMessage._id),
  };
}

export async function forceCloseWidgetCsatTimeout(
  params: WidgetCsatTimeoutParams
): Promise<WidgetCsatActivityResult> {
  const conversationId = requireNonEmptyString(
    params.conversationId,
    "conversationId"
  );
  const workspaceId = normalizeOptionalString(params.workspaceId);

  await connectDB();

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    return { ok: true, skipped: true, reason: "conversation_not_found" };
  }

  if (workspaceId && conversation.workspaceId !== workspaceId) {
    return { ok: true, skipped: true, reason: "workspace_mismatch" };
  }

  if (!conversation.awaiting_csat) {
    return { ok: true, skipped: true, reason: "not_awaiting_csat" };
  }

  if (conversation.customer_satisfaction_score) {
    conversation.awaiting_csat = false;
    await conversation.save();
    return { ok: true, skipped: true, reason: "already_rated" };
  }

  const previousStatus = conversation.status;
  conversation.awaiting_csat = false;
  conversation.status = "closed";
  conversation.csat_timeout_closed = true;
  conversation.updatedAt = new Date();
  await conversation.save();

  triggerConversationResolved(
    workspaceId || conversation.workspaceId,
    buildConversationEventData(conversation, {
      status: "closed",
      previous_status: previousStatus,
      channel: conversation.channel || "web_widget",
      customer_phone: conversation.user?.toString(),
      // Customer webhooks still see a resolution; analytics excludes timeouts.
      resolution_kind: "timeout",
    })
  ).catch(error =>
    console.error("[Widget CSAT] Webhook trigger error", {
      conversationId,
      error,
    })
  );

  realtime
    .trigger(`conversation-${conversationId}`, "conversation-updated", {
      workspaceId: conversation.workspaceId,
      status: "closed",
      awaiting_csat: false,
      csat_timeout_closed: true,
    })
    .catch(error =>
      console.error("[Widget CSAT] Realtime trigger error", {
        conversationId,
        error,
      })
    );

  return {
    ok: true,
    forceClosed: true,
  };
}
