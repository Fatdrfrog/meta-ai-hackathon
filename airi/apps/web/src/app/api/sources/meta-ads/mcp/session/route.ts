import { decryptMaybeString } from "@/lib/crypto";
import { fetchMetaAdsAdAccountById } from "@/lib/meta-ads/meta-ads-accounts";
import { extractMetaAdsMcpCredentialFields } from "@/lib/meta-ads/meta-ads-mcp-credentials";
import {
  evaluateMetaAdsMcpReadiness,
  normalizeMetaAdsMcpAdAccountInventory,
  normalizeMetaAdsMcpScopes,
} from "@/lib/meta-ads/meta-ads-mcp-readiness";
import {
  getMetaAdsAppConfig,
  resolveMetaAdsMcpLoginConfigId,
  resolveMetaAdsLoginConfigId,
} from "@/lib/meta-ads/meta-ads-login-config";
import { normalizeMetaAdsAdAccounts } from "@/lib/meta-ads/meta-ads-source";
import { getMetaAdsReportingReadiness } from "@/lib/meta-ads/meta-ads-reporting-readiness";
import type { MetaAdsMcpSessionPayload } from "@/lib/meta-ads/connect-meta-ads-mcp-client";
import {
  loadMetaAdsMcpSource as loadSource,
  metaAdsMcpCredentialContext as credentialContext,
  compareAndSetMetaAdsMcpCredentials as compareAndSetCredentials,
  refreshMetaAdsMcpSourceReadiness,
  type MetaAdsMcpSource as SourceRow,
} from "@/lib/meta-ads/mcp/readiness-service";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { noStoreJson } from "@/lib/http/no-store-json";
import { readJsonBodyOrResponse } from "@/lib/api/json-body";
import { asRecord } from "@icecore/shared/lib/value-utils";

const json = (body: unknown, status = 200) =>
  noStoreJson(body, status, { cacheControl: "no-store" });

function requestString(value: unknown, maxLength = 100): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

async function authorizeWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { response: json({ error: "Unauthorized" }, 401) };

  const hasAccess = await checkUserWorkspaceAccess(
    supabase,
    user.id,
    workspaceId
  );
  if (!hasAccess) return { response: json({ error: "Forbidden" }, 403) };
  const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
  if (!companyId)
    return { response: json({ error: "workspace_missing" }, 404) };
  return { supabase, companyId };
}

function sessionPayload(params: {
  source: SourceRow | null;
  tokenUsable?: boolean;
}): MetaAdsMcpSessionPayload {
  const appConfigured = Boolean(getMetaAdsAppConfig());
  const configId = resolveMetaAdsMcpLoginConfigId() || null;
  const raw = asRecord(params.source?.credentials);
  const reporting = getMetaAdsReportingReadiness(raw);
  return {
    appConfigured,
    configId,
    reportingConfigId: resolveMetaAdsLoginConfigId() || null,
    reporting,
    adAccounts: normalizeMetaAdsAdAccounts(raw.ad_accounts),
    selectedAdAccountId: reporting.selectedAdAccountId,
    hasMetaAdsSource: Boolean(params.source?.id),
    canConnect: appConfigured && Boolean(configId),
    readiness: evaluateMetaAdsMcpReadiness({
      hasMetaAdsSource: Boolean(params.source?.id),
      credentials: params.source?.credentials,
      ...(params.tokenUsable === undefined
        ? {}
        : { tokenUsable: params.tokenUsable }),
    }),
  };
}

