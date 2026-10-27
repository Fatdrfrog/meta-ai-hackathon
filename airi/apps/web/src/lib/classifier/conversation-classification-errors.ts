import {
  AIChatProviderAggregateError,
  type AIChatProviderErrorComponent,
} from "@/lib/ai";
import type { ConversationClassificationAttemptOutcome } from "@/lib/classifier/conversation-analysis-types";
import { getWorkspaceAiRequiredDetails } from "@/lib/ai/workspace-ai-errors";

export type ConversationClassificationFailureCode =
  | "own_ai_source_required"
  | "business_context_read_failed"
  | "workspace_not_found"
  | "workspace_company_missing"
  | "company_not_found"
  | "source_read_failed"
  | "source_not_found"
  | "source_workspace_mismatch"
  | "source_company_mismatch"
  | "taxonomy_read_failed"
  | "taxonomy_changed"
  | "summary_input_read_failed"
  | "summary_generation_failed"
  | "classification_provider_failed"
  | "invalid_classification_output"
  | "media_preprocessing_failed"
  | "analysis_revision_conflict"
  | "classification_execution_failed";

const FAILURE_MESSAGES: Record<ConversationClassificationFailureCode, string> =
  {
    own_ai_source_required:
      "Connect Google AI in Settings > Integrations to continue classification",
    business_context_read_failed: "Business context could not be read",
    workspace_not_found: "Classification workspace was not found",
    workspace_company_missing: "Classification workspace has no company",
    company_not_found: "Classification company was not found",
    source_read_failed: "Classification source could not be read",
    source_not_found: "Classification source was not found",
    source_workspace_mismatch: "Classification source workspace does not match",
    source_company_mismatch: "Classification source company does not match",
    taxonomy_read_failed: "Classification taxonomy could not be read",
    taxonomy_changed: "Classification taxonomy changed during processing",
    summary_input_read_failed: "Conversation summary input could not be read",
    summary_generation_failed: "Conversation summary generation failed",
    classification_provider_failed: "Classification provider failed",
    invalid_classification_output: "Classification output is invalid",
    media_preprocessing_failed: "Classification media preprocessing failed",
    analysis_revision_conflict: "Classification analysis revision conflicts",
    classification_execution_failed: "Classification execution failed",
  };

const NON_RETRYABLE_CODES = new Set<ConversationClassificationFailureCode>([
  "own_ai_source_required",
  "analysis_revision_conflict",
]);

export class ConversationClassificationError extends Error {
  readonly code: ConversationClassificationFailureCode;
  readonly retryable: boolean;

  constructor(
    code: ConversationClassificationFailureCode,
    options: { cause?: unknown; message?: string } = {}
  ) {
    super(options.message ?? FAILURE_MESSAGES[code], { cause: options.cause });
    this.name = "ConversationClassificationError";
    this.code = code;
    this.retryable = !NON_RETRYABLE_CODES.has(code);
  }
}

export class InvalidClassificationOutputError extends ConversationClassificationError {
  readonly path: string;

  constructor(path: string, _providerMessage?: string) {
    super("invalid_classification_output", {
      message: `Classification output is invalid at ${path}`,
    });
    this.name = "InvalidClassificationOutputError";
    this.path = path;
  }
}

export function createConversationClassificationError(
  code: ConversationClassificationFailureCode,
  cause?: unknown
): ConversationClassificationError {
  return new ConversationClassificationError(code, { cause });
}

export function normalizeConversationClassificationFailure(
  error: unknown,
  fallbackCode: ConversationClassificationFailureCode = "classification_execution_failed"
): {
  code: ConversationClassificationFailureCode;
  message: string;
  retryable: boolean;
} {
  if (getWorkspaceAiRequiredDetails(error)) {
    return {
      code: "own_ai_source_required",
      message: FAILURE_MESSAGES.own_ai_source_required,
      retryable: false,
    };
  }
  const normalized =
    error instanceof ConversationClassificationError
      ? error
      : createConversationClassificationError(fallbackCode, error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  };
}

function boundedText(value: unknown, maximumLength: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.slice(0, maximumLength);
}

// Provider and storage errors can carry signed URLs; keep the path, drop the query.
function withoutUrlQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1?[redacted]");
}

type ConversationClassificationLogErrorShape = {
  message: string;
  name?: string;
  code?: string;
};

function serializeLogErrorShape(
  error: unknown
): ConversationClassificationLogErrorShape {
  if (error instanceof Error) {
    const result: ConversationClassificationLogErrorShape = {
      message: boundedText(withoutUrlQueries(error.message), 500),
      name: boundedText(error.name, 120),
    };
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      result.code = boundedText(code.trim(), 120);
    }
    return result;
  }
  return { message: boundedText(withoutUrlQueries(String(error ?? "")), 500) };
}

/** One level of `cause`: wrapped failures such as media_preprocessing_failed keep their origin. */
export function serializeConversationClassificationLogError(
  error: unknown
): ConversationClassificationLogErrorShape & {
  cause?: ConversationClassificationLogErrorShape;
} {
  const result = serializeLogErrorShape(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === undefined
    ? result
    : { ...result, cause: serializeLogErrorShape(cause) };
}

function isExplicitSafetyComponent(
  value: AIChatProviderErrorComponent
): boolean {
  return (
    value.finishReason === "SAFETY" ||
    value.promptBlockReason === "PROHIBITED_CONTENT" ||
    // Claude reports a safety decline as stop_reason "refusal".
    (value.provider === "anthropic" && value.finishReason === "refusal")
  );
}

export function classifyConversationClassificationAttemptError(
  error: unknown
): Extract<
  ConversationClassificationAttemptOutcome,
  "safety_blocked" | "operational_failure"
> {
  if (!(error instanceof AIChatProviderAggregateError)) {
    return "operational_failure";
  }
  return error.providerErrors.length > 0 &&
    error.providerErrors.every(isExplicitSafetyComponent)
    ? "safety_blocked"
    : "operational_failure";
}

export function areAllConversationClassificationAttemptsSafetyBlocked(
  attempts: ReadonlyArray<{ outcome: ConversationClassificationAttemptOutcome }>
): boolean {
  return (
    attempts.length > 0 &&
    attempts.every(attempt => attempt.outcome === "safety_blocked")
  );
}
