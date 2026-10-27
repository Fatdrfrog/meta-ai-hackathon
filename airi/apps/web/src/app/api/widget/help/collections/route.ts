import { getCompanySlugByWorkspaceId } from "@/lib/kb/get-company-slug";
import { widgetLogger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import {
  checkRateLimit,
  createRateLimiter,
  rateLimitPresets,
} from "@icecore/shared/lib/rate-limiter";
import { NextRequest } from "next/server";

/**
 * Widget Help Collections API Response
 */
export interface WidgetHelpCollection {
  id: string;
  title: string;
  /** Description derived from article content. Currently null (Phase 1). */
  description: string | null;
  /** Count of direct + nested child articles (computed via recursive CTE) */
  articleCount: number;
  /** Full public URL to the KB article */
  url: string;
}

export interface WidgetHelpCollectionsResponse {
  success: boolean;
  collections?: WidgetHelpCollection[];
  error?: string;
}

// Reuse widget config rate limiter preset
const helpCollectionsLimiter = createRateLimiter(rateLimitPresets.widgetConfig);

/**
 * OPTIONS /api/widget/help/collections
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/widget/help/collections
 *
 * Fetches KB collections (root-level published articles) for the widget Help tab.
 * Uses client_key to identify workspace; returns full public URLs.
 *
 * Implementation notes:
 * - Collections = root kb_articles where parent_id IS NULL and status = 'published'
 * - articleCount computed via single recursive CTE (no N+1 queries)
 * - description is currently null for Phase 1 (derivation from content is complex)
 * - Full URL built on backend using NEXT_PUBLIC_APP_URL and company slug
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");

  try {
    const clientKey = req.nextUrl.searchParams.get("client_key");

    if (!clientKey) {
      return jsonWithCors<WidgetHelpCollectionsResponse>(
        {
          success: false,
          error: "Missing client_key parameter",
        },
        { status: 400 }
      );
    }

    // Rate limiting (same preset as widget config)
    const rateLimitResult = await checkRateLimit(
      helpCollectionsLimiter,
      clientKey,
      30
    );
    if (!rateLimitResult.success) {
      widgetLogger.rateLimitExceeded("/api/widget/help/collections", clientKey);
      return jsonWithCors<WidgetHelpCollectionsResponse>(
        {
          success: false,
          error: "Too many requests. Please try again later.",
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": rateLimitResult.limit.toString(),
            "X-RateLimit-Remaining": rateLimitResult.remaining.toString(),
          },
        }
      );
    }

    const sourceAuth = await resolveAuthorizedWidgetSource({
      request: req,
      clientKey,
    });
    if (!sourceAuth.ok) {
      return jsonWithCors<WidgetHelpCollectionsResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status, origin }
      );
    }

    const { source } = sourceAuth;
    const supabase = await createClient();

    // Get company slug for building public URLs. Widget visitors are anon
    // and anon cannot read companies, so resolve the slug on the server.
    const companySlug = await getCompanySlugByWorkspaceId(
      supabaseAdmin,
      source.workspace_id
    );

    if (!companySlug) {
      widgetLogger.error(
        "help_collections",
        new Error("Company slug not found"),
        {
          companyId: source.company_id,
          clientKey,
        }
      );
      return jsonWithCors<WidgetHelpCollectionsResponse>(
        {
          success: false,
          error: "Configuration error",
        },
        { status: 500 }
      );
    }

    // Build base URL for public KB links
    const baseUrl = (
      process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat"
    ).replace(/\/$/, "");

    /**
     * Query root collections with article counts using a single recursive CTE.
     *
     * The CTE:
     * 1. Starts with all articles in this workspace
     * 2. Builds a tree hierarchy to find all descendants of each root
     * 3. Aggregates counts per root article
     * 4. Returns only published root articles (parent_id IS NULL) with their child counts
     */
    const { data: collections, error: collectionsError } = await supabase.rpc(
      "get_kb_collections_with_counts",
      { p_workspace_id: source.workspace_id }
    );

    // If RPC doesn't exist, fall back to simpler query (no nested counts)
    if (collectionsError?.code === "PGRST202") {
      // RPC not found - use fallback query with direct children only
      console.warn(
        "[Widget Help] RPC get_kb_collections_with_counts not found, using fallback"
      );

      const { data: rootArticles, error: rootError } = await supabase
        .from("kb_articles")
        .select("id, title")
        .eq("workspace_id", source.workspace_id)
        .eq("status", "published")
        .not("published_at", "is", null)
        .is("parent_id", null)
        .order("sort_order", { ascending: true });

      if (rootError) {
        throw rootError;
      }

      if (!rootArticles || rootArticles.length === 0) {
        return jsonWithCors<WidgetHelpCollectionsResponse>({
          success: true,
          collections: [],
        });
      }

      // Get child counts for all root articles in a single query
      const rootIds = rootArticles.map(a => a.id);
      const { data: childCounts, error: countError } = await supabase
        .from("kb_articles")
        .select("parent_id")
        .eq("workspace_id", source.workspace_id)
        .eq("status", "published")
        .not("published_at", "is", null)
        .in("parent_id", rootIds);

      if (countError) {
        throw countError;
      }

      // Build count map
      const countMap = new Map<string, number>();
      childCounts?.forEach(c => {
        if (c.parent_id) {
          countMap.set(c.parent_id, (countMap.get(c.parent_id) || 0) + 1);
        }
      });

      const formattedCollections: WidgetHelpCollection[] = rootArticles.map(
        article => ({
          id: article.id,
          title: article.title,
          description: null, // Phase 1: description derivation deferred
          articleCount: countMap.get(article.id) || 0,
          url: `${baseUrl}/${companySlug}/kb/${article.id}`,
        })
      );

      return jsonWithCors<WidgetHelpCollectionsResponse>({
        success: true,
        collections: formattedCollections,
      });
    }

    if (collectionsError) {
      throw collectionsError;
    }

    // Format RPC results
    const collectionRows = (collections || []) as Array<{
      id: string;
      title: string;
      article_count: number;
    }>;
    const collectionIds = collectionRows.map(row => row.id);

    let publicCollectionIds = new Set(collectionIds);
    if (collectionIds.length > 0) {
      const { data: publicCollections, error: publicCollectionsError } =
        await supabase
          .from("kb_articles")
          .select("id")
          .eq("workspace_id", source.workspace_id)
          .eq("status", "published")
          .not("published_at", "is", null)
          .is("parent_id", null)
          .in("id", collectionIds);

      if (publicCollectionsError) {
        throw publicCollectionsError;
      }

      publicCollectionIds = new Set(
        (publicCollections || []).map(collection => collection.id)
      );
    }

    const formattedCollections: WidgetHelpCollection[] = collectionRows
      .filter(row => publicCollectionIds.has(row.id))
      .map(row => ({
        id: row.id,
        title: row.title,
        description: null, // Phase 1: description derivation deferred
        articleCount: row.article_count || 0,
        url: `${baseUrl}/${companySlug}/kb/${row.id}`,
      }));

    return jsonWithCors<WidgetHelpCollectionsResponse>({
      success: true,
      collections: formattedCollections,
    });
  } catch (error) {
    widgetLogger.error("help_collections", error, { origin });
    return jsonWithCors<WidgetHelpCollectionsResponse>(
      {
        success: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
