import { widgetLogger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import { Conversation } from "@/models/conversation";
import "@/models/message";
import { WidgetConversationSummary } from "@icecore/shared/types/widget-config";
import { NextRequest } from "next/server";

/**
 * OPTIONS /api/widget/conversations/history
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

interface HistoryResponse {
  success: boolean;
  conversations?: WidgetConversationSummary[];
  error?: string;
}

/**
 * GET /api/widget/conversations/history
 *
 * Fetch all conversations for a visitor across different URLs
 * Query params:
 *   - client_key: Widget client key
 *   - visitor_id: Visitor UUID
 */
export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const clientKey = searchParams.get("client_key");
    const visitorId = searchParams.get("visitor_id");

    if (!clientKey || !visitorId) {
      return jsonWithCors<HistoryResponse>(
        {
          success: false,
          error: "Missing required parameters: client_key and visitor_id",
        },
        { status: 400 }
      );
    }

    const sourceAuth = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey,
    });
    if (!sourceAuth.ok) {
      return jsonWithCors<HistoryResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status }
      );
    }

    const { source } = sourceAuth;

    // Connect to MongoDB
    await connectDB();

    // Find all conversations for this visitor across all URLs
    const conversations = (await Conversation.find({
      visitor_id: visitorId,
      workspaceId: source.workspace_id,
      channel: "web_widget",
      status: { $ne: "closed" },
    })
      .select("_id page_url lastMessageAt messages")
      .sort({ lastMessageAt: -1 })
      .populate({
        path: "messages",
        options: { limit: 1, sort: { date: -1 } },
        select: "text direction",
      })
      .lean()) as unknown as Array<{
      _id: unknown;
      page_url?: string;
      lastMessageAt?: Date;
      messages?: Array<{ text?: string; direction?: string }>;
    }>;

    const conversationSummaries: WidgetConversationSummary[] =
      conversations.map(conv => {
        const lastMessage =
          conv.messages && conv.messages.length > 0
            ? conv.messages[conv.messages.length - 1]
            : null;
        const preview = lastMessage?.text
          ? lastMessage.text.length > 50
            ? lastMessage.text.slice(0, 50) + "..."
            : lastMessage.text
          : "No messages yet";

        return {
          id: String(conv._id),
          pageUrl: conv.page_url || "unknown",
          lastMessageAt:
            conv.lastMessageAt?.toISOString() || new Date().toISOString(),
          messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
          lastMessagePreview: preview,
        };
      });

    return jsonWithCors<HistoryResponse>({
      success: true,
      conversations: conversationSummaries,
    });
  } catch (error) {
    widgetLogger.error("conversation_history", error, {
      visitorId: new URL(req.url).searchParams.get("visitor_id") || undefined,
    });
    return jsonWithCors<HistoryResponse>(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
