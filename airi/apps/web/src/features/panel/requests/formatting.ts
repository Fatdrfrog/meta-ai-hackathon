import { formatChannelName, formatClientName } from "@/lib/date-utils";
import { resolveInstagramMediaPreviewUrl } from "@/lib/instagram/thread-meta";
import { resolveTelegramSenderDisplayName } from "@/lib/telegram/message-identity";
import type {
  RequestConversationMessage,
  RequestConversationMessageAuthor,
  StoredMessageEditMeta,
} from "@icecore/shared/types/message-preview";
import type {
  FormattedRequest,
  InstagramRequestMeta,
  NullableRawDate,
  RawConversation,
  RawDate,
  RawId,
  RawRequestConversationMessage,
  RawRequestConversationMessageAuthor,
} from "@icecore/shared/types/requests";

export type {
  FormattedRequest,
  InstagramRequestMeta,
  RawConversation,
} from "@icecore/shared/types/requests";

function toClientId(
  value: RawId | null | undefined
): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  return String(value);
}

function toClientDate(value: RawDate): string;
function toClientDate(value: RawDate | undefined): string | undefined;
function toClientDate(value: NullableRawDate): string | null | undefined;
function toClientDate(value: NullableRawDate): string | null | undefined {
  if (value === undefined || value === null) return value;
  return value instanceof Date ? value.toISOString() : value;
}

function toClientAuthor(
  author: RawRequestConversationMessageAuthor | undefined
): RequestConversationMessageAuthor | undefined {
  if (!author) return undefined;

  return {
    _id: toClientId(author._id),
    firstName: author.firstName,
    lastName: author.lastName,
    username: author.username,
    avatar_url: author.avatar_url,
    isBot: author.isBot,
  };
}

function toClientEditMeta(
  editMeta: RawRequestConversationMessage["editMeta"]
): StoredMessageEditMeta | null {
  if (!editMeta) return null;

  return {
    ...editMeta,
    editedAt: toClientDate(editMeta.editedAt),
  };
}

// Projected message text is already stripped of Instagram comment metadata
// (lib/requests-projection/derive.ts).
function toClientMessage(
  message: RawRequestConversationMessage
): RequestConversationMessage {
  return {
    text: message.text,
    date: toClientDate(message.date),
    direction: message.direction,
    mediaType: message.mediaType ?? null,
    mimeType: message.mimeType ?? null,
    fileName: message.fileName ?? null,
    whatsappFlow: message.whatsappFlow ?? null,
    whatsappFlowReply: message.whatsappFlowReply ?? null,
    whatsappTemplate: message.whatsappTemplate ?? null,
    whatsappServiceMessage: message.whatsappServiceMessage ?? null,
    whatsappCtaLink: message.whatsappCtaLink ?? null,
    groundedReplyOptions: message.groundedReplyOptions ?? null,
    telegramReplyMarkup: message.telegramReplyMarkup ?? null,
    editMeta: toClientEditMeta(message.editMeta),
    author: toClientAuthor(message.author),
    telegramMeta: message.telegramMeta ?? null,
  };
}

function getLastInboundMessageAt(
  item: RawConversation,
  messages: RequestConversationMessage[]
): string | null {
  const explicitLastInbound = toClientDate(item.lastInboundMessageAt);
  if (explicitLastInbound) return explicitLastInbound;

  if (!item.user || messages.length === 0) return null;

  const inboundDate = messages.find(
    message => message.direction === "inbound"
  )?.date;

  return toClientDate(inboundDate) ?? null;
}

function getLastMessageAuthor(
  channel: RawConversation["channel"],
  lastMessage: RequestConversationMessage | undefined
): string | undefined {
  if (channel !== "telegram" || !lastMessage) {
    return lastMessage?.author?.firstName;
  }

  return resolveTelegramSenderDisplayName({
    author: lastMessage.author
      ? {
          firstName: lastMessage.author.firstName,
          lastName: lastMessage.author.lastName,
          username: lastMessage.author.username,
        }
      : null,
    telegramMeta: lastMessage.telegramMeta,
  });
}

function getInstagramMeta(item: RawConversation): InstagramRequestMeta {
  const comment = item.external_thread?.comment;
  const media = item.external_thread?.media;
  return {
    isReply: Boolean(comment?.parentId),
    isHidden: typeof comment?.hidden === "boolean" ? comment.hidden : undefined,
    likeCount:
      typeof comment?.likeCount === "number" ? comment.likeCount : null,
    mediaType: media?.mediaType,
    mediaProductType: media?.mediaProductType,
    mediaCaption: media?.caption,
    mediaPreviewUrl: resolveInstagramMediaPreviewUrl({
      thumbnailUrl: media?.thumbnailUrl,
      mediaUrl: media?.mediaUrl,
    }),
    mediaAuthorUsername: media?.username,
  };
}

function getClientUser(user: RawConversation["user"]) {
  if (!user) return undefined;

  return {
    ...user,
    _id: toClientId(user._id),
  };
}

export function formatConversationToRequest(
  item: RawConversation
): FormattedRequest {
  const isEmail = item.channel === "email";
  const isInstagramCommentThread =
    item.channel === "instagram" && item.external_thread?.type === "comment";

  // Projected recentMessages are newest first.
  const normalizedMessages = item.messages?.map(toClientMessage) || [];
  const lastMessage = normalizedMessages[0];

  return {
    id: String(item._id),
    projectionGeneration: item.projectionGeneration,
    readStateWatermark: item.readStateWatermark,
    dateValue: toClientDate(item.computedLastMessageAt ?? item.createdAt),
    source: formatChannelName(
      item.channel,
      item.business_connection_id,
      item.chat?.title,
      item.chat?.type,
      item.sourceInfo
    ),
    status: item.status,
    client: formatClientName(
      item.channel,
      getClientUser(item.user),
      item.participants,
      item.chat || undefined
    ),
    rename: item.rename ?? null,
    request: (isEmail ? item.subject : item.classification?.summary) || null,
    category: item.classification?.category || null,
    action: item.classification?.action || null,
    channel: item.channel,
    lastInboundMessageAt: getLastInboundMessageAt(item, normalizedMessages),
    avatarUrl: item.user?.avatar_url,
    lastMessageText: lastMessage?.text,
    lastMessageAuthor: getLastMessageAuthor(item.channel, lastMessage),
    lastMessageDirection: lastMessage?.direction,
    lastMessageThreadId: lastMessage?.telegramMeta?.messageThreadId ?? null,
    lastMessages: normalizedMessages,
    chatType: item.chat?.type,
    awaitingCsat: item.awaiting_csat,
    customerSatisfactionScore: item.customer_satisfaction_score,
    airiLastReplied: item.airiLastReplied === true,
    isReadByManager: item.is_read_by_manager === true,
    isInstagramCommentThread,
    instagramMeta: isInstagramCommentThread
      ? getInstagramMeta(item)
      : undefined,
    internalLabels: item.internal_labels ?? [],
  };
}
