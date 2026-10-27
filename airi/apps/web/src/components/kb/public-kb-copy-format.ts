import { convertContentToHtml } from "@/lib/kb/content-utils";
import { getSafeYoutubeEmbedUrl } from "@/lib/kb/youtube-embed";

type PublicKBMarkdownInput = {
  title: string;
  content: string;
};

type PublicKBLLMInput = PublicKBMarkdownInput & {
  articleUrl: string;
  companyName: string;
  locale: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
};

type MarkdownContext = {
  listDepth?: number;
};

const TABLE_CELL_SELECTOR = "td, th";
const SAFE_LANGUAGE_CLASS = /^language-([a-z0-9_-]{1,40})$/i;

function normalizeMarkdown(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineWhitespace(value: string) {
  return value.replace(/\s+/g, " ");
}

function normalizeHeadingText(value: string) {
  return normalizeInlineWhitespace(value).trim();
}

function escapeMarkdownText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]~])/g, "\\$1");
}

function escapeMarkdownLinkText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
}

function escapeMarkdownUrl(value: string) {
  return value.trim().replace(/\s/g, "%20").replace(/\)/g, "%29");
}

function escapeMarkdownTableCell(value: string) {
  return normalizeInlineWhitespace(value)
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

function getInlineMarkdown(
  nodes: NodeListOf<ChildNode>,
  context: MarkdownContext
) {
  return Array.from(nodes)
    .map(node => nodeToMarkdown(node, context))
    .join("")
    .trim();
}

function getCodeFence(value: string) {
  const longestFence =
    value.match(/`+/g)?.reduce((longest, fence) => {
      return fence.length > longest ? fence.length : longest;
    }, 0) ?? 0;

  return "`".repeat(Math.max(3, longestFence + 1));
}

function getCodeLanguage(element: Element) {
  const codeElement =
    element.tagName.toLowerCase() === "code"
      ? element
      : element.querySelector("code");
  const languageClass = Array.from(codeElement?.classList || []).find(
    className => SAFE_LANGUAGE_CLASS.test(className)
  );

  return languageClass?.match(SAFE_LANGUAGE_CLASS)?.[1] || "";
}

function getInlineCodeMarkdown(value: string) {
  const fence = getCodeFence(value);
  const paddedValue =
    value.startsWith("`") || value.endsWith("`") ? ` ${value} ` : value;

  return `${fence}${paddedValue}${fence}`;
}

function getBlockMarkdown(value: string) {
  const normalized = normalizeMarkdown(value);
  return normalized ? `\n\n${normalized}\n\n` : "";
}

function getListMarkdown(
  element: Element,
  ordered: boolean,
  context: MarkdownContext
) {
  const items = Array.from(element.children).filter(
    child => child.tagName.toLowerCase() === "li"
  );
  const depth = context.listDepth ?? 0;

  const markdown = items
    .map((item, index) => {
      const content = normalizeMarkdown(
        Array.from(item.childNodes)
          .map(node =>
            nodeToMarkdown(node, {
              ...context,
              listDepth: depth + 1,
            })
          )
          .join("")
      );
      const prefix = ordered ? `${index + 1}. ` : "- ";
      const indent = " ".repeat(prefix.length);
      const lines = content.split("\n");

      if (!content) {
        return prefix.trimEnd();
      }

      return lines
        .map((line, lineIndex) =>
          lineIndex === 0 ? `${prefix}${line}` : `${indent}${line}`
        )
        .join("\n");
    })
    .join("\n");

  return depth > 0 ? `\n${markdown}` : getBlockMarkdown(markdown);
}

function getBlockquoteMarkdown(element: Element, context: MarkdownContext) {
  const content = normalizeMarkdown(
    getInlineMarkdown(element.childNodes, context)
  );
  if (!content) return "";

  return getBlockMarkdown(
    content
      .split("\n")
      .map(line => (line ? `> ${line}` : ">"))
      .join("\n")
  );
}

function getTableMarkdown(element: Element) {
  const rows = Array.from(element.querySelectorAll("tr"))
    .map(row =>
      Array.from(row.querySelectorAll(TABLE_CELL_SELECTOR)).map(cell =>
        escapeMarkdownTableCell(cell.textContent || "")
      )
    )
    .filter(row => row.length > 0);

  if (!rows.length) {
    return "";
  }

  const columnCount = Math.max(...rows.map(row => row.length));
  const normalizedRows = rows.map(row => {
    return Array.from(
      { length: columnCount },
      (_value, index) => row[index] || ""
    );
  });
  const [header, ...body] = normalizedRows;
  const separator = Array.from({ length: columnCount }, () => "---");
  const markdownRows = [header, separator, ...body].map(
    row => `| ${row.join(" | ")} |`
  );

  return getBlockMarkdown(markdownRows.join("\n"));
}

function nodeToMarkdown(node: Node, context: MarkdownContext = {}): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || "";
    return escapeMarkdownText(normalizeInlineWhitespace(text));
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();

  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n---\n\n";

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const heading = normalizeHeadingText(
      getInlineMarkdown(element.childNodes, context)
    );
    return heading ? `\n\n${"#".repeat(level)} ${heading}\n\n` : "";
  }

  if (tag === "pre") {
    const code = element.textContent?.replace(/\n+$/, "") || "";
    const fence = getCodeFence(code);
    const language = getCodeLanguage(element);
    return code ? `\n\n${fence}${language}\n${code}\n${fence}\n\n` : "";
  }

  if (tag === "code") {
    if (element.parentElement?.tagName.toLowerCase() === "pre") {
      return element.textContent || "";
    }
    return getInlineCodeMarkdown(element.textContent || "");
  }

  if (tag === "strong" || tag === "b") {
    const content = getInlineMarkdown(element.childNodes, context);
    return content ? `**${content}**` : "";
  }

  if (tag === "em" || tag === "i") {
    const content = getInlineMarkdown(element.childNodes, context);
    return content ? `*${content}*` : "";
  }

  if (tag === "del" || tag === "s") {
    const content = getInlineMarkdown(element.childNodes, context);
    return content ? `~~${content}~~` : "";
  }

  if (tag === "a") {
    const href = element.getAttribute("href");
    const text =
      getInlineMarkdown(element.childNodes, context) ||
      escapeMarkdownText(href || "");

    return href
      ? `[${escapeMarkdownLinkText(text)}](${escapeMarkdownUrl(href)})`
      : text;
  }

  if (tag === "img") {
    const src = element.getAttribute("src");
    if (!src) return "";
    const alt = escapeMarkdownLinkText(element.getAttribute("alt") || "");
    return `![${alt}](${escapeMarkdownUrl(src)})`;
  }

  if (tag === "iframe") {
    const src = getSafeYoutubeEmbedUrl(element.getAttribute("src"));
    return src
      ? getBlockMarkdown(`[YouTube](${escapeMarkdownUrl(src)})`)
      : "";
  }

  if (tag === "span" && element.hasAttribute("data-kb-task-checkbox")) {
    return element.getAttribute("data-kb-task-checkbox") === "checked"
      ? "[x] "
      : "[ ] ";
  }

  if (tag === "ul" || tag === "ol") {
    return getListMarkdown(element, tag === "ol", context);
  }

  if (tag === "blockquote") {
    return getBlockquoteMarkdown(element, context);
  }

  if (tag === "table") {
    return getTableMarkdown(element);
  }

  const content = getInlineMarkdown(element.childNodes, context);

  if (
    tag === "p" ||
    tag === "div" ||
    tag === "section" ||
    tag === "article" ||
    tag === "figure" ||
    tag === "figcaption" ||
    tag === "caption"
  ) {
    return getBlockMarkdown(content);
  }

  if (tag === "li") {
    return content;
  }

  return content;
}

