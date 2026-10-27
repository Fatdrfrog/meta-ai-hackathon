import {
  REQUESTS_PROJECTION_CHECKPOINT_ID,
  RequestsProjectionCheckpoint,
  type RequestsProjectionCheckpointDocument,
  type RequestsProjectionCheckpointState,
  type RequestsProjectionGenerationMode,
  type ReservedProjectionBoundary,
} from "@/models/requests-projection-checkpoint";
import { encodeRequestProjectionWatermark } from "@/lib/requests-projection/contract";
import { sha256CanonicalJson } from "@icecore/shared/lib/canonical-json";
import mongoose from "mongoose";
import { requireNonEmptyString } from "@icecore/shared/lib/value-utils";

export type { RequestsProjectionCheckpointState };
export type { RequestsProjectionGenerationMode, ReservedProjectionBoundary };

const MAX_SIGNED_INT64 = BigInt("9223372036854775807");
export const MAX_ISSUABLE_GENERATION = BigInt("9214364837600034815");

export type ProjectionBoundaryProgress =
  | {
      kind: "change_stream_v1";
      resumeToken: mongoose.mongo.Document;
      clusterTime: mongoose.mongo.Timestamp;
    }
  | {
      kind: "backfill_page_v1";
      backfillAfterId: mongoose.Types.ObjectId | null;
    };

type NormalizedRequestsProjectionCheckpointDocument =
  RequestsProjectionCheckpointDocument & {
    generationMode: RequestsProjectionGenerationMode;
    lastProjectionGeneration: mongoose.mongo.Long;
    inFlightBoundary: ReservedProjectionBoundary | null;
  };

export function normalizeRequestsProjectionCheckpoint(
  document: RequestsProjectionCheckpointDocument
): NormalizedRequestsProjectionCheckpointDocument {
  const generationMode = document.generationMode ?? "cluster_time_v1";
  if (
    generationMode !== "cluster_time_v1" &&
    generationMode !== "sequence_v2"
  ) {
    throw new Error("requests_projection_generation_mode_corrupt");
  }
  const rawCounter = document.lastProjectionGeneration;
  const lastProjectionGeneration =
    rawCounter === undefined || rawCounter === null
      ? mongoose.mongo.Long.ZERO
      : requireCounterLong(rawCounter);
  const inFlightBoundary =
    document.inFlightBoundary === undefined ||
    document.inFlightBoundary === null
      ? null
      : requireReservedBoundary(document.inFlightBoundary);

  if (generationMode === "cluster_time_v1") {
    if (document.generationTransitionReceipt != null || inFlightBoundary) {
      throw new Error("requests_projection_legacy_transition_corrupt");
    }
  } else {
    if (
      document.generationTransitionReceipt === undefined ||
      document.generationTransitionReceipt === null
    ) {
      throw new Error("requests_projection_transition_receipt_missing");
    }
    if (rawCounter === undefined || rawCounter === null) {
      throw new Error("requests_projection_generation_counter_missing");
    }
    if (
      inFlightBoundary &&
      inFlightBoundary.generation.toBigInt() !==
        lastProjectionGeneration.toBigInt()
    ) {
      throw new Error("requests_projection_boundary_counter_mismatch");
    }
  }

  return {
    ...document,
    generationMode,
    lastProjectionGeneration,
    inFlightBoundary,
  };
}

export function deriveProjectionResumeTokenDigest(
  resumeToken: mongoose.mongo.Document
): string {
  if (!resumeToken || typeof resumeToken !== "object") {
    throw new TypeError("Requests projection raw resume token is required");
  }
  const serialized = mongoose.mongo.BSON.EJSON.serialize(resumeToken, {
    relaxed: false,
  });
  return sha256CanonicalJson({
    domain: "airi.requests.projection.resume-token.v1",
    schemaVersion: 1,
    resumeToken: serialized,
  });
}

