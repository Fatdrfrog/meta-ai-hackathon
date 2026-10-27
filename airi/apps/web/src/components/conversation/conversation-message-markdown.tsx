"use client";

import { normalizeMessageMarkdown } from "@/lib/conversation/message-markdown";
import { marked } from "marked";
import { createElement, memo, type ReactNode } from "react";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function sanitizeHref(href?: string | null): string | null {
  if (!href) return null;

  const trimmedHref = href.trim();
  if (!trimmedHref) return null;

  try {
    const parsed = new URL(trimmedHref, "https://airi.chat");
    const hasProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmedHref);

    if (
      hasProtocol &&
      !SAFE_LINK_PROTOCOLS.has(parsed.protocol.toLowerCase())
    ) {
      return null;
    }

    return trimmedHref;
  } catch {
    return null;
  }
}

type MessageMarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  tokens?: MessageMarkdownToken[];
  items?: MessageMarkdownToken[];
  href?: string;
  title?: string | null;
  ordered?: boolean;
  depth?: number;
};

function renderInlineMarkdownTokens(
  tokens: MessageMarkdownToken[] | undefined,
  keyPrefix: string
): ReactNode[] {
  return (tokens || []).map((token, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (token.type) {
      case "text":
      case "escape":
        return token.text || "";
      case "strong":
        return (
          <strong key={key}>
            {renderInlineMarkdownTokens(token.tokens, key)}
          </strong>
        );
      case "em":
        return (
          <em key={key}>{renderInlineMarkdownTokens(token.tokens, key)}</em>
        );
      case "codespan":
        return <code key={key}>{token.text || ""}</code>;
      case "br":
        return <br key={key} />;
      case "del":
        return (
          <del key={key}>{renderInlineMarkdownTokens(token.tokens, key)}</del>
        );
      case "link":
      case "image": {
        const safeHref = sanitizeHref(token.href);
        // Inline images stay caption links; they never load remote media.
        const children =
          token.type === "image"
            ? token.text || token.href || ""
            : renderInlineMarkdownTokens(token.tokens, key);
        if (!safeHref) {
          return token.type === "image" ? (
            children
          ) : (
            <span key={key}>{children}</span>
          );
        }
        const isExternalLink = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(safeHref);
        return (
          <a
            key={key}
            href={safeHref}
            title={token.type === "link" ? token.title || undefined : undefined}
            target={isExternalLink ? "_blank" : undefined}
            rel={isExternalLink ? "noopener noreferrer nofollow" : undefined}
          >
            {children}
          </a>
        );
      }
      default:
        // Keep HTML as literal text, escaped by React.
        return token.text || token.raw || "";
    }
  });
}

function renderBlockMarkdownTokens(
  tokens: MessageMarkdownToken[],
  keyPrefix = "md"
): ReactNode[] {
  return tokens.flatMap((token, index): ReactNode[] => {
    const key = `${keyPrefix}-${index}`;

    switch (token.type) {
      case "space":
        return [];
      case "paragraph":
        return [
          <p key={key}>{renderInlineMarkdownTokens(token.tokens, key)}</p>,
        ];
      case "heading": {
        const depth = Math.min(Math.max(token.depth || 2, 1), 6);
        return [
          createElement(
            `h${depth}`,
            { key },
            renderInlineMarkdownTokens(token.tokens, key)
          ),
        ];
      }
      case "list": {
        const Tag = token.ordered ? "ol" : "ul";
        return [
          createElement(
            Tag,
            { key },
            (token.items || []).map((item, itemIndex) => (
              <li key={`${key}-item-${itemIndex}`}>
                {renderBlockMarkdownTokens(
                  item.tokens || [{ type: "text", text: item.text || "" }],
                  `${key}-item-${itemIndex}`
                )}
              </li>
            ))
          ),
        ];
      }
      case "blockquote":
        return [
          <blockquote key={key}>
            {renderBlockMarkdownTokens(token.tokens || [], key)}
          </blockquote>,
        ];
      case "code":
        return [
          <pre key={key}>
            <code>{token.text || ""}</code>
          </pre>,
        ];
      case "hr":
        return [<hr key={key} />];
      case "html":
        return [token.text || token.raw || ""];
      default:
        return token.tokens
          ? renderInlineMarkdownTokens(token.tokens, key)
          : [token.text || token.raw || ""];
    }
  });
}

function renderMessageMarkdown(text: string): ReactNode[] {
  const normalizedInput = normalizeMessageMarkdown(text);
  if (!normalizedInput) return [];

  // A conservative subset with no Markdown syntax, entities or autolinks.
  // Other text still goes through the canonical lexer and safe-link renderer.
  if (
    /^[\p{L}\p{N}][\p{L}\p{N} ,.!?;:%()₸₽$€£—–…+-]*$/u.test(normalizedInput) &&
    !/\bwww\.|^\d+\)\s/i.test(normalizedInput)
  ) {
    return [<p key="md-0">{normalizedInput}</p>];
  }

  const tokens = marked.lexer(normalizedInput, {
    gfm: true,
    breaks: true,
  }) as MessageMarkdownToken[];
  return renderBlockMarkdownTokens(tokens);
}

export const ConversationMessageMarkdown = memo(
  function ConversationMessageMarkdown({ text }: { text: string }) {
    return <>{renderMessageMarkdown(text)}</>;
  }
);
