import mongoose from "mongoose";

export type ScenarioGeneratedRecipientSendStatus =
  | "draft"
  | "preparing"
  | "queued"
  | "sent"
  | "skipped"
  | "failed";

export interface IScenarioGeneratedRecipientMessage {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  scenarioId: string;
  generationJobId: string;
  nodeId: string;
  branchId: string;
  conversationId?: string | null;
  channel: "whatsapp" | "telegram" | "email";
  recipient: string;
  recipientName?: string | null;
  recipientEmail?: string | null;
  sourceId?: string | null;
  taxonomyCategory?: string | null;
  internalLabels?: string[];
  text: string;
  templateDraftId?: string | null;
  mediaAssetIds?: string[];
  sendStatus: ScenarioGeneratedRecipientSendStatus;
  sendOperationId?: string | null;
  campaignId?: string | null;
  sendPartitionKey?: string | null;
  skipReason?: string | null;
  skipDetail?: string | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const SCENARIO_GENERATED_RECIPIENT_LEGACY_OPERATION_INDEX_NAME =
  "scenario_generated_operation_status_page";

export const SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_KEYS = {
  workspaceId: 1,
  scenarioId: 1,
  sendOperationId: 1,
  createdAt: 1,
  _id: 1,
} as const;

export const SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_OPTIONS = {
  background: true,
  name: "scenario_generated_operation_page",
} as const;

export const SCENARIO_GENERATED_RECIPIENT_LEGACY_DRAFT_PAGE_INDEX_NAME =
  "scenario_generated_draft_page";

export const SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_KEYS = {
  workspaceId: 1,
  scenarioId: 1,
  generationJobId: 1,
  sendStatus: 1,
  createdAt: 1,
  _id: 1,
} as const;

export const SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_OPTIONS = {
  background: true,
  name: "scenario_generated_revision_draft_page",
} as const;

export const SCENARIO_GENERATED_RECIPIENT_LEGACY_IDENTITY_INDEX_NAME =
  "workspaceId_1_scenarioId_1_nodeId_1_recipient_1_channel_1";

export const SCENARIO_GENERATED_RECIPIENT_SOURCE_IDENTITY_INDEX_NAME =
  "scenario_generated_recipient_source_identity_unique";

export const SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_KEYS = {
  workspaceId: 1,
  scenarioId: 1,
  generationJobId: 1,
  nodeId: 1,
  recipient: 1,
  channel: 1,
  sourceId: 1,
} as const;

export const SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_OPTIONS = {
  background: true,
  name: "scenario_generated_recipient_revision_identity_unique",
  unique: true,
} as const;

const ScenarioGeneratedRecipientMessageSchema =
  new mongoose.Schema<IScenarioGeneratedRecipientMessage>(
    {
      workspaceId: { type: String, required: true, index: true },
      scenarioId: { type: String, required: true, index: true },
      generationJobId: { type: String, required: true },
      nodeId: { type: String, required: true, index: true },
      branchId: { type: String, required: true, index: true },
      conversationId: { type: String, default: null, index: true },
      channel: {
        type: String,
        enum: ["whatsapp", "telegram", "email"],
        required: true,
        index: true,
      },
      recipient: { type: String, required: true, index: true },
      recipientName: { type: String, default: null },
      recipientEmail: {
        type: String,
        default: null,
        trim: true,
        lowercase: true,
      },
      sourceId: { type: String, default: null, index: true },
      taxonomyCategory: { type: String, default: null, index: true },
      internalLabels: { type: [String], default: [] },
      text: { type: String, required: true },
      templateDraftId: { type: String, default: null, index: true },
      mediaAssetIds: { type: [String], default: [] },
      sendStatus: {
        type: String,
        enum: ["draft", "preparing", "queued", "sent", "skipped", "failed"],
        default: "draft",
        index: true,
      },
      sendOperationId: { type: String, default: null, index: true },
      campaignId: { type: String, default: null, index: true },
      sendPartitionKey: { type: String, default: null },
      skipReason: { type: String, default: null },
      skipDetail: { type: String, default: null },
      error: { type: String, default: null },
    },
    { timestamps: true }
  );

ScenarioGeneratedRecipientMessageSchema.index({
  workspaceId: 1,
  scenarioId: 1,
});
ScenarioGeneratedRecipientMessageSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  branchId: 1,
});
ScenarioGeneratedRecipientMessageSchema.index(
  SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_KEYS,
  SCENARIO_GENERATED_RECIPIENT_OPERATION_PAGE_INDEX_OPTIONS
);
ScenarioGeneratedRecipientMessageSchema.index(
  SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_KEYS,
  SCENARIO_GENERATED_RECIPIENT_REVISION_DRAFT_INDEX_OPTIONS
);
ScenarioGeneratedRecipientMessageSchema.index(
  SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_KEYS,
  SCENARIO_GENERATED_RECIPIENT_IDENTITY_INDEX_OPTIONS
);

export const ScenarioGeneratedRecipientMessage =
  mongoose.models.ScenarioGeneratedRecipientMessage ||
  mongoose.model<IScenarioGeneratedRecipientMessage>(
    "ScenarioGeneratedRecipientMessage",
    ScenarioGeneratedRecipientMessageSchema
  );
