import { enqueueAiriCoachJobBestEffort } from "@/lib/airi/coach/coach-jobs";
import { shouldUseBusinessConnectionId } from "@/app/api/telegram/helpers";
import { parseTelegramCompositeChatId } from "@/lib/telegram/chat-id";
import {
  persistManagerOutboundMessage,
  upsertManagerAuthor,
} from "@/lib/conversation-messages";
import {
  sendTelegramMedia,
  sendTelegramMessage,
  type TelegramOutboundMediaType,
} from "@/lib/telegram";
import { resolveTelegramSendContext } from "@/lib/telegram/source-context";
import Message from "@/models/message";

import {
  ConversationDocument,
  MessageDocument,
  PopulatedMessage,
} from "@/types/models";
import type { OutboundAttachment } from "@/types/outbound-attachment";
import { normalizeMediaMimeType } from "@/lib/whatsapp/media-types";
import type { ManagerReplyContext } from "./manager-reply-context";

const TELEGRAM_VOICE_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
]);

function isWebmAudioAttachment(attachment: OutboundAttachment): boolean {
  const normalizedMime = normalizeMediaMimeType(attachment.mimeType);
  if (normalizedMime === "audio/webm" || normalizedMime === "audio/weba") {
    return true;
  }

  const normalizedName = (attachment.fileName || "").trim().toLowerCase();
  return normalizedName.endsWith(".webm") || normalizedName.endsWith(".weba");
}

function isLikelyVoiceAttachment(attachment: OutboundAttachment): boolean {
  if (attachment.mediaType === "voice") {
    return true;
  }
  return /^voice[-_]/i.test((attachment.fileName || "").trim().toLowerCase());
}

function canSendAsTelegramVoice(attachment: OutboundAttachment): boolean {
  const normalizedMime = normalizeMediaMimeType(attachment.mimeType);
  if (normalizedMime) {
    return TELEGRAM_VOICE_MIME_TYPES.has(normalizedMime);
  }

  const normalizedName = (attachment.fileName || "").trim().toLowerCase();
  return /\.(ogg|opus|mp3|m4a)$/i.test(normalizedName);
}

// The route normalizes Telegram attachments to image, video, audio, voice or
// document; this only picks how audio is delivered.
function mapAttachmentToTelegramMediaType(
  attachment: OutboundAttachment
): TelegramOutboundMediaType {
  if (attachment.mediaType === "voice") {
    if (isWebmAudioAttachment(attachment)) {
      // Telegram often fails or misplays WEBM audio; sending as document is safer.
      return "document";
    }

    if (canSendAsTelegramVoice(attachment)) {
      return "voice";
    }

    return "audio";
  }

  if (attachment.mediaType === "audio" && isWebmAudioAttachment(attachment)) {
    // Telegram often fails or misplays WEBM audio; sending as document is safer.
    return "document";
  }

  if (
    attachment.mediaType === "audio" &&
    isLikelyVoiceAttachment(attachment) &&
    canSendAsTelegramVoice(attachment)
  ) {
    return "voice";
  }

  return attachment.mediaType as TelegramOutboundMediaType;
}

export async function resolveTelegramReplyContext(
  conversationId: ConversationDocument["_id"],
  replyToMessageId?: string
): Promise<{
  replyToTelegramMessageId?: number;
  messageThreadId?: number;
}> {
  let replyToTelegramMessageId: number | undefined;
  let messageThreadId: number | undefined;

  if (replyToMessageId) {
    const replyTargetMessage = await Message.findOne({
      _id: replyToMessageId,
      conversation: conversationId,
    })
      .select("messageId telegramMeta.messageThreadId")
      .lean<{
        messageId?: string;
        telegramMeta?: { messageThreadId?: number };
      }>()
      .catch(() => null);

    const candidate =
      typeof replyTargetMessage?.messageId === "string"
        ? replyTargetMessage.messageId.trim()
        : "";
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      replyToTelegramMessageId = parsed;
    }

    if (
      typeof replyTargetMessage?.telegramMeta?.messageThreadId === "number" &&
      Number.isFinite(replyTargetMessage.telegramMeta.messageThreadId)
    ) {
      messageThreadId = replyTargetMessage.telegramMeta.messageThreadId;
    }
  }

  if (messageThreadId === undefined) {
    const latestInboundMessage = await Message.findOne({
      conversation: conversationId,
      channel: "telegram",
      direction: "inbound",
    })
      .sort({ date: -1 })
      .select("telegramMeta.messageThreadId")
      .lean<{ telegramMeta?: { messageThreadId?: number } }>()
      .catch(() => null);

    if (
      typeof latestInboundMessage?.telegramMeta?.messageThreadId === "number" &&
      Number.isFinite(latestInboundMessage.telegramMeta.messageThreadId)
    ) {
      messageThreadId = latestInboundMessage.telegramMeta.messageThreadId;
    }
  }

  return {
    replyToTelegramMessageId,
    messageThreadId,
  };
}

