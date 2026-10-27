/**
 * Lightweight Markdown Parser for Widget
 *
 * Supports:
 * - **bold** or __bold__
 * - *italic* or _italic_
 * - [link text](url)
 * - Line breaks
 *
 * NOTE: This is a simple parser, not a full markdown implementation
 * Designed to be small and fast for the widget bundle
 */

export interface TextNode {
  type: "text";
  content: string;
}

export interface BoldNode {
  type: "bold";
  content: string;
}

export interface ItalicNode {
  type: "italic";
  content: string;
}

export interface LinkNode {
  type: "link";
  text: string;
  url: string;
}

export type MarkdownNode = TextNode | BoldNode | ItalicNode | LinkNode;

/**
 * Parse markdown text into structured nodes
 */
export function parseMarkdown(text: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Try to match link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      nodes.push({
        type: "link",
        text: linkMatch[1],
        url: linkMatch[2],
      });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Try to match bold: **text** or __text__
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      nodes.push({
        type: "bold",
        content: boldMatch[2],
      });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Try to match italic: *text* or _text_ (but not __ or **)
    const italicMatch = remaining.match(/^(\*|_)([^*_]+)\1/);
    if (
      italicMatch &&
      !remaining.startsWith("**") &&
      !remaining.startsWith("__")
    ) {
      nodes.push({
        type: "italic",
        content: italicMatch[2],
      });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // No match - take next character as plain text
    const nextSpecial = remaining.slice(1).search(/[\[\*_]/);
    const textLength = nextSpecial === -1 ? remaining.length : nextSpecial + 1;

    nodes.push({
      type: "text",
      content: remaining.slice(0, textLength),
    });
    remaining = remaining.slice(textLength);
  }

  return nodes;
}

/**
 * Check if text contains markdown
 */
export function hasMarkdown(text: string): boolean {
  return /(\*\*|__|[*_]|\[.+\]\(.+\))/.test(text);
}
