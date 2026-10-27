/**
 * Handles account_update webhook events from WhatsApp
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/webhooks#onboarded-business-customer
 * @see https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/
 */

import { mergeWhatsAppAccountHealthCredentials } from "@/lib/whatsapp/account/health";
import {
  recordWhatsAppOnboardingEvent,
  upsertWhatsAppAccountsForSource,
} from "@/lib/whatsapp/account/persistence";
import { createServerLogger } from "@/lib/observability/server-logs";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import {
  invalidateWhatsAppSourceBindingCaches,
  ManagedWhatsAppFlowSourceRebindError,
  updateManagedWhatsAppSourceBinding,
} from "@/lib/whatsapp/flows/source-rebind-guard";
import { resolveWhatsAppSourcesByAccountIdentifiers } from "@/lib/whatsapp/source-resolver";
import type { AccountUpdateValue } from "@icecore/airi-runtime/whatsapp-webhook-runtime";
import {
  buildWhatsAppCredentialAccountPatch,
  stripDeprecatedWhatsAppCredentialAliases,
} from "@icecore/shared/lib/whatsapp/account-identifiers";
import { isWhatsAppCloudApiMessagingSuspended } from "@icecore/shared/lib/whatsapp/source-state";

const accountUpdateLogger = createServerLogger(
  "whatsapp.account-update-handler"
);

function finalizeWhatsAppCredentials(
  credentials: Record<string, unknown>
): Record<string, unknown> {
  stripDeprecatedWhatsAppCredentialAliases(credentials);
  return credentials;
}

type WhatsAppSourceRecord = {
  id: string;
  workspace_id: string;
  company_id: string | null;
  credentials: Record<string, unknown> | null;
};

type AccountUpdateSourceBindingMutation =
  | {
      nextCredentials: Record<string, unknown>;
      buildCredentials?: never;
      nextWabaId?: never;
    }
  | {
      nextCredentials?: never;
      buildCredentials: (
        current: Readonly<Record<string, unknown>>
      ) => Record<string, unknown>;
      nextWabaId: string;
    };

type PersistAccountUpdateSourceBindingParams = {
  source: WhatsAppSourceRecord;
  semanticOperationId: string;
} & AccountUpdateSourceBindingMutation;

async function persistAccountUpdateSourceBinding(
  params: PersistAccountUpdateSourceBindingParams
): Promise<Record<string, unknown>> {
  const currentCredentials = params.source.credentials || {};
  const currentWabaId = String(
    normalizeWhatsAppCredentials(currentCredentials).wabaId || ""
  );
  const sharedParams = {
    workspaceId: params.source.workspace_id,
    sourceId: params.source.id,
    currentWabaId,
    semanticOperationId: params.semanticOperationId,
  };
  const updated =
    typeof params.buildCredentials === "function"
      ? await updateManagedWhatsAppSourceBinding({
          ...sharedParams,
          nextWabaId: params.nextWabaId,
          buildCredentials: params.buildCredentials,
        })
      : await updateManagedWhatsAppSourceBinding({
          ...sharedParams,
          nextWabaId: String(
            normalizeWhatsAppCredentials(params.nextCredentials).wabaId || ""
          ),
          currentCredentials,
          nextCredentials: params.nextCredentials,
        });
  return updated.credentials;
}

async function persistAccountUpdateSourceBindingWithConflictRetry(
  params: PersistAccountUpdateSourceBindingParams,
  retryOnBindingConflict: boolean
): Promise<Record<string, unknown>> {
  try {
    return await persistAccountUpdateSourceBinding(params);
  } catch (error) {
    if (
      !retryOnBindingConflict ||
      !(error instanceof ManagedWhatsAppFlowSourceRebindError)
    ) {
      throw error;
    }

    // A workspace alert dismissal updates the same credentials document. One
    // bounded retry reloads the latest snapshot inside the fence store, then
    // reapplies the reconnect builder so Meta's reconnect cannot be dropped.
    return persistAccountUpdateSourceBinding(params);
  }
}

