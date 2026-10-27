import "server-only";

const SHARE_ROOTS = ["tiktok.com"] as const;
const THUMBNAIL_ROOTS = [
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "muscdn.com",
] as const;

function hasAllowedRoot(hostname: string, roots: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return roots.some(root => host === root || host.endsWith(`.${root}`));
}

function normalizeHttpsUrl(
  value: unknown,
  roots: readonly string[]
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      return null;
    }
    if (!hasAllowedRoot(url.hostname, roots)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeTikTokShareUrl(value: unknown): string | null {
  return normalizeHttpsUrl(value, SHARE_ROOTS);
}

export function normalizeTikTokThumbnailUrl(value: unknown): string | null {
  return normalizeHttpsUrl(value, THUMBNAIL_ROOTS);
}
