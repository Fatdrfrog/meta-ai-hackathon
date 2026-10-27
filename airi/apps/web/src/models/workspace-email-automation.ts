import mongoose from "mongoose";

const WorkspaceEmailAutomationSchema = new mongoose.Schema<
  Record<string, unknown>
>(
  {
    workspaceId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    registrationFollowUpEnabled: {
      type: Boolean,
      default: true,
      required: true,
    },
    registrationFollowUpTemplate: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    updatedBy: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

const WorkspaceEmailAutomation =
  mongoose.models.WorkspaceEmailAutomation ||
  mongoose.model("WorkspaceEmailAutomation", WorkspaceEmailAutomationSchema);

export default WorkspaceEmailAutomation;
