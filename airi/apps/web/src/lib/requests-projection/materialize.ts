import { deriveRequestListItem } from "@/lib/requests-projection/derive";
import { buildProjectionTombstone } from "@/lib/requests-projection/projector";
import {
  readRequestProjectionSource,
  requireRequestProjectionSourceClusterTime,
  type RequestProjectionReadStateWatermarkMode,
} from "@/lib/requests-projection/source-reader";
import { Conversation } from "@/models/conversation";
import { RequestListItem } from "@/models/request-list-item";
import mongoose from "mongoose";

import type {
  RequestListItemPayload,
  RequestProjectionTombstone,
} from "./contract";

type MaterializedRequestConversation = {
  conversationId: mongoose.Types.ObjectId;
  workspaceId: string;
  row: RequestListItemPayload | RequestProjectionTombstone;
};

type ProjectionRowCollection = {
  findOne(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<{
    workspaceId?: unknown;
    projection?: { readStateWatermark?: unknown };
  } | null>;
};

function projectionRowCollection(): ProjectionRowCollection {
  return RequestListItem.collection as unknown as ProjectionRowCollection;
}

function asObjectId(value: unknown): mongoose.Types.ObjectId | null {
  if (value instanceof mongoose.Types.ObjectId) return value;
  const text = String(value || "");
  return mongoose.Types.ObjectId.isValid(text)
    ? new mongoose.Types.ObjectId(text)
    : null;
}

function requiredWorkspaceId(value: unknown): string {
  const workspaceId = typeof value === "string" ? value.trim() : "";
  if (!workspaceId) {
    throw new Error("Requests projection source requires workspaceId");
  }
  return workspaceId;
}

function readyProjection(input: {
  generation: mongoose.mongo.Long;
  fence: mongoose.mongo.Long;
}) {
  return {
    status: "ready" as const,
    generation: input.generation,
    fence: input.fence,
  };
}

function zeroProjectionWatermark(): mongoose.mongo.Timestamp {
  return new mongoose.mongo.Timestamp({ t: 0, i: 0 });
}

function existingReadStateWatermark(value: unknown): mongoose.mongo.Timestamp {
  if (value === undefined) return zeroProjectionWatermark();
  if (!(value instanceof mongoose.mongo.Timestamp)) {
    throw new TypeError(
      "Request projection readStateWatermark must be a BSON Timestamp"
    );
  }
  return value;
}

function greatestProjectionWatermark(
  current: mongoose.mongo.Timestamp,
  candidate: mongoose.mongo.Timestamp
): mongoose.mongo.Timestamp {
  return current.toBigInt() >= candidate.toBigInt() ? current : candidate;
}

type MaterializeRequestConversationDeps = {
  startSession(options: {
    causalConsistency: true;
  }): Promise<mongoose.ClientSession>;
};

const defaultMaterializeDeps: MaterializeRequestConversationDeps = {
  startSession: options => mongoose.startSession(options),
};

export async function materializeRequestConversation(
  input: {
    conversationId: mongoose.Types.ObjectId | string;
    generation: mongoose.mongo.Long;
    fence: mongoose.mongo.Long;
    sourceClusterTime: mongoose.mongo.Timestamp;
    readStateWatermarkMode: RequestProjectionReadStateWatermarkMode;
    projectedAt?: Date;
    workspaceId?: string;
  },
  deps: MaterializeRequestConversationDeps = defaultMaterializeDeps
): Promise<MaterializedRequestConversation | null> {
  const conversationId = asObjectId(input.conversationId);
  if (!conversationId) {
    throw new Error("Invalid Requests projection conversation id");
  }
  const sourceClusterTime = requireRequestProjectionSourceClusterTime(
    input.sourceClusterTime
  );
  const projectedAt = input.projectedAt || new Date();
  const session = await deps.startSession({ causalConsistency: true });
  try {
    const source = await readRequestProjectionSource({
      conversationId,
      session,
      sourceClusterTime,
    });
    const existing = await projectionRowCollection().findOne(
      { _id: conversationId },
      {
        projection: { workspaceId: 1, "projection.readStateWatermark": 1 },
        session,
        readPreference: "primary",
        readConcern: { level: "majority" },
        promoteLongs: false,
      }
    );
    const priorReadStateWatermark = existingReadStateWatermark(
      existing?.projection?.readStateWatermark
    );

    if (source) {
      const workspaceId = requiredWorkspaceId(source.conversation.workspaceId);
      if (input.workspaceId && input.workspaceId !== workspaceId) {
        throw new Error("Requests projection workspace ownership changed");
      }
      const readStateWatermark =
        input.readStateWatermarkMode === "advance_if_changed"
          ? greatestProjectionWatermark(
              priorReadStateWatermark,
              sourceClusterTime
            )
          : priorReadStateWatermark;
      const row = deriveRequestListItem({
        source,
        generation: input.generation,
        workspaceUnreadGeneration: mongoose.mongo.Long.ONE,
        sourceWatermark: sourceClusterTime,
        readStateWatermark,
        projectedAt,
        projection: readyProjection(input),
      });
      return { conversationId, workspaceId, row };
    }

    const workspaceId =
      input.workspaceId ||
      (typeof existing?.workspaceId === "string" ? existing.workspaceId : null);
    if (!workspaceId) return null;

    return {
      conversationId,
      workspaceId,
      row: buildProjectionTombstone({
        conversationId,
        workspaceId,
        generation: input.generation,
        projectedAt,
        fence: input.fence,
        sourceWatermark: sourceClusterTime,
        readStateWatermark: priorReadStateWatermark,
      }),
    };
  } finally {
    await session.endSession();
  }
}

export async function materializeRequestConversationPage(
  input: {
    afterId?: mongoose.Types.ObjectId | null;
    limit?: number;
    generation: mongoose.mongo.Long;
    fence: mongoose.mongo.Long;
    sourceClusterTime: mongoose.mongo.Timestamp;
    signal?: AbortSignal;
  },
  deps: MaterializeRequestConversationDeps = defaultMaterializeDeps
): Promise<{
  rows: RequestListItemPayload[];
  projected: number;
  lastId: mongoose.Types.ObjectId | null;
  hasMore: boolean;
}> {
  const limit = Math.min(500, Math.max(1, input.limit || 100));
  const filter = input.afterId ? { _id: { $gt: input.afterId } } : {};
  const sourceClusterTime = requireRequestProjectionSourceClusterTime(
    input.sourceClusterTime
  );
  const enumerationSession = await deps.startSession({
    causalConsistency: true,
  });
  let sourceRows: Array<{
    _id: mongoose.Types.ObjectId;
    workspaceId: string;
  }>;
  try {
    enumerationSession.advanceOperationTime(sourceClusterTime);
    sourceRows = await Conversation.find(filter)
      .select("_id workspaceId")
      .sort({ _id: 1 })
      .limit(limit + 1)
      .session(enumerationSession)
      .read("primary")
      .readConcern("majority")
      .lean<
        Array<{
          _id: mongoose.Types.ObjectId;
          workspaceId: string;
        }>
      >()
      .exec();
  } finally {
    await enumerationSession.endSession();
  }
  const page = sourceRows.slice(0, limit);
  const rows: RequestListItemPayload[] = [];

  for (let offset = 0; offset < page.length; offset += 8) {
    if (input.signal?.aborted) throw input.signal.reason;
    const batch = await Promise.allSettled(
      page.slice(offset, offset + 8).map(source =>
        materializeRequestConversation(
          {
            conversationId: source._id,
            workspaceId: requiredWorkspaceId(source.workspaceId),
            generation: input.generation,
            fence: input.fence,
            sourceClusterTime,
            readStateWatermarkMode: "preserve",
          },
          deps
        )
      )
    );
    const failure = batch.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const result of batch) {
      if (
        result.status === "fulfilled" &&
        result.value &&
        !(result.value.row.deletedAt instanceof Date)
      ) {
        rows.push(result.value.row as RequestListItemPayload);
      }
    }
  }

  return {
    rows,
    projected: rows.length,
    lastId: page.at(-1)?._id || input.afterId || null,
    hasMore: sourceRows.length > limit,
  };
}

