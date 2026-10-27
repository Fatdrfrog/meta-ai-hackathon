import { decryptMaybeString } from "@/lib/crypto";
import { tryGetMetaServerAppConfig } from "@/lib/meta/app-config";
import {
  attributeMetaCredentialOwner,
  getMetaCredentialOwner,
} from "@/lib/meta/credential-owner";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import { classifyWhatsAppMetaDiagnosticError } from "@/lib/meta/whatsapp-diagnostics";
import { createServerLogger } from "@/lib/observability/server-logs";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsappMessage } from "@/lib/whatsapp";
import {
  deriveWhatsAppAccountHealth,
  mergeWhatsAppAccountHealthCredentials,
} from "@/lib/whatsapp/account/health";
import {
  type AutoDefaultsTrigger,
  buildCallingStatusPatch,
  buildWhatsAppCallingOperationalReadiness,
  runWhatsAppAutoDefaults,
} from "@/lib/whatsapp/auto-defaults";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import {
  createWhatsAppSourceCredentialSnapshotSaver,
  updateCurrentWhatsAppSourceCredentials,
} from "@/lib/whatsapp/flows/source-rebind-guard";
import { uploadWhatsAppVoicemailAnnouncementFile } from "@/lib/whatsapp/media-upload";
import { buildMarketingMessagesCredentialPatch } from "@/lib/whatsapp/marketing/messages-onboarding";
import {
  acquireWhatsAppMetaReadPermit,
  buildWhatsAppMetaAuthorizationCredentialPatch,
  buildWhatsAppMetaRateLimitCredentialPatch,
  buildWhatsAppMetaReadFailureCredentialPatch,
  buildWhatsAppMetaReadSuccessCredentialPatch,
  META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD,
  releaseWhatsAppMetaReadPermit,
  setCachedWhatsAppMetaReadCooldownUntil,
  type WhatsAppMetaRefreshOutcome,
  type WhatsAppMetaRefreshResponse,
} from "@/lib/whatsapp/meta-read-policy";
import {
  buildWhatsAppBusinessAppConnectionSignalInput,
  buildWhatsAppOnboardingStatusFromCredentials,
  type WhatsAppOnboardingStatus as OnboardingStatus,
} from "@/lib/whatsapp/onboarding-status";
import {
  getPhoneNumberDetails,
  registerPhoneNumberWithPin,
} from "@/lib/whatsapp/qr-code-service";
import {
  getWabaWebhookSubscriptionStatus,
} from "@/lib/whatsapp/waba-service";
import { getPhoneCallingSettings } from "@icecore/airi-runtime/whatsapp-calling-service";
import { cache } from "@icecore/shared/lib/cache";
import {
  getWhatsAppGraphClient,
} from "@icecore/shared/lib/meta/api";
import { readString } from "@icecore/shared/lib/value-utils";
import {
  buildWhatsAppBusinessAppConnectionPatch,
  hasWhatsAppBusinessAppConnectionSignal,
  shouldUseManualPhoneRegistrationGuidance,
} from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";
import {
  buildWhatsAppPhoneDetailsCredentialPatch,
  isWhatsAppPhoneNumberRegistered,
} from "@icecore/shared/lib/whatsapp/phone-details";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

const PAYMENT_MANAGER_URL = "https://business.facebook.com/wa/manage/home/";
const PAYMENT_HELP_URL =
  "https://www.facebook.com/business/help/488291839463771";
const PHONE_NUMBERS_DOC_URL =
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers";
const REGISTRATION_DOC_URL =
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration";

const graphClient = getWhatsAppGraphClient();
const onboardingRouteLogger = createServerLogger("api.whatsapp.onboarding");

type OnboardingAction =
  | "upload_voicemail_announcement"
  | "register_phone"
  | "send_test_message"
  | "payment_method_prompt"
  | "auto_enable_defaults";

type OnboardingRequestBody = {
  workspaceId?: string;
  action?: OnboardingAction;
  pin?: string;
  to?: string;
  message?: string;
  force?: boolean;
  trigger?: string;
  description?: string;
};

type ParsedOnboardingRequest = {
  body: OnboardingRequestBody;
  file?: File | null;
};

function isSmbRegisterEndpointUnavailable(errorMessage: string) {
  return errorMessage
    .toLowerCase()
    .includes("register endpoint is not available for smb businesses");
}

function buildSmbManualRegistrationGuidance() {
  return {
    error:
      "Phone registration API is not available for SMB/coexistence numbers.",
    actionable:
      "Complete phone setup in WhatsApp Business app (Settings > Account > Two-step verification) or WhatsApp Manager.",
    docs: [PHONE_NUMBERS_DOC_URL, REGISTRATION_DOC_URL],
  };
}

