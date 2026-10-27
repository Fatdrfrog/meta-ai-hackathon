import connectDB from "@/lib/mongoose";
import { createServerLogger } from "@/lib/observability/server-logs";
import { markPendingV3PubSubConfirmed } from "@/lib/realtime/outbox-lifecycle";
import { createProjectionChangeBatchReader } from "./change-batch";
import {
  advanceIdleProjectionResumeToken,
  assertReservedProjectionBoundary,
  claimRequestsProjectionCheckpointLease,
  deriveProjectionBackfillBoundaryDigest,
  deriveProjectionResumeTokenDigest,
  finalizeProjectionBoundary,
  readRequestsProjectionCheckpoint,
  releaseRequestsProjectionCheckpointLease,
  reserveProjectionBoundary,
  resetRequestsProjectionCheckpointForRebuild,
  requiresFreshRequestsProjectionBackfill,
  renewRequestsProjectionCheckpointLease,
  updateRequestsProjectionCheckpoint,
  toLegacyClusterTimeGeneration,
  type ProjectionBoundaryProgress,
  type ReservedProjectionBoundary,
  type RequestsProjectionGenerationMode,
  type RequestsProjectionLease,
} from "@/lib/requests-projection/checkpoint";
import {
  materializeRequestConversation,
  materializeRequestConversationPage,
  projectionChangeConversationIds,
} from "@/lib/requests-projection/materialize";
import {
  buildProjectedRealtimeOutboxInsert,
  commitProjectedBatch,
  RequestsProjectionLeaseLostError,
  selectAdvancingProjectionRows,
  type ProjectedRealtimeEvent,
  type CommitProjectedBatchResult,
  type ProjectionCommitSession,
} from "@/lib/requests-projection/projector";
import {
  isRequestProjectionChangeRelevant,
  requireRequestProjectionSourceClusterTime,
  type RequestProjectionReadStateWatermarkMode,
} from "@/lib/requests-projection/source-reader";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";
import {
  RealtimeEvent,
  REALTIME_EVENT_INDEX_DEFINITIONS,
} from "@/models/realtime-event";
import {
  REQUESTS_PROJECTION_CHECKPOINT_ID,
  RequestsProjectionCheckpoint,
} from "@/models/requests-projection-checkpoint";
import { RequestListItem } from "@/models/request-list-item";
import User from "@/models/user";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import {
  serializeCanonicalJson,
  sha256CanonicalJson,
} from "@icecore/shared/lib/canonical-json";
import {
  isRecord,
  hasExactKeys,
  isValidDate,
} from "@icecore/shared/lib/value-utils";

import type { RequestListItemPayload } from "./contract";

const PROJECTION_LEASE_MS = 60_000;
const PROJECTION_HEARTBEAT_MS = 15_000;
// A released/expired owner is noticed within five seconds; a healthy lease
// requires only a read, avoiding repeated failed findOneAndUpdate claims.
const PROJECTION_STANDBY_TAKEOVER_BUDGET_MS = 5_000;
const PROJECTION_STANDBY_MIN_POLL_MS = 1_000;
const BACKFILL_PAGE_SIZE = 100;
const DEPENDENCY_PAGE_SIZE = 200;
const CHANGE_STREAM_IDLE_READS = 3;
const requestsProjectionSourceReadFailures = new WeakSet<Error>();
const defaultRequestsProjectionMonotonicNow = () => performance.now();
const projectionLogger = createServerLogger("requests-projection");
let immediatePublications = 0;

export function publishCommittedEvents(
  events: readonly ProjectedRealtimeEvent[]
): void {
  for (const event of events) {
    // A stalled broker must not stall source processing or grow an in-memory
    // queue. Overflow and process shutdown are recovered from the same outbox.
    if (immediatePublications >= 256) break;
    immediatePublications += 1;
    void import("@/lib/realtime/server")
      .then(async ({ publishRealtimePubSubEvent }) => {
        const publication = await publishRealtimePubSubEvent(event);
        if (!publication.ok || !publication.messageId) {
          throw new Error("Requests publication was not confirmed by Pub/Sub");
        }
        // The transactional row is already durable. A replay claim that wins
        // this race retains ownership; publication failure leaves it pending.
        await markPendingV3PubSubConfirmed({
          eventId: event.eventId,
          messageId: publication.messageId,
          publishedAt: new Date(),
        });
      })
      .catch(() => {
        projectionLogger.warn("requests_projection.immediate_publish_failed", {
          recovery: "durable_outbox",
        });
      })
      .finally(() => {
        immediatePublications -= 1;
      });
  }
}

type RequestsProjectionActivationDecision = {
  listWatermarkMode: "pre_migration_legacy_list" | "strict_persisted";
  capability: "not_ready" | "ready";
};

type RequestsProjectionPhysicalEvidence = {
  collectionUuids: {
    requestListItem: string;
    checkpoint: string;
    realtimeOutbox: string;
    conversation: string;
    message: string;
    chat: string;
    user: string;
  };
  rowIndexDigest: string;
  outboxIndexDigest: string;
  imageProofs: {
    conversation: true;
    message: true;
    chat: true;
    user: true;
  };
  canaryContractVersion: 1;
  approvedCardinalityCap: 10_000_000;
};

type RequestsProjectionIndexDefinition = Readonly<{
  keys: Readonly<Record<string, 1 | -1>>;
  options: Readonly<{
    name: string;
    unique?: boolean;
    expireAfterSeconds?: number;
    partialFilterExpression?: Readonly<Record<string, unknown>>;
  }>;
}>;

function freezeValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeValue(child);
    }
  }
  return value;
}

export const REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION =
  freezeValue<RequestsProjectionIndexDefinition>({
    keys: { workspaceId: 1, _id: 1 },
    options: { name: "request_projection_workspace_id_v1" },
  });

export const REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS = freezeValue<
  readonly RequestsProjectionIndexDefinition[]
>([
  {
    keys: { workspaceId: 1, sortAt: -1, _id: -1 },
    options: {
      name: "requests_projection_serving_v2",
      partialFilterExpression: {
        deletedAt: null,
        "projection.status": "ready",
      },
    },
  },
  {
    keys: { workspaceId: 1, unreadGeneration: 1, sortAt: -1, _id: -1 },
    options: {
      name: "requests_projection_unread_v2",
      partialFilterExpression: {
        deletedAt: null,
        "projection.status": "ready",
        unreadGeneration: { $type: "long" },
      },
    },
  },
  {
    keys: { workspaceId: 1, channel: 1, sortAt: -1, _id: -1 },
    options: { name: "requests_projection_channel_v2" },
  },
  {
    keys: { workspaceId: 1, status: 1, sortAt: -1, _id: -1 },
    options: { name: "requests_projection_status_v2" },
  },
  {
    keys: { workspaceId: 1, category: 1, sortAt: -1, _id: -1 },
    options: { name: "requests_projection_category_v2" },
  },
  {
    keys: { workspaceId: 1, internalLabels: 1, sortAt: -1, _id: -1 },
    options: { name: "requests_projection_labels_v2" },
  },
  {
    keys: { workspaceId: 1, phoneDigits: 1 },
    options: {
      name: "requests_projection_phone_v2",
      partialFilterExpression: { phoneDigits: { $type: "string" } },
    },
  },
  {
    keys: { "projection.generation": -1, _id: 1 },
    options: { name: "request_projection_generation_desc_v4_seed" },
  },
  REQUESTS_PROJECTION_TARGETED_ROW_INDEX_DEFINITION,
]);

