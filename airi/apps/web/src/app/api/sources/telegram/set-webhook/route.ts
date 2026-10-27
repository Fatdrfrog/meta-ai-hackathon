import { fetchSourceWithAccessCheck } from "@/lib/sources/utils";
import { createClient } from "@/lib/supabase/server";
import { callTelegramApiWithToken } from "@/lib/telegram";
import { registerTelegramWebhook } from "@/lib/telegram/register-webhook";
import { readTelegramBotToken } from "@/lib/telegram/telegram-source";
import { isTelegramSource } from "@icecore/shared/types/sources";
import { NextRequest, NextResponse } from "next/server";

/**
 * Register or update webhook for a Telegram source.
 *
 * This endpoint:
 * 1. Validates user authentication
 * 2. Fetches source from Supabase
 * 3. Validates source is Telegram type and has bot_token
 * 4. Constructs webhook URL: ${NEXT_PUBLIC_APP_URL}/api/telegram/webhook/${sourceId}
 * 5. Calls Telegram setWebhook API
 * 6. Returns webhook registration status
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { sourceId } = body;

    if (!sourceId) {
      return NextResponse.json(
        { error: "Source ID is required" },
        { status: 400 }
      );
    }

    // Fetch source with credentials and verify workspace access
    const {
      source,
      hasAccess,
      error: accessError,
    } = await fetchSourceWithAccessCheck(sourceId, user.id, "telegram");

    if (!source || !hasAccess) {
      return NextResponse.json(
        { error: accessError || "Source not found or access denied" },
        { status: accessError?.includes("Access denied") ? 403 : 404 }
      );
    }

    // Validate source is Telegram type
    if (!isTelegramSource(source)) {
      return NextResponse.json(
        { error: "Invalid source type" },
        { status: 400 }
      );
    }

    const botToken = readTelegramBotToken(source.credentials);
    if (!botToken) {
      return NextResponse.json(
        { error: "Bot token not configured for this source" },
        { status: 400 }
      );
    }

    // Register webhook with Telegram using shared helper
    const webhookResult = await registerTelegramWebhook(botToken, sourceId);

    if (!webhookResult.success) {
      return NextResponse.json(
        {
          error: "Failed to register webhook with Telegram",
          details: webhookResult.error,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      webhookUrl: webhookResult.webhookUrl,
      message: "Webhook registered successfully",
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    console.error("[Telegram Webhook Registration] Error:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * Get current webhook info for a Telegram source.
 * Useful for checking webhook status.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const sourceId = searchParams.get("sourceId");

    if (!sourceId) {
      return NextResponse.json(
        { error: "Source ID is required" },
        { status: 400 }
      );
    }

    // Fetch source with credentials and verify workspace access
    const {
      source,
      hasAccess,
      error: accessError,
    } = await fetchSourceWithAccessCheck(sourceId, user.id, "telegram");

    if (!source || !hasAccess) {
      return NextResponse.json(
        { error: accessError || "Source not found or access denied" },
        { status: accessError?.includes("Access denied") ? 403 : 404 }
      );
    }

    // Validate source is Telegram type
    if (!isTelegramSource(source)) {
      return NextResponse.json(
        { error: "Invalid source type" },
        { status: 400 }
      );
    }

    const botToken = readTelegramBotToken(source.credentials);
    if (!botToken) {
      return NextResponse.json(
        { error: "Bot token not configured for this source" },
        { status: 400 }
      );
    }

    // Get webhook info from Telegram
    try {
      const webhookInfo = await callTelegramApiWithToken<{
        url: string;
        has_custom_certificate: boolean;
        pending_update_count: number;
        ip_address?: string;
        last_error_date?: number;
        last_error_message?: string;
        last_synchronization_error_date?: number;
        max_connections?: number;
        allowed_updates?: string[];
      }>(botToken, "getWebhookInfo", {});

      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const expectedWebhookUrl = `${baseUrl}/api/telegram/webhook/${sourceId}`;

      return NextResponse.json({
        success: true,
        webhookInfo,
        expectedWebhookUrl,
        isConfigured: webhookInfo.url === expectedWebhookUrl,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("[Telegram Webhook Info] Error:", error);

      return NextResponse.json(
        {
          error: "Failed to get webhook info from Telegram",
          details: errorMessage,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    console.error("[Telegram Webhook Info] Error:", error);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
