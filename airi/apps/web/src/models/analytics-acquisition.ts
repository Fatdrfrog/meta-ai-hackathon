import mongoose from "mongoose";

const entrySchema = new mongoose.Schema<Record<string, unknown>>({
  workspaceId: { type: String, required: true },
  entryKey: { type: String, required: true },
  conversationId: { type: String, required: true },
  sourceId: { type: String, default: null },
  channel: { type: String, required: true },
  kind: { type: String, enum: ["ad", "organic"], required: true },
  adId: { type: String, default: null },
  identityCoverage: { type: String, required: true },
  capturedAt: { type: Date, required: true },
  entryOrder: { type: String, required: true },
  sourceMessageId: { type: String, default: null },
  supersededBy: { type: String, default: null },
  projectedAt: { type: Date, required: true },
  fence: { type: Number, required: true },
});
entrySchema.index({ workspaceId: 1, entryKey: 1 }, { unique: true });
entrySchema.index({ workspaceId: 1, capturedAt: 1, sourceId: 1 });
entrySchema.index({
  workspaceId: 1,
  conversationId: 1,
  capturedAt: 1,
  entryOrder: 1,
});
export const AnalyticsAcquisitionEntry =
  mongoose.models.AnalyticsAcquisitionEntry ||
  mongoose.model("AnalyticsAcquisitionEntry", entrySchema);

// A bounded alias per durable message keeps late click enrichment replayable.
// Superseded entry tombstones prevent an older page from resurrecting a fallback.
const messageLinkSchema = new mongoose.Schema<Record<string, unknown>>({
  workspaceId: { type: String, required: true },
  sourceMessageId: { type: String, required: true },
  conversationId: { type: String, required: true },
  fallbackEntryKey: { type: String, required: true },
  entryKey: { type: String, required: true },
  identityCoverage: {
    type: String,
    enum: ["message", "click"],
    required: true,
  },
  sourceId: { type: String, default: null },
  adId: { type: String, default: null },
  channel: { type: String, required: true },
  capturedAt: { type: Date, required: true },
  entryOrder: { type: String, required: true },
  projectedAt: { type: Date, required: true },
});
messageLinkSchema.index(
  { workspaceId: 1, sourceMessageId: 1 },
  { unique: true }
);
messageLinkSchema.index({ workspaceId: 1, entryKey: 1 });
export const AnalyticsAcquisitionMessageLink =
  mongoose.models.AnalyticsAcquisitionMessageLink ||
  mongoose.model("AnalyticsAcquisitionMessageLink", messageLinkSchema);

const conversionSchema = new mongoose.Schema<Record<string, unknown>>({
  workspaceId: { type: String, required: true },
  conversionId: { type: String, required: true },
  conversationId: { type: String, required: true },
  customerId: { type: String, default: null },
  sourceId: { type: String, default: null },
  conversionType: { type: String, required: true },
  value: { type: Number, default: null },
  currency: { type: String, default: null },
  occurredAt: { type: Date, required: true },
  ledgerCreatedAt: { type: Date, required: true },
  transactionId: { type: String, default: null },
  purchaseTransactionId: { type: String, default: null },
  projectedAt: { type: Date, required: true },
  fence: { type: Number, required: true },
});
conversionSchema.index({ workspaceId: 1, conversionId: 1 }, { unique: true });
conversionSchema.index({ workspaceId: 1, conversationId: 1, occurredAt: 1 });
conversionSchema.index({ workspaceId: 1, customerId: 1, occurredAt: 1 });
conversionSchema.index({ workspaceId: 1, sourceId: 1, transactionId: 1 });
conversionSchema.index({
  workspaceId: 1,
  purchaseTransactionId: 1,
  sourceId: 1,
  currency: 1,
  occurredAt: 1,
});
export const AnalyticsConversionFact =
  mongoose.models.AnalyticsConversionFact ||
  mongoose.model("AnalyticsConversionFact", conversionSchema);

const purchaseObservationSchema = new mongoose.Schema<Record<string, unknown>>({
  workspaceId: { type: String, required: true },
  scope: { type: String, enum: ["workspace", "source"], required: true },
  sourceId: { type: String, default: null },
  customerId: { type: String, required: true },
  currency: { type: String, default: null },
  firstPurchase: { type: Date, required: true },
  projectedAt: { type: Date, required: true },
});
purchaseObservationSchema.index(
  { workspaceId: 1, scope: 1, sourceId: 1, customerId: 1, currency: 1 },
  { unique: true }
);
purchaseObservationSchema.index({
  workspaceId: 1,
  scope: 1,
  sourceId: 1,
  firstPurchase: 1,
  currency: 1,
});
export const AnalyticsCustomerPurchaseObservation =
  mongoose.models.AnalyticsCustomerPurchaseObservation ||
  mongoose.model(
    "AnalyticsCustomerPurchaseObservation",
    purchaseObservationSchema
  );

const checkpointSchema = new mongoose.Schema<Record<string, unknown>>({
  workspaceId: { type: String, required: true },
  stream: {
    type: String,
    enum: [
      "messages",
      "conversations",
      "conversions",
      "messages_reconciliation",
      "conversations_reconciliation",
      "conversions_reconciliation",
      "workspace_discovery",
      "provider_sync",
    ],
    required: true,
  },
  cursorAt: { type: Date, default: null },
  // Ledger (Postgres) cursors keep their microsecond instant; cursorAt is milliseconds only.
  cursorAtExact: { type: String, default: null },
  cursorId: { type: String, default: null },
  through: { type: Date, default: null },
  // Sweep start is the covered boundary; through records its completion cutoff.
  reconcileThrough: { type: Date, default: null },
  sweepStartedAt: { type: Date, default: null },
  sweepMaxId: { type: String, default: null },
  owner: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  fence: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  // A leased page remains incomplete until every write is acknowledged; failure
  // keeps this flag set. Live conversion claims also keep queue coverage incomplete.
  // sweepStartedAt may remain set with incomplete=false between completed pages.
  incomplete: { type: Boolean, default: false },
  // provider_sync only: source counts of the current/last provider sweep, so an
  // empty template or health collection shows whether Meta access or activation is missing.
  providerSources: {
    type: new mongoose.Schema<Record<string, unknown>>(
      {
        processed: Number,
        available: Number,
        unavailable: Number,
        activationRequired: Number,
        permissionRequired: Number,
      },
      { _id: false }
    ),
    default: null,
  },
  providerSourcesAt: { type: Date, default: null },
});
checkpointSchema.index({ workspaceId: 1, stream: 1 }, { unique: true });
export const AnalyticsAcquisitionCheckpoint =
  mongoose.models.AnalyticsAcquisitionCheckpoint ||
  mongoose.model("AnalyticsAcquisitionCheckpoint", checkpointSchema);

const dailySchema = new mongoose.Schema<Record<string, unknown>>({
  workspaceId: { type: String, required: true },
  day: { type: String, required: true },
  kind: { type: String, required: true },
  sourceId: { type: String, default: null },
  adId: { type: String, default: null },
  entries: { type: Number, required: true },
  fence: { type: Number, required: true },
  projectedAt: { type: Date, required: true },
});
dailySchema.index(
  { workspaceId: 1, day: 1, kind: 1, sourceId: 1, adId: 1 },
  { unique: true }
);
export const AnalyticsAcquisitionDaily =
  mongoose.models.AnalyticsAcquisitionDaily ||
  mongoose.model("AnalyticsAcquisitionDaily", dailySchema);
