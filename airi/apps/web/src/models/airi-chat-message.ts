import mongoose from "mongoose";

/** Longest stored message; replies are clamped to it before insert. */
export const AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH = 12000;

export type AiriChatMessageRole = "user" | "assistant" | "system";

export interface IAiriChatMessage {
  threadId: mongoose.Types.ObjectId;
  workspaceId: string;
  role: AiriChatMessageRole;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

const AiriChatMessageSchema = new mongoose.Schema<IAiriChatMessage>(
  {
    threadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiriChatThread",
      required: true,
      index: true,
    },
    workspaceId: { type: String, required: true, index: true },
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true,
      index: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH,
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

AiriChatMessageSchema.index({ threadId: 1, createdAt: 1 });
AiriChatMessageSchema.index({ workspaceId: 1, createdAt: -1 });

export const AiriChatMessage =
  mongoose.models.AiriChatMessage ||
  mongoose.model<IAiriChatMessage>("AiriChatMessage", AiriChatMessageSchema);
