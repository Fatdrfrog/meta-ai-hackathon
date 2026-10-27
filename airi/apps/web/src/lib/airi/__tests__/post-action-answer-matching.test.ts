const chatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    chatCompletionWithFallback(...args),
  getLightTextModel: () => "claude-haiku-4-5",
}));

import {
  matchPostActionAnswerExact,
  resolvePostActionAnswerMatch,
} from "@/lib/airi/post-action-answer-matching";

describe("post-action answer matching", () => {
  beforeEach(() => {
    chatCompletionWithFallback.mockReset();
  });

  it("matches exact rules case-insensitively inside a longer customer message", () => {
    expect(
      matchPostActionAnswerExact({
        messageText: "Hello, I want   the PREMIUM PLAN today.",
        rules: [
          { id: "premium", mode: "exact", text: "premium plan" },
          { id: "basic", mode: "exact", text: "basic" },
        ],
      })
    ).toEqual({
      ruleId: "premium",
      mode: "exact",
      confidence: 1,
    });
  });

  it("does not match exact rules inside unrelated token substrings", () => {
    expect(
      matchPostActionAnswerExact({
        messageText: "I wrote yesterday about the offer",
        rules: [{ id: "yes", mode: "exact", text: "yes" }],
      })
    ).toBeNull();
  });

  it("uses one AI call for intent rules only after exact rules miss", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        matches: [{ id: "pricing", confidence: 0.91 }],
      }),
    });

    await expect(
      resolvePostActionAnswerMatch({
        messageText: "How much does this package cost?",
        rules: [
          { id: "yes", mode: "exact", text: "yes" },
          { id: "pricing", mode: "intent", text: "asking about price" },
          { id: "delivery", mode: "intent", text: "asking about delivery" },
        ],
      })
    ).resolves.toEqual({
      ruleId: "pricing",
      mode: "intent",
      confidence: 0.91,
    });

    expect(chatCompletionWithFallback).toHaveBeenCalledTimes(1);
    const request = chatCompletionWithFallback.mock.calls[0][0];
    expect(request).toMatchObject({
      model: "claude-haiku-4-5",
      temperature: 0,
      responseFormat: { type: "json_object" },
    });
    // Platform default provider order (Claude first), not a Vertex pin.
    expect(request.providerOrder).toBeUndefined();
  });

  it("reads intent matches from a fenced JSON reply", async () => {
    chatCompletionWithFallback.mockResolvedValue({
      content: [
        "```json",
        JSON.stringify({ matches: [{ id: "delivery", confidence: 0.88 }] }),
        "```",
      ].join("\n"),
    });

    await expect(
      resolvePostActionAnswerMatch({
        messageText: "When will it arrive?",
        rules: [
          { id: "pricing", mode: "intent", text: "asking about price" },
          { id: "delivery", mode: "intent", text: "asking about delivery" },
        ],
      })
    ).resolves.toEqual({
      ruleId: "delivery",
      mode: "intent",
      confidence: 0.88,
    });
  });

  it("lets exact rules win without calling AI", async () => {
    await expect(
      resolvePostActionAnswerMatch({
        messageText: "YES, send it",
        rules: [
          { id: "yes", mode: "exact", text: "yes" },
          { id: "confirm", mode: "intent", text: "customer confirms" },
        ],
      })
    ).resolves.toEqual({
      ruleId: "yes",
      mode: "exact",
      confidence: 1,
    });

    expect(chatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("treats low-confidence intent and AI failure as no match", async () => {
    chatCompletionWithFallback.mockResolvedValueOnce({
      content: JSON.stringify({
        matches: [{ id: "pricing", confidence: 0.5 }],
      }),
    });

    await expect(
      resolvePostActionAnswerMatch({
        messageText: "Maybe later",
        rules: [{ id: "pricing", mode: "intent", text: "asking about price" }],
      })
    ).resolves.toBeNull();

    chatCompletionWithFallback.mockRejectedValueOnce(
      new Error("provider down")
    );

    await expect(
      resolvePostActionAnswerMatch({
        messageText: "What is the price?",
        rules: [{ id: "pricing", mode: "intent", text: "asking about price" }],
      })
    ).resolves.toBeNull();
  });
});
