import { BoundedExecutor } from "./bounded-executor.js";

// Only acceleration lives in memory. Every task must already have a durable
// outbox/ingress owner, so queue saturation and shutdown do not lose work.
let executor: BoundedExecutor | null = null;
export function scheduleWhatsAppOptionalWork(
  task: () => Promise<void>,
): boolean {
  return executor?.submit([task]).accepted ?? false;
}
export async function startWhatsAppOptionalWork(
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  const owned = new BoundedExecutor(256, 8);
  executor = owned;
  const close = () => {
    owned.close();
    if (executor === owned) executor = null;
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return async () => {
    close();
    signal.removeEventListener("abort", close);
    await owned.drain({
      deadlineMs: performance.now() + 5_000,
      monotonicNow: () => performance.now(),
    });
  };
}
