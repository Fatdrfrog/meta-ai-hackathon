import connectDB from "@/lib/mongoose";
import {
  REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS,
  REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS,
  collectionUuidHex,
  decideRequestsProjectionActivation,
  deriveRequestsProjectionIndexDefinitionDigest,
  deriveRequestsProjectionProvisionReceiptDigest,
  ensureRequestsProjectionInfrastructure,
  verifyRequestsProjectionIndexDefinitions,
} from "@/lib/requests-projection/activation";
import {
  claimRequestsProjectionCheckpointLease,
  ensureRequestsProjectionCheckpoint,
  releaseRequestsProjectionCheckpointLease,
  selectRequestsSequenceTransitionSeed,
} from "@/lib/requests-projection/checkpoint";
import Chat from "@/models/chat";
import {
  Conversation,
  CONVERSATION_REQUESTS_DEPENDENCY_INDEXES,
} from "@/models/conversation";
import Message from "@/models/message";
import {
  RealtimeEvent,
  ensureRealtimeEventIndexes,
} from "@/models/realtime-event";
import {
  REQUESTS_PROJECTION_CHECKPOINT_ID,
  RequestsProjectionCheckpoint,
} from "@/models/requests-projection-checkpoint";
import { RequestListItem } from "@/models/request-list-item";
import User from "@/models/user";
import {
  serializeCanonicalJson,
  sha256CanonicalJson,
} from "@icecore/shared/lib/canonical-json";
import mongoose from "mongoose";
import { createHash, randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  isRecord,
  hasExactKeys,
  isValidDate,
  isNonNegativeSafeInteger,
} from "@icecore/shared/lib/value-utils";

export const REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT = 10_000_000;
export const REQUESTS_PROJECTION_MIGRATION_PAGE_SIZE = 250;
export const REQUESTS_PROJECTION_VERIFY_PAGE_SIZE = 1_000;
export const REQUESTS_PROJECTION_MAX_UPDATED_ROWS_PER_SECOND = 500;
export const REQUESTS_PROJECTION_RUN_BUDGET_MS = 45 * 60_000;
export const REQUESTS_PROJECTION_STOP_STARTING_PAGE_RESERVE_MS = 30_000;
export const REQUESTS_PROJECTION_DB_MAX_TIME_MS = 15_000;
export const REQUESTS_PROJECTION_TRANSACTION_TIMEOUT_MS = 25_000;
export const REQUESTS_PROJECTION_MAX_COMMIT_TIME_MS = 10_000;

type RequestsProjectionProvisioningResult = {
  status: "ready";
  collectionUuid: string;
};

export async function transitionRequestsProjectionSequence(input: {
  expectedCollectionUuid: string;
  verificationReceipt: string;
  deploymentReceipt: string;
  quiesceReceipt: string;
  receiptOutput: string;
}): Promise<Record<string, unknown>> {
  const paths = [
    input.verificationReceipt,
    input.deploymentReceipt,
    input.quiesceReceipt,
    input.receiptOutput,
  ];
  if (paths.some(file => !path.isAbsolute(file)))
    throw new RequestsProjectionProvisioningError(
      "requests_projection_receipt_path_invalid"
    );
  for (const file of paths.slice(0, 3)) {
    const info = await stat(file);
    if (!info.isFile())
      throw new RequestsProjectionProvisioningError(
        "requests_projection_receipt_invalid"
      );
  }
  const receipts = await Promise.all(
    paths
      .slice(0, 3)
      .map(
        async file =>
          JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
      )
  );
  await connectDB();
  const ownerToken = `transition:${randomBytes(24).toString("hex")}`;
  const lease = await claimRequestsProjectionCheckpointLease({
    ownerToken,
    leaseMs: 60_000,
  });
  if (!lease)
    throw new RequestsProjectionProvisioningError(
      "requests_projection_transition_lease_busy"
    );
  try {
    const session = await mongoose.startSession();
    let receipt: Record<string, unknown> | null = null;
    try {
      await session.withTransaction(
        async () => {
          const uuids = await readCollectionUuids(input.expectedCollectionUuid);
          const checkpoint = await RequestsProjectionCheckpoint.findOne({
            _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
          })
            .session(session)
            .lean();
          if (
            !checkpoint ||
            checkpoint.generationMode === "sequence_v2" ||
            checkpoint.inFlightBoundary ||
            checkpoint.watermarkMigrationProgress ||
            checkpoint.generationTransitionReceipt
          )
            throw new RequestsProjectionProvisioningError(
              "requests_projection_transition_precondition_failed"
            );
          if (
            checkpoint.lease?.ownerToken !== lease.ownerToken ||
            checkpoint.lease.fence.toString() !== lease.fence.toString()
          )
            throw new RequestsProjectionProvisioningError(
              "requests_projection_transition_lease_lost"
            );
          const top = await RequestListItem.findOne({ deletedAt: null })
            .sort({ "projection.generation": -1, _id: 1 })
            .hint("request_projection_generation_desc_v4_seed")
            .session(session)
            .lean();
          const topGeneration =
            top &&
            (top as Record<string, unknown>).projection &&
            typeof (
              (top as Record<string, unknown>).projection as Record<
                string,
                unknown
              >
            ).generation === "object"
              ? ((
                  (top as Record<string, unknown>).projection as Record<
                    string,
                    unknown
                  >
                ).generation as mongoose.mongo.Long)
              : null;
          const seed = selectRequestsSequenceTransitionSeed({
            topGeneration,
            checkpointClusterTime: checkpoint.clusterTime,
            lastProjectionGeneration: checkpoint.lastProjectionGeneration,
          });
          const core = createRequestsSequenceTransitionCore({
            schemaVersion: 1,
            domain: "requests-sequence-transition-v1",
            releaseCommit: String(receipts[1].releaseCommit || ""),
            collectionUuids: uuids,
            seed: seed.toString(),
            generationMode: "sequence_v2",
            verificationDigest: sha256CanonicalJson(receipts[0]),
            deploymentDigest: sha256CanonicalJson(receipts[1]),
            quiesceDigest: sha256CanonicalJson(receipts[2]),
          });
          const envelope = {
            schemaVersion: 1,
            transition: core,
            aHandoff: null,
          };
          const result = await RequestsProjectionCheckpoint.updateOne(
            {
              _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
              generationMode: { $in: [null, "cluster_time_v1"] },
              generationTransitionReceipt: null,
              lastProjectionGeneration: checkpoint.lastProjectionGeneration,
              fence: lease.fence,
            },
            {
              $set: {
                generationMode: "sequence_v2",
                lastProjectionGeneration: seed,
                generationTransitionReceipt: envelope,
                updatedAt: new Date(),
              },
            },
            { session }
          );
          if (result.matchedCount !== 1)
            throw new RequestsProjectionProvisioningError(
              "requests_projection_transition_cas_failed"
            );
          receipt = {
            status: "committed",
            transitionCoreDigest: core.digest,
            seed: seed.toString(),
            collectionUuids: uuids,
          };
        },
        {
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
          maxCommitTimeMS: REQUESTS_PROJECTION_MAX_COMMIT_TIME_MS,
          maxTimeMS: REQUESTS_PROJECTION_TRANSACTION_TIMEOUT_MS,
        } as never
      );
    } finally {
      await session.endSession();
    }
    if (!receipt)
      throw new RequestsProjectionProvisioningError(
        "requests_projection_transition_receipt_missing"
      );
    const handle = await open(input.receiptOutput, "wx");
    await handle.writeFile(`${serializeCanonicalJson(receipt)}\n`, "utf8");
    await handle.close();
    return receipt;
  } finally {
    await releaseRequestsProjectionCheckpointLease({ lease }).catch(
      () => false
    );
  }
}

