import { isConversationStatus } from "@icecore/shared/types/conversation";
import {
  CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT,
  getCurrentConversationClassification,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  INVALID_CONVERSATION_CHANNEL_QUERY,
  isConversationChannel,
} from "@icecore/shared/types/sources";
import { authenticateRequest } from "@/lib/api-auth";
import { parsePositiveInt } from "@/lib/api/query-params";
import {
  applyCustomerConversationVisibility,
  CUSTOMER_CONVERSATION_MAX_OFFSET,
} from "@/lib/customer-api/conversation-reads";
import { canReadCustomerConversations } from "@/lib/customer-api/read-access";
import connectDB from "@/lib/mongoose";
import { getCompanyConversationVisibilityGate } from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";
import { NextResponse } from "next/server";

/**
 * Public API v1 - Conversations
 * Requires read permission; explicit conversations:false denies access.
 * Legacy keys without a domain scope inherit their read permission.
 */

/**
 * GET - List conversations for workspace
 */
export async function GET(request: Request) {
  // Authenticate request
  const { apiKey, error } = await authenticateRequest(request);
  if (error) return error;

  // Check permission
  if (!canReadCustomerConversations(apiKey!)) {
    return new Response(
      JSON.stringify({
        error: "API key does not have permission to read conversations",
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const channel = searchParams.get("channel");
    const limit = parsePositiveInt(searchParams.get("limit"), 20, 1, 100);
    const page = parsePositiveInt(
      searchParams.get("page"),
      1,
      1,
      Math.floor(Number.MAX_SAFE_INTEGER / limit)
    );
    const skip = (page - 1) * limit;
    if (skip > CUSTOMER_CONVERSATION_MAX_OFFSET) {
      return NextResponse.json(
        {
          code: "INVALID_PAGINATION",
          error:
            "Pagination offset must not exceed 10000 conversations. Narrow the channel or status filters.",
        },
        { status: 400 }
      );
    }

    await connectDB();

    const visibility = await getCompanyConversationVisibilityGate(
      supabaseAdmin,
      apiKey!.workspace_id
    );
    const filter = applyCustomerConversationVisibility(
      { workspaceId: apiKey!.workspace_id },
      visibility
    );

    if (status) {
      if (!isConversationStatus(status)) {
        return NextResponse.json(
          { error: "Invalid status. Use open, in_progress, or closed." },
          { status: 400 }
        );
      }
      filter.status = status;
    }

    if (channel) {
      if (!isConversationChannel(channel)) {
        return NextResponse.json(
          { error: INVALID_CONVERSATION_CHANNEL_QUERY },
          { status: 400 }
        );
      }
      filter.channel = channel;
    }

    const [conversations, total] = await Promise.all([
      Conversation.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          `_id status channel createdAt updatedAt lastMessageAt classification user chat ${CONVERSATION_CLASSIFICATION_FRESHNESS_SELECT}`
        )
        .lean(),
      Conversation.countDocuments(filter),
    ]);

    return NextResponse.json({
      data: conversations.map(conversation => {
        const classification =
          getCurrentConversationClassification<Record<string, unknown>>(
            conversation
          );
        // Freshness fields are server evidence, not public lease/worker state.
        return {
          _id: conversation._id,
          status: conversation.status,
          channel: conversation.channel,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          lastMessageAt: conversation.lastMessageAt,
          classification: classification ?? null,
          classification_is_current: classification !== undefined,
          user: conversation.user,
          chat: conversation.chat,
        };
      }),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get conversations error:", error);
    return NextResponse.json(
      {
        code: "CONVERSATIONS_UNAVAILABLE",
        error: "Conversations are temporarily unavailable.",
      },
      { status: 503 }
    );
  }
}
