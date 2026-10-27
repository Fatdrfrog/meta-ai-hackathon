import {
  AIChatProviderAggregateError,
  type AIChatProviderErrorComponent,
} from "@/lib/ai/provider-errors";
import { WorkspaceAiSourceRequiredError } from "@/lib/ai/workspace-ai-policy";
import {
  buildAiriChatFailureFields,
  describeAiriChatFailure,
  formatAiriChatFailureDetail,
} from "./failure-diagnostics";

function component(
  overrides: Partial<AIChatProviderErrorComponent>
): AIChatProviderErrorComponent {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    attempt: 1,
    fallbackIndex: 0,
    retryable: true,
    finishReason: null,
    promptBlockReason: null,
    httpStatus: null,
    ...overrides,
  };
}

describe("describeAiriChatFailure", () => {
  it("reports the facade's code and the last failed attempt's provider and status", () => {
    const error = new AIChatProviderAggregateError([
      component({ provider: "anthropic", httpStatus: 529 }),
      component({ provider: "vertex", httpStatus: 429, fallbackIndex: 1 }),
    ]);

    const diagnostics = describeAiriChatFailure(error);

    expect(diagnostics).toEqual({
      errorClass: "ai_chat_provider_failed",
      provider: "vertex",
      httpStatus: 429,
    });
    expect(formatAiriChatFailureDetail(diagnostics)).toBe(
      "ai_chat_provider_failed (vertex HTTP 429)"
    );
  });

  it("leaves the status out for a timed-out attempt that had no response", () => {
    const diagnostics = describeAiriChatFailure(
      new AIChatProviderAggregateError([component({ httpStatus: null })])
    );

    expect(diagnostics).toEqual({
      errorClass: "ai_chat_provider_failed",
      provider: "anthropic",
      httpStatus: null,
    });
    expect(buildAiriChatFailureFields(diagnostics)).toEqual({
      errorClass: "ai_chat_provider_failed",
      errorProvider: "anthropic",
    });
  });

  it("prefers a string code, then a specific class name, and never the message", () => {
    const secret = "Bearer sk-live-secret prompt text";
    const coded = Object.assign(new Error(secret), {
      code: "ECONNRESET",
      status: 503,
    });
    const named = new WorkspaceAiSourceRequiredError(
      "workspace-1",
      "2026-10-08T00:00:00.000Z"
    );
    const plain = new Error(secret);

    expect(describeAiriChatFailure(coded)).toEqual({
      errorClass: "ECONNRESET",
      provider: null,
      httpStatus: 503,
    });
    expect(describeAiriChatFailure(named).errorClass).toBe(
      "own_ai_source_required"
    );
    expect(describeAiriChatFailure(plain).errorClass).toBe("Error");
    for (const error of [coded, named, plain]) {
      expect(JSON.stringify(describeAiriChatFailure(error))).not.toContain(
        "secret"
      );
    }
  });

  it("drops values that are not plain identifiers or valid statuses", () => {
    const error = Object.assign(new Error("boom"), {
      code: "has spaces and: a message",
      name: "x".repeat(100),
      status: 42,
      statusCode: "503",
    });

    expect(describeAiriChatFailure(error)).toEqual({
      errorClass: "Error",
      provider: null,
      httpStatus: null,
    });
    expect(describeAiriChatFailure("raw string failure")).toEqual({
      errorClass: "unknown_error",
      provider: null,
      httpStatus: null,
    });
  });
});
