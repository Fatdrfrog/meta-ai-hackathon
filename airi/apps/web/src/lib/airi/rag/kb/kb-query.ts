import {
  isRagPrepExplicitlyNonSearchable,
  prepareQueryForRagWithLlm,
  type RagQueryPreparation,
} from "@/lib/airi/rag/query/query-cleaner";

const KB_TOKEN_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "have",
  "want",
  "learn",
  "about",
  "your",
  "you",
  "how",
  "what",
  "where",
  "when",
  "why",
  "кто",
  "что",
  "как",
  "где",
  "когда",
  "это",
  "для",
  "или",
  "тоже",
  "надо",
  "хочу",
  "узнать",
]);

export function tokenizeKBQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(
      token =>
        token.length >= 3 &&
        !KB_TOKEN_STOP_WORDS.has(token) &&
        !/^\d+$/.test(token)
    );
}

export async function buildSearchAttempts(
  query: string,
  options?: {
    language?: string | null;
    ragQueryPreparation?: RagQueryPreparation;
  }
): Promise<string[]> {
  const prep =
    options?.ragQueryPreparation ??
    (await prepareQueryForRagWithLlm(query, { language: options?.language }));
  if (isRagPrepExplicitlyNonSearchable(prep)) {
    return [];
  }
  const base =
    prep.cleanedQuery.trim().length >= 3
      ? prep.cleanedQuery.trim()
      : query.trim();
  const tokens = tokenizeKBQuery(base);
  const latinOrNumericTokens = tokens.filter(token => /[a-z0-9]/i.test(token));
  const longTokens = tokens.filter(token => token.length >= 6);

  const attempts = [
    base,
    tokens.slice(0, 6).join(" "),
    latinOrNumericTokens.slice(0, 4).join(" "),
    ...latinOrNumericTokens.slice(0, 4),
    ...longTokens.slice(0, 4),
    ...tokens.slice(0, 4),
  ]
    .map(attempt => attempt.trim())
    .filter(attempt => attempt.length >= 3);

  return [...new Set(attempts)];
}
