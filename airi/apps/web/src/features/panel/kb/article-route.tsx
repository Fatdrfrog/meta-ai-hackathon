import { ArticleEditor } from "@/components/kb/article-editor";
import { KBBreadcrumbs } from "@/components/kb/kb-breadcrumbs";
import { Card, CardContent } from "@/components/ui/card";
import { getLocaleFromCookie } from "@/i18n/message-loader";
import { isLocale, type Locale } from "@/i18n/locales";
import {
  resolveActiveKBArticleContent,
  type KBArticleVersionRelation,
} from "@/lib/kb/article-content";
import { fetchKBAncestors } from "@/lib/kb/fetch-ancestors";
import { resolveKBArticleReadLocale } from "@/lib/kb/kb-locales";
import {
  buildKBLocalizationMetadata,
  resolveKBDefaultLocale,
} from "@/lib/kb/kb-localization-actions";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { FileText } from "lucide-react";
import { getTranslations } from "next-intl/server";

type AdminArticlePageRow = {
  id: string;
  title: string;
  draft_title: string | null;
  draft_content_mdx: string | null;
  status: string;
  published_at: string | null;
  is_featured: boolean | null;
  parent_id: string | null;
  default_locale: string | null;
  workspaces:
    | {
        id: string;
        name: string | null;
      }
    | Array<{
        id: string;
        name: string | null;
      }>
    | null;
  kb_article_versions?: KBArticleVersionRelation;
};

type AdminArticleLocalizationRow = {
  locale: string;
  title: string;
  draft_title: string | null;
  draft_content_mdx: string | null;
  status: string;
  published_at: string | null;
  updated_at: string | null;
};

export default async function EditArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; articleId: string }>;
  searchParams?: Promise<{ locale?: string }>;
}) {
  const [
    { supabase },
    { workspaceId, articleId },
    resolvedSearchParams,
    t,
    cookieLocale,
  ] = await Promise.all([
    getReadOnlySupabaseContext(),
    params,
    searchParams,
    getTranslations("KnowledgeBase"),
    getLocaleFromCookie(),
  ]);
  const requestedLocale =
    resolvedSearchParams?.locale && isLocale(resolvedSearchParams.locale)
      ? resolvedSearchParams.locale
      : cookieLocale;
  const articleNotFoundLabel =
    typeof t.has === "function" && t.has("articleNotFound")
      ? t("articleNotFound")
      : "Article not found";

  const { data: article, error } = await supabase
    .from("kb_articles")
    .select(
      `
      id,
      title,
      draft_title,
      draft_content_mdx,
      status,
      published_at,
      is_featured,
      parent_id,
      default_locale,
      workspaces:workspaces!kb_articles_workspace_id_fkey(id, name),
      kb_article_versions(
        content_mdx,
        version,
        created_at
      )
    `
    )
    .eq("workspace_id", workspaceId)
    .eq("id", articleId)
    .order("version", {
      ascending: false,
      referencedTable: "kb_article_versions",
    })
    .limit(1, { referencedTable: "kb_article_versions" })
    .maybeSingle();

  const typedArticle = (article as AdminArticlePageRow | null) ?? null;

  if (error || !typedArticle) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <Card className="max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12 px-8">
            <div className="w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mx-auto mb-4">
              <FileText className="h-8 w-8 text-destructive" />
            </div>
            <h3 className="text-lg font-semibold">{articleNotFoundLabel}</h3>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { data: localizationRows } = await supabase
    .from("kb_article_localizations")
    .select(
      "locale, title, draft_title, draft_content_mdx, status, published_at, updated_at"
    )
    .eq("article_id", typedArticle.id);

  const localizations =
    (localizationRows as AdminArticleLocalizationRow[] | null) ?? [];
  const defaultLocale = resolveKBDefaultLocale(typedArticle.default_locale);
  const localizationMetadata = buildKBLocalizationMetadata({
    defaultLocale: typedArticle.default_locale,
    articleStatus: typedArticle.status,
    articlePublishedAt: typedArticle.published_at,
    articleDraftTitle: typedArticle.draft_title,
    articleDraftContentMdx: typedArticle.draft_content_mdx,
    rows: localizations,
  });
  const { locale, availableLocales } = resolveKBArticleReadLocale({
    requestedLocale,
    defaultLocale: typedArticle.default_locale,
    localizationLocales: localizations.map(row => row.locale),
  });
  const isDefaultLocale = locale === defaultLocale;
  const activeLocalization = isDefaultLocale
    ? null
    : localizations.find(row => row.locale === locale);
  const { data: localizationVersion } = activeLocalization
    ? await supabase
        .from("kb_article_localization_versions")
        .select("content_mdx, version, created_at")
        .eq("article_id", typedArticle.id)
        .eq("locale", locale)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  const activeArticleContent = resolveActiveKBArticleContent({
    article: typedArticle,
    activeLocalization,
    localizationVersion: localizationVersion as KBArticleVersionRelation,
    isDefaultLocale,
    fallback: "",
  });

  const ancestors = await fetchKBAncestors(
    supabase,
    typedArticle.parent_id,
    workspaceId,
    { useDraft: true, locale }
  );
  const workspace = Array.isArray(typedArticle.workspaces)
    ? typedArticle.workspaces[0]
    : typedArticle.workspaces;
  const workspaceName = workspace?.name;

  return (
    <ArticleEditor
      key={`${typedArticle.id}:${locale}`}
      parentArticleId={typedArticle.parent_id ?? undefined}
      breadcrumbSlot={
        <KBBreadcrumbs
          mode="admin"
          workspaceId={workspaceId}
          workspaceName={workspaceName ?? undefined}
          articleId={typedArticle.id}
          articleTitle={typedArticle.draft_title ?? typedArticle.title}
          ancestors={ancestors}
        />
      }
      initial={{
        id: typedArticle.id,
        title: activeArticleContent.title,
        content_mdx: activeArticleContent.content,
        status: activeArticleContent.status ?? "draft",
        published_at: activeArticleContent.published_at ?? null,
        is_featured: typedArticle.is_featured,
        locale: locale as Locale,
        defaultLocale,
        availableLocales,
        localizations: localizationMetadata,
        hasLocalization: isDefaultLocale || Boolean(activeLocalization),
      }}
    />
  );
}
