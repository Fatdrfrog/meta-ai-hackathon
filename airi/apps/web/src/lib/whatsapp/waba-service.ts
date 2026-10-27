/**
 * Shared WhatsApp Business Account (WABA) service
 * Handles WABA operations for multi-tenant SaaS integration
 */

import { createServerLogger } from "@/lib/observability/server-logs";
import {
  buildMetaAppAccessToken,
  getMetaServerAppConfig,
  tryGetMetaServerAppConfig,
  type MetaServerAppConfig,
} from "@/lib/meta/app-config";
import {
  attributeMetaCredentialOwner,
  getMetaCredentialOwner,
  type MetaCredentialOwner,
} from "@/lib/meta/credential-owner";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import {
  analyzeSubscribedFields,
  COEXISTENCE_REQUIRED_FIELDS,
  normalizeSubscribedFields,
  type WebhookFieldCoverage,
} from "@icecore/whatsapp/webhookFields";
import {
  collectMetaGraphEdge,
  MetaGraphRequestError,
  formatMetaGraphAPIError,
  getWhatsAppGraphClient,
  type MetaGraphAPIError,
  type MetaGraphPageBoundary,
  type WhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import { isRecord } from "@icecore/shared/lib/value-utils";
import { WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL } from "./docs";

const graphClient = getWhatsAppGraphClient();
const wabaLogger = createServerLogger("whatsapp.waba-service");
const WABA_APP_SUBSCRIPTION_FIELDS_CACHE_TTL_SECONDS = 5 * 60;
const appSubscriptionFieldsInFlight = new Map<string, Promise<string[]>>();

export { getWABASendingReadiness } from "@icecore/whatsapp/sendingReadiness";

export interface WABAInfo {
  id: string;
  name?: string;
  currency?: string;
  timezone_id?: string;
  message_template_namespace?: string;
  account_review_status?: string; // "APPROVED", "PENDING", "REJECTED"
}

export interface PhoneNumberInfo {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  code_verification_status?: string;
  quality_rating?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
  name_status?: string;
}

export interface WABAWithPhones {
  waba: WABAInfo;
  phoneNumbers: PhoneNumberInfo[];
  accountType: "owned" | "client";
  businessId?: string;
  businessName?: string;
}

export interface BusinessInfo {
  id: string;
  name: string;
}

interface SubscribedAppEntry {
  id?: string;
  name?: string;
  whatsapp_business_api_data?: {
    id?: string;
    name?: string;
    subscribed_fields?: string[];
  };
  override_callback_uri?: string;
}

interface SubscribedAppsResponse {
  data?: SubscribedAppEntry[];
}

interface AppSubscriptionsResponse {
  data?: Array<{
    object?: string;
    active?: boolean;
    fields?: Array<{ name?: string; version?: string }>;
  }>;
}

function getSubscribedAppId(entry: SubscribedAppEntry) {
  return entry.id || entry.whatsapp_business_api_data?.id;
}

function getSubscribedAppName(entry: SubscribedAppEntry) {
  return entry.name || entry.whatsapp_business_api_data?.name;
}

function readConfiguredMetaApp(options: {
  required: true;
}): MetaServerAppConfig;
function readConfiguredMetaApp(options?: {
  required?: false;
}): MetaServerAppConfig | null;
function readConfiguredMetaApp(
  options: { required?: boolean } = {}
): MetaServerAppConfig | null {
  if (!options.required) {
    return tryGetMetaServerAppConfig();
  }

  try {
    return getMetaServerAppConfig();
  } catch (error) {
    throw attributeMetaCredentialOwner(error, "configured_app");
  }
}

export function extractSubscribedFieldsForApp(
  response: SubscribedAppsResponse
): {
  subscribedFields: string[];
  selectedAppId?: string;
  selectedAppName?: string;
  matchedPreferredApp: boolean;
  availableAppIds: string[];
  appSubscribed: boolean;
} {
  const entries = Array.isArray(response.data) ? response.data : [];
  const availableAppIds = entries
    .map(entry => getSubscribedAppId(entry))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const metaAppId = readConfiguredMetaApp({ required: true }).appId;

  if (metaAppId) {
    const matched = entries.find(
      entry => getSubscribedAppId(entry) === metaAppId
    );
    if (matched) {
      return {
        subscribedFields: normalizeSubscribedFields(
          matched.whatsapp_business_api_data?.subscribed_fields
        ),
        selectedAppId: getSubscribedAppId(matched),
        selectedAppName: getSubscribedAppName(matched),
        matchedPreferredApp: true,
        availableAppIds,
        appSubscribed: true,
      };
    }
  }

  const fallbackEntry =
    entries.find(entry =>
      Array.isArray(entry.whatsapp_business_api_data?.subscribed_fields)
    ) || entries[0];

  return {
    subscribedFields: normalizeSubscribedFields(
      fallbackEntry?.whatsapp_business_api_data?.subscribed_fields
    ),
    selectedAppId: fallbackEntry
      ? getSubscribedAppId(fallbackEntry)
      : undefined,
    selectedAppName: fallbackEntry
      ? getSubscribedAppName(fallbackEntry)
      : undefined,
    matchedPreferredApp: false,
    availableAppIds,
    appSubscribed: false,
  };
}

function resolveConfiguredMetaAppAccessToken(): {
  appId: string;
  token: string;
} {
  const appConfig = readConfiguredMetaApp({ required: true });
  return {
    appId: appConfig.appId,
    token: buildMetaAppAccessToken(appConfig),
  };
}

async function getConfiguredWhatsAppBusinessAccountWebhookFields(): Promise<
  string[]
> {
  const appAccess = resolveConfiguredMetaAppAccessToken();

  const cacheKey = buildCacheKey("whatsapp:meta-app-subscription-fields:v1", [
    appAccess.appId,
  ]);
  try {
    const cached = await cache.get<unknown>(cacheKey);
    if (
      Array.isArray(cached) &&
      cached.every(field => typeof field === "string")
    ) {
      return normalizeSubscribedFields(cached);
    }
  } catch {
    // Cache availability must not change the provider-derived result.
  }

  const existingRead = appSubscriptionFieldsInFlight.get(cacheKey);
  if (existingRead) {
    return existingRead;
  }

  const providerRead = (async () => {
    const data = await graphClient.getJson<AppSubscriptionsResponse>(
      `${appAccess.appId}/subscriptions`,
      {
        token: appAccess.token,
      }
    );

    if (!Array.isArray(data.data)) {
      return [];
    }

    const subscription = data.data.find(
      entry =>
        entry.object === "whatsapp_business_account" && entry.active !== false
    );
    if (subscription && !Array.isArray(subscription.fields)) {
      return [];
    }

    const subscribedFields = normalizeSubscribedFields(
      subscription?.fields?.map(field => field.name || "") || []
    );
    try {
      await cache.set(
        cacheKey,
        subscribedFields,
        WABA_APP_SUBSCRIPTION_FIELDS_CACHE_TTL_SECONDS
      );
    } catch {
      // A successful Meta read remains authoritative when cache writes fail.
    }

    return subscribedFields;
  })();
  appSubscriptionFieldsInFlight.set(cacheKey, providerRead);

  try {
    return await providerRead;
  } finally {
    if (appSubscriptionFieldsInFlight.get(cacheKey) === providerRead) {
      appSubscriptionFieldsInFlight.delete(cacheKey);
    }
  }
}

async function getWabaSubscribedFieldCoverage(
  wabaId: string,
  accessToken: string,
  options?: { coexistenceMode?: boolean }
): Promise<{
  appSubscribed: boolean;
  subscribedFields: string[];
  coverage: WebhookFieldCoverage;
  appSelection: ReturnType<typeof extractSubscribedFieldsForApp>;
}> {
  let verifyData: SubscribedAppsResponse;
  try {
    verifyData = await graphClient.getJson<SubscribedAppsResponse>(
      `${wabaId}/subscribed_apps`,
      {
        token: accessToken,
        query: {
          fields: "id,name,whatsapp_business_api_data",
        },
      }
    );
  } catch (error) {
    throw attributeMetaCredentialOwner(error, "source_token");
  }
  const appSelection = extractSubscribedFieldsForApp(verifyData);
  let subscribedFields = appSelection.subscribedFields;

  // Graph v25 returns the WABA app attachment and override callback, but often
  // omits whatsapp_business_api_data.subscribed_fields from this edge. The
  // actual field list is available on the app-level subscription.
  if (subscribedFields.length === 0 && appSelection.appSubscribed) {
    try {
      subscribedFields =
        await getConfiguredWhatsAppBusinessAccountWebhookFields();
    } catch (error) {
      throw attributeMetaCredentialOwner(error, "configured_app");
    }
  }

  const coverage = analyzeSubscribedFields(subscribedFields, {
    coexistenceMode: options?.coexistenceMode,
  });

  return {
    appSubscribed: appSelection.appSubscribed,
    subscribedFields: coverage.subscribedFields,
    coverage,
    appSelection,
  };
}

export async function getWabaWebhookSubscriptionStatus(
  wabaId: string,
  accessToken: string,
  options?: { coexistenceMode?: boolean }
): Promise<{
  subscribed: boolean;
  fields: string[];
  missingRequiredFields: string[];
  missingOptionalFields: string[];
  coverageOk: boolean;
  actionable: string | null;
  coverage: WebhookFieldCoverage;
  selectedAppId?: string;
  selectedAppName?: string;
  matchedPreferredApp: boolean;
  availableAppIds: string[];
}> {
  const verified = await getWabaSubscribedFieldCoverage(
    wabaId,
    accessToken,
    options
  );

  return {
    subscribed: verified.appSubscribed,
    fields: verified.subscribedFields,
    missingRequiredFields: verified.coverage.missingRequiredFields,
    missingOptionalFields: verified.coverage.missingOptionalFields,
    coverageOk: verified.coverage.coverageOk,
    actionable: verified.coverage.actionable,
    coverage: verified.coverage,
    selectedAppId: verified.appSelection.selectedAppId,
    selectedAppName: verified.appSelection.selectedAppName,
    matchedPreferredApp: verified.appSelection.matchedPreferredApp,
    availableAppIds: verified.appSelection.availableAppIds,
  };
}

/** Verify delivery before consuming either one-time Business App sync request. */
export async function getWhatsAppCoexistenceSyncWebhookReadiness(
  wabaId: string | null | undefined,
  accessToken: string
): Promise<
  | { ready: true }
  | { ready: false; error: string; actionable: string; docs: string[] }
> {
  const docs = [WHATSAPP_COEXISTENCE_ONBOARDING_DOC_URL];
  if (!wabaId) {
    return {
      ready: false,
      error: "WhatsApp Business Account is missing. Sync has not been requested.",
      actionable:
        "Reconnect WhatsApp to select a business account, then retry synchronization.",
      docs,
    };
  }

  try {
    const status = await getWabaWebhookSubscriptionStatus(wabaId, accessToken, {
      coexistenceMode: true,
    });
    if (!status.subscribed) {
      return {
        ready: false,
        error:
          "The app is not subscribed to this WhatsApp Business Account. Sync has not been requested.",
        actionable:
          "Repair the WhatsApp webhook subscription, then retry synchronization.",
        docs,
      };
    }

    const missingFields = COEXISTENCE_REQUIRED_FIELDS.filter(
      field => !status.fields.includes(field)
    );
    if (missingFields.length > 0) {
      return {
        ready: false,
        error: `Required coexistence webhooks are missing: ${missingFields.join(", ")}. Sync has not been requested.`,
        actionable:
          "Enable the missing fields in Meta App Dashboard > WhatsApp > Configuration > Webhooks, repair the subscription, then retry synchronization.",
        docs,
      };
    }

    return { ready: true };
  } catch {
    return {
      ready: false,
      error:
        "Could not verify WhatsApp webhook subscriptions. Sync has not been requested.",
      actionable:
        "Check the WhatsApp connection and repair webhook subscriptions, then retry synchronization.",
      docs,
    };
  }
}

/**
 * Fetches business portfolios for the authenticated user
 */
export async function getBusinessPortfolios(
  accessToken: string
): Promise<BusinessInfo[]> {
  try {
    const data = await graphClient.getJson<{ data?: BusinessInfo[] }>(
      "me/businesses",
      {
        token: accessToken,
        query: { fields: "id,name" },
      }
    );
    return data.data || [];
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      const wrappedError = new Error(
        `Failed to fetch business portfolios: ${error.message}`
      );
      (wrappedError as unknown as { details: string }).details =
        typeof error.details === "string"
          ? error.details
          : JSON.stringify(error.details);
      throw wrappedError;
    }

    throw error;
  }
}

