/**
 * WhatsApp text formatting utilities.
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```monospace```
 * Keep this intentionally narrower than full Markdown because WhatsApp
 * renders a small marker subset in message/template text.
 */

import {
  getScenarioTokenFallbackLabel,
  SCENARIO_VARIABLE_CHIP_CLASSNAME,
  SCENARIO_VARIABLE_TOKEN_REGEX,
} from "@/components/scenarios/view/scenario-template-utils";
import { escapeHtml } from "@icecore/shared/lib/html-utils";

export type WhatsAppTextFormatKind =
  | "bold"
  | "italic"
  | "strikethrough"
  | "monospace";

export type WhatsAppTextFormatSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "format";
      kind: Exclude<WhatsAppTextFormatKind, "monospace">;
      children: WhatsAppTextFormatSegment[];
    }
  | {
      type: "format";
      kind: "monospace";
      text: string;
    };

const INLINE_MARKERS = {
  "*": "bold",
  _: "italic",
  "~": "strikethrough",
} as const;

const MAX_PARSE_DEPTH = 4;

function isWhitespace(value: string | undefined): boolean {
  return Boolean(value && /\s/u.test(value));
}

function isWordChar(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function getInlineMarkerKind(
  marker: string
): (typeof INLINE_MARKERS)[keyof typeof INLINE_MARKERS] | null {
  return marker in INLINE_MARKERS
    ? INLINE_MARKERS[marker as keyof typeof INLINE_MARKERS]
    : null;
}

function canOpenInlineMarker(
  source: string,
  index: number,
  end: number,
  marker: string
): boolean {
  if (source[index - 1] === marker || source[index + 1] === marker) {
    return false;
  }
  if (index + 1 >= end || isWhitespace(source[index + 1])) {
    return false;
  }
  return !isWordChar(source[index - 1]);
}

function canCloseInlineMarker(
  source: string,
  index: number,
  marker: string
): boolean {
  if (source[index - 1] === marker || source[index + 1] === marker) {
    return false;
  }
  if (isWhitespace(source[index - 1])) {
    return false;
  }
  return !isWordChar(source[index + 1]);
}

function findClosingInlineMarker(
  source: string,
  marker: string,
  start: number,
  end: number
): number {
  let i = start;
  while (i < end) {
    if (source.startsWith("```", i)) {
      const codeEnd = source.indexOf("```", i + 3);
      if (codeEnd === -1 || codeEnd >= end) return -1;
      i = codeEnd + 3;
      continue;
    }

    if (source[i] === marker && canCloseInlineMarker(source, i, marker)) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function mergeAdjacentTextSegments(
  segments: WhatsAppTextFormatSegment[]
): WhatsAppTextFormatSegment[] {
  const merged: WhatsAppTextFormatSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (segment.type === "text" && previous?.type === "text") {
      previous.text += segment.text;
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

function parseWhatsAppTextRange(
  source: string,
  start: number,
  end: number,
  depth: number
): WhatsAppTextFormatSegment[] {
  const segments: WhatsAppTextFormatSegment[] = [];
  let buffer = "";
  let i = start;

  const flushText = () => {
    if (!buffer) return;
    segments.push({ type: "text", text: buffer });
    buffer = "";
  };

  while (i < end) {
    if (source.startsWith("```", i)) {
      const close = source.indexOf("```", i + 3);
      if (close !== -1 && close < end && close > i + 3) {
        flushText();
        segments.push({
          type: "format",
          kind: "monospace",
          text: source.slice(i + 3, close),
        });
        i = close + 3;
        continue;
      }
    }

    const marker = source[i] ?? "";
    const kind = getInlineMarkerKind(marker);
    if (kind && canOpenInlineMarker(source, i, end, marker)) {
      const close = findClosingInlineMarker(source, marker, i + 1, end);
      if (close !== -1 && close > i + 1) {
        flushText();
        const innerText = source.slice(i + 1, close);
        segments.push({
          type: "format",
          kind,
          children:
            depth >= MAX_PARSE_DEPTH
              ? [{ type: "text", text: innerText }]
              : parseWhatsAppTextRange(source, i + 1, close, depth + 1),
        });
        i = close + 1;
        continue;
      }
    }

    buffer += source[i];
    i += 1;
  }

  flushText();
  return mergeAdjacentTextSegments(segments);
}

export function parseWhatsAppTextFormatting(
  text: string
): WhatsAppTextFormatSegment[] {
  if (!text || typeof text !== "string") return [];
  return parseWhatsAppTextRange(text, 0, text.length, 0);
}

function formatSegmentsToEditorHtml(
  segments: WhatsAppTextFormatSegment[]
): string {
  return segments
    .map(segment => {
      if (segment.type === "text") {
        return escapeHtml(segment.text).replace(/\n/g, "<br>");
      }
      if (segment.kind === "monospace") {
        return `<code>${escapeHtml(segment.text)}</code>`;
      }
      const inner = formatSegmentsToEditorHtml(segment.children);
      if (segment.kind === "bold") return `<strong>${inner}</strong>`;
      if (segment.kind === "italic") return `<em>${inner}</em>`;
      return `<s>${inner}</s>`;
    })
    .join("");
}

/**
 * Convert HTML (from TipTap) to WhatsApp formatting markers.
 * Works in both browser and Node (API routes).
 * - <strong>, <b> → *text*
 * - <em>, <i> → _text_
 * - <s>, <strike> → ~text~
 * - <code> → ```text```
 * - <br>, </p><p> → newline
 */
export function htmlToWhatsAppFormat(html: string): string {
  if (!html || typeof html !== "string") return "";
  const trimmed = html.trim();
  if (!trimmed) return "";

  // Plain text (no HTML tags) - return as-is
  if (!/<[a-z][\s\S]*>/i.test(trimmed)) {
    return trimmed;
  }

  // Use DOM in browser, regex fallback in Node
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(trimmed, "text/html");
      return walkToWhatsApp(doc.body).trim();
    } catch {
      return htmlToWhatsAppFormatRegex(trimmed);
    }
  }
  return htmlToWhatsAppFormatRegex(trimmed);
}

/**
 * Convert HTML (from TipTap) to plain text.
 * Keeps basic line breaks but removes formatting tags entirely.
 */
export function htmlToPlainText(html: string): string {
  if (!html || typeof html !== "string") return "";
  const trimmed = html.trim();
  if (!trimmed) return "";

  if (!/<[a-z][\s\S]*>/i.test(trimmed)) {
    return trimmed;
  }

  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(trimmed, "text/html");
      return walkToPlainText(doc.body).trim();
    } catch {
      return htmlToPlainTextRegex(trimmed);
    }
  }

  return htmlToPlainTextRegex(trimmed);
}

function scenarioVariableTokenFromElement(el: Element): string | null {
  const token = el.getAttribute("data-scenario-variable")?.trim();
  return token || null;
}

function walkToWhatsApp(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const variableToken = scenarioVariableTokenFromElement(el);
  if (variableToken) {
    return `{{${variableToken}}}`;
  }

  const childText = Array.from(node.childNodes).map(walkToWhatsApp).join("");

  switch (tag) {
    case "strong":
    case "b":
      return childText ? `*${childText}*` : "";
    case "em":
    case "i":
      return childText ? `_${childText}_` : "";
    case "s":
    case "strike":
    case "del":
      return childText ? `~${childText}~` : "";
    case "code":
      return childText ? `\`\`\`${childText}\`\`\`` : "";
    case "br":
      return "\n";
    case "p":
    case "div":
      return childText + (childText ? "\n" : "");
    default:
      return childText;
  }
}

function walkToPlainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const variableToken = scenarioVariableTokenFromElement(el);
  if (variableToken) {
    return `{{${variableToken}}}`;
  }
  const childText = Array.from(node.childNodes).map(walkToPlainText).join("");

  switch (tag) {
    case "br":
      return "\n";
    case "p":
    case "div":
      return childText + (childText ? "\n" : "");
    default:
      return childText;
  }
}

