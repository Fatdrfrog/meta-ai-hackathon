import mongoose from "mongoose";

const ScenarioEvalOptimizerRunSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true, index: true },
    evalRunId: { type: String, required: true, index: true, unique: true },
    status: {
      type: String,
      enum: ["running", "completed", "failed"],
      default: "running",
      index: true,
    },
    gateDecision: {
      type: String,
      enum: ["promote", "reject", "none"],
      default: "none",
      index: true,
    },
    promotionApplied: { type: Boolean, default: false, index: true },
    actionNodeId: { type: String, default: null },
    promptField: {
      type: String,
      enum: ["actionReplyInstruction", "actionReplyText", null],
      default: null,
    },
    baselinePrompt: { type: String, default: null },
    candidatePrompt: { type: String, default: null },
    candidateRationale: { type: String, default: null },
    baselineScore: { type: Number, default: null },
    candidateScore: { type: Number, default: null },
    improvement: { type: Number, default: null },
    requiredImprovement: { type: Number, default: null },
    criticalRegressionRisk: { type: Boolean, default: false },
    gateReasons: { type: [String], default: [] },
    evaluatedCaseCount: { type: Number, default: 0 },
    triggeredBy: {
      type: String,
      enum: ["manual", "cron", "api"],
      default: "api",
      index: true,
    },
    runByUserId: { type: String, default: null },
    startedAt: { type: Date, default: Date.now, index: true },
    completedAt: { type: Date, default: null, index: true },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

ScenarioEvalOptimizerRunSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  createdAt: -1,
});
ScenarioEvalOptimizerRunSchema.index({
  workspaceId: 1,
  gateDecision: 1,
  createdAt: -1,
});

const ScenarioEvalOptimizerRun =
  mongoose.models.ScenarioEvalOptimizerRun ||
  mongoose.model("ScenarioEvalOptimizerRun", ScenarioEvalOptimizerRunSchema);

export default ScenarioEvalOptimizerRun;
