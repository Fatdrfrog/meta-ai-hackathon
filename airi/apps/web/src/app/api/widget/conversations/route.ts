import { appendMessageToConversationById } from "@/lib/conversation-messages";
import { trackWidgetEvent } from "@/lib/analytics";
import { widgetLogger } from "@/lib/logger";
import {
  getWorkspaceCoachDefault,
  getWorkspaceScenariosDefault,
} from "@/lib/airi/workspace-bot-default";
import {
  buildCompanyLimitExceededBody,
  ensureCompanyConversationCapacity,
} from "@/lib/limits/company-limits";
import { enqueueConversationMediaAnalysis } from "@/lib/media/conversation-media-analysis-jobs";
import { withCustomerMediaReadUrls } from "@/lib/media/customer-media-read-url";
import { isMediaPlaceholderText } from "@/lib/media/message-media-utils";
import { buildDeterministicMongoObjectId } from "@/lib/mongo-deterministic-id";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import connectDB from "@/lib/mongoose";
import { triggerRealtimeEvent } from "@/lib/realtime/server";
import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { buildRawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import {
  CanonicalJsonSerializationError,
  serializeCanonicalJson,
} from "@icecore/shared/lib/canonical-json";
import { persistOrRecoverAndLink } from "@icecore/shared/lib/persist-recover-link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { acceptAiriConversationIngress } from "@/lib/temporal/airi-direct-ingress";
import {
  buildAiriConversationIngressIntent,
  type AiriTurnContextInput,
} from "@/lib/temporal/airi-turn-context";
import {
  generateTagsFromUrl,
  inferPriorityFromUrl,
  suggestCategoryFromUrl,
} from "@/lib/widget/auto-tagger";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import { normalizeUrl } from "@/lib/widget/url-normalizer";
import { generateVisitorToken } from "@/lib/widget/visitor-auth";
import { isWidgetConversationOwnedByVisitor } from "@/lib/widget/visitor-conversation-access";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import User from "@/models/user";
import type { ConversationDocument } from "@/types/models";
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@icecore/shared/types/message";
import crypto from "crypto";
import mongoose from "mongoose";
import { NextRequest } from "next/server";

// Widget rate limiter
const messageLimiter = createRateLimiter(rateLimitPresets.widgetMessages);
const MAX_WIDGET_RAG_CONTEXT_CHARS = 2000;
const CLIENT_MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

class WidgetMessageConflictError extends Error {
  constructor() {
    super("clientMessageId was already used for another message");
  }
}
const ALLOWED_MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "voice",
  "file",
]);

function normalizeMediaType(
  value: unknown,
  mimeType: unknown,
  mediaUrl: unknown
):
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "voice"
  | "file"
  | null {
  if (typeof value === "string" && ALLOWED_MEDIA_TYPES.has(value)) {
    return value as
      | "image"
      | "video"
      | "audio"
      | "document"
      | "sticker"
      | "voice"
      | "file";
  }

  const normalizedMime =
    typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  if (normalizedMime.startsWith("image/")) return "image";
  if (normalizedMime.startsWith("video/")) return "video";
  if (normalizedMime.startsWith("audio/")) return "audio";

  const normalizedUrl =
    typeof mediaUrl === "string" ? mediaUrl.trim().toLowerCase() : "";
  if (/\.(png|jpe?g|gif|webp)(\?|$)/.test(normalizedUrl)) return "image";
  if (/\.(mp3|m4a|wav|ogg|weba|webm)(\?|$)/.test(normalizedUrl)) return "audio";
  if (/\.(mp4|mov|mkv)(\?|$)/.test(normalizedUrl)) return "video";

  return null;
}

function resolveMediaPlaceholderText(
  mediaType:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "voice"
    | "file"
    | null
): string {
  switch (mediaType) {
    case "audio":
    case "voice":
      return "[Voice message]";
    case "image":
      return "[Image attachment]";
    case "video":
      return "[Video attachment]";
    case "document":
      return "[Document attachment]";
    case "sticker":
      return "[Sticker attachment]";
    case "file":
      return "[File attachment]";
    default:
      return "";
  }
}

