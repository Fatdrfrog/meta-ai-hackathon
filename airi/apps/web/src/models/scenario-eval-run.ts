import mongoose from "mongoose";

const ScenarioEvalRunSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, default: null, index: true },
    scenarioName: { type: String, default: null },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed"],
      default: "queued",
      index: true,
    },
    triggerLogDaysLookback: { type: Number, default: 14 },
    sampleTarget: { type: Number, default: 50 },
    sampledCases: { type: Number, default: 0 },
    dominantScenarioId: { type: String, default: null, index: true },
    metricsSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: null, index: true },
    completedAt: { type: Date, default: null, index: true },
    errorMessage: { type: String, default: null },
    runByUserId: { type: String, default: null },
  },
  { timestamps: true }
);

ScenarioEvalRunSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  createdAt: -1,
});

const ScenarioEvalRun =
  mongoose.models.ScenarioEvalRun ||
  mongoose.model("ScenarioEvalRun", ScenarioEvalRunSchema);

export default ScenarioEvalRun;
