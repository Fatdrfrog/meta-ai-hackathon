import { ScenarioTriggerLog } from "@/models/scenario-trigger-log";
import {
  ScenarioTriggerDailyMetric,
  SCENARIO_TRIGGER_DAILY_METRIC_UNIQUE_KEY,
} from "@/models/scenario-trigger-daily-metric";
import { ensureSingleFieldTtlIndex } from "@/lib/mongo-ttl-indexes";
import {
  resolveTtlSeconds,
  SCENARIO_TRIGGER_LOG_RETENTION,
  SCENARIO_TRIGGER_DAILY_METRIC_RETENTION,
} from "./ttl-utils";

export async function ensureScenarioObservabilityIndexes(
  options: { dryRun?: boolean } = {}
) {
  const db = ScenarioTriggerLog.db.db;
  if (!db)
    throw new Error(
      "MongoDB must be connected before ensuring scenario retention"
    );
  if (!options.dryRun) {
    await ScenarioTriggerDailyMetric.collection.createIndex(
      SCENARIO_TRIGGER_DAILY_METRIC_UNIQUE_KEY,
      { unique: true }
    );
  }
  const logs = await ensureSingleFieldTtlIndex({
    collection: ScenarioTriggerLog.collection,
    db,
    field: "evaluatedAt",
    expireAfterSeconds: resolveTtlSeconds(SCENARIO_TRIGGER_LOG_RETENTION),
    dryRun: options.dryRun,
  });
  const metrics = await ensureSingleFieldTtlIndex({
    collection: ScenarioTriggerDailyMetric.collection,
    db,
    field: "day",
    expireAfterSeconds: resolveTtlSeconds(
      SCENARIO_TRIGGER_DAILY_METRIC_RETENTION
    ),
    dryRun: options.dryRun,
  });
  return { logs, metrics };
}
