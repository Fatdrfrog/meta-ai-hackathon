import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
/**
 * Reranking: prefer Vertex AI Search [Ranking API](https://docs.cloud.google.com/generative-ai-app-builder/docs/ranking)
 * (stateless; no RAG Engine required) when `VERTEX_RANKING_API=1`, else LLM JSON scores via the
 * platform text provider (light tier, `chatCompletionWithFallback`). Scoring a handful of
 * candidates is a light-model task; the heavy tier took 2.3–3.3 s of every reply.
 *
 * @see https://cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/projects.locations.rankingConfigs/rank
 */

import {
  chatCompletionWithFallback,
  formatScore,
  getLightTextModel,
  getStructuredJsonGenerationConfig,
  truncateText,
} from "@/lib/ai";
import { extractJsonObject } from "@/lib/ai/json-object";
import { rankRecordsWithVertexRankingApi } from "@/lib/ai/vertex-ranking-api";
import { canUseTextAI } from "@/lib/ai/text-provider-config";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { ragLogger } from "@/lib/airi/shared/logger";

export interface RerankDocument {
  text: string;
  id?: string;
  metadata?: Record<string, unknown>;
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
  document?: RerankDocument;
}

export interface RerankResponse {
  results: RerankResult[];
  meta?: {
    billedUnits?: number;
  };
}

const RERANK_MAX_DOC_CHARS = 1400;
/** Align with `vertex-ranking-api` + semantic-ranker-default-004 (~1024 tokens title+content). */
const RERANK_VERTEX_RANKING_MAX_CONTENT_CHARS = 3500;

function normalizeDocumentText(text: string): string {
  return truncateText(text.replace(/\s+/g, " ").trim(), RERANK_MAX_DOC_CHARS);
}

function normalizeDocumentTextForVertexRankingApi(text: string): string {
  return truncateText(
    text.replace(/\s+/g, " ").trim(),
    RERANK_VERTEX_RANKING_MAX_CONTENT_CHARS
  );
}

function buildRerankPrompt(
  query: string,
  documents: RerankDocument[],
  topN: number
): string {
  const serializedDocs = documents
    .map((document, index) => {
      const body = normalizeDocumentText(document.text);
      return `Document ${index}:\n${body}`;
    })
    .join("\n\n");

  return `User query:
${query}

Candidates:
${serializedDocs}

Rules:
- Return up to ${topN} candidates
- "index" must reference the original candidate index
- "score" must be a number from 0 to 1
- Rank by how directly the candidate answers the query
- Penalize greetings, intros, unrelated products/services, and generic marketing copy
- Prefer the candidate that best answers the customer right now
- Follow the provided response schema`;
}

function extractJsonFromLlmOutput(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Extract the first complete JSON object if there's preamble text
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    text = text.slice(jsonStart, jsonEnd + 1);
  } else if (jsonStart >= 0) {
    text = text.slice(jsonStart);
  }

  if (text.startsWith("{")) {
    text = repairTruncatedJson(text);
  }

  return text;
}

function repairTruncatedJson(text: string): string {
  let repaired = text.trim();
  let openObjects = 0;
  let openArrays = 0;
  let inString = false;
  let isEscaped = false;

  for (const ch of repaired) {
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (ch === "\\") {
        isEscaped = true;
        continue;
      }

      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      openObjects += 1;
      continue;
    }

    if (ch === "}") {
      openObjects = Math.max(0, openObjects - 1);
      continue;
    }

    if (ch === "[") {
      openArrays += 1;
      continue;
    }

    if (ch === "]") {
      openArrays = Math.max(0, openArrays - 1);
    }
  }

  if (inString) {
    repaired += '"';
  }

  if (openArrays > 0) {
    repaired += "]".repeat(openArrays);
  }

  if (openObjects > 0) {
    repaired += "}".repeat(openObjects);
  }

  return repaired;
}

