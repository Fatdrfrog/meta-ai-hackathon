/**
 * In-process registry of the durable runs executing on this instance. Live
 * SSE connections on the same instance get a run's events from here (with a
 * replay of what they missed); connections elsewhere follow the run's
 * document instead (run-stream.ts). The registry also holds each run's
 * AbortController so a cancel that lands on this instance stops it at once.
 */

import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";

/** How long a finished run stays here for late attaches and replays. */
export const AIRI_CHAT_LIVE_RUN_RETENTION_MS = 60_000;

type LiveRunListener = (event: AiriChatRunEvent) => void;

type LiveRun = {
  controller: AbortController;
  /** Every event but the answer previews, in order. */
  events: AiriChatRunEvent[];
  /** The latest preview and where it sits among `events`. */
  delta: { event: AiriChatRunEvent; index: number } | null;
  listeners: Set<LiveRunListener>;
  closers: Set<() => void>;
  finished: boolean;
};

// One registry per process, also when the route bundles load this module
// more than once.
const registryKey = Symbol.for("airi.chat.liveRuns");
const registry: Map<string, LiveRun> = ((
  globalThis as unknown as Record<symbol, Map<string, LiveRun> | undefined>
)[registryKey] ??= new Map());

export function registerLiveAiriChatRun(
  runId: string,
  controller: AbortController
): void {
  registry.set(runId, {
    controller,
    events: [],
    delta: null,
    listeners: new Set(),
    closers: new Set(),
    finished: false,
  });
}

export function isLiveAiriChatRun(runId: string): boolean {
  return registry.has(runId);
}

export function publishLiveAiriChatRunEvent(
  runId: string,
  event: AiriChatRunEvent
): void {
  const run = registry.get(runId);
  if (!run || run.finished) return;
  if (event.type === "assistant_delta") {
    run.delta = { event, index: run.events.length };
  } else {
    // The final answer replaces the preview for anyone attaching later.
    if (event.type === "assistant_message") run.delta = null;
    run.events.push(event);
  }
  for (const listener of run.listeners) listener(event);
}

/**
 * Attaches to a run executing here: the events so far (one preview at most,
 * where it was), then every new event through `listener`, and `closed`
 * once the run has finished. Null when the run is not on this instance.
 */
export function subscribeLiveAiriChatRun(
  runId: string,
  listener: LiveRunListener
): {
  replay: AiriChatRunEvent[];
  closed: Promise<void>;
  unsubscribe: () => void;
} | null {
  const run = registry.get(runId);
  if (!run) return null;
  const replay = [...run.events];
  if (run.delta) replay.splice(run.delta.index, 0, run.delta.event);
  if (run.finished) {
    return { replay, closed: Promise.resolve(), unsubscribe: () => {} };
  }
  let close = () => {};
  const closed = new Promise<void>(resolve => {
    close = resolve;
  });
  run.listeners.add(listener);
  run.closers.add(close);
  return {
    replay,
    closed,
    unsubscribe: () => {
      run.listeners.delete(listener);
      run.closers.delete(close);
      close();
    },
  };
}

/** Stops a run executing here; false when it is not on this instance. */
export function abortLiveAiriChatRun(runId: string, reason: unknown): boolean {
  const run = registry.get(runId);
  if (!run || run.finished) return false;
  run.controller.abort(reason);
  return true;
}

/** The run ended: listeners are released and the replay kept for a while. */
export function finishLiveAiriChatRun(runId: string): void {
  const run = registry.get(runId);
  if (!run || run.finished) return;
  run.finished = true;
  run.listeners.clear();
  for (const close of run.closers) close();
  run.closers.clear();
  const timer = setTimeout(() => {
    if (registry.get(runId) === run) registry.delete(runId);
  }, AIRI_CHAT_LIVE_RUN_RETENTION_MS);
  timer.unref?.();
}
