import {
  describeAiriChatRequestFailure,
  shouldLogAiriChatRequestFailure,
} from "@/lib/airi-chats/errors";
import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";
import { logger } from "@/lib/logger";

/** A comment frame keeps proxies from closing a quiet stream mid-run. */
export const AIRI_CHAT_SSE_PING_INTERVAL_MS = 15_000;

export function createAiriChatSseResponse(
  run: (
    emit: (event: AiriChatRunEvent) => Promise<void>,
    signal: AbortSignal
  ) => Promise<void>,
  options?: { signal?: AbortSignal; pingIntervalMs?: number }
): Response {
  const encoder = new TextEncoder();
  const cancellation = new AbortController();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, cancellation.signal])
    : cancellation.signal;
  let connected = true;
  let removeAbortListener = () => {};
  let stopPing = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        removeAbortListener();
        stopPing();
        if (!connected) return;
        connected = false;
        controller.close();
      };
      signal.addEventListener("abort", close, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", close);
      if (signal.aborted) close();
      // The answer is final once assistant_message is out; a later failure
      // (background bookkeeping) must not turn it into an error banner.
      let answered = false;
      const emit = async (event: AiriChatRunEvent) => {
        if (!connected || signal.aborted) return;
        if (event.type === "assistant_message") answered = true;
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          )
        );
      };

      if (connected) {
        const ping = setInterval(() => {
          if (!connected || signal.aborted) return;
          controller.enqueue(encoder.encode(": ping\n\n"));
        }, options?.pingIntervalMs ?? AIRI_CHAT_SSE_PING_INTERVAL_MS);
        stopPing = () => clearInterval(ping);
      }

      const operation = signal.aborted ? Promise.resolve() : run(emit, signal);
      void operation
        .catch(async error => {
          if (answered) {
            logger.warn("airi_chat.stream_failed_after_answer", {
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          // Only an abort of the run's signal (request or disconnect) is a
          // cancellation; an inner deadline's TimeoutError is a timeout.
          const failure = describeAiriChatRequestFailure(
            error,
            undefined,
            signal
          );
          if (shouldLogAiriChatRequestFailure(failure)) {
            logger.error("airi_chat.stream_failed", error, {
              code: failure.code,
            });
          }
          await emit({
            type: "error",
            message: failure.message,
            code: failure.code,
            status: failure.status,
            persisted: false,
            at: new Date().toISOString(),
          });
        })
        .finally(close);
    },
    cancel(reason) {
      connected = false;
      removeAbortListener();
      stopPing();
      cancellation.abort(reason);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
