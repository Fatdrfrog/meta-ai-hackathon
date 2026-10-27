import "server-only";

import { decryptMaybeString, encryptString } from "@/lib/crypto";
import { hasStoredTelegramBotToken } from "@/lib/integrations/source-status";
import { createServerLogger } from "@/lib/observability/server-logs";
import type { PublicTelegramCredentials } from "@icecore/shared/types/sources";
import { asRecord, cleanString } from "@icecore/shared/lib/value-utils";

const telegramSourceLogger = createServerLogger("telegram.source");

/** The credentials stored encrypted; rows saved before that hold plain text. */
const SEALED_TELEGRAM_KEYS = ["bot_token", "webhook_secret_token"] as const;

function readSealed(
  credentials: unknown,
  key: (typeof SEALED_TELEGRAM_KEYS)[number]
): string {
  const stored = asRecord(credentials)[key];
  const value = decryptMaybeString(stored);
  if (!value && stored && typeof stored === "object") {
    // Usually an ENCRYPTION_SECRET mismatch. Callers then treat the value as
    // missing: an unconfigured bot, or a webhook that rejects every update.
    telegramSourceLogger.warn(`telegram_${key}_undecryptable`);
  }
  return value;
}

export function readTelegramBotToken(credentials: unknown): string {
  return readSealed(credentials, "bot_token");
}

/** The secret Telegram sends back on every update to this source's webhook. */
export function readTelegramWebhookSecret(credentials: unknown): string {
  return readSealed(credentials, "webhook_secret_token");
}

/**
 * Credentials ready to store: a plain-text bot token or webhook secret,
 * including one saved before encryption, is encrypted. An encrypted value is
 * kept as it is.
 */
export function sealTelegramCredentials<T extends object>(credentials: T): T {
  const record = asRecord(credentials);
  if (SEALED_TELEGRAM_KEYS.every(key => typeof record[key] !== "string")) {
    return credentials;
  }

  const sealed: Record<string, unknown> = { ...record };
  for (const key of SEALED_TELEGRAM_KEYS) {
    if (typeof record[key] !== "string") continue;
    const value = decryptMaybeString(record[key]);
    if (value) sealed[key] = encryptString(value);
    else delete sealed[key];
  }
  return sealed as T;
}

export function toPublicTelegramCredentials(
  credentials: unknown
): PublicTelegramCredentials {
  const record = asRecord(credentials);
  const botUsername = cleanString(record.bot_username, 64);
  return {
    has_bot_token: hasStoredTelegramBotToken(record),
    ...(botUsername ? { bot_username: botUsername } : {}),
    ai_reactions_enabled: record.ai_reactions_enabled === true,
  };
}
