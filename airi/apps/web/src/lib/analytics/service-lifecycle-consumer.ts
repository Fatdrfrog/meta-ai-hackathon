import "server-only";
import connectDB from "@/lib/mongoose";
import { Conversation } from "@/models/conversation";
import {
  AnalyticsServiceLifecycleCheckpoint,
  AnalyticsCustomerStageCheckpoint,
  AnalyticsServiceLifecycleFact,
} from "@/models/analytics-service-lifecycle";
import {
  decodeServiceLifecycleEnvelope as envelope,
  type ServiceLifecycleEnvelope,
} from "./service-lifecycle";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  airiWorkerLogger,
  describeLogError,
} from "@icecore/airi-runtime/logging";

// Reserved checkpoint identity only. Source evidence always retains its real tenant.
export const ANALYTICS_GLOBAL_CHECKPOINT = "__analytics_all_workspaces__";
const workspaceIdSchema = z.string().uuid();
export const isAnalyticsWorkspaceId = (value: unknown): value is string =>
  workspaceIdSchema.safeParse(value).success;

type ResumeToken = Record<string, unknown>;
export type ServiceLifecycleChange = {
  _id: ResumeToken;
  operationType: string;
  documentKey?: { _id?: unknown };
  fullDocument?: Record<string, unknown> | null;
  updateDescription?: { updatedFields?: Record<string, unknown> };
};
/** Records why a shared-stream change could not be trusted; the cause is logged, never stored raw. */
export type AnalyticsInvalidEvent = (cause: unknown) => Promise<unknown>;
type AnalyticsTransitionLogger = {
  error: (
    event: string,
    error: unknown,
    metadata?: Record<string, unknown>
  ) => void;
};
export type ServiceLifecycleCoverage = {
  state: "not_started" | "streaming" | "degraded" | "history_gap";
  history: "unknown" | "since_activation" | "history_gap";
  firstObservedAt: string | null;
  historyGapAt: string | null;
  snapshotRecovery: "pending" | "running" | "complete";
  snapshotScanned: number;
  resumePersistedAt: string | null;
};
type Checkpoint = {
  workspaceId: string;
  resumeToken?: ResumeToken | null;
  streamState?: string;
  historyState?: string;
  firstObservedAt?: Date;
  historyGapAt?: Date | null;
  snapshotState?: string;
  snapshotCursor?: mongoose.Types.ObjectId | null;
  snapshotScanned?: number;
  snapshotGapAt?: Date | null;
  resumePersistedAt?: Date | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
  startAtOperationTime?: mongoose.mongo.Timestamp | null;
};
const iso = (value?: Date | null) => value?.toISOString() ?? null;
export type ServiceLifecycleLease = {
  workspaceId: string;
  owner: string;
  fence: number;
  source?: "customer_stage";
};
export type AnalyticsTransitionSource = "service_lifecycle" | "customer_stage";
const checkpointModel = (
  source: AnalyticsTransitionSource = "service_lifecycle"
) =>
  source === "customer_stage"
    ? AnalyticsCustomerStageCheckpoint
    : AnalyticsServiceLifecycleCheckpoint;
const LEASE_MS = 30_000;
function leaseFilter(lease: ServiceLifecycleLease) {
  return {
    workspaceId: lease.workspaceId,
    leaseOwner: lease.owner,
    fence: lease.fence,
    leaseExpiresAt: { $gt: new Date() },
  };
}
async function acquireLease(
  workspaceId: string,
  source: AnalyticsTransitionSource = "service_lifecycle"
): Promise<ServiceLifecycleLease | null> {
  const model = checkpointModel(source);
  await model.updateOne(
    { workspaceId },
    {
      $setOnInsert: {
        workspaceId,
        firstObservedAt: new Date(),
        historyState: "since_activation",
        snapshotState: "pending",
      },
    },
    { upsert: true }
  );
  const owner = randomUUID(),
    now = new Date();
  const state = await model
    .findOneAndUpdate(
      {
        workspaceId,
        $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }],
      },
      {
        $set: {
          leaseOwner: owner,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        },
        $inc: { fence: 1 },
      },
      { new: true }
    )
    .lean<{ fence: number } | null>();
  return state
    ? {
        workspaceId,
        owner,
        fence: state.fence,
        ...(source === "customer_stage" ? { source } : {}),
      }
    : null;
}
export async function advanceServiceLifecycleCheckpoint(
  lease: ServiceLifecycleLease,
  update: Record<string, unknown>
) {
  const result = await checkpointModel(lease.source).updateOne(
    leaseFilter(lease),
    update
  );
  if (result.matchedCount !== 1)
    throw new Error(
      "Service lifecycle lease lost; stale consumer cannot advance"
    );
}
async function renewLease(lease: ServiceLifecycleLease) {
  await advanceServiceLifecycleCheckpoint(lease, {
    $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
  });
}
async function releaseLease(lease: ServiceLifecycleLease) {
  await checkpointModel(lease.source).updateOne(
    {
      workspaceId: lease.workspaceId,
      leaseOwner: lease.owner,
      fence: lease.fence,
    },
    { $set: { leaseOwner: null, leaseExpiresAt: null } }
  );
}

