/**
 * Get webhook subscription status for a workspace
 * Lightweight endpoint for UI to check if webhooks are active
 *
 * Usage: GET /api/whatsapp/webhook-status?workspace_id=WORKSPACE_ID
 */

import { createClient } from "@/lib/supabase/server";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspace_id");

  if (!workspaceId) {
    return NextResponse.json(
      { error: "Missing workspace_id parameter" },
      { status: 400 }
    );
  }

  try {
    // Fetch WhatsApp source for workspace
    const { data: source, error: sourceError } = await supabase
      .from("sources")
      .select("id, credentials")
      .eq("workspace_id", workspaceId)
      .eq("type", "whatsapp")
      .maybeSingle();

    if (sourceError || !source) {
      return NextResponse.json({
        hasWhatsApp: false,
        webhookSubscribed: false,
        message: "No WhatsApp source found",
      });
    }

    const credentials = source.credentials as {
      phone_number_id?: string;
      waba_id?: string;
      access_token?: unknown;
      token_expires_at?: string;
    };
    const normalized = normalizeWhatsAppCredentials(credentials);

    // Check if token is expired
    let tokenExpired = false;
    if (credentials.token_expires_at) {
      const expiresAt = new Date(credentials.token_expires_at);
      if (expiresAt < new Date()) {
        tokenExpired = true;
      }
    }

    // If we have WABA ID, check subscription status
    // This is a lightweight check - we'll do a full check in the cron job
    // For UI purposes, we just need to know if there's a potential issue
    const hasCredentials =
      normalized.wabaId && normalized.phoneNumberId && !tokenExpired;

    return NextResponse.json({
      hasWhatsApp: true,
      webhookSubscribed: hasCredentials, // Optimistic - full check happens in cron
      tokenExpired,
      sourceId: source.id,
      // Note: Full subscription check is done by cron job
      // This endpoint is just for UI to know if WhatsApp is connected
    });
  } catch (error) {
    console.error("Error checking webhook status:", error);
    return NextResponse.json(
      {
        error: "Failed to check webhook status",
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 }
    );
  }
}
