import mongoose from "mongoose";

/**
 * Records provider intent and acceptance per Temporal activity item. Unresolved
 * intents have createdAt=null so the receipt TTL cannot authorize a later resend.
 */
const BulkDispatchActivityDedupeSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    key: { type: String, required: true, unique: true },
    workspaceId: { type: String, required: true, index: true },
    channel: {
      type: String,
      enum: ["whatsapp", "telegram", "email"],
      required: true,
    },
    messageId: { type: String },
    state: { type: String, enum: ["attempted", "accepted"] },
    intentToken: { type: String },
    providerAttemptStartedAt: { type: Date },
    // Unresolved intent has no TTL date; acceptance starts receipt retention.
    createdAt: { type: Date, immutable: false },
    recipient: { type: String, required: true },
  },
  { timestamps: true }
);

BulkDispatchActivityDedupeSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 }
);

const BulkDispatchActivityDedupe =
  mongoose.models.BulkDispatchActivityDedupe ||
  mongoose.model(
    "BulkDispatchActivityDedupe",
    BulkDispatchActivityDedupeSchema
  );

export default BulkDispatchActivityDedupe;
