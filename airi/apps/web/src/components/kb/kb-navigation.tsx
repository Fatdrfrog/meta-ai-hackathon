import { KBNavTree } from "@/components/kb/kb-nav-tree";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { getLocaleFromCookie } from "@/i18n/message-loader";
import {
  getPublicKBNavigationArticles,
  getPublicKBWorkspaceIds,
} from "@/lib/kb/public-kb";
import { resolveKBPublicArticleReadLocale } from "@/lib/kb/kb-locales";
import { pickKBArticleTitle } from "@/lib/kb/kb-title-overrides";
import { resolveKBNavigationWorkspaceIds } from "@/lib/kb/navigation-workspace";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";

interface KBNavigationProps {
  currentArticleId?: string;
  mode?: "public" | "internal";
  companySlug?: string; // For public multi-tenant URLs
  workspaceId?: string; // For internal admin URLs
  locale?: string;
}

import type { KBArticleBase as KBArticlePublic } from "./kb-types";

type KBNavigationArticle = KBArticlePublic & {
  default_locale?: string | null;
};

type KBNavigationLocalization = {
  article_id: string;
  locale: string;
  title: string;
  draft_title: string | null;
};

export async function KBNavigation({
  currentArticleId,
  mode = "public",
  companySlug,
  workspaceId,
  locale,
}: KBNavigationProps) {
  const supabase = await createReadOnlyClient();
  const t = await getTranslations("KnowledgeBase");
  const requestedLocale = locale ?? (await getLocaleFromCookie());

  const targetWorkspaceIds = await resolveKBNavigationWorkspaceIds({
    mode,
    companySlug,
    workspaceId,
    fetchWorkspaceIdsByCompanySlug: getPublicKBWorkspaceIds,
  });

  if (targetWorkspaceIds.length === 0) {
    return null;
  }

  const allArticles =
    mode === "public" && targetWorkspaceIds.length === 1
      ? await getPublicKBNavigationArticles(
          targetWorkspaceIds[0]!,
          requestedLocale
        )
      : await (async () => {
          let articlesQuery = supabase
            .from("kb_articles")
            .select(
              "id, title, parent_id, sort_order, workspace_id, default_locale"
            )
            .in("workspace_id", targetWorkspaceIds)
            .eq("status", "published")
            .order("sort_order", { ascending: true });

          if (mode === "public") {
            articlesQuery = articlesQuery.not("published_at", "is", null);
          }

          const { data } = await articlesQuery;
          const articles = ((data ?? []) as KBNavigationArticle[]).filter(
            Boolean
          );

          if (articles.length === 0) {
            return [];
          }

          const defaultLocaleArticleIds = new Set<string>();
          if (mode === "public") {
            const { data: defaultLocaleVersionRows } = await supabase
              .from("kb_article_versions")
              .select("article_id")
              .in(
                "article_id",
                articles.map(article => article.id)
              );

            for (const row of (defaultLocaleVersionRows ?? []) as Array<{
              article_id: string;
            }>) {
              defaultLocaleArticleIds.add(row.article_id);
            }
          }

          let localizationsQuery = supabase
            .from("kb_article_localizations")
            .select(
              "article_id, locale, title, draft_title, status, published_at"
            )
            .in(
              "article_id",
              articles.map(article => article.id)
            );

          if (mode === "public") {
            localizationsQuery = localizationsQuery
              .eq("status", "published")
              .not("published_at", "is", null)
              .lte("published_at", new Date().toISOString());
          } else {
            localizationsQuery = localizationsQuery.eq(
              "locale",
              requestedLocale
            );
          }

          const { data: localizations } = await localizationsQuery;

          const localizationRows = (localizations ??
            []) as KBNavigationLocalization[];
          const localizationsByArticleId = new Map<
            string,
            KBNavigationLocalization[]
          >();

          for (const localization of localizationRows) {
            const articleLocalizations =
              localizationsByArticleId.get(localization.article_id) ?? [];
            articleLocalizations.push(localization);
            localizationsByArticleId.set(
              localization.article_id,
              articleLocalizations
            );
          }

          return articles.map(article => ({
            ...article,
            title:
              mode === "public"
                ? (() => {
                    const articleLocalizations =
                      localizationsByArticleId.get(article.id) ?? [];
                    const { locale: resolvedLocale } =
                      resolveKBPublicArticleReadLocale({
                        requestedLocale,
                        defaultLocale: article.default_locale,
                        localizationLocales: articleLocalizations.map(
                          localization => localization.locale
                        ),
                        hasDefaultLocaleVariant: defaultLocaleArticleIds.has(
                          article.id
                        ),
                      });
                    const localizationTitle = articleLocalizations.find(
                      localization => localization.locale === resolvedLocale
                    )?.title;

                    return pickKBArticleTitle(localizationTitle, article.title);
                  })()
                : pickKBArticleTitle(
                    localizationsByArticleId.get(article.id)?.[0]?.draft_title,
                    localizationsByArticleId.get(article.id)?.[0]?.title,
                    article.title
                  ),
          }));
        })();

  if (!allArticles || allArticles.length === 0) {
    return null;
  }

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>{t("navigation.knowledgeBase")}</SidebarGroupLabel>
        <SidebarMenu>
          <KBNavTree
            articles={(allArticles || []) as KBArticlePublic[]}
            currentArticleId={currentArticleId}
            mode={mode}
            companySlug={companySlug}
            workspaceId={workspaceId || targetWorkspaceIds[0]}
            locale={requestedLocale}
          />
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  );
}
