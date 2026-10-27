import mongoose from "mongoose";

const ScenarioEvalMetricSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, default: null, index: true },
    runId: { type: String, required: true, index: true },
    metricKey: { type: String, required: true, index: true },
    metricValue: { type: Number, required: true },
    numerator: { type: Number, default: null },
    denominator: { type: Number, default: null },
    axialCode: { type: String, default: null, index: true },
    graderType: {
      type: String,
      enum: ["deterministic", "llm", "aggregate"],
      default: "aggregate",
      index: true,
    },
    measuredAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

ScenarioEvalMetricSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  metricKey: 1,
  measuredAt: -1,
});

const ScenarioEvalMetric =
  mongoose.models.ScenarioEvalMetric ||
  mongoose.model("ScenarioEvalMetric", ScenarioEvalMetricSchema);

export default ScenarioEvalMetric;