export function deriveProjectionBackfillBoundaryDigest(input: {
  sourceClusterTime: mongoose.mongo.Timestamp;
  backfillAfterId: mongoose.Types.ObjectId | null;
}): string {
  const sourceClusterTime = requireNonzeroTimestamp(
    input.sourceClusterTime,
    "Requests projection backfill source boundary"
  );
  if (
    input.backfillAfterId !== null &&
    !(input.backfillAfterId instanceof mongoose.Types.ObjectId)
  ) {
    throw new TypeError("Requests projection backfill cursor must be ObjectId");
  }
  return sha256CanonicalJson({
    domain: "airi.requests.projection.backfill-page.v1",
    schemaVersion: 1,
    checkpointId: REQUESTS_PROJECTION_CHECKPOINT_ID,
    sourceWatermark: encodeRequestProjectionWatermark(sourceClusterTime),
    backfillAfterId: input.backfillAfterId?.toHexString() ?? null,
    pageSize: 100,
  });
}

export async function reserveProjectionBoundary(input: {
  lease: RequestsProjectionLease;
  resumeTokenDigest: string;
  sourceClusterTime: mongoose.mongo.Timestamp;
  legacyGeneration: mongoose.mongo.Long;
  now?: Date;
}): Promise<ReservedProjectionBoundary> {
  const now = validDate(input.now || new Date(), "now");
  const resumeTokenDigest = requireResumeTokenDigest(input.resumeTokenDigest);
  const sourceClusterTime = requireNonzeroTimestamp(
    input.sourceClusterTime,
    "Requests projection source boundary"
  );
  const legacyGeneration = requireLong(
    input.legacyGeneration,
    "Requests projection legacy generation"
  );
  const session = await mongoose.startSession();
  try {
    let reserved: ReservedProjectionBoundary | null = null;
    await session.withTransaction(async () => {
      const checkpoint = await readOwnedCheckpoint({
        lease: input.lease,
        now,
        session,
      });
      if (checkpoint.generationMode === "cluster_time_v1") {
        reserved = Object.freeze({
          resumeTokenDigest,
          generation: legacyGeneration,
          sourceClusterTime,
        });
        return;
      }

      const existing = checkpoint.inFlightBoundary;
      if (existing) {
        if (existing.resumeTokenDigest !== resumeTokenDigest) {
          throw new Error("requests_projection_boundary_occupied");
        }
        if (!timestampsEqual(existing.sourceClusterTime, sourceClusterTime)) {
          throw new Error("requests_projection_boundary_source_corrupt");
        }
        reserved = Object.freeze({ ...existing });
        return;
      }

      const last = checkpoint.lastProjectionGeneration.toBigInt();
      if (last >= MAX_ISSUABLE_GENERATION) {
        throw new Error("requests_projection_generation_headroom_exhausted");
      }
      const generation = mongoose.mongo.Long.fromBigInt(last + BigInt(1));
      const boundary: ReservedProjectionBoundary = Object.freeze({
        resumeTokenDigest,
        generation,
        sourceClusterTime,
      });
      const result = await checkpointCollection().updateOne(
        {
          ...liveLeaseFilter(input.lease, now),
          generationMode: "sequence_v2",
          generationTransitionReceipt: { $exists: true, $ne: null },
          lastProjectionGeneration: checkpoint.lastProjectionGeneration,
          inFlightBoundary: null,
        },
        {
          $set: {
            lastProjectionGeneration: generation,
            inFlightBoundary: boundary,
            updatedAt: now,
          },
        },
        { session }
      );
      if (result.matchedCount !== 1) {
        throw new RequestsProjectionCheckpointLeaseLostError();
      }
      reserved = boundary;
    });
    if (!reserved) {
      throw new Error("requests_projection_boundary_reservation_missing");
    }
    return reserved;
  } finally {
    await session.endSession();
  }
}

