import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCompanyConversationLimitSnapshotFromUsage,
  type CompanyLimitCompanyConfig,
  readCompanyBulkRecipientUsage,
  toPublicLimitPayload,
} from "./company-limits";
import {
  normalizeCompanyUsageSnapshotRow,
  type CompanyUsageSnapshotRow,
} from "./company-usage-snapshots";
import { isInternalLimitsCompany } from "./internal-limits-company";
import "server-only";
import {
  readTrimmedString,
  isNonEmptyString,
} from "@icecore/shared/lib/value-utils";

const MAX_COMPANY_LIMIT_SUMMARY_ROWS = 500;

const COMPANY_SELECT = [
  "id",
  "name",
  "slug",
  "subscription_type",
  "trial_starts_at",
  "trial_ends_at",
  "seat_limit",
  "workspace_limit",
  "whatsapp_number_limit",
  "created_at",
].join(", ");

const WORKSPACE_SELECT = ["id", "name", "company_id", "created_at"].join(", ");

const USAGE_SNAPSHOT_SELECT = [
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
].join(", ");

type CompanyLimitCompanyRow = CompanyLimitCompanyConfig & {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
  created_at?: string | null;
};

type CompanyLimitWorkspaceRow = {
  id?: string | null;
  name?: string | null;
  company_id?: string | null;
  created_at?: string | null;
};

export type CompanyLimitSummary = {
  company: {
    id: string;
    name: string;
    slug: string | null;
    createdAt: string | null;
  };
  workspaces: Array<{
    id: string;
    name: string;
    createdAt: string | null;
  }>;
  isInternalCompany: boolean;
  limit: ReturnType<typeof toPublicLimitPayload>;
  trial: {
    rawDaysRemaining: number | null;
    fullDaysRemaining: number | null;
    calendarDaysRemaining: number | null;
  };
  snapshot: {
    missing: boolean;
    updatedAt: string | null;
    repairedAt: string | null;
    lastEventAt: string | null;
  };
};

export type CompanyLimitSummariesResult = {
  companies: CompanyLimitSummary[];
  totalCompanies: number | null;
  truncated: boolean;
  rowLimit: number;
  generatedAt: string;
};

type GetCompanyLimitSummariesOptions = {
  limit?: number;
};

function normalizeBoundedLimit(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1)
    return MAX_COMPANY_LIMIT_SUMMARY_ROWS;
  return Math.min(Math.floor(parsed), MAX_COMPANY_LIMIT_SUMMARY_ROWS);
}

function getTrialDaysRemaining(trialEndsAt: string | null): {
  rawDaysRemaining: number | null;
  fullDaysRemaining: number | null;
  calendarDaysRemaining: number | null;
} {
  if (!trialEndsAt) {
    return {
      rawDaysRemaining: null,
      fullDaysRemaining: null,
      calendarDaysRemaining: null,
    };
  }

  const timestamp = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(timestamp)) {
    return {
      rawDaysRemaining: null,
      fullDaysRemaining: null,
      calendarDaysRemaining: null,
    };
  }

  const rawDaysRemaining = (timestamp - Date.now()) / 86_400_000;
  return {
    rawDaysRemaining,
    fullDaysRemaining: Math.max(0, Math.floor(rawDaysRemaining)),
    calendarDaysRemaining: Math.max(0, Math.ceil(rawDaysRemaining)),
  };
}

function mapByCompanyId<T extends { company_id?: string | null }>(
  rows: T[]
): Map<string, T[]> {
  const rowsByCompany = new Map<string, T[]>();

  for (const row of rows) {
    const companyId = readTrimmedString(row.company_id);
    if (!companyId) continue;

    const companyRows = rowsByCompany.get(companyId) ?? [];
    companyRows.push(row);
    rowsByCompany.set(companyId, companyRows);
  }

  return rowsByCompany;
}

export async function getCompanyLimitSummaries(
  supabase: SupabaseClient,
  options: GetCompanyLimitSummariesOptions = {}
): Promise<CompanyLimitSummariesResult> {
  const rowLimit = normalizeBoundedLimit(options.limit);
  const {
    data: companyRows,
    error: companyError,
    count,
  } = await supabase
    .from("companies")
    .select(COMPANY_SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(0, rowLimit - 1);

  if (companyError) {
    throw new Error(companyError.message);
  }

  const companies = ((companyRows ?? []) as CompanyLimitCompanyRow[]).filter(
    company => isNonEmptyString(company.id)
  );
  const companyIds = companies.map(company => company.id as string);

  if (companyIds.length === 0) {
    return {
      companies: [],
      totalCompanies: count ?? 0,
      truncated: false,
      rowLimit,
      generatedAt: new Date().toISOString(),
    };
  }

  const [workspaceResult, snapshotResult, bulkRecipientUsage] =
    await Promise.all([
      supabase
        .from("workspaces")
        .select(WORKSPACE_SELECT)
        .in("company_id", companyIds),
      supabase
        .from("company_usage_snapshots")
        .select(USAGE_SNAPSHOT_SELECT)
        .in("company_id", companyIds),
      readCompanyBulkRecipientUsage(supabase, companyIds),
    ]);

  if (workspaceResult.error) {
    throw new Error(workspaceResult.error.message);
  }
  if (snapshotResult.error) {
    throw new Error(snapshotResult.error.message);
  }

  const workspacesByCompanyId = mapByCompanyId(
    (workspaceResult.data ?? []) as CompanyLimitWorkspaceRow[]
  );
  const snapshotsByCompanyId = new Map(
    ((snapshotResult.data ?? []) as unknown as CompanyUsageSnapshotRow[])
      .filter(row => isNonEmptyString(row.company_id))
      .map(row => [row.company_id, row])
  );

  const summaries = companies.map(company => {
    const companyId = company.id as string;
    const workspaceRows = (workspacesByCompanyId.get(companyId) ?? []).filter(
      workspace => isNonEmptyString(workspace.id)
    );
    const workspaceIds = workspaceRows.map(workspace => workspace.id as string);
    const usageRow = snapshotsByCompanyId.get(companyId) ?? null;
    const usage = normalizeCompanyUsageSnapshotRow(
      usageRow ?? { company_id: companyId },
      workspaceIds.length
    );
    const snapshot = buildCompanyConversationLimitSnapshotFromUsage({
      companyId,
      company,
      usage,
      workspaceIds,
      minimumWorkspaceCount: workspaceIds.length,
      bulkRecipientCount: bulkRecipientUsage.get(companyId) ?? null,
    });
    const publicLimit = toPublicLimitPayload(snapshot);

    return {
      company: {
        id: companyId,
        name: readTrimmedString(company.name) || "Untitled company",
        slug: readTrimmedString(company.slug) || null,
        createdAt: company.created_at ?? null,
      },
      workspaces: workspaceRows.map(workspace => ({
        id: workspace.id as string,
        name: readTrimmedString(workspace.name) || "Untitled workspace",
        createdAt: workspace.created_at ?? null,
      })),
      isInternalCompany: isInternalLimitsCompany(company),
      limit: publicLimit,
      trial: getTrialDaysRemaining(publicLimit.trialEndsAt),
      snapshot: {
        missing: !usageRow,
        updatedAt: usageRow?.updated_at ?? null,
        repairedAt: usageRow?.repaired_at ?? null,
        lastEventAt: usageRow?.last_event_at ?? null,
      },
    } satisfies CompanyLimitSummary;
  });

  return {
    companies: summaries,
    totalCompanies: count ?? null,
    truncated: typeof count === "number" ? count > companies.length : false,
    rowLimit,
    generatedAt: new Date().toISOString(),
  };
}