const SCENARIO_VARIABLE_SPAN_REGEX =
  /<span\b[^>]*\bdata-scenario-variable=(["'])(.*?)\1[^>]*>[\s\S]*?<\/span>/gi;

function replaceScenarioVariableSpans(html: string): string {
  return html.replace(
    SCENARIO_VARIABLE_SPAN_REGEX,
    (_match, _quote: string, token: string) => `{{${token}}}`
  );
}

function injectScenarioVariableChips(
  html: string,
  resolveLabel?: (token: string) => string
): string {
  return html.replace(SCENARIO_VARIABLE_TOKEN_REGEX, (_match, token: string) => {
    const label = escapeHtml(
      resolveLabel?.(token) ?? getScenarioTokenFallbackLabel(token)
    );
    const safeToken = escapeHtml(token);
    return `<span data-scenario-variable="${safeToken}" data-label="${label}" class="${SCENARIO_VARIABLE_CHIP_CLASSNAME}">${label}</span>`;
  });
}

/** Regex-based fallback for Node (no DOM) */
function htmlToWhatsAppFormatRegex(html: string): string {
  let s = replaceScenarioVariableSpans(html);
  // Line breaks first
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, "\n");
  s = s.replace(/<\/?p[^>]*>/gi, "\n");
  // Multi-pass for nested tags (inner to outer)
  for (let i = 0; i < 5; i++) {
    const prev = s;
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "```$1```");
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "*$1*");
    s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "*$1*");
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_");
    s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_");
    s = s.replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, "~$1~");
    s = s.replace(/<strike[^>]*>([\s\S]*?)<\/strike>/gi, "~$1~");
    s = s.replace(/<del[^>]*>([\s\S]*?)<\/del>/gi, "~$1~");
    if (s === prev) break;
  }
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return s.trim();
}

function htmlToPlainTextRegex(html: string): string {
  let s = replaceScenarioVariableSpans(html);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, "\n");
  s = s.replace(/<\/?p[^>]*>/gi, "\n");
  s = s.replace(/<\/div>\s*<div[^>]*>/gi, "\n");
  s = s.replace(/<\/?div[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return s.trim();
}

/**
 * Convert plain text or WhatsApp format to HTML for TipTap editor.
 * Used when loading existing content that may be plain text.
 */
export function textToEditorHtml(
  text: string,
  options?: { resolveVariableLabel?: (token: string) => string }
): string {
  if (!text || typeof text !== "string") return "<p></p>";
  const trimmed = text.trim();
  if (!trimmed) return "<p></p>";

  // Already HTML (from TipTap)
  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    return injectScenarioVariableChips(trimmed, options?.resolveVariableLabel);
  }

  return injectScenarioVariableChips(
    `<p>${formatSegmentsToEditorHtml(parseWhatsAppTextFormatting(trimmed))}</p>`,
    options?.resolveVariableLabel
  );
}