export const REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS = freezeValue<
  readonly RequestsProjectionIndexDefinition[]
>(
  REALTIME_EVENT_INDEX_DEFINITIONS.map(definition => ({
    keys: { ...definition.keys },
    options: { ...definition.options },
  }))
);

export function deriveRequestsProjectionIndexDefinitionDigest(
  definitions: readonly RequestsProjectionIndexDefinition[]
): string {
  return sha256CanonicalJson(
    definitions.map(definition => ({
      keys: Object.entries(definition.keys),
      options: definition.options,
    }))
  );
}

function isLowerHex(value: unknown, bytes: number): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)
  );
}

const PROVISION_COLLECTION_UUID_KEYS = [
  "requestListItem",
  "checkpoint",
  "realtimeOutbox",
  "conversation",
  "message",
  "chat",
  "user",
] as const;

const IMAGE_PROOF_KEYS = ["conversation", "message", "chat", "user"] as const;

function normalizeProvisionReceiptForDigest(
  value: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...value,
    completedAt: (value.completedAt as Date).toISOString(),
  };
}

export function deriveRequestsProjectionProvisionReceiptDigest(
  value: unknown
): string {
  if (!isStructurallyHealthyProvisionReceipt(value)) {
    throw new TypeError("requests_projection_provision_receipt_malformed");
  }
  return sha256CanonicalJson(normalizeProvisionReceiptForDigest(value));
}

function isStructurallyHealthyProvisionReceipt(
  value: unknown
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "contractVersion",
      "collectionUuids",
      "rowIndexDigest",
      "outboxIndexDigest",
      "imageProofs",
      "canaryContractVersion",
      "approvedCardinalityCap",
      "preflightCardinality",
      "completedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    value.contractVersion !== 1 ||
    value.canaryContractVersion !== 1 ||
    value.approvedCardinalityCap !== 10_000_000 ||
    !Number.isSafeInteger(value.preflightCardinality) ||
    (value.preflightCardinality as number) < 0 ||
    (value.preflightCardinality as number) > 10_000_000 ||
    !isLowerHex(value.rowIndexDigest, 32) ||
    !isLowerHex(value.outboxIndexDigest, 32) ||
    !isValidDate(value.completedAt) ||
    !isRecord(value.collectionUuids) ||
    !hasExactKeys(value.collectionUuids, PROVISION_COLLECTION_UUID_KEYS) ||
    !PROVISION_COLLECTION_UUID_KEYS.every(key =>
      isLowerHex((value.collectionUuids as Record<string, unknown>)[key], 16)
    ) ||
    !isRecord(value.imageProofs) ||
    !hasExactKeys(value.imageProofs, IMAGE_PROOF_KEYS) ||
    !IMAGE_PROOF_KEYS.every(
      key => (value.imageProofs as Record<string, unknown>)[key] === true
    )
  ) {
    return false;
  }
  return true;
}

function isHealthyPhysicalEvidence(
  value: unknown
): value is RequestsProjectionPhysicalEvidence {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "collectionUuids",
      "rowIndexDigest",
      "outboxIndexDigest",
      "imageProofs",
      "canaryContractVersion",
      "approvedCardinalityCap",
    ]) &&
    isRecord(value.collectionUuids) &&
    hasExactKeys(value.collectionUuids, PROVISION_COLLECTION_UUID_KEYS) &&
    PROVISION_COLLECTION_UUID_KEYS.every(key =>
      isLowerHex((value.collectionUuids as Record<string, unknown>)[key], 16)
    ) &&
    value.rowIndexDigest ===
      deriveRequestsProjectionIndexDefinitionDigest(
        REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS
      ) &&
    value.outboxIndexDigest ===
      deriveRequestsProjectionIndexDefinitionDigest(
        REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS
      ) &&
    isRecord(value.imageProofs) &&
    hasExactKeys(value.imageProofs, IMAGE_PROOF_KEYS) &&
    IMAGE_PROOF_KEYS.every(
      key => (value.imageProofs as Record<string, unknown>)[key] === true
    ) &&
    value.canaryContractVersion === 1 &&
    value.approvedCardinalityCap === 10_000_000
  );
}

function isHealthyProvisionReceipt(
  value: unknown,
  physicalEvidence: RequestsProjectionPhysicalEvidence
): value is Record<string, unknown> {
  if (!isStructurallyHealthyProvisionReceipt(value)) return false;
  return (
    serializeCanonicalJson(value.collectionUuids) ===
      serializeCanonicalJson(physicalEvidence.collectionUuids) &&
    value.rowIndexDigest === physicalEvidence.rowIndexDigest &&
    value.outboxIndexDigest === physicalEvidence.outboxIndexDigest &&
    serializeCanonicalJson(value.imageProofs) ===
      serializeCanonicalJson(physicalEvidence.imageProofs) &&
    value.canaryContractVersion === physicalEvidence.canaryContractVersion &&
    value.approvedCardinalityCap === physicalEvidence.approvedCardinalityCap
  );
}

function isHealthyMigrationReceipt(
  value: unknown,
  provisionReceipt: Record<string, unknown>,
  completedAt: Date
): boolean {
  if (!isRecord(value)) return false;
  const collectionUuids = provisionReceipt.collectionUuids as Record<
    string,
    unknown
  >;
  return (
    hasExactKeys(value, [
      "schemaVersion",
      "contractVersion",
      "collectionUuids",
      "rowIndexDigest",
      "outboxIndexDigest",
      "provisionReceiptDigest",
      "approvedCardinalityCap",
      "preflightCardinality",
      "scanned",
      "matched",
      "updated",
      "missingAfter",
      "invalidAfter",
      "verifiedAt",
      "completedAt",
    ]) &&
    value.schemaVersion === 1 &&
    value.contractVersion === 1 &&
    isRecord(value.collectionUuids) &&
    serializeCanonicalJson(value.collectionUuids) ===
      serializeCanonicalJson(collectionUuids) &&
    value.rowIndexDigest === provisionReceipt.rowIndexDigest &&
    value.outboxIndexDigest === provisionReceipt.outboxIndexDigest &&
    value.provisionReceiptDigest ===
      deriveRequestsProjectionProvisionReceiptDigest(provisionReceipt) &&
    value.approvedCardinalityCap === 10_000_000 &&
    Number.isSafeInteger(value.preflightCardinality) &&
    (value.preflightCardinality as number) >= 0 &&
    (value.preflightCardinality as number) <= 10_000_000 &&
    Number.isSafeInteger(value.scanned) &&
    (value.scanned as number) >= 0 &&
    Number.isSafeInteger(value.matched) &&
    (value.matched as number) >= 0 &&
    (value.matched as number) <= (value.scanned as number) &&
    Number.isSafeInteger(value.updated) &&
    (value.updated as number) >= 0 &&
    (value.updated as number) <= (value.matched as number) &&
    value.missingAfter === 0 &&
    value.invalidAfter === 0 &&
    isValidDate(value.verifiedAt) &&
    isValidDate(value.completedAt) &&
    value.completedAt.getTime() === completedAt.getTime()
  );
}

