import { normalizeWhatsAppPhone } from "./contact-identities";

/**
 * Contact-policy reservation key for one bulk campaign recipient. A later Meta
 * status for that send names the campaign and the phone, so it can find the
 * same key again.
 */
export function buildCampaignContactDeliveryKey(
  campaignId: string | null | undefined,
  phone: unknown,
): string | null {
  const id = String(campaignId || "").trim();
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  return id && normalizedPhone ? `campaign:${id}:${normalizedPhone}` : null;
}

/** Contact-policy reservation key for one campaign delivery task send. */
export function buildCampaignTaskContactDeliveryKey(taskId: string): string {
  return `campaign-task:${taskId}`;
}
