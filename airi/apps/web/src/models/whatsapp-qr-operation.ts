import mongoose, { Schema, type Model } from "mongoose";
import {
  assertRequiredSetOnInsertFields,
  installInvariantUpdateShapeGuard,
  isQueryValidationContext,
  resolveAtomicUpdateField,
  resolveValidationValue,
  type AtomicUpdateGuardOptions,
  type AtomicUpdateShape,
} from "@/models/mongoose-validation-context";
import { asNullableRecord, asRecord } from "@icecore/shared/lib/value-utils";

export const WHATSAPP_QR_OPERATION_KINDS = [
  "CREATE",
  "CONNECT",
  "APPLY_MESSAGE",
  "REPLACE",
  "MOVE",
  "SET_ROUTING",
  "DELETE",
  "SYNC_PROVIDER",
  "RECONCILE",
] as const;
export const WHATSAPP_QR_OPERATION_STATUSES = [
  "RUNNING",
  "RECONCILE_REQUIRED",
  "FAILED",
  "COMPLETED",
] as const;
export const WHATSAPP_QR_PROVIDER_STAGES = [
  "NOT_STARTED",
  "REQUEST_SENT",
  "RECONCILING",
  "CONFIRMED",
] as const;
type Status = (typeof WHATSAPP_QR_OPERATION_STATUSES)[number];
type TerminalResult = {
  outcome: "applied" | "failed";
  status: "FAILED" | "COMPLETED";
  codeId?: string;
  entryPointVersion: number;
  codeVersion?: number;
};
export type WhatsAppQrOperationRecord = {
  operationId: string;
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  codeId?: string;
  currentCodeId?: string;
  operationKeyHash: string;
  requestDigest: string;
  kind: (typeof WHATSAPP_QR_OPERATION_KINDS)[number];
  status: Status;
  expectedEntryPointVersion: number;
  expectedCodeVersion?: number;
  providerStage: (typeof WHATSAPP_QR_PROVIDER_STAGES)[number];
  providerCodeEvidence?: string;
  attemptedAt?: Date;
  observedAt?: Date;
  sanitizedError?: { code: string; retryable: boolean };
  cachedTerminalResult?: TerminalResult;
  lease: { ownerToken?: string; fence: number; expiresAt?: Date };
  cleanupAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};
const boundedRequiredString = {
  type: String,
  required: true,
  trim: true,
  maxlength: 256,
} as const;
const boundedOptionalString = {
  type: String,
  trim: true,
  maxlength: 256,
} as const;
const SHA256 = /^[a-f0-9]{64}$/;
const leaseSchema = new Schema<WhatsAppQrOperationRecord["lease"]>(
  {
    ownerToken: boundedOptionalString,
    fence: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    expiresAt: { type: Date },
  },
  { _id: false, strict: "throw" }
);
const errorSchema = new Schema<
  NonNullable<WhatsAppQrOperationRecord["sanitizedError"]>
>(
  {
    code: { ...boundedRequiredString, maxlength: 128 },
    retryable: { type: Boolean, required: true },
  },
  { _id: false, strict: "throw" }
);
const terminalResultSchema = new Schema<TerminalResult>(
  {
    outcome: { type: String, required: true, enum: ["applied", "failed"] },
    status: { type: String, required: true, enum: ["FAILED", "COMPLETED"] },
    codeId: boundedOptionalString,
    entryPointVersion: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    codeVersion: { type: Number, min: 0, validate: Number.isSafeInteger },
  },
  { _id: false, strict: "throw" }
);

function isTerminal(status: unknown): status is "FAILED" | "COMPLETED" {
  return status === "FAILED" || status === "COMPLETED";
}
function isActiveStatus(
  status: unknown
): status is "RUNNING" | "RECONCILE_REQUIRED" {
  return status === "RUNNING" || status === "RECONCILE_REQUIRED";
}
function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCanonicalNonemptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0
  );
}

function hasExactOperationIdentity(filter: unknown): boolean {
  const record = asNullableRecord(filter);
  return Boolean(
    record &&
      isCanonicalNonemptyString(record.operationId) &&
      isCanonicalNonemptyString(record.workspaceId) &&
      isCanonicalNonemptyString(record.entryPointId)
  );
}

