const mockRecordRagTurnAnalyticsEvents = jest.fn();

jest.mock("@/lib/llm-analytics/events", () => ({
  recordRagTurnAnalyticsEvents: (...args: unknown[]) =>
    mockRecordRagTurnAnalyticsEvents(...args),
}));

import {
  buildAiriChatAnalyticsSourceContext,
  recordAiriChatTurnAnalyticsEvents,
} from "./analytics";

describe("Airi chat analytics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds stable prefixed source ids for conversations and knowledge", () => {
    const context = buildAiriChatAnalyticsSourceContext({
      conversations: [
        { id: "conversation-1", summary: "Billing question" },
        { id: "conversation-1", summary: "Duplicate" },
        { summary: "Missing id" },
      ],
      kbArticles: [
        {
          id: "kb-1",
          title: "Billing",
          content: "Billing content",
          relevance_score: 0.91,
        },
        {
          id: "url-1",
          title: "Docs",
          content: "Docs content",
          relevance_score: 0.83,
          source_type: "external_url",
        },
      ],
    });

    expect(context).toEqual({
      conversationSourceIds: ["conversation:conversation-1"],
      kbSourceIds: ["kb:kb-1", "url:url-1"],
      sourceIds: ["conversation:conversation-1", "kb:kb-1", "url:url-1"],
      retrievalPath: "blended",
    });
  });

  it("records Airi chat turns through RAG analytics without review items", async () => {
    await recordAiriChatTurnAnalyticsEvents({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessageId: "user-message-1",
      assistantMessageId: "assistant-message-1",
      inputText: "What should I improve?",
      outputText: "Improve reply speed.",
      outcome: "ok",
      analytics: {
        traceId: "airi_chat:workspace-1:thread-1:user-message-1",
        durationMs: 1234,
        generationLatencyMs: 900,
        generationModel: "gemini-3.5-flash",
        sourceIds: ["kb:kb-1"],
        conversationSourceIds: [],
        kbSourceIds: ["kb:kb-1"],
        retrievalPath: "kb",
      },
      metadata: {
        kbArticlesFound: 1,
        conversationsFound: 0,
      },
    });

    expect(mockRecordRagTurnAnalyticsEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        answerMessageId: "assistant-message-1",
        inputText: "What should I improve?",
        outputText: "Improve reply speed.",
        sourceService: "web.airi_chat",
        metadata: expect.objectContaining({
          userMessageId: "user-message-1",
          kbArticlesFound: 1,
          conversationsFound: 0,
        }),
        wideEvent: expect.objectContaining({
          workspaceId: "workspace-1",
          conversationId: "thread-1",
          traceId: "airi_chat:workspace-1:thread-1:user-message-1",
          channel: "panel",
          outcome: "ok",
          retrievalPath: "kb",
          generationModel: "gemini-3.5-flash",
          retrieval: expect.objectContaining({
            selectedSourceIds: ["kb:kb-1"],
            kbSourceIds: ["kb:kb-1"],
          }),
        }),
      }),
      { persistReviewItems: false }
    );
  });

  it("records a failed turn as failed instead of ok", async () => {
    await recordAiriChatTurnAnalyticsEvents({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessageId: "user-message-1",
      assistantMessageId: "assistant-message-1",
      inputText: "Draft a campaign",
      outputText: "Airi is temporarily busy.",
      outcome: "failed",
      analytics: {
        traceId: "airi_chat:workspace-1:thread-1:user-message-1",
        durationMs: 1234,
        generationLatencyMs: null,
        generationModel: "heavy-text-model",
        sourceIds: [],
        conversationSourceIds: [],
        kbSourceIds: [],
        retrievalPath: "none",
      },
      metadata: { errorCode: "provider_resource_exhausted" },
    });

    expect(mockRecordRagTurnAnalyticsEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          errorCode: "provider_resource_exhausted",
        }),
        wideEvent: expect.objectContaining({ outcome: "failed" }),
      }),
      { persistReviewItems: false }
    );
  });
});
