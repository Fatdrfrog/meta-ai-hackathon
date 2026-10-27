const INTERNAL_AUTH_ORIGIN = "https://airi.chat";

/**
 * Accept only same-origin relative paths for auth continuations.
 *
 * Auth redirects are user-controlled at several boundaries, so an absolute
 * URL (including protocol-relative and backslash-normalized variants) must
 * never be allowed to become a redirect target.
 */
export function getSafeAuthReturnPath(
  rawPath: string | null | undefined
): string | null {
  const value = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  try {
    const url = new URL(value, INTERNAL_AUTH_ORIGIN);
    if (url.origin !== INTERNAL_AUTH_ORIGIN) {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
