import mongoose from "mongoose";

const TelegramSubscriberSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    sourceId: { type: String, required: true, index: true },
    chatId: { type: String, required: true },
    telegramUserId: { type: String, default: null, index: true },
    username: { type: String, default: null, trim: true },
    firstName: { type: String, default: null, trim: true },
    lastName: { type: String, default: null, trim: true },
    displayName: { type: String, default: null, trim: true },
    languageCode: { type: String, default: null, trim: true },
    externalId: { type: String, default: null, trim: true },
    tags: { type: [String], default: [] },
    origin: {
      type: String,
      enum: ["webhook", "conversation_backfill", "import"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "imported", "blocked", "invalid", "suppressed"],
      default: "imported",
      index: true,
    },
    invalidReason: { type: String, default: null },
    firstSeenAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null, index: true },
    importBatchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TelegramSubscriberImportBatch",
      default: null,
      index: true,
    },
    importedBy: { type: String, default: null, index: true },
    importedAt: { type: Date, default: null },
    sourceFileName: { type: String, default: null },
    lastSendAttemptAt: { type: Date, default: null },
    lastSuccessfulSendAt: { type: Date, default: null },
    lastSendError: { type: String, default: null },
    lastSendErrorCode: { type: String, default: null },
  },
  { timestamps: true }
);

TelegramSubscriberSchema.index(
  { workspaceId: 1, sourceId: 1, chatId: 1 },
  { unique: true }
);
TelegramSubscriberSchema.index({
  workspaceId: 1,
  sourceId: 1,
  status: 1,
  lastSeenAt: -1,
});

export const TelegramSubscriber =
  mongoose.models.TelegramSubscriber ||
  mongoose.model("TelegramSubscriber", TelegramSubscriberSchema);
