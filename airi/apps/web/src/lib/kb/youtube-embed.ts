import { KB_EDITOR_YOUTUBE_IFRAME_CLASS_NAME } from "@/lib/kb/kb-editor-classes";

export const KB_YOUTUBE_IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
export const KB_YOUTUBE_IFRAME_TITLE = "YouTube video";

const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const SAFE_QUERY_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const SAFE_QUERY_VALUE = /^[A-Za-z0-9._-]{0,64}$/;
const IFRAME_TAG =
  /<iframe\b[^>]*>([\s\S]*?)<\/iframe>|<iframe\b[^>]*\/>/gi;

function decodeHtmlAttr(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getTagAttribute(tagHtml: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = tagHtml.match(
    new RegExp(`\\s${escapedName}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i")
  );
  if (quoted?.[2] != null) {
    return decodeHtmlAttr(quoted[2]);
  }

  const unquoted = tagHtml.match(
    new RegExp(`\\s${escapedName}\\s*=\\s*(?!["'])([^\\s>]+)`, "i")
  );
  return unquoted?.[1] ? decodeHtmlAttr(unquoted[1]) : null;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function getSafeYoutubeEmbedUrl(
  value: string | null | undefined
): string | null {
  const trimmed = decodeHtmlAttr(String(value || "").trim());
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_EMBED_HOSTS.has(host)) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parts.length !== 2 ||
      parts[0] !== "embed" ||
      !YOUTUBE_VIDEO_ID.test(parts[1])
    ) {
      return null;
    }

    const params = new URLSearchParams();
    parsed.searchParams.forEach((paramValue, key) => {
      if (SAFE_QUERY_KEY.test(key) && SAFE_QUERY_VALUE.test(paramValue)) {
        params.set(key, paramValue);
      }
    });

    const query = params.toString();
    return `https://${host}/embed/${parts[1]}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

export function buildSafeYoutubeIframeHtml(
  src: string | null | undefined
): string {
  const safeSrc = getSafeYoutubeEmbedUrl(src);
  if (!safeSrc) return "";

  return `<iframe class="${KB_EDITOR_YOUTUBE_IFRAME_CLASS_NAME}" src="${escapeHtmlAttribute(safeSrc)}" title="${KB_YOUTUBE_IFRAME_TITLE}" allow="${KB_YOUTUBE_IFRAME_ALLOW}" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

export function rewriteHtmlYoutubeIframes(html: string): {
  html: string;
  iframes: string[];
} {
  const iframes: string[] = [];
  const next = html.replace(IFRAME_TAG, match => {
    const rewritten = buildSafeYoutubeIframeHtml(getTagAttribute(match, "src"));
    if (!rewritten) return "";

    const token = `%%KB_YOUTUBE_IFRAME_${iframes.length}%%`;
    iframes.push(rewritten);
    return token;
  });

  return { html: next, iframes };
}

export function restoreHtmlYoutubeIframes(
  html: string,
  iframes: string[]
): string {
  return iframes.reduce(
    (next, iframe, index) =>
      next.replace(`%%KB_YOUTUBE_IFRAME_${index}%%`, iframe),
    html
  );
}
