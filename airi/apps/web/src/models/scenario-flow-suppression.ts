import mongoose from "mongoose";

export const SCENARIO_FLOW_SUPPRESSION_REASONS = [
  "meta_integrity_block",
] as const;

const ScenarioFlowSuppressionSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: { type: String, required: true, index: true },
    flowId: { type: String, required: true, index: true },
    reason: {
      type: String,
      enum: SCENARIO_FLOW_SUPPRESSION_REASONS,
      required: true,
      index: true,
    },
    sourceId: { type: String, default: null, index: true },
    conversationId: { type: String, default: null, index: true },
    scenarioId: { type: String, default: null, index: true },
    actionNodeId: { type: String, default: null },
    errorCode: { type: Number, default: null, index: true },
    errorMessage: { type: String, default: null },
    occurrenceCount: { type: Number, default: 0 },
    suppressedAt: { type: Date, default: Date.now, index: true },
    lastFailureAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

ScenarioFlowSuppressionSchema.index(
  { workspaceId: 1, flowId: 1, reason: 1 },
  { unique: true }
);
ScenarioFlowSuppressionSchema.index({
  workspaceId: 1,
  flowId: 1,
  resolvedAt: 1,
  expiresAt: 1,
});
ScenarioFlowSuppressionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

export const ScenarioFlowSuppression =
  mongoose.models.ScenarioFlowSuppression ||
  mongoose.model("ScenarioFlowSuppression", ScenarioFlowSuppressionSchema);
