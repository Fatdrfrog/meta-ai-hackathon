/**
 * Password sign-in failures reach LoginForm as a short `error` search param,
 * so the page can show translated copy instead of an English message. Supabase
 * returns the same `invalid_credentials` for a wrong password, an unknown email
 * and an account without a password (Google-only or invited), on purpose.
 */

export const SIGN_IN_ERROR_CODES = [
  "invalid_credentials",
  "rate_limited",
  "unknown",
] as const;

export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[number];

type SupabaseSignInError = {
  code?: string;
  status?: number;
  message?: string;
};

/**
 * `email_not_confirmed` is not a sign-in error code: the password was right,
 * so the caller sends it to the resend-confirmation step instead.
 */
export function classifySignInError(
  error: SupabaseSignInError | null | undefined
): SignInErrorCode | "email_not_confirmed" {
  const message = error?.message ?? "";

  if (
    error?.code === "email_not_confirmed" ||
    /^email not confirmed$/i.test(message)
  ) {
    return "email_not_confirmed";
  }

  if (
    error?.code === "invalid_credentials" ||
    /^invalid login credentials$/i.test(message)
  ) {
    return "invalid_credentials";
  }

  if (error?.code === "over_request_rate_limit" || error?.status === 429) {
    return "rate_limited";
  }

  return "unknown";
}

/** Reads the `error` login search param; null when absent or unknown. */
export function parseSignInErrorParam(
  value: string | null | undefined
): SignInErrorCode | null {
  return SIGN_IN_ERROR_CODES.find(code => code === value) ?? null;
}

/**
 * Every failed attempt gets a fresh `attempt` search param. Without it a repeat
 * failure redirects to the identical URL and the form looks like nothing
 * happened.
 */
export function createSignInAttemptId(now = Date.now()): string {
  return now.toString(36);
}
