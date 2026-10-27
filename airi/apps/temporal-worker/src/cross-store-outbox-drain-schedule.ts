import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  CROSS_STORE_OUTBOX_DRAIN_BATCH_LIMIT,
  CROSS_STORE_OUTBOX_DRAIN_MAX_BATCHES,
  CROSS_STORE_OUTBOX_DRAIN_MAX_DURATION_MS,
  CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_CATCHUP_WINDOW_MS,
  CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_ID,
  CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_INTERVAL_MS,
  CROSS_STORE_OUTBOX_DRAIN_WORKFLOW,
  CROSS_STORE_OUTBOX_DRAIN_WORKFLOW_CONTRACT_VERSION,
} from "@icecore/temporal";
import {
  Client,
  Connection,
  ScheduleNotFoundError,
  type ScheduleClient,
  type ScheduleOptions,
} from "@temporalio/client";

import type { TemporalWorkerConfig } from "./config.js";
import {
  createOrUpdateTemporalSchedule,
  runTemporalScheduleUpsertWithDeadline,
} from "./temporal-schedule-upsert.js";

export function isCrossStoreOutboxDrainScheduleEnabled(
  value: string | undefined,
): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return !["0", "false", "no", "off"].includes(normalized);
}

export function buildCrossStoreOutboxDrainScheduleOptions(params: {
  taskQueue: string;
}): ScheduleOptions {
  return {
    scheduleId: CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_ID,
    spec: {
      intervals: [{ every: CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_INTERVAL_MS }],
    },
    action: {
      type: "startWorkflow" as const,
      workflowType: CROSS_STORE_OUTBOX_DRAIN_WORKFLOW,
      taskQueue: params.taskQueue,
      workflowId: `${CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_ID}:run`,
      args: [
        {
          contractVersion: CROSS_STORE_OUTBOX_DRAIN_WORKFLOW_CONTRACT_VERSION,
          batchLimit: CROSS_STORE_OUTBOX_DRAIN_BATCH_LIMIT,
          maxBatches: CROSS_STORE_OUTBOX_DRAIN_MAX_BATCHES,
          maxDurationMs: CROSS_STORE_OUTBOX_DRAIN_MAX_DURATION_MS,
        },
      ],
      workflowRunTimeout: 10 * 60_000,
      workflowExecutionTimeout: 10 * 60_000,
    },
    policies: {
      overlap: "SKIP" as const,
      catchupWindow: CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_CATCHUP_WINDOW_MS,
    },
    state: {
      paused: false,
    },
  };
}

function isScheduleNotFound(error: unknown): boolean {
  if (error instanceof ScheduleNotFoundError) return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.toLowerCase().includes("not found") ||
    message.toLowerCase().includes("unknown schedule")
  );
}

export async function reconcileCrossStoreOutboxDrainSchedule(params: {
  enabled: boolean;
  scheduleClient: ScheduleClient;
  taskQueue: string;
}): Promise<"created" | "updated" | "paused" | "not_found"> {
  if (params.enabled) {
    return createOrUpdateTemporalSchedule(
      params.scheduleClient,
      buildCrossStoreOutboxDrainScheduleOptions({
        taskQueue: params.taskQueue,
      }),
    );
  }

  try {
    await params.scheduleClient
      .getHandle(CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_ID)
      .pause("disabled by worker configuration");
    return "paused";
  } catch (error) {
    if (isScheduleNotFound(error)) return "not_found";
    throw error;
  }
}

export async function ensureCrossStoreOutboxDrainSchedule(params: {
  config: TemporalWorkerConfig;
  signal?: AbortSignal;
}): Promise<{
  enabled: boolean;
  action: "created" | "updated" | "paused" | "not_found";
}> {
  const enabled = isCrossStoreOutboxDrainScheduleEnabled(
    process.env.CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_ENABLED,
  );

  const connection = Connection.lazy({
    address: params.config.address,
    tls: params.config.tls ? {} : undefined,
    apiKey: params.config.apiKey || undefined,
  });
  const client = new Client({
    connection,
    namespace: params.config.namespace,
  });

  try {
    const action = await runTemporalScheduleUpsertWithDeadline(
      client,
      () =>
        reconcileCrossStoreOutboxDrainSchedule({
          enabled,
          scheduleClient: client.schedule,
          taskQueue: params.config.taskQueue,
        }),
      params.signal,
    );
    airiWorkerLogger.info("cross_store_outbox.drain.schedule", {
      note: action,
      scheduleId: CROSS_STORE_OUTBOX_DRAIN_SCHEDULE_ID,
      taskQueue: params.config.taskQueue,
    });
    return { enabled, action };
  } finally {
    await connection.close();
  }
}
