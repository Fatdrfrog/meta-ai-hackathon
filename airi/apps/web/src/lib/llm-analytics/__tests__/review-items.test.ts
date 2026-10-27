import { buildRagTurnEventFromWideEvent } from "@icecore/airi-runtime/llm-analytics";
import { buildReviewItemDraftsForRagTurn } from "../review-items";

describe("LLM evaluation review item drafts", () => {
  it("creates customer-review drafts for bad RAG turns", () => {
    const ragTurn = buildRagTurnEventFromWideEvent({
      eventTs: "2026-04-22T10:00:00.000Z",
      answerMessageId: "outbound-1",
      inputText: "Can you deliver today?",
      outputText: "I am not sure.",
      wideEvent: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        resultType: "fallback",
        outcome: "ok",
        durationMs: 12_500,
        fallbackAction: "generic_clarification",
        fallbackReason: "missing_context",
        retrieval: { selectedSourceIds: [] },
      },
    });

    const drafts = buildReviewItemDraftsForRagTurn(ragTurn);

    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueType: "knowledge_gap",
          severity: "high",
          suggestedFix: expect.objectContaining({
            type: "knowledge_base_update",
          }),
        }),
        expect.objectContaining({
          issueType: "cost_latency_spike",
          severity: "medium",
          suggestedFix: expect.objectContaining({
            type: "prompt_rubric_change",
          }),
        }),
      ])
    );
    expect(new Set(drafts.map(draft => draft.dedupeKey)).size).toBe(
      drafts.length
    );
  });
});
