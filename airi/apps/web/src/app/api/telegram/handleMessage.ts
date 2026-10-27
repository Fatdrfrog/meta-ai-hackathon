import { detectAndUpdateConversationLanguage } from "@/lib/airi/coach/coach-utils-server";
import { acceptAiriConversationIngress } from "@/lib/temporal/airi-direct-ingress";
import * as telegramApi from "@/lib/telegram";
import { normalizeBusinessConnectionId } from "@/lib/telegram-business-connection";
import { upsertTelegramSubscriberFromMessage } from "@/lib/telegram/subscribers";
import Message from "@/models/message";
import type { TelegramMessage } from "@/types/telegram";
import type { SourceContext } from "@icecore/shared/types/sources";
import { isBusinessOwner } from "./business-owner-detector";
import {
  getExistingBusinessConnection,
  upsertBusinessConnectionFromMessage,
} from "./handleBusinessConnectionUpdate";
import {
  ensureChatDocument,
  ensureConversation,
  ensureTelegramUser,
  handleCommands,
  persistInboundMessage,
  resolveGroupChatBusinessConnection,
  resolveWorkspaceId,
  runPostSaveSideEffects,
  safeParseChatId,
  shouldUseBusinessConnectionId,
  type TelegramAiriIngressPayload,
} from "./helpers";
import { hasTelegramPersistableContent } from "./message-content";

