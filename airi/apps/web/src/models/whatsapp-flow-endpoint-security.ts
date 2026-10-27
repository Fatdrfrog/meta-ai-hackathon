import mongoose, { Schema, type Model } from "mongoose";

import type { EncryptedString } from "@/lib/crypto";
import { EncryptedStringSchema } from "@/models/encrypted-string-schema";
import {
  assertRequiredSetOnInsertFields,
  installInvariantUpdateShapeGuard,
  resolveAtomicUpdateField,
  type AtomicUpdateGuardOptions,
  type AtomicUpdateShape,
} from "@/models/mongoose-validation-context";

export const WHATSAPP_FLOW_KEY_ORIGINS = [
  "LEGACY_IMPORTED",
  "WABA_GENERATED",
] as const;
export const WHATSAPP_FLOW_PHONE_SIGNATURE_STATUSES = [
  "UNKNOWN",
  "VALID",
  "INVALID",
] as const;
export const WHATSAPP_FLOW_PHONE_KEY_STAGES = [
  "DISCOVERED",
  "UPLOADING",
  "VERIFYING",
  "READY",
  "FAILED",
] as const;
export const WHATSAPP_FLOW_KEY_PROVISIONING_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "READY",
  "FAILED",
] as const;
export const WHATSAPP_FLOW_SECURITY_MUTATION_KINDS = [
  "ENSURE",
  "ROTATE",
  "LEGACY_IMPORT",
] as const;
export const WHATSAPP_FLOW_SECURITY_MUTATION_STATUSES = [
  "IDLE",
  "RUNNING",
  "FAILED",
  "COMPLETED",
] as const;
export const MAX_PREVIOUS_FLOW_KEY_SETS = 2;

export type WhatsAppFlowKeySet = {
  generationId: string;
  origin: (typeof WHATSAPP_FLOW_KEY_ORIGINS)[number];
  rsaKeyId: string;
  encryptedPrivateKey: EncryptedString;
  publicKeyFingerprint: string;
  signingKeyId: string;
  encryptedSigningKey: EncryptedString;
  createdAt: Date;
  activatedAt?: Date;
  retireAt?: Date;
};

export type WhatsAppFlowSanitizedSecurityError = {
  code: string;
  message: string;
  stage?: string;
  providerCode?: number;
  providerSubcode?: number;
  retryable: boolean;
  at: Date;
};

export type WhatsAppFlowPhoneSecurityState = {
  phoneNumberId: string;
  generationId?: string;
  publicKeyFingerprint?: string;
  signatureStatus: (typeof WHATSAPP_FLOW_PHONE_SIGNATURE_STATUSES)[number];
  stage: (typeof WHATSAPP_FLOW_PHONE_KEY_STAGES)[number];
  verifiedAt?: Date;
  lastError?: WhatsAppFlowSanitizedSecurityError;
  updatedAt: Date;
};

