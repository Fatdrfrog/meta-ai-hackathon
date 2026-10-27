import type { Message } from "@google-cloud/pubsub";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import {
  isWorkspaceUsageMetric,
  WORKSPACE_USAGE_EVENT_CONTRACT_VERSION,
  WORKSPACE_USAGE_PUBSUB_SUBSCRIPTION_DEFAULT,
  type WorkspaceUsageEvent,
} from "@icecore/temporal";

import {
  compactEnv,
  createPubSubSubscription,
  parseEnabledFlag,
} from "./pubsub-consumer-runtime.js";

type PendingUsageMessage = {
  message: Message;
  event: WorkspaceUsageEvent;
};

function getSubscriptionName(): string {
  return (
    compactEnv("WORKSPACE_USAGE_PUBSUB_SUBSCRIPTION") ||
    WORKSPACE_USAGE_PUBSUB_SUBSCRIPTION_DEFAULT
  );
}

function getMaxBatchSize(): number {
  const parsed = Number.parseInt(
    String(process.env.WORKSPACE_USAGE_PUBSUB_BATCH_SIZE || ""),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 100;
}

function getFlushMs(): number {
  const parsed = Number.parseInt(
    String(process.env.WORKSPACE_USAGE_PUBSUB_FLUSH_MS || ""),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5_000) : 250;
}

function isConsumerEnabled(): boolean {
  return parseEnabledFlag(process.env.WORKSPACE_USAGE_PUBSUB_ENABLED);
}

function parseMessage(message: Message): WorkspaceUsageEvent {
  const raw = message.data.toString("utf8");
  const parsed = JSON.parse(raw) as Partial<WorkspaceUsageEvent>;

  if (parsed.schemaVersion !== WORKSPACE_USAGE_EVENT_CONTRACT_VERSION) {
    throw new Error("Unsupported workspace usage event schema version.");
  }
  if (!parsed.eventId || !parsed.companyId || !parsed.objectId) {
    throw new Error("Workspace usage event is missing required ids.");
  }
  if (!isWorkspaceUsageMetric(parsed.metric)) {
    throw new Error(`Unsupported workspace usage metric: ${parsed.metric}`);
  }
  const delta =
    typeof parsed.delta === "number" ? Math.trunc(parsed.delta) : Number.NaN;
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error("Workspace usage event delta must be non-zero.");
  }
  if (!parsed.occurredAt || Number.isNaN(Date.parse(parsed.occurredAt))) {
    throw new Error("Workspace usage event occurredAt is invalid.");
  }

  return {
    schemaVersion: WORKSPACE_USAGE_EVENT_CONTRACT_VERSION,
    eventId: parsed.eventId,
    workspaceId: parsed.workspaceId || null,
    companyId: parsed.companyId,
    metric: parsed.metric,
    delta,
    objectId: parsed.objectId,
    occurredAt: parsed.occurredAt,
    metadata: parsed.metadata || {},
  };
}

export async function startWorkspaceUsagePubSubConsumer(): Promise<
  () => Promise<void>
> {
  if (!isConsumerEnabled()) {
    airiWorkerLogger.info("workspace.usage.pubsub.consumer", {
      note: "disabled",
    });
    return async () => undefined;
  }

  const subscriptionName = getSubscriptionName();
  const { projectId, subscription } = createPubSubSubscription({
    projectIdEnvName: "WORKSPACE_USAGE_PUBSUB_PROJECT_ID",
    subscriptionName,
    maxMessagesEnvName: "WORKSPACE_USAGE_PUBSUB_MAX_MESSAGES",
    defaultMaxMessages: 100,
  });

  const maxBatchSize = getMaxBatchSize();
  const flushMs = getFlushMs();
  let pending: PendingUsageMessage[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let flushPromise: Promise<void> | null = null;

  const clearFlushTimer = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const flush = async () => {
    if (flushPromise) return flushPromise;
    clearFlushTimer();
    const batch = pending.splice(0, maxBatchSize);
    if (batch.length === 0) return;

    flushPromise = (async () => {
      try {
        const { supabaseAdmin } = await import("@/lib/supabase/admin");
        const { applyWorkspaceUsageEvents } = await import(
          "@/lib/limits/company-usage-snapshots"
        );
        const result = await applyWorkspaceUsageEvents(
          supabaseAdmin,
          batch.map((item) => item.event),
        );

        for (const item of batch) item.message.ack();
        airiWorkerLogger.info("workspace.usage.pubsub.consumer", {
          note: "batch_acked",
          processed: result.processed,
          duplicates: result.duplicates,
          batchSize: batch.length,
        });
      } catch (error) {
        for (const item of batch) item.message.nack();
        airiWorkerLogger.error("workspace.usage.pubsub.consumer", error, {
          note: "batch_failed",
          batchSize: batch.length,
        });
      } finally {
        flushPromise = null;
        if (pending.length > 0) {
          void flush();
        }
      }
    })();

    return flushPromise;
  };

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        void flush();
      }, flushMs);
    }
  };

  const onMessage = (message: Message) => {
    try {
      const event = parseMessage(message);
      pending.push({ message, event });
      if (pending.length >= maxBatchSize) {
        void flush();
      } else {
        scheduleFlush();
      }
    } catch (error) {
      airiWorkerLogger.error("workspace.usage.pubsub.consumer", error, {
        note: "invalid_message",
        messageId: message.id || null,
      });
      message.nack();
    }
  };

  const onError = (error: Error) => {
    airiWorkerLogger.error("workspace.usage.pubsub.consumer", error, {
      note: "subscription_error",
      subscription: subscriptionName,
    });
  };

  subscription.on("message", onMessage);
  subscription.on("error", onError);

  airiWorkerLogger.info("workspace.usage.pubsub.consumer", {
    note: "started",
    projectId: projectId || null,
    subscription: subscriptionName,
    maxBatchSize,
    flushMs,
  });

  return async () => {
    subscription.removeListener("message", onMessage);
    subscription.removeListener("error", onError);
    clearFlushTimer();
    await flush();
    await subscription.close();
  };
}