export async function handleMessage(
  message: TelegramMessage,
  sourceContext?: SourceContext
) {
  const { message_id, from, chat } = message;

  if (!message_id) {
    return;
  }

  const fromUser = from;
  const senderChat = message.sender_chat;
  if (!fromUser && !senderChat) {
    return;
  }

  const chatId = chat.id.toString();
  const fallbackParticipantId =
    safeParseChatId(senderChat?.id) || safeParseChatId(chat.id) || chat.id;

  console.log("[Telegram Webhook] Received message:", {
    messageId: message_id,
    chatId,
    fromId: fromUser?.id ?? null,
    senderChatId: senderChat?.id ?? null,
    chatType: chat.type,
    hasText: !!message.text,
    isBot: fromUser?.is_bot ?? false,
  });

  let businessConnectionId = normalizeBusinessConnectionId(
    message.business_connection_id
  );
  if (!businessConnectionId) {
    const sourceId = sourceContext?.sourceId || "legacy";
    const upserted = await upsertBusinessConnectionFromMessage(
      message.bot_business_connection,
      { raw: chatId, sourceId }
    );
    businessConnectionId = normalizeBusinessConnectionId(upserted);
  }

  const existingConnection = businessConnectionId
    ? null
    : fromUser
      ? await getExistingBusinessConnection(
          fromUser.id,
          sourceContext?.sourceId
        )
      : null;
  const commandBusinessConnectionId =
    businessConnectionId ||
    normalizeBusinessConnectionId(existingConnection?.business_connection_id);

  // For group chats, resolve business connection conflicts
  // This handles cases where multiple business owners have connected the same bot
  if (
    businessConnectionId &&
    (chat.type === "group" || chat.type === "supergroup")
  ) {
    const resolved = await resolveGroupChatBusinessConnection(
      chatId,
      fromUser?.id ?? fallbackParticipantId,
      businessConnectionId
    );

    if (!resolved.businessConnectionId) {
      businessConnectionId = undefined;
    } else {
      businessConnectionId = resolved.businessConnectionId;
    }
  }

  const handledCommand = fromUser
    ? await handleCommands(
        message,
        commandBusinessConnectionId,
        sourceContext?.botToken,
        sourceContext?.sourceId
      )
    : false;
  if (handledCommand) {
    return;
  }

  const hasPersistableContent = hasTelegramPersistableContent(message);

  if (!hasPersistableContent) {
    console.log("[Telegram Webhook] Skipping non-persistable message:", {
      messageId: message_id,
      chatId,
      chatType: chat.type,
      hasText: !!message.text,
      hasPhoto: !!(message.photo && message.photo.length > 0),
      hasCaption: !!message.caption,
      hasEntities: !!(message.entities && message.entities.length > 0),
    });
    return;
  }

  // Ensure sender user exists
  if (fromUser) {
    await ensureTelegramUser(fromUser, sourceContext?.botToken);
  }

  // For business conversations, also ensure the client user exists
  // The client is identified by chat.id in business messages
  if (businessConnectionId && fromUser && chat.id !== fromUser.id) {
    await ensureTelegramUser(
      {
        id: chat.id,
        is_bot: false,
        first_name: chat.first_name || `User ${chat.id}`,
        last_name: chat.last_name,
        username: chat.username,
      },
      sourceContext?.botToken
    );
  }

  const sourceId = sourceContext?.sourceId;

  const chatDocument = await ensureChatDocument(
    chat,
    fallbackParticipantId,
    sourceId || "legacy", // Fallback for old webhooks if any
    businessConnectionId
  );

  // Use provided workspaceId from source context if available
  let workspaceId = sourceContext?.workspaceId;
  if (!workspaceId) {
    workspaceId = await resolveWorkspaceId(
      chatDocument,
      chat,
      businessConnectionId
    );
  }

  if (!chatDocument.sourceId && sourceId) {
    chatDocument.sourceId = sourceId;
    await chatDocument.save();
  }

  if (!chatDocument.sourceId && !workspaceId) {
    const useBusinessConnection = await shouldUseBusinessConnectionId(
      chatId,
      businessConnectionId,
      undefined, // workspaceId not available yet
      chat.type // Pass chat type for validation
    );

    const helpText = businessConnectionId
      ? "⚠️ This business chat is not linked to a workspace. Use /start <source-key> (or /link_business <source-key>) to connect it."
      : "⚠️ This chat is not linked to a workspace. Use /start <source-key> (or /link_chat <source-key>) to connect it.";

    await telegramApi.sendTelegramMessage(
      chatId,
      helpText,
      useBusinessConnection
        ? { businessConnectionId, botToken: sourceContext?.botToken }
        : { botToken: sourceContext?.botToken }
    );
    return;
  }

  workspaceId = workspaceId || chatDocument.workspaceId;
  if (!workspaceId) {
    return;
  }

  if (sourceId && chat.type === "private") {
    await upsertTelegramSubscriberFromMessage({
      workspaceId,
      sourceId,
      message,
    });
  }

  const conversationUserId = businessConnectionId
    ? chat.id
    : chat.type === "group" || chat.type === "supergroup"
      ? chat.id
      : (fromUser?.id ?? fallbackParticipantId);

  const conversationResult = await ensureConversation(
    chatDocument,
    conversationUserId,
    workspaceId,
    sourceId,
    businessConnectionId
  );
  if (!conversationResult) {
    return;
  }
  const { conversation, isNew: isNewConversation } = conversationResult;

  const conversationId = String(conversation._id);

  // Determine if this message is from the business owner (outbound) or client (inbound)
  const isFromBusinessOwner = await isBusinessOwner(
    fromUser?.id ?? fallbackParticipantId,
    businessConnectionId
  );
  const messageDirection: "inbound" | "outbound" = isFromBusinessOwner
    ? "outbound"
    : "inbound";
  const ingressPayload =
    !fromUser?.is_bot && !isFromBusinessOwner
      ? ({
          type: "telegram",
          conversation: {
            _id: conversation._id,
            sourceId: conversation.sourceId,
            business_connection_id: conversation.business_connection_id,
            chat: conversation.chat,
          },
          workspaceId,
          chatDocument: {
            _id: chatDocument._id,
            sourceId: chatDocument.sourceId,
            workspaceId: chatDocument.workspaceId,
            businessConnectionId: chatDocument.businessConnectionId,
          },
          chatId,
          chatType: chat.type,
        } as TelegramAiriIngressPayload)
      : undefined;

  const persisted = await persistInboundMessage(
    message,
    chatDocument,
    fromUser?.id,
    conversationId,
    workspaceId,
    messageDirection,
    sourceContext?.botToken,
    ingressPayload
  );

  if (!persisted) {
    return;
  }

  const { message: newMessage, isNew: isNewMessage } = persisted;

  if (
    !newMessage.conversation ||
    String(newMessage.conversation) !== String(conversation._id)
  ) {
    try {
      await Message.updateOne(
        { _id: newMessage._id },
        { $set: { conversation: conversation._id } }
      ).exec();
    } catch {}
  }

  await runPostSaveSideEffects(
    conversation,
    workspaceId,
    newMessage,
    isNewConversation
  ).catch(error => {
    if (!ingressPayload) throw error;
    console.warn("[Telegram Webhook] Post-save side effects failed", {
      conversationId,
      messageId: String(newMessage._id),
      error: error instanceof Error ? error.message : String(error),
    });
  });

  if (ingressPayload) {
    await acceptAiriConversationIngress(newMessage, {
      ...ingressPayload,
      newMessage,
    });
  }

  if (!fromUser?.is_bot && !isFromBusinessOwner && newMessage.text) {
    await detectAndUpdateConversationLanguage(
      conversationId,
      newMessage.text
    ).catch(error => {
      console.warn(
        "[Telegram Webhook] Language detection failed after acceptance",
        {
          conversationId,
          messageId: String(newMessage._id),
          error: error instanceof Error ? error.message : String(error),
        }
      );
    });
  }

  if (!ingressPayload) {
    console.log("[RAG] Telegram: skipping Airi", {
      conversationId,
      workspaceId,
      messageId: newMessage._id,
      isBot: fromUser?.is_bot ?? false,
      isFromBusinessOwner,
      isNewMessage,
    });
  }
}
