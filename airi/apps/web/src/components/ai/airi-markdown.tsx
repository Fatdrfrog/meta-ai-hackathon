"use client";

import { Lexer } from "marked";
import type { ReactNode } from "react";

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  ordered?: boolean;
  depth?: number;
  href?: string;
  lang?: string;
};

function isSafeHref(value: string): boolean {
  if (value.startsWith("/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function getInlineTokens(token: MarkdownToken): MarkdownToken[] {
  if (token.tokens) return token.tokens;
  return Lexer.lexInline(token.text || "") as MarkdownToken[];
}

function renderInlineTokens(
  tokens: MarkdownToken[] | undefined,
  keyPrefix: string
): ReactNode[] {
  return (tokens || []).map((token, index) => {
    const key = `${keyPrefix}:${token.type}:${index}`;
    if (token.type === "text") {
      return token.tokens ? renderInlineTokens(token.tokens, key) : token.text;
    }
    if (token.type === "strong") {
      return <strong key={key}>{renderInlineTokens(token.tokens, key)}</strong>;
    }
    if (token.type === "em") {
      return <em key={key}>{renderInlineTokens(token.tokens, key)}</em>;
    }
    if (token.type === "codespan") {
      return (
        <code
          key={key}
          className="rounded bg-current/10 px-1 py-0.5 text-[0.92em]"
        >
          {token.text}
        </code>
      );
    }
    if (token.type === "link" && token.href) {
      if (!isSafeHref(token.href)) {
        return renderInlineTokens(token.tokens, key);
      }
      return (
        <a
          key={key}
          href={token.href}
          target={token.href.startsWith("/") ? undefined : "_blank"}
          rel={token.href.startsWith("/") ? undefined : "noreferrer"}
          className="font-medium underline underline-offset-2"
        >
          {renderInlineTokens(token.tokens, key)}
        </a>
      );
    }
    if (token.type === "br") {
      return <br key={key} />;
    }
    return token.text || token.raw || null;
  });
}

function renderListItem(token: MarkdownToken, key: string): ReactNode {
  const inlineOnly =
    token.tokens?.length === 1 &&
    ["text", "paragraph"].includes(token.tokens[0]?.type || "");
  if (inlineOnly) {
    return renderInlineTokens(getInlineTokens(token.tokens![0]), key);
  }
  return renderBlocks(token.tokens || [], key);
}

function renderBlocks(tokens: MarkdownToken[], keyPrefix: string): ReactNode[] {
  return tokens
    .map((token, index): ReactNode => {
      const key = `${keyPrefix}:${token.type}:${index}`;
      if (token.type === "space") return null;
      if (token.type === "heading") {
        const HeadingTag = (token.depth || 2) <= 1 ? "h3" : "h4";
        return (
          <HeadingTag key={key} className="font-semibold leading-snug">
            {renderInlineTokens(getInlineTokens(token), key)}
          </HeadingTag>
        );
      }
      if (token.type === "paragraph") {
        return (
          <p key={key} className="leading-6">
            {renderInlineTokens(getInlineTokens(token), key)}
          </p>
        );
      }
      if (token.type === "list") {
        const ListTag = token.ordered ? "ol" : "ul";
        return (
          <ListTag
            key={key}
            className={
              token.ordered
                ? "list-decimal space-y-1 pl-5"
                : "list-disc space-y-1 pl-5"
            }
          >
            {(token.items || []).map((item, itemIndex) => (
              <li key={`${key}:item:${itemIndex}`}>
                {renderListItem(item, `${key}:item:${itemIndex}`)}
              </li>
            ))}
          </ListTag>
        );
      }
      if (token.type === "blockquote") {
        return (
          <blockquote
            key={key}
            className="border-l-2 border-current/20 pl-3 text-muted-foreground"
          >
            <div className="space-y-2">
              {renderBlocks(token.tokens || [], key)}
            </div>
          </blockquote>
        );
      }
      if (token.type === "code") {
        return (
          <pre
            key={key}
            className="overflow-x-auto rounded-xl bg-current/10 p-3 text-xs"
          >
            <code>{token.text}</code>
          </pre>
        );
      }
      if (token.type === "hr") {
        return <div key={key} className="h-px bg-current/10" />;
      }
      return token.text ? (
        <p key={key} className="leading-6">
          {token.text}
        </p>
      ) : null;
    })
    .filter(Boolean);
}

export function AiriMarkdown({ content }: { content: string }) {
  const tokens = Lexer.lex(content, {
    async: false,
    breaks: true,
    gfm: true,
  }) as MarkdownToken[];
  const blocks = renderBlocks(tokens, "airi-md");

  if (blocks.length === 0) return null;

  return <div className="space-y-3">{blocks}</div>;
}
