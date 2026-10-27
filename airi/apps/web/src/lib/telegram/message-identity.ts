import type { TelegramMessage, TelegramReplyMessage } from "@/types/telegram";
import type { TelegramStoredMessageMeta } from "@icecore/shared/types/telegram";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

type TelegramDisplayAuthor = {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
};

function formatFullName(author?: TelegramDisplayAuthor | null): string {
  const firstName = readTrimmedString(author?.firstName);
  const lastName = readTrimmedString(author?.lastName);
  return [firstName, lastName].filter(Boolean).join(" ").trim();
}

function formatUsername(username?: string | null): string {
  const normalized = readTrimmedString(username).replace(/^@+/g, "");
  return normalized ? `@${normalized}` : "";
}

function getTelegramMediaPlaceholder(
  message?: Pick<
    TelegramReplyMessage,
    | "photo"
    | "document"
    | "audio"
    | "voice"
    | "video"
    | "video_note"
    | "animation"
    | "sticker"
  >
): string | null {
  if (!message) return null;
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return "[image attachment]";
  }
  if (message.video) return "[video attachment]";
  if (message.voice) return "[voice attachment]";
  if (message.audio) return "[audio attachment]";
  if (message.document) return "[document attachment]";
  if (message.animation) return "[animation attachment]";
  if (message.video_note) return "[video note]";
  if (message.sticker) return "[sticker]";
  return null;
}

export function buildTelegramReplyPreview(
  message?: TelegramReplyMessage | null
): string | null {
  if (!message) return null;
  const text = readTrimmedString(message.text);
  if (text) return text;

  const caption = readTrimmedString(message.caption);
  if (caption) return caption;

  return getTelegramMediaPlaceholder(message);
}

export function resolveTelegramSenderDisplayName(params: {
  author?: TelegramDisplayAuthor | null;
  telegramMeta?: Partial<TelegramStoredMessageMeta> | null;
  fallback?: string;
}): string {
  const fullName = formatFullName(params.author);
  if (fullName) return fullName;

  const username = formatUsername(params.author?.username);
  if (username) return username;

  const senderTag = readTrimmedString(params.telegramMeta?.senderTag);
  if (senderTag) return senderTag;

  const authorSignature = readTrimmedString(
    params.telegramMeta?.authorSignature
  );
  if (authorSignature) return authorSignature;

  const senderChatTitle = readTrimmedString(
    params.telegramMeta?.senderChatTitle
  );
  if (senderChatTitle) return senderChatTitle;

  const snapshottedName = readTrimmedString(
    params.telegramMeta?.senderDisplayName
  );
  if (snapshottedName) return snapshottedName;

  return params.fallback || "Unknown participant";
}

export function buildTelegramStoredMessageMeta(
  message: TelegramMessage
): TelegramStoredMessageMeta {
  const senderChat = message.sender_chat;
  const author = message.from
    ? {
        firstName: message.from.first_name,
        lastName: message.from.last_name,
        username: message.from.username,
      }
    : null;

  const meta: TelegramStoredMessageMeta = {
    senderChatId:
      senderChat && senderChat.id !== undefined
        ? String(senderChat.id)
        : undefined,
    senderChatTitle: senderChat?.title || undefined,
    senderChatType: senderChat?.type || undefined,
    authorSignature: readTrimmedString(message.author_signature) || undefined,
    senderTag: readTrimmedString(message.sender_tag) || undefined,
    messageThreadId:
      typeof message.message_thread_id === "number"
        ? message.message_thread_id
        : undefined,
    isTopicMessage:
      typeof message.is_topic_message === "boolean"
        ? message.is_topic_message
        : undefined,
    replyToTelegramMessageId: message.reply_to_message
      ? String(message.reply_to_message.message_id)
      : undefined,
    replyToTextPreview: buildTelegramReplyPreview(message.reply_to_message),
  };

  const senderDisplayName = resolveTelegramSenderDisplayName({
    author,
    telegramMeta: meta,
  });
  if (senderDisplayName) {
    meta.senderDisplayName = senderDisplayName;
  }

  return meta;
}

export function formatTelegramTopicLabel(
  messageThreadId?: number | null
): string | null {
  if (
    typeof messageThreadId !== "number" ||
    !Number.isFinite(messageThreadId)
  ) {
    return null;
  }

  return `Topic #${messageThreadId}`;
}
