import { LandingPageHeader } from "@/components/landing/page-header";
import { getPublicKBWorkspaceIds } from "@/lib/kb/public-kb";
import { getPublicKBHeaderViewer } from "@/lib/kb/public-kb-viewer";
import { appendKBLocaleQuery } from "@/lib/kb/kb-route-prefetch";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { BookOpen } from "lucide-react";
import { getLocaleFromCookie } from "@/i18n/message-loader";
import { resolvePublicKBRequestedLocale } from "@/lib/kb/public-kb-locale-fallback";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

type PublicKBLandingSearchParams = {
  locale?: string | string[];
};

async function getRequestedLocale(
  searchParams?: Promise<PublicKBLandingSearchParams>
) {
  const [resolvedSearchParams, cookieLocale] = await Promise.all([
    searchParams,
    getLocaleFromCookie(),
  ]);
  return resolvePublicKBRequestedLocale(resolvedSearchParams, cookieLocale);
}

export default async function PublicKBLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams?: Promise<PublicKBLandingSearchParams>;
}) {
  const [{ companySlug }, requestedLocale, supabase, workspaceIds] =
    await Promise.all([
      params,
      getRequestedLocale(searchParams),
      createReadOnlyClient(),
      params.then(({ companySlug }) => getPublicKBWorkspaceIds(companySlug)),
    ]);
  if (workspaceIds.length === 0) {
    return notFound();
  }

  const [{ data: firstArticles }, { data: company }, t] = await Promise.all([
    supabase
      .from("kb_articles")
      .select("id")
      .in("workspace_id", workspaceIds)
      .eq("status", "published")
      .not("published_at", "is", null)
      .order("parent_id", { ascending: true, nullsFirst: true })
      .order("sort_order", { ascending: true })
      .limit(1)
      .returns<Array<{ id: string }>>(),
    // Visitors are usually anonymous and anon cannot read companies; the KB
    // title only needs the public name of the company behind this slug.
    supabaseAdmin
      .from("companies")
      .select("name, slug")
      .eq("slug", companySlug)
      .maybeSingle(),
    getTranslations({
      locale: requestedLocale,
      namespace: "KnowledgeBase",
    }),
  ]);

  const firstArticle = firstArticles?.[0] ?? null;
  if (firstArticle) {
    redirect(
      appendKBLocaleQuery(
        `/${companySlug}/kb/${firstArticle.id}`,
        requestedLocale
      )
    );
  }

  const workspaceId = workspaceIds[0];
  const viewer = workspaceId
    ? await getPublicKBHeaderViewer({
        currentWorkspaceId: workspaceId,
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
      })
    : undefined;

  const companyName = company?.name || companySlug;

  return (
    <div className="min-h-screen bg-background">
      <LandingPageHeader
        variant="docs"
        sticky={false}
        languageSwitcherActiveLocale={requestedLocale}
        languageSwitcherSyncSearchParam
        viewer={viewer}
      />
      <main className="mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-3xl flex-col items-center justify-center px-6 py-16 text-center">
        <BookOpen className="mb-4 h-10 w-10 text-muted-foreground" />
        <h1 className="text-2xl font-semibold tracking-tight">
          {companyName} {t("navigation.knowledgeBase")}
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          {t("emptyPublicKb") || "No published articles yet. Check back soon."}
        </p>
      </main>
    </div>
  );
}
