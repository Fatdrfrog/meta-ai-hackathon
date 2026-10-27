import mongoose, { Schema, type Model } from "mongoose";

import type { EncryptedString } from "@/lib/crypto";
import { EncryptedStringSchema } from "@/models/encrypted-string-schema";
import {
  assertRequiredSetOnInsertFields,
  installInvariantUpdateShapeGuard,
  resolveAtomicUpdateField,
  resolveValidationValue,
  type AtomicUpdateGuardOptions,
  type AtomicUpdateShape,
} from "@/models/mongoose-validation-context";

export const WHATSAPP_FLOW_SESSION_STATUSES = [
  "ACTIVE",
  "COMPLETED",
  "REVOKED",
] as const;

export type WhatsAppFlowSessionSecrets = {
  encryptedJti: EncryptedString;
  jtiHash: string;
};

export type WhatsAppFlowSessionRecord = WhatsAppFlowSessionSecrets & {
  sessionId: string;
  issuanceKeyHash: string;
  signingKeyId: string;
  routingDigest: string;
  endpointId: string;
  workspaceId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  flowId: string;
  status: (typeof WHATSAPP_FLOW_SESSION_STATUSES)[number];
  issuedAt: Date;
  expiresAt: Date;
  cleanupAt: Date;
  terminalDigest?: string;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

const boundedRequiredString = {
  type: String,
  required: true,
  trim: true,
  maxlength: 256,
} as const;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_INSERTION_ONLY_PATHS = [
  "sessionId",
  "issuanceKeyHash",
  "encryptedJti",
  "jtiHash",
  "signingKeyId",
  "routingDigest",
  "endpointId",
  "workspaceId",
  "sourceId",
  "wabaId",
  "phoneNumberId",
  "flowId",
  "issuedAt",
  "expiresAt",
  "cleanupAt",
] as const;
const SESSION_REQUIRED_INSERT_PATHS = [
  ...SESSION_INSERTION_ONLY_PATHS,
  "status",
] as const;
const SESSION_INVARIANT_PATHS = [
  ...SESSION_REQUIRED_INSERT_PATHS,
  "terminalDigest",
  "completedAt",
] as const;

function isStrictlyLater(value: unknown, boundary: unknown): boolean {
  return (
    value instanceof Date &&
    boundary instanceof Date &&
    value.getTime() > boundary.getTime()
  );
}

function isSessionTerminalFieldRequired(context: unknown): boolean {
  const status = resolveValidationValue<WhatsAppFlowSessionRecord["status"]>(
    context,
    "status"
  );
  return !status.known || status.value === "COMPLETED";
}

function validateSessionStatusContext(
  context: unknown,
  status: WhatsAppFlowSessionRecord["status"]
): boolean {
  const terminalDigest = resolveValidationValue<string>(
    context,
    "terminalDigest"
  );
  const completedAt = resolveValidationValue<Date>(context, "completedAt");

  if (status === "COMPLETED") {
    return (
      terminalDigest.known &&
      typeof terminalDigest.value === "string" &&
      completedAt.known &&
      completedAt.value instanceof Date
    );
  }

  return (
    (!terminalDigest.known ||
      terminalDigest.value === undefined ||
      terminalDigest.value === null) &&
    (!completedAt.known ||
      completedAt.value === undefined ||
      completedAt.value === null)
  );
}

function assertSessionInvariantUpdateShape(
  shape: AtomicUpdateShape,
  options: AtomicUpdateGuardOptions
): void {
  const status = resolveAtomicUpdateField<WhatsAppFlowSessionRecord["status"]>(
    shape,
    "status"
  );
  const terminalDigest = resolveAtomicUpdateField<string>(
    shape,
    "terminalDigest"
  );
  const completedAt = resolveAtomicUpdateField<Date>(shape, "completedAt");
  const issuedAt = resolveAtomicUpdateField<Date>(shape, "issuedAt");
  const expiresAt = resolveAtomicUpdateField<Date>(shape, "expiresAt");
  const cleanupAt = resolveAtomicUpdateField<Date>(shape, "cleanupAt");

  if (options.upsert) {
    assertRequiredSetOnInsertFields(shape, SESSION_REQUIRED_INSERT_PATHS);
    if (
      !status.touched ||
      status.value !== "ACTIVE" ||
      !issuedAt.touched ||
      !(issuedAt.value instanceof Date) ||
      !expiresAt.touched ||
      !(expiresAt.value instanceof Date) ||
      !cleanupAt.touched ||
      !(cleanupAt.value instanceof Date) ||
      !isStrictlyLater(expiresAt.value, issuedAt.value) ||
      !isStrictlyLater(cleanupAt.value, expiresAt.value)
    ) {
      throw new Error(
        "Inserted sessions require ACTIVE status and ordered issuance deadlines"
      );
    }
    if (terminalDigest.touched || completedAt.touched) {
      throw new Error(
        "Session issuance upserts cannot include terminal state transitions"
      );
    }
    return;
  }

  const mutatedInsertionPath = SESSION_INSERTION_ONLY_PATHS.find(path => {
    const field = resolveAtomicUpdateField(shape, path);
    return field.touched;
  });
  if (mutatedInsertionPath !== undefined) {
    throw new Error(
      `Existing sessions cannot mutate insertion-only field ${mutatedInsertionPath}`
    );
  }

  if (!status.touched) {
    if (terminalDigest.touched || completedAt.touched) {
      throw new Error(
        "Session terminal fields must transition atomically with status"
      );
    }
    return;
  }

  if (status.source !== "$set") {
    throw new Error("Session status must use an allowed atomic transition");
  }

  if (status.value === "COMPLETED") {
    if (
      !terminalDigest.touched ||
      terminalDigest.source !== "$set" ||
      typeof terminalDigest.value !== "string" ||
      !completedAt.touched ||
      completedAt.source !== "$set" ||
      !(completedAt.value instanceof Date)
    ) {
      throw new Error(
        "Completed sessions require terminalDigest and completedAt in the same $set"
      );
    }
    return;
  }

  if (status.value === "REVOKED") {
    if (
      !terminalDigest.touched ||
      terminalDigest.source !== "$unset" ||
      !completedAt.touched ||
      completedAt.source !== "$unset"
    ) {
      throw new Error(
        "Non-completed session transitions must unset both terminal fields"
      );
    }
    return;
  }

  throw new Error(
    "Existing sessions can transition only to COMPLETED or REVOKED"
  );
}

export const WHATSAPP_FLOW_SESSION_INDEXES = [
  {
    key: { sessionId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_session_id_unique",
    },
  },
  {
    key: { issuanceKeyHash: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_session_issuance_key_hash_unique",
    },
  },
  {
    key: { jtiHash: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_session_jti_hash_unique",
    },
  },
  {
    key: { endpointId: 1, status: 1, expiresAt: 1 },
    options: {
      background: true,
      name: "whatsapp_flow_session_endpoint_status_expires",
    },
  },
  {
    key: { cleanupAt: 1 },
    options: {
      background: true,
      name: "whatsapp_flow_session_cleanup_ttl",
      expireAfterSeconds: 0,
    },
  },
] as const;

const WhatsAppFlowSessionSchema = new Schema<WhatsAppFlowSessionRecord>(
  {
    sessionId: boundedRequiredString,
    issuanceKeyHash: {
      type: String,
      required: true,
      match: SHA256_HEX_PATTERN,
    },
    encryptedJti: {
      type: EncryptedStringSchema,
      required: true,
    },
    jtiHash: {
      type: String,
      required: true,
      match: SHA256_HEX_PATTERN,
    },
    signingKeyId: boundedRequiredString,
    routingDigest: {
      type: String,
      required: true,
      match: SHA256_HEX_PATTERN,
    },
    endpointId: boundedRequiredString,
    workspaceId: boundedRequiredString,
    sourceId: boundedRequiredString,
    wabaId: boundedRequiredString,
    phoneNumberId: boundedRequiredString,
    flowId: boundedRequiredString,
    status: {
      type: String,
      enum: WHATSAPP_FLOW_SESSION_STATUSES,
      required: true,
      default: "ACTIVE",
      validate: {
        validator(this: unknown, value: WhatsAppFlowSessionRecord["status"]) {
          return validateSessionStatusContext(this, value);
        },
        message:
          "Completed sessions require terminal fields in the same validated state transition",
      },
    },
    issuedAt: { type: Date, required: true },
    expiresAt: {
      type: Date,
      required: true,
      validate: {
        validator(this: unknown, value: Date) {
          const issuedAt = resolveValidationValue<Date>(this, "issuedAt");
          return issuedAt.known && isStrictlyLater(value, issuedAt.value);
        },
        message: "expiresAt must be strictly later than issuedAt",
      },
    },
    cleanupAt: {
      type: Date,
      required: true,
      validate: {
        validator(this: unknown, value: Date) {
          const expiresAt = resolveValidationValue<Date>(this, "expiresAt");
          return expiresAt.known && isStrictlyLater(value, expiresAt.value);
        },
        message: "cleanupAt must be strictly later than expiresAt",
      },
    },
    terminalDigest: {
      type: String,
      match: SHA256_HEX_PATTERN,
      required(this: unknown) {
        return isSessionTerminalFieldRequired(this);
      },
      validate: {
        validator(this: unknown, value: string | undefined) {
          const status = resolveValidationValue<
            WhatsAppFlowSessionRecord["status"]
          >(this, "status");
          if (!status.known) {
            return false;
          }
          return status.value === "COMPLETED"
            ? typeof value === "string"
            : value === undefined || value === null;
        },
        message:
          "terminalDigest is required only for completed WhatsApp Flow sessions",
      },
    },
    completedAt: {
      type: Date,
      required(this: unknown) {
        return isSessionTerminalFieldRequired(this);
      },
      validate: {
        validator(this: unknown, value: Date | undefined) {
          const status = resolveValidationValue<
            WhatsAppFlowSessionRecord["status"]
          >(this, "status");
          if (!status.known) {
            return false;
          }
          return status.value === "COMPLETED"
            ? value instanceof Date
            : value === undefined || value === null;
        },
        message:
          "completedAt is required only for completed WhatsApp Flow sessions",
      },
    },
  },
  {
    collection: "whatsapp_flow_sessions",
    timestamps: true,
    versionKey: false,
    strict: "throw",
  }
);

for (const index of WHATSAPP_FLOW_SESSION_INDEXES) {
  WhatsAppFlowSessionSchema.index(index.key, index.options);
}

installInvariantUpdateShapeGuard(
  WhatsAppFlowSessionSchema,
  SESSION_INVARIANT_PATHS,
  assertSessionInvariantUpdateShape
);

export const WhatsAppFlowSession =
  (mongoose.models.WhatsAppFlowSession as Model<WhatsAppFlowSessionRecord>) ||
  mongoose.model<WhatsAppFlowSessionRecord>(
    "WhatsAppFlowSession",
    WhatsAppFlowSessionSchema
  );