async function conflictResponse(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  sourceId: string;
}) {
  const latest = await loadSource(
    params.supabase,
    params.workspaceId,
    params.sourceId
  );
  return json(
    {
      error: "mcp_session_conflict",
      ...sessionPayload({ source: latest.source }),
    },
    409
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspaceId = (searchParams.get("workspaceId") || "").trim();
  const shouldProbe = searchParams.get("probe") === "1";
  if (!workspaceId) return json({ error: "workspaceId is required" }, 400);

  const authorization = await authorizeWorkspace(workspaceId);
  if ("response" in authorization) return authorization.response;
  const { supabase, companyId } = authorization;

  const loaded = await loadSource(supabase, workspaceId);
  if (loaded.error)
    return json({ error: "Failed to load Meta Ads source" }, 500);
  if (loaded.source && loaded.source.company_id !== companyId)
    return json({ error: "source_company_mismatch" }, 409);
  if (!shouldProbe || !loaded.source) {
    return json(sessionPayload({ source: loaded.source }));
  }

  const refreshed = await refreshMetaAdsMcpSourceReadiness({
    supabase,
    workspaceId,
    source: loaded.source,
    signal: request.signal,
  });
  if (refreshed.status === 409) {
    return conflictResponse({
      supabase,
      workspaceId,
      sourceId: loaded.source.id,
    });
  }
  if (refreshed.error)
    return json({ error: refreshed.error }, refreshed.status ?? 500);
  return json(
    sessionPayload({
      source: refreshed.source,
      tokenUsable: refreshed.tokenUsable,
    })
  );
}

export async function PATCH(request: NextRequest) {
  const bodyResult = await readJsonBodyOrResponse(request, {
    headers: { "Cache-Control": "no-store" },
  });
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.body;
  const rawBody = asRecord(body);
  if (
    body === null ||
    Array.isArray(body) ||
    Object.keys(rawBody).some(
      key => key !== "workspaceId" && key !== "adAccountId"
    )
  ) {
    return json({ error: "Invalid request body" }, 400);
  }
  const workspaceId = requestString(rawBody.workspaceId);
  const adAccountId = requestString(rawBody.adAccountId);
  if (!workspaceId || !adAccountId) {
    return json({ error: "workspaceId and adAccountId are required" }, 400);
  }

  const authorization = await authorizeWorkspace(workspaceId);
  if ("response" in authorization) return authorization.response;
  const { supabase, companyId } = authorization;
  const loaded = await loadSource(supabase, workspaceId);
  if (loaded.error)
    return json({ error: "Failed to load Meta Ads source" }, 500);
  if (!loaded.source) return json({ error: "Meta Ads source not found" }, 404);
  if (loaded.source.company_id !== companyId)
    return json({ error: "source_company_mismatch" }, 409);

  const initialContext = credentialContext(loaded.source);
  const initialFields = extractMetaAdsMcpCredentialFields(
    loaded.source.credentials
  );
  const initialRaw = asRecord(loaded.source.credentials);
  const accessToken = decryptMaybeString(initialRaw.access_token);
  if (!accessToken) {
    return json(
      sessionPayload({ source: loaded.source, tokenUsable: false }),
      400
    );
  }

  let selectedAccount;
  try {
    selectedAccount = await fetchMetaAdsAdAccountById({
      accessToken,
      adAccountId,
      grantedScopes: normalizeMetaAdsMcpScopes(initialRaw.scope),
    });
  } catch {
    return json({ error: "Failed to verify Meta Ads account" }, 502);
  }
  if (!selectedAccount) {
    return json({ error: "Meta Ads account is not accessible" }, 400);
  }

  const latest = await loadSource(supabase, workspaceId, loaded.source.id);
  if (latest.error || !latest.source) {
    return json(
      {
        error: latest.error
          ? "Failed to load Meta Ads source"
          : "Source not found",
      },
      latest.error ? 500 : 404
    );
  }
  const latestContext = credentialContext(latest.source);
  if (
    latestContext.connectionId !== initialContext.connectionId ||
    latestContext.selectedAdAccountId !== initialContext.selectedAdAccountId ||
    latestContext.assetsCheckedAt !== initialContext.assetsCheckedAt ||
    latestContext.updatedAt !== initialContext.updatedAt ||
    latestContext.companyId !== initialContext.companyId
  ) {
    return conflictResponse({
      supabase,
      workspaceId,
      sourceId: loaded.source.id,
    });
  }

  const latestRaw = asRecord(latest.source.credentials);
  const latestFields = extractMetaAdsMcpCredentialFields(
    latest.source.credentials
  );
  const inventory = normalizeMetaAdsMcpAdAccountInventory([
    ...(latestFields.mcp_ad_account_ids || []),
    selectedAccount.id,
  ]);
  let accountIds = inventory.ids;
  if (!accountIds.includes(selectedAccount.id)) {
    accountIds = [...accountIds.slice(0, 499), selectedAccount.id].sort();
  }
  const checkedAt = new Date().toISOString();
  const accounts = normalizeMetaAdsAdAccounts(latestRaw.ad_accounts).filter(
    account => account.id !== selectedAccount.id
  );
  const credentials: Record<string, unknown> = {
    ...latestRaw,
    selected_ad_account_id: selectedAccount.id,
    ad_accounts: [...accounts, selectedAccount],
    ad_accounts_checked_at: checkedAt,
  };
  delete credentials.ad_accounts_error;
  // Provider rollout/queryability is account-specific; a Graph selection cannot
  // transfer the previous account's successful MCP evidence to another account.
  if (latestContext.selectedAdAccountId !== selectedAccount.id) {
    delete credentials.mcp_provider_probe;
  }
  // A Graph-only selection works independently. Evidence from a distinct old
  // AI token cannot inherit account access verified with this Graph token.
  const sameToken =
    initialContext.connectionId &&
    decryptMaybeString(initialFields.mcp_access_token) === accessToken;
  if (sameToken) {
    Object.assign(credentials, {
      mcp_ad_account_ids: accountIds,
      mcp_ad_accounts_truncated:
        latestFields.mcp_ad_accounts_truncated === true || inventory.truncated,
      mcp_selected_ad_account: selectedAccount,
      mcp_assets_checked_at: checkedAt,
    });
  } else {
    delete credentials.mcp_selected_ad_account;
    delete credentials.mcp_assets_checked_at;
    delete credentials.mcp_provider_probe;
  }
  const saved = await compareAndSetCredentials({
    supabase,
    workspaceId,
    sourceId: latest.source.id,
    expected: latestContext,
    credentials,
  });
  if (saved.error)
    return json({ error: "Failed to update Meta Ads source" }, 500);
  if (!saved.source) {
    return conflictResponse({
      supabase,
      workspaceId,
      sourceId: latest.source.id,
    });
  }
  return json(sessionPayload({ source: saved.source }));
}
