import "server-only";

import { createHash } from "node:crypto";
import {
  buildEmbeddingMetadata,
  getCurrentEmbeddingMetadata,
  getDocumentEmbeddingResultsBatch,
  isEmbeddingMetadataCurrent,
} from "@/lib/ai";
import { EMBEDDING_CACHE_VERSION } from "@/lib/ai/embedding-config";
import { parseStoredEmbedding } from "@/lib/ai/embedding-storage";
import { normalizeEmbeddingText } from "@/lib/ai/vertex-embeddings";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import {
  finishKnowledgeSyncRun,
  getKnowledgeDocumentSnapshot,
  getKnowledgeDocumentsForReconciliation,
  reconcileKnowledgeDocuments,
  replaceKnowledgeDocumentChunks,
  startKnowledgeSyncRun,
  type CanonicalChunk,
  type KnowledgeReconciliationSnapshot,
} from "@/lib/airi/rag/knowledge/canonical-sync/knowledge-canonical-repository";
import type {
  KBVersionRow,
  KnowledgeCanonicalSourceKind,
  KnowledgeSyncResult,
  RunKnowledgeCanonicalSyncInput,
  RunKnowledgeCanonicalSyncResult,
} from "@/lib/airi/rag/kb/kb-types";
import {
  buildChunkEmbeddingText,
  chunkCuratedSnippet,
  chunkIndexedUrlByBlocks,
  chunkKbArticleByHeadings,
} from "@/lib/airi/rag/knowledge/knowledge-chunkers";
import { ragLogger } from "@/lib/airi/shared/logger";
import { fetchArticleURLData, generateArticleURL } from "@/lib/kb/article-url";
import { resolveKBDefaultLocale } from "@/lib/kb/kb-localization-actions";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import AnswerSnippet, {
  ensureAnswerSnippetIndexes,
} from "@/models/answer-snippet";
import {
  KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS,
  normalizeKnowledgeCanonicalSyncSourceKinds,
} from "@icecore/temporal";

