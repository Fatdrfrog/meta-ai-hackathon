import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_DEFAULT_LIMIT,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_CATCHUP_WINDOW_MS,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ID,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_INTERVAL_MS,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW,
  WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW_CONTRACT_VERSION,
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

function normalizeLimit(limit?: number | null): number {
  if (!Number.isFinite(limit || Number.NaN)) {
    return WHATSAPP_CALL_TRANSCRIPTION_DRAIN_DEFAULT_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit || 0), 1), 500);
}

export function isWhatsAppCallTranscriptionDrainScheduleEnabled(
  value: string | undefined,
): boolean {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return !["0", "false", "no", "off"].includes(normalized);
}

export function buildWhatsAppCallTranscriptionDrainScheduleOptions(params: {
  taskQueue: string;
  limit?: number | null;
}): ScheduleOptions {
  return {
    scheduleId: WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ID,
    spec: {
      intervals: [
        { every: WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_INTERVAL_MS },
      ],
    },
    action: {
      type: "startWorkflow" as const,
      workflowType: WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW,
      taskQueue: params.taskQueue,
      workflowId: `${WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ID}:run`,
      args: [
        {
          contractVersion:
            WHATSAPP_CALL_TRANSCRIPTION_DRAIN_WORKFLOW_CONTRACT_VERSION,
          limit: normalizeLimit(params.limit),
        },
      ],
      workflowRunTimeout: 10 * 60 * 1000,
      workflowExecutionTimeout: 10 * 60 * 1000,
    },
    policies: {
      overlap: "SKIP" as const,
      catchupWindow:
        WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_CATCHUP_WINDOW_MS,
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

export async function createOrUpdateWhatsAppCallTranscriptionDrainSchedule(
  scheduleClient: ScheduleClient,
  options: ReturnType<
    typeof buildWhatsAppCallTranscriptionDrainScheduleOptions
  >,
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

export async function ensureWhatsAppCallTranscriptionDrainSchedule(params: {
  config: TemporalWorkerConfig;
  signal?: AbortSignal;
}): Promise<{ enabled: boolean; action?: "created" | "updated" }> {
  if (
    !isWhatsAppCallTranscriptionDrainScheduleEnabled(
      process.env.WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ENABLED,
    )
  ) {
    airiWorkerLogger.info("whatsapp.call.transcription_drain.schedule", {
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
        createOrUpdateWhatsAppCallTranscriptionDrainSchedule(
          client.schedule,
          buildWhatsAppCallTranscriptionDrainScheduleOptions({
            taskQueue: params.config.taskQueue,
            limit: Number(
              process.env.WHATSAPP_CALL_TRANSCRIPTION_DRAIN_LIMIT || "",
            ),
          }),
        ),
      params.signal,
    );
    airiWorkerLogger.info("whatsapp.call.transcription_drain.schedule", {
      note: action,
      scheduleId: WHATSAPP_CALL_TRANSCRIPTION_DRAIN_SCHEDULE_ID,
      taskQueue: params.config.taskQueue,
    });
    return { enabled: true, action };
  } finally {
    await connection.close();
  }
}
