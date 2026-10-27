import { buildEmbeddingMetadata, getCurrentEmbeddingMetadata, getDocumentEmbeddingResult } from "@/lib/ai";
import { EMBEDDING_CACHE_VERSION } from "@/lib/ai/embedding-config";
import { parseStoredEmbedding } from "@/lib/ai/embedding-storage";
import { normalizeEmbeddingText } from "@/lib/ai/vertex-embeddings";
import { createHash } from "node:crypto";
import { invalidateKbWorkspaceCaches } from "@/lib/airi/rag/cache-invalidation";
import { buildKBArticleEmbeddingText } from "@/lib/airi/rag/kb/kb-article-embedding";
import { runKnowledgeCanonicalSync } from "@/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-sync-runner";
import { tryStartKnowledgeCanonicalSyncWorkflow } from "@/lib/temporal/knowledge-canonical-sync-client";
import { getLocaleFromCookie } from "@/i18n/message-loader";
import { isLocale, type Locale } from "@/i18n/locales";
import {
  getAccessibleKBArticle,
  requireKBRouteAccess,
} from "@/lib/kb/article-access";
import { fetchKBAncestors } from "@/lib/kb/fetch-ancestors";
import { getCompanySlugByWorkspaceId } from "@/lib/kb/get-company-slug";
import { resolveKBDefaultLocale } from "@/lib/kb/kb-localization-actions";
import { isKBPlaceholderTitle } from "@/lib/kb/kb-title-overrides";
import {
  getPublicKBArticleTag,
  getPublicKBNavigationTag,
} from "@/lib/kb/public-kb";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type KBArticlePublishMode =
  | "public_with_auto_link"
  | "public_without_auto_link"
  | "ai_context_only";

function isKBArticlePublishMode(value: unknown): value is KBArticlePublishMode {
  return (
    value === "public_with_auto_link" ||
    value === "public_without_auto_link" ||
    value === "ai_context_only"
  );
}

type PublishableKBArticle = {
  id: string;
  title: string;
  status: string | null;
  published_at: string | null;
  is_featured: boolean | null;
  workspace_id: string;
  parent_id: string | null;
  draft_title: string | null;
  draft_content_mdx: string | null;
  default_locale: string | null;
};

type PublishableKBLocalization = {
  locale: string;
  title: string;
  status: string | null;
  published_at: string | null;
  draft_title: string | null;
  draft_content_mdx: string | null;
  updated_at: string | null;
};

type KBArticleEmbeddingRow = {
  locale: string | null;
  embedding: unknown;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_task_type: string | null;
  embedding_dimensions: number | null;
  embedding_fingerprint: string | null;
  updated_at: string | null;
};

type KBPublishRollbackState = {
  articleId: string;
  locale: Locale;
  previousArticleState: {
    status: string | null;
    title: string;
    draft_title: string | null;
    draft_content_mdx: string | null;
    published_at: string | null;
    is_featured: boolean | null;
  };
  previousLocalizationState: PublishableKBLocalization | null;
  previousEmbeddings: KBArticleEmbeddingRow[];
  insertedLegacyVersion: number | null;
  insertedLocalizationVersion: number | null;
  articleUpdateApplied: boolean;
  localizationUpdateApplied: boolean;
  embeddingMutationApplied: boolean;
};

function buildKBPublishError(message: string, cause: unknown): Error {
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
        ? cause.message
        : "";

  return new Error(causeMessage ? `${message}: ${causeMessage}` : message);
}

