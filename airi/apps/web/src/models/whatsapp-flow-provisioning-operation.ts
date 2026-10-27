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
import {
  WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES,
  WHATSAPP_FLOW_PROVISIONING_RELEASE_MODES,
  WHATSAPP_FLOW_PROVISIONING_STAGES,
  WHATSAPP_FLOW_PROVISIONING_STATUSES,
} from "@/lib/whatsapp/flows/provisioning-contract";

const RETRYABLE_PROVISIONING_STATUSES = new Set<
  (typeof WHATSAPP_FLOW_PROVISIONING_STATUSES)[number]
>(["RUNNING", "FAILED"]);

export type WhatsAppFlowProvisioningError = {
  code: string;
  message: string;
  stage: (typeof WHATSAPP_FLOW_PROVISIONING_STAGES)[number];
  providerCode?: number;
  providerSubcode?: number;
  retryable: boolean;
  at: Date;
};

export type WhatsAppFlowProvisioningProviderResolution = {
  kind: "published_deprecated" | "draft_deleted";
  requestedAt: Date;
  requestedBy: string;
  outcome?: "deprecated" | "missing";
  confirmedAt?: Date;
  confirmedBy?: string;
};

export type WhatsAppFlowProvisioningOperationRecord = {
  operationId: string;
  operationKeyHash: string;
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  targetOwner: "template" | "service_message";
  sourceId: string;
  wabaId: string;
  releaseMode: (typeof WHATSAPP_FLOW_PROVISIONING_RELEASE_MODES)[number];
  endpointId?: string;
  applicationId?: string;
  replacesOperationId?: string;
  cloneFlowId?: string;
  contentRevision: number;
  contentDigest: string;
  providerMarker: string;
  providerFlowId?: string;
  providerAcknowledgedAt?: Date;
  providerFlowName?: string;
  providerStatus?: (typeof WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES)[number];
  stage: (typeof WHATSAPP_FLOW_PROVISIONING_STAGES)[number];
  status: (typeof WHATSAPP_FLOW_PROVISIONING_STATUSES)[number];
  lastError?: WhatsAppFlowProvisioningError;
  lease: {
    ownerToken?: string;
    fence: number;
    expiresAt?: Date;
  };
  providerResolution?: WhatsAppFlowProvisioningProviderResolution;
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
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const PROVISIONING_IDENTITY_PATHS = [
  "operationId",
  "operationKeyHash",
  "workspaceId",
  "scenarioId",
  "nodeId",
  "targetOwner",
  "sourceId",
  "wabaId",
  "releaseMode",
  "endpointId",
  "applicationId",
  "replacesOperationId",
  "cloneFlowId",
  "contentRevision",
  "contentDigest",
  "providerMarker",
] as const;
const PROVISIONING_INVARIANT_PATHS = [
  ...PROVISIONING_IDENTITY_PATHS,
  "providerFlowId",
  "providerAcknowledgedAt",
  "status",
  "stage",
  "providerResolution",
  "cleanupAt",
] as const;
const PROVISIONING_REQUIRED_INSERT_PATHS = [
  "operationId",
  "operationKeyHash",
  "workspaceId",
  "scenarioId",
  "nodeId",
  "targetOwner",
  "sourceId",
  "wabaId",
  "releaseMode",
  "providerMarker",
  "contentRevision",
  "contentDigest",
  "stage",
  "status",
  "lease",
] as const;

function validateProvisioningReleaseBindingContext(context: unknown): boolean {
  if (isQueryValidationContext(context)) {
    // Atomic insert/update shape validation below owns query invariants. Mongoose
    // does not expose absent optional fields reliably from update validators.
    return true;
  }
  const releaseMode = resolveValidationValue<
    WhatsAppFlowProvisioningOperationRecord["releaseMode"]
  >(context, "releaseMode");
  const endpointId = resolveValidationValue<string>(context, "endpointId");
  const applicationId = resolveValidationValue<string>(
    context,
    "applicationId"
  );
  if (!releaseMode.known || !endpointId.known || !applicationId.known) {
    return false;
  }
  if (releaseMode.value === "data_endpoint") {
    return Boolean(endpointId.value?.trim() && applicationId.value?.trim());
  }
  return (
    releaseMode.value === "linear" &&
    (endpointId.value === undefined || endpointId.value === null) &&
    (applicationId.value === undefined || applicationId.value === null)
  );
}

function isProvisioningEndpointBindingRequired(context: unknown): boolean {
  const releaseMode = resolveValidationValue<
    WhatsAppFlowProvisioningOperationRecord["releaseMode"]
  >(context, "releaseMode");
  return !releaseMode.known || releaseMode.value === "data_endpoint";
}

function validateProviderAcknowledgementContext(context: unknown): boolean {
  if (isQueryValidationContext(context)) {
    // The atomic update-shape guard owns query pairing. Mongoose update
    // validators cannot distinguish an absent stored value from an omitted
    // update path.
    return true;
  }
  const providerFlowId = resolveValidationValue<string>(
    context,
    "providerFlowId"
  );
  const providerAcknowledgedAt = resolveValidationValue<Date>(
    context,
    "providerAcknowledgedAt"
  );
  if (!providerFlowId.known || !providerAcknowledgedAt.known) return false;

  const hasProviderFlowId =
    providerFlowId.value !== undefined && providerFlowId.value !== null;
  const hasAcknowledgedAt =
    providerAcknowledgedAt.value !== undefined &&
    providerAcknowledgedAt.value !== null;
  if (hasProviderFlowId !== hasAcknowledgedAt) return false;
  if (!hasProviderFlowId) return true;

  return (
    typeof providerFlowId.value === "string" &&
    Boolean(providerFlowId.value.trim()) &&
    providerAcknowledgedAt.value instanceof Date &&
    Number.isFinite(providerAcknowledgedAt.value.getTime())
  );
}

function isRetryableProvisioningStatus(
  status: unknown
): status is "RUNNING" | "FAILED" {
  return RETRYABLE_PROVISIONING_STATUSES.has(
    status as (typeof WHATSAPP_FLOW_PROVISIONING_STATUSES)[number]
  );
}

function isProviderResolutionEvidenceRecord(
  value: unknown
): value is WhatsAppFlowProvisioningProviderResolution {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProviderResolutionKind(
  value: unknown
): value is WhatsAppFlowProvisioningProviderResolution["kind"] {
  return value === "published_deprecated" || value === "draft_deleted";
}

function isRequestedProviderResolutionEvidence(
  value: unknown
): value is WhatsAppFlowProvisioningProviderResolution & {
  outcome?: undefined;
  confirmedAt?: undefined;
  confirmedBy?: undefined;
} {
  if (!isProviderResolutionEvidenceRecord(value)) return false;
  return (
    isProviderResolutionKind(value.kind) &&
    value.requestedAt instanceof Date &&
    Number.isFinite(value.requestedAt.getTime()) &&
    typeof value.requestedBy === "string" &&
    Boolean(value.requestedBy.trim()) &&
    value.outcome === undefined &&
    value.confirmedAt === undefined &&
    value.confirmedBy === undefined
  );
}

function isConfirmedProviderResolutionEvidence(
  value: unknown
): value is WhatsAppFlowProvisioningProviderResolution & {
  outcome: "deprecated" | "missing";
  confirmedAt: Date;
  confirmedBy: string;
} {
  if (!isProviderResolutionEvidenceRecord(value)) return false;
  return (
    isProviderResolutionKind(value.kind) &&
    value.requestedAt instanceof Date &&
    Number.isFinite(value.requestedAt.getTime()) &&
    typeof value.requestedBy === "string" &&
    Boolean(value.requestedBy.trim()) &&
    (value.outcome === "deprecated" || value.outcome === "missing") &&
    value.confirmedAt instanceof Date &&
    Number.isFinite(value.confirmedAt.getTime()) &&
    value.confirmedAt.getTime() >= value.requestedAt.getTime() &&
    typeof value.confirmedBy === "string" &&
    Boolean(value.confirmedBy.trim())
  );
}

function isMissingProviderDraftResolutionError(
  value: unknown
): value is WhatsAppFlowProvisioningError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const error = value as Partial<WhatsAppFlowProvisioningError>;
  return (
    error.code === "WHATSAPP_FLOW_PROVISIONING_CREATE_FAILED" &&
    typeof error.message === "string" &&
    Boolean(error.message.trim()) &&
    error.message.length <= 1_024 &&
    error.stage === "CREATING_FLOW" &&
    error.retryable === true &&
    error.at instanceof Date &&
    Number.isFinite(error.at.getTime()) &&
    (error.providerCode === undefined ||
      Number.isSafeInteger(error.providerCode)) &&
    (error.providerSubcode === undefined ||
      Number.isSafeInteger(error.providerSubcode))
  );
}

function validateProvisioningStateContext(context: unknown): boolean {
  const status = resolveValidationValue<
    WhatsAppFlowProvisioningOperationRecord["status"]
  >(context, "status");
  const stage = resolveValidationValue<
    WhatsAppFlowProvisioningOperationRecord["stage"]
  >(context, "stage");
  const cleanupAt = resolveValidationValue<Date>(context, "cleanupAt");
  const providerResolution =
    resolveValidationValue<WhatsAppFlowProvisioningProviderResolution>(
      context,
      "providerResolution"
    );
  const providerStatus = resolveValidationValue<
    WhatsAppFlowProvisioningOperationRecord["providerStatus"]
  >(context, "providerStatus");
  const providerFlowId = resolveValidationValue<string>(
    context,
    "providerFlowId"
  );
  const lastError = resolveValidationValue<WhatsAppFlowProvisioningError>(
    context,
    "lastError"
  );
  if (!status.known || !stage.known) {
    return false;
  }

  if (!cleanupAt.known) {
    if (!isQueryValidationContext(context)) return false;
    return isRetryableProvisioningStatus(status.value)
      ? stage.value !== "COMPLETED"
      : status.value === "COMPLETED" && stage.value === "COMPLETED";
  }

  if (isRetryableProvisioningStatus(status.value)) {
    return (
      stage.value !== "COMPLETED" &&
      (cleanupAt.value === undefined || cleanupAt.value === null)
    );
  }

  if (status.value === "COMPLETED") {
    return (
      stage.value === "COMPLETED" &&
      (cleanupAt.value === undefined || cleanupAt.value === null)
    );
  }

  if (status.value === "SUPERSEDED") {
    const validState =
      cleanupAt.value === undefined ||
      cleanupAt.value === null ||
      cleanupAt.value instanceof Date;
    if (!validState) return false;
    return (
      !providerResolution.known ||
      providerResolution.value === undefined ||
      isRequestedProviderResolutionEvidence(providerResolution.value)
    );
  }
  if (
    status.value !== "MANUALLY_RESOLVED" ||
    !(cleanupAt.value instanceof Date)
  ) {
    return false;
  }

  if (
    providerResolution.known &&
    isConfirmedProviderResolutionEvidence(providerResolution.value)
  ) {
    const resolutionMatchesOutcome =
      providerResolution.value.kind === "published_deprecated" ||
      providerResolution.value.outcome === "missing";
    if (!resolutionMatchesOutcome || !providerStatus.known) return false;
    return providerResolution.value.outcome === "deprecated"
      ? providerStatus.value === "DEPRECATED"
      : providerStatus.value === undefined;
  }

  const providerMissingDraftResolution =
    stage.value === "CREATING_FLOW" &&
    (!providerResolution.known || providerResolution.value === undefined) &&
    providerStatus.known &&
    providerStatus.value === undefined &&
    lastError.known &&
    isMissingProviderDraftResolutionError(lastError.value);
  if (isQueryValidationContext(context)) {
    return providerMissingDraftResolution;
  }
  return (
    providerMissingDraftResolution &&
    providerFlowId.known &&
    typeof providerFlowId.value === "string" &&
    Boolean(providerFlowId.value.trim())
  );
}

function isProvisioningCleanupRequired(context: unknown): boolean {
  const status = resolveValidationValue<
    WhatsAppFlowProvisioningOperationRecord["status"]
  >(context, "status");
  return !status.known || status.value === "MANUALLY_RESOLVED";
}

function assertProvisioningInvariantUpdateShape(
  shape: AtomicUpdateShape,
  options: AtomicUpdateGuardOptions
): void {
  const status = resolveAtomicUpdateField<
    WhatsAppFlowProvisioningOperationRecord["status"]
  >(shape, "status");
  const stage = resolveAtomicUpdateField<
    WhatsAppFlowProvisioningOperationRecord["stage"]
  >(shape, "stage");
  const lease = resolveAtomicUpdateField<
    WhatsAppFlowProvisioningOperationRecord["lease"]
  >(shape, "lease");
  const cleanupAt = resolveAtomicUpdateField<Date>(shape, "cleanupAt");
  const providerResolution =
    resolveAtomicUpdateField<WhatsAppFlowProvisioningProviderResolution>(
      shape,
      "providerResolution"
    );
  const providerStatus = resolveAtomicUpdateField<
    WhatsAppFlowProvisioningOperationRecord["providerStatus"]
  >(shape, "providerStatus");
  const lastError = resolveAtomicUpdateField<WhatsAppFlowProvisioningError>(
    shape,
    "lastError"
  );
  const providerFlowId = resolveAtomicUpdateField<string>(
    shape,
    "providerFlowId"
  );
  const providerAcknowledgedAt = resolveAtomicUpdateField<Date>(
    shape,
    "providerAcknowledgedAt"
  );

  if (options.upsert) {
    assertRequiredSetOnInsertFields(shape, PROVISIONING_REQUIRED_INSERT_PATHS);
    const releaseMode = resolveAtomicUpdateField<
      WhatsAppFlowProvisioningOperationRecord["releaseMode"]
    >(shape, "releaseMode");
    const endpointId = resolveAtomicUpdateField<string>(shape, "endpointId");
    const applicationId = resolveAtomicUpdateField<string>(
      shape,
      "applicationId"
    );
    if (releaseMode.touched && releaseMode.value === "data_endpoint") {
      assertRequiredSetOnInsertFields(shape, ["endpointId", "applicationId"]);
    } else if (
      !releaseMode.touched ||
      releaseMode.value !== "linear" ||
      endpointId.touched ||
      applicationId.touched
    ) {
      throw new Error(
        "Provisioning release mode and endpoint bindings are inconsistent"
      );
    }
    if (
      !status.touched ||
      !stage.touched ||
      !lease.touched ||
      lease.value === null ||
      typeof lease.value !== "object" ||
      !Number.isSafeInteger(lease.value.fence) ||
      lease.value.fence < 0 ||
      cleanupAt.touched ||
      providerResolution.touched ||
      providerFlowId.touched ||
      providerAcknowledgedAt.touched ||
      !isRetryableProvisioningStatus(status.value) ||
      stage.value === "COMPLETED"
    ) {
      throw new Error(
        "Provisioning inserts require retryable status and non-terminal stage in one $setOnInsert"
      );
    }
    return;
  }

  const mutatedIdentityPath = PROVISIONING_IDENTITY_PATHS.find(path => {
    const field = resolveAtomicUpdateField(shape, path);
    return field.touched;
  });
  if (mutatedIdentityPath !== undefined) {
    throw new Error(
      `Existing provisioning operations cannot mutate identity field ${mutatedIdentityPath}`
    );
  }

  if (providerFlowId.touched || providerAcknowledgedAt.touched) {
    if (
      providerFlowId.touched &&
      providerFlowId.source === "$set" &&
      typeof providerFlowId.value === "string" &&
      Boolean(providerFlowId.value.trim()) &&
      providerAcknowledgedAt.touched &&
      providerAcknowledgedAt.source === "$set" &&
      providerAcknowledgedAt.value instanceof Date &&
      Number.isFinite(providerAcknowledgedAt.value.getTime()) &&
      !status.touched &&
      !stage.touched &&
      !cleanupAt.touched &&
      !providerResolution.touched
    ) {
      return;
    }
    throw new Error(
      "Provider Flow ID and acknowledgement time must be recorded once as one atomic pair"
    );
  }

  if (
    !status.touched ||
    status.source !== "$set" ||
    !stage.touched ||
    stage.source !== "$set" ||
    !cleanupAt.touched
  ) {
    throw new Error(
      "Provisioning status, stage, and cleanupAt must transition atomically"
    );
  }

  if (isRetryableProvisioningStatus(status.value)) {
    if (stage.value === "COMPLETED" || cleanupAt.source !== "$unset") {
      throw new Error(
        "Retryable provisioning operations require a non-terminal stage and no cleanup deadline"
      );
    }
    return;
  }

  if (status.value === "COMPLETED") {
    if (stage.value !== "COMPLETED" || cleanupAt.source !== "$unset") {
      throw new Error(
        "Completed provisioning operations remain authoritative without cleanup"
      );
    }
    return;
  }

  if (status.value === "SUPERSEDED") {
    if (
      cleanupAt.source !== "$unset" &&
      (cleanupAt.source !== "$set" || !(cleanupAt.value instanceof Date))
    ) {
      throw new Error(
        "Superseded provisioning cleanup must be a deadline or an explicit evidence-retention unset"
      );
    }
    if (
      providerResolution.touched &&
      (providerResolution.source !== "$set" ||
        !isRequestedProviderResolutionEvidence(providerResolution.value))
    ) {
      throw new Error(
        "Superseded Flow resolution requires one atomic operator request"
      );
    }
    return;
  }

  if (status.value !== "MANUALLY_RESOLVED") {
    throw new Error("Provisioning status transition is invalid");
  }

  if (cleanupAt.source !== "$set" || !(cleanupAt.value instanceof Date)) {
    throw new Error(
      "Terminal provisioning status, stage, and cleanup deadline are inconsistent"
    );
  }
  if (
    providerResolution.touched &&
    providerResolution.source === "$set" &&
    isConfirmedProviderResolutionEvidence(providerResolution.value)
  ) {
    const resolutionMatchesOutcome =
      providerResolution.value.kind === "published_deprecated" ||
      providerResolution.value.outcome === "missing";
    const hasMatchingProviderTruth =
      resolutionMatchesOutcome &&
      providerStatus.touched &&
      (providerResolution.value.outcome === "deprecated"
        ? providerStatus.source === "$set" &&
          providerStatus.value === "DEPRECATED"
        : providerStatus.source === "$unset");
    if (hasMatchingProviderTruth) return;
  }

  if (
    stage.value === "CREATING_FLOW" &&
    !providerResolution.touched &&
    providerStatus.touched &&
    providerStatus.source === "$unset" &&
    lastError.touched &&
    lastError.source === "$set" &&
    isMissingProviderDraftResolutionError(lastError.value)
  ) {
    return;
  }
  throw new Error(
    "Manual Flow resolution requires exact provider-confirmed or missing-draft evidence"
  );
}

const WhatsAppFlowProvisioningErrorSchema =
  new Schema<WhatsAppFlowProvisioningError>(
    {
      code: { ...boundedRequiredString, maxlength: 128 },
      message: { ...boundedRequiredString, maxlength: 1_024 },
      stage: {
        type: String,
        enum: WHATSAPP_FLOW_PROVISIONING_STAGES,
        required: true,
      },
      providerCode: { type: Number },
      providerSubcode: { type: Number },
      retryable: { type: Boolean, required: true },
      at: { type: Date, required: true },
    },
    { _id: false, id: false, strict: "throw", versionKey: false }
  );

const WhatsAppFlowProvisioningProviderResolutionSchema =
  new Schema<WhatsAppFlowProvisioningProviderResolution>(
    {
      kind: {
        type: String,
        enum: ["published_deprecated", "draft_deleted"],
        required: true,
      },
      requestedAt: { type: Date, required: true },
      requestedBy: { ...boundedRequiredString, maxlength: 256 },
      outcome: {
        type: String,
        enum: ["deprecated", "missing"],
      },
      confirmedAt: { type: Date },
      confirmedBy: boundedOptionalString,
    },
    { _id: false, strict: "throw" }
  );

const WhatsAppFlowProvisioningLeaseSchema = new Schema<
  WhatsAppFlowProvisioningOperationRecord["lease"]
>(
  {
    ownerToken: boundedOptionalString,
    fence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    expiresAt: { type: Date },
  },
  { _id: false, id: false, strict: "throw", versionKey: false }
);

export const WHATSAPP_FLOW_PROVISIONING_OPERATION_INDEXES = [
  {
    key: { operationId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_provisioning_operation_id_unique",
    },
  },
  {
    key: { operationKeyHash: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_provisioning_operation_key_hash_unique",
    },
  },
  {
    key: { wabaId: 1, providerMarker: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_provisioning_provider_marker_unique",
    },
  },
  {
    key: { wabaId: 1, providerFlowId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_provisioning_provider_flow_unique",
      partialFilterExpression: {
        providerFlowId: { $type: "string" },
      },
    },
  },
  {
    key: {
      workspaceId: 1,
      scenarioId: 1,
      nodeId: 1,
      targetOwner: 1,
      sourceId: 1,
      wabaId: 1,
      releaseMode: 1,
      endpointId: 1,
      applicationId: 1,
      contentRevision: -1,
      createdAt: -1,
      operationId: -1,
    },
    options: {
      background: true,
      name: "whatsapp_flow_provisioning_binding_revision",
    },
  },
  {
    key: {
      workspaceId: 1,
      sourceId: 1,
      status: 1,
      providerFlowId: 1,
      wabaId: 1,
    },
    options: {
      background: true,
      name: "whatsapp_flow_provisioning_source_rebind",
    },
  },
  {
    key: { status: 1, "lease.expiresAt": 1 },
    options: {
      background: true,
      name: "whatsapp_flow_provisioning_status_lease",
    },
  },
  {
    key: { cleanupAt: 1 },
    options: {
      background: true,
      name: "whatsapp_flow_provisioning_cleanup_ttl",
      expireAfterSeconds: 0,
    },
  },
] as const;

const WhatsAppFlowProvisioningOperationSchema =
  new Schema<WhatsAppFlowProvisioningOperationRecord>(
    {
      operationId: boundedRequiredString,
      operationKeyHash: {
        type: String,
        required: true,
        match: SHA256_HEX_PATTERN,
      },
      workspaceId: boundedRequiredString,
      scenarioId: boundedRequiredString,
      nodeId: boundedRequiredString,
      targetOwner: {
        type: String,
        enum: ["template", "service_message"],
        required: true,
      },
      sourceId: boundedRequiredString,
      wabaId: boundedRequiredString,
      releaseMode: {
        type: String,
        enum: WHATSAPP_FLOW_PROVISIONING_RELEASE_MODES,
        required: true,
        validate: {
          validator(this: unknown) {
            return validateProvisioningReleaseBindingContext(this);
          },
          message:
            "Provisioning release mode and endpoint bindings are inconsistent",
        },
      },
      endpointId: {
        ...boundedOptionalString,
        required(this: unknown) {
          return isProvisioningEndpointBindingRequired(this);
        },
      },
      applicationId: {
        ...boundedOptionalString,
        required(this: unknown) {
          return isProvisioningEndpointBindingRequired(this);
        },
      },
      replacesOperationId: boundedOptionalString,
      cloneFlowId: boundedOptionalString,
      contentRevision: {
        type: Number,
        required: true,
        min: 0,
        validate: Number.isSafeInteger,
      },
      contentDigest: {
        type: String,
        required: true,
        match: SHA256_HEX_PATTERN,
      },
      providerMarker: boundedRequiredString,
      providerFlowId: {
        ...boundedOptionalString,
        validate: {
          validator(this: unknown) {
            return validateProviderAcknowledgementContext(this);
          },
          message:
            "Provider Flow ID and acknowledgement time must form one durable pair",
        },
      },
      providerAcknowledgedAt: {
        type: Date,
        validate: {
          validator(this: unknown) {
            return validateProviderAcknowledgementContext(this);
          },
          message:
            "Provider Flow ID and acknowledgement time must form one durable pair",
        },
      },
      providerFlowName: boundedOptionalString,
      providerStatus: {
        type: String,
        enum: WHATSAPP_FLOW_PROVISIONING_PROVIDER_STATUSES,
      },
      stage: {
        type: String,
        enum: WHATSAPP_FLOW_PROVISIONING_STAGES,
        required: true,
        validate: {
          validator(this: unknown) {
            return validateProvisioningStateContext(this);
          },
          message:
            "Provisioning status, stage, and cleanupAt must form one valid state",
        },
      },
      status: {
        type: String,
        enum: WHATSAPP_FLOW_PROVISIONING_STATUSES,
        required: true,
        validate: {
          validator(this: unknown) {
            return validateProvisioningStateContext(this);
          },
          message:
            "Provisioning status, stage, and cleanupAt must form one valid state",
        },
      },
      lastError: { type: WhatsAppFlowProvisioningErrorSchema },
      lease: {
        type: WhatsAppFlowProvisioningLeaseSchema,
        required: true,
        default: () => ({ fence: 0 }),
      },
      providerResolution: {
        type: WhatsAppFlowProvisioningProviderResolutionSchema,
      },
      cleanupAt: {
        type: Date,
        required(this: unknown) {
          return isProvisioningCleanupRequired(this);
        },
        validate: {
          validator(this: unknown) {
            return validateProvisioningStateContext(this);
          },
          message:
            "Provisioning status, stage, and cleanupAt must form one valid state",
        },
      },
    },
    {
      collection: "whatsapp_flow_provisioning_operations",
      timestamps: true,
      versionKey: false,
      strict: "throw",
    }
  );

for (const index of WHATSAPP_FLOW_PROVISIONING_OPERATION_INDEXES) {
  WhatsAppFlowProvisioningOperationSchema.index(index.key, index.options);
}

installInvariantUpdateShapeGuard(
  WhatsAppFlowProvisioningOperationSchema,
  PROVISIONING_INVARIANT_PATHS,
  assertProvisioningInvariantUpdateShape,
  {
    validationOnlyPaths: [
      "providerFlowName",
      "providerStatus",
      "lastError",
      "lease",
    ],
    // Runtime CAS writers use dotted lease fields; only $inc may advance the fence.
    monotonicIncrementPaths: ["lease.fence"],
  }
);

export const WhatsAppFlowProvisioningOperation =
  (mongoose.models
    .WhatsAppFlowProvisioningOperation as Model<WhatsAppFlowProvisioningOperationRecord>) ||
  mongoose.model<WhatsAppFlowProvisioningOperationRecord>(
    "WhatsAppFlowProvisioningOperation",
    WhatsAppFlowProvisioningOperationSchema
  );
