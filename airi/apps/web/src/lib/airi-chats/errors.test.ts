import {
  WorkspaceAiPolicyUnavailableError,
  WorkspaceAiSourceRequiredError,
} from "@/lib/ai/workspace-ai-policy";
import {
  AiriChatSelectedSourceError,
  AiriChatThreadNotFoundError,
  describeAiriChatRequestFailure,
  isAiriChatReplyFailed,
  shouldLogAiriChatRequestFailure,
} from "./errors";

jest.mock("@/lib/google/google-ai-source", () => ({}));

describe("describeAiriChatRequestFailure", () => {
  it("keeps typed errors' safe messages and maps them to their codes", () => {
    expect(
      describeAiriChatRequestFailure(
        new AiriChatSelectedSourceError("Select up to 12 sources")
      )
    ).toEqual({
      status: 400,
      code: "selected_source_unavailable",
      message: "Select up to 12 sources",
    });
    expect(
      describeAiriChatRequestFailure(new AiriChatThreadNotFoundError())
    ).toEqual({
      status: 404,
      code: "thread_not_found",
      message: "Airi chat thread not found",
    });
  });

  it("uses the workspace AI policy errors' existing codes", () => {
    expect(
      describeAiriChatRequestFailure(
        new WorkspaceAiSourceRequiredError("workspace-1", "2026-11-01")
      )
    ).toMatchObject({ status: 403, code: "own_ai_source_required" });
    expect(
      describeAiriChatRequestFailure(
        new Error("wrapped", { cause: new WorkspaceAiPolicyUnavailableError() })
      )
    ).toEqual({
      status: 503,
      code: "workspace_ai_policy_unavailable",
      message: "AI allowance could not be verified. Try again later.",
    });
  });

  it("reports cancellation as cancelled", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(describeAiriChatRequestFailure(abort)).toMatchObject({
      status: 499,
      code: "cancelled",
    });
  });

  it("reports an inner TimeoutError as a server timeout while the request is live", () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const live = new AbortController();
    for (const failure of [
      describeAiriChatRequestFailure(timeout),
      describeAiriChatRequestFailure(timeout, undefined, live.signal),
    ]) {
      expect(failure).toEqual({
        status: 504,
        code: "timed_out",
        message: "Airi took too long to answer. Try again.",
      });
    }
    expect(
      shouldLogAiriChatRequestFailure(describeAiriChatRequestFailure(timeout))
    ).toBe(true);
  });

  it("reports any failure after the request itself was aborted as cancelled", () => {
    const request = new AbortController();
    request.abort();
    for (const error of [
      new DOMException("The operation timed out", "TimeoutError"),
      new Error("socket hang up"),
    ]) {
      expect(
        describeAiriChatRequestFailure(error, undefined, request.signal)
      ).toMatchObject({ status: 499, code: "cancelled" });
    }
    expect(
      shouldLogAiriChatRequestFailure(
        describeAiriChatRequestFailure(
          new Error("x"),
          undefined,
          request.signal
        )
      )
    ).toBe(false);
  });

  it("reports a request signal that hit its own deadline as a timeout", () => {
    const signal = AbortSignal.abort(
      new DOMException("The operation timed out", "TimeoutError")
    );
    expect(
      describeAiriChatRequestFailure(signal.reason, undefined, signal)
    ).toMatchObject({ status: 504, code: "timed_out" });
  });

  it("treats failure and busy (retryable) replies as unanswered", () => {
    expect(isAiriChatReplyFailed({ failed: true })).toBe(true);
    expect(
      isAiriChatReplyFailed({
        retryable: true,
        errorCode: "provider_resource_exhausted",
      })
    ).toBe(true);
    // A degraded draft reply saved no draft: not counted against the quota.
    expect(
      isAiriChatReplyFailed({
        fallbackUsed: true,
        errorCode: "artifact_validation_failed",
      })
    ).toBe(true);
    expect(isAiriChatReplyFailed({ fallbackUsed: false })).toBe(false);
    expect(isAiriChatReplyFailed({})).toBe(false);
    expect(isAiriChatReplyFailed(null)).toBe(false);
    expect(isAiriChatReplyFailed(undefined)).toBe(false);
  });

  it("never passes an unknown error's message through, whatever it says", () => {
    for (const error of [
      new Error("Selected source is unavailable: mongodb://user:pw@host"),
      new Error("Select up to 12 sources"),
      "boom",
      null,
    ]) {
      expect(describeAiriChatRequestFailure(error)).toEqual({
        status: 500,
        code: "airi_chat_failed",
        message: "Failed to send Airi message",
      });
    }
    expect(
      describeAiriChatRequestFailure(new Error("x"), "Failed to load")
    ).toMatchObject({ message: "Failed to load" });
  });
});
