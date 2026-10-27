import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";
import { buildRealtimeChannelName } from "@icecore/shared/types/realtime";
import mongoose from "mongoose";
import { createHash } from "node:crypto";

import {
  assertRequestListItemPayload,
  type RequestListItemPayload,
  type RequestProjectionTombstone,
} from "./contract";
import type {
  ProjectionBoundaryProgress,
  RequestsProjectionGenerationMode,
  RequestsProjectionLease,
  ReservedProjectionBoundary,
} from "./checkpoint";

export class RequestsProjectionLeaseLostError extends Error {
  constructor(message = "Requests projection lease was lost") {
    super(message);
    this.name = "RequestsProjectionLeaseLostError";
  }
}

export function buildProjectionTombstone(input: {
  conversationId: mongoose.Types.ObjectId;
  workspaceId: string;
  generation: mongoose.mongo.Long;
  projectedAt: Date;
  fence: mongoose.mongo.Long;
  sourceWatermark: mongoose.mongo.Timestamp;
  readStateWatermark: mongoose.mongo.Timestamp;
}): RequestProjectionTombstone {
  return assertRequestListItemPayload({
    _id: input.conversationId,
    workspaceId: input.workspaceId,
    schemaVersion: 1,
    projectedAt: input.projectedAt,
    deletedAt: input.projectedAt,
    projection: {
      status: "ready",
      generation: input.generation,
      fence: input.fence,
      sourceWatermark: input.sourceWatermark,
      readStateWatermark: input.readStateWatermark,
    },
  });
}

export type ProjectedRealtimeEvent = RealtimeEventEnvelope & {
  channel: string;
  payload: RealtimeEventEnvelope["payload"] & {
    conversationId: string;
    changeType: "updated" | "removed";
    projectionGeneration: string;
  };
};

export function buildProjectedRealtimeEvent(
  row: RequestListItemPayload | RequestProjectionTombstone
): ProjectedRealtimeEvent {
  const conversationId = row._id.toHexString();
  const generation = mongoose.mongo.Long.isLong(row.projection.generation)
    ? row.projection.generation.toString()
    : String(row.projection.generation);
  const changeType = row.deletedAt instanceof Date ? "removed" : "updated";
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        domain: "airi.requests.row.changed.v3",
        workspaceId: row.workspaceId,
        conversationId,
        generation,
        changeType,
      }),
      "utf8"
    )
    .digest("hex");
  const eventId = `requests-row:v3:${identity}`;
  const createdAt = row.projectedAt.toISOString();

  return {
    eventId,
    version: 1,
    name: "conversation.row.changed",
    workspaceId: row.workspaceId,
    conversationId,
    createdAt,
    dedupeKey: eventId,
    channel: buildRealtimeChannelName({
      kind: "workspace",
      workspaceId: row.workspaceId,
    }),
    payload: {
      conversationId,
      changeType,
      projectionGeneration: generation,
    },
  };
}

