import {
  asNullableRecord,
  readStringField,
} from "@icecore/shared/lib/value-utils";
import { normalizeMetaAdsMcpScopes } from "./meta-ads-mcp-readiness";
import {
  hasMetaAdsCredential,
  normalizeMetaAdsAdAccounts,
} from "./meta-ads-source";

export type MetaAdsReportingReadiness = {
  canRead: boolean;
  reason:
    | "ready"
    | "not_connected"
    | "missing_permission"
    | "expired"
    | "account_missing"
    | "account_unavailable"
    | "account_check_failed";
  selectedAdAccountId: string | null;
};

/** Saved Graph evidence only; optional MCP readiness never gates campaigns. */
export function getMetaAdsReportingReadiness(
  credentials: unknown,
  nowMs = Date.now()
): MetaAdsReportingReadiness {
  const raw = asNullableRecord(credentials) ?? {};
  const read = (key: string) => readStringField(raw, key, { trim: true });
  const accounts = normalizeMetaAdsAdAccounts(raw.ad_accounts);
  // Old sources did not store a selection; never substitute for a removed one.
  const selectedAdAccountId =
    read("selected_ad_account_id") ||
    (!("selected_ad_account_id" in raw) ? accounts[0]?.id : null) ||
    null;
  const result = (
    reason: MetaAdsReportingReadiness["reason"]
  ): MetaAdsReportingReadiness => ({
    canRead: reason === "ready",
    reason,
    selectedAdAccountId,
  });
  if (raw.has_access_token !== true && !hasMetaAdsCredential(raw.access_token))
    return result("not_connected");
  if (read("ads_access_invalidated_at")) return result("not_connected");
  const scopes = normalizeMetaAdsMcpScopes(raw.scope);
  // Legacy discovery is useful evidence; an explicitly verified empty grant is not.
  if (
    (scopes.length > 0 || read("ads_scopes_verified_at")) &&
    !scopes.includes("ads_read") &&
    !scopes.includes("ads_management")
  )
    return result("missing_permission");
  const expiresAt = Date.parse(read("expires_at"));
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs)
    return result("expired");
  if (read("ad_accounts_error")) return result("account_check_failed");
  if (!selectedAdAccountId) return result("account_missing");
  if (
    !accounts.some(
      account => account.id.toLowerCase() === selectedAdAccountId.toLowerCase()
    )
  )
    return result("account_unavailable");
  return result("ready");
}
