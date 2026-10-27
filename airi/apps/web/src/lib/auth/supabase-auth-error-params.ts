/**
 * Supabase Auth redirects failed OAuth/PKCE flows to the Site URL with:
 *   ?error=invalid_request&error_code=bad_oauth_state&error_description=...
 * Distinguish from unrelated marketing `?error=` params by requiring
 * error_code and/or error_description.
 */

type SearchParamReader = {
  get(name: string): string | null;
};

export function hasSupabaseAuthErrorSearchParams(
  searchParams: SearchParamReader
): boolean {
  const error = searchParams.get("error")?.trim();
  if (!error) {
    return false;
  }

  return Boolean(
    searchParams.get("error_code")?.trim() ||
      searchParams.get("error_description")?.trim()
  );
}

export function buildSupabaseAuthErrorRedirectPath(
  searchParams: SearchParamReader,
  options: { hasAuthCookie: boolean }
): string {
  if (options.hasAuthCookie) {
    // Session still valid — continue onboarding instead of trapping the user
    // on a polluted homepage URL that sticks in browser history.
    return "/onboarding";
  }

  const description =
    searchParams.get("error_description")?.trim() ||
    searchParams.get("error_code")?.trim() ||
    searchParams.get("error")?.trim() ||
    "Authentication failed";

  const params = new URLSearchParams({ reason: description });
  const raw = searchParams.get("error_description")?.trim();
  if (raw) {
    params.set("raw", raw);
  }

  return `/auth/auth-code-error?${params.toString()}`;
}