export async function persistServiceLifecycleFact(
  event: ServiceLifecycleEnvelope,
  evidence: "change_stream" | "snapshot_recovery"
) {
  await AnalyticsServiceLifecycleFact.updateOne(
    { workspaceId: event.workspaceId, eventId: event.eventId },
    {
      $setOnInsert: {
        workspaceId: event.workspaceId,
        eventId: event.eventId,
        conversationId: event.conversationId,
        customerId: event.customerId,
        sourceId: event.sourceId,
        channel: event.channel,
        revision: event.revision,
        occurredAt: event.occurredAt,
        kinds: event.kinds,
        evidence,
        envelope: event,
      },
    },
    { upsert: true }
  );
}

/** At-least-once delivery: unique event persistence always precedes its token. */
export async function processServiceLifecycleChange({
  workspaceId,
  change,
  persistFact = persistServiceLifecycleFact,
  checkpoint,
  invalidEvent,
}: {
  workspaceId: string;
  change: ServiceLifecycleChange;
  persistFact?: (
    event: ServiceLifecycleEnvelope,
    evidence: "change_stream" | "snapshot_recovery"
  ) => Promise<unknown>;
  checkpoint: (token: ResumeToken) => Promise<unknown>;
  invalidEvent?: AnalyticsInvalidEvent;
}): Promise<boolean> {
  // updateLookup can already show a later transition. Only the exact update value is historic evidence.
  let event: ServiceLifecycleEnvelope | null;
  try {
    event = envelope(
      change.operationType === "update"
        ? change.updateDescription?.updatedFields?.service_lifecycle_event
        : ["insert", "replace"].includes(change.operationType)
          ? change.fullDocument?.service_lifecycle_event
          : null
    );
  } catch (error) {
    if (workspaceId !== ANALYTICS_GLOBAL_CHECKPOINT || !invalidEvent)
      throw error;
    await invalidEvent(error);
    await checkpoint(change._id);
    return false;
  }
  const global = workspaceId === ANALYTICS_GLOBAL_CHECKPOINT;
  // A source write without an envelope (for example a default-null insert) is not a transition.
  if (global && event && !isAnalyticsWorkspaceId(event.workspaceId)) {
    const cause = new Error("Invalid analytics event workspace");
    if (!invalidEvent) throw cause;
    await invalidEvent(cause);
    await checkpoint(change._id);
    return false;
  }
  const belongs = Boolean(
    event && (global || event.workspaceId === workspaceId)
  );
  if (belongs && event) await persistFact(event, "change_stream");
  await checkpoint(change._id);
  return belongs;
}

export function isServiceLifecycleHistoryLost(error: unknown): boolean {
  const row = error as {
    code?: number;
    codeName?: string;
    message?: string;
  } | null;
  return (
    row?.code === 286 ||
    row?.code === 280 ||
    row?.codeName === "ChangeStreamHistoryLost" ||
    /resume token.*(?:not found|no longer|invalid)|change stream.*history.*lost/i.test(
      row?.message ?? ""
    )
  );
}

