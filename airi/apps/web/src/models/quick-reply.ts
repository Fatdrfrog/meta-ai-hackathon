import { CONVERSATION_CHANNELS } from "@icecore/shared/types/sources";
import mongoose from "mongoose";

const QUICK_REPLY_CHANNEL_ENUM = [...CONVERSATION_CHANNELS, null] as const;

export interface IQuickReply {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  text: string;
  category?: string; // Optional grouping (e.g., "greeting", "closing", "common_questions")
  channel?: string; // Optional channel-specific quick replies
  order: number; // Display order
  createdAt: Date;
  updatedAt: Date;
}

const QuickReplySchema = new mongoose.Schema<IQuickReply>(
  {
    workspaceId: {
      type: String,
      required: true,
      index: true,
    },
    text: {
      type: String,
      required: true,
      maxlength: 500,
    },
    category: {
      type: String,
      enum: [
        "greeting",
        "closing",
        "common_questions",
        "support",
        "sales",
        "other",
      ],
      default: "other",
      index: true,
    },
    channel: {
      type: String,
      enum: QUICK_REPLY_CHANNEL_ENUM,
      default: null,
      index: true,
    },
    order: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  { timestamps: true }
);

// Compound index for workspace + channel + order
QuickReplySchema.index({ workspaceId: 1, channel: 1, order: 1 });
QuickReplySchema.index({ workspaceId: 1, category: 1, order: 1 });

export const QuickReply =
  mongoose.models.QuickReply ||
  mongoose.model<IQuickReply>("QuickReply", QuickReplySchema);
