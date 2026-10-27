/**
 * Safe failure facts for Airi chat receipts, stages and API errors. Only
 * identifiers survive (an error class or code, a provider name, an HTTP
 * status), never an error message: messages can carry prompts, provider
 * response bodies or credentials.
 */

import { AIChatProviderAggregateError } from "@/lib/ai/provider-errors";

export type AiriChatFailureDiagnostics = {
  /** Error code or class name, e.g. ai_chat_provider_failed or ValidationError. */
  errorClass: string;
  /** Provider of the last failed attempt, when the error says which. */
  provider: string | null;
  /** HTTP status of the last failed attempt or of the error itself. */
  httpStatus: number | null;
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function safeHttpStatus(value: unknown): number | null {
  const status = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

export function describeAiriChatFailure(
  error: unknown
): AiriChatFailureDiagnostics {
  if (error instanceof AIChatProviderAggregateError) {
    const last = error.providerErrors[error.providerErrors.length - 1];
    return {
      errorClass: error.code,
      provider: safeIdentifier(last?.provider) ?? null,
      httpStatus: safeHttpStatus(last?.httpStatus),
    };
  }
  if (typeof error !== "object" || error === null) {
    return { errorClass: "unknown_error", provider: null, httpStatus: null };
  }
  const record = error as {
    code?: unknown;
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const named = safeIdentifier(record.name);
  return {
    // A string code is more specific than a generic Error/TypeError name.
    errorClass:
      safeIdentifier(record.code) ??
      (named && named !== "Error" ? named : null) ??
      (error instanceof Error ? "Error" : "unknown_error"),
    provider: null,
    httpStatus:
      safeHttpStatus(record.status) ?? safeHttpStatus(record.statusCode),
  };
}

/** Short stage detail, e.g. "ai_chat_provider_failed (anthropic HTTP 529)". */
export function formatAiriChatFailureDetail(
  diagnostics: AiriChatFailureDiagnostics
): string {
  const origin = [
    diagnostics.provider,
    diagnostics.httpStatus ? `HTTP ${diagnostics.httpStatus}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return origin
    ? `${diagnostics.errorClass} (${origin})`
    : diagnostics.errorClass;
}

/** Receipt and metadata fields; empty values are left out. */
export function buildAiriChatFailureFields(
  diagnostics: AiriChatFailureDiagnostics
): {
  errorClass: string;
  errorProvider?: string;
  errorHttpStatus?: number;
} {
  return {
    errorClass: diagnostics.errorClass,
    ...(diagnostics.provider ? { errorProvider: diagnostics.provider } : {}),
    ...(diagnostics.httpStatus
      ? { errorHttpStatus: diagnostics.httpStatus }
      : {}),
  };
}
