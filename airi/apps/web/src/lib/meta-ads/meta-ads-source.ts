import type {
  EncryptedCredential,
  MetaAdsAdAccount,
  MetaAdsCredentials,
} from "@icecore/shared/types/sources";
import {
  asRecord,
  cleanString,
  readNonEmptyStringOrUndefined,
} from "@icecore/shared/lib/value-utils";
import {
  evaluateMetaAdsMcpReadiness,
  normalizeMetaAdsMcpAdAccountInventory,
  normalizeMetaAdsMcpScopes,
  normalizeMetaAdsMcpSelectedAdAccount,
  normalizeMetaAdsMcpStoredProbe,
} from "./meta-ads-mcp-readiness";

export const META_ADS_SOURCE_TYPE = "meta_ads" as const;
export const META_ADS_INTEGRATION_NAME = "Meta Ads";
export const META_ADS_DEFAULT_SCOPE = "ads_read";
export const META_ADS_OAUTH_COOKIE_PREFIX = META_ADS_SOURCE_TYPE;
export const META_ADS_MCP_OAUTH_COOKIE_PREFIX = `${META_ADS_SOURCE_TYPE}_mcp`;

export type RawMetaAdsAdAccount = {
  id?: unknown;
  account_id?: unknown;
  name?: unknown;
  account_status?: unknown;
  currency?: unknown;
  timezone_name?: unknown;
  business?: {
    id?: unknown;
    name?: unknown;
  };
};

export function hasMetaAdsCredential(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  const credential = asRecord(value);
  return ["iv", "tag", "ciphertext"].every(
    key => typeof credential[key] === "string" && credential[key].length > 0
  );
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function normalizeMetaAdsAdAccounts(value: unknown): MetaAdsAdAccount[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): MetaAdsAdAccount | null => {
      if (!item || typeof item !== "object") return null;
      const raw = item as RawMetaAdsAdAccount;
      const id = readNonEmptyStringOrUndefined(raw.id);
      if (!id) return null;
      const business =
        raw.business && typeof raw.business === "object"
          ? {
              id: readNonEmptyStringOrUndefined(raw.business.id),
              name: readNonEmptyStringOrUndefined(raw.business.name),
            }
          : undefined;
      return {
        id,
        account_id: readNonEmptyStringOrUndefined(raw.account_id),
        name: readNonEmptyStringOrUndefined(raw.name),
        account_status: optionalNumber(raw.account_status),
        currency: readNonEmptyStringOrUndefined(raw.currency),
        timezone_name: readNonEmptyStringOrUndefined(raw.timezone_name),
        ...(business?.id || business?.name ? { business } : {}),
      } satisfies MetaAdsAdAccount;
    })
    .filter((item): item is MetaAdsAdAccount => Boolean(item));
}

