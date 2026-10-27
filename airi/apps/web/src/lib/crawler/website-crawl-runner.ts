import "server-only";

import { extractTextFromHtml } from "@icecore/shared/lib/html-utils";
import { logger } from "@icecore/shared/lib/logger";
import type {
  CrawlWebsiteActivityResult,
  CrawlWebsiteSeedResult,
} from "@icecore/temporal";

import { getIndexedUrlEmbedding } from "@/lib/kb/url-indexer";
import {
  extractSameOriginLinks,
  extractSitemapLocs,
  normalizeRootUrl,
  rankCrawlUrls,
} from "@/lib/crawler/crawl-html-utils";
import {
  CRAWL_INDEX_LIMITS,
  resolveEffectiveCrawlWebsiteSeeds,
  resolveCrawlBudget,
  type CrawlBudget,
} from "@/lib/crawler/crawl-limits";
import { readResponseTextWithinLimit } from "@/lib/crawler/crawl-response";
import { safeCrawlFetch } from "@/lib/crawler/url-safety";
import { decryptMaybeString } from "@/lib/crypto";
import { fetchSourceWithCredentials } from "@/lib/sources/utils";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveInstagramGraphBase } from "@icecore/shared/lib/meta/graph-version";

const CRAWLER_USER_AGENT =
  "Airi.chat RAG Indexer/1.0 (https://airi.chat; support@airi.chat)";

export type RunWebsiteCrawlInput = {
  workspaceId: string;
  websites?: string[];
  includeInstagram?: boolean;
  maxPagesPerSite?: number;
  maxCrawlMsPerSite?: number;
  maxIndexChars?: number;
};

type FetchedPage = {
  url: string;
  title: string;
  description: string;
  contentText: string;
  html: string;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runWorker()
    )
  );

  return results;
}

async function fetchAndExtractPage(
  url: string,
  budget: CrawlBudget
): Promise<FetchedPage | null> {
  try {
    // SSRF-hardened: validates the host (literal + DNS) and every redirect hop.
    const response = await safeCrawlFetch(url, {
      timeoutMs: CRAWL_INDEX_LIMITS.pageFetchTimeoutMs,
      dnsTimeoutMs: CRAWL_INDEX_LIMITS.dnsLookupTimeoutMs,
      userAgent: CRAWLER_USER_AGENT,
    });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    const html = await readResponseTextWithinLimit(
      response,
      CRAWL_INDEX_LIMITS.maxResponseBytes
    );
    const lower = html.trim().toLowerCase();
    const looksHtml =
      lower.startsWith("<!doctype html") || lower.startsWith("<html");
    if (!contentType.includes("text/html") && !looksHtml) return null;

    const { title, description, contentText } = extractTextFromHtml(html, {
      maxLength: budget.maxIndexChars,
      removeNavFooter: true,
    });
    return { url, title, description, contentText, html };
  } catch {
    return null;
  }
}

async function fetchSitemapUrls(root: URL): Promise<string[]> {
  try {
    const sitemapUrl = new URL("/sitemap.xml", root.origin).toString();
    const response = await safeCrawlFetch(sitemapUrl, {
      timeoutMs: CRAWL_INDEX_LIMITS.sitemapFetchTimeoutMs,
      dnsTimeoutMs: CRAWL_INDEX_LIMITS.dnsLookupTimeoutMs,
      userAgent: CRAWLER_USER_AGENT,
    });
    if (!response.ok) return [];
    const xml = await readResponseTextWithinLimit(
      response,
      CRAWL_INDEX_LIMITS.maxResponseBytes
    );
    return extractSitemapLocs(xml, root.origin);
  } catch {
    return [];
  }
}

async function crawlWebsite(
  rootRaw: string,
  budget: CrawlBudget
): Promise<{
  title: string;
  description: string;
  content: string;
  pagesCrawled: number;
} | null> {
  const root = normalizeRootUrl(rootRaw);
  if (!root) return null;

  const limit = budget.maxPagesPerSite;
  const deadlineAt = Date.now() + budget.maxCrawlMsPerSite;
  const visited = new Set<string>();
  const queued = new Set<string>([root.toString()]);
  const queue: string[] = [root.toString()];

  // Seed additional URLs from sitemap when available (best-effort).
  const sitemapUrls = rankCrawlUrls(await fetchSitemapUrls(root), root);
  for (const u of sitemapUrls.slice(0, limit)) {
    if (!queued.has(u)) {
      queued.add(u);
      queue.push(u);
    }
  }

  const pages: FetchedPage[] = [];

  while (queue.length > 0 && pages.length < limit && Date.now() < deadlineAt) {
    const batch: string[] = [];
    while (
      queue.length > 0 &&
      batch.length < CRAWL_INDEX_LIMITS.crawlerConcurrency &&
      pages.length + batch.length < limit
    ) {
      const next = queue.shift();
      if (!next || visited.has(next)) continue;
      visited.add(next);
      batch.push(next);
    }

    if (batch.length === 0) continue;

    const fetched = await Promise.all(
      batch.map(url => fetchAndExtractPage(url, budget))
    );

    for (const page of fetched) {
      if (!page || page.contentText.length < 100) continue;
      pages.push(page);

      if (pages.length >= limit || Date.now() >= deadlineAt) continue;
      const discovered = rankCrawlUrls(
        extractSameOriginLinks(page.html, root),
        root
      );
      for (const link of discovered) {
        if (!visited.has(link) && !queued.has(link)) {
          queued.add(link);
          queue.push(link);
        }
      }
    }
  }

  if (pages.length === 0) return null;

  const rootPage = pages[0];
  const title = rootPage.title || root.hostname;
  const description = rootPage.description || "";

  let aggregated = "";
  for (const page of pages) {
    const heading = page.title ? page.title : page.url;
    const block = `## ${heading}\n${page.url}\n\n${page.contentText}\n\n`;
    if (aggregated.length + block.length > budget.maxIndexChars) {
      aggregated += block.slice(0, budget.maxIndexChars - aggregated.length);
      break;
    }
    aggregated += block;
  }

  return {
    title,
    description,
    content: aggregated.trim(),
    pagesCrawled: pages.length,
  };
}

