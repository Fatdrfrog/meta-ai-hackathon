import type { MessageDTO } from "./message";

export const CONVERSATION_STATUSES = ["open", "in_progress", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_PREFERRED_LANGUAGES = [
  "en",
  "ru",
  "kz",
  "uz",
] as const;
export type ConversationPreferredLanguage =
  (typeof CONVERSATION_PREFERRED_LANGUAGES)[number];

export const CONVERSATION_CUSTOMER_LANGUAGE_SOURCES = [
  "explicit",
  "heuristic",
  "workspace_bias",
  "dominant_recent",
  "google_cloud",
] as const;
export type ConversationCustomerLanguageSource =
  (typeof CONVERSATION_CUSTOMER_LANGUAGE_SOURCES)[number];

export function isConversationStatus(
  value: unknown,
): value is ConversationStatus {
  return (
    typeof value === "string" &&
    (CONVERSATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isConversationPreferredLanguage(
  value: unknown,
): value is ConversationPreferredLanguage {
  return (
    typeof value === "string" &&
    (CONVERSATION_PREFERRED_LANGUAGES as readonly string[]).includes(value)
  );
}

export function normalizeConversationPreferredLanguage(
  value: unknown,
): ConversationPreferredLanguage | null {
  if (typeof value !== "string") return null;

  const [rawBase = ""] = value.trim().toLowerCase().split(/[-_]/u);
  const base = rawBase === "kk" ? "kz" : rawBase;
  return isConversationPreferredLanguage(base) ? base : null;
}

export interface ConversationDTO {
  id: string;
  status: ConversationStatus;
  lastMessageAt: string; // ISO string
  messages: MessageDTO[];
}
