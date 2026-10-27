import { enqueueKnowledgeCanonicalSync } from "@/lib/airi/rag/knowledge/canonical-sync/enqueue-knowledge-canonical-sync";
import {
  CRAWL_INDEX_LIMITS,
  normalizeCrawlWebsiteSeeds,
  resolveCrawlBudget,
} from "@/lib/crawler/crawl-limits";
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
import { deleteIndexedUrl } from "@/lib/kb/url-indexer";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tryStartCrawlWebsiteWorkflow } from "@/lib/temporal/crawl-website-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const addUrlSchema = z.object({
  url: z.string().min(1, "URL is required"),
  workspaceId: z.string().min(1, "workspaceId is required"),
  maxPagesPerSite: z.number().int().positive().optional(),
  maxCrawlMsPerSite: z.number().int().positive().optional(),
  maxIndexChars: z.number().int().positive().optional(),
});

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

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspaceId query parameter is required" },
      { status: 400 }
    );
  }

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

    if (error) {
      throw new Error(error.message || "Failed to fetch indexed URLs");
    }

    const publicRows = (urls ?? []).map(({ error_message, ...row }) => ({
      ...row,
      ...(row.index_status === "failed"
        ? toPublicIndexedUrlFailure(error_message)
        : { failure_code: null, error_message: null }),
    }));
    const activeCount = publicRows.filter(
      row => row.index_status !== "failed"
    ).length;

    return NextResponse.json({
      urls: publicRows,
      count: activeCount,
      limit: CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany,
      remaining: Math.max(
        0,
        CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany - activeCount
      ),
    });
  } catch (error) {
    console.error("Indexed URL operation failed", {
      operation: "indexed_url_list",
      workspaceId,
      companyId,
      error: getRouteErrorMessage(error),
    });
    return NextResponse.json(
      buildIndexedUrlPublicError("indexed_url_list_failed"),
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let workspaceId: string | undefined;
  let companyId: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    const validationResult = addUrlSchema.safeParse(body);
    if (!validationResult.success) {
      const errorMessage =
        validationResult.error.errors[0]?.message || "Validation failed";
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const { url } = validationResult.data;
    workspaceId = validationResult.data.workspaceId;
    const budget = resolveCrawlBudget(validationResult.data);
    const normalizedWebsites = normalizeCrawlWebsiteSeeds([url], 1);
    const normalizedUrl = normalizedWebsites[0];
    if (!normalizedUrl) {
      return NextResponse.json(
        { error: "Must be a valid public HTTP/HTTPS URL." },
        { status: 400 }
      );
    }

    const access = await requireIndexedUrlWorkspaceAccess(workspaceId);
    if (!access.ok) return access.response;
    companyId = access.companyId;
    const indexedUrlClient = supabaseAdmin as unknown as IndexedUrlClient;

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
    const alreadyQueued = freshPendingUrls.has(normalizedUrl);
    const websitesToQueue = alreadyQueued ? [] : normalizedWebsites;
    if (
      activeCount + newWebsiteCount >
      CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany
    ) {
      return NextResponse.json(
        buildIndexedUrlLimitError({
          activeCount,
          requestedNewCount: newWebsiteCount,
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
      includeInstagram: false,
      maxPagesPerSite: budget.maxPagesPerSite,
      maxCrawlMsPerSite: budget.maxCrawlMsPerSite,
      maxIndexChars: budget.maxIndexChars,
    });

    if (!startResult.ok) {
      console.error("Indexed URL operation failed", {
        operation: "indexed_url_add_start",
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
          queued: true,
          started: false,
          alreadyQueued: true,
          url: normalizedUrl,
          title: normalizedUrl,
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
        queued: true,
        workflowId: startResult.workflowId,
        url: normalizedUrl,
        title: normalizedUrl,
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
      operation: "indexed_url_add",
      workspaceId,
      companyId,
      error: getRouteErrorMessage(error),
    });
    return NextResponse.json(
      buildIndexedUrlPublicError("indexed_url_add_failed"),
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  let workspaceId: string | undefined;
  let companyId: string | undefined;
  let urlId: string | null = null;
  try {
    const { searchParams } = new URL(request.url);
    workspaceId = searchParams.get("workspaceId")?.trim();
    urlId = searchParams.get("id");

    if (!workspaceId) {
      return NextResponse.json(
        { error: "workspaceId query parameter is required" },
        { status: 400 }
      );
    }

    if (!urlId) {
      return NextResponse.json(
        { error: "URL ID is required" },
        { status: 400 }
      );
    }

    const access = await requireIndexedUrlWorkspaceAccess(workspaceId);
    if (!access.ok) return access.response;
    companyId = access.companyId;

    const result = await deleteIndexedUrl(companyId, urlId);
    if (!result.success) {
      console.error("Indexed URL operation failed", {
        operation: "indexed_url_delete",
        workspaceId,
        companyId,
        urlId,
        error: result.error,
      });
      return NextResponse.json(
        buildIndexedUrlPublicError("indexed_url_delete_failed"),
        { status: 500 }
      );
    }

    enqueueKnowledgeCanonicalSync({
      context: "indexed_url_delete",
      workspaceId,
      sourceKinds: ["indexed_url"],
      executionId: `indexed-url-delete-${workspaceId}-${urlId}-${Date.now()}`,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Indexed URL operation failed", {
      operation: "indexed_url_delete",
      workspaceId,
      companyId,
      urlId,
      error: getRouteErrorMessage(error),
    });
    return NextResponse.json(
      buildIndexedUrlPublicError("indexed_url_delete_failed"),
      { status: 500 }
    );
  }
}
