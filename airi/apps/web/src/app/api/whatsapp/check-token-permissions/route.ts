/**
 * Check System User token permissions and WABA access
 * Helps diagnose permission issues before attempting webhook subscription
 *
 * Usage: POST /api/whatsapp/check-token-permissions
 * Body: { workspace_id: string, access_token?: string }
 */

import { createClient } from "@/lib/supabase/server";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";
import { NextRequest, NextResponse } from "next/server";

const graphClient = getWhatsAppGraphClient();

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  try {
    const body = await request.json();
    const { workspace_id, access_token: providedToken } = body;

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

    const normalized = normalizeWhatsAppCredentials(source.credentials);
    const accessToken = providedToken || normalized.accessToken;
    const wabaId = normalized.wabaId;
    const phoneNumberId = normalized.phoneNumberId;

    if (!wabaId || !phoneNumberId || !accessToken) {
      return NextResponse.json(
        { error: "WhatsApp credentials incomplete", workspace_id },
        { status: 500 }
      );
    }

    const diagnostics = {
      workspace_id,
      source_id: source.id,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      token_source: providedToken ? "provided" : "stored",
      checks: {
        token_permissions: null as {
          success: boolean;
          permissions: Array<{ permission: string; status: string }>;
          missing_permissions: string[];
          error?: string;
        } | null,
        waba_access: null as {
          success: boolean;
          can_read: boolean;
          can_subscribe: boolean;
          error?: string;
        } | null,
        phone_number_access: null as {
          success: boolean;
          can_read: boolean;
          error?: string;
        } | null,
        webhook_subscription_test: null as {
          success: boolean;
          error?: string;
        } | null,
      },
      recommendations: [] as string[],
    };

    // Check 1: Token Permissions
    const requiredPermissions = [
      "whatsapp_business_management",
      "whatsapp_business_messaging",
      "business_management",
      "catalog_management",
    ];

    try {
      const permRes = await graphClient.request("me/permissions", {
        token: accessToken,
        method: "GET",
      });

      if (permRes.ok) {
        const permData = (await permRes.json()) as {
          data?: Array<{ permission: string; status: string }>;
        };

        const permissions = permData.data || [];

        const grantedPermissions = permissions
          .filter(p => p.status === "granted")
          .map(p => p.permission);

        const missingPermissions = requiredPermissions.filter(
          p => !grantedPermissions.includes(p)
        );

        diagnostics.checks.token_permissions = {
          success: missingPermissions.length === 0,
          permissions,
          missing_permissions: missingPermissions,
        };

        if (missingPermissions.length > 0) {
          diagnostics.recommendations.push(
            `Token is missing required permissions: ${missingPermissions.join(", ")}. Regenerate System User token with all required permissions.`
          );
        }
      } else {
        const errorText = await permRes.text();
        diagnostics.checks.token_permissions = {
          success: false,
          permissions: [],
          missing_permissions: requiredPermissions,
          error: `Failed to check permissions: ${errorText.substring(0, 200)}`,
        };
        diagnostics.recommendations.push(
          "Token may be invalid. Check if token is correct and not expired."
        );
      }
    } catch (error) {
      diagnostics.checks.token_permissions = {
        success: false,
        permissions: [],
        missing_permissions: requiredPermissions,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Check 2: WABA Access
    try {
      const wabaRes = await graphClient.request(wabaId, {
        token: accessToken,
        method: "GET",
        query: { fields: "id,name,account_review_status" },
      });

      const canRead = wabaRes.ok;

      // Test webhook subscription capability
      let canSubscribe = false;
      if (canRead) {
        try {
          const subscribeRes = await graphClient.request(
            `${wabaId}/subscribed_apps`,
            {
              token: accessToken,
              method: "GET",
            }
          );
          canSubscribe = subscribeRes.ok;
        } catch {
          canSubscribe = false;
        }
      }

      diagnostics.checks.waba_access = {
        success: canRead && canSubscribe,
        can_read: canRead,
        can_subscribe: canSubscribe,
        ...(!canRead && {
          error: `Cannot read WABA: HTTP ${wabaRes.status}`,
        }),
        ...(canRead &&
          !canSubscribe && {
            error:
              "Can read WABA but cannot subscribe to webhooks (permissions issue)",
          }),
      };

      if (!canRead) {
        diagnostics.recommendations.push(
          "System User doesn't have access to this WABA. Assign WABA to System User in Business Manager."
        );
      } else if (!canSubscribe) {
        diagnostics.recommendations.push(
          "System User can read WABA but cannot subscribe webhooks. Ensure token has 'whatsapp_business_management' permission and System User is assigned to WABA."
        );
      }
    } catch (error) {
      diagnostics.checks.waba_access = {
        success: false,
        can_read: false,
        can_subscribe: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Check 3: Phone Number Access
    try {
      const phoneRes = await graphClient.request(phoneNumberId, {
        token: accessToken,
        method: "GET",
        query: { fields: "id,display_phone_number" },
      });

      const canRead = phoneRes.ok;

      diagnostics.checks.phone_number_access = {
        success: canRead,
        can_read: canRead,
        ...(!canRead && {
          error: `Cannot read phone number: HTTP ${phoneRes.status}`,
        }),
      };

      if (!canRead) {
        diagnostics.recommendations.push(
          "System User doesn't have access to this phone number. Ensure System User is assigned to the WABA containing this phone number."
        );
      }
    } catch (error) {
      diagnostics.checks.phone_number_access = {
        success: false,
        can_read: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Check 4: Test Webhook Subscription (dry run - just check if we can call the endpoint)
    if (
      diagnostics.checks.token_permissions?.success &&
      diagnostics.checks.waba_access?.can_subscribe
    ) {
      try {
        // Try to get current subscriptions (this tests if we can access the subscription endpoint)
        const testRes = await graphClient.request(`${wabaId}/subscribed_apps`, {
          token: accessToken,
          method: "GET",
        });

        diagnostics.checks.webhook_subscription_test = {
          success: testRes.ok,
          ...(!testRes.ok && {
            error: `Cannot access webhook subscription endpoint: HTTP ${testRes.status}`,
          }),
        };
      } catch (error) {
        diagnostics.checks.webhook_subscription_test = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      diagnostics.checks.webhook_subscription_test = {
        success: false,
        error: "Skipped: Token permissions or WABA access check failed",
      };
    }

    // Overall assessment
    const allChecksPass =
      diagnostics.checks.token_permissions?.success &&
      diagnostics.checks.waba_access?.success &&
      diagnostics.checks.phone_number_access?.success;

    return NextResponse.json({
      success: allChecksPass,
      diagnostics,
      summary: {
        token_has_permissions:
          diagnostics.checks.token_permissions?.success || false,
        can_access_waba: diagnostics.checks.waba_access?.can_read || false,
        can_subscribe_webhooks:
          diagnostics.checks.waba_access?.can_subscribe || false,
        can_access_phone:
          diagnostics.checks.phone_number_access?.can_read || false,
        ready_for_webhook_subscription: allChecksPass,
      },
      next_steps: allChecksPass
        ? [
            "All checks passed! You can now subscribe webhooks using /api/whatsapp/fix-all-wabas",
          ]
        : diagnostics.recommendations.length > 0
          ? diagnostics.recommendations
          : [
              "Check the diagnostics above to identify the specific permission or access issue.",
            ],
    });
  } catch (error) {
    console.error("[Check Token Permissions] Unexpected error:", error);
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
