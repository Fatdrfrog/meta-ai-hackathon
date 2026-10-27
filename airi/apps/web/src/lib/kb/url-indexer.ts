import { createHash } from "node:crypto";
import {
  getDocumentEmbeddingResult,
  getCurrentEmbeddingMetadata,
} from "@/lib/ai";
import { EMBEDDING_CACHE_VERSION } from "@/lib/ai/embedding-config";
import { parseStoredEmbedding } from "@/lib/ai/embedding-storage";
import { normalizeEmbeddingText } from "@/lib/ai/vertex-embeddings";
import { CRAWL_INDEX_LIMITS } from "@/lib/crawler/crawl-limits";
import { normalizeRootUrl } from "@/lib/crawler/crawl-html-utils";
import { readResponseTextWithinLimit } from "@/lib/crawler/crawl-response";
import { safeCrawlFetch } from "@/lib/crawler/url-safety";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { extractTextFromHtml } from "@icecore/shared/lib/html-utils";
import { logger } from "@icecore/shared/lib/logger";

interface IndexResult {
  success: boolean;
  error?: string;
  url?: string;
  title?: string;
}

export async function getIndexedUrlEmbedding(params: {
  workspaceId: string;
  companyId: string;
  url: string;
  title: string;
  content: string;
}) {
  if (!params.workspaceId?.trim()) throw new Error("workspaceId is required");
  const text = params.content.slice(0, CRAWL_INDEX_LIMITS.maxEmbedChars);
  const metadata = getCurrentEmbeddingMetadata("RETRIEVAL_DOCUMENT");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        cacheVersion: EMBEDDING_CACHE_VERSION,
        metadata,
        url: params.url,
        title: params.title,
        text: normalizeEmbeddingText(text),
      })
    )
    .digest("hex");
  const { data: existing, error } = await supabaseAdmin
    .from("kb_indexed_urls")
    .select("embedding, embedding_fingerprint")
    .eq("company_id", params.companyId)
    .eq("url", params.url)
    .maybeSingle();
  if (error) throw new Error("Cannot verify the existing URL embedding");
  const storedEmbedding =
    existing?.embedding_fingerprint === fingerprint
      ? parseStoredEmbedding(existing.embedding)
      : null;
  if (storedEmbedding) {
    return {
      embedding: storedEmbedding,
      embeddingFingerprint: fingerprint,
    };
  }
  const result = await getDocumentEmbeddingResult(text, {
    title: params.title,
    action: {
      workspaceId: params.workspaceId,
      actionId: `url-index:${fingerprint}`,
    },
  });
  if (
    result &&
    (!parseStoredEmbedding(result.embedding) ||
      result.provider !== metadata.embeddingProvider ||
      result.model !== metadata.embeddingModel ||
      result.taskType !== metadata.embeddingTaskType ||
      result.dimensions !== metadata.embeddingDimensions)
  ) {
    throw new Error("URL embedding result does not match its fingerprint");
  }
  return result
    ? { embedding: result.embedding, embeddingFingerprint: fingerprint }
    : null;
}

export async function indexExternalUrl(
  companyId: string,
  url: string,
  workspaceId: string
): Promise<IndexResult> {
  let normalizedUrl = url;
  try {
    if (!workspaceId?.trim())
      return { success: false, error: "workspaceId is required" };
    const { data: workspace, error: workspaceError } = await supabaseAdmin
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (workspaceError || !workspace) {
      return {
        success: false,
        error: "Workspace does not belong to the company",
      };
    }
    const parsedUrl = normalizeRootUrl(url);
    if (!parsedUrl) {
      return {
        success: false,
        error: "Invalid URL format. Must be a valid public HTTP/HTTPS URL.",
      };
    }
    normalizedUrl = parsedUrl.toString();

    logger.info(`[URL Indexer] Fetching URL: ${normalizedUrl}`);

    const response = await safeCrawlFetch(normalizedUrl, {
      timeoutMs: CRAWL_INDEX_LIMITS.pageFetchTimeoutMs,
      dnsTimeoutMs: CRAWL_INDEX_LIMITS.dnsLookupTimeoutMs,
      userAgent:
        "Airi.chat RAG Indexer/1.0 (https://airi.chat; support@airi.chat)",
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") || "";

    const html = await readResponseTextWithinLimit(
      response,
      CRAWL_INDEX_LIMITS.maxResponseBytes
    );

    const trimmedContent = html.trim();
    const lowerTrimmedContent = trimmedContent.toLowerCase();
    const isHtmlContent =
      lowerTrimmedContent.startsWith("<!doctype html") ||
      lowerTrimmedContent.startsWith("<html");

    if (!contentType.includes("text/html") && !isHtmlContent) {
      return {
        success: false,
        error: `Unsupported content type: ${contentType || "not specified"}. Only HTML pages are supported.`,
      };
    }

    const { title, description, contentText } = extractTextFromHtml(html, {
      maxLength: CRAWL_INDEX_LIMITS.maxAggregatedChars,
      removeNavFooter: true,
    });

    if (!contentText || contentText.length < 100) {
      return {
        success: false,
        error:
          "Insufficient content extracted. Page must have at least 100 characters of text.",
      };
    }

    logger.info(
      `[URL Indexer] Extracted ${contentText.length} characters from ${url}`
    );

    const embeddingResult = await getIndexedUrlEmbedding({
      workspaceId,
      companyId,
      url: normalizedUrl,
      title,
      content: contentText,
    });

    if (!embeddingResult?.embedding) {
      return {
        success: false,
        error: "Failed to generate embedding for content",
      };
    }

    logger.info(`[URL Indexer] Generated embedding for ${url}`);

    const { error: dbError } = await supabaseAdmin
      .from("kb_indexed_urls")
      .upsert(
        {
          company_id: companyId,
          url: normalizedUrl,
          title,
          description,
          content_text: contentText.slice(
            0,
            CRAWL_INDEX_LIMITS.maxAggregatedChars
          ),
          embedding: embeddingResult.embedding,
          embedding_fingerprint: embeddingResult.embeddingFingerprint,
          index_status: "indexed",
          last_indexed_at: new Date().toISOString(),
          error_message: null,
        },
        { onConflict: "company_id,url" }
      );

    if (dbError) {
      if (dbError.message?.includes("Maximum 5 indexed URLs")) {
        return {
          success: false,
          error: `Maximum ${CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany} indexed URLs per company. Please delete an existing URL before adding a new one.`,
        };
      }
      throw dbError;
    }

    logger.info(`[URL Indexer] Successfully indexed ${url}`);

    return {
      success: true,
      url: normalizedUrl,
      title,
    };
  } catch (error) {
    logger.error("[URL Indexer] Error", {
      error,
      url: normalizedUrl,
      companyId,
    });

    try {
      await supabaseAdmin.from("kb_indexed_urls").upsert(
        {
          company_id: companyId,
          url: normalizedUrl,
          index_status: "failed",
          error_message:
            error instanceof Error ? error.message : "Unknown error",
          last_indexed_at: new Date().toISOString(),
        },
        { onConflict: "company_id,url" }
      );
    } catch {}

    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to index URL",
    };
  }
}

export async function deleteIndexedUrl(
  companyId: string,
  urlId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabaseAdmin
      .from("kb_indexed_urls")
      .delete()
      .eq("id", urlId)
      .eq("company_id", companyId);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to delete URL",
    };
  }
}
