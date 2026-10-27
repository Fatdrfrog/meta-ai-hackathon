import type { Message, Subscription } from "@google-cloud/pubsub";
import {
  isRealtimeEventEnvelope,
  parseRealtimeChannelName,
  type RealtimeEventEnvelope,
} from "@icecore/shared/types/realtime";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  createPubSubSubscription,
  getPubSubDeliveryTiming,
} from "./pubsub/pubsub-consumer-runtime.js";
import {
  connectRealtimeValkeyClient,
  createRealtimeValkeyClient,
  type RealtimeValkeyClient,
} from "./realtime-valkey.js";
import { createAtomicRealtimePublisher } from "./realtime-atomic-publisher.js";
import {
  startRealtimeOutboxReplayer,
  createRealtimeOutboxScanOwnership,
} from "./realtime-outbox-replayer.js";
import { runTemporalWorkerLifecycle } from "./worker-lifecycle.js";

type RealtimePubSubPayload = {
  channel?: string;
  event?: unknown;
};

type ParsedRealtimePubSubPayload = {
  channel: string;
  event: RealtimeEventEnvelope;
};

const DEFAULT_SUBSCRIPTION = "icecore-realtime-events-dispatcher";
const DEFAULT_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

type RealtimeLogger = {
  info: (event: string, metadata?: Record<string, unknown>) => void;
  error: (
    event: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ) => void;
};

function getSubscriptionName(): string {
  return DEFAULT_SUBSCRIPTION;
}

function getDedupeTtlSeconds(): number {
  return DEFAULT_DEDUPE_TTL_SECONDS;
}

function parseMessage(message: Message): ParsedRealtimePubSubPayload {
  const parsed = JSON.parse(
    message.data.toString("utf8"),
  ) as RealtimePubSubPayload;
  if (typeof parsed.channel !== "string") {
    throw new Error("Realtime Pub/Sub message is missing channel");
  }
  if (!isRealtimeEventEnvelope(parsed.event)) {
    throw new Error("Realtime Pub/Sub message has invalid event envelope");
  }
  return {
    channel: parsed.channel,
    event: parsed.event,
  };
}

