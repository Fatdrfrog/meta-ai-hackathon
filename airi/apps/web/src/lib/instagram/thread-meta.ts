export function buildInstagramMediaPermalink(
  permalink: unknown,
  shortcode: unknown
): string | undefined {
  const normalizedPermalink =
    typeof permalink === "string" ? permalink.trim() : "";
  if (normalizedPermalink) return normalizedPermalink;

  const normalizedShortcode =
    typeof shortcode === "string" ? shortcode.trim() : "";
  if (!normalizedShortcode) return undefined;

  return `https://www.instagram.com/p/${normalizedShortcode}/`;
}

export function resolveInstagramMediaPreviewUrl(media: {
  thumbnailUrl?: unknown;
  mediaUrl?: unknown;
}): string | undefined {
  const normalizedThumbnail =
    typeof media.thumbnailUrl === "string" ? media.thumbnailUrl.trim() : "";
  if (normalizedThumbnail) return normalizedThumbnail;

  const normalizedMediaUrl =
    typeof media.mediaUrl === "string" ? media.mediaUrl.trim() : "";
  return normalizedMediaUrl || undefined;
}
