import { isRealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import { randomUUID } from "node:crypto";

import connectDB from "@/lib/mongoose";
import {
  ensureRealtimeEventIndexes,
  RealtimeEvent,
} from "@/models/realtime-event";
import { publishRealtimePubSubEvent, type MappedRealtimeEvent } from "./server";

type ReplayBatchOptions = {
  batchSize?: number;
  leaseId?: string;
  leaseMs?: number;
  maxAttempts?: number;
  now?: Date;
  retryDelayMs?: number;
  stalePendingMs?: number;
  shouldContinue?: () => boolean;
};

export type ReplayBatchResult = {
  claimed: number;
  published: number;
  failed: number;
};

type RealtimeOutboxDocument = {
  _id: unknown;
  channel?: unknown;
  event?: unknown;
  eventId?: unknown;
};

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_STALE_PENDING_MS = 30_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.floor(value)
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toMappedRealtimeEvent(
  doc: RealtimeOutboxDocument
): MappedRealtimeEvent {
  if (!isRealtimeEventEnvelope(doc.event)) {
    throw new Error("Realtime outbox event envelope is invalid");
  }
  const eventWithMaybeChannel = doc.event as unknown as { channel?: unknown };
  const channel =
    typeof doc.channel === "string"
      ? doc.channel
      : typeof eventWithMaybeChannel.channel === "string"
        ? eventWithMaybeChannel.channel
        : null;
  if (!channel) {
    throw new Error("Realtime outbox event channel is missing");
  }
  return {
    ...doc.event,
    channel,
  };
}

async function claimNextRealtimeOutboxEvent(params: {
  leaseExpiresAt: Date;
  leaseId: string;
  maxAttempts: number;
  now: Date;
  stalePendingBefore: Date;
}): Promise<RealtimeOutboxDocument | null> {
  return RealtimeEvent.findOneAndUpdate(
    {
      attempts: { $lt: params.maxAttempts },
      $and: [
        {
          $or: [
            { status: "failed" },
            {
              status: "pending",
              nextAttemptAt: { $type: "date", $lte: params.now },
            },
            {
              status: "pending",
              createdAt: { $lte: params.stalePendingBefore },
              $or: [
                { nextAttemptAt: { $exists: false } },
                { nextAttemptAt: null },
              ],
            },
            {
              status: "replaying",
              replayLeaseExpiresAt: { $lte: params.now },
            },
          ],
        },
        {
          $or: [
            { replayLeaseExpiresAt: { $exists: false } },
            { replayLeaseExpiresAt: null },
            { replayLeaseExpiresAt: { $lte: params.now } },
          ],
        },
        {
          $or: [
            { nextAttemptAt: { $exists: false } },
            { nextAttemptAt: null },
            { nextAttemptAt: { $lte: params.now } },
          ],
        },
      ],
    },
    {
      $set: {
        status: "replaying",
        replayLeaseId: params.leaseId,
        replayLeaseExpiresAt: params.leaseExpiresAt,
        lastReplayAt: params.now,
      },
      $inc: { attempts: 1 },
    },
    {
      new: true,
      sort: { createdAt: 1 },
    }
  ) as Promise<RealtimeOutboxDocument | null>;
}

async function markRealtimeOutboxPublished(params: {
  id: unknown;
  leaseId: string;
  messageId?: string | null;
  now: Date;
}) {
  await RealtimeEvent.updateOne(
    { _id: params.id, replayLeaseId: params.leaseId },
    {
      $set: {
        status: "published",
        publishedAt: params.now,
        messageId: params.messageId || null,
        lastError: null,
      },
      $unset: {
        replayLeaseId: "",
        replayLeaseExpiresAt: "",
        nextAttemptAt: "",
      },
    }
  );
}

async function markRealtimeOutboxFailed(params: {
  error: unknown;
  id: unknown;
  leaseId: string;
  nextAttemptAt: Date;
}) {
  await RealtimeEvent.updateOne(
    { _id: params.id, replayLeaseId: params.leaseId },
    {
      $set: {
        status: "failed",
        lastError: errorMessage(params.error),
        nextAttemptAt: params.nextAttemptAt,
      },
      $unset: {
        replayLeaseId: "",
        replayLeaseExpiresAt: "",
      },
    }
  );
}

export async function replayRealtimeOutboxBatch(
  options: ReplayBatchOptions
): Promise<ReplayBatchResult> {
  if (options.shouldContinue && !options.shouldContinue()) {
    return { claimed: 0, published: 0, failed: 0 };
  }
  await connectDB();
  await ensureRealtimeEventIndexes();

  const batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
  const maxAttempts = positiveInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS
  );
  const retryDelayMs = positiveInteger(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS
  );
  const stalePendingMs = positiveInteger(
    options.stalePendingMs,
    DEFAULT_STALE_PENDING_MS
  );
  const leaseId = options.leaseId || randomUUID();
  const result: ReplayBatchResult = {
    claimed: 0,
    published: 0,
    failed: 0,
  };

  while (result.claimed < batchSize) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    // Slow batches must not admit later rows with an already-expired lease.
    const now = options.now || new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const stalePendingBefore = new Date(now.getTime() - stalePendingMs);
    const nextAttemptAt = new Date(now.getTime() + retryDelayMs);
    const doc = await claimNextRealtimeOutboxEvent({
      leaseExpiresAt,
      leaseId,
      maxAttempts,
      now,
      stalePendingBefore,
    });
    if (!doc) break;

    result.claimed += 1;
    try {
      const publishResult = await publishRealtimePubSubEvent(
        toMappedRealtimeEvent(doc)
      );
      await markRealtimeOutboxPublished({
        id: doc._id,
        leaseId,
        messageId: publishResult.messageId || null,
        now,
      });
      result.published += 1;
    } catch (error) {
      await markRealtimeOutboxFailed({
        error,
        id: doc._id,
        leaseId,
        nextAttemptAt,
      });
      result.failed += 1;
    }
  }

  return result;
}
