import mongoose from "mongoose";

export type CreativeStudioChatSource =
  | "scenario_plan"
  | "scenario_create"
  | "instagram_generate"
  | "airi_chat";

export interface ICreativeStudioChat {
  workspaceId: string;
  source: CreativeStudioChatSource;
  createdAt: Date;
  updatedAt: Date;
}

const CreativeStudioChatSchema = new mongoose.Schema<ICreativeStudioChat>(
  {
    workspaceId: { type: String, required: true, index: true },
    source: {
      type: String,
      enum: [
        "scenario_plan",
        "scenario_create",
        "instagram_generate",
        "airi_chat",
      ],
      required: true,
    },
  },
  { timestamps: true }
);

CreativeStudioChatSchema.index({ workspaceId: 1, createdAt: -1 });

export const CreativeStudioChat =
  mongoose.models.CreativeStudioChat ||
  mongoose.model<ICreativeStudioChat>(
    "CreativeStudioChat",
    CreativeStudioChatSchema
  );
