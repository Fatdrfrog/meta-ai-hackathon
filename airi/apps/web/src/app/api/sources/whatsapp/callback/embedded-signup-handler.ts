import { runWhatsAppPostConnectSetup } from "@/lib/whatsapp/post-connect";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { randomUUID } from "node:crypto";
import { prepareWhatsAppHistorySyncSession } from "@/lib/whatsapp/history-sync/lifecycle";
import { buildWhatsAppTokenMetadataPatch } from "@/lib/whatsapp/token-lifecycle";
import { encryptString } from "@/lib/crypto";
import {
  COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE,
  ensureCompanyChannelCapacity,
} from "@/lib/limits/company-limits";
import {
  buildMetaAppAccessToken,
  getMetaServerAppConfig,
  tryGetMetaServerAppConfig,
  type MetaServerAppConfig,
} from "@/lib/meta/app-config";
import {
  debugMetaAccessToken,
  evaluateMetaAccessToken,
} from "@icecore/shared/lib/meta/debug-token";
import {
  buildWhatsAppPhoneDetailsCredentialPatch,
  isWhatsAppPhoneNumberRegistered,
} from "@icecore/shared/lib/whatsapp/phone-details";
import type { WhatsAppCredentials } from "@icecore/shared/types/sources";
import {
  createServerLogger,
  flushServerLogsAfterResponse,
  type ServerLogContext,
} from "@/lib/observability/server-logs";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { findWhatsAppPhoneOwner } from "@/lib/whatsapp/account/inventory";
import {
  recordWhatsAppOnboardingEvent,
  upsertWhatsAppAccountsForSource,
} from "@/lib/whatsapp/account/persistence";
import {
  buildWhatsAppReconnectedCredentialPatch,
  normalizeWhatsAppCredentials,
  resetWhatsAppPhoneScopedState,
} from "@/lib/whatsapp/credentials";
import {
  createWhatsAppSourceCredentialSnapshotSaver,
  invalidateWhatsAppSourceBindingCaches,
  ManagedWhatsAppFlowSourceRebindError,
  updateManagedWhatsAppSourceBinding,
} from "@/lib/whatsapp/flows/source-rebind-guard";
import {
  getPhoneNumberDetails,
  registerPhoneNumberWithPin,
} from "@/lib/whatsapp/qr-code-service";
import {
  getEmbeddedSignupRedirectUri,
  parseEmbeddedSignupState,
  validateRedirectUri,
} from "@/lib/whatsapp/redirect-uri";
import {
  discoverWABAs,
  getAllWABAs,
  getBusinessPortfolios,
} from "@/lib/whatsapp/waba-service";
import {
  MetaGraphRequestError,
  WHATSAPP_BUSINESS_PLATFORM_NUMBER_NOT_ELIGIBLE_ERROR_CODE,
  formatMetaGraphAPIError,
  getWhatsAppGraphClient,
  parseMetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";
import {
  buildWhatsAppCredentialAccountPatch,
  stripDeprecatedWhatsAppCredentialAliases,
} from "@icecore/shared/lib/whatsapp/account-identifiers";
import {
  buildEmbeddedSignupConnectionModePatch,
  buildWhatsAppBusinessAppConnectionPatch,
  isSmbPlatformType,
  wasWhatsAppCoexistenceConnection,
} from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import { setWhatsAppSelectionSessionCookie } from "@/lib/whatsapp/embedded-signup-selection-session";
import { NextResponse } from "next/server";

const graphClient = getWhatsAppGraphClient();
const logger = createServerLogger("whatsapp.embedded-signup");

function buildWhatsAppIntegrationsRedirectUrl(
  origin: string,
  workspaceId?: string | null
) {
  const normalizedWorkspaceId = workspaceId?.trim();
  return new URL(
    normalizedWorkspaceId
      ? `/panel/w/${encodeURIComponent(normalizedWorkspaceId)}/settings/integrations`
      : "/panel",
    origin
  );
}

function resolveTwoStepPin() {
  const envPin = process.env.WHATSAPP_DEFAULT_PIN;
  if (envPin && /^\d{6}$/.test(envPin)) {
    return envPin;
  }
  return null;
}

function readSessionAssetId(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key)?.trim();
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function readSessionText(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key)?.trim();
  return value && /^[A-Za-z0-9_:-]+$/.test(value) ? value : undefined;
}

function readSessionAssetIds(searchParams: URLSearchParams, key: string) {
  const repeatedValues = searchParams.getAll(key);
  const commaSeparatedValue = searchParams.get(`${key}s`);
  const values = [...repeatedValues];

  if (commaSeparatedValue) {
    values.push(...commaSeparatedValue.split(","));
  }

  return values
    .map(value => value.trim())
    .filter(value => value && /^[A-Za-z0-9_-]+$/.test(value));
}

export function resolveEmbeddedSignupSessionAssets(
  searchParams: URLSearchParams
) {
  const wabaId = readSessionAssetId(searchParams, "waba_id");

  return {
    wabaId,
    phoneNumberId: readSessionAssetId(searchParams, "phone_number_id"),
    csId: readSessionAssetId(searchParams, "cs_id"),
    messagingAccountId: readSessionAssetId(
      searchParams,
      "messaging_account_id"
    ),
    waacId: readSessionAssetId(searchParams, "waac_id"),
    businessId: readSessionAssetId(searchParams, "business_id"),
    wabaIds: readSessionAssetIds(searchParams, "waba_id").filter(
      id => id !== wabaId
    ),
    catalogIds: readSessionAssetIds(searchParams, "catalog_id"),
  };
}

type EmbeddedSignupSessionAssets = ReturnType<
  typeof resolveEmbeddedSignupSessionAssets
>;

function resolveEmbeddedSignupPrimaryWabaId(
  assets: EmbeddedSignupSessionAssets
) {
  return (
    assets.wabaId ??
    (assets.wabaIds.length === 1 ? assets.wabaIds[0] : undefined)
  );
}

export type EmbeddedSignupSessionAssetState =
  | "complete"
  | "waba_only"
  | "missing";

export function resolveEmbeddedSignupSessionAssetState(
  assets: EmbeddedSignupSessionAssets
): EmbeddedSignupSessionAssetState {
  const selectedWabaId = resolveEmbeddedSignupPrimaryWabaId(assets);
  if (selectedWabaId && assets.phoneNumberId) return "complete";
  if (selectedWabaId) return "waba_only";
  return "missing";
}

export type EmbeddedSignupCallbackFlow = "cloud_api" | "coexistence";

export function resolveEmbeddedSignupFlow(
  searchParams: URLSearchParams,
  stateFlow?: EmbeddedSignupCallbackFlow
): EmbeddedSignupCallbackFlow {
  const event = readSessionText(searchParams, "event");
  if (event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
    return "coexistence";
  }

  const flow = readSessionText(searchParams, "flow");
  if (flow === "coexistence" || flow === "cloud_api") {
    return flow;
  }

  if (stateFlow === "coexistence" || stateFlow === "cloud_api") {
    return stateFlow;
  }

  return "cloud_api";
}

export function shouldAttemptEmbeddedSignupPhoneRegistration({
  flow,
  isOnBizApp,
  platformType,
}: {
  flow: EmbeddedSignupCallbackFlow;
  codeVerificationStatus?: string;
  isOnBizApp?: boolean;
  platformType?: string;
}) {
  if (flow === "coexistence") return false;
  if (isOnBizApp) return false;
  if (isSmbPlatformType(platformType)) return false;
  return true;
}

export type EmbeddedSignupTokenExchangeQuery = Record<
  string,
  string | undefined
> & {
  client_id: string;
  client_secret: string;
  code: string;
  redirect_uri?: string;
};

export function buildEmbeddedSignupTokenExchangeQuery({
  appId,
  appSecret,
  code,
  redirectUri,
}: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri?: string;
}): EmbeddedSignupTokenExchangeQuery {
  return {
    client_id: appId,
    client_secret: appSecret,
    code,
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
  };
}

