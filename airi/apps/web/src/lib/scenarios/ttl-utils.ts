/**
 * Shared TTL resolution utility for Mongoose schema expireAfterSeconds indexes.
 *
 * Both ScenarioTriggerLog and ScenarioTriggerDailyMetric use the same pattern
 * of reading a TTL from an environment variable and falling back to a default.
 */
export const SCENARIO_TRIGGER_LOG_RETENTION = {
  envVar: "SCENARIO_TRIGGER_LOG_TTL_DAYS",
  defaultDays: 30,
} as const;
export const SCENARIO_TRIGGER_DAILY_METRIC_RETENTION = {
  envVar: "SCENARIO_TRIGGER_DAILY_METRICS_TTL_DAYS",
  defaultDays: 365,
} as const;

export function resolveTtlSeconds(params: {
  envVar: string;
  defaultDays: number;
}): number {
  const raw = Number.parseInt(process.env[params.envVar] || "", 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : params.defaultDays;
  return Math.max(1, days) * 24 * 60 * 60;
}
