import { getQueryEmbeddingWithCache } from "@/lib/ai";
import { withWorkspaceTextAiAction } from "@/lib/ai/workspace-ai-policy";
import { runAfterResponse } from "@/lib/after-response-work";
import { buildCacheKey, cache } from "@/lib/cache";
import { fetchArticleURLData, generateArticleURL } from "@/lib/kb/article-url";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS,
  normalizeKnowledgeCanonicalSyncSourceKinds,
} from "@icecore/temporal";
import crypto from "crypto";
import { RetrievalError } from "@/lib/airi/shared/errors";
import { ragLogger } from "@/lib/airi/shared/logger";
import {
  isRagPrepExplicitlyNonSearchable,
  prepareQueryForRagWithLlm,
  type RagQueryPreparation,
} from "@/lib/airi/rag/query/query-cleaner";
import { buildSearchAttempts, tokenizeKBQuery } from "./kb-query";
import { buildKBContentExcerpt, extractKBPlainText } from "./kb-content";
import { isHttpOrHttpsUrl } from "@/lib/airi/rag/http-url-normalize";
import { embeddedSourceUrlsForArticle } from "./kb-source-urls";
import { generateHypotheticalAnswer } from "@/lib/airi/rag/pipeline/hyde";
import { buildKbRetrievalCacheKey } from "./kb-cache";
import { getKBCandidateThreshold } from "./kb-confidence";
import type {
  CanonicalKnowledgeChunkRow,
  KBArticleResult,
  KBRetrievalMethod,
  KBRetrievalOptions,
  KnowledgeCanonicalSourceKind,
} from "./kb-types";
import { queryKnowledgeChunks } from "@/lib/airi/rag/knowledge/knowledge-chunks-retrieval";
import type { KnowledgeSearchPrincipal } from "@/lib/airi/rag/knowledge/knowledge-search-permissions";
import {
  resolveMatchAllowedVisibilities,
  visibilityCacheKeySegment,
} from "@/lib/airi/rag/knowledge/knowledge-search-permissions";
import { fallbackTitleForCanonicalRow } from "@/lib/airi/grounding/evidence-source-labels";
import type { HyDEArtifact } from "@/lib/airi/rag/pipeline/hyde-safety";
import { mergeDedupeKBArticles } from "./kb-ranking";

export type { KBArticleResult } from "./kb-types";

function hashString(str: string): string {
  return crypto.createHash("md5").update(str).digest("hex").substring(0, 16);
}

function formatArticleContent(
  content: string,
  includeFullContent = false,
  query?: string
): string {
  const cleaned = extractKBPlainText(content);

  if (includeFullContent) {
    return cleaned;
  }

  return buildKBContentExcerpt({
    content,
    query,
  });
}

interface RawKBArticleResult {
  id: string;
  title: string;
  raw_content: string;
  distance: number;
  category_title: string | null;
  tags: string[];
  article_url: string;
  workspace_name: string;
}

interface KBVersionRow {
  content_mdx: string | null;
  version: number | null;
}

interface RawKBSearchVectorResult {
  id: string;
  title: string | null;
  workspace_id: string;
  kb_article_versions: KBVersionRow[] | KBVersionRow | null;
}

interface RawIndexedURLResult {
  id: string;
  title: string | null;
  content: string | null;
  content_text?: string | null;
  url: string | null;
  similarity: number | null;
}

interface RawPinnedKBArticleRow {
  id: string;
  title: string | null;
  kb_article_versions: KBVersionRow[] | KBVersionRow | null;
}

const KB_RETRIEVAL_POSITIVE_TTL_SECONDS = 10 * 60;
const KB_RETRIEVAL_NEGATIVE_TTL_SECONDS = 60;
const KB_COMPANY_ID_CACHE_TTL_SECONDS = 60 * 60;
const KB_NO_COMPANY_CACHE_SENTINEL = "__none__";
const DEFAULT_ASSISTANT_KB_SOURCE_KINDS: KnowledgeCanonicalSourceKind[] = [
  ...KNOWLEDGE_CANONICAL_SYNC_SOURCE_KINDS,
];
const PRODUCT_SOURCE_KIND_SET = new Set<string>(
  DEFAULT_ASSISTANT_KB_SOURCE_KINDS
);
const SIBLING_EXPANSION_DOCUMENT_LIMIT = 2;
const SIBLING_EXPANSION_RESULT_LIMIT = 6;

const kbRetrievalInFlight = new Map<string, Promise<KBArticleResult[]>>();

function resolveCanonicalMatchSourceKinds(
  value: KnowledgeCanonicalSourceKind[] | null | undefined
): KnowledgeCanonicalSourceKind[] {
  const normalized = normalizeKnowledgeCanonicalSyncSourceKinds(value);
  return normalized?.length
    ? normalized
    : [...DEFAULT_ASSISTANT_KB_SOURCE_KINDS];
}

function sourceKindsCacheKeySegment(
  sourceKinds: KnowledgeCanonicalSourceKind[]
): string {
  return `sources:${sourceKinds.join(",")}`;
}

function getLatestVersionContent(
  versions: KBVersionRow[] | KBVersionRow | null
): string {
  const list = Array.isArray(versions) ? versions : versions ? [versions] : [];
  if (list.length === 0) return "";

  const latest = [...list].sort(
    (a, b) => (b.version ?? 0) - (a.version ?? 0)
  )[0];

  return latest?.content_mdx || "";
}

function estimateDistanceFromKeywordCoverage(
  queryTokens: string[],
  title: string,
  rawContent: string
): number {
  if (queryTokens.length === 0) return 0.3;

  const haystack = `${title} ${extractKBPlainText(rawContent)}`.toLowerCase();
  let matched = 0;

  for (const token of queryTokens) {
    if (haystack.includes(token.toLowerCase())) {
      matched += 1;
    }
  }

  const coverage = matched / queryTokens.length;

  if (coverage >= 0.8) return 0.26;
  if (coverage >= 0.5) return 0.33;
  return 0.4;
}

function isValidAbsoluteHttpUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false;
  return isHttpOrHttpsUrl(url.trim());
}

function normalizeCanonicalSourceKind(
  raw: string
): KnowledgeCanonicalSourceKind {
  if (raw === "indexed_url") return "indexed_url";
  if (raw === "curated_snippet") return "curated_snippet";
  return "kb_article";
}