export function decideRequestsProjectionActivation(
  checkpoint: Record<string, unknown>,
  physicalEvidence?: RequestsProjectionPhysicalEvidence
): RequestsProjectionActivationDecision {
  const hasCompletionLatch = checkpoint.watermarkMigrationCompletedAt != null;
  const hasMigrationReceipt = checkpoint.watermarkMigrationReceipt != null;
  const hasTransitionReceipt = checkpoint.generationTransitionReceipt != null;
  if (!hasCompletionLatch && !hasMigrationReceipt && !hasTransitionReceipt) {
    return {
      listWatermarkMode: "pre_migration_legacy_list",
      capability: "not_ready",
    };
  }

  const completedAt = checkpoint.watermarkMigrationCompletedAt;
  const provisionReceipt = checkpoint.provisionReceipt;
  const ready =
    isValidDate(completedAt) &&
    isHealthyPhysicalEvidence(physicalEvidence) &&
    isHealthyProvisionReceipt(provisionReceipt, physicalEvidence) &&
    isHealthyMigrationReceipt(
      checkpoint.watermarkMigrationReceipt,
      provisionReceipt,
      completedAt
    );
  return {
    listWatermarkMode: "strict_persisted",
    capability: ready ? "ready" : "not_ready",
  };
}

type ProjectionChange = {
  _id: mongoose.mongo.Document;
  clusterTime: mongoose.mongo.Timestamp;
  operationType: string;
  ns?: { coll?: string };
  documentKey?: { _id?: unknown };
  fullDocument?: Record<string, unknown> | null;
  fullDocumentBeforeChange?: Record<string, unknown> | null;
  updateDescription?: unknown;
};

type ChangeStreamLike = {
  tryNext(): Promise<ProjectionChange | null>;
  close(): Promise<void>;
  resumeToken?: mongoose.mongo.Document | null;
};

type DriverCollection<Row extends Record<string, unknown>> = {
  bulkWrite(
    operations: Array<{
      replaceOne: {
        filter: { _id: mongoose.Types.ObjectId };
        replacement: Row;
        upsert: true;
      };
    }>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  findOne(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<Row | null>;
  find(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): {
    toArray(): Promise<Row[]>;
  };
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  deleteMany(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  distinct(field: string, filter: Record<string, unknown>): Promise<unknown[]>;
};

type OutboxCollection = {
  bulkWrite(
    operations: Record<string, unknown>[],
    options?: Record<string, unknown>
  ): Promise<unknown>;
};

function rowCollection(): DriverCollection<RequestListItemPayload> {
  return RequestListItem.collection as unknown as DriverCollection<RequestListItemPayload>;
}

function outboxCollection(): OutboxCollection {
  return RealtimeEvent.collection as unknown as OutboxCollection;
}

function validOwnerToken(value: string | undefined, prefix: string): string {
  const normalized = value?.trim();
  return normalized || `${prefix}:${randomUUID()}`;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal.reason ? String(signal.reason) : "Requests projection stopped"
  );
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function projectionFailureCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || "requests_projection_activation_failed").slice(0, 64);
}

function tagProjectionSourceReadFailure(error: unknown): Error {
  const normalized =
    error instanceof Error ? error : new Error(String(error || "unknown"));
  requestsProjectionSourceReadFailures.add(normalized);
  return normalized;
}

function isProjectionSourceReadFailure(error: unknown): boolean {
  return (
    error instanceof Error && requestsProjectionSourceReadFailures.has(error)
  );
}

function canonicalIndexValue(value: unknown): string {
  return serializeCanonicalJson(value ?? null);
}

function exactIndexMatches(
  actual: Record<string, unknown>,
  expected: RequestsProjectionIndexDefinition
): boolean {
  if (
    canonicalIndexValue(Object.entries((actual.key as object) || {})) !==
    canonicalIndexValue(Object.entries(expected.keys))
  ) {
    return false;
  }
  const actualPartial = actual.partialFilterExpression ?? null;
  const expectedPartial = expected.options.partialFilterExpression ?? null;
  return (
    canonicalIndexValue(actualPartial) ===
      canonicalIndexValue(expectedPartial) &&
    (actual.unique === true) === (expected.options.unique === true) &&
    (actual.expireAfterSeconds ?? null) ===
      (expected.options.expireAfterSeconds ?? null) &&
    actual.sparse !== true &&
    actual.hidden !== true &&
    actual.collation === undefined
  );
}

export async function verifyRequestsProjectionIndexDefinitions(input: {
  collectionName: string;
  definitions: readonly RequestsProjectionIndexDefinition[];
}): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  const indexes = (await db
    .collection(input.collectionName)
    .listIndexes()
    .toArray()) as Array<Record<string, unknown>>;
  for (const definition of input.definitions) {
    const actual = indexes.find(
      index => index.name === definition.options.name
    );
    if (!actual || !exactIndexMatches(actual, definition)) {
      throw new Error(
        `requests_projection_index_mismatch_${definition.options.name}`
      );
    }
  }
}

async function readCollectionMetadata(collectionNames: string[]) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  const metadata = await db
    .listCollections({ name: { $in: collectionNames } }, { nameOnly: false })
    .toArray();
  return new Map(metadata.map(collection => [collection.name, collection]));
}

/** Hex of a BSON subtype-4, 16-byte collection UUID; null for anything else. */
export function collectionUuidHex(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    sub_type?: unknown;
    subtype?: unknown;
    buffer?: unknown;
  };
  const subtype = candidate.sub_type ?? candidate.subtype;
  const bytes = candidate.buffer;
  if (
    subtype !== 4 ||
    !(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) ||
    bytes.byteLength !== 16
  ) {
    return null;
  }
  return Buffer.from(bytes).toString("hex");
}

function parsePhysicalCollectionUuid(value: unknown): string {
  const uuid = collectionUuidHex(value);
  if (!uuid) throw new Error("requests_projection_collection_uuid_invalid");
  return uuid;
}

function requirePhysicalCollectionUuid(
  collectionName: string,
  metadata: mongoose.mongo.CollectionInfo | undefined,
  requiresSourceImages: boolean
): string {
  if (!metadata) {
    throw new Error(`requests_projection_collection_missing_${collectionName}`);
  }
  if (
    requiresSourceImages &&
    metadata.options?.changeStreamPreAndPostImages?.enabled !== true
  ) {
    throw new Error(
      `requests_projection_source_image_missing_${collectionName}`
    );
  }
  return parsePhysicalCollectionUuid(metadata.info?.uuid);
}

