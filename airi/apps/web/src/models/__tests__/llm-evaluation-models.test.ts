import LlmEvaluationRegressionCase from "@/models/llm-evaluation-regression-case";
import LlmEvaluationReviewItem from "@/models/llm-evaluation-review-item";

describe("LLM evaluation workflow models", () => {
  it("defines customer-owned review item workflow state", () => {
    const reviewItem = new LlmEvaluationReviewItem({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      traceId: "trace-1",
      scoreEventId: "score-1",
      issueType: "unsupported_answer",
      severity: "high",
      title: "Unsupported answer",
      suggestedFix: {
        type: "knowledge_base_update",
        title: "Add delivery policy",
      },
    });

    expect(reviewItem.status).toBe("open");
    expect(reviewItem.source).toBe("system_eval");
    expect(reviewItem.suggestedFix?.type).toBe("knowledge_base_update");
  });

  it("applies review-item dedupe uniqueness only to string dedupe keys", () => {
    const index = LlmEvaluationReviewItem.schema
      .indexes()
      .find(
        ([keys]) =>
          JSON.stringify(keys) ===
          JSON.stringify({ workspaceId: 1, dedupeKey: 1 })
      );

    expect(index).toEqual([
      { workspaceId: 1, dedupeKey: 1 },
      expect.objectContaining({
        name: "llm_review_items_workspace_dedupe_unique_v2",
        partialFilterExpression: { dedupeKey: { $type: "string" } },
        unique: true,
      }),
    ]);
    expect(index?.[1]).not.toHaveProperty("sparse");
  });

  it("defines regression cases created from reviewed chats", () => {
    const regressionCase = new LlmEvaluationRegressionCase({
      workspaceId: "workspace-1",
      reviewItemId: "review-1",
      conversationId: "conversation-1",
      inputExcerpt: "Do you deliver today?",
      expectedBehavior: "Escalate or answer from a cited delivery policy.",
    });

    expect(regressionCase.status).toBe("active");
    expect(regressionCase.datasetSplit).toBe("validation");
  });
});
