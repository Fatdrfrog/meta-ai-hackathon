import type {
  MetaAdsAdAccount,
  MetaAdsMcpReadiness,
  MetaAdsMcpReadinessState,
  MetaAdsMcpStoredProbe,
  MetaAdsMcpWarningCode,
} from "@icecore/shared/types/sources";
import {
  asRecord,
  readNonEmptyStringOrUndefined,
} from "@icecore/shared/lib/value-utils";

// Ads MCP requires its own permission and either reporting or management
// access. Asset-specific permissions are requested only for those tools.
export const META_ADS_MCP_READ_REQUIRED_SCOPES = [
  "ads_mcp_management",
] as const;

export const META_ADS_MCP_READ_PERMISSION_SCOPES = [
  "ads_read",
  "ads_management",
] as const;

export const META_ADS_MCP_OPTIONAL_SCOPES = [
  "catalog_management",
  "business_management",
  "pages_show_list",
  "instagram_basic",
] as const;

export const META_ADS_MCP_WRITE_REQUIRED_SCOPES = [
  ...META_ADS_MCP_READ_REQUIRED_SCOPES,
  "ads_management",
] as const;

export const META_ADS_MCP_KNOWN_SCOPES = [
  ...META_ADS_MCP_READ_REQUIRED_SCOPES,
  ...META_ADS_MCP_READ_PERMISSION_SCOPES,
  ...META_ADS_MCP_OPTIONAL_SCOPES,
] as const;

export const META_ADS_MCP_EXPIRY_SKEW_MS = 300_000;
export const META_ADS_MCP_READINESS_TTL_MS = 900_000;

