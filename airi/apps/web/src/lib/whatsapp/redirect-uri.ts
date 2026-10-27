/**
 * Standardized redirect URI utilities for WhatsApp Embedded Signup
 *
 * Ensures redirect_uri matches exactly between OAuth request and callback
 * as required by Meta's OAuth specification.
 */

/**
 * Gets the standardized redirect URI for Embedded Signup
 * This MUST match exactly in both the OAuth request and callback
 *
 * @param origin The origin (protocol + host) of the current request
 * @returns Standardized redirect URI
 */
export function getEmbeddedSignupRedirectUri(origin: string): string {
  // Standard format: {origin}/api/sources/whatsapp/callback?embedded=true
  // Always include the embedded=true query parameter for consistency
  return `${origin}/api/sources/whatsapp/callback?embedded=true`;
}

export type EmbeddedSignupStateFlow = "cloud_api" | "coexistence";

export function parseEmbeddedSignupState(rawState?: string | null): {
  workspaceId?: string;
  flow?: EmbeddedSignupStateFlow;
} {
  const trimmedState = rawState?.trim();
  if (!trimmedState) return {};

  if (!trimmedState.includes("=")) {
    return { workspaceId: trimmedState };
  }

  const params = new URLSearchParams(trimmedState);
  const workspaceId = params.get("workspace_id")?.trim() || undefined;
  const flow = params.get("flow")?.trim();

  return {
    workspaceId: workspaceId || trimmedState,
    flow: flow === "cloud_api" || flow === "coexistence" ? flow : undefined,
  };
}

/**
 * Validates that a redirect URI matches the expected format
 *
 * @param redirectUri The redirect URI to validate
 * @param origin The expected origin
 * @returns Validation result
 */
export function validateRedirectUri(
  redirectUri: string,
  origin: string
): {
  valid: boolean;
  error?: string;
  expected?: string;
} {
  const expected = getEmbeddedSignupRedirectUri(origin);

  // Exact match required
  if (redirectUri === expected) {
    return { valid: true };
  }

  // Check if it's the same path but different query param order (still valid)
  try {
    const uri = new URL(redirectUri);
    const expectedUri = new URL(expected);

    if (
      uri.origin === expectedUri.origin &&
      uri.pathname === expectedUri.pathname
    ) {
      // Check if embedded=true is present
      const hasEmbedded = uri.searchParams.get("embedded") === "true";
      if (hasEmbedded) {
        // Allow other query params but embedded=true must be present
        return { valid: true };
      }
    }
  } catch {
    // Invalid URL format
  }

  return {
    valid: false,
    error: `Redirect URI mismatch. Expected: ${expected}, Got: ${redirectUri}`,
    expected,
  };
}
