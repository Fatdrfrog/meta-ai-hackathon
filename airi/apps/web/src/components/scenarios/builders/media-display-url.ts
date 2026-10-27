import { isHttpOrHttpsUrl } from "@/lib/media/whatsapp-media-url";

type ScenarioMediaValue =
  | string
  | { url?: string | null; bucket?: string | null; path?: string | null }
  | null
  | undefined;

/** Browser-local previews and paths on this site. */
const LOCAL_PREVIEW_URL = /^(blob:|data:|\/)/i;

function readMediaUrl(value: ScenarioMediaValue): string {
  return (typeof value === "string" ? value : value?.url)?.trim() ?? "";
}

/**
 * The URL the canvas can show for a media value, or null while it is still
 * a durable storage ref (gcs://, gs://, or a bucket and path without a
 * signed https URL). A scenario opened before its media is signed holds such
 * refs until the signed URLs arrive; the canvas shows a placeholder instead
 * of a broken image meanwhile.
 */
export function resolveScenarioMediaDisplayUrl(
  value: ScenarioMediaValue
): string | null {
  const url = readMediaUrl(value);
  if (!url) return null;
  return isHttpOrHttpsUrl(url) || LOCAL_PREVIEW_URL.test(url) ? url : null;
}

/**
 * The stored media a value points at: its bucket and path when it has them,
 * else its URL. Showing a durable ref signed replaces only the URL, so the
 * identity stays the same across that swap.
 */
export function readScenarioMediaIdentity(
  value: ScenarioMediaValue
): string | null {
  if (value && typeof value === "object" && value.bucket && value.path) {
    return JSON.stringify([value.bucket, value.path]);
  }
  return readMediaUrl(value) || null;
}
