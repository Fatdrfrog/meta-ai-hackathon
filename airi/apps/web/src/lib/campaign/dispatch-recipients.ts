import { asNullableRecord } from "@icecore/shared/lib/value-utils";
import { normalizeCampaignEmail } from "./campaign-recipient-utils";

type ConversationRecipientShape = {
  user?: unknown;
  chat?: unknown;
  participants?: {
    from?: unknown;
    to?: unknown;
  };
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export function isPhoneLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("wa_bsuid_")) return false;
  if (trimmed.startsWith("wa_")) return true;
  if (!/^[+\d][\d\s().-]{6,}$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 16;
}

export function resolveRecipientFromConversation(
  conversation: unknown
): string | null {
  const payload = asNullableRecord(
    conversation
  ) as ConversationRecipientShape | null;
  if (!payload) return null;

  const candidates: unknown[] = [
    payload.user,
    (payload.user as { _id?: unknown } | null | undefined)?._id,
    payload.chat,
    (payload.chat as { _id?: unknown } | null | undefined)?._id,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const asString = String(candidate).trim();
    if (!asString) continue;
    if (isPhoneLike(asString)) return asString;
  }

  return null;
}

export function resolveEmailRecipientFromConversation(
  conversation: unknown,
  fromAddress?: string
): string | null {
  const payload = asNullableRecord(
    conversation
  ) as ConversationRecipientShape | null;
  if (!payload) return null;

  const sender = normalizeCampaignEmail(fromAddress);
  const fromCandidates = Array.isArray(payload.participants?.from)
    ? payload.participants.from
    : [];
  const toCandidates = Array.isArray(payload.participants?.to)
    ? payload.participants.to
    : [];
  const candidates = [...fromCandidates, ...toCandidates];

  for (const raw of candidates) {
    const email = normalizeCampaignEmail(raw);
    if (!email || !EMAIL_REGEX.test(email)) continue;
    if (sender && email === sender) continue;
    return email;
  }

  return null;
}