export function buildEmbeddedSignupTokenExchangeQueries({
  appId,
  appSecret,
  code,
  redirectUri,
  preferRedirectUri = true,
}: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri?: string;
  preferRedirectUri?: boolean;
}): EmbeddedSignupTokenExchangeQuery[] {
  const withoutRedirectUri = buildEmbeddedSignupTokenExchangeQuery({
    appId,
    appSecret,
    code,
  });

  if (!redirectUri) {
    return [withoutRedirectUri];
  }

  const withRedirectUri = buildEmbeddedSignupTokenExchangeQuery({
    appId,
    appSecret,
    code,
    redirectUri,
  });

  return preferRedirectUri
    ? [withRedirectUri, withoutRedirectUri]
    : [withoutRedirectUri, withRedirectUri];
}

function isRedirectUriMismatchExchangeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();

  if (error instanceof MetaGraphRequestError) {
    const metaMessage =
      error.metaError?.message?.toLowerCase() || normalizedMessage;
    return (
      error.metaError?.code === 100 &&
      (error.metaError.error_subcode === 36008 ||
        metaMessage.includes("redirect_uri"))
    );
  }

  return normalizedMessage.includes("redirect_uri");
}

function createEmbeddedSignupCodeExchangeError(error: unknown) {
  let errorMessage = "Failed to exchange code";

  if (error instanceof MetaGraphRequestError) {
    const metaError = error.metaError;
    errorMessage = `Token exchange failed: ${metaError?.message || error.message}`;

    if (
      metaError?.code === 100 &&
      (metaError.error_subcode === 33 ||
        metaError.error_subcode === 36008 ||
        metaError.message?.toLowerCase().includes("redirect_uri"))
    ) {
      errorMessage +=
        " The authorization code may have expired, or Meta rejected the OAuth redirect URI for this Embedded Signup session.";
    } else if (metaError?.code === 190) {
      errorMessage +=
        " Invalid or expired authorization code. Please try the signup flow again.";
    }
  }

  return new Error(errorMessage);
}

function buildSafeMetaErrorLogContext(error: unknown) {
  const context: {
    errorType: string;
    httpStatus?: number;
    metaErrorCode?: number;
    metaErrorSubcode?: number;
  } = {
    errorType: error instanceof Error ? error.name : typeof error,
  };

  if (error instanceof MetaGraphRequestError) {
    context.httpStatus = error.status;
    context.metaErrorCode = error.metaError?.code;
    context.metaErrorSubcode = error.metaError?.error_subcode;
  }

  return context;
}

/**
 * Exchanges the short-lived Embedded Signup code for a business access token
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
 *
 * Token lifetime is configured in Meta and must be read from provider metadata.
 * Tokens with no scheduled expiry can still be revoked if:
 * 1. The System User is deleted in Business Manager
 * 2. Permissions are changed
 * 3. The WABA is transferred or removed
 *
 */
async function exchangeEmbeddedSignupCode(code: string, redirectUri: string) {
  const { appId, appSecret } = getMetaServerAppConfig();

  let tokenData: {
    access_token: string;
    token_type: string;
    expires_in?: number; // May or may not be present
  };

  const requestToken = (query: EmbeddedSignupTokenExchangeQuery) =>
    graphClient.getJson<{
      access_token: string;
      token_type: string;
      expires_in?: number;
    }>("oauth/access_token", {
      token: `${appId}|${appSecret}`,
      query,
    });

  try {
    const tokenExchangeQueries = buildEmbeddedSignupTokenExchangeQueries({
      appId,
      appSecret,
      code,
      redirectUri,
    });

    const [firstQuery] = tokenExchangeQueries;
    tokenData = await requestToken(firstQuery);
  } catch (error) {
    if (isRedirectUriMismatchExchangeError(error)) {
      const fallbackQuery = buildEmbeddedSignupTokenExchangeQuery({
        appId,
        appSecret,
        code,
      });

      logger.warn(
        "embedded_signup.token_exchange.retry_without_redirect_uri",
        buildSafeMetaErrorLogContext(error)
      );

      try {
        tokenData = await requestToken(fallbackQuery);
      } catch (retryError) {
        throw createEmbeddedSignupCodeExchangeError(retryError);
      }
    } else {
      throw createEmbeddedSignupCodeExchangeError(error);
    }
  }

  if (!tokenData?.access_token) {
    throw new Error("Token exchange failed: Meta did not return access_token.");
  }

  logger.info("embedded_signup.token_exchange_succeeded", {
    tokenType: tokenData.token_type,
    hasExpiresIn: tokenData.expires_in !== undefined,
    expiresInSeconds: tokenData.expires_in,
  });

  return tokenData;
}

/**
 * Gets WABAs directly accessible by the business token (for Embedded Signup)
 * This works even without business_management permission by using debug_token to get business_id
 *
 * For Embedded Signup flow:
 * 1. Exchange code for business-scoped token (30s TTL)
 * 2. Use debug_token to get business_id from the token
 * 3. Query WABAs directly via business_id endpoint
 */
