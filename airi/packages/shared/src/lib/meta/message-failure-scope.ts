export type MetaMessageFailureScope = "provider" | "recipient" | "unknown";

/**
 * Meta answers 130429 while the sender's throughput level is used up. It is a
 * provider-scoped, retryable failure, but never a restriction on the sender.
 */
export const META_THROUGHPUT_ERROR_CODE = "130429";

const META_PROVIDER_FAILURE_CODES = new Set([
  "3",
  "4",
  "10",
  "190",
  "200",
  "368",
  "80007",
  "130429",
  "131005",
  "131016",
  "131031",
  "131037",
  "131042",
  "131048",
  "131057",
  "131063",
  "131064",
]);

const META_RECIPIENT_FAILURE_CODES = new Set([
  "130472",
  "130497",
  "131021",
  "131026",
  "131047",
  "131049",
  "131050",
  "131056",
]);

export function classifyMetaMessageFailureScope(
  code: unknown,
): MetaMessageFailureScope {
  if (
    (typeof code !== "number" && typeof code !== "string") ||
    !String(code).trim()
  ) {
    return "unknown";
  }

  const normalized = String(code).trim();
  if (META_PROVIDER_FAILURE_CODES.has(normalized)) return "provider";
  if (META_RECIPIENT_FAILURE_CODES.has(normalized)) return "recipient";
  return "unknown";
}

/** A provider failure that should stop the campaign until someone acknowledges it. */
export function isMetaProviderRestrictionCode(code: unknown): boolean {
  return (
    classifyMetaMessageFailureScope(code) === "provider" &&
    String(code).trim() !== META_THROUGHPUT_ERROR_CODE
  );
}
