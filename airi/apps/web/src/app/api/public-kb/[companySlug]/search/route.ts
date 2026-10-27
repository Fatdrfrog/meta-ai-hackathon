import {
  PUBLIC_KB_SEARCH_DEFAULT_LIMIT,
  normalizePublicKBSearchLimit,
  normalizePublicKBSearchQuery,
  searchPublicKBArticles,
} from "@/lib/kb/public-kb-search";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const publicKBSearchLimiter = createRateLimiter({
  requests: 60,
  window: "1 m",
  prefix: "public-kb:search",
});

function getRequesterKey(request: NextRequest, companySlug: string) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || "0.0.0.0";
  return `${companySlug}:${ip}`;
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ companySlug: string }> }
) {
  const { companySlug } = await context.params;
  const query = normalizePublicKBSearchQuery(
    request.nextUrl.searchParams.get("q")
  );
  const locale = request.nextUrl.searchParams.get("locale")?.trim() || null;
  const limit = normalizePublicKBSearchLimit(
    request.nextUrl.searchParams.get("limit") ?? PUBLIC_KB_SEARCH_DEFAULT_LIMIT
  );

  if (query.length < 2) {
    return jsonResponse({ items: [], query }, { status: 200 });
  }

  const rateLimit = await checkRateLimit(
    publicKBSearchLimiter,
    getRequesterKey(request, companySlug),
    60
  );
  if (!rateLimit.success) {
    return jsonResponse(
      { items: [], query, error: "Too many requests" },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": rateLimit.limit.toString(),
          "X-RateLimit-Remaining": rateLimit.remaining.toString(),
        },
      }
    );
  }

  try {
    const items = await searchPublicKBArticles({
      companySlug,
      query,
      locale,
      limit,
    });

    return jsonResponse({ items, query }, { status: 200 });
  } catch (error) {
    console.error("[Public KB Search] Search failed:", error);
    return jsonResponse(
      { items: [], query, error: "Search unavailable" },
      { status: 500 }
    );
  }
}