/** One bounded keyset batch restores only available snapshots, never complete history. */
export async function rebuildServiceLifecycleSnapshots({
  workspaceId,
  batchSize = 500,
  lease: suppliedLease,
  signal,
}: {
  workspaceId: string;
  batchSize?: number;
  lease?: ServiceLifecycleLease;
  signal?: AbortSignal;
}) {
  return rebuildAnalyticsTransitionSnapshots({
    workspaceId,
    batchSize,
    lease: suppliedLease,
    signal,
    source: "service_lifecycle",
    loadRows: async (cursor, limit) =>
      await Conversation.find({
        workspaceId,
        ...(cursor ? { _id: { $gt: cursor } } : {}),
      })
        .select("_id service_lifecycle_event")
        .sort({ _id: 1 })
        .limit(limit)
        .lean<
          { _id: mongoose.Types.ObjectId; service_lifecycle_event?: unknown }[]
        >(),
    persistRow: async row => {
      const event = envelope(row.service_lifecycle_event);
      if (event?.workspaceId === workspaceId)
        await persistServiceLifecycleFact(event, "snapshot_recovery");
    },
  });
}

export async function rebuildAnalyticsTransitionSnapshots({
  workspaceId,
  source,
  batchSize = 500,
  lease: suppliedLease,
  signal,
  loadRows,
  persistRow,
}: {
  workspaceId: string;
  source: AnalyticsTransitionSource;
  batchSize?: number;
  lease?: ServiceLifecycleLease;
  signal?: AbortSignal;
  loadRows: (
    cursor: mongoose.Types.ObjectId | null,
    limit: number
  ) => Promise<{ _id: mongoose.Types.ObjectId; [field: string]: unknown }[]>;
  persistRow: (row: {
    _id: mongoose.Types.ObjectId;
    [field: string]: unknown;
  }) => Promise<unknown>;
}) {
  if (
    suppliedLease &&
    (suppliedLease.workspaceId !== workspaceId ||
      (suppliedLease.source ?? "service_lifecycle") !== source)
  )
    throw new Error("Snapshot recovery requires the matching source lease");
  await connectDB();
  const lease = suppliedLease ?? (await acquireLease(workspaceId, source));
  if (!lease) return { scanned: 0, complete: false, busy: true };
  try {
    await renewLease(lease);
    const state = await checkpointModel(source)
      .findOne({
        workspaceId,
      })
      .lean<Checkpoint | null>();
    if (!state)
      throw new Error("Start lifecycle consumer before snapshot recovery");
    const global =
      workspaceId === ANALYTICS_GLOBAL_CHECKPOINT
        ? null
        : await checkpointModel(source)
            .findOne({ workspaceId: ANALYTICS_GLOBAL_CHECKPOINT })
            .lean<Checkpoint | null>();
    const gapAt = global?.historyGapAt;
    if (
      gapAt &&
      (!state.snapshotGapAt || state.snapshotGapAt.getTime() < gapAt.getTime())
    ) {
      const reset = {
        snapshotState: "pending",
        snapshotCursor: null,
        snapshotScanned: 0,
        snapshotGapAt: gapAt,
      };
      // Lazily invalidate only this visited tenant, under its own existing source fence.
      await advanceServiceLifecycleCheckpoint(lease, { $set: reset });
      Object.assign(state, reset);
    }
    if (state.snapshotState === "complete")
      return { scanned: 0, complete: true };
    const limit = Math.min(500, Math.max(1, Math.floor(batchSize)));
    const rows = await loadRows(state.snapshotCursor ?? null, limit + 1);
    const loaded = rows.slice(0, limit);
    // Shutdown stops between rows; the keyset cursor keeps only the persisted prefix.
    let persisted = 0;
    for (; persisted < loaded.length && !signal?.aborted; persisted++) {
      if (persisted % 100 === 0) await renewLease(lease);
      await persistRow(loaded[persisted]);
    }
    const batch = loaded.slice(0, persisted);
    const complete = persisted === loaded.length && rows.length <= limit;
    if (batch.length || complete)
      await advanceServiceLifecycleCheckpoint(lease, {
        $set: {
          snapshotState: complete ? "complete" : "running",
          ...(batch.length
            ? { snapshotCursor: batch[batch.length - 1]._id }
            : {}),
        },
        $inc: { snapshotScanned: batch.length },
      });
    return { scanned: batch.length, complete };
  } finally {
    if (!suppliedLease) await releaseLease(lease);
  }
}

export async function readServiceLifecycleCoverage(
  workspaceId: string
): Promise<ServiceLifecycleCoverage> {
  return readAnalyticsTransitionCoverage(workspaceId, "service_lifecycle");
}

