/**
 * Shared HTML processing utilities
 * Used for cleaning, extracting text, and decoding HTML content
 */

export interface HtmlMetadata {
  title: string;
  description: string;
}

export interface HtmlExtractionResult extends HtmlMetadata {
  contentText: string;
}

/**
 * Decode HTML entities to plain text
 */
export function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&[a-z]+;/gi, " ");
}

/**
 * Escape &, <, > and " for HTML text and double-quoted attributes
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Remove HTML tags from content
 */
export function removeHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

/**
 * Clean HTML content by removing scripts, styles, and other non-content elements
 * Optionally preserves line breaks for better text formatting
 */
export function cleanHtmlContent(
  html: string,
  options: {
    preserveLineBreaks?: boolean;
    removeNavFooter?: boolean;
  } = {},
): string {
  const { preserveLineBreaks = false, removeNavFooter = false } = options;

  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  if (removeNavFooter) {
    cleaned = cleaned
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ");
  }

  if (preserveLineBreaks) {
    cleaned = cleaned
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/td>/gi, " | ");
  }

  cleaned = removeHtmlTags(cleaned);
  cleaned = decodeHtmlEntities(cleaned);

  // Normalize whitespace
  if (preserveLineBreaks) {
    cleaned = cleaned
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    cleaned = cleaned.replace(/\s+/g, " ").trim();
  }

  return cleaned;
}

/**
 * Extract metadata (title, description) from HTML
 */
export function extractHtmlMetadata(html: string): HtmlMetadata {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? "";

  const descMatch = html.match(
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
  );
  const description = descMatch?.[1]?.trim() ?? "";

  return { title, description };
}

/**
 * Extract text content from HTML with metadata
 * Useful for indexing external URLs or processing HTML content
 */
export function extractTextFromHtml(
  html: string,
  options: {
    maxLength?: number;
    removeNavFooter?: boolean;
  } = {},
): HtmlExtractionResult {
  const { maxLength, removeNavFooter = true } = options;

  const metadata = extractHtmlMetadata(html);
  const contentText = cleanHtmlContent(html, {
    preserveLineBreaks: false,
    removeNavFooter,
  });

  const finalText = maxLength ? contentText.slice(0, maxLength) : contentText;

  return {
    ...metadata,
    contentText: finalText,
  };
}