export async function finalizeRequestsProjectionAHandoff(input: {
  expectedCollectionUuid: string;
  transitionReceipt: string;
  handoffReceipt: string;
  receiptOutput: string;
}): Promise<Record<string, unknown>> {
  const files = [
    input.transitionReceipt,
    input.handoffReceipt,
    input.receiptOutput,
  ];
  if (files.some(file => !path.isAbsolute(file)))
    throw new RequestsProjectionProvisioningError(
      "requests_projection_receipt_path_invalid"
    );
  const [transition, handoff] = await Promise.all(
    files
      .slice(0, 2)
      .map(
        async file =>
          JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
      )
  );
  const transitionDigest = String(
    transition.transitionCoreDigest || transition.digest || ""
  );
  if (
    !/^[0-9a-f]{64}$/.test(transitionDigest) ||
    handoff.transitionReceiptSha256 !== transitionDigest
  )
    throw new RequestsProjectionProvisioningError(
      "requests_projection_a_handoff_transition_mismatch"
    );
  await connectDB();
  const uuids = await readCollectionUuids(input.expectedCollectionUuid);
  const existing = await RequestsProjectionCheckpoint.findOne({
    _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
  }).lean();
  if (!existing) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_checkpoint_missing",
    );
  }
  const existingHandoff =
    existing?.generationTransitionReceipt &&
    ((existing.generationTransitionReceipt as Record<string, unknown>)
      .aHandoff as Record<string, unknown> | null | undefined);
  if (
    existingHandoff?.digest === sha256CanonicalJson(handoff) &&
    (existing.generationTransitionReceipt as Record<string, unknown>)
      .transition &&
    (
      (existing.generationTransitionReceipt as Record<string, unknown>)
        .transition as Record<string, unknown>
    ).digest === transitionDigest
  ) {
    const replay = {
      status: "ready",
      transitionCoreDigest: transitionDigest,
      handoffDigest: String(existingHandoff.digest),
      collectionUuids: uuids,
    };
    const replayHandle = await open(input.receiptOutput, "wx");
    await replayHandle.writeFile(`${serializeCanonicalJson(replay)}\n`, "utf8");
    await replayHandle.close();
    return replay;
  }
  const result = await RequestsProjectionCheckpoint.updateOne(
    {
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      generationMode: "sequence_v2",
      "generationTransitionReceipt.transition.digest": transitionDigest,
      "generationTransitionReceipt.aHandoff": null,
    },
    {
      $set: {
        "generationTransitionReceipt.aHandoff": {
          ...handoff,
          digest: sha256CanonicalJson(handoff),
        },
        updatedAt: new Date(),
      },
    }
  );
  if (result.matchedCount !== 1)
    throw new RequestsProjectionProvisioningError(
      "requests_projection_a_handoff_cas_failed"
    );
  const receipt = {
    status: "ready",
    transitionCoreDigest: transitionDigest,
    handoffDigest: sha256CanonicalJson(handoff),
    collectionUuids: uuids,
  };
  const handle = await open(input.receiptOutput, "wx");
  await handle.writeFile(`${serializeCanonicalJson(receipt)}\n`, "utf8");
  await handle.close();
  return receipt;
}

type RequestsProjectionMigrationResult =
  | {
      status: "ready";
      collectionUuid: string;
      preflightCardinality: number;
      scanned: number;
      matched: number;
      updated: number;
      missingAfter: 0;
      invalidAfter: 0;
    }
  | {
      status: "incomplete_resumable" | "not_ready";
      collectionUuid: string;
      missingAfter?: number;
      invalidAfter?: number;
    };

type RequestsProjectionOperatorVerification = {
  schemaVersion: 1;
  contractVersion: 1;
  status: "ready" | "not_ready";
  collectionUuid: string;
  collectionUuids: RequestsProjectionCollectionUuids;
  rowIndexDigest: string;
  outboxIndexDigest: string;
  provisionReceiptDigest: string;
  migrationReceiptDigest: string | null;
  verifiedAt: string;
};

type RequestsSequenceTransitionCore = {
  schemaVersion: 1;
  domain: "requests-sequence-transition-v1";
  releaseCommit: string;
  collectionUuids: RequestsProjectionCollectionUuids;
  seed: string;
  generationMode: "sequence_v2";
  [key: string]: unknown;
};

function createRequestsSequenceTransitionCore(
  input: Omit<RequestsSequenceTransitionCore, "digest">
): RequestsSequenceTransitionCore & { digest: string } {
  const digest = sha256CanonicalJson(input);
  return { ...input, digest } as RequestsSequenceTransitionCore & {
    digest: string;
  };
}

class RequestsProjectionProvisioningError extends Error {
  constructor(
    public readonly reasonCode: string,
    message = reasonCode
  ) {
    super(message);
    this.name = "RequestsProjectionProvisioningError";
  }
}

type RequestsProjectionCollectionUuids = {
  requestListItem: string;
  checkpoint: string;
  realtimeOutbox: string;
  conversation: string;
  message: string;
  chat: string;
  user: string;
};

type WatermarkMigrationProgressV1 = {
  schemaVersion: 1;
  state: "running";
  collectionUuid: string;
  approvedCardinalityCap: typeof REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT;
  nextAfterId: mongoose.Types.ObjectId | null;
  preflightCardinality: number;
  scanned: number;
  matched: number;
  updated: number;
  startedAt: Date;
  updatedAt: Date;
};

type RequestsProjectionProvisionReceiptV1 = {
  schemaVersion: 1;
  contractVersion: 1;
  collectionUuids: RequestsProjectionCollectionUuids;
  rowIndexDigest: string;
  outboxIndexDigest: string;
  imageProofs: {
    conversation: true;
    message: true;
    chat: true;
    user: true;
  };
  canaryContractVersion: 1;
  approvedCardinalityCap: typeof REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT;
  preflightCardinality: number;
  completedAt: Date;
};