export async function readAnalyticsTransitionCoverage(
  workspaceId: string,
  source: AnalyticsTransitionSource
): Promise<ServiceLifecycleCoverage> {
  const [state, global] = await Promise.all([
    checkpointModel(source)
      .findOne({
        workspaceId,
      })
      .lean<Checkpoint | null>(),
    workspaceId === ANALYTICS_GLOBAL_CHECKPOINT
      ? Promise.resolve(null)
      : checkpointModel(source)
          .findOne({ workspaceId: ANALYTICS_GLOBAL_CHECKPOINT })
          .lean<Checkpoint | null>(),
  ]);
  // Snapshot progress is tenant-local; activation, liveness and gaps belong to the shared source stream.
  const stream = global ?? state;
  const historyGap =
    stream?.historyState === "history_gap" ||
    state?.historyState === "history_gap";
  const staleSnapshot = Boolean(
    global?.historyGapAt &&
      (!state?.snapshotGapAt ||
        state.snapshotGapAt.getTime() < global.historyGapAt.getTime())
  );
  return {
    state: !stream
      ? "not_started"
      : historyGap
        ? "history_gap"
        : stream.streamState === "streaming" &&
            stream.leaseOwner &&
            stream.leaseExpiresAt &&
            stream.leaseExpiresAt.getTime() > Date.now()
          ? "streaming"
          : "degraded",
    history: historyGap
      ? "history_gap"
      : stream?.resumeToken || stream?.startAtOperationTime
        ? "since_activation"
        : "unknown",
    firstObservedAt: iso(stream?.firstObservedAt),
    historyGapAt: iso(stream?.historyGapAt ?? state?.historyGapAt),
    snapshotRecovery: staleSnapshot
      ? "pending"
      : state?.snapshotState === "complete"
        ? "complete"
        : state?.snapshotState === "running"
          ? "running"
          : "pending",
    snapshotScanned: staleSnapshot ? 0 : (state?.snapshotScanned ?? 0),
    resumePersistedAt: iso(stream?.resumePersistedAt),
  };
}

export async function watchServiceLifecycle({
  workspaceId,
  signal,
  maxEvents,
  snapshotBatchSize = 500,
  logger,
}: {
  workspaceId: string;
  signal?: AbortSignal;
  maxEvents?: number;
  snapshotBatchSize?: number;
  logger?: AnalyticsTransitionLogger;
}) {
  return watchAnalyticsTransitionSource({
    workspaceId,
    signal,
    maxEvents,
    snapshotBatchSize,
    logger,
    source: "service_lifecycle",
    collection: Conversation.collection,
    eventKeyField: "service_lifecycle_event_key",
    processChange: (change, checkpoint, invalidEvent) =>
      processServiceLifecycleChange({
        workspaceId,
        change,
        checkpoint,
        invalidEvent,
      }),
    rebuildSnapshots: lease =>
      workspaceId === ANALYTICS_GLOBAL_CHECKPOINT
        ? Promise.resolve({ scanned: 0, complete: false })
        : rebuildServiceLifecycleSnapshots({
            workspaceId,
            batchSize: snapshotBatchSize,
            lease,
            signal,
          }),
  });
}

/** Shared streams admit only changes that carry an event key; schema-default nulls are not events. */
export function analyticsTransitionMatch(
  workspaceId: string,
  eventKeyField: string
) {
  const global = workspaceId === ANALYTICS_GLOBAL_CHECKPOINT;
  return {
    $or: [
      {
        operationType: { $in: ["insert", "replace"] },
        ...(global
          ? { [`fullDocument.${eventKeyField}`]: { $type: "string" } }
          : { "fullDocument.workspaceId": workspaceId }),
      },
      {
        operationType: "update",
        [`updateDescription.updatedFields.${eventKeyField}`]: global
          ? { $type: "string" }
          : {
              $regex: `^${workspaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`,
            },
      },
    ],
  };
}

