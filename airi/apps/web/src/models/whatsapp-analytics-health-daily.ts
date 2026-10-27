import mongoose from "mongoose";
type HealthDaily = {
  workspaceId: string;
  sourceId: string;
  day: string;
  observedAt: Date;
  deliveryObservedAt: Date | null;
  accountStatus: string;
  phoneQuality: string | null;
  portfolioLimit: string | null;
  webhookStatus: "healthy" | "action_required" | "unknown";
  templateIssues: number | null;
  pending7d: number | null;
  failed7d: number | null;
};

// Daily, aggregate-only observations. History begins when collection is enabled.
const schema = new mongoose.Schema<HealthDaily>(
  {
    workspaceId: { type: String, required: true },
    sourceId: { type: String, required: true },
    day: { type: String, required: true },
    observedAt: { type: Date, required: true },
    deliveryObservedAt: { type: Date, default: null },
    accountStatus: { type: String, required: true },
    phoneQuality: { type: String, default: null },
    portfolioLimit: { type: String, default: null },
    webhookStatus: {
      type: String,
      enum: ["healthy", "action_required", "unknown"],
      required: true,
    },
    templateIssues: { type: Number, default: null },
    pending7d: { type: Number, default: null },
    failed7d: { type: Number, default: null },
  },
  { timestamps: true, autoIndex: false }
);
schema.index({ workspaceId: 1, sourceId: 1, day: 1 }, { unique: true });
schema.index({ workspaceId: 1, day: 1 });
export const WhatsAppAnalyticsHealthDaily =
  (mongoose.models.WhatsAppAnalyticsHealthDaily as
    | mongoose.Model<HealthDaily>
    | undefined) ||
  mongoose.model<HealthDaily>("WhatsAppAnalyticsHealthDaily", schema);
let indexPromise: Promise<void> | null = null;
export function ensureWhatsAppAnalyticsHealthIndexes(): Promise<void> {
  if (!indexPromise)
    indexPromise = WhatsAppAnalyticsHealthDaily.createIndexes()
      .then(() => undefined)
      .catch(error => {
        indexPromise = null;
        throw error;
      });
  return indexPromise;
}
