const chatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    chatCompletionWithFallback(...args),
  getDefaultAIChatProviderOrder: () => ["anthropic", "vertex"],
  getLightTextModel: () => "claude-haiku-4-5",
  getLightStructuredJsonGenerationConfig: () => ({
    thinkingConfig: { thinkingLevel: "LOW" },
  }),
}));

import {
  buildAnswerCoveragePlan,
  evaluateAnswerCoverage,
  renderAnswerCoverageBlock,
} from "@/lib/airi/reply/generation/answer-coverage";

describe("answer coverage", () => {
  beforeEach(() => {
    chatCompletionWithFallback.mockReset();
  });

  it("judges multi-ask coverage from structured LLM output", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        items: [
          {
            askIndex: 1,
            ask: "grants",
            status: "answered",
            confidence: "high",
            answerSpan: "We support grants",
            reason: "The reply explicitly mentions grants.",
          },
          {
            askIndex: 2,
            ask: "pricing",
            status: "not_answered",
            confidence: "high",
            answerSpan: "",
            reason: "No pricing information is provided.",
          },
        ],
        repairInstruction: "Add the pricing answer.",
      }),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 11,
    });

    const plan = buildAnswerCoveragePlan({
      openAsks: ["grants", "pricing"],
    });

    await expect(
      evaluateAnswerCoverage({
        reply: "We support grants.",
        plan,
        latestCustomerMessage: "Do you support grants and what is pricing?",
      })
    ).resolves.toEqual({
      asksDetected: ["grants", "pricing"],
      asksAnswered: ["grants"],
      missingAsks: ["pricing"],
      ambiguousMissingAsks: [],
      fullyCovered: false,
      coverageSource: "llm_judge",
      judgeItems: [
        {
          ask: "grants",
          status: "answered",
          confidence: "high",
          answerSpan: "We support grants",
          reason: "The reply explicitly mentions grants.",
        },
        {
          ask: "pricing",
          status: "not_answered",
          confidence: "high",
          answerSpan: "",
          reason: "No pricing information is provided.",
        },
      ],
      repairInstruction: "Add the pricing answer.",
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-haiku-4-5",
        providerOrder: ["anthropic", "vertex"],
        responseFormat: { type: "json_object" },
        generationConfig: expect.objectContaining({
          thinkingConfig: { thinkingLevel: "LOW" },
          responseSchema: expect.objectContaining({ type: "OBJECT" }),
        }),
        temperature: 0,
        resilience: {
          maxRetries: 0,
          timeoutMs: 5_000,
        },
      })
    );
  });

  it("reads a judge verdict wrapped in a markdown fence", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: [
        "```json",
        JSON.stringify({
          items: [
            {
              askIndex: 1,
              ask: "grants",
              status: "answered",
              confidence: "high",
              answerSpan: "We support grants",
              reason: "Grants are covered.",
            },
            {
              askIndex: 2,
              ask: "pricing",
              status: "answered",
              confidence: "high",
              answerSpan: "$10",
              reason: "Pricing is covered.",
            },
          ],
          repairInstruction: null,
        }),
        "```",
      ].join("\n"),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 9,
    });

    await expect(
      evaluateAnswerCoverage({
        reply: "We support grants. Pricing is $10.",
        plan: buildAnswerCoveragePlan({ openAsks: ["grants", "pricing"] }),
        latestCustomerMessage: "Do you support grants and what is pricing?",
      })
    ).resolves.toMatchObject({
      asksAnswered: ["grants", "pricing"],
      missingAsks: [],
      fullyCovered: true,
      coverageSource: "llm_judge",
    });
  });

  it("does not spend an LLM call judging an ordinary single-ask turn", async () => {
    const plan = buildAnswerCoveragePlan({ openAsks: ["deadline"] });

    await expect(
      evaluateAnswerCoverage({
        reply: "I do not have a confirmed deadline in the provided context.",
        plan,
        latestCustomerMessage: "What is the deadline?",
      })
    ).resolves.toMatchObject({
      asksAnswered: [],
      missingAsks: [],
      fullyCovered: true,
      coverageSource: "skipped",
    });
    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("does not start a compound-turn judge after its deadline is exhausted", async () => {
    const plan = buildAnswerCoveragePlan({
      openAsks: ["deadline", "pricing"],
    });

    await expect(
      evaluateAnswerCoverage({
        reply: "The deadline is tomorrow.",
        plan,
        timeoutMs: 500,
      })
    ).resolves.toMatchObject({
      fullyCovered: true,
      coverageSource: "judge_unavailable",
    });
    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("does not silently fall back to token heuristics when the judge fails", async () => {
    chatCompletionWithFallback.mockRejectedValue(new Error("judge offline"));

    const plan = buildAnswerCoveragePlan({
      openAsks: ["grant application process", "pricing"],
    });

    await expect(
      evaluateAnswerCoverage({
        reply:
          "The grant application process starts with a short form. Pricing depends on the package.",
        plan,
        latestCustomerMessage: "Explain the grant process and pricing.",
      })
    ).resolves.toEqual({
      asksDetected: ["grant application process", "pricing"],
      asksAnswered: [],
      missingAsks: [],
      ambiguousMissingAsks: [],
      fullyCovered: true,
      coverageSource: "judge_unavailable",
      judgeItems: [],
      repairInstruction: null,
    });
  });

  it("maps judge output by ask index instead of relying on rewritten ask text", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        items: [
          {
            askIndex: 2,
            ask: "the cost question",
            status: "answered",
            confidence: "high",
            answerSpan: "$10",
            reason: "The reply gives a price.",
          },
          {
            askIndex: 1,
            ask: "grant support",
            status: "not_answered",
            confidence: "high",
            answerSpan: "",
            reason: "No grant information is provided.",
          },
        ],
        repairInstruction: "Add the grants answer.",
      }),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 7,
    });

    const plan = buildAnswerCoveragePlan({
      openAsks: ["grants", "pricing"],
    });

    await expect(
      evaluateAnswerCoverage({
        reply: "Pricing is $10.",
        plan,
        latestCustomerMessage: "Do you support grants and what is pricing?",
      })
    ).resolves.toMatchObject({
      asksAnswered: ["pricing"],
      missingAsks: ["grants"],
    });
  });

  it("keeps coverage prompt guidance for multi-ask and repair turns", () => {
    const plan = buildAnswerCoveragePlan({
      openAsks: ["grant application process"],
    });

    expect(plan.requiresCoverageCheck).toBe(false);
    expect(renderAnswerCoverageBlock(plan)).toBeUndefined();
    expect(
      renderAnswerCoverageBlock(plan, {
        missingAsks: ["grant application process"],
      })
    ).toContain("Missing asks from the previous draft");
  });
});
