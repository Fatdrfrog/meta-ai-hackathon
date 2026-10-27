/**
 * Normalize URL by replacing dynamic segments with wildcards
 */
export function normalizeUrl(url: string): string {
  try {
    // Parse URL to get pathname
    const urlObj = new URL(url);
    let pathname = urlObj.pathname;

    // Remove trailing slash
    if (pathname.endsWith("/") && pathname.length > 1) {
      pathname = pathname.slice(0, -1);
    }

    // Split into segments
    const segments = pathname.split("/").filter(s => s.length > 0);

    if (segments.length === 0) {
      return "/";
    }

    // Normalize each segment
    const normalized = segments.map((segment, index) => {
      // Keep first segment (usually indicates section like /product, /blog, /user)
      if (index === 0) {
        return segment;
      }

      // Keep last segment if it looks like an action/page name (no numbers/UUIDs)
      if (index === segments.length - 1 && isStaticSegment(segment)) {
        return segment;
      }

      // Replace dynamic segments with wildcard
      if (isDynamicSegment(segment)) {
        return "*";
      }

      return segment;
    });

    return "/" + normalized.join("/");
  } catch {
    // If URL parsing fails, return as-is
    return url;
  }
}

/**
 * Check if segment appears to be dynamic (ID, UUID, number, date)
 */
function isDynamicSegment(segment: string): boolean {
  // UUID pattern
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segment
    )
  ) {
    return true;
  }

  // Pure numbers (IDs)
  if (/^\d+$/.test(segment)) {
    return true;
  }

  // Long alphanumeric strings (likely IDs)
  if (segment.length > 15 && /^[a-z0-9-]+$/i.test(segment)) {
    return true;
  }

  // Date patterns (YYYY, YYYY-MM-DD, etc.)
  if (/^\d{4}(-\d{2})?(-\d{2})?$/.test(segment)) {
    return true;
  }

  return false;
}

/**
 * Check if segment appears to be static (action, page name)
 */
function isStaticSegment(segment: string): boolean {
  // Common static segments
  const staticPatterns = [
    "settings",
    "profile",
    "edit",
    "delete",
    "view",
    "create",
    "new",
    "details",
    "overview",
    "dashboard",
    "requests",
    "admin",
    "panel",
    "checkout",
    "cart",
    "pricing",
    "features",
    "about",
    "contact",
  ];

  return staticPatterns.includes(segment.toLowerCase()) || segment.length < 8;
}
