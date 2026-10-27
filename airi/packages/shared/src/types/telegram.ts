export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export interface TelegramStoredMessageMeta {
  /** Business connection actually used for the provider send; null means bot transport. */
  businessConnectionId?: string | null;
  senderDisplayName?: string | null;
  senderChatId?: string | null;
  senderChatTitle?: string | null;
  senderChatType?: TelegramChatType | null;
  authorSignature?: string | null;
  senderTag?: string | null;
  messageThreadId?: number | null;
  isTopicMessage?: boolean | null;
  replyToTelegramMessageId?: string | null;
  replyToTextPreview?: string | null;
}
