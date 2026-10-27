import { enqueueAiriCoachJobBestEffort } from "@/lib/airi/coach/coach-jobs";
import {
  persistManagerOutboundMessage,
  upsertManagerAuthor,
  type ManagerOutboundMessage,
} from "@/lib/conversation-messages";
import {
  checkMessagingWindowForConversation,
  formatWindowMessage,
} from "@/lib/messaging-window";
import {
  sendWhatsappMedia,
  sendWhatsappMessage,
  type WhatsAppMediaType,
} from "@/lib/whatsapp";
import {
  buildWhatsAppStoredReplyMeta,
  normalizeWhatsAppMessageId,
  toWhatsAppGraphMessageId,
} from "@icecore/shared/lib/whatsapp/message-id";
import type { WhatsAppStoredMessageMeta } from "@icecore/shared/types/whatsapp-message-meta";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import Message from "@/models/message";
import type { PopulatedMessage } from "@/types/models";
import type { ManagerReplyContext } from "./manager-reply-context";
import { resolveConversationWhatsAppRecipient } from "./whatsapp-recipient";

function normalizeOutboundWhatsAppMessageId(messageId?: string): string {
  const safeId =
    messageId ||
    `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return normalizeWhatsAppMessageId(safeId);
}

export async function handleWhatsAppReply({
  conversation,
  text,
  workspaceId,
  manager,
  attachments,
  replyToMessageId,
}: ManagerReplyContext): Promise<PopulatedMessage> {
  const startedAt = Date.now();

  const sourceContext = await resolveWhatsAppSendContext({
    sourceId: conversation.sourceId,
    workspaceId,
  });
  if (!sourceContext) {
    throw new Error("WhatsApp credentials not found for this workspace");
  }
  const { phoneNumberId, accessToken } = sourceContext;

  const { recipientTarget } =
    await resolveConversationWhatsAppRecipient(conversation);
  if (!recipientTarget) {
    throw new Error("Recipient WhatsApp target not found in conversation");
  }

  const windowInfo = await checkMessagingWindowForConversation(conversation);
  if (!windowInfo.isWithinWindow) {
    const errorMessage = formatWindowMessage(windowInfo);
    throw new Error(`Cannot send message: ${errorMessage}`);
  }

  let replyToPlatformMessageId: string | undefined;
  let whatsappReplyMeta: WhatsAppStoredMessageMeta | null = null;
  if (replyToMessageId) {
    const replyTargetMessage = await Message.findOne({
      _id: replyToMessageId,
      conversation: conversation._id,
    })
      .select("messageId text mediaType")
      .lean<{
        messageId?: string;
        text?: string | null;
        mediaType?: string | null;
      }>()
      .catch(() => null);

    replyToPlatformMessageId = toWhatsAppGraphMessageId(
      replyTargetMessage?.messageId
    );

    if (replyTargetMessage?.messageId || replyToPlatformMessageId) {
      whatsappReplyMeta = buildWhatsAppStoredReplyMeta({
        replyToMessageId:
          replyTargetMessage?.messageId || replyToPlatformMessageId || "",
        parent: replyTargetMessage,
      });
    }
  }

  // Meta first: nothing is stored until WhatsApp has accepted every part.
  const preMetaMs = Date.now() - startedAt;
  const metaStartedAt = Date.now();
  const sentMessages: ManagerOutboundMessage[] = [];
  const replyFields = whatsappReplyMeta
    ? { whatsappMeta: whatsappReplyMeta }
    : {};

  if (text) {
    const sent = await sendWhatsappMessage(
      phoneNumberId,
      accessToken,
      recipientTarget,
      text,
      replyToPlatformMessageId
    );
    sentMessages.push({
      messageId: normalizeOutboundWhatsAppMessageId(sent.messageId),
      date: new Date(sent.date * 1000),
      text,
      fields: replyFields,
    });
  }

  for (const attachment of attachments) {
    // The route normalized attachments to WhatsApp's media types.
    const mediaType = attachment.mediaType as WhatsAppMediaType;
    const sent = await sendWhatsappMedia(
      phoneNumberId,
      accessToken,
      recipientTarget,
      {
        type: mediaType,
        ...(attachment.whatsappMediaId
          ? { id: attachment.whatsappMediaId }
          : { link: attachment.url }),
        fileName: attachment.fileName,
      },
      replyToPlatformMessageId
    );
    sentMessages.push({
      messageId: normalizeOutboundWhatsAppMessageId(sent.messageId),
      date: new Date(sent.date * 1000),
      text: `[${mediaType} attachment]`,
      fields: {
        imageUrl: attachment.url,
        mediaType,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
        whatsappMediaId: attachment.whatsappMediaId,
        ...replyFields,
      },
    });
  }

  const metaSendMs = Date.now() - metaStartedAt;
  const persistStartedAt = Date.now();
  const managerUser = await upsertManagerAuthor(manager);

  let lastMessage: PopulatedMessage | null = null;
  for (const message of sentMessages) {
    lastMessage = await persistManagerOutboundMessage({
      conversation,
      workspaceId,
      channel: "whatsapp",
      managerId: manager.id,
      managerUser,
      message,
      logTag: "Reply:WhatsApp",
    });
  }
  if (!lastMessage) {
    throw new Error("No message was sent");
  }

  enqueueAiriCoachJobBestEffort(
    {
      workspaceId,
      conversationId: String(conversation._id),
      messageId: String(lastMessage._id),
    },
    "Reply:WhatsApp"
  );

  console.info("[Reply:WhatsApp] Manager send timing", {
    preMetaMs,
    metaSendMs,
    persistMs: Date.now() - persistStartedAt,
    totalMs: Date.now() - startedAt,
    channel: "whatsapp",
    attachmentCount: attachments.length,
    cacheHit: sourceContext.cacheHit,
  });

  return lastMessage;
}
