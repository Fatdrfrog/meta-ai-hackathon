import "server-only";

import { invalidateKbWorkspaceCaches } from "@/lib/airi/rag/cache-invalidation";
import { retireKbArticleCanonicalKnowledge } from "@/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-sync-runner";
import { getCompanySlugByWorkspaceId } from "@/lib/kb/get-company-slug";
import {
  getPublicKBArticleTag,
  getPublicKBNavigationTag,
} from "@/lib/kb/public-kb";
import { sanitizeBrokenImages } from "@/lib/kb/sanitize-content";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath, revalidateTag } from "next/cache";
import type { Locale } from "@/i18n/locales";

export type KBLocalizationActionArticle = {
  id: string;
  title: string;
  status: string | null;
  published_at: string | null;
  workspace_id: string;
  default_locale: string | null;
  draft_title: string | null;
  draft_content_mdx: string | null;
};

export type KBLocalizationActionRow = {
  locale: string;
  title: string;
  status: string | null;
  published_at: string | null;
  draft_title: string | null;
  draft_content_mdx: string | null;
  updated_at: string | null;
};

export type KBLocalizationSourceContent = {
  locale: Locale;
  title: string;
  contentMdx: string;
  status: string | null;
  publishedAt: string | null;
};

async function getLatestLocalizationContent(
  supabase: SupabaseClient,
  articleId: string,
  locale: Locale
): Promise<string> {
  const { data, error } = await supabase
    .from("kb_article_localization_versions")
    .select("content_mdx")
    .eq("article_id", articleId)
    .eq("locale", locale)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as { content_mdx?: string | null } | null)?.content_mdx ?? "";
}

async function getLatestLegacyContent(
  supabase: SupabaseClient,
  articleId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("kb_article_versions")
    .select("content_mdx")
    .eq("article_id", articleId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as { content_mdx?: string | null } | null)?.content_mdx ?? "";
}

export async function getKBLocalizationSourceContent({
  supabase,
  article,
  localizations,
  locale,
  defaultLocale,
}: {
  supabase: SupabaseClient;
  article: KBLocalizationActionArticle;
  localizations: readonly KBLocalizationActionRow[];
  locale: Locale;
  defaultLocale: Locale;
}): Promise<KBLocalizationSourceContent> {
  const localization = localizations.find(row => row.locale === locale);
  const isDefaultLocale = locale === defaultLocale;
  const title = isDefaultLocale
    ? (article.draft_title ?? article.title)
    : (localization?.draft_title ??
      localization?.title ??
      article.draft_title ??
      article.title);

  let contentMdx = isDefaultLocale
    ? article.draft_content_mdx
    : localization?.draft_content_mdx;

  if (contentMdx === null || contentMdx === undefined) {
    contentMdx =
      localization && !isDefaultLocale
        ? await getLatestLocalizationContent(supabase, article.id, locale)
        : "";
  }

  if (!contentMdx && isDefaultLocale) {
    contentMdx = await getLatestLegacyContent(supabase, article.id);
  }

  return {
    locale,
    title,
    contentMdx: sanitizeBrokenImages(contentMdx ?? ""),
    status: isDefaultLocale
      ? article.status
      : (localization?.status ?? "draft"),
    publishedAt: isDefaultLocale
      ? article.published_at
      : (localization?.published_at ?? null),
  };
}

/**
 * Takes content that just stopped being published out of AI search: the
 * embeddings of one language (or of every language when `locale` is null),
 * the article's full-text vector and, when the article's default-language
 * content went away, its canonical knowledge chunks. Cached retrieval results
 * and public pages are dropped last, after the search data is gone.
 */
export async function removeUnpublishedKBContentFromSearch({
  articleId,
  workspaceId,
  locale,
  retireCanonicalKnowledge,
}: {
  articleId: string;
  workspaceId: string;
  locale: Locale | null;
  retireCanonicalKnowledge: boolean;
}) {
  let embeddingDelete = supabaseAdmin
    .from("kb_article_embeddings")
    .delete()
    .eq("article_id", articleId);
  if (locale) embeddingDelete = embeddingDelete.eq("locale", locale);
  const { error: embeddingDeleteError } = await embeddingDelete;
  if (embeddingDeleteError) throw embeddingDeleteError;

  const { error: refreshError } = await supabaseAdmin.rpc(
    "kb_refresh_article_search_vector",
    {
      p_article_id: articleId,
    }
  );
  if (refreshError) throw refreshError;

  if (retireCanonicalKnowledge) {
    await retireKbArticleCanonicalKnowledge({ workspaceId, articleId });
  }

  await revalidateKBLocalizationCaches({ articleId, workspaceId });
}

export async function revalidateKBLocalizationCaches({
  articleId,
  workspaceId,
}: {
  articleId: string;
  workspaceId: string;
}) {
  try {
    await invalidateKbWorkspaceCaches(workspaceId);
  } catch (error) {
    console.error("[KB Localization] Cache invalidation failed:", error);
  }

  const companySlug = await getCompanySlugByWorkspaceId(
    supabaseAdmin,
    workspaceId
  );

  if (!companySlug) return;

  revalidatePath(`/${companySlug}/kb/${articleId}`);
  revalidatePath(`/${companySlug}/kb`);
  revalidateTag(getPublicKBArticleTag(articleId), "max");
  revalidateTag(getPublicKBNavigationTag(workspaceId), "max");
}
