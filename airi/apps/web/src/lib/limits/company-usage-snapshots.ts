import { buildCacheKey, cache } from "@/lib/cache";
import type { WorkspaceUsageEvent } from "@icecore/temporal";
import type { SupabaseClient } from "@supabase/supabase-js";
import "server-only";
import { readNonNegativeCount as normalizeCount } from "@icecore/shared/lib/value-utils";

const COMPANY_USAGE_SNAPSHOT_CACHE_TTL_SECONDS = 20;

export type CompanyUsageSnapshotRow = {
  company_id: string;
  conversation_count?: number | string | null;
  workspace_count?: number | string | null;
  seat_count?: number | string | null;
  channel_count?: number | string | null;
  channel_types?: string[] | null;
  whatsapp_number_count?: number | string | null;
  integration_connection_counts?: Record<string, unknown> | null;
  max_integration_connection_count?: number | string | null;
  airi_auto_reply_count?: number | string | null;
  scenario_count?: number | string | null;
  bulk_campaign_count?: number | string | null;
  classification_count?: number | string | null;
  coach_count?: number | string | null;
  studio_chat_count?: number | string | null;
  last_event_at?: string | null;
  repaired_at?: string | null;
  updated_at?: string | null;
};

export type CompanyUsageSnapshotCounts = {
  companyId: string;
  conversationCount: number;
  workspaceCount: number;
  seatCount: number;
  channelCount: number;
  channelTypes: string[];
  whatsappNumberCount: number;
  integrationConnectionCounts: Record<string, number>;
  maxIntegrationConnectionCount: number;
  airiAutoReplyCount: number;
  scenarioCount: number;
  bulkCampaignCount: number;
  classificationCount: number;
  coachCount: number;
  studioChatCount: number;
  lastEventAt: string | null;
  repairedAt: string | null;
  updatedAt: string | null;
};

export type ApplyWorkspaceUsageEventsResult = {
  processed: number;
  duplicates: number;
};

type ReadCompanyUsageSnapshotOptions = {
  useCache?: boolean;
  minimumWorkspaceCount?: number;
  repairMissingSnapshot?: (
    companyId: string
  ) => Promise<CompanyUsageSnapshotRow | null>;
};

export function buildCompanyUsageSnapshotCacheKey(companyId: string): string {
  return buildCacheKey("company-usage-snapshot", [companyId]);
}

export async function invalidateCompanyUsageSnapshotCache(
  companyId: string
): Promise<void> {
  await cache.del(buildCompanyUsageSnapshotCacheKey(companyId));
}

export async function readCompanyUsageSnapshot(
  supabase: SupabaseClient,
  companyId: string,
  options: ReadCompanyUsageSnapshotOptions = {}
): Promise<CompanyUsageSnapshotCounts> {
  const useCache = options.useCache !== false;
  const cacheKey = buildCompanyUsageSnapshotCacheKey(companyId);
  if (useCache) {
    const cached = await cache.get<CompanyUsageSnapshotCounts>(cacheKey);
    if (cached?.companyId === companyId) {
      return cached;
    }
  }

  const { data, error } = await supabase
    .from("company_usage_snapshots")
    .select(
      [
        "company_id",
        "conversation_count",
        "workspace_count",
        "seat_count",
        "channel_count",
        "channel_types",
        "whatsapp_number_count",
        "integration_connection_counts",
        "max_integration_connection_count",
        "airi_auto_reply_count",
        "scenario_count",
        "bulk_campaign_count",
        "classification_count",
        "coach_count",
        "studio_chat_count",
        "last_event_at",
        "repaired_at",
        "updated_at",
      ].join(", ")
    )
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  let row = data as CompanyUsageSnapshotRow | null;
  if (!row && options.repairMissingSnapshot) {
    row = await options.repairMissingSnapshot(companyId);
  }

  const snapshot = normalizeCompanyUsageSnapshotRow(
    row ?? { company_id: companyId },
    options.minimumWorkspaceCount
  );

  if (useCache) {
    await cache.set(
      cacheKey,
      snapshot,
      COMPANY_USAGE_SNAPSHOT_CACHE_TTL_SECONDS
    );
  }

  return snapshot;
}

export async function applyWorkspaceUsageEvents(
  supabase: SupabaseClient,
  events: WorkspaceUsageEvent[]
): Promise<ApplyWorkspaceUsageEventsResult> {
  if (events.length === 0) {
    return { processed: 0, duplicates: 0 };
  }

  const { data, error } = await supabase.rpc("apply_workspace_usage_events", {
    events,
  });

  if (error) {
    throw new Error(error.message);
  }

  const payload = (data ?? {}) as Partial<ApplyWorkspaceUsageEventsResult>;
  await Promise.all(
    Array.from(new Set(events.map(event => event.companyId))).map(companyId =>
      invalidateCompanyUsageSnapshotCache(companyId)
    )
  );

  return {
    processed: normalizeCount(payload.processed),
    duplicates: normalizeCount(payload.duplicates),
  };
}

export function normalizeCompanyUsageSnapshotRow(
  row: CompanyUsageSnapshotRow,
  minimumWorkspaceCount = 0
): CompanyUsageSnapshotCounts {
  const integrationConnectionCounts = normalizeIntegrationConnectionCounts(
    row.integration_connection_counts
  );
  const channelTypes = Array.isArray(row.channel_types)
    ? row.channel_types.filter(type => typeof type === "string").sort()
    : Object.entries(integrationConnectionCounts)
        .filter(([, count]) => count > 0)
        .map(([type]) => type)
        .sort();

  const maxIntegrationConnectionCount =
    normalizeCount(row.max_integration_connection_count) ||
    Object.values(integrationConnectionCounts).reduce(
      (max, count) => Math.max(max, count),
      0
    );

  return {
    companyId: row.company_id,
    conversationCount: normalizeCount(row.conversation_count),
    workspaceCount: Math.max(
      normalizeCount(row.workspace_count),
      minimumWorkspaceCount
    ),
    seatCount: normalizeCount(row.seat_count),
    channelCount: normalizeCount(row.channel_count) || channelTypes.length,
    channelTypes,
    whatsappNumberCount: normalizeCount(row.whatsapp_number_count),
    integrationConnectionCounts,
    maxIntegrationConnectionCount,
    airiAutoReplyCount: normalizeCount(row.airi_auto_reply_count),
    scenarioCount: normalizeCount(row.scenario_count),
    bulkCampaignCount: normalizeCount(row.bulk_campaign_count),
    classificationCount: normalizeCount(row.classification_count),
    coachCount: normalizeCount(row.coach_count),
    studioChatCount: normalizeCount(row.studio_chat_count),
    lastEventAt: row.last_event_at ?? null,
    repairedAt: row.repaired_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function normalizeIntegrationConnectionCounts(
  value: Record<string, unknown> | null | undefined
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!value || typeof value !== "object") return counts;
  for (const [key, rawCount] of Object.entries(value)) {
    const normalizedKey = key.trim().toLowerCase();
    const count = normalizeCount(rawCount);
    if (normalizedKey && count > 0) {
      counts[normalizedKey] = count;
    }
  }
  return counts;
}
