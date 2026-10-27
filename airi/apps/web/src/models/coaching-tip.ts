import mongoose from "mongoose";

/**
 * Valid coaching tip types that match what the AI engine generates
 * Keep this in sync with CoachTip type in lib/airi/engine.ts
 */
export const COACH_TIP_TYPES = [
  "tone",
  "clarity",
  "policy",
  "empathy",
  "urgency",
  "other",
] as const;

const CoachingTipSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, index: true, required: true },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      index: true,
      required: true,
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      index: true,
      required: true,
    },
    tips: {
      type: [
        new mongoose.Schema<Record<string, unknown>>(
          {
            title: { type: String, required: true },
            suggestion: { type: String, required: true },
            type: { type: String, enum: COACH_TIP_TYPES, default: "other" },
            confidence: { type: Number, min: 0, max: 1, default: 0.7 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    modelVersion: { type: String, default: "v1" },
    tagsApplied: { type: [String], default: [] },
    inputMessageIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    inference: new mongoose.Schema<Record<string, unknown>>(
      {
        model: { type: String },
        promptTokens: { type: Number },
        completionTokens: { type: Number },
        totalTokens: { type: Number },
        latencyMs: { type: Number },
      },
      { _id: false }
    ),
    suggestedEdit: { type: String, default: "" },
    risk: new mongoose.Schema<Record<string, unknown>>(
      {
        maxSeverity: { type: Number, default: 0 },
        categories: { type: [String], default: [] },
      },
      { _id: false }
    ),
    adopted: { type: Boolean, default: false },
    adoptedAt: { type: Date },
  },
  { timestamps: true }
);

CoachingTipSchema.index({ conversationId: 1, messageId: 1 });

export default mongoose.models.CoachingTip ||
  mongoose.model("CoachingTip", CoachingTipSchema);