export type WhatsAppFlowEndpointSecurityRecord = {
  workspaceId: string;
  wabaId: string;
  endpointId: string;
  applicationId: string;
  activeKeySet: WhatsAppFlowKeySet;
  pendingKeySet?: WhatsAppFlowKeySet;
  previousKeySets: WhatsAppFlowKeySet[];
  phones: WhatsAppFlowPhoneSecurityState[];
  keyProvisioning: {
    status: (typeof WHATSAPP_FLOW_KEY_PROVISIONING_STATUSES)[number];
    generationId?: string;
    lastError?: WhatsAppFlowSanitizedSecurityError;
    updatedAt?: Date;
  };
  mutation: {
    kind?: (typeof WHATSAPP_FLOW_SECURITY_MUTATION_KINDS)[number];
    status: (typeof WHATSAPP_FLOW_SECURITY_MUTATION_STATUSES)[number];
    semanticOperationId?: string;
    generationId?: string;
    ownerToken?: string;
    fence: number;
    leaseExpiresAt?: Date;
    lastError?: WhatsAppFlowSanitizedSecurityError;
    updatedAt?: Date;
  };
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
const ENDPOINT_SECURITY_IDENTITY_PATHS = [
  "workspaceId",
  "wabaId",
  "endpointId",
  "applicationId",
] as const;
const ENDPOINT_SECURITY_MATERIAL_PATHS = [
  "activeKeySet",
  "pendingKeySet",
  "previousKeySets",
  "phones",
] as const;
const ENDPOINT_SECURITY_INVARIANT_PATHS = [
  ...ENDPOINT_SECURITY_IDENTITY_PATHS,
  ...ENDPOINT_SECURITY_MATERIAL_PATHS,
] as const;
const ENDPOINT_SECURITY_REQUIRED_INSERT_PATHS = [
  ...ENDPOINT_SECURITY_IDENTITY_PATHS,
  "activeKeySet",
  "previousKeySets",
  "phones",
  "keyProvisioning",
  "mutation",
] as const;

function isInitialKeyProvisioningState(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const state = value as WhatsAppFlowEndpointSecurityRecord["keyProvisioning"];
  return (
    state.status === "NOT_STARTED" &&
    state.generationId === undefined &&
    state.lastError === undefined &&
    state.updatedAt === undefined
  );
}

function isInitialMutationState(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const state = value as WhatsAppFlowEndpointSecurityRecord["mutation"];
  return (
    state.status === "IDLE" &&
    state.fence === 0 &&
    state.kind === undefined &&
    state.semanticOperationId === undefined &&
    state.generationId === undefined &&
    state.ownerToken === undefined &&
    state.leaseExpiresAt === undefined &&
    state.lastError === undefined &&
    state.updatedAt === undefined
  );
}

function assertEndpointSecurityUpdateShape(
  shape: AtomicUpdateShape,
  options: AtomicUpdateGuardOptions
): void {
  const activeKeySet = resolveAtomicUpdateField<WhatsAppFlowKeySet>(
    shape,
    "activeKeySet"
  );
  const pendingKeySet = resolveAtomicUpdateField<WhatsAppFlowKeySet>(
    shape,
    "pendingKeySet"
  );
  const previousKeySets = resolveAtomicUpdateField<WhatsAppFlowKeySet[]>(
    shape,
    "previousKeySets"
  );
  const phones = resolveAtomicUpdateField<WhatsAppFlowPhoneSecurityState[]>(
    shape,
    "phones"
  );
  const keyProvisioning = resolveAtomicUpdateField<
    WhatsAppFlowEndpointSecurityRecord["keyProvisioning"]
  >(shape, "keyProvisioning");
  const mutation = resolveAtomicUpdateField<
    WhatsAppFlowEndpointSecurityRecord["mutation"]
  >(shape, "mutation");

  if (options.upsert) {
    assertRequiredSetOnInsertFields(
      shape,
      ENDPOINT_SECURITY_REQUIRED_INSERT_PATHS
    );
    if (
      !previousKeySets.touched ||
      !Array.isArray(previousKeySets.value) ||
      previousKeySets.value.length !== 0 ||
      !phones.touched ||
      !Array.isArray(phones.value) ||
      phones.value.length !== 0 ||
      !keyProvisioning.touched ||
      !isInitialKeyProvisioningState(keyProvisioning.value) ||
      !mutation.touched ||
      !isInitialMutationState(mutation.value)
    ) {
      throw new Error(
        "Endpoint-security inserts require empty material arrays and initial provisioning state"
      );
    }
    for (const field of [activeKeySet, pendingKeySet]) {
      if (
        field.touched &&
        (field.source !== "$setOnInsert" ||
          field.value === null ||
          typeof field.value !== "object")
      ) {
        throw new Error(
          "Initial endpoint key material must use a whole-path $setOnInsert"
        );
      }
    }
    return;
  }

  const mutatedIdentityPath = ENDPOINT_SECURITY_IDENTITY_PATHS.find(path => {
    const field = resolveAtomicUpdateField(shape, path);
    return field.touched;
  });
  if (mutatedIdentityPath !== undefined) {
    throw new Error(
      `Existing endpoint security cannot mutate identity field ${mutatedIdentityPath}`
    );
  }

  for (const field of [activeKeySet, pendingKeySet]) {
    if (field.touched && field.source !== "$set" && field.source !== "$unset") {
      throw new Error(
        "Endpoint active and pending key sets require whole-path $set or $unset"
      );
    }
  }
  for (const field of [previousKeySets, phones]) {
    if (field.touched && field.source !== "$set") {
      throw new Error(
        "Endpoint key-history and phone arrays require a whole-path $set"
      );
    }
  }
}

const WhatsAppFlowSanitizedSecurityErrorSchema =
  new Schema<WhatsAppFlowSanitizedSecurityError>(
    {
      code: { ...boundedRequiredString, maxlength: 128 },
      message: { ...boundedRequiredString, maxlength: 1_024 },
      stage: { ...boundedOptionalString, maxlength: 128 },
      providerCode: { type: Number },
      providerSubcode: { type: Number },
      retryable: { type: Boolean, required: true },
      at: { type: Date, required: true },
    },
    { _id: false, id: false, strict: "throw", versionKey: false }
  );

const WhatsAppFlowKeySetSchema = new Schema<WhatsAppFlowKeySet>(
  {
    generationId: boundedRequiredString,
    origin: {
      type: String,
      enum: WHATSAPP_FLOW_KEY_ORIGINS,
      required: true,
    },
    rsaKeyId: boundedRequiredString,
    encryptedPrivateKey: {
      type: EncryptedStringSchema,
      required: true,
    },
    publicKeyFingerprint: {
      type: String,
      required: true,
      match: SHA256_HEX_PATTERN,
    },
    signingKeyId: boundedRequiredString,
    encryptedSigningKey: {
      type: EncryptedStringSchema,
      required: true,
    },
    createdAt: { type: Date, required: true },
    activatedAt: { type: Date },
    retireAt: { type: Date },
  },
  { _id: false, id: false, strict: "throw", versionKey: false }
);

const WhatsAppFlowPhoneSecurityStateSchema =
  new Schema<WhatsAppFlowPhoneSecurityState>(
    {
      phoneNumberId: boundedRequiredString,
      generationId: boundedOptionalString,
      publicKeyFingerprint: {
        type: String,
        match: SHA256_HEX_PATTERN,
      },
      signatureStatus: {
        type: String,
        enum: WHATSAPP_FLOW_PHONE_SIGNATURE_STATUSES,
        required: true,
        default: "UNKNOWN",
      },
      stage: {
        type: String,
        enum: WHATSAPP_FLOW_PHONE_KEY_STAGES,
        required: true,
        default: "DISCOVERED",
      },
      verifiedAt: { type: Date },
      lastError: { type: WhatsAppFlowSanitizedSecurityErrorSchema },
      updatedAt: { type: Date, required: true },
    },
    { _id: false, id: false, strict: "throw", versionKey: false }
  );

const WhatsAppFlowKeyProvisioningSchema = new Schema<
  WhatsAppFlowEndpointSecurityRecord["keyProvisioning"]
>(
  {
    status: {
      type: String,
      enum: WHATSAPP_FLOW_KEY_PROVISIONING_STATUSES,
      required: true,
      default: "NOT_STARTED",
    },
    generationId: boundedOptionalString,
    lastError: { type: WhatsAppFlowSanitizedSecurityErrorSchema },
    updatedAt: { type: Date },
  },
  { _id: false, id: false, strict: "throw", versionKey: false }
);

const WhatsAppFlowSecurityMutationSchema = new Schema<
  WhatsAppFlowEndpointSecurityRecord["mutation"]
>(
  {
    kind: {
      type: String,
      enum: WHATSAPP_FLOW_SECURITY_MUTATION_KINDS,
    },
    status: {
      type: String,
      enum: WHATSAPP_FLOW_SECURITY_MUTATION_STATUSES,
      required: true,
      default: "IDLE",
    },
    semanticOperationId: boundedOptionalString,
    generationId: boundedOptionalString,
    ownerToken: boundedOptionalString,
    fence: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    leaseExpiresAt: { type: Date },
    lastError: { type: WhatsAppFlowSanitizedSecurityErrorSchema },
    updatedAt: { type: Date },
  },
  { _id: false, id: false, strict: "throw", versionKey: false }
);

export const WHATSAPP_FLOW_ENDPOINT_SECURITY_INDEXES = [
  {
    key: { wabaId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_endpoint_security_waba_unique",
    },
  },
  {
    key: { endpointId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_flow_endpoint_security_endpoint_unique",
    },
  },
  {
    key: { workspaceId: 1, updatedAt: -1 },
    options: {
      background: true,
      name: "whatsapp_flow_endpoint_security_workspace_updated",
    },
  },
  {
    key: { "mutation.leaseExpiresAt": 1 },
    options: {
      background: true,
      name: "whatsapp_flow_endpoint_security_mutation_lease",
    },
  },
] as const;

const WhatsAppFlowEndpointSecuritySchema =
  new Schema<WhatsAppFlowEndpointSecurityRecord>(
    {
      workspaceId: boundedRequiredString,
      wabaId: boundedRequiredString,
      endpointId: boundedRequiredString,
      applicationId: boundedRequiredString,
      activeKeySet: { type: WhatsAppFlowKeySetSchema, required: true },
      pendingKeySet: { type: WhatsAppFlowKeySetSchema },
      previousKeySets: {
        type: [WhatsAppFlowKeySetSchema],
        required: true,
        default: [],
        validate: {
          validator: (value: unknown) =>
            Array.isArray(value) &&
            value.length <= MAX_PREVIOUS_FLOW_KEY_SETS &&
            value.every(
              keySet =>
                keySet !== null &&
                keySet !== undefined &&
                typeof keySet === "object" &&
                keySet.retireAt instanceof Date &&
                Number.isFinite(keySet.retireAt.getTime())
            ),
          message:
            "At most two previous WhatsApp Flow key sets with retirement times are retained",
        },
      },
      phones: {
        type: [WhatsAppFlowPhoneSecurityStateSchema],
        required: true,
        default: [],
        validate: {
          validator: (value: unknown) =>
            Array.isArray(value) &&
            value.every(
              phone =>
                phone !== null &&
                phone !== undefined &&
                typeof phone === "object"
            ),
          message: "WhatsApp Flow phone states cannot contain null entries",
        },
      },
      keyProvisioning: {
        type: WhatsAppFlowKeyProvisioningSchema,
        required: true,
        default: () => ({ status: "NOT_STARTED" }),
      },
      mutation: {
        type: WhatsAppFlowSecurityMutationSchema,
        required: true,
        default: () => ({ status: "IDLE", fence: 0 }),
      },
    },
    {
      collection: "whatsapp_flow_endpoint_security",
      timestamps: true,
      versionKey: false,
      strict: "throw",
    }
  );

for (const index of WHATSAPP_FLOW_ENDPOINT_SECURITY_INDEXES) {
  WhatsAppFlowEndpointSecuritySchema.index(index.key, index.options);
}

installInvariantUpdateShapeGuard(
  WhatsAppFlowEndpointSecuritySchema,
  ENDPOINT_SECURITY_INVARIANT_PATHS,
  assertEndpointSecurityUpdateShape,
  {
    validationOnlyPaths: ["keyProvisioning", "mutation"],
    // Runtime CAS writers use dotted mutation fields; only $inc may advance the fence.
    monotonicIncrementPaths: ["mutation.fence"],
  }
);

export const WhatsAppFlowEndpointSecurity =
  (mongoose.models
    .WhatsAppFlowEndpointSecurity as Model<WhatsAppFlowEndpointSecurityRecord>) ||
  mongoose.model<WhatsAppFlowEndpointSecurityRecord>(
    "WhatsAppFlowEndpointSecurity",
    WhatsAppFlowEndpointSecuritySchema
  );
