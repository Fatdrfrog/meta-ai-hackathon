import mongoose from "mongoose";

const WhatsAppGroupParticipantSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    input: { type: String, default: null },
    waId: { type: String, default: null, index: true },
    userId: { type: String, default: null, index: true },
    parentUserId: { type: String, default: null, index: true },
    username: { type: String, default: null },
    status: {
      type: String,
      enum: ["active", "removed", "pending", "failed"],
      default: "active",
      index: true,
    },
    joinedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const WhatsAppGroupSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, required: true, index: true },
    wabaId: { type: String, default: null, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    displayPhoneNumber: { type: String, default: null },
    groupId: { type: String, required: true, index: true },
    subject: { type: String, default: null },
    description: { type: String, default: null },
    inviteLink: { type: String, default: null },
    joinApprovalMode: { type: String, default: null },
    status: {
      type: String,
      enum: ["active", "deleted", "suspended"],
      default: "active",
      index: true,
    },
    lastEventType: { type: String, default: null, index: true },
    lastEventField: { type: String, default: null, index: true },
    lastEventAt: { type: Date, default: null, index: true },
    participants: { type: [WhatsAppGroupParticipantSchema], default: [] },
    rawLastEvent: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

WhatsAppGroupSchema.index(
  { workspaceId: 1, sourceId: 1, groupId: 1 },
  { unique: true }
);
WhatsAppGroupSchema.index({ workspaceId: 1, phoneNumberId: 1, status: 1 });

const WhatsAppGroup =
  mongoose.models.WhatsAppGroup ||
  mongoose.model("WhatsAppGroup", WhatsAppGroupSchema);

export default WhatsAppGroup;