function toWhatsAppSourceRecord(source: {
  id?: unknown;
  workspace_id?: unknown;
  company_id?: unknown;
  credentials?: unknown;
}): WhatsAppSourceRecord | null {
  if (
    typeof source.id !== "string" ||
    typeof source.workspace_id !== "string"
  ) {
    return null;
  }
  return {
    id: source.id,
    workspace_id: source.workspace_id,
    company_id:
      typeof source.company_id === "string" ? source.company_id : null,
    credentials:
      source.credentials &&
      typeof source.credentials === "object" &&
      !Array.isArray(source.credentials)
        ? (source.credentials as Record<string, unknown>)
        : {},
  };
}

async function findWhatsAppSourcesForAccountUpdate(
  wabaInfo: AccountUpdateValue["waba_info"]
): Promise<WhatsAppSourceRecord[]> {
  if (!wabaInfo?.waba_id) return [];

  const identityPatch = buildAccountUpdateIdentityPatch(wabaInfo);
  const sources = await resolveWhatsAppSourcesByAccountIdentifiers({
    wabaId: wabaInfo.waba_id,
    messagingAccountId: identityPatch.messaging_account_id,
    waacId: identityPatch.waac_id,
    csId: identityPatch.cs_id,
  });

  return sources
    .map(toWhatsAppSourceRecord)
    .filter((source): source is WhatsAppSourceRecord => Boolean(source));
}

async function persistAccountUpdateSideEffects(params: {
  eventType: string;
  source: WhatsAppSourceRecord;
  credentials: Record<string, unknown>;
  payload?: Record<string, unknown>;
}) {
  invalidateWhatsAppSourceBindingCaches({
    sourceId: params.source.id,
    workspaceId: params.source.workspace_id,
  });
  await upsertWhatsAppAccountsForSource({
    sourceId: params.source.id,
    workspaceId: params.source.workspace_id,
    // The upsert overwrites company_id, so omitting it would null the column.
    companyId: params.source.company_id,
    credentials: params.credentials,
    isDefault: true,
  });
  await recordWhatsAppOnboardingEvent({
    eventType: params.eventType,
    eventSource: "account_update",
    workspaceId: params.source.workspace_id,
    sourceId: params.source.id,
    accountIdentifiers: params.credentials,
    payload: params.payload,
  });
}

function buildAccountUpdateIdentityPatch(
  wabaInfo: AccountUpdateValue["waba_info"]
) {
  return buildWhatsAppCredentialAccountPatch({
    waba_id: wabaInfo?.waba_id,
    messaging_account_id: wabaInfo?.messaging_account_id || wabaInfo?.waba_id,
    waac_id: wabaInfo?.waac_id,
    cs_id: wabaInfo?.cs_id,
    business_id: wabaInfo?.owner_business_id,
  });
}

async function updateWhatsAppSourcesForAccountUpdate({
  event,
  wabaInfo,
  buildCredentials,
  buildEventPayload,
  retryOnBindingConflict = false,
}: {
  event: string;
  wabaInfo?: AccountUpdateValue["waba_info"];
  buildCredentials: (
    credentials: Record<string, unknown>,
    now: string
  ) => Record<string, unknown>;
  buildEventPayload?: (source: WhatsAppSourceRecord) => Record<string, unknown>;
  retryOnBindingConflict?: boolean;
}) {
  if (!wabaInfo?.waba_id) {
    console.info("WhatsApp account_update missing WABA id", { event });
    return;
  }

  const sources = await findWhatsAppSourcesForAccountUpdate(wabaInfo);

  if (sources.length === 0) {
    console.info("WhatsApp account_update arrived before source persistence", {
      event,
      wabaId: wabaInfo.waba_id,
      outcome: "source_not_found",
    });
    return;
  }

  const now = new Date().toISOString();
  for (const source of sources as WhatsAppSourceRecord[]) {
    let persistedCredentials: Record<string, unknown>;
    try {
      persistedCredentials =
        await persistAccountUpdateSourceBindingWithConflictRetry(
          {
            source,
            nextWabaId: wabaInfo.waba_id,
            buildCredentials: current =>
              finalizeWhatsAppCredentials(
                buildCredentials({ ...current }, now)
              ),
            semanticOperationId: `account-update:${event}:${wabaInfo.waba_id}`,
          },
          retryOnBindingConflict
        );
    } catch (updateError) {
      accountUpdateLogger.error(
        "Failed to update WhatsApp source from account_update",
        updateError,
        {
          event,
          wabaId: wabaInfo.waba_id,
          sourceId: source.id,
          workspaceId: source.workspace_id,
        }
      );
      continue;
    }

    await persistAccountUpdateSideEffects({
      eventType: event,
      source,
      credentials: persistedCredentials,
      payload: {
        wabaId: wabaInfo.waba_id,
        ...buildEventPayload?.(source),
      },
    });

    console.info("Updated WhatsApp source from account_update", {
      event,
      sourceId: source.id,
      workspaceId: source.workspace_id,
      wabaId: wabaInfo.waba_id,
    });
  }
}