/** Aligns with SQL `ORDER BY fused_score, distance`; defensive when RPC order differs. */
function sortCanonicalKnowledgeChunkRows(
  rows: CanonicalKnowledgeChunkRow[]
): CanonicalKnowledgeChunkRow[] {
  return [...rows].sort((a, b) => {
    const fusedB = Number(b.fused_score) || 0;
    const fusedA = Number(a.fused_score) || 0;
    if (fusedB !== fusedA) return fusedB - fusedA;
    const authB = Number(b.authority_score);
    const authA = Number(a.authority_score);
    if (authB !== authA) return authB - authA;
    const tb = b.freshness_at
      ? Date.parse(b.freshness_at)
      : Number.NEGATIVE_INFINITY;
    const ta = a.freshness_at
      ? Date.parse(a.freshness_at)
      : Number.NEGATIVE_INFINITY;
    if (tb !== ta) return tb - ta;
    return Number(a.distance) - Number(b.distance);
  });
}

type KnowledgeDocumentSiblingRow = {
  id: string;
  source_kind: string | null;
  source_record_id: string | null;
  title: string | null;
  canonical_url: string | null;
  locale: string | null;
  authority_score: number | null;
  freshness_at: string | null;
};

type KnowledgeChunkSiblingRow = {
  id: string;
  document_id: string;
  chunk_index: number | null;
  content: string | null;
  locale: string | null;
  authority_score: number | null;
  citation_label: string | null;
  document_title: string | null;
};

function chooseSiblingDocumentIds(
  rows: CanonicalKnowledgeChunkRow[],
  matchSourceKinds: KnowledgeCanonicalSourceKind[]
): string[] {
  const sourceKinds = new Set(matchSourceKinds.map(kind => String(kind)));
  const ids: string[] = [];
  for (const row of sortCanonicalKnowledgeChunkRows(rows)) {
    if (!row.document_id) continue;
    const sourceKind = normalizeCanonicalSourceKind(row.source_kind);
    if (!PRODUCT_SOURCE_KIND_SET.has(sourceKind)) continue;
    if (!sourceKinds.has(sourceKind)) continue;
    if (!ids.includes(row.document_id)) ids.push(row.document_id);
    if (ids.length >= SIBLING_EXPANSION_DOCUMENT_LIMIT) break;
  }
  return ids;
}

function mergeCanonicalSiblingRows(params: {
  rows: CanonicalKnowledgeChunkRow[];
  documents: Map<string, KnowledgeDocumentSiblingRow>;
  chunks: KnowledgeChunkSiblingRow[];
  queryText: string;
}): CanonicalKnowledgeChunkRow[] {
  const existingIds = new Set(params.rows.map(row => row.chunk_id));
  const anchorsByDocument = new Map<string, CanonicalKnowledgeChunkRow>();
  for (const row of sortCanonicalKnowledgeChunkRows(params.rows)) {
    if (!anchorsByDocument.has(row.document_id)) {
      anchorsByDocument.set(row.document_id, row);
    }
  }

  const queryTokens = tokenizeKBQuery(params.queryText);
  const siblings: CanonicalKnowledgeChunkRow[] = [];
  for (const chunk of params.chunks) {
    if (!chunk.id || existingIds.has(chunk.id)) continue;
    const document = params.documents.get(chunk.document_id);
    const anchor = anchorsByDocument.get(chunk.document_id);
    if (!document || !anchor || !chunk.content?.trim()) continue;

    const title =
      chunk.document_title || document.title || anchor.title || null;
    const lexicalDistance = estimateDistanceFromKeywordCoverage(
      queryTokens,
      title || "",
      chunk.content
    );
    const anchorDistance = Number(anchor.distance);
    const anchorFused = Number(anchor.fused_score);
    const distance = Math.max(
      0,
      Math.min(0.99, Math.min(anchorDistance + 0.015, lexicalDistance))
    );
    const fusedScore = Number.isFinite(anchorFused)
      ? anchorFused - Math.max(0, distance - anchorDistance) * 0.1
      : anchor.fused_score;

    siblings.push({
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      chunk_index: Number(chunk.chunk_index) || 0,
      content: chunk.content,
      locale: chunk.locale || document.locale || anchor.locale,
      source_kind: document.source_kind || anchor.source_kind,
      source_record_id:
        document.source_record_id || anchor.source_record_id || "",
      title,
      citation_label: chunk.citation_label || anchor.citation_label || null,
      document_title:
        chunk.document_title || document.title || anchor.document_title || null,
      canonical_url: document.canonical_url || anchor.canonical_url,
      authority_score:
        Number(chunk.authority_score) ||
        Number(document.authority_score) ||
        Number(anchor.authority_score) ||
        0,
      freshness_at: document.freshness_at || anchor.freshness_at,
      distance,
      fused_score: fusedScore,
    });
  }

  return sortCanonicalKnowledgeChunkRows([...params.rows, ...siblings]);
}