function resolveTwoStepPin(pin?: string) {
  if (pin && /^\d{6}$/.test(pin)) {
    return pin;
  }

  const envPin = process.env.WHATSAPP_DEFAULT_PIN;
  if (envPin && /^\d{6}$/.test(envPin)) {
    return envPin;
  }

  return null;
}

async function getWorkspaceWhatsAppSource(workspaceId: string): Promise<{
  id: string;
  credentials: Record<string, unknown> | null;
} | null> {
  const supabase = await createClient();
  const { data: source } = await supabase
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!source) return null;
  return {
    id: source.id,
    credentials: (source.credentials as Record<string, unknown>) || null,
  };
}

interface WabaPhoneNumbersResponse {
  data?: Array<{
    id?: string;
  }>;
}

async function fetchTokenAppId(accessToken: string): Promise<{
  attempted: boolean;
  succeeded: boolean;
  appId?: string;
}> {
  const appConfig = tryGetMetaServerAppConfig();
  if (!appConfig) {
    return { attempted: false, succeeded: false };
  }

  try {
    const data = await debugConfiguredMetaAccessToken(accessToken, {
      appConfig,
    });

    return {
      attempted: true,
      succeeded: true,
      appId: readString(data.app_id),
    };
  } catch (error) {
    const errorClass = classifyWhatsAppMetaDiagnosticError(error);
    if (errorClass === "rate_limited" || errorClass === "authorization") {
      throw attributeMetaCredentialOwner(error, "configured_app");
    }
    return { attempted: true, succeeded: false };
  }
}

function parseAutoDefaultsTrigger(input: unknown): AutoDefaultsTrigger {
  if (typeof input !== "string" || input.trim().length === 0) {
    return "onboarding_action";
  }

  const normalized = input.trim() as AutoDefaultsTrigger;
  const allowed: AutoDefaultsTrigger[] = [
    "embedded_signup_connect",
    "oauth_connect",
    "source_connect",
    "token_refresh",
    "upgrade_fallback",
    "upgrade_retry",
    "onboarding_action",
    "unknown",
  ];

  return allowed.includes(normalized) ? normalized : "unknown";
}

function readFormString(formData: FormData, key: string): string | undefined {
  return readString(formData.get(key))?.trim() || undefined;
}

function readFormBoolean(formData: FormData, key: string): boolean | undefined {
  const value = readFormString(formData, key)?.toLowerCase();
  if (!value) return undefined;
  return value === "true" || value === "1" || value === "yes";
}

async function parseOnboardingRequest(
  request: Request
): Promise<ParsedOnboardingRequest> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const formData = await request.formData();
    const action = readFormString(formData, "action") as
      | OnboardingAction
      | undefined;
    const file = formData.get("file");

    return {
      body: {
        workspaceId: readFormString(formData, "workspaceId"),
        action,
        description: readFormString(formData, "description"),
        force: readFormBoolean(formData, "force"),
        trigger: readFormString(formData, "trigger"),
      },
      file: file instanceof File ? file : null,
    };
  }

  return {
    body: ((await request.json()) || {}) as OnboardingRequestBody,
    file: null,
  };
}

async function fetchWabaReviewAndMarketingStatus(
  wabaId: string,
  accessToken: string
): Promise<
  | {
      ok: true;
      accountReviewStatus?: string;
      marketingMessagesOnboardingStatus?: string | null;
    }
  | { ok: false }
> {
  try {
    const data = await graphClient.getJson<{
      account_review_status?: string;
      marketing_messages_onboarding_status?: string | null;
    }>(wabaId, {
      token: accessToken,
      query: {
        fields: "id,account_review_status,marketing_messages_onboarding_status",
      },
    });

    return {
      ok: true,
      accountReviewStatus: data.account_review_status,
      marketingMessagesOnboardingStatus:
        data.marketing_messages_onboarding_status ?? null,
    };
  } catch (error) {
    const errorClass = classifyWhatsAppMetaDiagnosticError(error);
    if (errorClass === "rate_limited" || errorClass === "authorization") {
      throw error;
    }
    return { ok: false };
  }
}

