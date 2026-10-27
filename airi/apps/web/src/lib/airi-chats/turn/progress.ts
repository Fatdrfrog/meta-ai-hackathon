/** Run progress: the stage recorder, stage events and answer deltas. */

import type { AIChatDeltaEvent, AIChatLifecycleEvent } from "@/lib/ai";
import {
  createAiriChatRunEventAt,
  type AiriChatRunEvent,
  type AiriChatRunProgressEmitter,
  type AiriChatRunResource,
  type AiriChatThinkingTrace,
} from "@/lib/airi-chats/run-events";
import type { AiriChatProgressRecorder } from "./types";

export function createProgressRecorder(
  emitProgress?: AiriChatRunProgressEmitter
): AiriChatProgressRecorder {
  const stages: AiriChatThinkingTrace["stages"] = [];
  const resources: AiriChatRunResource[] = [];
  const emit: AiriChatRunProgressEmitter = async event => {
    if (event.type === "stage") {
      stages.push({
        id: event.id,
        label: event.label,
        status: event.status,
        detail: event.detail ?? null,
        ...(event.durationMs !== undefined
          ? { durationMs: event.durationMs }
          : {}),
        at: event.at,
      });
    }
    if (event.type === "resources") {
      resources.splice(0, resources.length, ...event.resources);
    }
    await emitProgress?.(event);
  };
  return { emit, stages, resources, live: Boolean(emitProgress) };
}

export function stageEvent(
  id: string,
  label: string,
  status: "running" | "complete" | "error",
  detail?: string | null,
  durationMs?: number
): AiriChatRunEvent {
  return {
    type: "stage",
    id,
    label,
    status,
    detail,
    ...(durationMs !== undefined ? { durationMs } : {}),
    at: createAiriChatRunEventAt(),
  };
}

/** Minimum gap between assistant_delta events while an answer streams. */
export const AIRI_CHAT_DELTA_THROTTLE_MS = 80;

/**
 * Throttled assistant_delta emitter for one generation call. Each event
 * carries the full accumulated text; a provider fallback simply restarts it.
 * `stop()` drops anything pending so no preview follows the final message.
 */
export function createAssistantDeltaStream(params: {
  threadId: string;
  progress: AiriChatProgressRecorder;
  throttleMs?: number;
}): {
  onDelta: ((event: AIChatDeltaEvent) => void) | undefined;
  stop: () => void;
} {
  if (!params.progress.live) return { onDelta: undefined, stop: () => {} };
  const throttleMs = params.throttleMs ?? AIRI_CHAT_DELTA_THROTTLE_MS;
  let stopped = false;
  let pending: string | null = null;
  let lastSent: string | null = null;
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const text = pending;
    pending = null;
    if (stopped || text === null || text === lastSent) return;
    lastSent = text;
    lastSentAt = Date.now();
    void Promise.resolve(
      params.progress.emit({
        type: "assistant_delta",
        threadId: params.threadId,
        text,
        at: createAiriChatRunEventAt(),
      })
    ).catch(() => undefined);
  };
  return {
    onDelta: event => {
      if (stopped || !event.accumulated) return;
      pending = event.accumulated;
      const waitMs = lastSentAt + throttleMs - Date.now();
      if (waitMs <= 0) {
        if (timer) clearTimeout(timer);
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, waitMs);
      }
    },
    stop: () => {
      stopped = true;
      pending = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function buildModelRunEvent(
  event: AIChatLifecycleEvent
): AiriChatRunEvent {
  if (event.type === "model_fallback") {
    return {
      type: "model_attempt",
      id: `model-fallback:${event.toModel}:${event.fallbackIndex}`,
      label: "Switching model",
      status: "running",
      model: event.toModel,
      fallbackIndex: event.fallbackIndex,
      detail: `Fallback from ${event.fromModel}`,
      at: createAiriChatRunEventAt(),
    };
  }

  const attempt = event.attempt + 1;
  if (event.type === "attempt_start") {
    return {
      type: "model_attempt",
      id: `model:${event.model}:${event.fallbackIndex}:${event.attempt}`,
      label:
        event.fallbackIndex > 0 ? "Trying fallback model" : "Calling model",
      status: "running",
      model: event.model,
      attempt,
      fallbackIndex: event.fallbackIndex,
      at: createAiriChatRunEventAt(),
    };
  }
  if (event.type === "attempt_success") {
    return {
      type: "model_attempt",
      id: `model:${event.model}:${event.fallbackIndex}:${event.attempt}`,
      label: "Model answered",
      status: "complete",
      model: event.model,
      attempt,
      fallbackIndex: event.fallbackIndex,
      detail: `${event.latencyMs}ms`,
      at: createAiriChatRunEventAt(),
    };
  }
  if (event.type === "retry_wait") {
    return {
      type: "model_attempt",
      id: `model-retry:${event.model}:${event.fallbackIndex}:${event.attempt}`,
      label: "Retrying model capacity",
      status: "running",
      model: event.model,
      attempt,
      fallbackIndex: event.fallbackIndex,
      retryable: true,
      detail: `${event.delayMs}ms backoff`,
      at: createAiriChatRunEventAt(),
    };
  }
  return {
    type: "model_attempt",
    id: `model-error:${event.model}:${event.fallbackIndex}:${event.attempt}`,
    label: event.retryable ? "Model capacity issue" : "Model error",
    status: "error",
    model: event.model,
    attempt,
    fallbackIndex: event.fallbackIndex,
    retryable: event.retryable,
    detail: event.retryable ? "Retryable provider error" : "Provider error",
    at: createAiriChatRunEventAt(),
  };
}
