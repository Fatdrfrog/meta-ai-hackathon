export const INDEXED_URL_PUBLIC_ERRORS = {
  invalid_training_source: "Provide at least one website or connect Instagram.",
  indexed_url_limit_exceeded: "The indexed URL limit would be exceeded.",
  background_processing_unavailable:
    "Background processing is not available right now.",
  training_start_failed: "We couldn't start training. Please try again.",
  training_progress_unavailable:
    "We couldn't load training progress. Please try again.",
  indexed_url_list_failed: "Failed to load indexed URLs.",
  indexed_url_add_failed: "Failed to queue website indexing.",
  indexed_url_delete_failed: "Failed to delete indexed URL.",
  indexed_url_reindex_failed: "Failed to queue website reindex.",
} as const;

export type IndexedUrlPublicErrorCode = keyof typeof INDEXED_URL_PUBLIC_ERRORS;
export type IndexedUrlFailureCode = "no_content" | "timeout" | "generic";

export type IndexedUrlPublicSource = {
  id: string;
  url: string;
  title: string | null;
  index_status: "pending" | "indexed" | "failed";
  failure_code: IndexedUrlFailureCode | null;
  error_message: string | null;
};

export function buildIndexedUrlPublicError(code: IndexedUrlPublicErrorCode) {
  return { code, error: INDEXED_URL_PUBLIC_ERRORS[code] };
}

export function toPublicIndexedUrlFailure(rawMessage: unknown): {
  failure_code: IndexedUrlFailureCode;
  error_message: string;
} {
  const message = typeof rawMessage === "string" ? rawMessage : "";
  if (/no indexable|no readable|no content|empty content/i.test(message)) {
    return {
      failure_code: "no_content",
      error_message: "No readable content was found.",
    };
  }
  if (/timed? out|timeout|aborted/i.test(message)) {
    return { failure_code: "timeout", error_message: "Indexing timed out." };
  }
  return { failure_code: "generic", error_message: "Indexing failed." };
}