export async function assertReservedProjectionBoundary(input: {
  lease: RequestsProjectionLease;
  boundary: ReservedProjectionBoundary;
  session: mongoose.ClientSession;
  now?: Date;
}): Promise<RequestsProjectionGenerationMode> {
  const now = validDate(input.now || new Date(), "now");
  const boundary = requireReservedBoundary(input.boundary);
  const checkpoint = await readOwnedCheckpoint({
    lease: input.lease,
    now,
    session: input.session,
  });
  assertBoundaryMatchesMode(checkpoint, boundary);
  if (checkpoint.generationMode === "cluster_time_v1") {
    return checkpoint.generationMode;
  }
  const priorUpdatedAt = validDate(
    checkpoint.updatedAt,
    "Requests projection persisted updatedAt"
  );
  let touchUpdatedAt = now;
  if (touchUpdatedAt.getTime() <= priorUpdatedAt.getTime()) {
    touchUpdatedAt = new Date(priorUpdatedAt.getTime() + 1);
    if (
      !Number.isFinite(touchUpdatedAt.getTime()) ||
      touchUpdatedAt.getTime() <= priorUpdatedAt.getTime()
    ) {
      throw new Error("requests_projection_checkpoint_touch_time_overflow");
    }
  }
  const result = await checkpointCollection().updateOne(
    {
      ...liveLeaseFilter(input.lease, now),
      generationMode: "sequence_v2",
      generationTransitionReceipt: { $exists: true, $ne: null },
      lastProjectionGeneration: boundary.generation,
      updatedAt: priorUpdatedAt,
      "inFlightBoundary.resumeTokenDigest": boundary.resumeTokenDigest,
      "inFlightBoundary.generation": boundary.generation,
      "inFlightBoundary.sourceClusterTime": boundary.sourceClusterTime,
    },
    { $set: { updatedAt: touchUpdatedAt } },
    { session: input.session }
  );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    throw new RequestsProjectionCheckpointLeaseLostError();
  }
  return checkpoint.generationMode;
}

export async function finalizeProjectionBoundary(input: {
  lease: RequestsProjectionLease;
  boundary: ReservedProjectionBoundary;
  progress: ProjectionBoundaryProgress;
  projectedCountIncrement: number;
  session: mongoose.ClientSession;
  now?: Date;
}): Promise<RequestsProjectionLease> {
  const now = validDate(input.now || new Date(), "now");
  const boundary = requireReservedBoundary(input.boundary);
  const projectedCountIncrement = requireProjectedCountIncrement(
    input.projectedCountIncrement
  );
  const checkpoint = await readOwnedCheckpoint({
    lease: input.lease,
    now,
    session: input.session,
  });
  assertBoundaryMatchesMode(checkpoint, boundary);
  const progress = requireProjectionBoundaryProgress(input.progress, boundary);

  if (checkpoint.generationMode === "cluster_time_v1") {
    return updateRequestsProjectionCheckpoint({
      lease: input.lease,
      ...(progress.kind === "change_stream_v1"
        ? {
            resumeToken: progress.resumeToken,
            clusterTime: progress.clusterTime,
          }
        : {
            state: "backfilling" as const,
            backfillAfterId: progress.backfillAfterId,
          }),
      projectedCountIncrement,
      session: input.session,
      now,
    });
  }

  const set: Record<string, unknown> = {
    inFlightBoundary: null,
    updatedAt: now,
  };
  if (progress.kind === "change_stream_v1") {
    set.resumeToken = progress.resumeToken;
    set.clusterTime = progress.clusterTime;
  } else {
    set.state = "backfilling";
    set.backfillAfterId = progress.backfillAfterId;
  }
  const update: Record<string, unknown> = { $set: set };
  if (projectedCountIncrement > 0) {
    update.$inc = { projectedCount: projectedCountIncrement };
  }
  const result = await checkpointCollection().updateOne(
    {
      ...liveLeaseFilter(input.lease, now),
      generationMode: "sequence_v2",
      generationTransitionReceipt: { $exists: true, $ne: null },
      "inFlightBoundary.resumeTokenDigest": boundary.resumeTokenDigest,
      "inFlightBoundary.generation": boundary.generation,
      "inFlightBoundary.sourceClusterTime": boundary.sourceClusterTime,
    },
    update,
    { session: input.session }
  );
  if (result.matchedCount !== 1) {
    throw new RequestsProjectionCheckpointLeaseLostError();
  }
  return input.lease;
}