async function storeIndexedUrlRow(params: {
  workspaceId: string;
  companyId: string;
  url: string;
  title: string;
  description: string;
  content: string;
  maxIndexChars: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const embeddingResult = await getIndexedUrlEmbedding(params);

    if (!embeddingResult?.embedding) {
      return { ok: false, error: "Failed to generate embedding" };
    }

    const { error } = await supabaseAdmin.from("kb_indexed_urls").upsert(
      {
        company_id: params.companyId,
        url: params.url,
        title: params.title,
        description: params.description,
        content_text: params.content.slice(0, params.maxIndexChars),
        embedding: embeddingResult.embedding,
        embedding_fingerprint: embeddingResult.embeddingFingerprint,
        index_status: "indexed",
        last_indexed_at: new Date().toISOString(),
        error_message: null,
      },
      { onConflict: "company_id,url" }
    );

    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown storage error",
    };
  }
}

async function markIndexedUrlFailed(params: {
  companyId: string;
  url: string;
  errorMessage: string;
}): Promise<void> {
  try {
    await supabaseAdmin.from("kb_indexed_urls").upsert(
      {
        company_id: params.companyId,
        url: params.url,
        index_status: "failed",
        error_message: params.errorMessage,
        last_indexed_at: new Date().toISOString(),
      },
      { onConflict: "company_id,url" }
    );
  } catch (error) {
    logger.error("[Website Crawl] Failed to mark indexed URL failed", error, {
      companyId: params.companyId,
      url: params.url,
    });
  }
}

function resolveInstagramAccountId(
  authMethod: string,
  credentials: Record<string, unknown>
): string {
  const scopedId = String(credentials.instagram_scoped_id || "").trim();
  const businessId = String(
    credentials.instagram_business_account_id || ""
  ).trim();
  if (authMethod === "instagram_business_login") {
    return scopedId || businessId;
  }
  return businessId || scopedId;
}

async function crawlInstagram(workspaceId: string): Promise<{
  source: string;
  title: string;
  description: string;
  content: string;
} | null> {
  const source = await fetchSourceWithCredentials(undefined, "instagram", {
    workspace_id: workspaceId,
  });
  if (!source) return null;

  const creds = source.credentials as Record<string, unknown>;
  const token = decryptMaybeString(creds.page_access_token);
  const authMethod = String(creds.auth_method || "");
  const instagramId = resolveInstagramAccountId(authMethod, creds);
  if (!token || !instagramId) return null;

  const username = String(creds.username || "").trim();
  const profileUrl = username
    ? `https://www.instagram.com/${username}`
    : `instagram:${instagramId}`;

  const sections: string[] = [];
  const biography = String(creds.biography || "").trim();
  const name = String(creds.name || "").trim();
  const category = String(creds.category_name || "").trim();
  const website = String(creds.website || "").trim();

  const profileLines = [
    name ? `Name: ${name}` : "",
    username ? `Username: @${username}` : "",
    category ? `Category: ${category}` : "",
    website ? `Website: ${website}` : "",
    biography ? `Bio: ${biography}` : "",
  ].filter(Boolean);
  if (profileLines.length > 0) {
    sections.push(`## Instagram profile\n${profileLines.join("\n")}`);
  }

  // Fetch recent media captions (best-effort).
  try {
    const graphBase = resolveInstagramGraphBase(authMethod);
    const mediaUrl = new URL(
      `${graphBase}/${encodeURIComponent(instagramId)}/media`
    );
    mediaUrl.searchParams.set(
      "fields",
      "caption,permalink,timestamp,media_type"
    );
    mediaUrl.searchParams.set(
      "limit",
      String(CRAWL_INDEX_LIMITS.maxInstagramMedia)
    );
    mediaUrl.searchParams.set("access_token", token);

    const response = await fetch(mediaUrl.toString(), { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        data?: Array<{ caption?: string; permalink?: string }>;
      };
      const captions = (payload.data || [])
        .map(item => String(item.caption || "").trim())
        .filter(Boolean);
      if (captions.length > 0) {
        sections.push(`## Recent posts\n${captions.join("\n\n")}`);
      }
    }
  } catch (error) {
    logger.error("[Website Crawl] Instagram media fetch failed", error);
  }

  if (sections.length === 0) return null;

  const content = sections
    .join("\n\n")
    .slice(0, CRAWL_INDEX_LIMITS.maxAggregatedChars);
  return {
    source: profileUrl,
    title: name || username || "Instagram",
    description: biography.slice(0, 300),
    content,
  };
}

