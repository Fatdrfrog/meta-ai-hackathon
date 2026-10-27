import { convertContentToHtml } from "@/lib/kb/content-utils";
import { widgetLogger } from "@/lib/logger";
import {
  getEffectiveKBArticleContent,
  getKBArticleUpdatedAt,
  type KBArticleVersionRelation,
} from "@/lib/kb/article-content";
import { createClient } from "@/lib/supabase/server";
import { handleCorsOptions, jsonWithCors } from "@/lib/widget/cors";
import { resolveAuthorizedWidgetSource } from "@/lib/widget/source-context";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { NextRequest } from "next/server";

/**
 * Widget Help Article Content Response
 */
export interface WidgetHelpArticleContent {
  id: string;
  title: string;
  /** Sanitized HTML content rendered from MDX */
  content_html: string;
  /** ISO date string of last update */
  updatedAt: string;
}

export interface WidgetHelpArticleResponse {
  success: boolean;
  article?: WidgetHelpArticleContent;
  error?: string;
}

interface WidgetHelpArticleRow {
  id: string;
  title: string;
  updated_at: string | null;
  kb_article_versions?: KBArticleVersionRelation;
}

/**
 * Stricter rate limiter for article content (full HTML is expensive)
 * Lower requests per window than collections/articles-list
 */
const articleContentLimiter = createRateLimiter({
  prefix: "widget_article_content",
  window: "1 m",
  requests: 30, // 30 requests per minute per client_key
});

/**
 * OPTIONS /api/widget/help/articles/[articleId]
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/widget/help/articles/[articleId]
 *
 * Fetches full article content for in-widget viewing.
 * Returns sanitized HTML, suitable for rendering in the widget.
 *
 * Query params:
 * - client_key (required): Widget client key
 *
 * Implementation notes:
 * - Stricter rate limiting than list endpoints (serves full content)
 * - HTML is sanitized to prevent XSS
 * - Only returns published articles belonging to the client's workspace
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ articleId: string }> }
) {
  const origin = req.headers.get("origin");

  try {
    const { articleId } = await params;
    const clientKey = req.nextUrl.searchParams.get("client_key");

    if (!clientKey) {
      return jsonWithCors<WidgetHelpArticleResponse>(
        {
          success: false,
          error: "Missing client_key parameter",
        },
        { status: 400 }
      );
    }

    // Stricter rate limiting for content endpoint
    const rateLimitResult = await checkRateLimit(
      articleContentLimiter,
      clientKey,
      30
    );
    if (!rateLimitResult.success) {
      widgetLogger.rateLimitExceeded(
        "/api/widget/help/articles/[articleId]",
        clientKey
      );
      return jsonWithCors<WidgetHelpArticleResponse>(
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
      return jsonWithCors<WidgetHelpArticleResponse>(
        {
          success: false,
          error: sourceAuth.error,
        },
        { status: sourceAuth.status, origin }
      );
    }

    const { source } = sourceAuth;
    const supabase = await createClient();

    // Fetch article with latest version content
    // Security: verify article belongs to this workspace and is published
    const { data: article, error: articleError } = await supabase
      .from("kb_articles")
      .select(
        `
        id,
        title,
        updated_at,
        kb_article_versions(
          content_mdx,
          version,
          created_at
        )
      `
      )
      .eq("id", articleId)
      .eq("workspace_id", source.workspace_id)
      .eq("status", "published")
      .not("published_at", "is", null)
      .order("version", {
        ascending: false,
        referencedTable: "kb_article_versions",
      })
      .limit(1, { referencedTable: "kb_article_versions" })
      .single();

    const typedArticle = (article as WidgetHelpArticleRow | null) ?? null;

    if (articleError || !typedArticle) {
      return jsonWithCors<WidgetHelpArticleResponse>(
        {
          success: false,
          error: "Article not found",
        },
        { status: 404 }
      );
    }

    // Get latest version's content
    const contentMdx = getEffectiveKBArticleContent({
      versions: typedArticle.kb_article_versions,
    });
    const contentHtml = convertContentToHtml(contentMdx);

    // Use version created_at or article updated_at for updatedAt
    const updatedAt =
      getKBArticleUpdatedAt({
        articleUpdatedAt: typedArticle.updated_at,
        versions: typedArticle.kb_article_versions,
      }) || new Date().toISOString();

    return jsonWithCors<WidgetHelpArticleResponse>({
      success: true,
      article: {
        id: typedArticle.id,
        title: typedArticle.title,
        content_html: contentHtml,
        updatedAt,
      },
    });
  } catch (error) {
    widgetLogger.error("help_article_content", error, { origin });
    return jsonWithCors<WidgetHelpArticleResponse>(
      {
        success: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
