import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { randomUUID } from "node:crypto";
import type { RealtimeValkeyClient } from "./realtime-valkey.js";

type ReplayerLogger = {
  error: (
    event: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ) => void;
  info: (event: string, metadata?: Record<string, unknown>) => void;
};

export type ReplayBatchResult = {
  claimed: number;
  published: number;
  failed: number;
};

type ReplayerOptions = {
  intervalMs?: number;
  logger?: ReplayerLogger;
  replayBatch: (input: {
    shouldContinue: () => boolean;
  }) => Promise<ReplayBatchResult>;
  ownership?: RealtimeOutboxScanOwnership;
};

export type RealtimeOutboxScanOwnership = {
  leaseMs?: number;
  acquireOrRenew(): Promise<boolean>;
  release(): Promise<void>;
};

const SCAN_LEASE_MS = 30_000;
const SCAN_LEASE_KEY = "realtime:outbox:scan-owner:v1";

// This lease suppresses duplicate empty scans. The Mongo row lease/CAS and
// atomic publish proofs remain the delivery fence if a scanner expires.
export function createRealtimeOutboxScanOwnership(
  client: RealtimeValkeyClient,
  ownerToken: string = randomUUID(),
): RealtimeOutboxScanOwnership {
  return {
    leaseMs: SCAN_LEASE_MS,
    async acquireOrRenew() {
      const reply = await client.eval(
        `
local owner = redis.call("GET", KEYS[1])
if owner == ARGV[1] then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
if not owner and redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX") then
  return 1
end
return 0`,
        {
          keys: [SCAN_LEASE_KEY],
          arguments: [ownerToken, String(SCAN_LEASE_MS)],
        },
      );
      return reply === 1;
    },
    async release() {
      await client.eval(
        `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`,
        { keys: [SCAN_LEASE_KEY], arguments: [ownerToken] },
      );
    },
  };
}

const DEFAULT_REPLAY_INTERVAL_MS = 5_000;

function normalizeIntervalMs(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.floor(value)
    : DEFAULT_REPLAY_INTERVAL_MS;
}

export function createRealtimeOutboxReplayer(options: ReplayerOptions) {
  const intervalMs = normalizeIntervalMs(options.intervalMs);
  const logger = options.logger || airiWorkerLogger;
  let running: Promise<void> | null = null;
  let renewing: Promise<boolean> | null = null;
  let owned = !options.ownership;
  let expiresAt = Infinity;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const shouldContinue = () =>
    !stopped && owned && performance.now() < expiresAt;
  const renew = () => {
    if (renewing) return renewing;
    renewing = (async () => {
      const startedAt = performance.now();
      try {
        owned = options.ownership
          ? await options.ownership.acquireOrRenew()
          : true;
        expiresAt = !options.ownership
          ? Infinity
          : owned
            ? startedAt + (options.ownership.leaseMs || SCAN_LEASE_MS)
            : 0;
      } catch (error) {
        owned = false;
        expiresAt = 0;
        logger.error("airi.realtime.outbox_replay", error, {
          note: "scan_lease_failed",
        });
      }
      return owned;
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  };

  const runOnce = async () => {
    if (running || stopped) return;
    const pending = (async () => {
      try {
        if (options.ownership && !(await renew())) return;
        if (!shouldContinue()) return;
        const result = await options.replayBatch({ shouldContinue });
        if (result.claimed > 0) {
          logger.info("airi.realtime.outbox_replay", {
            note: "batch_processed",
            ...result,
          });
        }
      } catch (error) {
        logger.error("airi.realtime.outbox_replay", error, {
          note: "batch_failed",
        });
      }
    })();
    running = pending;
    try {
      await pending;
    } finally {
      if (running === pending) running = null;
    }
  };

  const start = () => {
    if (timer || stopped)
      throw new Error("Realtime outbox replayer already started or stopped");
    void runOnce();
    timer = setInterval(() => {
      if (running) {
        // A lost owner never re-admits rows into its existing batch.
        if (owned && performance.now() < expiresAt) void renew();
        else owned = false;
      } else void runOnce();
    }, intervalMs);
    timer.unref?.();

    return (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      stopPromise = (async () => {
        await running;
        await renewing;
        await options.ownership?.release();
      })();
      return stopPromise;
    };
  };

  return {
    runOnce,
    start,
  };
}

type TemporalWorkerWebRuntime = {
  replayRealtimeOutboxBatch(
    input: Readonly<{ shouldContinue?: () => boolean }>,
  ): Promise<ReplayBatchResult>;
  startProductionRequestsProjectionRuntime(input: {
    signal: AbortSignal;
    ownerToken?: string;
    realtimeEnabled?: boolean;
    onFatal?(error: Error): void;
  }): Promise<() => Promise<void>>;
  drainPendingLlmAnalyticsEvents(timeoutMs: number): Promise<boolean>;
};

export async function loadTemporalWorkerWebRuntime(): Promise<TemporalWorkerWebRuntime> {
  return import("@/lib/temporal-worker-runtime");
}

export async function startRealtimeOutboxReplayer(input: {
  intervalMs?: number;
  ownership?: RealtimeOutboxScanOwnership;
  loadRuntime?: () => Promise<TemporalWorkerWebRuntime>;
}) {
  const { replayRealtimeOutboxBatch } = await (
    input.loadRuntime || loadTemporalWorkerWebRuntime
  )();
  return createRealtimeOutboxReplayer({
    intervalMs: input.intervalMs,
    ownership: input.ownership,
    replayBatch: ({ shouldContinue }) =>
      replayRealtimeOutboxBatch({ shouldContinue }),
  }).start();
}

export async function startRequestsProjectionRuntime(input: {
  signal: AbortSignal;
  ownerToken?: string;
  realtimeEnabled?: boolean;
  loadRuntime?: () => Promise<TemporalWorkerWebRuntime>;
  onFatal?(error: Error): void;
}): Promise<() => Promise<void>> {
  const { startProductionRequestsProjectionRuntime } = await (
    input.loadRuntime || loadTemporalWorkerWebRuntime
  )();
  return startProductionRequestsProjectionRuntime({
    signal: input.signal,
    ownerToken: input.ownerToken,
    realtimeEnabled: input.realtimeEnabled,
    onFatal: input.onFatal,
  });
}