function hasExactLeaseOwnerFence(filter: unknown): boolean {
  const record = asNullableRecord(filter);
  return Boolean(
    hasExactOperationIdentity(record) &&
      record &&
      isCanonicalNonemptyString(record["lease.ownerToken"]) &&
      Number.isSafeInteger(record["lease.fence"]) &&
      (record["lease.fence"] as number) >= 1
  );
}

function hasLiveLeaseExpiry(filter: unknown): boolean {
  const record = asNullableRecord(filter);
  const expires = asNullableRecord(record?.["lease.expiresAt"]);
  return expires?.$gt instanceof Date;
}

function hasExactLiveLeaseFilter(filter: unknown): boolean {
  const record = asNullableRecord(filter);
  return Boolean(
    record &&
      isActiveStatus(record.status) &&
      hasExactLeaseOwnerFence(record) &&
      hasLiveLeaseExpiry(record)
  );
}
function validDocumentState(context: unknown, status: Status): boolean {
  if (isQueryValidationContext(context)) return true;
  const cleanup = resolveValidationValue<Date>(context, "cleanupAt");
  const result = resolveValidationValue<TerminalResult>(
    context,
    "cachedTerminalResult"
  );
  if (!cleanup.known || !result.known) return false;
  const terminal = isTerminal(status);
  if (
    terminal !== Boolean(cleanup.value instanceof Date) ||
    terminal !== Boolean(result.value)
  )
    return false;
  return (
    !terminal ||
    (status === "COMPLETED"
      ? result.value?.outcome === "applied" &&
        result.value.status === "COMPLETED"
      : result.value?.outcome === "failed" && result.value.status === "FAILED")
  );
}
export const WHATSAPP_QR_OPERATION_INDEXES = [
  {
    key: { operationId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_operation_id_unique",
    },
  },
  {
    key: { workspaceId: 1, operationKeyHash: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_operation_workspace_idempotency_unique",
    },
  },
  {
    key: { workspaceId: 1, entryPointId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_operation_active_resource_unique",
      partialFilterExpression: {
        status: { $in: ["RUNNING", "RECONCILE_REQUIRED"] },
      },
    },
  },
  {
    key: { status: 1, "lease.expiresAt": 1 },
    options: { background: true, name: "whatsapp_qr_operation_status_lease" },
  },
  {
    key: { cleanupAt: 1 },
    options: {
      background: true,
      name: "whatsapp_qr_operation_cleanup_ttl",
      expireAfterSeconds: 0,
    },
  },
] as const;
const schema = new Schema<WhatsAppQrOperationRecord>(
  {
    operationId: boundedRequiredString,
    workspaceId: boundedRequiredString,
    entryPointId: boundedRequiredString,
    sourceId: boundedRequiredString,
    codeId: boundedOptionalString,
    currentCodeId: boundedOptionalString,
    operationKeyHash: { type: String, required: true, match: SHA256 },
    requestDigest: { type: String, required: true, match: SHA256 },
    kind: { type: String, required: true, enum: WHATSAPP_QR_OPERATION_KINDS },
    status: {
      type: String,
      required: true,
      enum: WHATSAPP_QR_OPERATION_STATUSES,
      validate: {
        validator(this: unknown, value: Status) {
          return validDocumentState(this, value);
        },
        message: "Terminal QR operations require cleanup and a cached result",
      },
    },
    expectedEntryPointVersion: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    expectedCodeVersion: {
      type: Number,
      min: 0,
      validate: Number.isSafeInteger,
    },
    providerStage: {
      type: String,
      required: true,
      enum: WHATSAPP_QR_PROVIDER_STAGES,
    },
    providerCodeEvidence: { type: String, trim: true, maxlength: 256 },
    attemptedAt: { type: Date },
    observedAt: { type: Date },
    sanitizedError: { type: errorSchema },
    cachedTerminalResult: { type: terminalResultSchema },
    lease: { type: leaseSchema, required: true },
    cleanupAt: { type: Date },
  },
  {
    collection: "whatsapp_qr_operations",
    timestamps: true,
    versionKey: false,
    strict: "throw",
  }
);
const REQUIRED_IDENTITY = [
  "operationId",
  "workspaceId",
  "entryPointId",
  "sourceId",
  "operationKeyHash",
  "requestDigest",
  "kind",
  "expectedEntryPointVersion",
] as const;
const OPTIONAL_TARGET_IDENTITY = [
  "codeId",
  "currentCodeId",
  "expectedCodeVersion",
] as const;
const IDENTITY = [...REQUIRED_IDENTITY, ...OPTIONAL_TARGET_IDENTITY] as const;
function assertOperationUpdate(
  shape: AtomicUpdateShape,
  options: AtomicUpdateGuardOptions
) {
  if (
    !options.upsert &&
    IDENTITY.some(path => resolveAtomicUpdateField(shape, path).touched)
  ) {
    throw new Error("QR operation command identity is immutable");
  }
  const status = resolveAtomicUpdateField<Status>(shape, "status");
  const cleanup = resolveAtomicUpdateField<Date>(shape, "cleanupAt");
  const result = resolveAtomicUpdateField<TerminalResult>(
    shape,
    "cachedTerminalResult"
  );
  if (options.upsert) {
    const misplacedIdentity = IDENTITY.filter(path => {
      const field = resolveAtomicUpdateField(shape, path);
      return field.touched && field.source !== "$setOnInsert";
    });
    if (misplacedIdentity.length > 0)
      throw new Error(
        `QR operation upsert identity must use $setOnInsert: ${misplacedIdentity.join(
          ", "
        )}`
      );
    assertRequiredSetOnInsertFields(shape, [
      ...REQUIRED_IDENTITY,
      "status",
      "providerStage",
      "lease",
    ]);
    if (
      !status.touched ||
      status.source !== "$setOnInsert" ||
      status.value !== "RUNNING"
    )
      throw new Error("QR operation upserts require initial RUNNING status");
    if (cleanup.touched || result.touched)
      throw new Error("QR operation upserts cannot carry cleanup or result");
    return;
  } else if (!status.touched) {
    if (cleanup.touched || result.touched)
      throw new Error("QR operation cleanup/result require a state transition");
    return;
  }
  if (!isTerminal(status.value)) {
    if (cleanup.touched || result.touched)
      throw new Error(
        "Active QR transitions cannot mutate cleanup or cached results"
      );
    return;
  }
  if (!cleanup.touched || !result.touched)
    throw new Error("QR operation terminal state requires cleanup and result");
  const terminal = isTerminal(status.value);
  if (
    (status.value === "COMPLETED" &&
      (result.value?.outcome !== "applied" ||
        result.value.status !== "COMPLETED")) ||
    (status.value === "FAILED" &&
      (result.value?.outcome !== "failed" || result.value.status !== "FAILED"))
  )
    throw new Error("QR terminal result must match status");
  if (
    terminal !== (cleanup.source === "$set") ||
    terminal !== (result.source === "$set")
  )
    throw new Error("QR operation terminal cleanup invariant failed");
}
installInvariantUpdateShapeGuard(
  schema,
  [
    ...IDENTITY,
    "status",
    "cleanupAt",
    "cachedTerminalResult",
    "providerStage",
    "providerCodeEvidence",
    "attemptedAt",
    "observedAt",
    "sanitizedError",
  ],
  assertOperationUpdate,
  {
    validationOnlyPaths: ["lease.fence"],
    monotonicIncrementPaths: ["lease.fence"],
  }
);
const PERSISTED_OPERATION_FIELDS = [
  ...IDENTITY,
  "status",
  "providerStage",
  "providerCodeEvidence",
  "attemptedAt",
  "observedAt",
  "sanitizedError",
  "cachedTerminalResult",
  "lease",
  "cleanupAt",
] as const;

