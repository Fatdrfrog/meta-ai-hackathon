import { randomUUID } from "node:crypto";
import { getQueryEmbeddingWithCache } from "@/lib/ai";
import { ragLogger } from "@/lib/airi/shared/logger";
import { buildKbSearchCacheKey } from "@/lib/airi/rag/kb/kb-cache";
import { cache } from "@/lib/cache";
import {
  getAccessibleKBArticle,
  requireKBRouteAccess,
} from "@/lib/kb/article-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
const KB_SEARCH_CACHE_TTL_SECONDS = 60;

// Authenticated semantic search meters provider work and caches the response.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(
  request: Request,
  context: { params: Promise<{ articleId: string }> }
) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(
      20,
      Math.max(1, Number(url.searchParams.get("limit") || 10) || 10)
    );
    if (q.length < 2) {
      return NextResponse.json({ items: [] }, { status: 200 });
    }
    const { articleId } = await context.params;

    const supabase = await createClient();
    const access = await requireKBRouteAccess(supabase);
    if (!access.ok) {
      return NextResponse.json({ items: [] }, { status: 200 });
    }

    const article = await getAccessibleKBArticle<{ workspace_id: string }>(
      supabase,
      articleId,
      access.workspaceIds,
      "workspace_id"
    );

    if (!article?.workspace_id) {
      return NextResponse.json({ items: [] }, { status: 200 });
    }
    const workspaceId = article.workspace_id;

    const searchCacheKey = buildKbSearchCacheKey([
      workspaceId,
      q.toLowerCase(),
      String(limit),
    ]);

    const cached = await cache.get<unknown[]>(searchCacheKey);
    if (cached !== null) {
      console.log("[KB Search] Cache hit", {
        workspaceId,
        query: q.toLowerCase(),
      });
      return NextResponse.json({ items: cached }, { status: 200 });
    }

    const [keywordResponse, embedding] = await Promise.all([
      supabase
        .from("kb_articles")
        .select("id, title, published_at, views, feedback_score")
        .eq("workspace_id", workspaceId)
        .eq("status", "published")
        .textSearch("search_vector", q, { type: "plain" })
        .limit(limit),
      getQueryEmbeddingWithCache(q, {
        workspaceId,
        actionId: `kb-search:${randomUUID()}`,
      }).catch(() => null),
    ]);

    const keywordResults = keywordResponse.data || [];
    const keywordById = new Map(
      keywordResults.map(item => [
        String(item.id),
        {
          id: String(item.id),
          title: item.title || "Untitled",
          published_at: item.published_at,
          views: item.views,
          feedback_score: item.feedback_score,
        },
      ])
    );
    let orderedIds = keywordResults.map(item => String(item.id));

    if (embedding) {
      try {
        const { data: semanticResults } = await supabaseAdmin.rpc(
          "search_kb_articles",
          {
            query_embedding: embedding,
            match_workspace: workspaceId,
            match_locale: null,
            match_threshold: 0.5,
            match_count: limit,
          }
        );
        if (semanticResults) {
          orderedIds = [
            ...new Set([
              ...semanticResults.map((result: { id: string }) =>
                String(result.id)
              ),
              ...orderedIds,
            ]),
          ].slice(0, limit);
        }
      } catch (error) {
        ragLogger.retrieval.warn(
          "KB admin semantic search failed, using keyword results",
          {
            workspaceId,
            queryPreview: q.slice(0, 120),
            limit,
            error:
              error instanceof Error ? error.message : "Unknown semantic error",
          }
        );
      }
    }

    const missingIds = orderedIds.filter(id => !keywordById.has(id));
    if (missingIds.length > 0) {
      const { data: missingRows } = await supabase
        .from("kb_articles")
        .select("id, title, published_at, views, feedback_score")
        .eq("workspace_id", workspaceId)
        .eq("status", "published")
        .in("id", missingIds);

      for (const row of missingRows || []) {
        keywordById.set(String(row.id), {
          id: String(row.id),
          title: row.title || "Untitled",
          published_at: row.published_at,
          views: row.views,
          feedback_score: row.feedback_score,
        });
      }
    }

    const items = orderedIds
      .map(id => keywordById.get(id))
      .filter(Boolean)
      .slice(0, limit);

    await cache.set(searchCacheKey, items, KB_SEARCH_CACHE_TTL_SECONDS);
    console.log("[KB Search] Cache miss -> stored", {
      workspaceId,
      query: q.toLowerCase(),
      ttlSec: KB_SEARCH_CACHE_TTL_SECONDS,
      resultCount: items.length,
    });

    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
