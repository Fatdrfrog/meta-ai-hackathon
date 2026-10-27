export const PULSE_INTERVAL_MS = 10_000;

/**
 * Runs a task, calling `pulse` now and every 10 s until it settles, so a
 * Temporal activity keeps heartbeating through a Meta call that can take
 * minutes, not only between calls.
 */
export async function whilePulsing<T>(
  pulse: (() => void) | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!pulse) return task();
  pulse();
  const timer = setInterval(pulse, PULSE_INTERVAL_MS);
  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}
