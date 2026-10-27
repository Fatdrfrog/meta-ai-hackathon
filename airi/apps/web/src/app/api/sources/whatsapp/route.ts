import { runWhatsAppPostConnectSetup } from "@/lib/whatsapp/post-connect";
import { randomUUID } from "node:crypto";
import {
  buildEmbeddedSignupConnectionModePatch,
  isSmbPlatformType,
} from "@icecore/shared/lib/whatsapp/phone-registration-mode";
import { getPhoneNumberDetails } from "@/lib/whatsapp/qr-code-service";
import { prepareWhatsAppHistorySyncSession } from "@/lib/whatsapp/history-sync/lifecycle";
import { buildWhatsAppTokenMetadataPatch } from "@/lib/whatsapp/token-lifecycle";
import { trackSourceConnected } from "@/lib/analytics";
import { captureFunnelEvent } from "@/lib/funnel-analytics";
import { encryptString } from "@/lib/crypto";
import { getMetaServerAppConfig } from "@/lib/meta/app-config";
import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import {
  buildCompanyChannelLimitExceededResponse,
  ensureCompanyChannelCapacity,
} from "@/lib/limits/company-limits";
import { flushServerPostHog } from "@/lib/posthog/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCompanyIdForWorkspace } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { findWhatsAppPhoneOwner } from "@/lib/whatsapp/account/inventory";
import {
  recordWhatsAppOnboardingEvent,
  upsertWhatsAppAccountsForSource,
} from "@/lib/whatsapp/account/persistence";
import { resolveCompanyWhatsAppAccessToken } from "@/lib/whatsapp/company-access-token";
import {
  clearWhatsAppSelectionSessionCookie,
  readWhatsAppSelectionSessionToken,
} from "@/lib/whatsapp/embedded-signup-selection-session";
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
import { resolveWhatsAppSourceByAccountIdentifiers } from "@/lib/whatsapp/source-resolver";
import { hasWhatsAppAccess } from "@/lib/whatsapp/token-maintenance";
import {
  getAllWABAs,
  subscribeToWABAWebhooks,
  validateWABAAccess,
} from "@/lib/whatsapp/waba-service";
import {
  getWhatsAppGraphClient,
  isMetaGraphAuthorizationError,
} from "@icecore/shared/lib/meta/api";
import { evaluateMetaAccessToken } from "@icecore/shared/lib/meta/debug-token";
import {
  buildWhatsAppCredentialAccountPatch,
  stripDeprecatedWhatsAppCredentialAliases,
} from "@icecore/shared/lib/whatsapp/account-identifiers";
import {
  isRemovedWhatsAppSource,
  isWhatsAppCloudApiMessagingSuspended,
} from "@icecore/shared/lib/whatsapp/source-state";
import { NextRequest, NextResponse } from "next/server";
import { hasProtectedWhatsAppConversionFields } from "@/lib/conversions/source-config";

const graphClient = getWhatsAppGraphClient();