type ProjectedRealtimeOutboxInsert = {
  eventId: string;
  version: ProjectedRealtimeEvent["version"];
  name: ProjectedRealtimeEvent["name"];
  workspaceId: string;
  conversationId: string | null;
  channel: string;
  dedupeKey: string;
  event: RealtimeEventEnvelope;
  status: "pending";
  attempts: 0;
  messageId: null;
  publishedAt: null;
  lastError: null;
  replayLeaseId: null;
  replayLeaseExpiresAt: null;
  lastReplayAt: null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export function buildProjectedRealtimeOutboxInsert(
  event: ProjectedRealtimeEvent
): ProjectedRealtimeOutboxInsert {
  const { channel, ...envelope } = event;
  const createdAt = new Date(event.createdAt);
  return {
    eventId: event.eventId,
    version: event.version,
    name: event.name,
    workspaceId: event.workspaceId,
    conversationId: event.conversationId || null,
    channel,
    dedupeKey: event.dedupeKey,
    event: envelope,
    status: "pending",
    attempts: 0,
    messageId: null,
    publishedAt: null,
    lastError: null,
    replayLeaseId: null,
    replayLeaseExpiresAt: null,
    lastReplayAt: null,
    nextAttemptAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

export function selectAdvancingProjectionRows(
  incomingRows: readonly RequestListItemPayload[],
  existingRows: ReadonlyArray<{
    _id: mongoose.Types.ObjectId;
    projection?: { generation?: unknown };
  }>,
  generationMode: RequestsProjectionGenerationMode
): RequestListItemPayload[] {
  if (generationMode === "cluster_time_v1") {
    return incomingRows.map(assertRequestListItemPayload);
  }
  const existingById = new Map(
    existingRows.map(row => {
      if (!(row._id instanceof mongoose.Types.ObjectId)) {
        throw new TypeError("Existing Requests projection row ID is invalid");
      }
      return [row._id.toHexString(), row] as const;
    })
  );
  const seen = new Set<string>();
  const selected: RequestListItemPayload[] = [];
  for (const candidate of incomingRows) {
    const row = assertRequestListItemPayload(candidate);
    const id = row._id.toHexString();
    if (seen.has(id)) {
      throw new Error("Requests projection batch contains a duplicate row");
    }
    seen.add(id);
    const existing = existingById.get(id);
    const existingGeneration = existing?.projection?.generation;
    if (
      existingGeneration === undefined ||
      projectionGenerationBigInt(row.projection.generation) >
        projectionGenerationBigInt(existingGeneration)
    ) {
      selected.push(row);
    }
  }
  return selected;
}

function projectionGenerationBigInt(value: unknown): bigint {
  if (mongoose.mongo.Long.isLong(value)) return value.toBigInt();
  if (typeof value === "bigint") return value;
  throw new TypeError("Requests projection generation must be int64");
}

export type ProjectionCommitSession = {
  withTransaction<T>(work: () => Promise<T>): Promise<T>;
  endSession(): Promise<void> | void;
};

type CommitProjectedBatchInput = {
  lease: RequestsProjectionLease;
  rows: RequestListItemPayload[];
  boundary: ReservedProjectionBoundary;
  progress: ProjectionBoundaryProgress | null;
  realtimeEnabled: boolean;
  now?: Date;
};

export type CommitProjectedBatchResult = Readonly<{
  lease: RequestsProjectionLease;
}>;

type CommitProjectedBatchDependencies = {
  // This callback schedules bounded best-effort publication. Durable delivery
  // remains owned by the outbox written in the transaction below.
  publishCommittedEvents?(events: readonly ProjectedRealtimeEvent[]): void;
  startSession(): Promise<ProjectionCommitSession>;
  replaceRows(input: {
    rows: RequestListItemPayload[];
    session: ProjectionCommitSession;
    generationMode: RequestsProjectionGenerationMode;
  }): Promise<RequestListItemPayload[] | void>;
  enqueue(input: {
    events: ProjectedRealtimeEvent[];
    session: ProjectionCommitSession;
  }): Promise<void>;
  assertBoundary(input: {
    lease: RequestsProjectionLease;
    boundary: ReservedProjectionBoundary;
    session: ProjectionCommitSession;
    now: Date;
  }): Promise<RequestsProjectionGenerationMode>;
  finalizeBoundary(input: {
    lease: RequestsProjectionLease;
    boundary: ReservedProjectionBoundary;
    progress: ProjectionBoundaryProgress;
    projectedCountIncrement: number;
    session: ProjectionCommitSession;
    now: Date;
  }): Promise<RequestsProjectionLease>;
};

export async function commitProjectedBatch(
  input: CommitProjectedBatchInput,
  dependencies: CommitProjectedBatchDependencies
): Promise<CommitProjectedBatchResult> {
  const now = input.now || new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Requests projection commit time must be valid");
  }
  const rows = Object.freeze(
    input.rows.map(row => Object.freeze(assertRequestListItemPayload(row)))
  );
  const v3Events = Object.freeze(
    input.realtimeEnabled ? rows.map(buildProjectedRealtimeEvent) : []
  );
  const v3EventByConversationId = new Map(
    v3Events.map(event => [event.conversationId || "", event] as const)
  );
  const session = await dependencies.startSession();
  let nextLease = input.lease;
  let committedRows: readonly RequestListItemPayload[] = [];
  try {
    await session.withTransaction(async () => {
      const generationMode = await dependencies.assertBoundary({
        lease: input.lease,
        boundary: input.boundary,
        session,
        now,
      });

      const replaced = await dependencies.replaceRows({
        rows: [...rows],
        session,
        generationMode,
      });
      committedRows = Object.freeze(replaced ? [...replaced] : [...rows]);
      if (input.realtimeEnabled && committedRows.length > 0) {
        await dependencies.enqueue({
          events: committedRows.map(row => {
            const event = v3EventByConversationId.get(row._id.toHexString());
            if (!event) {
              throw new Error(
                "Requests projection v3 event mapping is missing"
              );
            }
            return event;
          }),
          session,
        });
      }

      if (input.progress) {
        nextLease = await dependencies.finalizeBoundary({
          lease: input.lease,
          boundary: input.boundary,
          progress: input.progress,
          projectedCountIncrement: committedRows.length,
          session,
          now,
        });
      } else {
        nextLease = input.lease;
      }
    });
  } finally {
    await session.endSession();
  }

  const committedIds = new Set(committedRows.map(row => row._id.toHexString()));
  if (v3Events.length > 0 && committedIds.size > 0) {
    dependencies.publishCommittedEvents?.(
      v3Events.filter(event => committedIds.has(event.conversationId || ""))
    );
  }
  return Object.freeze({ lease: nextLease });
}