export async function advanceIdleProjectionResumeToken(input: {
  lease: RequestsProjectionLease;
  resumeToken: mongoose.mongo.Document;
  now?: Date;
}): Promise<RequestsProjectionLease> {
  const now = validDate(input.now || new Date(), "now");
  if (!input.resumeToken || typeof input.resumeToken !== "object") {
    throw new TypeError("Requests projection idle resume token is required");
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const checkpoint = await readOwnedCheckpoint({
        lease: input.lease,
        now,
        session,
      });
      if (checkpoint.inFlightBoundary) {
        throw new Error("requests_projection_idle_boundary_occupied");
      }
      const modeFilter =
        checkpoint.generationMode === "sequence_v2"
          ? {
              generationMode: "sequence_v2",
              generationTransitionReceipt: { $exists: true, $ne: null },
              inFlightBoundary: null,
            }
          : {
              $or: [
                { generationMode: { $exists: false } },
                { generationMode: "cluster_time_v1" },
              ],
              generationTransitionReceipt: null,
              $and: [
                {
                  $or: [
                    { inFlightBoundary: { $exists: false } },
                    { inFlightBoundary: null },
                  ],
                },
              ],
            };
      const result = await checkpointCollection().updateOne(
        { ...liveLeaseFilter(input.lease, now), ...modeFilter },
        { $set: { resumeToken: input.resumeToken, updatedAt: now } },
        { session }
      );
      if (result.matchedCount !== 1) {
        throw new RequestsProjectionCheckpointLeaseLostError();
      }
    });
    return input.lease;
  } finally {
    await session.endSession();
  }
}

export async function resetRequestsProjectionCheckpointForRebuild(input: {
  lease: RequestsProjectionLease;
  expectedBoundary: ReservedProjectionBoundary | null;
  session: mongoose.ClientSession;
  now?: Date;
}): Promise<RequestsProjectionLease> {
  const now = validDate(input.now || new Date(), "now");
  const checkpoint = await readOwnedCheckpoint({
    lease: input.lease,
    now,
    session: input.session,
  });
  if (checkpoint.generationMode === "cluster_time_v1") {
    if (input.expectedBoundary !== null) {
      throw new Error("requests_projection_legacy_rebuild_boundary_invalid");
    }
    return updateRequestsProjectionCheckpoint({
      lease: input.lease,
      state: "initializing",
      projectedCount: 0,
      resumeToken: null,
      clusterTime: null,
      backfillAfterId: null,
      activatedAt: null,
      error: null,
      session: input.session,
      now,
    });
  }

  const expected = input.expectedBoundary
    ? requireReservedBoundary(input.expectedBoundary)
    : null;
  if (
    (expected === null) !== (checkpoint.inFlightBoundary === null) ||
    (expected &&
      checkpoint.inFlightBoundary &&
      (expected.resumeTokenDigest !==
        checkpoint.inFlightBoundary.resumeTokenDigest ||
        expected.generation.toBigInt() !==
          checkpoint.inFlightBoundary.generation.toBigInt() ||
        !timestampsEqual(
          expected.sourceClusterTime,
          checkpoint.inFlightBoundary.sourceClusterTime
        )))
  ) {
    throw new Error("requests_projection_rebuild_boundary_mismatch");
  }
  const boundaryFilter = expected
    ? {
        "inFlightBoundary.resumeTokenDigest": expected.resumeTokenDigest,
        "inFlightBoundary.generation": expected.generation,
        "inFlightBoundary.sourceClusterTime": expected.sourceClusterTime,
      }
    : { inFlightBoundary: null };
  const result = await checkpointCollection().updateOne(
    {
      ...liveLeaseFilter(input.lease, now),
      generationMode: "sequence_v2",
      generationTransitionReceipt: { $exists: true, $ne: null },
      ...boundaryFilter,
    },
    {
      $set: {
        state: "initializing",
        inFlightBoundary: null,
        backfillAfterId: null,
        projectedCount: 0,
        activatedAt: null,
        error: { code: null, message: null, at: null },
        updatedAt: now,
      },
    },
    { session: input.session }
  );
  if (result.matchedCount !== 1) {
    throw new RequestsProjectionCheckpointLeaseLostError();
  }
  return input.lease;
}

