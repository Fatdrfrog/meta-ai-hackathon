import { isLocale } from "@/i18n/locales";
import {
  getAccessibleKBArticle,
  requireKBRouteAccess,
} from "@/lib/kb/article-access";
import {
  buildKBLocalizationMetadata,
  getKBLocalizationDeleteError,
  resolveKBDefaultLocale,
  type KBArticleLocalizationMetadataRow,
} from "@/lib/kb/kb-localization-actions";
import { revalidateKBLocalizationCaches } from "@/lib/kb/kb-localization-server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function DELETE(
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

    const article = await getAccessibleKBArticle<{
      id: string;
      workspace_id: string;
      default_locale: string | null;
      status: string | null;
      published_at: string | null;
      draft_title: string | null;
      draft_content_mdx: string | null;
      updated_at: string | null;
    }>(
      supabase,
      articleId,
      access.workspaceIds,
      "id, workspace_id, default_locale, status, published_at, draft_title, draft_content_mdx, updated_at"
    );

    if (!article) {
      return NextResponse.json({ error: "Article not found" }, { status: 404 });
    }

    const { data: localizationRows, error: localizationRowsError } =
      await supabase
        .from("kb_article_localizations")
        .select(
          "locale, status, published_at, updated_at, draft_title, draft_content_mdx"
        )
        .eq("article_id", article.id);

    if (localizationRowsError) throw localizationRowsError;

    const metadata = buildKBLocalizationMetadata({
      defaultLocale: article.default_locale,
      articleStatus: article.status,
      articlePublishedAt: article.published_at,
      articleUpdatedAt: article.updated_at,
      articleDraftTitle: article.draft_title,
      articleDraftContentMdx: article.draft_content_mdx,
      rows:
        (localizationRows as KBArticleLocalizationMetadataRow[] | null) ?? [],
    });
    const defaultLocale = resolveKBDefaultLocale(article.default_locale);
    const deleteError = getKBLocalizationDeleteError({
      targetLocale: localeParam,
      defaultLocale,
      availableLocaleCount: metadata.length,
    });

    if (deleteError) {
      return NextResponse.json({ error: deleteError }, { status: 400 });
    }

    const [versionDelete, embeddingDelete, localizationDelete] =
      await Promise.all([
        supabaseAdmin
          .from("kb_article_localization_versions")
          .delete()
          .eq("article_id", article.id)
          .eq("locale", localeParam),
        supabaseAdmin
          .from("kb_article_embeddings")
          .delete()
          .eq("article_id", article.id)
          .eq("locale", localeParam),
        supabase
          .from("kb_article_localizations")
          .delete()
          .eq("article_id", article.id)
          .eq("locale", localeParam),
      ]);

    if (versionDelete.error) throw versionDelete.error;
    if (embeddingDelete.error) throw embeddingDelete.error;
    if (localizationDelete.error) throw localizationDelete.error;

    const { error: refreshError } = await supabaseAdmin.rpc(
      "kb_refresh_article_search_vector",
      {
        p_article_id: article.id,
      }
    );
    if (refreshError) throw refreshError;

    await revalidateKBLocalizationCaches({
      articleId: article.id,
      workspaceId: article.workspace_id,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
