import type {
  ScenarioActionType,
  ScenarioMatchingRole,
} from "@icecore/scenario-contracts";
import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";
import type { ScenarioTriggerLogMeta } from "@/lib/scenarios/trigger-log-meta";
import type { ScenarioRuntimeEventKind } from "@icecore/scenario-contracts";
import { ScenarioTriggerDailyMetric } from "@/models/scenario-trigger-daily-metric";
import { ScenarioTriggerLog } from "@/models/scenario-trigger-log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScenarioTriggerLogResult =
  | "winner"
  | "matched_but_shadowed"
  | "blocked"
  | "trigger_mismatch"
  | "no_action";

type ScenarioTriggerLogInsertDoc = {
  workspaceId: string;
  conversationId: string;
  scenarioId: string;
  scenarioName: string;
  evaluationId: string;
  scenarioPriority: number | null;
  candidateOrder: number | null;
  matchingRole: ScenarioMatchingRole | null;
  result: ScenarioTriggerLogResult;
  winnerScenarioId: string | null;
  shadowedByScenarioId: string | null;
  shadowedByOrder: number | null;
  triggerType: string | null;
  eventKind: ScenarioRuntimeEventKind;
  matched: boolean;
  mismatchReason: string | null;
  selectedActionNodeId: string | null;
  selectedActionType: ScenarioActionType | null;
  branchNodeIds: string[];
  meta: ScenarioTriggerLogMeta | null;
  evaluatedAt: Date;
};

// ---------------------------------------------------------------------------
// Constants & buffer state
// ---------------------------------------------------------------------------

