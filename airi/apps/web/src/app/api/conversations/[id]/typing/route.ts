import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import {
  getSupabaseRouteAuth,
  isSupabaseRouteAuthError,
} from "@/lib/supabase/route-auth";
import { sendWhatsappTypingIndicator } from "@/lib/whatsapp";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import { NextResponse } from "next/server";

type Params = Promise<{ id: string }>;

const WHATSAPP_TYPING_INBOUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const WHATSAPP_WAMID_REGEX = /^(?:ws_)?wamid\./;

type TypingConversation = {
  _id?: unknown;
  workspaceId: string;
  channel?: string | null;
  sourceId?: string | null;
};

type LatestInboundMessage = {
  messageId?: string | null;
};

function jsonNoop(reason: string) {
  return NextResponse.json({
    success: true,
    sent: false,
    reason,
  });
}

async function getLatestInboundWhatsAppMessageId(conversationId: string) {
  const latest = (await Message.findOne({
    conversation: conversationId,
    channel: "whatsapp",
    direction: "inbound",
    messageId: WHATSAPP_WAMID_REGEX,
    date: {
      $gte: new Date(Date.now() - WHATSAPP_TYPING_INBOUND_WINDOW_MS),
    },
  })
    .sort({ date: -1, _id: -1 })
    .select("messageId")
    .lean()) as LatestInboundMessage | null;

  return typeof latest?.messageId === "string" ? latest.messageId.trim() : "";
}

export async function POST(request: Request, { params }: { params: Params }) {
  const auth = await getSupabaseRouteAuth(request);
  if (isSupabaseRouteAuthError(auth)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: conversationId } = await params;

  await connectDB();
  const conversation = (await Conversation.findById(conversationId)
    .select("_id workspaceId channel sourceId")
    .lean()) as TypingConversation | null;

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  if (conversation.channel !== "whatsapp") {
    return jsonNoop("unsupported_channel");
  }

  const { workspaceId } = conversation;
  const hasAccess = await verifyWorkspaceAccess(
    auth.supabase,
    auth.user.id,
    workspaceId
  );
  if (!hasAccess) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const planGateResponse = await getHiddenConversationPlanGateResponse(
    auth.supabase,
    workspaceId,
    conversationId
  );
  if (planGateResponse) {
    return planGateResponse;
  }

  const messageId = await getLatestInboundWhatsAppMessageId(conversationId);
  if (!messageId) {
    return jsonNoop("no_recent_inbound_message");
  }

  const sourceId =
    typeof conversation.sourceId === "string"
      ? conversation.sourceId.trim()
      : undefined;
  const sendContext = await resolveWhatsAppSendContext({
    workspaceId,
    sourceId,
  });
  if (!sendContext) {
    return jsonNoop("missing_whatsapp_send_context");
  }

  try {
    await sendWhatsappTypingIndicator(
      sendContext.phoneNumberId,
      sendContext.accessToken,
      messageId
    );
  } catch {
    return jsonNoop("provider_rejected_typing_indicator");
  }

  return NextResponse.json({
    success: true,
    sent: true,
  });
}