export function createRealtimePubSubHandler(input: {
  publisher: RealtimeValkeyClient;
  logger?: RealtimeLogger;
  dedupeTtlSeconds?: number;
}): (message: Message) => Promise<void> {
  const logger = input.logger || airiWorkerLogger;
  const dedupeTtlSeconds = input.dedupeTtlSeconds || DEFAULT_DEDUPE_TTL_SECONDS;
  const atomicPublisher = createAtomicRealtimePublisher(input.publisher);
  return async (message: Message): Promise<void> => {
    const startedAt = Date.now();
    const deliveryTiming = getPubSubDeliveryTiming(message, startedAt);
    let payload: ParsedRealtimePubSubPayload | null = null;
    try {
      payload = parseMessage(message);
      const channel = parseRealtimeChannelName(payload.channel);
      const publishStartedAt = Date.now();
      const outcome = await atomicPublisher.publishOnce({
        dedupeKey: `realtime:published:${payload.event.dedupeKey}`,
        ttlSeconds: dedupeTtlSeconds,
        channel: payload.channel,
        message: JSON.stringify({
          type: "event",
          channel: payload.channel,
          event: payload.event,
        }),
      });
      const publishMs = Date.now() - publishStartedAt;

      if (outcome.kind === "duplicate") {
        message.ack();
        logger.info("airi.realtime.dispatcher", {
          note: "duplicate_suppressed",
          ...deliveryTiming,
          pubsubMessageId: message.id || null,
          eventId: payload.event.eventId,
          eventName: payload.event.name,
          workspaceId: payload.event.workspaceId,
          conversationId: payload.event.conversationId || null,
          channelKind: channel.kind,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (outcome.kind === "published") {
        message.ack();
        logger.info("airi.realtime.dispatcher", {
          note: "message_published",
          ...deliveryTiming,
          pubsubMessageId: message.id || null,
          channel: payload.channel,
          eventId: payload.event.eventId,
          eventName: payload.event.name,
          workspaceId: payload.event.workspaceId,
          conversationId: payload.event.conversationId || null,
          channelKind: channel.kind,
          channelWorkspaceId: channel.workspaceId,
          channelConversationId: channel.conversationId,
          subscriberCount: outcome.subscriberCount,
          publishMs,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      logger.error("airi.realtime.dispatcher", new Error(outcome.kind), {
        note: "message_failed",
        ...deliveryTiming,
        pubsubMessageId: message.id || null,
        channel: payload.channel,
        eventId: payload.event.eventId,
        eventName: payload.event.name,
        workspaceId: payload.event.workspaceId,
        conversationId: payload.event.conversationId || null,
        durationMs: Date.now() - startedAt,
      });
      message.nack();
    } catch (error) {
      logger.error("airi.realtime.dispatcher", error, {
        note: "message_failed",
        ...deliveryTiming,
        pubsubMessageId: message.id || null,
        channel: payload?.channel || null,
        eventId: payload?.event.eventId || null,
        eventName: payload?.event.name || null,
        workspaceId: payload?.event.workspaceId || null,
        conversationId: payload?.event.conversationId || null,
        durationMs: Date.now() - startedAt,
      });
      message.nack();
    }
  };
}

export type RealtimeDispatcherDependencies = {
  createPublisher(): RealtimeValkeyClient;
  connectPublisher(client: RealtimeValkeyClient): Promise<RealtimeValkeyClient>;
  createSubscription(): { projectId?: string; subscription: Subscription };
  startReplayer(input: {
    publisher: RealtimeValkeyClient;
  }): Promise<() => Promise<void>>;
  logger: RealtimeLogger;
};

const dispatcherDependencies: RealtimeDispatcherDependencies = {
  createPublisher: createRealtimeValkeyClient,
  connectPublisher: connectRealtimeValkeyClient,
  createSubscription: () =>
    createPubSubSubscription({
      projectIdEnvName: "GCP_PROJECT_ID",
      subscriptionName: getSubscriptionName(),
      defaultMaxMessages: 500,
    }),
  startReplayer: ({ publisher }) =>
    startRealtimeOutboxReplayer({
      ownership: createRealtimeOutboxScanOwnership(publisher),
    }),
  logger: airiWorkerLogger,
};

async function settleBeforeDeadline(
  promise: Promise<unknown>,
  deadlineMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          Math.max(0, deadlineMs - performance.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startRealtimeDispatcher(
  input: {
    dependencies?: RealtimeDispatcherDependencies;
    drainTimeoutMs?: number;
    signal?: AbortSignal;
    onFatal?(error: Error): void;
  } = {},
): Promise<() => Promise<void>> {
  const deps = input.dependencies || dispatcherDependencies;
  const logger = deps.logger;
  let publisher: RealtimeValkeyClient | null = null;
  let subscription: Subscription | null = null;
  let stopReplayer: (() => Promise<void>) | null = null;
  let onMessage: ((message: Message) => void) | null = null;
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let publisherDestroyed = false;
  let startupCancelled = false;
  const destroyPublisher = () => {
    if (!publisher || publisherDestroyed) return;
    publisherDestroyed = true;
    try {
      publisher.destroy();
    } catch {
      /* not connected or already closed */
    }
  };
  const startupAbortError = () =>
    Object.assign(
      new Error(
        typeof input.signal?.reason === "string"
          ? input.signal.reason
          : "realtime_dispatcher_startup_aborted",
      ),
      { name: "AbortError" },
    );
  let rejectStartup!: (error: Error) => void;
  const startupAborted = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  // Cancellation may occur in a synchronous dependency before the first race.
  void startupAborted.catch(() => undefined);
  const onStartupAbort = () => {
    startupCancelled = true;
    // quit() can queue behind a retrying connect(), so cancellation owns destroy.
    destroyPublisher();
    rejectStartup(startupAbortError());
  };
  const awaitStartup = async <T>(
    work: Promise<T>,
    discard?: (value: T) => Promise<void>,
  ): Promise<T> => {
    let discarded = false;
    const discardOnce = (value: T) => {
      if (!discard || discarded) return;
      discarded = true;
      void discard(value).catch((error) =>
        logger.error("airi.realtime.dispatcher", error, {
          note: "late_startup_cleanup_failed",
        }),
      );
    };
    const observed = work.then((value) => {
      if (startupCancelled) discardOnce(value);
      return value;
    });
    const value = await Promise.race([observed, startupAborted]);
    if (startupCancelled) {
      discardOnce(value);
      throw startupAbortError();
    }
    return value;
  };
  const inFlight = new Set<Promise<void>>();
  const subscriptionName = getSubscriptionName();
  const onError = (error: Error) => {
    logger.error("airi.realtime.dispatcher", error, {
      note: "subscription_error",
      subscription: subscriptionName,
    });
    if (!stopped && !startupCancelled) input.onFatal?.(error);
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    const deadlineMs = performance.now() + (input.drainTimeoutMs ?? 8_000);
    stopping = (async () => {
      let cleanupError: unknown;
      const cleanup = async (work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          cleanupError ??= error;
        }
      };
      // Stop scan admission and subscription delivery before draining work that
      // already crossed either boundary. Keep publishers alive until then.
      const drained = await settleBeforeDeadline(
        Promise.all([
          cleanup(async () => {
            const closingSubscription = subscription;
            if (!closingSubscription) return;
            const shutdownLogger = logger;
            const closingSubscriptionName = subscriptionName;
            let shutdownErrorLogged = false;
            // The SDK can forward queued stream errors while close is pending.
            // This guard retains no fatal owner and outlives the stop deadline
            // only until that close settles, without logging a shutdown storm.
            const onShutdownError = (error: Error) => {
              if (shutdownErrorLogged) return;
              shutdownErrorLogged = true;
              shutdownLogger.error("airi.realtime.dispatcher", error, {
                note: "subscription_shutdown_error",
                subscription: closingSubscriptionName,
              });
            };
            closingSubscription.on("error", onShutdownError);
            closingSubscription.removeListener("error", onError);
            if (onMessage)
              closingSubscription.removeListener("message", onMessage);
            try {
              await closingSubscription.close();
            } finally {
              closingSubscription.removeListener("error", onShutdownError);
            }
          }),
          cleanup(async () => stopReplayer?.()),
          Promise.allSettled([...inFlight]),
        ]),
        deadlineMs,
      );
      if (publisher) {
        if (!publisherDestroyed && drained && publisher.isOpen) {
          const closed = await settleBeforeDeadline(
            cleanup(() => publisher!.quit()),
            deadlineMs,
          );
          if (!closed || cleanupError) {
            destroyPublisher();
          }
        } else {
          destroyPublisher();
        }
        // A destroyed, retrying connection can still emit a late error. Its
        // closed owner contains that error until the client is collected.
        if (!publisherDestroyed && drained)
          publisher.removeListener("error", onError);
      }
      if (!drained)
        logger.error(
          "airi.realtime.dispatcher",
          new Error("dispatcher_drain_deadline"),
          { note: "drain_deadline" },
        );
      if (cleanupError) throw cleanupError;
    })();
    return stopping;
  };
  input.signal?.addEventListener("abort", onStartupAbort, { once: true });
  try {
    if (input.signal?.aborted) {
      onStartupAbort();
      throw startupAbortError();
    }
    publisher = deps.createPublisher();
    publisher.on("error", onError);
    if (startupCancelled) {
      destroyPublisher();
      throw startupAbortError();
    }
    await awaitStartup(deps.connectPublisher(publisher));
    const created = deps.createSubscription();
    subscription = created.subscription;
    if (startupCancelled) throw startupAbortError();
    const handler = createRealtimePubSubHandler({
      publisher,
      logger,
      dedupeTtlSeconds: getDedupeTtlSeconds(),
    });
    onMessage = (message) => {
      if (stopped) {
        message.nack();
        return;
      }
      const pending = handler(message).catch((error) =>
        onError(error instanceof Error ? error : new Error(String(error))),
      );
      inFlight.add(pending);
      const forget = () => {
        inFlight.delete(pending);
      };
      void pending.then(forget, forget);
    };
    subscription.on("message", onMessage);
    subscription.on("error", onError);
    stopReplayer = await awaitStartup(
      deps.startReplayer({ publisher }),
      async (stopLateReplayer) => {
        await settleBeforeDeadline(
          stopLateReplayer(),
          performance.now() + (input.drainTimeoutMs ?? 8_000),
        );
      },
    );
    logger.info("airi.realtime.dispatcher", {
      note: "started",
      projectId: created.projectId || null,
      subscription: subscriptionName,
    });
    return stop;
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onStartupAbort);
  }
}

export async function runRealtimeDispatcher(): Promise<void> {
  // The rollback runtime shares SIGTERM, fatal-error and cleanup ownership with
  // the main worker rather than registering another competing signal handler.
  let finish!: () => void;
  await runTemporalWorkerLifecycle({
    workers: [
      {
        run: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        shutdown: () => finish?.(),
      },
    ],
    auxiliaryStarters: [
      (signal, onFatal) => startRealtimeDispatcher({ signal, onFatal }),
    ],
  });
}
