import { widgetLogger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { realtime } from "@/lib/realtime/server";
import {
  triggerConversationResolved,
  triggerCsatSubmitted,
} from "@/lib/webhook-events";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import { Conversation } from "@/models/conversation";
import { buildConversationEventData } from "@icecore/shared/lib/conversation-lifecycle-webhook";
import { NextRequest } from "next/server";
import { measuredResolutionWholeSeconds } from "@/lib/analytics/service-truth";

type CsatSubmitBody = {
  score: number;
  comment?: string;
  client_key: string;
};

/**
 * OPTIONS /api/widget/conversations/[id]/csat
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * POST /api/widget/conversations/[id]/csat
 *
 * Accepts a CSAT score (1-5) and optional comment from the widget,
 * saves it on the conversation, formally closes the conversation,
 * and fires the appropriate webhooks.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: conversationId } = await params;

  try {
    const body = (await req.json()) as CsatSubmitBody;
    const { score, comment, client_key } = body;

    if (!client_key) {
      return jsonWithCors(
        { success: false, error: "Missing client_key" },
        { status: 400 }
      );
    }

    if (typeof score !== "number" || score < 1 || score > 5) {
      return jsonWithCors(
        { success: false, error: "Score must be a number between 1 and 5" },
        { status: 400 }
      );
    }

    const sourceAuth = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey: client_key,
    });
    if (!sourceAuth.ok) {
      return jsonWithCors(
        { success: false, error: sourceAuth.error },
        { status: sourceAuth.status }
      );
    }

    const { source } = sourceAuth;

    await connectDB();

    const conversation = await Conversation.findById(conversationId);
    if (!conversation || conversation.workspaceId !== source.workspace_id) {
      return jsonWithCors(
        { success: false, error: "Conversation not found" },
        { status: 404 }
      );
    }

    // A rating can arrive after the chat was already closed (the CSAT timeout
    // or a manager). That close already sent its resolved event and keeps its
    // resolution; the late rating is stored and reported only as a rating.
    const wasClosed = conversation.status === "closed";

    // Save CSAT score and comment, then formally close
    conversation.customer_satisfaction_score = score;
    if (comment && typeof comment === "string") {
      conversation.customer_satisfaction_comment = comment
        .trim()
        .slice(0, 2000);
    }
    conversation.awaiting_csat = false;
    if (!wasClosed) {
      conversation.status = "closed";
      conversation.csat_timeout_closed = false;
      conversation.$locals = conversation.$locals ?? {};
      conversation.$locals.serviceResolutionKind = "customer_csat";
    }
    conversation.updatedAt = new Date();
    await conversation.save();

    const workspaceId = conversation.workspaceId;

    // Fire conversation resolved webhook, once per close
    if (!wasClosed) {
      triggerConversationResolved(
        workspaceId,
        buildConversationEventData(conversation, {
          status: "closed",
          previous_status: "in_progress",
          channel: conversation.channel || "web_widget",
          customer_phone: conversation.user?.toString(),
          resolution_kind: "customer_csat",
          resolution_time_seconds: measuredResolutionWholeSeconds(conversation),
        })
      ).catch(err =>
        console.error("[CSAT] triggerConversationResolved error:", err)
      );
    }

    // Fire CSAT submitted webhook (handles CSAT_LOW automatically)
    triggerCsatSubmitted(workspaceId, {
      conversation_id: conversationId,
      score,
      channel: conversation.channel || "web_widget",
      submitted_at: new Date().toISOString(),
    }).catch(err => console.error("[CSAT] triggerCsatSubmitted error:", err));

    // Notify admin panel via Realtime that the conversation is now closed
    realtime
      .trigger(
        `private-conversation-${conversationId}`,
        "conversation-updated",
        {
          workspaceId,
          status: "closed",
          awaiting_csat: false,
          customer_satisfaction_score: score,
        }
      )
      .catch((err: unknown) =>
        console.error("[CSAT] Realtime conversation-updated error:", err)
      );

    return jsonWithCors({ success: true });
  } catch (error) {
    widgetLogger.error("csat_submit", error, { conversationId });
    return jsonWithCors(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
