import mongoose from "mongoose";

export const SCENARIO_EVAL_AXIAL_CODES = [
  "trigger_mismatch",
  "wrong_action_selected",
  "timing_window_error",
  "channel_template_error",
  "delivery_or_retry_error",
  "other",
] as const;

const ScenarioEvalCaseSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true, index: true },
    runId: { type: String, default: null, index: true },
    scenarioName: { type: String, default: null },
    triggerLogId: { type: String, default: null, index: true },
    conversationId: { type: String, default: null, index: true },
    openCode: { type: String, default: null },
    axialCode: {
      type: String,
      enum: [...SCENARIO_EVAL_AXIAL_CODES],
      default: "other",
      index: true,
    },
    failureType: { type: String, default: null, index: true },
    severity: {
      type: String,
      enum: ["critical", "high", "medium", "low", "info"],
      default: "medium",
      index: true,
    },
    expectedOutcome: { type: String, default: null },
    actualOutcome: { type: String, default: null },
    traceRefs: { type: [String], default: [] },
    source: { type: String, enum: ["manual", "auto"], default: "auto" },
    sampledAt: { type: Date, default: Date.now, index: true },
    evaluatedAt: { type: Date, default: null, index: true },
    datasetSplit: {
      type: String,
      enum: ["train", "validation", "test"],
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

ScenarioEvalCaseSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  runId: 1,
  sampledAt: -1,
});
ScenarioEvalCaseSchema.index({
  workspaceId: 1,
  axialCode: 1,
  sampledAt: -1,
});

const ScenarioEvalCase =
  mongoose.models.ScenarioEvalCase ||
  mongoose.model("ScenarioEvalCase", ScenarioEvalCaseSchema);

export default ScenarioEvalCase;
