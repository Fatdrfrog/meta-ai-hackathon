import mongoose from "mongoose";
import { createHash } from "node:crypto";

export const REQUEST_LIST_SCHEMA_VERSION = 1 as const;
export const REQUEST_LIST_ROW_MAX_BYTES = 16 * 1024;
export const REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT = 2;
export const REQUEST_PROJECTION_ID_MAX_BYTES = 256;

export type ProjectionInt64 = bigint | mongoose.mongo.Long;
export type RequestProjectionWorkState = {
  status: "ready";
  generation: ProjectionInt64;
  fence: ProjectionInt64;
  sourceWatermark: mongoose.mongo.Timestamp;
  readStateWatermark: mongoose.mongo.Timestamp;
};

type BoundedProjectionObject = Record<string, unknown>;

export type RequestListItemPayload = {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  schemaVersion: typeof REQUEST_LIST_SCHEMA_VERSION;
  projectedAt: Date;
  deletedAt?: Date | null;
  sortAt?: Date;
  displayAt?: Date;
  channel?: string | null;
  status?: string;
  category?: string | null;
  internalLabels?: string[];
  unreadGeneration?: ProjectionInt64 | null;
  hasAiriReply?: boolean;
  isBestPractice?: boolean;
  customerSatisfactionScore?: number | null;
  slaDueAt?: Date;
  // Retired: no longer derived or read. Kept while the RequestListItem
  // schema still declares these paths (rows projected earlier carry them).
  hasChurnRisk?: boolean;
  churnRank?: number | null;
  profileSearchText?: string;
  phoneDigits?: string | null;
  createdAt?: Date;
  lastInboundAt?: Date | null;
  sourceId?: string | null;
  businessConnectionId?: string | null;
  rename?: string | null;
  subject?: string | null;
  participants?: { from: string[]; to: string[] };
  customer?: BoundedProjectionObject;
  chat?: BoundedProjectionObject;
  classification?: BoundedProjectionObject;
  /** Retired with hasChurnRisk/churnRank. */
  health?: BoundedProjectionObject;
  awaitingCsat?: boolean | null;
  recentMessages?: BoundedProjectionObject[];
  instagram?: BoundedProjectionObject | null;
  projection: RequestProjectionWorkState;
};

export type RequestListItemDocument = RequestListItemPayload & {
  createdAt?: Date;
  updatedAt?: Date;
};

export type RequestProjectionSource = {
  conversation: Record<string, unknown>;
  messages: readonly Record<string, unknown>[];
  users: readonly Record<string, unknown>[];
  chat: Record<string, unknown> | null;
  airiWitness: Record<string, unknown> | null;
};

export type RequestProjectionTombstone = Pick<
  RequestListItemPayload,
  | "_id"
  | "workspaceId"
  | "schemaVersion"
  | "projectedAt"
  | "deletedAt"
  | "projection"
> & { deletedAt: Date };

const LIVE_REQUIRED_FIELDS = [
  "sortAt",
  "displayAt",
  "status",
  "internalLabels",
  "hasAiriReply",
  "isBestPractice",
  "slaDueAt",
  "profileSearchText",
  "createdAt",
  "recentMessages",
] as const;

const TOMBSTONE_FORBIDDEN_FIELDS = [
  ...LIVE_REQUIRED_FIELDS,
  "channel",
  "category",
  "unreadGeneration",
  "customerSatisfactionScore",
  "hasChurnRisk",
  "churnRank",
  "phoneDigits",
  "lastInboundAt",
  "sourceId",
  "businessConnectionId",
  "rename",
  "subject",
  "participants",
  "customer",
  "chat",
  "classification",
  "health",
  "awaitingCsat",
  "instagram",
] as const;

function projectionJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    return item;
  });
}

export function requestListPayloadUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(projectionJson(value), "utf8");
}

export function assertRequestListPayloadWithinByteCap(value: unknown): void {
  const bytes = requestListPayloadUtf8Bytes(value);
  if (bytes > REQUEST_LIST_ROW_MAX_BYTES) {
    throw new Error(
      `Request list payload exceeds ${REQUEST_LIST_ROW_MAX_BYTES} UTF-8 bytes (${bytes})`
    );
  }
}

