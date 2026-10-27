import { ArticleContent } from "@/components/kb/article-content";
import { ArticleInteractions } from "@/components/kb/article-interactions";
import { extractPlainText } from "@/lib/kb/content-utils";
import { KBBreadcrumbs } from "@/components/kb/kb-breadcrumbs";
import { KBNavigation } from "@/components/kb/kb-navigation";
import { PublicKBArticleActions } from "@/components/kb/public-kb-article-actions";
import { PublicKBCommandSearch } from "@/components/kb/public-kb-command-search";
import { LandingPageHeader } from "@/components/landing/page-header";
import { StructuredData } from "@/components/seo/structured-data";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { getLocaleFromCookie } from "@/i18n/message-loader";
import { formatDateSafe } from "@/lib/date-utils";
import { fetchKBAncestors } from "@/lib/kb/fetch-ancestors";
import { getPublicKBArticleData } from "@/lib/kb/public-kb";
import {
  getPublicKBArticleLocaleFallback,
  getPublicKBLanguageSwitcherLocale,
  resolvePublicKBRequestedLocale,
} from "@/lib/kb/public-kb-locale-fallback";
import { getKBLocaleLabel } from "@/lib/kb/kb-localization-actions";
import { getPublicKBHeaderViewer } from "@/lib/kb/public-kb-viewer";
import {
  createArticleSchema,
  createBreadcrumbSchema,
  createMetadata,
  generateMetaDescription,
  getCanonicalUrl,
} from "@/lib/seo";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { BookOpen, Calendar, Clock, Languages } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

export const revalidate = 300;

type CompanyArticlePageParams = {
  companySlug: string;
  article: string;
};

type CompanyArticleSearchParams = {
  locale?: string | string[];
};

async function getRequestedLocale(
  searchParams?: Promise<CompanyArticleSearchParams>
) {
  return resolvePublicKBRequestedLocale(
    await searchParams,
    await getLocaleFromCookie()
  );
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<CompanyArticlePageParams>;
  searchParams?: Promise<CompanyArticleSearchParams>;
}): Promise<Metadata> {
  const { companySlug, article: articleId } = await params;
  const requestedLocale = await getRequestedLocale(searchParams);
  const articleData = await getPublicKBArticleData(
    companySlug,
    articleId,
    requestedLocale
  );

  if (!articleData) {
    return createMetadata({
      title: "Knowledge Base Article",
      description:
        "Read customer support articles and guides on airi.chat knowledge bases.",
      path: `/${companySlug}/kb/${articleId}`,
    });
  }

  const { article, company, content } = articleData;
  const description =
    generateMetaDescription(extractPlainText(content), 160) ||
    `Read ${article.title} from the ${company.name} knowledge base.`;

  return createMetadata({
    title: `${article.title} | ${company.name} Knowledge Base`,
    description,
    path: `/${companySlug}/kb/${article.id}`,
    type: "article",
    publishedTime: article.published_at || undefined,
    modifiedTime: article.updated_at || article.published_at || undefined,
    authors: [company.name],
    keywords: [
      `${company.name} knowledge base`,
      "support article",
      "help center article",
      "customer support documentation",
    ],
  });
}