function buildPartnerRemovalReconnectPatch(
  currentCredentials: Record<string, unknown>,
  embeddedSignupFlow: "cloud_api" | "coexistence" | undefined
): Record<string, unknown> {
  const coexistence =
    embeddedSignupFlow === "coexistence" ||
    (embeddedSignupFlow !== "cloud_api" &&
      currentCredentials.coexistence_mode === true);
  return {
    ...buildWhatsAppReconnectedCredentialPatch(),
    // A suspended Business app number counts as disconnected until the
    // partner app is marked installed again.
    ...(coexistence && {
      coexistence_mode: true,
      partner_app_installed: true,
      partner_app_installed_at: new Date().toISOString(),
    }),
  };
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const body = await request.json();
  if (hasProtectedWhatsAppConversionFields(body)) {
    return NextResponse.json(
      {
        error:
          "Use WhatsApp conversion settings to configure sales feedback and webhook credentials.",
      },
      { status: 400 }
    );
  }
  const {
    phone_number_id,
    cs_id,
    waba_id,
    messaging_account_id,
    waac_id,
    access_token,
    workspace_id,
    display_phone_number,
    embedded_signup,
    embedded_signup_flow,
    embedded_signup_event,
    business_id,
    catalog_ids,
    intent,
  } = body;
  const accountPatch = buildWhatsAppCredentialAccountPatch({
    phone_number_id,
    cs_id,
    waba_id,
    messaging_account_id: messaging_account_id || waba_id,
    waac_id,
  });
  const resolvedPhoneNumberId = accountPatch.phone_number_id;
  const resolvedWabaId = accountPatch.waba_id;

  if (!resolvedPhoneNumberId || !resolvedWabaId) {
    return new Response(
      JSON.stringify({ error: "WhatsApp account identifiers are required" }),
      { status: 400 }
    );
  }
  if (!workspace_id) {
    return new Response(JSON.stringify({ error: "workspace_id is required" }), {
      status: 400,
    });
  }

  // Verify user has access to this workspace
  const { data: access } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspace_id)
    .maybeSingle();

  if (!access) {
    return new Response(
      JSON.stringify({ error: "Access denied to this workspace" }),
      { status: 403 }
    );
  }

  const { fetchSourceWithCredentials } = await import("@/lib/sources/utils");

  try {
    const companyId = await getCompanyIdForWorkspace(
      supabase,
      access.workspace_id
    );
    if (!companyId) {
      return new Response(
        JSON.stringify({ error: "Workspace company not found" }),
        { status: 400 }
      );
    }

    const resolvedAccessToken = await resolveCompanyWhatsAppAccessToken({
      companyId,
      explicitAccessToken:
        (typeof access_token === "string" && access_token) ||
        readWhatsAppSelectionSessionToken(request, {
          workspaceId: access.workspace_id,
          userId: user.id,
        }),
    });

    if (!resolvedAccessToken) {
      return NextResponse.json(
        {
          error: "reauthorization_required",
          message:
            "Reconnect WhatsApp with Meta before choosing another number for this workspace.",
        },
        { status: 409 }
      );
    }

    const appConfig = getMetaServerAppConfig();
    const dbg = await debugConfiguredMetaAccessToken(resolvedAccessToken, {
      appConfig,
    });
    const tokenValidation = evaluateMetaAccessToken(dbg, {
      appId: appConfig.appId,
    });
    if (!tokenValidation.valid) {
      return NextResponse.json(
        { error: tokenValidation.error || "Invalid WhatsApp access token" },
        { status: 400 }
      );
    }
    // Any app-valid token passes the check above, and the ids come from the
    // request body. Prove this token reaches the WABA and the number is on it,
    // as select-waba does, or a member could bind another tenant's number and
    // take over its inbound routing.
    const wabaAccess = await validateWABAAccess(
      resolvedWabaId,
      resolvedAccessToken
    );
    if (!wabaAccess.valid) {
      return NextResponse.json(
        { error: "invalid_waba", message: wabaAccess.error },
        { status: 400 }
      );
    }
    if (
      !wabaAccess.phoneNumbers?.some(
        phone => phone.id === resolvedPhoneNumberId
      )
    ) {
      return NextResponse.json(
        {
          error: "phone_not_in_waba",
          message:
            "This WhatsApp number is not on the WhatsApp Business Account for this token.",
        },
        { status: 400 }
      );
    }
    const tokenMetadataPatch = {
      ...buildWhatsAppTokenMetadataPatch(dbg, { appId: appConfig.appId }),
      token_last_refresh_attempt_at: null,
      meta_diagnostics_reconnect_reason: null,
    };

    const enc = encryptString(resolvedAccessToken);
    const displayName = display_phone_number || resolvedPhoneNumberId;
    const catalogIds = Array.isArray(catalog_ids)
      ? catalog_ids
          .map(value => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean)
      : [];
    const businessId =
      typeof business_id === "string" && business_id.trim()
        ? business_id.trim()
        : dbg.business_id;
    const embeddedSignupFlow =
      embedded_signup_flow === "cloud_api" ||
      embedded_signup_flow === "coexistence"
        ? embedded_signup_flow
        : undefined;
    const embeddedSignupEvent =
      typeof embedded_signup_event === "string" && embedded_signup_event.trim()
        ? embedded_signup_event.trim()
        : undefined;
    // Set when the number picker finishes an "Upgrade to Cloud API" signup.
    const isUpgradeIntent = intent === "upgrade";
    // The signup callback saves what Meta reports about the number before
    // post-connect decides Cloud API registration. Stored Business app
    // signals can belong to the previous number or predate a migration, so
    // a Cloud API save reads them the same way.
    let phoneSignalsPatch: Record<string, unknown> | null = null;
    let numberLeftBusinessApp = false;
    if (embeddedSignupFlow === "cloud_api") {
      try {
        const details = await getPhoneNumberDetails(
          resolvedPhoneNumberId,
          resolvedAccessToken
        );
        phoneSignalsPatch = {
          is_on_biz_app:
            typeof details.is_on_biz_app === "boolean"
              ? details.is_on_biz_app
              : null,
          platform_type: details.platform_type || null,
        };
        numberLeftBusinessApp =
          details.is_on_biz_app !== true &&
          !isSmbPlatformType(details.platform_type);
      } catch (error) {
        console.warn("WhatsApp phone details unavailable during save:", {
          workspaceId: workspace_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const embeddedSignupPatch =
      embedded_signup || embeddedSignupFlow
        ? {
            embedded_signup: true,
            ...(embeddedSignupFlow && {
              embedded_signup_flow: embeddedSignupFlow,
            }),
            ...(embeddedSignupEvent && {
              embedded_signup_event: embeddedSignupEvent,
            }),
          }
        : {};
    const catalogPatch =
      embeddedSignupFlow || catalogIds.length > 0
        ? { catalog_ids: catalogIds }
        : {};
    const cloudApiModePatch =
      embeddedSignupFlow === "cloud_api"
        ? {
            coexistence_mode: false,
            partner_app_installed: false,
          }
        : {};

    // Check if source already exists (reconnection scenario)
    // First check by workspace_id + type (most common case) using filters
    const existingByWorkspace = await fetchSourceWithCredentials(
      undefined,
      "whatsapp",
      {
        workspace_id: workspace_id,
      }
    );

    // Also check if a source exists with the same waba_id or phone_number_id
    // This catches cases where user reconnects and selects the same number
    let existingByWaba = null;
    if (!existingByWorkspace) {
      existingByWaba = await resolveWhatsAppSourceByAccountIdentifiers({
        workspaceId: access.workspace_id,
        phoneNumberId: resolvedPhoneNumberId,
        csId: accountPatch.cs_id,
        wabaId: resolvedWabaId,
        messagingAccountId: accountPatch.messaging_account_id,
        waacId: accountPatch.waac_id,
      });
    }

    const existing = existingByWorkspace || existingByWaba;
    const existingOwner = await findWhatsAppPhoneOwner({
      companyId,
      phoneNumberId: resolvedPhoneNumberId,
      currentWorkspaceId: access.workspace_id,
      currentSourceId: existing?.id,
    });
    if (existingOwner) {
      const workspaceName =
        existingOwner.workspaceName || existingOwner.workspaceId;
      return NextResponse.json(
        {
          error: "phone_already_connected",
          message: `This WhatsApp number is already connected to ${workspaceName}. Choose another number or transfer it explicitly.`,
          conflict: {
            phone_number_id: resolvedPhoneNumberId,
            source_id: existingOwner.sourceId,
            workspace_id: existingOwner.workspaceId,
            workspace_name: existingOwner.workspaceName,
          },
        },
        { status: 409 }
      );
    }
    // PARTNER_REMOVED strips our grant, so a token that again holds both
    // WhatsApp permissions for this WABA proves a fresh partner grant (e.g. an
    // Embedded Signup finished in the number picker). Without one the source
    // would stay suspended, so ask for a real reconnect instead of saving.
    const reconnectsRemovedSource = Boolean(
      existing?.id && isRemovedWhatsAppSource(existing)
    );
    const removedSourceAccessGranted = reconnectsRemovedSource
      ? await hasWhatsAppAccess(dbg, resolvedAccessToken, resolvedWabaId).catch(
          error => {
            // Only an authorization failure means the grant is missing;
            // transient Graph errors fail the request like token checks do.
            if (isMetaGraphAuthorizationError(error)) return false;
            throw error;
          }
        )
      : true;
    if (!removedSourceAccessGranted) {
      return NextResponse.json(
        {
          error: "reauthorization_required",
          message:
            "Meta removed airi.chat's access to this WhatsApp account. Reconnect it with Meta before choosing a number.",
        },
        { status: 409 }
      );
    }
    let sourceId: string;
    let credentialsForDefaults: Record<string, unknown>;
    let created = false;
    const historySession = {
      sessionId: randomUUID(),
      startedAt: new Date().toISOString(),
      embeddedSignupCompleted:
        embeddedSignupEvent === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    };

    if (existing?.id) {
      const existingCreds =
        (existing.credentials as Record<string, unknown>) || {};

      try {
        const updated = await updateManagedWhatsAppSourceBinding({
          workspaceId: access.workspace_id,
          sourceId: existing.id,
          currentWabaId: String(
            normalizeWhatsAppCredentials(existingCreds).wabaId || ""
          ),
          nextWabaId: resolvedWabaId,
          semanticOperationId: `source-connect:${resolvedWabaId}:${resolvedPhoneNumberId}`,
          sourcePatch: { name: `WhatsApp (${displayName})` },
          buildCredentials: currentCredentials => {
            const nextCredentials: Record<string, unknown> = {
              ...resetWhatsAppPhoneScopedState(
                currentCredentials,
                resolvedPhoneNumberId
              ),
              ...accountPatch,
              access_token: enc,
              ...tokenMetadataPatch,
              ...(businessId && { business_id: businessId }),
              ...catalogPatch,
              ...embeddedSignupPatch,
              ...cloudApiModePatch,
              ...(reconnectsRemovedSource &&
                isWhatsAppCloudApiMessagingSuspended(currentCredentials) &&
                buildPartnerRemovalReconnectPatch(
                  currentCredentials,
                  embeddedSignupFlow
                )),
            };
            stripDeprecatedWhatsAppCredentialAliases(nextCredentials);
            // The binding store merges onto the stored row, so a signal that
            // must go away is written as null rather than deleted.
            const previousNumberSignals =
              embeddedSignupFlow === "cloud_api" &&
              normalizeWhatsAppCredentials(currentCredentials).phoneNumberId !==
                resolvedPhoneNumberId
                ? { is_on_biz_app: null, platform_type: null }
                : {};
            Object.assign(
              nextCredentials,
              phoneSignalsPatch ?? previousNumberSignals,
              buildEmbeddedSignupConnectionModePatch({
                previousCredentials: currentCredentials,
                leavesCoexistence: numberLeftBusinessApp,
                upgradeIntent: isUpgradeIntent,
              })
            );
            return prepareWhatsAppHistorySyncSession({
              ...historySession,
              current: currentCredentials,
              next: nextCredentials,
            });
          },
        });
        credentialsForDefaults = updated.credentials;
      } catch (error) {
        if (error instanceof ManagedWhatsAppFlowSourceRebindError) {
          return NextResponse.json(
            { error: error.code, message: error.message },
            { status: 409 }
          );
        }
        throw error;
      }
      sourceId = existing.id;
    } else {
      const channelCapacity = await ensureCompanyChannelCapacity(
        supabaseAdmin,
        access.workspace_id,
        "whatsapp"
      );
      if (!channelCapacity.allowed) {
        return buildCompanyChannelLimitExceededResponse(channelCapacity.limit);
      }

      credentialsForDefaults = {
        ...accountPatch,
        access_token: enc,
        ...tokenMetadataPatch,
        ...(businessId && { business_id: businessId }),
        ...catalogPatch,
        ...embeddedSignupPatch,
        ...cloudApiModePatch,
      };
      stripDeprecatedWhatsAppCredentialAliases(credentialsForDefaults);
      credentialsForDefaults = prepareWhatsAppHistorySyncSession({
        ...historySession,
        current: {},
        next: credentialsForDefaults,
      });

      // Clients may not write WhatsApp rows directly; the workspace and
      // company come from the membership verified above.
      const { data, error } = await supabaseAdmin
        .from("sources")
        .insert({
          company_id: companyId,
          workspace_id: access.workspace_id,
          type: "whatsapp",
          name: `WhatsApp (${displayName})`,
          credentials: credentialsForDefaults,
        })
        .select("id")
        .single();

      if (error) throw error;
      if (!data?.id) throw new Error("Failed to create WhatsApp source.");
      sourceId = data.id;
      created = true;
    }

    if (created) {
      invalidateWhatsAppSourceBindingCaches({
        workspaceId: access.workspace_id,
        sourceId,
      });
    }

    await upsertWhatsAppAccountsForSource({
      sourceId,
      workspaceId: access.workspace_id,
      companyId,
      credentials: credentialsForDefaults,
      isDefault: true,
    });
    await recordWhatsAppOnboardingEvent({
      eventType: created ? "source_connected" : "source_reconnected",
      eventSource: embeddedSignupPatch.embedded_signup
        ? "embedded_signup_api"
        : "manual_source_api",
      workspaceId: access.workspace_id,
      companyId,
      sourceId,
      accountIdentifiers: credentialsForDefaults,
      payload: {
        upgrade_intent: isUpgradeIntent,
        embedded_signup: Boolean(embeddedSignupPatch.embedded_signup),
        embedded_signup_flow: embeddedSignupFlow || null,
        ...(reconnectsRemovedSource && {
          partner_removal_cleared: !isWhatsAppCloudApiMessagingSuspended(
            credentialsForDefaults
          ),
        }),
      },
    });
    trackSourceConnected(
      companyId,
      access.workspace_id,
      "whatsapp",
      created ? "connected" : "reconnected"
    );
    await captureFunnelEvent({
      event: "whatsapp_connected",
      userId: user.id,
      workspaceId: access.workspace_id,
      companyId,
      properties: {
        path: embeddedSignupPatch.embedded_signup ? "select_waba" : "manual",
        flow: embeddedSignupFlow || null,
        reconnect: !created,
      },
    });
    await flushServerPostHog();

    const {
      autoDefaults,
      contactSync: autoContactSync,
      catalogSetup: autoCatalogSetup,
      historySync: autoHistorySync,
    } = await runWhatsAppPostConnectSetup({
      sourceId,
      workspaceId: access.workspace_id,
      credentials: credentialsForDefaults,
      trigger: "source_connect",
      saveCredentials: createWhatsAppSourceCredentialSnapshotSaver({
        sourceId,
        workspaceId: access.workspace_id,
        expectedPhoneNumberId: resolvedPhoneNumberId,
        currentCredentials: credentialsForDefaults,
      }),
    });

    if (autoHistorySync?.error && !autoHistorySync.skipped) {
      console.warn("Auto history sync request failed after WhatsApp connect:", {
        workspaceId: access.workspace_id,
        sourceId,
        reason: autoHistorySync.reason,
        error: autoHistorySync.error,
        errorCode: autoHistorySync.errorCode,
      });
    }

    const response = NextResponse.json({
      success: true,
      ...(created ? { created: true } : { updated: true }),
      auto_defaults: {
        attempted: autoDefaults.attempted,
        success: autoDefaults.success,
        warnings: autoDefaults.warnings,
        status: autoDefaults.status,
      },
      auto_contact_sync: autoContactSync,
      auto_catalog_setup: autoCatalogSetup,
      auto_history_sync: autoHistorySync,
    });
    clearWhatsAppSelectionSessionCookie(response);
    return response;
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
    });
  }
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const { access_token, workspace_id } = await request.json();
  if (!access_token) {
    return new Response(
      JSON.stringify({ error: "A new access token is required" }),
      { status: 400 }
    );
  }
  if (!workspace_id) {
    return new Response(JSON.stringify({ error: "workspace_id is required" }), {
      status: 400,
    });
  }

  const { fetchSourceWithCredentials, verifyWorkspaceAccess } = await import(
    "@/lib/sources/utils"
  );

  // Verify user has access to this workspace
  const hasAccess = await verifyWorkspaceAccess(
    supabase,
    user.id,
    workspace_id
  );

  if (!hasAccess) {
    return new Response(
      JSON.stringify({ error: "Access denied to this workspace" }),
      { status: 403 }
    );
  }

  try {
    // 1. Fetch the current credentials
    const source = await fetchSourceWithCredentials(undefined, "whatsapp", {
      workspace_id: workspace_id,
    });

    if (!source) {
      throw new Error("WhatsApp source not found for this workspace.");
    }

    // Validate the replacement before changing the stored token or webhooks.
    const appConfig = getMetaServerAppConfig();
    const dbg = await debugConfiguredMetaAccessToken(access_token, {
      appConfig,
    });
    const tokenValidation = evaluateMetaAccessToken(dbg, {
      appId: appConfig.appId,
    });
    if (!tokenValidation.valid) {
      return NextResponse.json(
        { error: tokenValidation.error || "Invalid WhatsApp access token" },
        { status: 400 }
      );
    }
    const tokenMetadataPatch = {
      ...buildWhatsAppTokenMetadataPatch(dbg, { appId: appConfig.appId }),
      token_last_refresh_attempt_at: null,
      meta_diagnostics_reconnect_reason: null,
    };

    // 3. Update the access token and set expiration (or null if unknown)
    const currentCreds = source.credentials as {
      phone_number_id?: string;
      waba_id?: string;
      business_id?: string;
      [key: string]: unknown;
    };
    const normalized = normalizeWhatsAppCredentials(currentCreds);

    // Resolve business_id from WABA if not stored (so we can persist it)
    let resolvedBusinessIdForSave = normalized.businessId;
    if (!resolvedBusinessIdForSave && normalized.wabaId) {
      try {
        const wabaData = await graphClient.getJson<{
          owner_business_info?: { id: string };
        }>(normalized.wabaId, {
          token: access_token,
          query: { fields: "owner_business_info" },
        });
        resolvedBusinessIdForSave = wabaData.owner_business_info?.id;
      } catch {
        // ignore; webhook re-subscribe will try again
      }
    }

    const updatedSource = await updateManagedWhatsAppSourceBinding({
      workspaceId: workspace_id,
      sourceId: source.id,
      currentWabaId: String(normalized.wabaId || ""),
      nextWabaId: String(normalized.wabaId || ""),
      semanticOperationId: `token-refresh:${normalized.wabaId || source.id}`,
      buildCredentials: liveCredentials => {
        const nextCredentials = {
          ...liveCredentials,
          access_token: encryptString(access_token),
          ...tokenMetadataPatch,
          ...buildWhatsAppCredentialAccountPatch(currentCreds),
          ...(resolvedBusinessIdForSave && {
            business_id: resolvedBusinessIdForSave,
          }),
        };
        stripDeprecatedWhatsAppCredentialAliases(nextCredentials);
        return nextCredentials;
      },
    });
    const newCredentials = updatedSource.credentials;

    // 5. CRITICAL: Re-subscribe webhooks for ALL WABAs after token update
    // This is essential because:
    // - New token may have different permissions
    // - Webhook subscriptions may have been lost
    // - Client WABAs need separate subscriptions
    const webhookResults = {
      attempted: false,
      success: false,
      error: null as string | null,
      wabas_subscribed: 0,
      total_wabas: 0,
    };

    try {
      const wabaId = normalized.wabaId;
      const businessId = resolvedBusinessIdForSave ?? normalized.businessId;

      if (wabaId) {
        console.log(
          `[PATCH Token] Re-subscribing webhooks after token update for workspace ${workspace_id}...`
        );

        // Subscribe to the primary WABA (stored in credentials)
        const primaryWabaResult = await subscribeToWABAWebhooks(
          wabaId,
          access_token,
          { coexistenceMode: normalized.coexistenceMode }
        );
        webhookResults.attempted = true;

        if (primaryWabaResult.success) {
          webhookResults.wabas_subscribed++;
          console.log(
            `[PATCH Token] ✅ Subscribed webhooks for primary WABA ${wabaId}`
          );

          // If we have business ID, subscribe to ALL WABAs (owned + client)
          if (businessId) {
            try {
              const allWABAs = await getAllWABAs(businessId, access_token);
              webhookResults.total_wabas = allWABAs.length;

              // Subscribe to all WABAs
              for (const wabaWithPhones of allWABAs) {
                if (wabaWithPhones.waba.id !== wabaId) {
                  // Skip primary WABA (already subscribed)
                  const result = await subscribeToWABAWebhooks(
                    wabaWithPhones.waba.id,
                    access_token,
                    { coexistenceMode: normalized.coexistenceMode }
                  );
                  if (result.success) {
                    webhookResults.wabas_subscribed++;
                    console.log(
                      `[PATCH Token] ✅ Subscribed webhooks for ${wabaWithPhones.accountType} WABA ${wabaWithPhones.waba.id}`
                    );
                  }
                }
              }
            } catch (error) {
              console.warn(
                "[PATCH Token] Failed to subscribe all WABAs:",
                error
              );
              webhookResults.error =
                error instanceof Error ? error.message : String(error);
            }
          } else {
            // Only primary WABA available
            webhookResults.total_wabas = 1;
          }

          webhookResults.success = true;
        } else {
          webhookResults.error =
            primaryWabaResult.error || "Subscription failed";
          console.error(
            `[PATCH Token] ❌ Failed to subscribe webhooks for primary WABA: ${webhookResults.error}`
          );
        }
      }
    } catch (error) {
      console.error("[PATCH Token] Error during webhook subscription:", error);
      webhookResults.error =
        error instanceof Error ? error.message : String(error);
      // Don't fail the token update if webhook subscription fails
    }

    const {
      autoDefaults,
      contactSync: autoContactSync,
      catalogSetup: autoCatalogSetup,
    } = await runWhatsAppPostConnectSetup({
      sourceId: source.id,
      workspaceId: workspace_id,
      credentials: newCredentials,
      trigger: "token_refresh",
      includeHistory: false,
      saveCredentials: createWhatsAppSourceCredentialSnapshotSaver({
        sourceId: source.id,
        workspaceId: workspace_id,
        expectedPhoneNumberId:
          normalizeWhatsAppCredentials(newCredentials).phoneNumberId || "",
        currentCredentials: newCredentials,
      }),
    });

    await upsertWhatsAppAccountsForSource({
      sourceId: source.id,
      workspaceId: workspace_id,
      companyId: source.company_id,
      credentials: autoDefaults.credentials,
      isDefault: true,
    });
    await recordWhatsAppOnboardingEvent({
      eventType: "token_refreshed",
      eventSource: "source_patch",
      workspaceId: workspace_id,
      companyId: source.company_id,
      sourceId: source.id,
      accountIdentifiers: autoDefaults.credentials,
      payload: {
        webhooks: webhookResults,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Access token updated successfully.",
      webhooks: webhookResults.attempted
        ? {
            subscribed: webhookResults.success,
            wabas_subscribed: webhookResults.wabas_subscribed,
            total_wabas: webhookResults.total_wabas,
            ...(webhookResults.error && { error: webhookResults.error }),
            note: webhookResults.success
              ? "Webhooks re-subscribed for all WABAs"
              : "Token updated but webhook subscription failed. Use /api/whatsapp/fix-all-wabas to retry.",
          }
        : {
            note: "Webhook subscription skipped (WABA ID not found)",
          },
      auto_defaults: {
        attempted: autoDefaults.attempted,
        success: autoDefaults.success,
        warnings: autoDefaults.warnings,
        status: autoDefaults.status,
      },
      auto_contact_sync: autoContactSync,
      auto_catalog_setup: autoCatalogSetup,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
    });
  }
}
