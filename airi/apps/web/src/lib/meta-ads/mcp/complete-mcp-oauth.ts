import { randomUUID } from "node:crypto";
import { encryptString } from "@/lib/crypto";
import { fetchMetaAdsAdAccountInventory } from "@/lib/meta-ads/meta-ads-accounts";
import { getMetaAdsAppConfig } from "@/lib/meta-ads/meta-ads-login-config";
import {
  buildMetaAdsMcpCredentialFields,
  mergeMetaAdsCredentialsWithMcp,
} from "@/lib/meta-ads/meta-ads-mcp-credentials";
import {
  evaluateMetaAdsMcpReadiness,
  normalizeMetaAdsMcpScopes,
} from "@/lib/meta-ads/meta-ads-mcp-readiness";
import {
  fetchMetaOAuthUser,
  metaOAuthErrorDetails,
  resolveMetaAdsOAuthAccessToken,
} from "@/lib/meta-ads/meta-ads-oauth-exchange";
import {
  buildMetaAdsCredentials,
  META_ADS_SOURCE_TYPE,
  summarizeMetaAdsSourceName,
} from "@/lib/meta-ads/meta-ads-source";
import {
  getMetaAdsReportingReadiness,
  type MetaAdsReportingReadiness,
} from "@/lib/meta-ads/meta-ads-reporting-readiness";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import { createServerLogger } from "@/lib/observability/server-logs";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { evaluateMetaAccessToken } from "@icecore/shared/lib/meta/debug-token";
import type {
  MetaAdsAdAccount,
  MetaAdsMcpReadiness,
} from "@icecore/shared/types/sources";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  asRecord,
  readNonEmptyStringOrUndefined as optionalString,
} from "@icecore/shared/lib/value-utils";

const logger = createServerLogger("meta-ads.oauth.complete");

export type MetaAdsConnectionIntent = "reporting" | "ai_ads";

type CompleteMetaAdsMcpOAuthParams = {
  supabase: SupabaseClient;
  workspaceId: string;
  code: string;
  redirectUri?: string | null;
  allowCreateGraphSource?: boolean;
  intent?: MetaAdsConnectionIntent;
};

export type CompleteMetaAdsMcpOAuthResult =
  | {
      ok: true;
      createdSource: boolean;
      reportingReady: boolean;
      reporting: MetaAdsReportingReadiness;
      readiness: MetaAdsMcpReadiness;
      adAccounts: MetaAdsAdAccount[];
      selectedAdAccountId: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      errorDetails?: string;
      adAccounts?: MetaAdsAdAccount[];
      selectedAdAccountId?: string;
    };

/** One authorization refreshes Graph and optional AI credentials together. The
 * provider MCP probe is a separate step so its outage cannot block reporting. */
