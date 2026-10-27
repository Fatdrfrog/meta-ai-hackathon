import {
  getEffectiveKBArticleContent,
  getLatestKBArticleVersion,
  type KBArticleVersionRelation,
} from "@/lib/kb/article-content";
import {
  resolveKBPublicArticleReadLocale,
  toKBLocaleList,
  type KBLocale,
} from "@/lib/kb/kb-locales";
import { resolveKBDefaultLocale } from "@/lib/kb/kb-localization-actions";
import { pickKBArticleTitle } from "@/lib/kb/kb-title-overrides";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { unstable_cache } from "next/cache";

export const PUBLIC_KB_ARTICLE_TAG = "public-kb-article";
export const PUBLIC_KB_NAV_TAG = "public-kb-nav";
export const PUBLIC_KB_WORKSPACE_TAG = "public-kb-workspaces";

export interface PublicKBArticleData {
  article: {
    id: string;
    title: string;
    parent_id: string | null;
    published_at: string | null;
    updated_at: string | null;
    workspace_id: string;
  };
  company: {
    name: string;
    slug: string;
  };
  content: string;
  locale: KBLocale;
  availableLocales: KBLocale[];
}

export interface PublicKBNavArticle {
  id: string;
  title: string;
  parent_id: string | null;
  sort_order: number;
  workspace_id: string;
  default_locale?: string | null;
}

type PublicKBArticleRow = {
  id: string;
  title: string;
  parent_id: string | null;
  published_at: string | null;
  updated_at: string | null;
  workspace_id: string;
  default_locale: string | null;
  workspaces:
    | {
        id: string;
        companies:
          | {
              id: string;
              name: string | null;
              slug: string | null;
            }
          | Array<{
              id: string;
              name: string | null;
              slug: string | null;
            }>
          | null;
      }
    | Array<{
        id: string;
        companies:
          | {
              id: string;
              name: string | null;
              slug: string | null;
            }
          | Array<{
              id: string;
              name: string | null;
              slug: string | null;
            }>
          | null;
      }>
    | null;
  kb_article_versions?: KBArticleVersionRelation;
};

type PublicKBLocalizationRow = {
  locale: string;
  title: string;
  status: string | null;
  published_at: string | null;
  updated_at: string | null;
};

type PublicKBLocalizationVersionRow = {
  content_mdx: string | null;
  version?: number | null;
  created_at?: string | null;
};

export function getPublicKBArticleTag(articleId: string): string {
  return `${PUBLIC_KB_ARTICLE_TAG}:${articleId}`;
}

export function getPublicKBNavigationTag(workspaceId: string): string {
  return `${PUBLIC_KB_NAV_TAG}:${workspaceId}`;
}

export function getPublicKBWorkspaceTag(companySlug: string): string {
  return `${PUBLIC_KB_WORKSPACE_TAG}:${companySlug}`;
}

export async function getPublicKBWorkspaceIds(
  companySlug: string
): Promise<string[]> {
  const loadWorkspaceIds = unstable_cache(
    async (slug: string) => {
      const { data: company } = await supabaseAdmin
        .from("companies")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();

      if (!company) {
        return [];
      }

      const { data: workspaces } = await supabaseAdmin
        .from("workspaces")
        .select("id")
        .eq("company_id", company.id);

      return (workspaces ?? []).map(workspace => workspace.id);
    },
    ["public-kb-workspace-ids", companySlug],
    {
      revalidate: 300,
      tags: [getPublicKBWorkspaceTag(companySlug)],
    }
  );

  return loadWorkspaceIds(companySlug);
}

export async function getPublicKBNavigationArticles(
  workspaceId: string,
  requestedLocale?: string | null
): Promise<PublicKBNavArticle[]> {
  const loadNavigationArticles = unstable_cache(
    async (targetWorkspaceId: string, targetLocale?: string | null) => {
      const { data } = await supabaseAdmin
        .from("kb_articles")
        .select(
          "id, title, parent_id, sort_order, workspace_id, default_locale"
        )
        .eq("workspace_id", targetWorkspaceId)
        .eq("status", "published")
        .not("published_at", "is", null)
        .order("sort_order", { ascending: true });

      const articles = ((data ?? []) as PublicKBNavArticle[]).filter(Boolean);

      if (articles.length === 0) {
        return [];
      }

      const { data: defaultLocaleVersionRows } = await supabaseAdmin
        .from("kb_article_versions")
        .select("article_id")
        .in(
          "article_id",
          articles.map(article => article.id)
        );
      const articleIdsWithDefaultLocaleVersion = new Set(
        ((defaultLocaleVersionRows ?? []) as Array<{ article_id: string }>).map(
          row => row.article_id
        )
      );

      const { data: localizations } = await supabaseAdmin
        .from("kb_article_localizations")
        .select("article_id, locale, title, status, published_at")
        .in(
          "article_id",
          articles.map(article => article.id)
        )
        .eq("status", "published")
        .not("published_at", "is", null)
        .lte("published_at", new Date().toISOString());

      const localizationsByArticle = new Map<
        string,
        Array<{ locale: string; title: string }>
      >();

      for (const localization of (localizations ?? []) as Array<{
        article_id: string;
        locale: string;
        title: string;
      }>) {
        const existing = localizationsByArticle.get(localization.article_id);
        if (existing) {
          existing.push(localization);
        } else {
          localizationsByArticle.set(localization.article_id, [localization]);
        }
      }

      return articles.flatMap(article => {
        const articleLocalizations =
          localizationsByArticle.get(article.id) ?? [];
        const defaultLocale = resolveKBDefaultLocale(article.default_locale);
        const { locale: resolvedLocale } = resolveKBPublicArticleReadLocale({
          requestedLocale: targetLocale,
          defaultLocale: article.default_locale,
          localizationLocales: articleLocalizations.map(
            localization => localization.locale
          ),
          hasDefaultLocaleVariant: articleIdsWithDefaultLocaleVersion.has(
            article.id
          ),
        });
        const hasPublishedResolvedLocale = articleLocalizations.some(
          localization => localization.locale === resolvedLocale
        );
        if (
          articleLocalizations.length > 0 &&
          resolvedLocale === defaultLocale &&
          !hasPublishedResolvedLocale
        ) {
          return [];
        }
        const localizedTitle = articleLocalizations.find(
          localization => localization.locale === resolvedLocale
        )?.title;

        return [
          {
            ...article,
            title: pickKBArticleTitle(localizedTitle, article.title),
          },
        ];
      });
    },
    ["public-kb-navigation-articles", workspaceId, requestedLocale ?? ""],
    {
      revalidate: 300,
      tags: [getPublicKBNavigationTag(workspaceId)],
    }
  );

  return loadNavigationArticles(workspaceId, requestedLocale);
}

