import mongoose, { Schema, model, models } from "mongoose";

type AiriSuggestionDoc = mongoose.Document & {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  source: "kb" | "llm";
  score?: number;
  category?: string;
  approved?: boolean;
  autoSent?: boolean;
  createdAt?: Date;
};

const AiriSuggestionSchema = new Schema<AiriSuggestionDoc>(
  {
    workspaceId: { type: String, index: true, required: true },
    conversationId: { type: String, index: true, required: true },
    messageId: { type: String, index: true, required: true },
    source: { type: String, enum: ["kb", "llm"], required: true },
    score: { type: Number },
    category: { type: String },
    approved: { type: Boolean, default: false },
    autoSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default (models.AiriSuggestion as mongoose.Model<AiriSuggestionDoc>) ||
  model<AiriSuggestionDoc>("AiriSuggestion", AiriSuggestionSchema);
