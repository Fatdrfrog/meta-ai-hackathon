/**
 * SSE for durable runs: a new send and the resume route both attach to a
 * run. A run executing on this instance streams from the in-process
 * registry (a replay of what the client missed, then live events); any
 * other run is followed in its document: the user message, the stages so
 * far and the answer preview, then new progress every followPollMs until it
 * ends with assistant_message and done. Closing the connection only
 * detaches; the run goes on.
 */

import { createAiriChatSseResponse } from "@/lib/airi-chats/sse";
import {
  createAiriChatRunEventAt,
  type AiriChatRunEvent,
} from "@/lib/airi-chats/run-events";
import { AiriChatMessage } from "@/models/airi-chat-message";
import { AiriChatThread } from "@/models/airi-chat-thread";
import type { IAiriChatRunStage } from "@/models/airi-chat-run";
import type { MessageLike, SupabaseClient, ThreadLike } from "./types";
import { subscribeLiveAiriChatRun } from "./run-live";
import {
  loadAiriChatRun,
  reconcileAiriChatRun,
  type AiriChatRunRecord,
} from "./run-store";
import { AIRI_CHAT_RUN_TIMING, waitForAiriChatRunPoll } from "./run";
import {
  serializeAssistantRunMessage,
  serializeThreadRunEvent,
  serializeUserRunMessage,
} from "./serialization";

type Emit = (event: AiriChatRunEvent) => Promise<void>;

function isTerminalStreamEvent(event: AiriChatRunEvent): boolean {
  return event.type === "done" || event.type === "error";
}

/** The SSE response that follows one run until it ends or the client leaves. */
export function createAiriChatRunStreamResponse(params: {
  runId: string;
  /** The request's signal: its abort only detaches this connection. */
  signal: AbortSignal;
  supabase?: SupabaseClient;
}): Response {
  return createAiriChatSseResponse(
    (emit, signal) =>
      followAiriChatRun({
        runId: params.runId,
        emit,
        signal,
        supabase: params.supabase,
      }),
    { signal: params.signal }
  );
}

export async function followAiriChatRun(params: {
  runId: string;
  emit: Emit;
  signal: AbortSignal;
  supabase?: SupabaseClient;
}): Promise<void> {
  // One ordered queue: replayed events first, then live ones.
  let queue: Promise<void> = Promise.resolve();
  let terminal = false;
  const push = (event: AiriChatRunEvent) => {
    if (isTerminalStreamEvent(event)) terminal = true;
    queue = queue.then(() => params.emit(event));
  };
  const live = subscribeLiveAiriChatRun(params.runId, push);
  if (live) {
    for (const event of live.replay) push(event);
    const detached = new Promise<void>(resolve => {
      if (params.signal.aborted) return resolve();
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([live.closed, detached]);
    live.unsubscribe();
    await queue;
    if (terminal || params.signal.aborted) return;
  }
  await followAiriChatRunInStore({ ...params, emit: params.emit });
}

function stageKey(stage: IAiriChatRunStage): string {
  return JSON.stringify([
    stage.status,
    stage.detail ?? null,
    stage.durationMs ?? null,
  ]);
}

async function followAiriChatRunInStore(params: {
  runId: string;
  emit: Emit;
  signal: AbortSignal;
  supabase?: SupabaseClient;
}): Promise<void> {
  const { emit, signal } = params;
  const load = async (): Promise<AiriChatRunRecord | null> => {
    const run = await loadAiriChatRun(params.runId);
    return run
      ? reconcileAiriChatRun(run, { supabase: params.supabase })
      : null;
  };
  let run = await load();
  if (!run) {
    await emit({
      type: "error",
      message: "Airi run not found",
      code: "airi_run_not_found",
      status: 404,
      persisted: false,
      at: createAiriChatRunEventAt(),
    });
    return;
  }
  await emit({
    type: "run",
    runId: String(run._id),
    threadId: String(run.threadId),
    clientTurnId: run.clientTurnId,
    status: run.status,
    at: createAiriChatRunEventAt(),
  });

  const sentStages = new Map<string, string>();
  let sentUserMessage = false;
  let sentPreview = "";
  const sendProgress = async (current: AiriChatRunRecord) => {
    if (!sentUserMessage && current.userMessageId) {
      const message = await AiriChatMessage.findOne({
        _id: current.userMessageId,
        workspaceId: current.workspaceId,
      }).lean<MessageLike | null>();
      if (message) {
        sentUserMessage = true;
        await emit({
          type: "user_message",
          message: serializeUserRunMessage(message),
          at: createAiriChatRunEventAt(),
        });
      }
    }
    for (const stage of current.stages ?? []) {
      const key = stageKey(stage);
      if (sentStages.get(stage.id) === key) continue;
      sentStages.set(stage.id, key);
      await emit({
        type: "stage",
        id: stage.id,
        label: stage.label,
        status: stage.status,
        detail: stage.detail ?? null,
        ...(stage.durationMs !== undefined && stage.durationMs !== null
          ? { durationMs: stage.durationMs }
          : {}),
        at: stage.at,
      });
    }
    if (
      current.status === "running" &&
      current.partialText &&
      current.partialText !== sentPreview
    ) {
      sentPreview = current.partialText;
      await emit({
        type: "assistant_delta",
        threadId: String(current.threadId),
        text: current.partialText,
        at: createAiriChatRunEventAt(),
      });
    }
  };

  await sendProgress(run);
  while (run.status === "running") {
    await waitForAiriChatRunPoll(AIRI_CHAT_RUN_TIMING.followPollMs, signal);
    if (signal.aborted) return;
    const next = await load();
    if (!next) return;
    run = next;
    await sendProgress(run);
  }
  // The interrupted transition and its failure reply are two writes.
  if (run.status === "interrupted" && run.userMessageId) {
    for (let retry = 0; retry < 4 && !run.assistantMessageId; retry += 1) {
      await waitForAiriChatRunPoll(AIRI_CHAT_RUN_TIMING.followPollMs, signal);
      if (signal.aborted) return;
      run = (await loadAiriChatRun(params.runId)) ?? run;
    }
  }

  const [answer, thread] = await Promise.all([
    run.assistantMessageId
      ? AiriChatMessage.findOne({
          _id: run.assistantMessageId,
          workspaceId: run.workspaceId,
        }).lean<MessageLike | null>()
      : null,
    AiriChatThread.findOne({
      _id: run.threadId,
      workspaceId: run.workspaceId,
    }).lean<ThreadLike | null>(),
  ]);
  if (answer) {
    await emit({
      type: "assistant_message",
      message: serializeAssistantRunMessage(answer),
      at: createAiriChatRunEventAt(),
    });
  }
  if (thread && (answer || run.status === "cancelled")) {
    await emit({
      type: "done",
      thread: serializeThreadRunEvent(thread),
      status: run.status === "running" ? "interrupted" : run.status,
      at: createAiriChatRunEventAt(),
    });
    return;
  }
  await emit({
    type: "error",
    message: "Failed to send Airi message",
    code: run.errorCode ?? "airi_chat_failed",
    persisted: false,
    at: createAiriChatRunEventAt(),
  });
}
