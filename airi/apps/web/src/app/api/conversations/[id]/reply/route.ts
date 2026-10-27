import { errorMessageResponse } from "@/lib/api/json-body";
import { invalidateConversationCache } from "@/lib/cache";
import { normalizeConversationOutboundAttachments } from "@/lib/conversation-attachments";
import {
  InstagramPartialSendError,
  isInstagramSendError,
} from "@/lib/instagram/send-errors";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import { withCustomerMediaReadUrls } from "@/lib/media/customer-media-read-url";
import {
  isHttpOrHttpsUrl,
  parseWhatsAppMediaProxyUrl,
} from "@/lib/media/whatsapp-media-url";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { checkProfanity } from "@/lib/profanity";
import { getWorkspaceMemberDisplayName } from "@/lib/supabase/company-users";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { createRequestLogger } from "@/lib/observability/server-logs";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import User from "@/models/user";
import {
  ConversationDocument,
  EmailSendResponse,
  PopulatedMessage,
} from "@/types/models";
import type { OutboundAttachment } from "@/types/outbound-attachment";
import { NextRequest, NextResponse } from "next/server";
import { handleEmailReply } from "./handleEmailReply";
import { handleInstagramReply } from "./handleInstagramReply";
import { handleTelegramReply } from "./handleTelegramReply";
import { handleWebWidget } from "./handleWebWidget";
import { handleWhatsAppReply } from "./handleWhatsAppReply";
import type { ManagerReplyHandler } from "./manager-reply-context";

type Params = Promise<{ id: string }>;

function errorResponse(error: string, status: number, details?: string) {
  return NextResponse.json(details ? { error, details } : { error }, {
    status,
  });
}

// The thread shows the returned message as it is, and its attachments live in
// private buckets, so it gets signed URLs. Handlers may return Mongoose
// documents, whose fields exist only through toJSON.
async function withSignedMessageMedia(message: unknown): Promise<unknown> {
  if (!message || typeof message !== "object") return message;
  const [signed] = await withCustomerMediaReadUrls([
    JSON.parse(JSON.stringify(message)) as object,
  ]);
  return signed;
}

function getFallbackManagerDisplayName(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): string {
  const metadataName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name.trim()
      : "";
  if (metadataName) return metadataName;

  const emailName =
    typeof user.email === "string" ? user.email.split("@")[0]?.trim() : "";
  return emailName || "Manager";
}

/** A public link, or this app's own WhatsApp media proxy path. */
function isAllowedAttachmentUrl(url: string): boolean {
  return (
    isHttpOrHttpsUrl(url) ||
    (url.startsWith("/") &&
      !url.startsWith("//") &&
      parseWhatsAppMediaProxyUrl(url) !== null)
  );
}

