/** Public signup errors are stable codes; provider details never enter the UI. */
export const SIGN_UP_ERROR_CODES = [
  "invalid_email",
  "weak_password",
  "rate_limited",
  "signup_disabled",
  "unknown",
] as const;

export type SignUpErrorCode = (typeof SIGN_UP_ERROR_CODES)[number];

export function classifySignUpError(error: unknown): SignUpErrorCode {
  if (!error || typeof error !== "object") return "unknown";

  const code = "code" in error ? error.code : undefined;
  const status = "status" in error ? error.status : undefined;
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : "";

  if (
    code === "email_address_invalid" ||
    /^(Invalid email address|Unable to validate email address: invalid format)\.?$/i.test(
      message
    )
  ) {
    return "invalid_email";
  }

  if (
    code === "weak_password" ||
    /^Password should be at least \d+ characters\.?$/i.test(message)
  ) {
    return "weak_password";
  }

  if (
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit" ||
    status === 429
  ) {
    return "rate_limited";
  }

  if (
    code === "signup_disabled" ||
    code === "email_provider_disabled" ||
    /^Signups (not allowed for this instance|are disabled)\.?$/i.test(message)
  ) {
    return "signup_disabled";
  }

  return "unknown";
}

export function parseSignUpErrorParam(
  value: string | null | undefined
): SignUpErrorCode | null {
  return SIGN_UP_ERROR_CODES.find(code => code === value) ?? null;
}
