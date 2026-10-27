import type { MetadataRoute } from "next";
import {
  AI_SEARCH_CRAWLER_USER_AGENTS,
  PRIVATE_ROBOTS_DISALLOW_PATHS,
  PUBLIC_ROBOTS_ALLOW_PATHS,
  getPublicBaseUrl,
} from "@/lib/public-seo";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getPublicBaseUrl();
  const publicRule = (userAgent: string) => ({
    userAgent,
    allow: PUBLIC_ROBOTS_ALLOW_PATHS,
    disallow: PRIVATE_ROBOTS_DISALLOW_PATHS,
  });

  return {
    rules: [publicRule("*"), ...AI_SEARCH_CRAWLER_USER_AGENTS.map(publicRule)],
    host: baseUrl,
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
