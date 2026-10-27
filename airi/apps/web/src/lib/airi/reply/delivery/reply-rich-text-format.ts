import { extractPlainText } from "@/lib/kb/content-utils";
import { marked } from "marked";

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return SAFE_URL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function replaceMarkdownLinksWithVisibleUrl(value: string): string {
  return value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 - $2");
}

function normalizeBulletWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Models often emit one line break before the first "• **heading**:" item, then
 * chain further items with ". • **next**:" on the same line. Marked treats that
 * as a single paragraph, so almost no vertical spacing reaches Telegram. Split
 * those chains before markdown parsing so <br>/paragraph breaks appear.
 *
 * Models also mix bullet markers — the first item may use `•` (unicode bullet)
 * while subsequent items get chained with ` * ` (ASCII asterisk) after a
 * sentence end, which marked then renders as the literal character `*`
 * because it isn't at the start of a line. Rewrite those to `\n\n• ` too.
 */
function expandChainedUnicodeBulletItems(value: string): string {
  const bullet = "(?:•|\\u2022)";
  return (
    value
      .replace(new RegExp(`\\)\\.\\s*${bullet}\\s+`, "gu"), ").\n\n• ")
      .replace(
        new RegExp(`([.!?])\\s*${bullet}\\s+(?=\\*\\*)`, "gu"),
        "$1\n\n• "
      )
      // Inline "asterisk bullet" chained after a sentence/heading end. We
      // only match when the next token looks like a bullet label — either
      // `**Bold:**` or a word starting with a Unicode uppercase letter —
      // so we don't accidentally rewrite literal `*` characters in prose
      // (multiplications, footnote markers, etc.).
      .replace(/([.!?:])[ \t]+\*[ \t]+(?=\*\*|\p{Lu})/gu, "$1\n\n• ")
  );
}

/**
 * Telegram HTML parse_mode officially supports:
 *   b, strong, i, em, u, ins, s, strike, del, span (only tg-spoiler class),
 *   tg-spoiler, a, tg-emoji, code, pre, blockquote.
 *
 * We strip everything else (headings/lists/paragraphs/tables/etc.) after
 * first transforming them into the supported subset above. `blockquote` is
 * newly allowed through so `> quoted text` renders as a Telegram quote
 * instead of being flattened into a plain line.
 */
function stripUnsupportedTelegramHtmlTags(value: string): string {
  return value.replace(
    /<(?!\/?(?:b|i|s|u|code|pre|a|blockquote)(?:\s|>|$))[^>]*>/gi,
    ""
  );
}

/**
 * Telegram has no heading entity — clients render `<h1>..<h6>` as plain
 * text. Convention is to promote headings to bold with surrounding blank
 * lines so section breaks survive the conversion.
 */
function convertHeadingsToBold(value: string): string {
  return value
    .replace(/<h[1-6][^>]*>/gi, "\n\n<b>")
    .replace(/<\/h[1-6]>/gi, "</b>\n\n");
}

/**
 * Marked emits loose-list items as `<li><p>content</p></li>`. Stripping
 * inner `<p>`s before the outer-list transform keeps list output compact
 * (avoids blank lines between every bullet/number).
 */
function normalizeListItemInner(inner: string): string {
  return String(inner)
    .replace(/<\/p>\s*<p>/gi, "\n")
    .replace(/<\/?p>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .trim();
}

/**
 * Marked inserts whitespace between `<li>` tags (`</li>\n<li>`). If we
 * only replace the tags themselves, those inter-item newlines survive and
 * Telegram ends up with blank lines between every item. Collapse the gap
 * between siblings to a single boundary before emitting new markers.
 */
function flattenListItemSeparators(inner: string): string {
  return String(inner)
    .replace(/\s*<li\b/gi, "<li")
    .replace(/<\/li>\s*/gi, "</li>")
    .trim();
}

function convertOrderedListsToNumbered(value: string): string {
  return value.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_match, inner) => {
    let counter = 0;
    const flat = flattenListItemSeparators(inner);
    const items = flat.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, content) => {
      counter += 1;
      return `${counter}. ${normalizeListItemInner(content)}\n`;
    });
    // Wrap the whole block with blank lines so it detaches from prose,
    // without inflating spacing between items.
    return `\n\n${items.trim()}\n\n`;
  });
}

function convertUnorderedListsToBullets(value: string): string {
  return value.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_match, inner) => {
    const flat = flattenListItemSeparators(inner);
    const items = flat.replace(
      /<li[^>]*>([\s\S]*?)<\/li>/gi,
      (_m, content) => `• ${normalizeListItemInner(content)}\n`
    );
    return `\n\n${items.trim()}\n\n`;
  });
}

/**
 * Marked wraps blockquote content in `<p>` tags; once those flatten to
 * newlines we end up with `<blockquote>\n\ncontent\n\n</blockquote>`,
 * which Telegram renders with an empty line at the top and bottom of the
 * quote. Trim only leading/trailing whitespace to keep internal line
 * breaks (multi-line quotes should keep their breaks).
 */
