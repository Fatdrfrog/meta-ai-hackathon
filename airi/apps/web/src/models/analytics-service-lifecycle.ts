import mongoose from "mongoose";

// Existing Requests checkpoints own a different projection/activation contract.
// Reuse their write-before-resume discipline without sharing incompatible state.
const factSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true },
    eventId: { type: String, required: true },
    conversationId: { type: String, required: true },
    customerId: { type: String, default: null },
    sourceId: { type: String, default: null },
    channel: { type: String, default: null },
    revision: { type: Number, required: true },
    occurredAt: { type: Date, required: true },
    kinds: { type: [String], required: true },
    evidence: {
      type: String,
      enum: ["change_stream", "snapshot_recovery"],
      required: true,
    },
    envelope: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);
factSchema.index({ workspaceId: 1, eventId: 1 }, { unique: true });
factSchema.index({ workspaceId: 1, occurredAt: 1, _id: 1 });
factSchema.index({ workspaceId: 1, sourceId: 1, occurredAt: 1, _id: 1 });
factSchema.index({ workspaceId: 1, conversationId: 1, revision: 1 });
export const AnalyticsServiceLifecycleFact =
  mongoose.models.AnalyticsServiceLifecycleFact ||
  mongoose.model("AnalyticsServiceLifecycleFact", factSchema);

const checkpointSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, unique: true },
    streamState: {
      type: String,
      enum: ["starting", "streaming", "degraded"],
      default: "starting",
    },
    historyState: {
      type: String,
      enum: ["since_activation", "history_gap"],
      default: "since_activation",
    },
    firstObservedAt: { type: Date, required: true },
    historyGapAt: { type: Date, default: null },
    gapReason: { type: String, default: null },
    resumeToken: { type: mongoose.Schema.Types.Mixed, default: null },
    resumePersistedAt: { type: Date, default: null },
    startAtOperationTime: { type: mongoose.Schema.Types.Mixed, default: null },
    snapshotState: {
      type: String,
      enum: ["pending", "running", "complete"],
      default: "pending",
    },
    snapshotCursor: { type: mongoose.Schema.Types.ObjectId, default: null },
    snapshotScanned: { type: Number, default: 0 },
    // Latest shared-stream gap whose available snapshots this tenant sweep recovered.
    snapshotGapAt: { type: Date, default: null },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    fence: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const AnalyticsServiceLifecycleCheckpoint =
  mongoose.models.AnalyticsServiceLifecycleCheckpoint ||
  mongoose.model("AnalyticsServiceLifecycleCheckpoint", checkpointSchema);

// Isolate source cursors while keeping the canonical lease/recovery schema and existing service index identity.
export const AnalyticsCustomerStageCheckpoint =
  mongoose.models.AnalyticsCustomerStageCheckpoint ||
  mongoose.model("AnalyticsCustomerStageCheckpoint", checkpointSchema.clone());
