import mongoose from "mongoose";

export type ScenarioGenerationJobStatus =
  | "queued"
  | "planning"
  | "generating_media"
  | "complete"
  | "failed";

export interface IScenarioGenerationJob {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  scenarioId?: string | null;
  status: ScenarioGenerationJobStatus;
  prompt: string;
  workflowKind: "bulk_campaign" | "follow_up_workflow";
  channels: string[];
  sourceIds?: string[];
  sendMode: "immediate" | "trigger";
  assetRefs?: unknown[];
  selectedCanvaTemplates?: unknown[];
  presetSeed?: unknown | null;
  mediaProvider?: string | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ScenarioGenerationJobSchema = new mongoose.Schema<IScenarioGenerationJob>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ["queued", "planning", "generating_media", "complete", "failed"],
      required: true,
      index: true,
    },
    prompt: { type: String, required: true },
    workflowKind: {
      type: String,
      enum: ["bulk_campaign", "follow_up_workflow"],
      required: true,
    },
    channels: { type: [String], default: [] },
    sourceIds: { type: [String], default: [] },
    sendMode: {
      type: String,
      enum: ["immediate", "trigger"],
      required: true,
    },
    assetRefs: { type: mongoose.Schema.Types.Mixed, default: [] },
    selectedCanvaTemplates: { type: mongoose.Schema.Types.Mixed, default: [] },
    presetSeed: { type: mongoose.Schema.Types.Mixed, default: null },
    mediaProvider: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

ScenarioGenerationJobSchema.index({ workspaceId: 1, scenarioId: 1 });
ScenarioGenerationJobSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });

export const ScenarioGenerationJob =
  mongoose.models.ScenarioGenerationJob ||
  mongoose.model<IScenarioGenerationJob>(
    "ScenarioGenerationJob",
    ScenarioGenerationJobSchema
  );
