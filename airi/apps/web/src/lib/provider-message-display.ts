import type { RawSourcePayload } from "@icecore/shared/lib/raw-source-payload";
import { isWhatsAppUnavailableMessage } from "@icecore/shared/lib/whatsapp/webhook-automation-eligibility";
import {
  readNonEmptyStringOrUndefined as toOptionalString,
  toArray,
} from "@icecore/shared/lib/value-utils";

export const INSTAGRAM_STORY_MENTION_DISPLAY_TEXT = "Tagged in Instagram story";
/** Text the Instagram ingest stores in place of what the customer sent. */
const INSTAGRAM_LABELS = {
  deleted: "Instagram message deleted",
  unsupported: "Unsupported Instagram message",
  storyMention: INSTAGRAM_STORY_MENTION_DISPLAY_TEXT,
  reelShare: "Shared Instagram reel",
  share: "Shared Instagram content",
  ephemeral: "Ephemeral Instagram media",
} as const;
const INSTAGRAM_LABEL_TEXTS = new Set<string>(Object.values(INSTAGRAM_LABELS));
export const WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT =
  "[WhatsApp message unavailable through Meta API]";

export type ProviderMessageMediaType = "image" | "video" | "audio" | "file";

export interface ProviderMessageContent {
  text: string;
  imageUrl?: string;
  mediaType?: ProviderMessageMediaType;
  suppressGeneralAutoReply?: boolean;
  shouldDetectLanguage?: boolean;
  shouldQueueAiri?: boolean;
  providerEventKind?:
    | "instagram_deleted"
    | "instagram_unsupported"
    | "instagram_story_mention"
    | "instagram_reel_share"
    | "instagram_share"
    | "instagram_ephemeral";
}

export interface ProviderMessageDisplayOverride {
  text?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getObjectField(
  value: Record<string, unknown> | null,
  field: string
): Record<string, unknown> | null {
  return asRecord(value?.[field]);
}

/**
 * Whether a webhook attachment URL points at Meta's media CDN, as opposed to
 * an instagram.com page (a shared reel or post).
 */
export function isInstagramCdnMediaUrl(value: string | null | undefined) {
  let url: URL;
  try {
    url = new URL(value || "");
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    (host === "lookaside.fbsbx.com" ||
      host.endsWith(".fbcdn.net") ||
      host.endsWith(".cdninstagram.com"))
  );
}

/**
 * Whether stored text is one of those labels (a shared link may follow it),
 * not words the customer typed or said.
 */
export function isProviderLabelText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const firstLine = value.trim().split("\n", 1)[0] ?? "";
  return INSTAGRAM_LABEL_TEXTS.has(firstLine.trim());
}

/** A label with the shared page's link under it, for the thread to link. */
function withSharedLink(label: string, url: string | undefined): string {
  return url ? `${label}\n${url}` : label;
}

export function resolveInstagramMessageContent(
  message: unknown
): ProviderMessageContent {
  const messageRecord = asRecord(message);
  if (messageRecord?.is_deleted === true) {
    return {
      text: INSTAGRAM_LABELS.deleted,
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      shouldQueueAiri: false,
      providerEventKind: "instagram_deleted",
    };
  }
  if (messageRecord?.is_unsupported === true) {
    return {
      text: INSTAGRAM_LABELS.unsupported,
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      shouldQueueAiri: false,
      providerEventKind: "instagram_unsupported",
    };
  }

  const text = toOptionalString(messageRecord?.text) || "";
  if (text) {
    return { text };
  }

  const attachments = toArray(messageRecord?.attachments);
  const attachment = asRecord(attachments[0]);
  if (!attachment) {
    return { text: "" };
  }

  const rawType = (toOptionalString(attachment.type) || "").toLowerCase();
  const payload = getObjectField(attachment, "payload");
  const imageUrl = toOptionalString(payload?.url);

  if (rawType === "story_mention") {
    return {
      text: INSTAGRAM_LABELS.storyMention,
      ...(imageUrl ? { imageUrl } : {}),
      mediaType: "image",
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      providerEventKind: "instagram_story_mention",
    };
  }

  if (rawType === "ig_reel" || rawType === "reel") {
    // Instagram links a shared reel's page, not its video file.
    const isMedia = isInstagramCdnMediaUrl(imageUrl);
    return {
      text: withSharedLink(
        INSTAGRAM_LABELS.reelShare,
        isMedia ? undefined : imageUrl
      ),
      ...(isMedia ? { imageUrl, mediaType: "video" as const } : {}),
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      providerEventKind: "instagram_reel_share",
    };
  }

  if (rawType === "share") {
    return {
      text: withSharedLink(INSTAGRAM_LABELS.share, imageUrl),
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      providerEventKind: "instagram_share",
    };
  }

  if (rawType === "ephemeral") {
    return {
      text: INSTAGRAM_LABELS.ephemeral,
      suppressGeneralAutoReply: true,
      shouldDetectLanguage: false,
      shouldQueueAiri: false,
      providerEventKind: "instagram_ephemeral",
    };
  }

  const mediaType =
    rawType === "image" || rawType === "video" || rawType === "audio"
      ? rawType
      : "file";

  return {
    text: `[${mediaType} attachment]`,
    ...(imageUrl ? { imageUrl } : {}),
    mediaType,
  };
}

