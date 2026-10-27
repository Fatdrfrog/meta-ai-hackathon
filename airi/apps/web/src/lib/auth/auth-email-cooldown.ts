/**
 * Supabase Auth sends at most one email per address per interval (60 seconds by
 * default). A request inside that window fails with 429
 * `over_email_send_rate_limit` and the message
 * "For security purposes, you can only request this after N seconds."
 */

type AuthEmailError = {
  code?: string;
  status?: number;
  message?: string;
};

const COOLDOWN_SECONDS_PATTERN = /after (\d+) seconds?/i;
const MAX_COOLDOWN_SECONDS = 3600;

function normalizeCooldownSeconds(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.min(Math.ceil(value), MAX_COOLDOWN_SECONDS);
}

/** Seconds until Supabase will email this address again, or null for other errors. */
export function getAuthEmailCooldownSeconds(
  error: AuthEmailError | null | undefined
): number | null {
  if (
    !error ||
    (error.code !== "over_email_send_rate_limit" && error.status !== 429)
  ) {
    return null;
  }

  const match = error.message?.match(COOLDOWN_SECONDS_PATTERN);
  return match ? normalizeCooldownSeconds(Number(match[1])) : null;
}

/** Reads the `retry_after` login search param; 0 when absent or invalid. */
export function parseAuthEmailCooldownParam(
  value: string | null | undefined
): number {
  return normalizeCooldownSeconds(Number(value)) ?? 0;
}
