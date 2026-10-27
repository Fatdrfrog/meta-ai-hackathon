/**
 * Pure HTML/URL helpers for the website crawler. Kept free of `server-only`
 * and side-effectful imports so they can be unit-tested directly.
 */

import { isDisallowedLocalHostname } from "@icecore/shared/lib/network-safety";

export { isPrivateOrReservedIp } from "@icecore/shared/lib/network-safety";

export const SKIP_LINK_EXTENSIONS =
  /\.(pdf|zip|rar|gz|png|jpe?g|gif|webp|svg|ico|mp4|mp3|wav|avi|mov|css|js|woff2?|ttf|eot|xml|json|csv|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i;

/**
 * Rejects hostnames that must never be crawled, based on the literal value alone
 * (no DNS): localhost, *.local/*.localhost, and IP literals in reserved ranges.
 * DNS-resolved private IPs are blocked separately at fetch time.
 */
export function isDisallowedCrawlHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return isDisallowedLocalHostname(host);
}

export function normalizeRootUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (isDisallowedCrawlHost(url.hostname)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function extractSameOriginLinks(html: string, base: URL): string[] {
  const links = new Set<string>();
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    if (
      raw.startsWith("#") ||
      raw.startsWith("mailto:") ||
      raw.startsWith("tel:") ||
      raw.startsWith("javascript:")
    ) {
      continue;
    }
    try {
      const resolved = new URL(raw, base);
      resolved.hash = "";
      if (resolved.origin !== base.origin) continue;
      if (SKIP_LINK_EXTENSIONS.test(resolved.pathname)) continue;
      links.add(resolved.toString());
    } catch {
      // ignore malformed links
    }
  }
  return Array.from(links);
}

export function extractSitemapLocs(xml: string, origin: string): string[] {
  const locRegex = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = locRegex.exec(xml)) !== null) {
    try {
      const url = new URL(match[1].trim());
      if (url.origin === origin && !SKIP_LINK_EXTENSIONS.test(url.pathname)) {
        urls.push(url.toString());
      }
    } catch {
      // ignore malformed entries
    }
  }
  return urls;
}

const HIGH_SIGNAL_PATH_TERMS = [
  "product",
  "products",
  "service",
  "services",
  "solution",
  "solutions",
  "pricing",
  "plans",
  "features",
  "faq",
  "help",
  "support",
  "docs",
  "documentation",
  "about",
  "contact",
  "shipping",
  "delivery",
  "returns",
];

const LOW_SIGNAL_PATH_TERMS = [
  "blog",
  "news",
  "press",
  "careers",
  "jobs",
  "privacy",
  "terms",
  "cookies",
  "login",
  "signin",
  "signup",
];

function crawlUrlScore(rawUrl: string, root: URL): number {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Number.POSITIVE_INFINITY;
  }

  const path = url.pathname.toLowerCase();
  const pathSegments = path.split("/").filter(Boolean);
  let score = pathSegments.length * 5;

  if (url.toString() === root.toString()) score -= 60;

  HIGH_SIGNAL_PATH_TERMS.forEach((term, index) => {
    if (path.includes(term)) score -= 30;
    if (path.includes(term)) score -= HIGH_SIGNAL_PATH_TERMS.length - index;
  });

  for (const term of LOW_SIGNAL_PATH_TERMS) {
    if (path.includes(term)) score += 35;
  }

  if (url.search) score += 15;

  return score;
}

export function rankCrawlUrls(urls: string[], root: URL): string[] {
  return Array.from(new Set(urls)).sort((a, b) => {
    const scoreDelta = crawlUrlScore(a, root) - crawlUrlScore(b, root);
    if (scoreDelta !== 0) return scoreDelta;
    return a.localeCompare(b);
  });
}
