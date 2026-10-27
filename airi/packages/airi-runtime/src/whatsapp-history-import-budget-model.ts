import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    maxMessages: { type: Number, required: true, min: 0 },
    maxBytes: { type: Number, required: true, min: 0 },
    messagesUsed: { type: Number, required: true, min: 0, default: 0 },
    bytesUsed: { type: Number, required: true, min: 0, default: 0 },
  },
  { collection: "whatsapp_history_import_budgets", timestamps: true },
);

export default mongoose.models.WhatsAppHistoryImportBudget ||
  mongoose.model("WhatsAppHistoryImportBudget", schema);
