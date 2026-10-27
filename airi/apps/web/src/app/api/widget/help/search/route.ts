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
 * Widget Help Search Result
 */
export interface WidgetHelpSearchResult {
  id: string;
  title: string;
  /** Full public URL to the KB article */
  url: string;
}

export interface WidgetHelpSearchResponse {
  success: boolean;
  results?: WidgetHelpSearchResult[];
  error?: string;
}

// Rate limiter for search (stricter than collections listing)
const helpSearchLimiter = createRateLimiter(rateLimitPresets.widgetConfig);

/**
 * OPTIONS /api/widget/help/search
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/widget/help/search?client_key=...&q=...
 *
 * Searches published KB articles for the workspace identified by client_key.
 * Returns matching article titles using keyword search (ilike).
 *
 * Query params:
 * - client_key (required): Widget client key
 * - q (required): Search query (minimum 2 characters)
 *
 * Implementation notes:
 * - Only searches published articles (status = 'published', published_at IS NOT NULL)
 * - Scoped to the workspace identified by the client_key
 * - Returns up to 10 results sorted by relevance
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");

  try {
    const clientKey = req.nextUrl.searchParams.get("client_key");
    const q = (req.nextUrl.searchParams.get("q") || "").trim();

    if (!clientKey) {
      return jsonWithCors<WidgetHelpSearchResponse>(
        {
          success: false,
          error: "Missing client_key parameter",
        },
        { status: 400 }
      );
    }

    if (q.length < 2) {
      return jsonWithCors<WidgetHelpSearchResponse>({
        success: true,
        results: [],
      });
    }

    // Rate limiting
    const rateLimitResult = await checkRateLimit(
      helpSearchLimiter,
      clientKey,
      30
    );
    if (!rateLimitResult.success) {
      widgetLogger.rateLimitExceeded("/api/widget/help/search", clientKey);
      return jsonWithCors<WidgetHelpSearchResponse>(
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
      return jsonWithCors<WidgetHelpSearchResponse>(
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
      widgetLogger.error("help_search", new Error("Company slug not found"), {
        companyId: source.company_id,
        clientKey,
      });
      return jsonWithCors<WidgetHelpSearchResponse>(
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

    // Search published articles by title using case-insensitive pattern match
    const { data: articles, error: articlesError } = await supabase
      .from("kb_articles")
      .select("id, title")
      .eq("workspace_id", source.workspace_id)
      .eq("status", "published")
      .not("published_at", "is", null)
      .ilike("title", `%${q}%`)
      .order("sort_order", { ascending: true })
      .limit(10);

    if (articlesError) {
      throw articlesError;
    }

    const results: WidgetHelpSearchResult[] = (articles || []).map(article => ({
      id: article.id,
      title: article.title,
      url: `${baseUrl}/${companySlug}/kb/${article.id}`,
    }));

    return jsonWithCors<WidgetHelpSearchResponse>({
      success: true,
      results,
    });
  } catch (error) {
    widgetLogger.error("help_search", error, { origin });
    return jsonWithCors<WidgetHelpSearchResponse>(
      {
        success: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
