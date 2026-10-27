/**
 * Builds the allowlist of http(s) URLs that may appear in a grounded reply.
 *
 * Provenances:
 * - **Reflection citations** — {@link Citation} URLs from structured `GroundedAnswer`.
 * - **Chunk/body URLs** — from raw KB (`embeddedSourceUrls`, extracted from article body only).
 * - **Public article page URLs** — `KBArticleResult.url` when the workspace allows sharing
 *   article links on this channel (see {@link mergeReplyUrlAllowlist}).
 */
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import type { Citation } from "./evidence-types";
import {
  isHttpOrHttpsUrl,
  normalizeHttpUrlForRag,
} from "@/lib/airi/rag/http-url-normalize";
import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import { normalizedKbArticlePageUrl } from "@/lib/airi/rag/kb/kb-source-urls";

export function collectCitedSourceLinks(
  citations: Citation[],
  maxLinks: number = RAG_CONFIG.limits.kbArticles
): Array<{ url: string; title: string }> {
  const byUrl = new Map<string, { url: string; title: string }>();

  for (const citation of citations) {
    if (!citation.url) continue;

    const normalized = normalizeHttpUrlForRag(citation.url);
    if (!isHttpOrHttpsUrl(normalized)) continue;

    if (!byUrl.has(normalized)) {
      byUrl.set(normalized, {
        url: normalized,
        title: citation.label?.trim() || "Source",
      });
    }
  }

  return Array.from(byUrl.values()).slice(0, maxLinks);
}

const MAX_KB_EMBEDDED_URLS = 80;

export function collectKbEmbeddedSourceLinks(
  kbArticles: KBArticleResult[]
): Array<{ url: string; title: string }> {
  const merged = new Map<string, { url: string; title: string }>();

  for (const article of kbArticles || []) {
    const title = article.title?.trim() || "Source";
    for (const raw of article.embeddedSourceUrls || []) {
      const normalized = normalizeHttpUrlForRag(raw);
      if (!isHttpOrHttpsUrl(normalized)) continue;
      if (!merged.has(normalized)) {
        merged.set(normalized, { url: normalized, title });
      }
      if (merged.size >= MAX_KB_EMBEDDED_URLS) {
        return Array.from(merged.values());
      }
    }
  }

  return Array.from(merged.values());
}

const MAX_KB_ARTICLE_PAGE_URLS = 20;

/** Public KB / indexed page URLs on matched articles (for footer + gated allowlist). */
export function collectKbArticlePageLinks(
  kbArticles: KBArticleResult[]
): Array<{ url: string; title: string }> {
  const merged = new Map<string, { url: string; title: string }>();

  for (const article of kbArticles || []) {
    const normalized = normalizedKbArticlePageUrl(article);
    if (!normalized) continue;
    const title = article.title?.trim() || "Article";
    if (!merged.has(normalized)) {
      merged.set(normalized, { url: normalized, title });
    }
    if (merged.size >= MAX_KB_ARTICLE_PAGE_URLS) {
      return Array.from(merged.values());
    }
  }

  return Array.from(merged.values());
}

/**
 * Citations + chunk body URLs always; adds `KBArticleResult.url` only when
 * `includeArticlePageUrls` is true (channel + workspace setting).
 */
export function mergeReplyUrlAllowlist(params: {
  citationLinks: Array<{ url: string; title: string }>;
  kbArticles: KBArticleResult[];
  includeArticlePageUrls: boolean;
  /** When set, use these instead of calling {@link collectKbArticlePageLinks} again. */
  articlePageLinks?: Array<{ url: string; title: string }>;
}): Array<{ url: string; title: string }> {
  const fromKb = collectKbEmbeddedSourceLinks(params.kbArticles);
  const merged = new Map<string, { url: string; title: string }>();
  for (const link of params.citationLinks) {
    const n = normalizeHttpUrlForRag(link.url);
    if (!merged.has(n)) merged.set(n, { ...link, url: n });
  }
  for (const link of fromKb) {
    const n = normalizeHttpUrlForRag(link.url);
    if (!merged.has(n)) merged.set(n, link);
  }
  if (params.includeArticlePageUrls) {
    const pageLinks =
      params.articlePageLinks !== undefined
        ? params.articlePageLinks
        : collectKbArticlePageLinks(params.kbArticles);
    for (const link of pageLinks) {
      const n = normalizeHttpUrlForRag(link.url);
      if (!merged.has(n)) merged.set(n, link);
    }
  }
  return Array.from(merged.values());
}

export function allowedUrlsForLinks(
  links: Array<{ url: string; title: string }>
): Set<string> {
  return new Set(links.map(link => normalizeHttpUrlForRag(link.url)));
}
