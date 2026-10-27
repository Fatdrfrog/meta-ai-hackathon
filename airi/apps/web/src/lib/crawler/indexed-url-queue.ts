import "server-only";

import { CRAWL_INDEX_LIMITS } from "@/lib/crawler/crawl-limits";
import { normalizeRootUrl } from "@/lib/crawler/crawl-html-utils";

export type IndexedUrlClient = {
  from: (table: "kb_indexed_urls") => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string
      ) => PromiseLike<{
        data: IndexedUrlStatusRow[] | null;
        error: { message?: string } | null;
      }>;
    };
    upsert: (
      values: unknown,
      options: { onConflict: string }
    ) => PromiseLike<{ error: { message?: string } | null }>;
  };
};

export type IndexedUrlStatusRow = {
  url: string;
  index_status: string | null;
  last_indexed_at?: string | null;
};

function createIndexedUrlQueueError(
  error: { message?: string } | Error,
  fallbackMessage: string
): Error {
  const message =
    error instanceof Error
      ? error.message
      : typeof error.message === "string" && error.message.trim()
        ? error.message
        : fallbackMessage;
  const wrapped = new Error(message);
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

function normalizeIndexedUrl(rawUrl: string): string {
  return normalizeRootUrl(rawUrl)?.toString() || rawUrl;
}

function isFreshPendingRow(
  row: IndexedUrlStatusRow,
  nowMs = Date.now()
): boolean {
  if (row.index_status !== "pending") return false;
  const lastIndexedAtMs = row.last_indexed_at
    ? Date.parse(row.last_indexed_at)
    : Number.NaN;
  if (!Number.isFinite(lastIndexedAtMs)) return false;
  return nowMs - lastIndexedAtMs <= CRAWL_INDEX_LIMITS.duplicatePendingWindowMs;
}

export async function fetchIndexedUrlStatusRows(
  client: IndexedUrlClient,
  companyId: string
): Promise<IndexedUrlStatusRow[]> {
  const { data, error } = await client
    .from("kb_indexed_urls")
    .select("url,index_status,last_indexed_at")
    .eq("company_id", companyId);

  if (error) {
    throw createIndexedUrlQueueError(
      error,
      "Failed to fetch indexed URL status rows"
    );
  }
  return data || [];
}

export function countIndexedUrlSlots(params: {
  websites: string[];
  existingRows: IndexedUrlStatusRow[];
}): { activeCount: number; newWebsiteCount: number } {
  const activeUrls = new Set<string>();
  for (const row of params.existingRows) {
    if (row.index_status !== "failed") {
      activeUrls.add(normalizeIndexedUrl(row.url));
    }
  }

  const newWebsiteCount = params.websites.filter(
    website => !activeUrls.has(website)
  ).length;

  return {
    activeCount: activeUrls.size,
    newWebsiteCount,
  };
}

export function findFreshPendingIndexedUrls(params: {
  websites: string[];
  existingRows: IndexedUrlStatusRow[];
  nowMs?: number;
}): Set<string> {
  const requested = new Set(params.websites.map(normalizeIndexedUrl));
  const freshPending = new Set<string>();

  for (const row of params.existingRows) {
    const url = normalizeIndexedUrl(row.url);
    if (requested.has(url) && isFreshPendingRow(row, params.nowMs)) {
      freshPending.add(url);
    }
  }

  return freshPending;
}

export function buildIndexedUrlLimitError(params: {
  activeCount: number;
  requestedNewCount: number;
}) {
  return {
    code: "indexed_url_limit_exceeded" as const,
    error: `Maximum ${CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany} indexed URLs per company. Delete an existing URL or reduce this crawl.`,
    limit: CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany,
    activeCount: params.activeCount,
    requestedNewCount: params.requestedNewCount,
  };
}

export async function markIndexedUrlRowsPending(params: {
  client: IndexedUrlClient;
  companyId: string;
  websites: string[];
}) {
  if (params.websites.length === 0) return;

  const now = new Date().toISOString();
  const rows = params.websites.map(url => ({
    company_id: params.companyId,
    url,
    title: null,
    description: null,
    index_status: "pending",
    error_message: null,
    last_indexed_at: now,
  }));

  const { error } = await params.client
    .from("kb_indexed_urls")
    .upsert(rows, { onConflict: "company_id,url" });

  if (error) {
    throw createIndexedUrlQueueError(
      error,
      "Failed to mark indexed URLs pending"
    );
  }
}

export async function markIndexedUrlRowsFailed(params: {
  client: IndexedUrlClient;
  companyId: string;
  websites: string[];
  message: string;
}) {
  if (params.websites.length === 0) return;

  const now = new Date().toISOString();
  const { error } = await params.client.from("kb_indexed_urls").upsert(
    params.websites.map(url => ({
      company_id: params.companyId,
      url,
      index_status: "failed",
      error_message: params.message,
      last_indexed_at: now,
    })),
    { onConflict: "company_id,url" }
  );

  if (error) {
    throw createIndexedUrlQueueError(
      error,
      "Failed to mark indexed URLs failed"
    );
  }
}
