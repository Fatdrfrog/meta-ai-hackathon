import { marked } from "marked";

export type MarkdownImportFile = {
  name: string;
  type?: string;
  text: () => Promise<string>;
};

export type MarkdownImportResult = {
  html: string;
  markdown: string;
  title: string;
  sourceName: string;
};

const MARKDOWN_EXTENSION_RE = /\.(md|markdown)$/i;
const MARKDOWN_MIME_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
  "application/x-markdown",
]);

function normalizeFileType(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function isMarkdownImportFile(
  file: Pick<MarkdownImportFile, "name" | "type">
): boolean {
  const name = String(file.name || "").trim();
  const type = normalizeFileType(file.type);

  if (MARKDOWN_EXTENSION_RE.test(name)) {
    return true;
  }

  return MARKDOWN_MIME_TYPES.has(type);
}

function stripMarkdownExtension(fileName: string): string {
  return fileName.replace(MARKDOWN_EXTENSION_RE, "").trim();
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstH1(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    if (/^\s{0,3}```/.test(line) || /^\s{0,3}~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const match = /^\s{0,3}#(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1]) {
      const title = stripInlineMarkdown(match[1]);
      if (title) {
        return title;
      }
    }
  }

  return null;
}

export function extractMarkdownImportTitle(params: {
  markdown: string;
  fileName: string;
}): string {
  const h1 = findFirstH1(params.markdown);
  if (h1) {
    return h1;
  }

  return stripMarkdownExtension(params.fileName) || "Imported Markdown";
}

export function convertMarkdownImportToHtml(markdown: string): string {
  const parsed = marked.parse(markdown, { async: false });
  return typeof parsed === "string" ? parsed.trim() : markdown.trim();
}

export async function buildMarkdownImport(
  file: MarkdownImportFile
): Promise<MarkdownImportResult> {
  if (!isMarkdownImportFile(file)) {
    throw new Error("Unsupported file type");
  }

  const markdown = (await file.text()).trim();
  if (!markdown) {
    throw new Error("Markdown file is empty");
  }

  return {
    html: convertMarkdownImportToHtml(markdown),
    markdown,
    title: extractMarkdownImportTitle({ markdown, fileName: file.name }),
    sourceName: file.name,
  };
}
