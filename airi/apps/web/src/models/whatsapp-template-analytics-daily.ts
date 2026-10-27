import mongoose from "mongoose";
type TemplateDaily = {
  workspaceId: string;
  wabaId: string;
  templateId: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string | null;
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  uniqueClicked: number | null;
  quickReplyClicked: number | null;
  cost: number | null;
  lastObservedAt: Date;
};

// Aggregate-only observations survive Meta's seven-day read/click reset.
const schema = new mongoose.Schema<TemplateDaily>(
  {
    workspaceId: { type: String, required: true },
    wabaId: { type: String, required: true },
    templateId: { type: String, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    currency: { type: String, default: null },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    read: { type: Number, default: null },
    clicked: { type: Number, default: null },
    uniqueClicked: { type: Number, default: null },
    quickReplyClicked: { type: Number, default: null },
    cost: { type: Number, default: null },
    lastObservedAt: { type: Date, required: true },
  },
  { timestamps: true, autoIndex: false }
);
schema.index(
  { workspaceId: 1, wabaId: 1, templateId: 1, periodStart: 1 },
  { unique: true }
);
schema.index({ workspaceId: 1, wabaId: 1, periodStart: 1 });
export const WhatsAppTemplateAnalyticsDaily =
  (mongoose.models.WhatsAppTemplateAnalyticsDaily as
    | mongoose.Model<TemplateDaily>
    | undefined) ||
  mongoose.model<TemplateDaily>("WhatsAppTemplateAnalyticsDaily", schema);
let indexPromise: Promise<void> | null = null;
export function ensureWhatsAppTemplateAnalyticsIndexes(): Promise<void> {
  if (!indexPromise)
    indexPromise = WhatsAppTemplateAnalyticsDaily.createIndexes()
      .then(() => undefined)
      .catch(error => {
        indexPromise = null;
        throw error;
      });
  return indexPromise;
}
