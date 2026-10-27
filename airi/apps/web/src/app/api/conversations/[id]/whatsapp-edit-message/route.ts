import { errorMessageResponse } from "@/lib/api/json-body";
import {
  invalidateConversationCache,
  invalidateRequestsForWorkspace,
} from "@/lib/cache";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { createRequestLogger } from "@/lib/observability/server-logs";
import { checkProfanity } from "@/lib/profanity";
import { realtime } from "@/lib/realtime/server";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { editWhatsappTextMessage } from "@/lib/whatsapp";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import type { MessageDocument } from "@/types/models";
import { isStoredWhatsAppTextMessageEditable } from "@icecore/shared/lib/whatsapp/message-mutations";
import { NextRequest, NextResponse } from "next/server";
import { resolveConversationWhatsAppRecipient } from "../reply/whatsapp-recipient";

type Params = Promise<{ id: string }>;

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MEDIA_PLACEHOLDER =
  /^\[(audio|voice|video|image|document|sticker|file)(?:\s+(?:message|attachment))?\]$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const requestLogger = createRequestLogger(
    "api.conversations.whatsappEditMessage",
    request,
    { route: "/api/conversations/[id]/whatsapp-edit-message" }
  );
  requestLogger.start("WhatsApp edit message request received");

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: conversationId } = await params;
    const body = (await request.json()) as {
      messageId?: string;
      text?: string;
    };
    const messageId = String(body.messageId || "").trim();
    const text = String(body.text || "").trim();

    if (!messageId || !text) {
      return NextResponse.json(
        { error: "messageId and text are required" },
        { status: 400 }
      );
    }

    const profanity = checkProfanity("", text);
    if (profanity.toxic) {
      return NextResponse.json(
        { error: "Message contains inappropriate content and cannot be sent" },
        { status: 400 }
      );
    }

    await connectDB();

    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId channel sourceId user chat")
      .lean<{
        workspaceId: string;
        channel?: string;
        sourceId?: string | null;
        user?: unknown;
        chat?: unknown;
      } | null>();
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    const { workspaceId } = conversation;
    const hasAccess = await verifyWorkspaceAccess(
      supabase,
      user.id,
      workspaceId
    );
    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    if (conversation.channel !== "whatsapp") {
      return NextResponse.json(
        { error: "Editing is only supported for WhatsApp conversations" },
        { status: 400 }
      );
    }

    const messageDoc = await Message.findOne({
      _id: messageId,
      conversation: conversationId,
      channel: "whatsapp",
      direction: "outbound",
    }).lean<{
      _id: unknown;
      messageId?: string;
      text?: string;
      date?: Date;
      whatsappTemplate?: unknown;
      whatsappFlow?: { flowId?: string };
      whatsappServiceMessage?: unknown;
    } | null>();

    if (!messageDoc) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    const platformId = String(messageDoc.messageId || "").trim();
    if (!platformId) {
      return NextResponse.json(
        { error: "This message cannot be edited (missing WhatsApp id)" },
        { status: 400 }
      );
    }

    if (MEDIA_PLACEHOLDER.test(text)) {
      return NextResponse.json(
        { error: "Invalid message text" },
        { status: 400 }
      );
    }

    if (!isStoredWhatsAppTextMessageEditable(messageDoc)) {
      return NextResponse.json(
        { error: "This message type cannot be edited" },
        { status: 400 }
      );
    }

    const sentAt = messageDoc.date ? new Date(messageDoc.date).getTime() : 0;
    if (!sentAt || Date.now() - sentAt > EDIT_WINDOW_MS) {
      return NextResponse.json(
        {
          error:
            "This message can no longer be edited (WhatsApp allows edits within 15 minutes of sending).",
        },
        { status: 400 }
      );
    }

    // The edit must come from the number that sent the message.
    const sendContext = await resolveWhatsAppSendContext({
      workspaceId,
      sourceId: conversation.sourceId,
    });
    if (!sendContext) {
      return NextResponse.json(
        { error: "WhatsApp credentials not found" },
        { status: 500 }
      );
    }

    const { recipientTarget } =
      await resolveConversationWhatsAppRecipient(conversation);
    if (!recipientTarget) {
      return NextResponse.json(
        { error: "Recipient WhatsApp target not found" },
        { status: 400 }
      );
    }

    await editWhatsappTextMessage(
      sendContext.phoneNumberId,
      sendContext.accessToken,
      recipientTarget,
      text,
      platformId
    );

    const previousText =
      typeof messageDoc.text === "string" ? messageDoc.text : null;
    const hasTextChange = (previousText || "") !== text;

    const updated = await Message.findOneAndUpdate(
      { _id: messageId },
      {
        $set: {
          text,
          "editMeta.editedAt": new Date(),
          "editMeta.kind": "edit",
          "editMeta.source": "manager",
          ...(hasTextChange ? { "editMeta.previousText": previousText } : {}),
        },
        ...(hasTextChange ? { $inc: { "editMeta.editCount": 1 } } : {}),
      },
      { new: true, projection: { text: 1, editMeta: 1 } }
    ).lean<Pick<MessageDocument, "text" | "editMeta"> | null>();
    const editMeta = updated?.editMeta || null;

    const [{ triggerConversationRealtime }] = await Promise.all([
      import("@/lib/realtime-updates"),
      updated
        ? realtime
            .trigger(
              `private-conversation-${conversationId}`,
              "message-updated",
              { messageId, text, editMeta }
            )
            .catch(() => {})
        : undefined,
      invalidateRequestsForWorkspace(workspaceId).catch(() => {}),
    ]);
    await triggerConversationRealtime(conversationId, false).catch(() => {});

    void invalidateConversationCache(workspaceId, conversationId).catch(
      () => {}
    );

    requestLogger.success("WhatsApp message edited", {
      conversationId,
      workspaceId,
      messageId,
    });

    return NextResponse.json({ text, editMeta });
  } catch (error) {
    requestLogger.error("WhatsApp edit message failed", error, {});
    return errorMessageResponse(error, 500);
  }
}
