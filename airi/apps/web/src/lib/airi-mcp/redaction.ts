import { normalizeLooseString } from "@icecore/shared/lib/value-utils";
import { resolveStoredWhatsAppRecipientTarget } from "@icecore/shared/lib/whatsapp/contact-identities";
import type { AiriMcpConversationBundle } from "./types";

const PHONE_MASK = "****";
/** Hidden digits a masked number must keep before its prefix is shown. */
const MIN_HIDDEN_PHONE_DIGITS = 6;

/**
 * Masks canonical phone digits to "+<country code>****<last 2>". There is no
 * calling-code table in the repo, so the visible prefix is one digit for the
 * +1/+7 zones and two otherwise; numbers too short to keep six digits hidden
 * show only their last two digits.
 */
export function maskPhoneDigits(digits: string): string | null {
  if (!/^\d{6,15}$/.test(digits)) return null;
  const suffix = digits.slice(-2);
  const prefixLength = /^[17]/.test(digits) ? 1 : 2;
  if (digits.length - prefixLength - 2 < MIN_HIDDEN_PHONE_DIGITS) {
    return `${PHONE_MASK}${suffix}`;
  }
  return `+${digits.slice(0, prefixLength)}${PHONE_MASK}${suffix}`;
}

/**
 * The masked phone of a WhatsApp conversation, resolved the same way sends
 * resolve their recipient. Business-scoped user ids are not phone numbers
 * and other channels have no phone, so both give null.
 */
export function maskConversationPhone(
  bundle: AiriMcpConversationBundle
): string | null {
  if (bundle.conversation.channel !== "whatsapp") return null;
  const target = resolveStoredWhatsAppRecipientTarget(
    bundle.user,
    bundle.chat,
    bundle.conversation.user,
    bundle.conversation.chat
  );
  return target?.kind === "phone" ? maskPhoneDigits(target.value) : null;
}

function cutToLength(text: string, maxLength: number): string {
  const codePoints = Array.from(text);
  return codePoints.length > maxLength
    ? `${codePoints.slice(0, maxLength - 1).join("")}…`
    : text;
}

/** Whitespace-collapsed text cut to `maxLength` code points, or null. */
export function boundedText(value: unknown, maxLength: number): string | null {
  const text = normalizeLooseString(value);
  return text ? cutToLength(text, maxLength) : null;
}

/** Like {@link boundedText} but keeps line breaks (template bodies). */
export function boundedMultilineText(
  value: unknown,
  maxLength: number
): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? cutToLength(text, maxLength) : null;
}

export function boundedTextList(
  value: unknown,
  maxItems: number,
  maxLength: number
): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry, maxLength);
    if (text && !items.includes(text)) items.push(text);
    if (items.length >= maxItems) break;
  }
  return items;
}
