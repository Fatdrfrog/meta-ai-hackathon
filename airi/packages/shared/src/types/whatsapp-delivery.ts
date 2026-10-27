export const WHATSAPP_DELIVERY_STATUSES = [
  "sent",
  "delivered",
  "read",
  "played",
  "failed",
] as const;

export const WHATSAPP_DELIVERY_EVENT_STATUSES = [
  ...WHATSAPP_DELIVERY_STATUSES,
  "unknown",
] as const;

export type WhatsAppDeliveryStatus =
  (typeof WHATSAPP_DELIVERY_STATUSES)[number];

export type WhatsAppDeliveryEventStatus =
  (typeof WHATSAPP_DELIVERY_EVENT_STATUSES)[number];

const WHATSAPP_DELIVERY_STATUS_PREDECESSORS: Record<
  WhatsAppDeliveryStatus,
  readonly WhatsAppDeliveryStatus[]
> = {
  sent: [],
  delivered: ["sent"],
  read: ["sent", "delivered"],
  played: ["sent", "delivered", "read"],
  failed: ["sent"],
};

export const WHATSAPP_CAMPAIGN_MESSAGE_STATUS_PREDECESSORS = {
  sent: ["pending", "attempted"],
  accepted: ["pending", "attempted", "sent"],
  delivered: ["pending", "attempted", "sent", "accepted"],
  read: ["pending", "attempted", "sent", "accepted", "delivered"],
  failed: ["pending", "attempted", "sent", "accepted"],
} as const;

export type WhatsAppCampaignMessageStatus =
  keyof typeof WHATSAPP_CAMPAIGN_MESSAGE_STATUS_PREDECESSORS;

export function normalizeWhatsAppDeliveryStatus(
  status: unknown,
): WhatsAppDeliveryStatus | null {
  if (typeof status !== "string") return null;
  const normalized = status.trim().toLowerCase();
  return (WHATSAPP_DELIVERY_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as WhatsAppDeliveryStatus)
    : null;
}

/**
 * Meta can deliver status webhooks out of order. Successful delivery and
 * failure are mutually terminal branches; raw events remain available for
 * audit even when the canonical message state does not change.
 */
export function shouldAdvanceWhatsAppDeliveryStatus(params: {
  currentStatus: unknown;
  incomingStatus: unknown;
}): boolean {
  const incoming = normalizeWhatsAppDeliveryStatus(params.incomingStatus);
  if (!incoming) return false;

  const current = normalizeWhatsAppDeliveryStatus(params.currentStatus);
  if (!current) return true;
  if (current === incoming) return true;

  return WHATSAPP_DELIVERY_STATUS_PREDECESSORS[incoming].includes(current);
}
