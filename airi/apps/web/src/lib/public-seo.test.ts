import robots from "@/app/robots";
import { GET as getLlmsTxt } from "@/app/llms.txt/route";
import { AIRI_PRODUCT_CONTEXT_VERSION } from "@/lib/airi-product-context";
import { createMetadata } from "@/lib/seo";
import {
  AI_SEARCH_CRAWLER_USER_AGENTS,
  extendHtmlLimitedBots,
} from "@/lib/public-crawlers";
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/is-bot";
import { shouldServeStreamingMetadata } from "next/dist/server/lib/streaming-metadata";

describe("public SEO contract", () => {
  it("serves complete metadata to allowed AI crawlers and preserves Next's preview bots", () => {
    const pattern = extendHtmlLimitedBots(HTML_LIMITED_BOT_UA_RE).source;
    for (const agent of [
      ...AI_SEARCH_CRAWLER_USER_AGENTS,
      "WhatsApp/2.0",
      "Slackbot-LinkExpanding 1.0",
      "facebookexternalhit/1.1",
      "Twitterbot/1.0",
      "DuckDuckBot/1.0",
    ]) {
      expect(shouldServeStreamingMetadata(agent, pattern)).toBe(false);
    }
    expect(
      shouldServeStreamingMetadata("Mozilla/5.0 Mobile Safari", pattern)
    ).toBe(true);
  });
  it("supports explicit language alternates without changing default pages", () => {
    const metadata = createMetadata({
      title: "Localized",
      description: "Localized description",
      path: "/whatsapp-templates?locale=kz",
      locale: "kk_KZ",
      alternateLocales: ["en_US", "ru_RU"],
      languages: { kk: "https://www.airi.chat/whatsapp-templates?locale=kz" },
    });
    expect(metadata.openGraph?.locale).toBe("kk_KZ");
    expect(metadata.alternates?.languages).toHaveProperty("kk");
    expect(
      createMetadata({ title: "Default", description: "Default" }).openGraph
        ?.locale
    ).toBe("en_US");
  });
  it("positions default metadata on WhatsApp campaigns, not customer support", () => {
    const metadata = createMetadata({
      title: "Test",
      description: "Test description",
    });

    expect(metadata.keywords).toEqual(
      expect.arrayContaining([
        "WhatsApp marketing campaigns",
        "WhatsApp Business Platform",
        "WhatsApp Marketing Messages API",
        "Meta Ads MCP",
      ])
    );
    const keywords = (metadata.keywords as string[]).join(" | ");
    expect(keywords).not.toMatch(
      /customer support|customer service|helpdesk|conversation intelligence|support widget/i
    );
  });

  it("uses a WhatsApp-sized Open Graph image by default", () => {
    const metadata = createMetadata({
      title: "Test",
      description: "Test description",
    });

    expect(metadata.openGraph?.images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://www.airi.chat/og-whatsapp.jpg?v=20261021",
          width: 1280,
          height: 672,
        }),
      ])
    );
    expect(metadata.twitter?.images).toEqual([
      "https://www.airi.chat/og-whatsapp.jpg?v=20261021",
    ]);
  });

  it("allows major AI search crawlers while keeping private product surfaces blocked", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const privatePaths = ["/panel", "/api", "/auth", "/login"];
    const crawlerAgents = [
      "OAI-SearchBot",
      "GPTBot",
      "ChatGPT-User",
      "ClaudeBot",
      "Claude-SearchBot",
      "PerplexityBot",
      "Google-Extended",
      "Bingbot",
    ];

    for (const userAgent of crawlerAgents) {
      const rule = rules.find(item => item.userAgent === userAgent);
      expect(rule).toBeDefined();
      expect(rule?.allow).toEqual(expect.arrayContaining(["/", "/llms.txt"]));
      expect(rule?.disallow).toEqual(expect.arrayContaining(privatePaths));
      expect(rule?.disallow).not.toContain("/intercom/");
    }
  });

  it("serves an llms.txt summary with product category, integrations, and source URLs", async () => {
    const response = await getLlmsTxt();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("# airi.chat");
    expect(body).toContain(`Version: ${AIRI_PRODUCT_CONTEXT_VERSION}`);
    expect(body).toContain("WhatsApp marketing campaign platform");
    expect(body).toContain("Marketing Messages API");
    expect(body).toContain("WhatsApp Business Platform");
    expect(body).toContain("WhatsApp Flows");
    expect(body).toContain("https://www.airi.chat/whatsapp-templates");
    expect(body).toContain("bulk campaigns");
    expect(body).toContain("Canva");
    expect(body).toContain("ElevenLabs");
    expect(body).toContain("Telegram");
    expect(body).toContain("Instagram");
    expect(body).toContain(
      "helps teams build useful bulk campaigns and follow-ups from customer chats and knowledge base context"
    );
    expect(body).not.toContain("https://www.airi.chat/pricing");
    expect(body).toContain("support@airi.chat");
    expect(body).not.toContain("helps building");
    expect(body).not.toContain("knoweldge");
    expect(body).not.toContain("IceCoreAI");
    expect(body).not.toContain("IceCore AI");
  });

  it("points answer engines at the product pages and the read-only MCP server", async () => {
    const body = await (await getLlmsTxt()).text();

    for (const path of [
      "/whatsapp-marketing-delivery",
      "/meta-ads-mcp",
      "/mcp",
    ]) {
      expect(body).toContain(`https://www.airi.chat${path} - `);
    }
    expect(body).toContain("https://www.airi.chat/api/mcp");
    expect(body).toMatch(/Airi\.chat MCP server is read-only/);
  });

  it("keeps support-desk positioning and removed docs pages out of llms.txt", async () => {
    const body = await (await getLlmsTxt()).text();

    expect(body).not.toMatch(
      /customer support platform|helpdesk|conversation intelligence|\bCSAT\b|\bNPS\b|\bcoach|support managers|CX leaders/i
    );
    for (const removedPath of [
      "/integrations",
      "/knowledge-base",
      "/get-started",
      "/performance",
    ]) {
      expect(body).not.toContain(`https://www.airi.chat${removedPath}`);
    }
  });
});
