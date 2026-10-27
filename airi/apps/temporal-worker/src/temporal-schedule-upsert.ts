import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError,
  type ScheduleClient,
  type ScheduleOptions,
} from "@temporalio/client";

export const TEMPORAL_SCHEDULE_UPSERT_DEADLINE_MS = 15_000;

export type TemporalScheduleDeadlineClient = {
  withDeadline<R>(deadline: number | Date, run: () => Promise<R>): Promise<R>;
  withAbortSignal?<R>(signal: AbortSignal, run: () => Promise<R>): Promise<R>;
};

function isGrpcCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 1
  );
}

function normalizeShutdownCancellation(
  error: unknown,
  signal: AbortSignal,
): unknown {
  if (
    !signal.aborted ||
    signal.reason !== "worker_shutdown" ||
    !isGrpcCancellation(error)
  ) {
    return error;
  }

  const abortError = new Error("worker_shutdown");
  abortError.name = "AbortError";
  return abortError;
}

export function runTemporalScheduleUpsertWithDeadline<R>(
  client: TemporalScheduleDeadlineClient,
  run: () => Promise<R>,
  signal?: AbortSignal,
): Promise<R> {
  const withDeadline = () =>
    client.withDeadline(Date.now() + TEMPORAL_SCHEDULE_UPSERT_DEADLINE_MS, run);
  if (!signal) return withDeadline();
  if (!client.withAbortSignal) {
    throw new Error("Temporal client abort binding is unavailable");
  }
  return client.withAbortSignal(signal, withDeadline).catch((error) => {
    throw normalizeShutdownCancellation(error, signal);
  });
}

function isScheduleNotFound(error: unknown): boolean {
  if (error instanceof ScheduleNotFoundError) return true;
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.toLowerCase().includes("not found") ||
    message.toLowerCase().includes("unknown schedule")
  );
}

export async function createOrUpdateTemporalSchedule(
  scheduleClient: ScheduleClient,
  options: ScheduleOptions,
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
      if (!(createError instanceof ScheduleAlreadyRunning)) throw createError;
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
