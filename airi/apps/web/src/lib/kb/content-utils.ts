import { cleanHtmlContent } from "@icecore/shared/lib/html-utils";
import { marked } from "marked";
import {
  restoreHtmlYoutubeIframes,
  rewriteHtmlYoutubeIframes,
} from "@/lib/kb/youtube-embed";

const BLOCKED_HTML_TAGS =
  /<\/?(?:script|iframe|object|embed|base|form|input|button|textarea|select|option|meta|link|style|svg|math)\b[^>]*>/gi;
const EVENT_HANDLER_ATTRIBUTE =
  /\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g;
const DANGEROUS_URL_ATTRIBUTE =
  /\s+(href|src|xlink:href|action|formaction|poster)\s*=\s*(["'])(.*?)\2/gi;
const DANGEROUS_UNQUOTED_URL_ATTRIBUTE =
  /\s+(href|src|xlink:href|action|formaction|poster)\s*=\s*(?!["'])([^\s>]+)/gi;
const MARKDOWN_TASK_CHECKBOX = /<input\b([^>]*)>/gi;

function isSafeHtmlUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (/^(?:#|\/(?!\/)|\.{1,2}\/)/.test(trimmed)) {
    return true;
  }

  try {
    const parsed = new URL(trimmed, "https://airi.chat");
    if (parsed.protocol === "data:") {
      return /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(trimmed);
    }
    return ["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function sanitizeRichHtml(html: string): string {
  const youtubeIframes = rewriteHtmlYoutubeIframes(
    html.replace(MARKDOWN_TASK_CHECKBOX, (match, attributes) => {
      const attrText = String(attributes || "");
      const isCheckbox = /\btype\s*=\s*["']?checkbox["']?/i.test(attrText);
      const isDisabled = /\bdisabled\b/i.test(attrText);

      if (!isCheckbox || !isDisabled) {
        return match;
      }

      const state = /\bchecked\b/i.test(attrText) ? "checked" : "unchecked";
      return `<span data-kb-task-checkbox="${state}"></span>`;
    })
  );

  const sanitized = youtubeIframes.html
    .replace(BLOCKED_HTML_TAGS, "")
    .replace(EVENT_HANDLER_ATTRIBUTE, "")
    .replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(DANGEROUS_URL_ATTRIBUTE, (_match, attribute, quote, value) =>
      isSafeHtmlUrl(value) ? ` ${attribute}=${quote}${value}${quote}` : ""
    )
    .replace(DANGEROUS_UNQUOTED_URL_ATTRIBUTE, (_match, attribute, value) =>
      isSafeHtmlUrl(value) ? ` ${attribute}="${value}"` : ""
    );

  return restoreHtmlYoutubeIframes(sanitized, youtubeIframes.iframes);
}

export function convertContentToHtml(value: string | undefined | null): string {
  if (!value) return "";

  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = marked.parse(trimmed, { async: false, gfm: true });
    return sanitizeRichHtml(typeof parsed === "string" ? parsed : trimmed);
  } catch {
    return sanitizeRichHtml(trimmed);
  }
}

export function extractPlainText(
  value: string | undefined | null,
  options: { preserveLineBreaks?: boolean } = { preserveLineBreaks: false }
): string {
  const html = convertContentToHtml(value);
  if (!html) return "";

  return cleanHtmlContent(html, {
    preserveLineBreaks: options.preserveLineBreaks,
  });
}
