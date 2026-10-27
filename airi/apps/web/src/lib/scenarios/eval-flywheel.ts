import ScenarioEvalCase, {
  SCENARIO_EVAL_AXIAL_CODES,
} from "@/models/scenario-eval-case";
import ScenarioEvalMetric from "@/models/scenario-eval-metric";
import ScenarioEvalRun from "@/models/scenario-eval-run";
import { ScenarioTriggerLog } from "@/models/scenario-trigger-log";
import { readTrimmedString } from "@icecore/shared/lib/value-utils";

export type ScenarioEvalAxialCode = (typeof SCENARIO_EVAL_AXIAL_CODES)[number];

type TriggerLogRecord = {
  _id?: unknown;
  workspaceId?: string;
  conversationId?: string;
  scenarioId?: string;
  scenarioName?: string;
  triggerType?: string | null;
  eventKind?: string;
  matched?: boolean;
  mismatchReason?: string | null;
  selectedActionType?: string | null;
  selectedActionNodeId?: string | null;
  evaluatedAt?: string | Date;
  createdAt?: string | Date;
};

export type ScenarioEvalRunInput = {
  workspaceId: string;
  scenarioId?: string | null;
  sampleTarget?: number;
  triggerLogDaysLookback?: number;
  runByUserId?: string | null;
};

export type ScenarioEvalRunResult = {
  runId: string;
  dominantScenarioId: string | null;
  sampledCases: number;
  metrics: Record<string, number>;
};

function normalizePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function resolveAxialCode(log: TriggerLogRecord): ScenarioEvalAxialCode {
  const mismatchReason = readTrimmedString(log.mismatchReason).toLowerCase();
  const eventKind = readTrimmedString(log.eventKind).toLowerCase();
  const triggerType = readTrimmedString(log.triggerType).toLowerCase();

  if (mismatchReason.includes("trigger_mismatch")) return "trigger_mismatch";
  if (mismatchReason.includes("flow_no_matching_action")) {
    return "wrong_action_selected";
  }
  if (
    triggerType.includes("timeout") ||
    triggerType.includes("business_hours") ||
    eventKind.includes("no_human_reply")
  ) {
    return "timing_window_error";
  }
  if (triggerType.includes("channel") || triggerType.includes("template")) {
    return "channel_template_error";
  }
  if (
    mismatchReason.includes("delivery") ||
    mismatchReason.includes("retry") ||
    readTrimmedString(log.selectedActionType).toLowerCase() === "assign_human"
  ) {
    return "delivery_or_retry_error";
  }
  return "other";
}

function resolveSeverity(
  axialCode: ScenarioEvalAxialCode
): "critical" | "high" | "medium" | "low" {
  if (axialCode === "delivery_or_retry_error") return "critical";
  if (axialCode === "wrong_action_selected") return "high";
  if (axialCode === "timing_window_error") return "high";
  if (axialCode === "trigger_mismatch") return "medium";
  return "low";
}

function resolveFailureType(axialCode: ScenarioEvalAxialCode): string {
  return axialCode;
}

function resolveOpenCode(
  log: TriggerLogRecord,
  axialCode: ScenarioEvalAxialCode
): string {
  const reason = readTrimmedString(log.mismatchReason);
  if (reason) return reason;
  return `auto:${axialCode}`;
}

function resolveDatasetSplit(
  index: number,
  total: number
): "train" | "validation" | "test" {
  if (total <= 0) return "validation";
  const ratio = index / total;
  if (ratio < 0.2) return "train";
  if (ratio < 0.6) return "validation";
  return "test";
}

function computeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function mapTriggerLogToExpectedOutcome(log: TriggerLogRecord): string {
  return `Expected trigger match with valid action path for event ${readTrimmedString(log.eventKind)}`;
}

function mapTriggerLogToActualOutcome(log: TriggerLogRecord): string {
  if (log.matched) {
    return `Matched. Selected action ${readTrimmedString(log.selectedActionType) || "unknown"}.`;
  }
  const reason = readTrimmedString(log.mismatchReason) || "no reason";
  return `Not matched. ${reason}.`;
}

function resolveDominantScenarioId(logs: TriggerLogRecord[]): string | null {
  const counts = new Map<string, number>();
  for (const log of logs) {
    const scenarioId = readTrimmedString(log.scenarioId);
    if (!scenarioId) continue;
    counts.set(scenarioId, (counts.get(scenarioId) || 0) + 1);
  }
  let bestId: string | null = null;
  let bestCount = 0;
  for (const [scenarioId, count] of counts.entries()) {
    if (count > bestCount) {
      bestId = scenarioId;
      bestCount = count;
    }
  }
  return bestId;
}

