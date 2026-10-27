import mongoose, { type Model } from "mongoose";
import {
  dashboardBoardStateSchema,
  type DashboardBoardState,
} from "@/lib/analytics/dashboard-board-schema";

type AnalyticsDashboardPreferenceDocument = {
  workspaceId: string;
  userId: string;
  state: DashboardBoardState;
  revision: number;
};

const memberIndex = {
  keys: { workspaceId: 1, userId: 1 } as const,
  options: { unique: true, name: "analytics_dashboard_member_unique" },
};

const preferenceSchema =
  new mongoose.Schema<AnalyticsDashboardPreferenceDocument>(
    {
      workspaceId: { type: String, required: true },
      userId: { type: String, required: true },
      state: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
        validate: (value: unknown) =>
          dashboardBoardStateSchema.safeParse(value).success,
      },
      revision: {
        type: Number,
        required: true,
        min: 1,
        validate: Number.isSafeInteger,
      },
    },
    { timestamps: true, autoIndex: false }
  );

preferenceSchema.index({ ...memberIndex.keys }, { ...memberIndex.options });

export const AnalyticsDashboardPreference =
  (mongoose.models.AnalyticsDashboardPreference as
    | Model<AnalyticsDashboardPreferenceDocument>
    | undefined) ||
  mongoose.model<AnalyticsDashboardPreferenceDocument>(
    "AnalyticsDashboardPreference",
    preferenceSchema
  );

let indexPromise: Promise<void> | null = null;

/** Awaited before every save; cached only after index creation succeeds. */
export function ensureAnalyticsDashboardPreferenceIndexes(): Promise<void> {
  if (!indexPromise) {
    indexPromise = AnalyticsDashboardPreference.collection
      .createIndex(memberIndex.keys, memberIndex.options)
      .then(() => undefined)
      .catch(error => {
        indexPromise = null;
        throw error;
      });
  }
  return indexPromise;
}
