import mongoose from "mongoose";

export type CampaignScheduleRunStatus =
  | "claimed"
  | "started"
  | "duplicate"
  | "failed";

const CampaignScheduleRunSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true, index: true },
    nodeId: { type: String, required: true, index: true },
    scheduleId: { type: String, required: true, index: true },
    scheduledFor: { type: Date, required: true, index: true },
    takenAt: { type: Date, default: null },
    actionWorkflowId: { type: String, required: true, index: true },
    actionWorkflowRunId: { type: String, required: true, index: true },
    childWorkflowId: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ["claimed", "started", "duplicate", "failed"],
      default: "claimed",
      index: true,
    },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

CampaignScheduleRunSchema.index(
  { scheduleId: 1, scheduledFor: 1 },
  { unique: true }
);
CampaignScheduleRunSchema.index({
  workspaceId: 1,
  scenarioId: 1,
  nodeId: 1,
  scheduledFor: -1,
});

const CampaignScheduleRun =
  mongoose.models.CampaignScheduleRun ||
  mongoose.model("CampaignScheduleRun", CampaignScheduleRunSchema);

export default CampaignScheduleRun;
