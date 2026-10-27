/**
 * Fix webhooks for ALL WABAs (owned + client) in a business account
 * This is critical for tech providers managing multiple client WABAs
 *
 * Usage: POST /api/whatsapp/fix-all-wabas
 * Body: { workspace_id: string }
 */

import { EncryptedString } from "@/lib/crypto";
import { createClient } from "@/lib/supabase/server";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import {
  getAllWABAs,
  subscribeToWABAWebhooks,
  validateWABAAccess,
} from "@/lib/whatsapp/waba-service";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import { NextRequest, NextResponse } from "next/server";

const graphClient = getWhatsAppGraphClient();

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  try {
    const body = await request.json();
    const { workspace_id } = body;

    if (!workspace_id) {
      return NextResponse.json(
        { error: "Missing workspace_id in request body" },
        { status: 400 }
      );
    }

    // Fetch WhatsApp source for workspace
    const { data: source, error: sourceError } = await supabase
      .from("sources")
      .select("id, credentials, name")
      .eq("workspace_id", workspace_id)
      .eq("type", "whatsapp")
      .maybeSingle();

    if (sourceError || !source) {
      return NextResponse.json(
        {
          error: "No WhatsApp source found for this workspace",
          workspace_id,
        },
        { status: 404 }
      );
    }

    const credentials = source.credentials as {
      phone_number_id: string;
      waba_id: string;
      business_id?: string;
      access_token: EncryptedString;
      token_expires_at?: string;
    };
    const normalized = normalizeWhatsAppCredentials(credentials);

    // Check token expiration
    if (credentials.token_expires_at) {
      const expiresAt = new Date(credentials.token_expires_at);
      const now = new Date();
      if (expiresAt < now) {
        return NextResponse.json(
          {
            error: "Access token has expired",
            message:
              "Please reconnect WhatsApp integration to get a fresh token",
            token_expired: true,
            expires_at: credentials.token_expires_at,
            days_expired: Math.ceil(
              (now.getTime() - expiresAt.getTime()) / (1000 * 60 * 60 * 24)
            ),
          },
          { status: 401 }
        );
      }
    }

    const accessToken = normalized.accessToken;
    const wabaId = normalized.wabaId;
    let businessId = normalized.businessId;

    if (!accessToken || !wabaId) {
      return NextResponse.json(
        {
          error: "WhatsApp credentials incomplete",
          message: "Missing access token or WABA ID",
        },
        { status: 500 }
      );
    }

    // Get business ID (required to fetch all WABAs)
    // If not stored, try to get it from the current WABA
    if (!businessId) {
      // Try to fetch business ID from WABA
      try {
        const wabaData = await graphClient.getJson<{
          owner_business_info?: { id: string };
        }>(wabaId, {
          token: accessToken,
          query: { fields: "owner_business_info" },
        });
        businessId = wabaData.owner_business_info?.id;
        // Persist business_id so future calls (labels, re-subscribe, etc.) have it
        if (businessId) {
          try {
            await updateCurrentWhatsAppSourceCredentials({
              workspaceId: workspace_id,
              sourceId: source.id,
              expectedWabaId: wabaId,
              buildCredentials: current => ({
                ...current,
                business_id: businessId,
              }),
            });
          } catch (updateError) {
            console.warn(
              "[Fix All WABAs] Could not persist business_id:",
              updateError
            );
          }
        }
      } catch (error) {
        console.warn("Could not fetch business ID from WABA:", error);
      }
    }

    if (!businessId) {
      return NextResponse.json(
        {
          error: "Business ID not found",
          message:
            "Cannot fetch all WABAs without business ID. Please reconnect WhatsApp integration.",
        },
        { status: 400 }
      );
    }

    console.log(
      `[Fix All WABAs] Fetching all WABAs for business ${businessId}...`
    );

    // Get ALL WABAs (owned + client)
    const allWABAs = await getAllWABAs(businessId, accessToken);

    if (allWABAs.length === 0) {
      return NextResponse.json(
        {
          error: "No WABAs found",
          message: "No WhatsApp Business Accounts found for this business",
        },
        { status: 404 }
      );
    }

    const results = {
      workspace_id,
      source_id: source.id,
      business_id: businessId,
      total_wabas: allWABAs.length,
      wabas: [] as Array<{
        waba_id: string;
        waba_name: string;
        account_type: "owned" | "client";
        phone_numbers: Array<{
          phone_number_id: string;
          display_phone_number: string;
        }>;
        waba_subscription: {
          attempted: boolean;
          success: boolean;
          error?: string;
          subscribed_fields?: string[];
          missing_required_fields?: string[];
          missing_optional_fields?: string[];
          coverage_ok?: boolean;
          actionable?: string | null;
        };
        phone_subscriptions: Array<{
          phone_number_id: string;
          success: boolean;
          error?: string;
          skipped?: boolean;
          reason?: string;
        }>;
      }>,
    };

    // Subscribe webhooks for each WABA
    for (const wabaWithPhones of allWABAs) {
      const wabaId = wabaWithPhones.waba.id;
      const wabaName = wabaWithPhones.waba.name || wabaId;
      const accountType = wabaWithPhones.accountType;

      console.log(
        `[Fix All WABAs] Processing ${accountType} WABA: ${wabaName} (${wabaId})`
      );

      // Validate access to this WABA
      const validation = await validateWABAAccess(wabaId, accessToken);

      if (!validation.valid) {
        console.warn(
          `[Fix All WABAs] ⚠️ Cannot access ${accountType} WABA ${wabaId}: ${validation.error}`
        );
        results.wabas.push({
          waba_id: wabaId,
          waba_name: wabaName,
          account_type: accountType,
          phone_numbers: wabaWithPhones.phoneNumbers.map(p => ({
            phone_number_id: p.id,
            display_phone_number: p.display_phone_number || p.id,
          })),
          waba_subscription: {
            attempted: true,
            success: false,
            error: validation.error || "Cannot access WABA",
          },
          phone_subscriptions: [],
        });
        continue;
      }

      // Subscribe to WABA webhooks. Phone numbers are routed via the WABA webhook payload metadata.
      const wabaSubscription = await subscribeToWABAWebhooks(
        wabaId,
        accessToken,
        { coexistenceMode: normalized.coexistenceMode }
      );

      const phoneSubscriptions: Array<{
        phone_number_id: string;
        success: boolean;
        skipped: boolean;
        reason: string;
      }> = wabaWithPhones.phoneNumbers.map(phone => ({
        phone_number_id: phone.id,
        success: true,
        skipped: true,
        reason:
          "WABA-level subscribed_apps handles phone-number webhook routing.",
      }));
      results.wabas.push({
        waba_id: wabaId,
        waba_name: wabaName,
        account_type: accountType,
        phone_numbers: wabaWithPhones.phoneNumbers.map(p => ({
          phone_number_id: p.id,
          display_phone_number: p.display_phone_number || p.id,
        })),
        waba_subscription: {
          attempted: true,
          success: wabaSubscription.success,
          error: wabaSubscription.error,
          subscribed_fields: wabaSubscription.subscribedFields,
          missing_required_fields: wabaSubscription.missingRequiredFields,
          missing_optional_fields: wabaSubscription.missingOptionalFields,
          coverage_ok: wabaSubscription.coverageOk,
          actionable: wabaSubscription.actionable,
        },
        phone_subscriptions: phoneSubscriptions,
      });

      if (wabaSubscription.success) {
        console.log(
          `[Fix All WABAs] ✅ Successfully subscribed ${accountType} WABA ${wabaName}`
        );
      } else {
        console.error(
          `[Fix All WABAs] ❌ Failed to subscribe ${accountType} WABA ${wabaName}: ${wabaSubscription.error}`
        );
      }
    }

    // Summary
    const successfulWABAs = results.wabas.filter(
      w => w.waba_subscription.success
    ).length;
    const successfulPhones = results.wabas.reduce(
      (sum, w) => sum + w.phone_subscriptions.filter(p => p.success).length,
      0
    );

    return NextResponse.json({
      success: true,
      summary: {
        total_wabas: results.total_wabas,
        successful_wabas: successfulWABAs,
        failed_wabas: results.total_wabas - successfulWABAs,
        total_phone_numbers: results.wabas.reduce(
          (sum, w) => sum + w.phone_numbers.length,
          0
        ),
        successful_phone_numbers: successfulPhones,
      },
      results,
      message:
        successfulWABAs === results.total_wabas
          ? "All WABAs successfully subscribed"
          : `Subscribed ${successfulWABAs} of ${results.total_wabas} WABAs. Check results for details.`,
    });
  } catch (error) {
    console.error("[Fix All WABAs] Unexpected error:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
