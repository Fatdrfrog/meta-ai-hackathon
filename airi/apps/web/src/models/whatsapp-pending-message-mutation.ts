import mongoose from "mongoose";

const WhatsAppPendingMessageMutationSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    mutationMessageId: { type: String, required: true, index: true },
    targetMessageId: { type: String, required: true, index: true },
    normalizedTargetMessageId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: ["edit", "revoke"],
      required: true,
      index: true,
    },
    text: { type: String, default: null },
    eventAt: { type: Date, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ["pending", "applied", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    appliedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

WhatsAppPendingMessageMutationSchema.index(
  { normalizedTargetMessageId: 1, kind: 1, mutationMessageId: 1 },
  { unique: true }
);
WhatsAppPendingMessageMutationSchema.index(
  {
    workspaceId: 1,
    status: 1,
    normalizedTargetMessageId: 1,
    eventAt: 1,
    createdAt: 1,
  },
  {
    name: "whatsapp_pending_mutations_workspace_status_target_event_created",
  }
);

const WhatsAppPendingMessageMutation =
  mongoose.models.WhatsAppPendingMessageMutation ||
  mongoose.model(
    "WhatsAppPendingMessageMutation",
    WhatsAppPendingMessageMutationSchema
  );

export default WhatsAppPendingMessageMutation;
