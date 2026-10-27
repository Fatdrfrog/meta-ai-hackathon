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
    previousWaIds: { type: [String], default: undefined, index: true },
    previousUserIds: { type: [String], default: undefined, index: true },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    _id: { type: mongoose.Schema.Types.Mixed, required: true }, // Support both Number (Telegram) and String (WhatsApp)
    workspaceId: { type: String, required: true, index: true },
    firstName: { type: String },
    lastName: { type: String },
    username: { type: String, index: true },
    email: { type: String, index: true }, // For authenticated widget users
    isBot: { type: Boolean, default: false },
    avatar_url: { type: String }, // User's profile picture URL
    whatsapp: { type: WhatsAppIdentitySchema, default: undefined },
  },
  {
    _id: false,
    timestamps: true,
  }
);

UserSchema.index({ workspaceId: 1, "whatsapp.waId": 1 });
UserSchema.index({ workspaceId: 1, "whatsapp.previousWaIds": 1 });
UserSchema.index({ workspaceId: 1, "whatsapp.userId": 1 });
UserSchema.index({ workspaceId: 1, "whatsapp.parentUserId": 1 });
UserSchema.index({ workspaceId: 1, "whatsapp.previousUserIds": 1 });

export default mongoose.models.User || mongoose.model("User", UserSchema);
