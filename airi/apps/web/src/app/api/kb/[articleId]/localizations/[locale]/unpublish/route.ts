import { isLocale } from "@/i18n/locales";
import {
  getAccessibleKBArticle,
  requireKBRouteAccess,
} from "@/lib/kb/article-access";
import {
  getKBLocalizationUnpublishError,
  resolveKBDefaultLocale,
} from "@/lib/kb/kb-localization-actions";
import {
  getKBLocalizationSourceContent,
  removeUnpublishedKBContentFromSearch,
  type KBLocalizationActionArticle,
  type KBLocalizationActionRow,
} from "@/lib/kb/kb-localization-server";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ articleId: string; locale: string }> }
) {
  try {
    const { articleId, locale: localeParam } = await context.params;
    if (!isLocale(localeParam)) {
      return NextResponse.json({ error: "Invalid locale" }, { status: 400 });
    }

    const supabase = await createClient();
    const access = await requireKBRouteAccess(supabase);
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );
    }

    const article = await getAccessibleKBArticle<KBLocalizationActionArticle>(
      supabase,
      articleId,
      access.workspaceIds,
      "id, title, status, published_at, workspace_id, default_locale, draft_title, draft_content_mdx"
    );

    if (!article) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    const { data: localizationRows, error: localizationRowsError } =
      await supabase
        .from("kb_article_localizations")
        .select(
          "locale, title, status, published_at, draft_title, draft_content_mdx, updated_at"
        )
        .eq("article_id", article.id);

    if (localizationRowsError) throw localizationRowsError;

    const localizations =
      (localizationRows as KBLocalizationActionRow[] | null) ?? [];
    const defaultLocale = resolveKBDefaultLocale(article.default_locale);
    const targetLocalization = localizations.find(
      localization => localization.locale === localeParam
    );
    const targetStatus =
      targetLocalization?.status ??
      (localeParam === defaultLocale ? article.status : null);
    let publishedLocaleCount = localizations.filter(
      localization => localization.status === "published"
    ).length;
    const hasDefaultLocalization = localizations.some(
      localization => localization.locale === defaultLocale
    );
    if (!hasDefaultLocalization && article.status === "published") {
      publishedLocaleCount += 1;
    }
    const unpublishError = getKBLocalizationUnpublishError({
      publishedLocaleCount,
      targetStatus,
    });

    if (unpublishError) {
      return NextResponse.json({ error: unpublishError }, { status: 400 });
    }

    const source = await getKBLocalizationSourceContent({
      supabase,
      article,
      localizations,
      locale: localeParam,
      defaultLocale,
    });
    const now = new Date().toISOString();

    const { error: localizationUpdateError } = await supabase
      .from("kb_article_localizations")
      .upsert(
        {
          article_id: article.id,
          locale: localeParam,
          title: source.title,
          status: "draft",
          published_at: null,
          draft_title: source.title,
          draft_content_mdx: source.contentMdx,
          updated_by: access.user.id,
          updated_at: now,
        },
        { onConflict: "article_id,locale" }
      );

    if (localizationUpdateError) throw localizationUpdateError;

    if (localeParam === defaultLocale) {
      const { error: articleUpdateError } = await supabase
        .from("kb_articles")
        .update({
          draft_title: source.title,
          draft_content_mdx: source.contentMdx,
          updated_by: access.user.id,
          updated_at: now,
        })
        .eq("id", article.id)
        .in("workspace_id", access.workspaceIds);

      if (articleUpdateError) throw articleUpdateError;
    }

    await removeUnpublishedKBContentFromSearch({
      articleId: article.id,
      workspaceId: article.workspace_id,
      locale: localeParam,
      retireCanonicalKnowledge: localeParam === defaultLocale,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
