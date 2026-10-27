/**
 * Sanitize KB article content by removing broken image URLs
 * Prevents local file paths (file://, C:/Users/, clip_image) from being saved
 */

/**
 * Check if an image URL is broken (local file path, file:// protocol, etc.)
 */
function isBrokenImageUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;

  const lowerUrl = url.toLowerCase().trim();

  // Check for local file paths
  return (
    lowerUrl.startsWith("file://") ||
    lowerUrl.startsWith("file:///") ||
    lowerUrl.includes("c:/users/") ||
    lowerUrl.includes("c:\\users\\") ||
    lowerUrl.includes("clip_image") ||
    lowerUrl.includes("msohtmlclip") ||
    (lowerUrl.includes("temp/") && lowerUrl.includes("clip"))
  );
}

/**
 * Sanitize content by removing broken image tags
 * Returns cleaned content with broken images removed
 */
export function sanitizeBrokenImages(content: string): string {
  if (!content || typeof content !== "string") return content;

  // Remove img tags with broken URLs
  return content.replace(
    /<img([^>]*)\s+src=["']([^"']+)["']([^>]*)>/gi,
    (match, before, src) => {
      if (isBrokenImageUrl(src)) {
        // Remove the broken image tag completely
        return "";
      }
      return match;
    }
  );
}
