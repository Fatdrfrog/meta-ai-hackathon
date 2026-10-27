/** Shared by robots.txt and Next configuration without application imports. */
export const AI_SEARCH_CRAWLER_USER_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "GPTBot",
  "Claude-SearchBot",
  "Claude-User",
  "ClaudeBot",
  "PerplexityBot",
  "Perplexity-User",
  "Googlebot",
  "Google-Extended",
  "Bingbot",
  "Applebot",
  "Applebot-Extended",
  "CCBot",
];

/** Preserve Next's installed defaults while including our allowed AI crawlers. */
export function extendHtmlLimitedBots(defaultPattern: RegExp): RegExp {
  const agents = AI_SEARCH_CRAWLER_USER_AGENTS.map(agent =>
    agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`${defaultPattern.source}|${agents.join("|")}`, "i");
}
