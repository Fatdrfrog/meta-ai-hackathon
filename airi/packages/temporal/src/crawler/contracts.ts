/** Must match the exported workflow function name in `apps/temporal-worker/src/workflows`. */
export const CRAWL_WEBSITE_WORKFLOW = "crawlWebsiteWorkflow";
export const CRAWL_WEBSITE_WORKFLOW_CONTRACT_VERSION = 1;

export const CRAWL_WEBSITE_ACTIVITY = "crawlWebsiteActivity";

export type CrawlWebsiteSeedKind = "website" | "instagram";

export type CrawlWebsitePayload = {
  contractVersion: number;
  workspaceId: string;
  /** Website root URLs the customer entered during onboarding. */
  websites?: string[];
  /** When true, the connected Instagram source (if any) is crawled too. */
  includeInstagram?: boolean;
  /** Max pages followed per website seed (defaults applied in the runner). */
  maxPagesPerSite?: number;
  /** Max wall-clock milliseconds spent per website seed. */
  maxCrawlMsPerSite?: number;
  /** Max extracted text characters stored per seed before chunk sync. */
  maxIndexChars?: number;
};

export type CrawlWebsiteActivityInput = CrawlWebsitePayload;

export type CrawlWebsiteSeedResult = {
  kind: CrawlWebsiteSeedKind;
  /** Root URL for websites, profile/permalink for Instagram. */
  source: string;
  status: "completed" | "failed" | "skipped";
  pagesIndexed: number;
  charsIndexed: number;
  errorMessage?: string;
};

export type CrawlWebsiteActivityResult = {
  workspaceId: string;
  seeds: CrawlWebsiteSeedResult[];
  /** Whether a canonical sync was enqueued after ingestion. */
  canonicalSyncEnqueued: boolean;
};

export type CrawlWebsiteWorkflowInput = CrawlWebsitePayload;

export type CrawlWebsiteWorkflowResult = CrawlWebsiteActivityResult;
