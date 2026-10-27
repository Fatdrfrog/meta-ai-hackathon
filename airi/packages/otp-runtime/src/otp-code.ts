import crypto from "crypto";

const OTP_DIGITS = 6;
const OTP_MODULO = 10 ** OTP_DIGITS;

export function generateOtpCode(): string {
  return crypto.randomInt(0, OTP_MODULO).toString().padStart(OTP_DIGITS, "0");
}

export function normalizeOtpCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^\d{6}$/.test(normalized) ? normalized : null;
}

export function getOtpHashSecret(): string {
  const secret = process.env.OTP_HASH_SECRET || process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "OTP_HASH_SECRET or ENCRYPTION_SECRET must be set to at least 32 characters"
    );
  }
  return secret;
}

export function hashOtpCode(input: {
  code: string;
  workspaceId: string;
  recipientPhone: string;
  purpose: string;
  challengeId: string;
}): string {
  return crypto
    .createHmac("sha256", getOtpHashSecret())
    .update(input.workspaceId)
    .update(":")
    .update(input.recipientPhone)
    .update(":")
    .update(input.purpose)
    .update(":")
    .update(input.challengeId)
    .update(":")
    .update(input.code)
    .digest("hex");
}

export function isOtpHashMatch(
  expectedHash: string,
  actualHash: string
): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(actualHash, "hex");
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

export function redactOtpLikeValues(value: string): string {
  return value.replace(/\b\d{4,8}\b/g, "[redacted_code]");
}
