import mongoose from "mongoose";

// Admission state only: the existing conversation workflow executes the graph.
const schema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sourceId: { type: String, required: true },
    scenarioId: { type: mongoose.Schema.Types.ObjectId, required: true },
    triggerNodeId: { type: String, required: true },
    scenarioUpdatedAt: { type: Date, required: true },
    eventId: { type: mongoose.Schema.Types.ObjectId, required: true },
    eventType: { type: String, required: true },
    referenceId: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    dueAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    config: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["pending", "signaled", "contacted", "cancelled", "skipped"],
      default: "pending",
    },
    reason: { type: String, default: null },
    nextAttemptAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);
schema.index(
  {
    workspaceId: 1,
    scenarioId: 1,
    triggerNodeId: 1,
    customerId: 1,
    eventId: 1,
  },
  { unique: true }
);
schema.index({ status: 1, nextAttemptAt: 1, _id: 1 });
schema.index({ workspaceId: 1, customerId: 1, status: 1, occurredAt: -1 });
schema.index({
  workspaceId: 1,
  conversationId: 1,
  scenarioId: 1,
  createdAt: -1,
});
export default mongoose.models.ScenarioBehaviorRun ||
  mongoose.model("ScenarioBehaviorRun", schema);