export async function getPublicKBArticleData(
  companySlug: string,
  articleId: string,
  requestedLocale?: string | null
): Promise<PublicKBArticleData | null> {
  const loadArticleData = unstable_cache(
    async (
      slug: string,
      targetArticleId: string,
      targetLocale?: string | null
    ) => {
      const workspaceIds = await getPublicKBWorkspaceIds(slug);

      if (workspaceIds.length === 0) {
        return null;
      }

      const { data: article, error } = await supabaseAdmin
        .from("kb_articles")
        .select(
          `
            id,
            title,
            parent_id,
            published_at,
            updated_at,
            workspace_id,
            default_locale,
            workspaces:workspaces!kb_articles_workspace_id_fkey(
              id,
              companies:companies!workspaces_company_id_fkey(
                id,
                name,
                slug
              )
            ),
            kb_article_versions(
              content_mdx,
              version,
              created_at
            )
          `
        )
        .in("workspace_id", workspaceIds)
        .eq("id", targetArticleId)
        .eq("status", "published")
        .not("published_at", "is", null)
        .order("version", {
          ascending: false,
          referencedTable: "kb_article_versions",
        })
        .limit(1, { referencedTable: "kb_article_versions" })
        .maybeSingle();

      const typedArticle = (article as PublicKBArticleRow | null) ?? null;

      if (error || !typedArticle) {
        return null;
      }

      const workspace = Array.isArray(typedArticle.workspaces)
        ? typedArticle.workspaces[0]
        : typedArticle.workspaces;
      const company = Array.isArray(workspace?.companies)
        ? workspace.companies[0]
        : workspace?.companies;

      if (!company || company.slug !== slug) {
        return null;
      }

      const { data: localizationRows } = await supabaseAdmin
        .from("kb_article_localizations")
        .select("locale, title, status, published_at, updated_at")
        .eq("article_id", typedArticle.id)
        .eq("status", "published")
        .not("published_at", "is", null)
        .lte("published_at", new Date().toISOString());

      const localizations =
        (localizationRows as PublicKBLocalizationRow[] | null) ?? [];
      const availableLocales = toKBLocaleList(
        localizations.map(localization => localization.locale)
      );
      const defaultLocale = resolveKBDefaultLocale(typedArticle.default_locale);
      const hasDefaultLocaleVariant = Boolean(
        getLatestKBArticleVersion(typedArticle.kb_article_versions)
      );
      const { locale: resolvedLocale, availableLocales: readAvailableLocales } =
        resolveKBPublicArticleReadLocale({
          requestedLocale: targetLocale,
          defaultLocale,
          localizationLocales: availableLocales,
          hasDefaultLocaleVariant,
        });
      const localization =
        localizations.find(candidate => candidate.locale === resolvedLocale) ??
        null;

      if (
        localizations.length > 0 &&
        resolvedLocale === defaultLocale &&
        !localization
      ) {
        return null;
      }

      let title = typedArticle.title;
      let content = getEffectiveKBArticleContent({
        versions: typedArticle.kb_article_versions,
      });
      let publishedAt = typedArticle.published_at;
      let updatedAt = typedArticle.updated_at;

      if (localization) {
        const { data: version } = await supabaseAdmin
          .from("kb_article_localization_versions")
          .select("content_mdx, version, created_at")
          .eq("article_id", typedArticle.id)
          .eq("locale", resolvedLocale)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();

        title = pickKBArticleTitle(localization.title, typedArticle.title);
        content =
          (version as PublicKBLocalizationVersionRow | null)?.content_mdx ?? "";
        publishedAt = localization.published_at;
        updatedAt =
          (version as PublicKBLocalizationVersionRow | null)?.created_at ??
          localization.updated_at ??
          typedArticle.updated_at;
      }

      return {
        article: {
          id: typedArticle.id,
          title,
          parent_id: typedArticle.parent_id,
          published_at: publishedAt,
          updated_at: updatedAt,
          workspace_id: typedArticle.workspace_id,
        },
        company: {
          name: company.name || "Company",
          slug: company.slug,
        },
        content,
        locale: resolvedLocale,
        availableLocales: readAvailableLocales,
      } satisfies PublicKBArticleData;
    },
    ["public-kb-article-data", companySlug, articleId, requestedLocale ?? ""],
    {
      revalidate: 300,
      tags: [getPublicKBArticleTag(articleId)],
    }
  );

  return loadArticleData(companySlug, articleId, requestedLocale);
}
