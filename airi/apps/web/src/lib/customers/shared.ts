import {
  normalizeLooseString,
  normalizePhone,
  normalizeWhitespace,
} from "@icecore/shared/lib/value-utils";
import { getCurrentConversationClassification } from "@icecore/shared/lib/conversation-classification-freshness";
import { INSTAGRAM_USER_PLACEHOLDER } from "@/lib/instagram/user-placeholder";

export { normalizeLooseString, normalizePhone };

type ConversationLike = {
  _id?: unknown;
  channel?: string | null;
  user?: unknown;
  chat?: unknown;
  visitor_id?: string | null;
  sourceId?: string | null;
  rename?: string | null;
  preferred_language?: string | null;
  classification?: {
    category?: string | null;
    sentiment?: string | null;
    tags?: string[] | null;
  } | null;
  is_classified?: boolean | null;
  classification_revision?: number | null;
  classification_state?: {
    contractVersion?: number | null;
    status?: string | null;
    requestedRevision?: number | null;
    appliedRevision?: number | null;
  } | null;
  classification_meta?: {
    source_revision?: number | null;
    provenance_kind?: string | null;
    analysis_revision_id?: string | null;
  } | null;
  internal_labels?: string[] | null;
  page_url?: string | null;
  lastMessageAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

type UserLike = {
  _id?: unknown;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  email?: string | null;
  whatsapp?: { profileName?: string | null } | null;
};

type ChatLike = {
  _id?: unknown;
  title?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  whatsapp?: { profileName?: string | null } | null;
};

export type CustomerSuggestionReason = {
  code:
    | "exact_visitor"
    | "same_channel_user"
    | "same_channel_chat"
    | "phone"
    | "email"
    | "username"
    | "same_name_source"
    | "same_name_recent";
  label: string;
  weight: number;
};

const MAX_TO_STRING_ID_DEPTH = 32;

/**
 * Resolves Mongo-style ids (string, ObjectId, `{ _id }` wrappers) to a trimmed string.
 * Bounded recursion: malformed or circular `_id` chains (seen in some lean/populate payloads)
 * cannot blow the stack.
 */
export function toStringId(value: unknown, depth = 0): string | null {
  if (value === null || value === undefined) return null;
  if (depth > MAX_TO_STRING_ID_DEPTH) return null;

  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value === "object" && value !== null) {
    if (
      "toHexString" in value &&
      typeof (value as { toHexString?: unknown }).toHexString === "function"
    ) {
      try {
        const hex = (value as { toHexString: () => string }).toHexString();
        const normalized = String(hex).trim();
        return normalized.length > 0 ? normalized : null;
      } catch {
        // fall through to _id / toString
      }
    }

    if ("_id" in value) {
      const inner = (value as { _id?: unknown })._id;
      if (inner === value) return null;
      return toStringId(inner, depth + 1);
    }

    if ("toString" in value) {
      const normalized = String(value).trim();
      return normalized.length > 0 ? normalized : null;
    }
  }

  return null;
}

/**
 * `$in` values for User and Chat ids. Those `_id`s are Mixed (numbers for
 * Telegram and Instagram, strings for WhatsApp) and Mongoose does not cast
 * them, so a stringified 123 never matches a stored 123: keep each id's type.
 */
export function mixedIdLookupValues(
  ids: readonly unknown[]
): Array<string | number> {
  const values = new Map<string, string | number>();
  for (const id of ids) {
    if (typeof id === "number") {
      if (Number.isFinite(id)) values.set(`n:${id}`, id);
      continue;
    }
    const value = toStringId(id);
    if (value) values.set(`s:${value}`, value);
  }
  return [...values.values()];
}

export function buildConversationSeedKey(
  conversation: ConversationLike
): string {
  const channel = normalizeLooseString(conversation.channel) || "unknown";
  const visitorId = normalizeLooseString(conversation.visitor_id);
  const userId = toStringId(conversation.user);
  const chatId = toStringId(conversation.chat);
  const fallbackId = toStringId(conversation._id) || "unknown";

  return [
    channel.toLowerCase(),
    visitorId || userId || chatId || fallbackId,
  ].join(":");
}