type RequestsProjectionMigrationReceiptV1 = {
  schemaVersion: 1;
  contractVersion: 1;
  collectionUuids: RequestsProjectionCollectionUuids;
  rowIndexDigest: string;
  outboxIndexDigest: string;
  provisionReceiptDigest: string;
  approvedCardinalityCap: typeof REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT;
  preflightCardinality: number;
  scanned: number;
  matched: number;
  updated: number;
  missingAfter: 0;
  invalidAfter: 0;
  verifiedAt: Date;
  completedAt: Date;
};

type RequestsProjectionCollectionNames = {
  requestListItem: string;
  checkpoint: string;
  realtimeOutbox: string;
  conversation: string;
  message: string;
  chat: string;
  user: string;
};

function collectionNames(): RequestsProjectionCollectionNames {
  return {
    requestListItem: RequestListItem.collection.collectionName,
    checkpoint: RequestsProjectionCheckpoint.collection.collectionName,
    realtimeOutbox: RealtimeEvent.collection.collectionName,
    conversation: Conversation.collection.collectionName,
    message: Message.collection.collectionName,
    chat: Chat.collection.collectionName,
    user: User.collection.collectionName,
  };
}

function database(): mongoose.mongo.Db {
  const db = mongoose.connection.db;
  if (!db) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_database_unavailable"
    );
  }
  return db;
}

function rawCollection(name: string): mongoose.mongo.Collection<{
  _id: string | mongoose.Types.ObjectId;
  [key: string]: unknown;
}> {
  return database().collection<{
    _id: string | mongoose.Types.ObjectId;
    [key: string]: unknown;
  }>(name);
}

function isUuidHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function validExpectedUuid(value: string): string {
  if (!isUuidHex(value)) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_expected_collection_uuid_invalid"
    );
  }
  return value;
}

function requireApprovedCap(value: number): void {
  if (value !== REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_approved_cardinality_cap_invalid"
    );
  }
}

function bsonCanonical(value: unknown): string {
  return serializeCanonicalJson(
    mongoose.mongo.BSON.EJSON.serialize(value, { relaxed: false })
  );
}

function bsonEqual(left: unknown, right: unknown): boolean {
  return bsonCanonical(left) === bsonCanonical(right);
}

async function requireReplicaSetServerTime(): Promise<Date> {
  const hello = (await database().admin().command({ hello: 1 })) as {
    setName?: unknown;
    localTime?: unknown;
  };
  if (!hello.setName) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_requires_replica_set"
    );
  }
  if (!isValidDate(hello.localTime)) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_server_time_missing"
    );
  }
  return hello.localTime;
}

async function readCollectionMetadata(name: string) {
  return database()
    .listCollections(
      { name },
      {
        nameOnly: false,
        maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
      }
    )
    .next();
}

async function requireCollectionUuid(name: string): Promise<string> {
  const metadata = await readCollectionMetadata(name);
  if (!metadata) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_collection_missing"
    );
  }
  return parseRequestsProjectionCollectionUuid(metadata.info?.uuid);
}

async function assertExpectedRequestListItemUuid(
  expectedCollectionUuid: string
): Promise<string> {
  const actual = await requireCollectionUuid(collectionNames().requestListItem);
  if (actual !== expectedCollectionUuid) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_collection_uuid_mismatch"
    );
  }
  return actual;
}

async function readCollectionUuids(
  expectedRequestListItemUuid: string
): Promise<RequestsProjectionCollectionUuids> {
  const names = collectionNames();
  return {
    requestListItem: await assertExpectedRequestListItemUuid(
      expectedRequestListItemUuid
    ),
    checkpoint: await requireCollectionUuid(names.checkpoint),
    realtimeOutbox: await requireCollectionUuid(names.realtimeOutbox),
    conversation: await requireCollectionUuid(names.conversation),
    message: await requireCollectionUuid(names.message),
    chat: await requireCollectionUuid(names.chat),
    user: await requireCollectionUuid(names.user),
  };
}

function assertCollectionUuidsEqual(
  expected: RequestsProjectionCollectionUuids,
  actual: RequestsProjectionCollectionUuids
): void {
  if (!bsonEqual(expected, actual)) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_collection_uuid_drift"
    );
  }
}

async function createCollectionIfMissing(name: string): Promise<void> {
  if (await readCollectionMetadata(name)) return;
  try {
    await database().createCollection(name);
  } catch {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_collection_create_failed"
    );
  }
  await requireCollectionUuid(name);
}

export function parseRequestsProjectionCollectionUuid(value: unknown): string {
  const uuid = collectionUuidHex(value);
  if (!uuid) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_collection_uuid_invalid"
    );
  }
  return uuid;
}

export async function countRequestsProjectionRowsWithinHardLimit(collection: {
  countDocuments(
    filter: Record<string, never>,
    options: Record<string, unknown>
  ): Promise<number>;
}): Promise<number> {
  let count: number;
  try {
    count = await collection.countDocuments(
      {},
      {
        hint: "_id_",
        limit: REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT + 1,
        maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
      }
    );
  } catch {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_cardinality_count_failed"
    );
  }
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT
  ) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_cardinality_requires_shadow_copy"
    );
  }
  return count;
}

export function buildRequestsProjectionWatermarkMigrationSet(
  row: Record<string, unknown>
): Record<string, mongoose.mongo.Timestamp> | null {
  const projection = row.projection;
  if (
    projection !== undefined &&
    (!projection || typeof projection !== "object" || Array.isArray(projection))
  ) {
    return null;
  }
  const record = (projection || {}) as Record<string, unknown>;
  const set: Record<string, mongoose.mongo.Timestamp> = {};
  if (!Object.hasOwn(record, "sourceWatermark")) {
    set["projection.sourceWatermark"] = new mongoose.mongo.Timestamp({
      t: 0,
      i: 0,
    });
  }
  if (!Object.hasOwn(record, "readStateWatermark")) {
    set["projection.readStateWatermark"] = new mongoose.mongo.Timestamp({
      t: 0,
      i: 0,
    });
  }
  return Object.keys(set).length > 0 ? set : null;
}

async function enableAndVerifySourceImages(): Promise<void> {
  const names = collectionNames();
  for (const name of [
    names.conversation,
    names.message,
    names.chat,
    names.user,
  ]) {
    const metadata = await readCollectionMetadata(name);
    if (metadata?.options?.changeStreamPreAndPostImages?.enabled === true) {
      continue;
    }
    try {
      await database().command({
        collMod: name,
        changeStreamPreAndPostImages: { enabled: true },
      });
    } catch {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_source_image_enable_failed"
      );
    }
  }

  for (const name of [
    names.conversation,
    names.message,
    names.chat,
    names.user,
  ]) {
    const metadata = await readCollectionMetadata(name);
    if (metadata?.options?.changeStreamPreAndPostImages?.enabled !== true) {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_source_image_verification_failed"
      );
    }
  }
}

