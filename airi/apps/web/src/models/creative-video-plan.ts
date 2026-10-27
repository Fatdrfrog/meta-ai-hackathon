import mongoose, { type Model } from "mongoose";
import type { ReferenceVideoPlanSnapshot } from "@/lib/creative-assets/reference-video/plan";

export interface ICreativeVideoPlan {
  _id: string;
  workspaceId: string;
  createdBy: string;
  snapshot: ReferenceVideoPlanSnapshot;
  hash: string;
  outputAssetId: string;
  expiresAt: Date;
  status: "draft" | "approved";
  approvedAt: Date | null;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CreativeVideoPlanSchema = new mongoose.Schema<ICreativeVideoPlan>(
  {
    _id: { type: String, required: true, immutable: true },
    workspaceId: { type: String, required: true, immutable: true },
    createdBy: { type: String, required: true, immutable: true },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      immutable: true,
    },
    hash: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    outputAssetId: { type: String, required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    status: { type: String, enum: ["draft", "approved"], required: true },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null },
  },
  { timestamps: true }
);

CreativeVideoPlanSchema.index({ workspaceId: 1, createdAt: -1 });
// Approved plans must outlive the quote so an interrupted dispatch can be retried.
CreativeVideoPlanSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 86_400, partialFilterExpression: { status: "draft" } }
);

export const CreativeVideoPlan: Model<ICreativeVideoPlan> =
  mongoose.models.CreativeVideoPlan ||
  mongoose.model<ICreativeVideoPlan>(
    "CreativeVideoPlan",
    CreativeVideoPlanSchema
  );