async function rollbackKBPublishMutation({
  articleId,
  locale,
  previousArticleState,
  previousLocalizationState,
  previousEmbeddings,
  insertedLegacyVersion,
  insertedLocalizationVersion,
  articleUpdateApplied,
  localizationUpdateApplied,
  embeddingMutationApplied,
}: KBPublishRollbackState) {
  try {
    if (articleUpdateApplied) {
      const { error: articleRollbackError } = await supabaseAdmin
        .from("kb_articles")
        .update(previousArticleState)
        .eq("id", articleId);

      if (articleRollbackError) {
        console.error(
          "[KB Publish] Article rollback failed:",
          articleRollbackError
        );
      }
    }

    if (localizationUpdateApplied) {
      if (previousLocalizationState) {
        const { error: localizationRollbackError } = await supabaseAdmin
          .from("kb_article_localizations")
          .update({
            title: previousLocalizationState.title,
            status: previousLocalizationState.status,
            published_at: previousLocalizationState.published_at,
            draft_title: previousLocalizationState.draft_title,
            draft_content_mdx: previousLocalizationState.draft_content_mdx,
            updated_at: previousLocalizationState.updated_at,
          })
          .eq("article_id", articleId)
          .eq("locale", locale);

        if (localizationRollbackError) {
          console.error(
            "[KB Publish] Localization rollback failed:",
            localizationRollbackError
          );
        }
      } else {
        const { error: localizationDeleteError } = await supabaseAdmin
          .from("kb_article_localizations")
          .delete()
          .eq("article_id", articleId)
          .eq("locale", locale);

        if (localizationDeleteError) {
          console.error(
            "[KB Publish] Localization delete rollback failed:",
            localizationDeleteError
          );
        }
      }
    }

    if (embeddingMutationApplied) {
      const { error: deleteEmbeddingsError } = await supabaseAdmin
        .from("kb_article_embeddings")
        .delete()
        .eq("article_id", articleId)
        .eq("locale", locale);

      if (deleteEmbeddingsError) {
        console.error(
          "[KB Publish] Failed to clear replacement embeddings during rollback:",
          deleteEmbeddingsError
        );
      }

      if (previousEmbeddings.length > 0) {
        const { error: restoreEmbeddingsError } = await supabaseAdmin
          .from("kb_article_embeddings")
          .insert(
            previousEmbeddings.map(embedding => ({
              article_id: articleId,
              locale: embedding.locale,
              embedding: embedding.embedding,
              embedding_provider: embedding.embedding_provider,
              embedding_model: embedding.embedding_model,
              embedding_task_type: embedding.embedding_task_type,
              embedding_dimensions: embedding.embedding_dimensions,
              embedding_fingerprint: embedding.embedding_fingerprint,
              updated_at: embedding.updated_at ?? new Date().toISOString(),
            }))
          );

        if (restoreEmbeddingsError) {
          console.error(
            "[KB Publish] Failed to restore previous embeddings during rollback:",
            restoreEmbeddingsError
          );
        }
      }
    }

    if (insertedLegacyVersion !== null) {
      const { error: deleteVersionError } = await supabaseAdmin
        .from("kb_article_versions")
        .delete()
        .eq("article_id", articleId)
        .eq("version", insertedLegacyVersion);

      if (deleteVersionError) {
        console.error(
          "[KB Publish] Failed to delete rollback version:",
          deleteVersionError
        );
      }
    }

    if (insertedLocalizationVersion !== null) {
      const { error: deleteLocalizationVersionError } = await supabaseAdmin
        .from("kb_article_localization_versions")
        .delete()
        .eq("article_id", articleId)
        .eq("locale", locale)
        .eq("version", insertedLocalizationVersion);

      if (deleteLocalizationVersionError) {
        console.error(
          "[KB Publish] Failed to delete rollback localization version:",
          deleteLocalizationVersionError
        );
      }
    }

    const { error: refreshRollbackError } = await supabaseAdmin.rpc(
      "kb_refresh_article_search_vector",
      {
        p_article_id: articleId,
      }
    );

    if (refreshRollbackError) {
      console.error(
        "[KB Publish] Failed to refresh article search vector after rollback:",
        refreshRollbackError
      );
    }
  } catch (rollbackError) {
    console.error("[KB Publish] Unexpected rollback failure:", rollbackError);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const { articleId } = await context.params;
    let publishMode: KBArticlePublishMode = "public_with_auto_link";
    let requestLocale: Locale | null = null;

    try {
      const body = await request.json();
      if (isKBArticlePublishMode(body?.publishMode)) {
        publishMode = body.publishMode;
      }
      if (typeof body?.locale === "string" && isLocale(body.locale)) {
        requestLocale = body.locale;
      }
    } catch {
      // Keep default when no JSON body is provided.
    }
    const cookieLocale = await getLocaleFromCookie();
    const locale = requestLocale ?? cookieLocale;

    const supabase = await createClient();
    const access = await requireKBRouteAccess(supabase);
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status }
      );
    }

    if (!articleId)
      return NextResponse.json({ error: "Article not found" }, { status: 404 });

    const article = await getAccessibleKBArticle<PublishableKBArticle>(
      supabase,
      articleId,
      access.workspaceIds,
      "id, title, status, published_at, is_featured, workspace_id, parent_id, draft_title, draft_content_mdx, default_locale"
    );

    if (!article)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    const wasAlreadyPublished =
      article.status === "published" || Boolean(article.published_at);

    const { data: localizationRow, error: localizationFetchError } =
      await supabase
        .from("kb_article_localizations")
        .select(
          "locale, title, status, published_at, draft_title, draft_content_mdx, updated_at"
        )
        .eq("article_id", article.id)
        .eq("locale", locale)
        .maybeSingle();

    if (localizationFetchError) {
      throw localizationFetchError;
    }

    const localization =
      (localizationRow as PublishableKBLocalization | null) ?? null;
    const defaultLocale = resolveKBDefaultLocale(article.default_locale);
    const isDefaultLocale = locale === defaultLocale;
    const finalTitle = isDefaultLocale
      ? (article.draft_title ?? article.title)
      : (localization?.draft_title ??
        localization?.title ??
        article.draft_title ??
        article.title);

    if (isKBPlaceholderTitle(finalTitle)) {
      return NextResponse.json(
        { error: "Add a title before publishing" },
        { status: 400 }
      );
    }

    const isPublicMode = publishMode !== "ai_context_only";
    const disableAutoLinkEmbedding = publishMode !== "public_with_auto_link";
    const publishTimestamp = new Date().toISOString();
    const publishedAt = isPublicMode
      ? (localization?.published_at ?? article.published_at ?? publishTimestamp)
      : null;
    const publishedUpdatedAt = new Date().toISOString();

    const updates: Record<string, unknown> = {
      status: "published",
      is_featured: disableAutoLinkEmbedding,
    };
    if (isDefaultLocale) {
      updates.title = finalTitle;
      updates.draft_title = null;
      updates.draft_content_mdx = null;
    }
    if (isPublicMode) {
      if (!article.published_at) updates.published_at = publishTimestamp;
    } else {
      updates.published_at = null;
    }

    const draftContent = isDefaultLocale
      ? (article.draft_content_mdx ?? localization?.draft_content_mdx)
      : localization?.draft_content_mdx;
    const contentFromDraft =
      draftContent !== null && draftContent !== undefined;
    let content = draftContent ?? "";

    if (!contentFromDraft) {
      const { data: latestVersion, error: latestVersionError } = await supabase
        .from("kb_article_localization_versions")
        .select("content_mdx")
        .eq("article_id", article.id)
        .eq("locale", locale)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestVersionError) throw latestVersionError;

      content = latestVersion?.content_mdx ?? "";

      if (!content && isDefaultLocale) {
        const { data: legacyVersion, error: legacyVersionError } =
          await supabase
            .from("kb_article_versions")
            .select("content_mdx")
            .eq("article_id", article.id)
            .order("version", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (legacyVersionError) throw legacyVersionError;
        content = legacyVersion?.content_mdx ?? "";
      }
    }

    const { data: previousEmbeddings, error: previousEmbeddingsError } =
      await supabaseAdmin
        .from("kb_article_embeddings")
        .select(
          "locale, embedding, embedding_provider, embedding_model, embedding_task_type, embedding_dimensions, embedding_fingerprint, updated_at"
        )
        .eq("article_id", article.id)
        .eq("locale", locale);

    if (previousEmbeddingsError) {
      throw previousEmbeddingsError;
    }

    const ancestors = await fetchKBAncestors(
      supabase,
      article.parent_id,
      article.workspace_id,
      { useDraft: true, maxDepth: 5, locale }
    );
    const parentTitles = ancestors.map(ancestor => ancestor.title);

    const textToEmbed = buildKBArticleEmbeddingText({
      title: finalTitle,
      content,
      ancestorTitles: parentTitles,
    });
    const embeddingFingerprint = (metadata: {
      embeddingProvider: string | null;
      embeddingModel: string | null;
      embeddingTaskType: string | null;
      embeddingDimensions: number | null;
    }) =>
      createHash("sha256").update(JSON.stringify({
        version: 1,
        cacheVersion: EMBEDDING_CACHE_VERSION,
        metadata,
        title: finalTitle,
        text: normalizeEmbeddingText(textToEmbed),
      })).digest("hex");
    const expectedFingerprint = embeddingFingerprint(getCurrentEmbeddingMetadata("RETRIEVAL_DOCUMENT"));
    const reusableEmbedding = (previousEmbeddings as KBArticleEmbeddingRow[] | null)?.some(row =>
      row.embedding_fingerprint === expectedFingerprint &&
      embeddingFingerprint({
        embeddingProvider: row.embedding_provider,
        embeddingModel: row.embedding_model,
        embeddingTaskType: row.embedding_task_type,
        embeddingDimensions: row.embedding_dimensions,
      }) === expectedFingerprint &&
      parseStoredEmbedding(row.embedding)
    );

    let nextLegacyVersion: number | null = null;
    let nextLocalizationVersion: number | null = null;
    let embeddingInsertPayload: {
      locale: string;
      embedding: unknown;
      embedding_provider: string;
      embedding_model: string;
      embedding_task_type: string;
      embedding_dimensions: number;
      embedding_fingerprint: string;
      updated_at: string;
    } | null = null;
    const warnings: string[] = [];

    const addWarning = (warning: string) => {
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    };

    if (textToEmbed && !reusableEmbedding) {
      try {
        const embeddingResult = await getDocumentEmbeddingResult(textToEmbed, {
          title: finalTitle,
          action: { workspaceId: article.workspace_id, actionId: `kb-publish:${article.id}:${locale}:${expectedFingerprint}` },
        });

        if (!embeddingResult?.embedding) {
          addWarning("embedding_unavailable");
          console.warn(
            "[KB Publish] Article embedding unavailable; continuing publish",
            {
              articleId: article.id,
              locale,
              publishMode,
            }
          );
        } else {
          const embeddingMetadata = buildEmbeddingMetadata(embeddingResult);
          embeddingInsertPayload = {
            locale,
            embedding: embeddingResult.embedding,
            embedding_provider: embeddingMetadata.embeddingProvider,
            embedding_model: embeddingMetadata.embeddingModel,
            embedding_task_type: embeddingMetadata.embeddingTaskType,
            embedding_dimensions: embeddingMetadata.embeddingDimensions,
            embedding_fingerprint: embeddingFingerprint(embeddingMetadata),
            updated_at: new Date().toISOString(),
          };
        }
      } catch (embeddingError) {
        addWarning("embedding_failed");
        console.error(
          "[KB Publish] Article embedding failed; continuing publish:",
          embeddingError
        );
      }
    }

    const previousArticleState = {
      status: article.status,
      title: article.title,
      draft_title: article.draft_title,
      draft_content_mdx: article.draft_content_mdx,
      published_at: article.published_at,
      is_featured: article.is_featured,
    };

    let articleUpdateApplied = false;
    let localizationUpdateApplied = false;
    let embeddingMutationApplied = false;
    try {
      if (contentFromDraft) {
        const { data: lastVersion, error: lastVersionError } = await supabase
          .from("kb_article_localization_versions")
          .select("version")
          .eq("article_id", article.id)
          .eq("locale", locale)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lastVersionError) {
          throw lastVersionError;
        }

        nextLocalizationVersion = (lastVersion?.version ?? 0) + 1;

        const { error: versionInsertError } = await supabase
          .from("kb_article_localization_versions")
          .insert({
            article_id: article.id,
            locale,
            version: nextLocalizationVersion,
            title: finalTitle,
            content_mdx: content,
            created_by: access.user.id,
          });

        if (versionInsertError) {
          throw versionInsertError;
        }

        if (isDefaultLocale) {
          const { data: lastLegacyVersion, error: lastLegacyVersionError } =
            await supabase
              .from("kb_article_versions")
              .select("version")
              .eq("article_id", article.id)
              .order("version", { ascending: false })
              .limit(1)
              .maybeSingle();

          if (lastLegacyVersionError) {
            throw lastLegacyVersionError;
          }

          nextLegacyVersion = (lastLegacyVersion?.version ?? 0) + 1;

          const { error: legacyVersionInsertError } = await supabase
            .from("kb_article_versions")
            .insert({
              article_id: article.id,
              version: nextLegacyVersion,
              content_mdx: content,
              created_by: access.user.id,
            });

          if (legacyVersionInsertError) {
            throw legacyVersionInsertError;
          }
        }
      }

      if (embeddingInsertPayload) {
        const { error: insertEmbeddingError } = await supabaseAdmin
          .from("kb_article_embeddings")
          .upsert(
            {
              article_id: article.id,
              locale: embeddingInsertPayload.locale,
              embedding: embeddingInsertPayload.embedding,
              embedding_provider: embeddingInsertPayload.embedding_provider,
              embedding_model: embeddingInsertPayload.embedding_model,
              embedding_task_type: embeddingInsertPayload.embedding_task_type,
              embedding_dimensions: embeddingInsertPayload.embedding_dimensions,
              embedding_fingerprint: embeddingInsertPayload.embedding_fingerprint,
              updated_at: embeddingInsertPayload.updated_at,
            },
            { onConflict: "article_id,locale" }
          );

        if (insertEmbeddingError) {
          console.error(
            "[KB Publish] Failed to store article embedding; aborting publish:",
            insertEmbeddingError
          );
          throw buildKBPublishError(
            "Failed to store article embedding",
            insertEmbeddingError
          );
        }
        embeddingMutationApplied = true;
      } else if (
        warnings.some(warning => warning.startsWith("embedding_")) &&
        (previousEmbeddings?.length ?? 0) > 0
      ) {
        const { error: deleteStaleEmbeddingError } = await supabaseAdmin
          .from("kb_article_embeddings")
          .delete()
          .eq("article_id", article.id)
          .eq("locale", locale);

        if (deleteStaleEmbeddingError) {
          console.error(
            "[KB Publish] Failed to clear stale article embedding; aborting publish:",
            deleteStaleEmbeddingError
          );
          throw buildKBPublishError(
            "Failed to clear stale article embedding",
            deleteStaleEmbeddingError
          );
        }
        embeddingMutationApplied = true;
      }

      const { error: localizationUpdateError } = await supabase
        .from("kb_article_localizations")
        .upsert(
          {
            article_id: article.id,
            locale,
            title: finalTitle,
            status: "published",
            published_at: publishedAt,
            draft_title: null,
            draft_content_mdx: null,
            updated_by: access.user.id,
            updated_at: publishedUpdatedAt,
          },
          { onConflict: "article_id,locale" }
        );

      if (localizationUpdateError) {
        throw localizationUpdateError;
      }
      localizationUpdateApplied = true;

      const { error: updateArticleError } = await supabase
        .from("kb_articles")
        .update(updates)
        .eq("id", article.id)
        .in("workspace_id", access.workspaceIds);

      if (updateArticleError) {
        throw updateArticleError;
      }
      articleUpdateApplied = true;

      const { error: refreshSearchVectorError } = await supabaseAdmin.rpc(
        "kb_refresh_article_search_vector",
        {
          p_article_id: article.id,
        }
      );

      if (refreshSearchVectorError) {
        throw refreshSearchVectorError;
      }
    } catch (error) {
      await rollbackKBPublishMutation({
        articleId: article.id,
        locale,
        previousArticleState,
        previousLocalizationState: localization,
        previousEmbeddings: previousEmbeddings ?? [],
        insertedLegacyVersion: nextLegacyVersion,
        insertedLocalizationVersion: nextLocalizationVersion,
        articleUpdateApplied,
        localizationUpdateApplied,
        embeddingMutationApplied,
      });
      throw error;
    }

    try {
      const workspaceId = article.workspace_id;
      if (workspaceId) {
        await invalidateKbWorkspaceCaches(workspaceId);
        console.log(
          `[KB Cache] Invalidated retrieval cache for workspace: ${workspaceId}`
        );
      }
    } catch (cacheErr) {
      console.error("[KB Cache] Cache invalidation error:", cacheErr);
    }

    const companySlug = article.workspace_id
      ? await getCompanySlugByWorkspaceId(supabaseAdmin, article.workspace_id)
      : null;
    if (companySlug) {
      revalidatePath(`/${companySlug}/kb/${articleId}`);
      revalidatePath(`/${companySlug}/kb`);
      revalidateTag(getPublicKBArticleTag(articleId), "max");
      revalidateTag(getPublicKBNavigationTag(article.workspace_id), "max");
    }

    if (article.workspace_id) {
      try {
        const temporalResult = await tryStartKnowledgeCanonicalSyncWorkflow({
          workspaceId: article.workspace_id,
          sourceKinds: ["kb_article"],
          sourceRecordIds: [article.id],
          executionId: `kb-publish-${article.id}-${Date.now()}`,
        });
        if (!temporalResult.ok) {
          console.warn(
            "[KB Publish] Temporal canonical sync not started; running inline kb_article sync",
            {
              reason: temporalResult.reason,
              message:
                temporalResult.reason === "start_failed"
                  ? temporalResult.message
                  : undefined,
            }
          );
          await runKnowledgeCanonicalSync({
            workspaceId: article.workspace_id,
            sourceKinds: ["kb_article"],
            sourceRecordIds: [article.id],
            dryRun: false,
          });
        }
      } catch (syncErr) {
        console.error("[KB Publish] Knowledge canonical sync failed:", syncErr);
      }
    }

    let isFirstPublishedInWorkspace = false;
    if (article.workspace_id && !wasAlreadyPublished) {
      const { count, error: countError } = await supabase
        .from("kb_articles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", article.workspace_id)
        .eq("status", "published");

      if (countError) throw countError;
      isFirstPublishedInWorkspace = (count ?? 0) === 1;
    }

    return NextResponse.json(
      {
        success: true,
        isFirstPublishedInWorkspace,
        publishedLocalization: {
          locale,
          status: "published",
          published_at: publishedAt,
          updated_at: publishedUpdatedAt,
          hasDraft: false,
          isDefault: isDefaultLocale,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
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
