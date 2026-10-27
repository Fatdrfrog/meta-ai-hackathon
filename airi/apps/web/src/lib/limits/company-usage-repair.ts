import connectDB from "@/lib/mongoose";
import { CreativeStudioChat } from "@/models/creative-studio-chat";
import { Conversation } from "@/models/conversation";
import { Scenario } from "@/models/scenario";
import { isOnboardingTestSource } from "@icecore/shared/types/sources";
import {
  WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
  type WorkspaceUsageRepairActivityInput,
  type WorkspaceUsageRepairActivityResult,
  type WorkspaceUsageRepairCompanyResult,
} from "@icecore/temporal";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  campaignHistoryCountsTowardBulkLimit,
  type CampaignHistoryLimitRow,
} from "@/lib/campaign/campaign-history-limit";
import {
  invalidateCompanyUsageSnapshotCache,
  type CompanyUsageSnapshotRow,
} from "./company-usage-snapshots";
import "server-only";
import {
  isNonEmptyString,
  readNonNegativeCount,
} from "@icecore/shared/lib/value-utils";

type WorkspaceRow = {
  id?: string | null;
  company_id?: string | null;
};

type SourceRow = {
  type?: unknown;
  credentials?: unknown;
};

type CompanySourceUsageSummary = {
  channelTypes: string[];
  integrationConnectionCounts: Record<string, number>;
  whatsappNumberCount: number;
  maxIntegrationConnectionCount: number;
};

type CompanyUsageRepairResult = {
  result: WorkspaceUsageRepairCompanyResult;
  snapshotRow: CompanyUsageSnapshotRow;
};

const LIMITED_SOURCE_TYPES = new Set([
  "canva",
  "email",
  "elevenlabs",
  "google_calendar",
  "higgsfield",
  "instagram",
  "intercom",
  "meta_ads",
  "teams",
  "telegram",
  "web_widget",
  "whatsapp",
]);

export async function repairCompanyUsageSnapshots(
  supabase: SupabaseClient,
  input: WorkspaceUsageRepairActivityInput
): Promise<WorkspaceUsageRepairActivityResult> {
  const companyIds = await resolveRepairCompanyIds(supabase, input);
  await connectDB();

  const companies: WorkspaceUsageRepairCompanyResult[] = [];
  for (const companyId of companyIds) {
    const { result } = await repairSingleCompanyUsageSnapshot(
      supabase,
      companyId,
      input
    );
    companies.push(result);
  }

  return {
    scannedCompanies: companyIds.length,
    repairedCompanies: companies.length,
    companies,
  };
}

export async function repairCompanyUsageSnapshot(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyUsageSnapshotRow> {
  await connectDB();
  const { snapshotRow } = await repairSingleCompanyUsageSnapshot(
    supabase,
    companyId,
    {
      contractVersion: WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
      companyIds: [companyId],
      reason: "single_company_repair",
      includeHistoricalMessageCounts: false,
    }
  );
  return snapshotRow;
}

async function resolveRepairCompanyIds(
  supabase: SupabaseClient,
  input: WorkspaceUsageRepairActivityInput
): Promise<string[]> {
  const explicitCompanyIds = Array.from(
    new Set((input.companyIds ?? []).filter(isNonEmptyString))
  );
  if (explicitCompanyIds.length > 0) {
    return explicitCompanyIds.slice(0, normalizeLimit(input.limit));
  }

  const workspaceIds = Array.from(
    new Set((input.workspaceIds ?? []).filter(isNonEmptyString))
  );
  if (workspaceIds.length > 0) {
    const { data, error } = await supabase
      .from("workspaces")
      .select("company_id")
      .in("id", workspaceIds);
    if (error) throw new Error(error.message);
    return Array.from(
      new Set(
        ((data ?? []) as WorkspaceRow[])
          .map(row => row.company_id)
          .filter(isNonEmptyString)
      )
    ).slice(0, normalizeLimit(input.limit));
  }

  const { data, error } = await supabase
    .from("companies")
    .select("id")
    .limit(normalizeLimit(input.limit));
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<{ id?: string | null }>)
    .map(row => row.id)
    .filter(isNonEmptyString);
}

