import mongoose from "mongoose";

const WhatsAppGroupParticipantSnapshotSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    input: { type: String, default: null },
    waId: { type: String, default: null },
    userId: { type: String, default: null },
    parentUserId: { type: String, default: null },
    username: { type: String, default: null },
  },
  { _id: false }
);

const WhatsAppGroupEventSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, required: true, index: true },
    wabaId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    displayPhoneNumber: { type: String, default: null },
    groupId: { type: String, required: true, index: true },
    field: { type: String, required: true, index: true },
    type: { type: String, default: null, index: true },
    requestId: { type: String, default: null, index: true },
    reason: { type: String, default: null },
    subject: { type: String, default: null },
    description: { type: String, default: null },
    inviteLink: { type: String, default: null },
    joinApprovalMode: { type: String, default: null },
    eventAt: { type: Date, required: true, index: true },
    addedParticipants: {
      type: [WhatsAppGroupParticipantSnapshotSchema],
      default: [],
    },
    removedParticipants: {
      type: [WhatsAppGroupParticipantSnapshotSchema],
      default: [],
    },
    failedParticipants: {
      type: [WhatsAppGroupParticipantSnapshotSchema],
      default: [],
    },
    pendingParticipants: {
      type: [WhatsAppGroupParticipantSnapshotSchema],
      default: [],
    },
    rawGroup: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

WhatsAppGroupEventSchema.index({
  workspaceId: 1,
  sourceId: 1,
  groupId: 1,
  eventAt: -1,
});
WhatsAppGroupEventSchema.index({
  workspaceId: 1,
  phoneNumberId: 1,
  field: 1,
  eventAt: -1,
});
WhatsAppGroupEventSchema.index({
  workspaceId: 1,
  sourceId: 1,
  groupId: 1,
  field: 1,
  type: 1,
  eventAt: 1,
});
WhatsAppGroupEventSchema.index(
  { workspaceId: 1, requestId: 1 },
  {
    partialFilterExpression: { requestId: { $type: "string" } },
  }
);

const WhatsAppGroupEvent =
  mongoose.models.WhatsAppGroupEvent ||
  mongoose.model("WhatsAppGroupEvent", WhatsAppGroupEventSchema);

export default WhatsAppGroupEvent;
