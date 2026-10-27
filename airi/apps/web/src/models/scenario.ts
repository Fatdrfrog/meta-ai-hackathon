import mongoose from "mongoose";
import {
  DEFAULT_SCENARIO_ENTRY_POLICY,
  MAX_SCENARIO_NAME_LENGTH,
} from "@icecore/scenario-contracts";
import { CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION } from "@/lib/scenarios/scenario-graph-migrations";

const ScenarioSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    name: {
      type: String,
      required: true,
      maxlength: MAX_SCENARIO_NAME_LENGTH,
    },
    description: { type: String, default: "" },
    mode: {
      type: String,
      enum: ["conversation", "bulk_campaign"],
      default: "conversation",
      index: true,
    },
    timezone: { type: String, default: "UTC" },
    status: {
      type: String,
      enum: ["draft", "active"],
      default: "draft",
      index: true,
    },
    priority: { type: Number, min: 0, max: 1000, default: 0, index: true },
    presetId: { type: String, default: null, index: true },
    presetVersion: { type: String, default: null },
    segmentKey: { type: String, default: null, index: true },
    matchingRole: {
      type: String,
      enum: ["default", "fallback"],
      default: "default",
    },
    entryPolicy: {
      type: String,
      enum: ["repeatable", "once_per_conversation"],
      default: DEFAULT_SCENARIO_ENTRY_POLICY,
    },
    graphSchemaVersion: {
      type: Number,
      default: CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
    },
    nodes: { type: mongoose.Schema.Types.Mixed, default: [] },
    edges: { type: mongoose.Schema.Types.Mixed, default: [] },
    viewport: {
      type: mongoose.Schema.Types.Mixed,
      default: { x: 0, y: 0, zoom: 1 },
    },
    /** Bulk follow-up: taxonomy→template routes + projection preference (see bulk-follow-up-settings). */
    bulkFollowUpSettings: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, default: null },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: String, default: null },
    whatsappQrDetachPendingNodeIds: {
      type: [{ type: String, trim: true, maxlength: 256 }],
      default: undefined,
    },
    whatsappQrDetachNextRetryAt: { type: Date, default: undefined },
  },
  { timestamps: true }
);

/**
 * The scenario list's filter and cursor order, so a page of live scenarios is
 * read in index order instead of through a blocking sort.
 */
export const SCENARIO_LIST_ORDER_INDEX_KEYS = {
  workspaceId: 1,
  deletedAt: 1,
  priority: -1,
  _id: 1,
} as const;

export const WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX = {
  key: { workspaceId: 1, _id: 1 },
  options: {
    background: true,
    name: "whatsapp_qr_scenario_migration_scan_v1",
  },
} as const;

ScenarioSchema.index({ workspaceId: 1, updatedAt: -1 });
ScenarioSchema.index({ workspaceId: 1, status: 1 });
ScenarioSchema.index({
  workspaceId: 1,
  status: 1,
  "nodes.data.triggerConfig.entryPointType": 1,
  _id: 1,
});
ScenarioSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
ScenarioSchema.index({
  workspaceId: 1,
  "nodes.data.actionFlowConfig.managedProvisioning.sourceId": 1,
});
ScenarioSchema.index({
  workspaceId: 1,
  "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.managedProvisioning.sourceId": 1,
});
ScenarioSchema.index({
  workspaceId: 1,
  "nodes.data.actionFlowConfig.providerReference.sourceId": 1,
});
ScenarioSchema.index({
  workspaceId: 1,
  "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.providerReference.sourceId": 1,
});
ScenarioSchema.index({
  workspaceId: 1,
  status: 1,
  priority: -1,
  updatedAt: -1,
});
ScenarioSchema.index({ workspaceId: 1, mode: 1, status: 1, updatedAt: -1 });
ScenarioSchema.index({ workspaceId: 1, mode: 1, updatedAt: -1 });
ScenarioSchema.index({ workspaceId: 1, deletedAt: 1, updatedAt: -1 });
// Connections run with autoIndex off, so ensureIndexes (lib/mongo.ts) builds
// this one; declaring it here alone creates nothing.
ScenarioSchema.index(SCENARIO_LIST_ORDER_INDEX_KEYS);
ScenarioSchema.index(
  { whatsappQrDetachNextRetryAt: 1, _id: 1 },
  {
    name: "scenario_whatsapp_qr_detach_retry_due",
    partialFilterExpression: {
      whatsappQrDetachNextRetryAt: { $type: "date" },
    },
  }
);
ScenarioSchema.index(
  WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX.key,
  WHATSAPP_QR_SCENARIO_MIGRATION_SCAN_INDEX.options
);

ScenarioSchema.pre("save", function captureUsageCounterState() {
  this.$locals.wasNewForUsageCounter = this.isNew;
});

ScenarioSchema.post("save", function postSaveEmitUsageCounter(doc) {
  if (
    !doc?._id ||
    !doc.$locals?.wasNewForUsageCounter ||
    !doc.workspaceId ||
    doc.deletedAt
  ) {
    return;
  }

  setImmediate(async () => {
    try {
      const { emitScenarioCreatedUsageBestEffort } = await import(
        "@/lib/scenarios/scenario-created-usage"
      );
      emitScenarioCreatedUsageBestEffort(doc);
    } catch {
      // Non-blocking best effort.
    }
  });
});

export const Scenario =
  mongoose.models.Scenario || mongoose.model("Scenario", ScenarioSchema);