function canaryDocument(value: "before" | "after") {
  return { _id: "requests-projection-canary", value };
}

async function runRequiredImageCanary(): Promise<void> {
  const name = `requests_projection_image_canary_v1_${randomBytes(6).toString("hex")}`;
  let stream: mongoose.mongo.ChangeStream | null = null;
  let expectedUuid: string | null = null;
  let created = false;
  let failure: RequestsProjectionProvisioningError | null = null;
  try {
    await database().createCollection(name, {
      changeStreamPreAndPostImages: { enabled: true },
    });
    created = true;
    expectedUuid = await requireCollectionUuid(name);
    const createdMetadata = await readCollectionMetadata(name);
    if (
      createdMetadata?.options?.changeStreamPreAndPostImages?.enabled !== true
    ) {
      await database().command({
        collMod: name,
        changeStreamPreAndPostImages: { enabled: true },
      });
    }
    const collection = database().collection<{
      _id: string;
      value: "before" | "after";
    }>(name);
    stream = collection.watch([], {
      fullDocument: "required",
      fullDocumentBeforeChange: "required",
      maxAwaitTimeMS: 1_000,
      showExpandedEvents: true,
    });
    await collection.insertOne(canaryDocument("before"));
    await collection.updateOne(
      { _id: "requests-projection-canary" },
      { $set: { value: "after" } }
    );

    let update: mongoose.mongo.ChangeStreamDocument | null = null;
    for (let attempt = 0; attempt < 8 && !update; attempt += 1) {
      const change = await stream.tryNext();
      if (
        change?.operationType === "insert" &&
        !bsonEqual(change.fullDocument, canaryDocument("before"))
      ) {
        throw new RequestsProjectionProvisioningError(
          "requests_projection_required_image_canary_failed"
        );
      }
      if (change?.operationType === "update") update = change;
    }
    if (
      !update ||
      !bsonEqual(update.fullDocumentBeforeChange, canaryDocument("before")) ||
      !bsonEqual(update.fullDocument, canaryDocument("after"))
    ) {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_required_image_canary_failed"
      );
    }
    if ((await requireCollectionUuid(name)) !== expectedUuid) {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_required_image_canary_uuid_drift"
      );
    }
  } catch (error) {
    failure =
      error instanceof RequestsProjectionProvisioningError
        ? error
        : new RequestsProjectionProvisioningError(
            "requests_projection_required_image_canary_failed"
          );
  }

  try {
    await stream?.close();
  } catch {
    failure = new RequestsProjectionProvisioningError(
      "requests_projection_required_image_canary_cleanup_failed"
    );
  }
  if (created) {
    let mayDropExactCanary = false;
    try {
      const metadata = await readCollectionMetadata(name);
      mayDropExactCanary =
        expectedUuid !== null &&
        metadata != null &&
        parseRequestsProjectionCollectionUuid(metadata.info?.uuid) ===
          expectedUuid;
      if (!mayDropExactCanary) {
        failure = new RequestsProjectionProvisioningError(
          "requests_projection_required_image_canary_uuid_drift"
        );
      }
    } catch {
      failure = new RequestsProjectionProvisioningError(
        "requests_projection_required_image_canary_cleanup_failed"
      );
    }
    if (mayDropExactCanary) {
      try {
        await rawCollection(name).drop();
      } catch {
        failure = new RequestsProjectionProvisioningError(
          "requests_projection_required_image_canary_cleanup_failed"
        );
      }
    }
  }
  if (failure) throw failure;
}

async function persistImmutableProvisionReceipt(
  receipt: RequestsProjectionProvisionReceiptV1
): Promise<void> {
  const collection = rawCollection(collectionNames().checkpoint);
  const existing = await collection.findOne({
    _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
  });
  if (!existing) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_checkpoint_singleton_missing"
    );
  }
  if (existing.provisionReceipt != null) {
    if (sameProvisionEvidence(existing.provisionReceipt, receipt)) return;
    throw new RequestsProjectionProvisioningError(
      "requests_projection_provision_receipt_conflict"
    );
  }
  const result = await collection.updateOne(
    {
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      $or: [
        { provisionReceipt: null },
        { provisionReceipt: { $exists: false } },
      ],
    },
    { $set: { provisionReceipt: receipt, updatedAt: receipt.completedAt } }
  );
  if (result.matchedCount !== 1) {
    const raced = await collection.findOne({
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
    });
    if (!sameProvisionEvidence(raced?.provisionReceipt, receipt)) {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_provision_receipt_conflict"
      );
    }
  }
}

function sameProvisionEvidence(
  existing: unknown,
  candidate: RequestsProjectionProvisionReceiptV1
): boolean {
  if (!isRecord(existing) || !isValidDate(existing.completedAt)) return false;
  return bsonEqual(
    { ...existing, completedAt: candidate.completedAt },
    candidate
  );
}