function buildConnectedOnboardingResponse(
  statusFromCredentials: OnboardingStatus,
  statusCredentials: Record<string, unknown>,
  options: {
    metaRefresh: WhatsAppMetaRefreshResponse;
    error?: string;
    httpStatus?: number;
  }
) {
  const accountHealth = deriveWhatsAppAccountHealth(statusCredentials);
  const status: OnboardingStatus = {
    ...statusFromCredentials,
    ...buildWhatsAppOnboardingStatusFromCredentials(statusCredentials),
    account_health: accountHealth,
    waba_health_state: accountHealth.state,
    waba_health_reasons: accountHealth.reasons,
    waba_health_last_checked_at: readString(
      statusCredentials.waba_health_last_checked_at
    ),
  };
  status.calls_operational_readiness =
    buildWhatsAppCallingOperationalReadiness(status);

  return NextResponse.json(
    {
      connected: true,
      status,
      meta_refresh: options.metaRefresh,
      ...(options.error ? { error: options.error } : {}),
    },
    { status: options.httpStatus ?? 200 }
  );
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const source = await getWorkspaceWhatsAppSource(workspaceId);
    if (!source?.credentials) {
      return NextResponse.json(
        { connected: false, status: null },
        { status: 200 }
      );
    }

    const creds = source.credentials as Record<string, unknown>;
    const phoneNumberId = readString(creds.phone_number_id);
    const wabaId = readString(creds.waba_id);
    const accessToken = decryptMaybeString(creds.access_token);

    const statusFromCredentials: OnboardingStatus = {
      ...buildWhatsAppOnboardingStatusFromCredentials(creds),
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
    };

    const explicitRefresh = ["1", "true"].includes(
      (searchParams.get("refresh") || "").toLowerCase()
    );
    if (!accessToken || (!phoneNumberId && !wabaId)) {
      return buildConnectedOnboardingResponse(statusFromCredentials, creds, {
        metaRefresh: {
          requested: explicitRefresh,
          performed: false,
          outcome: "not_configured",
        },
        ...(explicitRefresh
          ? {
              error: "WhatsApp Meta credentials are incomplete.",
              httpStatus: 409,
            }
          : {}),
      });
    }

    const metaReadPermit = await acquireWhatsAppMetaReadPermit(
      {
        sourceId: source.id,
        wabaId,
        credentials: creds,
        explicitRefresh,
      },
      { cacheClient: cache }
    );
    if (metaReadPermit.outcome !== "acquired") {
      const coordinationUnavailable =
        metaReadPermit.outcome === "coordination_unavailable";
      if (coordinationUnavailable) {
        onboardingRouteLogger.error(
          "WhatsApp Meta diagnostics coordination is unavailable",
          new Error("Provider refresh lock backend is unavailable"),
          { workspaceId, sourceId: source.id, wabaId }
        );
      }
      return buildConnectedOnboardingResponse(statusFromCredentials, creds, {
        metaRefresh: {
          requested: explicitRefresh,
          performed: false,
          outcome:
            metaReadPermit.outcome === "coordination_unavailable"
              ? "failed"
              : metaReadPermit.outcome,
          ...(metaReadPermit.cooldownUntil
            ? { cooldown_until: metaReadPermit.cooldownUntil }
            : {}),
        },
        ...(explicitRefresh
          ? {
              error: coordinationUnavailable
                ? "Meta diagnostics coordination is temporarily unavailable."
                : metaReadPermit.outcome === "in_progress"
                  ? "A Meta diagnostics refresh is already in progress."
                  : metaReadPermit.outcome === "cooldown"
                    ? `Meta diagnostics are cooling down until ${metaReadPermit.cooldownUntil}.`
                    : "Meta diagnostics were checked too recently. Please try again shortly.",
              httpStatus: coordinationUnavailable ? 503 : 429,
            }
          : {}),
      });
    }

    try {
      let metaRateLimitError: unknown = null;
      let terminalMetaReadError: unknown = null;
      let terminalMetaReadRequiresCustomerReconnect = false;
      let terminalMetaReadCredentialOwner: ReturnType<
        typeof getMetaCredentialOwner
      > = null;
      let successfulMetaReadCount = 0;
      let failedMetaReadCount = 0;
      const metaReadStopped = () =>
        Boolean(metaRateLimitError || terminalMetaReadError);
      const captureMetaCircuitError = (error: unknown) => {
        const errorClass = classifyWhatsAppMetaDiagnosticError(error);
        const credentialOwner = getMetaCredentialOwner(error);
        if (errorClass === "configured_app") {
          terminalMetaReadError = error;
          terminalMetaReadCredentialOwner = credentialOwner;
          terminalMetaReadRequiresCustomerReconnect = false;
          return true;
        }
        if (errorClass === "rate_limited") {
          metaRateLimitError = error;
          return true;
        }
        if (errorClass === "authorization") {
          terminalMetaReadError = error;
          terminalMetaReadCredentialOwner = credentialOwner;
          terminalMetaReadRequiresCustomerReconnect = true;
          return true;
        }
        return false;
      };

      const livePatch: Partial<OnboardingStatus> = {};

      if (phoneNumberId && accessToken) {
        try {
          const details = await getPhoneNumberDetails(
            phoneNumberId,
            accessToken
          );
          successfulMetaReadCount += 1;
          const phoneDetailsCheckedAt = new Date().toISOString();
          const isRegistered = isWhatsAppPhoneNumberRegistered(
            details,
            statusFromCredentials
          );

          livePatch.phone_number_accessible = true;
          livePatch.phone_number_access_error = null;
          livePatch.phone_registered = isRegistered;
          Object.assign(
            livePatch,
            buildWhatsAppPhoneDetailsCredentialPatch(details)
          );
          if (isRegistered) {
            livePatch.phone_registration_error = null;
          }
          livePatch.messaging_limit_last_checked_at = phoneDetailsCheckedAt;
          if (typeof details.is_pin_enabled === "boolean") {
            livePatch.two_step_pin_enabled = details.is_pin_enabled;
          } else if (typeof details.is_pin_enabled === "string") {
            livePatch.two_step_pin_enabled =
              details.is_pin_enabled.toLowerCase() === "true";
          }
          Object.assign(
            livePatch,
            buildWhatsAppBusinessAppConnectionPatch({
              ...buildWhatsAppBusinessAppConnectionSignalInput(creds, {
                isOnBizApp: details.is_on_biz_app,
                platformType: details.platform_type,
              }),
              partnerAppInstalledAt: readString(creds.partner_app_installed_at),
              cloudApiMessagingSuspended:
                isWhatsAppCloudApiMessagingSuspended(creds),
              now: phoneDetailsCheckedAt,
            })
          );

          if (isRegistered && !statusFromCredentials.phone_registered_at) {
            livePatch.phone_registered_at = phoneDetailsCheckedAt;
          }
        } catch (error) {
          failedMetaReadCount += 1;
          if (!captureMetaCircuitError(error)) {
            console.warn(
              "Could not hydrate live phone onboarding status:",
              error
            );
          }
        }
      }

      if (!metaReadStopped() && wabaId && accessToken) {
        try {
          const wabaStatus = await fetchWabaReviewAndMarketingStatus(
            wabaId,
            accessToken
          );
          if (wabaStatus.ok) {
            successfulMetaReadCount += 1;
            if (wabaStatus.accountReviewStatus) {
              livePatch.account_review_status = wabaStatus.accountReviewStatus;
            }
            Object.assign(
              livePatch,
              buildMarketingMessagesCredentialPatch({
                status: wabaStatus.marketingMessagesOnboardingStatus,
              })
            );
          } else {
            failedMetaReadCount += 1;
          }
        } catch (error) {
          failedMetaReadCount += 1;
          captureMetaCircuitError(error);
        }

        if (!metaReadStopped()) {
          const metaAppId = tryGetMetaServerAppConfig()?.appId;
          if (metaAppId) {
            livePatch.expected_meta_app_id = metaAppId;
          }

          try {
            const tokenApp = await fetchTokenAppId(accessToken);
            if (tokenApp.succeeded) {
              successfulMetaReadCount += 1;
            } else if (tokenApp.attempted) {
              failedMetaReadCount += 1;
            }
            if (tokenApp.appId) {
              livePatch.token_app_id = tokenApp.appId;
              if (metaAppId) {
                livePatch.token_app_id_matches_config =
                  tokenApp.appId === metaAppId;
              }
            }
          } catch (error) {
            failedMetaReadCount += 1;
            captureMetaCircuitError(error);
          }

          if (!metaReadStopped()) {
            try {
              const webhookConnectionCredentials = {
                ...creds,
                ...livePatch,
              } as Record<string, unknown>;
              const subscriptionStatus = await getWabaWebhookSubscriptionStatus(
                wabaId,
                accessToken,
                {
                  coexistenceMode: hasWhatsAppBusinessAppConnectionSignal(
                    buildWhatsAppBusinessAppConnectionSignalInput(
                      webhookConnectionCredentials
                    )
                  ),
                }
              );
              successfulMetaReadCount += 1;
              const subscribedFields = subscriptionStatus.fields;
              const coverage = subscriptionStatus.coverage;
              const selectedAppMatchesConfig = Boolean(
                metaAppId &&
                  subscriptionStatus.subscribed &&
                  subscriptionStatus.matchedPreferredApp
              );

              livePatch.waba_subscribed_fields = subscribedFields;
              livePatch.calls_webhook_subscribed =
                selectedAppMatchesConfig && subscribedFields.includes("calls");
              livePatch.waba_selected_app_id = subscriptionStatus.selectedAppId;
              livePatch.waba_selected_app_name =
                subscriptionStatus.selectedAppName;
              livePatch.waba_subscribed_app_ids =
                subscriptionStatus.availableAppIds;
              livePatch.waba_calls_field_present_for_selected_app =
                subscribedFields.includes("calls");
              if (metaAppId) {
                livePatch.waba_selected_app_matches_config =
                  subscriptionStatus.matchedPreferredApp;
              }

              livePatch.webhook_profile_version = coverage.profileVersion;
              livePatch.webhook_required_fields = coverage.requiredFields;
              livePatch.webhook_optional_fields = coverage.optionalFields;
              livePatch.webhook_missing_required_fields =
                coverage.missingRequiredFields;
              livePatch.webhook_missing_optional_fields =
                coverage.missingOptionalFields;
              livePatch.webhook_fields_last_checked_at =
                new Date().toISOString();

              const wabaWebhookHealthy =
                selectedAppMatchesConfig &&
                coverage.missingRequiredFields.length === 0;
              if (wabaWebhookHealthy) {
                livePatch.webhook_requires_reconnect = false;
                livePatch.webhook_error = null;
                livePatch.phone_webhook_error = null;
              }
            } catch (error) {
              failedMetaReadCount += 1;
              if (!captureMetaCircuitError(error)) {
                const message =
                  error instanceof Error
                    ? error.message
                    : "Failed to read WABA subscribed apps";
                livePatch.calls_enablement_error = message;
                livePatch.calls_enablement_actionable =
                  "Reconnect WhatsApp integration and verify WABA webhook subscription permissions.";
              }
            }
          }

          if (!metaReadStopped()) {
            try {
              const phoneNumbersData =
                await graphClient.getJson<WabaPhoneNumbersResponse>(
                  `${wabaId}/phone_numbers`,
                  {
                    token: accessToken,
                    query: { fields: "id" },
                  }
                );
              successfulMetaReadCount += 1;
              const wabaPhoneIds =
                phoneNumbersData.data
                  ?.map(item => readString(item.id))
                  .filter((id): id is string => Boolean(id)) || [];
              livePatch.waba_phone_number_ids = wabaPhoneIds;
              if (phoneNumberId) {
                livePatch.phone_number_in_waba =
                  wabaPhoneIds.includes(phoneNumberId);
              }
            } catch (error) {
              failedMetaReadCount += 1;
              if (!captureMetaCircuitError(error)) {
                livePatch.phone_number_access_error =
                  error instanceof Error
                    ? error.message
                    : "Failed to fetch WABA phone numbers";
              }
            }
          }
        }
      }

      if (!metaReadStopped() && phoneNumberId && accessToken) {
        const checkedAt = new Date().toISOString();
        const callingSettingsResult = await getPhoneCallingSettings(
          phoneNumberId,
          accessToken
        );

        if (callingSettingsResult.success) {
          successfulMetaReadCount += 1;
          Object.assign(
            livePatch,
            buildCallingStatusPatch(
              callingSettingsResult.data,
              { ...creds, ...livePatch },
              checkedAt
            )
          );

          if (
            livePatch.calls_enabled &&
            livePatch.calls_webhook_subscribed === true
          ) {
            livePatch.calls_enablement_error = null;
            livePatch.calls_enablement_actionable = null;
          }
        } else {
          failedMetaReadCount += 1;
          if (!captureMetaCircuitError(callingSettingsResult.error)) {
            livePatch.calls_last_checked_at = checkedAt;
            livePatch.calls_enablement_error =
              callingSettingsResult.error.message;
            livePatch.calls_enablement_actionable =
              callingSettingsResult.error.actionable || null;
          }
        }
      }

      const refreshCompletedAt = new Date();
      const refreshSucceeded =
        !metaRateLimitError &&
        !terminalMetaReadError &&
        successfulMetaReadCount > 0 &&
        failedMetaReadCount === 0;
      const successfulReadPatch = {
        ...livePatch,
        ...buildWhatsAppMetaReadSuccessCredentialPatch(refreshCompletedAt),
      };
      const terminalMetaReadMessage =
        terminalMetaReadError instanceof Error &&
        terminalMetaReadError.message.trim()
          ? terminalMetaReadError.message
          : "Meta rejected the saved WhatsApp authorization.";
      const terminalMetaReadPatch = terminalMetaReadRequiresCustomerReconnect
        ? {
            ...buildWhatsAppMetaAuthorizationCredentialPatch(
              terminalMetaReadError,
              refreshCompletedAt
            ),
            webhook_requires_reconnect: true,
            webhook_error: terminalMetaReadMessage,
          }
        : {};
      const buildCredentialPatch = (
        currentCredentials: Record<string, unknown>
      ): Record<string, unknown> =>
        metaRateLimitError
          ? buildWhatsAppMetaRateLimitCredentialPatch(currentCredentials, {
              error: metaRateLimitError,
              now: refreshCompletedAt,
            })
          : refreshSucceeded
            ? successfulReadPatch
            : {
                ...(terminalMetaReadError ? terminalMetaReadPatch : livePatch),
                ...buildWhatsAppMetaReadFailureCredentialPatch(
                  refreshCompletedAt
                ),
              };
      const applyCredentialPatch = (
        currentCredentials: Record<string, unknown>
      ) => {
        const patch = { ...buildCredentialPatch(currentCredentials) };
        // livePatch was built from the snapshot read before the Meta calls; an
        // offboarding that landed meanwhile must keep the partner app off.
        if (isWhatsAppCloudApiMessagingSuspended(currentCredentials)) {
          delete patch.partner_app_installed;
          delete patch.partner_app_installed_at;
        }
        const patchedCredentials = {
          ...currentCredentials,
          ...patch,
        };
        return refreshSucceeded
          ? mergeWhatsAppAccountHealthCredentials(patchedCredentials)
          : patchedCredentials;
      };
      const credentialPatch = buildCredentialPatch(creds);
      if (metaRateLimitError && wabaId) {
        const cooldownUntil = readString(
          credentialPatch[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]
        );
        if (cooldownUntil) {
          await setCachedWhatsAppMetaReadCooldownUntil(wabaId, cooldownUntil, {
            now: refreshCompletedAt,
          });
        }
      }
      const nextCredentials = refreshSucceeded
        ? mergeWhatsAppAccountHealthCredentials({
            ...creds,
            ...credentialPatch,
          })
        : { ...creds, ...credentialPatch };
      let statusCredentials: Record<string, unknown> = nextCredentials;
      let persistenceSucceeded = true;
      try {
        const updated = await updateCurrentWhatsAppSourceCredentials({
          workspaceId,
          sourceId: source.id,
          expectedWabaId: String(
            normalizeWhatsAppCredentials(creds).wabaId || ""
          ).trim(),
          expectedPhoneNumberId: phoneNumberId || "",
          expectedCredentials: {
            access_token: creds.access_token,
            accessToken: creds.accessToken,
          },
          buildCredentials: applyCredentialPatch,
        });
        statusCredentials = updated.credentials;
        revalidatePath(`/panel/w/${workspaceId}/settings/integrations`);
      } catch (persistError) {
        persistenceSucceeded = false;
        statusCredentials = creds;
        onboardingRouteLogger.error(
          "Failed to persist WhatsApp onboarding status",
          persistError,
          {
            workspaceId,
            sourceId: source.id,
            wabaId: String(
              normalizeWhatsAppCredentials(creds).wabaId || ""
            ).trim(),
          }
        );
      }

      const refreshOutcome: WhatsAppMetaRefreshOutcome = !persistenceSucceeded
        ? "failed"
        : metaRateLimitError
          ? "rate_limited"
          : refreshSucceeded
            ? "succeeded"
            : "failed";
      const cooldownUntil = readString(
        statusCredentials.meta_diagnostics_cooldown_until
      );
      const refreshError = !persistenceSucceeded
        ? "Meta diagnostics refresh could not be saved; serving persisted status."
        : metaRateLimitError
          ? cooldownUntil
            ? `Meta diagnostics are cooling down until ${cooldownUntil}.`
            : "Meta rate-limited the diagnostics refresh."
          : terminalMetaReadError
            ? terminalMetaReadCredentialOwner === "configured_app"
              ? "Meta diagnostics failed because the airi.chat Meta app authorization is unavailable."
              : "Meta rejected the saved WhatsApp authorization. Reconnect WhatsApp and try again."
            : !refreshSucceeded
              ? "Meta diagnostics refresh failed; serving last-known status."
              : undefined;

      return buildConnectedOnboardingResponse(
        statusFromCredentials,
        statusCredentials,
        {
          metaRefresh: {
            requested: explicitRefresh,
            performed: true,
            outcome: refreshOutcome,
            ...(cooldownUntil ? { cooldown_until: cooldownUntil } : {}),
          },
          ...(explicitRefresh && refreshError
            ? {
                error: refreshError,
                httpStatus:
                  persistenceSucceeded && metaRateLimitError ? 429 : 502,
              }
            : {}),
        }
      );
    } finally {
      await releaseWhatsAppMetaReadPermit(metaReadPermit, cache);
    }
  } catch (error) {
    console.error("WhatsApp onboarding status error:", error);
    return NextResponse.json(
      { error: "Failed to fetch onboarding status" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { body, file } = await parseOnboardingRequest(request);

    const workspaceId = body.workspaceId;
    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!body.action) return requiredFieldResponse("action");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const source = await getWorkspaceWhatsAppSource(workspaceId);
    if (!source?.credentials) {
      return NextResponse.json(
        { error: "WhatsApp not connected" },
        { status: 404 }
      );
    }

    const creds = source.credentials as Record<string, unknown>;
    const phoneNumberId = creds?.phone_number_id as string | undefined;
    const accessToken = decryptMaybeString(creds?.access_token);
    const expectedWabaId = String(
      normalizeWhatsAppCredentials(creds).wabaId || ""
    ).trim();

    if (!phoneNumberId || !accessToken) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete" },
        { status: 400 }
      );
    }

    if (body.action === "upload_voicemail_announcement") {
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: "Voicemail announcement file is required" },
          { status: 400 }
        );
      }

      const uploaded = await uploadWhatsAppVoicemailAnnouncementFile({
        phoneNumberId,
        accessToken,
        file,
        description:
          body.description?.trim() || "Default voicemail announcement",
      });
      const now = new Date().toISOString();
      const voicemailPatch = {
        calls_voicemail_announcement_media_id: uploaded.id,
        calls_voicemail_announcement_uploaded_at: now,
        calls_voicemail_announcement_file_name:
          file.name || "voicemail-announcement.ogg",
        calls_voicemail_announcement_file_size_bytes: uploaded.sizeBytes,
        calls_voicemail_announcement_mime_type: uploaded.mimeType,
      };
      const voicemailSource = await updateCurrentWhatsAppSourceCredentials({
        workspaceId,
        sourceId: source.id,
        expectedWabaId,
        buildCredentials: current => ({
          ...current,
          ...voicemailPatch,
        }),
      });
      const credentialsWithVoicemail = voicemailSource.credentials;
      const saveAutoDefaultsCredentials =
        createWhatsAppSourceCredentialSnapshotSaver({
          workspaceId,
          sourceId: source.id,
          currentCredentials: credentialsWithVoicemail,
        });

      const autoDefaultsResult = await runWhatsAppAutoDefaults({
        sourceId: source.id,
        credentials: credentialsWithVoicemail,
        trigger: "onboarding_action",
        force: true,
        saveCredentials: async nextCredentials => {
          await saveAutoDefaultsCredentials(nextCredentials);
        },
      });

      const status = buildWhatsAppOnboardingStatusFromCredentials(
        autoDefaultsResult.credentials
      );

      return NextResponse.json({
        success: true,
        auto_defaults_success: autoDefaultsResult.success,
        upload: uploaded,
        warnings: autoDefaultsResult.warnings,
        status,
        step_results: autoDefaultsResult.stepResults,
      });
    }

    if (body.action === "register_phone") {
      const now = new Date().toISOString();
      const storedBusinessAppSignal = hasWhatsAppBusinessAppConnectionSignal(
        buildWhatsAppBusinessAppConnectionSignalInput(creds)
      );

      const updatedStatus: OnboardingStatus = {
        phone_registered: false,
        phone_registered_at: undefined,
        phone_registration_status: undefined,
        phone_registration_error: null,
      };
      let platformType: string | undefined;
      let manualGuidance: ReturnType<
        typeof buildSmbManualRegistrationGuidance
      > | null = null;

      try {
        const details = await getPhoneNumberDetails(phoneNumberId, accessToken);
        const phoneDetailsPatch = buildWhatsAppPhoneDetailsCredentialPatch(
          details
        );
        Object.assign(updatedStatus, phoneDetailsPatch);
        platformType = phoneDetailsPatch.platform_type;

        const phoneConnectedToCloudApi =
          isWhatsAppPhoneNumberRegistered(details);
        const businessAppSignal = hasWhatsAppBusinessAppConnectionSignal(
          buildWhatsAppBusinessAppConnectionSignalInput(creds, {
            isOnBizApp: details.is_on_biz_app,
            platformType: details.platform_type,
          })
        );

        if (phoneConnectedToCloudApi) {
          updatedStatus.phone_registered = true;
          updatedStatus.phone_registered_at = now;
          updatedStatus.two_step_pin_enabled = true;
        } else if (businessAppSignal) {
          manualGuidance = buildSmbManualRegistrationGuidance();
          updatedStatus.phone_registration_error = manualGuidance.error;
        }
      } catch (error) {
        console.warn(
          "Could not fetch phone status before registration:",
          error
        );
      }

      if (
        !updatedStatus.phone_registered &&
        !manualGuidance &&
        shouldUseManualPhoneRegistrationGuidance({
          phoneRegistered: updatedStatus.phone_registered,
          platformType,
          storedCoexistenceFlagsIndicateSmb: storedBusinessAppSignal,
        })
      ) {
        manualGuidance = buildSmbManualRegistrationGuidance();
        updatedStatus.phone_registration_error = manualGuidance.error;
      }

      if (!updatedStatus.phone_registered && !manualGuidance) {
        const pin = resolveTwoStepPin(body.pin?.trim());
        if (!pin) {
          return NextResponse.json(
            { error: "PIN is required to register the phone number." },
            { status: 400 }
          );
        }

        try {
          await registerPhoneNumberWithPin({
            phoneNumberId,
            pin,
            accessToken,
          });
          updatedStatus.phone_registered = true;
          updatedStatus.phone_registered_at = now;
          updatedStatus.phone_registration_status = "REGISTERED";
          updatedStatus.two_step_pin_enabled = true;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const normalized = errorMessage.toLowerCase();
          const alreadyRegistered =
            normalized.includes("already") && normalized.includes("register");

          if (alreadyRegistered) {
            updatedStatus.phone_registered = true;
            updatedStatus.phone_registered_at = now;
            updatedStatus.phone_registration_status = "REGISTERED";
            updatedStatus.two_step_pin_enabled = true;
          } else if (isSmbRegisterEndpointUnavailable(errorMessage)) {
            manualGuidance = buildSmbManualRegistrationGuidance();
            updatedStatus.phone_registration_error = manualGuidance.error;
          } else {
            updatedStatus.phone_registration_error = errorMessage;
          }
        }
      }

      await updateCurrentWhatsAppSourceCredentials({
        workspaceId,
        sourceId: source.id,
        expectedWabaId,
        buildCredentials: current => ({
          ...current,
          ...updatedStatus,
        }),
      });

      if (manualGuidance) {
        return NextResponse.json(
          {
            success: false,
            status: updatedStatus,
            error: manualGuidance.error,
            actionable: manualGuidance.actionable,
            docs: manualGuidance.docs,
          },
          { status: 409 }
        );
      }

      if (!updatedStatus.phone_registered) {
        return NextResponse.json(
          {
            success: false,
            status: updatedStatus,
            error:
              updatedStatus.phone_registration_error ||
              "Failed to register phone number.",
          },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        status: updatedStatus,
      });
    }

    if (body.action === "send_test_message") {
      const to = (body.to || "").trim();
      const message =
        (body.message || "").trim() || "Message received, loud and clear!";

      if (!to) {
        return NextResponse.json(
          { error: "Recipient phone number is required" },
          { status: 400 }
        );
      }

      const result = await sendWhatsappMessage(
        phoneNumberId,
        accessToken,
        to,
        message
      );

      const now = new Date().toISOString();
      const updatedStatus: OnboardingStatus = {
        last_test_message_at: now,
        last_test_message_to: to,
        last_test_message_id: result.messageId,
      };

      await updateCurrentWhatsAppSourceCredentials({
        workspaceId,
        sourceId: source.id,
        expectedWabaId,
        buildCredentials: current => ({
          ...current,
          ...updatedStatus,
        }),
      });

      return NextResponse.json({ success: true, result });
    }

    if (body.action === "payment_method_prompt") {
      const now = new Date().toISOString();
      const updatedStatus: OnboardingStatus = {
        payment_method_prompted_at: now,
      };

      await updateCurrentWhatsAppSourceCredentials({
        workspaceId,
        sourceId: source.id,
        expectedWabaId,
        buildCredentials: current => ({
          ...current,
          ...updatedStatus,
        }),
      });

      return NextResponse.json({
        success: true,
        links: {
          manager: PAYMENT_MANAGER_URL,
          help: PAYMENT_HELP_URL,
        },
        status: updatedStatus,
      });
    }

    if (body.action === "auto_enable_defaults") {
      const force = Boolean(body.force);
      const trigger = parseAutoDefaultsTrigger(body.trigger);
      const saveAutoDefaultsCredentials =
        createWhatsAppSourceCredentialSnapshotSaver({
          workspaceId,
          sourceId: source.id,
          currentCredentials: creds,
        });

      const autoDefaultsResult = await runWhatsAppAutoDefaults({
        sourceId: source.id,
        credentials: creds,
        trigger,
        force,
        saveCredentials: async nextCredentials => {
          await saveAutoDefaultsCredentials(nextCredentials);
        },
      });

      const status = buildWhatsAppOnboardingStatusFromCredentials(
        autoDefaultsResult.credentials
      );

      return NextResponse.json({
        success: autoDefaultsResult.success,
        warnings: autoDefaultsResult.warnings,
        status,
        step_results: autoDefaultsResult.stepResults,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("WhatsApp onboarding action error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to run action",
      },
      { status: 500 }
    );
  }
}
