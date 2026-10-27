import "server-only";

import { getMetaServerAppConfig } from "@/lib/meta/app-config";
import { attributeMetaCredentialOwner } from "@/lib/meta/credential-owner";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import { classifyWhatsAppMetaDiagnosticError } from "@/lib/meta/whatsapp-diagnostics";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import {
  evaluateMetaAccessToken,
  type MetaDebugTokenData,
} from "@icecore/shared/lib/meta/debug-token";
import {
  buildWhatsAppTokenMetadataPatch,
  WHATSAPP_CONNECTION_ATTENTION_DAYS,
  WHATSAPP_TOKEN_RENEWAL_WINDOW_DAYS,
} from "./token-lifecycle";

const graphClient = getWhatsAppGraphClient();
const REQUIRED_PERMISSIONS = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
];
const REQUEST_TIMEOUT_MS = 15_000;

export interface WhatsAppTokenMaintenanceResult {
  accessToken: string;
  credentialsPatch: Record<string, unknown>;
  refreshed: boolean;
  requiresReconnect: boolean;
  error?: unknown;
}

function attributeAppRequestError(error: unknown): unknown {
  return classifyWhatsAppMetaDiagnosticError(error) === "authorization"
    ? attributeMetaCredentialOwner(error, "configured_app")
    : error;
}

