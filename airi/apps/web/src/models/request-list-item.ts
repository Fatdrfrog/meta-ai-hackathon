import mongoose, { Schema } from "mongoose";
import {
  REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT,
  REQUEST_LIST_ROW_MAX_BYTES,
  REQUEST_LIST_SCHEMA_VERSION,
  assertRequestListItemPayload,
  projectionInt64Field,
  projectionTimestampField,
  type RequestListItemDocument,
} from "@/lib/requests-projection/contract";

export const REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_NAME =
  "requests_projection_unread_ordered_v1";
export const REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_KEYS = {
  workspaceId: 1,
  sortAt: -1,
  _id: -1,
} as const;
export const REQUEST_LIST_ITEM_UNREAD_ORDERED_PARTIAL_FILTER = {
  deletedAt: null,
  "projection.status": "ready",
  unreadGeneration: { $type: "long" },
} as const;

const stringField = (maxLength = 512) => ({
  type: String,
  maxlength: maxLength,
  trim: true,
});

function isBoundedDisplayValue(value: unknown, depth = 0): boolean {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= 2048;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date ||
    value instanceof mongoose.Types.ObjectId
  ) {
    return true;
  }
  if (depth >= 8) return false;
  if (Array.isArray(value)) {
    return (
      value.length <= 64 &&
      value.every(item => isBoundedDisplayValue(item, depth + 1))
    );
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 64 &&
    entries.every(
      ([key, item]) =>
        Buffer.byteLength(key, "utf8") <= 128 &&
        isBoundedDisplayValue(item, depth + 1)
    )
  );
}

const boundedObject = {
  type: Schema.Types.Mixed,
  validate: {
    validator(value: unknown) {
      if (value === null || value === undefined) return true;
      try {
        return (
          isBoundedDisplayValue(value) &&
          Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096
        );
      } catch {
        return false;
      }
    },
    message: "{PATH} must be a bounded serializable object",
  },
};

const projectionSchema = new Schema<Record<string, unknown>>(
  {
    status: {
      type: String,
      enum: ["ready"],
      required: true,
    },
    generation: projectionInt64Field({ required: true }),
    fence: projectionInt64Field({ required: true }),
    sourceWatermark: projectionTimestampField({ required: true }),
    readStateWatermark: projectionTimestampField({ required: true }),
  },
  { _id: false, strict: "throw", minimize: false }
);

const participantsSchema = new Schema<Record<string, unknown>>(
  {
    from: {
      type: [{ type: String, maxlength: 256 }],
      default: [],
      validate: (value: string[]) => value.length <= 64,
    },
    to: {
      type: [{ type: String, maxlength: 256 }],
      default: [],
      validate: (value: string[]) => value.length <= 64,
    },
  },
  { _id: false, strict: "throw", minimize: false }
);

const RequestListItemSchema = new Schema<RequestListItemDocument>(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    workspaceId: { ...stringField(256), required: true },
    schemaVersion: {
      type: Number,
      enum: [REQUEST_LIST_SCHEMA_VERSION],
      required: true,
    },
    projectedAt: { type: Date, required: true },
    deletedAt: { type: Date },
    sortAt: Date,
    displayAt: Date,
    channel: stringField(64),
    status: stringField(128),
    category: stringField(256),
    internalLabels: {
      type: [{ type: String, maxlength: 256 }],
      default: undefined,
      validate: (value: string[] | undefined) => !value || value.length <= 64,
    },
    unreadGeneration: projectionInt64Field(),
    hasAiriReply: Boolean,
    isBestPractice: Boolean,
    customerSatisfactionScore: { type: Number, min: 0, max: 5 },
    slaDueAt: Date,
    hasChurnRisk: Boolean,
    churnRank: { type: Number },
    profileSearchText: stringField(8192),
    phoneDigits: stringField(64),
    createdAt: Date,
    lastInboundAt: { type: Date },
    sourceId: stringField(256),
    businessConnectionId: stringField(256),
    rename: stringField(1024),
    subject: stringField(1024),
    participants: { type: participantsSchema, default: undefined },
    customer: boundedObject,
    chat: boundedObject,
    classification: boundedObject,
    health: boundedObject,
    awaitingCsat: { type: Boolean },
    recentMessages: {
      type: [boundedObject],
      default: undefined,
      validate: (value: unknown[] | undefined) =>
        !value || value.length <= REQUEST_LIST_RECENT_MESSAGE_MAX_COUNT,
    },
    instagram: boundedObject,
    projection: { type: projectionSchema, required: true },
  },
  {
    collection: "request_list_items",
    strict: "throw",
    minimize: false,
    autoIndex: false,
    versionKey: false,
  }
);

// Optional serving optimization, provisioned by the general Mongo index owner.
// Keep it outside the sealed required projection index definitions.
RequestListItemSchema.index(REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_KEYS, {
  name: REQUEST_LIST_ITEM_UNREAD_ORDERED_INDEX_NAME,
  partialFilterExpression: REQUEST_LIST_ITEM_UNREAD_ORDERED_PARTIAL_FILTER,
});

RequestListItemSchema.pre("validate", function validateRequestListItem() {
  try {
    const payload = this.toObject({ depopulate: true });
    assertRequestListItemPayload(payload as never);
  } catch (error) {
    this.invalidate(
      "projection",
      error instanceof Error ? error.message : "Invalid request projection"
    );
  }
});

RequestListItemSchema.path("projection").validate(function boundedRow() {
  try {
    return (
      Buffer.byteLength(
        JSON.stringify(this.toObject({ depopulate: true }), (_key, value) =>
          typeof value === "bigint" ? value.toString() : value
        ),
        "utf8"
      ) <= REQUEST_LIST_ROW_MAX_BYTES
    );
  } catch {
    return false;
  }
}, `Request list payload exceeds ${REQUEST_LIST_ROW_MAX_BYTES} UTF-8 bytes`);

export const RequestListItem =
  (mongoose.models.RequestListItem as
    | mongoose.Model<RequestListItemDocument>
    | undefined) ||
  mongoose.model<RequestListItemDocument>(
    "RequestListItem",
    RequestListItemSchema
  );

export default RequestListItem;
