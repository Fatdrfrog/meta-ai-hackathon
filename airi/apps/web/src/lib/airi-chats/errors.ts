import {
  getWorkspaceAiRequiredDetails,
  isWorkspaceAiPolicyError,
} from "@/lib/ai/workspace-ai-errors";

/** A selected source the user attached cannot be used; the message is safe to show. */
export class AiriChatSelectedSourceError extends Error {
  readonly code = "selected_source_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "AiriChatSelectedSourceError";
  }
}

/** The chat is gone or not the caller's; the message is safe to show. */
export class AiriChatThreadNotFoundError extends Error {
  readonly code = "thread_not_found";

  constructor() {
    super("Airi chat thread not found");
    this.name = "AiriChatThreadNotFoundError";
  }
}

export type AiriChatRequestErrorCode =
  | "invalid_request"
  | "selected_source_unavailable"
  | "thread_not_found"
  | "own_ai_source_required"
  | "workspace_ai_policy_unavailable"
  | "cancelled"
  | "timed_out"
  | "airi_chat_failed";

export type AiriChatRequestFailure = {
  status: number;
  code: AiriChatRequestErrorCode;
  /** Safe to show: never a raw provider, database or runtime message. */
  message: string;
};

const AIRI_CHAT_FAILED_MESSAGE = "Failed to send Airi message";

function errorName(error: unknown): unknown {
  return error && typeof error === "object" && "name" in error
    ? error.name
    : undefined;
}

/** Server-side failures the routes log; a client cancellation is not one. */
export function shouldLogAiriChatRequestFailure(
  failure: AiriChatRequestFailure
): boolean {
  return failure.code === "airi_chat_failed" || failure.code === "timed_out";
}

/**
 * A failure reply, a busy (retryable) reply and a degraded draft reply (the
 * model's answer was not a valid draft, fallbackUsed): none answered the
 * user, so analytics records them as failed and none counts against the
 * studio-chat quota.
 */
export function isAiriChatReplyFailed(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return (
    metadata?.failed === true ||
    metadata?.retryable === true ||
    metadata?.fallbackUsed === true
  );
}

/**
 * The one failure mapper for the Airi chat message routes (JSON and SSE).
 * Status and code come from typed errors, never from message text; anything
 * unrecognised becomes a generic message so internals never reach clients.
 *
 * `signal` is the request's own signal. Only an abort of that signal, or an
 * AbortError, is a cancellation; a TimeoutError from an inner deadline while
 * the request is still live is a server timeout.
 */
export function describeAiriChatRequestFailure(
  error: unknown,
  fallbackMessage = AIRI_CHAT_FAILED_MESSAGE,
  signal?: AbortSignal
): AiriChatRequestFailure {
  if (error instanceof AiriChatSelectedSourceError) {
    return { status: 400, code: error.code, message: error.message };
  }
  if (error instanceof AiriChatThreadNotFoundError) {
    return { status: 404, code: error.code, message: error.message };
  }
  const allowance = getWorkspaceAiRequiredDetails(error);
  if (allowance) {
    return { status: 403, code: allowance.code, message: allowance.error };
  }
  if (isWorkspaceAiPolicyError(error)) {
    return {
      status: 503,
      code: "workspace_ai_policy_unavailable",
      message: "AI allowance could not be verified. Try again later.",
    };
  }
  const requestTimedOut =
    signal?.aborted && errorName(signal.reason) === "TimeoutError";
  if (
    !requestTimedOut &&
    (signal?.aborted || errorName(error) === "AbortError")
  ) {
    return { status: 499, code: "cancelled", message: "Request cancelled" };
  }
  if (requestTimedOut || errorName(error) === "TimeoutError") {
    return {
      status: 504,
      code: "timed_out",
      message: "Airi took too long to answer. Try again.",
    };
  }
  return {
    status: 500,
    code: "airi_chat_failed",
    message: fallbackMessage,
  };
}
