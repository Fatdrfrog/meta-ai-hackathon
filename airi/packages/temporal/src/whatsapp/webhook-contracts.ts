export const WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW =
  "whatsappWebhookProcessorWorkflow";
export const WHATSAPP_WEBHOOK_PROCESSOR_WORKFLOW_CONTRACT_VERSION = 1;
export const WHATSAPP_WEBHOOK_PROCESS_EVENT_SIGNAL =
  "whatsapp.webhook.processEvent";
export const WHATSAPP_WEBHOOK_PROCESS_EVENT_ACTIVITY =
  "whatsapp.webhook.processEvent";
export const WHATSAPP_WEBHOOK_DRAIN_WORKFLOW = "whatsappWebhookDrainWorkflow";
export const WHATSAPP_WEBHOOK_DRAIN_WORKFLOW_CONTRACT_VERSION = 1;
export const WHATSAPP_WEBHOOK_DRAIN_ACTIVITY = "whatsapp.webhook.drain";
export const WHATSAPP_WEBHOOK_DRAIN_SCHEDULE_ID =
  "whatsapp-webhook-events:drain";
export const WHATSAPP_WEBHOOK_DRAIN_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;
export const WHATSAPP_WEBHOOK_DRAIN_SCHEDULE_CATCHUP_WINDOW_MS = 15 * 60 * 1000;
export const WHATSAPP_WEBHOOK_DRAIN_DEFAULT_LIMIT = 50;
export const WHATSAPP_WEBHOOK_DRAIN_MAX_LIMIT = 500;
export const WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_TOPIC =
  "icecore-whatsapp-webhook-events";
/**
 * Customer-originated messages are latency-sensitive. They use a separate
 * topic so history imports and WhatsApp Business App echoes cannot delay the
 * inbox-visible path.
 */
export const WHATSAPP_FAST_WEBHOOK_PUBSUB_DEFAULT_TOPIC =
  "icecore-whatsapp-fast-events";
export const WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_TOPIC =
  "icecore-whatsapp-call-events";
export const WHATSAPP_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION =
  "icecore-whatsapp-webhook-events-worker";
export const WHATSAPP_FAST_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION =
  "icecore-whatsapp-fast-events-worker";
/**
 * Unordered copy of the fast topic. Pub/Sub re-creates ordering-key state for
 * a chat that has been quiet for a few minutes, holding its next message
 * 6-7 s; this lane processes a chat's head event at once and leaves the rest
 * to the ordered subscription.
 */
export const WHATSAPP_FAST_LANE_PUBSUB_DEFAULT_SUBSCRIPTION =
  "icecore-whatsapp-fast-events-unordered-worker";
export const WHATSAPP_CALL_WEBHOOK_PUBSUB_DEFAULT_SUBSCRIPTION =
  "icecore-whatsapp-call-events-worker";
export const WHATSAPP_WEBHOOK_ISOLATED_PROCESSOR_ITEM_KINDS = [
  "status",
  "error",
  "call",
  "history",
  "smb_app_state_sync",
  "message_echoes",
  "smb_message_echoes",
] as const;

const isolatedProcessorItemKindSet = new Set<string>(
  WHATSAPP_WEBHOOK_ISOLATED_PROCESSOR_ITEM_KINDS,
);

export type WhatsAppWebhookEventSignal = {
  contractVersion: number;
  eventId: string;
  dedupeKey: string;
  field: string;
  orderingKey: string;
  receivedAt: string;
};

export type WhatsAppWebhookPubSubMessage = Omit<
  WhatsAppWebhookEventSignal,
  "contractVersion"
> & {
  /**
   * Added after the original durable Pub/Sub contract. Consumers must accept
   * historic messages without it while publishers use it for lane selection.
   */
  itemKind?: string | null;
};

export type WhatsAppWebhookProcessorWorkflowInput = {
  contractVersion: number;
  routingKey: string;
  initialEvent?: WhatsAppWebhookEventSignal | null;
  processedCount?: number;
};

export type WhatsAppWebhookProcessEventActivityInput =
  WhatsAppWebhookEventSignal;

export type WhatsAppWebhookProcessEventActivityResult = {
  eventId: string;
  status: "completed" | "skipped";
  runtimeCode?: string | null;
};

export type WhatsAppWebhookRuntimeResult = {
  ok: boolean;
  code: string;
  message?: string | null;
  details?: Record<string, unknown> | null;
  retryable?: boolean;
};

export type WhatsAppWebhookProcessorWorkflowResult = {
  routingKey: string;
  processedCount: number;
};

export type WhatsAppWebhookDrainWorkflowInput = {
  contractVersion: number;
  limit?: number | null;
};

export type WhatsAppWebhookDrainActivityInput =
  WhatsAppWebhookDrainWorkflowInput;

export type WhatsAppWebhookDrainActivityResult = {
  scanned: number;
  queued: number;
  failed: number;
};

export type WhatsAppWebhookDrainWorkflowResult =
  WhatsAppWebhookDrainActivityResult;

export function sanitizeWhatsAppWebhookWorkflowIdPart(value: string): string {
  return String(value || "unknown")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

export function buildWhatsAppWebhookProcessorWorkflowId(
  routingKey: string,
): string {
  return `whatsapp-webhook:${sanitizeWhatsAppWebhookWorkflowIdPart(routingKey)}`;
}

export function shouldIsolateWhatsAppWebhookProcessorItemKind(
  itemKind?: string | null,
): boolean {
  return isolatedProcessorItemKindSet.has(String(itemKind || "").trim());
}

function readRequiredPubSubString(
  value: Record<string, unknown>,
  key: keyof WhatsAppWebhookPubSubMessage,
): string {
  const stringValue =
    typeof value[key] === "string" ? String(value[key]).trim() : "";
  if (!stringValue) {
    throw new Error(
      `Pub/Sub WhatsApp webhook message is missing required ${key}.`,
    );
  }
  return stringValue;
}

export function parseWhatsAppWebhookPubSubMessage(
  value: unknown,
): WhatsAppWebhookPubSubMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pub/Sub WhatsApp webhook message must be an object.");
  }

  const record = value as Record<string, unknown>;
  return {
    eventId: readRequiredPubSubString(record, "eventId"),
    dedupeKey: readRequiredPubSubString(record, "dedupeKey"),
    field: readRequiredPubSubString(record, "field"),
    orderingKey:
      typeof record.orderingKey === "string" && record.orderingKey.trim()
        ? record.orderingKey.trim()
        : "whatsapp-unknown",
    receivedAt:
      typeof record.receivedAt === "string" && record.receivedAt.trim()
        ? record.receivedAt.trim()
        : "",
    itemKind:
      typeof record.itemKind === "string" && record.itemKind.trim()
        ? record.itemKind.trim()
        : null,
  };
}

export function isWhatsAppCustomerMessagePubSubMessage(
  message: Pick<WhatsAppWebhookPubSubMessage, "itemKind">,
): boolean {
  return message.itemKind === "message";
}

export function isWhatsAppCallWebhookPubSubField(field: string): boolean {
  return field === "calls";
}

export function buildWhatsAppWebhookProcessorRoutingKey(params: {
  baseKey: string;
  itemKind?: string | null;
}): string {
  const baseKey = String(params.baseKey || "whatsapp-unknown").trim();
  const itemKind = String(params.itemKind || "").trim();
  if (!shouldIsolateWhatsAppWebhookProcessorItemKind(itemKind)) {
    return baseKey;
  }
  const suffix = `:${itemKind}`;
  return baseKey.endsWith(suffix) || baseKey.includes(`${suffix}:`)
    ? baseKey
    : `${baseKey}${suffix}`;
}