export async function ensureRequestsProjectionInfrastructure(): Promise<RequestsProjectionPhysicalEvidence> {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  const hello = (await db.admin().command({ hello: 1 })) as {
    setName?: unknown;
  };
  if (!hello.setName) {
    throw new Error("requests_projection_requires_replica_set");
  }

  const rowCollectionName = RequestListItem.collection.collectionName;
  const checkpointCollectionName =
    RequestsProjectionCheckpoint.collection.collectionName;
  const outboxCollectionName = RealtimeEvent.collection.collectionName;
  const sourceCollectionNames = [
    Conversation.collection.collectionName,
    Message.collection.collectionName,
    Chat.collection.collectionName,
    User.collection.collectionName,
  ];
  const collectionEntries = [
    ["requestListItem", rowCollectionName],
    ["checkpoint", checkpointCollectionName],
    ["realtimeOutbox", outboxCollectionName],
    ["conversation", Conversation.collection.collectionName],
    ["message", Message.collection.collectionName],
    ["chat", Chat.collection.collectionName],
    ["user", User.collection.collectionName],
  ] as const;
  const collectionUuids =
    {} as RequestsProjectionPhysicalEvidence["collectionUuids"];
  const collectionNames = collectionEntries.map(([, name]) => name);
  const initialMetadata = await readCollectionMetadata(collectionNames);
  for (const [key, collectionName] of collectionEntries) {
    collectionUuids[key] = requirePhysicalCollectionUuid(
      collectionName,
      initialMetadata.get(collectionName),
      sourceCollectionNames.includes(collectionName)
    );
  }

  const [, , checkpoint] = await Promise.all([
    verifyRequestsProjectionIndexDefinitions({
      collectionName: rowCollectionName,
      definitions: REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS,
    }),
    verifyRequestsProjectionIndexDefinitions({
      collectionName: outboxCollectionName,
      definitions: REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS,
    }),
    db
      .collection<{
        _id: string;
        [key: string]: unknown;
      }>(checkpointCollectionName)
      .findOne(
        { _id: REQUESTS_PROJECTION_CHECKPOINT_ID },
        { projection: { _id: 1 } }
      ),
  ]);
  if (!checkpoint) {
    throw new Error("requests_projection_checkpoint_singleton_missing");
  }
  const currentMetadata = await readCollectionMetadata(collectionNames);
  for (const [key, collectionName] of collectionEntries) {
    const currentUuid = requirePhysicalCollectionUuid(
      collectionName,
      currentMetadata.get(collectionName),
      sourceCollectionNames.includes(collectionName)
    );
    if (currentUuid !== collectionUuids[key]) {
      throw new Error(
        `requests_projection_collection_uuid_drift_${collectionName}`
      );
    }
  }
  return {
    collectionUuids,
    rowIndexDigest: deriveRequestsProjectionIndexDefinitionDigest(
      REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS
    ),
    outboxIndexDigest: deriveRequestsProjectionIndexDefinitionDigest(
      REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS
    ),
    imageProofs: {
      conversation: true,
      message: true,
      chat: true,
      user: true,
    },
    canaryContractVersion: 1,
    approvedCardinalityCap: 10_000_000,
  };
}

export async function readRequestsProjectionActivationDecision(): Promise<RequestsProjectionActivationDecision> {
  const physicalEvidence = await ensureRequestsProjectionInfrastructure();
  const checkpoint = await readRequestsProjectionCheckpoint();
  if (!checkpoint) {
    throw new Error("requests_projection_checkpoint_singleton_missing");
  }
  return decideRequestsProjectionActivation(checkpoint, physicalEvidence);
}

async function readStreamBoundary(): Promise<mongoose.mongo.Timestamp> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  const hello = (await db.admin().command({ hello: 1 })) as {
    operationTime?: mongoose.mongo.Timestamp;
  };
  return requireRequestProjectionSourceClusterTime(hello.operationTime);
}

async function openProductionChangeStream(input: {
  resumeToken?: mongoose.mongo.Document | null;
  startAtOperationTime?: mongoose.mongo.Timestamp | null;
}): Promise<ChangeStreamLike> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  const collections = [
    Conversation.collection.collectionName,
    Message.collection.collectionName,
    Chat.collection.collectionName,
    User.collection.collectionName,
  ];
  return db.watch(
    [
      {
        $match: {
          operationType: { $in: ["insert", "update", "replace", "delete"] },
          "ns.coll": { $in: collections },
        },
      },
    ],
    {
      ...(input.resumeToken
        ? { resumeAfter: input.resumeToken }
        : input.startAtOperationTime
          ? { startAtOperationTime: input.startAtOperationTime }
          : {}),
      fullDocument: "updateLookup",
      fullDocumentBeforeChange: "required",
      maxAwaitTimeMS: 1_000,
      showExpandedEvents: true,
    }
  ) as unknown as ChangeStreamLike;
}

async function replaceRows(input: {
  rows: RequestListItemPayload[];
  session: ProjectionCommitSession;
  generationMode: RequestsProjectionGenerationMode;
}): Promise<RequestListItemPayload[]> {
  if (input.rows.length === 0) return [];
  const existing =
    input.generationMode === "sequence_v2"
      ? await rowCollection()
          .find(
            { _id: { $in: input.rows.map(row => row._id) } },
            {
              projection: { _id: 1, "projection.generation": 1 },
              promoteLongs: false,
              session: input.session,
            }
          )
          .toArray()
      : [];
  const rows = selectAdvancingProjectionRows(
    input.rows,
    existing,
    input.generationMode
  );
  if (rows.length === 0) return [];
  await rowCollection().bulkWrite(
    rows.map(row => ({
      replaceOne: {
        filter: { _id: row._id },
        replacement: row,
        upsert: true,
      },
    })),
    { ordered: false, session: input.session }
  );
  return rows;
}

async function enqueueEvents(input: {
  events: ProjectedRealtimeEvent[];
  session: ProjectionCommitSession;
}): Promise<void> {
  if (input.events.length === 0) return;
  await outboxCollection().bulkWrite(
    input.events.map(event => ({
      updateOne: {
        filter: { eventId: event.eventId },
        update: { $setOnInsert: buildProjectedRealtimeOutboxInsert(event) },
        upsert: true,
      },
    })),
    { ordered: false, session: input.session }
  );
}

function projectionCommitDependencies() {
  return {
    startSession: () => mongoose.startSession(),
    replaceRows,
    enqueue: enqueueEvents,
    publishCommittedEvents,
    assertBoundary: ({
      lease,
      boundary,
      session,
      now,
    }: {
      lease: RequestsProjectionLease;
      boundary: ReservedProjectionBoundary;
      session: ProjectionCommitSession;
      now: Date;
    }) =>
      assertReservedProjectionBoundary({
        lease,
        boundary,
        session: session as mongoose.ClientSession,
        now,
      }),
    finalizeBoundary: ({
      lease,
      boundary,
      progress,
      projectedCountIncrement,
      session,
      now,
    }: {
      lease: RequestsProjectionLease;
      boundary: ReservedProjectionBoundary;
      progress: ProjectionBoundaryProgress;
      projectedCountIncrement: number;
      session: ProjectionCommitSession;
      now: Date;
    }) =>
      finalizeProjectionBoundary({
        lease,
        boundary,
        progress,
        projectedCountIncrement,
        session: session as mongoose.ClientSession,
        now,
      }),
  };
}

