import {
  projectionInt64Field,
  projectionTimestampField,
} from "@/lib/requests-projection/contract";
import {
  REQUESTS_PROJECTION_CHECKPOINT_COLLECTION,
  REQUESTS_PROJECTION_CHECKPOINT_ID,
} from "@icecore/shared/lib/requests-projection-checkpoint";
import mongoose, { Schema } from "mongoose";

export { REQUESTS_PROJECTION_CHECKPOINT_ID };

export type RequestsProjectionCheckpointState =
  | "initializing"
  | "backfilling"
  | "catching_up"
  | "ready"
  | "failed";

export type RequestsProjectionCheckpointLeaseDocument = {
  ownerToken: string;
  fence: mongoose.mongo.Long;
  claimedAt: Date;
  expiresAt: Date;
};

export type RequestsProjectionGenerationMode =
  | "cluster_time_v1"
  | "sequence_v2";

export type ReservedProjectionBoundary = {
  resumeTokenDigest: string;
  generation: mongoose.mongo.Long;
  sourceClusterTime: mongoose.mongo.Timestamp;
};

export type RequestsProjectionCheckpointDocument = {
  _id: typeof REQUESTS_PROJECTION_CHECKPOINT_ID;
  schemaVersion: 2;
  state: RequestsProjectionCheckpointState;
  fence: mongoose.mongo.Long;
  lease: RequestsProjectionCheckpointLeaseDocument | null;
  resumeToken: mongoose.mongo.Document | null;
  clusterTime: mongoose.mongo.Timestamp | null;
  backfillAfterId: mongoose.Types.ObjectId | null;
  projectedCount: number;
  activatedAt: Date | null;
  generationMode?: RequestsProjectionGenerationMode;
  lastProjectionGeneration?: mongoose.mongo.Long | null;
  inFlightBoundary?: ReservedProjectionBoundary | null;
  watermarkMigrationProgress?: mongoose.mongo.Document | null;
  watermarkMigrationCompletedAt?: Date | null;
  watermarkMigrationReceipt?: mongoose.mongo.Document | null;
  provisionReceipt?: mongoose.mongo.Document | null;
  generationTransitionReceipt?: mongoose.mongo.Document | null;
  error: {
    code: string | null;
    message: string | null;
    at: Date | null;
  };
  createdAt: Date;
  updatedAt: Date;
};

const leaseSchema = new Schema<Record<string, unknown>>(
  {
    ownerToken: { type: String, required: true, maxlength: 256 },
    fence: projectionInt64Field({ required: true }),
    claimedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { _id: false, strict: "throw", versionKey: false }
);

const reservedProjectionBoundarySchema = new Schema<Record<string, unknown>>(
  {
    resumeTokenDigest: {
      type: String,
      required: true,
      match: /^[0-9a-f]{64}$/,
    },
    generation: projectionInt64Field({ required: true }),
    sourceClusterTime: projectionTimestampField({ required: true }),
  },
  { _id: false, strict: "throw", versionKey: false }
);

const schema = new Schema<RequestsProjectionCheckpointDocument>(
  {
    _id: { type: String, required: true },
    schemaVersion: { type: Number, enum: [2], required: true },
    state: {
      type: String,
      enum: ["initializing", "backfilling", "catching_up", "ready", "failed"],
      required: true,
    },
    fence: projectionInt64Field({ required: true }),
    lease: { type: leaseSchema, default: null },
    resumeToken: { type: Schema.Types.Mixed, default: null },
    clusterTime: { type: Schema.Types.Mixed, default: null },
    backfillAfterId: { type: Schema.Types.ObjectId, default: null },
    projectedCount: { type: Number, min: 0, default: 0 },
    activatedAt: { type: Date, default: null },
    generationMode: {
      type: String,
      enum: ["cluster_time_v1", "sequence_v2"],
      required: false,
      default: undefined,
    },
    lastProjectionGeneration: {
      ...projectionInt64Field(),
      default: undefined,
    },
    inFlightBoundary: {
      type: reservedProjectionBoundarySchema,
      required: false,
      default: undefined,
    },
    watermarkMigrationProgress: {
      type: Schema.Types.Mixed,
      required: false,
      default: undefined,
    },
    watermarkMigrationCompletedAt: {
      type: Date,
      required: false,
      default: undefined,
    },
    watermarkMigrationReceipt: {
      type: Schema.Types.Mixed,
      required: false,
      default: undefined,
    },
    provisionReceipt: {
      type: Schema.Types.Mixed,
      required: false,
      default: undefined,
    },
    generationTransitionReceipt: {
      type: Schema.Types.Mixed,
      required: false,
      default: undefined,
    },
    error: {
      code: { type: String, maxlength: 64, default: null },
      message: { type: String, maxlength: 512, default: null },
      at: { type: Date, default: null },
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  {
    collection: REQUESTS_PROJECTION_CHECKPOINT_COLLECTION,
    strict: "throw",
    minimize: false,
    autoIndex: false,
    versionKey: false,
  }
);

schema.index(
  { "lease.expiresAt": 1 },
  {
    name: "requests_projection_checkpoint_lease_expiry_v2",
    partialFilterExpression: { lease: { $type: "object" } },
  }
);

export const RequestsProjectionCheckpoint =
  (mongoose.models.RequestsProjectionCheckpoint as
    | mongoose.Model<RequestsProjectionCheckpointDocument>
    | undefined) ||
  mongoose.model<RequestsProjectionCheckpointDocument>(
    "RequestsProjectionCheckpoint",
    schema
  );

export default RequestsProjectionCheckpoint;
