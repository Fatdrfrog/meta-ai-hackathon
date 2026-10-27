import mongoose from "mongoose";

const WhatsAppIdentitySchema = new mongoose.Schema<Record<string, unknown>>(
  {
    waId: { type: String, index: true },
    userId: { type: String, index: true },
    parentUserId: { type: String, index: true },
    username: { type: String },
    profileName: { type: String },
    primaryIdType: {
      type: String,
      enum: ["wa_id", "user_id", "parent_user_id", "message_from"],
    },
    // History of prior wa_id values seen on this identity, populated when a
    // `system.user_changed_number` webhook re-pins the contact. Used to merge
    // future inbound traffic that still addresses the old number and for audit.
    previousWaIds: { type: [String], default: undefined, index: true },
    // History of prior business-scoped user IDs, populated by
    // `system.user_changed_user_id` webhooks.
    previousUserIds: { type: [String], default: undefined, index: true },
  },
  { _id: false }
);

const WhatsAppGroupChatSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    groupId: { type: String, required: true, index: true },
    phoneNumberId: { type: String, default: null, index: true },
    sourceId: { type: String, default: null, index: true },
    subject: { type: String, default: null },
  },
  { _id: false }
);

const ChatSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    _id: { type: mongoose.Schema.Types.Mixed, required: true },
    type: {
      type: String,
      enum: [
        "private",
        "group",
        "supergroup",
        "channel",
        "whatsapp",
        "instagram",
        "email",
      ],
      required: true,
    },
    title: { type: String },
    // For business conversations, store client's info
    first_name: { type: String },
    last_name: { type: String },
    username: { type: String, index: true },
    is_forum: { type: Boolean, default: undefined },
    participants: [{ type: mongoose.Schema.Types.Mixed, ref: "User" }],
    sourceId: {
      type: String,
      required: false,
      index: true,
    },
    businessConnectionId: {
      type: String,
      required: false,
      index: true,
    },
    workspaceId: {
      type: String,
      index: true,
    },
    whatsapp: { type: WhatsAppIdentitySchema, default: undefined },
    whatsappGroup: { type: WhatsAppGroupChatSchema, default: undefined },
  },
  { _id: false, timestamps: true }
);

ChatSchema.index({ workspaceId: 1, "whatsapp.waId": 1 });
ChatSchema.index({ workspaceId: 1, "whatsapp.previousWaIds": 1 });
ChatSchema.index({ workspaceId: 1, "whatsapp.userId": 1 });
ChatSchema.index({ workspaceId: 1, "whatsapp.parentUserId": 1 });
ChatSchema.index({ workspaceId: 1, "whatsapp.previousUserIds": 1 });
ChatSchema.index({ workspaceId: 1, sourceId: 1, "whatsappGroup.groupId": 1 });

export default mongoose.models.Chat || mongoose.model("Chat", ChatSchema);
