import { errorMessageResponse } from "@/lib/api/json-body";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { triggerConversationReopened } from "@/lib/webhook-events";
import { Conversation } from "@/models/conversation";
import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { NextRequest, NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;

/**
 * POST - Re-open a closed conversation
 * Allows managers to re-open conversations that were previously closed
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user: managerUser },
    } = await supabase.auth.getUser();

    if (!managerUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: conversationId } = await params;

    await connectDB();
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    // Verify workspace access
    const access = await checkUserWorkspaceAccess(
      supabase,
      managerUser.id,
      conversation.workspaceId
    );

    if (!access) {
      return NextResponse.json(
        { error: "Access denied to this conversation" },
        { status: 403 }
      );
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      conversation.workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    // Check if conversation is actually closed
    if (conversation.status !== "closed") {
      return NextResponse.json(
        {
          error: "Conversation is not closed",
          currentStatus: conversation.status,
        },
        { status: 400 }
      );
    }

    // Re-open the conversation
    conversation.status = "in_progress";
    conversation.handled_by_agent_id = managerUser.id;
    await conversation.save();

    triggerConversationReopened(
      conversation.workspaceId,
      buildConversationEventData(conversation, {
        status: "in_progress",
        previous_status: "closed",
        channel: conversation.channel,
        customer_phone: conversation.user?.toString(),
      })
    ).catch(error =>
      logger.error("conversation.reopened_webhook_failed", error, {
        workspaceId: conversation.workspaceId,
        conversationId,
      })
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorMessageResponse(error, 500);
  }
}
