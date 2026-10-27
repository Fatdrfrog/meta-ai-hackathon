import { supabaseAdmin } from "@/lib/supabase/admin";

type CompanyContext = {
  businessContext?: string;
  dynamicTags?: string[];
  airiLanguage?: "en" | "ru" | "kz" | "uz" | null;
};

const COMPANY_CONTEXT_CACHE_TTL_MS = 60_000;
const companyContextBySource = new Map<
  string,
  { expiresAt: number; value: CompanyContext }
>();

function readCachedCompanyContext(sourceId: string): CompanyContext | null {
  const cached = companyContextBySource.get(sourceId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    companyContextBySource.delete(sourceId);
    return null;
  }
  return cached.value;
}

function writeCachedCompanyContext(sourceId: string, value: CompanyContext) {
  companyContextBySource.set(sourceId, {
    expiresAt: Date.now() + COMPANY_CONTEXT_CACHE_TTL_MS,
    value,
  });
}

export async function fetchCompanyContextBySourceId(sourceId: string): Promise<{
  businessContext?: string;
  dynamicTags?: string[];
  airiLanguage?: "en" | "ru" | "kz" | "uz" | null;
}> {
  const normalizedSourceId = sourceId.trim();
  const cached = normalizedSourceId
    ? readCachedCompanyContext(normalizedSourceId)
    : null;
  if (cached) return cached;

  try {
    const supabase = await supabaseAdmin;
    const { data: sourceRow } = await supabase
      .from("sources")
      .select(
        "companies(business_context, dynamic_context_tags, airi_language)"
      )
      .eq("id", normalizedSourceId || sourceId)
      .single();
    const company = Array.isArray(sourceRow?.companies)
      ? sourceRow?.companies?.[0]
      : sourceRow?.companies;
    const result = {
      businessContext: company?.business_context || undefined,
      dynamicTags: company?.dynamic_context_tags || undefined,
      airiLanguage: company?.airi_language || undefined,
    };
    if (normalizedSourceId) {
      writeCachedCompanyContext(normalizedSourceId, result);
    }
    return result;
  } catch {
    return {};
  }
}

export async function fetchCompanyContextByWorkspace(
  workspaceId: string
): Promise<{
  businessContext?: string;
  dynamicTags?: string[];
  airiLanguage?: "en" | "ru" | "kz" | "uz" | null;
}> {
  try {
    const supabase = await supabaseAdmin;

    // First, get the company_id from workspace
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("company_id")
      .eq("id", workspaceId)
      .single();

    if (!workspace?.company_id) {
      console.warn(
        "[Company Context] No company_id found for workspace:",
        workspaceId
      );
      return {};
    }

    // Then fetch company context directly
    const { data: company } = await supabase
      .from("companies")
      .select("business_context, dynamic_context_tags, airi_language")
      .eq("id", workspace.company_id)
      .single();

    const result = {
      businessContext: company?.business_context || undefined,
      dynamicTags: company?.dynamic_context_tags || undefined,
      airiLanguage: company?.airi_language || undefined,
    };

    console.log("[Company Context] Fetched for workspace:", {
      workspaceId,
      companyId: workspace.company_id,
      airiLanguage: result.airiLanguage,
      hasBusinessContext: !!result.businessContext,
    });

    return result;
  } catch (err) {
    console.error("[Company Context] Error fetching:", err);
    return {};
  }
}
