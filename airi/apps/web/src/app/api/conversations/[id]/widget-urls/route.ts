import { widgetLogger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { NextRequest } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;

type LatestMessagePreview = {
  _id: unknown;
  text?: string | null;
  mediaType?: string | null;
  fileName?: string | null;
};

function buildLastMessagePreview(message: LatestMessagePreview | undefined) {
  if (!message) return null;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (text) {
    return text.length > 140 ? `${text.slice(0, 139)}...` : text;
  }

  const fileName =
    typeof message.fileName === "string" ? message.fileName.trim() : "";
  if (fileName) return fileName;

  const mediaType =
    typeof message.mediaType === "string" ? message.mediaType.trim() : "";
  return mediaType ? `${mediaType} message` : null;
}

/**
 * GET /api/conversations/[id]/widget-urls
 *
 * Fetch all conversations for the same visitor across different URLs
 * Used by dashboard to show visitor-level view with URL tabs
 */
export async function GET(_req: NextRequest, { params }: { params: Params }) {
  const { id: conversationId } = await params;

  try {
    // Auth check
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Connect to MongoDB
    await connectDB();

    // Get the original conversation to extract visitor_id and workspaceId
    const originalConversation = (await Conversation.findById(conversationId)
      .select("visitor_id workspaceId channel")
      .lean()) as {
      _id: unknown;
      visitor_id?: string;
      workspaceId: string;
      channel: string;
    } | null;

    if (!originalConversation) {
      return Response.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    // Only works for web_widget conversations
    if (originalConversation.channel !== "web_widget") {
      return Response.json(
        { error: "This endpoint only works for web_widget conversations" },
        { status: 400 }
      );
    }

    if (!originalConversation.visitor_id) {
      return Response.json(
        { error: "Conversation does not have a visitor_id" },
        { status: 400 }
      );
    }

    // Check user has access to this workspace
    const companyUser = await checkUserWorkspaceAccess(
      supabase,
      user.id,
      originalConversation.workspaceId
    );

    if (!companyUser) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    // Find all conversations for this visitor across different URLs
    const conversations = (await Conversation.find({
      visitor_id: originalConversation.visitor_id,
      workspaceId: originalConversation.workspaceId,
      channel: "web_widget",
    })
      .select("_id page_url lastMessageAt message_count status createdAt")
      .sort({ createdAt: -1 })
      .lean()) as unknown as Array<{
      _id: unknown;
      page_url?: string;
      lastMessageAt?: Date;
      message_count?: number;
      status: string;
      createdAt: Date;
    }>;

    const conversationIds = conversations.map(conv => conv._id);
    const latestMessages = conversationIds.length
      ? ((await Message.aggregate([
          { $match: { conversation: { $in: conversationIds } } },
          { $sort: { date: -1, _id: -1 } },
          {
            $group: {
              _id: "$conversation",
              text: { $first: "$text" },
              mediaType: { $first: "$mediaType" },
              fileName: { $first: "$fileName" },
            },
          },
        ])) as LatestMessagePreview[])
      : [];
    const latestMessageMap = new Map(
      latestMessages.map(message => [String(message._id), message])
    );

    const conversationSummaries = conversations.map(conv => ({
      id: String(conv._id),
      pageUrl: conv.page_url || "unknown",
      lastMessageAt:
        conv.lastMessageAt?.toISOString() || conv.createdAt.toISOString(),
      messageCount: conv.message_count ?? 0,
      status: conv.status,
      createdAt: conv.createdAt.toISOString(),
      lastMessagePreview: buildLastMessagePreview(
        latestMessageMap.get(String(conv._id))
      ),
    }));

    return Response.json({
      success: true,
      visitorId: originalConversation.visitor_id,
      conversations: conversationSummaries,
    });
  } catch (error) {
    widgetLogger.error("widget_urls_fetch", error, {
      conversationId,
    });
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
