/**
 * Deterministic extraction of http(s) URLs from KB source (MDX/HTML/plain)
 * before plain-text excerpting strips links. Used for prompts + outbound allowlists.
 */

import {
  isHttpOrHttpsUrl,
  normalizeHttpUrlForRag,
} from "@/lib/airi/rag/http-url-normalize";
import type { KBArticleResult } from "./kb-types";

/**
 * KB result mappers uniformly project embedded URLs as `string[] | undefined`
 * (undefined when there are none). Centralize the extraction + undefined
 * collapse so every KB retrieval path uses the same call shape and we can
 * later swap the URL extractor without touching the mappers. See plan Phase 1.11.
 */
export function embeddedSourceUrlsForArticle(
  raw: string | null | undefined
): string[] | undefined {
  if (!raw) return undefined;
  const urls = extractHttpUrlsFromKbSource(raw);
  return urls.length > 0 ? urls : undefined;
}

/**
 * Returns unique, normalized https? URLs found in the raw article/chunk body.
 */
export function extractHttpUrlsFromKbSource(raw: string): string[] {
  if (!raw || !raw.trim()) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  const push = (candidate: string) => {
    const normalized = normalizeHttpUrlForRag(candidate);
    if (!normalized || seen.has(normalized)) return;
    if (!isHttpOrHttpsUrl(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  const markdownLink = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = markdownLink.exec(raw)) !== null) {
    push(m[2]!);
  }

  const hrefDouble = /href\s*=\s*"(https?:\/\/[^"]+)"/gi;
  while ((m = hrefDouble.exec(raw)) !== null) {
    push(m[1]!);
  }
  const hrefSingle = /href\s*=\s*'(https?:\/\/[^']+)'/gi;
  while ((m = hrefSingle.exec(raw)) !== null) {
    push(m[1]!);
  }

  const bare = /https?:\/\/[^\s<>\])"'`]+/gi;
  while ((m = bare.exec(raw)) !== null) {
    push(m[0]!);
  }

  return out;
}

/** Normalized https? URL for `article.url`, or undefined if missing/invalid. */
export function normalizedKbArticlePageUrl(
  article: KBArticleResult
): string | undefined {
  const raw = article.url?.trim();
  if (!raw) return undefined;
  const normalized = normalizeHttpUrlForRag(raw);
  if (!isHttpOrHttpsUrl(normalized)) return undefined;
  return normalized;
}
