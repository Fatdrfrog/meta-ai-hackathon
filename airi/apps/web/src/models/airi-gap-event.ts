import {
  CONVERSATION_CHANNELS,
  type ConversationChannel,
} from "@icecore/shared/types/sources";
import mongoose, { Schema, model, models } from "mongoose";

export type AiriGapIntent =
  | "business_hours"
  | "pricing"
  | "policy"
  | "integration_request"
  | "unknown";
export type AiriGapSource = "runtime" | "backfill";

export type AiriGapEventDoc = mongoose.Document & {
  dedupeKey: string;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  channel: ConversationChannel;
  intent: AiriGapIntent;
  intentTopic?: string | null;
  reason: string;
  query: string;
  source: AiriGapSource;
  responseConfidence?: number | null;
  retrievalPriority?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
};

const AiriGapEventSchema = new Schema<AiriGapEventDoc>(
  {
    dedupeKey: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    messageId: { type: String, required: true, index: true },
    channel: {
      type: String,
      enum: CONVERSATION_CHANNELS,
      required: true,
      index: true,
    },
    intent: {
      type: String,
      enum: [
        "business_hours",
        "pricing",
        "policy",
        "integration_request",
        "unknown",
      ],
      required: true,
      index: true,
    },
    intentTopic: { type: String, default: null, index: true },
    reason: { type: String, required: true, index: true },
    query: { type: String, default: "" },
    source: {
      type: String,
      enum: ["runtime", "backfill"],
      default: "runtime",
      index: true,
    },
    responseConfidence: { type: Number, default: null },
    retrievalPriority: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

AiriGapEventSchema.index({ workspaceId: 1, createdAt: -1 });
AiriGapEventSchema.index({ workspaceId: 1, intent: 1, createdAt: -1 });
AiriGapEventSchema.index({
  workspaceId: 1,
  intent: 1,
  intentTopic: 1,
  createdAt: -1,
});
AiriGapEventSchema.index({ workspaceId: 1, reason: 1, createdAt: -1 });

export default (models.AiriGapEvent as mongoose.Model<AiriGapEventDoc>) ||
  model<AiriGapEventDoc>("AiriGapEvent", AiriGapEventSchema);
