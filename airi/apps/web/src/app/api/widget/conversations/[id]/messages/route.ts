import { widgetLogger } from "@/lib/logger";
import { withCustomerMediaReadUrls } from "@/lib/media/customer-media-read-url";
import connectDB from "@/lib/mongoose";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import {
  isWidgetConversationOwnedByVisitor,
  resolveWidgetRequestVisitorIds,
  type WidgetConversationOwnershipFields,
} from "@/lib/widget/visitor-conversation-access";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import "@/models/user"; // Ensure User model is registered for Message.populate("author")
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";
import type { MessageDTO } from "@icecore/shared/types/message";
import { Types } from "mongoose";
import { NextRequest } from "next/server";

// Widget rate limiter
const historyLimiter = createRateLimiter(rateLimitPresets.widgetHistory);

interface GetMessagesResponse {
  success: boolean;
  messages?: MessageDTO[];
  error?: string;
}

type WidgetMessageLean = {
  _id: Types.ObjectId | string;
  author?: { firstName?: string | null } | Types.ObjectId | string | null;
  date?: Date | string | null;
  direction?: MessageDTO["direction"];
  fileName?: string | null;
  fileSize?: number | null;
  imageUrl?: string | null;
  mediaType?: string | null;
  mimeType?: string | null;
  text?: string | null;
  audioAnalysis?: string | null;
  actionType?: string | null;
};

/**
 * OPTIONS /api/widget/conversations/[id]/messages
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/widget/conversations/[id]/messages
 *
 * Retrieves message history for a conversation
 * Used by widget to load conversation history
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const clientKey = req.nextUrl.searchParams.get("client_key");

    if (!clientKey) {
      return jsonWithCors<GetMessagesResponse>(
        {
          success: false,
          error: "Missing client_key parameter",
        },
        { status: 400 }
      );
    }

    const sourceAuth = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey,
    });
    if (!sourceAuth.ok) {
      return jsonWithCors<GetMessagesResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status }
      );
    }

    const { source } = sourceAuth;
    const visitorScope = {
      workspaceId: source.workspace_id,
      sourceId: source.id,
    };
    const visitorIds = await resolveWidgetRequestVisitorIds(req, visitorScope);

    // Rate limit the caller, not the conversation being probed.
    const caller =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      visitorIds[0] ||
      "anonymous";
    const rateLimitResult = await checkRateLimit(
      historyLimiter,
      `${source.id}:${caller}`,
      20
    );
    if (!rateLimitResult.success) {
      return jsonWithCors<GetMessagesResponse>(
        {
          success: false,
          error: "Too many requests. Please try again later.",
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": rateLimitResult.limit.toString(),
            "X-RateLimit-Remaining": rateLimitResult.remaining.toString(),
          },
        }
      );
    }

    // Connect to MongoDB and fetch messages
    await connectDB();

    const conversation = await Conversation.findById(id)
      .select("workspaceId channel sourceId visitor_id user")
      .lean<WidgetConversationOwnershipFields>();
    // Foreign and missing conversations answer alike, so ids cannot be probed.
    if (
      !conversation ||
      !isWidgetConversationOwnedByVisitor(conversation, {
        ...visitorScope,
        visitorIds,
      })
    ) {
      return jsonWithCors<GetMessagesResponse>(
        {
          success: false,
          error: "Conversation not found",
        },
        { status: 404 }
      );
    }

    // Fetch messages with safe populate. If User model registration is missing
    // in a hot-reload/serverless edge case, fall back to plain messages.
    let messages: WidgetMessageLean[];
    try {
      messages = await Message.find({ conversation: id })
        .sort({ date: 1 })
        .populate({
          path: "author",
          select: "firstName",
          options: { strictPopulate: false }, // Don't throw if author doesn't exist
        })
        .lean<WidgetMessageLean[]>();
    } catch (populateError) {
      const message =
        populateError instanceof Error
          ? populateError.message
          : String(populateError);

      if (
        !message.includes('Schema hasn\'t been registered for model "User"')
      ) {
        throw populateError;
      }

      console.warn(
        "[Widget] User model unavailable during message populate; falling back to non-populated messages",
        { conversationId: id }
      );

      messages = await Message.find({ conversation: id })
        .sort({ date: 1 })
        .lean<WidgetMessageLean[]>();
    }

    const messagesDTO: MessageDTO[] = messages.map(msg => {
      // Handle potential null/undefined date
      const timestamp = msg.date
        ? new Date(msg.date).toISOString()
        : new Date().toISOString();

      // Safely get author name
      let authorName = "Agent";
      if (msg.direction === "inbound") {
        authorName = "You";
      } else if (msg.author) {
        // Handle both populated author object and author ID
        if (typeof msg.author === "object" && "firstName" in msg.author) {
          authorName = msg.author.firstName || "Agent";
        }
      }

      return {
        id: (msg._id as Types.ObjectId).toString(),
        conversationId: id,
        text: msg.text || "",
        direction: msg.direction || "inbound",
        timestamp,
        authorName,
        imageUrl: msg.imageUrl ?? undefined,
        mediaUrl: msg.imageUrl ?? undefined,
        mediaType: (msg.mediaType ?? null) as MessageDTO["mediaType"],
        mimeType: msg.mimeType,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        audioAnalysis: msg.audioAnalysis,
        actionType: msg.actionType === "csat_request" ? msg.actionType : null,
      };
    });

    return jsonWithCors<GetMessagesResponse>({
      success: true,
      messages: await withCustomerMediaReadUrls(messagesDTO),
    });
  } catch (error) {
    widgetLogger.error("get_messages", error, {
      conversationId: id,
      clientKey:
        req.nextUrl.searchParams.get("client_key")?.slice(0, 16) + "...",
    });
    return jsonWithCors<GetMessagesResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
