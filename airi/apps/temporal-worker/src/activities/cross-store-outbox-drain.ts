import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  assertContractVersion,
  CROSS_STORE_OUTBOX_DRAIN_BATCH_LIMIT,
  CROSS_STORE_OUTBOX_DRAIN_MAX_BATCHES,
  CROSS_STORE_OUTBOX_DRAIN_MAX_DURATION_MS,
  CROSS_STORE_OUTBOX_DRAIN_WORKFLOW_CONTRACT_VERSION,
  type CrossStoreOutboxDrainActivityInput,
  type CrossStoreOutboxDrainActivityResult,
  type CrossStoreOutboxDrainBatchResult,
} from "@icecore/temporal";
import { heartbeat } from "@temporalio/activity";

type ProcessBatch = (params: {
  deadlineAtMs: number;
  limit: number;
}) => Promise<CrossStoreOutboxDrainBatchResult>;

type DrainHeartbeat = (details: Record<string, unknown>) => void;

type ProcessCrossStoreOutboxBatch =
  typeof import("@/lib/cross-store-outbox").processCrossStoreOutboxBatch;

function resolveRuntimeModuleFunction<TFunction>(
  moduleValue: unknown,
  exportName: string,
): TFunction {
  if (!moduleValue || typeof moduleValue !== "object") {
    throw new Error(`Worker module is missing ${exportName}`);
  }

  const moduleRecord = moduleValue as Record<string, unknown>;
  const containers = [
    moduleRecord,
    moduleRecord.default,
    moduleRecord["module.exports"],
  ];
  for (const container of containers) {
    if (!container || typeof container !== "object") continue;
    const candidate = (container as Record<string, unknown>)[exportName];
    if (typeof candidate === "function") {
      return candidate as TFunction;
    }
  }

  throw new Error(`Worker module is missing ${exportName}`);
}

export function resolveProcessCrossStoreOutboxBatch(
  moduleValue: unknown,
): ProcessCrossStoreOutboxBatch {
  return resolveRuntimeModuleFunction<ProcessCrossStoreOutboxBatch>(
    moduleValue,
    "processCrossStoreOutboxBatch",
  );
}

