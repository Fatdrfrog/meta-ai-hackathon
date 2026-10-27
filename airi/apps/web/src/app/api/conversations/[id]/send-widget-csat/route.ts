import { errorMessageResponse } from "@/lib/api/json-body";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { sendWidgetCsatRequest } from "@/lib/widget-csat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ id: string }>;

// sendWidgetCsatRequest owns the eligibility checks; a manual send that it
// skips is a client error.
const SKIP_ERRORS: Record<string, string> = {
  not_web_widget: "This action is only available for web_widget conversations",
  already_rated: "CSAT score already submitted for this conversation",
  csat_already_sent: "CSAT request already sent for this conversation",
};

function skippedResponse(reason: string | undefined) {
  if (reason === "conversation_not_found") {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }
  return NextResponse.json(
    { error: SKIP_ERRORS[reason || ""] ?? "CSAT request was not sent" },
    { status: 400 }
  );
}

/**
 * POST /api/conversations/[id]/send-widget-csat
 *
 * Sends the CSAT request message for a web_widget conversation. Can only be
 * used once before the customer has submitted CSAT.
 */
export async function POST(_request: Request, { params }: { params: Params }) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: conversationId } = await params;

    await connectDB();
    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId")
      .lean<{ workspaceId: string } | null>();

    if (!conversation) {
      return skippedResponse("conversation_not_found");
    }

    const { workspaceId } = conversation;
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Access denied to this conversation" },
        { status: 403 }
      );
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    // Checked before sending: a repeat would re-link the earlier request and
    // flag the conversation as awaiting CSAT again.
    if (
      await Message.exists({
        conversation: conversationId,
        actionType: "csat_request",
      })
    ) {
      return skippedResponse("csat_already_sent");
    }

    const result = await sendWidgetCsatRequest({
      conversationId,
      workspaceId,
      ensureAwaiting: true,
    });

    console.log("[send-widget-csat] Completed", {
      conversationId,
      skipped: result.skipped === true,
      reason: result.reason || null,
      messageId: result.messageId || null,
    });

    return result.skipped
      ? skippedResponse(result.reason)
      : NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[send-widget-csat] Error:", error);
    return errorMessageResponse(error, 500);
  }
}
