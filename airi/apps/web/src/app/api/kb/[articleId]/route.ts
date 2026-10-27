import { invalidateKbWorkspaceCaches } from "@/lib/airi/rag/cache-invalidation";
import { retireKbArticleCanonicalKnowledge } from "@/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-sync-runner";
import { getLocaleFromCookie } from "@/i18n/message-loader";
import { isLocale, type Locale } from "@/i18n/locales";
import {
  resolveActiveKBArticleContent,
  type KBArticleVersionRelation,
} from "@/lib/kb/article-content";
import { getCompanySlugByWorkspaceId } from "@/lib/kb/get-company-slug";
import {
  getAccessibleKBArticle,
  requireKBRouteAccess,
} from "@/lib/kb/article-access";
import {
  getPublicKBArticleTag,
  getPublicKBNavigationTag,
} from "@/lib/kb/public-kb";
import { resolveKBArticleReadLocale } from "@/lib/kb/kb-locales";
import {
  buildKBLocalizationMetadata,
  resolveKBDefaultLocale,
} from "@/lib/kb/kb-localization-actions";
import { removeUnpublishedKBContentFromSearch } from "@/lib/kb/kb-localization-server";
import { isKBDefaultArticleLocale } from "@/lib/kb/kb-title-overrides";
import { sanitizeBrokenImages } from "@/lib/kb/sanitize-content";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const supabase = await createClient();
    const { articleId } = await context.params;
    const requestedLocale = new URL(request.url).searchParams.get("locale");
    const cookieLocale = await getLocaleFromCookie();
    const preferredLocale: Locale =
      requestedLocale && isLocale(requestedLocale)
        ? requestedLocale
        : cookieLocale;
    const access = await requireKBRouteAccess(supabase);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );
    }

    const { data: article, error: articleError } = await supabase
      .from("kb_articles")
      .select(
        `
          id,
          title,
          status,
          published_at,
          is_featured,
          updated_at,
          parent_id,
          workspace_id,
          default_locale,
          draft_title,
          draft_content_mdx,
          kb_article_versions(
            content_mdx,
            version,
            created_at
          )
        `
      )
      .eq("id", articleId)
      .in("workspace_id", access.workspaceIds)
      .order("version", {
        ascending: false,
        referencedTable: "kb_article_versions",
      })
      .limit(1, { referencedTable: "kb_article_versions" })
      .maybeSingle();

    if (articleError) {
      throw articleError;
    }

    const typedArticle = article as {
      id: string;
      title: string;
      status: string | null;
      published_at: string | null;
      is_featured: boolean | null;
      updated_at: string | null;
      parent_id: string | null;
      workspace_id: string;
      default_locale: string | null;
      draft_title: string | null;
      draft_content_mdx: string | null;
      kb_article_versions?: KBArticleVersionRelation;
    } | null;

    if (!typedArticle)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { data: localizationRows, error: localizationError } = await supabase
      .from("kb_article_localizations")
      .select(
        "locale, title, draft_title, draft_content_mdx, status, published_at, updated_at"
      )
      .eq("article_id", articleId);

    if (localizationError) {
      throw localizationError;
    }

    const localizations =
      (localizationRows as Array<{
        locale: string;
        title: string;
        draft_title: string | null;
        draft_content_mdx: string | null;
        status: string | null;
        published_at: string | null;
        updated_at: string | null;
      }> | null) ?? [];
    const { locale, availableLocales } = resolveKBArticleReadLocale({
      requestedLocale: preferredLocale,
      defaultLocale: typedArticle.default_locale,
      localizationLocales: localizations.map(
        localization => localization.locale
      ),
    });
    const activeLocalization = localizations.find(
      localization => localization.locale === locale
    );
    const localizationMetadata = buildKBLocalizationMetadata({
      defaultLocale: typedArticle.default_locale,
      articleStatus: typedArticle.status,
      articlePublishedAt: typedArticle.published_at,
      articleUpdatedAt: typedArticle.updated_at,
      articleDraftTitle: typedArticle.draft_title,
      articleDraftContentMdx: typedArticle.draft_content_mdx,
      rows: localizations,
    });
    const { data: activeLocalizationVersion } = activeLocalization
      ? await supabase
          .from("kb_article_localization_versions")
          .select("content_mdx, version, created_at")
          .eq("article_id", articleId)
          .eq("locale", locale)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };

    const defaultLocale = resolveKBDefaultLocale(typedArticle.default_locale);
    const isDefaultLocale = locale === defaultLocale;
    const activeArticleContent = resolveActiveKBArticleContent({
      article: typedArticle,
      activeLocalization,
      localizationVersion:
        activeLocalizationVersion as KBArticleVersionRelation,
      isDefaultLocale,
      fallback: "",
    });

    return NextResponse.json(
      {
        article: {
          ...typedArticle,
          title: activeArticleContent.title,
          status: activeArticleContent.status,
          published_at: activeArticleContent.published_at,
        },
        content: activeArticleContent.content,
        locale,
        availableLocales,
        defaultLocale,
        localizations: localizationMetadata,
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const supabase = await createClient();
    const { articleId } = await context.params;
    const access = await requireKBRouteAccess(supabase);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );
    }

    const body = await request.json();
    const { title, status, content_mdx, parent_id } = body;
    const cookieLocale = await getLocaleFromCookie();
    const locale: Locale =
      typeof body?.locale === "string" && isLocale(body.locale)
        ? body.locale
        : cookieLocale;

    if (status && status === "published") {
      return NextResponse.json(
        {
          error:
            "Cannot publish via PUT. Use the /publish endpoint to publish articles.",
        },
        { status: 400 }
      );
    }

    const article = await getAccessibleKBArticle<{
      id: string;
      title: string;
      workspace_id: string;
      default_locale: string | null;
    }>(
      supabase,
      articleId,
      access.workspaceIds,
      "id, title, workspace_id, default_locale"
    );

    if (!article) {
      return NextResponse.json(
        { error: "Article not found or access denied" },
        { status: 404 }
      );
    }

    const isDefaultLocale = isKBDefaultArticleLocale(
      locale,
      article.default_locale
    );

    if (parent_id !== undefined || isDefaultLocale) {
      const articleUpdates: Record<string, unknown> = {
        updated_by: access.user.id,
      };

      if (isDefaultLocale) {
        if (title !== undefined) articleUpdates.draft_title = title;
        if (content_mdx !== undefined) {
          articleUpdates.draft_content_mdx = sanitizeBrokenImages(content_mdx);
        }
        if (status && status !== "published") {
          articleUpdates.status = status;
        }
      }

      if (parent_id !== undefined) {
        articleUpdates.parent_id = parent_id;
      }

      const { error: updErr } = await supabase
        .from("kb_articles")
        .update(articleUpdates)
        .eq("id", articleId)
        .in("workspace_id", access.workspaceIds);
      if (updErr) throw updErr;
    }

    if (title !== undefined || status || content_mdx !== undefined) {
      const localizationPayload: Record<string, unknown> = {
        article_id: articleId,
        locale,
        title: title || article.title,
        updated_by: access.user.id,
        updated_at: new Date().toISOString(),
      };

      if (title !== undefined) localizationPayload.draft_title = title;
      if (content_mdx !== undefined) {
        localizationPayload.draft_content_mdx =
          sanitizeBrokenImages(content_mdx);
      }
      if (status && status !== "published") {
        localizationPayload.status = status;
      }

      const { error: localizationError } = await supabase
        .from("kb_article_localizations")
        .upsert(localizationPayload, { onConflict: "article_id,locale" });

      if (localizationError) throw localizationError;
    }

    if (status && status !== "published") {
      // A non-published status on the default language unpublishes the whole
      // article; on another language, just that language.
      await removeUnpublishedKBContentFromSearch({
        articleId,
        workspaceId: article.workspace_id,
        locale: isDefaultLocale ? null : locale,
        retireCanonicalKnowledge: isDefaultLocale,
      });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const supabase = await createClient();
    const { articleId } = await context.params;
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
    }>(supabase, articleId, access.workspaceIds, "id, workspace_id");

    if (!article)
      return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const workspaceId = article.workspace_id;

    // Manually delete related records that may not have cascade delete.
    // These deletes are independent, so run them in parallel to reduce latency.
    const [embeddingDeleteResult, feedbackDeleteResult] = await Promise.all([
      supabaseAdmin
        .from("kb_article_embeddings")
        .delete()
        .eq("article_id", article.id),
      supabaseAdmin
        .from("kb_article_feedback")
        .delete()
        .eq("article_id", article.id),
    ]);

    if (embeddingDeleteResult.error) {
      console.error(
        "[KB Delete] Error deleting embeddings:",
        embeddingDeleteResult.error
      );
      // Continue with deletion even if embeddings delete fails
    }

    if (feedbackDeleteResult.error) {
      console.error(
        "[KB Delete] Error deleting feedback:",
        feedbackDeleteResult.error
      );
      // Continue with deletion even if feedback delete fails
    }

    // 3. Delete article (cascade will handle kb_article_versions automatically)
    const { error: deleteErr } = await supabase
      .from("kb_articles")
      .delete()
      .eq("id", article.id);

    if (deleteErr) throw deleteErr;

    // The deleted article is no longer selected, so a scoped sync deletes its
    // canonical knowledge chunks before the retrieval cache is dropped.
    if (workspaceId) {
      await retireKbArticleCanonicalKnowledge({
        workspaceId,
        articleId: article.id,
      });
    }

    // Invalidate KB retrieval cache (RAG)
    try {
      if (workspaceId) {
        await invalidateKbWorkspaceCaches(workspaceId);
        console.log(
          `[KB Delete] Invalidated retrieval cache for workspace: ${workspaceId}`
        );
      }
    } catch (cacheErr) {
      // Don't fail deletion if cache invalidation fails
      console.error("[KB Delete] Cache invalidation error:", cacheErr);
    }

    const companySlug = await getCompanySlugByWorkspaceId(
      supabaseAdmin,
      workspaceId
    );
    if (companySlug) {
      revalidatePath(`/${companySlug}/kb/${articleId}`);
      revalidatePath(`/${companySlug}/kb`);
      revalidateTag(getPublicKBArticleTag(articleId), "max");
      revalidateTag(getPublicKBNavigationTag(workspaceId), "max");
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
