import {
  airiWorkerLogger,
  describeLogError,
} from "@icecore/airi-runtime/logging";
import { readRuntimeExport } from "@icecore/airi-runtime/module-interop";

type AnalyticsProjectionLogger = Pick<
  typeof airiWorkerLogger,
  "info" | "error"
>;
type AnalyticsWebRuntime = {
  startAnalyticsProjectionRuntime(input: {
    signal?: AbortSignal;
    workspaceId?: string;
    logger?: AnalyticsProjectionLogger;
  }): Promise<() => Promise<void>>;
};

/** Prerequisite retries back off from 30 s to 5 min; analytics never blocks or stops polling. */
export const ANALYTICS_START_RETRY_INITIAL_MS = 30_000;
export const ANALYTICS_START_RETRY_MAX_MS = 300_000;
/** Shutdown abandons an in-flight start after this bound; leases expire safely. */
export const ANALYTICS_START_STOP_DEADLINE_MS = 2_000;

const wait = (signal: AbortSignal, milliseconds: number) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });

export async function startAnalyticsProjectionRuntime(input: {
  enabled: boolean;
  signal: AbortSignal;
  logger?: AnalyticsProjectionLogger;
  loadRuntime?: () => Promise<
    AnalyticsWebRuntime | { default: AnalyticsWebRuntime }
  >;
  retryInitialMs?: number;
  retryMaxMs?: number;
  stopDeadlineMs?: number;
}): Promise<() => Promise<void>> {
  if (!input.enabled || input.signal.aborted) return async () => undefined;
  const { signal } = input;
  const logger = input.logger || airiWorkerLogger;
  const loadRuntime =
    input.loadRuntime ||
    (() => import("@/lib/analytics/analytics-projection-runtime"));
  let stopRuntime: (() => Promise<void>) | null = null;
  // Starting (connectDB plus the Supabase RPC probe) runs in the background, so a
  // failed or slow prerequisite is logged and retried while Temporal keeps polling.
  const starting = (async () => {
    let delay = input.retryInitialMs ?? ANALYTICS_START_RETRY_INITIAL_MS;
    while (!signal.aborted) {
      try {
        const runtime = await loadRuntime();
        if (signal.aborted) return;
        const startRuntime = readRuntimeExport<
          AnalyticsWebRuntime["startAnalyticsProjectionRuntime"]
        >(runtime, "startAnalyticsProjectionRuntime");
        stopRuntime = await startRuntime({ signal, logger });
        return;
      } catch (error) {
        if (signal.aborted) return;
        logger.error("analytics.projection_degraded", describeLogError(error), {
          phase: "runtime_start",
          retryInMs: delay,
        });
        await wait(signal, delay);
        delay = Math.min(
          delay * 2,
          input.retryMaxMs ?? ANALYTICS_START_RETRY_MAX_MS,
        );
      }
    }
  })();
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      starting,
      new Promise<void>((resolve) => {
        timer = setTimeout(
          resolve,
          input.stopDeadlineMs ?? ANALYTICS_START_STOP_DEADLINE_MS,
        );
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    const stop: (() => Promise<void>) | null = stopRuntime;
    if (stop) await stop();
  };
}