export async function handleTelegramReply({
  conversation,
  text,
  workspaceId,
  manager,
  attachments,
  replyToMessageId,
}: ManagerReplyContext): Promise<PopulatedMessage> {
  const dbChatId =
    typeof conversation.chat === "object" && conversation.chat._id
      ? String(conversation.chat._id)
      : String(conversation.chat);

  const realChatId = parseTelegramCompositeChatId(dbChatId);

  // The resolved name is also stored as the Telegram sender display name.
  const resolvedManagerNamePromise = manager.namePromise
    ? manager.namePromise.then(
        value => value || manager.name,
        () => manager.name
      )
    : Promise.resolve(manager.name);
  const managerUserPromise = resolvedManagerNamePromise.then(name =>
    upsertManagerAuthor({ id: manager.id, name })
  );

  // The conversation's own bot; without a usable workspace source the
  // platform bot (TELEGRAM_BOT_TOKEN) sends.
  const botTokenPromise = conversation.sourceId
    ? resolveTelegramSendContext({
        workspaceId,
        sourceId: conversation.sourceId,
      }).then(
        context => context?.botToken,
        () => undefined
      )
    : Promise.resolve(undefined);

  const originalBusinessConnectionId = conversation.business_connection_id as
    | string
    | undefined;
  const businessConnectionPromise = originalBusinessConnectionId
    ? shouldUseBusinessConnectionId(
        realChatId,
        originalBusinessConnectionId,
        workspaceId,
        conversation.chat?.type || "private"
      ).then(shouldUse =>
        shouldUse ? originalBusinessConnectionId : undefined
      )
    : Promise.resolve(undefined);

  // Author, source and ownership readiness can overlap. Read the latest inbound
  // topic afterward so a message arriving during preparation keeps its routing.
  const [
    resolvedManagerName,
    managerUser,
    botToken,
    ownedBusinessConnectionId,
  ] = await Promise.all([
    resolvedManagerNamePromise,
    managerUserPromise,
    botTokenPromise,
    businessConnectionPromise,
  ]);
  let businessConnectionId = ownedBusinessConnectionId;
  const { replyToTelegramMessageId, messageThreadId: replyMessageThreadId } =
    await resolveTelegramReplyContext(conversation._id, replyToMessageId);

  const sendWithBusinessFallback = async <T>(
    sender: (options?: {
      businessConnectionId?: string;
      botToken?: string;
      replyToMessageId?: number;
      messageThreadId?: number;
    }) => Promise<T>
  ) => {
    try {
      return await sender({
        ...(businessConnectionId ? { businessConnectionId } : {}),
        ...(botToken ? { botToken } : {}),
      });
    } catch (error) {
      const errorMessage =
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : "";

      const hadBusinessConnection = !!originalBusinessConnectionId;
      const isBusinessConnectionError =
        hadBusinessConnection &&
        (errorMessage.includes("BUSINESS_PEER_INVALID") ||
          errorMessage.includes("bot can't initiate conversation") ||
          errorMessage.includes("Forbidden: bot can't"));

      if (!isBusinessConnectionError) {
        throw error;
      }

      conversation.business_connection_id = undefined;
      await conversation.save();
      businessConnectionId = undefined;

      try {
        return await sender(botToken ? { botToken } : undefined);
      } catch (retryError) {
        const retryErrorMsg =
          retryError &&
          typeof retryError === "object" &&
          "message" in retryError
            ? String(retryError.message)
            : "Unknown error";

        throw new Error(
          `Cannot send message to this Telegram chat. The user may need to message your bot first. Original error: ${errorMessage}. Retry error: ${retryErrorMsg}`
        );
      }
    }
  };

  // Each part is stored as soon as Telegram accepts it, so a later failed
  // attachment never loses an already delivered message.
  const persistSent = (
    sent: { messageId: number | string; date: number },
    text: string,
    fields: Record<string, unknown> = {}
  ) =>
    persistManagerOutboundMessage({
      // Telegram manager messages have always stored the chat id as a string.
      conversation: { _id: conversation._id, chat: dbChatId },
      workspaceId,
      channel: "telegram",
      managerId: manager.id,
      managerUser,
      message: {
        messageId: String(sent.messageId),
        date: new Date(sent.date * 1000),
        text,
        fields: {
          ...fields,
          // Read at persist time: a rejected business connection is dropped.
          telegramMeta: {
            businessConnectionId: businessConnectionId ?? null,
            senderDisplayName: resolvedManagerName,
            ...(replyMessageThreadId
              ? {
                  messageThreadId: replyMessageThreadId,
                  isTopicMessage: true,
                }
              : {}),
            ...(replyToTelegramMessageId
              ? { replyToTelegramMessageId: String(replyToTelegramMessageId) }
              : {}),
          } satisfies MessageDocument["telegramMeta"],
        },
      },
      logTag: "Reply:Telegram",
    });

  let lastMessage: PopulatedMessage | null = null;

  if (text) {
    const sentMessageData = await sendWithBusinessFallback(options =>
      sendTelegramMessage(realChatId, text, {
        ...options,
        ...(replyToTelegramMessageId
          ? { replyToMessageId: replyToTelegramMessageId }
          : {}),
        ...(replyMessageThreadId
          ? { messageThreadId: replyMessageThreadId }
          : {}),
      })
    );

    lastMessage = await persistSent(sentMessageData, text);
  }

  for (const attachment of attachments) {
    const attachmentUrl = attachment.url;
    if (!attachmentUrl) {
      throw new Error("Telegram attachment is missing a public URL");
    }

    const tgMediaType = mapAttachmentToTelegramMediaType(attachment);
    const sentMessageData = await sendWithBusinessFallback(options =>
      sendTelegramMedia(
        realChatId,
        {
          type: tgMediaType,
          url: attachmentUrl,
          fileName: attachment.fileName,
        },
        {
          ...options,
          ...(replyToTelegramMessageId
            ? { replyToMessageId: replyToTelegramMessageId }
            : {}),
          ...(replyMessageThreadId
            ? { messageThreadId: replyMessageThreadId }
            : {}),
        }
      )
    );

    lastMessage = await persistSent(
      sentMessageData,
      `[${tgMediaType} attachment]`,
      {
        imageUrl: attachmentUrl,
        mediaType: tgMediaType,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        fileSize: attachment.fileSize,
      }
    );
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
    "Reply:Telegram"
  );

  return lastMessage;
}
