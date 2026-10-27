/**
 * Domain validation for widget embedding
 * Validates if the request origin is allowed based on configured domains
 */

interface ParsedOrigin {
  hostname: string;
  port: string;
}

interface ParsedAllowedDomain {
  hostname: string;
  isWildcard: boolean;
  port?: string;
}

function normalizeAllowedDomain(value: string): string {
  let normalized = value.trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  normalized = normalized.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  normalized = normalized.split(/[/?#]/, 1)[0] ?? normalized;

  return normalized.replace(/\/+$/, "");
}

function splitHostAndPort(value: string): { hostname: string; port?: string } {
  const lastColonIndex = value.lastIndexOf(":");
  if (lastColonIndex <= -1) {
    return { hostname: value };
  }

  const maybePort = value.slice(lastColonIndex + 1);
  if (maybePort === "*" || /^\d+$/.test(maybePort)) {
    return {
      hostname: value.slice(0, lastColonIndex),
      port: maybePort,
    };
  }

  return { hostname: value };
}

function parseAllowedDomain(value: string): ParsedAllowedDomain | null {
  const normalized = normalizeAllowedDomain(value);
  if (!normalized) {
    return null;
  }

  const isWildcard = normalized.startsWith("*.");
  const base = isWildcard ? normalized.slice(2) : normalized;
  const { hostname, port } = splitHostAndPort(base);

  if (!hostname) {
    return null;
  }

  return {
    hostname,
    isWildcard,
    ...(port ? { port } : {}),
  };
}

function parseOrigin(origin: string | null): ParsedOrigin | null {
  if (!origin) {
    return null;
  }

  try {
    const url = new URL(origin);
    return {
      hostname: url.hostname.toLowerCase(),
      port: url.port,
    };
  } catch {
    const normalized = normalizeAllowedDomain(origin);
    if (!normalized) {
      return null;
    }

    const { hostname, port } = splitHostAndPort(normalized);
    if (!hostname) {
      return null;
    }

    return {
      hostname,
      port: port && port !== "*" ? port : "",
    };
  }
}

function matchesAllowedDomain(
  requestOrigin: ParsedOrigin,
  allowedDomain: ParsedAllowedDomain
): boolean {
  const hostnameMatches = allowedDomain.isWildcard
    ? requestOrigin.hostname === allowedDomain.hostname ||
      requestOrigin.hostname.endsWith(`.${allowedDomain.hostname}`)
    : requestOrigin.hostname === allowedDomain.hostname;

  if (!hostnameMatches) {
    return false;
  }

  if (!allowedDomain.port || allowedDomain.port === "*") {
    return true;
  }

  return requestOrigin.port === allowedDomain.port;
}

export function normalizeAllowedDomains(allowedDomains: string[]): string[] {
  const seen = new Set<string>();
  const normalizedDomains: string[] = [];

  for (const allowedDomain of allowedDomains) {
    const normalized = normalizeAllowedDomain(allowedDomain);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedDomains.push(normalized);
  }

  return normalizedDomains;
}

/**
 * Validates if an origin/domain is allowed
 * Supports wildcards: *.example.com
 *
 * @param origin - Request origin (e.g., "https://example.com")
 * @param allowedDomains - Array of allowed domains with optional wildcards
 * @returns true if domain is allowed, false otherwise
 */
export function validateDomain(
  origin: string | null,
  allowedDomains: string[]
): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    return false;
  }

  const requestOrigin = parseOrigin(origin);
  if (!requestOrigin) {
    return false;
  }

  // Check against each allowed domain
  for (const allowed of allowedDomains) {
    const parsedAllowedDomain = parseAllowedDomain(allowed);
    if (!parsedAllowedDomain) {
      continue;
    }

    if (matchesAllowedDomain(requestOrigin, parsedAllowedDomain)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract origin from request headers
 * Checks both Origin and Referer headers
 */
export function getRequestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      return url.origin;
    } catch {
      return null;
    }
  }

  return null;
}