/**
 * Resiliently discovers all available WABAs for a token.
 * Tries multiple methods to handle different permission levels (e.g. tech providers).
 */
export async function discoverWABAs(
  accessToken: string
): Promise<WABAWithPhones[]> {
  const allWABAs: WABAWithPhones[] = [];
  const seenWabaIds = new Set<string>();

  const addUniqueWABAs = (newWABAs: WABAWithPhones[]) => {
    for (const waba of newWABAs) {
      if (!seenWabaIds.has(waba.waba.id)) {
        allWABAs.push(waba);
        seenWabaIds.add(waba.waba.id);
      }
    }
  };

  // Method 1: Try via debug_token to get granular_scopes (most accurate for newly authorized assets)
  const appConfig = readConfiguredMetaApp();
  if (appConfig) {
    try {
      const debugData = await debugConfiguredMetaAccessToken(accessToken, {
        appConfig,
      });

      const granularScopes = debugData.granular_scopes || [];
      const mgmtScope = granularScopes.find(
        s => s.scope === "whatsapp_business_management"
      );
      const authorizedWabaIds = mgmtScope?.target_ids || [];

      if (authorizedWabaIds.length > 0) {
        wabaLogger.info("discover_wabas_granular_scopes_found", {
          authorizedWabaIds,
        });

        let businessName: string | undefined;
        const businessId = debugData.business_id;

        if (businessId) {
          try {
            const businessData = await graphClient.getJson<{ name?: string }>(
              businessId,
              {
                token: accessToken,
                query: { fields: "name" },
              }
            );
            businessName = businessData.name;
          } catch (be) {
            wabaLogger.info("discover_wabas_business_name_lookup_failed", {
              error: be instanceof Error ? be.message : String(be),
            });
          }
        }

        for (const wabaId of authorizedWabaIds) {
          try {
            const waba = await graphClient.getJson<WABAInfo>(wabaId, {
              token: accessToken,
              query: {
                fields:
                  "id,name,currency,timezone_id,message_template_namespace,account_review_status",
              },
            });
            const phoneNumbers = await getWABAPhoneNumbers(
              waba.id,
              accessToken
            );
            addUniqueWABAs([
              {
                waba,
                phoneNumbers,
                accountType: "owned",
                businessId,
                businessName,
              },
            ]);
          } catch (err) {
            wabaLogger.info("discover_wabas_authorized_waba_lookup_failed", {
              wabaId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // If we found WABAs via granular_scopes, return immediately to keep UX clean
        if (allWABAs.length > 0) {
          wabaLogger.info("discover_wabas_session_authorized_assets_found", {
            wabaCount: allWABAs.length,
          });
          return allWABAs;
        }
      }

      // Fallback: If no granular_scopes, try using the business_id from debug_token
      const businessId = debugData.business_id;
      if (businessId) {
        try {
          const wabas = await getAllWABAs(businessId, accessToken);
          addUniqueWABAs(wabas);
        } catch (eb) {
          wabaLogger.info("discover_wabas_business_fallback_failed", {
            businessId,
            error: eb instanceof Error ? eb.message : String(eb),
          });
        }
      }
    } catch (error) {
      wabaLogger.info("discover_wabas_debug_token_method_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Method 2: Try via Business Portfolios (requires business_management permission)
  try {
    const businesses = await getBusinessPortfolios(accessToken);
    for (const business of businesses) {
      const wabas = await getAllWABAs(business.id, accessToken);
      addUniqueWABAs(
        wabas.map(w => ({
          ...w,
          businessId: business.id,
          businessName: business.name,
        }))
      );
    }
  } catch (error) {
    wabaLogger.info("discover_wabas_businesses_method_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Method 3: Try via /me endpoint (fallback for direct owned access)
  try {
    const data = await graphClient.getJson<{ data?: WABAInfo[] }>(
      "me/owned_whatsapp_business_accounts",
      {
        token: accessToken,
        query: {
          fields:
            "id,name,currency,timezone_id,message_template_namespace,account_review_status",
        },
      }
    );

    if (data.data && Array.isArray(data.data)) {
      for (const waba of data.data) {
        if (!seenWabaIds.has(waba.id)) {
          const phoneNumbers = await getWABAPhoneNumbers(waba.id, accessToken);
          allWABAs.push({
            waba,
            phoneNumbers,
            accountType: "owned",
          });
          seenWabaIds.add(waba.id);
        }
      }
    }
  } catch (error) {
    wabaLogger.info("discover_wabas_me_method_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return allWABAs;
}

/**
 * Fetches all WABAs (owned and client) for a business
 * This is critical for multi-tenant SaaS - users may have multiple WABAs
 */
export async function getAllWABAs(
  businessId: string,
  accessToken: string
): Promise<WABAWithPhones[]> {
  const wabas: WABAWithPhones[] = [];

  // Fetch both owned and client WABAs
  const edges: Array<{
    type: "owned" | "client";
    endpoint: string;
  }> = [
    {
      type: "owned",
      endpoint: "owned_whatsapp_business_accounts",
    },
    {
      type: "client",
      endpoint: "client_whatsapp_business_accounts",
    },
  ];

  for (const { type, endpoint } of edges) {
    try {
      const data = await graphClient.getJson<{ data?: WABAInfo[] }>(
        `${businessId}/${endpoint}`,
        {
          token: accessToken,
          query: {
            fields:
              "id,name,currency,timezone_id,message_template_namespace,account_review_status",
          },
        }
      );

      if (data.data && data.data.length > 0) {
        // For each WABA, fetch its phone numbers
        for (const waba of data.data) {
          const phoneNumbers = await getWABAPhoneNumbers(waba.id, accessToken);
          wabas.push({
            waba,
            phoneNumbers,
            accountType: type,
          });
        }
      }
    } catch (error) {
      wabaLogger.error("fetch_wabas_edge_failed", error, {
        businessId,
        accountType: type,
      });
      // Continue to next type even if one fails
    }
  }

  return wabas;
}

/**
 * Fetches phone numbers for a specific WABA
 */
const WABA_PHONE_INVENTORY_MAX_PAGES = 100;
const WABA_PHONE_INVENTORY_MAX_ITEMS = 10_000;
const WABA_PHONE_NUMBER_FIELDS =
  "id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type,is_on_biz_app,name_status";

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isPhoneNumberInfo(value: unknown): value is PhoneNumberInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.display_phone_number === "string" &&
    value.display_phone_number.length > 0 &&
    isOptionalString(value.verified_name) &&
    isOptionalString(value.code_verification_status) &&
    isOptionalString(value.quality_rating) &&
    isOptionalString(value.platform_type) &&
    (value.is_on_biz_app === undefined ||
      typeof value.is_on_biz_app === "boolean") &&
    isOptionalString(value.name_status)
  );
}

export async function getWABAPhoneNumbersStrict(params: {
  wabaId: string;
  accessToken: string;
  client?: WhatsAppGraphClient;
  beforePage?: (boundary: MetaGraphPageBoundary) => void | Promise<void>;
  createRequestSignal?: () => AbortSignal;
}): Promise<PhoneNumberInfo[]> {
  const phoneNumbers = await collectMetaGraphEdge<PhoneNumberInfo>({
    client: params.client ?? graphClient,
    accessToken: params.accessToken,
    path: `${params.wabaId}/phone_numbers`,
    initialQuery: {
      fields: WABA_PHONE_NUMBER_FIELDS,
      limit: 100,
    },
    maxPages: WABA_PHONE_INVENTORY_MAX_PAGES,
    maxItems: WABA_PHONE_INVENTORY_MAX_ITEMS,
    beforePage: params.beforePage,
    createRequestSignal: params.createRequestSignal,
    normalizePage: payload => {
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new Error("Invalid WABA phone numbers response");
      }
      if (!payload.data.every(isPhoneNumberInfo)) {
        throw new Error("Invalid WABA phone numbers response");
      }

      const paging = payload.paging;
      if (paging !== undefined && !isRecord(paging)) {
        throw new Error("Invalid WABA phone numbers response");
      }
      const next = paging?.next;
      if (next !== undefined && typeof next !== "string") {
        throw new Error("Invalid WABA phone numbers response");
      }

      return {
        data: payload.data,
        next,
      };
    },
  });
  if (phoneNumbers.length >= WABA_PHONE_INVENTORY_MAX_ITEMS) {
    throw new Error("WABA phone number inventory limit exceeded");
  }

  const uniquePhoneNumbers = new Map<string, PhoneNumberInfo>();
  for (const phoneNumber of phoneNumbers) {
    if (!uniquePhoneNumbers.has(phoneNumber.id)) {
      uniquePhoneNumbers.set(phoneNumber.id, phoneNumber);
    }
  }
  return Array.from(uniquePhoneNumbers.values());
}

export async function getWABAPhoneNumbers(
  wabaId: string,
  accessToken: string
): Promise<PhoneNumberInfo[]> {
  try {
    return await getWABAPhoneNumbersStrict({ wabaId, accessToken });
  } catch (error) {
    wabaLogger.error("fetch_waba_phone_numbers_failed", error, {
      wabaId,
    });
    return [];
  }
}

/**
 * Resolves the webhook callback URL and verify token from environment.
 * Used by both WABA and phone number subscription to set override_callback_uri.
 *
 * CRITICAL for Embedded Signup tech providers: Without override_callback_uri,
 * Meta won't know where to send webhooks for client WABAs, and no webhook
 * fields will be activated even though the subscription call succeeds.
 *
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/webhooks/override
 */
function resolveWebhookOverride(explicit?: {
  overrideCallbackUri?: string;
  verifyToken?: string;
}): { overrideCallbackUri: string; verifyToken: string } | null {
  // Extract base URL from NEXT_PUBLIC_APP_URL or NEXT_PUBLIC_WHATSAPP_REDIRECT_URI
  let baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl && process.env.NEXT_PUBLIC_WHATSAPP_REDIRECT_URI) {
    try {
      baseUrl = new URL(process.env.NEXT_PUBLIC_WHATSAPP_REDIRECT_URI).origin;
    } catch {
      // Ignore invalid URL
    }
  }

  const callbackUri =
    explicit?.overrideCallbackUri ||
    (baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/webhooks/whatsapp` : null);

  const verifyToken =
    explicit?.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || null;

  if (!callbackUri || !verifyToken) {
    return null;
  }

  return { overrideCallbackUri: callbackUri, verifyToken };
}

export interface WABASubscribeOptions {
  /** Override webhook callback URL. Auto-resolved from env if not provided. */
  overrideCallbackUri?: string;
  /** Webhook verify token. Auto-resolved from WHATSAPP_VERIFY_TOKEN if not provided. */
  verifyToken?: string;
  /**
   * When true, coexistence-specific fields (history, smb_app_state_sync, ...)
   * are treated as required for the coverage report. Pass the value of
   * `source.credentials.coexistence_mode` from the caller.
   */
  coexistenceMode?: boolean;
}

/**
 * Subscribes app to WABA webhooks
 * Required for receiving messages and account_update events
 *
 * CRITICAL: Meta periodically re-verifies webhooks by sending GET requests to the webhook endpoint.
 * If verification fails (endpoint down, slow, or returns error), Meta will automatically unsubscribe.
 * This is why subscriptions can be lost even if they were working before.
 *
 * To prevent subscription loss:
 * 1. Ensure /api/webhooks/whatsapp GET endpoint is always available and responds quickly
 * 2. Ensure WHATSAPP_VERIFY_TOKEN matches what's configured in Meta App Dashboard
 * 3. Monitor webhook verification attempts in logs
 * 4. Re-subscribe if verification fails (the cron job at /api/cron/check-whatsapp-webhooks will auto-fix)
 *
 * IMPORTANT: For Embedded Signup as tech provider, account_update field is required to receive
 * PARTNER_ADDED events when customers complete onboarding.
 *
 * For tech providers with Embedded Signup, pass overrideCallbackUri + verifyToken so that Meta
 * can verify your webhook endpoint and activate webhook fields for the client's WABA.
 * If not passed explicitly, these are auto-resolved from WHATSAPP_WEBHOOK_CALLBACK_URL /
 * NEXT_PUBLIC_APP_URL and WHATSAPP_VERIFY_TOKEN environment variables.
 *
 * @see https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/webhooks#overriding-the-callback-url
 * @returns Object with success status and error details if failed
 */
export async function subscribeToWABAWebhooks(
  wabaId: string,
  accessToken: string,
  options?: WABASubscribeOptions
): Promise<{
  success: boolean;
  error?: string;
  status?: number;
  details?: unknown;
  metaError?: MetaGraphAPIError;
  formattedError?: ReturnType<typeof formatMetaGraphAPIError>;
  metaCredentialOwner?: MetaCredentialOwner;
  subscribedFields?: string[];
  missingRequiredFields?: string[];
  missingOptionalFields?: string[];
  coverageOk?: boolean;
  actionable?: string | null;
  coverage?: WebhookFieldCoverage;
}> {
  try {
    // Resolve webhook override for tech-provider Embedded Signup.
    // This is critical: without override_callback_uri, Meta has no way to verify
    // our webhook endpoint for client WABAs, and no webhook fields get activated.
    const webhookOverride = resolveWebhookOverride(options);

    // Build POST body - include override_callback_uri if available
    const postBody: Record<string, string> | undefined = webhookOverride
      ? {
          override_callback_uri: webhookOverride.overrideCallbackUri,
          verify_token: webhookOverride.verifyToken,
        }
      : undefined;

    if (webhookOverride) {
      wabaLogger.info("subscribe_waba_webhooks_with_override", {
        wabaId,
        overrideCallbackUri: webhookOverride.overrideCallbackUri,
      });
    } else {
      wabaLogger.info("subscribe_waba_webhooks_without_override", {
        wabaId,
        guidance:
          "Set NEXT_PUBLIC_WHATSAPP_REDIRECT_URI or NEXT_PUBLIC_APP_URL plus WHATSAPP_VERIFY_TOKEN to auto-configure webhook routing.",
      });
    }

    // Subscribe to webhooks
    const result = await graphClient.postJson<{ success?: boolean }>(
      `${wabaId}/subscribed_apps`,
      {
        token: accessToken,
        ...(postBody ? { body: postBody } : {}),
      }
    );
    const success = result.success === true;

    if (!success) {
      wabaLogger.info("subscribe_waba_webhooks_success_false", {
        wabaId,
        result,
      });
    }

    let subscribedFields: string[] = [];
    let coverage: WebhookFieldCoverage | undefined;
    let configuredAppVerified = false;
    if (success) {
      const verified = await getWabaSubscribedFieldCoverage(
        wabaId,
        accessToken,
        { coexistenceMode: options?.coexistenceMode }
      );
      configuredAppVerified = verified.appSubscribed;
      subscribedFields = verified.subscribedFields;
      coverage = verified.coverage;

      if (subscribedFields.length === 0) {
        wabaLogger.info("subscribe_waba_webhooks_no_active_fields", {
          wabaId,
          guidance:
            "Configure WhatsApp webhook fields in Meta App Dashboard, then re-run WABA subscription.",
        });
      } else {
        wabaLogger.info("subscribe_waba_webhooks_fields_active", {
          wabaId,
          subscribedFields,
        });
      }

      if (!configuredAppVerified) {
        wabaLogger.info("subscribe_waba_webhooks_configured_app_not_verified", {
          wabaId,
        });
      }

      if (!coverage.coverageOk && coverage.actionable) {
        wabaLogger.info("subscribe_waba_webhooks_missing_required_fields", {
          wabaId,
          missingRequiredFields: coverage.missingRequiredFields,
          actionable: coverage.actionable,
        });
      }
    }

    return {
      success: success && configuredAppVerified,
      ...(!configuredAppVerified && success
        ? { error: "Configured Meta app subscription was not verified." }
        : {}),
      subscribedFields:
        subscribedFields.length > 0 ? subscribedFields : undefined,
      missingRequiredFields: coverage?.missingRequiredFields,
      missingOptionalFields: coverage?.missingOptionalFields,
      coverageOk: coverage?.coverageOk ?? false,
      actionable: coverage?.actionable || null,
      coverage,
    };
  } catch (error) {
    const metaCredentialOwner = getMetaCredentialOwner(error);
    if (error instanceof MetaGraphRequestError) {
      wabaLogger.error("subscribe_waba_webhooks_graph_failed", error, {
        wabaId,
        status: error.status,
        statusText: error.statusText,
        details:
          error.details == null
            ? null
            : typeof error.details === "object"
              ? (error.details as object)
              : String(error.details),
        metaError: error.metaError,
        formattedError: error.formattedError,
      });

      return {
        success: false,
        status: error.status,
        error:
          error.formattedError?.message ||
          `HTTP ${error.status}: ${error.statusText}`,
        details: error.details,
        metaError: error.metaError,
        formattedError: error.formattedError,
        ...(metaCredentialOwner ? { metaCredentialOwner } : {}),
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    wabaLogger.error("subscribe_waba_webhooks_failed", error, {
      wabaId,
      errorMessage,
    });
    return {
      success: false,
      error: errorMessage,
      ...(metaCredentialOwner ? { metaCredentialOwner } : {}),
    };
  }
}

/**
 * Validates if user has proper permissions for WABA
 * Checks if WABA is accessible and has at least one phone number
 */
export async function validateWABAAccess(
  wabaId: string,
  accessToken: string
): Promise<{
  valid: boolean;
  error?: string;
  phoneNumbers?: PhoneNumberInfo[];
  accountReviewStatus?: string;
  warnings?: string[];
}> {
  try {
    const warnings: string[] = [];

    // Fetch WABA details to check review status
    const wabaData = await graphClient.getJson<WABAInfo>(wabaId, {
      token: accessToken,
      query: { fields: "id,name,account_review_status" },
    });
    let accountReviewStatus = "UNKNOWN";
    accountReviewStatus = wabaData.account_review_status || "UNKNOWN";

    if (accountReviewStatus !== "APPROVED") {
      warnings.push(
        `WhatsApp Business Account is not verified (Status: ${accountReviewStatus}). This may cause phone verification issues and messaging limits.`
      );
    }

    const phoneNumbers = await getWABAPhoneNumbers(wabaId, accessToken);

    if (phoneNumbers.length === 0) {
      return {
        valid: false,
        error: "No phone numbers found for this WhatsApp Business Account",
        accountReviewStatus,
      };
    }

    // Check if any phone number is not verified
    const unverifiedPhones = phoneNumbers.filter(
      p => p.code_verification_status !== "VERIFIED"
    );
    if (unverifiedPhones.length > 0) {
      warnings.push(
        `${unverifiedPhones.length} phone number(s) not verified. Please complete phone verification in Facebook Business Manager.`
      );
    }

    return {
      valid: true,
      phoneNumbers,
      accountReviewStatus,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    if (error instanceof MetaGraphRequestError) {
      const metaError = error.metaError;
      if (metaError?.code === 100 || metaError?.code === 200) {
        return {
          valid: false,
          error: `Access token does not have permissions to access WABA ${wabaId}. ${metaError.message || "The WABA may not exist, or the token may have been revoked."}`,
        };
      }

      return {
        valid: false,
        error:
          error.formattedError?.message ||
          `Failed to access WABA: HTTP ${error.status}`,
      };
    }

    return {
      valid: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to validate WABA access",
    };
  }
}