export async function completeMetaAdsMcpOAuth(
  params: CompleteMetaAdsMcpOAuthParams
): Promise<CompleteMetaAdsMcpOAuthResult> {
  const config = getMetaAdsAppConfig();
  if (!config)
    return {
      ok: false,
      status: 500,
      error: "Meta Ads OAuth is not configured",
    };

  // Capture the source revision before external work. Never rebase this grant on
  // a concurrent reconnect or account change after the user has authorized it.
  const { data: existingSource, error: sourceError } = await params.supabase
    .from("sources")
    .select("id, company_id, credentials, updated_at")
    .eq("workspace_id", params.workspaceId)
    .eq("type", META_ADS_SOURCE_TYPE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sourceError)
    return { ok: false, status: 500, error: "Failed to load Meta Ads source" };
  if (!existingSource?.id && !params.allowCreateGraphSource) {
    return {
      ok: false,
      status: 400,
      error:
        "Connect Meta Ads first before enabling Ads MCP for this workspace",
    };
  }
  const companyId = await getCompanyIdForWorkspace(
    params.supabase,
    params.workspaceId
  );
  if (!companyId) return { ok: false, status: 400, error: "workspace_missing" };
  if (existingSource && existingSource.company_id !== companyId) {
    return { ok: false, status: 409, error: "source_company_mismatch" };
  }

  const tokenResult = await resolveMetaAdsOAuthAccessToken({
    code: params.code,
    appId: config.appId,
    appSecret: config.appSecret,
    redirectUri: params.redirectUri,
  });
  if (!tokenResult.ok)
    return {
      ok: false,
      status: 400,
      error: "mcp_token_exchange_failed",
      ...(metaOAuthErrorDetails(tokenResult.error)
        ? { errorDetails: metaOAuthErrorDetails(tokenResult.error) }
        : {}),
    };
  const { token: finalToken, shortLived: codeToken } = tokenResult;
  const connectedAt = new Date();
  let debug;
  try {
    debug = await debugConfiguredMetaAccessToken(finalToken.access_token, {
      appConfig: config,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { ok: false, status: 502, error: "token_verification_failed" };
  }
  const validity = evaluateMetaAccessToken(debug, {
    appId: config.appId,
    expiresIn: finalToken.expires_in,
    nowMs: connectedAt.getTime(),
  });
  if (!validity.valid)
    return { ok: false, status: 400, error: "token_verification_failed" };
  // Only the debugger's verified grants count; popup selections and OAuth scope
  // claims cannot prove which permissions survived the final token exchange.
  const scopes = normalizeMetaAdsMcpScopes(
    Array.isArray(debug.scopes) ? debug.scopes.join(" ") : undefined
  );
  if (!scopes.includes("ads_read") && !scopes.includes("ads_management"))
    return { ok: false, status: 400, error: "ads_permissions_missing" };
  const debugUserId =
    optionalString(debug.user_id) || optionalString(debug.profile_id);
  const metaUser = await fetchMetaOAuthUser(finalToken.access_token);
  if (!debugUserId || !metaUser?.id || debugUserId !== metaUser.id)
    return { ok: false, status: 400, error: "identity_verification_failed" };

  const raw = asRecord(existingSource?.credentials);
  const priorSelectedId = optionalString(raw.selected_ad_account_id);
  let discoveryFailed = false;
  const inventory = await fetchMetaAdsAdAccountInventory({
    accessToken: finalToken.access_token,
    selectedAdAccountId: priorSelectedId,
    grantedScopes: scopes,
    onError: error => {
      if (error.phase !== "selected_account") discoveryFailed = true;
    },
  });
  if (discoveryFailed)
    return { ok: false, status: 502, error: "ad_accounts_unavailable" };
  const selectedAccount = priorSelectedId
    ? inventory.accounts.find(account => account.id === priorSelectedId) ||
      (inventory.selectedAccount?.id === priorSelectedId
        ? inventory.selectedAccount
        : undefined)
    : inventory.accounts[0];
  if (!priorSelectedId && !selectedAccount)
    return { ok: false, status: 400, error: "no_ad_accounts" };
  // Keep an unavailable selection visible, but save the new verified grant so
  // the user can choose an accessible account without relying on a revoked token.
  const selectedAdAccountId = priorSelectedId || selectedAccount!.id;
  // A selected account verified by the direct fallback must retain its full
  // metadata even when the bounded paginated inventory did not include it.
  const accounts =
    !selectedAccount ||
    inventory.accounts.some(account => account.id === selectedAccount.id)
      ? inventory.accounts
      : [...inventory.accounts, selectedAccount];
  const encryptedToken = encryptString(finalToken.access_token);
  const scope = scopes.join(" ");
  const tokenType = finalToken.token_type || codeToken.token_type || "bearer";
  const verifiedAt = connectedAt.toISOString();
  const expiresAt = validity.expiresAt?.toISOString() ?? null;
  const neverExpires =
    validity.neverExpires &&
    (debug.data_access_expires_at === undefined ||
      debug.data_access_expires_at === 0);
  const graphFields = {
    ...raw,
    ...buildMetaAdsCredentials({
      encryptedAccessToken: encryptedToken,
      tokenType,
      scope,
      connectedAt: verifiedAt,
      userId: metaUser.id,
      userName: metaUser.name,
      adAccounts: accounts,
    }),
    expires_at: expiresAt,
    ads_never_expires: neverExpires,
    ads_scopes_verified_at: verifiedAt,
    ads_identity_verified_at: verifiedAt,
    selected_ad_account_id: selectedAdAccountId,
    ad_accounts: accounts,
    user_name: metaUser.name,
  };
  delete graphFields.ad_accounts_error;
  delete graphFields.ads_access_invalidated_at;
  const credentials = mergeMetaAdsCredentialsWithMcp({
    existing: graphFields,
    mcp: buildMetaAdsMcpCredentialFields({
      encryptedMcpAccessToken: encryptedToken,
      tokenType,
      expiresAt,
      neverExpires,
      scope,
      connectedAt: verifiedAt,
      connectionId: randomUUID(),
      userId: metaUser.id,
      userName: metaUser.name,
      scopesVerifiedAt: verifiedAt,
      adAccountIds: inventory.accessibleAdAccountIds,
      adAccountsTruncated: inventory.truncated,
      selectedAdAccount: selectedAccount,
      assetsCheckedAt: verifiedAt,
    }),
  });
  const name = summarizeMetaAdsSourceName(accounts.length);
  const query = existingSource?.id
    ? params.supabase
        .from("sources")
        .update({ name, credentials })
        .eq("id", existingSource.id)
        .eq("company_id", companyId)
        .eq("workspace_id", params.workspaceId)
        .eq("type", META_ADS_SOURCE_TYPE)
        .eq("updated_at", existingSource.updated_at)
    : params.supabase.from("sources").insert({
        company_id: companyId,
        workspace_id: params.workspaceId,
        type: META_ADS_SOURCE_TYPE,
        name,
        credentials,
      });
  const { data: savedSource, error: saveError } = await query
    .select("id")
    .maybeSingle();
  if (saveError || !savedSource?.id) {
    if (saveError)
      logger.error("meta_ads_oauth_save_failed", undefined, {
        workspaceId: params.workspaceId,
        code: saveError.code,
      });
    const conflict =
      (!savedSource?.id && !saveError) || saveError?.code === "23505";
    return {
      ok: false,
      status: conflict ? 409 : 500,
      error: conflict ? "mcp_save_conflict" : "mcp_save_failed",
    };
  }
  logger.info("meta_ads_oauth_completed", {
    workspaceId: params.workspaceId,
    intent: params.intent ?? "ai_ads",
    createdSource: !existingSource?.id,
    adAccountCount: accounts.length,
    scopes,
    neverExpires,
  });
  const reporting = getMetaAdsReportingReadiness(credentials);
  return {
    ok: true,
    createdSource: !existingSource?.id,
    reportingReady: reporting.canRead,
    reporting,
    readiness: evaluateMetaAdsMcpReadiness({
      hasMetaAdsSource: true,
      credentials,
    }),
    adAccounts: accounts,
    selectedAdAccountId,
  };
}
