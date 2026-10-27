interface KBRoutePrefetchRouter {
  prefetch?: (href: string) => void;
}

interface KBArticleRouteRecord {
  id: string;
}

export function appendKBLocaleQuery(
  href: string,
  locale?: string | null
): string {
  const normalizedLocale = locale?.trim();
  if (!normalizedLocale) {
    return href;
  }

  const [path, existingQuery = ""] = href.split("?");
  const params = new URLSearchParams(existingQuery);
  params.set("locale", normalizedLocale);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function buildPublicKBLandingHref(
  companySlug: string,
  locale?: string | null
): string {
  return appendKBLocaleQuery(`/${companySlug}/kb`, locale);
}

export function buildPublicKBArticleHref(
  companySlug: string | undefined,
  articleId: string,
  locale?: string | null
): string {
  const href = companySlug
    ? `/${companySlug}/kb/${articleId}`
    : `/kb/${articleId}`;
  return appendKBLocaleQuery(href, locale);
}

export function buildAdminKBArticleHref(
  workspaceId: string,
  articleId: string,
  locale?: string | null
): string {
  return appendKBLocaleQuery(
    `/panel/w/${workspaceId}/kb/${articleId}`,
    locale
  );
}

export function buildKBArticleHrefs<TArticle extends KBArticleRouteRecord>(
  articles: TArticle[],
  buildHref: (articleId: string) => string
): string[] {
  return articles.map(article => buildHref(article.id));
}

export function prefetchKBArticleRoutes(
  router: KBRoutePrefetchRouter,
  hrefs: Iterable<string>,
  limit = 60
): void {
  if (!router.prefetch || limit <= 0) return;

  const seen = new Set<string>();
  let prefetchedCount = 0;

  for (const href of hrefs) {
    if (!href || seen.has(href)) continue;

    seen.add(href);
    router.prefetch(href);
    prefetchedCount += 1;

    if (prefetchedCount >= limit) return;
  }
}
