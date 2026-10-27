import mongoose from "mongoose";

const CustomerEventSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "conversation_linked",
        "conversation_unlinked",
        "stage_snapshot",
        "stage_changed",
        "owner_changed",
        "conversion_recorded",
        "commerce_behavior",
        "behavioral_profile_updated",
      ],
      required: true,
      index: true,
    },
    occurredAt: { type: Date, required: true, index: true },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    actor: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          type: {
            type: String,
            enum: ["system", "manager", "ai", "backfill"],
            default: "system",
          },
          userId: { type: String, default: null },
          label: { type: String, default: null },
        },
        { _id: false }
      ),
      default: { type: "system", userId: null, label: null },
    },
    idempotencyKey: { type: String, required: true },
    behaviorAdmissionStatus: {
      type: String,
      enum: ["pending", "completed"],
      default: undefined,
    },
    behaviorAdmissionCursor: { type: String, default: undefined },
    behaviorAdmissionNextAt: { type: Date, default: undefined },
  },
  { timestamps: true }
);

CustomerEventSchema.index({ workspaceId: 1, customerId: 1, occurredAt: -1 });
CustomerEventSchema.index({ workspaceId: 1, type: 1, occurredAt: -1 });
CustomerEventSchema.index({
  workspaceId: 1,
  conversationId: 1,
  type: 1,
  occurredAt: 1,
});
CustomerEventSchema.index({
  behaviorAdmissionStatus: 1,
  behaviorAdmissionNextAt: 1,
  _id: 1,
});
CustomerEventSchema.index({
  workspaceId: 1,
  customerId: 1,
  "payload.behavior.referenceId": 1,
  occurredAt: -1,
});
CustomerEventSchema.index(
  { workspaceId: 1, idempotencyKey: 1 },
  { unique: true }
);

export default mongoose.models.CustomerEvent ||
  mongoose.model("CustomerEvent", CustomerEventSchema);