async function getWABAsDirectly(
  accessToken: string,
  appConfig: MetaServerAppConfig | null
) {
  try {
    // Method 1: Get business_id from token via debug_token
    // CRITICAL: debug_token requires an APP access token (app_id|app_secret), not the user/business token
    // Use server-side secret (not public) for security
    const debugData = await debugMetaAccessToken(accessToken, {
      appAccessToken: appConfig ? buildMetaAppAccessToken(appConfig) : null,
      allowInputTokenFallback: true,
      client: graphClient,
    }).catch(error => {
      logger.warn(
        "embedded_signup.waba_discovery.debug_token_failed",
        buildSafeMetaErrorLogContext(error)
      );
      return null;
    });

    if (!debugData) {
      return null;
    }

    const appId = appConfig?.appId || "";

    // Security validation: Ensure token belongs to our app (if appId is provided)
    if (appId && debugData.app_id && debugData.app_id !== appId) {
      logger.error(
        "embedded_signup.waba_discovery.token_app_mismatch",
        undefined,
        {
          expectedAppId: appId,
          receivedAppId: debugData.app_id,
        }
      );
      return null;
    }

    // If no app_id in token, that's suspicious - log but continue if appId not required
    if (!debugData.app_id && appId) {
      logger.warn("embedded_signup.waba_discovery.token_app_id_missing", {
        expectedAppIdPresent: true,
      });
    }

    const businessId = debugData.business_id;
    const tokenType = debugData.type || "UNKNOWN";

    // For SYSTEM_USER tokens, check granular_scopes for WABA ID
    let wabaIdFromGranularScopes: string | null = null;
    if (debugData.granular_scopes) {
      for (const granularScope of debugData.granular_scopes) {
        if (
          granularScope.scope === "whatsapp_business_management" &&
          granularScope.target_ids
        ) {
          // The first target_id in whatsapp_business_management granular scope is the WABA ID
          wabaIdFromGranularScopes = granularScope.target_ids[0] || null;
          if (wabaIdFromGranularScopes) {
            logger.info(
              "embedded_signup.waba_discovery.granular_scope_target_found",
              {
                wabaId: wabaIdFromGranularScopes,
                scope: granularScope.scope,
                targetIdCount: granularScope.target_ids.length,
              }
            );
            break;
          }
        }
      }
    }

    // If we have WABA ID from granular_scopes, query it directly
    if (wabaIdFromGranularScopes) {
      try {
        const wabaData = await graphClient.getJson<{
          id: string;
          phone_numbers?: {
            data?: Array<{
              id: string;
              display_phone_number: string;
            }>;
          };
        }>(wabaIdFromGranularScopes, {
          token: accessToken,
          query: {
            fields:
              "id,name,currency,timezone_id,message_template_namespace,account_review_status,phone_numbers{id,display_phone_number,verified_name,code_verification_status,quality_rating}",
          },
        });

        const phones = wabaData.phone_numbers?.data || [];
        if (phones.length > 0) {
          logger.info(
            "embedded_signup.waba_discovery.granular_scope_succeeded",
            {
              wabaId: wabaIdFromGranularScopes,
              phoneNumberId: phones[0].id,
            }
          );
          return {
            wabaId: wabaIdFromGranularScopes,
            phone: phones[0],
          };
        }
      } catch (wabaError) {
        logger.warn("embedded_signup.waba_discovery.granular_scope_failed", {
          wabaId: wabaIdFromGranularScopes,
          ...buildSafeMetaErrorLogContext(wabaError),
        });
      }
    }

    // If no business_id, the token might still work for direct WABA queries
    // Embedded Signup tokens can sometimes access WABAs directly
    if (!businessId && !wabaIdFromGranularScopes) {
      logger.warn("embedded_signup.waba_discovery.token_targets_missing", {
        tokenType,
        hasGranularScopes: !!debugData.granular_scopes,
      });
    }

    if (businessId) {
      logger.info("embedded_signup.waba_discovery.business_id_found", {
        businessId,
        scopeCount: debugData.scopes?.length || 0,
        tokenType,
        tokenAppValidated: !appId || debugData.app_id === appId,
      });
    } else if (!wabaIdFromGranularScopes) {
      logger.info("embedded_signup.waba_discovery.trying_fallbacks", {
        scopeCount: debugData.scopes?.length || 0,
        hasTokenAppId: !!debugData.app_id,
        hasProfileId: !!debugData.profile_id,
        tokenType,
        granularScopeCount: debugData.granular_scopes?.length || 0,
      });
    }

    // Method 2: Query WABAs directly through business_id (if we have it)
    if (businessId) {
      const endpoints = [
        "owned_whatsapp_business_accounts",
        "client_whatsapp_business_accounts",
      ];

      for (const endpoint of endpoints) {
        try {
          const wabaData = await graphClient.getJson<{
            data?: Array<{
              id: string;
              name?: string;
              phone_numbers?: {
                data?: Array<{
                  id: string;
                  display_phone_number: string;
                }>;
              };
            }>;
          }>(`${businessId}/${endpoint}`, {
            token: accessToken,
            query: {
              fields:
                "id,name,currency,timezone_id,message_template_namespace,account_review_status,phone_numbers{id,display_phone_number,verified_name,code_verification_status,quality_rating}",
            },
          });

          const wabaList = wabaData.data || [];

          if (wabaList.length > 0) {
            // Find first WABA with phone numbers
            for (const waba of wabaList) {
              const phones = waba.phone_numbers?.data || [];
              if (phones.length > 0) {
                logger.info(
                  "embedded_signup.waba_discovery.business_succeeded",
                  {
                    endpoint,
                    wabaId: waba.id,
                    phoneNumberId: phones[0].id,
                  }
                );
                return {
                  wabaId: waba.id,
                  phone: phones[0],
                };
              }
            }
          }
        } catch (endpointError) {
          logger.warn("embedded_signup.waba_discovery.business_failed", {
            endpoint,
            ...buildSafeMetaErrorLogContext(endpointError),
          });
          // Continue to next endpoint
        }
      }
    }

    // Method 3: Try querying WABAs via /me endpoint (some Embedded Signup tokens support this)
    try {
      const meData = await graphClient.getJson<{
        data?: Array<{
          id: string;
          name?: string;
          phone_numbers?: {
            data?: Array<{
              id: string;
              display_phone_number: string;
            }>;
          };
        }>;
      }>("me/owned_whatsapp_business_accounts", {
        token: accessToken,
        query: {
          fields:
            "id,name,currency,timezone_id,message_template_namespace,account_review_status,phone_numbers{id,display_phone_number,verified_name,code_verification_status,quality_rating}",
        },
      });

      const wabaList = meData.data || [];
      if (wabaList.length > 0) {
        for (const waba of wabaList) {
          const phones = waba.phone_numbers?.data || [];
          if (phones.length > 0) {
            logger.info("embedded_signup.waba_discovery.me_succeeded", {
              wabaId: waba.id,
              phoneNumberId: phones[0].id,
            });
            return {
              wabaId: waba.id,
              phone: phones[0],
            };
          }
        }
      }
    } catch (meError) {
      logger.info("embedded_signup.waba_discovery.me_failed", {
        ...buildSafeMetaErrorLogContext(meError),
      });
    }

    // Method 4: Try querying through the WABA ID if we have it from token (profile_id)
    // Some tokens might have the WABA ID directly embedded
    if (debugData.profile_id) {
      // profile_id might be the WABA ID in some cases
      const potentialWabaId = debugData.profile_id;

      try {
        // Verify if this is a WABA by querying its phone numbers
        const phoneData = await graphClient.getJson<{
          data?: Array<{
            id: string;
            display_phone_number: string;
          }>;
        }>(`${potentialWabaId}/phone_numbers`, {
          token: accessToken,
          query: { fields: "id,display_phone_number,verified_name" },
        });

        const phones = phoneData.data || [];
        if (phones.length > 0) {
          logger.info("embedded_signup.waba_discovery.profile_id_succeeded", {
            wabaId: potentialWabaId,
            phoneNumberId: phones[0].id,
          });
          return {
            wabaId: potentialWabaId,
            phone: phones[0],
          };
        }
      } catch (profileError) {
        // profile_id is not a WABA, continue
        logger.info("embedded_signup.waba_discovery.profile_id_failed", {
          wabaId: potentialWabaId,
          ...buildSafeMetaErrorLogContext(profileError),
        });
      }
    }

    return null;
  } catch (error) {
    logger.error(
      "embedded_signup.waba_discovery.failed",
      undefined,
      buildSafeMetaErrorLogContext(error)
    );
    return null;
  }
}

/**
 * Gets the WABA ID and phone number ID from the business token
 * Uses shared WABA service for consistency
 *
 * For Embedded Signup, the token might not have business_management permission,
 * so we try alternative methods to get WABA info.
 */
async function getWABAInfo(accessToken: string) {
  // Try method 1: Get business portfolios (requires business_management permission)
  try {
    const businesses = await getBusinessPortfolios(accessToken);

    if (businesses.length > 0) {
      // Get all WABAs from all businesses
      const allWABAs = [];
      for (const business of businesses) {
        const wabas = await getAllWABAs(business.id, accessToken);
        allWABAs.push(...wabas);
      }

      if (allWABAs.length > 0) {
        const selectedWaba = allWABAs[0];
        const phone = selectedWaba.phoneNumbers[0];

        if (phone) {
          return {
            wabaId: selectedWaba.waba.id,
            phoneNumberId: phone.id,
            displayPhoneNumber: phone.display_phone_number,
          };
        }
      }
    }
  } catch (error) {
    logger.warn("embedded_signup.business_portfolio_discovery_failed", {
      ...buildSafeMetaErrorLogContext(error),
    });
    // Fall through to alternative method
  }

  // Method 2: Use resilient WABA discovery
  const discovered = await discoverWABAs(accessToken);
  if (discovered.length > 0) {
    // Find first one with phone numbers
    const wabaWithPhone = discovered.find(d => d.phoneNumbers.length > 0);
    if (wabaWithPhone) {
      return {
        wabaId: wabaWithPhone.waba.id,
        phoneNumberId: wabaWithPhone.phoneNumbers[0].id,
        displayPhoneNumber: wabaWithPhone.phoneNumbers[0].display_phone_number,
      };
    }
  }

  const appConfig = tryGetMetaServerAppConfig();
  if (appConfig) {
    const direct = await getWABAsDirectly(accessToken, appConfig);
    if (direct) {
      return {
        wabaId: direct.wabaId,
        phoneNumberId: direct.phone.id,
        displayPhoneNumber: direct.phone.display_phone_number,
      };
    }
  }

  // If all methods fail, provide detailed error with troubleshooting steps
  const errorDetails = [
    "Could not retrieve WABA information. Troubleshooting steps:",
    "",
    "1. Check if WABA already exists:",
    "   GET /api/whatsapp/check-existing?workspaceId=YOUR_WORKSPACE_ID",
    "",
    "2. Verify Embedded Signup completed successfully:",
    "   - Check Facebook Business Manager → WhatsApp Accounts",
    "   - Ensure WABA was created in the signup flow",
    "   - Verify phone number is added to the WABA",
    "",
    "3. Token may have expired:",
    "   - Embedded Signup tokens last only 30 seconds",
    "   - Ensure callback happens immediately after signup",
    "   - Check network latency isn't delaying the callback",
    "",
    "4. Permissions check:",
    "   - Embedded Signup doesn't need business_management permission",
    "   - Only whatsapp_business_management is required",
    "   - Verify app has whatsapp_business_management enabled",
    "",
    "5. Try reconnecting:",
    "   - Disconnect existing connection (if any)",
    "   - Go through Embedded Signup flow again",
    "   - Complete all 3 steps in Meta's UI",
  ].join("\n");

  throw new Error(errorDetails);
}