function getLatestVersion(
  versions: KBVersionRow[] | KBVersionRow | null
): KBVersionRow | undefined {
  const list = Array.isArray(versions) ? versions : versions ? [versions] : [];
  return [...list].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function resolveCompanyIdByWorkspace(
  workspaceId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .single();

  if (error || !data) return null;
  return (data as { company_id?: string | null }).company_id || null;
}

function emptyResult(
  status: KnowledgeSyncResult["status"]
): KnowledgeSyncResult {
  return {
    documentsTouched: 0,
    chunksUpserted: 0,
    chunksDeleted: 0,
    status,
  };
}

async function persistChunkedDocument(params: {
  workspaceId: string;
  sourceKind: string;
  sourceRecordId: string;
  title: string | null;
  canonicalUrl: string | null;
  locale: string | null;
  authorityScore: number;
  chunks: Array<{
    text: string;
    title?: string;
    chunkIndex: number;
    headingPath?: string[] | null;
  }>;
  documentMetadata: Record<string, unknown>;
  dryRun: boolean;
  observedDocument?: KnowledgeReconciliationSnapshot | null;
}): Promise<{ chunksUpserted: number; chunksDeleted: number }> {
  if (params.dryRun) {
    return { chunksUpserted: params.chunks.length, chunksDeleted: 0 };
  }

  // Prepend document title and full heading breadcrumb so short sub-sections
  // gain ancestor context and retrieval recall improves.
  const embeddingInputs = params.chunks.map(c =>
    buildChunkEmbeddingText({
      documentTitle: params.title,
      headingPath:
        c.headingPath && c.headingPath.length > 0
          ? c.headingPath
          : c.title
            ? [c.title]
            : null,
      text: c.text,
    })
  );
  const snapshot = await getKnowledgeDocumentSnapshot(params);
  if (
    params.observedDocument !== undefined &&
    ((snapshot?.id ?? null) !== (params.observedDocument?.id ?? null) ||
      (snapshot?.updatedAt ?? null) !==
        (params.observedDocument?.updatedAt ?? null))
  ) {
    throw new Error(
      `Canonical document changed after source snapshot: ${params.sourceKind}:${params.sourceRecordId}`
    );
  }
  const embeddingMetadata = getCurrentEmbeddingMetadata("RETRIEVAL_DOCUMENT");
  const chunkFingerprints = embeddingInputs.map(text =>
    fingerprint({
      version: 1,
      cacheVersion: EMBEDDING_CACHE_VERSION,
      embeddingMetadata,
      chunking: RAG_CONFIG.chunking,
      text: normalizeEmbeddingText(text),
    })
  );
  const documentFingerprint = fingerprint({
    chunkFingerprints,
    title: params.title,
    canonicalUrl: params.canonicalUrl,
    locale: params.locale,
    authorityScore: params.authorityScore,
    metadata: params.documentMetadata,
  });
  const reused = chunkFingerprints.map(chunkFingerprint => {
    const previous = snapshot?.chunks.find(
      chunk =>
        chunk.metadata?.embeddingFingerprint === chunkFingerprint &&
        isEmbeddingMetadataCurrent(chunk.metadata, "RETRIEVAL_DOCUMENT")
    );
    return parseStoredEmbedding(previous?.embedding);
  });
  if (
    snapshot?.metadata?.canonicalFingerprint === documentFingerprint &&
    snapshot.chunks.length === params.chunks.length &&
    reused.every(Boolean)
  ) {
    return { chunksUpserted: 0, chunksDeleted: 0 };
  }
  const missingIndexes = reused.flatMap((embedding, index) =>
    embedding ? [] : [index]
  );
  const generated =
    missingIndexes.length > 0
      ? await getDocumentEmbeddingResultsBatch(
          missingIndexes.map(index => embeddingInputs[index]),
          { workspaceId: params.workspaceId, actionId: `knowledge:${params.sourceKind}:${params.sourceRecordId}:${documentFingerprint}` }
        )
      : [];
  for (let offset = 0; offset < missingIndexes.length; offset++) {
    const result = generated[offset];
    if (
      !result ||
      !parseStoredEmbedding(result.embedding) ||
      !isEmbeddingMetadataCurrent(
        buildEmbeddingMetadata(result),
        "RETRIEVAL_DOCUMENT"
      )
    ) {
      throw new Error(
        `Incomplete canonical embeddings for ${params.sourceKind}:${params.sourceRecordId}`
      );
    }
    reused[missingIndexes[offset]] = result.embedding;
  }

  const document = {
    workspaceId: params.workspaceId,
    sourceKind: params.sourceKind,
    sourceRecordId: params.sourceRecordId,
    title: params.title,
    canonicalUrl: params.canonicalUrl,
    locale: params.locale,
    authorityScore: params.authorityScore,
    metadata: {
      ...params.documentMetadata,
      canonicalFingerprint: documentFingerprint,
    },
  };
  const rows: CanonicalChunk[] = params.chunks.map((c, i) => {
    const resolvedHeadingPath =
      c.headingPath && c.headingPath.length > 0
        ? c.headingPath
        : c.title
          ? [c.title]
          : null;
    return {
      chunkIndex: c.chunkIndex,
      content: c.text,
      locale: params.locale,
      headingPath: resolvedHeadingPath,
      citationLabel: c.title ?? null,
      documentTitle: params.title,
      embedding: reused[i],
      authorityScore: params.authorityScore,
      metadata: {
        ...embeddingMetadata,
        embeddingFingerprint: chunkFingerprints[i],
        sourceRecordId: params.sourceRecordId,
        chunkTitle: c.title ?? null,
        headingPath: resolvedHeadingPath,
      },
    };
  });

  return replaceKnowledgeDocumentChunks({
    document,
    expectedUpdatedAt:
      params.observedDocument !== undefined
        ? (params.observedDocument?.updatedAt ?? null)
        : (snapshot?.updatedAt ?? null),
    chunks: rows,
  });
}

type KbArticleLocalizationStatusRow = {
  locale: string;
  status: string | null;
};

// Canonical KB documents hold the default-language content, so an article
// whose default language was unpublished (another language stays published)
// must leave the canonical layer too. Articles without a default-language
// localization row follow the article status alone.
function isKbDefaultLanguagePublished(row: {
  default_locale: string | null;
  kb_article_localizations:
    | KbArticleLocalizationStatusRow[]
    | KbArticleLocalizationStatusRow
    | null;
}): boolean {
  const defaultLocale = resolveKBDefaultLocale(row.default_locale);
  const localizations = Array.isArray(row.kb_article_localizations)
    ? row.kb_article_localizations
    : row.kb_article_localizations
      ? [row.kb_article_localizations]
      : [];
  const defaultLocalization = localizations.find(
    localization => localization.locale === defaultLocale
  );
  return !defaultLocalization || defaultLocalization.status === "published";
}

async function syncKbArticles(
  workspaceId: string,
  dryRun: boolean,
  sourceRecordIds?: string[]
): Promise<KnowledgeSyncResult> {
  let query = supabaseAdmin
    .from("kb_articles")
    .select(
      `
      id,
      title,
      workspace_id,
      updated_at,
      default_locale,
      kb_article_versions ( content_mdx, version ),
      kb_article_localizations ( locale, status )
    `
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "published");
  if (sourceRecordIds) query = query.in("id", sourceRecordIds);
  const { data, error } = await query;

  if (error) {
    return {
      ...emptyResult("failed"),
      errorMessage: error.message,
    };
  }

  const articles = (data || []).filter(isKbDefaultLanguagePublished);
  const urlMap =
    articles.length > 0
      ? await fetchArticleURLData(articles.map((a: { id: string }) => a.id))
      : new Map();

  let documentsTouched = 0;
  let chunksUpserted = 0;
  let chunksDeleted = 0;

  for (const row of articles as Array<{
    id: string;
    title: string | null;
    updated_at: string;
    kb_article_versions: KBVersionRow[] | KBVersionRow | null;
  }>) {
    const latestVersion = getLatestVersion(row.kb_article_versions);
    const rawContent = latestVersion?.content_mdx || "";
    const urlData = urlMap.get(row.id);
    const publicUrl =
      urlData?.isPubliclyVisible && urlData.companySlug && urlData.articlePath
        ? generateArticleURL(urlData.companySlug, urlData.articlePath)
        : null;

    const evidenceChunks = chunkKbArticleByHeadings({
      articleId: row.id,
      title: row.title || "Untitled",
      bodyText: rawContent,
      url: publicUrl || undefined,
    });

    const chunkPayload = evidenceChunks.map((ec, idx) => ({
      text: ec.text,
      title: ec.title,
      chunkIndex: idx,
      headingPath:
        (ec.metadata?.headingPath as string[] | undefined) ?? undefined,
    }));

    const persisted = await persistChunkedDocument({
      workspaceId,
      sourceKind: "kb_article",
      sourceRecordId: row.id,
      title: row.title,
      canonicalUrl: publicUrl,
      locale: null,
      authorityScore: 0.82,
      chunks: chunkPayload,
      documentMetadata: {
        kbArticleId: row.id,
        kbVersion: latestVersion?.version ?? null,
        sourceUpdatedAt: row.updated_at,
      },
      dryRun,
    });

    documentsTouched += 1;
    chunksUpserted += persisted.chunksUpserted;
    chunksDeleted += persisted.chunksDeleted;
  }
  if (!dryRun)
    chunksDeleted += await reconcileKnowledgeDocuments({
      workspaceId,
      sourceKind: "kb_article",
      sourceRecordIds,
      activeSourceRecordIds: articles.map((row: { id: string }) => row.id),
    });

  return {
    documentsTouched,
    chunksUpserted,
    chunksDeleted,
    status: "completed",
  };
}

async function syncIndexedUrls(
  workspaceId: string,
  dryRun: boolean,
  sourceRecordIds?: string[]
): Promise<KnowledgeSyncResult> {
  const companyId = await resolveCompanyIdByWorkspace(workspaceId);
  if (!companyId) {
    return emptyResult("completed");
  }

  let query = supabaseAdmin
    .from("kb_indexed_urls")
    .select("id, title, url, content_text, index_status, updated_at")
    .eq("company_id", companyId)
    .neq("index_status", "failed");
  if (sourceRecordIds) query = query.in("id", sourceRecordIds);
  const { data, error } = await query;

  if (error) {
    return {
      ...emptyResult("failed"),
      errorMessage: error.message,
    };
  }

  const rows = data || [];
  let documentsTouched = 0;
  let chunksUpserted = 0;
  let chunksDeleted = 0;

  for (const row of rows as Array<{
    id: string;
    title: string | null;
    url: string | null;
    content_text: string | null;
    updated_at: string | null;
  }>) {
    const body = row.content_text || "";
    const evidenceChunks = chunkIndexedUrlByBlocks({
      pageId: row.id,
      title: row.title || row.url || "Page",
      bodyText: body,
      url: row.url || undefined,
    });

    const chunkPayload = evidenceChunks.map((ec, idx) => ({
      text: ec.text,
      title: ec.title,
      chunkIndex: idx,
      headingPath:
        (ec.metadata?.headingPath as string[] | undefined) ?? undefined,
    }));

    const persisted = await persistChunkedDocument({
      workspaceId,
      sourceKind: "indexed_url",
      sourceRecordId: row.id,
      title: row.title,
      canonicalUrl: row.url,
      locale: null,
      authorityScore: 0.5,
      chunks: chunkPayload,
      documentMetadata: {
        indexedUrlId: row.id,
        sourceUpdatedAt: row.updated_at,
      },
      dryRun,
    });

    documentsTouched += 1;
    chunksUpserted += persisted.chunksUpserted;
    chunksDeleted += persisted.chunksDeleted;
  }
  if (!dryRun)
    chunksDeleted += await reconcileKnowledgeDocuments({
      workspaceId,
      sourceKind: "indexed_url",
      sourceRecordIds,
      activeSourceRecordIds: rows.map((row: { id: string }) => row.id),
    });

  return {
    documentsTouched,
    chunksUpserted,
    chunksDeleted,
    status: "completed",
  };
}

async function syncAnswerSnippets(
  workspaceId: string,
  dryRun: boolean,
  sourceRecordIds?: string[]
): Promise<KnowledgeSyncResult> {
  await connectDB();
  await ensureAnswerSnippetIndexes();

  const observedDocuments = dryRun
    ? []
    : await getKnowledgeDocumentsForReconciliation({
        workspaceId,
        sourceKind: "curated_snippet",
        sourceRecordIds,
      });
  const observedBySourceId = new Map(
    observedDocuments.map(document => [document.sourceRecordId, document])
  );

  const docs = await AnswerSnippet.find({
    workspaceId,
    ...(sourceRecordIds ? { _id: { $in: sourceRecordIds } } : {}),
  })
    .select(
      "_id question answer language category tags safe sourceMessageIds updatedAt"
    )
    .lean();

  let documentsTouched = 0;
  let chunksUpserted = 0;
  let chunksDeleted = 0;

  for (const doc of docs) {
    const id = String(doc._id);
    const evidenceChunks = chunkCuratedSnippet({
      snippetId: id,
      question: doc.question || "",
      answer: doc.answer || "",
      locale: doc.language || undefined,
    });

    const chunkPayload = evidenceChunks.map((ec, idx) => ({
      text: ec.text,
      title: ec.title,
      chunkIndex: idx,
      headingPath:
        (ec.metadata?.headingPath as string[] | undefined) ?? undefined,
    }));

    const tags =
      Array.isArray(doc.tags) && doc.tags.length > 0 ? doc.tags : null;
    const sourceMessageIds =
      Array.isArray(doc.sourceMessageIds) && doc.sourceMessageIds.length > 0
        ? doc.sourceMessageIds
        : null;
    const safe = typeof doc.safe === "boolean" ? doc.safe : null;
    const updatedAt = doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : null;

    const persisted = await persistChunkedDocument({
      workspaceId,
      sourceKind: "curated_snippet",
      sourceRecordId: id,
      observedDocument: observedBySourceId.get(id) ?? null,
      title: (doc.question || "").slice(0, 200),
      canonicalUrl: null,
      locale: doc.language || null,
      authorityScore: 0.95,
      chunks: chunkPayload,
      documentMetadata: {
        answerSnippetId: id,
        category: doc.category ?? null,
        tags,
        safe,
        sourceMessageIds,
        // Mongo updatedAt → allows downstream freshness_at ordering.
        mongoUpdatedAt: updatedAt,
      },
      dryRun,
    });

    documentsTouched += 1;
    chunksUpserted += persisted.chunksUpserted;
    chunksDeleted += persisted.chunksDeleted;
  }
  if (!dryRun)
    chunksDeleted += await reconcileKnowledgeDocuments({
      workspaceId,
      sourceKind: "curated_snippet",
      sourceRecordIds,
      observedDocuments,
      activeSourceRecordIds: docs.map(doc => String(doc._id)),
    });

  return {
    documentsTouched,
    chunksUpserted,
    chunksDeleted,
    status: "completed",
  };
}

/**
 * Mirrors KB articles, indexed URLs, and Mongo answer snippets into
 * knowledge_documents / knowledge_chunks.
 * Intended for Temporal activities and admin/cron triggers — not on the online RAG hot path.
 */
export async function runKnowledgeCanonicalSync(
  input: RunKnowledgeCanonicalSyncInput
): Promise<RunKnowledgeCanonicalSyncResult> {
  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  const normalizedSourceKinds = normalizeKnowledgeCanonicalSyncSourceKinds(
    input.sourceKinds
  );
  const kinds: KnowledgeCanonicalSourceKind[] = normalizedSourceKinds
    ? normalizedSourceKinds
    : [...KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS];

  const dryRun = Boolean(input.dryRun);
  const sourceRecordIds =
    input.sourceRecordIds === undefined
      ? undefined
      : Array.isArray(input.sourceRecordIds)
        ? [
            ...new Set(
              input.sourceRecordIds
                .filter(id => typeof id === "string" && id.trim())
                .map(id => id.trim())
            ),
          ]
        : [];
  const bySource: Record<string, KnowledgeSyncResult> = {};
  const syncRunIds: string[] = [];
  if (sourceRecordIds?.length === 0)
    return { workspaceId, bySource, syncRunIds };

  for (const kind of kinds) {
    const runId = await startKnowledgeSyncRun({
      workspaceId,
      sourceKind: kind,
      metadata: { dryRun },
    });
    if (runId) syncRunIds.push(runId);

    try {
      let result: KnowledgeSyncResult;
      if (kind === "kb_article") {
        result = await syncKbArticles(workspaceId, dryRun, sourceRecordIds);
      } else if (kind === "indexed_url") {
        result = await syncIndexedUrls(workspaceId, dryRun, sourceRecordIds);
      } else if (kind === "curated_snippet") {
        result = await syncAnswerSnippets(workspaceId, dryRun, sourceRecordIds);
      } else {
        const exhaustive: never = kind;
        throw new Error(`Unsupported canonical source kind: ${exhaustive}`);
      }

      bySource[kind] = result;

      if (runId) {
        await finishKnowledgeSyncRun({
          runId,
          status: result.status === "failed" ? "failed" : "completed",
          documentsTouched: result.documentsTouched,
          chunksUpserted: result.chunksUpserted,
          chunksDeleted: result.chunksDeleted,
          errorMessage: result.errorMessage ?? null,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bySource[kind] = {
        ...emptyResult("failed"),
        errorMessage: message,
      };
      if (runId) {
        await finishKnowledgeSyncRun({
          runId,
          status: "failed",
          documentsTouched: 0,
          chunksUpserted: 0,
          chunksDeleted: 0,
          errorMessage: message,
        });
      }
      ragLogger.general.error("knowledge_canonical_sync.source_failed", err, {
        workspaceId,
        sourceKind: kind,
      });
    }
  }

  ragLogger.general.info("knowledge_canonical_sync.completed", {
    workspaceId,
    dryRun,
    kinds,
    bySource,
  });

  return { workspaceId, bySource, syncRunIds };
}

/**
 * Scoped kb_article sync for an article whose content just left the published
 * set (unpublished, deleted, or its default language unpublished). The article
 * is no longer selected, so reconciliation deletes its canonical document and
 * chunks. Runs inline rather than through Temporal: nothing is embedded, and
 * callers drop cached retrieval results only after the chunks are gone.
 * Never throws; the retrieval guard and the daily sync cover a failure.
 */
export async function retireKbArticleCanonicalKnowledge(params: {
  workspaceId: string;
  articleId: string;
}): Promise<void> {
  try {
    const result = await runKnowledgeCanonicalSync({
      workspaceId: params.workspaceId,
      sourceKinds: ["kb_article"],
      sourceRecordIds: [params.articleId],
      dryRun: false,
    });
    const kbResult = result.bySource.kb_article;
    if (kbResult?.status === "failed") {
      ragLogger.general.warn(
        "knowledge_canonical_sync.kb_article_retire_failed",
        {
          workspaceId: params.workspaceId,
          articleId: params.articleId,
          error: kbResult.errorMessage ?? null,
        }
      );
    }
  } catch (error) {
    ragLogger.general.warn(
      "knowledge_canonical_sync.kb_article_retire_failed",
      {
        workspaceId: params.workspaceId,
        articleId: params.articleId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
  }
}
