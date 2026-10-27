import mongoose from "mongoose";

const schema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true },
    identity: { type: String, required: true },
    // A bounded rolling window, atomically replaced with a compare-and-swap version.
    version: { type: Number, default: 0 },
    contacts: { type: [{ key: String, at: Date, _id: false }], default: [] },
  },
  { timestamps: true }
);
schema.index({ workspaceId: 1, identity: 1 }, { unique: true });
export default mongoose.models.CustomerContactReservation ||
  mongoose.model("CustomerContactReservation", schema);