export function projectionChangeConversationIds(input: {
  change: Record<string, unknown>;
  conversationCollection: string;
  messageCollection: string;
}): Array<{
  conversationId: mongoose.Types.ObjectId;
  workspaceId?: string;
}> {
  const change = input.change as {
    ns?: { coll?: unknown };
    fullDocument?: Record<string, unknown> | null;
    fullDocumentBeforeChange?: Record<string, unknown> | null;
    documentKey?: Record<string, unknown> | null;
  };
  const collection = String(change.ns?.coll || "");
  const results = new Map<
    string,
    { conversationId: mongoose.Types.ObjectId; workspaceId?: string }
  >();
  const add = (id: unknown, workspaceId?: unknown) => {
    const conversationId = asObjectId(id);
    if (!conversationId) return;
    results.set(conversationId.toHexString(), {
      conversationId,
      ...(typeof workspaceId === "string" && workspaceId.trim()
        ? { workspaceId: workspaceId.trim() }
        : {}),
    });
  };

  if (collection === input.conversationCollection) {
    const document =
      change.fullDocument || change.fullDocumentBeforeChange || {};
    add(document._id || change.documentKey?._id, document.workspaceId);
  } else if (collection === input.messageCollection) {
    const current = change.fullDocument || {};
    const previous = change.fullDocumentBeforeChange || {};
    add(current.conversation, current.workspaceId);
    add(previous.conversation, previous.workspaceId);
  }

  return [...results.values()];
}