export async function provisionRequestsProjectionInfrastructure(input: {
  expectedCollectionUuid: string | "absent";
  approvedCardinalityCap: typeof REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT;
}): Promise<RequestsProjectionProvisioningResult> {
  requireApprovedCap(input.approvedCardinalityCap);
  if (
    input.expectedCollectionUuid !== "absent" &&
    !isUuidHex(input.expectedCollectionUuid)
  ) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_expected_collection_uuid_invalid"
    );
  }
  await connectDB();
  await requireReplicaSetServerTime();
  const names = collectionNames();
  const initialMetadata = await readCollectionMetadata(names.requestListItem);
  if (input.expectedCollectionUuid === "absent") {
    if (initialMetadata) {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_expected_collection_absent"
      );
    }
    await database().createCollection(names.requestListItem);
  } else {
    if (!initialMetadata) {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_collection_missing"
      );
    }
    const actual = parseRequestsProjectionCollectionUuid(
      initialMetadata.info?.uuid
    );
    if (actual !== input.expectedCollectionUuid) {
      throw new RequestsProjectionProvisioningError(
        "requests_projection_collection_uuid_mismatch"
      );
    }
  }

  const collectionUuid =
    input.expectedCollectionUuid === "absent"
      ? await requireCollectionUuid(names.requestListItem)
      : input.expectedCollectionUuid;
  await assertExpectedRequestListItemUuid(collectionUuid);
  const preflightCardinality = await countRequestsProjectionRowsWithinHardLimit(
    rawCollection(names.requestListItem)
  );
  if (input.expectedCollectionUuid === "absent" && preflightCardinality !== 0) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_absent_bootstrap_not_empty"
    );
  }

  await assertExpectedRequestListItemUuid(collectionUuid);
  for (const name of [
    names.checkpoint,
    names.realtimeOutbox,
    names.conversation,
    names.message,
    names.chat,
    names.user,
  ]) {
    await createCollectionIfMissing(name);
  }
  await assertExpectedRequestListItemUuid(collectionUuid);
  const collectionUuidsBefore = await readCollectionUuids(collectionUuid);

  await assertExpectedRequestListItemUuid(collectionUuid);
  await ensureRequestsProjectionCheckpoint(await requireReplicaSetServerTime());
  await assertExpectedRequestListItemUuid(collectionUuid);

  await assertExpectedRequestListItemUuid(collectionUuid);
  for (const definition of REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS) {
    await rawCollection(names.requestListItem).createIndex(definition.keys, {
      background: true,
      ...definition.options,
    });
  }
  await ensureRealtimeEventIndexes();
  for (const definition of CONVERSATION_REQUESTS_DEPENDENCY_INDEXES) {
    await rawCollection(names.conversation).createIndex(
      definition.keys,
      definition.options
    );
  }
  await verifyRequestsProjectionIndexDefinitions({
    collectionName: names.conversation,
    definitions: CONVERSATION_REQUESTS_DEPENDENCY_INDEXES,
  });
  await assertExpectedRequestListItemUuid(collectionUuid);

  await assertExpectedRequestListItemUuid(collectionUuid);
  await enableAndVerifySourceImages();
  await assertExpectedRequestListItemUuid(collectionUuid);

  await assertExpectedRequestListItemUuid(collectionUuid);
  await runRequiredImageCanary();
  await assertExpectedRequestListItemUuid(collectionUuid);

  await assertExpectedRequestListItemUuid(collectionUuid);
  await verifyRequestsProjectionIndexDefinitions({
    collectionName: names.requestListItem,
    definitions: REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS,
  });
  await verifyRequestsProjectionIndexDefinitions({
    collectionName: names.realtimeOutbox,
    definitions: REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS,
  });
  await ensureRequestsProjectionInfrastructure();
  await assertExpectedRequestListItemUuid(collectionUuid);

  const collectionUuidsAfter = await readCollectionUuids(collectionUuid);
  assertCollectionUuidsEqual(collectionUuidsBefore, collectionUuidsAfter);
  const existingCheckpoint = await readCheckpointDocument();
  const existingProvisionReceipt = existingCheckpoint.provisionReceipt;
  const completedAt =
    isRecord(existingProvisionReceipt) &&
    isValidDate(existingProvisionReceipt.completedAt)
      ? existingProvisionReceipt.completedAt
      : await requireReplicaSetServerTime();
  const receipt: RequestsProjectionProvisionReceiptV1 = {
    schemaVersion: 1,
    contractVersion: 1,
    collectionUuids: collectionUuidsAfter,
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
    approvedCardinalityCap: REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT,
    preflightCardinality,
    completedAt,
  };
  await assertExpectedRequestListItemUuid(collectionUuid);
  await persistImmutableProvisionReceipt(receipt);
  await assertExpectedRequestListItemUuid(collectionUuid);
  const collectionUuidsPersisted = await readCollectionUuids(collectionUuid);
  assertCollectionUuidsEqual(collectionUuidsAfter, collectionUuidsPersisted);
  return { status: "ready", collectionUuid };
}

function parseMigrationProgress(value: unknown): WatermarkMigrationProgressV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "state",
      "collectionUuid",
      "approvedCardinalityCap",
      "nextAfterId",
      "preflightCardinality",
      "scanned",
      "matched",
      "updated",
      "startedAt",
      "updatedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    value.state !== "running" ||
    !isUuidHex(value.collectionUuid) ||
    value.approvedCardinalityCap !==
      REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT ||
    (value.nextAfterId !== null &&
      !(value.nextAfterId instanceof mongoose.Types.ObjectId)) ||
    !isNonNegativeSafeInteger(value.preflightCardinality) ||
    (value.preflightCardinality as number) >
      REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT ||
    !isNonNegativeSafeInteger(value.scanned) ||
    !isNonNegativeSafeInteger(value.matched) ||
    !isNonNegativeSafeInteger(value.updated) ||
    (value.matched as number) > (value.scanned as number) ||
    (value.updated as number) > (value.matched as number) ||
    !isValidDate(value.startedAt) ||
    !isValidDate(value.updatedAt)
  ) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_watermark_migration_progress_malformed"
    );
  }
  return value as WatermarkMigrationProgressV1;
}

async function readCheckpointDocument(
  session?: mongoose.ClientSession
): Promise<Record<string, unknown>> {
  const document = await rawCollection(collectionNames().checkpoint).findOne(
    { _id: REQUESTS_PROJECTION_CHECKPOINT_ID },
    {
      ...(session ? { session } : {}),
      promoteLongs: false,
      maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
    }
  );
  if (!document) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_checkpoint_singleton_missing"
    );
  }
  return document;
}

function requireProvisionReceipt(
  checkpoint: Record<string, unknown>,
  currentUuids: RequestsProjectionCollectionUuids
): RequestsProjectionProvisionReceiptV1 {
  try {
    deriveRequestsProjectionProvisionReceiptDigest(checkpoint.provisionReceipt);
  } catch {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_provision_receipt_missing_or_malformed"
    );
  }
  const receipt =
    checkpoint.provisionReceipt as RequestsProjectionProvisionReceiptV1;
  assertCollectionUuidsEqual(receipt.collectionUuids, currentUuids);
  if (
    receipt.rowIndexDigest !==
      deriveRequestsProjectionIndexDefinitionDigest(
        REQUESTS_PROJECTION_ROW_INDEX_DEFINITIONS
      ) ||
    receipt.outboxIndexDigest !==
      deriveRequestsProjectionIndexDefinitionDigest(
        REQUESTS_PROJECTION_OUTBOX_INDEX_DEFINITIONS
      )
  ) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_provision_receipt_index_digest_mismatch"
    );
  }
  return receipt;
}

async function initializeMigrationProgress(input: {
  collectionUuid: string;
  preflightCardinality: number;
  serverTime: Date;
}): Promise<WatermarkMigrationProgressV1> {
  const progress: WatermarkMigrationProgressV1 = {
    schemaVersion: 1,
    state: "running",
    collectionUuid: input.collectionUuid,
    approvedCardinalityCap: REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT,
    nextAfterId: null,
    preflightCardinality: input.preflightCardinality,
    scanned: 0,
    matched: 0,
    updated: 0,
    startedAt: input.serverTime,
    updatedAt: input.serverTime,
  };
  const result = await rawCollection(collectionNames().checkpoint).updateOne(
    {
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      watermarkMigrationCompletedAt: null,
      watermarkMigrationReceipt: null,
      "provisionReceipt.collectionUuids.requestListItem": input.collectionUuid,
      $or: [
        { watermarkMigrationProgress: null },
        { watermarkMigrationProgress: { $exists: false } },
      ],
    },
    { $set: { watermarkMigrationProgress: progress } },
    { maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS }
  );
  if (result.matchedCount !== 1) {
    const raced = await readCheckpointDocument();
    return parseMigrationProgress(raced.watermarkMigrationProgress);
  }
  return progress;
}

