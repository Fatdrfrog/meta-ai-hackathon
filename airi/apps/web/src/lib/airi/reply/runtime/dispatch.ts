import { normalizeHttpUrlForRag } from "@/lib/airi/rag/http-url-normalize";
import type { WorkspaceBotRuntimeSettings } from "@/lib/airi/workspace-bot-contract";
import { escapeRegExp } from "@/lib/regex-utils";
import type { Channel } from "@/types/models";

const KB_ARTICLE_LINKS_LABELS: Record<string, string> = {
  en: "Learn more",
  ru: "Подробнее",
  kz: "Толығырақ",
  uz: "Batafsil",
};

// Matches the trailing block appendKbArticleLinksToReply writes:
// "\n\n<label>:\n1. title: url\n2. title: url".
const KB_ARTICLE_LINKS_FOOTER = new RegExp(
  String.raw`\n\n(?:` +
    Object.values(KB_ARTICLE_LINKS_LABELS).map(escapeRegExp).join("|") +
    String.raw`):\n(?:\d+\. [^\n]*(?:\n|$))+$`,
  "u"
);

function kbArticleLinksAllowedForChannel(
  channel: Channel | undefined,
  sendKbArticleLinksToUserChannels: boolean | undefined
): boolean {
  if (channel === "web_widget") return true;
  return Boolean(sendKbArticleLinksToUserChannels);
}

export function shouldAttachKbArticleLinks(params: {
  channel: Channel;
  workspaceBotSettings: WorkspaceBotRuntimeSettings;
}): boolean {
  return kbArticleLinksAllowedForChannel(
    params.channel,
    params.workspaceBotSettings.sendKbArticleLinksToUserChannels
  );
}

/**
 * Same policy as {@link shouldAttachKbArticleLinks};
 * `channel` undefined → not widget, use setting only.
 */
export function resolveAttachKbArticlePageLinks(params: {
  channel: Channel | undefined;
  sendKbArticleLinksToUserChannels: boolean | undefined;
}): boolean {
  return kbArticleLinksAllowedForChannel(
    params.channel,
    params.sendKbArticleLinksToUserChannels
  );
}

export function appendKbArticleLinksToReply(params: {
  reply: string;
  articleLinks?: Array<{ url: string; title: string }>;
  language: string;
}): string {
  const baseReply = (params.reply || "").trim();
  const links = Array.isArray(params.articleLinks)
    ? params.articleLinks
        .filter(
          link =>
            typeof link?.url === "string" &&
            link.url.trim().length > 0 &&
            typeof link?.title === "string" &&
            link.title.trim().length > 0
        )
        .slice(0, 5)
    : [];

  if (links.length === 0) {
    return baseReply;
  }

  const uniqueLinks = Array.from(
    new Map(
      links.map(link => {
        const trimmed = link.url.trim();
        const key = normalizeHttpUrlForRag(trimmed) || trimmed;
        return [key, { ...link, url: key }] as const;
      })
    ).values()
  );

  const hasExistingUrl = uniqueLinks.some(link => baseReply.includes(link.url));
  if (hasExistingUrl) {
    return baseReply;
  }

  const prefix =
    KB_ARTICLE_LINKS_LABELS[params.language] || KB_ARTICLE_LINKS_LABELS.en;
  const linkLines = uniqueLinks
    .map((link, index) => `${index + 1}. ${link.title}: ${link.url}`)
    .join("\n");

  return [baseReply, `${prefix}:\n${linkLines}`].filter(Boolean).join("\n\n");
}

/** Removes the link list {@link appendKbArticleLinksToReply} adds. */
export function stripKbArticleLinksFooter(reply: string): string {
  return reply.replace(KB_ARTICLE_LINKS_FOOTER, "");
}
