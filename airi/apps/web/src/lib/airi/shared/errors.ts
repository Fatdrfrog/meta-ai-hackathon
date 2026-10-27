/**
 * RAG Error Types
 *
 * Standardized error handling for RAG operations.
 * All errors include context (workspaceId, query, etc.) for better debugging.
 */

/**
 * Base RAG error class
 */
export class RAGError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RAGError";
    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RAGError);
    }
  }
}

/**
 * Retrieval-specific errors
 * Used when KB article or snippet retrieval fails
 */
export class RetrievalError extends RAGError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "RETRIEVAL_ERROR", context);
    this.name = "RetrievalError";
  }
}

/**
 * Verification-specific errors
 * Used when LLM verification fails
 */
export class VerificationError extends RAGError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VERIFICATION_ERROR", context);
    this.name = "VerificationError";
  }
}
