/**
 * Storage-safe file name: every character outside `[a-zA-Z0-9._-]` becomes
 * "-", dash runs collapse and the result is capped at 120 characters. Each
 * character maps to one output character, so only empty input yields an
 * empty name; `fallback` is returned as given in that case.
 */
export function sanitizeStorageFilename(
  filename: string | null | undefined,
  fallback: string,
): string {
  const cleaned = (filename || "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return cleaned || fallback;
}
