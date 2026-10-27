import { parseWhatsAppName } from "@/lib/whatsapp/contact/utils";

const PHONE_LIKE_NAME = /^\+?\d{5,}$/;
/** The conversation field's length limit, as for a manager's rename. */
const MAX_CAMPAIGN_RECIPIENT_NAME_LENGTH = 120;

/**
 * True for what a contact holds when nobody named it: a blank, "Customer"
 * or the phone number a campaign stored in its place.
 */
export function isPlaceholderContactName(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const name = value.trim();
  return (
    !name ||
    name === "Customer" ||
    PHONE_LIKE_NAME.test(name.replace(/[\s()-]/g, ""))
  );
}

/**
 * The name a recipient file gives a row, with spacing tidied, or null when
 * it is a placeholder such as a phone number.
 */
export function parseCampaignRecipientName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (isPlaceholderContactName(name)) return null;
  const fullName = parseWhatsAppName(name).fullName;
  if (!fullName) return null;
  return Array.from(fullName)
    .slice(0, MAX_CAMPAIGN_RECIPIENT_NAME_LENGTH)
    .join("")
    .trim();
}
