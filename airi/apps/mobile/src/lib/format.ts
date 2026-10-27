import type {
  MobileConversationDetail,
  MobileConversationMessage,
} from "@icecore/shared/types/mobile-api";
import type { RawConversation } from "@icecore/shared/types/requests";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getId(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "toString" in value) {
    return String(value);
  }
  return "";
}

export function getConversationTitle(conversation: RawConversation): string {
  const rename = asString(conversation.rename);
  if (rename) return rename;
  const chatTitle = asString(conversation.chat?.title);
  if (chatTitle) return chatTitle;
  const firstName = asString(conversation.user?.firstName);
  const lastName = asString(conversation.user?.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  if (fullName) return fullName;
  const username = asString(conversation.user?.username);
  if (username) return username;
  return `${conversation.channel || "Conversation"} ${getId(conversation._id).slice(-6)}`;
}

export function getConversationPreview(conversation: RawConversation): string {
  const lastMessage = asString(conversation.lastMessageText);
  if (lastMessage) return lastMessage;
  const summary = asString(conversation.classification?.summary);
  if (summary) return summary;
  const category = asString(conversation.classification?.category);
  if (category) return category;
  return "No messages yet";
}

export function getConversationTimestamp(
  conversation: RawConversation,
): string {
  const value =
    conversation.computedLastMessageAt ||
    conversation.lastInboundMessageAt ||
    conversation.createdAt;
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function sortRawConversations(
  conversations: RawConversation[],
): RawConversation[] {
  return [...conversations].sort((a, b) => {
    const aTime = new Date(
      a.computedLastMessageAt || a.lastInboundMessageAt || a.createdAt,
    ).getTime();
    const bTime = new Date(
      b.computedLastMessageAt || b.lastInboundMessageAt || b.createdAt,
    ).getTime();
    return bTime - aTime;
  });
}

export function normalizeConversationMessage(
  message: MobileConversationMessage,
): MobileConversationMessage {
  return {
    ...message,
    _id: getId(message._id),
  };
}

export function getDetailTitle(detail: MobileConversationDetail): string {
  const rename = asString(detail.rename);
  if (rename) return rename;
  const subject = asString(detail.subject);
  if (subject) return subject;
  const chatTitle = asString(detail.chat?.title);
  if (chatTitle) return chatTitle;
  const firstName = asString(detail.user?.firstName);
  const lastName = asString(detail.user?.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  if (fullName) return fullName;
  return `Conversation ${detail._id.slice(-6)}`;
}

export function formatMessageTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
