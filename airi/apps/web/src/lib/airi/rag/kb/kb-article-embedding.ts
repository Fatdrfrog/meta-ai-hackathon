import "server-only";

import { extractKBPlainText } from "./kb-content";

export function buildKBArticleEmbeddingText(params: {
  title: string;
  content: string;
  ancestorTitles?: string[];
}): string {
  const title = String(params.title || "").trim();
  const ancestorTitles = (params.ancestorTitles || [])
    .map(titlePart => String(titlePart || "").trim())
    .filter(Boolean);
  const breadcrumb =
    ancestorTitles.length > 0 ? `${ancestorTitles.join(" > ")} > ` : "";
  const plainContent = extractKBPlainText(params.content || "");

  return `${breadcrumb}${title}\n\n${plainContent}`.trim();
}
