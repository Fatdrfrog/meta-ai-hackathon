import mongoose from "mongoose";

// Compact completed payloads through bounded maintenance, never TTL the receipt:
// the unique dedupe key must continue to suppress provider redelivery.
export const WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX = {
  key: { completedAt: 1, _id: 1 } as const,
  options: {
    name: "whatsapp_webhook_events_payload_compaction",
    partialFilterExpression: { status: "completed", payloadCompactedAt: null },
  },
};

export const WHATSAPP_HISTORY_CAPACITY_INDEX = {
  key: { "historyImport.capacityCompanyId": 1, _id: 1 } as const,
  options: {
    name: "whatsapp_history_capacity_paused",
    partialFilterExpression: {
      status: "received",
      "historyImport.capacityPaused": true,
    },
  },
};

export const WHATSAPP_HISTORY_IMPORT_INDEX = {
  key: {
    workspaceId: 1,
    sourceId: 1,
    "historyImport.sessionId": 1,
    "historyImport.role": 1,
    status: 1,
  } as const,
  options: {
    name: "whatsapp_history_import_receipts",
    partialFilterExpression: { "historyImport.sessionId": { $type: "string" } },
  },
};

export const WHATSAPP_WEBHOOK_EVENT_STATUSES = [
  "received",
  "published",
  "queued",
  "processing",
  "completed",
  "failed",
  "dead",
] as const;

export type WhatsAppWebhookEventStatus =
  (typeof WHATSAPP_WEBHOOK_EVENT_STATUSES)[number];

// The schema and explicit provisioner share exactly this managed subset.
// Field-level diagnostic indexes below are intentionally not provisioned here.
export const WHATSAPP_WEBHOOK_MANAGED_INDEXES: Array<{
  key: Record<string, 1 | -1>;
  options: mongoose.mongo.CreateIndexesOptions;
}> = [
  WHATSAPP_HISTORY_CAPACITY_INDEX,
  WHATSAPP_HISTORY_IMPORT_INDEX,
  { key: { dedupeKey: 1 }, options: { unique: true } },
  { key: { status: 1, nextRetryAt: 1 }, options: {} },
  WHATSAPP_WEBHOOK_PAYLOAD_COMPACTION_INDEX,
  {
    key: { status: 1, queuedAt: 1 },
    options: {
      name: "whatsapp_webhook_events_stale_queued",
      partialFilterExpression: { status: "queued", completedAt: null },
    },
  },
  {
    key: { status: 1, processingStartedAt: 1 },
    options: {
      name: "whatsapp_webhook_events_stale_processing",
      partialFilterExpression: { status: "processing", completedAt: null },
    },
  },
  { key: { phoneNumberId: 1, field: 1, createdAt: -1 }, options: {} },
  { key: { wabaId: 1, field: 1, createdAt: -1 }, options: {} },
  { key: { waacId: 1, field: 1, createdAt: -1 }, options: {} },
];

const WhatsAppWebhookEventSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    provider: {
      type: String,
      required: true,
      default: "whatsapp",
    },
    dedupeKey: { type: String, required: true },
    object: { type: String, default: null },
    field: { type: String, required: true, index: true },
    itemKind: { type: String, default: null, index: true },

    workspaceId: { type: String, default: null, index: true },
    sourceId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null },
    csId: { type: String, default: null, index: true },
    wabaId: { type: String, default: null },
    messagingAccountId: { type: String, default: null },
    waacId: { type: String, default: null, index: true },
    orderingKey: { type: String, required: true },

    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: function (this: {
        status?: string;
        completedAt?: Date | null;
        payloadCompactedAt?: Date | null;
      }) {
        return !(
          this.status === "completed" &&
          this.completedAt instanceof Date &&
          this.payloadCompactedAt instanceof Date
        );
      },
    },
    payloadCompactedAt: { type: Date, default: null },
    providerSignatureVerified: { type: Boolean, default: false },
    originalPayloadHash: { type: String, default: null, index: true },

    historyMetadata: {
      phase: { type: Number, default: null },
      chunkOrder: { type: Number, default: null },
      progress: { type: Number, default: null },
    },
    processingCursor: { type: mongoose.Schema.Types.Mixed, default: null },
    historyImport: { type: mongoose.Schema.Types.Mixed, default: null },

    status: {
      type: String,
      enum: [...WHATSAPP_WEBHOOK_EVENT_STATUSES],
      default: "received",
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    publishAttempts: { type: Number, default: 0, min: 0 },
    duplicateCount: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 12, min: 1 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    firstReceivedAt: { type: Date, default: Date.now },
    lastReceivedAt: { type: Date, default: Date.now, index: true },
    publishedAt: { type: Date, default: null },
    queuedAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },
    processingLeaseId: { type: String, default: null },
    completedAt: { type: Date, default: null },
    // Set only while a completed receipt is a company-plan skip (see
    // whatsapp-intake-plan-gate); the replay tool's --plan-skipped selects it.
    planSkipReason: { type: String },
    lastError: { type: String, default: null },
    pubsubMessageId: { type: String, default: null },
    temporalWorkflowId: { type: String, default: null, index: true },
  },
  { timestamps: true },
);

for (const { key, options } of WHATSAPP_WEBHOOK_MANAGED_INDEXES) {
  WhatsAppWebhookEventSchema.index(key, { ...options });
}

const WhatsAppWebhookEvent =
  mongoose.models.WhatsAppWebhookEvent ||
  mongoose.model("WhatsAppWebhookEvent", WhatsAppWebhookEventSchema);

export default WhatsAppWebhookEvent;