export type RequestsProjectionLease = {
  ownerToken: string;
  fence: mongoose.mongo.Long;
  claimedAt: Date;
  expiresAt: Date;
};

export function requiresFreshRequestsProjectionBackfill(
  checkpoint: Pick<RequestsProjectionCheckpointDocument, "state"> | null
): boolean {
  return (
    checkpoint === null ||
    checkpoint.state === "initializing" ||
    checkpoint.state === "failed"
  );
}

export class RequestsProjectionCheckpointLeaseLostError extends Error {
  constructor(message = "Requests projection checkpoint lease was lost") {
    super(message);
    this.name = "RequestsProjectionCheckpointLeaseLostError";
  }
}

type CheckpointCollection = {
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options?: Record<string, unknown>
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown> | Record<string, unknown>[],
    options?: Record<string, unknown>
  ): Promise<RequestsProjectionCheckpointDocument | null>;
  findOne(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<RequestsProjectionCheckpointDocument | null>;
};

function requireLong(value: unknown, name: string): mongoose.mongo.Long {
  if (!mongoose.mongo.Long.isLong(value)) {
    throw new TypeError(`${name} must be a BSON Long`);
  }
  return value;
}

function requireCounterLong(value: unknown): mongoose.mongo.Long {
  const counter = requireLong(value, "Requests projection generation counter");
  const parsed = counter.toBigInt();
  if (parsed < BigInt(0) || parsed > MAX_SIGNED_INT64) {
    throw new Error("requests_projection_generation_counter_corrupt");
  }
  return counter;
}

function requireNonzeroTimestamp(
  value: unknown,
  name: string
): mongoose.mongo.Timestamp {
  if (
    !(value instanceof mongoose.mongo.Timestamp) ||
    value.toBigInt() === BigInt(0)
  ) {
    throw new TypeError(`${name} must be a nonzero BSON Timestamp`);
  }
  return value;
}

/** Canonical legacy generation packing shared by activation and migration. */
export function toLegacyClusterTimeGeneration(
  clusterTime: mongoose.mongo.Timestamp
): mongoose.mongo.Long {
  if (
    !(clusterTime instanceof mongoose.mongo.Timestamp) ||
    clusterTime.toBigInt() <= BigInt(0)
  ) {
    throw new TypeError("clusterTime must be a nonzero BSON Timestamp");
  }
  return mongoose.mongo.Long.fromBits(
    clusterTime.getLowBits(),
    clusterTime.getHighBits()
  );
}

/** Selects the one transition seed; the first post-restart reservation is seed+1. */
export function selectRequestsSequenceTransitionSeed(input: {
  topGeneration?: mongoose.mongo.Long | null;
  checkpointClusterTime?: mongoose.mongo.Timestamp | null;
  lastProjectionGeneration?: mongoose.mongo.Long | null;
}): mongoose.mongo.Long {
  const values = [
    input.topGeneration?.toBigInt() ?? BigInt(0),
    input.checkpointClusterTime &&
    input.checkpointClusterTime.toBigInt() > BigInt(0)
      ? toLegacyClusterTimeGeneration(input.checkpointClusterTime).toBigInt()
      : BigInt(0),
    input.lastProjectionGeneration?.toBigInt() ?? BigInt(0),
  ];
  const seed =
    values.reduce((max, value) => (value > max ? value : max), BigInt(0)) +
    BigInt(1);
  if (seed >= MAX_ISSUABLE_GENERATION)
    throw new Error("requests_projection_generation_headroom_exhausted");
  return mongoose.mongo.Long.fromBigInt(seed);
}

function requireResumeTokenDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(
      "Requests projection resume token digest must be lowercase SHA-256"
    );
  }
  return value;
}

function requireReservedBoundary(value: unknown): ReservedProjectionBoundary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Requests projection reserved boundary is required");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "generation,resumeTokenDigest,sourceClusterTime") {
    throw new Error("requests_projection_boundary_shape_corrupt");
  }
  const generation = requireCounterLong(record.generation);
  if (
    generation.toBigInt() < BigInt(1) ||
    generation.toBigInt() > MAX_ISSUABLE_GENERATION
  ) {
    throw new Error("requests_projection_boundary_generation_corrupt");
  }
  return {
    resumeTokenDigest: requireResumeTokenDigest(record.resumeTokenDigest),
    generation,
    sourceClusterTime: requireNonzeroTimestamp(
      record.sourceClusterTime,
      "Requests projection reserved source boundary"
    ),
  };
}

function timestampsEqual(
  left: mongoose.mongo.Timestamp,
  right: mongoose.mongo.Timestamp
): boolean {
  return left.toBigInt() === right.toBigInt();
}

function requireProjectedCountIncrement(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(
      "Requests projection projected count increment must be non-negative"
    );
  }
  return value as number;
}

function requireProjectionBoundaryProgress(
  value: ProjectionBoundaryProgress,
  boundary: ReservedProjectionBoundary
): ProjectionBoundaryProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Requests projection boundary progress is required");
  }
  const record = value as unknown as Record<string, unknown>;
  if (value.kind === "change_stream_v1") {
    if (
      Object.keys(record).sort().join(",") !== "clusterTime,kind,resumeToken"
    ) {
      throw new Error("requests_projection_change_progress_shape_corrupt");
    }
    if (!value.resumeToken || typeof value.resumeToken !== "object") {
      throw new TypeError("Requests projection raw change token is required");
    }
    if (
      deriveProjectionResumeTokenDigest(value.resumeToken) !==
      boundary.resumeTokenDigest
    ) {
      throw new Error("requests_projection_progress_token_digest_mismatch");
    }
    const clusterTime = requireNonzeroTimestamp(
      value.clusterTime,
      "Requests projection progress cluster time"
    );
    if (!timestampsEqual(clusterTime, boundary.sourceClusterTime)) {
      throw new Error("requests_projection_progress_source_mismatch");
    }
    return { ...value, clusterTime };
  }
  if (value.kind === "backfill_page_v1") {
    if (Object.keys(record).sort().join(",") !== "backfillAfterId,kind") {
      throw new Error("requests_projection_backfill_progress_shape_corrupt");
    }
    if (
      value.backfillAfterId !== null &&
      !(value.backfillAfterId instanceof mongoose.Types.ObjectId)
    ) {
      throw new TypeError(
        "Requests projection backfill progress cursor must be ObjectId"
      );
    }
    return value;
  }
  throw new Error("requests_projection_progress_kind_corrupt");
}

