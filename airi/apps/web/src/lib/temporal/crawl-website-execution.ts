import "server-only";

import { createHash } from "node:crypto";

import { CRAWL_WEBSITE_WORKFLOW_CONTRACT_VERSION } from "@icecore/temporal";

import {
  resolveEffectiveCrawlWebsiteSeeds,
  resolveCrawlBudget,
  type CrawlBudgetInput,
} from "@/lib/crawler/crawl-limits";

export type CrawlWebsiteExecutionInput = CrawlBudgetInput & {
  websites?: string[];
  includeInstagram?: boolean;
};

export function buildCrawlWebsiteExecutionFingerprint(
  input: CrawlWebsiteExecutionInput
): string {
  const canonical = JSON.stringify({
    contractVersion: CRAWL_WEBSITE_WORKFLOW_CONTRACT_VERSION,
    websites: resolveEffectiveCrawlWebsiteSeeds(input).sort(),
    includeInstagram: input.includeInstagram === true,
    ...resolveCrawlBudget(input),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildCrawlWebsiteExecutionId(
  input: CrawlWebsiteExecutionInput
): string {
  return `manual-${buildCrawlWebsiteExecutionFingerprint(input)}`;
}
