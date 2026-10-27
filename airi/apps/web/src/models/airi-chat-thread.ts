import mongoose from "mongoose";

export type AiriChatThreadStatus = "active" | "archived";
export type AiriChatThreadSource = "manual" | "onboarding" | "global";

export interface IAiriChatThread {
  workspaceId: string;
  createdByUserId: string;
  title: string;
  status: AiriChatThreadStatus;
  source: AiriChatThreadSource;
  pinnedAt?: Date | null;
  metaAdsMcpConversationId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AiriChatThreadSchema = new mongoose.Schema<IAiriChatThread>(
  {
    workspaceId: { type: String, required: true, index: true },
    createdByUserId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active",
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ["manual", "onboarding", "global"],
      default: "manual",
      required: true,
    },
    pinnedAt: { type: Date, default: null, index: true },
    metaAdsMcpConversationId: { type: String, match: /^[A-Za-z0-9]{20}$/ },
  },
  { timestamps: true }
);

AiriChatThreadSchema.index({ workspaceId: 1, updatedAt: -1 });
AiriChatThreadSchema.index({
  workspaceId: 1,
  createdByUserId: 1,
  pinnedAt: -1,
  updatedAt: -1,
});

export const AiriChatThread =
  mongoose.models.AiriChatThread ||
  mongoose.model<IAiriChatThread>("AiriChatThread", AiriChatThreadSchema);
