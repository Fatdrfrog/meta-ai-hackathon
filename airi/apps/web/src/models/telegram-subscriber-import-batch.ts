import mongoose from "mongoose";

const TelegramSubscriberImportBatchSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, required: true, index: true },
    importedBy: { type: String, required: true, index: true },
    fileName: { type: String, default: null },
    status: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
      index: true,
    },
    totalRows: { type: Number, default: 0 },
    validRows: { type: Number, default: 0 },
    invalidRows: { type: Number, default: 0 },
    duplicateRows: { type: Number, default: 0 },
    insertedRows: { type: Number, default: 0 },
    updatedRows: { type: Number, default: 0 },
    errorSamples: { type: [mongoose.Schema.Types.Mixed], default: [] },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);

TelegramSubscriberImportBatchSchema.index({
  workspaceId: 1,
  sourceId: 1,
  createdAt: -1,
});

export const TelegramSubscriberImportBatch =
  mongoose.models.TelegramSubscriberImportBatch ||
  mongoose.model(
    "TelegramSubscriberImportBatch",
    TelegramSubscriberImportBatchSchema
  );
