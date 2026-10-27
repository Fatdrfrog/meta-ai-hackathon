import { verifyCronAuth } from "@/lib/cron-auth";
import { encryptString } from "@/lib/crypto";
import { classifyWhatsAppMetaDiagnosticError } from "@/lib/meta/whatsapp-diagnostics";
import { checkTokenExpiryAndAlert } from "@/lib/notifications/check-token-expiry";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { maintainWhatsAppToken } from "@/lib/whatsapp/token-maintenance";
import { updateCurrentWhatsAppSourceCredentialsFromSnapshot } from "@/lib/whatsapp/flows/source-rebind-guard";
import {
  acquireWhatsAppMetaReadLock,
  buildWhatsAppMetaAuthorizationCredentialPatch,
  buildWhatsAppMetaRateLimitCredentialPatch,
  buildWhatsAppMetaReadFailureCredentialPatch,
  buildWhatsAppMetaReadSuccessCredentialPatch,
  getCachedWhatsAppMetaReadCooldownUntil,
  getWhatsAppMetaReadDecision,
  hasConfirmedWhatsAppMetaAuthorizationReconnect,
  releaseWhatsAppMetaReadPermit,
  selectLaterActiveWhatsAppMetaReadCooldownUntil,
  setCachedWhatsAppMetaReadCooldownUntil,
  type WhatsAppMetaReadPermit,
} from "@/lib/whatsapp/meta-read-policy";
import { getPhoneNumberDetails } from "@/lib/whatsapp/qr-code-service";
import {
  getWabaWebhookSubscriptionStatus,
  subscribeToWABAWebhooks,
} from "@/lib/whatsapp/waba-service";
import {
  analyzeSubscribedFields,
  WEBHOOK_PROFILE_VERSION,
} from "@icecore/whatsapp/webhookFields";
import { getMetaGraphAuthorizationMetadata } from "@icecore/shared/lib/meta/api";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import { createLogger } from "@icecore/shared/lib/logger";
import {
  buildWhatsAppBusinessAppConnectionPatch,
  hasWhatsAppBusinessAppConnectionSignal,
} from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";
import { buildWhatsAppPhoneDetailsCredentialPatch } from "@icecore/shared/lib/whatsapp/phone-details";
import type { WhatsAppSource } from "@icecore/shared/types/sources";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

type SubscriptionStatus = "subscribed" | "unsubscribed" | "unknown";
type MetaAuthorizationOperation =
  | "token_refresh"
  | "phone_details"
  | "waba_subscription";

interface SubscriptionCheckResult {
  workspace_id: string;
  source_id: string;
  waba_id: string;
  phone_number_id: string;
  waba_subscribed: boolean;
  phone_subscribed: boolean;
  waba_subscription_status: SubscriptionStatus;
  waba_subscribed_fields?: string[];
  webhook_missing_required_fields?: string[];
  webhook_missing_optional_fields?: string[];
  webhook_coverage_ok?: boolean;
  token_expired: boolean;
  token_refreshed: boolean;
  auto_fixed: boolean;
  rate_limited?: boolean;
  failed?: boolean;
  persistence_failed?: boolean;
  skipped_reason?:
    | "fresh_provider_state"
    | "rate_limit_cooldown"
    | "reconnection_required"
    | "provider_configuration_error"
    | "provider_refresh_in_progress"
    | "provider_coordination_unavailable";
  error?: string;
}

const maintenanceLogger = createLogger("whatsapp-maintenance");
const MAINTENANCE_LOCK_TTL_SECONDS = 15 * 60;

function fingerprintAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function buildTokenAuthorizationFailureKey(tokenFingerprint: string): string {
  return JSON.stringify(["token", tokenFingerprint]);
}

function buildPhoneAuthorizationFailureKey(params: {
  wabaId: string;
  phoneNumberId: string;
  tokenFingerprint: string;
}): string {
  return JSON.stringify([
    "phone",
    params.wabaId,
    params.phoneNumberId,
    params.tokenFingerprint,
  ]);
}

function buildWabaAuthorizationFailureKey(params: {
  wabaId: string;
  tokenFingerprint: string;
}): string {
  return JSON.stringify(["waba", params.wabaId, params.tokenFingerprint]);
}

function buildTerminalAuthorizationFailureKey(params: {
  error: unknown;
  operation: MetaAuthorizationOperation;
  tokenFingerprint: string;
  wabaId: string;
  phoneNumberId: string;
}): string {
  const metadata = getMetaGraphAuthorizationMetadata(params.error);
  const tokenWideFailure =
    params.operation === "token_refresh" ||
    metadata?.status === 401 ||
    metadata?.status === 403 ||
    metadata?.code === 10 ||
    metadata?.code === 190 ||
    metadata?.code === 200 ||
    metadata?.code === undefined;

  if (tokenWideFailure) {
    return buildTokenAuthorizationFailureKey(params.tokenFingerprint);
  }

  return params.operation === "phone_details"
    ? buildPhoneAuthorizationFailureKey(params)
    : buildWabaAuthorizationFailureKey(params);
}

