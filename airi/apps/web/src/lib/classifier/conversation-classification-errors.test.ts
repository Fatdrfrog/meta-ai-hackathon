jest.mock(
  "@/lib/ai/workspace-ai-policy",
  () => ({
    resolveWorkspaceTextAiBilling: async () => null,
    hasWorkspaceTextAiAction: () => false,
  }),
  { virtual: true }
);

import { AIChatProviderAggregateError } from "@/lib/ai";
import {
  ConversationClassificationError,
  InvalidClassificationOutputError,
  areAllConversationClassificationAttemptsSafetyBlocked,
  classifyConversationClassificationAttemptError,
  createConversationClassificationError,
  normalizeConversationClassificationFailure,
  serializeConversationClassificationLogError,
} from "@/lib/classifier/conversation-classification-errors";

describe("conversation classification errors", () => {
  it("does not retry an allowance denial wrapped by media or provider handling", () => {
    const denial = Object.assign(new Error("Connect your AI provider"), {
      code: "own_ai_source_required",
    });
    expect(
      normalizeConversationClassificationFailure(
        createConversationClassificationError(
          "media_preprocessing_failed",
          denial
        )
      )
    ).toMatchObject({ code: "own_ai_source_required", retryable: false });
  });
  const providerFailure = (input: {
    attempt: number;
    finishReason?: string | null;
    promptBlockReason?: string | null;
    retryable?: boolean;
  }) => ({
    provider: "vertex" as const,
    model: "gemini-primary",
    attempt: input.attempt,
    fallbackIndex: 0,
    retryable: input.retryable ?? false,
    finishReason: input.finishReason ?? null,
    promptBlockReason: input.promptBlockReason ?? null,
  });

  it("persists only the bounded public code and message", () => {
    const raw = new Error(`secret-token-${"x".repeat(2_000)}`);
    const error = createConversationClassificationError(
      "taxonomy_read_failed",
      raw
    );

    expect(error).toMatchObject({
      code: "taxonomy_read_failed",
      message: "Classification taxonomy could not be read",
      retryable: true,
      cause: raw,
    });
    expect(error.message).not.toContain("secret-token");
    expect(normalizeConversationClassificationFailure(error)).toEqual({
      code: "taxonomy_read_failed",
      message: "Classification taxonomy could not be read",
      retryable: true,
    });
  });

  it("marks immutable analysis conflicts non-retryable", () => {
    expect(
      createConversationClassificationError("analysis_revision_conflict")
    ).toMatchObject({
      code: "analysis_revision_conflict",
      retryable: false,
    });
  });

  it("normalizes unexpected failures to the bounded fallback", () => {
    expect(
      normalizeConversationClassificationFailure(new Error("database secret"))
    ).toEqual({
      code: "classification_execution_failed",
      message: "Classification execution failed",
      retryable: true,
    });
  });

  it("reports strict output paths without accepting a raw provider message", () => {
    const error = new InvalidClassificationOutputError(
      "confidence.category",
      "provider emitted NaN and secret-token"
    );

    expect(error).toBeInstanceOf(ConversationClassificationError);
    expect(error).toMatchObject({
      code: "invalid_classification_output",
      path: "confidence.category",
      retryable: true,
    });
    expect(error.message).toBe(
      "Classification output is invalid at confidence.category"
    );
  });

  it("serializes a bounded safe log shape", () => {
    const serialized = serializeConversationClassificationLogError(
      Object.assign(new Error("x".repeat(2_000)), {
        code: "provider_code",
        transcript: "must-not-leak",
      })
    );

    expect(serialized.name).toBe("Error");
    expect(serialized.code).toBe("provider_code");
    expect(serialized.message.length).toBeLessThanOrEqual(500);
    expect(serialized).not.toHaveProperty("transcript");
  });

  it("serializes one level of cause without URL query strings", () => {
    const origin = new Error(
      "download failed: https://cdn.example/a.jpg?X-Goog-Signature=secret#frag",
      { cause: new Error("must-not-nest") }
    );
    const serialized = serializeConversationClassificationLogError(
      createConversationClassificationError(
        "media_preprocessing_failed",
        origin
      )
    );

    expect(serialized).toEqual({
      message: "Classification media preprocessing failed",
      name: "ConversationClassificationError",
      code: "media_preprocessing_failed",
      cause: {
        message: "download failed: https://cdn.example/a.jpg?[redacted]",
        name: "Error",
      },
    });
    expect(JSON.stringify(serialized)).not.toContain("secret");
    expect(
      serializeConversationClassificationLogError(new Error("plain"))
    ).not.toHaveProperty("cause");
  });

  it("recognizes all-safety evidence from the provider aggregate", () => {
    const error = new AIChatProviderAggregateError([
      providerFailure({ attempt: 1, finishReason: "SAFETY" }),
      providerFailure({
        attempt: 2,
        promptBlockReason: "PROHIBITED_CONTENT",
      }),
    ]);

    expect(classifyConversationClassificationAttemptError(error)).toBe(
      "safety_blocked"
    );
  });

  it("treats a Claude refusal as explicit safety evidence", () => {
    const claudeRefusal = {
      ...providerFailure({ attempt: 1, finishReason: "refusal" }),
      provider: "anthropic" as const,
      model: "claude-sonnet-5-5",
    };
    expect(
      classifyConversationClassificationAttemptError(
        new AIChatProviderAggregateError([claudeRefusal])
      )
    ).toBe("safety_blocked");
    expect(
      classifyConversationClassificationAttemptError(
        new AIChatProviderAggregateError([
          claudeRefusal,
          providerFailure({ attempt: 1, finishReason: "SAFETY" }),
        ])
      )
    ).toBe("safety_blocked");
  });

  it.each([
    [
      new AIChatProviderAggregateError([
        {
          ...providerFailure({ attempt: 1, finishReason: "refusal" }),
          provider: "anthropic",
          model: "claude-sonnet-5-5",
        },
        providerFailure({ attempt: 1, retryable: true }),
      ]),
    ],
    [
      new AIChatProviderAggregateError([
        {
          ...providerFailure({ attempt: 1, finishReason: "max_tokens" }),
          provider: "anthropic",
          model: "claude-sonnet-5-5",
        },
      ]),
    ],
    [
      new AIChatProviderAggregateError([
        providerFailure({ attempt: 1, finishReason: "refusal" }),
      ]),
    ],
  ])("keeps Claude non-refusal or mixed evidence operational", error => {
    expect(classifyConversationClassificationAttemptError(error)).toBe(
      "operational_failure"
    );
  });

  it.each([
    [new Error("returned no text content: finishReason=SAFETY")],
    [{ finishReason: "STOP" }],
    [
      new AIChatProviderAggregateError([
        providerFailure({ attempt: 1, finishReason: "SAFETY" }),
        providerFailure({ attempt: 2, retryable: true }),
      ]),
    ],
    [new AIChatProviderAggregateError([])],
    [
      {
        providerErrors: [
          providerFailure({ attempt: 1, finishReason: "SAFETY" }),
        ],
      },
    ],
    [providerFailure({ attempt: 1, finishReason: "SAFETY" })],
  ])("keeps empty, generic, and mixed failures operational", error => {
    expect(classifyConversationClassificationAttemptError(error)).toBe(
      "operational_failure"
    );
  });

  it("requires every executed attempt to be explicitly safety blocked", () => {
    expect(
      areAllConversationClassificationAttemptsSafetyBlocked([
        { outcome: "safety_blocked" },
        { outcome: "safety_blocked" },
      ])
    ).toBe(true);
    expect(
      areAllConversationClassificationAttemptsSafetyBlocked([
        { outcome: "safety_blocked" },
        { outcome: "invalid_output" },
      ])
    ).toBe(false);
    expect(areAllConversationClassificationAttemptsSafetyBlocked([])).toBe(
      false
    );
  });
});