function normalizeWidgetRagContext(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return undefined;
  return normalized.slice(0, MAX_WIDGET_RAG_CONTEXT_CHARS);
}

/**
 * OPTIONS /api/widget/conversations
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * POST /api/widget/conversations
 *
 * Creates a new conversation or sends a message to existing conversation
 * This is the main endpoint for widget message sending
 */
export async function POST(req: NextRequest) {
  let requestBody: SendMessageRequest | null = null;

  try {
    const body: SendMessageRequest = await req.json();
    requestBody = body; // Store for error logging
    const {
      conversationId,
      text,
      clientKey,
      clientMessageId,
      imageUrl,
      mediaUrl,
      mediaType,
      mimeType,
      fileName,
      fileSize,
      metadata,
    } = body;
    if (
      clientMessageId !== undefined &&
      (typeof clientMessageId !== "string" ||
        !CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId) ||
        typeof metadata?.customerId !== "string" ||
        !metadata.customerId.trim())
    ) {
      return jsonWithCors<SendMessageResponse>(
        {
          success: false,
          error:
            "clientMessageId must be 1-128 letters, numbers, underscores or hyphens and requires metadata.customerId",
        },
        { status: 400 }
      );
    }
    const resolvedMediaUrl = mediaUrl || imageUrl;
    const resolvedMediaType = normalizeMediaType(
      mediaType,
      mimeType,
      resolvedMediaUrl
    );
    const resolvedText =
      typeof text === "string" && text.trim().length > 0
        ? text.trim()
        : resolveMediaPlaceholderText(resolvedMediaType);

    if (!clientKey || (!resolvedText && !resolvedMediaUrl)) {
      return jsonWithCors<SendMessageResponse>(
        {
          success: false,
          error:
            "Missing required fields: clientKey and (text or imageUrl or mediaUrl)",
        },
        { status: 400 }
      );
    }

    const sourceAuth = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey,
    });
    if (!sourceAuth.ok) {
      return jsonWithCors<SendMessageResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status }
      );
    }

    const { source, credentials } = sourceAuth;

    // Generate or use existing visitor ID
    const visitorId = metadata?.customerId || crypto.randomUUID();

    // Extract page URL from metadata or referer header
    const rawPageUrl =
      metadata?.pageUrl || req.headers.get("referer") || "unknown";
    // Normalize URL to group similar pages (e.g., /product/123 → /product/*)
    const pageUrl = normalizeUrl(rawPageUrl);
    const ragContext = normalizeWidgetRagContext(metadata?.ragContext);

    // Rate limiting
    const identifier = `${source.workspace_id}:${source.id}:${visitorId}`;
    const rateLimitResult = await checkRateLimit(
      messageLimiter,
      identifier,
      10
    );
    if (!rateLimitResult.success) {
      widgetLogger.rateLimitExceeded("/api/widget/conversations", visitorId);
      return jsonWithCors<SendMessageResponse>(
        {
          success: false,
          error:
            "Too many messages. Please wait a moment before sending again.",
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": rateLimitResult.limit.toString(),
            "X-RateLimit-Remaining": rateLimitResult.remaining.toString(),
            "X-RateLimit-Reset": new Date(rateLimitResult.reset).toISOString(),
          },
        }
      );
    }

    // Connect to MongoDB
    await connectDB();

    const requestIdentity = clientMessageId
      ? JSON.stringify([
          source.workspace_id,
          source.id,
          visitorId,
          clientMessageId,
        ])
      : null;
    const messageObjectId = requestIdentity
      ? buildDeterministicMongoObjectId(
          "widget-inbound-message",
          requestIdentity
        )
      : new mongoose.Types.ObjectId();
    const findExistingMessage = () =>
      requestIdentity
        ? Message.findById(messageObjectId).select(
            "+airiIngressIntent +widgetRequestHash"
          )
        : Promise.resolve(null);
    const existingMessage = await findExistingMessage();
    const rawSourcePayload = buildRawSourcePayload({
      provider: "web_widget",
      eventType: "message",
      payload: body,
    });
    // Persist the comparison before Mongo can minimize empty metadata objects.
    const widgetRequestHash = requestIdentity
      ? crypto
          .createHash("sha256")
          .update(serializeCanonicalJson(rawSourcePayload.payload))
          .digest("hex")
      : undefined;
    const validateExistingMessage = (message: typeof existingMessage) => {
      if (
        message.workspaceId !== source.workspace_id ||
        message.channel !== "web_widget" ||
        message.direction !== "inbound" ||
        String(message.author) !== visitorId ||
        message.widgetRequestHash !== widgetRequestHash
      ) {
        throw new WidgetMessageConflictError();
      }
    };
    if (existingMessage) validateExistingMessage(existingMessage);

    // Create or find visitor user in MongoDB
    // Use provided user metadata if available (for authenticated users)
    const userEmail = metadata?.userEmail;
    const userName = metadata?.userName;

    // Users also holds WhatsApp and Telegram customers keyed by their channel
    // ids. Only widget visitor records take widget profile updates; another
    // customer's record with the same id stays untouched.
    try {
      await User.findOneAndUpdate(
        {
          _id: visitorId,
          whatsapp: { $exists: false },
          workspaceId: { $in: [source.workspace_id, null] },
        },
        {
          _id: visitorId,
          isBot: false,
          firstName: userName || "Visitor",
          username: userEmail || `visitor_${visitorId.slice(0, 8)}`,
          // Store email if provided (shows in dashboard)
          ...(userEmail && { email: userEmail }),
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      if (!isMongoDuplicateKeyError(error)) throw error;
    }

    console.log("[Widget] User identity:", {
      visitorId,
      authenticated: !!userEmail,
    });

    // Find or create conversation
    let conversation: ConversationDocument;
    let isNewConversation = false;
    // Unassigned legacy conversations can acquire this source on append.
    const conversationSourceFilter = {
      $or: [{ sourceId: source.id }, { sourceId: null }],
    };
    if (existingMessage || conversationId) {
      const foundConversation = await Conversation.findById(
        existingMessage?.conversation || conversationId
      );
      if (
        !foundConversation ||
        !isWidgetConversationOwnedByVisitor(foundConversation, {
          workspaceId: source.workspace_id,
          sourceId: source.id,
          visitorIds: [visitorId],
        })
      ) {
        return jsonWithCors<SendMessageResponse>(
          { success: false, error: "Conversation not found" },
          { status: 404 }
        );
      }
      conversation = foundConversation;
    } else {
      // Find existing conversation for this visitor + URL combination
      conversation = await Conversation.findOne({
        ...conversationSourceFilter,
        visitor_id: visitorId,
        page_url: pageUrl,
        workspaceId: source.workspace_id,
        channel: "web_widget",
        status: { $ne: "closed" },
      }).sort({ lastMessageAt: -1 });

      if (!conversation) {
        // Try to find old conversation by user field (migration path)
        const oldConversation = await Conversation.findOne({
          ...conversationSourceFilter,
          user: visitorId,
          workspaceId: source.workspace_id,
          channel: "web_widget",
          visitor_id: { $exists: false }, // Old conversations don't have this field
          status: { $ne: "closed" },
        }).sort({ lastMessageAt: -1 });

        if (oldConversation) {
          // Migrate old conversation by adding visitor_id and page_url
          oldConversation.visitor_id = visitorId;
          oldConversation.page_url = pageUrl;
          await oldConversation.save();
          conversation = oldConversation;

          console.log("[Widget] Migrated old conversation:", {
            conversationId: conversation._id.toString(),
            visitorId,
            pageUrl,
            messageCount: conversation.messages.length,
          });
        }
      }

      // Check for closed conversations to reopen
      if (!conversation) {
        // Try to find closed conversation by visitor_id and page_url
        let closedConversation = await Conversation.findOne({
          ...conversationSourceFilter,
          visitor_id: visitorId,
          page_url: pageUrl,
          workspaceId: source.workspace_id,
          channel: "web_widget",
          status: "closed",
        }).sort({ updatedAt: -1 });

        // If not found, try old conversation format
        if (!closedConversation) {
          closedConversation = await Conversation.findOne({
            ...conversationSourceFilter,
            user: visitorId,
            workspaceId: source.workspace_id,
            channel: "web_widget",
            visitor_id: { $exists: false },
            status: "closed",
          }).sort({ updatedAt: -1 });
        }

        if (closedConversation) {
          // Reopen the closed conversation
          closedConversation.status = "open";
          if (!closedConversation.visitor_id) {
            closedConversation.visitor_id = visitorId;
            closedConversation.page_url = pageUrl;
          }
          await closedConversation.save();
          conversation = closedConversation;

          console.log("[Widget] Reopened closed conversation:", {
            conversationId: conversation._id.toString(),
            visitorId,
            pageUrl,
          });

          // Trigger webhook for reopening
          const { triggerConversationReopened } = await import(
            "@/lib/webhook-events"
          );
          triggerConversationReopened(
            source.workspace_id,
            buildConversationEventData(conversation, {
              status: "open",
              previous_status: "closed",
              channel: "web_widget",
            })
          ).catch(err => console.error("Webhook trigger error:", err));
        }
      }

      if (!conversation) {
        const capacity = await ensureCompanyConversationCapacity(
          supabaseAdmin,
          source.workspace_id
        );
        if (!capacity.allowed) {
          const lockBody = buildCompanyLimitExceededBody(capacity.limit);
          return jsonWithCors(
            {
              success: false,
              ...lockBody,
            },
            { status: 402 }
          );
        }

        // Create new conversation if none found
        // Auto-generate tags and suggested classification from URL
        // Uses taxonomy if configured, otherwise fallback rules
        const autoTags = await generateTagsFromUrl(
          rawPageUrl,
          source.workspace_id
        );
        const suggestedPriority = inferPriorityFromUrl(rawPageUrl);
        const suggestedCategory = suggestCategoryFromUrl(rawPageUrl);

        const [scenariosDefaultEnabled, coachDefaultEnabled] =
          await Promise.all([
            getWorkspaceScenariosDefault(source.workspace_id),
            getWorkspaceCoachDefault(source.workspace_id),
          ]);

        // Create new conversation
        const newConversationId = requestIdentity
          ? buildDeterministicMongoObjectId(
              "widget-inbound-conversation",
              requestIdentity
            )
          : new mongoose.Types.ObjectId();
        try {
          conversation = await Conversation.create({
            _id: newConversationId,
            user: visitorId,
            visitor_id: visitorId,
            sourceId: source.id,
            page_url: pageUrl,
            status: "open",
            channel: "web_widget",
            workspaceId: source.workspace_id,
            messages: [],
            is_classified: false,
            is_best_practice: false,
            is_qa_analyzed: false,
            airi_bot_enabled: credentials.settings?.airi_enabled ?? true,
            airi_scenarios_enabled: scenariosDefaultEnabled,
            airi_coach_enabled: coachDefaultEnabled,
            // Auto-tagging based on URL
            classification:
              suggestedCategory || suggestedPriority
                ? {
                    category: suggestedCategory || undefined,
                    priority: suggestedPriority || undefined,
                    tags: autoTags,
                    confidence: {
                      category: suggestedCategory ? 0.6 : undefined,
                      priority: suggestedPriority ? 0.7 : undefined,
                    },
                  }
                : { tags: autoTags },
          });
          isNewConversation = true;
        } catch (error) {
          if (!requestIdentity || !isMongoDuplicateKeyError(error)) throw error;
          const winningConversation =
            await Conversation.findById(newConversationId);
          if (
            !winningConversation ||
            winningConversation.workspaceId !== source.workspace_id ||
            winningConversation.sourceId !== source.id ||
            winningConversation.visitor_id !== visitorId
          )
            throw error;
          conversation = winningConversation;
        }

        console.log("[Widget] Created new conversation:", {
          conversationId: conversation._id.toString(),
          visitorId,
          pageUrl,
          workspaceId: source.workspace_id,
        });
      } else {
        console.log("[Widget] Reusing existing conversation:", {
          conversationId: conversation._id.toString(),
          visitorId,
          pageUrl,
          messageCount: conversation.messages.length,
        });
      }
    }

    if (conversation.sourceId && conversation.sourceId !== source.id) {
      return jsonWithCors<SendMessageResponse>(
        { success: false, error: "Conversation not found" },
        { status: 404 }
      );
    }

    // Create message
    const messageDate = new Date();
    const messageValues = {
      _id: messageObjectId,
      workspaceId: source.workspace_id,
      conversation: conversation._id,
      channel: "web_widget",
      direction: "inbound",
      rawSourcePayload: { ...rawSourcePayload, capturedAt: messageDate },
      widgetRequestHash,
      text: resolvedText, // Empty string only when no text/media fallback applies
      ragContext,
      imageUrl: resolvedMediaUrl || undefined,
      mediaType: resolvedMediaType || undefined,
      mimeType: typeof mimeType === "string" ? mimeType : undefined,
      fileName: typeof fileName === "string" ? fileName : undefined,
      fileSize: typeof fileSize === "number" ? fileSize : undefined,
      date: messageDate,
      author: visitorId,
    };
    const buildIngressPayload = (
      inbound: AiriTurnContextInput["newMessage"]
    ): AiriTurnContextInput => ({
      type: "web_widget",
      newMessage: inbound,
      conversation,
      workspaceId: source.workspace_id,
      chatDocument: {
        sourceId: source.id,
        workspaceId: source.workspace_id,
        _id: String(conversation._id),
      } as AiriTurnContextInput["chatDocument"],
    });

    const { record: message, created: messageCreated } =
      await persistOrRecoverAndLink({
        findExisting: () =>
          existingMessage
            ? Promise.resolve(existingMessage)
            : findExistingMessage(),
        persist: () =>
          Message.create({
            ...messageValues,
            airiIngressIntent: buildAiriConversationIngressIntent(
              buildIngressPayload(messageValues)
            ),
          }),
        isDuplicateError: error =>
          Boolean(requestIdentity) && isMongoDuplicateKeyError(error),
        link: async savedMessage => {
          if (requestIdentity) validateExistingMessage(savedMessage);
          if (String(savedMessage.conversation) !== String(conversation._id)) {
            const savedConversation = await Conversation.findById(
              savedMessage.conversation
            );
            if (!savedConversation) throw new WidgetMessageConflictError();
            conversation = savedConversation;
          }
          const intent = savedMessage.airiIngressIntent as
            | { sourceId?: string | null }
            | undefined;
          const messageSourceId = intent?.sourceId || conversation?.sourceId;
          if (
            !conversation ||
            conversation.workspaceId !== source.workspace_id ||
            (requestIdentity && messageSourceId !== source.id)
          )
            throw new WidgetMessageConflictError();
          await appendMessageToConversationById(
            conversation._id,
            savedMessage._id,
            {
              lastMessageAt: savedMessage.date,
              direction: "inbound",
              set: { sourceId: source.id },
            }
          );
        },
      });

    const mediaAnalysisStart = await enqueueConversationMediaAnalysis({
      workspaceId: source.workspace_id,
      conversationId: String(conversation._id),
      messageId: String(message._id),
      mediaType: message.mediaType,
      sourceId: source.id,
    }).catch(error => ({
      queued: false as const,
      reason: "publish_failed" as const,
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
    if (
      !mediaAnalysisStart.queued &&
      !["unsupported_media", "already_active", "already_complete"].includes(
        mediaAnalysisStart.reason
      )
    ) {
      console.warn("[Widget] Media analysis enqueue failed", {
        workspaceId: source.workspace_id,
        conversationId: String(conversation._id),
        messageId: String(message._id),
        mediaType: message.mediaType,
        reason: mediaAnalysisStart.reason,
        error: mediaAnalysisStart.errorMessage,
      });
    }

    // The saved intent remains recoverable if context persistence fails here.
    await acceptAiriConversationIngress(message, buildIngressPayload(message));

    // Trigger real-time update for requests list (fire and forget)
    const { triggerConversationRealtime } = await import(
      "@/lib/realtime-updates"
    );
    triggerConversationRealtime(
      String(conversation._id),
      isNewConversation
    ).catch(error => {
      // Log but don't throw - realtime failures shouldn't block message delivery
      console.error(
        "[Widget] Real-time update trigger failed (non-critical):",
        error
      );
    });

    // Detect and update conversation language (required for Airi)
    if (
      messageCreated &&
      resolvedText &&
      !isMediaPlaceholderText(resolvedText)
    ) {
      import("@/lib/airi/coach/coach-utils-server").then(
        ({ detectAndUpdateConversationLanguage }) => {
          detectAndUpdateConversationLanguage(
            conversation._id.toString(),
            resolvedText
          ).catch(error => {
            console.error("[Widget] Language detection failed:", error);
          });
        }
      );
    }

    // Generate visitor token for future requests
    const visitorToken = await generateVisitorToken({
      visitorId,
      workspaceId: source.workspace_id,
      sourceId: source.id,
      scope: "widget",
    });

    // Log successful message send (with page_url for PostHog analytics)
    if (messageCreated) {
      widgetLogger.messageSent(
        source.workspace_id,
        source.company_id,
        source.id,
        conversation._id.toString(),
        visitorId,
        pageUrl // Track normalized page URL in PostHog
      );
      trackWidgetEvent(
        "widget_message_send",
        {
          visitor_id: visitorId,
          page_url: pageUrl,
          source_id: source.id,
          conversation_id: conversation._id.toString(),
          conversation_started: isNewConversation,
          has_media: Boolean(resolvedMediaUrl),
          ...(resolvedMediaType ? { media_type: resolvedMediaType } : {}),
        },
        visitorId,
        source.company_id,
        source.workspace_id
      );
    }

    const [sentMessage] = await withCustomerMediaReadUrls([
      { imageUrl: message.imageUrl || undefined },
    ]);
    const response: SendMessageResponse = {
      success: true,
      message: {
        id: message._id.toString(),
        conversationId: conversation._id.toString(),
        text: message.text!,
        direction: "inbound",
        timestamp: message.date.toISOString(),
        authorName: "You",
        imageUrl: sentMessage.imageUrl,
        mediaUrl: sentMessage.imageUrl,
        mediaType: message.mediaType || undefined,
        mimeType: message.mimeType || undefined,
        fileName: message.fileName || undefined,
        fileSize: message.fileSize || undefined,
        audioAnalysis: message.audioAnalysis || undefined,
      },
      conversationId: conversation._id.toString(),
    };

    // Trigger realtime event for real-time updates (fire and forget - don't block response)
    if (messageCreated)
      triggerRealtimeEvent(
        `conversation-${conversation._id.toString()}`,
        "message.new",
        {
          id: message._id.toString(),
          conversationId: conversation._id.toString(),
          workspaceId: source.workspace_id,
          text: message.text!,
          direction: "inbound",
          timestamp: message.date.toISOString(),
          authorName: "You",
          imageUrl: message.imageUrl || undefined,
          mediaUrl: message.imageUrl || undefined,
          mediaType: message.mediaType || undefined,
          mimeType: message.mimeType || undefined,
          fileName: message.fileName || undefined,
          fileSize: message.fileSize || undefined,
          audioAnalysis: message.audioAnalysis || undefined,
        }
      ).catch(error => {
        // Log but don't throw - Realtime failures shouldn't block message delivery
        console.error(
          "[Widget] Realtime trigger failed (non-critical):",
          error
        );
      });

    // Return response with visitor token and CORS headers
    return jsonWithCors<SendMessageResponse>(response, {
      headers: {
        "X-Visitor-Token": visitorToken,
      },
    });
  } catch (error) {
    if (error instanceof CanonicalJsonSerializationError) {
      return jsonWithCors<SendMessageResponse>(
        { success: false, error: "Message metadata exceeds supported limits" },
        { status: 400 }
      );
    }
    if (error instanceof WidgetMessageConflictError) {
      return jsonWithCors<SendMessageResponse>(
        { success: false, error: error.message },
        { status: 409 }
      );
    }
    widgetLogger.error("send_message", error, {
      clientKey: requestBody?.clientKey?.slice(0, 16) + "...",
      conversationId: requestBody?.conversationId,
    });
    return jsonWithCors<SendMessageResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
