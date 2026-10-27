const mockChatCompletionWithFallback = jest.fn();
const mockGetHeavyTextModel = jest.fn(() => "claude-sonnet-5-5");

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  formatScore: (value: number | null | undefined) => value ?? null,
  getHeavyTextModel: () => mockGetHeavyTextModel(),
  truncateText: (value: string) => value,
}));

jest.mock("@/lib/airi/shared/logger", () => ({
  ragLogger: { verification: { info: jest.fn() } },
}));

import { VerificationError } from "@/lib/airi/shared/errors";
import { verifySnippetRelevance } from "./verifier";

const snippet = {
  question: "How much does delivery cost?",
  answer: "Delivery costs 500 KZT.",
  score: 0.89,
};

describe("verifySnippetRelevance", () => {
  beforeEach(() => {
    mockChatCompletionWithFallback.mockReset();
    mockGetHeavyTextModel.mockClear();
  });

  it("asks the heavy text tier for a JSON verdict", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: '{"isRelevant":true,"confidence":0.92,"reason":"Same topic"}',
    });

    await expect(
      verifySnippetRelevance("Delivery price?", snippet, {
        workspaceId: "workspace-1",
      })
    ).resolves.toEqual({
      isRelevant: true,
      confidence: 0.92,
      reason: "Same topic",
    });
    expect(mockGetHeavyTextModel).toHaveBeenCalled();
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-5-5",
        responseFormat: { type: "json_object" },
        analytics: expect.objectContaining({
          operation: "airi.rag.verifier",
        }),
      })
    );
  });

  it("reads a verdict wrapped in a Markdown code fence", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content:
        '```json\n{"isRelevant":false,"confidence":0.81,"reason":"Different products"}\n```',
    });

    await expect(
      verifySnippetRelevance("How much does an americano cost?", snippet)
    ).resolves.toEqual({
      isRelevant: false,
      confidence: 0.81,
      reason: "Different products",
    });
  });

  it("treats an empty reply as not relevant", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({ content: "" });

    await expect(
      verifySnippetRelevance("Delivery price?", snippet)
    ).resolves.toEqual({ isRelevant: false, confidence: 0, reason: "Unknown" });
  });

  it("wraps unreadable replies in a VerificationError", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: "I cannot tell.",
    });

    await expect(
      verifySnippetRelevance("Delivery price?", snippet)
    ).rejects.toBeInstanceOf(VerificationError);
  });
});
