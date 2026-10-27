import { formatClientName } from "@/lib/date-utils";

const GROUP_CHAT_TYPES = new Set(["group", "supergroup", "channel"]);

type DisplayNameSource = {
  channel?: string;
  rename?: string | null;
  user?: Parameters<typeof formatClientName>[1] | null;
  chat?: (Parameters<typeof formatClientName>[3] & { type?: string }) | null;
};

/** Translated placeholders for a conversation nothing names yet. */
export type UnnamedConversationLabels = { customer: string; group: string };

export function isGroupLikeChatType(chatType?: string): boolean {
  return GROUP_CHAT_TYPES.has(chatType ?? "");
}

/**
 * The one title the inbox shows for an open conversation (header, info panel):
 * the manager's rename, a Telegram group's own title, else the client name,
 * else the translated placeholder. Not the CRM person name in
 * lib/customers/shared, which never falls back to ids or placeholders.
 */
export function getConversationTitle(
  { channel, rename, user, chat }: DisplayNameSource,
  unnamed: UnnamedConversationLabels
): string {
  const renamed = rename?.trim();
  if (renamed) return renamed;

  if (channel === "telegram" && isGroupLikeChatType(chat?.type)) {
    return chat?.title || chat?.first_name || user?.firstName || unnamed.group;
  }

  return (
    formatClientName(
      channel,
      user ?? undefined,
      undefined,
      chat ?? undefined
    ) || unnamed.customer
  );
}

/**
 * Avatar initials: the first letters of up to two words, else the first
 * letter or digit (phone-number names), else "?".
 */
export function getNameInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .map(word => Array.from(word)[0] ?? "")
    .filter(char => /\p{L}/u.test(char))
    .slice(0, 2)
    .join("");
  if (initials) return initials.toUpperCase();
  return Array.from(name).find(char => /[\p{L}\p{N}]/u.test(char)) ?? "?";
}
