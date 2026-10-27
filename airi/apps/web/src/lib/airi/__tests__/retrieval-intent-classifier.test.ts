jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: jest.fn(),
  getDefaultAIChatProviderOrder: jest.fn(() => ["anthropic", "vertex"]),
  getLightTextModel: jest.fn(() => "claude-haiku-4-5"),
  getLightStructuredJsonGenerationConfig: jest.fn(() => ({
    thinkingConfig: { thinkingLevel: "LOW" },
  })),
}));

import { chatCompletionWithFallback } from "@/lib/ai";
import { buildAnthropicMessageParams } from "@/lib/ai/anthropic-messages";
import {
  classifyRetrievalIntent,
  createNeutralRetrievalIntent,
} from "@/lib/airi/rag/query/retrieval-intent-classifier";

const mockedChatCompletion = chatCompletionWithFallback as jest.MockedFunction<
  typeof chatCompletionWithFallback
>;

describe("retrieval intent classifier", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses the LLM classifier for typo-heavy broad service-overview asks", async () => {
    mockedChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        label: "service_overview",
        confidence: "high",
        language: "en",
        queryVariants: [
          "available services",
          "how you can help",
          "available services",
          "",
        ],
        reason: "The user broadly asks what help is available.",
      }),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 7,
    });

    const result = await classifyRetrievalIntent({
      query: "wht servises can u help with?",
      language: "en",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    });

    expect(mockedChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5",
        providerOrder: ["anthropic", "vertex"],
        responseFormat: { type: "json_object" },
        temperature: 0,
        generationConfig: expect.objectContaining({
          thinkingConfig: { thinkingLevel: "LOW" },
        }),
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        label: "service_overview",
        confidence: "high",
        shouldUseBroadRetrieval: true,
        shouldUseOverviewVariants: true,
        source: "llm_classifier",
      })
    );
    expect(result.queryVariants).toEqual([
      "available services",
      "how you can help",
    ]);
  });

  it("treats medium service-overview classification as recall expansion, not a hard broad route", async () => {
    mockedChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        label: "service_overview",
        confidence: "medium",
        language: "en",
        queryVariants: ["available services", "formats of work"],
        reason: "Likely broad, but wording is underspecified.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 9,
    });

    const result = await classifyRetrievalIntent({
      query: "tell me more",
      language: "en",
    });

    expect(result.shouldUseBroadRetrieval).toBe(false);
    expect(result.shouldUseOverviewVariants).toBe(true);
    expect(result.queryVariants).toEqual([
      "available services",
      "formats of work",
    ]);
  });

  it("sends a response schema that Claude structured outputs can enforce", async () => {
    mockedChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        label: "pricing",
        confidence: "high",
        language: "en",
        queryVariants: [],
        reason: "One price question.",
      }),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 5,
    });

    await classifyRetrievalIntent({ query: "how much is it?", language: "en" });

    const [request] = mockedChatCompletion.mock.calls[0]!;
    const params = buildAnthropicMessageParams({
      model: String(request.model),
      messages: request.messages,
      forceJson: true,
      generationConfig: request.generationConfig,
    });
    expect(params.output_config?.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        required: [
          "label",
          "confidence",
          "language",
          "queryVariants",
          "reason",
        ],
        properties: {
          label: {
            type: "string",
            enum: [
              "service_overview",
              "specific_factual",
              "procedural",
              "pricing",
              "comparison",
              "other",
              "unclear",
            ],
          },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          language: { type: "string" },
          queryVariants: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
    });
  });

  it("reads a classification wrapped in a Markdown code fence", async () => {
    mockedChatCompletion.mockResolvedValue({
      content: `\`\`\`json\n${JSON.stringify({
        label: "procedural",
        confidence: "medium",
        language: "en",
        queryVariants: [],
        reason: "How-to question.",
      })}\n\`\`\``,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 5,
    });

    const result = await classifyRetrievalIntent({
      query: "how do I sign up?",
      language: "en",
    });

    expect(result).toEqual(
      expect.objectContaining({
        label: "procedural",
        confidence: "medium",
        source: "llm_classifier",
      })
    );
  });

  it("fails open to neutral retrieval when the classifier is unavailable", async () => {
    mockedChatCompletion.mockRejectedValue(new Error("provider unavailable"));

    const result = await classifyRetrievalIntent({
      query: "what can you do",
      language: "en",
    });

    expect(result).toEqual(
      createNeutralRetrievalIntent({
        query: "what can you do",
        language: "en",
        source: "classifier_unavailable",
        reason: "Retrieval intent classifier unavailable.",
      })
    );
  });
});
