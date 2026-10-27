import mongoose, { Schema, type Model } from "mongoose";
import {
  installInvariantUpdateShapeGuard,
  isQueryValidationContext,
  resolveAtomicUpdateField,
  resolveValidationValue,
  type AtomicUpdateGuardOptions,
  type AtomicUpdateShape,
} from "@/models/mongoose-validation-context";
import { asNullableRecord, asRecord } from "@icecore/shared/lib/value-utils";

export const WHATSAPP_QR_CODE_PLACEMENT_BINDING_STATES = [
  "CURRENT",
  "HISTORICAL",
  "DETACHED",
] as const;
export const WHATSAPP_QR_CODE_ROUTING_STATES = ["ENABLED", "DISABLED"] as const;
export const WHATSAPP_QR_CODE_PROVIDER_STATES = [
  "PENDING",
  "ACTIVE",
  "RECONCILING",
  "DELETED",
] as const;
export const WHATSAPP_QR_MANAGEABLE_HISTORY_LIMIT = 20;
export type WhatsAppQrCodeRecord = {
  codeId: string;
  workspaceId: string;
  entryPointId: string;
  sourceId: string;
  wabaId: string;
  phoneNumberId: string;
  referenceCode: string;
  providerCode?: string;
  deepLink?: string;
  prefilledMessage?: string;
  placementBindingState: (typeof WHATSAPP_QR_CODE_PLACEMENT_BINDING_STATES)[number];
  routingState: (typeof WHATSAPP_QR_CODE_ROUTING_STATES)[number];
  providerState: (typeof WHATSAPP_QR_CODE_PROVIDER_STATES)[number];
  lastActivationFenceToken?: string;
  lastAssignmentFenceToken?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
const requiredString = {
  type: String,
  required: true,
  trim: true,
  maxlength: 256,
} as const;
const optionalString = { type: String, trim: true, maxlength: 2048 } as const;
function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
function hasQueryOperator(
  value: unknown,
  operator: string,
  expected: unknown
): boolean {
  const record = asNullableRecord(value);
  return record !== null && record[operator] === expected;
}
function isCanonicalNonemptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0
  );
}
function isProviderState(
  value: unknown
): value is WhatsAppQrCodeRecord["providerState"] {
  return WHATSAPP_QR_CODE_PROVIDER_STATES.includes(
    value as WhatsAppQrCodeRecord["providerState"]
  );
}
function isAllowedExistingProviderTransition(
  previous: WhatsAppQrCodeRecord["providerState"],
  next: WhatsAppQrCodeRecord["providerState"]
): boolean {
  return (
    (previous === "ACTIVE" && (next === "RECONCILING" || next === "DELETED")) ||
    (previous === "RECONCILING" && (next === "ACTIVE" || next === "DELETED"))
  );
}
export const WHATSAPP_QR_CODE_INDEXES = [
  {
    key: { codeId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_code_id_unique",
    },
  },
  {
    key: { workspaceId: 1, referenceCode: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_code_workspace_reference_unique",
    },
  },
  {
    key: { wabaId: 1, phoneNumberId: 1, providerCode: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_code_provider_identity_unique",
      partialFilterExpression: { providerCode: { $type: "string" } },
    },
  },
  {
    key: { workspaceId: 1, entryPointId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_code_current_placement_binding_unique",
      partialFilterExpression: { placementBindingState: "CURRENT" },
    },
  },
  {
    key: { workspaceId: 1, sourceId: 1, referenceCode: 1 },
    options: {
      background: true,
      name: "whatsapp_qr_code_runtime_reference_lookup",
    },
  },
  {
    key: {
      workspaceId: 1,
      entryPointId: 1,
      placementBindingState: 1,
      createdAt: -1,
    },
    options: {
      background: true,
      name: "whatsapp_qr_code_placement_history",
    },
  },
] as const;
function validProviderState(context: unknown): boolean {
  if (isQueryValidationContext(context)) return true;
  const state = resolveValidationValue<WhatsAppQrCodeRecord["providerState"]>(
    context,
    "providerState"
  );
  const code = resolveValidationValue<string>(context, "providerCode");
  const link = resolveValidationValue<string>(context, "deepLink");
  if (!state.known || !code.known || !link.known) return false;
  const both = Boolean(code.value?.trim() && link.value?.trim());
  const neither = !code.value && !link.value;
  return state.value === "PENDING"
    ? neither
    : state.value === "RECONCILING"
      ? neither || both
      : both;
}
const schema = new Schema<WhatsAppQrCodeRecord>(
  {
    codeId: requiredString,
    workspaceId: requiredString,
    entryPointId: requiredString,
    sourceId: requiredString,
    wabaId: requiredString,
    phoneNumberId: requiredString,
    referenceCode: {
      ...requiredString,
      match: /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/,
    },
    providerCode: optionalString,
    deepLink: optionalString,
    prefilledMessage: { type: String, trim: false, maxlength: 140 },
    placementBindingState: {
      type: String,
      required: true,
      enum: WHATSAPP_QR_CODE_PLACEMENT_BINDING_STATES,
    },
    routingState: {
      type: String,
      required: true,
      enum: WHATSAPP_QR_CODE_ROUTING_STATES,
    },
    providerState: {
      type: String,
      required: true,
      enum: WHATSAPP_QR_CODE_PROVIDER_STATES,
      validate: {
        validator(this: unknown) {
          return validProviderState(this);
        },
        message: "Provider fields do not match lifecycle state",
      },
    },
    lastActivationFenceToken: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    lastAssignmentFenceToken: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    version: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
  },
  {
    collection: "whatsapp_qr_codes",
    timestamps: true,
    versionKey: false,
    strict: "throw",
  }
);
const IMMUTABLE = [
  "codeId",
  "workspaceId",
  "entryPointId",
  "sourceId",
  "wabaId",
  "phoneNumberId",
  "referenceCode",
] as const;
const MUTABLE = [
  "prefilledMessage",
  "placementBindingState",
  "routingState",
  "providerState",
  "lastActivationFenceToken",
  "lastAssignmentFenceToken",
] as const;
const DURABLE = [...IMMUTABLE, "providerCode", "deepLink", ...MUTABLE] as const;
installInvariantUpdateShapeGuard(
  schema,
  DURABLE,
  (shape: AtomicUpdateShape, options: AtomicUpdateGuardOptions) => {
    if (options.upsert)
      throw new Error("WhatsApp QR codes must be created as documents");
    if (IMMUTABLE.some(path => resolveAtomicUpdateField(shape, path).touched))
      throw new Error("Permanent WhatsApp QR identity cannot be updated");
    for (const path of MUTABLE) {
      const field = resolveAtomicUpdateField(shape, path);
      if (field.touched && field.source !== "$set")
        throw new Error(`QR durable field ${path} must use $set`);
    }
    const providerCode = resolveAtomicUpdateField<string>(
      shape,
      "providerCode"
    );
    const deepLink = resolveAtomicUpdateField<string>(shape, "deepLink");
    const state = resolveAtomicUpdateField<string>(shape, "providerState");
    if (providerCode.touched || deepLink.touched) {
      if (
        !providerCode.touched ||
        !deepLink.touched ||
        providerCode.source !== "$set" ||
        deepLink.source !== "$set" ||
        !isCanonicalNonemptyString(providerCode.value) ||
        !isCanonicalNonemptyString(deepLink.value) ||
        !state.touched ||
        state.source !== "$set" ||
        (state.value !== "ACTIVE" && state.value !== "RECONCILING")
      )
        throw new Error(
          "Provider identity must be observed together with RECONCILING or ACTIVE state"
        );
    }
    const activationFence = resolveAtomicUpdateField<string>(
      shape,
      "lastActivationFenceToken"
    );
    const assignmentFence = resolveAtomicUpdateField<string>(
      shape,
      "lastAssignmentFenceToken"
    );
    const touchedFence = activationFence.touched
      ? {
          field: "lastActivationFenceToken" as const,
          mutation: activationFence,
        }
      : assignmentFence.touched
        ? {
            field: "lastAssignmentFenceToken" as const,
            mutation: assignmentFence,
          }
        : null;
    if (
      touchedFence &&
      (activationFence.touched === assignmentFence.touched ||
        touchedFence.mutation.source !== "$set" ||
        !isCanonicalNonemptyString(touchedFence.mutation.value) ||
        DURABLE.some(
          path =>
            path !== touchedFence.field &&
            resolveAtomicUpdateField(shape, path).touched
        ))
    ) {
      throw new Error(
        "QR Scenario fencing permits only one canonical token mutation"
      );
    }
  },
  { validationOnlyPaths: ["version"], monotonicIncrementPaths: ["version"] }
);
schema.pre(["save"], function () {
  if (
    !this.isNew &&
    (DURABLE.some(path => this.isModified(path)) || this.isModified("version"))
  ) {
    throw new Error("Persistent QR writes require atomic version CAS");
  }
});
schema.pre(
  ["updateOne", "findOneAndUpdate"],
  { query: true, document: false },
  function () {
    if (this.getOptions().upsert === true)
      throw new Error("WhatsApp QR codes must be created as documents");
    if (this.getOptions().runValidators !== true)
      throw new Error("QR code mutations require runValidators: true");
    const update = asNullableRecord(this.getUpdate());
    if (!update) throw new Error("QR code mutations must use update objects");
    const set = asRecord(update.$set);
    const setOnInsert = asRecord(update.$setOnInsert);
    const unset = asRecord(update.$unset);
    if (
      !DURABLE.some(path =>
        [set, setOnInsert, unset].some(values => hasOwn(values, path))
      )
    )
      throw new Error("QR code mutations must change a durable field");
    const filter = asNullableRecord(this.getFilter());
    if (
      !filter ||
      !isCanonicalNonemptyString(filter.codeId) ||
      !isCanonicalNonemptyString(filter.workspaceId) ||
      typeof filter.version !== "number" ||
      !Number.isSafeInteger(filter.version) ||
      filter.version < 0 ||
      asNullableRecord(update.$inc)?.version !== 1
    )
      throw new Error("QR code mutations require exact identity/version CAS");
    const fenceField = hasOwn(set, "lastActivationFenceToken")
      ? "lastActivationFenceToken"
      : hasOwn(set, "lastAssignmentFenceToken")
        ? "lastAssignmentFenceToken"
        : null;
    if (fenceField) {
      const allowedSetPaths = new Set([fenceField, "updatedAt"]);
      const increment = asRecord(update.$inc);
      const allowedOperators = new Set(["$set", "$setOnInsert", "$inc"]);
      if (
        !isCanonicalNonemptyString(set[fenceField]) ||
        (hasOwn(set, "lastActivationFenceToken") &&
          hasOwn(set, "lastAssignmentFenceToken")) ||
        Object.keys(set).some(path => !allowedSetPaths.has(path)) ||
        Object.keys(setOnInsert).some(path => path !== "createdAt") ||
        Object.keys(unset).length > 0 ||
        Object.keys(increment).some(path => path !== "version") ||
        Object.keys(update).some(operator => !allowedOperators.has(operator)) ||
        !isCanonicalNonemptyString(filter.entryPointId) ||
        filter.placementBindingState !== "CURRENT" ||
        filter.routingState !== "ENABLED" ||
        filter.providerState !== "ACTIVE"
      ) {
        throw new Error(
          "QR Scenario fencing requires the exact ready code projection"
        );
      }
    }
    const state = set.providerState;
    if (state === undefined) return;
    const setsPair = hasOwn(set, "providerCode") || hasOwn(set, "deepLink");
    const absent =
      hasQueryOperator(filter.providerCode, "$exists", false) &&
      hasQueryOperator(filter.deepLink, "$exists", false);
    const existing =
      isCanonicalNonemptyString(filter.providerCode) &&
      isCanonicalNonemptyString(filter.deepLink);
    const priorState = filter.providerState;
    if (state === "PENDING" && (!absent || setsPair))
      throw new Error("QR absent-provider state requires absent-provider CAS");
    if ((state === "RECONCILING" || state === "ACTIVE") && setsPair && !absent)
      throw new Error("QR provider observation requires absent-provider CAS");
    if (state === "RECONCILING" && !setsPair && !absent && !existing)
      throw new Error(
        "QR RECONCILING state requires absent or exact existing provider identity CAS"
      );
    if (state === "ACTIVE" && !setsPair && !existing)
      throw new Error(
        "QR ACTIVE state requires exact existing provider identity CAS"
      );
    if (state === "DELETED" && !existing)
      throw new Error(
        "QR deletion state requires exact existing provider identity CAS"
      );
    if (
      !setsPair &&
      existing &&
      (state === "ACTIVE" || state === "RECONCILING" || state === "DELETED") &&
      (!isProviderState(priorState) ||
        !isAllowedExistingProviderTransition(priorState, state))
    )
      throw new Error(
        "QR existing-provider transitions require an exact allowed prior provider state"
      );
  }
);
schema.pre(
  ["deleteOne", "deleteMany", "findOneAndDelete"],
  { query: true, document: false },
  () => {
    throw new Error("WhatsApp QR code tombstones cannot be deleted");
  }
);
schema.pre("deleteOne", { document: true, query: false }, () => {
  throw new Error("WhatsApp QR code tombstones cannot be deleted");
});
for (const index of WHATSAPP_QR_CODE_INDEXES)
  schema.index(index.key, index.options);
export const WhatsAppQrCode =
  (mongoose.models.WhatsAppQrCode as Model<WhatsAppQrCodeRecord>) ||
  mongoose.model<WhatsAppQrCodeRecord>("WhatsAppQrCode", schema);
