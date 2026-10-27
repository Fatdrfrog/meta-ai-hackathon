export { buildMissingKnowledgeCoachPayload as createMissingKnowledgeCoachPayload } from "./gap-copy";

export type KbSnippetSuggestionPayload = {
  suggestionId: "kb-suggestion";
  messageId: string;
  tips: Array<{
    title: string;
    suggestion: string;
    type: "clarity";
    confidence: number;
  }>;
  suggestedEdit: string;
  tagsApplied: string[];
  createdAt: string;
  source: "kb";
};

/**
 * Standardized suggestion payload for realtime `airi.suggestion` / AiriSuggestion.
 */
export function createSuggestionPayload(
  messageId: string,
  snippet: { answer: string; score: number; tags?: string[] }
): KbSnippetSuggestionPayload {
  return {
    suggestionId: "kb-suggestion",
    messageId,
    tips: [
      {
        title: "Similar resolved answer found",
        suggestion: snippet.answer,
        type: "clarity",
        confidence: Math.round(snippet.score * 100) / 100,
      },
    ],
    suggestedEdit: snippet.answer,
    tagsApplied: snippet.tags ?? [],
    createdAt: new Date().toISOString(),
    source: "kb",
  };
}
