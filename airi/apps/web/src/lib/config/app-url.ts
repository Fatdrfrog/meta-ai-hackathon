import "server-only";

import { isDisallowedLocalHostname } from "@icecore/shared/lib/network-safety";

/**
 * Canonical helpers for reading the configured application URL out of the
 * environment. Provider integrations derive OAuth redirect URIs and webhook
 * callbacks from this value, so the parsing and hardening rules live here
 * instead of being re-implemented per provider.
 */

export function readConfiguredEnvValue(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Parses a configured value that must be a bare origin: no credentials, no
 * query, no fragment, and no path beyond the root. Callers that build a
 * redirect URI by appending a fixed callback path rely on this so a stray path
 * in the environment cannot silently relocate the callback.
 */
export function parseCanonicalAppUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Parses a configured value into a publicly reachable HTTPS origin, discarding
 * any path, query, or fragment. Used where only the origin is meaningful and a
 * configured path is tolerated.
 */
export function parsePublicHttpsOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isDisallowedLocalHostname(url.hostname)
  ) {
    return null;
  }

  return url.origin;
}