function parseContentHtml(content: string) {
  if (typeof DOMParser === "undefined") {
    return null;
  }

  const html = convertContentToHtml(content);
  if (!html) return null;

  const parsed = new DOMParser().parseFromString(
    `<article>${html}</article>`,
    "text/html"
  );

  return parsed.body.firstElementChild;
}

export function convertPublicKBContentToMarkdown(content: string) {
  const root = parseContentHtml(content);
  if (!root) return "";

  return normalizeMarkdown(
    Array.from(root.childNodes)
      .map(node => nodeToMarkdown(node))
      .join("")
  );
}

export function buildPublicKBMarkdown({
  title,
  content,
}: PublicKBMarkdownInput) {
  const heading = normalizeHeadingText(title);
  const body = convertPublicKBContentToMarkdown(content);

  return normalizeMarkdown(
    [heading ? `# ${heading}` : "", body].filter(Boolean).join("\n\n")
  );
}

export function buildPublicKBLLMText({
  title,
  content,
  articleUrl,
  companyName,
  locale,
  publishedAt,
  updatedAt,
}: PublicKBLLMInput) {
  const heading = normalizeHeadingText(title);
  const body = convertPublicKBContentToMarkdown(content);
  const metadata = [
    articleUrl ? `Source: ${articleUrl}` : "",
    companyName ? `Company: ${companyName}` : "",
    locale ? `Locale: ${locale}` : "",
    publishedAt ? `Published: ${publishedAt}` : "",
    updatedAt ? `Updated: ${updatedAt}` : "",
  ].filter(Boolean);

  return normalizeMarkdown(
    [heading ? `# ${heading}` : "", metadata.join("\n"), body]
      .filter(Boolean)
      .join("\n\n")
  );
}