function boundedInteger(
  value: number,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

export async function drainCrossStoreOutboxBatches(params: {
  processBatch: ProcessBatch;
  batchLimit?: number | null;
  maxBatches?: number | null;
  maxDurationMs?: number | null;
  heartbeat?: DrainHeartbeat;
  now?: () => number;
}): Promise<CrossStoreOutboxDrainActivityResult> {
  const batchLimit = boundedInteger(
    Number(params.batchLimit),
    CROSS_STORE_OUTBOX_DRAIN_BATCH_LIMIT,
    CROSS_STORE_OUTBOX_DRAIN_BATCH_LIMIT,
  );
  const maxBatches = boundedInteger(
    Number(params.maxBatches),
    CROSS_STORE_OUTBOX_DRAIN_MAX_BATCHES,
    100,
  );
  const maxDurationMs = boundedInteger(
    Number(params.maxDurationMs),
    CROSS_STORE_OUTBOX_DRAIN_MAX_DURATION_MS,
    55_000,
  );
  const now = params.now || Date.now;
  const startedAt = now();
  const aggregate: CrossStoreOutboxDrainBatchResult = {
    recoveredStale: 0,
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    skippedUnsupported: 0,
    analyticsBacklog: 0,
    analyticsFailed: 0,
  };
  let batches = 0;
  let stopReason: CrossStoreOutboxDrainActivityResult["stopReason"] =
    "max_batches";

  while (batches < maxBatches) {
    const result = await params.processBatch({
      deadlineAtMs: startedAt + maxDurationMs,
      limit: batchLimit,
    });
    batches += 1;
    aggregate.recoveredStale += result.recoveredStale;
    aggregate.claimed += result.claimed;
    aggregate.completed += result.completed;
    aggregate.retried += result.retried;
    aggregate.failed += result.failed;
    aggregate.skippedUnsupported += result.skippedUnsupported;
    aggregate.analyticsBacklog = result.analyticsBacklog;
    aggregate.analyticsFailed = result.analyticsFailed;
    if (
      result.customerWebhookIntentsAdmitted !== undefined ||
      result.customerWebhookIntentsHasMore !== undefined
    ) {
      aggregate.customerWebhookIntentsAdmitted =
        (aggregate.customerWebhookIntentsAdmitted || 0) +
        (result.customerWebhookIntentsAdmitted || 0);
      aggregate.customerWebhookIntentsSkipped =
        (aggregate.customerWebhookIntentsSkipped || 0) +
        (result.customerWebhookIntentsSkipped || 0);
      aggregate.customerWebhookIntentsHasMore =
        result.customerWebhookIntentsHasMore === true;
    }

    params.heartbeat?.({
      batch: batches,
      claimed: result.claimed,
      completed: result.completed,
      analyticsBacklog: result.analyticsBacklog,
      analyticsFailed: result.analyticsFailed,
      ...(result.customerWebhookIntentsAdmitted !== undefined
        ? {
            customerWebhookIntentsAdmitted:
              result.customerWebhookIntentsAdmitted,
            customerWebhookIntentsSkipped:
              result.customerWebhookIntentsSkipped || 0,
            customerWebhookIntentsHasMore:
              result.customerWebhookIntentsHasMore === true,
          }
        : {}),
    });

    if (now() - startedAt >= maxDurationMs) {
      stopReason = "time_budget";
      break;
    }
    const recoveryMadeProgress =
      result.customerWebhookIntentsHasMore === true &&
      (result.customerWebhookIntentsAdmitted || 0) +
        (result.customerWebhookIntentsSkipped || 0) >
        0;
    if (result.claimed < batchLimit && !recoveryMadeProgress) {
      stopReason = "drained";
      break;
    }
  }

  return {
    ...aggregate,
    batches,
    stopReason,
    durationMs: Math.max(0, now() - startedAt),
  };
}

export function buildCrossStoreOutboxDrainLogContext(
  result: CrossStoreOutboxDrainActivityResult,
) {
  return {
    note: "completed",
    outcome:
      result.failed > 0 || result.analyticsFailed > 0 ? "degraded" : "success",
    durationMs: result.durationMs,
    batches: result.batches,
    stopReason: result.stopReason,
    recoveredStale: result.recoveredStale,
    claimed: result.claimed,
    completed: result.completed,
    retried: result.retried,
    failed: result.failed,
    skippedUnsupported: result.skippedUnsupported,
    analyticsBacklog: result.analyticsBacklog,
    analyticsFailed: result.analyticsFailed,
    ...(result.customerWebhookIntentsAdmitted !== undefined
      ? {
          customerWebhookIntentsAdmitted: result.customerWebhookIntentsAdmitted,
          customerWebhookIntentsSkipped:
            result.customerWebhookIntentsSkipped || 0,
          customerWebhookIntentsHasMore:
            result.customerWebhookIntentsHasMore === true,
        }
      : {}),
  };
}

export async function crossStoreOutboxDrainActivity(
  input: CrossStoreOutboxDrainActivityInput,
): Promise<CrossStoreOutboxDrainActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: CROSS_STORE_OUTBOX_DRAIN_WORKFLOW_CONTRACT_VERSION },
    "cross-store outbox drain",
  );

  const crossStoreOutboxModule = await import("@/lib/cross-store-outbox");
  const processCrossStoreOutboxBatch = resolveProcessCrossStoreOutboxBatch(
    crossStoreOutboxModule,
  );
  const { publishLlmAnalyticsEventsToPubSub } = await import(
    "../gcp-llm-analytics.js"
  );
  const result = await drainCrossStoreOutboxBatches({
    batchLimit: input.batchLimit,
    maxBatches: input.maxBatches,
    maxDurationMs: input.maxDurationMs,
    heartbeat,
    processBatch: async ({ deadlineAtMs, limit }) =>
      (await processCrossStoreOutboxBatch({
        deadlineAtMs,
        limit,
        onProgress: ({ candidates, processed }) =>
          heartbeat({ candidates, processed }),
        publishLlmAnalyticsEvents: publishLlmAnalyticsEventsToPubSub,
      })) as CrossStoreOutboxDrainBatchResult,
  });

  airiWorkerLogger.info(
    "cross_store_outbox.drain",
    buildCrossStoreOutboxDrainLogContext(result),
  );
  return result;
}