type EmbeddedSignupWabaPhoneNumber = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
};

type EmbeddedSignupCompanyUser = {
  workspace_id: string;
};

async function resolveEmbeddedSignupCompanyUser({
  supabase,
  userId,
  stateWorkspaceId,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  stateWorkspaceId?: string | null;
}): Promise<EmbeddedSignupCompanyUser | null> {
  const normalizedStateWorkspaceId = stateWorkspaceId?.trim();

  if (normalizedStateWorkspaceId) {
    const { data, error } = await supabase
      .from("company_users")
      .select("workspace_id")
      .eq("user_id", userId)
      .eq("workspace_id", normalizedStateWorkspaceId)
      .maybeSingle();

    if (data?.workspace_id) {
      return data;
    }

    if (error) {
      logger.warn("embedded_signup.state_workspace_membership_failed", {
        userId,
        stateWorkspaceId: normalizedStateWorkspaceId,
        error,
      });
    }

    return null;
  }

  const { data, error } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn("embedded_signup.fallback_workspace_membership_failed", {
      userId,
      error,
    });
    return null;
  }

  return data?.workspace_id ? data : null;
}

async function getPhoneNumbersForSelectedWaba(
  wabaId: string,
  accessToken: string
): Promise<EmbeddedSignupWabaPhoneNumber[]> {
  const wabaData = await graphClient.getJson<{
    id: string;
    phone_numbers?: {
      data?: EmbeddedSignupWabaPhoneNumber[];
    };
  }>(wabaId, {
    token: accessToken,
    query: {
      fields:
        "id,phone_numbers{id,display_phone_number,verified_name,code_verification_status,quality_rating}",
    },
  });

  return (wabaData.phone_numbers?.data || []).filter(phone => !!phone.id);
}

function getPhoneDisplayLabel(phone: EmbeddedSignupWabaPhoneNumber) {
  return phone.display_phone_number || phone.verified_name || phone.id;
}

function redirectToWhatsAppSelection(
  redirectUrl: URL,
  session: {
    accessToken: string;
    workspaceId: string;
    userId: string;
    tokenExpiresAt?: Date | null;
  }
) {
  const response = NextResponse.redirect(redirectUrl);
  if (!setWhatsAppSelectionSessionCookie(response, session)) {
    logger.warn("embedded_signup.selection_session_not_set", {
      workspaceId: session.workspaceId,
    });
  }
  return response;
}

function appendEmbeddedSignupSelectionParams(
  redirectUrl: URL,
  params: {
    businessId?: string;
    catalogIds?: string[];
    csId?: string;
    event?: string;
    expiresAt?: Date;
    flow: EmbeddedSignupCallbackFlow;
    intent?: "upgrade";
    messagingAccountId?: string;
    waacId?: string;
  }
) {
  redirectUrl.searchParams.set("flow", params.flow);

  // The number picker saves the connection itself, so it needs the same
  // upgrade intent the direct path reads from the callback URL.
  if (params.intent) {
    redirectUrl.searchParams.set("intent", params.intent);
  }

  if (params.expiresAt) {
    redirectUrl.searchParams.set(
      "expires_in",
      Math.max(
        0,
        Math.floor((params.expiresAt.getTime() - Date.now()) / 1000)
      ).toString()
    );
  }

  if (params.event) {
    redirectUrl.searchParams.set("event", params.event);
  }

  if (params.businessId) {
    redirectUrl.searchParams.set("business_id", params.businessId);
  }

  if (params.csId) {
    redirectUrl.searchParams.set("cs_id", params.csId);
  }

  if (params.messagingAccountId) {
    redirectUrl.searchParams.set(
      "messaging_account_id",
      params.messagingAccountId
    );
  }

  if (params.waacId) {
    redirectUrl.searchParams.set("waac_id", params.waacId);
  }

  if (params.catalogIds && params.catalogIds.length > 0) {
    redirectUrl.searchParams.set("catalog_ids", params.catalogIds.join(","));
  }
}

const EMBEDDED_SIGNUP_WORKSPACE_PATH = /^\/panel\/w\/([^/]+)\//;

/**
 * Summarizes a callback redirect for logs. Reads only the path and outcome
 * params: the login and selection redirects carry the code or business token.
 */
export function describeEmbeddedSignupCallbackOutcome(
  response: Response
): ServerLogContext & { outcome: string } {
  const location = response.headers.get("location");
  let url: URL | null = null;
  try {
    url = location ? new URL(location) : null;
  } catch {
    url = null;
  }

  if (!url) {
    return { outcome: "no_redirect", status: response.status };
  }

  const base = {
    status: response.status,
    workspaceId: url.pathname.match(EMBEDDED_SIGNUP_WORKSPACE_PATH)?.[1],
  };

  if (url.pathname === "/login") {
    return { ...base, outcome: "login_required" };
  }

  if (url.pathname.endsWith("/settings/integrations/whatsapp/select")) {
    return { ...base, outcome: "selection_required" };
  }

  const error = url.searchParams.get("error");
  if (error) {
    return {
      ...base,
      outcome: "failed",
      error: error.slice(0, 120),
      errorDetails: url.searchParams.get("error_details")?.slice(0, 300),
      requiresReconnect: url.searchParams.get("requires_reconnect") === "true",
    };
  }

  if (url.searchParams.get("new") === "true") {
    return {
      ...base,
      outcome: "connected",
      upgraded: url.searchParams.get("upgraded") ?? undefined,
    };
  }

  return { ...base, outcome: "redirected", path: url.pathname };
}

/**
 * Handles the Embedded Signup callback. Every attempt ends in one
 * `embedded_signup.callback_completed` line, so failures that stop before the
 * source is saved stay findable in logs.
 */
export async function handleEmbeddedSignupCallback(request: Request) {
  flushServerLogsAfterResponse();

  const response = await runEmbeddedSignupCallback(request).catch(error => {
    logger.error(
      "embedded_signup.callback_crashed",
      error,
      buildSafeMetaErrorLogContext(error)
    );
    throw error;
  });

  const outcome = describeEmbeddedSignupCallbackOutcome(response);
  if (outcome.outcome === "failed") {
    logger.warn("embedded_signup.callback_completed", outcome);
  } else {
    logger.info("embedded_signup.callback_completed", outcome);
  }

  return response;
}

