import "server-only";
import {
  normalizeStoredDashboardBoard,
  type DashboardBoardState,
} from "@/lib/analytics/dashboard-board-schema";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import {
  AnalyticsDashboardPreference,
  ensureAnalyticsDashboardPreferenceIndexes,
} from "@/models/analytics-dashboard-preference";

export type DashboardPreferencesResult =
  | { state: DashboardBoardState; revision: number }
  | { state: null; revision: null }
  /** Stored but unreadable by this release; the next save replaces it by revision. */
  | { state: null; revision: number; unreadable: true };

export class DashboardPreferencesConflictError extends Error {
  constructor() {
    super("Dashboard preferences changed. Reload before saving.");
    this.name = "DashboardPreferencesConflictError";
  }
}

function serializePreferences(document: {
  state: unknown;
  revision: number;
}): DashboardPreferencesResult {
  if (!Number.isSafeInteger(document.revision) || document.revision < 1) {
    throw new Error("Invalid stored dashboard revision");
  }
  const state = normalizeStoredDashboardBoard(document.state);
  return state
    ? { state, revision: document.revision }
    : { state: null, revision: document.revision, unreadable: true };
}

function serializeSaved(document: { state: unknown; revision: number }): {
  state: DashboardBoardState;
  revision: number;
} {
  const result = serializePreferences(document);
  if (!result.state) throw new Error("Saved dashboard state is unreadable");
  return result;
}

export async function getDashboardPreferences(
  workspaceId: string,
  userId: string
): Promise<DashboardPreferencesResult> {
  await connectDB();
  const document = await AnalyticsDashboardPreference.findOne({
    workspaceId,
    userId,
  }).lean();
  if (!document) return { state: null, revision: null };
  const result = serializePreferences(document);
  if (!result.state)
    logger.warn("Analytics dashboard preference is unreadable", {
      workspaceId,
      revision: result.revision,
    });
  return result;
}

export async function saveDashboardPreferences({
  workspaceId,
  userId,
  state,
  revision,
}: {
  workspaceId: string;
  userId: string;
  state: DashboardBoardState;
  revision: number | null;
}): Promise<{ state: DashboardBoardState; revision: number }> {
  await connectDB();
  await ensureAnalyticsDashboardPreferenceIndexes();
  if (revision === null) {
    try {
      const document = await AnalyticsDashboardPreference.create({
        workspaceId,
        userId,
        state,
        revision: 1,
      });
      return serializeSaved(document);
    } catch (error) {
      if (isMongoDuplicateKeyError(error))
        throw new DashboardPreferencesConflictError();
      throw error;
    }
  }
  const document = await AnalyticsDashboardPreference.findOneAndUpdate(
    { workspaceId, userId, revision },
    { $set: { state }, $inc: { revision: 1 } },
    { new: true, runValidators: true }
  ).lean();
  if (!document) throw new DashboardPreferencesConflictError();
  return serializeSaved(document);
}