schema.pre("save", function () {
  if (
    !this.isNew &&
    PERSISTED_OPERATION_FIELDS.some(path => this.isModified(path))
  ) {
    throw new Error(
      "Persistent QR operation writes require guarded atomic updates"
    );
  }
});

schema.pre(
  ["updateOne", "findOneAndUpdate"],
  { query: true, document: false },
  function () {
    const update = asNullableRecord(this.getUpdate());
    if (!update) {
      throw new Error("QR operation mutations must use update objects");
    }
    const options = this.getOptions();
    if (options.upsert === true) return;

    const set = asRecord(update.$set);
    const unset = asRecord(update.$unset);
    const inc = asRecord(update.$inc);
    const filter = asNullableRecord(this.getFilter());

    const statefulPaths = [
      "status",
      "providerStage",
      "providerCodeEvidence",
      "attemptedAt",
      "observedAt",
      "sanitizedError",
      "cachedTerminalResult",
      "cleanupAt",
    ] as const;
    const statefulTouched = statefulPaths.some(
      path => hasOwn(set, path) || hasOwn(unset, path)
    );
    if (statefulTouched && !hasExactLiveLeaseFilter(filter)) {
      throw new Error(
        "QR operation state mutations require exact operation and live lease CAS filters"
      );
    }

    const setOwner = hasOwn(set, "lease.ownerToken");
    const setExpires = hasOwn(set, "lease.expiresAt");
    const unsetOwner = hasOwn(unset, "lease.ownerToken");
    const unsetExpires = hasOwn(unset, "lease.expiresAt");
    const incrementFence = hasOwn(inc, "lease.fence");
    const touchesLease =
      setOwner ||
      setExpires ||
      unsetOwner ||
      unsetExpires ||
      incrementFence ||
      hasOwn(set, "lease") ||
      hasOwn(unset, "lease");
    if (!touchesLease) return;

    if (options.runValidators !== true) {
      throw new Error(
        "QR operation lease mutations require runValidators: true"
      );
    }
    if (hasOwn(set, "lease") || hasOwn(unset, "lease")) {
      throw new Error("QR operation leases require guarded nested updates");
    }

    const record = filter ?? {};
    const exactIdentity = hasExactOperationIdentity(record);
    const exactStatus = isActiveStatus(record.status);
    const fence = record["lease.fence"];
    const exactFence = Number.isSafeInteger(fence) && (fence as number) >= 0;

    const acquisition =
      setOwner &&
      setExpires &&
      !unsetOwner &&
      !unsetExpires &&
      incrementFence &&
      inc["lease.fence"] === 1 &&
      isCanonicalNonemptyString(set["lease.ownerToken"]) &&
      set["lease.expiresAt"] instanceof Date;
    if (acquisition) {
      const priorOwner = record["lease.ownerToken"];
      const ownerMissing = asNullableRecord(priorOwner)?.$exists === false;
      const sameOwner = priorOwner === set["lease.ownerToken"];
      const expiredOwner =
        isCanonicalNonemptyString(priorOwner) &&
        asNullableRecord(record["lease.expiresAt"])?.$lte instanceof Date;
      if (
        !exactIdentity ||
        !exactStatus ||
        !exactFence ||
        (!ownerMissing && !sameOwner && !expiredOwner)
      ) {
        throw new Error(
          "QR lease acquisition requires exact operation, active status, owner, and fence CAS filters"
        );
      }
      return;
    }

    const renewal =
      !setOwner &&
      setExpires &&
      !unsetOwner &&
      !unsetExpires &&
      !incrementFence &&
      set["lease.expiresAt"] instanceof Date;
    if (renewal) {
      if (!hasExactLiveLeaseFilter(record)) {
        throw new Error(
          "QR lease renewal requires exact operation, owner, fence, and live-expiry CAS filters"
        );
      }
      return;
    }

    const release =
      !setOwner && !setExpires && unsetOwner && unsetExpires && !incrementFence;
    if (release) {
      if (!exactIdentity || !exactStatus || !hasExactLeaseOwnerFence(record)) {
        throw new Error(
          "QR lease release requires exact operation, active status, owner, and fence CAS filters"
        );
      }
      return;
    }

    throw new Error(
      "QR lease ownership cannot be changed outside guarded CAS paths"
    );
  }
);
for (const index of WHATSAPP_QR_OPERATION_INDEXES)
  schema.index(index.key, index.options);
export const WhatsAppQrOperation =
  (mongoose.models.WhatsAppQrOperation as Model<WhatsAppQrOperationRecord>) ||
  mongoose.model<WhatsAppQrOperationRecord>("WhatsAppQrOperation", schema);