function hasValue(record: Record<string, unknown>, key: string): boolean {
  return record[key] !== undefined && record[key] !== null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const PROJECTION_ALLOWED_FIELDS = new Set([
  "status",
  "generation",
  "fence",
  "sourceWatermark",
  "readStateWatermark",
]);

function isProjectionInt64(value: unknown): value is ProjectionInt64 {
  return typeof value === "bigint" || value instanceof mongoose.mongo.Long;
}

function assertReadyProjectionState(value: unknown): void {
  const projection =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!projection || projection.status !== "ready") {
    throw new Error("Request projection state must be ready");
  }
  const unsupported = Object.keys(projection).filter(
    field => !PROJECTION_ALLOWED_FIELDS.has(field)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Request projection state contains unsupported fields: ${unsupported.join(", ")}`
    );
  }
  for (const field of ["generation", "fence"] as const) {
    if (!isProjectionInt64(projection[field])) {
      throw new Error(`Request projection ${field} must be int64`);
    }
  }
  for (const field of ["sourceWatermark", "readStateWatermark"] as const) {
    if (!(projection[field] instanceof mongoose.mongo.Timestamp)) {
      throw new Error(`Request projection ${field} must be a BSON Timestamp`);
    }
  }
}

export function encodeRequestProjectionWatermark(
  value: mongoose.mongo.Timestamp
): string {
  if (!(value instanceof mongoose.mongo.Timestamp)) {
    throw new TypeError(
      "Request projection watermark must be a BSON Timestamp"
    );
  }
  return value.toBigInt().toString(16).padStart(16, "0");
}

export function assertRequestListItemPayload<T extends RequestListItemPayload>(
  payload: T
): T {
  if (payload.schemaVersion !== REQUEST_LIST_SCHEMA_VERSION) {
    throw new Error("Unsupported request list schema version");
  }
  if (payload.recentMessages && payload.recentMessages.length > 2) {
    throw new Error("Request list payload has more than two message previews");
  }
  for (const [field, value] of [
    ["workspaceId", payload.workspaceId],
    ["sourceId", payload.sourceId],
    ["businessConnectionId", payload.businessConnectionId],
  ] as const) {
    if (
      typeof value === "string" &&
      Buffer.byteLength(value, "utf8") > REQUEST_PROJECTION_ID_MAX_BYTES
    ) {
      throw new Error(
        `${field} exceeds ${REQUEST_PROJECTION_ID_MAX_BYTES} UTF-8 bytes`
      );
    }
  }

  assertReadyProjectionState(payload.projection);

  const record = payload as unknown as Record<string, unknown>;
  if (payload.deletedAt instanceof Date) {
    const present = TOMBSTONE_FORBIDDEN_FIELDS.filter(field =>
      hasOwn(record, field)
    );
    if (present.length > 0) {
      throw new Error(
        `Request projection tombstone contains live fields: ${present.join(", ")}`
      );
    }
  } else {
    const missing = LIVE_REQUIRED_FIELDS.filter(
      field => !hasValue(record, field)
    );
    if (missing.length > 0) {
      throw new Error(
        `Request list payload is missing fields: ${missing.join(", ")}`
      );
    }
  }

  assertRequestListPayloadWithinByteCap(payload);
  return payload;
}

export function encodeRequestDependencyKey(value: unknown): string {
  let type: "o" | "n" | "s";
  let canonical: string;
  if (value instanceof mongoose.Types.ObjectId) {
    type = "o";
    canonical = value.toHexString();
  } else if (typeof value === "number" && Number.isFinite(value)) {
    type = "n";
    canonical = Object.is(value, -0) ? "-0" : String(value);
  } else if (typeof value === "string") {
    type = "s";
    canonical = value;
  } else {
    throw new TypeError(
      "Request dependency identity must be ObjectId, number, or string"
    );
  }
  return `${type}:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function requireProjectionInt64Input(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof mongoose.mongo.Long) return value;
  if (typeof value === "bigint") {
    return mongoose.mongo.Long.fromBigInt(value);
  }
  throw new TypeError(
    "Projection int64 fields require bigint or BSON Long input"
  );
}

function requireProjectionTimestampInput(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof mongoose.mongo.Timestamp) return value;
  throw new TypeError(
    "Projection timestamp fields require native BSON Timestamp input"
  );
}

export function projectionInt64Field({
  required = false,
}: {
  required?: boolean;
} = {}) {
  return {
    // Mixed preserves the driver's exact BSON Long instance. Mongoose's
    // BigInt schema type converts values through JavaScript bigint and makes
    // exact promoteLongs:false boundaries harder to type and reason about.
    type: mongoose.Schema.Types.Mixed,
    required,
    set: requireProjectionInt64Input,
    validate: {
      validator(value: unknown) {
        return (
          value === null ||
          value === undefined ||
          value instanceof mongoose.mongo.Long
        );
      },
      message: "{PATH} must be a BSON Long",
    },
  } as const;
}

export function projectionTimestampField({
  required = false,
}: {
  required?: boolean;
} = {}) {
  const requiredOption: false | [boolean, string] = required
    ? [true, "{PATH} must be a BSON Timestamp"]
    : false;
  return {
    type: mongoose.Schema.Types.Mixed,
    required: requiredOption,
    set: requireProjectionTimestampInput,
    validate: {
      validator(value: unknown) {
        return (
          value === null ||
          value === undefined ||
          value instanceof mongoose.mongo.Timestamp
        );
      },
      message: "{PATH} must be a BSON Timestamp",
    },
  } as const;
}