async function commitRowsOnly(input: {
  lease: RequestsProjectionLease;
  rows: RequestListItemPayload[];
  boundary: ReservedProjectionBoundary;
  realtimeEnabled: boolean;
}): Promise<CommitProjectedBatchResult> {
  return commitProjectedBatch(
    {
      lease: input.lease,
      rows: input.rows,
      boundary: input.boundary,
      progress: null,
      realtimeEnabled: input.realtimeEnabled,
    },
    projectionCommitDependencies()
  );
}

async function commitChangeBoundary(input: {
  lease: RequestsProjectionLease;
  rows: RequestListItemPayload[];
  boundary: ReservedProjectionBoundary;
  change: ProjectionChange;
  realtimeEnabled: boolean;
}): Promise<CommitProjectedBatchResult> {
  return commitProjectedBatch(
    {
      lease: input.lease,
      rows: input.rows,
      boundary: input.boundary,
      progress: {
        kind: "change_stream_v1",
        resumeToken: input.change._id,
        clusterTime: input.change.clusterTime,
      },
      realtimeEnabled: input.realtimeEnabled,
    },
    projectionCommitDependencies()
  );
}

type ConversationReference = {
  conversationId: mongoose.Types.ObjectId;
  workspaceId?: string;
};

function requestProjectionReadStateWatermarkMode(
  change: ProjectionChange
): RequestProjectionReadStateWatermarkMode {
  if (change.ns?.coll !== Conversation.collection.collectionName) {
    return "preserve";
  }
  if (change.operationType === "insert") return "advance_if_changed";
  if (change.operationType === "replace") {
    if (
      !isRecord(change.fullDocument) ||
      !isRecord(change.fullDocumentBeforeChange)
    ) {
      return "preserve";
    }
    return (change.fullDocument.is_read_by_manager === true) !==
      (change.fullDocumentBeforeChange.is_read_by_manager === true)
      ? "advance_if_changed"
      : "preserve";
  }
  if (change.operationType !== "update") return "preserve";

  const description = isRecord(change.updateDescription)
    ? change.updateDescription
    : null;
  if (!description) return "preserve";
  const updatedFields = isRecord(description.updatedFields)
    ? description.updatedFields
    : null;
  const removedFields = Array.isArray(description.removedFields)
    ? description.removedFields
    : null;
  return (updatedFields &&
    Object.prototype.hasOwnProperty.call(
      updatedFields,
      "is_read_by_manager"
    )) ||
    removedFields?.includes("is_read_by_manager")
    ? "advance_if_changed"
    : "preserve";
}

async function* relatedConversationBatches(
  change: ProjectionChange,
  sourceClusterTime: mongoose.mongo.Timestamp
): AsyncGenerator<{ references: ConversationReference[]; final: boolean }> {
  const direct = projectionChangeConversationIds({
    change: change as unknown as Record<string, unknown>,
    conversationCollection: Conversation.collection.collectionName,
    messageCollection: Message.collection.collectionName,
  });
  if (direct.length > 0) {
    yield { references: direct, final: true };
    return;
  }

  const collection = String(change.ns?.coll || "");
  const document = change.fullDocument || change.fullDocumentBeforeChange || {};
  const dependencyId = document._id || change.documentKey?._id;
  const field =
    collection === Chat.collection.collectionName
      ? "chat"
      : collection === User.collection.collectionName
        ? "user"
        : null;
  if (!field || dependencyId === undefined || dependencyId === null) {
    yield { references: [], final: true };
    return;
  }

  let afterId: mongoose.Types.ObjectId | null = null;
  while (true) {
    const filter: Record<string, unknown> = { [field]: dependencyId };
    if (afterId) filter._id = { $gt: afterId };
    let rows: Array<{
      _id: mongoose.Types.ObjectId;
      workspaceId: string;
    }>;
    try {
      const session = await mongoose.startSession({ causalConsistency: true });
      try {
        session.advanceOperationTime(sourceClusterTime);
        rows = await Conversation.find(filter)
          .select("_id workspaceId")
          .sort({ _id: 1 })
          .limit(DEPENDENCY_PAGE_SIZE + 1)
          .session(session)
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
        await session.endSession();
      }
    } catch (error) {
      throw tagProjectionSourceReadFailure(error);
    }
    const page = rows.slice(0, DEPENDENCY_PAGE_SIZE);
    const hasMore = rows.length > DEPENDENCY_PAGE_SIZE;
    yield {
      references: page.map(row => ({
        conversationId: row._id,
        workspaceId: row.workspaceId,
      })),
      final: !hasMore,
    };
    if (!hasMore) return;
    afterId = page.at(-1)?._id || null;
    if (!afterId) return;
  }
}

async function materializeReferences(input: {
  references: ConversationReference[];
  generation: mongoose.mongo.Long;
  lease: RequestsProjectionLease;
  sourceClusterTime: mongoose.mongo.Timestamp;
  readStateWatermarkMode: RequestProjectionReadStateWatermarkMode;
  signal: AbortSignal;
}): Promise<RequestListItemPayload[]> {
  const output: RequestListItemPayload[] = [];
  for (let offset = 0; offset < input.references.length; offset += 8) {
    assertNotAborted(input.signal);
    const results = await Promise.allSettled(
      input.references.slice(offset, offset + 8).map(reference =>
        materializeRequestConversation({
          conversationId: reference.conversationId,
          workspaceId: reference.workspaceId,
          generation: input.generation,
          fence: input.lease.fence,
          sourceClusterTime: input.sourceClusterTime,
          readStateWatermarkMode: input.readStateWatermarkMode,
        })
      )
    );
    for (const result of results) {
      if (result.status === "rejected") {
        throw tagProjectionSourceReadFailure(result.reason);
      }
      if (result.value) {
        output.push(result.value.row as RequestListItemPayload);
      }
    }
  }
  return output;
}

async function processProjectionChange(input: {
  change: ProjectionChange;
  lease: RequestsProjectionLease;
  signal: AbortSignal;
  realtimeEnabled: boolean;
}): Promise<RequestsProjectionLease> {
  const sourceClusterTime = requireRequestProjectionSourceClusterTime(
    input.change.clusterTime
  );
  const boundary = await reserveProjectionBoundary({
    lease: input.lease,
    resumeTokenDigest: deriveProjectionResumeTokenDigest(input.change._id),
    sourceClusterTime,
    legacyGeneration: toLegacyClusterTimeGeneration(sourceClusterTime),
  });
  if (
    !isRequestProjectionChangeRelevant({
      change: input.change as unknown as Record<string, unknown>,
      conversationCollection: Conversation.collection.collectionName,
      messageCollection: Message.collection.collectionName,
      chatCollection: Chat.collection.collectionName,
      userCollection: User.collection.collectionName,
    })
  ) {
    const committed = await commitChangeBoundary({
      lease: input.lease,
      rows: [],
      boundary,
      change: input.change,
      realtimeEnabled: input.realtimeEnabled,
    });
    return committed.lease;
  }

  const readStateWatermarkMode = requestProjectionReadStateWatermarkMode(
    input.change
  );
  for await (const batch of relatedConversationBatches(
    input.change,
    sourceClusterTime
  )) {
    const rows = await materializeReferences({
      references: batch.references,
      generation: boundary.generation,
      lease: input.lease,
      sourceClusterTime,
      readStateWatermarkMode,
      signal: input.signal,
    });
    if (batch.final) {
      const committed = await commitChangeBoundary({
        lease: input.lease,
        rows,
        boundary,
        change: input.change,
        realtimeEnabled: input.realtimeEnabled,
      });
      return committed.lease;
    }
    await commitRowsOnly({
      lease: input.lease,
      rows,
      boundary,
      realtimeEnabled: input.realtimeEnabled,
    });
  }
  const committed = await commitChangeBoundary({
    lease: input.lease,
    rows: [],
    boundary,
    change: input.change,
    realtimeEnabled: input.realtimeEnabled,
  });
  return committed.lease;
}

