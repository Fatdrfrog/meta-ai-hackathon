/**
 * Text provider failure shapes and retry classification. Kept free of
 * server-only imports so callers' tests can use the real classifier.
 */

import type { TextModelProvider } from "./text-models";

export type AIChatProviderErrorComponent = {
  provider: TextModelProvider;
  model: string;
  attempt: number;
  fallbackIndex: number;
  retryable: boolean;
  finishReason: string | null;
  promptBlockReason: string | null;
  /** Safe provider response status; raw error bodies never survive aggregation. */
  httpStatus?: number | null;
};

export class AIChatProviderAggregateError extends Error {
  readonly code = "ai_chat_provider_failed";
  readonly providerErrors: ReadonlyArray<AIChatProviderErrorComponent>;

  constructor(providerErrors: AIChatProviderErrorComponent[]) {
    super("AI chat provider attempts failed");
    this.name = "AIChatProviderAggregateError";
    this.providerErrors = Object.freeze(
      providerErrors.map(component => Object.freeze({ ...component }))
    );
  }
}

/**
 * A provider stops at its first non-retryable failure, so its last component
 * is how it ended. The call is worth retrying later when at least one
 * provider ended on a transient failure (capacity, rate limit, timeout).
 */
function isRetryableAggregate(error: AIChatProviderAggregateError): boolean {
  const lastByProvider = new Map<string, AIChatProviderErrorComponent>();
  for (const component of error.providerErrors) {
    lastByProvider.set(component.provider, component);
  }
  return Array.from(lastByProvider.values()).some(
    component => component.retryable
  );
}

export function isRetryableAIProviderError(error: unknown): boolean {
  if (error instanceof AIChatProviderAggregateError) {
    return isRetryableAggregate(error);
  }

  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : null;
  if (status === 408 || status === 409 || status === 429 || status === 500) {
    return true;
  }
  if (status === 502 || status === 503 || status === 504 || status === 529) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  return (
    /\b(408|409|429|500|502|503|504|529)\b/.test(message) ||
    normalized.includes("overloaded") ||
    normalized.includes("connection error") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("service unavailable") ||
    normalized.includes("deadline exceeded") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout")
  );
}
