import type { TelegramCredentials } from "@icecore/shared/types/sources";
import { getMe } from "../telegram";

/**
 * Validates a Telegram bot token by calling the getMe API.
 *
 * @param botToken - The bot token to validate
 * @returns Object with validation result and bot info if valid
 */
export async function validateTelegramBotToken(botToken: string): Promise<{
  valid: boolean;
  error?: string;
  botInfo?: {
    id: number;
    username?: string;
    first_name: string;
    is_bot: boolean;
    can_read_all_group_messages?: boolean;
  };
}> {
  if (
    !botToken ||
    typeof botToken !== "string" ||
    botToken.trim().length === 0
  ) {
    return {
      valid: false,
      error: "Bot token is required",
    };
  }

  try {
    const botInfo = await getMe(botToken);

    return {
      valid: true,
      botInfo: {
        id: botInfo.id,
        username: botInfo.username,
        first_name: botInfo.first_name,
        is_bot: botInfo.is_bot,
        can_read_all_group_messages: botInfo.can_read_all_group_messages,
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";

    // Provide user-friendly error messages
    if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
      return {
        valid: false,
        error: "Invalid bot token. Please check your token and try again.",
      };
    }

    if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      return {
        valid: false,
        error: "Network error. Please check your connection and try again.",
      };
    }

    return {
      valid: false,
      error: `Token validation failed: ${errorMessage}`,
    };
  }
}

/**
 * Validates and enriches Telegram credentials.
 * Calls getMe API to validate token and optionally fetch bot_username.
 *
 * @param credentials - Telegram credentials object
 * @param options - Validation options
 * @returns Enriched credentials with bot_username if not provided
 */
export async function validateAndEnrichTelegramCredentials(
  credentials: TelegramCredentials,
  options?: {
    /** If true, will fetch bot_username from API if not provided */
    fetchUsername?: boolean;
  }
): Promise<{
  valid: boolean;
  error?: string;
  credentials: TelegramCredentials;
}> {
  const { bot_token, bot_username } = credentials;

  if (!bot_token) {
    return {
      valid: false,
      error: "Bot token is required",
      credentials,
    };
  }

  const validation = await validateTelegramBotToken(bot_token);

  if (!validation.valid) {
    return {
      valid: false,
      error: validation.error,
      credentials,
    };
  }

  // Enrich credentials with bot_username if not provided and fetchUsername is true
  const enrichedCredentials: TelegramCredentials = {
    ...credentials,
  };

  if (!bot_username && options?.fetchUsername && validation.botInfo?.username) {
    enrichedCredentials.bot_username = validation.botInfo.username;
  }

  return {
    valid: true,
    credentials: enrichedCredentials,
  };
}
