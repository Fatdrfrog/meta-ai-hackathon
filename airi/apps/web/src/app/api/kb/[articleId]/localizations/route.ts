import { isLocale, type Locale } from "@/i18n/locales";
import {
  getAccessibleKBArticle,
  requireKBRouteAccess,
} from "@/lib/kb/article-access";
import { translateKBArticleLocalization } from "@/lib/kb/kb-article-translation";
import { randomUUID } from "node:crypto";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { getWorkspaceAiRequiredDetails } from "@/lib/ai/workspace-ai-errors";
import {
  isKBLocalizationCreateMode,
  resolveKBDefaultLocale,
  type KBLocalizationCreateMode,
} from "@/lib/kb/kb-localization-actions";
import {
  getKBLocalizationSourceContent,
  revalidateKBLocalizationCaches,
  type KBLocalizationActionArticle,
  type KBLocalizationActionRow,
} from "@/lib/kb/kb-localization-server";
import { sanitizeBrokenImages } from "@/lib/kb/sanitize-content";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
// AI translation of a long article can take up to 240 s
// (getKBArticleTranslationTimeoutMs); pin the duration above it.
export const maxDuration = 300;

function resolveSourceLocale({
  mode,
  bodySourceLocale,
  currentLocale,
  defaultLocale,
}: {
  mode: KBLocalizationCreateMode;
  bodySourceLocale: unknown;
  currentLocale: Locale;
  defaultLocale: Locale;
}): Locale {
  if (mode === "copy_default") {
    return defaultLocale;
  }

  if (
    mode === "copy_locale" ||
    mode === "copy_current" ||
    mode === "ai_translate" ||
    mode === "empty"
  ) {
    return typeof bodySourceLocale === "string" && isLocale(bodySourceLocale)
      ? bodySourceLocale
      : currentLocale;
  }

  return currentLocale;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const { articleId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const targetLocale =
      typeof body?.targetLocale === "string" && isLocale(body.targetLocale)
        ? body.targetLocale
        : null;
    const mode = isKBLocalizationCreateMode(body?.mode) ? body.mode : null;

    if (!targetLocale || !mode) {
      return NextResponse.json(
        { error: "Invalid localization request" },
        { status: 400 }
      );
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

    const defaultLocale = resolveKBDefaultLocale(article.default_locale);
    const currentLocale =
      typeof body?.sourceLocale === "string" && isLocale(body.sourceLocale)
        ? body.sourceLocale
        : defaultLocale;
    const sourceLocale = resolveSourceLocale({
      mode,
      bodySourceLocale: body?.sourceLocale,
      currentLocale,
      defaultLocale,
    });

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
    const existingTarget = localizations.find(
      localization => localization.locale === targetLocale
    );
    const overwrite = body?.overwrite === true;

    if (existingTarget && !overwrite) {
      return NextResponse.json(
        { error: "Language already exists" },
        { status: 409 }
      );
    }

    const source = await getKBLocalizationSourceContent({
      supabase,
      article,
      localizations,
      locale: sourceLocale,
      defaultLocale,
    });

    let nextTitle = source.title || article.title || "Untitled";
    let nextContentMdx = "";

    if (mode === "empty") {
      nextContentMdx = "";
    } else if (mode === "ai_translate") {
      const translated = await withWorkspaceTextAiAction(
        {
          workspaceId: article.workspace_id,
          actionId: `kb-translation:${randomUUID()}`,
        },
        () =>
          translateKBArticleLocalization({
            sourceLocale,
            targetLocale,
            title: source.title,
            contentMdx: source.contentMdx,
          })
      );
      nextTitle = translated.title;
      nextContentMdx = translated.contentMdx;
    } else {
      nextContentMdx = source.contentMdx;
    }

    const status = existingTarget?.status ?? "draft";
    const publishedAt = existingTarget?.published_at ?? null;
    const now = new Date().toISOString();
    const sanitizedContent = sanitizeBrokenImages(nextContentMdx);

    const { error: upsertError } = await supabase
      .from("kb_article_localizations")
      .upsert(
        {
          article_id: article.id,
          locale: targetLocale,
          title: nextTitle,
          status,
          published_at: publishedAt,
          draft_title: nextTitle,
          draft_content_mdx: sanitizedContent,
          updated_by: access.user.id,
          updated_at: now,
        },
        { onConflict: "article_id,locale" }
      );

    if (upsertError) throw upsertError;

    if (targetLocale === defaultLocale) {
      const { error: articleUpdateError } = await supabase
        .from("kb_articles")
        .update({
          draft_title: nextTitle,
          draft_content_mdx: sanitizedContent,
          updated_by: access.user.id,
          updated_at: now,
        })
        .eq("id", article.id)
        .in("workspace_id", access.workspaceIds);

      if (articleUpdateError) throw articleUpdateError;
    }

    await revalidateKBLocalizationCaches({
      articleId: article.id,
      workspaceId: article.workspace_id,
    });

    return NextResponse.json(
      {
        success: true,
        locale: targetLocale,
      },
      { status: 200 }
    );
  } catch (error) {
    const required = getWorkspaceAiRequiredDetails(error);
    if (required) return NextResponse.json(required, { status: 402 });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
