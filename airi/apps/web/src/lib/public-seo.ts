import {
  buildAiriProductLlmsTxt,
  PUBLIC_BRAND_NAME,
} from "@/lib/airi-product-context";
import type { MetadataRoute } from "next";

// Link previews are cached per URL by WhatsApp, Telegram and Facebook, so bump
// the version whenever the image changes.
export const DEFAULT_OG_IMAGE_PATH = "/og-whatsapp.jpg?v=20261021";
export const DEFAULT_OG_IMAGE_WIDTH = 1280;
export const DEFAULT_OG_IMAGE_HEIGHT = 672;
export const DEFAULT_OG_IMAGE_ALT =
  "airi.chat: good campaigns start a conversation. WhatsApp campaigns, answers from your sources, follow-ups and sales tracking.";

export const DEFAULT_SEO_KEYWORDS = [
  "WhatsApp marketing campaigns",
  "WhatsApp Business Platform",
  "WhatsApp Marketing Messages API",
  "official WhatsApp campaigns",
  "WhatsApp bulk campaigns",
  "WhatsApp marketing automation",
  "WhatsApp campaign automation",
  "WhatsApp templates",
  "WhatsApp Flows",
  "AI follow ups",
  "reply aware campaigns",
  "Meta Ads MCP",
  "WhatsApp MCP server",
  "customer engagement platform",
  "Instagram DM automation",
  PUBLIC_BRAND_NAME,
];

export const PRIVATE_ROBOTS_DISALLOW_PATHS = [
  "/panel",
  "/panel/",
  "/api",
  "/api/",
  "/auth",
  "/auth/",
  "/login",
  "/add-company",
  "/finish-profile",
  "/onboarding",
  "/setup",
  "/set-webhook",
  "/unauthorized",
  "/data-deletion",
];

export const PUBLIC_ROBOTS_ALLOW_PATHS = ["/", "/llms.txt", "/sitemap.xml"];

export { AI_SEARCH_CRAWLER_USER_AGENTS } from "./public-crawlers";

export type PublicMarketingRoute = {
  path: string;
  title: string;
  description: string;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  priority: MetadataRoute.Sitemap[number]["priority"];
  lastModified?: string;
};

export const PUBLIC_MARKETING_ROUTES: PublicMarketingRoute[] = [
  {
    path: "/whatsapp-templates",
    title: "WhatsApp template gallery",
    description:
      "Browse WhatsApp message examples by industry, goal and format, and try available demos from airi.chat on your own number.",
    changeFrequency: "weekly",
    priority: 0.9,
  },
  {
    path: "/whatsapp-marketing-delivery",
    title: "WhatsApp campaign delivery",
    description:
      "Why WhatsApp marketing messages fail (131049, 131050, 131026, 130429) and how airi.chat sends campaigns through Meta's Marketing Messages API with pre-send checks, opt-outs and frequency limits.",
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    path: "/meta-ads-mcp",
    title: "Meta Ads MCP in airi.chat",
    description:
      "The @meta skill in Airi chat reads Meta ad accounts through Meta's official Ads MCP server: results, benchmarks, anomalies and signal health. Changes need the user's confirmation.",
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    path: "/mcp",
    title: "Airi.chat MCP server",
    description:
      "Read-only MCP server at https://www.airi.chat/api/mcp for Claude Code, OpenAI Codex, Cursor and other MCP clients, authenticated with a workspace API key.",
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    path: "/",
    title: "WhatsApp campaigns, AI replies and follow-ups",
    description:
      "Homepage for airi.chat: official WhatsApp campaigns, AI replies and follow-ups, and the sales that follow, in one shared workspace.",
    changeFrequency: "weekly",
    priority: 1.0,
  },
  {
    path: "/llms.txt",
    title: "LLM-readable summary",
    description:
      "Plain-text summary of airi.chat for search engines, answer engines, and AI crawlers.",
    changeFrequency: "weekly",
    priority: 0.9,
  },
  {
    path: "/about",
    title: "About airi.chat",
    description:
      "Company, founders, and what airi.chat does for teams that sell through WhatsApp campaigns and customer chats.",
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    path: "/founders/aisulu",
    title: "Aisulu Kalshabekova",
    description: "Co-founder and CEO profile for airi.chat.",
    changeFrequency: "monthly",
    priority: 0.6,
  },
  {
    path: "/founders/samat",
    title: "Samat Kalshabekov",
    description: "Co-founder and CTO profile for airi.chat.",
    changeFrequency: "monthly",
    priority: 0.6,
  },
  {
    path: "/privacy",
    title: "Privacy Policy",
    description: "Privacy policy for airi.chat.",
    changeFrequency: "yearly",
    priority: 0.5,
    lastModified: "2026-10-21",
  },
  {
    path: "/terms",
    title: "Terms",
    description: "Terms and conditions for airi.chat.",
    changeFrequency: "yearly",
    priority: 0.5,
    lastModified: "2026-10-21",
  },
  {
    path: "/refunds",
    title: "Refund Policy",
    description: "Refund policy for unused airi.chat subscription days.",
    changeFrequency: "yearly",
    priority: 0.5,
    lastModified: "2026-06-26",
  },
  {
    path: "/security",
    title: "Security",
    description: "Security practices for the airi.chat SaaS platform.",
    changeFrequency: "yearly",
    priority: 0.5,
    lastModified: "2025-01-29",
  },
];

export function getPublicBaseUrl(): string {
  return "https://www.airi.chat".replace(/\/$/, "");
}

export function getPublicUrl(path = "/"): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getPublicBaseUrl()}${normalizedPath === "/" ? "" : normalizedPath}`;
}

export function buildLlmsTxt(): string {
  return buildAiriProductLlmsTxt({
    baseUrl: getPublicBaseUrl(),
    routes: PUBLIC_MARKETING_ROUTES,
  });
}