async function processProjectionChanges(input: {
  changes: ProjectionChange[];
  generationMode: RequestsProjectionGenerationMode;
  lease: RequestsProjectionLease;
  signal: AbortSignal;
  realtimeEnabled: boolean;
}): Promise<void> {
  // sequence_v2 reserves one exact replay boundary durably. Keep that contract
  // until its batch identity is explicitly supported; legacy generations come
  // from cluster time and can commit a bounded contiguous prefix atomically.
  if (input.generationMode !== "cluster_time_v1") {
    for (const change of input.changes) {
      await processProjectionChange({ ...input, change });
    }
    return;
  }
  let last: ProjectionChange | null = null;
  let count = 0;
  const references = new Map<string, ConversationReference>();
  const flush = async () => {
    if (!last) return;
    const change = last;
    if (count === 1) {
      await processProjectionChange({ ...input, change });
    } else {
      const sourceClusterTime = requireRequestProjectionSourceClusterTime(
        change.clusterTime
      );
      const boundary = await reserveProjectionBoundary({
        lease: input.lease,
        resumeTokenDigest: deriveProjectionResumeTokenDigest(change._id),
        sourceClusterTime,
        legacyGeneration: toLegacyClusterTimeGeneration(sourceClusterTime),
      });
      const rows = await materializeReferences({
        ...input,
        references: [...references.values()],
        generation: boundary.generation,
        sourceClusterTime,
        readStateWatermarkMode: "preserve",
      });
      await commitChangeBoundary({ ...input, change, boundary, rows });
    }
    references.clear();
    last = null;
    count = 0;
  };
  for (const change of input.changes) {
    assertNotAborted(input.signal);
    const relevant = isRequestProjectionChangeRelevant({
      change: change as unknown as Record<string, unknown>,
      conversationCollection: Conversation.collection.collectionName,
      messageCollection: Message.collection.collectionName,
      chatCollection: Chat.collection.collectionName,
      userCollection: User.collection.collectionName,
    });
    const direct = relevant
      ? projectionChangeConversationIds({
          change: change as unknown as Record<string, unknown>,
          conversationCollection: Conversation.collection.collectionName,
          messageCollection: Message.collection.collectionName,
        })
      : [];
    if (
      relevant &&
      (direct.length === 0 ||
        requestProjectionReadStateWatermarkMode(change) !== "preserve")
    ) {
      // Dependency fan-out and manager read receipts retain their own source
      // boundary. Never advance a receipt to the end of an unrelated batch.
      await flush();
      await processProjectionChange({ ...input, change });
      continue;
    }
    for (const reference of direct)
      references.set(reference.conversationId.toHexString(), reference);
    last = change;
    count += 1;
  }
  await flush();
}

async function resetProjectionForFreshBackfill(input: {
  lease: RequestsProjectionLease;
  expectedBoundary: ReservedProjectionBoundary | null;
}): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await rowCollection().deleteMany({}, { session });
      await resetRequestsProjectionCheckpointForRebuild({
        lease: input.lease,
        expectedBoundary: input.expectedBoundary,
        session,
      });
    });
  } finally {
    await session.endSession();
  }
}

async function commitBackfillPage(input: {
  lease: RequestsProjectionLease;
  rows: RequestListItemPayload[];
  boundary: ReservedProjectionBoundary;
  afterId: mongoose.Types.ObjectId | null;
}): Promise<CommitProjectedBatchResult> {
  return commitProjectedBatch(
    {
      lease: input.lease,
      rows: input.rows,
      boundary: input.boundary,
      progress: {
        kind: "backfill_page_v1",
        backfillAfterId: input.afterId,
      },
      realtimeEnabled: false,
    },
    projectionCommitDependencies()
  );
}

async function runBackfill(input: {
  signal: AbortSignal;
  readLease(): RequestsProjectionLease;
  sourceClusterTime: mongoose.mongo.Timestamp;
}): Promise<void> {
  const sourceClusterTime = requireRequestProjectionSourceClusterTime(
    input.sourceClusterTime
  );
  const checkpoint = await readRequestsProjectionCheckpoint();
  let afterId = checkpoint?.backfillAfterId || null;
  while (true) {
    assertNotAborted(input.signal);
    const lease = input.readLease();
    const pageStart = afterId;
    const boundary = await reserveProjectionBoundary({
      lease,
      resumeTokenDigest: deriveProjectionBackfillBoundaryDigest({
        sourceClusterTime,
        backfillAfterId: pageStart,
      }),
      sourceClusterTime,
      legacyGeneration: mongoose.mongo.Long.fromNumber(Date.now()),
    });
    let page: Awaited<ReturnType<typeof materializeRequestConversationPage>>;
    try {
      page = await materializeRequestConversationPage({
        afterId: pageStart,
        limit: BACKFILL_PAGE_SIZE,
        generation: boundary.generation,
        fence: lease.fence,
        sourceClusterTime,
        signal: input.signal,
      });
    } catch (error) {
      throw tagProjectionSourceReadFailure(error);
    }
    await commitBackfillPage({
      lease,
      rows: page.rows,
      boundary,
      afterId: page.lastId,
    });
    afterId = page.lastId;
    if (!page.hasMore) break;
  }
  await updateRequestsProjectionCheckpoint({
    lease: input.readLease(),
    state: "catching_up",
  });
}

async function drainChangeStream(input: {
  stream: ChangeStreamLike;
  initialChange: ProjectionChange | null;
  signal: AbortSignal;
  readLease(): RequestsProjectionLease;
  realtimeEnabled: boolean;
}): Promise<void> {
  let pending = input.initialChange;
  let idleReads = 0;
  while (idleReads < CHANGE_STREAM_IDLE_READS) {
    assertNotAborted(input.signal);
    const change = pending || (await input.stream.tryNext());
    pending = null;
    if (!change) {
      idleReads += 1;
      continue;
    }
    idleReads = 0;
    await processProjectionChange({
      change,
      lease: input.readLease(),
      signal: input.signal,
      realtimeEnabled: input.realtimeEnabled,
    });
  }
  if (input.stream.resumeToken) {
    await advanceIdleProjectionResumeToken({
      lease: input.readLease(),
      resumeToken: input.stream.resumeToken,
      now: new Date(),
    });
  }
}

