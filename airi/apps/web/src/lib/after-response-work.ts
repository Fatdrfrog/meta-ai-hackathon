import "server-only";

import { after } from "next/server";
import { trackInAiriChatRunTaskScope } from "@/lib/airi-chats/after-response";
import { logger } from "@/lib/logger";

/** Work started outside a request that has not settled yet. */
const pendingWork = new Set<Promise<void>>();

/**
 * Runs bookkeeping (LLM analytics, AI spend settles) without holding the
 * caller:
 * - inside a durable Airi chat run, the run's keep-alive waits for it;
 * - inside a Next.js request, after() runs it once the response is out;
 * - elsewhere (the Temporal worker, scripts) it starts now, and the worker
 *   drains it with {@link drainPendingAfterResponseWork} before it exits.
 * Failures are logged by `name` with no error text, which can carry
 * database URLs or payloads.
 */
export function runAfterResponse(
  name: string,
  task: () => Promise<unknown>
): void {
  const run = async () => {
    try {
      await task();
    } catch (error) {
      logger.warn(`after_response.${name}_failed`, {
        errorType: error instanceof Error ? error.name : typeof error,
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : null,
      });
    }
  };

  if (trackInAiriChatRunTaskScope(run)) return;

  try {
    after(run);
  } catch {
    // No request scope: start now and keep it visible to the drain.
    const pending: Promise<void> = run().finally(() =>
      pendingWork.delete(pending)
    );
    pendingWork.add(pending);
  }
}

/**
 * Waits until the work started outside a request settles, or `timeoutMs`
 * passes. Resolves true when nothing is left pending.
 */
export async function drainPendingAfterResponseWork(
  timeoutMs: number
): Promise<boolean> {
  if (pendingWork.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.allSettled([...pendingWork]).then(() => true),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
