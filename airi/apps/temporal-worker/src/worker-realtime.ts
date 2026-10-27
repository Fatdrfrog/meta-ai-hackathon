import type { MappedRealtimeEvent } from "@/lib/realtime/server";
import * as RealtimeServerModule from "@/lib/realtime/server";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  connectRealtimeValkeyClient,
  createRealtimeValkeyClient,
  type RealtimeValkeyClient,
} from "./realtime-valkey.js";
import { createAtomicRealtimePublisher } from "./realtime-atomic-publisher.js";

type RealtimeLogger = {
  info: (event: string, metadata?: Record<string, unknown>) => void;
  error: (
    event: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ) => void;
};

type WorkerRealtimeTriggerOptions = {
  env?: NodeJS.ProcessEnv;
  logger?: RealtimeLogger;
  fallbackTrigger?: (
    channel: string,
    eventName: string,
    payload: unknown,
  ) => Promise<unknown>;
  mapEvent?: (
    channel: string,
    eventName: string,
    payload: unknown,
  ) => Promise<MappedRealtimeEvent>;
  emitMappedEvent?: (event: MappedRealtimeEvent) => Promise<unknown>;
  connectPublisher?: () => Promise<RealtimeValkeyClient>;
};

const DIRECT_REALTIME_DEDUPE_TTL_SECONDS = 24 * 60 * 60;

let publisherPromise: Promise<RealtimeValkeyClient> | null = null;

type RealtimeServerModuleShape = {
  realtime: {
    trigger: (
      channel: string,
      eventName: string,
      payload: unknown,
    ) => Promise<unknown>;
  };
  mapChannelEventToRealtimeEvent: (
    channel: string,
    eventName: string,
    payload: unknown,
  ) => Promise<MappedRealtimeEvent>;
  emitRealtimeEvent: (event: MappedRealtimeEvent) => Promise<void>;
};

function getRealtimeServerModule(): RealtimeServerModuleShape {
  const moduleWithDefault = RealtimeServerModule as unknown as {
    default?: RealtimeServerModuleShape;
  };
  if (moduleWithDefault.default?.realtime?.trigger) {
    return moduleWithDefault.default;
  }
  return RealtimeServerModule as unknown as RealtimeServerModuleShape;
}

function compactEnv(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isEnabled(value: unknown): boolean {
  return /^(1|true|yes)$/i.test(compactEnv(value));
}

export function hasWorkerDirectRealtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    isEnabled(env.WORKER_REALTIME_DIRECT_VALKEY_ENABLED) &&
      (compactEnv(env.MEMORYSTORE_VALKEY_URL) ||
        compactEnv(env.MEMORYSTORE_VALKEY_HOST)),
  );
}

async function connectDefaultPublisher(): Promise<RealtimeValkeyClient> {
  if (!publisherPromise) {
    publisherPromise = connectRealtimeValkeyClient(
      createRealtimeValkeyClient(),
    );
  }
  return publisherPromise;
}

function buildRealtimeLogContext(event: MappedRealtimeEvent) {
  return {
    eventId: event.eventId,
    eventName: event.name,
    workspaceId: event.workspaceId,
    conversationId: event.conversationId || null,
    channel: event.channel,
  };
}

export function createWorkerRealtimeTrigger(
  options: WorkerRealtimeTriggerOptions = {},
) {
  const env = options.env || process.env;
  const logger = options.logger || airiWorkerLogger;
  const realtimeServer = getRealtimeServerModule();
  const fallbackTrigger =
    options.fallbackTrigger || realtimeServer.realtime.trigger;
  const mapEvent =
    options.mapEvent || realtimeServer.mapChannelEventToRealtimeEvent;
  const emitMappedEvent =
    options.emitMappedEvent || realtimeServer.emitRealtimeEvent;
  const connectPublisher = options.connectPublisher || connectDefaultPublisher;

  return async function triggerWorkerRealtimeEvent(
    channel: string,
    eventName: string,
    payload: unknown,
  ): Promise<unknown> {
    if (!hasWorkerDirectRealtimeConfig(env)) {
      return fallbackTrigger(channel, eventName, payload);
    }

    const startedAt = Date.now();
    let event: MappedRealtimeEvent;
    let mapMs: number;

    try {
      const mapStartedAt = Date.now();
      event = await mapEvent(channel, eventName, payload);
      mapMs = Date.now() - mapStartedAt;
    } catch (error) {
      logger.error("realtime.direct_event_failed", error, {
        note: "fallback_to_pubsub",
        durationMs: Date.now() - startedAt,
      });
      return fallbackTrigger(channel, eventName, payload);
    }

    try {
      const publisher = await connectPublisher();
      const frame = JSON.stringify({
        type: "event",
        channel: event.channel,
        event,
      });
      const publishStartedAt = Date.now();
      const outcome = await createAtomicRealtimePublisher(
        publisher,
      ).publishOnce({
        dedupeKey: `realtime:published:${event.dedupeKey}`,
        ttlSeconds: DIRECT_REALTIME_DEDUPE_TTL_SECONDS,
        channel: event.channel,
        message: frame,
      });
      const publishMs = Date.now() - publishStartedAt;

      if (outcome.kind === "duplicate") {
        logger.info("realtime.direct_event_suppressed", {
          note: "duplicate_suppressed",
          ...buildRealtimeLogContext(event),
          durationMs: Date.now() - startedAt,
          mapMs,
          publishMs,
        });
        return { ok: true, duplicate: true };
      }

      if (outcome.kind === "published") {
        logger.info("realtime.direct_event_published", {
          note: "published",
          outcome: "success",
          ...buildRealtimeLogContext(event),
          subscriberCount: outcome.subscriberCount,
          durationMs: Date.now() - startedAt,
          mapMs,
          publishMs,
        });

        return { ok: true, subscriberCount: outcome.subscriberCount };
      }
    } catch (error) {
      logger.error("realtime.direct_event_failed", error, {
        note: "fallback_to_pubsub",
        ...buildRealtimeLogContext(event),
        durationMs: Date.now() - startedAt,
      });
      return emitMappedEvent(event);
    }

    logger.error("realtime.direct_event_failed", new Error("unknown outcome"), {
      note: "fallback_to_pubsub",
      ...buildRealtimeLogContext(event),
      durationMs: Date.now() - startedAt,
    });
    return emitMappedEvent(event);
  };
}

export const workerRealtime = {
  trigger: createWorkerRealtimeTrigger(),
};
