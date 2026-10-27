import type { WhatsAppStoredMessageMeta } from "../../types/whatsapp-message-meta";

export function normalizeWhatsAppMessageId(messageId: string): string {
  if (!messageId) return messageId;
  return messageId.startsWith("ws_") ? messageId : `ws_${messageId}`;
}

/** Enroll a newly inserted inbound message in the workspace dedupe index. */
export function buildWhatsAppInboundDedupeKey(message: {
  channel?: unknown;
  direction?: unknown;
  workspaceId?: unknown;
  messageId?: unknown;
}): string | undefined {
  if (
    message.channel !== "whatsapp" ||
    message.direction !== "inbound" ||
    typeof message.workspaceId !== "string" ||
    !message.workspaceId.trim() ||
    typeof message.messageId !== "string" ||
    !message.messageId.trim()
  ) return undefined;
  return normalizeWhatsAppMessageId(message.messageId.trim());
}

export function stripWhatsAppMessageIdPrefix(
  messageId: string | null | undefined
): string {
  if (!messageId) return "";
  return messageId.startsWith("ws_") ? messageId.slice(3) : messageId;
}

/**
 * Strip internal `ws_` storage prefix for Graph API / Meta wire payloads.
 * Outbound contextual replies use `context.message_id` with a raw `wamid.…`.
 */
export function toWhatsAppGraphMessageId(
  messageId?: string | null
): string | undefined {
  if (typeof messageId !== "string") return undefined;
  const stripped = stripWhatsAppMessageIdPrefix(messageId.trim());
  return stripped || undefined;
}

/**
 * Lookup keys for the same WhatsApp message id with/without the `ws_` prefix.
 */
export function listWhatsAppMessageIdLookupKeys(
  messageId: string | null | undefined
): string[] {
  if (!messageId) return [];
  const normalized = normalizeWhatsAppMessageId(messageId);
  const stripped = stripWhatsAppMessageIdPrefix(messageId);
  return Array.from(
    new Set([messageId, normalized, stripped].filter(Boolean))
  );
}

/**
 * Stable fingerprint shared across phone-encoded and BSUID-encoded wamid twins.
 * Meta may cite a BSUID-form context.id while we stored the phone-form wamid.
 *
 * Note: this hex is decoded from the wamid payload — it is NOT a substring of the
 * base64 `messageId` string, so Mongo `$regex` on `messageId` cannot find twins.
 */
export function extractWhatsAppWamidFingerprint(
  messageId: string | null | undefined
): string | null {
  if (!messageId) return null;
  const raw = stripWhatsAppMessageIdPrefix(messageId).replace(
    /^wamid\./i,
    ""
  );
  if (!raw) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64").toString("latin1");
  } catch {
    return null;
  }

  // Prefer the trailing hex run (>=20 chars) so BSUID digit runs are ignored.
  const runs = [...decoded.matchAll(/[0-9A-Fa-f]{20,}/g)].map(
    match => match[0]
  );
  if (runs.length === 0) return null;
  return runs[runs.length - 1]!.toUpperCase();
}

/** The part of the Message model a context lookup reads. */
export type WhatsAppContextMessageModel = {
  findOne(filter: Record<string, unknown>): {
    select(fields: string): { lean(): PromiseLike<unknown> };
  };
};

/**
 * Find the conversation message a WhatsApp `context.id` cites: the same id
 * with or without the `ws_` prefix, or its phone/BSUID twin through the
 * indexed `whatsappWamidFingerprint`.
 */
export async function findWhatsAppContextMessage<T>(params: {
  Message: WhatsAppContextMessageModel;
  conversationId: unknown;
  contextMessageId: string | null | undefined;
  direction?: "inbound" | "outbound";
  select: string;
}): Promise<T | null> {
  const contextMessageId =
    typeof params.contextMessageId === "string"
      ? params.contextMessageId.trim()
      : "";
  if (!contextMessageId || !params.conversationId) return null;
  const fingerprint = extractWhatsAppWamidFingerprint(contextMessageId);
  const message = await params.Message.findOne({
    conversation: params.conversationId,
    channel: "whatsapp",
    ...(params.direction ? { direction: params.direction } : {}),
    $or: [
      { messageId: { $in: listWhatsAppMessageIdLookupKeys(contextMessageId) } },
      ...(fingerprint ? [{ whatsappWamidFingerprint: fingerprint }] : []),
    ],
  })
    .select(params.select)
    .lean();
  return (message ?? null) as T | null;
}

/**
 * Test/helper: match phone↔BSUID twins in an already-loaded candidate list.
 * Production lookups use `findWhatsAppContextMessage` and its indexed
 * `whatsappWamidFingerprint` query — do not load whole conversations for this.
 */
export function findWhatsAppMessageByWamidFingerprint<
  T extends { messageId?: string | null },
>(
  candidates: readonly T[],
  contextMessageId: string | null | undefined
): T | null {
  const fingerprint = extractWhatsAppWamidFingerprint(contextMessageId);
  if (!fingerprint) return null;

  for (const candidate of candidates) {
    if (
      extractWhatsAppWamidFingerprint(candidate.messageId) === fingerprint
    ) {
      return candidate;
    }
  }

  return null;
}

export function buildWhatsAppReplyTextPreview(parent: {
  text?: string | null;
  mediaType?: string | null;
}): string | null {
  const text = sanitizeWhatsAppUserFacingText(parent.text);
  if (text) return text;

  const mediaType =
    typeof parent.mediaType === "string" ? parent.mediaType.trim() : "";
  if (mediaType) return `[${mediaType} attachment]`;

  return null;
}

/**
 * Strip internal storage markers (template name prefix, location marker,
 * scenario node / template variable payloads) that never belong in chat UI.
 */
export function sanitizeWhatsAppUserFacingText(
  text: string | null | undefined,
): string {
  if (typeof text !== "string") return "";
  let next = text
    .trim()
    .replace(/^\[Template:\s*[^\]]+\]\s*/i, "")
    .trim();
  if (/^with variables:\s*/i.test(next)) return "";
  next = next.replace(/^\[Location\]\s*/i, "").trim();
  if (/^\[?"?stb:node-/i.test(next) || /"stb:node-/i.test(next)) return "";
  return next;
}

export function buildWhatsAppStoredReplyMeta(params: {
  replyToMessageId: string;
  parent?: {
    text?: string | null;
    mediaType?: string | null;
  } | null;
}): WhatsAppStoredMessageMeta {
  return {
    replyToWhatsAppMessageId: normalizeWhatsAppMessageId(
      params.replyToMessageId
    ),
    replyToTextPreview: params.parent
      ? buildWhatsAppReplyTextPreview(params.parent)
      : null,
  };
}
