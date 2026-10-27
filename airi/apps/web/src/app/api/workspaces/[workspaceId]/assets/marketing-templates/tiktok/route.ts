import {
  DEFAULT_TIKTOK_DISCOVERY_CATEGORY,
  DEFAULT_TIKTOK_DISCOVERY_MARKET,
  isTikTokDiscoveryCategory,
  isTikTokDiscoveryMarket,
  type TikTokDiscoveryCategory,
  type TikTokDiscoveryMarket,
} from "@/lib/creative-assets/tiktok-marketing-templates";
import { createRequestLogger } from "@/lib/observability/server-logs";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  loadTikTokDiscoveryMarketingTemplates,
  type TikTokDiscoveryLoadResult,
} from "@/lib/tiktok-discovery/catalog-loader";
import {
  checkRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { type NextRequest, NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;

type CompletionLogger = ReturnType<typeof createRequestLogger>;

type CompletionFields = {
  userId: string | null;
  workspaceId: string;
  market: TikTokDiscoveryMarket | null;
  category: TikTokDiscoveryCategory | null;
  httpStatus: number;
  productStatus: TikTokDiscoveryLoadResult["response"]["status"] | "not_called";
  cacheOutcome: TikTokDiscoveryLoadResult["cacheOutcome"] | "not_called";
  providerOutcome: TikTokDiscoveryLoadResult["providerOutcome"];
  itemCount: number;
  stale: boolean;
  retryAt: string | null;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUEST_LIMIT = 20;
const requestLimiter = createRateLimiter({
  requests: REQUEST_LIMIT,
  window: "5 m",
  prefix: "assets:tiktok-discovery",
  analytics: false,
});

function logCompletion(
  logger: CompletionLogger,
  fields: CompletionFields
): void {
  logger.success("TikTok Discovery catalog request completed", fields);
}

function unavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "TikTok Discovery is temporarily unavailable" },
    { status: 503 }
  );
}

function logBeforeLoader(
  logger: CompletionLogger,
  input: {
    userId: string | null;
    workspaceId: string;
    market?: TikTokDiscoveryMarket | null;
    category?: TikTokDiscoveryCategory | null;
    httpStatus: number;
    retryAt?: string | null;
  }
): void {
  logCompletion(logger, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    market: input.market ?? null,
    category: input.category ?? null,
    httpStatus: input.httpStatus,
    productStatus: "not_called",
    cacheOutcome: "not_called",
    providerOutcome: "not_called",
    itemCount: 0,
    stale: false,
    retryAt: input.retryAt ?? null,
  });
}

function resolveCoordinates(searchParams: URLSearchParams):
  | {
      ok: true;
      market: TikTokDiscoveryMarket;
      category: TikTokDiscoveryCategory;
    }
  | {
      ok: false;
      market: TikTokDiscoveryMarket | null;
      category: TikTokDiscoveryCategory | null;
    } {
  const marketValues = searchParams.getAll("market");
  const categoryValues = searchParams.getAll("category");
  const marketValue =
    marketValues.length === 0
      ? DEFAULT_TIKTOK_DISCOVERY_MARKET
      : marketValues.length === 1 && isTikTokDiscoveryMarket(marketValues[0])
        ? marketValues[0]
        : null;
  const categoryValue =
    categoryValues.length === 0
      ? DEFAULT_TIKTOK_DISCOVERY_CATEGORY
      : categoryValues.length === 1 &&
          isTikTokDiscoveryCategory(categoryValues[0])
        ? categoryValues[0]
        : null;

  if (marketValue === null || categoryValue === null) {
    return { ok: false, market: marketValue, category: categoryValue };
  }
  return { ok: true, market: marketValue, category: categoryValue };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  const { workspaceId } = await params;
  // Client request identifiers are untrusted. Preserve only the real method in
  // the shared request logger and supply bounded completion fields explicitly.
  const logger = createRequestLogger(
    "api.workspaces.assets.marketing-templates.tiktok",
    new Request("https://request.invalid", { method: request.method })
  );
  let access: Awaited<ReturnType<typeof requireWorkspaceApiAccess>>;
  try {
    access = await requireWorkspaceApiAccess(workspaceId);
  } catch {
    logBeforeLoader(logger, {
      userId: null,
      workspaceId,
      httpStatus: 503,
    });
    return unavailableResponse();
  }
  if (!access.ok) {
    logBeforeLoader(logger, {
      userId: null,
      workspaceId,
      httpStatus: access.response.status,
    });
    return access.response;
  }

  if (!requestLimiter) {
    if (process.env.NODE_ENV === "production") {
      logBeforeLoader(logger, {
        userId: access.userId,
        workspaceId,
        httpStatus: 503,
      });
      return unavailableResponse();
    }
  } else {
    let rateLimit;
    try {
      rateLimit = await checkRateLimit(
        requestLimiter,
        `${access.userId}:${workspaceId}`,
        REQUEST_LIMIT
      );
    } catch {
      logBeforeLoader(logger, {
        userId: access.userId,
        workspaceId,
        httpStatus: 503,
      });
      return unavailableResponse();
    }

    // Upstash's timeout fallback is normalized by the shared helper to a
    // granted-looking zero-valued result. It is not a valid 20-request window.
    if (rateLimit.limit !== REQUEST_LIMIT) {
      logBeforeLoader(logger, {
        userId: access.userId,
        workspaceId,
        httpStatus: 503,
      });
      return unavailableResponse();
    }

    if (!rateLimit.success) {
      const retryAfterSeconds = Math.min(
        300,
        Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1_000))
      );
      logBeforeLoader(logger, {
        userId: access.userId,
        workspaceId,
        httpStatus: 429,
        retryAt: new Date(Date.now() + retryAfterSeconds * 1_000).toISOString(),
      });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSeconds),
            "X-RateLimit-Limit": String(rateLimit.limit),
            "X-RateLimit-Remaining": String(rateLimit.remaining),
          },
        }
      );
    }
  }

  const coordinates = resolveCoordinates(request.nextUrl.searchParams);
  if (!coordinates.ok) {
    logBeforeLoader(logger, {
      userId: access.userId,
      workspaceId,
      market: coordinates.market,
      category: coordinates.category,
      httpStatus: 400,
    });
    return NextResponse.json(
      { error: "Invalid TikTok Discovery market or category" },
      { status: 400 }
    );
  }

  let result: TikTokDiscoveryLoadResult;
  try {
    result = await loadTikTokDiscoveryMarketingTemplates({
      market: coordinates.market,
      category: coordinates.category,
    });
  } catch {
    const response = {
      status: "temporarily_unavailable" as const,
      items: [] as [],
    };
    logCompletion(logger, {
      userId: access.userId,
      workspaceId,
      market: coordinates.market,
      category: coordinates.category,
      httpStatus: 503,
      productStatus: response.status,
      cacheOutcome: "coordination_unavailable",
      providerOutcome: "not_called",
      itemCount: 0,
      stale: false,
      retryAt: null,
    });
    return NextResponse.json(response, { status: 503 });
  }

  logCompletion(logger, {
    userId: access.userId,
    workspaceId,
    market: coordinates.market,
    category: coordinates.category,
    httpStatus: result.transportStatus,
    productStatus: result.response.status,
    cacheOutcome: result.cacheOutcome,
    providerOutcome: result.providerOutcome,
    itemCount: result.response.items.length,
    stale: result.response.status === "ok" ? result.response.stale : false,
    retryAt: result.retryAt,
  });
  return NextResponse.json(result.response, { status: result.transportStatus });
}