function getErrorCode(error: unknown): number | null {
  const record = asRecord(error);
  const code = record?.code;
  if (typeof code === "number" && Number.isFinite(code)) {
    return code;
  }
  if (typeof code === "string") {
    const parsed = Number(code);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isWhatsAppApiUnavailableUnsupportedMessage(
  message: unknown
): boolean {
  const messageRecord = asRecord(message);
  const type = (toOptionalString(messageRecord?.type) || "").toLowerCase();
  if (type !== "unsupported" && type !== "errors") {
    return false;
  }

  const hasUnsupportedTypeError = toArray(messageRecord?.errors).some(
    error => getErrorCode(error) === 131051
  );
  if (!hasUnsupportedTypeError) return false;

  const unsupported = getObjectField(messageRecord, "unsupported");
  const unsupportedType = (
    toOptionalString(unsupported?.type) || ""
  ).toLowerCase();
  return !unsupportedType || unsupportedType === "unknown";
}

function getWhatsAppMessagesFromValue(value: unknown): unknown[] {
  const valueRecord = asRecord(value);
  if (!valueRecord) return [];

  for (const key of [
    "messages",
    "message_echoes",
    "smb_message_echoes",
    "message",
  ]) {
    const messages = toArray(valueRecord[key]).filter(item => asRecord(item));
    if (messages.length > 0) return messages;
  }

  return [];
}

function extractWhatsAppWebhookMessages(payload: unknown): unknown[] {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) return [];

  const directMessages = getWhatsAppMessagesFromValue(payloadRecord);
  if (directMessages.length > 0) return directMessages;

  for (const entry of toArray(payloadRecord.entry)) {
    const entryRecord = asRecord(entry);
    if (!entryRecord) continue;

    for (const change of toArray(entryRecord.changes)) {
      const changeRecord = asRecord(change);
      const messages = getWhatsAppMessagesFromValue(changeRecord?.value);
      if (messages.length > 0) return messages;
    }
  }

  return [];
}

/** Only a persisted live inbound, never a display placeholder or history import. */
export function isWhatsAppUnavailableInboundSourcePayload(
  value: unknown
): boolean {
  const raw = asRecord(value);
  const payload = asRecord(raw?.payload);
  if (
    raw?.provider !== "whatsapp" ||
    raw.eventType !== "message" ||
    payload?.direction !== "inbound"
  )
    return false;
  const messages = extractWhatsAppWebhookMessages(payload);
  if (messages.length !== 1) return false;
  const message = asRecord(messages[0]);
  return isWhatsAppUnavailableMessage({
    type: toOptionalString(message?.type),
    errors: toArray(message?.errors).map(error => ({
      code: getErrorCode(error) ?? -1,
    })),
    unsupported: {
      type: toOptionalString(getObjectField(message, "unsupported")?.type),
    },
  });
}

export function getProviderMessageDisplayOverride(
  rawSourcePayload: RawSourcePayload | unknown
): ProviderMessageDisplayOverride | null {
  const raw = asRecord(rawSourcePayload);
  if (!raw) return null;

  const provider = (toOptionalString(raw.provider) || "").toLowerCase();
  const payload = raw.payload;

  if (provider === "instagram") {
    const payloadRecord = asRecord(payload);
    const content = resolveInstagramMessageContent(payloadRecord?.message);
    // Text only: the stored row holds the media copied off Meta's CDN, whose
    // webhook links expire within days.
    if (content.providerEventKind) {
      return { text: content.text };
    }
  }

  if (provider === "whatsapp") {
    const messages = extractWhatsAppWebhookMessages(payload);
    const hasApiUnavailableMessage = messages.some(message =>
      isWhatsAppApiUnavailableUnsupportedMessage(message)
    );
    if (hasApiUnavailableMessage) {
      return { text: WHATSAPP_API_UNAVAILABLE_MESSAGE_TEXT };
    }
  }

  return null;
}