export function toPublicMetaAdsCredentials(
  credentials: unknown
): Record<string, unknown> {
  const raw = asRecord(credentials);
  const mcpScopes = normalizeMetaAdsMcpScopes(raw.mcp_scope);
  const mcpAdAccountInventory = normalizeMetaAdsMcpAdAccountInventory(
    raw.mcp_ad_account_ids
  );
  const mcpSelectedAdAccount = normalizeMetaAdsMcpSelectedAdAccount(
    raw.mcp_selected_ad_account
  );
  const mcpProviderProbe = normalizeMetaAdsMcpStoredProbe(
    raw.mcp_provider_probe
  );
  const adAccounts = normalizeMetaAdsAdAccounts(raw.ad_accounts);

  return {
    has_access_token: hasMetaAdsCredential(raw.access_token),
    expires_at: cleanString(raw.expires_at, 100) || null,
    scope: cleanString(raw.scope, 400) || null,
    token_type: cleanString(raw.token_type, 50) || null,
    connected_at: cleanString(raw.connected_at, 100) || null,
    user_id: cleanString(raw.user_id, 100) || null,
    user_name: cleanString(raw.user_name, 200) || null,
    selected_ad_account_id:
      cleanString(raw.selected_ad_account_id, 100) ||
      (!("selected_ad_account_id" in raw) ? adAccounts[0]?.id : null) ||
      null,
    ad_accounts: adAccounts,
    ad_accounts_error: cleanString(raw.ad_accounts_error, 250) || null,
    ad_accounts_checked_at:
      cleanString(raw.ad_accounts_checked_at, 100) || null,
    ads_scopes_verified_at:
      cleanString(raw.ads_scopes_verified_at, 100) || null,
    ads_identity_verified_at:
      cleanString(raw.ads_identity_verified_at, 100) || null,
    ads_never_expires: raw.ads_never_expires === true,
    ads_access_invalidated_at:
      cleanString(raw.ads_access_invalidated_at, 100) || null,
    has_mcp_access_token: hasMetaAdsCredential(raw.mcp_access_token),
    mcp_token_type: cleanString(raw.mcp_token_type, 50) || null,
    mcp_expires_at: cleanString(raw.mcp_expires_at, 100) || null,
    mcp_scope: mcpScopes.length > 0 ? mcpScopes.join(" ") : null,
    mcp_connected_at: cleanString(raw.mcp_connected_at, 100) || null,
    mcp_connection_id: cleanString(raw.mcp_connection_id, 100) || null,
    mcp_user_id: cleanString(raw.mcp_user_id, 100) || null,
    mcp_user_name: cleanString(raw.mcp_user_name, 200) || null,
    mcp_scopes_verified_at:
      cleanString(raw.mcp_scopes_verified_at, 100) || null,
    mcp_ad_account_ids: mcpAdAccountInventory.ids,
    mcp_ad_accounts_truncated:
      raw.mcp_ad_accounts_truncated === true || mcpAdAccountInventory.truncated,
    mcp_selected_ad_account: mcpSelectedAdAccount || null,
    mcp_assets_checked_at: cleanString(raw.mcp_assets_checked_at, 100) || null,
    mcp_provider_probe: mcpProviderProbe || null,
    mcp_readiness: evaluateMetaAdsMcpReadiness({
      hasMetaAdsSource: true,
      credentials: raw,
    }),
  };
}

export function buildMetaAdsCredentials(params: {
  encryptedAccessToken: EncryptedCredential;
  tokenType?: string | null;
  expiresIn?: number | null;
  scope?: string | null;
  connectedAt?: string;
  userId?: string | null;
  userName?: string | null;
  adAccounts?: MetaAdsAdAccount[];
  adAccountsError?: string | null;
}): MetaAdsCredentials {
  const connectedAt = params.connectedAt || new Date().toISOString();
  const expiresAt =
    typeof params.expiresIn === "number" && params.expiresIn > 0
      ? new Date(Date.now() + params.expiresIn * 1000).toISOString()
      : null;
  const adAccounts = params.adAccounts || [];

  return {
    access_token: params.encryptedAccessToken,
    token_type: params.tokenType || "bearer",
    expires_at: expiresAt,
    scope: params.scope || META_ADS_DEFAULT_SCOPE,
    connected_at: connectedAt,
    ...(params.userId ? { user_id: params.userId } : {}),
    ...(params.userName ? { user_name: params.userName } : {}),
    ...(adAccounts.length > 0 ? { ad_accounts: adAccounts } : {}),
    ...(adAccounts[0]?.id ? { selected_ad_account_id: adAccounts[0].id } : {}),
    ad_accounts_checked_at: connectedAt,
    ...(params.adAccountsError
      ? { ad_accounts_error: params.adAccountsError.slice(0, 250) }
      : {}),
  };
}

export function summarizeMetaAdsSourceName(adAccountCount: number): string {
  if (adAccountCount === 1) return "Meta Ads (1 account)";
  if (adAccountCount > 1) return `Meta Ads (${adAccountCount} accounts)`;
  return META_ADS_INTEGRATION_NAME;
}