/** Whether the token holds both WhatsApp permissions for this WABA. */
export async function hasWhatsAppAccess(
  data: MetaDebugTokenData,
  accessToken: string,
  wabaId: string
): Promise<boolean> {
  if (!REQUIRED_PERMISSIONS.every(scope => data.scopes?.includes(scope)))
    return false;
  let needsAssetProbe = false;
  for (const scope of REQUIRED_PERMISSIONS) {
    const grants = data.granular_scopes?.filter(grant => grant.scope === scope);
    if (!grants?.length || grants.some(grant => !grant.target_ids)) {
      needsAssetProbe = true;
    } else if (!grants.some(grant => grant.target_ids?.includes(wabaId))) {
      return false;
    }
  }
  if (!needsAssetProbe) return true;
  const asset = await graphClient.getJson<{ id?: string }>(wabaId, {
    token: accessToken,
    query: { fields: "id" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return asset.id === wabaId;
}

function hasSameIdentity(
  before: MetaDebugTokenData,
  after: MetaDebugTokenData
): boolean {
  if (
    !before.user_id ||
    before.user_id !== after.user_id ||
    before.type !== after.type
  )
    return false;
  return (["business_id", "profile_id"] as const).every(
    key => !before[key] || before[key] === after[key]
  );
}

/**
 * Verify the existing token, renew in advance, and verify its replacement before
 * returning it for a fenced write. Meta keeps the old system-user token valid
 * until its original expiry, so a failed exchange check can keep using it.
 * https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-and-generate-tokens/#refresh-token
 */
export async function maintainWhatsAppToken(params: {
  accessToken: string;
  wabaId: string;
  credentials: Readonly<Record<string, unknown>>;
  now?: Date;
}): Promise<WhatsAppTokenMaintenanceResult> {
  const now = params.now ?? new Date();
  const result: WhatsAppTokenMaintenanceResult = {
    accessToken: params.accessToken,
    credentialsPatch: {},
    refreshed: false,
    requiresReconnect: false,
  };
  let daysUntilExpiry: number | undefined;
  let replacementRejected = false;
  let checkingReplacementAccess = false;
  let checkingCurrentAccess = false;
  try {
    let appConfig: ReturnType<typeof getMetaServerAppConfig>;
    try {
      appConfig = getMetaServerAppConfig();
    } catch (error) {
      throw attributeMetaCredentialOwner(error, "configured_app");
    }

    const inspect = (accessToken: string) =>
      debugConfiguredMetaAccessToken(accessToken, {
        appConfig,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(error => {
        throw attributeAppRequestError(error);
      });
    const before = await inspect(params.accessToken);
    const current = evaluateMetaAccessToken(before, {
      appId: appConfig.appId,
      nowMs: now.getTime(),
    });
    if (current.valid && !Array.isArray(before.scopes)) {
      throw new Error(
        "Meta did not provide permission metadata for the existing token"
      );
    }
    const explicitAppMismatch =
      typeof before.app_id === "string" &&
      before.app_id.length > 0 &&
      before.app_id !== appConfig.appId;
    if (
      before.is_valid !== false &&
      !current.expired &&
      !explicitAppMismatch &&
      (before.is_valid !== true || !before.app_id)
    ) {
      throw new Error(
        "Meta did not provide enough metadata to verify the existing token"
      );
    }
    result.credentialsPatch = buildWhatsAppTokenMetadataPatch(before, {
      appId: appConfig.appId,
      nowMs: now.getTime(),
    });
    daysUntilExpiry = current.daysUntilExpiry;

    const hasPermissions = REQUIRED_PERMISSIONS.every(scope =>
      before.scopes?.includes(scope)
    );
    let hasCurrentAccess = false;
    if (current.valid && hasPermissions) {
      checkingCurrentAccess = true;
      hasCurrentAccess = await hasWhatsAppAccess(
        before,
        params.accessToken,
        params.wabaId
      );
      checkingCurrentAccess = false;
    }
    if (!current.valid || !hasPermissions || !hasCurrentAccess) {
      result.requiresReconnect = true;
      result.credentialsPatch.token_is_valid = false;
      result.credentialsPatch.token_maintenance_status = "reconnect_required";
      result.credentialsPatch.token_maintenance_error_code = current.expired
        ? "token_expired"
        : !current.valid
          ? "token_authorization_invalid"
          : !hasPermissions
            ? "token_permissions_missing"
            : "waba_access_missing";
      return result;
    }
    if (
      daysUntilExpiry === undefined ||
      daysUntilExpiry > WHATSAPP_TOKEN_RENEWAL_WINDOW_DAYS
    )
      return result;
    if (
      !["USER", "SYSTEM_USER"].includes(before.type || "") ||
      !before.user_id
    ) {
      result.requiresReconnect =
        daysUntilExpiry <= WHATSAPP_CONNECTION_ATTENTION_DAYS;
      result.credentialsPatch.token_maintenance_status =
        result.requiresReconnect ? "reconnect_required" : "retrying";
      result.credentialsPatch.token_maintenance_error_code =
        "unsupported_token_type";
      return result;
    }

    result.credentialsPatch.token_last_refresh_attempt_at = now.toISOString();
    const exchanged = await graphClient
      .getJson<{ access_token?: string }>("oauth/access_token", {
        token: params.accessToken,
        query: {
          grant_type: "fb_exchange_token",
          client_id: appConfig.appId,
          client_secret: appConfig.appSecret,
          fb_exchange_token: params.accessToken,
          ...(before.type === "SYSTEM_USER"
            ? { set_token_expires_in_60_days: "true" }
            : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      .catch(error => {
        throw attributeAppRequestError(error);
      });
    if (
      typeof exchanged.access_token !== "string" ||
      !exchanged.access_token.trim()
    ) {
      throw new Error("Meta token renewal returned no access token");
    }

    const after = await inspect(exchanged.access_token);
    const replacement = evaluateMetaAccessToken(after, {
      appId: appConfig.appId,
      nowMs: now.getTime(),
    });
    const extended =
      replacement.neverExpires ||
      Boolean(
        replacement.expiresAt &&
          current.expiresAt &&
          replacement.expiresAt.getTime() - current.expiresAt.getTime() >=
            86_400_000
      );
    checkingReplacementAccess = true;
    if (
      !replacement.valid ||
      !hasSameIdentity(before, after) ||
      !extended ||
      !(await hasWhatsAppAccess(after, exchanged.access_token, params.wabaId))
    ) {
      replacementRejected = true;
      throw new Error(
        "Meta token renewal did not verify an extended lifetime for the same WhatsApp connection"
      );
    }
    result.accessToken = exchanged.access_token;
    result.refreshed = true;
    result.credentialsPatch = {
      ...buildWhatsAppTokenMetadataPatch(after, {
        appId: appConfig.appId,
        nowMs: now.getTime(),
      }),
      token_maintenance_status: "renewed",
      token_maintenance_error_code: null,
      token_last_refreshed_at: now.toISOString(),
      token_last_refresh_attempt_at: now.toISOString(),
      token_refresh_error: null,
    };
  } catch (error) {
    const sourceAuthorizationFailure =
      classifyWhatsAppMetaDiagnosticError(error) === "authorization";
    if (checkingCurrentAccess && sourceAuthorizationFailure) {
      result.requiresReconnect = true;
      result.credentialsPatch = {
        ...result.credentialsPatch,
        token_is_valid: false,
        token_maintenance_status: "reconnect_required",
        token_maintenance_error_code: "waba_access_missing",
      };
      return result;
    }
    result.error =
      checkingReplacementAccess && sourceAuthorizationFailure
        ? new Error(
            "The renewed token could not access the existing WhatsApp account"
          )
        : error;
    // A temporary failure is not evidence that the old token was revoked.
    result.requiresReconnect =
      (!checkingReplacementAccess && sourceAuthorizationFailure) ||
      (replacementRejected &&
        daysUntilExpiry !== undefined &&
        daysUntilExpiry <= WHATSAPP_CONNECTION_ATTENTION_DAYS);
    result.credentialsPatch = {
      ...result.credentialsPatch,
      token_maintenance_status: result.requiresReconnect
        ? "reconnect_required"
        : "retrying",
      token_maintenance_error_code: replacementRejected
        ? "renewal_not_verified"
        : "provider_check_failed",
      ...(!checkingReplacementAccess && sourceAuthorizationFailure
        ? { token_is_valid: false }
        : {}),
    };
  }
  return result;
}
