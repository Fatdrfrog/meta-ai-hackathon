import "server-only";

import { extractPlainText } from "@/lib/kb/content-utils";
import { buildCacheKey, cache } from "@/lib/cache";
import { appendKBLocaleQuery } from "@/lib/kb/kb-route-prefetch";
import { pickKBArticleTitle } from "@/lib/kb/kb-title-overrides";
import { supabaseAdmin } from "@/lib/supabase/admin";

const PUBLIC_KB_SEARCH_CACHE_TTL_SECONDS = 60;
export const PUBLIC_KB_SEARCH_MIN_QUERY_LENGTH = 2;
export const PUBLIC_KB_SEARCH_MAX_QUERY_LENGTH = 120;
export const PUBLIC_KB_SEARCH_DEFAULT_LIMIT = 8;
export const PUBLIC_KB_SEARCH_MAX_LIMIT = 20;

export type PublicKBSearchResult = {
  id: string;
  title: string;
  excerpt: string;
  href: string;
  publishedAt: string | null;
  updatedAt: string | null;
  locale: string | null;
};

type PublicKBSearchRow = {
  id: string;
  title: string | null;
  excerpt: string | null;
  article_url: string | null;
  published_at: string | null;
  updated_at: string | null;
  locale: string | null;
};

export function normalizePublicKBSearchQuery(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PUBLIC_KB_SEARCH_MAX_QUERY_LENGTH);
}

export function normalizePublicKBSearchLimit(value: number | string | null) {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return PUBLIC_KB_SEARCH_DEFAULT_LIMIT;
  }

  return Math.min(PUBLIC_KB_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function buildResultHref(params: {
  companySlug: string;
  articleId: string;
  articleUrl?: string | null;
  locale?: string | null;
}) {
  const baseHref =
    params.articleUrl && params.articleUrl.startsWith("/")
      ? params.articleUrl
      : `/${params.companySlug}/kb/${params.articleId}`;

  return appendKBLocaleQuery(baseHref, params.locale);
}

function normalizeExcerpt(value: string | null | undefined) {
  return extractPlainText(value, { preserveLineBreaks: false })
    .replace(/\s+/g, " ")
    .trim();
}

function mapSearchRow(
  row: PublicKBSearchRow,
  params: { companySlug: string; locale?: string | null }
): PublicKBSearchResult {
  const id = String(row.id);

  return {
    id,
    title: pickKBArticleTitle(row.title, "Untitled"),
    excerpt: normalizeExcerpt(row.excerpt),
    href: buildResultHref({
      companySlug: params.companySlug,
      articleId: id,
      articleUrl: row.article_url,
      locale: row.locale ?? params.locale,
    }),
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    locale: row.locale,
  };
}

export async function searchPublicKBArticles(params: {
  companySlug: string;
  query: string | null | undefined;
  locale?: string | null;
  limit?: number | string | null;
}): Promise<PublicKBSearchResult[]> {
  const companySlug = params.companySlug.trim();
  const query = normalizePublicKBSearchQuery(params.query);
  const limit = normalizePublicKBSearchLimit(params.limit ?? null);
  const locale = params.locale?.trim() || null;

  if (!companySlug || query.length < PUBLIC_KB_SEARCH_MIN_QUERY_LENGTH) {
    return [];
  }

  const cacheKey = buildCacheKey("kb:public-search", [
    companySlug,
    locale ?? "default",
    limit,
    query.toLowerCase(),
  ]);
  const cached = await cache.get<PublicKBSearchResult[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const { data, error } = await supabaseAdmin.rpc("search_public_kb_articles", {
    p_company_slug: companySlug,
    p_query: query,
    p_locale: locale,
    p_limit: limit,
  });

  if (error) {
    throw error;
  }

  const items = ((data ?? []) as PublicKBSearchRow[]).map(row =>
    mapSearchRow(row, { companySlug, locale })
  );

  await cache.set(cacheKey, items, PUBLIC_KB_SEARCH_CACHE_TTL_SECONDS);
  return items;
}
