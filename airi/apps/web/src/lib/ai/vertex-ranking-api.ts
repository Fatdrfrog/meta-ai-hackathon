/**
 * Vertex AI Search **Ranking API** — stateless rerank of arbitrary JSON records.
 * Does **not** require Vertex RAG Engine or a Discovery data store; typical flow is
 * vector / lexical candidates → `:rank` → ordered scores (see Google’s RAG outline).
 *
 * @see https://docs.cloud.google.com/generative-ai-app-builder/docs/ranking
 * @see https://docs.cloud.google.com/generative-ai-app-builder/docs/builder-apis (DIY RAG: rank after retrieval)
 * @see https://cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1/projects.locations.rankingConfigs/rank
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/retrieval-and-ranking (optional pairing with RAG Engine)
 */

import "server-only";

import {
  getVertexPlatformAccessToken,
  resolveVertexEmbeddingProjectId,
} from "@/lib/ai/vertex-auth";
import { getVertexProjectIdFromEnv } from "@/lib/ai/vertex-env";
import { RAG_CONFIG } from "@/lib/airi/rag/config";
import { ragLogger } from "@/lib/airi/shared/logger";

const DISCOVERY_ENGINE_HOST = "https://discoveryengine.googleapis.com";

type RankingRecordPayload = {
  id: string;
  title?: string;
  content?: string;
};

type RankResponse = {
  records?: Array<{
    id?: string;
    title?: string;
    content?: string;
    score?: number;
  }>;
};

function buildRankingConfigPath(projectId: string, location: string): string {
  return `projects/${projectId}/locations/${location}/rankingConfigs/default_ranking_config`;
}

/**
 * Ranks text records for a query using `projects.locations.rankingConfigs:rank`.
 * Returns records sorted by descending relevance (API order), or null on failure.
 */
export async function rankRecordsWithVertexRankingApi(params: {
  query: string;
  records: RankingRecordPayload[];
  topN: number;
}): Promise<Array<{ id: string; score: number }> | null> {
  const { query, records, topN } = params;
  if (!query.trim() || records.length === 0) return null;

  const projectId =
    (await resolveVertexEmbeddingProjectId()) || getVertexProjectIdFromEnv();
  if (!projectId?.trim()) {
    ragLogger.reranker.debug("Vertex ranking skipped: no GCP project id");
    return null;
  }

  const location = RAG_CONFIG.reranking.vertexRankingLocation;
  const model = RAG_CONFIG.reranking.vertexRankingModel;
  const resourcePath = buildRankingConfigPath(projectId.trim(), location);
  const url = `${DISCOVERY_ENGINE_HOST}/v1/${resourcePath}:rank`;

  let token: string;
  try {
    token = await getVertexPlatformAccessToken();
  } catch (e) {
    ragLogger.reranker.debug(
      "Vertex ranking skipped: no platform access token",
      {
        error: e instanceof Error ? e.message : String(e),
      }
    );
    return null;
  }

  /** `semantic-ranker-default-004` — up to ~1024 tokens per record (title+content); truncate conservatively. */
  const body = {
    model,
    query: query.trim(),
    topN: topN > 0 ? topN : undefined,
    ignoreRecordDetailsInResponse: true,
    records: records.map(r => ({
      id: r.id,
      title: (r.title || "").slice(0, 300),
      content: (r.content || "").slice(0, 3500),
    })),
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      ragLogger.reranker.warn("Vertex ranking API HTTP error", {
        status: res.status,
        preview: text.slice(0, 200),
      });
      return null;
    }

    const json = JSON.parse(text) as RankResponse;
    const out: Array<{ id: string; score: number }> = [];
    for (const row of json.records || []) {
      const id = String(row.id || "").trim();
      if (!id) continue;
      const score = Number(row.score);
      if (!Number.isFinite(score)) continue;
      out.push({ id, score: Math.min(Math.max(score, 0), 1) });
    }
    if (out.length === 0) return null;
    return out;
  } catch (error) {
    ragLogger.reranker.warn("Vertex ranking API request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
