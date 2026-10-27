import { retrieveRelevantKBArticles } from "@/lib/airi/rag/kb/kb-retrieval";
import type { KnowledgeCanonicalSourceKind } from "@/lib/airi/rag/kb/kb-types";
import { buildHeuristicRagQueryPreparation } from "@/lib/airi/rag/query/query-cleaner";
import type { GatewayKnowledgeSource } from "@icecore/airi-runtime/ai-gateway";
import { logger } from "@icecore/shared/lib/logger";

const WORKSPACE_KNOWLEDGE_THRESHOLD = 0.72;

export type WorkspaceKnowledgeSource = GatewayKnowledgeSource;

export type WorkspaceKnowledgeRetrievalParams = {
  workspaceId: string;
  query: string;
  limit?: number;
  locale?: string;
  threshold?: number;
  includeFullContent?: boolean;
  sourceKinds?: KnowledgeCanonicalSourceKind[];
  matchAllowedVisibilities?: string[] | null;
};

function normalizeLimit(value: number | null | undefined, fallback: number) {
  return Math.max(1, Math.floor(Number(value || fallback)));
}

function toGatewayKnowledgeSource(
  article: Awaited<ReturnType<typeof retrieveRelevantKBArticles>>[number]
): WorkspaceKnowledgeSource {
  const sourceType =
    article.sourceType === "indexed_url" ? "external_url" : "article";

  return {
    id: article.sourceRecordId || article.id,
    title: article.title,
    content: article.fullContent || "",
    relevance_score: article.similarity,
    source_type: sourceType,
    url: article.url,
  };
}

export async function retrieveWorkspaceKnowledgeSources(
  params: WorkspaceKnowledgeRetrievalParams
): Promise<WorkspaceKnowledgeSource[]> {
  const query = String(params.query || "").trim();
  if (!params.workspaceId || query.length < 2) return [];

  try {
    const articles = await retrieveRelevantKBArticles(
      params.workspaceId,
      query,
      params.locale || "en",
      {
        limit: normalizeLimit(params.limit, 3),
        threshold: params.threshold ?? WORKSPACE_KNOWLEDGE_THRESHOLD,
        includeFullContent: params.includeFullContent ?? false,
        enableHyDERescue: false,
        ragQueryPreparation: buildHeuristicRagQueryPreparation(query),
        matchSourceKinds:
          params.sourceKinds && params.sourceKinds.length > 0
            ? params.sourceKinds
            : ["kb_article", "indexed_url", "curated_snippet"],
        ...(params.matchAllowedVisibilities
          ? { matchAllowedVisibilities: params.matchAllowedVisibilities }
          : {}),
      }
    );

    return articles.map(toGatewayKnowledgeSource);
  } catch (error) {
    logger.error("Workspace knowledge retrieval failed", {
      workspaceId: params.workspaceId,
      sourceKinds: params.sourceKinds,
      error,
    });
    return [];
  }
}

export function retrieveWorkspaceKbArticleSources(params: {
  workspaceId: string;
  query: string;
  limit?: number;
  locale?: string;
  threshold?: number;
  includeFullContent?: boolean;
  matchAllowedVisibilities?: string[] | null;
}): Promise<WorkspaceKnowledgeSource[]> {
  return retrieveWorkspaceKnowledgeSources({
    ...params,
    sourceKinds: ["kb_article"],
  });
}

export function retrieveWorkspaceIndexedUrlSources(params: {
  workspaceId: string;
  query: string;
  limit?: number;
  locale?: string;
}): Promise<WorkspaceKnowledgeSource[]> {
  return retrieveWorkspaceKnowledgeSources({
    ...params,
    sourceKinds: ["indexed_url"],
  });
}
