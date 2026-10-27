import mongoose, { Schema, type Model } from "mongoose";
import {
  installInvariantUpdateShapeGuard,
  isQueryValidationContext,
  resolveAtomicUpdateField,
  resolveValidationValue,
  type AtomicUpdateGuardOptions,
  type AtomicUpdateShape,
} from "@/models/mongoose-validation-context";
import {
  normalizeWhatsAppQrPlacementNameSearch,
  WHATSAPP_QR_PLACEMENT_NAME_SEARCH_MAX_LENGTH,
} from "@/lib/whatsapp/qr-entry-points/normalization";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";
export const WHATSAPP_QR_ENTRY_POINT_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "DETACHED",
] as const;
export const WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME =
  "whatsapp_qr_entry_point_assignment_unique_v2";
export type WhatsAppQrEntryPointRecord = {
  entryPointId: string;
  workspaceId: string;
  scenarioId?: string;
  nodeId?: string;
  assignmentState?: "assigned" | "unassigned";
  placementName: string;
  placementNameSearch?: string;
  desiredMessage?: string;
  sourceId?: string;
  wabaId?: string;
  phoneNumberId?: string;
  currentCodeId?: string;
  lastDeletionFenceToken?: string;
  status: (typeof WHATSAPP_QR_ENTRY_POINT_STATUSES)[number];
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
const required = {
  type: String,
  required: true,
  trim: true,
  maxlength: 256,
} as const;
const optional = { type: String, trim: true, maxlength: 256 } as const;
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
function validBinding(
  context: unknown,
  status: WhatsAppQrEntryPointRecord["status"]
) {
  if (isQueryValidationContext(context)) return true;
  const sourceId = resolveValidationValue<string>(context, "sourceId");
  const wabaId = resolveValidationValue<string>(context, "wabaId");
  const phoneNumberId = resolveValidationValue<string>(
    context,
    "phoneNumberId"
  );
  const code = resolveValidationValue<string>(context, "currentCodeId");
  if (!sourceId.known || !wabaId.known || !phoneNumberId.known || !code.known)
    return false;
  const values = [sourceId.value, wabaId.value, phoneNumberId.value];
  const complete = values.every(Boolean),
    absent = values.every(value => !value);
  return status === "DRAFT"
    ? absent && !code.value
    : status === "ACTIVE"
      ? complete && Boolean(code.value)
      : (complete && Boolean(code.value)) || (absent && !code.value);
}
export const WHATSAPP_QR_ENTRY_POINT_INDEXES = [
  {
    key: { entryPointId: 1 },
    options: {
      background: true,
      unique: true,
      name: "whatsapp_qr_entry_point_id_unique",
    },
  },
  {
    key: { workspaceId: 1, scenarioId: 1, nodeId: 1 },
    options: {
      background: true,
      unique: true,
      name: WHATSAPP_QR_ENTRY_POINT_ASSIGNMENT_INDEX_NAME,
      partialFilterExpression: {
        scenarioId: { $type: "string" },
        nodeId: { $type: "string" },
      },
    },
  },
  {
    key: { workspaceId: 1, sourceId: 1, status: 1, updatedAt: -1 },
    options: {
      background: true,
      name: "whatsapp_qr_entry_point_workspace_source_status_updated",
    },
  },
  {
    key: { workspaceId: 1, _id: 1 },
    options: {
      background: true,
      name: "whatsapp_qr_entry_point_migration_scan_v1",
    },
  },
] as const;

function validAssignmentProjection(context: unknown): boolean {
  if (isQueryValidationContext(context)) return true;
  if (
    context !== null &&
    typeof context === "object" &&
    "isNew" in context &&
    (context as { isNew?: boolean }).isNew === false
  ) {
    return true;
  }
  const scenarioId = resolveValidationValue<string>(context, "scenarioId");
  const nodeId = resolveValidationValue<string>(context, "nodeId");
  const assignmentState = resolveValidationValue<string>(
    context,
    "assignmentState"
  );
  const placementNameSearch = resolveValidationValue<string>(
    context,
    "placementNameSearch"
  );
  if (
    !scenarioId.known ||
    !nodeId.known ||
    !assignmentState.known ||
    !placementNameSearch.known ||
    !isCanonicalNonemptyString(placementNameSearch.value)
  ) {
    return false;
  }
  const assigned =
    isCanonicalNonemptyString(scenarioId.value) &&
    isCanonicalNonemptyString(nodeId.value);
  const unassigned =
    scenarioId.value === undefined && nodeId.value === undefined;
  return (
    (assigned && assignmentState.value === "assigned") ||
    (unassigned && assignmentState.value === "unassigned")
  );
}
const schema = new Schema<WhatsAppQrEntryPointRecord>(
  {
    entryPointId: required,
    workspaceId: required,
    scenarioId: optional,
    nodeId: optional,
    assignmentState: {
      type: String,
      enum: ["assigned", "unassigned"],
    },
    placementName: { ...required, maxlength: 120 },
    placementNameSearch: {
      type: String,
      trim: false,
      maxlength: WHATSAPP_QR_PLACEMENT_NAME_SEARCH_MAX_LENGTH,
    },
    desiredMessage: { type: String, trim: false, maxlength: 120 },
    sourceId: optional,
    wabaId: optional,
    phoneNumberId: optional,
    currentCodeId: optional,
    lastDeletionFenceToken: {
      type: String,
      trim: true,
      maxlength: 128,
    },
    status: {
      type: String,
      required: true,
      enum: WHATSAPP_QR_ENTRY_POINT_STATUSES,
      validate: {
        validator(this: unknown, value: WhatsAppQrEntryPointRecord["status"]) {
          return validBinding(this, value) && validAssignmentProjection(this);
        },
      },
    },
    version: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
  },
  {
    collection: "whatsapp_qr_entry_points",
    timestamps: true,
    versionKey: false,
    strict: "throw",
  }
);
const IDENTITY = ["entryPointId", "workspaceId"] as const;
const DURABLE = [
  ...IDENTITY,
  "scenarioId",
  "nodeId",
  "assignmentState",
  "placementName",
  "placementNameSearch",
  "desiredMessage",
  "status",
  "sourceId",
  "wabaId",
  "phoneNumberId",
  "currentCodeId",
  "lastDeletionFenceToken",
] as const;
installInvariantUpdateShapeGuard(
  schema,
  DURABLE,
  (shape: AtomicUpdateShape, options: AtomicUpdateGuardOptions) => {
    if (options.upsert) {
      throw new Error("QR entry point upserts are not supported");
    }
    if (IDENTITY.some(path => resolveAtomicUpdateField(shape, path).touched))
      throw new Error("QR entry point identity is immutable");
    const scenario = resolveAtomicUpdateField<string>(shape, "scenarioId"),
      node = resolveAtomicUpdateField<string>(shape, "nodeId"),
      assignment = resolveAtomicUpdateField<string>(shape, "assignmentState");
    const assignmentTouched =
      scenario.touched || node.touched || assignment.touched;
    if (assignmentTouched) {
      const assigns =
        scenario.touched &&
        scenario.source === "$set" &&
        isCanonicalNonemptyString(scenario.value) &&
        node.touched &&
        node.source === "$set" &&
        isCanonicalNonemptyString(node.value) &&
        assignment.touched &&
        assignment.source === "$set" &&
        assignment.value === "assigned";
      const unassigns =
        scenario.touched &&
        scenario.source === "$unset" &&
        node.touched &&
        node.source === "$unset" &&
        assignment.touched &&
        assignment.source === "$set" &&
        assignment.value === "unassigned";
      if (!assigns && !unassigns) {
        throw new Error(
          "QR assignment mutations require paired scenarioId/nodeId and matching assignmentState"
        );
      }
    }

    const placementName = resolveAtomicUpdateField<string>(
        shape,
        "placementName"
      ),
      placementNameSearch = resolveAtomicUpdateField<string>(
        shape,
        "placementNameSearch"
      );
    if (placementName.touched || placementNameSearch.touched) {
      if (
        !placementName.touched ||
        placementName.source !== "$set" ||
        !isCanonicalNonemptyString(placementName.value) ||
        !placementNameSearch.touched ||
        placementNameSearch.source !== "$set" ||
        placementNameSearch.value !==
          normalizeWhatsAppQrPlacementNameSearch(placementName.value)
      ) {
        throw new Error(
          "QR placement name changes require the matching placementNameSearch projection"
        );
      }
    }

    const deletionFence = resolveAtomicUpdateField<string>(
      shape,
      "lastDeletionFenceToken"
    );
    if (
      deletionFence.touched &&
      (deletionFence.source !== "$set" ||
        !isCanonicalNonemptyString(deletionFence.value) ||
        DURABLE.some(
          path =>
            path !== "lastDeletionFenceToken" &&
            resolveAtomicUpdateField(shape, path).touched
        ))
    ) {
      throw new Error(
        "QR deletion fencing permits only one canonical token mutation"
      );
    }
  },
  { validationOnlyPaths: ["version"], monotonicIncrementPaths: ["version"] }
);
schema.pre(
  ["updateOne", "findOneAndUpdate"],
  { query: true, document: false },
  function () {
    const update = this.getUpdate() as Record<string, Record<string, unknown>>;
    const changed = Object.entries(update).some(
      ([operator, values]) =>
        operator !== "$inc" &&
        Object.keys(values ?? {}).some(path =>
          (DURABLE as readonly string[]).some(
            durable => path === durable || path.startsWith(`${durable}.`)
          )
        )
    );
    if (!changed) {
      if (update.$inc?.version !== undefined) {
        throw new Error(
          "QR entry point version increments require a durable field change"
        );
      }
      return;
    }
    const filter = asNullableRecord(this.getFilter());
    if (
      !filter ||
      typeof filter.entryPointId !== "string" ||
      !filter.entryPointId ||
      typeof filter.workspaceId !== "string" ||
      !filter.workspaceId ||
      !Number.isSafeInteger(filter.version) ||
      (filter.version as number) < 0 ||
      update.$inc?.version !== 1
    )
      throw new Error(
        "QR entry point mutations require exact identity and version CAS filters"
      );
    if (
      Object.prototype.hasOwnProperty.call(
        update.$set ?? {},
        "lastDeletionFenceToken"
      )
    ) {
      const set = update.$set ?? {};
      const setOnInsert = update.$setOnInsert ?? {};
      const unset = update.$unset ?? {};
      const increment = update.$inc ?? {};
      const assignmentProjectionIsExact =
        (isCanonicalNonemptyString(filter.scenarioId) &&
          isCanonicalNonemptyString(filter.nodeId) &&
          (filter.assignmentState === "assigned" ||
            hasQueryOperator(filter.assignmentState, "$exists", false))) ||
        (hasQueryOperator(filter.scenarioId, "$exists", false) &&
          hasQueryOperator(filter.nodeId, "$exists", false) &&
          (filter.assignmentState === "unassigned" ||
            hasQueryOperator(filter.assignmentState, "$exists", false)));
      if (
        !isCanonicalNonemptyString(set.lastDeletionFenceToken) ||
        Object.keys(set).some(
          path => path !== "lastDeletionFenceToken" && path !== "updatedAt"
        ) ||
        Object.keys(setOnInsert).some(path => path !== "createdAt") ||
        Object.keys(unset).length > 0 ||
        Object.keys(increment).some(path => path !== "version") ||
        Object.keys(update).some(
          operator => !["$set", "$setOnInsert", "$inc"].includes(operator)
        ) ||
        filter.status !== "ACTIVE" ||
        !isCanonicalNonemptyString(filter.sourceId) ||
        !isCanonicalNonemptyString(filter.wabaId) ||
        !isCanonicalNonemptyString(filter.phoneNumberId) ||
        !isCanonicalNonemptyString(filter.currentCodeId) ||
        !assignmentProjectionIsExact
      ) {
        throw new Error(
          "QR deletion fencing requires the exact active assignment and provider projection"
        );
      }
    }
    const moveScenario = update.$set?.scenarioId !== undefined,
      moveNode = update.$set?.nodeId !== undefined;
    if (moveScenario !== moveNode)
      throw new Error(
        "QR entry point moves require scenarioId and nodeId together"
      );
    const set = update.$set ?? {};
    const tuple = ["sourceId", "wabaId", "phoneNumberId"];
    const tupleTouched = tuple.some(path => set[path] !== undefined);
    const tupleComplete = tuple.every(
      path =>
        typeof set[path] === "string" && Boolean((set[path] as string).trim())
    );
    const absent =
      tuple.every(path => hasQueryOperator(filter[path], "$exists", false)) &&
      hasQueryOperator(filter.currentCodeId, "$exists", false);
    const existing =
      tuple.every(path => isCanonicalNonemptyString(filter[path])) &&
      isCanonicalNonemptyString(filter.currentCodeId);
    const unset = update.$unset ?? {};
    const unsetsFullBinding =
      tuple.every(path => Object.prototype.hasOwnProperty.call(unset, path)) &&
      Object.prototype.hasOwnProperty.call(unset, "currentCodeId");
    const isFullDraftReset =
      set.status === "DRAFT" &&
      existing &&
      filter.status === "ACTIVE" &&
      unsetsFullBinding &&
      !tupleTouched &&
      set.currentCodeId === undefined;
    const isDetachedDraftRevival =
      set.status === "DRAFT" &&
      filter.status === "DETACHED" &&
      absent &&
      !tupleTouched &&
      set.currentCodeId === undefined &&
      Object.keys(unset).length === 0;
    const tupleMutation = Object.values(update).some(values =>
      tuple.some(path =>
        Object.prototype.hasOwnProperty.call(values ?? {}, path)
      )
    );
    if (tupleMutation && !tupleTouched && !isFullDraftReset)
      throw new Error(
        "QR source binding cannot be unset, renamed, or partially changed"
      );
    if (
      tupleTouched &&
      (!tupleComplete ||
        !absent ||
        typeof set.currentCodeId !== "string" ||
        !set.currentCodeId.trim() ||
        set.status !== "ACTIVE")
    )
      throw new Error(
        "QR source binding requires one absent-to-set tuple and active current code"
      );
    if (set.status === "ACTIVE") {
      const first = tupleTouched && typeof set.currentCodeId === "string";
      if (!first && !existing)
        throw new Error(
          "QR activation requires unbound tuple or existing binding CAS"
        );
    }
    if (set.status === "DRAFT" && !isFullDraftReset && !isDetachedDraftRevival)
      throw new Error(
        "QR entry points return to DRAFT only by clearing the complete active binding"
      );
    if (
      !tupleTouched &&
      set.currentCodeId !== undefined &&
      set.status === undefined &&
      !(
        isCanonicalNonemptyString(set.currentCodeId) &&
        filter.status === "ACTIVE" &&
        existing
      )
    )
      throw new Error("QR code replacement requires ACTIVE binding CAS");
    if (update.$unset?.currentCodeId !== undefined && !isFullDraftReset) {
      throw new Error("QR current code cannot be unset");
    }
  }
);
schema.pre("save", function () {
  if (
    !this.isNew &&
    ((DURABLE as readonly string[]).some(path => this.isModified(path)) ||
      this.isModified("version"))
  )
    throw new Error(
      "Persistent QR entry point writes require atomic version CAS"
    );
});
schema.pre("deleteOne", { document: true, query: false }, () => {
  throw new Error("QR entry point history cannot be deleted");
});
schema.pre(
  ["deleteOne", "deleteMany", "findOneAndDelete"],
  { query: true, document: false },
  () => {
    throw new Error("QR entry point history cannot be deleted");
  }
);
for (const index of WHATSAPP_QR_ENTRY_POINT_INDEXES)
  schema.index(index.key, index.options);
export const WhatsAppQrEntryPoint =
  (mongoose.models.WhatsAppQrEntryPoint as Model<WhatsAppQrEntryPointRecord>) ||
  mongoose.model<WhatsAppQrEntryPointRecord>("WhatsAppQrEntryPoint", schema);