function normalizeAttachments(input: unknown): OutboundAttachment[] {
  if (!Array.isArray(input)) return [];
  const normalized: OutboundAttachment[] = [];

  for (const item of input) {
    if (!item || typeof item !== "object") continue;

    const url =
      "url" in item && typeof item.url === "string" ? item.url.trim() : "";
    const whatsappMediaId =
      "whatsappMediaId" in item && typeof item.whatsappMediaId === "string"
        ? item.whatsappMediaId.trim()
        : "";
    const mediaType =
      "mediaType" in item && typeof item.mediaType === "string"
        ? item.mediaType
        : "";
    const mimeType =
      "mimeType" in item && typeof item.mimeType === "string"
        ? item.mimeType
        : undefined;
    const fileName =
      "fileName" in item && typeof item.fileName === "string"
        ? item.fileName
        : undefined;
    const fileSize =
      "fileSize" in item && typeof item.fileSize === "number"
        ? item.fileSize
        : undefined;

    const hasAllowedUrl = Boolean(url && isAllowedAttachmentUrl(url));
    if (!hasAllowedUrl && !whatsappMediaId) continue;
    if (
      ![
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "voice",
        "file",
      ].includes(mediaType)
    ) {
      continue;
    }

    normalized.push({
      mediaType: mediaType as OutboundAttachment["mediaType"],
      ...(hasAllowedUrl ? { url } : {}),
      ...(whatsappMediaId ? { whatsappMediaId } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(fileName ? { fileName } : {}),
      ...(typeof fileSize === "number" ? { fileSize } : {}),
    });
  }

  return normalized;
}

function validateReplyPayload(
  text: string,
  attachments: OutboundAttachment[],
  isAppliedSuggestion?: boolean
) {
  const hasText = text.trim().length > 0;
  const hasAttachments = attachments.length > 0;

  if (!hasText && !hasAttachments) {
    return {
      valid: false,
      error: "Message text or at least one attachment is required",
    };
  }

  if (hasText && !isAppliedSuggestion) {
    const profanityCheck = checkProfanity("", text);
    if (profanityCheck.toxic) {
      return {
        valid: false,
        error: "Message contains inappropriate content and cannot be sent",
        details:
          "Please revise your message to remove any inappropriate language",
      };
    }
  }

  return { valid: true };
}

async function getConversation(
  conversationId: string
): Promise<ConversationDocument | null> {
  await connectDB();
  // Only email reads the message list (its last id threads the reply).
  return (await Conversation.findById(conversationId)
    .select({ messages: { $slice: -1 } })
    .populate({
      path: "chat",
      model: Chat,
      select: "_id type title first_name last_name username",
    })
    .populate({
      path: "user",
      model: User,
      select: "_id whatsapp",
    })) as ConversationDocument | null;
}

const CHANNEL_HANDLERS: Record<string, ManagerReplyHandler> = {
  telegram: handleTelegramReply,
  whatsapp: handleWhatsAppReply,
  instagram: handleInstagramReply,
  web_widget: handleWebWidget,
  email: handleEmailReply,
};

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const requestLogger = createRequestLogger(
    "api.conversations.reply",
    request,
    {
      route: "/api/conversations/[id]/reply",
    }
  );
  requestLogger.start("Conversation reply request received");

  const routeStartedAt = Date.now();
  const timings: Record<string, number> = {};
  let conversationId: string | undefined;
  let workspaceId: string | undefined;
  let channel: string | undefined;

  try {
    let stageStartedAt = Date.now();
    const auth = await getSupabaseRouteAuth(request);
    timings.authMs = Date.now() - stageStartedAt;
    if (isSupabaseRouteAuthError(auth)) {
      requestLogger.info(
        "Conversation reply rejected for unauthenticated user"
      );
      return errorResponse("Unauthorized", 401);
    }
    const supabase = auth.supabase;
    const managerUser = auth.user;

    stageStartedAt = Date.now();
    const { id } = await params;
    conversationId = id;
    const payload = (await request.json()) as {
      text?: string;
      attachments?: unknown;
      isAppliedSuggestion?: boolean;
      replyToMessageId?: string;
      instagramReplyMode?: string;
    };
    const text = (payload.text || "").trim();
    let attachments = normalizeAttachments(payload.attachments);
    const { isAppliedSuggestion, replyToMessageId } = payload;
    const instagramReplyMode =
      payload.instagramReplyMode === "private" ? "private" : "comment";
    timings.parsePayloadMs = Date.now() - stageStartedAt;

    const validation = validateReplyPayload(
      text,
      attachments,
      isAppliedSuggestion
    );
    if (!validation.valid) {
      requestLogger.info("Conversation reply payload failed validation", {
        conversationId,
        attachmentCount: attachments.length,
        hasText: text.length > 0,
        isAppliedSuggestion: Boolean(isAppliedSuggestion),
      });
      return errorResponse(validation.error!, 400, validation.details);
    }

    stageStartedAt = Date.now();
    const conversation = await getConversation(conversationId);
    timings.conversationLoadMs = Date.now() - stageStartedAt;
    if (!conversation) {
      requestLogger.info("Conversation reply target not found", {
        conversationId,
      });
      return errorResponse("Conversation not found", 404);
    }

    workspaceId = conversation.workspaceId;
    channel = conversation.channel;

    stageStartedAt = Date.now();
    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      managerUser.id,
      workspaceId
    );
    timings.accessAndMembershipMs = Date.now() - stageStartedAt;
    if (!hasAccess) {
      requestLogger.info(
        "Conversation reply denied by workspace access check",
        {
          conversationId,
          workspaceId,
          channel,
          managerUserId: managerUser.id,
        }
      );
      return errorResponse("Access denied to this conversation", 403);
    }

    stageStartedAt = Date.now();
    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    );
    timings.planGateMs = Date.now() - stageStartedAt;
    if (planGateResponse) {
      requestLogger.info("Conversation reply denied by plan gate", {
        conversationId,
        workspaceId,
        channel,
      });
      return planGateResponse;
    }

    // The display name is looked up alongside the send; handlers fall back
    // to the auth profile name until it resolves (email needs no author).
    const managerFallbackName = getFallbackManagerDisplayName(managerUser);
    const manager = {
      id: managerUser.id,
      name: managerFallbackName,
      namePromise:
        conversation.channel === "email"
          ? Promise.resolve(managerFallbackName)
          : getWorkspaceMemberDisplayName(
              supabase,
              managerUser.id,
              workspaceId
            ).catch(() => managerFallbackName),
    };

    const handler = CHANNEL_HANDLERS[conversation.channel];
    if (!handler) {
      requestLogger.info(
        "Conversation reply rejected for unsupported channel",
        {
          conversationId,
          workspaceId,
          channel,
        }
      );
      return errorResponse(`Unsupported channel: ${conversation.channel}`, 400);
    }

    stageStartedAt = Date.now();
    const normalizedAttachmentResult = normalizeConversationOutboundAttachments(
      {
        channel: conversation.channel,
        attachments,
        isInstagramCommentThread:
          conversation.channel === "instagram" &&
          conversation.external_thread?.type === "comment",
      }
    );
    if (!normalizedAttachmentResult.ok) {
      requestLogger.info(
        "Conversation reply rejected because attachments are unsupported for channel or media type",
        {
          conversationId,
          workspaceId,
          channel,
          attachmentCount: attachments.length,
        }
      );
      return errorResponse(normalizedAttachmentResult.error, 400);
    }
    attachments = normalizedAttachmentResult.attachments;
    timings.attachmentNormalizeMs = Date.now() - stageStartedAt;

    stageStartedAt = Date.now();
    const result: PopulatedMessage | EmailSendResponse = await handler({
      conversation,
      text,
      workspaceId,
      manager,
      attachments,
      replyToMessageId,
      instagramReplyMode,
    });
    timings.handlerMs = Date.now() - stageStartedAt;

    void invalidateConversationCache(
      workspaceId,
      String(conversation._id)
    ).catch(() => {});

    requestLogger.success("Conversation reply completed", {
      conversationId,
      workspaceId,
      channel,
      attachmentCount: attachments.length,
      hasReplyToMessageId: Boolean(replyToMessageId),
      isAppliedSuggestion: Boolean(isAppliedSuggestion),
      responseKind: (result as PopulatedMessage)?._id ? "message" : "result",
      totalMs: Date.now() - routeStartedAt,
      timings,
    });

    if ((result as PopulatedMessage)?._id) {
      return NextResponse.json({
        success: true,
        message: await withSignedMessageMedia(result),
      });
    }
    return NextResponse.json({ success: true, result });
  } catch (error) {
    requestLogger.error("Conversation reply failed", error, {
      conversationId,
      workspaceId,
      channel,
      ...(isInstagramSendError(error) ? { errorCode: error.code } : {}),
    });
    if (isInstagramSendError(error)) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          // The delivered part is saved; return it so the thread shows it.
          ...(error instanceof InstagramPartialSendError
            ? {
                partial: true,
                message: await withSignedMessageMedia(error.persistedMessage),
              }
            : {}),
        },
        { status: error.httpStatus }
      );
    }
    return errorMessageResponse(error, 500);
  }
}