function checkpointCollection(): CheckpointCollection {
  return RequestsProjectionCheckpoint.collection as unknown as CheckpointCollection;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${name} must be a valid Date`);
  }
  return value;
}

function validLeaseMs(value: number | undefined, fallback: number): number {
  const leaseMs = value ?? fallback;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
    throw new Error("Requests projection leaseMs must be at least 1000");
  }
  return leaseMs;
}

function asLong(value: unknown): mongoose.mongo.Long {
  if (mongoose.mongo.Long.isLong(value)) return value;
  if (typeof value === "bigint") return mongoose.mongo.Long.fromBigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return mongoose.mongo.Long.fromNumber(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return mongoose.mongo.Long.fromString(value);
  }
  return mongoose.mongo.Long.ZERO;
}

function toLease(
  document: RequestsProjectionCheckpointDocument
): RequestsProjectionLease | null {
  const lease = document.lease;
  if (!lease?.ownerToken || !lease.expiresAt) return null;
  return {
    ownerToken: lease.ownerToken,
    fence: asLong(lease.fence),
    claimedAt: new Date(lease.claimedAt),
    expiresAt: new Date(lease.expiresAt),
  };
}

function liveLeaseFilter(
  lease: RequestsProjectionLease,
  now: Date
): Record<string, unknown> {
  return {
    _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
    fence: lease.fence,
    "lease.ownerToken": lease.ownerToken,
    "lease.fence": lease.fence,
    "lease.expiresAt": { $gt: now },
  };
}

async function readOwnedCheckpoint(input: {
  lease: RequestsProjectionLease;
  now: Date;
  session: mongoose.ClientSession;
}): Promise<NormalizedRequestsProjectionCheckpointDocument> {
  const document = await checkpointCollection().findOne(
    liveLeaseFilter(input.lease, input.now),
    { session: input.session, promoteLongs: false }
  );
  if (!document) {
    throw new RequestsProjectionCheckpointLeaseLostError();
  }
  return normalizeRequestsProjectionCheckpoint(document);
}

function assertBoundaryMatchesMode(
  checkpoint: NormalizedRequestsProjectionCheckpointDocument,
  boundary: ReservedProjectionBoundary
): void {
  if (checkpoint.generationMode === "cluster_time_v1") return;
  const reserved = checkpoint.inFlightBoundary;
  if (!reserved) {
    throw new Error("requests_projection_boundary_missing");
  }
  if (
    reserved.resumeTokenDigest !== boundary.resumeTokenDigest ||
    reserved.generation.toBigInt() !== boundary.generation.toBigInt() ||
    !timestampsEqual(reserved.sourceClusterTime, boundary.sourceClusterTime)
  ) {
    throw new Error("requests_projection_boundary_mismatch");
  }
}

export async function ensureRequestsProjectionCheckpoint(
  now = new Date()
): Promise<void> {
  validDate(now, "now");
  await checkpointCollection().updateOne(
    { _id: REQUESTS_PROJECTION_CHECKPOINT_ID },
    {
      $setOnInsert: {
        _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
        schemaVersion: 2,
        state: "initializing",
        fence: mongoose.mongo.Long.ZERO,
        lease: null,
        resumeToken: null,
        clusterTime: null,
        backfillAfterId: null,
        projectedCount: 0,
        activatedAt: null,
        generationMode: "cluster_time_v1",
        lastProjectionGeneration: mongoose.mongo.Long.ZERO,
        inFlightBoundary: null,
        watermarkMigrationProgress: null,
        watermarkMigrationCompletedAt: null,
        watermarkMigrationReceipt: null,
        provisionReceipt: null,
        generationTransitionReceipt: null,
        error: { code: null, message: null, at: null },
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true }
  );
}

export async function claimRequestsProjectionCheckpointLease(input: {
  ownerToken: string;
  now?: Date;
  leaseMs?: number;
}): Promise<RequestsProjectionLease | null> {
  const ownerToken = requireNonEmptyString(
    input.ownerToken,
    "Requests projection ownerToken"
  );
  const now = validDate(input.now || new Date(), "now");
  const expiresAt = new Date(
    now.getTime() + validLeaseMs(input.leaseMs, 30_000)
  );

  const nextFence = {
    $add: [
      { $ifNull: ["$fence", mongoose.mongo.Long.ZERO] },
      mongoose.mongo.Long.ONE,
    ],
  };
  const document = await checkpointCollection().findOneAndUpdate(
    {
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      $or: [
        { lease: null },
        { "lease.expiresAt": { $lte: now } },
        { "lease.ownerToken": ownerToken },
      ],
    },
    [
      {
        $set: {
          fence: nextFence,
          lease: {
            ownerToken,
            fence: nextFence,
            claimedAt: now,
            expiresAt,
          },
          updatedAt: now,
        },
      },
    ],
    { returnDocument: "after", promoteLongs: false }
  );

  return document ? toLease(document) : null;
}

export async function renewRequestsProjectionCheckpointLease(input: {
  lease: RequestsProjectionLease;
  now?: Date;
  leaseMs?: number;
}): Promise<RequestsProjectionLease | null> {
  const now = validDate(input.now || new Date(), "now");
  const expiresAt = new Date(
    now.getTime() + validLeaseMs(input.leaseMs, 30_000)
  );
  const document = await checkpointCollection().findOneAndUpdate(
    liveLeaseFilter(input.lease, now),
    {
      $set: {
        "lease.expiresAt": expiresAt,
        updatedAt: now,
      },
    },
    { returnDocument: "after", promoteLongs: false }
  );
  return document ? toLease(document) : null;
}

export async function updateRequestsProjectionCheckpoint(input: {
  lease: RequestsProjectionLease;
  state?: RequestsProjectionCheckpointState;
  resumeToken?: mongoose.mongo.Document | null;
  clusterTime?: mongoose.mongo.Timestamp | null;
  backfillAfterId?: mongoose.Types.ObjectId | null;
  projectedCount?: number;
  projectedCountIncrement?: number;
  activatedAt?: Date | null;
  error?: { code: string; message: string; at?: Date } | null;
  now?: Date;
  session?: mongoose.ClientSession;
}): Promise<RequestsProjectionLease> {
  const now = validDate(input.now || new Date(), "now");
  const set: Record<string, unknown> = { updatedAt: now };
  if (input.state !== undefined) set.state = input.state;
  if (input.resumeToken !== undefined) set.resumeToken = input.resumeToken;
  if (input.clusterTime !== undefined) set.clusterTime = input.clusterTime;
  if (input.backfillAfterId !== undefined) {
    set.backfillAfterId = input.backfillAfterId;
  }
  if (input.projectedCount !== undefined) {
    if (
      !Number.isSafeInteger(input.projectedCount) ||
      input.projectedCount < 0
    ) {
      throw new Error(
        "Requests projection projectedCount must be non-negative"
      );
    }
    set.projectedCount = input.projectedCount;
  }
  if (input.activatedAt !== undefined) set.activatedAt = input.activatedAt;
  if (input.error !== undefined) {
    set.error = input.error
      ? {
          code: input.error.code.slice(0, 64),
          message: input.error.message.slice(0, 512),
          at: input.error.at || now,
        }
      : { code: null, message: null, at: null };
  }

  if (
    input.projectedCount !== undefined &&
    input.projectedCountIncrement !== undefined
  ) {
    throw new Error(
      "Requests projection projectedCount and projectedCountIncrement are mutually exclusive"
    );
  }

  const update: Record<string, unknown> = { $set: set };
  if (input.projectedCountIncrement) {
    update.$inc = { projectedCount: input.projectedCountIncrement };
  }

  const result = await checkpointCollection().updateOne(
    liveLeaseFilter(input.lease, now),
    update,
    { session: input.session }
  );
  if (result.matchedCount !== 1) {
    throw new RequestsProjectionCheckpointLeaseLostError();
  }
  return input.lease;
}

export async function releaseRequestsProjectionCheckpointLease(input: {
  lease: RequestsProjectionLease;
  now?: Date;
}): Promise<boolean> {
  const now = validDate(input.now || new Date(), "now");
  const result = await checkpointCollection().updateOne(
    {
      _id: REQUESTS_PROJECTION_CHECKPOINT_ID,
      fence: input.lease.fence,
      "lease.ownerToken": input.lease.ownerToken,
      "lease.fence": input.lease.fence,
    },
    { $set: { lease: null, updatedAt: now } }
  );
  return result.matchedCount === 1;
}

export async function readRequestsProjectionCheckpoint(): Promise<NormalizedRequestsProjectionCheckpointDocument | null> {
  const document = await checkpointCollection().findOne(
    { _id: REQUESTS_PROJECTION_CHECKPOINT_ID },
    { promoteLongs: false }
  );
  return document ? normalizeRequestsProjectionCheckpoint(document) : null;
}
