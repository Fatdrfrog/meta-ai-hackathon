import connectDB from "@/lib/mongoose";
import { readTelegramWebhookSecret } from "@/lib/telegram/telegram-source";
import { fetchAndValidateTelegramSource } from "@/lib/telegram/validate-source";
import {
  enforceTelegramSourceWebhookSecret,
  getTelegramSourceSecretMode,
  logWebhookSecurityEvent,
} from "@/lib/webhook-auth";
import type { TelegramUpdate } from "@/types/telegram";
import { NextRequest, NextResponse } from "next/server";
import { processTelegramUpdateWithDedupe } from "../../dedupe-update";
import { dispatchTelegramUpdate } from "../../dispatch-update";

/**
 * Source-specific webhook endpoint for Telegram bots.
 * Each source (business) has its own webhook URL: /api/telegram/webhook/[sourceId]
 *
 * This endpoint:
 * 1. Extracts sourceId from URL params
 * 2. Fetches source from Supabase with credentials
 * 3. Validates source exists and is Telegram type
 * 4. Decrypts the bot token from source credentials
 * 5. Processes webhook update with source context (sourceId, workspaceId, botToken)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> }
) {
  try {
    const { sourceId } = await params;

    if (!sourceId) {
      return NextResponse.json(
        { error: "Source ID is required" },
        { status: 400 }
      );
    }

    const sourceValidation = await fetchAndValidateTelegramSource(sourceId);
    if (
      !sourceValidation.valid ||
      !sourceValidation.source ||
      !sourceValidation.botToken
    ) {
      const error = sourceValidation.error || "Invalid Telegram source";
      const status = error === "Source not found" ? 404 : 400;
      console.error(
        `[Telegram Webhook] Invalid Telegram source ${sourceId}: ${error}`
      );
      return NextResponse.json({ error }, { status });
    }

    const source = sourceValidation.source;
    const botToken = sourceValidation.botToken;
    const workspaceId = source.workspace_id;
    if (!workspaceId) {
      return NextResponse.json(
        { error: "Workspace ID not found for source" },
        { status: 400 }
      );
    }

    const expectedSecret = readTelegramWebhookSecret(source.credentials);
    // A saved secret this key cannot decrypt must not read as "no secret",
    // which the optional mode would let through unchecked.
    if (!expectedSecret && source.credentials.webhook_secret_token) {
      return NextResponse.json(
        { error: "Invalid webhook secret token" },
        { status: 403 }
      );
    }

    const mode = getTelegramSourceSecretMode();
    const secretDecision = enforceTelegramSourceWebhookSecret({
      request: req,
      expectedSecret,
      mode,
    });

    if (secretDecision.reasonCode) {
      logWebhookSecurityEvent({
        provider: "telegram",
        route: "/api/telegram/webhook/[sourceId]",
        reasonCode: secretDecision.reasonCode,
        mode,
        status: secretDecision.allowed ? "allowed" : "denied",
      });
    }

    if (!secretDecision.allowed) {
      return NextResponse.json(
        { error: "Invalid webhook secret token" },
        { status: 403 }
      );
    }

    await connectDB();

    // Parse webhook update
    const body = (await req.json()) as TelegramUpdate;
    return await processTelegramUpdateWithDedupe({
      scope: sourceId,
      updateId: body.update_id,
      process: async () => {
        const sourceContext = {
          sourceId,
          workspaceId,
          botToken,
        };
        return NextResponse.json(
          await dispatchTelegramUpdate(body, {
            sourceId,
            sourceContext,
          })
        );
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "An unknown error occurred";
    console.error("[Telegram Webhook] Error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
