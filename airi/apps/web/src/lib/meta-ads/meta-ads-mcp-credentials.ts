import {
  normalizeMetaAdsMcpAdAccountInventory,
  normalizeMetaAdsMcpScopes,
  normalizeMetaAdsMcpSelectedAdAccount,
  normalizeMetaAdsMcpStoredProbe,
} from "@/lib/meta-ads/meta-ads-mcp-readiness";
import type {
  EncryptedCredential,
  MetaAdsAdAccount,
  MetaAdsCredentials,
  MetaAdsMcpStoredProbe,
} from "@icecore/shared/types/sources";
import {
  asRecord,
  readNonEmptyStringOrUndefined,
} from "@icecore/shared/lib/value-utils";

function hasEncryptedCredential(value: unknown): value is EncryptedCredential {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "iv" in value &&
      typeof value.iv === "string" &&
      value.iv.length > 0 &&
      "tag" in value &&
      typeof value.tag === "string" &&
      value.tag.length > 0 &&
      "ciphertext" in value &&
      typeof value.ciphertext === "string" &&
      value.ciphertext.length > 0
  );
}

const optionalString = (value: unknown, maxLength = 1000) =>
  readNonEmptyStringOrUndefined(value, { trim: true, maxLength });

function optionalTimestamp(value: unknown): string | undefined {
  const normalized = optionalString(value, 100);
  if (!normalized) return undefined;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

export type MetaAdsMcpCredentialFields = Pick<
  MetaAdsCredentials,
  | "mcp_access_token"
  | "mcp_token_type"
  | "mcp_expires_at"
  | "mcp_never_expires"
  | "mcp_scope"
  | "mcp_connected_at"
  | "mcp_connection_id"
  | "mcp_user_id"
  | "mcp_user_name"
  | "mcp_scopes_verified_at"
  | "mcp_ad_account_ids"
  | "mcp_ad_accounts_truncated"
  | "mcp_selected_ad_account"
  | "mcp_assets_checked_at"
  | "mcp_provider_probe"
>;

const META_ADS_MCP_CREDENTIAL_KEYS = [
  "mcp_access_token",
  "mcp_token_type",
  "mcp_expires_at",
  "mcp_never_expires",
  "mcp_scope",
  "mcp_connected_at",
  "mcp_connection_id",
  "mcp_user_id",
  "mcp_user_name",
  "mcp_scopes_verified_at",
  "mcp_ad_account_ids",
  "mcp_ad_accounts_truncated",
  "mcp_selected_ad_account",
  "mcp_assets_checked_at",
  "mcp_provider_probe",
] as const;

function withoutMetaAdsMcpCredentials(
  credentials: Record<string, unknown>
): Record<string, unknown> {
  const preserved = { ...credentials };
  for (const key of META_ADS_MCP_CREDENTIAL_KEYS) delete preserved[key];
  return preserved;
}

export function extractMetaAdsMcpCredentialFields(
  credentials: unknown
): MetaAdsMcpCredentialFields {
  const raw = asRecord(credentials);
  const fields: MetaAdsMcpCredentialFields = {};
  if (hasEncryptedCredential(raw.mcp_access_token)) {
    fields.mcp_access_token = raw.mcp_access_token;
  }
  const tokenType = optionalString(raw.mcp_token_type, 50);
  if (tokenType) fields.mcp_token_type = tokenType;
  if ("mcp_expires_at" in raw) {
    fields.mcp_expires_at =
      raw.mcp_expires_at === null
        ? null
        : optionalTimestamp(raw.mcp_expires_at) || null;
  }
  if (typeof raw.mcp_never_expires === "boolean") {
    fields.mcp_never_expires = raw.mcp_never_expires;
  }
  const scopes = normalizeMetaAdsMcpScopes(raw.mcp_scope);
  if (scopes.length > 0) fields.mcp_scope = scopes.join(" ");
  const connectedAt = optionalTimestamp(raw.mcp_connected_at);
  if (connectedAt) fields.mcp_connected_at = connectedAt;
  const connectionId = optionalString(raw.mcp_connection_id, 100);
  if (connectionId) fields.mcp_connection_id = connectionId;
  const userId = optionalString(raw.mcp_user_id, 100);
  if (userId) fields.mcp_user_id = userId;
  const userName = optionalString(raw.mcp_user_name, 200);
  if (userName) fields.mcp_user_name = userName;
  const scopesVerifiedAt = optionalTimestamp(raw.mcp_scopes_verified_at);
  if (scopesVerifiedAt) fields.mcp_scopes_verified_at = scopesVerifiedAt;
  const accountInventory = normalizeMetaAdsMcpAdAccountInventory(
    raw.mcp_ad_account_ids
  );
  if (Array.isArray(raw.mcp_ad_account_ids)) {
    fields.mcp_ad_account_ids = accountInventory.ids;
  }
  if (
    typeof raw.mcp_ad_accounts_truncated === "boolean" ||
    accountInventory.truncated
  ) {
    fields.mcp_ad_accounts_truncated =
      raw.mcp_ad_accounts_truncated === true || accountInventory.truncated;
  }
  const selectedAdAccount = normalizeMetaAdsMcpSelectedAdAccount(
    raw.mcp_selected_ad_account
  );
  if (selectedAdAccount) fields.mcp_selected_ad_account = selectedAdAccount;
  const assetsCheckedAt = optionalTimestamp(raw.mcp_assets_checked_at);
  if (assetsCheckedAt) fields.mcp_assets_checked_at = assetsCheckedAt;
  const providerProbe = normalizeMetaAdsMcpStoredProbe(raw.mcp_provider_probe);
  if (providerProbe) fields.mcp_provider_probe = providerProbe;
  return fields;
}

export function buildMetaAdsMcpCredentialFields(params: {
  encryptedMcpAccessToken: EncryptedCredential;
  tokenType?: string | null;
  expiresAt?: string | null;
  neverExpires?: boolean;
  /** @deprecated Transitional compatibility for the pre-readiness OAuth owner. */
  expiresIn?: number | null;
  scope?: string | null;
  connectedAt?: string;
  connectionId?: string | null;
  userId?: string | null;
  userName?: string | null;
  scopesVerifiedAt?: string | null;
  adAccountIds?: string[];
  adAccountsTruncated?: boolean;
  selectedAdAccount?: MetaAdsAdAccount | null;
  assetsCheckedAt?: string | null;
  providerProbe?: MetaAdsMcpStoredProbe | null;
}): MetaAdsMcpCredentialFields {
  const now = new Date();
  const connectedAt =
    optionalTimestamp(params.connectedAt) || now.toISOString();
  const explicitExpiresAt =
    params.expiresAt === null ? null : optionalTimestamp(params.expiresAt);
  const legacyExpiresAt =
    typeof params.expiresIn === "number" && params.expiresIn > 0
      ? new Date(now.getTime() + params.expiresIn * 1000).toISOString()
      : null;
  const expiresAt =
    params.expiresAt === null
      ? null
      : explicitExpiresAt === undefined
        ? legacyExpiresAt
        : explicitExpiresAt;
  const scopes = normalizeMetaAdsMcpScopes(params.scope);
  const connectionId = optionalString(params.connectionId, 100);
  const userId = optionalString(params.userId, 100);
  const userName = optionalString(params.userName, 200);
  const scopesVerifiedAt = optionalTimestamp(params.scopesVerifiedAt);
  const accountInventory = normalizeMetaAdsMcpAdAccountInventory(
    params.adAccountIds
  );
  const selectedAdAccount = normalizeMetaAdsMcpSelectedAdAccount(
    params.selectedAdAccount
  );
  const assetsCheckedAt = optionalTimestamp(params.assetsCheckedAt);
  const providerProbe = normalizeMetaAdsMcpStoredProbe(params.providerProbe);

  return {
    mcp_access_token: params.encryptedMcpAccessToken,
    mcp_token_type: optionalString(params.tokenType, 50) || "bearer",
    mcp_expires_at: expiresAt,
    ...(typeof params.neverExpires === "boolean"
      ? { mcp_never_expires: params.neverExpires }
      : {}),
    ...(scopes.length > 0 ? { mcp_scope: scopes.join(" ") } : {}),
    mcp_connected_at: connectedAt,
    ...(connectionId ? { mcp_connection_id: connectionId } : {}),
    ...(userId ? { mcp_user_id: userId } : {}),
    ...(userName ? { mcp_user_name: userName } : {}),
    ...(scopesVerifiedAt ? { mcp_scopes_verified_at: scopesVerifiedAt } : {}),
    ...(params.adAccountIds
      ? {
          mcp_ad_account_ids: accountInventory.ids,
        }
      : {}),
    ...(typeof params.adAccountsTruncated === "boolean" ||
    accountInventory.truncated
      ? {
          mcp_ad_accounts_truncated:
            params.adAccountsTruncated === true || accountInventory.truncated,
        }
      : {}),
    ...(selectedAdAccount
      ? { mcp_selected_ad_account: selectedAdAccount }
      : {}),
    ...(assetsCheckedAt ? { mcp_assets_checked_at: assetsCheckedAt } : {}),
    ...(providerProbe ? { mcp_provider_probe: providerProbe } : {}),
  };
}

export function mergeMetaAdsCredentialsWithMcp(params: {
  existing: unknown;
  mcp: MetaAdsMcpCredentialFields;
}): MetaAdsCredentials {
  const raw = asRecord(params.existing);
  if (!hasEncryptedCredential(raw.access_token)) {
    throw new Error(
      "Meta Ads Graph credentials are required before enabling Ads MCP"
    );
  }
  return {
    ...(withoutMetaAdsMcpCredentials(raw) as unknown as MetaAdsCredentials),
    access_token: raw.access_token,
    ...extractMetaAdsMcpCredentialFields(params.mcp),
  };
}

export function mergeMetaAdsMcpReadinessEvidence(params: {
  existing: unknown;
  expectedConnectionId: string;
  evidence: Omit<MetaAdsMcpCredentialFields, "mcp_access_token">;
}): MetaAdsCredentials | null {
  const raw = asRecord(params.existing);
  const expectedConnectionId = optionalString(params.expectedConnectionId, 100);
  if (
    !expectedConnectionId ||
    optionalString(raw.mcp_connection_id, 100) !== expectedConnectionId ||
    !hasEncryptedCredential(raw.access_token) ||
    !hasEncryptedCredential(raw.mcp_access_token)
  ) {
    return null;
  }

  const preserved = withoutMetaAdsMcpCredentials(raw);
  const evidence = extractMetaAdsMcpCredentialFields(params.evidence);
  delete evidence.mcp_access_token;

  return {
    ...(preserved as unknown as MetaAdsCredentials),
    ...evidence,
    mcp_connection_id: expectedConnectionId,
    access_token: raw.access_token,
    mcp_access_token: raw.mcp_access_token,
  };
}