function trimBlockquoteWhitespace(value: string): string {
  return value
    .replace(/<blockquote(\s[^>]*)?>\s+/gi, match => {
      const openTag =
        /^<blockquote(?:\s[^>]*)?>/i.exec(match)?.[0] ?? "<blockquote>";
      return openTag;
    })
    .replace(/\s+<\/blockquote>/gi, "</blockquote>");
}

/**
 * Telegram keeps syntax-highlighting on `<pre><code class="language-XXX">`.
 * Marked already emits that class when a fence specifies a language
 * (```python) but our old sanitizer dropped every attribute. Preserve the
 * language token (sanitized to [A-Za-z0-9+_-]) so highlights survive.
 */
function preserveTelegramCodeBlockLanguage(value: string): string {
  return value.replace(/<pre><code\b([^>]*)>/gi, (_match, attrs) => {
    const langMatch = /class\s*=\s*"language-([^"]+)"/i.exec(
      String(attrs || "")
    );
    const raw = langMatch?.[1] ?? "";
    const lang = raw.replace(/[^A-Za-z0-9+_\-]/g, "");
    return lang.length > 0
      ? `<pre><code class="language-${lang}">`
      : "<pre><code>";
  });
}

/**
 * Telegram only allows http(s) in parse_mode HTML links. Marked autolinks
 * emails to <a href="mailto:..."> — stripping only the opening tag leaves a
 * stray </a> and triggers "can't parse entities: Unexpected end tag".
 */
function normalizeTelegramAnchorTags(value: string): string {
  const unwrapAnchor = (href: string, inner: string): string => {
    const safeHref = String(href || "").trim();
    if (!isSafeExternalUrl(safeHref)) {
      return inner;
    }
    return `<a href="${escapeHtml(safeHref)}">${inner}</a>`;
  };

  return value
    .replace(
      /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href, inner) => unwrapAnchor(href, inner)
    )
    .replace(
      /<a\s+[^>]*href='([^']+)'[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href, inner) => unwrapAnchor(href, inner)
    );
}

export function formatReplyMarkdownForWhatsApp(value: string): string {
  if (!value) return "";

  const withVisibleLinks = replaceMarkdownLinksWithVisibleUrl(
    normalizeLineEndings(value)
  );

  return normalizeBulletWhitespace(
    withVisibleLinks
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/__([^_]+)__/g, "*$1*")
      .replace(/~~([^~]+)~~/g, "~$1~")
  );
}

export function formatReplyMarkdownForInstagram(value: string): string {
  if (!value) return "";
  const withVisibleLinks = replaceMarkdownLinksWithVisibleUrl(
    normalizeLineEndings(value)
  );
  return extractPlainText(withVisibleLinks, {
    preserveLineBreaks: true,
  }).trim();
}

export function formatReplyMarkdownForTelegramHtml(value: string): string {
  if (!value) return "";
  const normalized = expandChainedUnicodeBulletItems(
    normalizeLineEndings(value)
  );

  try {
    const parsed = marked.parse(normalized, {
      async: false,
      gfm: true,
      breaks: true,
    });
    const parsedHtml =
      typeof parsed === "string" ? parsed : escapeHtml(normalized);

    // Phase 1: structural transforms that need the original <p>/<li>/<h*>
    // scaffolding around them (lists/headings/code blocks). These must run
    // BEFORE we collapse paragraphs, otherwise loose list items and
    // heading contents lose their delimiters.
    const structuralized = preserveTelegramCodeBlockLanguage(
      convertOrderedListsToNumbered(
        convertUnorderedListsToBullets(convertHeadingsToBold(parsedHtml))
      )
    );

    // Phase 2: inline entity normalization + remaining block cleanup.
    // Keep `<blockquote>` intact so Telegram renders the quote style; we
    // only need to flatten `<p>` wrappers that marked emits inside it.
    const transformed = structuralized
      .replace(/<strong>/gi, "<b>")
      .replace(/<\/strong>/gi, "</b>")
      .replace(/<em>/gi, "<i>")
      .replace(/<\/em>/gi, "</i>")
      .replace(/<ins>/gi, "<u>")
      .replace(/<\/ins>/gi, "</u>")
      .replace(/<(?:del|strike)>/gi, "<s>")
      .replace(/<\/(?:del|strike)>/gi, "</s>")
      .replace(/<hr\s*\/?>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p>/gi, "\n\n")
      .replace(/<\/?p>/gi, "\n")
      .replace(/<\/?div>/gi, "\n");

    return normalizeBulletWhitespace(
      trimBlockquoteWhitespace(
        stripUnsupportedTelegramHtmlTags(
          normalizeTelegramAnchorTags(transformed)
        )
      )
    );
  } catch {
    return escapeHtml(normalized).trim();
  }
}