function buildOffboardedCredentials(
  credentials: Record<string, unknown>,
  wabaInfo: AccountUpdateValue["waba_info"],
  now: string,
  event = "ACCOUNT_OFFBOARDED",
  disconnectionInfo?: AccountUpdateValue["disconnection_info"]
) {
  const status = event === "PARTNER_REMOVED" ? "removed" : "offboarded";
  // offboarded_at marks when the latest suspension began: a new one starts
  // only when the source is not suspended already (e.g. after a reconnect).
  const suspensionStartedAt = isWhatsAppCloudApiMessagingSuspended(credentials)
    ? credentials.coexistence_reonboarding_offboarded_at || now
    : now;
  return mergeWhatsAppAccountHealthCredentials({
    ...credentials,
    ...buildAccountUpdateIdentityPatch(wabaInfo),
    // Only coexistence numbers are offboarded; PARTNER_REMOVED can also reach a
    // plain Cloud API source, which must keep its connection type.
    ...(event === "ACCOUNT_OFFBOARDED" ? { coexistence_mode: true } : {}),
    partner_app_installed: false,
    cloud_api_messaging_suspended: true,
    coexistence_reonboarding_status: status,
    coexistence_reonboarding_event: event,
    coexistence_reonboarding_offboarded_at: suspensionStartedAt,
    ...(event === "PARTNER_REMOVED"
      ? {
          coexistence_reonboarding_removed_at:
            credentials.coexistence_reonboarding_removed_at || now,
          ...(disconnectionInfo?.reason
            ? { partner_removed_reason: disconnectionInfo.reason }
            : {}),
          ...(disconnectionInfo?.initiated_by
            ? { partner_removed_initiated_by: disconnectionInfo.initiated_by }
            : {}),
        }
      : {}),
    coexistence_reonboarding_last_event_at: now,
    diagnostics_last_checked_at: now,
  });
}

