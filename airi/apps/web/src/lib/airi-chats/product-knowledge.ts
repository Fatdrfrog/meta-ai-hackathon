import { awaitWithCancellation, throwIfCancelled } from "@/lib/ai/cancellation";
import "server-only";

import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { KNOWLEDGE_CHUNK_VISIBILITY } from "@/lib/airi/rag/knowledge/knowledge-search-permissions";
import {
  retrieveWorkspaceKbArticleSources,
  type WorkspaceKnowledgeSource,
} from "@/lib/airi/rag/workspace-knowledge";
import { AIRI_PRODUCT_KB_COMPANY_SLUG } from "@/lib/airi-product-context";
import { getPublicKBWorkspaceIds } from "@/lib/kb/public-kb";
import { logger } from "@/lib/logger";

export { AIRI_PRODUCT_KB_COMPANY_SLUG };

const PRODUCT_KB_ARTICLE_LIMIT = 3;
const PRODUCT_KB_CONTENT_SLICE = 2400;

export type AiriProductKbArticle = {
  id: string;
  title: string;
  content: string;
  url: string | null;
  relevanceScore: number;
  workspaceId: string;
};

function toProductKbArticle(
  source: WorkspaceKnowledgeSource,
  workspaceId: string
): AiriProductKbArticle {
  return {
    id: source.id,
    title: source.title,
    content: source.content.trim(),
    url: source.url || null,
    relevanceScore: source.relevance_score,
    workspaceId,
  };
}

function dedupeProductKbArticles(
  articles: AiriProductKbArticle[]
): AiriProductKbArticle[] {
  const byId = new Map<string, AiriProductKbArticle>();
  for (const article of articles) {
    if (!article.id) continue;
    const existing = byId.get(article.id);
    if (!existing || article.relevanceScore > existing.relevanceScore) {
      byId.set(article.id, article);
    }
  }
  return [...byId.values()];
}

export async function retrieveAiriProductKbArticles(params: {
  signal?: AbortSignal;
  query: string;
  locale?: string | null;
}): Promise<AiriProductKbArticle[]> {
  throwIfCancelled(params.signal);
  const query = params.query.trim();
  if (query.length < 2) return [];

  let workspaceIds: string[] = [];
  try {
    workspaceIds = await awaitWithCancellation(
      getPublicKBWorkspaceIds(AIRI_PRODUCT_KB_COMPANY_SLUG),
      params.signal
    );
  } catch (error) {
    throwIfCancelled(params.signal, error);
    logger.error("Failed to resolve published airi.chat KB workspaces", {
      error,
      companySlug: AIRI_PRODUCT_KB_COMPANY_SLUG,
    });
    return [];
  }

  if (workspaceIds.length === 0) return [];

  const perWorkspace = await awaitWithCancellation(
    Promise.all(
      workspaceIds.map(async workspaceId => {
        const sources = await awaitWithCancellation(
          retrieveWorkspaceKbArticleSources({
            workspaceId,
            query,
            locale: params.locale?.trim() || "en",
            limit: PRODUCT_KB_ARTICLE_LIMIT,
            threshold: RAG_CONFIG.thresholds.kbAdmissionFloor,
            includeFullContent: true,
            matchAllowedVisibilities: [KNOWLEDGE_CHUNK_VISIBILITY.PUBLIC],
          }),
          params.signal
        );
        return sources.map(source => toProductKbArticle(source, workspaceId));
      })
    ),
    params.signal
  );

  return dedupeProductKbArticles(perWorkspace.flat())
    .sort((left, right) => right.relevanceScore - left.relevanceScore)
    .slice(0, PRODUCT_KB_ARTICLE_LIMIT);
}

export function formatAiriProductKbPromptContext(
  articles: AiriProductKbArticle[]
): string {
  if (articles.length === 0) {
    return [
      "PUBLISHED AIRI.CHAT PRODUCT KB",
      "No matching published airi.chat help articles were retrieved.",
      "Do not invent setup, connection, registration, or onboarding steps.",
      "If the question needs missing how-to detail, say the published help article was not found and point the user to https://www.airi.chat help or support@airi.chat.",
    ].join("\n");
  }

  const blocks = articles.map((article, index) => {
    const location = article.url ? `\nURL: ${article.url}` : "";
    const body = article.content.slice(0, PRODUCT_KB_CONTENT_SLICE);
    const truncated =
      article.content.length > PRODUCT_KB_CONTENT_SLICE ? "..." : "";
    return `### Product KB ${index + 1}: "${article.title}"${location}\nRelevance: ${Math.round(article.relevanceScore * 100)}%\n\n${body}${truncated}`;
  });

  return [
    "PUBLISHED AIRI.CHAT PRODUCT KB",
    "Use only these published help articles plus the product capabilities snapshot for how-to steps.",
    "Do not treat this tenant's empty knowledge base or conversations as a reason to refuse a platform how-to.",
    "Do not use unpublished Airi conversations or internal Airi workspace chats.",
    ...blocks,
  ].join("\n\n");
}
