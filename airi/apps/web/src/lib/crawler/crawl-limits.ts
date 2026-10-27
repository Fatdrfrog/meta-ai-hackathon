import { normalizeRootUrl } from "@/lib/crawler/crawl-html-utils";

export const CRAWL_INDEX_LIMITS = {
  maxIndexedUrlsPerCompany: 5,
  maxWebsitesPerRequest: 4,
  defaultMaxPagesPerSite: 3,
  hardMaxPagesPerSite: 8,
  defaultCrawlMsPerSite: 12_000,
  hardCrawlMsPerSite: 45_000,
  pageFetchTimeoutMs: 6_000,
  sitemapFetchTimeoutMs: 2_500,
  dnsLookupTimeoutMs: 2_500,
  maxResponseBytes: 750_000,
  maxAggregatedChars: 24_000,
  maxEmbedChars: 8_000,
  maxInstagramMedia: 20,
  crawlerConcurrency: 3,
  websiteConcurrency: 2,
  duplicatePendingWindowMs: 2 * 60_000,
} as const;

export type CrawlBudgetInput = {
  maxPagesPerSite?: number | null;
  maxCrawlMsPerSite?: number | null;
  maxIndexChars?: number | null;
};

export type CrawlBudget = {
  maxPagesPerSite: number;
  maxCrawlMsPerSite: number;
  maxIndexChars: number;
};

function clampPositiveInt(
  value: number | null | undefined,
  fallback: number,
  hardMax: number
): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(1, Math.floor(numeric)), hardMax);
}

export function resolveCrawlBudget(input: CrawlBudgetInput): CrawlBudget {
  return {
    maxPagesPerSite: clampPositiveInt(
      input.maxPagesPerSite,
      CRAWL_INDEX_LIMITS.defaultMaxPagesPerSite,
      CRAWL_INDEX_LIMITS.hardMaxPagesPerSite
    ),
    maxCrawlMsPerSite: clampPositiveInt(
      input.maxCrawlMsPerSite,
      CRAWL_INDEX_LIMITS.defaultCrawlMsPerSite,
      CRAWL_INDEX_LIMITS.hardCrawlMsPerSite
    ),
    maxIndexChars: clampPositiveInt(
      input.maxIndexChars,
      CRAWL_INDEX_LIMITS.maxAggregatedChars,
      CRAWL_INDEX_LIMITS.maxAggregatedChars
    ),
  };
}

export function normalizeCrawlWebsiteSeeds(
  rawWebsites: string[],
  maxWebsites: number = CRAWL_INDEX_LIMITS.maxWebsitesPerRequest
): string[] {
  const normalized = new Set<string>();

  for (const website of rawWebsites) {
    const root = normalizeRootUrl(website);
    if (!root) continue;
    normalized.add(root.toString());
    if (normalized.size >= maxWebsites) break;
  }

  return Array.from(normalized);
}

export function resolveEffectiveCrawlWebsiteSeeds(input: {
  websites?: string[];
  includeInstagram?: boolean;
}): string[] {
  return normalizeCrawlWebsiteSeeds(
    input.websites ?? [],
    input.includeInstagram
      ? CRAWL_INDEX_LIMITS.maxWebsitesPerRequest
      : CRAWL_INDEX_LIMITS.maxIndexedUrlsPerCompany
  );
}