function parseRerankResponse(
  content: string,
  documents: RerankDocument[],
  topN: number
): RerankResult[] {
  const jsonContent = extractJsonFromLlmOutput(content);
  const parsed = extractJsonObject(jsonContent) as {
    results?: Array<{
      index?: number;
      score?: number;
      relevanceScore?: number;
    }>;
  };

  if (!Array.isArray(parsed.results)) {
    return [];
  }

  const seen = new Set<number>();
  const normalized: RerankResult[] = [];

  for (const item of parsed.results) {
    const index = Number(item.index);
    const score = Number(item.score ?? item.relevanceScore);

    if (!Number.isInteger(index)) continue;
    if (index < 0 || index >= documents.length) continue;
    if (!Number.isFinite(score)) continue;
    if (seen.has(index)) continue;

    seen.add(index);
    normalized.push({
      index,
      relevanceScore: Math.min(Math.max(score, 0), 1),
      document: documents[index],
    });
  }

  return normalized
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topN);
}

function mapVertexRankingToResults(
  ranked: Array<{ id: string; score: number }>,
  documents: RerankDocument[],
  topN: number
): RerankResult[] {
  const out: RerankResult[] = [];
  const seen = new Set<number>();
  for (const row of ranked) {
    const idx = Number.parseInt(row.id, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= documents.length) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push({
      index: idx,
      relevanceScore: row.score,
      document: documents[idx],
    });
    if (out.length >= topN) break;
  }
  return out;
}

async function rerankDocumentsWithVertexRankingApi(
  query: string,
  documents: RerankDocument[],
  topN: number,
  startTime: number
): Promise<RerankResponse | null> {
  if (!RAG_CONFIG.reranking.useVertexRankingApi) {
    return null;
  }

  const records = documents.map((d, i) => {
    const body = normalizeDocumentTextForVertexRankingApi(d.text);
    const firstLine = body.split("\n")[0]?.trim() || "";
    return {
      id: String(i),
      title: (firstLine || body).slice(0, 300),
      content: body,
    };
  });

  const ranked = await rankRecordsWithVertexRankingApi({
    query,
    records,
    topN,
  });

  if (!ranked?.length) {
    return null;
  }

  const results = mapVertexRankingToResults(ranked, documents, topN);
  if (results.length === 0) {
    return null;
  }

  const rerankTime = Date.now() - startTime;
  ragLogger.reranker.info("Reranked documents (Vertex ranking API)", {
    provider: "vertex-ranking-api",
    model: RAG_CONFIG.reranking.vertexRankingModel,
    query: truncateText(query, 50),
    inputDocuments: documents.length,
    outputDocuments: results.length,
    topScore: formatScore(results[0]?.relevanceScore),
    rerankTimeMs: rerankTime,
  });

  return { results };
}

function buildRerankResponseSchema(topN: number) {
  return {
    type: "OBJECT",
    properties: {
      results: {
        type: "ARRAY",
        maxItems: topN,
        items: {
          type: "OBJECT",
          properties: {
            index: {
              type: "INTEGER",
              description: "Original zero-based index of the candidate.",
            },
            score: {
              type: "NUMBER",
              description:
                "Relevance score from 0 to 1 for how directly the candidate answers the query.",
            },
          },
          required: ["index", "score"],
          propertyOrdering: ["index", "score"],
        },
      },
    },
    required: ["results"],
    propertyOrdering: ["results"],
  } as const;
}

/**
 * True when the top KB candidate is a clear match on similarity alone, so a
 * reranker call cannot change the answer. Pinned articles carry a fixed
 * similarity and never count as a clear leader.
 */
export function hasClearKbLeader(
  articles: Array<{ similarity: number; retrievalMethod?: string }>
): boolean {
  const [top, next] = [...articles].sort(
    (left, right) => right.similarity - left.similarity
  );
  if (!top || top.retrievalMethod === "pinned") return false;
  const { clearLeaderSimilarity, clearLeaderMargin } = RAG_CONFIG.reranking;
  if (top.similarity < clearLeaderSimilarity) return false;
  return !next || top.similarity - next.similarity >= clearLeaderMargin;
}

/**
 * Rerank documents with the light text model (via chatCompletionWithFallback).
 * A rerank slower than `RAG_CONFIG.reranking.timeoutMs` is dropped and the
 * embedding order stands.
 *
 * @param query - The user's query
 * @param documents - Array of documents to rerank
 * @param topN - Number of top results to return
 */
