import {
  AIChatProviderAggregateError,
  isRetryableAIProviderError,
  type AIChatProviderErrorComponent,
} from "./provider-errors";

function failure(
  provider: AIChatProviderErrorComponent["provider"],
  retryable: boolean,
  attempt = 1
): AIChatProviderErrorComponent {
  return {
    provider,
    model: provider === "anthropic" ? "claude-sonnet-5-5" : "gemini-3.5-flash",
    attempt,
    fallbackIndex: provider === "anthropic" ? 0 : 1,
    retryable,
    finishReason: null,
    promptBlockReason: null,
    httpStatus: retryable ? 529 : 400,
  };
}

describe("isRetryableAIProviderError with the facade's aggregate error", () => {
  it.each([
    {
      label: "every provider ended on a transient failure",
      components: [failure("anthropic", true), failure("vertex", true)],
      expected: true,
    },
    {
      label: "one provider ended on a transient failure",
      components: [failure("anthropic", false), failure("vertex", true)],
      expected: true,
    },
    {
      label: "the only transient failure was retried into a rejection",
      components: [
        failure("anthropic", true, 1),
        failure("anthropic", false, 2),
        failure("vertex", false),
      ],
      expected: false,
    },
    {
      label: "every provider rejected the request",
      components: [failure("anthropic", false), failure("vertex", false)],
      expected: false,
    },
    {
      label: "the customer key was rate limited",
      components: [failure("google", true)],
      expected: true,
    },
    { label: "no provider was attempted", components: [], expected: false },
  ])("is $expected when $label", ({ components, expected }) => {
    expect(
      isRetryableAIProviderError(new AIChatProviderAggregateError(components))
    ).toBe(expected);
  });

  it("does not let the aggregate message decide", () => {
    const error = new AIChatProviderAggregateError([
      failure("anthropic", false),
    ]);
    expect(error.message).toBe("AI chat provider attempts failed");
    expect(isRetryableAIProviderError(error)).toBe(false);
  });
});

describe("isRetryableAIProviderError with raw provider errors", () => {
  it.each([
    [Object.assign(new Error("Overloaded"), { status: 529 }), true],
    [Object.assign(new Error("rate limited"), { status: 429 }), true],
    [Object.assign(new Error("bad request"), { status: 400 }), false],
    [new Error("Anthropic request timeout"), true],
    [
      new Error('Vertex Gemini HTTP 429: { "status": "RESOURCE_EXHAUSTED" }'),
      true,
    ],
    [new Error("Invalid JSON in prompt"), false],
  ])("classifies %p as %p", (error, expected) => {
    expect(isRetryableAIProviderError(error)).toBe(expected);
  });
});
