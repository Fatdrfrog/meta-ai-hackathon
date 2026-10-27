import mongoose from "mongoose";

const AnalyticsPolicySchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, unique: true },
    qualifiedStageKeys: { type: [String], default: ["qualified"] },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const AnalyticsPolicy =
  mongoose.models.AnalyticsPolicy ||
  mongoose.model("AnalyticsPolicy", AnalyticsPolicySchema);
