import mongoose from "mongoose";
import { DEFAULT_CONTACT_POLICY } from "@icecore/scenario-contracts";

const schema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, unique: true },
    minIntervalHours: {
      type: Number,
      default: DEFAULT_CONTACT_POLICY.minIntervalHours,
      min: 1,
      max: 720,
    },
    maxPerWeek: {
      type: Number,
      default: DEFAULT_CONTACT_POLICY.maxPerWeek,
      min: 1,
      max: 100,
    },
  },
  { timestamps: true }
);
export default mongoose.models.CustomerContactPolicy ||
  mongoose.model("CustomerContactPolicy", schema);
