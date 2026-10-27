export type CampaignFillUpChannel = "whatsapp" | "telegram" | "email";

export type CampaignFillUpRecipient = {
  phone?: string;
  chatId?: string;
  email?: string;
  name?: string;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
};

export type CampaignFillUpMergeResult<T extends CampaignFillUpRecipient> = {
  recipients: T[];
  acceptedFillUpCount: number;
  duplicateFillUpCount: number;
  invalidFillUpCount: number;
  truncatedFillUpCount: number;
};

export type CampaignFillUpCapacity = {
  remainingCapacity: number;
  acceptedFillUpCount: number;
  truncatedFillUpCount: number;
};

function normalizeMaxRecipients(value: unknown): number {
  if (value === undefined || value === null) return Number.POSITIVE_INFINITY;
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  if (parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeWhatsAppRecipientKey(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^wa_/i, "")
    .replace(/\D/g, "");
}

export function getCampaignRecipientIdentity(
  recipient: CampaignFillUpRecipient,
  channel: CampaignFillUpChannel
): string | null {
  if (channel === "whatsapp") {
    const phone = normalizeWhatsAppRecipientKey(recipient.phone);
    return phone ? `whatsapp:${phone}` : null;
  }
  if (channel === "telegram") {
    const chatId = String(recipient.chatId || recipient.phone || "").trim();
    return chatId ? `telegram:${chatId}` : null;
  }

  const email = String(recipient.email || "")
    .trim()
    .toLowerCase();
  return email ? `email:${email}` : null;
}

export function mergeCampaignRecipientsWithFillUp<
  T extends CampaignFillUpRecipient,
>(params: {
  channel: CampaignFillUpChannel;
  baseRecipients: T[];
  fillUpRecipients: T[];
  maxRecipients?: number | null;
}): CampaignFillUpMergeResult<T> {
  const maxRecipients = normalizeMaxRecipients(params.maxRecipients);
  const recipients: T[] = [];
  const seen = new Set<string>();

  for (const recipient of params.baseRecipients) {
    if (recipients.length >= maxRecipients) break;
    const identity = getCampaignRecipientIdentity(recipient, params.channel);
    if (identity) seen.add(identity);
    recipients.push(recipient);
  }

  let acceptedFillUpCount = 0;
  let duplicateFillUpCount = 0;
  let invalidFillUpCount = 0;
  let truncatedFillUpCount = 0;

  for (const recipient of params.fillUpRecipients) {
    const identity = getCampaignRecipientIdentity(recipient, params.channel);
    if (!identity) {
      invalidFillUpCount += 1;
      continue;
    }
    if (seen.has(identity)) {
      duplicateFillUpCount += 1;
      continue;
    }
    if (recipients.length >= maxRecipients) {
      truncatedFillUpCount += 1;
      continue;
    }

    seen.add(identity);
    recipients.push(recipient);
    acceptedFillUpCount += 1;
  }

  return {
    recipients,
    acceptedFillUpCount,
    duplicateFillUpCount,
    invalidFillUpCount,
    truncatedFillUpCount,
  };
}

export function resolveCampaignFillUpCapacity(params: {
  baseRecipientCount: number;
  fillUpRecipientCount: number;
  maxRecipients?: number | null;
}): CampaignFillUpCapacity {
  const maxRecipients = normalizeMaxRecipients(params.maxRecipients);
  const remainingCapacity = Number.isFinite(maxRecipients)
    ? Math.max(0, maxRecipients - Math.max(0, params.baseRecipientCount))
    : Math.max(0, params.fillUpRecipientCount);
  const acceptedFillUpCount = Math.min(
    Math.max(0, params.fillUpRecipientCount),
    remainingCapacity
  );

  return {
    remainingCapacity,
    acceptedFillUpCount,
    truncatedFillUpCount: Math.max(
      0,
      Math.max(0, params.fillUpRecipientCount) - acceptedFillUpCount
    ),
  };
}
