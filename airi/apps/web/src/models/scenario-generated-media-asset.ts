import mongoose from "mongoose";

export type ScenarioGeneratedMediaAssetKind =
  | "image"
  | "video"
  | "audio"
  | "document";

export type ScenarioGeneratedMediaAssetSource =
  | "uploaded"
  | "vertex"
  | "elevenlabs"
  | "higgsfield";

export interface IScenarioGeneratedMediaAsset {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  scenarioId?: string | null;
  jobId: string;
  branchId?: string | null;
  kind: ScenarioGeneratedMediaAssetKind;
  source: ScenarioGeneratedMediaAssetSource;
  url: string;
  mimeType?: string | null;
  fileName?: string | null;
  durationSeconds?: number | null;
  providerOperationId?: string | null;
  status: "queued" | "complete" | "failed";
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ScenarioGeneratedMediaAssetSchema =
  new mongoose.Schema<IScenarioGeneratedMediaAsset>(
    {
      workspaceId: { type: String, required: true, index: true },
      scenarioId: { type: String, default: null, index: true },
      jobId: { type: String, required: true, index: true },
      branchId: { type: String, default: null, index: true },
      kind: {
        type: String,
        enum: ["image", "video", "audio", "document"],
        required: true,
        index: true,
      },
      source: {
        type: String,
        enum: ["uploaded", "vertex", "elevenlabs", "higgsfield"],
        required: true,
        index: true,
      },
      url: { type: String, default: "" },
      mimeType: { type: String, default: null },
      fileName: { type: String, default: null },
      durationSeconds: { type: Number, default: null },
      providerOperationId: { type: String, default: null, index: true },
      status: {
        type: String,
        enum: ["queued", "complete", "failed"],
        default: "queued",
        index: true,
      },
      error: { type: String, default: null },
    },
    { timestamps: true }
  );

ScenarioGeneratedMediaAssetSchema.index({ workspaceId: 1, scenarioId: 1 });
ScenarioGeneratedMediaAssetSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  branchId: 1,
});
ScenarioGeneratedMediaAssetSchema.index({ workspaceId: 1, jobId: 1 });

export const ScenarioGeneratedMediaAsset =
  mongoose.models.ScenarioGeneratedMediaAsset ||
  mongoose.model<IScenarioGeneratedMediaAsset>(
    "ScenarioGeneratedMediaAsset",
    ScenarioGeneratedMediaAssetSchema
  );
