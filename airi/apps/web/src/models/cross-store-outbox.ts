import mongoose from "mongoose";

type CrossStoreOutboxIndexSpec = {
  key: Record<string, 1 | -1>;
  options: {
    background: true;
    expireAfterSeconds?: number;
    name: string;
    partialFilterExpression?: Record<string, unknown>;
    unique?: true;
  };
};

export const CROSS_STORE_OUTBOX_COMPLETED_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const CROSS_STORE_OUTBOX_INDEX_SPECS: readonly CrossStoreOutboxIndexSpec[] =
  [
    { key: { target: 1 }, options: { background: true, name: "target_1" } },
    {
      key: { operation: 1 },
      options: { background: true, name: "operation_1" },
    },
    {
      key: { dedupeKey: 1 },
      options: { background: true, name: "dedupeKey_1" },
    },
    { key: { status: 1 }, options: { background: true, name: "status_1" } },
    {
      key: { nextRetryAt: 1 },
      options: { background: true, name: "nextRetryAt_1" },
    },
    {
      key: { processingStartedAt: 1 },
      options: { background: true, name: "processingStartedAt_1" },
    },
    {
      key: { status: 1, nextRetryAt: 1 },
      options: { background: true, name: "status_1_nextRetryAt_1" },
    },
    {
      key: { target: 1, operation: 1, dedupeKey: 1 },
      options: {
        background: true,
        name: "target_1_operation_1_dedupeKey_1",
        unique: true,
      },
    },
    {
      key: { completedAt: 1 },
      options: {
        background: true,
        expireAfterSeconds: CROSS_STORE_OUTBOX_COMPLETED_RETENTION_SECONDS,
        name: "completedAt_1_completed_ttl",
        partialFilterExpression: { status: "completed" },
      },
    },
  ];

const CrossStoreOutboxSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    target: {
      type: String,
      enum: ["supabase", "gcp_ai_gateway", "whatsapp_cloud_api", "temporal"],
      required: true,
      default: "supabase",
    },
    operation: { type: String, required: true },
    dedupeKey: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "delivery_unknown",
        "completed",
        "failed",
      ],
      default: "pending",
    },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 8, min: 1 },
    nextRetryAt: { type: Date, default: Date.now },

    processingStartedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

for (const spec of CROSS_STORE_OUTBOX_INDEX_SPECS) {
  CrossStoreOutboxSchema.index(spec.key, spec.options);
}

const CrossStoreOutbox =
  mongoose.models.CrossStoreOutbox ||
  mongoose.model("CrossStoreOutbox", CrossStoreOutboxSchema);

export default CrossStoreOutbox;