export async function handleAccountUpdateWebhook(value: AccountUpdateValue) {
  const { event, waba_info, disconnection_info, phone_number, ban_info } =
    value;
  const normalizedEvent = event.trim().toUpperCase();

  console.log("Account update webhook received:", {
    event,
    waba_info,
    phone_number,
    ban_info,
  });

  switch (normalizedEvent) {
    case "PARTNER_ADDED":
      // Customer successfully completed Embedded Signup
      // Per Meta docs: This event is triggered when a customer completes Embedded Signup
      // and your app is added as a partner to their WABA
      if (waba_info) {
        console.log("✅ New customer onboarded via Embedded Signup:", {
          wabaId: waba_info.waba_id,
          businessId: waba_info.owner_business_id,
          partnerAppId: waba_info.partner_app_id,
        });

        // Update source record to mark onboarding as complete
        try {
          const sources = await findWhatsAppSourcesForAccountUpdate(waba_info);

          if (sources.length > 0) {
            for (const source of sources) {
              const credentials = source.credentials || {};
              const nextCredentials = finalizeWhatsAppCredentials({
                ...credentials,
                ...buildAccountUpdateIdentityPatch(waba_info),
                onboarding_completed: true,
                onboarding_completed_at: new Date().toISOString(),
                partner_app_id: waba_info.partner_app_id,
              });
              let persistedCredentials: Record<string, unknown>;
              try {
                persistedCredentials = await persistAccountUpdateSourceBinding({
                  source,
                  nextCredentials,
                  semanticOperationId: `account-update:${normalizedEvent}:${waba_info.waba_id}`,
                });
              } catch (updateError) {
                accountUpdateLogger.error(
                  "Failed to update WhatsApp onboarding completion status",
                  updateError,
                  {
                    sourceId: source.id,
                    workspaceId: source.workspace_id,
                    wabaId: waba_info.waba_id,
                    event: normalizedEvent,
                  }
                );
                continue;
              }
              await persistAccountUpdateSideEffects({
                eventType: normalizedEvent,
                source,
                credentials: persistedCredentials,
                payload: { waba_info, phone_number },
              });

              console.log(
                `✅ Updated source ${source.id} with onboarding completion status`
              );
            }
          } else {
            console.info(
              "WhatsApp account_update arrived before source persistence",
              {
                event,
                wabaId: waba_info.waba_id,
                businessId: waba_info.owner_business_id,
                partnerAppId: waba_info.partner_app_id,
                outcome: "deferred_to_callback",
              }
            );
          }
        } catch (error) {
          console.error("Error updating source with onboarding status:", error);
          // Don't fail the webhook - log and continue
        }

        // TODO: Send notification to workspace owner about successful onboarding
        // TODO: Track onboarding metrics for analytics
      }
      break;

    case "PARTNER_APP_INSTALLED":
      // App installed/connected to WABA (coexistence mode - WhatsApp Business app + Platform API)
      // Per Meta docs: This event occurs when your app is successfully connected to an existing WABA
      // that was created via WhatsApp Business app (coexistence mode)
      if (waba_info) {
        console.log("✅ Partner app installed on WABA:", {
          wabaId: waba_info.waba_id,
          businessId: waba_info.owner_business_id,
          partnerAppId: waba_info.partner_app_id,
        });

        // Update source record to confirm coexistence mode connection
        try {
          const sources = await findWhatsAppSourcesForAccountUpdate(waba_info);

          if (sources.length > 0) {
            for (const source of sources) {
              const credentials = source.credentials || {};
              const nextCredentials = finalizeWhatsAppCredentials({
                ...credentials,
                ...buildAccountUpdateIdentityPatch(waba_info),
                coexistence_mode: true,
                partner_app_installed: true,
                partner_app_installed_at: new Date().toISOString(),
                partner_app_id: waba_info.partner_app_id,
              });
              let persistedCredentials: Record<string, unknown>;
              try {
                persistedCredentials = await persistAccountUpdateSourceBinding({
                  source,
                  nextCredentials,
                  semanticOperationId: `account-update:${normalizedEvent}:${waba_info.waba_id}`,
                });
              } catch (updateError) {
                accountUpdateLogger.error(
                  "Failed to update WhatsApp partner app status",
                  updateError,
                  {
                    sourceId: source.id,
                    workspaceId: source.workspace_id,
                    wabaId: waba_info.waba_id,
                    event: normalizedEvent,
                  }
                );
                continue;
              }
              await persistAccountUpdateSideEffects({
                eventType: normalizedEvent,
                source,
                credentials: persistedCredentials,
                payload: { waba_info, phone_number },
              });

              console.log(
                `✅ Updated source ${source.id} with coexistence mode status`
              );
            }
          } else {
            console.info(
              "WhatsApp account_update arrived before source persistence",
              {
                event,
                wabaId: waba_info.waba_id,
                businessId: waba_info.owner_business_id,
                partnerAppId: waba_info.partner_app_id,
                outcome: "deferred_to_callback",
              }
            );
          }
        } catch (error) {
          console.error(
            "Error updating source with partner app status:",
            error
          );
          // Don't fail the webhook - log and continue
        }

        // TODO: Notify workspace owner about successful connection
      }
      break;

    case "ONBOARDING":
      // Customer onboarding process started or completed
      // This can occur during Embedded Signup flow
      if (waba_info) {
        console.log("✅ Customer onboarding event:", {
          wabaId: waba_info.waba_id,
          businessId: waba_info.owner_business_id,
          partnerAppId: waba_info.partner_app_id,
        });
        // TODO: Track onboarding progress
        // TODO: Update source status if needed
      } else {
        console.log("Onboarding event received (no WABA info yet)");
      }
      break;

    case "VERIFIED_ACCOUNT":
      // Sandbox number upgraded to verified account
      console.log("Account verified:", phone_number);
      break;

    case "DISABLED_UPDATE":
      // Account banned or disabled
      // Per Meta docs: This event indicates the WABA has been banned or disabled
      if (waba_info && ban_info) {
        console.warn("⚠️ WABA disabled/banned:", {
          wabaId: waba_info.waba_id,
          banState: ban_info.waba_ban_state,
          banDate: ban_info.waba_ban_date,
        });

        // Update source record to mark as disabled
        try {
          const sources = await findWhatsAppSourcesForAccountUpdate(waba_info);

          if (sources.length > 0) {
            for (const source of sources) {
              const credentials = source.credentials || {};
              const nextCredentials = finalizeWhatsAppCredentials({
                ...credentials,
                ...buildAccountUpdateIdentityPatch(waba_info),
                waba_banned: true,
                waba_ban_state: ban_info.waba_ban_state,
                waba_ban_date: ban_info.waba_ban_date,
                banned_at: new Date().toISOString(),
              });
              const healthCredentials = finalizeWhatsAppCredentials(
                mergeWhatsAppAccountHealthCredentials(nextCredentials)
              );
              let persistedCredentials: Record<string, unknown>;
              try {
                persistedCredentials = await persistAccountUpdateSourceBinding({
                  source,
                  nextCredentials: healthCredentials,
                  semanticOperationId: `account-update:${normalizedEvent}:${waba_info.waba_id}`,
                });
              } catch (updateError) {
                accountUpdateLogger.error(
                  "Failed to update WhatsApp source ban status",
                  updateError,
                  {
                    sourceId: source.id,
                    workspaceId: source.workspace_id,
                    wabaId: waba_info.waba_id,
                    event: normalizedEvent,
                  }
                );
                continue;
              }
              await persistAccountUpdateSideEffects({
                eventType: normalizedEvent,
                source,
                credentials: persistedCredentials,
                payload: { waba_info, ban_info },
              });

              console.warn(
                `⚠️ Updated source ${source.id} with ban status - workspace ${source.workspace_id}`
              );
            }
          }
        } catch (error) {
          console.error("Error updating source with ban status:", error);
        }

        // TODO: Notify workspace owner about account ban
      }
      break;

    case "ACCOUNT_OFFBOARDED":
      await updateWhatsAppSourcesForAccountUpdate({
        event: normalizedEvent,
        wabaInfo: waba_info,
        buildCredentials: (credentials, now) =>
          buildOffboardedCredentials(credentials, waba_info, now),
      });
      break;

    case "PARTNER_REMOVED":
      await updateWhatsAppSourcesForAccountUpdate({
        event: normalizedEvent,
        wabaInfo: waba_info,
        buildCredentials: (credentials, now) =>
          buildOffboardedCredentials(
            credentials,
            waba_info,
            now,
            "PARTNER_REMOVED",
            disconnection_info
          ),
        buildEventPayload: source => ({
          removedSourceId: source.id,
          disconnectionInfo: disconnection_info || null,
        }),
      });
      break;

    case "ACCOUNT_RECONNECTED":
      await updateWhatsAppSourcesForAccountUpdate({
        event: normalizedEvent,
        wabaInfo: waba_info,
        retryOnBindingConflict: true,
        buildCredentials: (credentials, now) =>
          mergeWhatsAppAccountHealthCredentials({
            ...credentials,
            ...buildAccountUpdateIdentityPatch(waba_info),
            coexistence_mode: true,
            partner_app_installed: true,
            partner_app_installed_at: now,
            onboarding_completed: true,
            onboarding_completed_at: credentials.onboarding_completed_at || now,
            cloud_api_messaging_suspended: false,
            coexistence_reonboarding_status: "reconnected",
            coexistence_reonboarding_event: "ACCOUNT_RECONNECTED",
            coexistence_reonboarding_reconnected_at: now,
            coexistence_reonboarding_last_event_at: now,
            coexistence_reonboarding_removed_at: null,
            partner_removed_alert_dismissed_at: null,
            partner_removed_alert_dismissed_by: null,
            partner_removed_alert_dismissed_for: null,
            partner_removed_initiated_by: null,
            partner_removed_reason: null,
            diagnostics_last_checked_at: now,
          }),
      });
      break;

    default:
      console.log("Unknown account_update event:", event);
  }

  return new Response("OK", { status: 200 });
}
