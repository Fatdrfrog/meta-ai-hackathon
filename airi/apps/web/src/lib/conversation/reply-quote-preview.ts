import {
  buildWhatsAppReplyTextPreview,
  extractWhatsAppWamidFingerprint,
  listWhatsAppMessageIdLookupKeys,
} from "@icecore/shared/lib/whatsapp/message-id";

type ReplyPreviewSource = {
  messageId?: string | number | null;
  text?: string | null;
  mediaType?: string | null;
};

/**
 * Build lookup maps so reply quotes can resolve parent text from messages
 * already loaded in the thread (no extra API).
 */
export function buildReplyQuotePreviewIndex(
  messages: readonly ReplyPreviewSource[]
): {
  byMessageId: Map<string, string>;
  byWhatsAppFingerprint: Map<string, string>;
} {
  const byMessageId = new Map<string, string>();
  const byWhatsAppFingerprint = new Map<string, string>();

  for (const message of messages) {
    const preview = buildWhatsAppReplyTextPreview(message);
    if (!preview) continue;

    if (typeof message.messageId === "number") {
      byMessageId.set(String(message.messageId), preview);
      continue;
    }

    if (typeof message.messageId !== "string" || !message.messageId.trim()) {
      continue;
    }

    const messageId = message.messageId.trim();
    byMessageId.set(messageId, preview);
    for (const key of listWhatsAppMessageIdLookupKeys(messageId)) {
      byMessageId.set(key, preview);
    }

    const fingerprint = extractWhatsAppWamidFingerprint(messageId);
    if (fingerprint) {
      byWhatsAppFingerprint.set(fingerprint, preview);
    }
  }

  return { byMessageId, byWhatsAppFingerprint };
}

export function resolveReplyQuotePreviewText(params: {
  storedPreview?: string | null;
  replyToMessageId?: string | null;
  index: {
    byMessageId: Map<string, string>;
    byWhatsAppFingerprint: Map<string, string>;
  };
  /** Last-resort label when parent is off-page and preview was never stored. */
  missingPreviewFallback?: string | null;
}): string | null {
  const stored =
    typeof params.storedPreview === "string"
      ? params.storedPreview.trim()
      : "";
  if (stored) return stored;

  const replyToMessageId =
    typeof params.replyToMessageId === "string"
      ? params.replyToMessageId.trim()
      : "";
  if (!replyToMessageId) return null;

  for (const key of [
    replyToMessageId,
    ...listWhatsAppMessageIdLookupKeys(replyToMessageId),
  ]) {
    const hit = params.index.byMessageId.get(key);
    if (hit) return hit;
  }

  const fingerprint = extractWhatsAppWamidFingerprint(replyToMessageId);
  if (fingerprint) {
    const twin = params.index.byWhatsAppFingerprint.get(fingerprint);
    if (twin) return twin;
  }

  const fallback =
    typeof params.missingPreviewFallback === "string"
      ? params.missingPreviewFallback.trim()
      : "";
  return fallback || null;
}