export function isProbablyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function normalizeEmail(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

export function normalizeUsername(value: string): string {
  return normalizeWhitespace(value).replace(/^@+/, "").toLowerCase();
}

export function getConversationStage(
  conversation: ConversationLike
): string | null {
  const manualStage = getManualConversationStage(conversation);
  if (manualStage) return manualStage;

  const classification = getCurrentConversationClassification<{
    category?: string | null;
  }>(conversation);
  return normalizeLooseString(classification?.category) || null;
}

export function getManualConversationStage(
  conversation: ConversationLike
): string | null {
  const labels = Array.isArray(conversation.internal_labels)
    ? conversation.internal_labels
    : [];
  for (const label of labels) {
    const normalized = normalizeLooseString(label)?.toLowerCase();
    if (!normalized) continue;
    if (normalized.startsWith("stage:")) {
      return normalized.slice("stage:".length).trim() || null;
    }
  }
  for (const label of labels) {
    const normalized = normalizeLooseString(label)?.toLowerCase();
    if (!normalized) continue;
    if (normalized.startsWith("seg:")) {
      return normalized.slice("seg:".length).trim() || null;
    }
  }
  return null;
}

export function getCrmPipelineStageFromConversation(
  conversation: ConversationLike
): string | null {
  const labels = Array.isArray(conversation.internal_labels)
    ? conversation.internal_labels
    : [];
  for (const label of labels) {
    const normalized = normalizeLooseString(label)?.toLowerCase();
    if (!normalized?.startsWith("stage:")) continue;
    const key = normalized.slice("stage:".length).trim();
    if (key) return key;
  }
  return null;
}

/**
 * The person's name for a conversation, or null while none is known.
 * Never a synthetic `<channel>:<id>` label: stored as the lead name, it
 * showed in the CRM and blocked real names from registrations and imports,
 * which only fill an empty name.
 */
export function getConversationDisplayName(params: {
  conversation: ConversationLike;
  user?: UserLike | null;
  chat?: ChatLike | null;
}): string | null {
  const rename = normalizeLooseString(params.conversation.rename);
  if (rename) return rename;

  const userFirstRaw = normalizeLooseString(params.user?.firstName);
  const userFirst =
    userFirstRaw === INSTAGRAM_USER_PLACEHOLDER ? null : userFirstRaw;
  const userLast = normalizeLooseString(params.user?.lastName);
  const userFull = normalizeWhitespace(
    [userFirst || "", userLast || ""].filter(Boolean).join(" ")
  );
  if (userFull) return userFull;

  const whatsAppProfileName =
    normalizeLooseString(params.user?.whatsapp?.profileName) ||
    normalizeLooseString(params.chat?.whatsapp?.profileName);
  if (whatsAppProfileName) return whatsAppProfileName;

  const chatTitle = normalizeLooseString(params.chat?.title);
  if (chatTitle) return chatTitle;

  const chatFull = normalizeWhitespace(
    [
      normalizeLooseString(params.chat?.first_name) || "",
      normalizeLooseString(params.chat?.last_name) || "",
    ]
      .filter(Boolean)
      .join(" ")
  );
  if (chatFull) return chatFull;

  const username =
    normalizeLooseString(params.user?.username) ||
    normalizeLooseString(params.chat?.username);
  if (username) return username;

  return null;
}

function toTimestamp(value: unknown): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function scoreCustomerSuggestion(input: {
  sameVisitorId: boolean;
  sameChannelUser: boolean;
  sameChannelChat: boolean;
  matchingPhones: string[];
  matchingEmails: string[];
  matchingUsernames: string[];
  sameDisplayName: boolean;
  sameSourceId: boolean;
  sourceLastActivity?: unknown;
  candidateLastActivity?: unknown;
}): { score: number; reasons: CustomerSuggestionReason[] } {
  const reasons: CustomerSuggestionReason[] = [];

  if (input.sameVisitorId) {
    reasons.push({
      code: "exact_visitor",
      label: "Same widget visitor identifier",
      weight: 100,
    });
  }
  if (input.sameChannelUser) {
    reasons.push({
      code: "same_channel_user",
      label: "Same channel user identifier",
      weight: 95,
    });
  }
  if (input.sameChannelChat) {
    reasons.push({
      code: "same_channel_chat",
      label: "Same channel chat identifier",
      weight: 90,
    });
  }
  if (input.matchingPhones.length > 0) {
    reasons.push({
      code: "phone",
      label: "Matching normalized phone number",
      weight: 88,
    });
  }
  if (input.matchingEmails.length > 0) {
    reasons.push({
      code: "email",
      label: "Matching email address",
      weight: 86,
    });
  }
  if (input.matchingUsernames.length > 0) {
    reasons.push({
      code: "username",
      label: "Matching username or handle",
      weight: 60,
    });
  }

  const sourceLast = toTimestamp(input.sourceLastActivity);
  const candidateLast = toTimestamp(input.candidateLastActivity);
  const daysApart =
    sourceLast !== null && candidateLast !== null
      ? Math.abs(sourceLast - candidateLast) / (1000 * 60 * 60 * 24)
      : null;

  if (input.sameDisplayName && input.sameSourceId) {
    reasons.push({
      code: "same_name_source",
      label: "Same display name on the same source",
      weight: 35,
    });
  } else if (
    input.sameDisplayName &&
    daysApart !== null &&
    Number.isFinite(daysApart) &&
    daysApart <= 30
  ) {
    reasons.push({
      code: "same_name_recent",
      label: "Same display name with close activity dates",
      weight: 20,
    });
  }

  const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  return { score, reasons };
}