export async function rerankDocuments(
  query: string,
  documents: RerankDocument[],
  topN: number = 3,
  options?: {
    workspaceId?: string | null;
    conversationId?: string | null;
  }
): Promise<RerankResponse | null> {
  if (!canUseTextAI()) {
    ragLogger.reranker.debug(
      "Text AI not available, skipping rerank (using embedding scores only)"
    );
    return null;
  }

  if (!query || !documents || documents.length === 0) {
    return null;
  }

  const actualTopN = Math.min(topN, documents.length);
  const startTime = Date.now();

  const rankingApiResult = await rerankDocumentsWithVertexRankingApi(
    query,
    documents,
    actualTopN,
    startTime
  );
  if (rankingApiResult) {
    return rankingApiResult;
  }

  const llmStart = Date.now();
  try {
    const model = getLightTextModel();
    const response = await chatCompletionWithFallback({
      model,
      resilience: {
        maxRetries: 0,
        timeoutMs: RAG_CONFIG.reranking.timeoutMs,
      },
      analytics: options?.workspaceId
        ? {
            workspaceId: options.workspaceId,
            conversationId: options.conversationId || null,
            operation: "airi.rag.reranker",
            sourceService: "web.airi.rag",
          }
        : undefined,
      messages: [
        {
          role: "system",
          content: `You rerank customer-support retrieval candidates.

Judge whether each candidate directly answers the customer's query.
The same topic and intent matter more than lexical overlap.
Be strict about unrelated greetings, onboarding messages, or different services.
Output valid JSON only.`,
        },
        {
          role: "user",
          content: buildRerankPrompt(query, documents, actualTopN),
        },
      ],
      temperature: 0,
      generationConfig: {
        ...getStructuredJsonGenerationConfig(model),
        maxOutputTokens: Math.max(512, Math.min(2048, actualTopN * 48 + 192)),
        responseMimeType: "application/json",
        responseSchema: buildRerankResponseSchema(actualTopN),
      },
    });

    const content = (response.content || "").trim();
    if (!content) {
      throw new Error("Rerank returned empty content");
    }

    const results = parseRerankResponse(content, documents, actualTopN);
    if (results.length === 0) {
      throw new Error("Rerank returned no valid results");
    }

    const rerankTime = Date.now() - llmStart;

    ragLogger.reranker.info("Reranked documents (LLM)", {
      provider: response.provider,
      model: response.model,
      query: truncateText(query, 50),
      inputDocuments: documents.length,
      outputDocuments: results.length,
      topScore: formatScore(results[0]?.relevanceScore),
      rerankTimeMs: rerankTime,
      billedUnits: response.usage?.total_tokens,
    });

    return {
      results,
      meta: {
        billedUnits: response.usage?.total_tokens,
      },
    };
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    ragLogger.reranker.error("Rerank failed", error, {
      query: truncateText(query, 50),
      documentCount: documents.length,
    });
    return null;
  }
}

/**
 * Rerank KB articles specifically.
 * Combines title + content for better matching.
 */
export async function rerankKBArticles<
  T extends {
    title: string;
    content?: string;
    fullContent?: string;
    similarity: number;
  },
>(
  query: string,
  articles: T[],
  topN: number = 3,
  options?: {
    workspaceId?: string | null;
    conversationId?: string | null;
  }
): Promise<T[]> {
  if (!articles || articles.length === 0) {
    return [];
  }

  const documents: RerankDocument[] = articles.map((article, index) => ({
    text: `${article.title}\n\n${article.content ?? article.fullContent ?? ""}`.trim(),
    id: String(index),
    metadata: { originalIndex: index },
  }));

  const reranked = await rerankDocuments(query, documents, topN, options);

  if (!reranked) {
    return articles.slice(0, topN);
  }

  return reranked.results.map(result => ({
    ...articles[result.index],
    similarity: articles[result.index].similarity,
    rerankerScore: result.relevanceScore,
    _originalSimilarity: articles[result.index].similarity,
    _reranked: true,
  }));
}
