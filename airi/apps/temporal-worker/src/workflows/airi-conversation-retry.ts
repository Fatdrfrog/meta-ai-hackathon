const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

export function nextAiriConversationRetryAt(
  nowMs: number,
  attempt: number,
): number {
  const delay =
    RETRY_DELAYS_MS[
      Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)
    ];
  return Math.min(nowMs + delay, Number.MAX_SAFE_INTEGER);
}