type CommittedMigrationPage = {
  progress: WatermarkMigrationProgressV1;
  modifiedCount: number;
  hasMore: boolean;
};

const REQUESTS_PROJECTION_NAMESPACE_FENCE_FIELD =
  "__requestsProjectionMigrationNamespaceFenceV1";

async function holdExpectedTargetNamespaceLock(input: {
  expectedCollectionUuid: string;
  session: mongoose.ClientSession;
}): Promise<void> {
  const collection = rawCollection(collectionNames().requestListItem);
  const sentinelId = new mongoose.Types.ObjectId();
  const nonce = randomBytes(16).toString("hex");
  // The transactional insert holds the target namespace lock until commit or
  // abort. Success exact-deletes the sentinel below; any thrown path aborts it.
  const inserted = await collection.insertOne(
    {
      _id: sentinelId,
      [REQUESTS_PROJECTION_NAMESPACE_FENCE_FIELD]: nonce,
    },
    {
      session: input.session,
      maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
    }
  );
  if (
    inserted.acknowledged !== true ||
    !bsonEqual(inserted.insertedId, sentinelId)
  ) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_namespace_fence_insert_failed"
    );
  }

  let uuidFailure: unknown = null;
  try {
    await assertExpectedRequestListItemUuid(input.expectedCollectionUuid);
  } catch (error) {
    uuidFailure = error;
  }
  const deleted = await collection.deleteOne(
    {
      _id: sentinelId,
      [REQUESTS_PROJECTION_NAMESPACE_FENCE_FIELD]: nonce,
    },
    {
      session: input.session,
      maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
    }
  );
  if (deleted.deletedCount !== 1) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_namespace_fence_cleanup_failed"
    );
  }
  if (uuidFailure) throw uuidFailure;
}

async function runMigrationPage(
  progress: WatermarkMigrationProgressV1,
  expectedCollectionUuid: string
): Promise<CommittedMigrationPage> {
  const names = collectionNames();
  const session = await mongoose.startSession();
  let committed: CommittedMigrationPage | null = null;
  try {
    await session.withTransaction(
      async () => {
        const durable = await readCheckpointDocument(session);
        if (!bsonEqual(durable.watermarkMigrationProgress, progress)) {
          throw new RequestsProjectionProvisioningError(
            "requests_projection_watermark_migration_progress_conflict"
          );
        }
        if (progress.collectionUuid !== expectedCollectionUuid) {
          throw new RequestsProjectionProvisioningError(
            "requests_projection_watermark_migration_progress_uuid_mismatch"
          );
        }
        const filter = progress.nextAfterId
          ? { _id: { $gt: progress.nextAfterId } }
          : {};
        const rows = await rawCollection(names.requestListItem)
          .find(filter, {
            projection: {
              _id: 1,
              "projection.sourceWatermark": 1,
              "projection.readStateWatermark": 1,
            },
            hint: "_id_",
            maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
            session,
          })
          .sort({ _id: 1 })
          .limit(REQUESTS_PROJECTION_MIGRATION_PAGE_SIZE + 1)
          .toArray();
        const page = rows.slice(0, REQUESTS_PROJECTION_MIGRATION_PAGE_SIZE);
        const operations: mongoose.mongo.AnyBulkWriteOperation<{
          _id: string | mongoose.Types.ObjectId;
          [key: string]: unknown;
        }>[] = [];
        for (const row of page) {
          const set = buildRequestsProjectionWatermarkMigrationSet(row);
          if (!set) continue;
          const missingFields = Object.keys(set);
          operations.push({
            updateOne: {
              filter: {
                _id: row._id,
                $and: missingFields.map(field => ({
                  [field]: { $exists: false },
                })),
              },
              update: { $set: set },
            },
          });
        }
        await holdExpectedTargetNamespaceLock({
          expectedCollectionUuid,
          session,
        });
        let modifiedCount = 0;
        if (operations.length > 0) {
          const result = await rawCollection(names.requestListItem).bulkWrite(
            operations,
            {
              ordered: true,
              maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
              session,
            }
          );
          modifiedCount = result.modifiedCount;
        }
        const nextProgress: WatermarkMigrationProgressV1 = {
          ...progress,
          nextAfterId:
            (page.at(-1)?._id as mongoose.Types.ObjectId | undefined) ??
            progress.nextAfterId,
          scanned: progress.scanned + page.length,
          matched: progress.matched + operations.length,
          updated: progress.updated + modifiedCount,
          updatedAt: new Date(),
        };
        const result = await rawCollection(names.checkpoint).updateOne(
          {
            _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
            watermarkMigrationProgress: progress,
            "watermarkMigrationProgress.collectionUuid": expectedCollectionUuid,
            "provisionReceipt.collectionUuids.requestListItem":
              expectedCollectionUuid,
            watermarkMigrationCompletedAt: null,
            watermarkMigrationReceipt: null,
          },
          { $set: { watermarkMigrationProgress: nextProgress } },
          {
            session,
            maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
          }
        );
        if (result.matchedCount !== 1) {
          throw new RequestsProjectionProvisioningError(
            "requests_projection_watermark_migration_progress_conflict"
          );
        }
        committed = {
          progress: nextProgress,
          modifiedCount,
          hasMore: rows.length > REQUESTS_PROJECTION_MIGRATION_PAGE_SIZE,
        };
      },
      {
        timeoutMS: REQUESTS_PROJECTION_TRANSACTION_TIMEOUT_MS,
        maxCommitTimeMS: REQUESTS_PROJECTION_MAX_COMMIT_TIME_MS,
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      }
    );
    await assertExpectedRequestListItemUuid(expectedCollectionUuid);
  } catch (error) {
    if (error instanceof RequestsProjectionProvisioningError) throw error;
    throw new RequestsProjectionProvisioningError(
      "requests_projection_watermark_migration_page_failed"
    );
  } finally {
    await session.endSession();
  }
  if (!committed) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_watermark_migration_page_not_committed"
    );
  }
  return committed;
}

async function verifyMigratedWatermarks(input: {
  expectedCollectionUuid: string;
  canStartStep: () => boolean;
}): Promise<
  | {
      status: "complete";
      missingAfter: number;
      invalidAfter: number;
    }
  | { status: "incomplete_resumable" }