/** These states need another provider check, not a new customer grant. */
export function canRetryMetaAdsMcpReadiness(
  readiness: Pick<MetaAdsMcpReadiness, "state" | "checkedAt">,
  now = Date.now()
): boolean {
  if (readiness.state === "stale") return true;
  if (readiness.state !== "provider_unreachable") return false;
  const checkedAt = Date.parse(readiness.checkedAt ?? "");
  const age = now - checkedAt;
  return !Number.isFinite(checkedAt) || age < 0 || age >= 60_000;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ACCOUNT_IDS = 500;
const MAX_WARNINGS = 20;

export const META_ADS_MCP_WARNING_CODES = [
  "account_inventory_truncated",
  "account_not_enabled",
  "expiry_unknown",
  "graph_user_mismatch",
  "protected_resource_metadata_unavailable",
  "provider_capability_drift",
  "provider_protocol_fallback",
  "provider_teardown_failed",
  "scope_contract_added",
  "scope_contract_removed",
  "scope_challenge_added",
  "scope_unverified",
  "selected_account_direct_only",
] as const satisfies readonly MetaAdsMcpWarningCode[];

const META_ADS_MCP_WARNING_CODE_SET = new Set<string>(
  META_ADS_MCP_WARNING_CODES
);

const cleanString = (value: unknown, maxLength: number) =>
  readNonEmptyStringOrUndefined(value, { trim: true, maxLength });

function cleanFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function cleanNonNegativeInteger(value: unknown): number | undefined {
  const number = cleanFiniteNumber(value);
  return number === undefined ? undefined : Math.floor(number);
}

function timestampMillis(value: unknown): number | undefined {
  const normalized = cleanString(value, 100);
  if (!normalized) return undefined;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function hasCredential(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  return ["iv", "tag", "ciphertext"].every(
    key => typeof credential[key] === "string" && credential[key].length > 0
  );
}

export function normalizeMetaAdsMcpScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(
    new Set(
      value
        .split(/[\s,]+/u)
        .map(scope => scope.trim().toLowerCase())
        .filter(Boolean)
    )
  ).sort();
}

export function getMissingMetaAdsMcpReadScopes(
  grantedScopes: readonly string[]
): string[] {
  const missing: string[] = META_ADS_MCP_READ_REQUIRED_SCOPES.filter(
    scope => !grantedScopes.includes(scope)
  );
  if (
    !META_ADS_MCP_READ_PERMISSION_SCOPES.some(scope =>
      grantedScopes.includes(scope)
    )
  ) {
    // ads_read is the least-privileged way to satisfy the alternative grant.
    missing.push("ads_read");
  }
  return missing;
}

export function normalizeMetaAdsMcpAdAccountInventory(value: unknown): {
  ids: string[];
  truncated: boolean;
} {
  if (!Array.isArray(value)) return { ids: [], truncated: false };
  const uniqueIds = new Set<string>();
  for (const valueId of value) {
    const id = cleanString(valueId, 100);
    if (id) uniqueIds.add(id);
  }
  const ids = Array.from(uniqueIds).sort();
  return {
    ids: ids.slice(0, MAX_ACCOUNT_IDS),
    truncated: ids.length > MAX_ACCOUNT_IDS,
  };
}

export function normalizeMetaAdsMcpSelectedAdAccount(
  value: unknown
): MetaAdsAdAccount | undefined {
  const raw = asRecord(value);
  const id = cleanString(raw.id, 100);
  if (!id) return undefined;
  const business = asRecord(raw.business);
  const businessId = cleanString(business.id, 100);
  const businessName = cleanString(business.name, 200);
  const accountStatus = cleanNonNegativeInteger(raw.account_status);

  return {
    id,
    ...(cleanString(raw.account_id, 100)
      ? { account_id: cleanString(raw.account_id, 100) }
      : {}),
    ...(cleanString(raw.name, 200) ? { name: cleanString(raw.name, 200) } : {}),
    ...(accountStatus !== undefined ? { account_status: accountStatus } : {}),
    ...(cleanString(raw.currency, 20)
      ? { currency: cleanString(raw.currency, 20) }
      : {}),
    ...(cleanString(raw.timezone_name, 100)
      ? { timezone_name: cleanString(raw.timezone_name, 100) }
      : {}),
    ...(businessId || businessName
      ? {
          business: {
            ...(businessId ? { id: businessId } : {}),
            ...(businessName ? { name: businessName } : {}),
          },
        }
      : {}),
  };
}

export function normalizeMetaAdsMcpStoredProbe(
  value: unknown
): MetaAdsMcpStoredProbe | undefined {
  const raw = asRecord(value);
  const checkedAtMs = timestampMillis(raw.checkedAt);
  const checkedAt =
    checkedAtMs === undefined ? undefined : new Date(checkedAtMs).toISOString();
  const outcome = cleanString(raw.outcome, 50);
  if (
    !checkedAt ||
    !["success", "unauthorized", "unreachable", "invalid_catalog"].includes(
      outcome || ""
    )
  ) {
    return undefined;
  }

  const latencyMs = cleanFiniteNumber(raw.latencyMs);
  const toolCount = cleanNonNegativeInteger(raw.toolCount);
  const catalogSha256 = cleanString(raw.catalogSha256, 64)?.toLowerCase();
  const protocolEra = cleanString(raw.protocolEra, 20);
  const protocolVersion = cleanString(raw.protocolVersion, 100);
  const serverName = cleanString(raw.serverName, 200);
  const warnings = Array.isArray(raw.warnings)
    ? Array.from(
        new Set(
          raw.warnings.filter(
            (warning): warning is MetaAdsMcpWarningCode =>
              typeof warning === "string" &&
              META_ADS_MCP_WARNING_CODE_SET.has(warning)
          )
        )
      ).slice(0, MAX_WARNINGS)
    : [];

  return {
    checkedAt,
    outcome: outcome as MetaAdsMcpStoredProbe["outcome"],
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(catalogSha256 && SHA256_PATTERN.test(catalogSha256)
      ? { catalogSha256 }
      : {}),
    ...(protocolEra === "legacy" || protocolEra === "modern"
      ? { protocolEra }
      : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(serverName ? { serverName } : {}),
    ...(typeof raw.selectedAccountEnabled === "boolean"
      ? { selectedAccountEnabled: raw.selectedAccountEnabled }
      : {}),
    ...(typeof raw.selectedAccountQueryable === "boolean"
      ? { selectedAccountQueryable: raw.selectedAccountQueryable }
      : {}),
    warnings,
  };
}

function capabilitiesForState(
  state: MetaAdsMcpReadinessState,
  freshSuccessfulEvidence: boolean,
  hasWritePermission: boolean
): Pick<MetaAdsMcpReadiness, "canRead" | "canWrite" | "reconnectRequired"> {
  if (state === "ready") {
    return {
      canRead: true,
      canWrite: hasWritePermission,
      reconnectRequired: false,
    };
  }
  if (state === "expiry_unknown" || state === "scope_unverified") {
    return {
      canRead: freshSuccessfulEvidence,
      canWrite: false,
      reconnectRequired: true,
    };
  }
  return {
    canRead: false,
    canWrite: false,
    reconnectRequired: [
      "expired",
      "missing_scopes",
      "identity_unverified",
      "provider_unauthorized",
    ].includes(state),
  };
}

export function evaluateMetaAdsMcpReadiness(params: {
  hasMetaAdsSource: boolean;
  credentials: unknown;
  selectedAdAccountId?: string | null;
  tokenUsable?: boolean;
  checking?: boolean;
  now?: Date;
}): MetaAdsMcpReadiness {
  const raw = asRecord(params.credentials);
  const now = params.now || new Date();
  const nowMs = now.getTime();
  const tokenPresent = hasCredential(raw.mcp_access_token);
  const tokenUsable = params.tokenUsable ?? tokenPresent;
  const grantedScopes = normalizeMetaAdsMcpScopes(raw.mcp_scope);
  const scopesVerifiedAt = timestampMillis(raw.mcp_scopes_verified_at);
  const authoritativeScopes = scopesVerifiedAt !== undefined;
  const requiredScopes = [
    ...META_ADS_MCP_READ_REQUIRED_SCOPES,
    grantedScopes.includes("ads_management") ? "ads_management" : "ads_read",
  ];
  const missingReadScopes = authoritativeScopes
    ? getMissingMetaAdsMcpReadScopes(grantedScopes)
    : [];
  const missingWriteScopes = authoritativeScopes
    ? META_ADS_MCP_WRITE_REQUIRED_SCOPES.filter(
        scope => !grantedScopes.includes(scope)
      )
    : [];
  const missingScopes = [...missingReadScopes];
  const expiresAt = cleanString(raw.mcp_expires_at, 100);
  const expiresAtMs = timestampMillis(expiresAt);
  const neverExpires =
    raw.mcp_never_expires === true && expiresAtMs === undefined;
  const connectionId = cleanString(raw.mcp_connection_id, 100);
  const userId = cleanString(raw.mcp_user_id, 100);
  const userName = cleanString(raw.mcp_user_name, 200);
  const identity = userId
    ? { id: userId, ...(userName ? { name: userName } : {}) }
    : undefined;
  const selectedAdAccountId = cleanString(
    params.selectedAdAccountId ?? raw.selected_ad_account_id,
    100
  );
  const selectedAccount = normalizeMetaAdsMcpSelectedAdAccount(
    raw.mcp_selected_ad_account
  );
  const directAccountMatches = Boolean(
    selectedAdAccountId && selectedAccount?.id === selectedAdAccountId
  );
  const accountInventory = normalizeMetaAdsMcpAdAccountInventory(
    raw.mcp_ad_account_ids
  );
  const accessibleAdAccountIds = accountInventory.ids;
  const accessibleAdAccountsTruncated =
    raw.mcp_ad_accounts_truncated === true || accountInventory.truncated;
  const selectedAccountAccessible = Boolean(
    selectedAdAccountId &&
      directAccountMatches &&
      (accessibleAdAccountIds.includes(selectedAdAccountId) ||
        accessibleAdAccountsTruncated)
  );
  const selectedAsset =
    selectedAdAccountId && selectedAccount?.id === selectedAdAccountId
      ? {
          adAccountId: selectedAccount.id,
          ...(selectedAccount.business?.id
            ? { businessId: selectedAccount.business.id }
            : {}),
          ...(selectedAccount.business?.name
            ? { businessName: selectedAccount.business.name }
            : {}),
          ...(selectedAccount.currency
            ? { currency: selectedAccount.currency }
            : {}),
          ...(selectedAccount.timezone_name
            ? { timezone: selectedAccount.timezone_name }
            : {}),
        }
      : undefined;
  const probe = normalizeMetaAdsMcpStoredProbe(raw.mcp_provider_probe);
  const probeCheckedAtMs = timestampMillis(probe?.checkedAt);
  const freshSuccessfulEvidence = Boolean(
    probe?.outcome === "success" &&
      probeCheckedAtMs !== undefined &&
      probeCheckedAtMs <= nowMs + META_ADS_MCP_EXPIRY_SKEW_MS &&
      nowMs - probeCheckedAtMs <= META_ADS_MCP_READINESS_TTL_MS
  );
  const provider = probe
    ? {
        ...(probe.latencyMs !== undefined
          ? { latencyMs: probe.latencyMs }
          : {}),
        ...(probe.toolCount !== undefined
          ? { toolCount: probe.toolCount }
          : {}),
        ...(probe.catalogSha256 ? { catalogSha256: probe.catalogSha256 } : {}),
        ...(probe.protocolEra ? { protocolEra: probe.protocolEra } : {}),
        ...(probe.protocolVersion
          ? { protocolVersion: probe.protocolVersion }
          : {}),
        ...(probe.serverName ? { serverName: probe.serverName } : {}),
        ...(probe.selectedAccountEnabled !== undefined
          ? { selectedAccountEnabled: probe.selectedAccountEnabled }
          : {}),
        ...(probe.selectedAccountQueryable !== undefined
          ? { selectedAccountQueryable: probe.selectedAccountQueryable }
          : {}),
        warnings: probe.warnings,
      }
    : undefined;

  let state: MetaAdsMcpReadinessState;
  if (!params.hasMetaAdsSource || !tokenPresent) {
    state = "not_connected";
  } else if (params.checking) {
    state = "checking";
  } else if (
    expiresAtMs !== undefined &&
    expiresAtMs <= nowMs + META_ADS_MCP_EXPIRY_SKEW_MS
  ) {
    state = "expired";
  } else if (missingScopes.length > 0) {
    state = "missing_scopes";
  } else if (!tokenUsable) {
    // A present but undecryptable credential is disconnected from provider use,
    // not absent. Evaluate it before identity/asset evidence can mask reconnect.
    state = "provider_unauthorized";
  } else if (!connectionId || !identity) {
    state = "identity_unverified";
  } else if (
    !selectedAccountAccessible ||
    !selectedAsset?.currency ||
    !timestampMillis(raw.mcp_assets_checked_at)
  ) {
    state = "asset_unavailable";
  } else if (probe?.outcome === "unauthorized") {
    state = "provider_unauthorized";
  } else if (probe?.outcome === "unreachable") {
    state = "provider_unreachable";
  } else if (probe?.outcome === "invalid_catalog") {
    state = "invalid_catalog";
  } else if (!freshSuccessfulEvidence) {
    state = "stale";
  } else if (probe?.selectedAccountEnabled === false) {
    state = "asset_unavailable";
  } else if (expiresAtMs === undefined && !neverExpires) {
    state = "expiry_unknown";
  } else if (!authoritativeScopes) {
    state = "scope_unverified";
  } else {
    state = "ready";
  }

  return {
    state,
    ...(probe?.checkedAt ? { checkedAt: probe.checkedAt } : {}),
    ...(expiresAtMs !== undefined && expiresAt ? { expiresAt } : {}),
    ...(neverExpires ? { neverExpires: true } : {}),
    grantedScopes,
    requiredScopes,
    missingScopes,
    missingReadScopes: [...missingReadScopes],
    missingWriteScopes: [...missingWriteScopes],
    ...(identity ? { identity } : {}),
    ...(selectedAsset ? { selectedAsset } : {}),
    accessibleAdAccountIds,
    accessibleAdAccountsTruncated,
    ...(provider ? { provider } : {}),
    ...capabilitiesForState(
      state,
      freshSuccessfulEvidence,
      authoritativeScopes && missingWriteScopes.length === 0
    ),
  };
}
