import mongoose from "mongoose";

const CampaignNodeScheduleSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true, index: true },
    nodeId: { type: String, required: true, index: true },
    scheduleType: {
      type: String,
      enum: ["weekly", "relative", "once", "recurring"],
      required: true,
    },
    timezone: { type: String, default: "UTC" },
    cronExpression: { type: String, default: null },
    scheduleConfig: { type: mongoose.Schema.Types.Mixed, default: null },
    scheduleSpec: { type: mongoose.Schema.Types.Mixed, default: null },
    scheduleSummary: { type: String, default: null },
    scheduleId: { type: String, required: true, unique: true },
    configHash: { type: String, required: true },
    status: {
      type: String,
      enum: ["active", "paused", "deleted", "error"],
      default: "active",
      index: true,
    },
    lastReconciledAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

CampaignNodeScheduleSchema.index(
  { workspaceId: 1, scenarioId: 1, nodeId: 1 },
  { unique: true }
);
CampaignNodeScheduleSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
CampaignNodeScheduleSchema.index({ scenarioId: 1, status: 1, updatedAt: -1 });

const CampaignNodeSchedule =
  mongoose.models.CampaignNodeSchedule ||
  mongoose.model("CampaignNodeSchedule", CampaignNodeScheduleSchema);

export default CampaignNodeSchedule;
