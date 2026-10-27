import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  isTelegramSource,
  type Source,
  type TelegramStoredCredentials,
} from "@icecore/shared/types/sources";
import { randomBytes } from "crypto";
import { callTelegramApiWithToken } from "../telegram";
import {
  readTelegramWebhookSecret,
  sealTelegramCredentials,
} from "./telegram-source";

/**
 * Generates a secure random secret token for webhook validation.
 * Uses crypto.randomBytes for cryptographically secure random generation.
 *
 * @returns A secure random token string (32 bytes, hex encoded = 64 characters)
 */
function generateWebhookSecretToken(): string {
  // Generate 32 random bytes (256 bits) and encode as hex (64 characters)
  return randomBytes(32).toString("hex");
}

/**
 * Registers a webhook for a Telegram bot with secret token security.
 *
 * This function:
 * 1. Generates or retrieves an existing webhook secret token
 * 2. Stores the secret token in source credentials
 * 3. Registers the webhook with Telegram API including the secret token
 *
 * @param botToken - The bot token
 * @param sourceId - The source ID for the webhook URL
 * @param options.rotateSecret - Replace the stored secret even if it is readable
 * @returns Webhook registration result
 */
export async function registerTelegramWebhook(
  botToken: string,
  sourceId: string,
  options: { rotateSecret?: boolean } = {}
): Promise<{
  success: boolean;
  webhookUrl?: string;
  secretToken?: string;
  error?: string;
}> {
  if (!botToken) {
    return {
      success: false,
      error: "Bot token is required",
    };
  }

  if (!sourceId) {
    return {
      success: false,
      error: "Source ID is required",
    };
  }

  // Fetch existing source to get current credentials
  const { data: existingSource, error: fetchError } = await supabaseAdmin
    .from("sources")
    .select("id, type, credentials")
    .eq("id", sourceId)
    .single();

  if (fetchError || !existingSource) {
    return {
      success: false,
      error: "Source not found",
    };
  }

  if (!isTelegramSource(existingSource as Source)) {
    return {
      success: false,
      error: "Source is not a Telegram source",
    };
  }

  const existingCredentials =
    existingSource.credentials && typeof existingSource.credentials === "object"
      ? (existingSource.credentials as TelegramStoredCredentials)
      : {};

  // Get or generate webhook secret token. One this key cannot decrypt is
  // replaced, and setWebhook below hands Telegram the new one.
  let secretToken = options.rotateSecret
    ? ""
    : readTelegramWebhookSecret(existingCredentials);
  if (!secretToken) {
    // Generate a new secret token if one doesn't exist
    secretToken = generateWebhookSecretToken();

    // Store the secret encrypted, like the bot token; a plain-text bot token
    // from before encryption is sealed too.
    const updatedCredentials = sealTelegramCredentials({
      ...existingCredentials,
      webhook_secret_token: secretToken,
    });

    const { error: updateError } = await supabaseAdmin
      .from("sources")
      .update({
        credentials: updatedCredentials,
      })
      .eq("id", sourceId);

    if (updateError) {
      console.error(
        "[Telegram Webhook Registration] Failed to store secret token:",
        updateError
      );
      return {
        success: false,
        error: "Failed to store webhook secret token",
      };
    }
  }

  // Construct webhook URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const webhookUrl = `${baseUrl}/api/telegram/webhook/${sourceId}`;

  try {
    const result = await callTelegramApiWithToken<{
      ok: boolean;
      description?: string;
      error_code?: number;
      result: boolean;
    }>(botToken, "setWebhook", {
      url: webhookUrl,
      secret_token: secretToken, // Include secret token for security
      allowed_updates: [
        "message",
        "callback_query",
        "business_connection",
        "business_message",
        "edited_business_message",
        "deleted_business_messages",
        "edited_message",
        "my_chat_member",
      ],
      max_connections: 40,
    });

    if (!result) {
      return {
        success: false,
        error: "Failed to register webhook with Telegram API",
      };
    }

    return {
      success: true,
      webhookUrl,
      secretToken, // Return secret token (for logging/debugging, not for client use)
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("[Telegram Webhook Registration] Error:", error);

    return {
      success: false,
      error: `Failed to register webhook: ${errorMessage}`,
    };
  }
}
