import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { readTelegramBotToken } from "@/lib/telegram/telegram-source";
import {
  isTelegramSource,
  type Source,
  type TelegramSource,
} from "@icecore/shared/types/sources";

/**
 * Validates that a Telegram source has a bot token configured.
 * This is a runtime validation helper to ensure sources are properly configured.
 *
 * @param source - The source to validate
 * @returns Object with validation result and, when valid, the decrypted token
 */
export function validateTelegramSourceHasToken(source: Source): {
  valid: boolean;
  error?: string;
  source?: TelegramSource;
  botToken?: string;
} {
  if (!isTelegramSource(source)) {
    return {
      valid: false,
      error: "Source is not a Telegram source",
    };
  }

  const botToken = readTelegramBotToken(source.credentials);
  if (!botToken) {
    return {
      valid: false,
      error: "Telegram source is missing bot_token in credentials",
      source,
    };
  }

  return {
    valid: true,
    source,
    botToken,
  };
}

/**
 * Fetches and validates a Telegram source from Supabase.
 * Ensures the source exists, is a Telegram type, and has a bot token.
 *
 * @param sourceId - The source ID to fetch and validate
 * @returns Object with validation result and source if valid
 */
export async function fetchAndValidateTelegramSource(
  sourceId: string
): Promise<{
  valid: boolean;
  error?: string;
  source?: TelegramSource;
  botToken?: string;
}> {
  try {
    const source = await fetchSourceWithCredentials(sourceId, "telegram");

    if (!source) {
      return {
        valid: false,
        error: "Source not found",
      };
    }

    return validateTelegramSourceHasToken(source);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      valid: false,
      error: `Failed to fetch source: ${errorMessage}`,
    };
  }
}
