import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  VIDEO_GENERATION_RECONCILE_SCHEDULE_CATCHUP_WINDOW_MS,
  VIDEO_GENERATION_RECONCILE_SCHEDULE_ID,
  VIDEO_GENERATION_RECONCILE_SCHEDULE_INTERVAL_MS,
  VIDEO_GENERATION_RECONCILE_WORKFLOW,
  VIDEO_GENERATION_RECONCILE_WORKFLOW_CONTRACT_VERSION,
} from "@icecore/temporal";
import { Client, Connection, type ScheduleOptions } from "@temporalio/client";

import type { TemporalWorkerConfig } from "./config.js";
import {
  createOrUpdateTemporalSchedule,
  runTemporalScheduleUpsertWithDeadline,
} from "./temporal-schedule-upsert.js";

export function buildVideoGenerationReconcileScheduleOptions(params: {
  taskQueue: string;
}): ScheduleOptions {
  return {
    scheduleId: VIDEO_GENERATION_RECONCILE_SCHEDULE_ID,
    spec: {
      intervals: [{ every: VIDEO_GENERATION_RECONCILE_SCHEDULE_INTERVAL_MS }],
    },
    action: {
      type: "startWorkflow" as const,
      workflowType: VIDEO_GENERATION_RECONCILE_WORKFLOW,
      taskQueue: params.taskQueue,
      workflowId: `${VIDEO_GENERATION_RECONCILE_SCHEDULE_ID}:run`,
      args: [
        {
          contractVersion: VIDEO_GENERATION_RECONCILE_WORKFLOW_CONTRACT_VERSION,
        },
      ],
      workflowRunTimeout: 10 * 60 * 1000,
      workflowExecutionTimeout: 10 * 60 * 1000,
    },
    policies: {
      overlap: "SKIP" as const,
      catchupWindow: VIDEO_GENERATION_RECONCILE_SCHEDULE_CATCHUP_WINDOW_MS,
    },
    state: { paused: false },
  };
}

export async function ensureVideoGenerationReconcileSchedule(params: {
  config: TemporalWorkerConfig;
  signal?: AbortSignal;
}): Promise<{ enabled: true; action: "created" | "updated" }> {
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
        createOrUpdateTemporalSchedule(
          client.schedule,
          buildVideoGenerationReconcileScheduleOptions({
            taskQueue: params.config.taskQueue,
          }),
        ),
      params.signal,
    );
    airiWorkerLogger.info("video.generation.reconcile.schedule", {
      note: action,
      scheduleId: VIDEO_GENERATION_RECONCILE_SCHEDULE_ID,
      taskQueue: params.config.taskQueue,
    });
    return { enabled: true, action };
  } finally {
    await connection.close();
  }
}
