/** Cancellation is control flow, never an ordinary fail-soft provider response. */
export function throwIfCancelled(signal?: AbortSignal, error?: unknown): void {
  signal?.throwIfAborted();
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
    throw error;
}

/** Waits `ms`; an abort rejects with `signal.reason` (not a wrapped AbortError). */
export function sleepWithCancellation(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Stop this caller waiting without cancelling shared cache work or a non-abortable DB read. */
export function awaitWithCancellation<T>(
  work: PromiseLike<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return Promise.resolve(work);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(work).then(
      value => {
        cleanup();
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      error => {
        cleanup();
        reject(signal.aborted ? signal.reason : error);
      }
    );
    if (signal.aborted) onAbort();
  });
}