/**
 * Crawls customer-provided websites + (optionally) the connected Instagram
 * profile and stores aggregated text into `kb_indexed_urls`.
 *
 * Canonical chunk sync is intentionally launched by the Temporal workflow after
 * this activity so the crawl/index step can finish fast.
 */
export async function runWebsiteCrawl(
  input: RunWebsiteCrawlInput
): Promise<CrawlWebsiteActivityResult> {
  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  const { data: workspace } = await supabaseAdmin
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle();

  const companyId = (workspace as { company_id?: string } | null)?.company_id;
  if (!companyId) {
    throw new Error(`Workspace ${workspaceId} has no company_id`);
  }
  const resolvedCompanyId: string = companyId;

  const budget = resolveCrawlBudget(input);
  const seeds: CrawlWebsiteSeedResult[] = [];

  // De-duplicate website seeds and respect the kb_indexed_urls per-company cap
  // by aggregating each site into a single row (websites + Instagram <= 5).
  const websites = resolveEffectiveCrawlWebsiteSeeds(input);

  async function processWebsiteSeed(
    website: string
  ): Promise<CrawlWebsiteSeedResult> {
    const root = normalizeRootUrl(website);
    if (!root) {
      return {
        kind: "website",
        source: website,
        status: "failed",
        pagesIndexed: 0,
        charsIndexed: 0,
        errorMessage: "Invalid URL",
      };
    }

    try {
      const crawled = await crawlWebsite(website, budget);
      if (!crawled || crawled.content.length < 100) {
        await markIndexedUrlFailed({
          companyId: resolvedCompanyId,
          url: root.toString(),
          errorMessage: "No indexable content found",
        });
        return {
          kind: "website",
          source: root.toString(),
          status: "failed",
          pagesIndexed: 0,
          charsIndexed: 0,
          errorMessage: "No indexable content found",
        };
      }

      const stored = await storeIndexedUrlRow({
        workspaceId,
        companyId: resolvedCompanyId,
        url: root.toString(),
        title: crawled.title,
        description: crawled.description,
        content: crawled.content,
        maxIndexChars: budget.maxIndexChars,
      });

      if (!stored.ok) {
        await markIndexedUrlFailed({
          companyId: resolvedCompanyId,
          url: root.toString(),
          errorMessage: stored.error || "Failed to store indexed content",
        });
      }

      return {
        kind: "website",
        source: root.toString(),
        status: stored.ok ? "completed" : "failed",
        pagesIndexed: stored.ok ? crawled.pagesCrawled : 0,
        charsIndexed: stored.ok ? crawled.content.length : 0,
        errorMessage: stored.error,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Crawl failed";
      await markIndexedUrlFailed({
        companyId: resolvedCompanyId,
        url: root.toString(),
        errorMessage,
      });
      return {
        kind: "website",
        source: root.toString(),
        status: "failed",
        pagesIndexed: 0,
        charsIndexed: 0,
        errorMessage,
      };
    }
  }

  const websiteSeeds = await mapWithConcurrency(
    websites,
    CRAWL_INDEX_LIMITS.websiteConcurrency,
    website => processWebsiteSeed(website)
  );
  seeds.push(...websiteSeeds);

  if (input.includeInstagram) {
    try {
      const ig = await crawlInstagram(workspaceId);
      if (ig && ig.content.length >= 50) {
        const stored = await storeIndexedUrlRow({
          workspaceId,
          companyId: resolvedCompanyId,
          url: ig.source,
          title: ig.title,
          description: ig.description,
          content: ig.content,
          maxIndexChars: budget.maxIndexChars,
        });
        seeds.push({
          kind: "instagram",
          source: ig.source,
          status: stored.ok ? "completed" : "failed",
          pagesIndexed: stored.ok ? 1 : 0,
          charsIndexed: stored.ok ? ig.content.length : 0,
          errorMessage: stored.error,
        });
      } else {
        seeds.push({
          kind: "instagram",
          source: "instagram",
          status: "skipped",
          pagesIndexed: 0,
          charsIndexed: 0,
          errorMessage: "No connected Instagram source or no content",
        });
      }
    } catch (error) {
      seeds.push({
        kind: "instagram",
        source: "instagram",
        status: "failed",
        pagesIndexed: 0,
        charsIndexed: 0,
        errorMessage:
          error instanceof Error ? error.message : "Instagram crawl failed",
      });
    }
  }

  return {
    workspaceId,
    seeds,
    canonicalSyncEnqueued: false,
  };
}
