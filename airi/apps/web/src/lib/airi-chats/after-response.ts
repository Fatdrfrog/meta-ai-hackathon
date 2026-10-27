import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { logger, type LogContext } from "@/lib/logger";

/**
 * Runs Airi chat bookkeeping (title, quota, analytics) after the response so
 * it never holds the composer or turns a saved answer into an error. Mirrors
 * the after()-or-inline fallback in lib/llm-analytics/events.ts: outside a
 * Next.js request scope (tests, scripts) the task starts immediately and is
 * not awaited. The caller's async context (for example the workspace AI
 * action scope) is carried into the task.
 *
 * Calling this from inside an SSE body is in scope (checked against Next.js
 * 16.3.5, next/dist/server/after/after.js and after-context.js):
 * - after() only needs workAsyncStorage and workUnitAsyncStorage stores.
 *   app-route/module.js runs the handler inside both, and a ReadableStream's
 *   start() runs synchronously in its constructor, inside the handler, so
 *   the run's promise chain inherits both stores after the handler returns.
 * - AfterContext queues the task, runs the queue on res 'close' and
 *   waitUntil()s it. The turn and the routes call this before the stream
 *   closes (sse.ts closes only after the run settles), so the task is
 *   queued in time and covered by waitUntil.
 * after() throws only without those stores or without waitUntil; the inline
 * fallback below covers exactly those cases.
 *
 * Inside a durable run (turn/run.ts) the response may be long closed: the
 * run outlives its request. after() would still queue the task, but once the
 * request's after-queue has drained a late task is no longer covered by a
 * waitUntil. So within a run the task starts at once (the answer is already
 * saved, nothing waits on it) and the run's own keep-alive waits for it.
 */
const airiChatRunTaskScope = new AsyncLocalStorage<Set<Promise<void>>>();

/** Runs `work` so the tasks scheduled inside it are tracked in `tasks`. */
export function runInAiriChatRunTaskScope<T>(
  tasks: Set<Promise<void>>,
  work: () => T
): T {
  return airiChatRunTaskScope.run(tasks, work);
}

/**
 * Inside a durable run: starts `task` now and the run's keep-alive waits for
 * it (its outcome is ignored). False outside a run, where the caller keeps
 * its own after()-or-inline path. Other after-response work a run triggers
 * (LLM analytics persistence) uses this too, for the reason above.
 */
export function trackInAiriChatRunTaskScope(
  task: () => Promise<unknown>
): boolean {
  const runTasks = airiChatRunTaskScope.getStore();
  if (!runTasks) return false;
  const tracked: Promise<void> = (async () => {
    await task();
  })()
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => runTasks.delete(tracked));
  runTasks.add(tracked);
  return true;
}

export function scheduleAiriChatAfterResponse(
  name: string,
  task: () => Promise<void>,
  context?: LogContext
): void {
  const run = AsyncLocalStorage.bind(async () => {
    try {
      await task();
    } catch (error) {
      logger.error(`airi_chat.after_response.${name}_failed`, error, context);
    }
  });
  if (trackInAiriChatRunTaskScope(run)) return;
  try {
    after(run);
  } catch {
    void run();
  }
}