const DEFAULT_MATCHED_TRIGGER_LOG_SAMPLE_RATE = 1;
const DEFAULT_UNMATCHED_TRIGGER_LOG_SAMPLE_RATE = 1;
const CLIENT_MESSAGE_TRIGGER_LOG_TYPE = "incoming_customer_message";
const triggerLogInsertBuffer: ScenarioTriggerLogInsertDoc[] = [];
type DailyMetricIncrement = {
  workspaceId: string;
  scenarioId: string;
  day: Date;
  eventKind: ScenarioRuntimeEventKind;
  triggerType: string | null;
  totalCount: number;
  matchedCount: number;
  unmatchedCount: number;
};
const dailyMetricBuffer = new Map<string, DailyMetricIncrement>();
let triggerLogFlushScheduled = false;

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function normalizeSampleRate(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function resolveScenarioTriggerLogSampleRates(): {
  matched: number;
  unmatched: number;
} {
  return {
    matched: normalizeSampleRate(
      process.env.SCENARIO_TRIGGER_LOG_SAMPLE_MATCHED,
      DEFAULT_MATCHED_TRIGGER_LOG_SAMPLE_RATE
    ),
    unmatched: normalizeSampleRate(
      process.env.SCENARIO_TRIGGER_LOG_SAMPLE_UNMATCHED,
      DEFAULT_UNMATCHED_TRIGGER_LOG_SAMPLE_RATE
    ),
  };
}

function shouldPersistScenarioTriggerLogSession(
  params: {
    matched: boolean;
  }[]
): boolean {
  const sampleRates = resolveScenarioTriggerLogSampleRates();
  const sampleRate = params.some(item => item.matched)
    ? sampleRates.matched
    : sampleRates.unmatched;
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return Math.random() <= sampleRate;
}

const WHATSAPP_QR_TRIGGER_LOG_TYPE = "whatsapp_qr";

function resolvePersistedTriggerType(
  meta: ScenarioTriggerLogMeta | null | undefined
): string | null {
  if (!meta) return null;
  if (
    meta.qrAnchored === true ||
    meta.entryPointType === "whatsapp_qr" ||
    meta.qrIngress?.anchored === true
  ) {
    return WHATSAPP_QR_TRIGGER_LOG_TYPE;
  }
  return typeof meta.triggerNodeId === "string" && meta.triggerNodeId.trim()
    ? CLIENT_MESSAGE_TRIGGER_LOG_TYPE
    : null;
}

// ---------------------------------------------------------------------------
// Flushing & daily metric aggregation
// ---------------------------------------------------------------------------

function toUtcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function isDailyMetricTriggerMatched(
  item: ScenarioTriggerLogInsertDoc
): boolean {
  return item.matched || item.result === "matched_but_shadowed";
}

function bufferDailyMetric(item: ScenarioTriggerLogInsertDoc): void {
  const day = toUtcDayStart(item.evaluatedAt);
  const triggerType = item.triggerType || null;
  const triggerMatched = isDailyMetricTriggerMatched(item);
  const key = JSON.stringify([
    item.workspaceId,
    item.scenarioId,
    day.toISOString(),
    item.eventKind,
    triggerType,
  ]);
  const current = dailyMetricBuffer.get(key);
  if (current) {
    current.totalCount += 1;
    if (triggerMatched) current.matchedCount += 1;
    else current.unmatchedCount += 1;
    return;
  }
  dailyMetricBuffer.set(key, {
    workspaceId: item.workspaceId,
    scenarioId: item.scenarioId,
    day,
    eventKind: item.eventKind,
    triggerType,
    totalCount: 1,
    matchedCount: triggerMatched ? 1 : 0,
    unmatchedCount: triggerMatched ? 0 : 1,
  });
}

function scheduleScenarioTriggerLogFlush(): void {
  if (triggerLogFlushScheduled) return;
  triggerLogFlushScheduled = true;

  setImmediate(async () => {
    const batch = triggerLogInsertBuffer.splice(
      0,
      triggerLogInsertBuffer.length
    );
    const metrics = Array.from(dailyMetricBuffer.values());
    dailyMetricBuffer.clear();
    try {
      try {
        if (batch.length > 0) {
          await ScenarioTriggerLog.insertMany(batch, { ordered: false });
        }
      } catch (error) {
        airiOrchestrationLogger.warn("airi.orchestration.scenario_trigger_log", {
          size: batch.length,
          note: "persist_batch_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        if (metrics.length > 0) {
          await ScenarioTriggerDailyMetric.bulkWrite(
            metrics.map(metric => ({
              updateOne: {
                filter: {
                  workspaceId: metric.workspaceId,
                  scenarioId: metric.scenarioId,
                  day: metric.day,
                  eventKind: metric.eventKind,
                  triggerType: metric.triggerType,
                },
                update: {
                  $inc: {
                    totalCount: metric.totalCount,
                    matchedCount: metric.matchedCount,
                    unmatchedCount: metric.unmatchedCount,
                  },
                  $set: {
                    updatedAt: new Date(),
                  },
                },
                upsert: true,
              },
            })),
            { ordered: false }
          );
        }
      } catch (error) {
        airiOrchestrationLogger.warn("airi.orchestration.scenario_trigger_log", {
          size: metrics.length,
          note: "persist_daily_aggregates_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      // Keep one flush in flight; evaluations arriving during I/O join the next batch.
      triggerLogFlushScheduled = false;
      if (triggerLogInsertBuffer.length > 0 || dailyMetricBuffer.size > 0) {
        scheduleScenarioTriggerLogFlush();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ScenarioTriggerLogEvaluationParams = {
  workspaceId: string;
  conversationId: string;
  scenarioId: string;
  scenarioName: string;
  evaluationId: string;
  scenarioPriority?: number | null;
  candidateOrder?: number | null;
  matchingRole?: ScenarioMatchingRole | null;
  result: ScenarioTriggerLogResult;
  winnerScenarioId?: string | null;
  shadowedByScenarioId?: string | null;
  shadowedByOrder?: number | null;
  eventKind: ScenarioRuntimeEventKind;
  matched: boolean;
  mismatchReason?: string;
  selectedActionNodeId?: string;
  selectedActionType?: ScenarioActionType;
  branchNodeIds?: string[];
  meta?: ScenarioTriggerLogMeta | null;
  evaluatedAt?: Date;
};

export async function logScenarioTriggerEvaluations(
  params: ScenarioTriggerLogEvaluationParams[]
): Promise<void> {
  if (params.length === 0) {
    return;
  }

  const documents: ScenarioTriggerLogInsertDoc[] = params.map(item => ({
    workspaceId: item.workspaceId,
    conversationId: item.conversationId,
    scenarioId: item.scenarioId,
    scenarioName: item.scenarioName,
    evaluationId: item.evaluationId,
    scenarioPriority:
      typeof item.scenarioPriority === "number" &&
      Number.isFinite(item.scenarioPriority)
        ? item.scenarioPriority
        : null,
    candidateOrder:
      typeof item.candidateOrder === "number" &&
      Number.isFinite(item.candidateOrder)
        ? item.candidateOrder
        : null,
    matchingRole: item.matchingRole || null,
    result: item.result,
    winnerScenarioId: item.winnerScenarioId || null,
    shadowedByScenarioId: item.shadowedByScenarioId || null,
    shadowedByOrder:
      typeof item.shadowedByOrder === "number" &&
      Number.isFinite(item.shadowedByOrder)
        ? item.shadowedByOrder
        : null,
    triggerType: resolvePersistedTriggerType(item.meta),
    eventKind: item.eventKind,
    matched: item.matched,
    mismatchReason: item.mismatchReason || null,
    selectedActionNodeId: item.selectedActionNodeId || null,
    selectedActionType: item.selectedActionType || null,
    branchNodeIds: item.branchNodeIds || [],
    meta: item.meta || null,
    evaluatedAt: item.evaluatedAt || new Date(),
  }));
  for (const document of documents) bufferDailyMetric(document);
  if (shouldPersistScenarioTriggerLogSession(params)) {
    triggerLogInsertBuffer.push(...documents);
  }
  scheduleScenarioTriggerLogFlush();
}
