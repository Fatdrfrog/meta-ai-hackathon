import mongoose from "mongoose";
import { resolveTtlSeconds, SCENARIO_TRIGGER_DAILY_METRIC_RETENTION } from "@/lib/scenarios/ttl-utils";

const ScenarioTriggerDailyMetricSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true, index: true },
    day: { type: Date, required: true },
    eventKind: { type: String, required: true, index: true },
    triggerType: { type: String, default: null, index: true },
    totalCount: { type: Number, default: 0 },
    matchedCount: { type: Number, default: 0 },
    unmatchedCount: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const SCENARIO_TRIGGER_DAILY_METRIC_UNIQUE_KEY = {
    workspaceId: 1,
    scenarioId: 1,
    day: 1,
    eventKind: 1,
    triggerType: 1,
  } as const;
ScenarioTriggerDailyMetricSchema.index(
  SCENARIO_TRIGGER_DAILY_METRIC_UNIQUE_KEY,
  { unique: true }
);
ScenarioTriggerDailyMetricSchema.index(
  { day: 1 },
  {
    expireAfterSeconds: resolveTtlSeconds(SCENARIO_TRIGGER_DAILY_METRIC_RETENTION),
  }
);

export const ScenarioTriggerDailyMetric =
  mongoose.models.ScenarioTriggerDailyMetric ||
  mongoose.model(
    "ScenarioTriggerDailyMetric",
    ScenarioTriggerDailyMetricSchema
  );
