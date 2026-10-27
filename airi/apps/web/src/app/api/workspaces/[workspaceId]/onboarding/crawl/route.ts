import {
  CRAWL_INDEX_LIMITS,
  normalizeCrawlWebsiteSeeds,
  resolveCrawlBudget,
} from "@/lib/crawler/crawl-limits";
import { normalizeRootUrl } from "@/lib/crawler/crawl-html-utils";
import {
  buildIndexedUrlLimitError,
  countIndexedUrlSlots,
  fetchIndexedUrlStatusRows,
  findFreshPendingIndexedUrls,
  markIndexedUrlRowsFailed,
  markIndexedUrlRowsPending,
  type IndexedUrlClient,
} from "@/lib/crawler/indexed-url-queue";
import {
  buildIndexedUrlPublicError,
  INDEXED_URL_PUBLIC_ERRORS,
  toPublicIndexedUrlFailure,
} from "@/lib/kb/indexed-url-public-contract";
import { requireIndexedUrlWorkspaceAccess } from "@/lib/kb/indexed-url-route-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isTemporalConfigured } from "@/lib/temporal/client";
import { tryStartCrawlWebsiteWorkflow } from "@/lib/temporal/crawl-website-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const crawlSchema = z.object({
  websites: z
    .array(z.string().min(1))
    .max(CRAWL_INDEX_LIMITS.maxWebsitesPerRequest)
    .optional()
    .default([]),
  includeInstagram: z.boolean().optional().default(false),
  maxPagesPerSite: z.number().int().positive().optional(),
  maxCrawlMsPerSite: z.number().int().positive().optional(),
  maxIndexChars: z.number().int().positive().optional(),
});

type Params = { params: Promise<{ workspaceId: string }> };

function getRouteErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Unknown error";
}