async function verifyRequestsProjectionParity(): Promise<boolean> {
  const rows = rowCollection();
  const [sourceCount, projectionCount, staleCount] = await Promise.all([
    Conversation.countDocuments({}),
    rows.countDocuments({
      deletedAt: null,
      "projection.status": "ready",
    }),
    rows.countDocuments({
      deletedAt: null,
      "projection.status": { $ne: "ready" },
    }),
  ]);
  if (sourceCount !== projectionCount || staleCount !== 0) return false;

  const sample = await Conversation.find({})
    .select("_id workspaceId")
    .sort({ _id: 1 })
    .limit(100)
    .lean<
      Array<{
        _id: mongoose.Types.ObjectId;
        workspaceId: string;
      }>
    >()
    .exec();
  const sampleIds: mongoose.Types.ObjectId[] = sample.map(row => row._id);
  const projected = await rows
    .find(
      { _id: { $in: sampleIds } },
      { projection: { workspaceId: 1 }, promoteLongs: false }
    )
    .toArray();
  const byId = new Map(projected.map(row => [row._id.toHexString(), row]));
  return sample.every(
    row => byId.get(row._id.toHexString())?.workspaceId === row.workspaceId
  );
}

type ActiveProjectionOwner = {
  lease: RequestsProjectionLease;
  generationMode: RequestsProjectionGenerationMode;
  stream: ChangeStreamLike;
  stopHeartbeat(): Promise<void>;
  readLease(): RequestsProjectionLease;
};

function standbyRetryDelayMs(
  checkpoint: Awaited<ReturnType<typeof readRequestsProjectionCheckpoint>>
): number {
  const expiresAt = checkpoint?.lease?.expiresAt?.getTime();
  return expiresAt && Number.isFinite(expiresAt)
    ? Math.max(
        PROJECTION_STANDBY_MIN_POLL_MS,
        Math.min(PROJECTION_STANDBY_TAKEOVER_BUDGET_MS, expiresAt - Date.now())
      )
    : PROJECTION_STANDBY_TAKEOVER_BUDGET_MS;
}

async function waitForStandbyRetry(
  signal: AbortSignal,
  delayMs = PROJECTION_STANDBY_TAKEOVER_BUDGET_MS
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function claimLeaseUntilOwnedOrReady(input: {
  ownerToken: string;
  signal: AbortSignal;
}): Promise<RequestsProjectionLease | null> {
  while (!input.signal.aborted) {
    const lease = await claimRequestsProjectionCheckpointLease({
      ownerToken: input.ownerToken,
      leaseMs: PROJECTION_LEASE_MS,
    });
    if (lease) return lease;
    const checkpoint = await readRequestsProjectionCheckpoint();
    if (checkpoint?.state === "ready") return null;
    await waitForStandbyRetry(input.signal, standbyRetryDelayMs(checkpoint));
  }
  throw abortError(input.signal);
}

async function claimLeaseUntilAvailable(input: {
  ownerToken: string;
  signal: AbortSignal;
}): Promise<RequestsProjectionLease> {
  const deadline = Date.now() + PROJECTION_LEASE_MS;
  while (!input.signal.aborted && Date.now() < deadline) {
    const lease = await claimRequestsProjectionCheckpointLease({
      ownerToken: input.ownerToken,
      leaseMs: PROJECTION_LEASE_MS,
    });
    if (lease) return lease;
    await waitForStandbyRetry(
      input.signal,
      Math.min(
        standbyRetryDelayMs(await readRequestsProjectionCheckpoint()),
        Math.max(0, deadline - Date.now())
      )
    );
  }
  if (input.signal.aborted) throw abortError(input.signal);
  throw new Error("requests_projection_lease_unavailable");
}

function startLeaseHeartbeat(initialLease: RequestsProjectionLease): {
  heartbeat: ReturnType<typeof setInterval>;
  stop(): Promise<void>;
  read(): RequestsProjectionLease;
} {
  let lease = initialLease;
  let failure: unknown = null;
  let inFlight: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (inFlight || failure) return;
    inFlight = renewRequestsProjectionCheckpointLease({
      lease,
      leaseMs: PROJECTION_LEASE_MS,
    })
      .then(next => {
        if (!next) throw new RequestsProjectionLeaseLostError();
        lease = next;
      })
      .catch(error => {
        failure = error;
      })
      .finally(() => {
        inFlight = null;
      });
  }, PROJECTION_HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    heartbeat,
    async stop() {
      clearInterval(heartbeat);
      await inFlight;
    },
    read() {
      if (failure) throw failure;
      return lease;
    },
  };
}

async function activateAndKeepOwnership(input: {
  ownerToken: string;
  signal: AbortSignal;
  realtimeEnabled: boolean;
  initialLease?: RequestsProjectionLease;
  allowStandby?: boolean;
}): Promise<ActiveProjectionOwner | null> {
  const lease =
    input.initialLease ||
    (await (input.allowStandby
      ? claimLeaseUntilOwnedOrReady({
          ownerToken: input.ownerToken,
          signal: input.signal,
        })
      : claimLeaseUntilAvailable({
          ownerToken: input.ownerToken,
          signal: input.signal,
        })));
  if (!lease) return null;
  const heartbeat = startLeaseHeartbeat(lease);
  let stream: ChangeStreamLike | null = null;
  try {
    let checkpoint = await readRequestsProjectionCheckpoint();
    if (requiresFreshRequestsProjectionBackfill(checkpoint)) {
      await resetProjectionForFreshBackfill({
        lease: heartbeat.read(),
        expectedBoundary: checkpoint?.inFlightBoundary || null,
      });
      checkpoint = await readRequestsProjectionCheckpoint();
    }
    let boundary = checkpoint?.clusterTime
      ? requireRequestProjectionSourceClusterTime(checkpoint.clusterTime)
      : null;
    if (!checkpoint?.resumeToken && !boundary) {
      boundary = await readStreamBoundary();
      // Persist the stream boundary before opening the stream or touching the
      // backfill cursor. A crash can therefore restart from the exact oplog
      // point that preceded the first projected row.
      await updateRequestsProjectionCheckpoint({
        lease: heartbeat.read(),
        clusterTime: boundary,
        error: null,
      });
    }
    stream = await openProductionChangeStream({
      resumeToken: checkpoint?.resumeToken,
      startAtOperationTime: checkpoint?.resumeToken ? null : boundary,
    });
    const initialChange = await stream.tryNext();

    if (checkpoint?.state !== "ready") {
      const backfillBoundary =
        requireRequestProjectionSourceClusterTime(boundary);
      if (checkpoint?.state !== "catching_up") {
        await updateRequestsProjectionCheckpoint({
          lease: heartbeat.read(),
          state: "backfilling",
          clusterTime: backfillBoundary,
          error: null,
        });
        await runBackfill({
          signal: input.signal,
          readLease: heartbeat.read,
          sourceClusterTime: backfillBoundary,
        });
      }
      await drainChangeStream({
        stream,
        initialChange,
        signal: input.signal,
        readLease: heartbeat.read,
        realtimeEnabled: input.realtimeEnabled,
      });
      if (!(await verifyRequestsProjectionParity())) {
        throw new Error("requests_projection_verification_failed");
      }
      await updateRequestsProjectionCheckpoint({
        lease: heartbeat.read(),
        state: "ready",
        backfillAfterId: null,
        activatedAt: new Date(),
        error: null,
      });
    } else if (initialChange) {
      await processProjectionChange({
        change: initialChange,
        lease: heartbeat.read(),
        signal: input.signal,
        realtimeEnabled: input.realtimeEnabled,
      });
    }

    return {
      lease: heartbeat.read(),
      generationMode: checkpoint?.generationMode || "cluster_time_v1",
      stream,
      stopHeartbeat: heartbeat.stop,
      readLease: heartbeat.read,
    };
  } catch (error) {
    if (!isProjectionSourceReadFailure(error)) {
      try {
        await updateRequestsProjectionCheckpoint({
          lease: heartbeat.read(),
          state: "failed",
          error: {
            code: projectionFailureCode(error),
            message: "Requests projection activation failed",
          },
        });
      } catch {
        // A lost lease is already a stronger failure signal; never overwrite
        // the checkpoint from a stale owner.
      }
    }
    await stream?.close().catch(() => undefined);
    await heartbeat.stop();
    await releaseRequestsProjectionCheckpointLease({ lease }).catch(
      () => false
    );
    throw error;
  }
}