async function repairSingleCompanyUsageSnapshot(
  supabase: SupabaseClient,
  companyId: string,
  input: WorkspaceUsageRepairActivityInput
): Promise<CompanyUsageRepairResult> {
  const workspaceIds = await getCompanyWorkspaceIds(supabase, companyId);
  // Historical message scans produce pathological docs-examined/returned
  // ratios at production scale. The Airi count is maintained by write-time
  // usage events, so repair preserves the materialized snapshot value.
  const existingSnapshot = await readExistingCompanyUsageSnapshotRow(
    supabase,
    companyId
  );
  const [
    conversationCount,
    airiAutoReplyCount,
    scenarioCount,
    seatCount,
    sourceSummary,
    bulkCampaignCount,
    classificationCount,
    coachCount,
    studioChatCount,
  ] = await Promise.all([
    Conversation.countDocuments({
      workspaceId: { $in: workspaceIds },
    }),
    Promise.resolve(
      readNonNegativeCount(existingSnapshot?.airi_auto_reply_count)
    ),
    Scenario.countDocuments({
      workspaceId: { $in: workspaceIds },
      deletedAt: null,
    }),
    getCompanySeatCount(supabase, workspaceIds),
    getCompanySourceUsageSummary(supabase, workspaceIds),
    getCompanyBulkCampaignCount(supabase, workspaceIds),
    Conversation.countDocuments({
      workspaceId: { $in: workspaceIds },
      "classification.category": { $exists: true, $nin: [null, ""] },
    }),
    getCompanyCoachSessionCount(supabase, workspaceIds),
    CreativeStudioChat.countDocuments({
      workspaceId: { $in: workspaceIds },
    }),
  ]);

  const repairedAt = new Date().toISOString();
  const snapshotRow: CompanyUsageSnapshotRow = {
    company_id: companyId,
    conversation_count: conversationCount,
    workspace_count: workspaceIds.length,
    seat_count: seatCount,
    channel_count: sourceSummary.channelTypes.length,
    channel_types: sourceSummary.channelTypes,
    whatsapp_number_count: sourceSummary.whatsappNumberCount,
    integration_connection_counts: sourceSummary.integrationConnectionCounts,
    max_integration_connection_count:
      sourceSummary.maxIntegrationConnectionCount,
    airi_auto_reply_count: airiAutoReplyCount,
    scenario_count: scenarioCount,
    bulk_campaign_count: bulkCampaignCount,
    classification_count: classificationCount,
    coach_count: coachCount,
    studio_chat_count: studioChatCount,
    repaired_at: repairedAt,
    updated_at: repairedAt,
  };

  const { error } = await supabase
    .from("company_usage_snapshots")
    .upsert(snapshotRow, { onConflict: "company_id" });
  if (error) throw new Error(error.message);

  await invalidateCompanyUsageSnapshotCache(companyId);

  return {
    snapshotRow,
    result: {
      companyId,
      workspaceCount: workspaceIds.length,
      conversationCount,
      airiAutoReplyCount,
      scenarioCount,
      sourceConnectionCount: Object.values(
        sourceSummary.integrationConnectionCounts
      ).reduce((total, count) => total + count, 0),
    },
  };
}

async function readExistingCompanyUsageSnapshotRow(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyUsageSnapshotRow | null> {
  const { data, error } = await supabase
    .from("company_usage_snapshots")
    .select("company_id, airi_auto_reply_count")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data ?? null) as CompanyUsageSnapshotRow | null;
}

async function getCompanyWorkspaceIds(
  supabase: SupabaseClient,
  companyId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id")
    .eq("company_id", companyId);
  if (error) throw new Error(error.message);

  return ((data ?? []) as WorkspaceRow[])
    .map(row => row.id)
    .filter(isNonEmptyString);
}

async function getCompanySeatCount(
  supabase: SupabaseClient,
  workspaceIds: string[]
): Promise<number> {
  if (workspaceIds.length === 0) return 0;

  const { data, error } = await supabase
    .from("company_users")
    .select("user_id")
    .in("workspace_id", workspaceIds);
  if (error) throw new Error(error.message);

  return new Set(
    ((data ?? []) as Array<{ user_id?: string | null }>)
      .map(row => row.user_id)
      .filter(isNonEmptyString)
  ).size;
}

async function getCompanySourceUsageSummary(
  supabase: SupabaseClient,
  workspaceIds: string[]
): Promise<CompanySourceUsageSummary> {
  if (workspaceIds.length === 0) {
    return {
      channelTypes: [],
      integrationConnectionCounts: {},
      whatsappNumberCount: 0,
      maxIntegrationConnectionCount: 0,
    };
  }

  const { data, error } = await supabase
    .from("sources")
    .select("type, credentials")
    .in("workspace_id", workspaceIds);
  if (error) throw new Error(error.message);

  const channelTypes = new Set<string>();
  const integrationConnectionCounts: Record<string, number> = {};
  let whatsappNumberCount = 0;
  let maxIntegrationConnectionCount = 0;

  for (const source of (data ?? []) as SourceRow[]) {
    if (isOnboardingTestSource(source)) continue;
    const sourceType =
      typeof source.type === "string" ? source.type.trim().toLowerCase() : "";
    if (!LIMITED_SOURCE_TYPES.has(sourceType)) continue;

    channelTypes.add(sourceType);
    const nextCount = (integrationConnectionCounts[sourceType] ?? 0) + 1;
    integrationConnectionCounts[sourceType] = nextCount;
    maxIntegrationConnectionCount = Math.max(
      maxIntegrationConnectionCount,
      nextCount
    );
    if (sourceType === "whatsapp") whatsappNumberCount += 1;
  }

  return {
    channelTypes: Array.from(channelTypes).sort(),
    integrationConnectionCounts,
    whatsappNumberCount,
    maxIntegrationConnectionCount,
  };
}

async function getCompanyBulkCampaignCount(
  supabase: SupabaseClient,
  workspaceIds: string[]
): Promise<number> {
  if (workspaceIds.length === 0) return 0;

  const pageSize = 1000;
  let offset = 0;
  let count = 0;

  while (true) {
    const { data, error } = await supabase
      .from("campaign_history")
      .select("total_recipients, successful_sends, failed_sends")
      .in("workspace_id", workspaceIds)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as CampaignHistoryLimitRow[];
    count += rows.filter(campaignHistoryCountsTowardBulkLimit).length;
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return count;
}

async function getCompanyCoachSessionCount(
  supabase: SupabaseClient,
  workspaceIds: string[]
): Promise<number> {
  if (workspaceIds.length === 0) return 0;

  const { count, error } = await supabase
    .from("airi_sessions")
    .select("id", { count: "exact", head: true })
    .in("workspace_id", workspaceIds)
    .eq("skipped", false);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

function normalizeLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 1000);
}
