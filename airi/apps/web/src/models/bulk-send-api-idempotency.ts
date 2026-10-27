import mongoose from "mongoose";

export const BULK_SEND_API_IDEMPOTENCY_OPERATION_KIND = {
  LEGACY: "legacy_bulk_send",
  GENERATED: "generated_scenario_send",
} as const;

export const BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE = {
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export const BULK_SEND_API_IDEMPOTENCY_LEGACY_INDEX_NAME = "createdAt_1";

export const BULK_SEND_API_IDEMPOTENCY_INDEXES = {
  keyHashUnique: {
    keys: { keyHash: 1 },
    options: {
      background: true,
      name: "keyHash_1",
      unique: true,
    },
  },
  legacyCreatedAtTtl: {
    keys: { createdAt: 1 },
    options: {
      background: true,
      expireAfterSeconds: 60 * 60 * 24,
      name: "bulk_send_legacy_created_at_ttl",
      partialFilterExpression: {
        operationKind: BULK_SEND_API_IDEMPOTENCY_OPERATION_KIND.LEGACY,
      },
    },
  },
  terminalExpiresAtTtl: {
    keys: { expiresAt: 1 },
    options: {
      background: true,
      expireAfterSeconds: 0,
      name: "bulk_send_terminal_expires_at_ttl",
    },
  },
  activeScenarioUnique: {
    keys: { activeScenarioKey: 1 },
    options: {
      background: true,
      name: "bulk_send_active_scenario_unique",
      sparse: true,
      unique: true,
    },
  },
  operationIdUnique: {
    keys: { campaignId: 1 },
    options: {
      background: true,
      name: "bulk_send_operation_id_unique",
      sparse: true,
      unique: true,
    },
  },
  generatedOperationLease: {
    keys: {
      workspaceId: 1,
      scenarioId: 1,
      operationState: 1,
      reservationExpiresAt: 1,
    },
    options: {
      background: true,
      name: "bulk_send_generated_operation_lease",
    },
  },
} as const;

/**
 * Short-lived cache for POST /api/campaigns/bulk-send idempotency (double-submit protection).
 */
const BulkSendApiIdempotencySchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    keyHash: { type: String, required: true },
    workspaceId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    operationKind: {
      type: String,
      enum: Object.values(BULK_SEND_API_IDEMPOTENCY_OPERATION_KIND),
      default: BULK_SEND_API_IDEMPOTENCY_OPERATION_KIND.LEGACY,
    },
    operationState: {
      type: String,
      enum: Object.values(BULK_SEND_API_IDEMPOTENCY_OPERATION_STATE),
    },
    scenarioId: { type: String },
    /** Unique only while a generated scenario operation is active. */
    activeScenarioKey: { type: String },
    /** Stable campaign identity shared by the initial owner and lease takeovers. */
    campaignId: { type: String },
    /** Database-owned generation job identifying the immutable audience. */
    audienceRevision: { type: String },
    /** Immutable command start time used to prevent late child admission. */
    requestedAtIso: { type: String },
    scheduledAtIso: { type: String },
    intentDigestVersion: { type: Number },
    intentDigest: { type: String },
    /** Immutable authoritative recipient policy for current generated sends. */
    recipientPolicy: {
      version: { type: Number },
      excludePriorFailedBulkSends: { type: Boolean },
    },
    requestDigestVersion: { type: Number },
    requestDigest: { type: String },
    /** Opaque ownership proof for a pending reservation. */
    reservationToken: { type: String },
    /** Pending reservations can be recovered after this lease expires. */
    reservationExpiresAt: { type: Date },
    /** Bounded JSON progress for resuming partially admitted child campaigns. */
    progressBody: { type: String },
    progressVersion: { type: Number },
    /** HTTP status for a cached terminal non-success response. */
    responseStatus: { type: Number },
    /** JSON string of the exact terminal response body. */
    responseBody: { type: String },
    /** Terminal records expire here; active generated operations never set it. */
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

for (const index of Object.values(BULK_SEND_API_IDEMPOTENCY_INDEXES)) {
  BulkSendApiIdempotencySchema.index(index.keys, index.options);
}

const BulkSendApiIdempotency =
  mongoose.models.BulkSendApiIdempotency ||
  mongoose.model("BulkSendApiIdempotency", BulkSendApiIdempotencySchema);

export default BulkSendApiIdempotency;
