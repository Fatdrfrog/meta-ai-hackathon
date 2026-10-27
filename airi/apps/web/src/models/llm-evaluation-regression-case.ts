import mongoose, { Schema, model, models } from "mongoose";

export type LlmEvaluationRegressionCaseDoc = mongoose.Document & {
  workspaceId: string;
  reviewItemId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  issueType?: string | null;
  inputExcerpt: string;
  expectedBehavior: string;
  expectedSourceIds: string[];
  status: "active" | "archived";
  datasetSplit: "train" | "validation" | "test";
  createdByUserId?: string | null;
  lastRunAt?: Date | null;
  lastPass?: boolean | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const LlmEvaluationRegressionCaseSchema =
  new Schema<LlmEvaluationRegressionCaseDoc>(
    {
      workspaceId: { type: String, required: true, index: true },
      reviewItemId: { type: String, default: null, index: true },
      conversationId: { type: String, default: null, index: true },
      messageId: { type: String, default: null, index: true },
      traceId: { type: String, default: null, index: true },
      issueType: { type: String, default: null, index: true },
      inputExcerpt: { type: String, required: true },
      expectedBehavior: { type: String, required: true },
      expectedSourceIds: { type: [String], default: [] },
      status: {
        type: String,
        enum: ["active", "archived"],
        default: "active",
        index: true,
      },
      datasetSplit: {
        type: String,
        enum: ["train", "validation", "test"],
        default: "validation",
        index: true,
      },
      createdByUserId: { type: String, default: null, index: true },
      lastRunAt: { type: Date, default: null, index: true },
      lastPass: { type: Boolean, default: null, index: true },
    },
    { timestamps: true }
  );

LlmEvaluationRegressionCaseSchema.index({
  workspaceId: 1,
  status: 1,
  datasetSplit: 1,
  createdAt: -1,
});

export default (models.LlmEvaluationRegressionCase as mongoose.Model<LlmEvaluationRegressionCaseDoc>) ||
  model<LlmEvaluationRegressionCaseDoc>(
    "LlmEvaluationRegressionCase",
    LlmEvaluationRegressionCaseSchema
  );
