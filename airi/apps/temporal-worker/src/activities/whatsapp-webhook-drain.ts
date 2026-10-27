import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import type { WhatsAppWebhookPayloadRetentionResult } from "@icecore/airi-runtime/whatsapp-webhook-event-retention";
import {
  assertContractVersion,
  WHATSAPP_WEBHOOK_DRAIN_DEFAULT_LIMIT,
  WHATSAPP_WEBHOOK_DRAIN_MAX_LIMIT,
  WHATSAPP_WEBHOOK_DRAIN_WORKFLOW_CONTRACT_VERSION,
  buildWhatsAppWebhookProcessorRoutingKey,
  type WhatsAppWebhookDrainActivityInput,
  type WhatsAppWebhookDrainActivityResult,
} from "@icecore/temporal";
import { heartbeat } from "@temporalio/activity";

import {
  getTemporalWorkerConfig,
  type TemporalWorkerConfig,
} from "../config.js";
import { signalWithStartWhatsAppWebhookProcessor } from "../whatsapp-webhook-temporal-client.js";
import { buildWhatsAppWebhookMaxAttemptsExpression } from "../whatsapp-webhook-retry-policy.js";

const STALE_QUEUED_WEBHOOK_EVENT_MS = 15 * 60 * 1000;
const WEBHOOK_DRAIN_QUERY_TIMEOUT_MS = 10_000;
const WEBHOOK_DRAIN_SIGNAL_TIMEOUT_MS = 10_000;
const WEBHOOK_DRAIN_HEARTBEAT_INTERVAL_MS = 10_000;
// Leave room within the 300s activity for payload and engagement maintenance.
const WEBHOOK_DRAIN_RECOVERY_BUDGET_MS = 180_000;

export type WhatsAppWebhookDrainEventRecord = {
  _id: unknown;
  dedupeKey: string;
  field: string;
  itemKind?: string | null;
  orderingKey: string;
  firstReceivedAt?: Date;
  lastReceivedAt?: Date;
};

type WhatsAppWebhookDrainQuery = {
  select: (projection: string) => WhatsAppWebhookDrainQuery;
  sort: (sort: Record<string, 1 | -1>) => WhatsAppWebhookDrainQuery;
  limit: (limit: number) => WhatsAppWebhookDrainQuery;
  maxTimeMS: (timeoutMs: number) => WhatsAppWebhookDrainQuery;
  lean: () => Promise<WhatsAppWebhookDrainEventRecord[]>;
};

type WhatsAppWebhookEventModel = {
  find: (filter: Record<string, unknown>) => WhatsAppWebhookDrainQuery;
  updateOne: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { maxTimeMS: number },
  ) => Promise<unknown>;
  updateMany?: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { maxTimeMS: number },
  ) => Promise<unknown>;
};

type SignalWithStartWebhookProcessor = (params: {
  config: TemporalWorkerConfig;
  timeoutMs: number;
  event: {
    eventId: string;
    dedupeKey: string;
    field: string;
    orderingKey: string;
    receivedAt: string;
  };
}) => Promise<{ workflowId: string }>;

function formatDrainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Temporal webhook drain signal failed: ${message}`.slice(0, 1_000);
}

export function getWhatsAppWebhookDrainOrderingKey(
  event: Pick<
    WhatsAppWebhookDrainEventRecord,
    "field" | "itemKind" | "orderingKey"
  >,
): string {
  return buildWhatsAppWebhookProcessorRoutingKey({
    baseKey: event.orderingKey,
    itemKind: event.itemKind || event.field,
  });
}

export function isValidWhatsAppWebhookDrainLimit(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= WHATSAPP_WEBHOOK_DRAIN_MAX_LIMIT
  );
}

export function normalizeWhatsAppWebhookDrainLimit(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  return isValidWhatsAppWebhookDrainLimit(parsed)
    ? parsed
    : WHATSAPP_WEBHOOK_DRAIN_DEFAULT_LIMIT;
}

export function buildWhatsAppWebhookDrainFilter(now: Date) {
  const staleQueuedBefore = new Date(
    now.getTime() - STALE_QUEUED_WEBHOOK_EVENT_MS,
  );
  const staleProcessingBefore = staleQueuedBefore;

  return {
    $and: [
      {
        $or: [
          {
            status: { $in: ["received", "failed"] },
            nextRetryAt: { $lte: now },
          },
          {
            status: "queued",
            queuedAt: { $lte: staleQueuedBefore },
            completedAt: null,
          },
          {
            status: "processing",
            processingStartedAt: { $lte: staleProcessingBefore },
            completedAt: null,
          },
        ],
      },
      {
        $expr: {
          $lt: [
            { $ifNull: ["$attempts", 0] },
            buildWhatsAppWebhookMaxAttemptsExpression(),
          ],
        },
      },
    ],
  };
}

export function buildWhatsAppWebhookExhaustedRetryFilter(now = new Date()) {
  return {
    $or: [
      { status: { $in: ["received", "failed", "queued"] } },
      {
        status: "processing",
        processingStartedAt: {
          $lte: new Date(now.getTime() - STALE_QUEUED_WEBHOOK_EVENT_MS),
        },
      },
    ],
    completedAt: null,
    $expr: {
      $gte: [
        { $ifNull: ["$attempts", 0] },
        buildWhatsAppWebhookMaxAttemptsExpression(),
      ],
    },
  };
}

export async function drainPendingWhatsAppWebhookEventsToTemporal(params: {
  model: WhatsAppWebhookEventModel;
  config: TemporalWorkerConfig;
  signalWithStart: SignalWithStartWebhookProcessor;
  heartbeat?: (details: Record<string, unknown>) => void;
  limit?: number | null;
  now?: Date;
  monotonicNow?: () => number;
  compactPayloads?: () => Promise<WhatsAppWebhookPayloadRetentionResult>;
  refreshEngagement?: () => Promise<{
    processed: number;
    bootstrapsAdvanced: number;
  }>;
}): Promise<WhatsAppWebhookDrainActivityResult> {
  const limit = normalizeWhatsAppWebhookDrainLimit(params.limit);
  const now = params.now || new Date();
  const monotonicNow = params.monotonicNow || (() => performance.now());
  const recoveryStartedAt = monotonicNow();
  const recoveryDeadline = recoveryStartedAt + WEBHOOK_DRAIN_RECOVERY_BUDGET_MS;
  const recoveryFilter = buildWhatsAppWebhookDrainFilter(now);
  const queryOptions = { maxTimeMS: WEBHOOK_DRAIN_QUERY_TIMEOUT_MS };
  let events: WhatsAppWebhookDrainEventRecord[] = [];
  let exhaustedScanned = 0;
  let exhaustedMarkedDead = 0;
  let queued = 0;
  let failed = 0;
  let stopReason = "drained";
  let heartbeatError: unknown;
  let lastHeartbeat: Record<string, unknown> = { phase: "recovery_start" };
  const reportHeartbeat = (details: Record<string, unknown>) => {
    if (heartbeatError) throw heartbeatError;
    lastHeartbeat = details;
    params.heartbeat?.(details);
  };
  // Mongo maxTimeMS bounds server work, not network waits. Keep the current
  // phase alive during I/O, as the processor does for its runtime operation.
  const heartbeatTimer = params.heartbeat
    ? setInterval(() => {
        try {
          params.heartbeat?.(lastHeartbeat);
        } catch (error) {
          heartbeatError = error;
        }
      }, WEBHOOK_DRAIN_HEARTBEAT_INTERVAL_MS)
    : null;
  try {
    if (params.model.updateMany) {
      const exhaustedFilter = buildWhatsAppWebhookExhaustedRetryFilter(now);
      reportHeartbeat({ phase: "exhausted_recovery_scan" });
      const exhausted = await params.model
        .find(exhaustedFilter)
        .select("_id")
        .limit(limit)
        .maxTimeMS(WEBHOOK_DRAIN_QUERY_TIMEOUT_MS)
        .lean();
      exhaustedScanned = exhausted.length;
      if (exhausted.length) {
        reportHeartbeat({
          phase: "exhausted_recovery_update",
          scanned: exhausted.length,
        });
        const update = (await params.model.updateMany(
          {
            _id: { $in: exhausted.map((event) => event._id) },
            ...exhaustedFilter,
          },
          { $set: { status: "dead", nextRetryAt: null } },
          queryOptions,
        )) as { modifiedCount?: number } | undefined;
        exhaustedMarkedDead = update?.modifiedCount || 0;
      }
    }
    reportHeartbeat({ phase: "recovery_scan" });
    events = await params.model
      .find(recoveryFilter)
      .select(
        "_id dedupeKey field itemKind orderingKey firstReceivedAt lastReceivedAt",
      )
      .sort({ nextRetryAt: 1, createdAt: 1 })
      .limit(limit)
      .maxTimeMS(WEBHOOK_DRAIN_QUERY_TIMEOUT_MS)
      .lean();

    for (const event of events) {
      const remainingMs = Math.floor(recoveryDeadline - monotonicNow());
      if (remainingMs <= 0) {
        stopReason = "time_budget";
        break;
      }
      const eventId = String(event._id);
      const receivedAt = (
        event.lastReceivedAt ||
        event.firstReceivedAt ||
        now
      ).toISOString();
      // The processor may claim or finish while the signal is in flight. Never
      // replace a fresh lease, completed receipt, or newly scheduled retry.
      const updateFilter = { _id: eventId, ...recoveryFilter };
      reportHeartbeat({ eventId, field: event.field, phase: "signal" });
      let result: { workflowId: string };
      try {
        result = await params.signalWithStart({
          config: params.config,
          timeoutMs: Math.min(WEBHOOK_DRAIN_SIGNAL_TIMEOUT_MS, remainingMs),
          event: {
            eventId,
            dedupeKey: event.dedupeKey,
            field: event.field,
            orderingKey: getWhatsAppWebhookDrainOrderingKey(event),
            receivedAt,
          },
        });
      } catch (error) {
        reportHeartbeat({ eventId, phase: "signal_failed" });
        await params.model.updateOne(
          updateFilter,
          {
            $set: {
              status: "failed",
              lastError: formatDrainError(error),
              nextRetryAt: new Date(now.getTime() + 60_000),
            },
          },
          queryOptions,
        );
        failed += 1;
        continue;
      }
      reportHeartbeat({ eventId, phase: "signal_accepted" });
      await params.model.updateOne(
        updateFilter,
        {
          $set: {
            status: "queued",
            queuedAt: now,
            temporalWorkflowId: result.workflowId,
            lastError: null,
          },
        },
        queryOptions,
      );
      // Preserve the workflow result contract: these count signal outcomes,
      // including receipts the processor has already claimed/completed.
      queued += 1;
    }
  } catch (error) {
    stopReason = "failed";
    throw error;
  } finally {
    try {
      const recovery = {
        scanned: events.length,
        queued,
        failed,
        deferred: events.length - queued - failed,
        exhaustedScanned,
        exhaustedMarkedDead,
        limit,
        batchFull: events.length === limit,
        stopReason,
        durationMs: monotonicNow() - recoveryStartedAt,
      };
      reportHeartbeat({ phase: "recovery_complete", ...recovery });
      airiWorkerLogger.info("whatsapp.webhook.drain", recovery);

      // A slow or failed recovery query must not starve independent maintenance.
      if (params.compactPayloads) {
        const startedAt = monotonicNow();
        try {
          reportHeartbeat({ phase: "payload_compaction" });
          const retention = await params.compactPayloads();
          const progress = {
            ...retention,
            status: "completed",
            durationMs: monotonicNow() - startedAt,
          };
          reportHeartbeat({
            phase: "payload_compaction_complete",
            ...progress,
          });
          airiWorkerLogger.info("whatsapp.webhook.payload_retention", progress);
        } catch (error) {
          // Maintenance must not fail successfully queued recovery work.
          const failure = {
            status: "failed",
            note: "maintenance_failed",
            durationMs: monotonicNow() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          };
          reportHeartbeat({ phase: "payload_compaction_failed", ...failure });
          airiWorkerLogger.warn("whatsapp.webhook.payload_retention", failure);
        }
      }

      if (params.refreshEngagement) {
        try {
          reportHeartbeat({ phase: "engagement_recovery" });
          const recovery = await params.refreshEngagement();
          if (recovery.processed || recovery.bootstrapsAdvanced) {
            airiWorkerLogger.info("conversation.engagement.recovery", recovery);
          }
        } catch (error) {
          airiWorkerLogger.warn("conversation.engagement.recovery", {
            note: "maintenance_failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  return {
    scanned: events.length,
    queued,
    failed,
  };
}

export async function whatsappWebhookDrainActivity(
  input: WhatsAppWebhookDrainActivityInput,
): Promise<WhatsAppWebhookDrainActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: WHATSAPP_WEBHOOK_DRAIN_WORKFLOW_CONTRACT_VERSION },
    "WhatsApp webhook drain activity",
  );

  const connectDB = (await import("@icecore/airi-runtime/mongoose")).default;
  await connectDB();
  const { default: WhatsAppWebhookEvent } = await import(
    "@icecore/airi-runtime/whatsapp-webhook-event-model"
  );
  const { ensureWhatsAppWebhookEventIndexes } = await import(
    "@icecore/airi-runtime/whatsapp-webhook-event-indexes"
  );
  await ensureWhatsAppWebhookEventIndexes();

  return drainPendingWhatsAppWebhookEventsToTemporal({
    model: WhatsAppWebhookEvent as WhatsAppWebhookEventModel,
    config: getTemporalWorkerConfig(),
    limit: input.limit,
    heartbeat,
    signalWithStart: signalWithStartWhatsAppWebhookProcessor,
    compactPayloads: async () => {
      const {
        compactCompletedWhatsAppWebhookEventPayloads,
        resolveWhatsAppWebhookPayloadRetentionPolicy,
      } = await import(
        "@icecore/airi-runtime/whatsapp-webhook-event-retention"
      );
      return compactCompletedWhatsAppWebhookEventPayloads({
        model: WhatsAppWebhookEvent,
        dryRun: false,
        ...resolveWhatsAppWebhookPayloadRetentionPolicy({ env: process.env }),
      });
    },
    refreshEngagement: async () => {
      const {
        drainPendingConversationEngagement,
        ensureConversationEngagementIndexes,
      } = await import("@/lib/engagement/conversation-engagement");
      await ensureConversationEngagementIndexes();
      return drainPendingConversationEngagement({
        limit: 10,
        heartbeat: () => heartbeat({ phase: "engagement_recovery" }),
      });
    },
  });
}
