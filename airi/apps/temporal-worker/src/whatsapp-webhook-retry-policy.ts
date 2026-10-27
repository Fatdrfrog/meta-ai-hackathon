export const DEFAULT_WEBHOOK_EVENT_MAX_ATTEMPTS = 12;

// Match the processor's legacy fallback for absent or nonpositive limits in
// both claim and recovery queries, so maintenance cannot dead-letter its work.
export function buildWhatsAppWebhookMaxAttemptsExpression() {
  return {
    $cond: [
      { $gt: [{ $ifNull: ["$maxAttempts", 0] }, 0] },
      "$maxAttempts",
      DEFAULT_WEBHOOK_EVENT_MAX_ATTEMPTS,
    ],
  };
}
