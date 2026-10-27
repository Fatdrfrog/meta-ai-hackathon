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
 * Widget Help Article (list item - no content)
 */
export interface WidgetHelpArticle {
  id: string;
  title: string;
  /** Full public URL to the KB article */
  url: string;
}

export interface WidgetHelpArticlesResponse {
  success: boolean;
  articles?: WidgetHelpArticle[];
  /** Cursor for next page, null if no more pages */
  nextCursor?: string | null;
  error?: string;
}

// Same rate limiter as collections (not content, just metadata)
const articlesListLimiter = createRateLimiter(rateLimitPresets.widgetConfig);

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

/**
 * OPTIONS /api/widget/help/collections/[collectionId]/articles
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/widget/help/collections/[collectionId]/articles
 *
 * Fetches articles within a KB collection for in-widget browsing.
 * Uses cursor-based pagination with stable sort order.
 *
 * Query params:
 * - client_key (required): Widget client key
 * - cursor (optional): Pagination cursor (article ID from previous page)
 * - limit (optional): Max articles per page (default 10, max 20)
 *
 * Implementation notes:
 * - Only direct children of the collection (parent_id = collectionId)
 * - Only published articles
 * - Stable sort: sort_order ASC, id ASC
 * - Cursor is the last article ID from the previous page
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ collectionId: string }> }
) {
  const origin = req.headers.get("origin");

  try {
    const { collectionId } = await params;
    const clientKey = req.nextUrl.searchParams.get("client_key");
    const cursor = req.nextUrl.searchParams.get("cursor");
    const limitParam = req.nextUrl.searchParams.get("limit");

    if (!clientKey) {
      return jsonWithCors<WidgetHelpArticlesResponse>(
        {
          success: false,
          error: "Missing client_key parameter",
        },
        { status: 400 }
      );
    }

    // Validate and cap limit
    let limit = DEFAULT_LIMIT;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, MAX_LIMIT);
      }
    }

    // Rate limiting
    const rateLimitResult = await checkRateLimit(
      articlesListLimiter,
      clientKey,
      30
    );
    if (!rateLimitResult.success) {
      widgetLogger.rateLimitExceeded(
        "/api/widget/help/collections/[collectionId]/articles",
        clientKey
      );
      return jsonWithCors<WidgetHelpArticlesResponse>(
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
      return jsonWithCors<WidgetHelpArticlesResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status, origin }
      );
    }

    const { source } = sourceAuth;
    const supabase = await createClient();

    // Verify the collection exists, is published, and belongs to this workspace
    const { data: collection, error: collectionError } = await supabase
      .from("kb_articles")
      .select("id, workspace_id")
      .eq("id", collectionId)
      .eq("workspace_id", source.workspace_id)
      .eq("status", "published")
      .not("published_at", "is", null)
      .is("parent_id", null) // Must be a root article (collection)
      .single();

    if (collectionError || !collection) {
      return jsonWithCors<WidgetHelpArticlesResponse>(
        {
          success: false,
          error: "Collection not found",
        },
        { status: 404 }
      );
    }

    // Get company slug for building public URLs. Widget visitors are anon
    // and anon cannot read companies, so resolve the slug on the server.
    const companySlug = await getCompanySlugByWorkspaceId(
      supabaseAdmin,
      source.workspace_id
    );

    if (!companySlug) {
      widgetLogger.error(
        "help_articles_list",
        new Error("Company slug not found"),
        {
          companyId: source.company_id,
          clientKey,
        }
      );
      return jsonWithCors<WidgetHelpArticlesResponse>(
        {
          success: false,
          error: "Configuration error",
        },
        { status: 500 }
      );
    }

    const baseUrl = (
      process.env.NEXT_PUBLIC_APP_URL || "https://www.airi.chat"
    ).replace(/\/$/, "");

    // Build query for articles in this collection
    let query = supabase
      .from("kb_articles")
      .select("id, title, sort_order")
      .eq("workspace_id", source.workspace_id)
      .eq("status", "published")
      .not("published_at", "is", null)
      .eq("parent_id", collectionId)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit + 1); // Fetch one extra to detect if there are more pages

    // Apply cursor if provided (cursor is the last article ID)
    if (cursor) {
      // Get the sort_order of the cursor article to enable proper pagination
      const { data: cursorArticle } = await supabase
        .from("kb_articles")
        .select("id, sort_order")
        .eq("id", cursor)
        .eq("workspace_id", source.workspace_id)
        .eq("status", "published")
        .not("published_at", "is", null)
        .eq("parent_id", collectionId)
        .single();

      if (cursorArticle) {
        // Fetch articles after the cursor position
        // (sort_order > cursor.sort_order) OR (sort_order = cursor.sort_order AND id > cursor.id)
        query = supabase
          .from("kb_articles")
          .select("id, title, sort_order")
          .eq("workspace_id", source.workspace_id)
          .eq("status", "published")
          .not("published_at", "is", null)
          .eq("parent_id", collectionId)
          .or(
            `sort_order.gt.${cursorArticle.sort_order},and(sort_order.eq.${cursorArticle.sort_order},id.gt.${cursorArticle.id})`
          )
          .order("sort_order", { ascending: true })
          .order("id", { ascending: true })
          .limit(limit + 1);
      }
    }

    const { data: articles, error: articlesError } = await query;

    if (articlesError) {
      throw articlesError;
    }

    // Determine if there are more pages
    const hasMore = (articles?.length || 0) > limit;
    const pageArticles = hasMore ? articles?.slice(0, limit) : articles;
    const nextCursor =
      hasMore && pageArticles?.length
        ? pageArticles[pageArticles.length - 1].id
        : null;

    // Format response
    const formattedArticles: WidgetHelpArticle[] = (pageArticles || []).map(
      article => ({
        id: article.id,
        title: article.title,
        url: `${baseUrl}/${companySlug}/kb/${article.id}`,
      })
    );

    return jsonWithCors<WidgetHelpArticlesResponse>({
      success: true,
      articles: formattedArticles,
      nextCursor,
    });
  } catch (error) {
    widgetLogger.error("help_articles_list", error, { origin });
    return jsonWithCors<WidgetHelpArticlesResponse>(
      {
        success: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
