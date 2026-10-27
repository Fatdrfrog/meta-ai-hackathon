export type InferenceDeadline = {
  readonly deadlineAt: number;
  remainingMs: () => number;
  nextTimeoutMs: (
    maxTimeoutMs: number,
    minimumTimeoutMs?: number
  ) => number | null;
};

/**
 * Shares one wall-clock budget across provider fallbacks and repair calls.
 * A deadline prevents each fallback from receiving a fresh full timeout.
 */
export function createInferenceDeadline(
  totalTimeoutMs: number,
  now: () => number = Date.now
): InferenceDeadline {
  const deadlineAt = now() + Math.max(0, Math.floor(totalTimeoutMs));

  return {
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    nextTimeoutMs: (maxTimeoutMs, minimumTimeoutMs = 1_000) => {
      const remainingMs = Math.max(0, deadlineAt - now());
      const minimumMs = Math.max(1, Math.floor(minimumTimeoutMs));
      if (remainingMs < minimumMs) return null;

      return Math.max(
        minimumMs,
        Math.min(remainingMs, Math.max(minimumMs, Math.floor(maxTimeoutMs)))
      );
    },
  };
}
