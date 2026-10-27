import { kbBlockCitationFooter } from "@/lib/airi/grounding/citation-discipline";
import type { CitationStrength } from "@/lib/airi/rag/evidence/evidence-types";
import { normalizedKbArticlePageUrl } from "./kb-source-urls";
import type { KBArticleResult } from "./kb-types";

const MAX_EMBEDDED_SOURCE_URLS_PER_ARTICLE = 40;

function formatEmbeddedSourceLinksBlock(urls: string[] | undefined): string {
  if (!urls?.length) return "";
  const limited = urls.slice(0, MAX_EMBEDDED_SOURCE_URLS_PER_ARTICLE);
  const lines = limited.map(u => `  ${u}`).join("\n");
  return `\n\nLINKS FROM THIS SOURCE (use these URLs verbatim; do not invent others):
${lines}
When the reply refers to one of these resources (a form, document, application page, etc.), render the reference as a clickable markdown link — format: [anchor text in the customer's language](URL). Use each URL at most once unless the customer clearly needs it twice. If none of these URLs matches the point you are making, do not fabricate a URL.`;
}

function formatArticlePageLine(kb: KBArticleResult): string {
  const normalized = normalizedKbArticlePageUrl(kb);
  if (!normalized) return "";
  return `\n\nPUBLIC ARTICLE PAGE (system may share this link with the customer when enabled; copy URL exactly if you cite it):\n  ${normalized}`;
}

export function formatKBBlockForAssistantReply(
  kbArticles: KBArticleResult[],
  customerLanguage: string,
  maxArticles: number = 5,
  mode: "default" | "overview" = "default",
  citationDiscipline: CitationStrength = "none",
  includeArticlePageLinks?: boolean
): string | undefined {
  if (!kbArticles || kbArticles.length === 0) {
    return undefined;
  }

  const articlesFormatted = kbArticles
    .slice(0, maxArticles)
    .map((kb, idx) => {
      const similarity = Math.round(kb.similarity * 100);
      const crossLangNote =
        kb.locale !== customerLanguage
          ? `[Note: Article in ${kb.locale}, translate in response]`
          : "";

      return `${idx + 1}. ${kb.title} (relevance: ${similarity}%)
${kb.fullContent}${formatEmbeddedSourceLinksBlock(kb.embeddedSourceUrls)}${
        includeArticlePageLinks ? formatArticlePageLine(kb) : ""
      }
${crossLangNote}`;
    })
    .join("\n---\n");

  return `KNOWLEDGE BASE (Use this authoritative information to answer product/service questions):

${articlesFormatted}

INSTRUCTIONS FOR USING KNOWLEDGE BASE:
- Prioritize KB information over generic knowledge for product/policy questions
- Synthesize the answer from all relevant KB entries provided here, not just the first one
- ${
    mode === "overview"
      ? "For broad overview questions, surface the main services, options, or formats across the grounded entries before going deeper."
      : "Prefer the most directly relevant facts first."
  }
- Weave KB facts into natural sentences; avoid formulaic openers that paste the full KB headline in quotes (in any language) unless the customer asked for that document by name. Do not repeat the same long title in every sentence
- If KB doesn't fully answer the question, use it as foundation and ask for clarification
- If customer's question is clearly outside KB scope, acknowledge and help anyway
- Translate KB content naturally if in different language than customer
- When a KB entry lists URLs (see "LINKS FROM THIS SOURCE"), embed the relevant URL inline as a markdown link \`[anchor text](URL)\` so the customer can click it. Copy the URL exactly, do not shorten or wrap it
- Never invent or guess URLs. If no provided URL fits, keep the reference as plain anchor text without brackets
${kbBlockCitationFooter(citationDiscipline)}
`;
}

export function formatCompanyContext(
  companyContext?: {
    businessContext?: string;
    dynamicTags?: string[];
  },
  maxBusinessContextLength: number = 400,
  maxTags: number = 10
): string | undefined {
  if (!companyContext) {
    return undefined;
  }

  const parts: string[] = [];
  const bc = companyContext.businessContext?.trim();
  if (bc) {
    parts.push(
      `About company context: ${bc.slice(0, maxBusinessContextLength)}`
    );
  }
  const tags = (companyContext.dynamicTags || []).filter(Boolean);
  if (tags.length > 0) {
    parts.push(`Focus areas/tags: ${tags.slice(0, maxTags).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
