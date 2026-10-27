import { CRAWL_WEBSITE_ACTIVITY } from "@icecore/temporal";
import { executeCrawlWebsiteActivity } from "@icecore/airi-runtime";

export const crawlWebsiteActivityHandlers = {
  [CRAWL_WEBSITE_ACTIVITY]: executeCrawlWebsiteActivity,
};