async function expandCanonicalRowsWithDocumentSiblings(params: {
  workspaceId: string;
  rows: CanonicalKnowledgeChunkRow[];
  queryText: string;
  matchSourceKinds: KnowledgeCanonicalSourceKind[];
  knowledgeSearchPrincipal?: KnowledgeSearchPrincipal;
  matchAllowedVisibilities?: string[] | null;
}): Promise<CanonicalKnowledgeChunkRow[]> {
  if (params.rows.length === 0) return params.rows;

  const documentIds = chooseSiblingDocumentIds(
    params.rows,
    params.matchSourceKinds
  );
  if (documentIds.length === 0) return params.rows;

  const resolvedVisibilities = resolveMatchAllowedVisibilities({
    knowledgeSearchPrincipal: params.knowledgeSearchPrincipal,
    matchAllowedVisibilities: params.matchAllowedVisibilities,
  });

  try {
    let documentsQuery = supabaseAdmin
      .from("knowledge_documents")
      .select(
        "id, source_kind, source_record_id, title, canonical_url, locale, authority_score, freshness_at"
      )
      .eq("workspace_id", params.workspaceId)
      .in("id", documentIds);

    documentsQuery = documentsQuery.in("source_kind", params.matchSourceKinds);
    if (resolvedVisibilities !== null) {
      documentsQuery = documentsQuery.in("visibility", resolvedVisibilities);
    }

    const { data: documentData, error: documentError } = await documentsQuery;
    if (documentError) {
      ragLogger.retrieval.warn("Knowledge document sibling lookup failed", {
        workspaceId: params.workspaceId,
        documentIds,
        error: documentError.message,
      });
      return params.rows;
    }

    const documents = new Map<string, KnowledgeDocumentSiblingRow>();
    for (const document of (documentData ||
      []) as KnowledgeDocumentSiblingRow[]) {
      if (document.id) documents.set(document.id, document);
    }
    if (documents.size === 0) return params.rows;

    const { data: chunkData, error: chunkError } = await supabaseAdmin
      .from("knowledge_chunks")
      .select(
        "id, document_id, chunk_index, content, locale, authority_score, citation_label, document_title"
      )
      .eq("workspace_id", params.workspaceId)
      .in("document_id", Array.from(documents.keys()))
      .order("document_id", { ascending: true })
      .order("chunk_index", { ascending: true })
      .limit(SIBLING_EXPANSION_RESULT_LIMIT);

    if (chunkError) {
      ragLogger.retrieval.warn("Knowledge chunk sibling lookup failed", {
        workspaceId: params.workspaceId,
        documentIds: Array.from(documents.keys()),
        error: chunkError.message,
      });
      return params.rows;
    }

    return mergeCanonicalSiblingRows({
      rows: params.rows,
      documents,
      chunks: (chunkData || []) as KnowledgeChunkSiblingRow[],
      queryText: params.queryText,
    });
  } catch (error) {
    ragLogger.retrieval.warn("Knowledge sibling expansion failed", {
      workspaceId: params.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return params.rows;
  }
}

async function fetchCanonicalChunksWithLocaleFallback(params: {
  workspaceId: string;
  /** FTS query text (original user retrieval string; not HyDE hypothetical). */
  queryText: string;
  queryEmbedding: number[];
  preferredLocale: string;
  limit: number;
  threshold: number;
  knowledgeSearchPrincipal?: KnowledgeSearchPrincipal;
  matchAllowedVisibilities?: string[] | null;
  matchSourceKinds: KnowledgeCanonicalSourceKind[];
}): Promise<{
  rows: CanonicalKnowledgeChunkRow[];
  usedAllLocalesFallback: boolean;
}> {
  const first = await queryKnowledgeChunks({
    workspaceId: params.workspaceId,
    queryText: params.queryText,
    queryEmbedding: params.queryEmbedding,
    matchCount: params.limit,
    matchThreshold: params.threshold,
    matchLocale: params.preferredLocale || null,
    matchSourceKinds: params.matchSourceKinds,
    knowledgeSearchPrincipal: params.knowledgeSearchPrincipal,
    matchAllowedVisibilities: params.matchAllowedVisibilities,
  });
  if (first.length > 0) {
    const rows =
      params.limit <= 3
        ? await expandCanonicalRowsWithDocumentSiblings({
            workspaceId: params.workspaceId,
            rows: first,
            queryText: params.queryText,
            matchSourceKinds: params.matchSourceKinds,
            knowledgeSearchPrincipal: params.knowledgeSearchPrincipal,
            matchAllowedVisibilities: params.matchAllowedVisibilities,
          })
        : first;
    return {
      rows,
      usedAllLocalesFallback: false,
    };
  }
  if (params.preferredLocale) {
    const second = await queryKnowledgeChunks({
      workspaceId: params.workspaceId,
      queryText: params.queryText,
      queryEmbedding: params.queryEmbedding,
      matchCount: params.limit,
      matchThreshold: params.threshold,
      matchLocale: null,
      matchSourceKinds: params.matchSourceKinds,
      knowledgeSearchPrincipal: params.knowledgeSearchPrincipal,
      matchAllowedVisibilities: params.matchAllowedVisibilities,
    });
    if (second.length > 0) {
      const rows =
        params.limit <= 3
          ? await expandCanonicalRowsWithDocumentSiblings({
              workspaceId: params.workspaceId,
              rows: second,
              queryText: params.queryText,
              matchSourceKinds: params.matchSourceKinds,
              knowledgeSearchPrincipal: params.knowledgeSearchPrincipal,
              matchAllowedVisibilities: params.matchAllowedVisibilities,
            })
          : second;
      return {
        rows,
        usedAllLocalesFallback: true,
      };
    }
  }
  return { rows: [], usedAllLocalesFallback: false };
}

async function mapCanonicalKnowledgeRowsToKBArticles(
  rows: CanonicalKnowledgeChunkRow[],
  options: {
    preferredLocale: string;
    includeFullContent: boolean;
    retrievalQuery: string;
  }
): Promise<KBArticleResult[]> {
  const ordered = sortCanonicalKnowledgeChunkRows(rows);
  const kbIds = [
    ...new Set(
      ordered
        .filter(
          r => normalizeCanonicalSourceKind(r.source_kind) === "kb_article"
        )
        .map(r => r.source_record_id)
        .filter(Boolean)
    ),
  ];
  const urlMap =
    kbIds.length > 0 ? await fetchArticleURLData(kbIds) : new Map();

  return ordered.map(r => {
    const sourceType = normalizeCanonicalSourceKind(r.source_kind);
    const similarity = Math.max(0, Math.min(1, 1 - Number(r.distance)));
    let url: string | undefined;
    let allowAutoLinkEmbedding = false;

    if (sourceType === "kb_article") {
      const urlData = urlMap.get(r.source_record_id);
      const articleUrl =
        urlData && urlData.isPubliclyVisible
          ? generateArticleURL(urlData.companySlug, urlData.articlePath)
          : undefined;
      url = articleUrl;
      allowAutoLinkEmbedding = urlData?.allowAutoLinkEmbedding ?? false;
    } else if (sourceType === "indexed_url") {
      url = isValidAbsoluteHttpUrl(r.canonical_url)
        ? (r.canonical_url as string)
        : undefined;
    }

    const title = fallbackTitleForCanonicalRow(sourceType, r.title);

    const fullContent = formatArticleContent(
      r.content,
      options.includeFullContent,
      options.retrievalQuery
    );
    return {
      id: r.chunk_id,
      sourceRecordId: r.source_record_id,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      citationLabel: r.citation_label || null,
      documentTitle: r.document_title || null,
      title,
      fullContent,
      embeddedSourceUrls: embeddedSourceUrlsForArticle(r.content),
      similarity,
      chunkFusedScore: Number.isFinite(Number(r.fused_score))
        ? Number(r.fused_score)
        : undefined,
      chunkAuthorityScore: Number.isFinite(Number(r.authority_score))
        ? Number(r.authority_score)
        : undefined,
      chunkFreshnessAt: r.freshness_at,
      locale: r.locale || options.preferredLocale,
      tags: [],
      url,
      sourceType,
      retrievalMethod: "knowledge_chunk",
      contextFormat: options.includeFullContent ? "full" : "preview",
      allowAutoLinkEmbedding,
    };
  });
}

function annotateKBArticlesWithHyDE(
  articles: KBArticleResult[],
  hypotheticalAnswer?: string
): KBArticleResult[] {
  if (!hypotheticalAnswer?.trim()) return articles;

  return articles.map(article => ({
    ...article,
    wasHydeApplied: true,
    hydeHypotheticalAnswer: hypotheticalAnswer,
  }));
}

function emitHyDEArtifactsFromKBResults(
  results: KBArticleResult[],
  onHyDEApplied: ((artifact: HyDEArtifact) => void) | undefined,
  queryText: string
): void {
  if (!onHyDEApplied || results.length === 0) return;

  const emitted = new Set<string>();
  for (const result of results) {
    const hypotheticalAnswer = result.hydeHypotheticalAnswer?.trim();
    if (!result.wasHydeApplied || !hypotheticalAnswer) continue;
    const dedupeKey = `${queryText}:${hypotheticalAnswer}`;
    if (emitted.has(dedupeKey)) continue;
    emitted.add(dedupeKey);
    onHyDEApplied({
      source: "kb",
      query: queryText,
      hypotheticalAnswer,
    });
  }
}

async function tryCanonicalHyDEKBArticlesWithMeta(params: {
  workspaceId: string;
  queryText: string;
  preferredLocale: string;
  limit: number;
  threshold: number;
  includeFullContent: boolean;
  enabled: boolean;
  knowledgeSearchPrincipal?: KnowledgeSearchPrincipal;
  matchAllowedVisibilities?: string[] | null;
  matchSourceKinds: KnowledgeCanonicalSourceKind[];
  onHyDEApplied?: (artifact: HyDEArtifact) => void;
  /** Phase 3.3: reuse unified-prep hypothetical instead of a fresh HyDE LLM. */
  seedHypotheticalAnswer?: string;
}): Promise<{
  articles: KBArticleResult[];
  hydeLlmInvoked: boolean;
  hypotheticalAnswer?: string;
}> {
  if (!params.enabled) {
    return { articles: [], hydeLlmInvoked: false };
  }

  try {
    const hydeResult = await generateHypotheticalAnswer(params.queryText, {
      language: params.preferredLocale,
      workspaceId: params.workspaceId,
      seedHypotheticalAnswer: params.seedHypotheticalAnswer,
    });

    if (
      !hydeResult.applied ||
      hydeResult.textForEmbedding === params.queryText
    ) {
      return {
        articles: [],
        hydeLlmInvoked: Boolean(hydeResult.applied),
      };
    }

    const hydeEmbedding = await getQueryEmbeddingWithCache(
      hydeResult.textForEmbedding
    );
    if (!hydeEmbedding) {
      return {
        articles: [],
        hydeLlmInvoked: true,
        hypotheticalAnswer: hydeResult.hypotheticalAnswer,
      };
    }

    const { rows } = await fetchCanonicalChunksWithLocaleFallback({
      workspaceId: params.workspaceId,
      queryText: params.queryText,
      queryEmbedding: hydeEmbedding,
      preferredLocale: params.preferredLocale,
      limit: params.limit,
      threshold: params.threshold,
      knowledgeSearchPrincipal: params.knowledgeSearchPrincipal,
      matchAllowedVisibilities: params.matchAllowedVisibilities,
      matchSourceKinds: params.matchSourceKinds,
    });

    if (rows.length === 0) {
      return { articles: [], hydeLlmInvoked: true };
    }

    const articles = await mapCanonicalKnowledgeRowsToKBArticles(rows, {
      preferredLocale: params.preferredLocale,
      includeFullContent: params.includeFullContent,
      retrievalQuery: params.queryText,
    });

    if (articles.length === 0) {
      return { articles: [], hydeLlmInvoked: true };
    }

    // Emit the HyDE artifact only after HyDE-augmented retrieval has actually
    // contributed KB results. Emitting earlier (before embedding/search) would
    // record a hypothetical answer that never influenced retrieval, which can
    // produce false-positive leakage matches downstream.
    if (hydeResult.hypotheticalAnswer?.trim()) {
      params.onHyDEApplied?.({
        source: "kb",
        query: params.queryText,
        hypotheticalAnswer: hydeResult.hypotheticalAnswer,
      });
    }

    return {
      articles: annotateKBArticlesWithHyDE(
        articles,
        hydeResult.hypotheticalAnswer
      ),
      hydeLlmInvoked: true,
      hypotheticalAnswer: hydeResult.hypotheticalAnswer,
    };
  } catch (error) {
    ragLogger.retrieval.warn("Canonical KB HyDE rescue failed", {
      workspaceId: params.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { articles: [], hydeLlmInvoked: true };
  }
}

async function resolveCompanyIdByWorkspace(
  workspaceId: string
): Promise<string | null> {
  const companyCacheKey = buildCacheKey("kb:workspace-company:v1", [
    workspaceId,
  ]);
  const cachedCompanyId = await cache.get<string>(companyCacheKey);
  if (cachedCompanyId) {
    return cachedCompanyId === KB_NO_COMPANY_CACHE_SENTINEL
      ? null
      : cachedCompanyId;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("workspaces")
      .select("company_id")
      .eq("id", workspaceId)
      .single();

    if (error) {
      ragLogger.retrieval.warn("Failed to resolve company_id from workspace", {
        workspaceId,
        error: error.message,
      });
      await cache.set(
        companyCacheKey,
        KB_NO_COMPANY_CACHE_SENTINEL,
        KB_COMPANY_ID_CACHE_TTL_SECONDS
      );
      return null;
    }

    const companyId =
      (data as { company_id?: string | null })?.company_id || null;
    await cache.set(
      companyCacheKey,
      companyId || KB_NO_COMPANY_CACHE_SENTINEL,
      KB_COMPANY_ID_CACHE_TTL_SECONDS
    );
    return companyId;
  } catch (error) {
    ragLogger.retrieval.warn("Failed to resolve company_id from workspace", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    await cache.set(
      companyCacheKey,
      KB_NO_COMPANY_CACHE_SENTINEL,
      KB_COMPANY_ID_CACHE_TTL_SECONDS
    );
    return null;
  }
}

async function searchIndexedUrlsByEmbedding(
  workspaceId: string,
  queryEmbedding: number[],
  preferredLocale: string,
  limit: number,
  threshold: number,
  includeFullContent = false
): Promise<KBArticleResult[]> {
  const companyId = await resolveCompanyIdByWorkspace(workspaceId);
  if (!companyId) return [];

  // Indexed URL similarity is usually lower than curated KB article similarity.
  // Use a source-appropriate threshold so strong external matches are not dropped.
  const indexedUrlThreshold = Math.max(0.3, threshold - 0.45);

  try {
    const { data, error } = await supabaseAdmin.rpc("match_indexed_urls", {
      query_embedding: queryEmbedding,
      match_threshold: indexedUrlThreshold,
      match_count: limit,
      target_company_id: companyId,
    });

    if (error) {
      ragLogger.retrieval.warn("Indexed URL RPC failed", {
        workspaceId,
        companyId,
        error: error.message,
        rpcFunction: "match_indexed_urls",
      });
      return [];
    }

    const rows = (data || []) as RawIndexedURLResult[];

    return rows
      .filter(r => isValidAbsoluteHttpUrl(r.url))
      .map(r => {
        const similarity = Math.max(0, Math.min(1, r.similarity ?? 0));
        const content = r.content || r.content_text || "";
        const fullContent = formatArticleContent(
          content,
          includeFullContent,
          undefined
        );
        const pageUrl = r.url || undefined;
        return {
          id: r.id,
          title: r.title || "External URL",
          fullContent,
          embeddedSourceUrls: embeddedSourceUrlsForArticle(content),
          similarity,
          locale: preferredLocale,
          tags: [],
          url: pageUrl,
          sourceType: "indexed_url" as const,
          retrievalMethod: "indexed_url" as const,
          contextFormat: includeFullContent ? "full" : "preview",
        };
      });
  } catch (error) {
    ragLogger.retrieval.warn("Indexed URL search failed", {
      workspaceId,
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function searchKBByEmbedding(
  workspaceId: string,
  queryEmbedding: number[],
  queryText: string,
  locale: string | null,
  limit: number,
  threshold: number
): Promise<RawKBArticleResult[]> {
  const distanceThreshold = 1 - threshold;

  try {
    const { data, error } = await supabaseAdmin.rpc("search_kb_articles", {
      query_embedding: queryEmbedding,
      match_workspace: workspaceId,
      match_locale: locale ?? null,
      match_threshold: distanceThreshold,
      match_count: limit,
    });

    if (error) {
      throw new RetrievalError("Supabase RPC error during vector search", {
        workspaceId,
        queryHash: hashString(queryText).substring(0, 8),
        error: error.message,
        rpcFunction: "search_kb_articles_by_embedding",
      });
    }

    return data || [];
  } catch (error) {
    if (error instanceof RetrievalError) {
      throw error;
    }
    throw new RetrievalError("Vector search failed", {
      workspaceId,
      queryHash: hashString(queryText).substring(0, 8),
      originalError: error instanceof Error ? error.message : String(error),
    });
  }
}

async function searchKBBySearchVectorFallback(
  workspaceId: string,
  queryText: string,
  limit: number,
  locale?: string,
  ragQueryPreparation?: RagQueryPreparation
): Promise<RawKBArticleResult[]> {
  const attempts = await buildSearchAttempts(queryText, {
    language: locale,
    ragQueryPreparation,
  });
  const queryTokens = tokenizeKBQuery(queryText);

  if (attempts.length === 0) return [];

  const merged = new Map<string, RawKBArticleResult>();

  for (const attempt of attempts) {
    const { data, error } = await supabaseAdmin
      .from("kb_articles")
      .select(
        `
        id,
        title,
        workspace_id,
        kb_article_versions(
          content_mdx,
          version
        )
      `
      )
      .eq("workspace_id", workspaceId)
      .eq("status", "published")
      .textSearch("search_vector", attempt, { type: "plain" })
      .limit(limit);

    if (error) {
      ragLogger.retrieval.warn("search_vector text fallback failed", {
        workspaceId,
        attempt,
        error: error.message,
      });
      continue;
    }

    const rows = (data || []) as RawKBSearchVectorResult[];

    for (const row of rows) {
      if (merged.has(row.id)) continue;

      const rawContent = getLatestVersionContent(row.kb_article_versions);
      const title = row.title || "Untitled";

      merged.set(row.id, {
        id: row.id,
        title,
        raw_content: rawContent,
        distance: estimateDistanceFromKeywordCoverage(
          queryTokens,
          title,
          rawContent
        ),
        category_title: null,
        tags: [],
        article_url: "",
        workspace_name: row.workspace_id,
      });
    }

    if (merged.size >= limit) break;
  }

  return Array.from(merged.values()).slice(0, limit);
}

async function searchKBByHyDERescue(params: {
  workspaceId: string;
  queryText: string;
  preferredLocale: string;
  limit: number;
  threshold: number;
  enabled: boolean;
  onHyDEApplied?: (artifact: HyDEArtifact) => void;
  /** Phase 3.3: reuse unified-prep hypothetical instead of a fresh HyDE LLM. */
  seedHypotheticalAnswer?: string;
}): Promise<{
  results: RawKBArticleResult[];
  applied: boolean;
  hypotheticalAnswer?: string;
}> {
  if (!params.enabled) {
    return {
      results: [],
      applied: false,
    };
  }

  try {
    const hydeResult = await generateHypotheticalAnswer(params.queryText, {
      language: params.preferredLocale,
      workspaceId: params.workspaceId,
      seedHypotheticalAnswer: params.seedHypotheticalAnswer,
    });

    if (
      !hydeResult.applied ||
      hydeResult.textForEmbedding === params.queryText
    ) {
      return {
        results: [],
        applied: false,
      };
    }

    const hydeEmbedding = await getQueryEmbeddingWithCache(
      hydeResult.textForEmbedding
    );
    if (!hydeEmbedding) {
      return {
        results: [],
        applied: hydeResult.applied,
        hypotheticalAnswer: hydeResult.hypotheticalAnswer,
      };
    }

    const results = await searchKBByEmbedding(
      params.workspaceId,
      hydeEmbedding,
      params.queryText,
      params.preferredLocale,
      params.limit,
      params.threshold
    );

    // Emit the HyDE artifact only after the HyDE-augmented search actually
    // returned results. Otherwise downstream leakage checks would match the
    // final reply against a hypothetical answer that never influenced
    // retrieval, producing false-positive leakage blocks.
    if (results.length > 0 && hydeResult.hypotheticalAnswer?.trim()) {
      params.onHyDEApplied?.({
        source: "kb",
        query: params.queryText,
        hypotheticalAnswer: hydeResult.hypotheticalAnswer,
      });
    }

    return {
      results,
      applied: hydeResult.applied,
      hypotheticalAnswer: hydeResult.hypotheticalAnswer,
    };
  } catch (error) {
    ragLogger.retrieval.warn("KB HyDE rescue failed", {
      workspaceId: params.workspaceId,
      queryPreview: params.queryText.substring(0, 80),
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      results: [],
      applied: true,
    };
  }
}

async function filterPublishedKBResults(
  workspaceId: string,
  results: RawKBArticleResult[]
): Promise<RawKBArticleResult[]> {
  if (results.length === 0) return results;

  const candidateIds = Array.from(
    new Set(results.map(result => result.id).filter(Boolean))
  );

  if (candidateIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("kb_articles")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .in("id", candidateIds);

  if (error) {
    ragLogger.retrieval.warn("Failed to validate KB article visibility", {
      workspaceId,
      candidateCount: candidateIds.length,
      error: error.message,
    });
    // Fail closed to prevent stale/deleted rows from being used in RAG.
    return [];
  }

  const visibleIdSet = new Set((data || []).map(row => String(row.id)));
  return results.filter(result => visibleIdSet.has(String(result.id)));
}

// kb_articles ids are UUIDs. A pinned id of another shape (a 24-hex Mongo id)
// fails the whole `in` filter, which used to drop every pinned article.
const KB_ARTICLE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function retrievePinnedKBArticles(
  workspaceId: string,
  articleIds: string[],
  preferredLocale: string = "en",
  options: Pick<KBRetrievalOptions, "includeFullContent" | "limit"> = {}
): Promise<KBArticleResult[]> {
  const normalizedIds = Array.from(
    new Set(
      articleIds
        .map(id => String(id || "").trim())
        .filter(id => KB_ARTICLE_ID_PATTERN.test(id))
    )
  ).slice(0, Math.max(1, options.limit || 5));

  if (!workspaceId || normalizedIds.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("kb_articles")
    .select(
      `
      id,
      title,
      kb_article_versions(
        content_mdx,
        version
      )
    `
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .in("id", normalizedIds);

  if (error) {
    ragLogger.retrieval.warn("Failed to load pinned KB articles", {
      workspaceId,
      articleIds: normalizedIds,
      error: error.message,
    });
    return [];
  }

  const rows = (data || []) as RawPinnedKBArticleRow[];
  if (rows.length === 0) {
    return [];
  }

  const urlDataMap = await fetchArticleURLData(rows.map(row => row.id));

  return rows.map(row => {
    const rawContent = getLatestVersionContent(row.kb_article_versions);
    const urlData = urlDataMap.get(row.id);
    const articleUrl =
      urlData && urlData.isPubliclyVisible
        ? generateArticleURL(urlData.companySlug, urlData.articlePath)
        : undefined;

    const fullContent = formatArticleContent(
      rawContent,
      options.includeFullContent || false,
      undefined
    );
    return {
      id: row.id,
      sourceRecordId: row.id,
      title: row.title || "Untitled",
      fullContent,
      embeddedSourceUrls: embeddedSourceUrlsForArticle(rawContent),
      similarity: 0.84,
      locale: preferredLocale,
      tags: [],
      url: articleUrl,
      sourceType: "kb_article",
      retrievalMethod: "pinned",
      contextFormat: options.includeFullContent ? "full" : "preview",
      allowAutoLinkEmbedding: urlData?.allowAutoLinkEmbedding ?? false,
    };
  });
}

export async function retrieveRelevantKBArticles(
  workspaceId: string,
  query: string,
  preferredLocale: string = "en",
  options: KBRetrievalOptions = {}
): Promise<KBArticleResult[]> {
  if (!workspaceId || !query || query.trim().length < 4) {
    ragLogger.retrieval.warn("KB retrieval aborted due to invalid input", {
      workspaceId,
      queryLength: query?.length,
    });
    return [];
  }

  return withWorkspaceTextAiAction(
    { workspaceId, actionId: `kb-retrieval:${crypto.randomUUID()}` },
    () =>
      retrieveRelevantKBArticlesInAction(
        workspaceId,
        query,
        preferredLocale,
        options
      )
  );
}

async function retrieveRelevantKBArticlesInAction(
  workspaceId: string,
  query: string,
  preferredLocale: string,
  options: KBRetrievalOptions
): Promise<KBArticleResult[]> {
  const prep =
    options.ragQueryPreparation ??
    (await prepareQueryForRagWithLlm(query, {
      language: preferredLocale,
      workspaceId,
    }));
  if (isRagPrepExplicitlyNonSearchable(prep)) {
    return [];
  }
  const cleanedQuery = prep.cleanedQuery;
  const wasCleaned = prep.wasCleaned;
  const retrievalQuery =
    cleanedQuery && cleanedQuery.trim().length >= 4
      ? cleanedQuery.trim()
      : query.trim();

  const {
    limit = 5,
    threshold = 0.75,
    includeFullContent = false,
    queryEmbedding: prefetchEmbedding,
    enableHyDERescue = true,
    hydeRecommended,
    onHyDEApplied,
    knowledgeSearchPrincipal,
    matchAllowedVisibilities,
    matchSourceKinds: requestedMatchSourceKinds,
  } = options;
  const matchSourceKinds = resolveCanonicalMatchSourceKinds(
    requestedMatchSourceKinds
  );
  const effectiveHyDERescue = enableHyDERescue && hydeRecommended !== false;
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const normalizedThreshold = Number.isFinite(threshold)
    ? Number(threshold.toFixed(3))
    : 0.75;
  const candidateThreshold = getKBCandidateThreshold(normalizedThreshold);

  const resolvedVisibilityForCache = resolveMatchAllowedVisibilities({
    knowledgeSearchPrincipal,
    matchAllowedVisibilities,
  });
  const visibilitySegment = visibilityCacheKeySegment(
    resolvedVisibilityForCache
  );
  const sourceKindsSegment = sourceKindsCacheKeySegment(matchSourceKinds);

  const retrievalCacheKey = buildKbRetrievalCacheKey([
    workspaceId,
    hashString(retrievalQuery),
    preferredLocale,
    String(normalizedLimit),
    String(normalizedThreshold),
    includeFullContent ? "full" : "preview",
    effectiveHyDERescue ? "hyde" : "no-hyde",
    visibilitySegment,
    sourceKindsSegment,
  ]);

  const cached = await cache.get<KBArticleResult[]>(retrievalCacheKey);
  if (cached !== null) {
    emitHyDEArtifactsFromKBResults(cached, onHyDEApplied, retrievalQuery);
    ragLogger.retrieval.info("KB retrieval cache hit", {
      workspaceId,
      queryHash: hashString(retrievalQuery),
      resultCount: cached.length,
      cacheType: cached.length > 0 ? "positive" : "negative",
      preferredLocale,
    });
    return cached;
  }

  const inFlight = kbRetrievalInFlight.get(retrievalCacheKey);
  if (inFlight) {
    const results = await inFlight;
    emitHyDEArtifactsFromKBResults(results, onHyDEApplied, retrievalQuery);
    return results;
  }

  const queryHash = hashString(retrievalQuery);
  const queryPreview =
    retrievalQuery.length > 100
      ? retrievalQuery.substring(0, 100) + "..."
      : retrievalQuery;

  const retrievalPromise = (async (): Promise<KBArticleResult[]> => {
    const queryEmbedding =
      prefetchEmbedding || (await getQueryEmbeddingWithCache(retrievalQuery));

    if (!queryEmbedding) {
      ragLogger.retrieval.warn(
        "KB retrieval missing embedding, using lexical fallback",
        {
          workspaceId,
          queryPreview: retrievalQuery.substring(0, 50),
          queryLength: retrievalQuery.length,
          preferredLocale,
        }
      );
    }

    const canRunVectorSearch = !!queryEmbedding;

    if (canRunVectorSearch) {
      ragLogger.retrieval.info("KB retrieval started", {
        workspaceId,
        workspaceIsolation: "enforced via match_workspace in RPC",
        queryHash,
        queryPreview,
        originalQueryPreview: wasCleaned ? query.slice(0, 100) : undefined,
        wasCleaned,
        queryLength: retrievalQuery.length,
        preferredLocale,
        threshold: normalizedThreshold,
        candidateThreshold,
        limit: normalizedLimit,
      });
    }

    let canonicalPathUsed = false;
    let knowledgeChunkHydeUsed = false;
    let knowledgeChunkAllLocalesFallback = false;
    let formattedKBArticlesFromCanonical: KBArticleResult[] = [];

    if (canRunVectorSearch) {
      const { rows, usedAllLocalesFallback } =
        await fetchCanonicalChunksWithLocaleFallback({
          workspaceId,
          queryText: retrievalQuery,
          queryEmbedding: queryEmbedding as number[],
          preferredLocale,
          limit: normalizedLimit,
          threshold: candidateThreshold,
          knowledgeSearchPrincipal,
          matchAllowedVisibilities,
          matchSourceKinds,
        });
      knowledgeChunkAllLocalesFallback = usedAllLocalesFallback;

      if (rows.length > 0) {
        canonicalPathUsed = true;
        formattedKBArticlesFromCanonical =
          await mapCanonicalKnowledgeRowsToKBArticles(rows, {
            preferredLocale,
            includeFullContent,
            retrievalQuery,
          });
        ragLogger.retrieval.info(
          "KB retrieval used canonical knowledge_chunks",
          {
            workspaceId,
            queryHash,
            hits: rows.length,
            allLocalesFallback: usedAllLocalesFallback,
          }
        );
      }
    }

    let suppressLegacyHyDE = false;
    if (canRunVectorSearch && !canonicalPathUsed && effectiveHyDERescue) {
      const { articles, hydeLlmInvoked } =
        await tryCanonicalHyDEKBArticlesWithMeta({
          workspaceId,
          queryText: retrievalQuery,
          preferredLocale,
          limit: normalizedLimit,
          threshold: candidateThreshold,
          includeFullContent,
          enabled: effectiveHyDERescue,
          knowledgeSearchPrincipal,
          matchAllowedVisibilities,
          matchSourceKinds,
          onHyDEApplied,
          // Phase 3.3: unified-prep seed short-circuits the HyDE LLM.
          seedHypotheticalAnswer: prep.hypotheticalAnswer,
        });
      suppressLegacyHyDE = hydeLlmInvoked;
      if (articles.length > 0) {
        canonicalPathUsed = true;
        knowledgeChunkHydeUsed = true;
        formattedKBArticlesFromCanonical = articles;
        ragLogger.retrieval.info(
          "KB retrieval used canonical knowledge_chunks (HyDE)",
          {
            workspaceId,
            queryHash,
            hits: articles.length,
          }
        );
      }
    }

    const indexedURLPromise =
      canRunVectorSearch && !canonicalPathUsed
        ? searchIndexedUrlsByEmbedding(
            workspaceId,
            queryEmbedding as number[],
            preferredLocale,
            normalizedLimit,
            candidateThreshold,
            includeFullContent
          ).catch(error => {
            ragLogger.retrieval.warn("Indexed URL search promise failed", {
              workspaceId,
              queryHash,
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          })
        : Promise.resolve<KBArticleResult[]>([]);

    let results: RawKBArticleResult[] = [];
    let vectorAllLocalesFallbackUsed = false;
    let searchVectorFallbackUsed = false;
    let hydeRescueUsed = false;
    let hydeRescueHypotheticalAnswer: string | undefined;
    let formattedKBArticles: KBArticleResult[] = [];
    let indexedURLArticles: KBArticleResult[] = [];

    if (canonicalPathUsed) {
      formattedKBArticles = formattedKBArticlesFromCanonical;
    } else {
      if (canRunVectorSearch) {
        try {
          results = await searchKBByEmbedding(
            workspaceId,
            queryEmbedding as number[],
            retrievalQuery,
            preferredLocale,
            normalizedLimit,
            candidateThreshold
          );
        } catch (error) {
          if (error instanceof RetrievalError) {
            ragLogger.retrieval.warn(
              "KB vector retrieval failed, continuing with fallbacks",
              {
                workspaceId,
                queryHash,
                queryPreview,
                preferredLocale,
                ...error.context,
              }
            );
          } else {
            ragLogger.retrieval.warn(
              "KB vector retrieval failed, continuing with fallbacks",
              {
                workspaceId,
                queryHash,
                queryPreview,
                preferredLocale,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

        if (results.length === 0 && preferredLocale) {
          try {
            results = await searchKBByEmbedding(
              workspaceId,
              queryEmbedding as number[],
              retrievalQuery,
              null,
              normalizedLimit,
              candidateThreshold
            );

            if (results.length > 0) {
              vectorAllLocalesFallbackUsed = true;
              ragLogger.retrieval.info(
                "KB vector retrieval recovered results across all locales",
                {
                  workspaceId,
                  queryHash,
                  queryPreview,
                  preferredLocale,
                  resultsFound: results.length,
                  topArticleTitle: results[0]?.title,
                  topDistance: results[0]?.distance,
                }
              );
            }
          } catch (error) {
            if (error instanceof RetrievalError) {
              ragLogger.retrieval.warn(
                "KB all-locales vector retrieval failed, continuing with lexical fallbacks",
                {
                  workspaceId,
                  queryHash,
                  queryPreview,
                  preferredLocale,
                  ...error.context,
                }
              );
            } else {
              ragLogger.retrieval.warn(
                "KB all-locales vector retrieval failed, continuing with lexical fallbacks",
                {
                  workspaceId,
                  queryHash,
                  queryPreview,
                  preferredLocale,
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }
        }
      }

      if (results.length === 0) {
        ragLogger.retrieval.debug(
          "KB vector candidate search returned no results, continuing with lexical fallbacks",
          {
            workspaceId,
            queryHash,
            preferredLocale,
            threshold: normalizedThreshold,
            candidateThreshold,
            allLocalesRetried: canRunVectorSearch && Boolean(preferredLocale),
          }
        );
      }

      if (results.length === 0) {
        results = await searchKBBySearchVectorFallback(
          workspaceId,
          retrievalQuery,
          normalizedLimit,
          preferredLocale,
          prep
        );
        searchVectorFallbackUsed = results.length > 0;

        if (searchVectorFallbackUsed) {
          ragLogger.retrieval.info(
            "KB search_vector text fallback found results",
            {
              workspaceId,
              queryHash,
              resultsFound: results.length,
              topArticleTitle: results[0]?.title,
              topDistance: results[0]?.distance,
            }
          );
        }

        if (results.length === 0 && canRunVectorSearch) {
          const hydeRescue = await searchKBByHyDERescue({
            workspaceId,
            queryText: retrievalQuery,
            preferredLocale,
            limit: normalizedLimit,
            threshold: normalizedThreshold,
            enabled: effectiveHyDERescue && !suppressLegacyHyDE,
            onHyDEApplied,
            // Phase 3.3: unified-prep seed short-circuits the HyDE LLM.
            seedHypotheticalAnswer: prep.hypotheticalAnswer,
          });

          if (hydeRescue.results.length > 0) {
            results = hydeRescue.results;
            hydeRescueUsed = true;
            hydeRescueHypotheticalAnswer = hydeRescue.hypotheticalAnswer;

            ragLogger.retrieval.info("KB HyDE rescue found results", {
              workspaceId,
              queryHash,
              queryPreview,
              resultsFound: results.length,
              topArticleTitle: results[0]?.title,
              topDistance: results[0]?.distance,
              hypotheticalAnswerPreview: hydeRescue.hypotheticalAnswer?.slice(
                0,
                120
              ),
            });
          } else if (hydeRescue.applied) {
            ragLogger.retrieval.debug("KB HyDE rescue produced no matches", {
              workspaceId,
              queryHash,
              queryPreview,
            });
          }
        }
      }

      const resultsBeforeVisibilityFilter = results.length;
      results = await filterPublishedKBResults(workspaceId, results);
      if (resultsBeforeVisibilityFilter !== results.length) {
        ragLogger.retrieval.warn("Dropped stale or non-published KB matches", {
          workspaceId,
          queryHash,
          before: resultsBeforeVisibilityFilter,
          after: results.length,
        });
      }

      const articleIds = results.map(r => r.id);
      const [urlDataMap, indexedUrlRows] = await Promise.all([
        fetchArticleURLData(articleIds),
        indexedURLPromise,
      ]);
      indexedURLArticles = indexedUrlRows;

      const kbRetrievalMethod: KBRetrievalMethod = searchVectorFallbackUsed
        ? "search_vector"
        : hydeRescueUsed
          ? "hyde_vector"
          : "vector";

      formattedKBArticles = results.map(r => {
        const urlData = urlDataMap.get(r.id);
        const articleUrl =
          urlData && urlData.isPubliclyVisible
            ? generateArticleURL(urlData.companySlug, urlData.articlePath)
            : undefined;

        const distance = r.distance;

        const rawContent = r.raw_content || "";
        const fullContent = formatArticleContent(
          rawContent,
          includeFullContent,
          retrievalQuery
        );
        return {
          id: r.id,
          title: r.title || "Untitled",
          fullContent,
          embeddedSourceUrls: embeddedSourceUrlsForArticle(rawContent),
          similarity: 1 - distance,
          locale: preferredLocale,
          tags: r.tags || [],
          url: articleUrl,
          sourceType: "kb_article" as const,
          retrievalMethod: kbRetrievalMethod,
          contextFormat: includeFullContent ? "full" : "preview",
          allowAutoLinkEmbedding: urlData?.allowAutoLinkEmbedding ?? false,
        };
      });
      if (hydeRescueUsed) {
        formattedKBArticles = annotateKBArticlesWithHyDE(
          formattedKBArticles,
          hydeRescueHypotheticalAnswer
        );
      }
    }

    const canonicalResultLimit =
      canonicalPathUsed && formattedKBArticles.length > normalizedLimit
        ? Math.min(
            formattedKBArticles.length,
            normalizedLimit + 2,
            SIBLING_EXPANSION_RESULT_LIMIT
          )
        : normalizedLimit;
    const formatted = canonicalPathUsed
      ? mergeDedupeKBArticles(formattedKBArticles, canonicalResultLimit)
      : mergeDedupeKBArticles(
          [...formattedKBArticles, ...indexedURLArticles],
          normalizedLimit
        );

    const topSimilarity = formatted.length > 0 ? formatted[0].similarity : null;
    const articlesAboveThreshold = formatted.filter(
      a => a.similarity >= normalizedThreshold
    ).length;
    const searchMethod = canonicalPathUsed
      ? knowledgeChunkHydeUsed
        ? "KNOWLEDGE_CHUNK_HYDE"
        : knowledgeChunkAllLocalesFallback
          ? "KNOWLEDGE_CHUNK_ALL_LOCALES"
          : "KNOWLEDGE_CHUNK"
      : searchVectorFallbackUsed
        ? "SEARCH_VECTOR_TEXT_FALLBACK"
        : hydeRescueUsed
          ? "HYDE_VECTOR_RESCUE"
          : vectorAllLocalesFallbackUsed
            ? "VECTOR_ALL_LOCALES_FALLBACK"
            : "VECTOR";
    const effectiveSearchMethod =
      !canonicalPathUsed && indexedURLArticles.length > 0
        ? `${searchMethod}+INDEXED_URLS`
        : searchMethod;

    ragLogger.retrieval.info("KB retrieval completed", {
      workspaceId,
      workspaceIsolation: "verified - all results filtered by workspaceId",
      queryHash,
      queryPreview,
      preferredLocale,
      threshold: normalizedThreshold,
      candidateThreshold,
      searchMethod: effectiveSearchMethod,
      resultsFound: formatted.length,
      kbArticleResults: formattedKBArticles.length,
      indexedURLResults: indexedURLArticles.length,
      sourceKinds: matchSourceKinds,
      articlesAboveThreshold,
      topSimilarity: topSimilarity
        ? Math.round(topSimilarity * 100) / 100
        : null,
      topArticleId: formatted[0]?.id || null,
      topArticleTitle: formatted[0]?.title || null,
      similarityScores: formatted.map(a => ({
        articleId: a.id,
        title: a.title,
        similarity: Math.round(a.similarity * 100) / 100,
        meetsThreshold: a.similarity >= normalizedThreshold,
        source: a.sourceType || "kb_article",
        retrievalMethod: a.retrievalMethod || null,
        url: a.url || null,
      })),
      cacheTtlSeconds:
        formatted.length > 0
          ? KB_RETRIEVAL_POSITIVE_TTL_SECONDS
          : KB_RETRIEVAL_NEGATIVE_TTL_SECONDS,
    });

    const cacheTtlSeconds =
      formatted.length > 0
        ? KB_RETRIEVAL_POSITIVE_TTL_SECONDS
        : KB_RETRIEVAL_NEGATIVE_TTL_SECONDS;
    // An Upstash round trip (about 180 ms from the worker) the reply does
    // not need to wait for.
    runAfterResponse("kb_retrieval_cache", () =>
      cache.set(retrievalCacheKey, formatted, cacheTtlSeconds)
    );

    return formatted;
  })();

  kbRetrievalInFlight.set(retrievalCacheKey, retrievalPromise);
  try {
    return await retrievalPromise;
  } finally {
    kbRetrievalInFlight.delete(retrievalCacheKey);
  }
}
