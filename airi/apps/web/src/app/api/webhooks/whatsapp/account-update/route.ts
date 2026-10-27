import { supabaseAdmin } from "@/lib/supabase/admin";
import { createServerLogger } from "@/lib/observability/server-logs";
import {
  enforceMetaWebhookSignature,
  getMetaWebhookSignatureMode,
  logWebhookSecurityEvent,
  readRawBodyAndJson,
} from "@/lib/webhook-auth";
import { handleAccountUpdateWebhook } from "@/lib/whatsapp/account/update-handler";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import { handleWhatsAppWebhookVerification } from "@/lib/whatsapp/webhook-verification";
import { NextResponse } from "next/server";
import pLimit from "p-limit";

const accountSourceUpdateLimit = pLimit(8);
const accountUpdateRouteLogger = createServerLogger(
  "api.webhooks.whatsapp.account-update"
);

function getStringField(
  value: Record<string, unknown>,
  field: string
): string | undefined {
  const raw = value[field];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function getStringListField(
  value: Record<string, unknown>,
  field: string
): string[] {
  const raw = value[field];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  return typeof raw === "string" && raw.trim() ? [raw] : [];
}

function getStringMapField(
  value: Record<string, unknown>,
  field: string
): Record<string, string> | undefined {
  const raw = value[field];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === "string" &&
      typeof entry[1] === "string" &&
      entry[1].trim().length > 0
  );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * WhatsApp account_update webhook handler
 *
 * Per Meta documentation: https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
 * "You must be subscribed to the account_update webhook, as this webhook is triggered
 * whenever a customer successfully completes the Embedded Signup flow and contains
 * business information you will need."
 *
 * This webhook is triggered when:
 * - A customer completes Embedded Signup
 * - Business verification status changes
 * - WABA settings are updated
 * - Phone number verification status changes
 */
export async function POST(request: Request) {
  try {
    const mode = getMetaWebhookSignatureMode();
    const signatureHeader = request.headers.get("x-hub-signature-256");
    const appSecret = process.env.META_APP_SECRET;

    const parsed = await readRawBodyAndJson<Record<string, unknown>>(request);
    const securityDecision = enforceMetaWebhookSignature({
      rawBody: parsed.rawBody,
      signatureHeader,
      appSecret,
      mode,
    });

    if (securityDecision.reasonCode) {
      logWebhookSecurityEvent({
        provider: "whatsapp",
        route: "/api/webhooks/whatsapp/account-update",
        reasonCode: securityDecision.reasonCode,
        mode,
        status: securityDecision.allowed ? "allowed" : "denied",
      });
    }

    if (!securityDecision.allowed) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = parsed.body as {
      object?: string;
      entry?: Array<{
        id?: string;
        changes?: Array<{
          field?: string;
          value?: Record<string, unknown>;
        }>;
      }>;
    };

    console.log("📢 WhatsApp account_update webhook received:", {
      object: body.object,
      entry: body.entry,
      timestamp: new Date().toISOString(),
    });

    // Webhook structure per Meta docs:
    // {
    //   object: "whatsapp_business_account",
    //   entry: [{
    //     id: "WABA_ID",
    //     time: timestamp,
    //     changes: [{
    //       field: "account_update",
    //       value: {
    //         phone_number: "PHONE_NUMBER",
    //         event: "VERIFIED" | "APPROVED" | "REJECTED" | ...,
    //         account_review_status: "APPROVED" | "PENDING" | "REJECTED",
    //         business_verification_status: "verified" | "unverified" | "pending",
    //         ...
    //       }
    //     }]
    //   }]
    // }

    if (body.object === "whatsapp_business_account") {
      for (const entry of body.entry || []) {
        const wabaId = entry.id;

        for (const change of entry.changes || []) {
          if (change.field === "account_update") {
            const value = (change.value || {}) as Record<string, unknown>;
            const event = getStringField(value, "event");
            const phoneNumber = getStringField(value, "phone_number");
            const ownerBusinessId =
              getStringField(value, "owner_business_id") || "";
            const partnerAppId = getStringField(value, "partner_app_id");
            const accountReviewStatus = getStringField(
              value,
              "account_review_status"
            );
            const businessVerificationStatus = getStringField(
              value,
              "business_verification_status"
            );
            const banStates = getStringListField(value, "ban_state");
            const banDate =
              getStringField(value, "ban_date") || new Date().toISOString();
            const disconnectionInfo = getStringMapField(
              value,
              "disconnection_info"
            );

            console.log("✅ Account update detected:", {
              wabaId,
              phoneNumber,
              event,
              displayPhoneNumber: value.display_phone_number,
              banState: banStates,
              reviewStatus: accountReviewStatus,
              businessVerificationStatus,
            });

            // Update source record with business verification status
            if (wabaId) {
              try {
                const { data: sources, error: findError } = await supabaseAdmin
                  .from("sources")
                  .select("id, workspace_id, credentials")
                  .eq("type", "whatsapp")
                  .contains("credentials", { waba_id: wabaId });

                if (!findError && sources && sources.length > 0) {
                  await Promise.all(
                    sources.map(source =>
                      accountSourceUpdateLimit(async () => {
                        const credentials =
                          (source.credentials as Record<string, unknown>) || {};

                        // If business verification status changed, log it
                        if (
                          businessVerificationStatus &&
                          businessVerificationStatus !==
                            credentials.business_verification_status
                        ) {
                          console.log(
                            `📊 Business verification status changed for WABA ${wabaId}:`,
                            {
                              old: credentials.business_verification_status,
                              new: businessVerificationStatus,
                              workspaceId: source.workspace_id,
                            }
                          );
                        }

                        // If account review status changed, log it
                        if (
                          accountReviewStatus &&
                          accountReviewStatus !==
                            credentials.account_review_status
                        ) {
                          console.log(
                            `📊 Account review status changed for WABA ${wabaId}:`,
                            {
                              old: credentials.account_review_status,
                              new: accountReviewStatus,
                              workspaceId: source.workspace_id,
                            }
                          );
                        }

                        try {
                          await updateCurrentWhatsAppSourceCredentials({
                            workspaceId: source.workspace_id,
                            sourceId: source.id,
                            expectedWabaId: wabaId,
                            buildCredentials: current => ({
                              ...current,
                              account_review_status:
                                accountReviewStatus ||
                                current.account_review_status,
                              business_verification_status:
                                businessVerificationStatus ||
                                current.business_verification_status,
                              phone_verified:
                                event === "VERIFIED" || current.phone_verified,
                              verification_updated_at: new Date().toISOString(),
                            }),
                          });
                        } catch (updateError) {
                          accountUpdateRouteLogger.error(
                            "Failed to update WhatsApp verification status",
                            updateError,
                            {
                              sourceId: source.id,
                              workspaceId: source.workspace_id,
                              wabaId,
                            }
                          );
                          return;
                        }

                        console.log(
                          `✅ Updated source ${source.id} with verification statuses`
                        );
                      })
                    )
                  );
                }
              } catch (updateError) {
                console.error(
                  "Error updating source with verification status:",
                  updateError
                );
                // Continue processing - don't fail the webhook
              }
            }

            // Handle account update events (PARTNER_ADDED, etc.)
            // This uses the existing handler for event-specific logic
            if (event) {
              await handleAccountUpdateWebhook({
                event,
                waba_info: wabaId
                  ? {
                      waba_id: wabaId,
                      owner_business_id: ownerBusinessId,
                      partner_app_id: partnerAppId,
                    }
                  : undefined,
                phone_number: phoneNumber,
                disconnection_info: disconnectionInfo,
                ban_info:
                  banStates.length > 0
                    ? {
                        waba_ban_state: banStates,
                        waba_ban_date: banDate,
                      }
                    : undefined,
              });
            }
          }
        }
      }
    }

    // Always return 200 OK to acknowledge webhook receipt
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error processing account_update webhook:", error);

    // Still return 200 to prevent Meta from retrying
    // Log the error for investigation
    return NextResponse.json({ success: false, error: "Internal error" });
  }
}

export async function GET(request: Request) {
  return handleWhatsAppWebhookVerification(request, {
    logScope: "api.webhooks.whatsapp.account-update.verify",
    route: "/api/webhooks/whatsapp/account-update",
  });
}