export async function runScenarioEvalFlywheel(
  input: ScenarioEvalRunInput
): Promise<ScenarioEvalRunResult> {
  const workspaceId = readTrimmedString(input.workspaceId);
  const scenarioId = readTrimmedString(input.scenarioId);
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  const sampleTarget = normalizePositiveInt(input.sampleTarget, 50, 10, 500);
  const triggerLogDaysLookback = normalizePositiveInt(
    input.triggerLogDaysLookback,
    14,
    1,
    90
  );
  const runByUserId = readTrimmedString(input.runByUserId) || null;

  const run = await ScenarioEvalRun.create({
    workspaceId,
    scenarioId: scenarioId || null,
    status: "running",
    triggerLogDaysLookback,
    sampleTarget,
    runByUserId,
    startedAt: new Date(),
  });

  const runId = String(run._id);
  try {
    const since = new Date();
    since.setDate(since.getDate() - triggerLogDaysLookback);

    const baseQuery: Record<string, unknown> = {
      workspaceId,
      evaluatedAt: { $gte: since },
    };
    if (scenarioId) {
      baseQuery.scenarioId = scenarioId;
    }

    const failLogs = await ScenarioTriggerLog.find({
      ...baseQuery,
      matched: false,
    })
      .sort({ evaluatedAt: -1 })
      .limit(sampleTarget)
      .lean<TriggerLogRecord[]>();

    const passLogs = await ScenarioTriggerLog.find({
      ...baseQuery,
      matched: true,
    })
      .sort({ evaluatedAt: -1 })
      .limit(sampleTarget)
      .lean<TriggerLogRecord[]>();

    const sampleLogs = [...failLogs, ...passLogs];
    const totalSamples = sampleLogs.length;

    if (totalSamples === 0) {
      await ScenarioEvalRun.updateOne(
        { _id: runId },
        {
          $set: {
            status: "completed",
            sampledCases: 0,
            dominantScenarioId: scenarioId || null,
            metricsSnapshot: {
              triggerPathPassRate: 0,
              scheduleWindowPassRate: 0,
              llmQualityPassRate: 0,
              judgeTPR: 0,
              judgeTNR: 0,
            },
            completedAt: new Date(),
          },
        }
      );
      return {
        runId,
        dominantScenarioId: scenarioId || null,
        sampledCases: 0,
        metrics: {
          triggerPathPassRate: 0,
          scheduleWindowPassRate: 0,
          llmQualityPassRate: 0,
          judgeTPR: 0,
          judgeTNR: 0,
        },
      };
    }

    const evalCases = sampleLogs.map((log, index) => {
      const axialCode = resolveAxialCode(log);
      return {
        workspaceId,
        scenarioId: readTrimmedString(log.scenarioId),
        runId,
        scenarioName: readTrimmedString(log.scenarioName) || null,
        triggerLogId: readTrimmedString(log._id),
        conversationId: readTrimmedString(log.conversationId) || null,
        openCode: resolveOpenCode(log, axialCode),
        axialCode,
        failureType: resolveFailureType(axialCode),
        severity: resolveSeverity(axialCode),
        expectedOutcome: mapTriggerLogToExpectedOutcome(log),
        actualOutcome: mapTriggerLogToActualOutcome(log),
        traceRefs: [
          `triggerLog:${readTrimmedString(log._id)}`,
          `conversation:${readTrimmedString(log.conversationId)}`,
        ].filter(Boolean),
        source: "auto",
        sampledAt: new Date(),
        evaluatedAt: log.evaluatedAt ? new Date(log.evaluatedAt) : new Date(),
        datasetSplit: resolveDatasetSplit(index, totalSamples),
      };
    });

    await ScenarioEvalCase.bulkWrite(
      evalCases.map(entry => ({
        updateOne: {
          filter: {
            workspaceId: entry.workspaceId,
            triggerLogId: entry.triggerLogId,
          },
          update: {
            $set: entry,
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    const triggerPathPassCount = sampleLogs.filter(log =>
      Boolean(log.matched)
    ).length;
    const scheduleWindowPassCount = evalCases.filter(
      entry => entry.axialCode !== "timing_window_error"
    ).length;
    const llmQualityPassCount = evalCases.filter(
      entry => entry.axialCode !== "channel_template_error"
    ).length;

    const goldFails = sampleLogs.filter(log => log.matched === false).length;
    const goldPasses = sampleLogs.filter(log => log.matched === true).length;
    const predictedFails = evalCases.filter(
      entry => entry.axialCode !== "other"
    ).length;
    const truePositive = evalCases.filter(
      (entry, index) =>
        entry.axialCode !== "other" && sampleLogs[index]?.matched === false
    ).length;
    const trueNegative = evalCases.filter(
      (entry, index) =>
        entry.axialCode === "other" && sampleLogs[index]?.matched === true
    ).length;

    const metrics = {
      triggerPathPassRate: computeRate(triggerPathPassCount, totalSamples),
      scheduleWindowPassRate: computeRate(
        scheduleWindowPassCount,
        totalSamples
      ),
      llmQualityPassRate: computeRate(llmQualityPassCount, totalSamples),
      judgeTPR: computeRate(truePositive, goldFails),
      judgeTNR: computeRate(trueNegative, goldPasses),
      failPredictionRate: computeRate(predictedFails, totalSamples),
    };

    await ScenarioEvalMetric.insertMany(
      Object.entries(metrics).map(([metricKey, metricValue]) => ({
        workspaceId,
        scenarioId: scenarioId || null,
        runId,
        metricKey,
        metricValue,
        graderType:
          metricKey === "llmQualityPassRate" ? "llm" : "deterministic",
        measuredAt: new Date(),
      })),
      { ordered: false }
    );

    await ScenarioEvalRun.updateOne(
      { _id: runId },
      {
        $set: {
          status: "completed",
          sampledCases: totalSamples,
          dominantScenarioId:
            scenarioId ||
            resolveDominantScenarioId(failLogs) ||
            resolveDominantScenarioId(sampleLogs),
          metricsSnapshot: metrics,
          completedAt: new Date(),
          errorMessage: null,
        },
      }
    );

    return {
      runId,
      dominantScenarioId:
        scenarioId ||
        resolveDominantScenarioId(failLogs) ||
        resolveDominantScenarioId(sampleLogs),
      sampledCases: totalSamples,
      metrics,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await ScenarioEvalRun.updateOne(
      { _id: runId },
      {
        $set: {
          status: "failed",
          completedAt: new Date(),
          errorMessage: errorMessage.slice(0, 1000),
        },
      }
    );
    throw error;
  }
}