export async function POST(request: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
  let companyId: string | undefined;
  try {
    const access = await requireIndexedUrlWorkspaceAccess(workspaceId);
    if (!access.ok) return access.response;
    companyId = access.companyId;
    const indexedUrlClient = supabaseAdmin as unknown as IndexedUrlClient;

    if (!isTemporalConfigured()) {
      return NextResponse.json(
        buildIndexedUrlPublicError("background_processing_unavailable"),
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const parsed = crawlSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message || "Validation failed" },
        { status: 400 }
      );
    }

    const budget = resolveCrawlBudget(parsed.data);
    const { includeInstagram } = parsed.data;
    if (parsed.data.websites.length === 0 && !includeInstagram) {
      return NextResponse.json(
        buildIndexedUrlPublicError("invalid_training_source"),
        { status: 400 }
      );
    }

    const normalizedWebsites = normalizeCrawlWebsiteSeeds(parsed.data.websites);
    const rejected: string[] = [];
    for (const website of parsed.data.websites) {
      const normalized = normalizeRootUrl(website);
      if (!normalized) {
        rejected.push(website);
      }
    }

    if (rejected.length > 0) {
      return NextResponse.json(
        {
          error: `These website URLs are not allowed: ${rejected.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const existingRows = await fetchIndexedUrlStatusRows(
      indexedUrlClient,
      companyId
    );
    const { activeCount, newWebsiteCount } = countIndexedUrlSlots({
      websites: normalizedWebsites,
      existingRows,
    });
    const freshPendingUrls = findFreshPendingIndexedUrls({
      websites: normalizedWebsites,
      existingRows,
    });
    const websitesToQueue = normalizedWebsites.filter(
      website => !freshPendingUrls.has(website)
    );
    const alreadyQueued =
      websitesToQueue.length === 0 &&
      normalizedWebsites.length > 0 &&
      !includeInstagram;
    const requestedSlots =
      activeCount + newWebsiteCount + (includeInstagram ? 1 : 0);
    if (requestedSlots > CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany) {
      return NextResponse.json(
        buildIndexedUrlLimitError({
          activeCount,
          requestedNewCount: newWebsiteCount + (includeInstagram ? 1 : 0),
        }),
        { status: 400 }
      );
    }

    await markIndexedUrlRowsPending({
      client: indexedUrlClient,
      companyId,
      websites: websitesToQueue,
    });

    const startResult = await tryStartCrawlWebsiteWorkflow({
      workspaceId,
      websites: normalizedWebsites,
      includeInstagram,
      maxPagesPerSite: budget.maxPagesPerSite,
      maxCrawlMsPerSite: budget.maxCrawlMsPerSite,
      maxIndexChars: budget.maxIndexChars,
    });

    if (!startResult.ok) {
      console.error("Indexed URL operation failed", {
        operation: "onboarding_crawl_start",
        workspaceId,
        companyId,
        workflowId: undefined,
        error: startResult.message || startResult.reason,
      });
      await markIndexedUrlRowsFailed({
        client: indexedUrlClient,
        companyId,
        websites: websitesToQueue,
        message: INDEXED_URL_PUBLIC_ERRORS.training_start_failed,
      });
      const code =
        startResult.reason === "temporal_not_configured"
          ? "background_processing_unavailable"
          : "training_start_failed";
      return NextResponse.json(buildIndexedUrlPublicError(code), {
        status: code === "background_processing_unavailable" ? 503 : 500,
      });
    }

    if (alreadyQueued) {
      return NextResponse.json(
        {
          success: true,
          started: false,
          alreadyQueued: true,
          accepted: {
            websites: normalizedWebsites,
            includeInstagram,
          },
          limits: {
            indexedUrlLimit: CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany,
            maxPagesPerSite: budget.maxPagesPerSite,
            maxCrawlMsPerSite: budget.maxCrawlMsPerSite,
            maxIndexChars: budget.maxIndexChars,
          },
        },
        { status: 202 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        started: true,
        workflowId: startResult.workflowId,
        accepted: {
          websites: normalizedWebsites,
          includeInstagram,
        },
        limits: {
          indexedUrlLimit: CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany,
          maxPagesPerSite: budget.maxPagesPerSite,
          maxCrawlMsPerSite: budget.maxCrawlMsPerSite,
          maxIndexChars: budget.maxIndexChars,
        },
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("Indexed URL operation failed", {
      operation: "onboarding_crawl_start",
      workspaceId,
      companyId,
      error: getRouteErrorMessage(error),
    });
    return NextResponse.json(
      buildIndexedUrlPublicError("training_start_failed"),
      { status: 500 }
    );
  }
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { workspaceId } = await params;
  let companyId: string | undefined;
  try {
    const access = await requireIndexedUrlWorkspaceAccess(workspaceId);
    if (!access.ok) return access.response;
    companyId = access.companyId;

    const { data: urls, error } = await supabaseAdmin
      .from("kb_indexed_urls")
      .select(
        "id, url, title, description, index_status, last_indexed_at, error_message, created_at"
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const publicRows = (urls ?? []).map(({ error_message, ...row }) => ({
      ...row,
      ...(row.index_status === "failed"
        ? toPublicIndexedUrlFailure(error_message)
        : { failure_code: null, error_message: null }),
    }));
    const indexed = publicRows.filter(
      row => row.index_status === "indexed"
    ).length;
    const failed = publicRows.filter(
      row => row.index_status === "failed"
    ).length;
    const pending = publicRows.filter(
      row => row.index_status !== "indexed" && row.index_status !== "failed"
    ).length;

    return NextResponse.json({
      sources: publicRows,
      total: publicRows.length,
      indexed,
      pending,
      failed,
    });
  } catch (error) {
    console.error("Indexed URL operation failed", {
      operation: "onboarding_crawl_progress",
      workspaceId,
      companyId,
      error: getRouteErrorMessage(error),
    });
    return NextResponse.json(
      buildIndexedUrlPublicError("training_progress_unavailable"),
      { status: 500 }
    );
  }
}