export async function runProductionRequestsProjectionActivation(
  input: {
    ownerToken?: string;
    signal?: AbortSignal;
  } = {}
): Promise<{ status: "ready" }> {
  const controller = new AbortController();
  const signal = input.signal || controller.signal;
  await ensureRequestsProjectionInfrastructure();
  const checkpoint = await readRequestsProjectionCheckpoint();
  if (checkpoint?.state === "ready") return { status: "ready" };
  const owner = await activateAndKeepOwnership({
    ownerToken: validOwnerToken(input.ownerToken, "deploy"),
    signal,
    realtimeEnabled: false,
  });
  if (!owner) return { status: "ready" };
  await owner.stream.close();
  await owner.stopHeartbeat();
  await releaseRequestsProjectionCheckpointLease({
    lease: owner.lease,
  });
  return { status: "ready" };
}

function startActiveProjectionRuntime(input: {
  owner: ActiveProjectionOwner;
  signal: AbortSignal;
  realtimeEnabled: boolean;
  monotonicNow: () => number;
  onFatal?(error: Error): void;
}): () => Promise<void> {
  let stopped = false;
  let fatal: Error | null = null;
  const reader = createProjectionChangeBatchReader(input.owner.stream);
  const loop = (async () => {
    try {
      while (!stopped && !input.signal.aborted) {
        // Surface heartbeat/lease loss even when the change stream is idle.
        input.owner.readLease();
        const changes = await reader.next();
        if (stopped || input.signal.aborted) break;
        if (changes.length === 0) continue;
        const startedAt = input.monotonicNow();
        await processProjectionChanges({
          changes,
          generationMode: input.owner.generationMode,
          lease: input.owner.readLease(),
          signal: input.signal,
          realtimeEnabled: input.realtimeEnabled,
        });
        projectionLogger.info("requests_projection.batch_completed", {
          sourceChanges: changes.length,
          generationMode: input.owner.generationMode,
          durationMs: input.monotonicNow() - startedAt,
          sourceLagMs: Math.max(
            0,
            Date.now() -
              requireRequestProjectionSourceClusterTime(
                changes[changes.length - 1].clusterTime
              ).getHighBitsUnsigned() *
                1000
          ),
        });
      }
    } catch (error) {
      if (!stopped && !input.signal.aborted) {
        fatal = error instanceof Error ? error : new Error(String(error));
        input.onFatal?.(fatal);
      }
    }
  })();

  return async () => {
    if (stopped) return;
    stopped = true;
    await input.owner.stream.close().catch(() => undefined);
    await loop;
    await input.owner.stopHeartbeat();
    await releaseRequestsProjectionCheckpointLease({
      lease: input.owner.lease,
    }).catch(() => false);
    if (fatal) throw fatal;
  };
}

function startStandbyProjectionRuntime(input: {
  ownerToken: string;
  signal: AbortSignal;
  realtimeEnabled: boolean;
  monotonicNow: () => number;
  onFatal?(error: Error): void;
}): () => Promise<void> {
  let stopped = false;
  let fatal: Error | null = null;
  let activeStop: (() => Promise<void>) | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextDelayMs = PROJECTION_STANDBY_TAKEOVER_BUDGET_MS;

  const schedule = () => {
    if (stopped || input.signal.aborted || fatal || activeStop) return;
    timer = setTimeout(poll, nextDelayMs);
    timer.unref?.();
  };

  const poll = () => {
    timer = null;
    if (stopped || input.signal.aborted || fatal || inFlight || activeStop) {
      return;
    }
    inFlight = (async () => {
      const checkpoint = await readRequestsProjectionCheckpoint();
      nextDelayMs = standbyRetryDelayMs(checkpoint);
      if (
        checkpoint?.lease &&
        checkpoint.lease.expiresAt.getTime() > Date.now()
      )
        return;
      const lease = await claimRequestsProjectionCheckpointLease({
        ownerToken: input.ownerToken,
        leaseMs: PROJECTION_LEASE_MS,
      });
      if (!lease) return;
      const owner = await activateAndKeepOwnership({
        ...input,
        initialLease: lease,
      });
      if (!owner) return;
      activeStop = startActiveProjectionRuntime({ ...input, owner });
      if (stopped || input.signal.aborted) {
        await activeStop();
        activeStop = null;
      }
    })()
      .catch(error => {
        if (!stopped && !input.signal.aborted && !fatal) {
          fatal = error instanceof Error ? error : new Error(String(error));
          input.onFatal?.(fatal);
        }
      })
      .finally(() => {
        inFlight = null;
        schedule();
      });
  };

  schedule();

  return async () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    await inFlight;
    await activeStop?.();
    if (fatal) throw fatal;
  };
}

export async function startProductionRequestsProjectionRuntime(input: {
  signal: AbortSignal;
  ownerToken?: string;
  realtimeEnabled?: boolean;
  monotonicNow?: () => number;
  onFatal?(error: Error): void;
}): Promise<() => Promise<void>> {
  await ensureRequestsProjectionInfrastructure();
  const ownerToken = validOwnerToken(input.ownerToken, "runtime");
  const realtimeEnabled = input.realtimeEnabled !== false;
  const monotonicNow =
    input.monotonicNow || defaultRequestsProjectionMonotonicNow;
  const owner = await activateAndKeepOwnership({
    ownerToken,
    signal: input.signal,
    realtimeEnabled,
    allowStandby: true,
  });
  const runtimeInput = {
    ownerToken,
    signal: input.signal,
    realtimeEnabled,
    monotonicNow,
    onFatal: input.onFatal,
  };
  return owner
    ? startActiveProjectionRuntime({ ...runtimeInput, owner })
    : startStandbyProjectionRuntime(runtimeInput);
}

export { REQUESTS_PROJECTION_CHECKPOINT_ID };
