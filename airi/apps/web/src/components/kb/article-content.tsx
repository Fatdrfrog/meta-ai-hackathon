"use client";

import { cn } from "@/lib/utils";
import {
  buildKBGoogleFontsStylesheetHref,
  extractKBGoogleFontFamilies,
  sanitizeKBGoogleFontFamily,
} from "@/lib/kb/kb-google-fonts";
import {
  buildKBImageCssStyle,
  normalizeKBImageDimension,
} from "@/lib/kb/kb-image-dimensions";
import { sanitizeKBColorValue } from "@/lib/kb/kb-text-colors";
import {
  KB_EDITOR_CODE_BLOCK_CLASS_NAME,
  KB_EDITOR_IMAGE_CLASS_NAME,
  KB_EDITOR_INLINE_CODE_CLASS_NAME,
  KB_EDITOR_LINK_CLASS_NAME,
  KB_EDITOR_TABLE_CELL_CLASS_NAME,
  KB_EDITOR_TABLE_CLASS_NAME,
  KB_EDITOR_TABLE_WRAPPER_CLASS_NAME,
  KB_EDITOR_YOUTUBE_IFRAME_CLASS_NAME,
} from "@/lib/kb/kb-editor-classes";
import {
  getSafeYoutubeEmbedUrl,
  KB_YOUTUBE_IFRAME_ALLOW,
  KB_YOUTUBE_IFRAME_TITLE,
} from "@/lib/kb/youtube-embed";
import { createElement, useEffect, useState, type ReactNode } from "react";
import { KBEditorBaseStyles } from "./kb-editor-base-styles";
import { convertContentToHtml } from "@/lib/kb/content-utils";

type ArticleContentProps = {
  content: string;
  className?: string;
};

type SafeTextAlign = "left" | "center" | "right" | "justify";

type SafeArticleStyle = {
  backgroundColor?: string;
  color?: string;
  fontFamily?: string;
  textAlign?: SafeTextAlign;
};

const SAFE_ARTICLE_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "caption",
  "code",
  "col",
  "colgroup",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const SAFE_ARTICLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_TABLE_ALIGNMENTS = new Set<SafeTextAlign>([
  "left",
  "center",
  "right",
  "justify",
]);
const SAFE_TABLE_HEADER_SCOPES = new Set([
  "row",
  "col",
  "rowgroup",
  "colgroup",
]);
const TABLE_STRUCTURE_TAGS = new Set([
  "colgroup",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
]);
const SAFE_CSS_LENGTH = /^\d+(?:\.\d+)?(?:px|%|rem|em|ch|vw|vh)?$/i;
const SAFE_CODE_LANGUAGE_CLASS = /^language-[a-z0-9_-]{1,40}$/i;

function isTiptapTableWrapperElement(element: Element | null) {
  return (
    element?.tagName.toLowerCase() === "div" &&
    element.classList.contains(KB_EDITOR_TABLE_WRAPPER_CLASS_NAME)
  );
}

function sanitizeArticleUrl(value: string | null, imageOnly = false) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed, "https://airi.chat");
    const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
    if (imageOnly && parsed.protocol === "data:") {
      return /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(trimmed)
        ? trimmed
        : null;
    }
    if (hasProtocol && !SAFE_ARTICLE_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function getBoundedTableSpan(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    return undefined;
  }
  return parsed;
}

function getSafeTableAlignment(value: string | null) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase() as SafeTextAlign;
  return SAFE_TABLE_ALIGNMENTS.has(normalized) ? normalized : undefined;
}

function getSafeCssLength(value: string | null) {
  const normalized = String(value || "").trim();
  if (!SAFE_CSS_LENGTH.test(normalized)) {
    return undefined;
  }
  return /^\d+(?:\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
}

function getSafeStyleWidth(value: string | null) {
  const width = String(value || "").match(/(?:^|;)\s*width\s*:\s*([^;]+)/i);
  return getSafeCssLength(width?.[1] ?? null);
}

function getStyleDeclarationValue(style: string | null, property: string) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(style || "").match(
    new RegExp(`(?:^|;)\\s*${escapedProperty}\\s*:\\s*([^;]+)`, "i")
  );

  return match?.[1]?.trim() ?? null;
}

function getSafeFontFamily(value: string | null) {
  const firstFamily = String(value || "")
    .split(",")[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, "");

  return sanitizeKBGoogleFontFamily(firstFamily);
}

