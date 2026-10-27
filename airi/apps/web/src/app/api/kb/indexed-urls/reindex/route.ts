import {
  normalizeCrawlWebsiteSeeds,
  resolveCrawlBudget,
} from "@/lib/crawler/crawl-limits";
import {
  findFreshPendingIndexedUrls,
  markIndexedUrlRowsFailed,
  markIndexedUrlRowsPending,
  type IndexedUrlClient,
} from "@/lib/crawler/indexed-url-queue";
import {
  buildIndexedUrlPublicError,
  INDEXED_URL_PUBLIC_ERRORS,
} from "@/lib/kb/indexed-url-public-contract";
import { requireIndexedUrlWorkspaceAccess } from "@/lib/kb/indexed-url-route-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { tryStartCrawlWebsiteWorkflow } from "@/lib/temporal/crawl-website-client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const reindexBodySchema = z.object({
  urlId: z.string().min(1, "URL ID is required"),
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

export async function POST(request: NextRequest) {
  let workspaceId: string | undefined;
  let companyId: string | undefined;
  let urlId: string | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = reindexBodySchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message ?? "Validation failed";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    urlId = parsed.data.urlId;
    workspaceId = parsed.data.workspaceId;
    const budget = resolveCrawlBudget(parsed.data);

    const access = await requireIndexedUrlWorkspaceAccess(workspaceId);
    if (!access.ok) return access.response;
    companyId = access.companyId;
    const indexedUrlClient = supabaseAdmin as unknown as IndexedUrlClient;

    const { data: existingUrl, error: existingUrlError } = await supabaseAdmin
      .from("kb_indexed_urls")
      .select("url,index_status,last_indexed_at")
      .eq("id", urlId)
      .eq("company_id", companyId)
      .maybeSingle();

    if (existingUrlError) throw existingUrlError;
    if (!existingUrl?.url) {
      return NextResponse.json({ error: "URL not found" }, { status: 404 });
    }

    const normalizedWebsites = normalizeCrawlWebsiteSeeds([existingUrl.url], 1);
    const normalizedUrl = normalizedWebsites[0];
    if (!normalizedUrl) {
      return NextResponse.json(
        { error: "Stored URL is no longer a valid public HTTP/HTTPS URL." },
        { status: 400 }
      );
    }

    const freshPendingUrls = findFreshPendingIndexedUrls({
      websites: normalizedWebsites,
      existingRows: [
        {
          url: existingUrl.url,
          index_status: existingUrl.index_status,
          last_indexed_at: existingUrl.last_indexed_at,
        },
      ],
    });
    const alreadyQueued = freshPendingUrls.has(normalizedUrl);
    const websitesToQueue = alreadyQueued ? [] : normalizedWebsites;

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
        operation: "indexed_url_reindex_start",
        workspaceId,
        companyId,
        workflowId: undefined,
        urlId,
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
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("Indexed URL operation failed", {
      operation: "indexed_url_reindex",
      workspaceId,
      companyId,
      urlId,
      error: getRouteErrorMessage(error),
    });
    return NextResponse.json(
      buildIndexedUrlPublicError("indexed_url_reindex_failed"),
      { status: 500 }
    );
  }
}