export async function watchAnalyticsTransitionSource({
  workspaceId,
  signal,
  maxEvents,
  source,
  collection,
  eventKeyField,
  processChange,
  rebuildSnapshots,
  logger = airiWorkerLogger,
}: {
  workspaceId: string;
  signal?: AbortSignal;
  maxEvents?: number;
  snapshotBatchSize?: number;
  source: AnalyticsTransitionSource;
  collection: mongoose.Collection;
  eventKeyField: string;
  processChange: (
    change: ServiceLifecycleChange,
    checkpoint: (token: ResumeToken) => Promise<unknown>,
    invalidEvent: AnalyticsInvalidEvent
  ) => Promise<unknown>;
  rebuildSnapshots: (lease: ServiceLifecycleLease) => Promise<unknown>;
  logger?: AnalyticsTransitionLogger;
}) {
  await connectDB();
  const lease = await acquireLease(workspaceId, source);
  if (!lease) return { status: "busy" as const, processed: 0 };
  let processed = 0;
  let stream: ReturnType<typeof Conversation.collection.watch> | null = null;
  try {
    const state = await checkpointModel(source)
      .findOne({
        workspaceId,
      })
      .lean<Checkpoint>();
    if (!state)
      throw new Error("Lifecycle analytics checkpoint no longer exists");
    let startAtOperationTime = state.startAtOperationTime;
    if (!state.resumeToken && !startAtOperationTime) {
      const db = mongoose.connection.db;
      if (!db) throw new Error("MongoDB is not connected");
      const hello = await db.command({ hello: 1 });
      startAtOperationTime = hello.operationTime;
      if (!startAtOperationTime)
        throw new Error(
          "Lifecycle analytics requires a replica set operation boundary"
        );
      await advanceServiceLifecycleCheckpoint(lease, {
        $set: {
          startAtOperationTime,
          ...(state.historyState !== "history_gap"
            ? { firstObservedAt: new Date() }
            : {}),
        },
      });
    }
    stream = collection.watch(
      [{ $match: analyticsTransitionMatch(workspaceId, eventKeyField) }],
      {
        ...(state.resumeToken ? { resumeAfter: state.resumeToken } : {}),
        ...(!state.resumeToken && startAtOperationTime
          ? { startAtOperationTime }
          : {}),
        maxAwaitTimeMS: 1000,
      }
    );
    let primedChange = await stream.tryNext();
    await advanceServiceLifecycleCheckpoint(lease, {
      $set: { streamState: "streaming" },
    });
    let lastRenewed = Date.now(),
      lastRecovered = 0;
    while (
      !signal?.aborted &&
      (maxEvents === undefined || processed < maxEvents)
    ) {
      const change = primedChange ?? (await stream.tryNext());
      primedChange = null;
      if (Date.now() - lastRenewed >= 10_000) {
        await renewLease(lease);
        lastRenewed = Date.now();
      }
      if (!change) {
        if (Date.now() - lastRecovered >= 10_000) {
          if (stream.resumeToken)
            await advanceServiceLifecycleCheckpoint(lease, {
              $set: {
                resumeToken: stream.resumeToken,
                resumePersistedAt: new Date(),
              },
            });
          await rebuildSnapshots(lease);
          lastRecovered = Date.now();
          lastRenewed = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      const sourceChange = change as unknown as ServiceLifecycleChange;
      await processChange(
        sourceChange,
        token =>
          advanceServiceLifecycleCheckpoint(lease, {
            $set: { resumeToken: token, resumePersistedAt: new Date() },
          }),
        async cause => {
          logger.error(
            "analytics.projection_degraded",
            describeLogError(cause),
            {
              phase: source,
              reason: "invalid_source_event",
              operationType: sourceChange.operationType,
              documentId:
                sourceChange.documentKey?._id == null
                  ? null
                  : String(sourceChange.documentKey._id),
            }
          );
          await advanceServiceLifecycleCheckpoint(lease, {
            $set: {
              historyState: "history_gap",
              historyGapAt: new Date(),
              gapReason: "invalid_source_event",
            },
          });
        }
      );
      processed++;
    }
    return { status: "stopped" as const, processed };
  } catch (error) {
    if (isServiceLifecycleHistoryLost(error)) {
      await advanceServiceLifecycleCheckpoint(lease, {
        $set: {
          streamState: "degraded",
          historyState: "history_gap",
          historyGapAt: new Date(),
          gapReason: "resume_history_lost",
          resumeToken: null,
          startAtOperationTime: null,
          snapshotState: "pending",
          snapshotCursor: null,
          snapshotScanned: 0,
        },
      });
      const recovery = await rebuildSnapshots(lease);
      return { status: "history_gap" as const, processed, recovery };
    }
    await advanceServiceLifecycleCheckpoint(lease, {
      $set: { streamState: "degraded" },
    });
    throw error;
  } finally {
    try {
      await stream?.close();
    } finally {
      await releaseLease(lease);
    }
  }
}
