import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";

const LOG_NAME = "airi.worker.event_loop";
const DEFAULT_INTERVAL_MS = 60_000;
const NS_PER_MS = 1_000_000;

function milliseconds(nanoseconds: number): number | null {
  return Number.isFinite(nanoseconds)
    ? Math.round((nanoseconds / NS_PER_MS) * 10) / 10
    : null;
}

/**
 * Logs event-loop delay once per interval so Pub/Sub delivery waits can be
 * told apart from a busy process: a stalled loop also delays stream reads and
 * the exactly-once receipt ModAck.
 */
export function startEventLoopDelayMonitor(input: {
  runtimeMode: string;
  intervalMs?: number;
  logger?: Pick<typeof airiWorkerLogger, "info">;
}): () => void {
  const logger = input.logger ?? airiWorkerLogger;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let utilizationStart = performance.eventLoopUtilization();

  const timer = setInterval(() => {
    const utilization = performance.eventLoopUtilization(utilizationStart);
    utilizationStart = performance.eventLoopUtilization();
    logger.info(LOG_NAME, {
      runtimeMode: input.runtimeMode,
      delayP50Ms: milliseconds(histogram.percentile(50)),
      delayP99Ms: milliseconds(histogram.percentile(99)),
      delayMaxMs: milliseconds(histogram.max),
      utilization: Math.round(utilization.utilization * 1000) / 1000,
    });
    histogram.reset();
  }, input.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