> {
  let afterId: mongoose.Types.ObjectId | null = null;
  let missingAfter = 0;
  let invalidAfter = 0;
  while (true) {
    if (!input.canStartStep()) return { status: "incomplete_resumable" };
    await assertExpectedRequestListItemUuid(input.expectedCollectionUuid);
    const rows = await rawCollection(collectionNames().requestListItem)
      .find(afterId ? { _id: { $gt: afterId } } : {}, {
        projection: {
          _id: 1,
          "projection.sourceWatermark": 1,
          "projection.readStateWatermark": 1,
        },
        hint: "_id_",
        maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
      })
      .sort({ _id: 1 })
      .limit(REQUESTS_PROJECTION_VERIFY_PAGE_SIZE + 1)
      .toArray();
    await assertExpectedRequestListItemUuid(input.expectedCollectionUuid);
    const page = rows.slice(0, REQUESTS_PROJECTION_VERIFY_PAGE_SIZE);
    for (const row of page) {
      const projection = isRecord(row.projection) ? row.projection : {};
      const sourcePresent = Object.hasOwn(projection, "sourceWatermark");
      const readPresent = Object.hasOwn(projection, "readStateWatermark");
      if (!sourcePresent || !readPresent) missingAfter += 1;
      if (
        (sourcePresent &&
          !(projection.sourceWatermark instanceof mongoose.mongo.Timestamp)) ||
        (readPresent &&
          !(projection.readStateWatermark instanceof mongoose.mongo.Timestamp))
      ) {
        invalidAfter += 1;
      }
    }
    if (!input.canStartStep()) return { status: "incomplete_resumable" };
    if (rows.length <= REQUESTS_PROJECTION_VERIFY_PAGE_SIZE) break;
    afterId = page.at(-1)?._id as mongoose.Types.ObjectId;
  }
  return { status: "complete", missingAfter, invalidAfter };
}

async function completeWatermarkMigration(input: {
  progress: WatermarkMigrationProgressV1;
  provisionReceipt: RequestsProjectionProvisionReceiptV1;
  collectionUuids: RequestsProjectionCollectionUuids;
  expectedCollectionUuid: string;
  verifiedAt: Date;
  completedAt: Date;
}): Promise<RequestsProjectionMigrationReceiptV1> {
  const receipt: RequestsProjectionMigrationReceiptV1 = {
    schemaVersion: 1,
    contractVersion: 1,
    collectionUuids: input.collectionUuids,
    rowIndexDigest: input.provisionReceipt.rowIndexDigest,
    outboxIndexDigest: input.provisionReceipt.outboxIndexDigest,
    provisionReceiptDigest: deriveRequestsProjectionProvisionReceiptDigest(
      input.provisionReceipt
    ),
    approvedCardinalityCap: REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT,
    preflightCardinality: input.progress.preflightCardinality,
    scanned: input.progress.scanned,
    matched: input.progress.matched,
    updated: input.progress.updated,
    missingAfter: 0,
    invalidAfter: 0,
    verifiedAt: input.verifiedAt,
    completedAt: input.completedAt,
  };
  const session = await mongoose.startSession();
  let committedReceipt: RequestsProjectionMigrationReceiptV1 | null = null;
  try {
    await session.withTransaction(
      async () => {
        committedReceipt = null;
        await holdExpectedTargetNamespaceLock({
          expectedCollectionUuid: input.expectedCollectionUuid,
          session,
        });
        const checkpoint = await readCheckpointDocument(session);
        if (
          checkpoint.watermarkMigrationCompletedAt != null ||
          checkpoint.watermarkMigrationReceipt != null
        ) {
          if (
            isValidDate(checkpoint.watermarkMigrationCompletedAt) &&
            checkpoint.watermarkMigrationCompletedAt.getTime() ===
              receipt.completedAt.getTime() &&
            checkpoint.watermarkMigrationProgress === null &&
            bsonEqual(checkpoint.provisionReceipt, input.provisionReceipt) &&
            bsonEqual(checkpoint.watermarkMigrationReceipt, receipt)
          ) {
            committedReceipt =
              checkpoint.watermarkMigrationReceipt as RequestsProjectionMigrationReceiptV1;
            return;
          }
          throw new RequestsProjectionProvisioningError(
            "requests_projection_watermark_migration_completion_conflict"
          );
        }
        if (!bsonEqual(checkpoint.watermarkMigrationProgress, input.progress)) {
          throw new RequestsProjectionProvisioningError(
            "requests_projection_watermark_migration_completion_conflict"
          );
        }
        const result = await rawCollection(
          collectionNames().checkpoint
        ).updateOne(
          {
            _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
            watermarkMigrationCompletedAt: null,
            watermarkMigrationReceipt: null,
            watermarkMigrationProgress: input.progress,
            "watermarkMigrationProgress.collectionUuid":
              input.expectedCollectionUuid,
            provisionReceipt: input.provisionReceipt,
            "provisionReceipt.collectionUuids.requestListItem":
              input.expectedCollectionUuid,
          },
          {
            $set: {
              watermarkMigrationCompletedAt: input.completedAt,
              watermarkMigrationReceipt: receipt,
              watermarkMigrationProgress: null,
              updatedAt: input.completedAt,
            },
          },
          {
            session,
            maxTimeMS: REQUESTS_PROJECTION_DB_MAX_TIME_MS,
          }
        );
        if (result.matchedCount !== 1) {
          throw new RequestsProjectionProvisioningError(
            "requests_projection_watermark_migration_completion_conflict"
          );
        }
        committedReceipt = receipt;
      },
      {
        timeoutMS: REQUESTS_PROJECTION_TRANSACTION_TIMEOUT_MS,
        maxCommitTimeMS: REQUESTS_PROJECTION_MAX_COMMIT_TIME_MS,
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      }
    );
    await assertExpectedRequestListItemUuid(input.expectedCollectionUuid);
  } finally {
    await session.endSession();
  }
  if (!committedReceipt) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_watermark_migration_completion_not_committed"
    );
  }
  return committedReceipt;
}