function getSafeArticleStyle(element: Element): SafeArticleStyle | undefined {
  const styleAttribute = element.getAttribute("style");
  const textAlign =
    getSafeTableAlignment(
      getStyleDeclarationValue(styleAttribute, "text-align")
    ) || getSafeTableAlignment(element.getAttribute("align"));
  const color = sanitizeKBColorValue(
    getStyleDeclarationValue(styleAttribute, "color")
  );
  const backgroundColor = sanitizeKBColorValue(
    getStyleDeclarationValue(styleAttribute, "background-color")
  );
  const fontFamily = getSafeFontFamily(
    getStyleDeclarationValue(styleAttribute, "font-family")
  );
  const style = {
    ...(textAlign ? { textAlign } : {}),
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(fontFamily ? { fontFamily } : {}),
  };

  return Object.keys(style).length > 0 ? style : undefined;
}

function getSafeTableColumnWidth(element: Element) {
  return (
    getSafeCssLength(element.getAttribute("width")) ||
    getSafeStyleWidth(element.getAttribute("style"))
  );
}

function getSafeTableCellWidth(element: Element) {
  const colWidth = String(
    element.getAttribute("colwidth") ||
      element.getAttribute("data-colwidth") ||
      ""
  )
    .split(",")
    .map(value => value.trim())
    .find(Boolean);

  return getSafeCssLength(colWidth ?? null);
}

function getSafeTableCellProps(element: Element, key: string) {
  const colSpan = getBoundedTableSpan(element.getAttribute("colspan"));
  const rowSpan = getBoundedTableSpan(element.getAttribute("rowspan"));
  const textAlign = getSafeTableAlignment(element.getAttribute("align"));
  const width = getSafeTableCellWidth(element);
  const scope = String(element.getAttribute("scope") || "")
    .trim()
    .toLowerCase();
  const style = {
    ...(textAlign ? { textAlign } : {}),
    ...(width ? { width } : {}),
  };

  return {
    key,
    className: KB_EDITOR_TABLE_CELL_CLASS_NAME,
    ...(colSpan ? { colSpan } : {}),
    ...(rowSpan ? { rowSpan } : {}),
    ...(Object.keys(style).length > 0 ? { style } : {}),
    ...(SAFE_TABLE_HEADER_SCOPES.has(scope) ? { scope } : {}),
  };
}

function getSafeCodeLanguageClass(element: Element) {
  return Array.from(element.classList).find(className =>
    SAFE_CODE_LANGUAGE_CLASS.test(className)
  );
}

function getSafeImageDimension(element: Element, name: "width" | "height") {
  const htmlElement = element instanceof HTMLElement ? element : null;

  return normalizeKBImageDimension(
    element.getAttribute(`data-${name}`) ??
      element.getAttribute(name) ??
      htmlElement?.style[name]
  );
}

function getSafeTitle(value: string | null) {
  const title = String(value || "").trim();
  return title || undefined;
}

function getSafeTableColumnProps(element: Element, key: string) {
  const width = getSafeTableColumnWidth(element);
  const span = getBoundedTableSpan(element.getAttribute("span"));

  return {
    key,
    ...(span ? { span } : {}),
    ...(width ? { style: { width } } : {}),
  };
}

function isYoutubeVideoWrapper(element: Element | null) {
  return (
    element?.tagName.toLowerCase() === "div" &&
    element.hasAttribute("data-youtube-video")
  );
}

function renderSafeYoutubeIframe(element: Element, key: string): ReactNode {
  const src = getSafeYoutubeEmbedUrl(element.getAttribute("src"));
  if (!src) return null;

  const iframe = createElement("iframe", {
    key: `${key}-iframe`,
    className: KB_EDITOR_YOUTUBE_IFRAME_CLASS_NAME,
    src,
    title:
      getSafeTitle(element.getAttribute("title")) || KB_YOUTUBE_IFRAME_TITLE,
    allow: KB_YOUTUBE_IFRAME_ALLOW,
    allowFullScreen: true,
    loading: "lazy",
    referrerPolicy: "strict-origin-when-cross-origin",
  });

  if (isYoutubeVideoWrapper(element.parentElement)) {
    return iframe;
  }

  return createElement("div", { key, "data-youtube-video": "" }, iframe);
}

