import { authenticateRequest, hasPermission } from "@/lib/api-auth";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import {
  buildMessageSendIdentity,
  completeMessageSend,
  getMessageSendReplay,
  recordUnknownMessageSend,
  reserveMessageSend,
  type MessageSendIdentity,
  type MessageSendReplay,
} from "@/lib/api/message-send-idempotency";
import { appendMessageToConversationById } from "@/lib/conversation-messages";
import {
  checkMessagingWindowForConversation,
  formatWindowMessage,
} from "@/lib/messaging-window";
import connectDB from "@/lib/mongoose";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import { createServerLogger } from "@/lib/observability/server-logs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendWhatsappMessage } from "@/lib/whatsapp";
import { resolveFreshWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import { resolveStoredWhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";
import { normalizeWhatsAppMessageId } from "@icecore/shared/lib/whatsapp/message-id";
import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const sendLogger = createServerLogger("api.v1.messages.send");

const MessageSendBodySchema = z.object({
  conversationId: z.string().regex(/^[a-f\d]{24}$/i),
  text: z.string().trim().min(1).max(4096),
});
const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);

function failure(code: string, error: string, status: number) {
  return NextResponse.json({ code, error }, { status });
}

function unknownOutcome(status: number) {
  return failure(
    "SEND_OUTCOME_UNKNOWN",
    "The message may have been sent. Repeat only the same request with the same Idempotency-Key to inspect its outcome. Do not send with a new key; contact support if the outcome remains unknown.",
    status
  );
}

function replayResponse(replay: MessageSendReplay): Response {
  if (replay.state === "completed") return NextResponse.json(replay.response);
  if (replay.state === "conflict") {
    return failure(
      "IDEMPOTENCY_KEY_CONFLICT",
      "This Idempotency-Key was already used for a different message.",
      409
    );
  }
  if (replay.state === "pending") {
    return NextResponse.json(
      {
        code: "SEND_IN_PROGRESS",
        error:
          "This message is already being processed. Retry only the same request with the same Idempotency-Key to inspect its outcome.",
      },
      { status: 409, headers: { "Retry-After": "2" } }
    );
  }
  return unknownOutcome(409);
}

/** Public API: WhatsApp text reply to an existing workspace conversation. */
export async function POST(request: Request): Promise<Response> {
  const { apiKey, error } = await authenticateRequest(request, {
    requireDistributedRateLimit: true,
  });
  if (error) return error;
  if (!apiKey || !hasPermission(apiKey, "write")) {
    return failure(
      "API_WRITE_PERMISSION_REQUIRED",
      "API key does not have permission to send messages",
      403
    );
  }

  const rawIdempotencyKey = request.headers.get("Idempotency-Key");
  if (!rawIdempotencyKey?.trim()) {
    return failure(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required for message sends.",
      400
    );
  }
  const keyResult = IdempotencyKeySchema.safeParse(rawIdempotencyKey);
  if (!keyResult.success) {
    return failure(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must contain 1 to 200 printable ASCII characters without spaces.",
      400
    );
  }

  let identity: MessageSendIdentity | undefined;
  let reserved = false;
  let accepted: { providerMessageId: string; sentAt: Date } | undefined;

  try {
    const { conversationId, text } = MessageSendBodySchema.parse(
      await readJsonBodyWithinLimit(request, 32 * 1024)
    );
    identity = buildMessageSendIdentity(apiKey.workspace_id, keyResult.data, {
      conversationId,
      text,
    });
    await connectDB();

    const replay = await getMessageSendReplay(identity);
    if (replay) return replayResponse(replay);

    const conversation = await Conversation.findById(conversationId);
    if (!conversation)
      return failure("CONVERSATION_NOT_FOUND", "Conversation not found", 404);
    if (conversation.workspaceId !== apiKey.workspace_id) {
      return failure(
        "WORKSPACE_ACCESS_DENIED",
        "Conversation does not belong to this workspace",
        403
      );
    }
    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabaseAdmin,
      apiKey.workspace_id,
      conversationId
    );
    if (planGateResponse) return planGateResponse;
    if (conversation.channel !== "whatsapp") {
      return failure(
        "CHANNEL_NOT_SUPPORTED",
        `Sending messages via API is not yet supported for ${conversation.channel}`,
        501
      );
    }
    const sourceId =
      typeof conversation.sourceId === "string"
        ? conversation.sourceId.trim()
        : "";
    if (!sourceId) {
      return failure(
        "WHATSAPP_SOURCE_REQUIRED",
        "The conversation has no WhatsApp source binding. Contact support before sending.",
        409
      );
    }
    const source = await resolveFreshWhatsAppSendContext({
      workspaceId: apiKey.workspace_id,
      sourceId,
    });
    if (!source) {
      return failure(
        "WHATSAPP_SOURCE_UNAVAILABLE",
        "The conversation's WhatsApp connection is unavailable.",
        409
      );
    }
    const windowInfo = await checkMessagingWindowForConversation(conversation);
    if (!windowInfo.isWithinWindow) {
      return failure(
        "WHATSAPP_MESSAGING_WINDOW_CLOSED",
        `Cannot send message: ${formatWindowMessage(windowInfo)}`,
        409
      );
    }
    const recipientUser = conversation.user
      ? await User.findById(conversation.user).select("_id whatsapp").lean()
      : null;
    const recipient = resolveStoredWhatsAppRecipientTarget(
      recipientUser,
      conversation.user,
      conversation.chat
    );
    if (!recipient)
      return failure(
        "WHATSAPP_RECIPIENT_UNAVAILABLE",
        "Recipient WhatsApp target not found",
        409
      );

    // All definitive validation is complete before claiming the irreversible send.
    const messageObjectId = new mongoose.Types.ObjectId();
    const reservation = await reserveMessageSend(identity, {
      apiKeyId: apiKey.id,
      conversationId,
      sourceId,
      messageId: String(messageObjectId),
    });
    if (!reservation.acquired) return replayResponse(reservation.replay);
    reserved = true;

    const result = await sendWhatsappMessage(
      source.phoneNumberId,
      source.accessToken,
      recipient,
      text
    );
    if (!result.messageId || !Number.isFinite(result.date)) {
      throw new Error("WhatsApp send acknowledgement is incomplete");
    }
    accepted = {
      providerMessageId: result.messageId,
      sentAt: new Date(result.date * 1000),
    };

    const apiUser = await User.findOneAndUpdate(
      { _id: "api_bot" },
      { _id: "api_bot", isBot: true, firstName: "API" },
      { upsert: true, new: true }
    );
    const newMessage = new Message({
      _id: messageObjectId,
      messageId: normalizeWhatsAppMessageId(result.messageId),
      chat:
        typeof conversation.chat === "object" && conversation.chat?._id
          ? conversation.chat._id
          : conversation.chat,
      author: apiUser._id,
      text,
      date: accepted.sentAt,
      workspaceId: apiKey.workspace_id,
      conversation: conversation._id,
      channel: "whatsapp",
      direction: "outbound",
      origin: { kind: "system", sentByUserId: "api_bot", sourceId },
    });
    await newMessage.save({ writeConcern: { w: "majority", wtimeout: 5_000 } });
    await appendMessageToConversationById(conversation._id, newMessage._id, {
      lastMessageAt: newMessage.date,
      direction: "outbound",
    });

    const response = {
      success: true as const,
      messageId: String(newMessage._id),
      sentAt: newMessage.date.toISOString(),
    };
    await completeMessageSend(identity, response, accepted.providerMessageId);
    return NextResponse.json(response);
  } catch (caught) {
    if (reserved && identity) {
      // Even if this update fails, the original pending record still blocks resend.
      await recordUnknownMessageSend(identity, accepted).catch(() => undefined);
      sendLogger.error("Message send outcome unknown", undefined, {
        operationId: identity.operationId,
        workspaceId: apiKey.workspace_id,
        errorClass: caught instanceof Error ? caught.name : "unknown",
        providerAccepted: Boolean(accepted),
      });
      return unknownOutcome(502);
    }
    if (caught instanceof JsonBodyTooLargeError)
      return failure("MESSAGE_BODY_TOO_LARGE", caught.message, 413);
    if (
      caught instanceof InvalidJsonBodyError ||
      caught instanceof z.ZodError
    ) {
      return failure(
        "INVALID_MESSAGE_BODY",
        "Provide a valid conversationId and message text of 1 to 4096 characters.",
        400
      );
    }
    sendLogger.error("Message send admission failed", undefined, {
      workspaceId: apiKey.workspace_id,
      errorClass: caught instanceof Error ? caught.name : "unknown",
    });
    return failure(
      "MESSAGE_SEND_UNAVAILABLE",
      "Message sending is temporarily unavailable. Retry the same request and Idempotency-Key later.",
      503
    );
  }
}
