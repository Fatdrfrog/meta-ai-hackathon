import {
  DASHBOARD_TEMPLATE_IDS,
  type DashboardTemplateId,
} from "./dashboard-board-schema";

/** Why a starting dashboard was recommended; each reason has translated copy. */
export const DASHBOARD_RECOMMENDATION_REASONS = [
  "new_workspace",
  "low_volume",
  "ads_connected",
  "recent_campaigns",
  "team_size",
  "support_default",
] as const;
export type DashboardRecommendationReason =
  (typeof DASHBOARD_RECOMMENDATION_REASONS)[number];
export type DashboardRecommendation = {
  templateId: DashboardTemplateId;
  reason: DashboardRecommendationReason;
};

export const DASHBOARD_RECOMMENDATION_RULES = {
  /** Workspaces younger than this still start with the basics. */
  newWorkspaceDays: 14,
  /** Lookback for conversation volume and WhatsApp campaign sends. */
  lookbackDays: 30,
  /** Fewer conversations than this in the lookback means an early stage. */
  earlyStageConversations: 30,
  /** Members at which team capacity becomes the main question. */
  teamMembers: 3,
} as const;

/**
 * Signals the workspace already has. Null means the signal could not be read;
 * that rule is then skipped instead of being treated as zero.
 */
export type DashboardRecommendationSignals = {
  workspaceAgeDays: number | null;
  /** Bounded count: values at or above the early-stage threshold are equivalent. */
  recentConversations: number | null;
  metaAdsConnected: boolean | null;
  recentWhatsAppCampaigns: boolean | null;
  members: number | null;
};

/**
 * Pick a starting dashboard from existing signals, in priority order: a new or
 * quiet workspace gets Getting started, ads or campaigns get Growth, a larger
 * team gets Team operations, and everyone else gets Customer support.
 */
export function recommendDashboardTemplate(
  signals: DashboardRecommendationSignals
): DashboardRecommendation | null {
  const rules = DASHBOARD_RECOMMENDATION_RULES;
  if (
    signals.workspaceAgeDays !== null &&
    signals.workspaceAgeDays < rules.newWorkspaceDays
  )
    return { templateId: "starter", reason: "new_workspace" };
  if (
    signals.recentConversations !== null &&
    signals.recentConversations < rules.earlyStageConversations
  )
    return { templateId: "starter", reason: "low_volume" };
  if (signals.metaAdsConnected)
    return { templateId: "sales", reason: "ads_connected" };
  if (signals.recentWhatsAppCampaigns)
    return { templateId: "sales", reason: "recent_campaigns" };
  if (signals.members !== null && signals.members >= rules.teamMembers)
    return { templateId: "operations", reason: "team_size" };
  if (Object.values(signals).every(value => value === null)) return null;
  return { templateId: "support", reason: "support_default" };
}

/** Validate a recommendation read from an API response or cache. */
export function parseDashboardRecommendation(
  value: unknown
): DashboardRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const { templateId, reason } = value as Record<string, unknown>;
  const template = DASHBOARD_TEMPLATE_IDS.find(id => id === templateId);
  const why = DASHBOARD_RECOMMENDATION_REASONS.find(item => item === reason);
  return template && why ? { templateId: template, reason: why } : null;
}
