import { createHash } from "node:crypto";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import { isWhatsAppRecoverableMessageContent } from "@icecore/shared/lib/whatsapp/webhook-automation-eligibility";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const document = value as { toObject?: () => RecordValue };
  return document.toObject ? document.toObject() : (value as RecordValue);
}

function stableJson(value: unknown): string {
  // Mongo documents may contain dates and optional fields; use their JSON view
  // before the shared bounded canonical serializer computes stable identity.
  return serializeCanonicalJson(JSON.parse(JSON.stringify(value ?? null)));
}

function confirmed(value: unknown): boolean {
  return value === "present" || value === "absent";
}

/** Stored messages default every referral field to null; only real facts count. */
export function hasWhatsAppReferralContent(referral: unknown): boolean {
  const fields = record(referral);
  return Boolean(
    fields &&
      Object.entries(fields).some(
        ([key, value]) =>
          key !== "capturedAt" &&
          ((typeof value === "string" && value.trim() !== "") ||
            (Array.isArray(value) && value.length > 0)),
      ),
  );
}

/** Preserve first-touch ownership and fill only missing facts for that source. */
export function mergeWhatsAppReferral(
  previous: unknown,
  incoming: unknown,
): RecordValue | null {
  const current = record(previous);
  const next = record(incoming);
  if (!next) return current;
  if (!hasWhatsAppReferralContent(next)) return current;
  if (!current) return { ...next };
  if (current.sourceId && current.sourceId !== next.sourceId) return current;
  if (
    !current.sourceId &&
    current.ctwaClid &&
    current.ctwaClid !== next.ctwaClid
  )
    return current;

  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (
      key === "campaignLabels" ||
      key === "campaignLabelStatus" ||
      key === "adAccountId"
    )
      continue;
    if (
      (merged[key] === undefined ||
        merged[key] === null ||
        merged[key] === "") &&
      value != null &&
      value !== ""
    ) {
      merged[key] = value;
    }
  }
  if (!confirmed(current.campaignLabelStatus)) {
    if (confirmed(next.campaignLabelStatus)) {
      merged.campaignLabels = next.campaignLabels;
      merged.campaignLabelStatus = next.campaignLabelStatus;
      merged.adAccountId = next.adAccountId || current.adAccountId || null;
    } else {
      if (!current.campaignLabelStatus && next.campaignLabelStatus) {
        merged.campaignLabelStatus = next.campaignLabelStatus;
      }
      if (
        !current.campaignLabels &&
        Array.isArray(next.campaignLabels) &&
        next.campaignLabels.length > 0
      ) {
        merged.campaignLabels = next.campaignLabels;
      }
      if (!current.adAccountId && next.adAccountId)
        merged.adAccountId = next.adAccountId;
    }
  } else if (
    !current.adAccountId &&
    next.adAccountId &&
    confirmed(next.campaignLabelStatus)
  ) {
    merged.adAccountId = next.adAccountId;
  }
  return merged;
}

export function getWhatsAppRecoverySourceMessage(
  rawSourcePayload: unknown,
): RecordValue | null {
  const payload = record(record(rawSourcePayload)?.payload);
  const direct =
    record(payload?.message) ||
    (typeof payload?.type === "string" ? payload : null);
  if (direct) return direct;
  if (Array.isArray(payload?.messages) && payload.messages.length === 1) {
    return record(payload.messages[0]);
  }
  // Live persistence keeps one entry envelope; history keeps payload.message.
  const entries = Array.isArray(payload?.entry)
    ? payload.entry
    : [payload?.entry];
  for (const entry of entries) {
    const changes = record(entry)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = record(record(change)?.value);
      const messages = value?.messages;
      if (Array.isArray(messages) && messages.length === 1)
        return record(messages[0]);
    }
  }
  return null;
}

const CONTENT_FIELDS = [
  "text",
  "rawSourcePayload",
  "imageUrl",
  "whatsappMediaId",
  "mediaType",
  "mimeType",
  "fileName",
  "fileSize",
  "whatsappFlowReply",
  "whatsappLocation",
  "whatsappContacts",
  "whatsappProductInquiry",
  "whatsappOrder",
  "whatsappMeta",
  "ragContext",
] as const;

export type WhatsAppRecoveryMessage = Partial<
  Record<(typeof CONTENT_FIELDS)[number], unknown>
> & {
  direction?: string;
  whatsappReferral?: unknown;
  whatsappRecoveryRevision?: string;
  editMeta?: unknown;
};

export function needsWhatsAppMessageRecovery(
  previous: WhatsAppRecoveryMessage,
  message: unknown,
): boolean {
  if (
    previous.direction !== "inbound" ||
    record(previous.editMeta)?.kind === "revoke"
  )
    return false;
  const current = getWhatsAppRecoverySourceMessage(previous.rawSourcePayload);
  return Boolean(
    isWhatsAppRecoverableMessageContent(message) &&
      (current?.type === "unsupported" || current?.type === "errors") &&
      !isWhatsAppRecoverableMessageContent(current) &&
      !record(previous.editMeta)?.kind,
  );
}

export function buildWhatsAppMessageRecovery(
  previous: WhatsAppRecoveryMessage,
  incoming: WhatsAppRecoveryMessage,
): RecordValue | null {
  if (
    previous.direction !== "inbound" ||
    record(previous.editMeta)?.kind === "revoke"
  )
    return null;
  const update: RecordValue = {};
  if (
    needsWhatsAppMessageRecovery(
      previous,
      getWhatsAppRecoverySourceMessage(incoming.rawSourcePayload),
    )
  ) {
    for (const field of CONTENT_FIELDS) {
      if (incoming[field] !== undefined) update[field] = incoming[field];
    }
  }
  const mergedReferral = mergeWhatsAppReferral(
    previous.whatsappReferral,
    incoming.whatsappReferral,
  );
  if (
    mergedReferral &&
    stableJson(mergedReferral) !== stableJson(previous.whatsappReferral)
  ) {
    update.whatsappReferral = mergedReferral;
  }
  if (Object.keys(update).length === 0) return null;

  update.whatsappRecoveryRevision = createHash("sha256")
    .update(
      stableJson({
        text: update.text ?? previous.text,
        message: getWhatsAppRecoverySourceMessage(
          update.rawSourcePayload ?? previous.rawSourcePayload,
        ),
        referral: update.whatsappReferral ?? previous.whatsappReferral,
      }),
    )
    .digest("hex");
  return update;
}

/** A losing writer re-reads and merges; it cannot overwrite a winning revision. */
export async function recoverWhatsAppMessage<T extends WhatsAppRecoveryMessage>(
  previous: T,
  incoming: WhatsAppRecoveryMessage,
  dependencies: {
    compareAndSwap: (previous: T, update: RecordValue) => Promise<T | null>;
    read: () => Promise<T | null>;
  },
): Promise<T> {
  let current = previous;
  for (let attempt = 0; attempt < 3; attempt++) {
    const update = buildWhatsAppMessageRecovery(current, incoming);
    if (!update) return current;
    const saved = await dependencies.compareAndSwap(current, update);
    if (saved) return saved;
    const latest = await dependencies.read();
    if (!latest) throw new Error("WhatsApp recovery target disappeared");
    current = latest;
  }
  throw new Error(
    "WhatsApp message recovery contention; retry the durable event",
  );
}
