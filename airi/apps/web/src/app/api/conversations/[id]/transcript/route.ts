import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { enqueueConversationMediaAnalysis } from "@/lib/media/conversation-media-analysis-jobs";
import { isMeaningfulMessageText } from "@/lib/media/message-media-utils";
import { isProviderLabelText } from "@/lib/provider-message-display";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { NextRequest, NextResponse } from "next/server";
import {
  errorMessageResponse,
  requiredFieldResponse,
} from "@/lib/api/json-body";

type Params = Promise<{ id: string }>;

const TRANSCRIBABLE_MEDIA_TYPES = new Set(["audio", "voice", "video"]);

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const auth = await getSupabaseRouteAuth(request);
    if (isSupabaseRouteAuthError(auth)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { supabase, user } = auth;

    const { id: conversationId } = await params;
    const payload = (await request.json().catch(() => null)) as {
      messageId?: string;
    } | null;
    const messageId = payload?.messageId?.trim();

    if (!messageId) return requiredFieldResponse("messageId");

    await connectDB();

    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId")
      .lean<{ workspaceId: string } | null>();
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      conversation.workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      conversation.workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    const message = await Message.findOne({
      _id: messageId,
      conversation: conversationId,
    })
      .select("mediaType text")
      .lean<{ mediaType?: string | null; text?: string | null } | null>();

    if (!message) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    const mediaType = (message.mediaType || "").toLowerCase();
    if (!TRANSCRIBABLE_MEDIA_TYPES.has(mediaType)) {
      return NextResponse.json(
        {
          error: "Transcription is supported only for audio and video messages",
        },
        { status: 400 }
      );
    }

    // Media analysis stores the transcript as the message text, unless the
    // text is a provider label ("Tagged in Instagram story"), which it keeps.
    if (
      isMeaningfulMessageText(message.text) &&
      !isProviderLabelText(message.text)
    ) {
      return NextResponse.json({ transcript: message.text.trim() });
    }

    const queued = await enqueueConversationMediaAnalysis({
      workspaceId: conversation.workspaceId,
      conversationId,
      messageId,
      mediaType,
    });
    if (queued.queued || queued.reason === "already_active") {
      return NextResponse.json(
        { error: "Transcript is being prepared." },
        { status: 202 }
      );
    }
    return NextResponse.json(
      {
        error:
          queued.reason === "already_complete"
            ? "Transcript is not available for this message."
            : queued.errorMessage || "Transcript could not be queued.",
      },
      { status: queued.reason === "already_complete" ? 409 : 503 }
    );
  } catch (error) {
    return errorMessageResponse(error, 500);
  }
}
