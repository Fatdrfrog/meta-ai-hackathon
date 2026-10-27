import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  WORKSPACE_USAGE_REPAIR_DEFAULT_LIMIT,
  WORKSPACE_USAGE_REPAIR_SCHEDULE_CATCHUP_WINDOW_MS,
  WORKSPACE_USAGE_REPAIR_SCHEDULE_ID,
  WORKSPACE_USAGE_REPAIR_SCHEDULE_INTERVAL_MS,
  WORKSPACE_USAGE_REPAIR_WORKFLOW,
  WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
} from "@icecore/temporal";
import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  type ScheduleClient,
  type ScheduleOptions,
} from "@temporalio/client";

import type { TemporalWorkerConfig } from "./config.js";
import { runTemporalScheduleUpsertWithDeadline } from "./temporal-schedule-upsert.js";

export function isWorkspaceUsageRepairScheduleEnabled(
  value: string | undefined,
): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return !["0", "false", "no", "off"].includes(normalized);
}

export function buildWorkspaceUsageRepairScheduleOptions(params: {
  taskQueue: string;
  limit?: number | null;
}): ScheduleOptions {
  const parsedLimit = Number.parseInt(String(params.limit || ""), 10);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 1_000)
      : WORKSPACE_USAGE_REPAIR_DEFAULT_LIMIT;

  return {
    scheduleId: WORKSPACE_USAGE_REPAIR_SCHEDULE_ID,
    spec: {
      intervals: [{ every: WORKSPACE_USAGE_REPAIR_SCHEDULE_INTERVAL_MS }],
    },
    action: {
      type: "startWorkflow" as const,
      workflowType: WORKSPACE_USAGE_REPAIR_WORKFLOW,
      taskQueue: params.taskQueue,
      workflowId: `${WORKSPACE_USAGE_REPAIR_SCHEDULE_ID}:run`,
      args: [
        {
          contractVersion: WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
          limit,
          reason: "scheduled_repair",
          includeHistoricalMessageCounts: false,
        },
      ],
      workflowRunTimeout: 30 * 60 * 1000,
      workflowExecutionTimeout: 30 * 60 * 1000,
    },
    policies: {
      overlap: "SKIP" as const,
      catchupWindow: WORKSPACE_USAGE_REPAIR_SCHEDULE_CATCHUP_WINDOW_MS,
    },
    state: {
      paused: false,
    },
  };
}

export async function createOrUpdateWorkspaceUsageRepairSchedule(
  scheduleClient: ScheduleClient,
  options: ReturnType<typeof buildWorkspaceUsageRepairScheduleOptions>,
): Promise<"created" | "updated"> {
  const handle = scheduleClient.getHandle(options.scheduleId);
  try {
    await handle.describe();
  } catch (error) {
    if (!isScheduleNotFound(error)) throw error;
    try {
      await scheduleClient.create(options);
      return "created";
    } catch (createError) {
      if (!(createError instanceof ScheduleAlreadyRunning)) {
        throw createError;
      }
    }
  }

  await handle.update(() => ({
    spec: options.spec,
    action: options.action,
    policies: options.policies,
    state: options.state ?? { paused: false },
  }));
  return "updated";
}

export async function ensureWorkspaceUsageRepairSchedule(params: {
  config: TemporalWorkerConfig;
  signal?: AbortSignal;
}): Promise<{ enabled: boolean; action?: "created" | "updated" }> {
  if (
    !isWorkspaceUsageRepairScheduleEnabled(
      process.env.WORKSPACE_USAGE_REPAIR_SCHEDULE_ENABLED,
    )
  ) {
    airiWorkerLogger.info("workspace.usage.repair.schedule", {
      note: "disabled",
    });
    return { enabled: false };
  }

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
        createOrUpdateWorkspaceUsageRepairSchedule(
          client.schedule,
          buildWorkspaceUsageRepairScheduleOptions({
            taskQueue: params.config.taskQueue,
            limit: Number(process.env.WORKSPACE_USAGE_REPAIR_LIMIT || ""),
          }),
        ),
      params.signal,
    );
    airiWorkerLogger.info("workspace.usage.repair.schedule", {
      note: action,
      scheduleId: WORKSPACE_USAGE_REPAIR_SCHEDULE_ID,
      taskQueue: params.config.taskQueue,
    });
    return { enabled: true, action };
  } finally {
    await connection.close();
  }
}

function isScheduleNotFound(error: unknown): boolean {
  if (error instanceof ScheduleNotFoundError) return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.toLowerCase().includes("not found") ||
    message.toLowerCase().includes("unknown schedule")
  );
}
