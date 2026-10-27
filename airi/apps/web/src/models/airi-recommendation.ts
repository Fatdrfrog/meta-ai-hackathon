import mongoose, { Schema, model, models } from "mongoose";

export type AiriRecommendationStatus =
  | "new"
  | "planned"
  | "in_progress"
  | "completed"
  | "dismissed";

export type AiriRecommendationPriority = "high" | "medium" | "low";

export type AiriRecommendationCategory =
  | "knowledge_gap"
  | "integration_demand"
  | "scenario_coverage"
  | "kb_coverage"
  | "snippet_coverage"
  | "quality"
  | "manual";

export type AiriRecommendationSource = "auto_gap" | "auto_readiness" | "manual";

export type AiriRecommendationDoc = mongoose.Document & {
  workspaceId: string;
  dedupeKey?: string | null;
  title: string;
  description: string;
  status: AiriRecommendationStatus;
  priority: AiriRecommendationPriority;
  category: AiriRecommendationCategory;
  source: AiriRecommendationSource;
  intent?: string | null;
  occurrences?: number;
  confidence?: number | null;
  lastSeenAt?: Date | null;
  links?: Array<{
    label: string;
    href: string;
  }>;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
  updatedBy?: string | null;
  resolvedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const AiriRecommendationSchema = new Schema<AiriRecommendationDoc>(
  {
    workspaceId: { type: String, required: true, index: true },
    dedupeKey: { type: String, default: null },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    status: {
      type: String,
      enum: ["new", "planned", "in_progress", "completed", "dismissed"],
      default: "new",
      index: true,
    },
    priority: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "medium",
      index: true,
    },
    category: {
      type: String,
      enum: [
        "knowledge_gap",
        "integration_demand",
        "scenario_coverage",
        "kb_coverage",
        "snippet_coverage",
        "quality",
        "manual",
      ],
      default: "manual",
      index: true,
    },
    source: {
      type: String,
      enum: ["auto_gap", "auto_readiness", "manual"],
      default: "manual",
      index: true,
    },
    intent: { type: String, default: null },
    occurrences: { type: Number, default: 1 },
    confidence: { type: Number, default: null },
    lastSeenAt: { type: Date, default: null },
    links: {
      type: [
        new Schema<Record<string, unknown>>(
          {
            label: { type: String, required: true },
            href: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    metadata: { type: Schema.Types.Mixed, default: undefined },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

AiriRecommendationSchema.index(
  { workspaceId: 1, dedupeKey: 1 },
  { unique: true, sparse: true }
);
AiriRecommendationSchema.index({
  workspaceId: 1,
  status: 1,
  priority: 1,
  updatedAt: -1,
});
AiriRecommendationSchema.index({ workspaceId: 1, category: 1, updatedAt: -1 });

export default (models.AiriRecommendation as mongoose.Model<AiriRecommendationDoc>) ||
  model<AiriRecommendationDoc>("AiriRecommendation", AiriRecommendationSchema);