export async function migrateRequestsProjectionWatermarks(input: {
  expectedCollectionUuid: string;
  approvedCardinalityCap: typeof REQUESTS_PROJECTION_HARD_CARDINALITY_LIMIT;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<RequestsProjectionMigrationResult> {
  requireApprovedCap(input.approvedCardinalityCap);
  const expectedCollectionUuid = validExpectedUuid(
    input.expectedCollectionUuid
  );
  const monotonicNow = input.monotonicNow || (() => performance.now());
  const sleep =
    input.sleep ||
    ((milliseconds: number) =>
      new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  await connectDB();
  await requireReplicaSetServerTime();
  const actualCollectionUuid = await requireCollectionUuid(
    collectionNames().requestListItem
  );
  if (actualCollectionUuid !== expectedCollectionUuid) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_collection_uuid_mismatch"
    );
  }
  const currentCardinality = await countRequestsProjectionRowsWithinHardLimit(
    rawCollection(collectionNames().requestListItem)
  );
  await assertExpectedRequestListItemUuid(expectedCollectionUuid);
  const physicalEvidence = await ensureRequestsProjectionInfrastructure();
  const collectionUuidsBefore = await readCollectionUuids(
    expectedCollectionUuid
  );
  assertCollectionUuidsEqual(
    collectionUuidsBefore,
    physicalEvidence.collectionUuids
  );
  const checkpoint = await readCheckpointDocument();
  const provisionReceipt = requireProvisionReceipt(
    checkpoint,
    collectionUuidsBefore
  );
  const initialDecision = decideRequestsProjectionActivation(
    checkpoint,
    physicalEvidence
  );
  if (initialDecision.capability === "ready") {
    const receipt =
      checkpoint.watermarkMigrationReceipt as RequestsProjectionMigrationReceiptV1;
    const replayUuids = await readCollectionUuids(expectedCollectionUuid);
    assertCollectionUuidsEqual(collectionUuidsBefore, replayUuids);
    return {
      status: "ready",
      collectionUuid: actualCollectionUuid,
      preflightCardinality: receipt.preflightCardinality,
      scanned: receipt.scanned,
      matched: receipt.matched,
      updated: receipt.updated,
      missingAfter: 0,
      invalidAfter: 0,
    };
  }
  if (
    checkpoint.watermarkMigrationCompletedAt != null ||
    checkpoint.watermarkMigrationReceipt != null
  ) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_watermark_migration_persisted_state_inconsistent"
    );
  }

  let progress = checkpoint.watermarkMigrationProgress
    ? parseMigrationProgress(checkpoint.watermarkMigrationProgress)
    : await initializeMigrationProgress({
        collectionUuid: expectedCollectionUuid,
        preflightCardinality: currentCardinality,
        serverTime: await requireReplicaSetServerTime(),
      });
  if (progress.collectionUuid !== expectedCollectionUuid) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_watermark_migration_progress_uuid_mismatch"
    );
  }

  const startedMonotonic = monotonicNow();
  const canStartStep = () =>
    monotonicNow() - startedMonotonic <
    REQUESTS_PROJECTION_RUN_BUDGET_MS -
      REQUESTS_PROJECTION_STOP_STARTING_PAGE_RESERVE_MS;
  let throttleDeadline = startedMonotonic;
  while (true) {
    if (!canStartStep()) {
      return {
        status: "incomplete_resumable",
        collectionUuid: actualCollectionUuid,
      };
    }
    await assertExpectedRequestListItemUuid(expectedCollectionUuid);
    const committed = await runMigrationPage(progress, expectedCollectionUuid);
    progress = committed.progress;
    if (committed.modifiedCount > 0) {
      throttleDeadline +=
        (committed.modifiedCount * 1_000) /
        REQUESTS_PROJECTION_MAX_UPDATED_ROWS_PER_SECOND;
      const delay = Math.max(0, throttleDeadline - monotonicNow());
      if (delay > 0) await sleep(delay);
    }
    if (!committed.hasMore) break;
  }

  const verification = await verifyMigratedWatermarks({
    expectedCollectionUuid,
    canStartStep,
  });
  if (verification.status === "incomplete_resumable") {
    return {
      status: "incomplete_resumable",
      collectionUuid: actualCollectionUuid,
    };
  }
  if (verification.missingAfter > 0 || verification.invalidAfter > 0) {
    return {
      status: "not_ready",
      collectionUuid: actualCollectionUuid,
      missingAfter: verification.missingAfter,
      invalidAfter: verification.invalidAfter,
    };
  }
  if (!canStartStep()) {
    return {
      status: "incomplete_resumable",
      collectionUuid: actualCollectionUuid,
    };
  }
  await assertExpectedRequestListItemUuid(expectedCollectionUuid);
  const verifiedAt = await requireReplicaSetServerTime();
  const collectionUuidsAfter = await readCollectionUuids(
    expectedCollectionUuid
  );
  assertCollectionUuidsEqual(collectionUuidsBefore, collectionUuidsAfter);
  const completedAt = await requireReplicaSetServerTime();
  if (!canStartStep()) {
    return {
      status: "incomplete_resumable",
      collectionUuid: actualCollectionUuid,
    };
  }
  const receipt = await completeWatermarkMigration({
    progress,
    provisionReceipt,
    collectionUuids: collectionUuidsAfter,
    expectedCollectionUuid,
    verifiedAt,
    completedAt,
  });
  const collectionUuidsCompleted = await readCollectionUuids(
    expectedCollectionUuid
  );
  assertCollectionUuidsEqual(collectionUuidsAfter, collectionUuidsCompleted);
  return {
    status: "ready",
    collectionUuid: actualCollectionUuid,
    preflightCardinality: receipt.preflightCardinality,
    scanned: receipt.scanned,
    matched: receipt.matched,
    updated: receipt.updated,
    missingAfter: 0,
    invalidAfter: 0,
  };
}

export async function verifyRequestsProjectionForOperator(input: {
  expectedCollectionUuid: string;
}): Promise<RequestsProjectionOperatorVerification> {
  await connectDB();
  const collectionUuid = await requireRequestsProjectionCollectionUuid(
    input.expectedCollectionUuid
  );
  await requireReplicaSetServerTime();
  await countRequestsProjectionRowsWithinHardLimit(
    rawCollection(collectionNames().requestListItem)
  );
  await assertExpectedRequestListItemUuid(collectionUuid);
  const physicalEvidence = await ensureRequestsProjectionInfrastructure();
  const collectionUuids = await readCollectionUuids(collectionUuid);
  assertCollectionUuidsEqual(collectionUuids, physicalEvidence.collectionUuids);
  const checkpoint = await readCheckpointDocument();
  const provisionReceipt = requireProvisionReceipt(checkpoint, collectionUuids);
  const decision = decideRequestsProjectionActivation(
    checkpoint,
    physicalEvidence
  );
  const verifiedAt = await requireReplicaSetServerTime();
  const collectionUuidsAfter = await readCollectionUuids(collectionUuid);
  assertCollectionUuidsEqual(collectionUuids, collectionUuidsAfter);
  return {
    schemaVersion: 1,
    contractVersion: 1,
    status: decision.capability,
    collectionUuid,
    collectionUuids,
    rowIndexDigest: provisionReceipt.rowIndexDigest,
    outboxIndexDigest: provisionReceipt.outboxIndexDigest,
    provisionReceiptDigest:
      deriveRequestsProjectionProvisionReceiptDigest(provisionReceipt),
    migrationReceiptDigest:
      checkpoint.watermarkMigrationReceipt == null
        ? null
        : createHash("sha256")
            .update(bsonCanonical(checkpoint.watermarkMigrationReceipt), "utf8")
            .digest("hex"),
    verifiedAt: verifiedAt.toISOString(),
  };
}

export async function requireRequestsProjectionCollectionUuid(
  expectedCollectionUuid: string
): Promise<string> {
  const expected = validExpectedUuid(expectedCollectionUuid);
  await connectDB();
  const actual = await requireCollectionUuid(collectionNames().requestListItem);
  if (actual !== expected) {
    throw new RequestsProjectionProvisioningError(
      "requests_projection_collection_uuid_mismatch"
    );
  }
  return actual;
}