async function runEmbeddedSignupCallback(request: Request) {
  const { origin, searchParams } = new URL(request.url);
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  logger.info("embedded_signup.callback_received", {
    origin,
    queryKeys: [...new Set(searchParams.keys())].sort(),
    hasAuthenticatedUser: Boolean(user),
  });

  // Get workspace ID from state parameter (fallback if session is lost)
  const callbackState = parseEmbeddedSignupState(searchParams.get("state"));
  const stateWorkspaceId = callbackState.workspaceId;
  const code = searchParams.get("code");
  const isUpgradeIntent = searchParams.get("intent") === "upgrade";
  const sessionAssets = resolveEmbeddedSignupSessionAssets(searchParams);
  const sessionAssetState =
    resolveEmbeddedSignupSessionAssetState(sessionAssets);
  const embeddedSignupFlow = resolveEmbeddedSignupFlow(
    searchParams,
    callbackState.flow
  );
  const embeddedSignupEvent = readSessionText(searchParams, "event");

  let companyUser: EmbeddedSignupCompanyUser | null = null;
  if (user) {
    companyUser = await resolveEmbeddedSignupCompanyUser({
      supabase,
      userId: user.id,
      stateWorkspaceId,
    });
  }

  // If no code, redirect to error page
  if (!code) {
    const errorRedirectUrl = buildWhatsAppIntegrationsRedirectUrl(
      origin,
      stateWorkspaceId || companyUser?.workspace_id
    );
    errorRedirectUrl.searchParams.set("type", "whatsapp");
    errorRedirectUrl.searchParams.set("error", "missing_code");
    return NextResponse.redirect(errorRedirectUrl);
  }

  // If no user session, redirect to login with return URL
  if (!user) {
    logger.warn("embedded_signup.user_session_missing", {
      stateWorkspaceId,
      hasCode: !!code,
    });

    // Store the callback URL temporarily and redirect to login
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set(
      "redirect",
      `/api/sources/whatsapp/callback?${searchParams.toString()}`
    );
    loginUrl.searchParams.set(
      "message",
      "Please sign in to complete WhatsApp setup"
    );
    return NextResponse.redirect(loginUrl);
  }

  if (!companyUser) {
    const errorRedirectUrl = buildWhatsAppIntegrationsRedirectUrl(
      origin,
      stateWorkspaceId
    );
    errorRedirectUrl.searchParams.set("type", "whatsapp");
    errorRedirectUrl.searchParams.set(
      "error",
      "User not associated with a workspace"
    );
    return NextResponse.redirect(errorRedirectUrl);
  }

  // If state provides workspace ID, verify it matches user's workspace
  if (stateWorkspaceId && stateWorkspaceId !== companyUser.workspace_id) {
    logger.warn("embedded_signup.workspace_mismatch", {
      stateWorkspaceId,
      userWorkspaceId: companyUser.workspace_id,
    });
    // Still proceed with user's actual workspace, but log the mismatch
  }

  const companyId = await getCompanyIdForWorkspace(
    supabase,
    companyUser.workspace_id
  );
  if (!companyId) {
    const errorRedirectUrl = new URL(
      `/panel/w/${companyUser.workspace_id}/settings/integrations`,
      origin
    );
    errorRedirectUrl.searchParams.set("type", "whatsapp");
    errorRedirectUrl.searchParams.set("error", "company_not_found");
    return NextResponse.redirect(errorRedirectUrl);
  }

  // Build the exact redirect_uri that was used in the OAuth request
  // This MUST match exactly, including query parameters
  const redirectUri = getEmbeddedSignupRedirectUri(origin);
  logger.info("embedded_signup.token_exchange_started", { origin });

  // Validate redirect_uri format (for debugging)
  const validation = validateRedirectUri(redirectUri, origin);
  if (!validation.valid) {
    logger.warn("embedded_signup.redirect_uri_invalid", {
      error: validation.error,
    });
  }

  try {
    // Exchange code for business token (30s TTL - must be fast!)
    // Add timeout to handle slow network
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Token exchange timeout (30s)")), 28000)
    );

    const tokenResponse = await Promise.race([
      exchangeEmbeddedSignupCode(code, redirectUri),
      timeoutPromise,
    ]).catch(error => {
      logger.error("embedded_signup.token_exchange_failed", error, {
        ...buildSafeMetaErrorLogContext(error),
      });
      throw new Error(
        "Failed to exchange signup code - this may be due to slow network or expired code. Please try again."
      );
    });

    const { access_token: businessToken } = tokenResponse;

    // Check if WhatsApp source already exists for this workspace
    // This handles cases where connection was partially completed before
    const { data: existingSource } = await supabase
      .from("sources")
      .select("id, credentials, name")
      .eq("workspace_id", companyUser.workspace_id)
      .eq("type", "whatsapp")
      .maybeSingle();

    if (existingSource?.credentials) {
      const existingCredentials = existingSource.credentials as {
        waba_id?: string;
        phone_number_id?: string;
      };

      // If we have an existing WABA ID, try to use it first before querying
      // This helps when the callback fails but the WABA was already created
      if (existingCredentials.waba_id) {
        logger.info("embedded_signup.existing_source_found", {
          workspaceId: companyUser.workspace_id,
          hasWabaId: true,
          hasPhoneNumberId: Boolean(existingCredentials.phone_number_id),
        });
      }
    }

    // Validate the exchanged token before using session assets or changing
    // provider/source state. A debugger failure cannot confirm token validity.
    const debugAppConfig = getMetaServerAppConfig();
    const debugInfo = await debugMetaAccessToken(businessToken, {
      appAccessToken: buildMetaAppAccessToken(debugAppConfig),
      client: graphClient,
    });
    const tokenLifecycle = evaluateMetaAccessToken(debugInfo, {
      appId: debugAppConfig.appId,
      expiresIn: tokenResponse.expires_in,
    });
    if (!tokenLifecycle.valid) {
      const errorRedirectUrl = buildWhatsAppIntegrationsRedirectUrl(
        origin,
        companyUser.workspace_id
      );
      errorRedirectUrl.searchParams.set("type", "whatsapp");
      errorRedirectUrl.searchParams.set(
        "error",
        tokenLifecycle.expired ? "token_expired" : "token_invalid"
      );
      errorRedirectUrl.searchParams.set(
        "error_details",
        tokenLifecycle.error || "Meta could not validate the access token."
      );
      errorRedirectUrl.searchParams.set(
        "guidance",
        "Reconnect WhatsApp through Embedded Signup to obtain a valid access token."
      );
      errorRedirectUrl.searchParams.set("requires_reconnect", "true");
      return NextResponse.redirect(errorRedirectUrl);
    }
    const businessIdForCreds =
      sessionAssets.businessId || debugInfo.business_id;
    const tokenMetadataPatch = buildWhatsAppTokenMetadataPatch(debugInfo, {
      appId: debugAppConfig.appId,
      expiresIn: tokenResponse.expires_in,
    });
    logger.info("embedded_signup.token_debug_completed", {
      hasBusinessId: Boolean(businessIdForCreds),
      hasSessionBusinessId: Boolean(sessionAssets.businessId),
    });

    // Get WABA and phone number info
    let wabaId: string;
    let phoneNumberId: string;
    let displayPhoneNumber: string;
    let allWABAs: Awaited<ReturnType<typeof getAllWABAs>> = [];
    let resolvedFromSessionSelection = false;
    const sessionSelectedWabaId =
      resolveEmbeddedSignupPrimaryWabaId(sessionAssets);

    try {
      if (
        sessionAssetState === "complete" &&
        sessionSelectedWabaId &&
        sessionAssets.phoneNumberId
      ) {
        // The session ids arrive through the browser. Prove the exchanged
        // token reaches this WABA and the number is on it before saving, or
        // any signup could claim another tenant's number for routing.
        const selectedWabaPhones = await getPhoneNumbersForSelectedWaba(
          sessionSelectedWabaId,
          businessToken
        );
        const selectedPhone = selectedWabaPhones.find(
          phone => phone.id === sessionAssets.phoneNumberId
        );
        if (!selectedPhone) {
          throw new Error(
            `Embedded Signup returned a phone number that is not on WABA ${sessionSelectedWabaId}.`
          );
        }
        wabaId = sessionSelectedWabaId;
        phoneNumberId = selectedPhone.id;
        displayPhoneNumber = getPhoneDisplayLabel(selectedPhone);
        resolvedFromSessionSelection = true;

        logger.info("embedded_signup.session_assets_selected", {
          workspaceId: companyUser.workspace_id,
          hasBusinessId: Boolean(sessionAssets.businessId),
        });
      } else if (sessionAssetState === "waba_only" && sessionSelectedWabaId) {
        const selectedWabaPhones = await getPhoneNumbersForSelectedWaba(
          sessionSelectedWabaId,
          businessToken
        );

        if (selectedWabaPhones.length === 1) {
          const selectedPhone = selectedWabaPhones[0];
          wabaId = sessionSelectedWabaId;
          phoneNumberId = selectedPhone.id;
          displayPhoneNumber = getPhoneDisplayLabel(selectedPhone);
          resolvedFromSessionSelection = true;

          logger.info("embedded_signup.session_phone_resolved", {
            workspaceId: companyUser.workspace_id,
            hasBusinessId: Boolean(sessionAssets.businessId),
          });
        } else if (selectedWabaPhones.length > 1) {
          const redirectUrl = new URL(
            `/panel/w/${companyUser.workspace_id}/settings/integrations/whatsapp/select`,
            origin
          );
          redirectUrl.searchParams.set("embedded", "true");
          redirectUrl.searchParams.set("source", "embedded_signup");
          redirectUrl.searchParams.set(
            "selected_waba_id",
            sessionSelectedWabaId
          );
          appendEmbeddedSignupSelectionParams(redirectUrl, {
            businessId: businessIdForCreds,
            catalogIds: sessionAssets.catalogIds,
            csId: sessionAssets.csId,
            event: embeddedSignupEvent,
            expiresAt: tokenLifecycle.expiresAt,
            flow: embeddedSignupFlow,
            intent: isUpgradeIntent ? "upgrade" : undefined,
            messagingAccountId: sessionAssets.messagingAccountId,
            waacId: sessionAssets.waacId,
          });

          logger.info("embedded_signup.phone_selection_required", {
            workspaceId: companyUser.workspace_id,
            phoneCount: selectedWabaPhones.length,
          });

          return redirectToWhatsAppSelection(redirectUrl, {
            accessToken: businessToken,
            workspaceId: companyUser.workspace_id,
            userId: user.id,
            tokenExpiresAt: tokenLifecycle.expiresAt,
          });
        } else {
          throw new Error(
            `Embedded Signup returned WABA ${sessionSelectedWabaId}, but no phone numbers were found on it.`
          );
        }
      } else {
        const wabaInfo = await getWABAInfo(businessToken);
        wabaId = wabaInfo.wabaId;
        phoneNumberId = wabaInfo.phoneNumberId;
        displayPhoneNumber = wabaInfo.displayPhoneNumber;
      }

      // Check if there are multiple options - if so, redirect to selection page.
      // If Meta returned explicit session asset IDs, they are the customer's
      // selected assets, so discovery is unnecessary and can be stale for
      // freshly-created Meta-provided 555 numbers.
      if (!resolvedFromSessionSelection) {
        try {
          const discovered = await discoverWABAs(businessToken);
          allWABAs = discovered;

          // Filter to WABAs that actually have phone numbers registered
          const wabasWithPhones = allWABAs.filter(
            w => Array.isArray(w.phoneNumbers) && w.phoneNumbers.length > 0
          );

          // Check for multiple WABAs OR multiple phones in the first WABA
          const hasMultipleWABAs = wabasWithPhones.length > 1;
          const hasMultiplePhonesInRange =
            wabasWithPhones.length > 0 &&
            wabasWithPhones[0].phoneNumbers.length > 1;

          if (hasMultipleWABAs || hasMultiplePhonesInRange) {
            // Multiple choices - redirect to selection page
            const redirectUrl = new URL(
              `/panel/w/${companyUser.workspace_id}/settings/integrations/whatsapp/select`,
              origin
            );
            redirectUrl.searchParams.set("embedded", "true");
            redirectUrl.searchParams.set("source", "embedded_signup");
            appendEmbeddedSignupSelectionParams(redirectUrl, {
              businessId: businessIdForCreds,
              catalogIds: sessionAssets.catalogIds,
              csId: sessionAssets.csId,
              event: embeddedSignupEvent,
              expiresAt: tokenLifecycle.expiresAt,
              flow: embeddedSignupFlow,
              intent: isUpgradeIntent ? "upgrade" : undefined,
              messagingAccountId: sessionAssets.messagingAccountId,
              waacId: sessionAssets.waacId,
            });

            logger.info("embedded_signup.asset_selection_required", {
              workspaceId: companyUser.workspace_id,
              wabaCount: wabasWithPhones.length,
              firstWabaPhoneCount:
                wabasWithPhones[0]?.phoneNumbers?.length || 0,
            });

            return redirectToWhatsAppSelection(redirectUrl, {
              accessToken: businessToken,
              workspaceId: companyUser.workspace_id,
              userId: user.id,
              tokenExpiresAt: tokenLifecycle.expiresAt,
            });
          }
        } catch (multiWabaError) {
          logger.warn("embedded_signup.multiple_waba_check_failed", {
            ...buildSafeMetaErrorLogContext(multiWabaError),
          });
          // Continue with single WABA flow
        }
      }
    } catch (wabaError) {
      logger.error("embedded_signup.waba_resolution_failed", wabaError, {
        workspaceId: companyUser.workspace_id,
        ...buildSafeMetaErrorLogContext(wabaError),
      });

      // Before failing, check if connection already exists - might be a reconnection
      const { data: existingSource } = await supabase
        .from("sources")
        .select("id, credentials, name")
        .eq("workspace_id", companyUser.workspace_id)
        .eq("type", "whatsapp")
        .maybeSingle();

      if (existingSource?.credentials) {
        const existingCreds = existingSource.credentials as {
          waba_id?: string;
          phone_number_id?: string;
        };

        if (existingCreds.waba_id && existingCreds.phone_number_id) {
          logger.warn("embedded_signup.existing_connection_unverified", {
            workspaceId: companyUser.workspace_id,
            hasExistingWabaId: true,
            hasExistingPhoneNumberId: true,
            ...buildSafeMetaErrorLogContext(wabaError),
          });

          // Don't fail completely - redirect with info that connection might already exist
          const redirectUrl = new URL(
            `/panel/w/${companyUser.workspace_id}/settings/integrations`,
            origin
          );
          redirectUrl.searchParams.set("type", "whatsapp");
          redirectUrl.searchParams.set("error", "connection_check_needed");
          redirectUrl.searchParams.set(
            "error_details",
            "Could not verify new token, but existing connection found. " +
              "Check /api/whatsapp/check-existing to verify current connection status."
          );
          return NextResponse.redirect(redirectUrl);
        }
      }

      // If no existing connection, throw the error
      throw wabaError;
    }

    // Read phone details before webhook subscription so coexistence-specific
    // webhook fields are included in the subscription coverage check.
    const phoneRegistration: Partial<WhatsAppCredentials> = {
      phone_registered: false,
      phone_registration_error: null,
    };
    let shouldAttemptPhoneRegistration =
      shouldAttemptEmbeddedSignupPhoneRegistration({
        flow: embeddedSignupFlow,
      });

    try {
      const details = await getPhoneNumberDetails(phoneNumberId, businessToken);
      displayPhoneNumber =
        details.display_phone_number ||
        details.verified_name ||
        displayPhoneNumber;
      const phoneDetailsCheckedAt = new Date().toISOString();
      Object.assign(
        phoneRegistration,
        buildWhatsAppPhoneDetailsCredentialPatch(details)
      );

      shouldAttemptPhoneRegistration =
        shouldAttemptEmbeddedSignupPhoneRegistration({
          flow: embeddedSignupFlow,
          codeVerificationStatus: details.code_verification_status,
          isOnBizApp: details.is_on_biz_app,
          platformType: details.platform_type,
        });
      Object.assign(
        phoneRegistration,
        buildWhatsAppBusinessAppConnectionPatch({
          embeddedSignupFlow,
          isOnBizApp: details.is_on_biz_app,
          platformType: details.platform_type,
          now: phoneDetailsCheckedAt,
        })
      );

      if (isWhatsAppPhoneNumberRegistered(details)) {
        phoneRegistration.phone_registered = true;
        phoneRegistration.phone_registered_at = phoneDetailsCheckedAt;
      }
    } catch (error) {
      logger.warn("embedded_signup.phone_status_fetch_failed", {
        workspaceId: companyUser.workspace_id,
        ...buildSafeMetaErrorLogContext(error),
      });
    }

    logger.info("embedded_signup.customer_assets_resolved", {
      workspaceId: companyUser.workspace_id,
      hasWabaId: Boolean(wabaId),
      hasPhoneNumberId: Boolean(phoneNumberId),
      hasDisplayPhoneNumber: Boolean(displayPhoneNumber),
    });

    if (!shouldAttemptPhoneRegistration) {
      phoneRegistration.coexistence_mode = true;
      phoneRegistration.partner_app_installed = true;
      phoneRegistration.partner_app_installed_at ||= new Date().toISOString();

      if (!phoneRegistration.phone_registered) {
        phoneRegistration.phone_registration_error =
          "Phone registration is managed by Meta for WhatsApp Business app coexistence accounts.";
      }
    }

    // Step 3: Register the customer's phone number (behind the scenes)
    // This ensures the number is ready for Cloud API usage.
    if (!phoneRegistration.phone_registered && shouldAttemptPhoneRegistration) {
      const pin = resolveTwoStepPin();

      if (!pin) {
        phoneRegistration.phone_registration_error =
          "PIN not configured. Manual registration required.";
      } else {
        try {
          await registerPhoneNumberWithPin({
            phoneNumberId,
            pin,
            accessToken: businessToken,
          });

          phoneRegistration.phone_registered = true;
          phoneRegistration.phone_registered_at = new Date().toISOString();
          phoneRegistration.phone_registration_status = "REGISTERED";
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const normalized = errorMessage.toLowerCase();
          const alreadyRegistered =
            normalized.includes("already") && normalized.includes("register");

          if (alreadyRegistered) {
            phoneRegistration.phone_registered = true;
            phoneRegistration.phone_registered_at = new Date().toISOString();
            phoneRegistration.phone_registration_status = "REGISTERED";
          } else {
            phoneRegistration.phone_registration_error = errorMessage;
            logger.warn("embedded_signup.phone_registration_failed", {
              workspaceId: companyUser.workspace_id,
              error: errorMessage,
            });
          }
        }
      }
    }

    // Encrypt and store the business token
    const encryptedToken = encryptString(businessToken);

    logger.info("embedded_signup.token_expiry_recorded", {
      workspaceId: companyUser.workspace_id,
      providerExpiryProvided: Boolean(tokenLifecycle.expiresAt),
      neverExpires: tokenLifecycle.neverExpires,
      expiresInDays: tokenLifecycle.daysUntilExpiry,
    });

    // Check if source already exists (reconnection scenario)
    const { data: existing } = await supabase
      .from("sources")
      .select("id, credentials")
      .eq("workspace_id", companyUser.workspace_id)
      .eq("type", "whatsapp")
      .maybeSingle();

    const existingCredentials =
      existing?.credentials && typeof existing.credentials === "object"
        ? (existing.credentials as Record<string, unknown>)
        : {};
    const existingOwner = await findWhatsAppPhoneOwner({
      companyId,
      phoneNumberId,
      currentWorkspaceId: companyUser.workspace_id,
      currentSourceId: existing?.id,
    });
    if (existingOwner) {
      const redirectUrl = buildWhatsAppIntegrationsRedirectUrl(
        origin,
        companyUser.workspace_id
      );
      redirectUrl.searchParams.set("type", "whatsapp");
      redirectUrl.searchParams.set("error", "phone_already_connected");
      redirectUrl.searchParams.set("workspace_id", existingOwner.workspaceId);
      if (existingOwner.workspaceName) {
        redirectUrl.searchParams.set(
          "workspace_name",
          existingOwner.workspaceName
        );
      }
      return NextResponse.redirect(redirectUrl);
    }

    const wasCoexistence =
      wasWhatsAppCoexistenceConnection(existingCredentials);
    const connectionModePatch = buildEmbeddedSignupConnectionModePatch({
      previousCredentials: existingCredentials,
      leavesCoexistence:
        embeddedSignupFlow === "cloud_api" && shouldAttemptPhoneRegistration,
      upgradeIntent: isUpgradeIntent,
    });

    const credentialPatch = {
      ...buildWhatsAppCredentialAccountPatch({
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        cs_id: sessionAssets.csId,
        messaging_account_id: sessionAssets.messagingAccountId || wabaId,
        waac_id: sessionAssets.waacId,
        business_id: businessIdForCreds,
      }),
      ...buildWhatsAppReconnectedCredentialPatch(),
      access_token: encryptedToken,
      ...tokenMetadataPatch,
      embedded_signup: true,
      embedded_signup_flow: embeddedSignupFlow,
      whatsapp_calls_media_enabled:
        embeddedSignupFlow === "cloud_api" &&
        shouldAttemptPhoneRegistration &&
        phoneRegistration.coexistence_mode !== true,
      ...(embeddedSignupEvent && {
        embedded_signup_event: embeddedSignupEvent,
      }),
      ...(businessIdForCreds && { business_id: businessIdForCreds }),
      ...(embeddedSignupFlow === "cloud_api" ||
      sessionAssets.catalogIds.length > 0
        ? {
            catalog_ids: sessionAssets.catalogIds,
          }
        : {}),
      ...phoneRegistration,
      ...connectionModePatch,
    };
    const historySession = {
      sessionId: randomUUID(),
      startedAt: new Date().toISOString(),
      embeddedSignupCompleted:
        embeddedSignupEvent === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    };
    let credentialsToSave: Record<string, unknown> =
      prepareWhatsAppHistorySyncSession({
        ...historySession,
        current: existingCredentials,
        next: {
          ...resetWhatsAppPhoneScopedState(existingCredentials, phoneNumberId),
          ...credentialPatch,
        },
      });
    stripDeprecatedWhatsAppCredentialAliases(
      credentialsToSave as Record<string, unknown>
    );

    logger.info("embedded_signup.source_persist_started", {
      workspaceId: companyUser.workspace_id,
      hasExistingSource: Boolean(existing?.id),
    });

    let persistError: unknown = null;
    let persistedSourceId: string | null = existing?.id || null;
    if (existing?.id) {
      try {
        const updated = await updateManagedWhatsAppSourceBinding({
          workspaceId: companyUser.workspace_id,
          sourceId: existing.id,
          currentWabaId: String(
            normalizeWhatsAppCredentials(existingCredentials).wabaId || ""
          ),
          nextWabaId: wabaId,
          semanticOperationId: `embedded-signup:${wabaId}:${phoneNumberId}`,
          sourcePatch: { name: `WhatsApp (${displayPhoneNumber})` },
          buildCredentials: currentCredentials => {
            const nextCredentials = {
              ...resetWhatsAppPhoneScopedState(
                currentCredentials,
                phoneNumberId
              ),
              ...credentialPatch,
            };
            stripDeprecatedWhatsAppCredentialAliases(nextCredentials);
            return prepareWhatsAppHistorySyncSession({
              ...historySession,
              current: currentCredentials,
              next: nextCredentials,
            });
          },
        });
        credentialsToSave = updated.credentials;
      } catch (error) {
        if (error instanceof ManagedWhatsAppFlowSourceRebindError) {
          const redirectUrl = buildWhatsAppIntegrationsRedirectUrl(
            origin,
            companyUser.workspace_id
          );
          redirectUrl.searchParams.set("type", "whatsapp");
          redirectUrl.searchParams.set("error", error.code.toLowerCase());
          return NextResponse.redirect(redirectUrl);
        }
        throw error;
      }
    } else {
      const channelCapacity = await ensureCompanyChannelCapacity(
        supabaseAdmin,
        companyUser.workspace_id,
        "whatsapp"
      );
      if (!channelCapacity.allowed) {
        const redirectUrl = buildWhatsAppIntegrationsRedirectUrl(
          origin,
          companyUser.workspace_id
        );
        redirectUrl.searchParams.set("type", "whatsapp");
        redirectUrl.searchParams.set(
          "error",
          COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE
        );
        return NextResponse.redirect(redirectUrl);
      }

      // Create new source. Clients may not write WhatsApp rows directly; the
      // workspace and company come from the membership verified above.
      const { data, error } = await supabaseAdmin
        .from("sources")
        .insert({
          company_id: companyId,
          workspace_id: companyUser.workspace_id,
          type: "whatsapp",
          name: `WhatsApp (${displayPhoneNumber})`,
          credentials: credentialsToSave,
        })
        .select("id")
        .single();
      persistError = error;
      persistedSourceId = data?.id || null;
    }

    if (persistError) {
      // PostgREST returns a plain object; its `details` can echo the failing
      // row, credentials included, so log only the code and message.
      const dbError = persistError as { code?: unknown; message?: unknown };
      logger.error("embedded_signup.source_persist_failed", undefined, {
        workspaceId: companyUser.workspace_id,
        dbErrorCode:
          typeof dbError.code === "string" ? dbError.code : undefined,
        dbErrorMessage:
          typeof dbError.message === "string"
            ? dbError.message.slice(0, 300)
            : undefined,
      });
      const redirectUrl = new URL(
        `/panel/w/${companyUser.workspace_id}/settings/integrations`,
        origin
      );
      redirectUrl.searchParams.set("type", "whatsapp");
      redirectUrl.searchParams.set("error", "whatsapp_save_failed");
      return NextResponse.redirect(redirectUrl);
    }

    if (persistedSourceId) {
      if (!existing?.id) {
        invalidateWhatsAppSourceBindingCaches({
          workspaceId: companyUser.workspace_id,
          sourceId: persistedSourceId,
        });
      }
      await upsertWhatsAppAccountsForSource({
        sourceId: persistedSourceId,
        workspaceId: companyUser.workspace_id,
        companyId,
        credentials: credentialsToSave,
        isDefault: true,
      });
      await recordWhatsAppOnboardingEvent({
        eventType: "embedded_signup_source_persisted",
        eventSource: "embedded_signup_callback",
        workspaceId: companyUser.workspace_id,
        companyId,
        sourceId: persistedSourceId,
        accountIdentifiers: credentialsToSave,
        payload: {
          flow: embeddedSignupFlow,
          event: embeddedSignupEvent || null,
          upgradeIntent: isUpgradeIntent,
          hasExistingSource: Boolean(existing?.id),
        },
      });
      await captureFunnelEvent({
        event: "whatsapp_connected",
        userId: user.id,
        workspaceId: companyUser.workspace_id,
        companyId,
        properties: {
          path: "embedded_signup",
          flow: embeddedSignupFlow || null,
          reconnect: Boolean(existing?.id),
          upgrade: isUpgradeIntent,
        },
      });
      const savePostConnectCredentials =
        createWhatsAppSourceCredentialSnapshotSaver({
          workspaceId: companyUser.workspace_id,
          sourceId: persistedSourceId,
          expectedPhoneNumberId: phoneNumberId,
          currentCredentials: credentialsToSave,
        });
      const postConnect = await runWhatsAppPostConnectSetup({
        sourceId: persistedSourceId,
        workspaceId: companyUser.workspace_id,
        credentials: credentialsToSave,
        trigger: "embedded_signup_connect",
        saveCredentials: async nextCredentials => {
          const updated = await savePostConnectCredentials(nextCredentials);

          await upsertWhatsAppAccountsForSource({
            sourceId: persistedSourceId,
            workspaceId: companyUser.workspace_id,
            companyId,
            credentials: updated.credentials,
            isDefault: true,
          });
        },
      });
      for (const { step, ...failure } of postConnect.failures) {
        logger.warn(`embedded_signup.${step}_failed`, {
          workspaceId: companyUser.workspace_id,
          sourceId: persistedSourceId,
          ...failure,
        });
      }
    }

    // Success! Redirect to integrations page
    const successRedirectUrl = new URL(
      `/panel/w/${companyUser.workspace_id}/settings/integrations`,
      origin
    );
    successRedirectUrl.searchParams.set("type", "whatsapp");
    successRedirectUrl.searchParams.set("new", "true");
    successRedirectUrl.searchParams.set("embedded_signup", "true");
    if (isUpgradeIntent && wasCoexistence) {
      successRedirectUrl.searchParams.set("upgraded", "cloud_api");
    }
    return NextResponse.redirect(successRedirectUrl);
  } catch (error) {
    logger.error("embedded_signup.callback_failed", error, {
      workspaceId: companyUser?.workspace_id || stateWorkspaceId,
      ...buildSafeMetaErrorLogContext(error),
    });

    // Parse error to provide tech provider-specific guidance
    let errorMessage = "An unknown error occurred.";
    let errorType = "embedded_signup_failed";
    let actionableGuidance: string | null = null;
    let requiresReconnect = false;

    // Check if it's a Meta Graph API error
    const errorText = error instanceof Error ? error.message : String(error);
    const metaError = parseMetaGraphAPIError(errorText);

    if (metaError) {
      const formatted = formatMetaGraphAPIError(metaError);
      errorMessage = formatted.message;
      actionableGuidance = formatted.actionable;
      requiresReconnect = formatted.requiresReconnect;

      // Map specific error codes to error types
      if (
        metaError.code ===
        WHATSAPP_BUSINESS_PLATFORM_NUMBER_NOT_ELIGIBLE_ERROR_CODE
      ) {
        errorType = "whatsapp_number_not_eligible";
      } else if (metaError.code === 190) {
        errorType = "token_invalid";
      } else if (metaError.code === 200) {
        errorType = "permissions_error";
      } else if (metaError.code === 100 && metaError.error_subcode === 33) {
        errorType = "waba_not_found";
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;

      // Check for specific error patterns
      if (
        error.message.includes("Access Verification") ||
        error.message.includes("access verification")
      ) {
        errorType = "access_verification_incomplete";
        actionableGuidance =
          "Complete Access Verification in Meta App Dashboard → App Review → Access Verification. " +
          "This is required for tech providers to use Embedded Signup.";
      } else if (
        error.message.includes("business_verification") ||
        error.message.includes("Business verification")
      ) {
        errorType = "business_verification_required";
        actionableGuidance =
          "Business verification is required for WhatsApp Business API. " +
          "Complete business verification in Facebook Business Manager.";
      } else if (
        error.message.includes("expired") ||
        error.message.includes("expiry")
      ) {
        errorType = "token_expired";
        requiresReconnect = true;
        actionableGuidance =
          "The signup code expired (30 second TTL). Please try the Embedded Signup flow again.";
      } else if (
        error.message.includes("WABA") &&
        error.message.includes("not found")
      ) {
        errorType = "waba_not_found";
        actionableGuidance =
          "WhatsApp Business Account was not found. " +
          "Ensure the Embedded Signup flow completed successfully and the WABA was created.";
      } else if (error.message.includes("revoked")) {
        errorType = "token_revoked";
        requiresReconnect = true;
        actionableGuidance =
          "The access token was revoked. This can happen if permissions were removed in Business Manager. " +
          "Please reconnect WhatsApp integration.";
      }
    }

    const errorRedirectUrl = new URL(
      `/panel/w/${companyUser.workspace_id}/settings/integrations`,
      origin
    );
    errorRedirectUrl.searchParams.set("type", "whatsapp");
    errorRedirectUrl.searchParams.set("error", errorType);
    errorRedirectUrl.searchParams.set("error_details", errorMessage);

    if (actionableGuidance) {
      errorRedirectUrl.searchParams.set("guidance", actionableGuidance);
    }

    if (requiresReconnect) {
      errorRedirectUrl.searchParams.set("requires_reconnect", "true");
    }

    return NextResponse.redirect(errorRedirectUrl);
  }
}