export default async function CompanyArticlePage({
  params,
  searchParams,
}: {
  params: Promise<CompanyArticlePageParams>;
  searchParams?: Promise<CompanyArticleSearchParams>;
}) {
  const { companySlug, article: articleId } = await params;
  const requestedLocale = await getRequestedLocale(searchParams);
  const articleData = await getPublicKBArticleData(
    companySlug,
    articleId,
    requestedLocale
  );

  if (!articleData) return notFound();

  const supabase = await createReadOnlyClient();
  const t = await getTranslations("KnowledgeBase");
  const { article, company, content, locale, availableLocales } = articleData;
  const languageSwitcherLocale = getPublicKBLanguageSwitcherLocale(
    requestedLocale,
    locale
  );
  const localeFallback = getPublicKBArticleLocaleFallback({
    requestedLocale,
    renderedLocale: locale,
    availableLocales,
  });

  const viewer = await getPublicKBHeaderViewer({
    currentWorkspaceId: article.workspace_id,
    getUser: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      return user ? { id: user.id } : null;
    },
    getMemberships: async userId => {
      const { data } = await supabase
        .from("company_users")
        .select("workspace_id")
        .eq("user_id", userId);

      return data;
    },
  });
  const ancestors = await fetchKBAncestors(
    supabase,
    article.parent_id,
    article.workspace_id,
    { locale }
  );

  const plainText = extractPlainText(content);
  const wordCount = plainText
    ? plainText.split(/\s+/).filter(Boolean).length
    : 0;
  const readingTime = Math.max(1, Math.ceil(wordCount / 200));

  const articleUrl = getCanonicalUrl(`/${companySlug}/kb/${article.id}`);
  const articleDescription = generateMetaDescription(plainText, 200);
  const articleSchema = createArticleSchema({
    title: article.title,
    description: articleDescription || article.title,
    publishedAt: article.published_at || new Date().toISOString(),
    modifiedAt: article.updated_at || article.published_at || undefined,
    url: articleUrl,
  });

  const breadcrumbItems = [
    { name: "Home", url: getCanonicalUrl("/") },
    { name: company.name, url: getCanonicalUrl(`/${companySlug}/kb`) },
    ...ancestors.map(a => ({
      name: a.title,
      url: getCanonicalUrl(`/${companySlug}/kb/${a.id}`),
    })),
    { name: article.title, url: articleUrl },
  ];
  const breadcrumbSchema = createBreadcrumbSchema(breadcrumbItems);

  return (
    <>
      <StructuredData data={[articleSchema, breadcrumbSchema]} />
      <div className="min-h-screen overflow-x-clip bg-background">
        <SidebarProvider className="min-h-screen min-w-0 flex-col overflow-x-clip">
          <LandingPageHeader
            variant="docs"
            sticky={false}
            languageSwitcherActiveLocale={languageSwitcherLocale}
            languageSwitcherAvailableLocales={availableLocales}
            languageSwitcherSyncSearchParam
            viewer={viewer}
            trailingSlot={
              <PublicKBCommandSearch
                companySlug={companySlug}
                locale={languageSwitcherLocale}
                labels={{
                  placeholder: t("search.placeholder"),
                  searching: t("search.searching"),
                  startTyping: t("search.startTyping"),
                  noResults: t("search.noResults"),
                  failed: t("search.failed"),
                  retry: t("search.retry"),
                }}
              />
            }
            leadingSlot={
              <SidebarTrigger
                className="md:hidden"
                aria-label={t("navigation.knowledgeBase")}
              />
            }
          />
          <div className="flex min-h-[calc(100svh-3.5rem)] w-full min-w-0 overflow-x-clip">
            <Sidebar desktopMode="sticky">
              <KBNavigation
                currentArticleId={article.id}
                mode="public"
                companySlug={companySlug}
                workspaceId={article.workspace_id}
                locale={languageSwitcherLocale}
              />
            </Sidebar>
            <SidebarInset className="min-h-[calc(100svh-3.5rem)] min-w-0 overflow-x-clip">
              <div className="min-h-[calc(100svh-3.5rem)] min-w-0 overflow-x-clip bg-background">
                <div className="mx-auto w-full max-w-4xl min-w-0 p-4 sm:p-6">
                  <KBBreadcrumbs
                    mode="public"
                    companySlug={companySlug}
                    articleId={article.id}
                    articleTitle={article.title}
                    ancestors={ancestors}
                  />

                  <article className="public-kb-article-body min-w-0">
                    {localeFallback ? (
                      <div
                        role="status"
                        className="mb-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground"
                      >
                        <Languages
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          {t("localeFallbackNotice", {
                            requestedLanguage: getKBLocaleLabel(
                              localeFallback.requestedLocale
                            ),
                            renderedLanguage: getKBLocaleLabel(
                              localeFallback.renderedLocale
                            ),
                          })}
                        </span>
                      </div>
                    ) : null}

                    <header className="mb-8 sm:mb-12">
                      <h1 className="text-3xl sm:text-4xl font-bold mb-4 sm:mb-6 leading-tight">
                        {article.title}
                      </h1>

                      <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-sm text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          <span className="hidden sm:inline">
                            {t("metadata.published")}{" "}
                            {formatDateSafe(article.published_at)}
                          </span>
                          <span className="sm:hidden">
                            {formatDateSafe(article.published_at, "Unknown")}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Clock className="h-4 w-4" />
                          <span>
                            {readingTime} {t("metadata.readingTime")}
                          </span>
                        </div>
                        <Badge
                          variant="outline"
                          className="flex items-center gap-1"
                        >
                          <BookOpen className="h-3 w-3" />
                          <span className="hidden sm:inline">
                            {t("navigation.knowledgeBase")}
                          </span>
                          <span className="sm:hidden">
                            {t("navigation.kb")}
                          </span>
                        </Badge>
                        <PublicKBArticleActions
                          title={article.title}
                          content={content}
                          articleUrl={articleUrl}
                          companyName={company.name}
                          locale={locale}
                          publishedAt={article.published_at}
                          updatedAt={article.updated_at}
                          labels={{
                            copyMarkdown: t("actions.copyMarkdown"),
                            copyForLLM: t("actions.copyForLLM"),
                            copiedMarkdown: t("actions.copiedMarkdown"),
                            copiedForLLM: t("actions.copiedForLLM"),
                            copyFailed: t("actions.copyFailed"),
                          }}
                        />
                      </div>
                    </header>

                    <div className="mb-8 sm:mb-12">
                      <ArticleContent
                        content={content}
                        className="public-kb-article-content"
                      />
                    </div>

                    <div className="border-t pt-6 sm:pt-8">
                      <ArticleInteractions
                        articleId={article.id}
                        companySlug={companySlug}
                      />
                    </div>
                  </article>
                </div>
              </div>
            </SidebarInset>
          </div>
        </SidebarProvider>
      </div>
    </>
  );
}
