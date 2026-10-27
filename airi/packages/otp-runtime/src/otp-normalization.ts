export function normalizeOtpPurpose(value: unknown): string {
  if (typeof value !== "string") return "login";
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  return normalized.length > 0 ? normalized.slice(0, 64) : "login";
}

export function normalizeOtpIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 128) : undefined;
}