async function checkWABASubscription(
  wabaId: string,
  accessToken: string,
  options?: { coexistenceMode?: boolean }
): Promise<{
  status: SubscriptionStatus;
  subscribed: boolean;
  fields?: string[];
  missingRequiredFields?: string[];
  missingOptionalFields?: string[];
  coverageOk?: boolean;
  actionable?: string | null;
  rateLimited?: boolean;
  cause?: unknown;
  error?: string;
}> {
  try {
    const status = await getWabaWebhookSubscriptionStatus(
      wabaId,
      accessToken,
      options
    );

    return {
      status: status.subscribed ? "subscribed" : "unsubscribed",
      subscribed: status.subscribed,
      fields: status.fields,
      missingRequiredFields: status.missingRequiredFields,
      missingOptionalFields: status.missingOptionalFields,
      coverageOk: status.coverageOk,
      actionable: status.actionable,
    };
  } catch (error) {
    return {
      status: "unknown",
      subscribed: false,
      rateLimited:
        classifyWhatsAppMetaDiagnosticError(error) === "rate_limited",
      cause: error,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Unified WhatsApp maintenance cron
 * - Refreshes expiring tokens
 * - Sends expiry alerts
 * - Checks and auto-fixes webhook subscriptions
 * Runs every 6 hours
 */
export async function GET(request: Request) {
  const maintenanceLockKey = buildCacheKey("whatsapp:maintenance:v1", [
    "global",
  ]);
  let maintenanceLockToken: string | null = null;

  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    const candidateLockToken = crypto.randomUUID();
    const lockAcquisition = await cache.acquireLock(
      maintenanceLockKey,
      candidateLockToken,
      MAINTENANCE_LOCK_TTL_SECONDS
    );
    if (lockAcquisition === "unavailable") {
      maintenanceLogger.error(
        "Coordination backend unavailable; maintenance aborted",
        new Error("Maintenance lock backend is unavailable")
      );
      return NextResponse.json(
        {
          status: "error",
          reason: "maintenance_coordination_unavailable",
        },
        { status: 503 }
      );
    }
    if (lockAcquisition === "contended") {
      return NextResponse.json({
        status: "skipped",
        reason: "maintenance_already_running",
      });
    }
    maintenanceLockToken = candidateLockToken;

    // Get all WhatsApp sources
    const { data: sources, error: sourcesError } = await supabaseAdmin
      .from("sources")
      .select("id, workspace_id, credentials")
      .eq("type", "whatsapp");

    if (sourcesError) {
      console.error(
        "[WhatsApp Maintenance] Error fetching sources:",
        sourcesError
      );
      return NextResponse.json(
        { error: "Failed to fetch sources", details: sourcesError },
        { status: 500 }
      );
    }

    if (!sources || sources.length === 0) {
      return NextResponse.json({
        status: "ok",
        message: "No WhatsApp sources found",
        checked: 0,
        fixed: 0,
        refreshed: 0,
      });
    }

    const results: SubscriptionCheckResult[] = [];
    let fixedCount = 0;
    let refreshedCount = 0;
    let failedCount = 0;
    let warningsCount = 0;
    let rateLimitedCount = 0;
    const criticalIssues: string[] = [];
    const tokenMaintenanceByIdentity = new Map<
      string,
      Awaited<ReturnType<typeof maintainWhatsAppToken>>
    >();
    const terminalAuthorizationFailures = new Map<
      string,
      {
        error: unknown;
        operation: MetaAuthorizationOperation;
      }
    >();
    const phoneDetailsByWabaAndPhone = new Map<
      string,
      Awaited<ReturnType<typeof getPhoneNumberDetails>>
    >();
    const phoneDetailsFailureByWabaAndPhone = new Map<string, unknown>();
    const wabaSubscriptionByWabaAndToken = new Map<
      string,
      Awaited<ReturnType<typeof checkWABASubscription>>
    >();
    const confirmedWabaRepairByWaba = new Map<
      string,
      Awaited<ReturnType<typeof subscribeToWABAWebhooks>>
    >();
    const wabaRepairByWabaAndToken = new Map<
      string,
      Awaited<ReturnType<typeof subscribeToWABAWebhooks>>
    >();
    const metaCooldownByWaba = new Map<string, string | null>();
    const metaRateLimitCountByWaba = new Map<string, number>();
    const sharedCooldownLoadedForWaba = new Set<string>();
    let configuredAppDiagnosticsFailure: string | null = null;

    // A persisted WABA-wide cooldown belongs to every source for that WABA.
    // Preseed the run-level circuit before processing the first source so row
    // order cannot bypass a cooldown when the shared cache is unavailable.
    for (const source of sources as WhatsAppSource[]) {
      const normalized = normalizeWhatsAppCredentials(source.credentials);
      const persistedCooldown = (
        source.credentials as unknown as Record<string, unknown>
      ).meta_diagnostics_cooldown_until;
      if (normalized.wabaId && typeof persistedCooldown === "string") {
        const activeCooldown = selectLaterActiveWhatsAppMetaReadCooldownUntil([
          metaCooldownByWaba.get(normalized.wabaId),
          persistedCooldown,
        ]);
        if (activeCooldown) {
          metaCooldownByWaba.set(normalized.wabaId, activeCooldown);
        }
      }
      const persistedRateLimitCount = (
        source.credentials as unknown as Record<string, unknown>
      ).meta_diagnostics_consecutive_rate_limits;
      if (
        normalized.wabaId &&
        typeof persistedRateLimitCount === "number" &&
        Number.isInteger(persistedRateLimitCount) &&
        persistedRateLimitCount > 0
      ) {
        metaRateLimitCountByWaba.set(
          normalized.wabaId,
          Math.max(
            metaRateLimitCountByWaba.get(normalized.wabaId) ?? 0,
            persistedRateLimitCount
          )
        );
      }
    }

    // Process each source
    for (const source of sources as WhatsAppSource[]) {
      const credentials = source.credentials;
      const normalized = normalizeWhatsAppCredentials(credentials);
      const wabaId = normalized.wabaId;
      const phoneNumberId = normalized.phoneNumberId;
      const accessTokenFromCreds = normalized.accessToken;

      const result: SubscriptionCheckResult = {
        workspace_id: source.workspace_id,
        source_id: source.id,
        waba_id: wabaId || "",
        phone_number_id: phoneNumberId || "",
        waba_subscribed: credentials.webhook_subscribed === true,
        phone_subscribed: credentials.webhook_subscribed === true,
        waba_subscription_status: "unknown",
        token_expired: false,
        token_refreshed: false,
        auto_fixed: false,
      };
      const markResultFailed = (): void => {
        if (result.failed) return;
        result.failed = true;
        failedCount++;
      };

      // Step 1: Check token expiration and refresh if needed
      let accessToken: string | null = null;
      let tokenWasRefreshed = false;
      let tokenMetadataWasUpdated = false;
      let tokenReconnectRequired = false;
      let subscriptionWasFixed = false;
      let updatedCredentials = { ...credentials };
      let phoneDetailsWereHydrated = false;
      let wabaDiagnosticsWereHydrated = false;
      let metaDiagnosticsWereAttempted = false;
      let metaProviderFailureOccurred = false;
      let webhookStateWasUpdated = false;
      let metaPolicyWasUpdated = false;
      let providerRefreshPermit: WhatsAppMetaReadPermit | null = null;
      let providerRefreshBlocked = false;
      let providerCoordinationUnavailable = false;
      let providerCallsStopped = false;
      let sharedMetaCooldownUntil: string | null = null;
      let tokenExpiredIssue: string | null = null;
      // Older cron versions promoted any third repair failure, including
      // transient provider failures, to a permanent reconnect flag. Only a
      // provider-classified authorization marker may now suppress live probes;
      // unmarked legacy rows get one bounded revalidation and can self-heal.
      let reconnectRequired =
        (credentials.waba_subscription_permanently_failed === true ||
          credentials.webhook_requires_reconnect === true) &&
        hasConfirmedWhatsAppMetaAuthorizationReconnect(credentials);
      const metaReadDecision = getWhatsAppMetaReadDecision(credentials);
      if (
        !metaReadDecision.shouldRefresh &&
        metaReadDecision.reason === "cooldown"
      ) {
        providerCallsStopped = true;
      }
      const applyConfiguredAppDiagnosticsFailure = (
        error: unknown,
        context?: string
      ): void => {
        const structuredMessage =
          typeof error === "object" &&
          error !== null &&
          typeof (error as { error?: unknown }).error === "string"
            ? (error as { error: string }).error
            : null;
        const providerMessage =
          error instanceof Error
            ? error.message
            : structuredMessage || String(error);
        const isFirstConfiguredAppFailure =
          configuredAppDiagnosticsFailure === null;
        configuredAppDiagnosticsFailure = `Platform Meta app diagnostics failed${
          context ? ` ${context}` : ""
        }: ${providerMessage}`;
        providerCallsStopped = true;
        metaProviderFailureOccurred = true;
        result.waba_subscription_status = "unknown";
        result.skipped_reason = "provider_configuration_error";
        result.error = configuredAppDiagnosticsFailure;
        markResultFailed();
        if (isFirstConfiguredAppFailure) {
          criticalIssues.push(configuredAppDiagnosticsFailure);
        }
        maintenanceLogger.error(
          "Configured Meta app diagnostics failed",
          error,
          {
            sourceId: source.id,
            workspaceId: source.workspace_id,
            wabaId,
            context,
          }
        );
      };
      const applyMetaRateLimit = async (error: unknown): Promise<void> => {
        const wabaRateLimitCount = wabaId
          ? (metaRateLimitCountByWaba.get(wabaId) ?? 0)
          : 0;
        const rateLimitPatch = buildWhatsAppMetaRateLimitCredentialPatch(
          {
            ...updatedCredentials,
            meta_diagnostics_consecutive_rate_limits: Math.max(
              wabaRateLimitCount,
              updatedCredentials.meta_diagnostics_consecutive_rate_limits ?? 0
            ),
          },
          { error }
        );
        updatedCredentials = {
          ...updatedCredentials,
          ...rateLimitPatch,
        };
        metaPolicyWasUpdated = true;
        const cooldownUntil =
          typeof rateLimitPatch.meta_diagnostics_cooldown_until === "string"
            ? rateLimitPatch.meta_diagnostics_cooldown_until
            : null;
        if (wabaId && cooldownUntil) {
          const nextRateLimitCount =
            rateLimitPatch.meta_diagnostics_consecutive_rate_limits;
          if (typeof nextRateLimitCount === "number") {
            metaRateLimitCountByWaba.set(wabaId, nextRateLimitCount);
          }
          sharedMetaCooldownUntil = cooldownUntil;
          metaCooldownByWaba.set(wabaId, cooldownUntil);
          await setCachedWhatsAppMetaReadCooldownUntil(wabaId, cooldownUntil);
        }
      };
      const applyMetaAuthorizationFailure = (
        error: unknown,
        operation: MetaAuthorizationOperation
      ): string => {
        const providerMessage =
          error instanceof Error ? error.message : String(error);
        const operationLabel =
          operation === "token_refresh"
            ? "Could not refresh the WhatsApp access token"
            : operation === "phone_details"
              ? "Could not fetch WhatsApp phone details"
              : "Could not verify the WABA webhook subscription";
        const message = `${operationLabel}: ${providerMessage}`;

        providerCallsStopped = true;
        reconnectRequired = true;
        metaProviderFailureOccurred = true;
        result.waba_subscription_status = "unknown";
        result.skipped_reason = "reconnection_required";
        result.error = message;
        updatedCredentials = {
          ...updatedCredentials,
          ...buildWhatsAppMetaAuthorizationCredentialPatch(error),
          webhook_requires_reconnect: true,
          webhook_error: message,
          ...(operation === "phone_details"
            ? { phone_webhook_error: message }
            : {}),
          ...(operation === "token_refresh"
            ? { token_refresh_error: message }
            : {}),
        };
        webhookStateWasUpdated = true;
        metaPolicyWasUpdated = true;

        return message;
      };
      const rememberTerminalAuthorizationFailure = (
        error: unknown,
        operation: MetaAuthorizationOperation
      ): void => {
        if (!accessToken || !wabaId || !phoneNumberId) return;
        terminalAuthorizationFailures.set(
          buildTerminalAuthorizationFailureKey({
            error,
            operation,
            tokenFingerprint: fingerprintAccessToken(accessToken),
            wabaId,
            phoneNumberId,
          }),
          { error, operation }
        );
      };
      const acquireProviderRefreshLock = async (): Promise<boolean> => {
        if (providerRefreshPermit?.outcome === "acquired") return true;
        if (providerRefreshBlocked) return false;

        const permit = await acquireWhatsAppMetaReadLock(
          {
            sourceId: source.id,
            wabaId: wabaId || undefined,
            additionalCooldownUntil: wabaId
              ? metaCooldownByWaba.get(wabaId)
              : null,
          },
          { cacheClient: cache }
        );

        if (permit.outcome === "acquired") {
          providerRefreshPermit = permit;
          return true;
        }

        if (permit.outcome === "cooldown") {
          if (wabaId) {
            sharedMetaCooldownUntil = permit.cooldownUntil;
            metaCooldownByWaba.set(wabaId, permit.cooldownUntil);
          }
          providerCallsStopped = true;
          result.skipped_reason = "rate_limit_cooldown";
          result.error = `Meta diagnostics are cooling down until ${permit.cooldownUntil}`;
          if (!result.rate_limited) {
            result.rate_limited = true;
            rateLimitedCount++;
          }
          return false;
        }

        if (permit.outcome === "coordination_unavailable") {
          providerRefreshBlocked = true;
          providerCoordinationUnavailable = true;
          providerCallsStopped = true;
          result.skipped_reason = "provider_coordination_unavailable";
          result.error =
            "Meta diagnostics coordination is temporarily unavailable";
          warningsCount++;
          maintenanceLogger.error(
            "Provider coordination unavailable for WhatsApp source",
            new Error("Provider refresh lock backend is unavailable"),
            {
              sourceId: source.id,
              workspaceId: source.workspace_id,
              wabaId,
            }
          );
          return false;
        }

        providerRefreshBlocked = true;
        result.skipped_reason = "provider_refresh_in_progress";
        result.error = "Meta diagnostics refresh is already in progress";
        return false;
      };

      try {
        if (!wabaId || !phoneNumberId || !accessTokenFromCreds) {
          result.error =
            "Missing WhatsApp credentials (waba_id/phone_number_id/access_token)";
          markResultFailed();
          results.push(result);
          continue;
        }
        accessToken = accessTokenFromCreds;
        const rememberedTokenFailure = terminalAuthorizationFailures.get(
          buildTokenAuthorizationFailureKey(fingerprintAccessToken(accessToken))
        );
        if (rememberedTokenFailure) {
          const authorizationMessage = applyMetaAuthorizationFailure(
            rememberedTokenFailure.error,
            rememberedTokenFailure.operation
          );
          markResultFailed();
          criticalIssues.push(
            `Workspace ${source.workspace_id}: ${authorizationMessage}`
          );
        }
        if (configuredAppDiagnosticsFailure && !providerCallsStopped) {
          providerCallsStopped = true;
          result.skipped_reason = "provider_configuration_error";
          result.error = configuredAppDiagnosticsFailure;
          markResultFailed();
        }
        if (!sharedCooldownLoadedForWaba.has(wabaId)) {
          const cachedCooldownUntil =
            await getCachedWhatsAppMetaReadCooldownUntil(wabaId);
          sharedCooldownLoadedForWaba.add(wabaId);
          sharedMetaCooldownUntil =
            selectLaterActiveWhatsAppMetaReadCooldownUntil([
              metaCooldownByWaba.get(wabaId),
              cachedCooldownUntil,
            ]);
          metaCooldownByWaba.set(wabaId, sharedMetaCooldownUntil);
        } else {
          sharedMetaCooldownUntil = metaCooldownByWaba.get(wabaId) ?? null;
        }
        if (sharedMetaCooldownUntil) {
          providerCallsStopped = true;
        }

        // Read Meta's current token evidence before using cached expiry or
        // publishing a renewed credential. Reuse the WABA lock and memoize
        // complete verified results for duplicate source bindings in this run.
        if (!providerCallsStopped) {
          const tokenIdentity = JSON.stringify([
            wabaId,
            fingerprintAccessToken(accessToken),
          ]);
          let maintenance = tokenMaintenanceByIdentity.get(tokenIdentity);
          if (!maintenance && (await acquireProviderRefreshLock())) {
            maintenance = await maintainWhatsAppToken({
              accessToken,
              wabaId,
              credentials,
            });
            tokenMaintenanceByIdentity.set(tokenIdentity, maintenance);
          }
          if (maintenance) {
            updatedCredentials = {
              ...updatedCredentials,
              ...maintenance.credentialsPatch,
            };
            tokenMetadataWasUpdated =
              Object.keys(maintenance.credentialsPatch).length > 0;
            tokenReconnectRequired = maintenance.requiresReconnect;
            const verifiedExpiry =
              typeof updatedCredentials.token_expires_at === "string"
                ? Date.parse(updatedCredentials.token_expires_at)
                : NaN;
            result.token_expired =
              Boolean(updatedCredentials.token_verified_at) &&
              Number.isFinite(verifiedExpiry) &&
              verifiedExpiry <= Date.now();
            if (result.token_expired) {
              tokenExpiredIssue =
                "Workspace " +
                source.workspace_id +
                ": WhatsApp access has expired";
            }
            if (maintenance.refreshed) {
              updatedCredentials.access_token = encryptString(
                maintenance.accessToken
              );
              accessToken = maintenance.accessToken;
              tokenWasRefreshed = true;
              result.token_expired = false;
              result.error = undefined;
            }
            if (
              maintenance.requiresReconnect &&
              (result.token_expired ||
                maintenance.credentialsPatch.token_is_valid === false ||
                maintenance.credentialsPatch.token_maintenance_error_code ===
                  "token_authorization_invalid")
            ) {
              const missingWabaAccess =
                maintenance.credentialsPatch.token_maintenance_error_code ===
                "waba_access_missing";
              const authorizationOperation = missingWabaAccess
                ? "waba_subscription"
                : "token_refresh";
              const authorizationError = Object.assign(
                new Error(
                  "Meta confirmed WhatsApp authorization requires reconnection"
                ),
                {
                  metaError: missingWabaAccess
                    ? { code: 100, error_subcode: 33 }
                    : { code: 190 },
                }
              );
              const authorizationMessage = applyMetaAuthorizationFailure(
                authorizationError,
                authorizationOperation
              );
              rememberTerminalAuthorizationFailure(
                authorizationError,
                authorizationOperation
              );
              if (!result.token_expired) {
                criticalIssues.push(
                  `Workspace ${source.workspace_id}: ${authorizationMessage}`
                );
              }
              markResultFailed();
            }
            if (maintenance.error) throw maintenance.error;
          }
        }
      } catch (error) {
        const providerMessage =
          error instanceof Error ? error.message : String(error);
        const errorClass = classifyWhatsAppMetaDiagnosticError(error);
        if (errorClass === "configured_app") {
          applyConfiguredAppDiagnosticsFailure(error, "during token renewal");
        } else if (errorClass === "rate_limited") {
          metaProviderFailureOccurred = true;
          result.error = providerMessage;
          await applyMetaRateLimit(error);
          providerCallsStopped = true;
          result.rate_limited = true;
          result.waba_subscription_status = "unknown";
          rateLimitedCount++;
          warningsCount++;
        } else if (errorClass === "authorization") {
          rememberTerminalAuthorizationFailure(error, "token_refresh");
          const authorizationMessage = applyMetaAuthorizationFailure(
            error,
            "token_refresh"
          );
          markResultFailed();
          criticalIssues.push(
            tokenExpiredIssue
              ? `${tokenExpiredIssue}; ${authorizationMessage}`
              : `Workspace ${source.workspace_id}: ${authorizationMessage}`
          );
          tokenExpiredIssue = null;
          maintenanceLogger.warn(
            "WhatsApp token refresh requires reconnection",
            {
              sourceId: source.id,
              workspaceId: source.workspace_id,
              wabaId,
            }
          );
        } else {
          metaProviderFailureOccurred = true;
          result.error = providerMessage;
          updatedCredentials = {
            ...updatedCredentials,
            ...buildWhatsAppMetaReadFailureCredentialPatch(),
          };
          metaPolicyWasUpdated = true;
          markResultFailed();
          criticalIssues.push(
            tokenExpiredIssue
              ? `${tokenExpiredIssue}; Error refreshing token - ${result.error}`
              : `Workspace ${source.workspace_id}: Error refreshing token - ${result.error}`
          );
          tokenExpiredIssue = null;
          console.error(
            `[WhatsApp Maintenance] Error refreshing token for source ${source.id}:`,
            error
          );
          // A transient exchange failure can keep using a token whose local
          // expiry remains valid. Expired or rejected tokens stop here.
        }
      }

      // Account for the final token state after the exchange attempt. Keeping
      // this outside the try/catch ensures a provider failure cannot bypass an
      // already-confirmed local expiry, while a successful renewal clears the
      // expiry before it is reported.
      if (result.token_expired && tokenExpiredIssue) {
        criticalIssues.push(tokenExpiredIssue);
      }

      // A source already marked for reconnection cannot be repaired by another
      // live probe. Keep local token maintenance above, but avoid repeatedly
      // consuming WABA/phone reads until the user reconnects it.
      if (sharedMetaCooldownUntil) {
        result.skipped_reason = "rate_limit_cooldown";
        result.error = `Meta diagnostics are cooling down until ${sharedMetaCooldownUntil}`;
        if (!result.rate_limited) {
          result.rate_limited = true;
          rateLimitedCount++;
        }
      } else if (providerCoordinationUnavailable) {
        result.skipped_reason = "provider_coordination_unavailable";
        result.error =
          "Meta diagnostics coordination is temporarily unavailable";
      } else if (providerRefreshBlocked) {
        result.skipped_reason = "provider_refresh_in_progress";
        result.error = "Meta diagnostics refresh is already in progress";
      } else if (reconnectRequired) {
        result.skipped_reason = "reconnection_required";
        result.error ||= "WABA subscription requires reconnection";
      } else if (configuredAppDiagnosticsFailure) {
        result.skipped_reason = "provider_configuration_error";
        result.error = configuredAppDiagnosticsFailure;
      } else if (!metaReadDecision.shouldRefresh) {
        if (metaReadDecision.reason === "cooldown") {
          result.skipped_reason = "rate_limit_cooldown";
          result.rate_limited = true;
          result.error = `Meta diagnostics are cooling down until ${metaReadDecision.cooldownUntil}`;
          rateLimitedCount++;
        } else {
          result.skipped_reason = "fresh_provider_state";
        }
      }

      const diagnosticsTokenFingerprint = accessToken
        ? fingerprintAccessToken(accessToken)
        : "";
      const phoneDetailsMemoKey = JSON.stringify([
        wabaId,
        phoneNumberId,
        diagnosticsTokenFingerprint,
      ]);
      const wabaSubscriptionMemoKey = JSON.stringify([
        wabaId,
        diagnosticsTokenFingerprint,
      ]);
      const rememberedResourceFailure =
        terminalAuthorizationFailures.get(
          buildPhoneAuthorizationFailureKey({
            wabaId: wabaId || "",
            phoneNumberId: phoneNumberId || "",
            tokenFingerprint: diagnosticsTokenFingerprint,
          })
        ) ??
        terminalAuthorizationFailures.get(
          buildWabaAuthorizationFailureKey({
            wabaId: wabaId || "",
            tokenFingerprint: diagnosticsTokenFingerprint,
          })
        );
      if (rememberedResourceFailure && !providerCallsStopped) {
        const authorizationMessage = applyMetaAuthorizationFailure(
          rememberedResourceFailure.error,
          rememberedResourceFailure.operation
        );
        markResultFailed();
        criticalIssues.push(
          `Workspace ${source.workspace_id}: ${authorizationMessage}`
        );
      }
      const shouldRunProviderDiagnostics =
        Boolean(accessToken) &&
        !providerCallsStopped &&
        !result.token_expired &&
        !reconnectRequired &&
        metaReadDecision.shouldRefresh;
      const memoizedWabaSubscription = wabaId
        ? wabaSubscriptionByWabaAndToken.get(wabaSubscriptionMemoKey)
        : undefined;
      const phoneDetailsWereMemoized =
        phoneDetailsByWabaAndPhone.has(phoneDetailsMemoKey) ||
        phoneDetailsFailureByWabaAndPhone.has(phoneDetailsMemoKey);
      const wabaRepairWasMemoized =
        Boolean(wabaId && confirmedWabaRepairByWaba.has(wabaId)) ||
        wabaRepairByWabaAndToken.has(wabaSubscriptionMemoKey);
      const providerDiagnosticsCallRequired =
        !phoneDetailsWereMemoized ||
        !memoizedWabaSubscription ||
        (memoizedWabaSubscription.status === "unsubscribed" &&
          !wabaRepairWasMemoized);
      if (
        shouldRunProviderDiagnostics &&
        providerDiagnosticsCallRequired &&
        !providerRefreshBlocked &&
        !providerRefreshPermit
      ) {
        await acquireProviderRefreshLock();
      }

      // Step 2: Check webhook subscriptions (only if we have a valid token)
      if (
        shouldRunProviderDiagnostics &&
        (providerRefreshPermit || !providerDiagnosticsCallRequired) &&
        !providerRefreshBlocked &&
        accessToken
      ) {
        metaDiagnosticsWereAttempted = true;
        try {
          providerChecks: {
            try {
              let details = phoneDetailsByWabaAndPhone.get(phoneDetailsMemoKey);
              if (!details) {
                if (
                  phoneDetailsFailureByWabaAndPhone.has(phoneDetailsMemoKey)
                ) {
                  throw phoneDetailsFailureByWabaAndPhone.get(
                    phoneDetailsMemoKey
                  );
                }
                try {
                  details = await getPhoneNumberDetails(
                    phoneNumberId || "",
                    accessToken
                  );
                  phoneDetailsByWabaAndPhone.set(phoneDetailsMemoKey, details);
                } catch (error) {
                  phoneDetailsFailureByWabaAndPhone.set(
                    phoneDetailsMemoKey,
                    error
                  );
                  throw error;
                }
              }
              const phoneDetailsCheckedAt = new Date().toISOString();
              updatedCredentials = {
                ...updatedCredentials,
                ...buildWhatsAppPhoneDetailsCredentialPatch(details),
                messaging_limit_last_checked_at: phoneDetailsCheckedAt,
                ...buildWhatsAppBusinessAppConnectionPatch({
                  embeddedSignupFlow: updatedCredentials.embedded_signup_flow,
                  embeddedSignupEvent: updatedCredentials.embedded_signup_event,
                  isOnBizApp: details.is_on_biz_app,
                  coexistenceMode: updatedCredentials.coexistence_mode,
                  partnerAppInstalled: updatedCredentials.partner_app_installed,
                  partnerAppInstalledAt:
                    updatedCredentials.partner_app_installed_at,
                  qrRegistered: updatedCredentials.qr_registered,
                  platformType:
                    details.platform_type || updatedCredentials.platform_type,
                  cloudApiMessagingSuspended:
                    isWhatsAppCloudApiMessagingSuspended(updatedCredentials),
                  now: phoneDetailsCheckedAt,
                }),
              };
              phoneDetailsWereHydrated = true;
            } catch (error) {
              const errorClass = classifyWhatsAppMetaDiagnosticError(error);
              if (errorClass === "rate_limited") {
                await applyMetaRateLimit(error);
                result.rate_limited = true;
                result.waba_subscription_status = "unknown";
                result.error =
                  "Meta rate limit reached; live subscription status was not changed";
                rateLimitedCount++;
                warningsCount++;
                break providerChecks;
              }
              if (errorClass === "authorization") {
                rememberTerminalAuthorizationFailure(error, "phone_details");
                const authorizationMessage = applyMetaAuthorizationFailure(
                  error,
                  "phone_details"
                );
                markResultFailed();
                criticalIssues.push(
                  `Workspace ${source.workspace_id}: ${authorizationMessage}`
                );
                maintenanceLogger.warn(
                  "WhatsApp phone diagnostics require reconnection",
                  {
                    sourceId: source.id,
                    workspaceId: source.workspace_id,
                    wabaId,
                    phoneNumberId,
                  }
                );
                break providerChecks;
              }

              metaProviderFailureOccurred = true;
              result.error = `Could not fetch phone details: ${
                error instanceof Error ? error.message : String(error)
              }`;
              warningsCount++;

              console.warn(
                `[WhatsApp Maintenance] Could not fetch phone details for source ${source.id}:`,
                error
              );
            }

            const webhookCredentials =
              normalizeWhatsAppCredentials(updatedCredentials);
            const coexistenceMode = hasWhatsAppBusinessAppConnectionSignal({
              embeddedSignupFlow: webhookCredentials.embeddedSignupFlow,
              embeddedSignupEvent: updatedCredentials.embedded_signup_event,
              isOnBizApp: webhookCredentials.isOnBizApp,
              coexistenceMode: webhookCredentials.coexistenceMode,
              partnerAppInstalled: updatedCredentials.partner_app_installed,
              qrRegistered: updatedCredentials.qr_registered,
              platformType: webhookCredentials.platformType,
            });
            const webhookProfileTemplate = analyzeSubscribedFields([], {
              coexistenceMode,
            });

            // Check current subscription status
            let providerWabaCheck = wabaId
              ? wabaSubscriptionByWabaAndToken.get(wabaSubscriptionMemoKey)
              : undefined;
            if (!providerWabaCheck) {
              providerWabaCheck = await checkWABASubscription(
                wabaId || "",
                accessToken,
                { coexistenceMode }
              );
              if (wabaId) {
                wabaSubscriptionByWabaAndToken.set(
                  wabaSubscriptionMemoKey,
                  providerWabaCheck
                );
              }
            }
            const sourceWabaCoverage = analyzeSubscribedFields(
              providerWabaCheck.fields || [],
              { coexistenceMode }
            );
            const wabaCheck = {
              ...providerWabaCheck,
              fields: sourceWabaCoverage.subscribedFields,
              missingRequiredFields: sourceWabaCoverage.missingRequiredFields,
              missingOptionalFields: sourceWabaCoverage.missingOptionalFields,
              coverageOk: sourceWabaCoverage.coverageOk,
              actionable: sourceWabaCoverage.actionable,
            };

            result.waba_subscription_status = wabaCheck.status;
            if (wabaCheck.status === "unknown") {
              result.error = wabaCheck.error || "Could not verify WABA status";
              const errorClass = classifyWhatsAppMetaDiagnosticError(
                wabaCheck.cause
              );
              if (errorClass === "configured_app") {
                applyConfiguredAppDiagnosticsFailure(
                  wabaCheck.cause,
                  "while reading webhook fields"
                );
              } else if (errorClass === "rate_limited") {
                await applyMetaRateLimit(wabaCheck.cause);
                result.rate_limited = true;
                rateLimitedCount++;
                warningsCount++;
              } else if (errorClass === "authorization") {
                rememberTerminalAuthorizationFailure(
                  wabaCheck.cause,
                  "waba_subscription"
                );
                const authorizationMessage = applyMetaAuthorizationFailure(
                  wabaCheck.cause,
                  "waba_subscription"
                );
                markResultFailed();
                criticalIssues.push(
                  `Workspace ${source.workspace_id}: ${authorizationMessage}`
                );
                maintenanceLogger.warn(
                  "WABA webhook diagnostics require reconnection",
                  {
                    sourceId: source.id,
                    workspaceId: source.workspace_id,
                    wabaId,
                  }
                );
              } else {
                metaProviderFailureOccurred = true;
                warningsCount++;
              }
              break providerChecks;
            }
            wabaDiagnosticsWereHydrated = true;

            result.waba_subscribed = wabaCheck.subscribed;
            // There is no separate phone-number subscribed_apps check. The WABA
            // subscription covers phone events and Meta includes phone_number_id
            // in webhook metadata for routing.
            result.phone_subscribed = wabaCheck.subscribed;
            result.waba_subscribed_fields = wabaCheck.fields;
            result.webhook_missing_required_fields =
              wabaCheck.missingRequiredFields;
            result.webhook_missing_optional_fields =
              wabaCheck.missingOptionalFields;
            result.webhook_coverage_ok = wabaCheck.coverageOk;
            if (wabaCheck.subscribed && !wabaCheck.coverageOk) {
              warningsCount++;
              result.error =
                wabaCheck.actionable ||
                "WABA subscription is missing required webhook fields";
            }

            const webhookCheckedAt = new Date().toISOString();
            const webhookCoveragePatch = {
              webhook_profile_version: WEBHOOK_PROFILE_VERSION,
              webhook_required_fields: webhookProfileTemplate.requiredFields,
              webhook_optional_fields: webhookProfileTemplate.optionalFields,
              webhook_missing_required_fields:
                wabaCheck.missingRequiredFields || [],
              webhook_missing_optional_fields:
                wabaCheck.missingOptionalFields || [],
              webhook_coverage_ok: wabaCheck.coverageOk,
              webhook_fields_last_checked_at: webhookCheckedAt,
              waba_subscribed_fields: wabaCheck.fields || [],
            };

            // If WABA subscription is lost (most critical), try to auto-fix
            if (!wabaCheck.subscribed) {
              // Check if this WABA has been permanently flagged as unrecoverable
              const consecutiveFailures =
                credentials.waba_subscription_consecutive_failures || 0;
              let providerFixResult = wabaId
                ? confirmedWabaRepairByWaba.get(wabaId)
                : undefined;
              providerFixResult ??= wabaRepairByWabaAndToken.get(
                wabaSubscriptionMemoKey
              );
              if (!providerFixResult) {
                console.warn(
                  `[WhatsApp Maintenance] WABA subscription lost for workspace ${source.workspace_id}, attempting auto-fix...`
                );
                providerFixResult = await subscribeToWABAWebhooks(
                  wabaId || "",
                  accessToken,
                  { coexistenceMode }
                );
                if (wabaId) {
                  wabaRepairByWabaAndToken.set(
                    wabaSubscriptionMemoKey,
                    providerFixResult
                  );
                  if (providerFixResult.success) {
                    confirmedWabaRepairByWaba.set(wabaId, providerFixResult);
                  }
                }
              }
              const sourceRepairCoverage = providerFixResult.success
                ? analyzeSubscribedFields(
                    providerFixResult.subscribedFields || [],
                    { coexistenceMode }
                  )
                : null;
              const fixResult = sourceRepairCoverage
                ? {
                    ...providerFixResult,
                    subscribedFields: sourceRepairCoverage.subscribedFields,
                    missingRequiredFields:
                      sourceRepairCoverage.missingRequiredFields,
                    missingOptionalFields:
                      sourceRepairCoverage.missingOptionalFields,
                    coverageOk: sourceRepairCoverage.coverageOk,
                    coverage: sourceRepairCoverage,
                  }
                : providerFixResult;

              if (fixResult.success) {
                result.waba_subscription_status = "subscribed";
                result.waba_subscribed = true;
                result.phone_subscribed = true;
                result.waba_subscribed_fields = fixResult.subscribedFields;
                result.webhook_missing_required_fields =
                  fixResult.missingRequiredFields;
                result.webhook_missing_optional_fields =
                  fixResult.missingOptionalFields;
                result.webhook_coverage_ok = fixResult.coverageOk;

                const coverageRestored =
                  fixResult.coverageOk === true &&
                  (fixResult.missingRequiredFields?.length ?? 0) === 0;
                if (coverageRestored) {
                  subscriptionWasFixed = true;
                  console.log(
                    `[WhatsApp Maintenance] ✅ Auto-fixed WABA subscription for workspace ${source.workspace_id}`
                  );
                } else {
                  warningsCount++;
                  const missingRequiredFields =
                    fixResult.missingRequiredFields || [];
                  result.error =
                    missingRequiredFields.length > 0
                      ? `WABA subscription remains incomplete; missing required webhook fields: ${missingRequiredFields.join(", ")}`
                      : "WABA subscription is active but no required webhook fields are configured";
                  console.warn(
                    `[WhatsApp Maintenance] WABA subscription coverage remains incomplete for workspace ${source.workspace_id}: ${result.error}`
                  );
                }

                updatedCredentials = {
                  ...updatedCredentials,
                  webhook_subscribed: coverageRestored,
                  webhook_last_checked: webhookCheckedAt,
                  webhook_error: coverageRestored ? undefined : result.error,
                  webhook_requires_reconnect: false,
                  waba_subscription_consecutive_failures: 0,
                  waba_subscription_permanently_failed: false,
                  webhook_profile_version:
                    fixResult.coverage?.profileVersion ||
                    WEBHOOK_PROFILE_VERSION,
                  webhook_required_fields:
                    fixResult.coverage?.requiredFields ||
                    webhookCoveragePatch.webhook_required_fields,
                  webhook_optional_fields:
                    fixResult.coverage?.optionalFields ||
                    webhookCoveragePatch.webhook_optional_fields,
                  webhook_missing_required_fields:
                    fixResult.missingRequiredFields ||
                    webhookCoveragePatch.webhook_missing_required_fields,
                  webhook_missing_optional_fields:
                    fixResult.missingOptionalFields ||
                    webhookCoveragePatch.webhook_missing_optional_fields,
                  webhook_coverage_ok: fixResult.coverageOk,
                  webhook_fields_last_checked_at: webhookCheckedAt,
                  waba_subscribed_fields:
                    fixResult.subscribedFields ||
                    webhookCoveragePatch.waba_subscribed_fields,
                };
              } else if (
                classifyWhatsAppMetaDiagnosticError(fixResult) ===
                "rate_limited"
              ) {
                await applyMetaRateLimit(fixResult);
                result.rate_limited = true;
                result.error =
                  "Meta rate limit reached while repairing the confirmed missing subscription";
                rateLimitedCount++;
                warningsCount++;
                updatedCredentials = {
                  ...updatedCredentials,
                  webhook_subscribed: false,
                  webhook_last_checked: webhookCheckedAt,
                  ...webhookCoveragePatch,
                };
              } else if (
                classifyWhatsAppMetaDiagnosticError(fixResult) ===
                "configured_app"
              ) {
                applyConfiguredAppDiagnosticsFailure(
                  fixResult,
                  "while verifying webhook repair"
                );
                updatedCredentials = {
                  ...updatedCredentials,
                  webhook_subscribed: false,
                  webhook_last_checked: webhookCheckedAt,
                  webhook_requires_reconnect: false,
                  waba_subscription_permanently_failed: false,
                  ...webhookCoveragePatch,
                };
              } else {
                metaProviderFailureOccurred = true;
                const requiresReconnect =
                  classifyWhatsAppMetaDiagnosticError(fixResult) ===
                  "authorization";
                const newConsecutiveFailures = consecutiveFailures + 1;

                markResultFailed();
                result.error = `Auto-fix failed: ${fixResult.error}`;
                if (requiresReconnect) {
                  rememberTerminalAuthorizationFailure(
                    fixResult,
                    "waba_subscription"
                  );
                  reconnectRequired = true;
                  providerCallsStopped = true;
                  result.skipped_reason = "reconnection_required";
                }

                criticalIssues.push(
                  `Workspace ${source.workspace_id}: WABA subscription lost and auto-fix failed (attempt ${newConsecutiveFailures}) - ${fixResult.error}` +
                    (requiresReconnect ? " (requires reconnection)" : "")
                );
                console.error(
                  `[WhatsApp Maintenance] ❌ Failed to auto-fix WABA subscription for workspace ${source.workspace_id} (attempt ${newConsecutiveFailures}):`,
                  fixResult
                );

                updatedCredentials = {
                  ...updatedCredentials,
                  ...(requiresReconnect
                    ? buildWhatsAppMetaAuthorizationCredentialPatch(fixResult)
                    : {}),
                  webhook_subscribed: false,
                  webhook_last_checked: webhookCheckedAt,
                  webhook_error: fixResult.error || "Subscription lost",
                  webhook_requires_reconnect: requiresReconnect,
                  waba_subscription_consecutive_failures:
                    newConsecutiveFailures,
                  waba_subscription_permanently_failed: requiresReconnect,
                  ...webhookCoveragePatch,
                };
              }
            } else {
              // Webhook is active — update status and reset failure counters
              updatedCredentials = {
                ...updatedCredentials,
                webhook_subscribed: true,
                webhook_last_checked: webhookCheckedAt,
                webhook_error: undefined,
                webhook_requires_reconnect: false,
                waba_subscription_consecutive_failures: 0,
                waba_subscription_permanently_failed: false,
                ...webhookCoveragePatch,
              };
            }
            webhookStateWasUpdated = true;
          }
        } catch (error) {
          metaProviderFailureOccurred = true;
          result.error = error instanceof Error ? error.message : String(error);
          markResultFailed();
          criticalIssues.push(
            `Workspace ${source.workspace_id}: Error checking/fixing subscriptions - ${result.error}`
          );
          console.error(
            `[WhatsApp Maintenance] Error processing source ${source.id}:`,
            error
          );
        }

        if (!result.rate_limited && metaDiagnosticsWereAttempted) {
          const requiredDiagnosticsSucceeded =
            phoneDetailsWereHydrated &&
            wabaDiagnosticsWereHydrated &&
            !metaProviderFailureOccurred;
          updatedCredentials = {
            ...updatedCredentials,
            ...(requiredDiagnosticsSucceeded
              ? buildWhatsAppMetaReadSuccessCredentialPatch()
              : buildWhatsAppMetaReadFailureCredentialPatch()),
          };
          metaPolicyWasUpdated = true;
        }
      }

      // Step 3: Update source with all changes (token refresh + webhook status)
      if (
        tokenWasRefreshed ||
        tokenMetadataWasUpdated ||
        phoneDetailsWereHydrated ||
        webhookStateWasUpdated ||
        metaPolicyWasUpdated
      ) {
        try {
          await updateCurrentWhatsAppSourceCredentialsFromSnapshot({
            workspaceId: source.workspace_id,
            sourceId: source.id,
            currentCredentials: credentials as Record<string, unknown>,
            nextCredentials: updatedCredentials,
            expectedPhoneNumberId: phoneNumberId,
            expectedCredentials: {
              access_token: credentials.access_token,
              accessToken: (credentials as Record<string, unknown>).accessToken,
            },
          });
          if (tokenWasRefreshed) {
            result.token_refreshed = true;
            refreshedCount++;
          }
          if (subscriptionWasFixed) {
            result.auto_fixed = true;
            fixedCount++;
          }
          // The final state must survive the source/token fence before an
          // actionable alert. Routine background renewal needs no countdown.
          if (tokenReconnectRequired) {
            const expiryAlert = await checkTokenExpiryAndAlert({
              tokenExpiresAt: updatedCredentials.token_expires_at,
              workspaceId: source.workspace_id,
              integrationType: "whatsapp",
              logPrefix: "[WhatsApp Maintenance]",
            });
            if (expiryAlert.alertSent) warningsCount++;
          }
        } catch (error) {
          result.persistence_failed = true;
          result.token_refreshed = false;
          result.auto_fixed = false;
          result.error = `Maintenance state was not persisted: ${
            error instanceof Error ? error.message : String(error)
          }`;
          markResultFailed();
          criticalIssues.push(
            `Workspace ${source.workspace_id}: Maintenance state was not persisted - ${result.error}`
          );
          console.error(
            `[WhatsApp Maintenance] Failed to update source ${source.id}:`,
            error
          );
        }
      }

      if (providerRefreshPermit) {
        await releaseWhatsAppMetaReadPermit(providerRefreshPermit, cache);
      }

      results.push(result);
    }

    // Log summary
    const summary = {
      total: sources.length,
      checked: results.length,
      waba_subscribed: results.filter(
        r => r.waba_subscription_status === "subscribed"
      ).length,
      waba_unsubscribed: results.filter(
        r => r.waba_subscription_status === "unsubscribed"
      ).length,
      waba_unknown: results.filter(
        r => r.waba_subscription_status === "unknown"
      ).length,
      phone_subscribed: results.filter(
        r => r.waba_subscription_status === "subscribed"
      ).length,
      waba_last_known_subscribed: results.filter(r => r.waba_subscribed).length,
      phone_last_known_subscribed: results.filter(r => r.phone_subscribed)
        .length,
      token_refreshed: refreshedCount,
      auto_fixed: fixedCount,
      failed: failedCount,
      warnings: warningsCount,
      rate_limited: rateLimitedCount,
      token_expired: results.filter(r => r.token_expired).length,
      critical_issues: criticalIssues.length,
    };
    const hasMaintenanceDegradation =
      criticalIssues.length > 0 ||
      warningsCount > 0 ||
      failedCount > 0 ||
      rateLimitedCount > 0 ||
      results.some(
        result =>
          result.skipped_reason === "reconnection_required" ||
          result.skipped_reason === "provider_configuration_error" ||
          result.skipped_reason === "provider_coordination_unavailable"
      );

    console.log("[WhatsApp Maintenance] Summary:", summary);

    // If there are critical issues, log them prominently
    if (criticalIssues.length > 0) {
      console.error(
        "[WhatsApp Maintenance] ⚠️ CRITICAL ISSUES DETECTED:",
        criticalIssues
      );
      // TODO: Send alert/notification (email, Slack, etc.)
    }

    return NextResponse.json({
      status: hasMaintenanceDegradation ? "degraded" : "ok",
      summary,
      results,
      critical_issues: criticalIssues,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[WhatsApp Maintenance] Unexpected error:", error);
    return NextResponse.json(
      {
        status: "error",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  } finally {
    if (maintenanceLockToken) {
      await cache.compareAndDelete(maintenanceLockKey, maintenanceLockToken);
    }
  }
}
