import type {
  CrawlWebsiteActivityInput,
  CrawlWebsiteActivityResult,
} from "@icecore/temporal";
import { airiWorkerLogger } from "./logging";
import { createWebRequire, readDefaultExport } from "./internal/module-interop";

const requireWeb = createWebRequire(import.meta.url);
const connectDB = readDefaultExport<() => Promise<unknown>>(
  requireWeb("../../../apps/web/src/lib/mongoose"),
);

type RunnerModule = {
  runWebsiteCrawl: (input: {
    workspaceId: string;
    websites?: string[];
    includeInstagram?: boolean;
    maxPagesPerSite?: number;
    maxCrawlMsPerSite?: number;
    maxIndexChars?: number;
  }) => Promise<CrawlWebsiteActivityResult>;
};

const runner = requireWeb(
  "../../../apps/web/src/lib/crawler/website-crawl-runner",
) as RunnerModule;

export async function executeCrawlWebsiteActivity(
  input: CrawlWebsiteActivityInput,
): Promise<CrawlWebsiteActivityResult> {
  if (input.contractVersion < 1 || input.contractVersion > 1) {
    throw new Error(
      `Unsupported crawl website contract version: ${input.contractVersion}`,
    );
  }

  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) {
    throw new Error("workspaceId is required");
  }

  await connectDB();

  airiWorkerLogger.info("website_crawl.activity_started", {
    workspaceId,
    websiteCount: input.websites?.length ?? 0,
    includeInstagram: Boolean(input.includeInstagram),
  });

  const result = await runner.runWebsiteCrawl({
    workspaceId,
    websites: input.websites,
    includeInstagram: input.includeInstagram,
    maxPagesPerSite: input.maxPagesPerSite,
    maxCrawlMsPerSite: input.maxCrawlMsPerSite,
    maxIndexChars: input.maxIndexChars,
  });

  airiWorkerLogger.info("website_crawl.activity_finished", {
    workspaceId,
    seedCount: result.seeds.length,
    canonicalSyncEnqueued: result.canonicalSyncEnqueued,
  });

  return result;
}
