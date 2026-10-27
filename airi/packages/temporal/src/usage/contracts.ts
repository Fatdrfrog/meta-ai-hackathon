export const WORKSPACE_USAGE_EVENT_CONTRACT_VERSION = 1;
export const WORKSPACE_USAGE_PUBSUB_TOPIC_DEFAULT =
  "icecore-workspace-usage-events";
export const WORKSPACE_USAGE_PUBSUB_SUBSCRIPTION_DEFAULT =
  "icecore-workspace-usage-events-worker";
export const WORKSPACE_USAGE_PUBSUB_DLQ_TOPIC_DEFAULT =
  "icecore-workspace-usage-events-dlq";
export const WORKSPACE_USAGE_PUBSUB_DLQ_SUBSCRIPTION_DEFAULT =
  "icecore-workspace-usage-events-dlq-worker";

export const WORKSPACE_USAGE_REPAIR_WORKFLOW = "workspaceUsageRepairWorkflow";
export const WORKSPACE_USAGE_REPAIR_ACTIVITY = "workspaceUsage.repair";
export const WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION = 1;
export const WORKSPACE_USAGE_REPAIR_SCHEDULE_ID = "workspace-usage:repair";
export const WORKSPACE_USAGE_REPAIR_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const WORKSPACE_USAGE_REPAIR_SCHEDULE_CATCHUP_WINDOW_MS = 60 * 60 * 1000;
export const WORKSPACE_USAGE_REPAIR_DEFAULT_LIMIT = 250;

export const WORKSPACE_USAGE_METRICS = [
  "conversation_count",
  "workspace_count",
  "seat_count",
  "source_connection_count",
  "airi_auto_reply_count",
  "scenario_count",
  "bulk_campaign_count",
  "classification_count",
  "coach_count",
  "studio_chat_count",
] as const;

export type WorkspaceUsageMetric = (typeof WORKSPACE_USAGE_METRICS)[number];

export type WorkspaceUsageEventMetadata = {
  source?: string | null;
  sourceType?: string | null;
  status?: string | null;
  previousStatus?: string | null;
  reason?: string | null;
  [key: string]: unknown;
};

export type WorkspaceUsageEvent = {
  schemaVersion: typeof WORKSPACE_USAGE_EVENT_CONTRACT_VERSION;
  eventId: string;
  workspaceId: string | null;
  companyId: string;
  metric: WorkspaceUsageMetric;
  delta: number;
  objectId: string;
  occurredAt: string;
  metadata?: WorkspaceUsageEventMetadata;
};

export type WorkspaceUsageRepairWorkflowInput = {
  contractVersion: typeof WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION;
  companyIds?: string[] | null;
  workspaceIds?: string[] | null;
  limit?: number | null;
  reason?: string | null;
  /**
   * Legacy compatibility flag. Historical message scans are intentionally not
   * used by repair; Airi reply counts are maintained by write-time events.
   */
  includeHistoricalMessageCounts?: boolean | null;
};

export type WorkspaceUsageRepairActivityInput =
  WorkspaceUsageRepairWorkflowInput;

export type WorkspaceUsageRepairCompanyResult = {
  companyId: string;
  workspaceCount: number;
  conversationCount: number;
  airiAutoReplyCount: number;
  scenarioCount: number;
  sourceConnectionCount: number;
};

export type WorkspaceUsageRepairActivityResult = {
  scannedCompanies: number;
  repairedCompanies: number;
  companies: WorkspaceUsageRepairCompanyResult[];
};

export type WorkspaceUsageRepairWorkflowResult =
  WorkspaceUsageRepairActivityResult;

export function buildWorkspaceUsageEventId(input: {
  metric: WorkspaceUsageMetric;
  companyId: string;
  workspaceId?: string | null;
  objectId: string;
  delta: number;
  source?: string | null;
}): string {
  return [
    "usage",
    WORKSPACE_USAGE_EVENT_CONTRACT_VERSION,
    input.metric,
    input.companyId,
    input.workspaceId || "company",
    input.objectId,
    input.delta,
    input.source || "event",
  ]
    .map((part) => sanitizeWorkspaceUsageEventIdPart(String(part)))
    .join(":");
}

export function sanitizeWorkspaceUsageEventIdPart(value: string): string {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "unknown";
}

export function isWorkspaceUsageMetric(
  value: unknown,
): value is WorkspaceUsageMetric {
  return (WORKSPACE_USAGE_METRICS as readonly string[]).includes(String(value));
}