function renderSafeArticleNode(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    const parentTag = node.parentElement?.tagName.toLowerCase();
    if (
      parentTag &&
      TABLE_STRUCTURE_TAGS.has(parentTag) &&
      !node.textContent?.trim()
    ) {
      return null;
    }
    return node.textContent || "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();

  if (tag === "iframe") {
    return renderSafeYoutubeIframe(element, key);
  }

  const children = Array.from(element.childNodes).map((child, index) =>
    renderSafeArticleNode(child, `${key}-${index}`)
  );

  if (!SAFE_ARTICLE_TAGS.has(tag)) {
    return children;
  }

  if (tag === "a") {
    const href = sanitizeArticleUrl(element.getAttribute("href"));
    const title = getSafeTitle(element.getAttribute("title"));
    return href
      ? createElement(
          "a",
          {
            key,
            className: KB_EDITOR_LINK_CLASS_NAME,
            href,
            target: "_blank",
            rel: "noopener noreferrer nofollow",
            ...(title ? { title } : {}),
          },
          children
        )
      : createElement("span", { key }, children);
  }

  if (tag === "img") {
    const src = sanitizeArticleUrl(element.getAttribute("src"), true);
    if (!src) return null;
    const width = getSafeImageDimension(element, "width");
    const height = getSafeImageDimension(element, "height");
    const style = buildKBImageCssStyle({ width, height });
    return createElement("img", {
      key,
      className: cn("kb-editor-image", KB_EDITOR_IMAGE_CLASS_NAME),
      src,
      alt: element.getAttribute("alt") || "",
      title: getSafeTitle(element.getAttribute("title")),
      loading: "lazy",
      decoding: "async",
      ...(width ? { "data-width": width } : {}),
      ...(height ? { "data-height": height } : {}),
      ...(Object.keys(style).length > 0 ? { style } : {}),
    });
  }

  if (tag === "span" && element.hasAttribute("data-kb-task-checkbox")) {
    return createElement("input", {
      key,
      type: "checkbox",
      checked: element.getAttribute("data-kb-task-checkbox") === "checked",
      disabled: true,
      readOnly: true,
      tabIndex: -1,
      className: "mr-2 align-middle",
    });
  }

  if (tag === "br" || tag === "hr") {
    return createElement(tag, { key });
  }

  if (tag === "col") {
    return createElement("col", getSafeTableColumnProps(element, key));
  }

  if (tag === "td" || tag === "th") {
    return createElement(tag, getSafeTableCellProps(element, key), children);
  }

  if (tag === "table") {
    const table = createElement(
      "table",
      { key: `${key}-table`, className: KB_EDITOR_TABLE_CLASS_NAME },
      children
    );

    return isTiptapTableWrapperElement(element.parentElement)
      ? table
      : createElement(
          "div",
          { key, className: KB_EDITOR_TABLE_WRAPPER_CLASS_NAME },
          table
        );
  }

  if (tag === "div" && isTiptapTableWrapperElement(element)) {
    return createElement(
      "div",
      { key, className: KB_EDITOR_TABLE_WRAPPER_CLASS_NAME },
      children
    );
  }

  if (isYoutubeVideoWrapper(element)) {
    return createElement("div", { key, "data-youtube-video": "" }, children);
  }

  if (tag === "pre") {
    return createElement(
      "pre",
      { key, className: KB_EDITOR_CODE_BLOCK_CLASS_NAME },
      children
    );
  }

  if (
    tag === "code" &&
    element.parentElement?.tagName.toLowerCase() !== "pre"
  ) {
    return createElement(
      "code",
      { key, className: KB_EDITOR_INLINE_CODE_CLASS_NAME },
      children
    );
  }

  if (tag === "code") {
    const languageClass = getSafeCodeLanguageClass(element);
    return createElement(
      "code",
      {
        key,
        ...(languageClass ? { className: languageClass } : {}),
      },
      children
    );
  }

  return createElement(
    tag,
    {
      key,
      ...(getSafeArticleStyle(element)
        ? { style: getSafeArticleStyle(element) }
        : {}),
    },
    children
  );
}

function renderSafeArticleHtml(html: string): ReactNode[] {
  if (typeof DOMParser === "undefined") {
    return [];
  }

  const parsed = new DOMParser().parseFromString(
    `<article>${html}</article>`,
    "text/html"
  );
  const root = parsed.body.firstElementChild;
  return Array.from(root?.childNodes || []).map((node, index) =>
    renderSafeArticleNode(node, `article-${index}`)
  );
}

export function ArticleContent({ content, className }: ArticleContentProps) {
  const html = convertContentToHtml(content);
  const [safeContent, setSafeContent] = useState<ReactNode[]>([]);
  const fontStylesheetHref = buildKBGoogleFontsStylesheetHref(
    extractKBGoogleFontFamilies(html)
  );

  useEffect(() => {
    setSafeContent(renderSafeArticleHtml(html));
  }, [html]);

  if (!html) {
    return null;
  }

  return (
    <>
      <KBEditorBaseStyles />
      {fontStylesheetHref ? (
        <link
          rel="stylesheet"
          href={fontStylesheetHref}
          data-kb-google-fonts="true"
        />
      ) : null}
      <div
        className={cn(
          "kb-editor prose prose-neutral dark:prose-invert max-w-none",
          className
        )}
      >
        {safeContent}
      </div>
    </>
  );
}
