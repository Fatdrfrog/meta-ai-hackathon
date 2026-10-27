/**
 * Durable Airi chat runs: a turn that keeps going when its client goes away.
 *
 * The run claims a document (run-store.ts), executes the turn engine with
 * its own AbortController (never the request's signal), persists the
 * engine's stages, a throttled copy of the streamed answer and a heartbeat,
 * polls for the user's Stop, and ends with a terminal status and a saved
 * reply. Live connections on this instance get its events in process
 * (run-live.ts); any other connection follows the document (run-stream.ts).
 *
 * Keeping the function alive (checked against Next.js 16.3.5,
 * next/dist/server/after/after.js and after-context.js, and the route
 * template build/templates/app-route.js):
 * - after(promise) goes to AfterContext.addThenable, which calls
 *   waitUntil(promise) at once; it does not wait for the response to close
 *   (only after(callback) is queued until res 'close').
 * - waitUntil is the platform's request context waitUntil (Vercel) or the
 *   server's internal one (next start); onClose is res.on('close'). The
 *   route's request.signal (signalFromNodeResponse) aborts on that close,
 *   which is why the run never uses it: a closed drawer must not stop it.
 * - after() needs the request's work stores, so startAiriChatRun is awaited
 *   by the route handler itself, before it returns the Response.
 * - Bookkeeping the turn schedules after its answer runs inside the run's
 *   task scope (after-response.ts) and the kept-alive promise waits for it,
 *   because a late after(callback) is not covered once the request's own
 *   after-queue has drained.
 * Outside a request scope (tests, scripts) after() throws and the promise
 * simply runs on.
 */

import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { after } from "next/server";
import { runInAiriChatRunTaskScope } from "@/lib/airi-chats/after-response";
import { describeAiriChatRequestFailure } from "@/lib/airi-chats/errors";
import type { AiriChatAttachmentInput } from "@/lib/airi-chats/request-schemas";
import {
  createAiriChatRunEventAt,
  type AiriChatRunEvent,
  type AiriChatRunResource,
} from "@/lib/airi-chats/run-events";
import type { AiriChatSourceRef } from "@/lib/airi-chats/source-types";
import { logger } from "@/lib/logger";
import { AiriChatMessage } from "@/models/airi-chat-message";
import type {
  AiriChatRunStatus,
  IAiriChatRunStage,
} from "@/models/airi-chat-run";
import {
  AiriChatThread,
  type AiriChatThreadSource,
} from "@/models/airi-chat-thread";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import {
  AiriTurnDeadlineExceededError,
  createAiriTurnDeadline,
  type AiriTurnDeadline,
} from "./deadline";
import {
  buildAiriChatFailureReply,
  getAiriTurnFailureMessage,
} from "./failure";
import { appendAiriChatTurn, createAndAppendAiriChatTurn } from "./engine";
import {
  clampAiriChatReplyForStorage,
  isAiriChatCancelledReply,
  type AiriChatThreadDocument,
} from "./persistence";
import {
  abortLiveAiriChatRun,
  finishLiveAiriChatRun,
  publishLiveAiriChatRunEvent,
  registerLiveAiriChatRun,
} from "./run-live";
import {
  buildAiriChatRunProgressSnapshot,
  findActiveAiriChatRun,
  findAiriChatRunByClientTurn,
  finishAiriChatRun,
  heartbeatAiriChatRun,
  insertAiriChatRun,
  loadAiriChatRun,
  readAiriChatRunControl,
  reconcileAiriChatRun,
  resolveAiriChatRunLanguage,
  saveAiriChatRunReply,
  updateRunningAiriChatRun,
  type AiriChatRunRecord,
} from "./run-store";
import {
  serializeAiriChatMessage,
  serializeAiriChatThread,
} from "./serialization";
import type {
  MessageLike,
  SerializedAiriChatMessage,
  SerializedAiriChatThread,
  SupabaseClient,
  ThreadLike,
} from "./types";

/** Run timing. Tests shorten these; production keeps the defaults. */
export const AIRI_CHAT_RUN_TIMING = {
  /** Cancel poll; every heartbeatEveryPolls-th poll is the heartbeat. */
  controlPollMs: 1_000,
  heartbeatEveryPolls: 5,
  /** Throttle of the persisted answer preview. */
  partialTextWriteMs: 500,
  /** Resume streams and attached JSON requests poll the run this often. */
  followPollMs: 500,
  /** Past the turn's deadline the run is stopped outright. */
  hardStopGraceMs: 5_000,
  /** The terminal write of an answered run is retried this often. */
  finishAttempts: 3,
  finishRetryMs: 250,
};

/** The user pressed Stop. */
export class AiriChatRunCancelledError extends Error {
  constructor() {
    super("Airi chat run cancelled");
    this.name = "AbortError";
  }
}

/** Another reader reconciled this run as interrupted; stop quietly. */
export class AiriChatRunLostError extends Error {
  constructor() {
    super("Airi chat run is no longer running");
    this.name = "AbortError";
  }
}

/** An attached request found the run ended without an answer to return. */
export class AiriChatRunEndedWithoutAnswerError extends Error {
  constructor(readonly runStatus: string) {
    super("Airi chat run ended without an answer");
    this.name = "AiriChatRunEndedWithoutAnswerError";
  }
}

export type AiriChatTurnResult = {
  userMessage: SerializedAiriChatMessage;
  assistantMessage: SerializedAiriChatMessage;
  thread: SerializedAiriChatThread;
};

export type AiriChatRunTerminalStatus = Exclude<AiriChatRunStatus, "running">;

export type AiriChatRunOutcome = {
  status: AiriChatRunTerminalStatus;
  turn: AiriChatTurnResult | null;
  /** The turn's own error when it ended before answering. */
  error?: unknown;
};

export type AiriChatRunRef = {
  runId: string;
  workspaceId: string;
  threadId: string;
  clientTurnId: string;
};

export type AiriChatRunStart =
  | { kind: "conflict"; runId: string | null }
  | {
      kind: "started";
      run: AiriChatRunRef;
      outcome: Promise<AiriChatRunOutcome>;
    }
  | { kind: "attached"; run: AiriChatRunRef };

type AiriChatRunTurnBase = {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  clientTurnId?: string | null;
  content: string;
  selectedSources?: AiriChatSourceRef[];
  attachedFiles?: AiriChatAttachmentInput[];
  activeBuilder?: unknown;
  /** Called once the answer is saved (not for a stopped turn). */
  onTurnSaved?: (turn: AiriChatTurnResult) => void | Promise<void>;
};

export type AiriChatRunTurnInput = AiriChatRunTurnBase &
  (
    | { threadId: string; thread: AiriChatThreadDocument }
    | {
        threadId?: undefined;
        thread?: undefined;
        source?: AiriChatThreadSource | null;
      }
  );

function toRunRef(run: AiriChatRunRecord): AiriChatRunRef {
  return {
    runId: String(run._id),
    workspaceId: run.workspaceId,
    threadId: String(run.threadId),
    clientTurnId: run.clientTurnId,
  };
}

/**
 * Starts the turn as a durable run, or attaches to the run this client turn
 * already has (a retried send), or reports the thread's other active run.
 */
export async function startAiriChatRun(
  input: AiriChatRunTurnInput
): Promise<AiriChatRunStart> {
  const clientTurnId = input.clientTurnId?.trim() || randomUUID();
  const owner = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    clientTurnId,
  };
  // Two attempts: an active run that finished between the check and the
  // insert frees the thread for the second one.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await findAiriChatRunByClientTurn(owner);
    if (existing) return { kind: "attached", run: toRunRef(existing) };
    if (input.threadId) {
      const active = await findActiveAiriChatRun({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        supabase: input.supabase,
      });
      if (active) return { kind: "conflict", runId: String(active._id) };
    }

    const deadline = createAiriTurnDeadline();
    const now = new Date();
    const record: AiriChatRunRecord = {
      _id: new Types.ObjectId(),
      workspaceId: input.workspaceId,
      // A new chat's id is allocated now; the turn creates the chat with it.
      threadId: input.threadId
        ? new Types.ObjectId(input.threadId)
        : new Types.ObjectId(),
      userId: input.userId,
      clientTurnId,
      status: "running",
      intent: null,
      stages: [],
      partialText: "",
      partialTextUpdatedAt: null,
      userMessageId: null,
      assistantMessageId: null,
      errorCode: null,
      cancelRequestedAt: null,
      heartbeatAt: now,
      deadlineAt: new Date(deadline.deadlineAt),
      startedAt: now,
      completedAt: null,
    };
    if (await insertAiriChatRun(record)) {
      return {
        kind: "started",
        run: toRunRef(record),
        outcome: executeAiriChatRun(record, input, deadline),
      };
    }
  }
  const existing = await findAiriChatRunByClientTurn(owner);
  if (existing) return { kind: "attached", run: toRunRef(existing) };
  const active = input.threadId
    ? await findActiveAiriChatRun({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
      })
    : null;
  return { kind: "conflict", runId: active ? String(active._id) : null };
}

/** Keeps the serverless function alive until the run and its tasks end. */
function keepAiriChatRunAlive(work: Promise<unknown>): void {
  try {
    after(work);
  } catch {
    // Outside a request scope (tests, scripts) the promise runs on its own.
  }
}

function executeAiriChatRun(
  record: AiriChatRunRecord,
  input: AiriChatRunTurnInput,
  deadline: AiriTurnDeadline
): Promise<AiriChatRunOutcome> {
  const runId = String(record._id);
  const controller = new AbortController();
  registerLiveAiriChatRun(runId, controller);
  const recorder = createAiriChatRunRecorder(record);
  recorder.publish({
    type: "run",
    runId,
    threadId: String(record.threadId),
    clientTurnId: record.clientTurnId,
    status: "running",
    at: createAiriChatRunEventAt(),
  });
  const tasks = new Set<Promise<void>>();
  const outcome = runInAiriChatRunTaskScope(tasks, () =>
    runAiriChatTurn({ record, input, deadline, controller, recorder })
  ).catch((error): AiriChatRunOutcome => {
    logger.error("airi_chat.run_crashed", error, {
      workspaceId: record.workspaceId,
      runId,
    });
    finishLiveAiriChatRun(runId);
    return { status: "failed", turn: null, error };
  });
  keepAiriChatRunAlive(
    outcome.then(async () => {
      while (tasks.size > 0) await Promise.allSettled([...tasks]);
    })
  );
  return outcome;
}

type AiriChatRunRecorder = ReturnType<typeof createAiriChatRunRecorder>;

/**
 * The engine's progress emitter for a run: persists stage changes at once,
 * the answer preview at most every partialTextWriteMs, the saved user
 * message's id, and publishes every event to live connections. The engine's
 * own 'done' is held back: the run sends it with its terminal status.
 */
function createAiriChatRunRecorder(record: AiriChatRunRecord) {
  const runId = String(record._id);
  const stages: IAiriChatRunStage[] = [];
  let resources: AiriChatRunResource[] = [];
  let intent: string | null = null;
  let partialText = "";
  let userMessage:
    | Extract<AiriChatRunEvent, { type: "user_message" }>["message"]
    | null = null;
  let thread: Extract<AiriChatRunEvent, { type: "thread" }>["thread"] | null =
    null;
  let assistantMessage:
    | Extract<AiriChatRunEvent, { type: "assistant_message" }>["message"]
    | null = null;
  const dirty = new Set<"stages" | "partial" | "user" | "assistant">();
  let writes: Promise<void> = Promise.resolve();
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPartialWriteAt = 0;
  let previewing = true;

  const write = (): Promise<void> => {
    writes = writes.then(async () => {
      if (dirty.size === 0) return;
      const set: Parameters<typeof updateRunningAiriChatRun>[1] = {};
      if (dirty.has("stages")) {
        set.stages = stages.map(stage => ({ ...stage }));
        if (intent) set.intent = intent;
      }
      if (dirty.has("partial")) {
        set.partialText = partialText;
        set.partialTextUpdatedAt = new Date();
        lastPartialWriteAt = Date.now();
      }
      if (dirty.has("user") && userMessage) {
        set.userMessageId = new Types.ObjectId(userMessage.id);
      }
      // The saved answer's id goes on the run at once: a run whose terminal
      // write fails (or whose process dies) is then reconciled without a
      // second, failure reply.
      if (dirty.has("assistant") && assistantMessage) {
        set.assistantMessageId = new Types.ObjectId(assistantMessage.id);
      }
      dirty.clear();
      try {
        await updateRunningAiriChatRun(record._id, set);
      } catch (error) {
        logger.warn("airi_chat.run_progress_write_failed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return writes;
  };

  const clearPartialTimer = () => {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
  };

  const emit = async (event: AiriChatRunEvent): Promise<void> => {
    switch (event.type) {
      case "stage": {
        const stage: IAiriChatRunStage = {
          id: event.id,
          label: event.label,
          status: event.status,
          detail: event.detail ?? null,
          ...(event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
          at: event.at,
        };
        const index = stages.findIndex(existing => existing.id === event.id);
        if (index === -1) stages.push(stage);
        else stages[index] = stage;
        if (event.id === "intent" && event.status === "complete") {
          intent = event.detail ?? intent;
        }
        dirty.add("stages");
        void write();
        break;
      }
      case "assistant_delta": {
        if (!previewing) return;
        partialText = event.text;
        dirty.add("partial");
        if (!partialTimer) {
          partialTimer = setTimeout(
            () => {
              partialTimer = null;
              void write();
            },
            Math.max(
              0,
              lastPartialWriteAt +
                AIRI_CHAT_RUN_TIMING.partialTextWriteMs -
                Date.now()
            )
          );
        }
        break;
      }
      case "user_message":
        userMessage = event.message;
        dirty.add("user");
        void write();
        break;
      case "thread":
        thread = event.thread;
        break;
      case "resources":
        resources = event.resources;
        break;
      case "assistant_message":
        previewing = false;
        clearPartialTimer();
        dirty.delete("partial");
        assistantMessage = event.message;
        dirty.add("assistant");
        void write();
        break;
      case "done":
        thread = event.thread;
        return;
      default:
        break;
    }
    publishLiveAiriChatRunEvent(runId, event);
  };

  return {
    emit,
    publish: (event: AiriChatRunEvent) =>
      publishLiveAiriChatRunEvent(runId, event),
    /** Stops preview writes and waits for the queued progress writes. */
    settle: async () => {
      previewing = false;
      clearPartialTimer();
      dirty.delete("partial");
      await write();
    },
    stages: () => stages.map(stage => ({ ...stage })),
    resources: () => resources,
    intent: () => intent,
    partialText: () => partialText,
    userMessage: () => userMessage,
    /** The answer the turn saved itself, once it reported it. */
    assistantMessage: () => assistantMessage,
    thread: () => thread,
  };
}

/**
 * Polls the run's document: the user's Stop every controlPollMs, and every
 * heartbeatEveryPolls-th poll writes the heartbeat. A run that is no longer
 * running (another reader reconciled it as interrupted) is stopped.
 */
function startAiriChatRunMonitor(
  runId: Types.ObjectId,
  handlers: { onCancel: () => void; onLost: () => void }
): { stop: () => void } {
  let polls = 0;
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    polls += 1;
    const heartbeat = polls % AIRI_CHAT_RUN_TIMING.heartbeatEveryPolls === 0;
    void (
      heartbeat
        ? heartbeatAiriChatRun(runId, new Date())
        : readAiriChatRunControl(runId)
    )
      .then(control => {
        if (stopped) return;
        if (!control || control.status !== "running") handlers.onLost();
        else if (control.cancelRequestedAt) handlers.onCancel();
      })
      .catch(error => {
        logger.warn("airi_chat.run_monitor_failed", {
          runId: String(runId),
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        busy = false;
      });
  }, AIRI_CHAT_RUN_TIMING.controlPollMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function isTimeoutReason(reason: unknown): boolean {
  return Boolean(
    reason &&
      typeof reason === "object" &&
      "name" in reason &&
      (reason as { name?: unknown }).name === "TimeoutError"
  );
}

async function loadSerializedThread(
  record: AiriChatRunRecord
): Promise<SerializedAiriChatThread | null> {
  const thread = await AiriChatThread.findOne({
    _id: record.threadId,
    workspaceId: record.workspaceId,
  }).lean<ThreadLike | null>();
  return thread ? serializeAiriChatThread(thread) : null;
}

function toDoneThread(
  thread: SerializedAiriChatThread
): Extract<AiriChatRunEvent, { type: "done" }>["thread"] {
  return {
    id: thread.id,
    title: thread.title,
    source: thread.source,
    pinnedAt: thread.pinnedAt,
    updatedAt: thread.updatedAt,
  };
}

async function runAiriChatTurn(params: {
  record: AiriChatRunRecord;
  input: AiriChatRunTurnInput;
  deadline: AiriTurnDeadline;
  controller: AbortController;
  recorder: AiriChatRunRecorder;
}): Promise<AiriChatRunOutcome> {
  const { record, input, deadline, controller, recorder } = params;
  const runId = String(record._id);
  const startedAt = Date.now();
  const monitor = startAiriChatRunMonitor(record._id, {
    onCancel: () => controller.abort(new AiriChatRunCancelledError()),
    onLost: () => controller.abort(new AiriChatRunLostError()),
  });
  const hardStop = setTimeout(
    () => {
      const timeout = new Error("Airi chat run passed its deadline");
      timeout.name = "TimeoutError";
      controller.abort(timeout);
    },
    Math.max(
      0,
      deadline.deadlineAt + AIRI_CHAT_RUN_TIMING.hardStopGraceMs - Date.now()
    )
  );
  hardStop.unref?.();

  try {
    const common = {
      supabase: input.supabase,
      workspaceId: input.workspaceId,
      userId: input.userId,
      content: input.content,
      selectedSources: input.selectedSources,
      attachedFiles: input.attachedFiles,
      activeBuilder: input.activeBuilder,
      emitProgress: recorder.emit,
      signal: controller.signal,
      deadline,
      userMessageId: new Types.ObjectId(),
    };
    let turn: AiriChatTurnResult;
    // Only the turn itself leads to the unanswered path: once it returned,
    // its answer is saved and delivered, and the run's own bookkeeping
    // failing must never add a failure reply after it.
    try {
      turn =
        input.threadId !== undefined
          ? await appendAiriChatTurn({
              ...common,
              threadId: input.threadId,
              thread: input.thread,
            })
          : await createAndAppendAiriChatTurn({
              ...common,
              source: input.source,
              threadId: record.threadId,
            });
    } catch (error) {
      monitor.stop();
      await recorder.settle();
      return await settleUnansweredAiriChatRun({
        record,
        input,
        controller,
        recorder,
        error,
        startedAt,
      });
    }
    monitor.stop();
    await recorder.settle();
    return await finishAnsweredAiriChatRun({ record, input, recorder, turn });
  } finally {
    monitor.stop();
    clearTimeout(hardStop);
    finishLiveAiriChatRun(runId);
  }
}

/**
 * The terminal write of a run whose answer is already saved: retried, and a
 * failure is only logged (the answer's id is already on the run, so a later
 * reconciliation adds no reply). True when written, false when the run was
 * already reconciled, null when the write kept failing.
 */
async function finishAnsweredAiriChatRunRecord(
  record: AiriChatRunRecord,
  result: Parameters<typeof finishAiriChatRun>[1]
): Promise<boolean | null> {
  for (
    let attempt = 1;
    attempt <= AIRI_CHAT_RUN_TIMING.finishAttempts;
    attempt += 1
  ) {
    try {
      return await finishAiriChatRun(record._id, result);
    } catch (error) {
      if (attempt === AIRI_CHAT_RUN_TIMING.finishAttempts) {
        logger.error("airi_chat.run_finish_failed", error, {
          workspaceId: record.workspaceId,
          runId: String(record._id),
        });
        return null;
      }
      await waitForAiriChatRunPoll(
        AIRI_CHAT_RUN_TIMING.finishRetryMs * attempt
      );
    }
  }
  return null;
}

/** The status a reconciled run ended with, for the live 'done'. */
async function loadReconciledAiriChatRunStatus(
  record: AiriChatRunRecord
): Promise<AiriChatRunTerminalStatus | null> {
  const run = await loadAiriChatRun(record._id).catch(() => null);
  return run && run.status !== "running" ? run.status : null;
}

/**
 * The turn saved its answer. The run's outcome comes from that reply: a
 * stopped reply is 'cancelled', a failure reply 'failed', anything else
 * 'completed', even when a Stop arrived after the answer was saved.
 */
async function finishAnsweredAiriChatRun(params: {
  record: AiriChatRunRecord;
  input: AiriChatRunTurnInput;
  recorder: AiriChatRunRecorder;
  turn: AiriChatTurnResult;
}): Promise<AiriChatRunOutcome> {
  const { record, input, recorder, turn } = params;
  const runId = String(record._id);
  const metadata = turn.assistantMessage.metadata ?? {};
  const status: AiriChatRunTerminalStatus =
    metadata.failed === true
      ? "failed"
      : isAiriChatCancelledReply(metadata)
        ? "cancelled"
        : "completed";
  const finished = await finishAnsweredAiriChatRunRecord(record, {
    status,
    errorCode:
      status === "failed" && typeof metadata.errorCode === "string"
        ? metadata.errorCode
        : status === "cancelled"
          ? "airi_run_cancelled"
          : null,
    assistantMessageId: turn.assistantMessage.id,
    userMessageId: turn.userMessage.id,
    stages: recorder.stages(),
  });
  // Reconciled meanwhile: report the status the run document holds.
  const doneStatus =
    finished === false
      ? ((await loadReconciledAiriChatRunStatus(record)) ?? status)
      : status;
  recorder.publish({
    type: "done",
    thread: toDoneThread(turn.thread),
    status: doneStatus,
    at: createAiriChatRunEventAt(),
  });
  if (status !== "cancelled" && input.onTurnSaved) {
    try {
      await input.onTurnSaved(turn);
    } catch (error) {
      logger.error("airi_chat.run_on_turn_saved_failed", error, {
        workspaceId: record.workspaceId,
        runId,
      });
    }
  }
  return { status: doneStatus, turn };
}

/**
 * Another reader reconciled the run as interrupted (and saved the failure
 * reply when the user message had none): live connections get that reply.
 */
async function publishReconciledAiriChatRun(
  record: AiriChatRunRecord,
  recorder: AiriChatRunRecorder,
  error: unknown
): Promise<AiriChatRunOutcome> {
  const run = await loadAiriChatRun(record._id).catch(() => null);
  const message = run?.assistantMessageId
    ? await AiriChatMessage.findOne({
        _id: run.assistantMessageId,
      })
        .lean<MessageLike | null>()
        .catch(() => null)
    : null;
  const thread = await loadSerializedThread(record).catch(() => null);
  if (message) {
    recorder.publish({
      type: "assistant_message",
      message: { ...serializeAiriChatMessage(message), role: "assistant" },
      at: createAiriChatRunEventAt(),
    });
  }
  const status: AiriChatRunTerminalStatus =
    run && run.status !== "running" ? run.status : "interrupted";
  if (thread) {
    recorder.publish({
      type: "done",
      thread: toDoneThread(thread),
      status,
      at: createAiriChatRunEventAt(),
    });
  }
  return { status, turn: null, error };
}

/**
 * The turn threw before its answer was saved: a Stop, the deadline, a lost
 * run or a failure. A saved user message always gets a reply (the partial
 * answer, a localized "Stopped." note, or the failure reply); without one
 * the run only records how it ended.
 */
async function settleUnansweredAiriChatRun(params: {
  record: AiriChatRunRecord;
  input: AiriChatRunTurnInput;
  controller: AbortController;
  recorder: AiriChatRunRecorder;
  error: unknown;
  startedAt: number;
}): Promise<AiriChatRunOutcome> {
  const { record, input, controller, recorder, error } = params;
  const runId = String(record._id);
  const reason = controller.signal.aborted
    ? controller.signal.reason
    : undefined;

  if (reason instanceof AiriChatRunLostError) {
    // Another reader marked it interrupted and saved the failure reply.
    return await publishReconciledAiriChatRun(record, recorder, error);
  }

  const userMessage = recorder.userMessage();
  const savedAnswer = recorder.assistantMessage();
  if (userMessage && savedAnswer) {
    // The turn saved and reported its answer before it threw: that answer
    // is the reply, never a second, failure one.
    const thread = await loadSerializedThread(record).catch(() => null);
    if (thread) {
      return await finishAnsweredAiriChatRun({
        record,
        input,
        recorder,
        turn: {
          userMessage: {
            ...userMessage,
            workspaceId: record.workspaceId,
            metadata: userMessage.metadata ?? null,
          },
          assistantMessage: {
            ...savedAnswer,
            workspaceId: record.workspaceId,
            metadata: savedAnswer.metadata ?? null,
          },
          thread,
        },
      });
    }
  }

  const cancelled = reason instanceof AiriChatRunCancelledError;
  const timedOut = isTimeoutReason(reason);
  if (!userMessage) {
    const status: AiriChatRunTerminalStatus = cancelled
      ? "cancelled"
      : "failed";
    const failure = describeAiriChatRequestFailure(error);
    await finishAiriChatRun(record._id, {
      status,
      errorCode: cancelled ? "airi_run_cancelled" : failure.code,
      stages: recorder.stages(),
    }).catch(() => false);
    const thread = cancelled
      ? await loadSerializedThread(record).catch(() => null)
      : null;
    if (thread) {
      recorder.publish({
        type: "done",
        thread: toDoneThread(thread),
        status,
        at: createAiriChatRunEventAt(),
      });
    } else {
      if (!cancelled && failure.code === "airi_chat_failed") {
        logger.error("airi_chat.run_failed", error, {
          workspaceId: record.workspaceId,
          runId,
        });
      }
      recorder.publish({
        type: "error",
        message: cancelled ? "Request cancelled" : failure.message,
        code: cancelled ? "cancelled" : failure.code,
        status: cancelled ? 499 : failure.status,
        persisted: false,
        at: createAiriChatRunEventAt(),
      });
    }
    return {
      status,
      turn: null,
      error: cancelled ? new AiriChatRunCancelledError() : error,
    };
  }

  if (!cancelled) {
    logger.error("airi_chat.run_turn_failed_after_user_message", error, {
      workspaceId: record.workspaceId,
      runId,
    });
  }
  // Claim the reply's id on the run before any slow work. The heartbeat has
  // stopped, so a reader may reconcile the run meanwhile: it then either
  // finds the run no longer running (no claim, and its own failure reply
  // stands) or writes its reply under this id, which makes the insert below
  // a duplicate. Either way the user turn gets exactly one reply.
  const replyId = new Types.ObjectId();
  const claimed = await updateRunningAiriChatRun(record._id, {
    assistantMessageId: replyId,
  }).catch(() => true);
  if (!claimed) {
    return await publishReconciledAiriChatRun(record, recorder, error);
  }
  const language = await resolveAiriChatRunLanguage(
    record.workspaceId,
    input.supabase
  );
  const stages = recorder.stages();
  const intent = recorder.intent();
  let reply: { content: string; metadata: Record<string, unknown> };
  if (cancelled) {
    const partial = recorder.partialText().trim();
    reply = {
      content:
        partial ||
        getAiriTurnFailureMessage({
          code: "airi_run_cancelled",
          language,
          workspaceId: record.workspaceId,
        }),
      metadata: {
        ...(intent ? { intent } : {}),
        cancelled: true,
        partial: Boolean(partial),
        errorCode: "airi_run_cancelled",
        thinkingTrace: { stages, resources: recorder.resources() },
      },
    };
  } else {
    const failed = buildAiriChatFailureReply({
      workspaceId: record.workspaceId,
      threadId: String(record.threadId),
      userMessageId: userMessage.id,
      startedAt: params.startedAt,
      progress: buildAiriChatRunProgressSnapshot(stages, recorder.resources()),
      error: timedOut ? new AiriTurnDeadlineExceededError() : error,
      language,
    });
    reply = {
      content: failed.content,
      metadata: { ...(intent ? { intent } : {}), ...failed.metadata },
    };
  }
  reply = clampAiriChatReplyForStorage(reply);
  const status: AiriChatRunTerminalStatus = cancelled ? "cancelled" : "failed";
  const errorCode =
    typeof reply.metadata.errorCode === "string"
      ? reply.metadata.errorCode
      : null;
  try {
    const assistantMessage = await saveAiriChatRunReply({
      workspaceId: record.workspaceId,
      threadId: record.threadId,
      content: reply.content,
      metadata: { ...reply.metadata, runId },
      _id: replyId,
    });
    const finished = await finishAiriChatRun(record._id, {
      status,
      errorCode,
      assistantMessageId: assistantMessage.id,
      userMessageId: userMessage.id,
      stages,
      ...(cancelled ? { partialText: recorder.partialText() } : {}),
    });
    // Reconciled after the insert: the run points at this reply already and
    // its document holds the status to report.
    const doneStatus = finished
      ? status
      : ((await loadReconciledAiriChatRunStatus(record)) ?? status);
    const thread = await loadSerializedThread(record);
    recorder.publish({
      type: "assistant_message",
      message: {
        id: assistantMessage.id,
        threadId: assistantMessage.threadId,
        role: "assistant",
        content: assistantMessage.content,
        metadata: assistantMessage.metadata,
        createdAt: assistantMessage.createdAt,
      },
      at: createAiriChatRunEventAt(),
    });
    if (thread) {
      recorder.publish({
        type: "done",
        thread: toDoneThread(thread),
        status: doneStatus,
        at: createAiriChatRunEventAt(),
      });
    }
    return {
      status: doneStatus,
      turn: thread
        ? {
            userMessage: {
              ...userMessage,
              workspaceId: record.workspaceId,
              metadata: userMessage.metadata ?? null,
            },
            assistantMessage,
            thread,
          }
        : null,
      error: thread ? undefined : error,
    };
  } catch (saveError) {
    // A reader reconciled the run and wrote its reply under the claimed id.
    if (isMongoDuplicateKeyError(saveError)) {
      return await publishReconciledAiriChatRun(record, recorder, error);
    }
    logger.error("airi_chat.run_reply_save_failed", saveError, {
      workspaceId: record.workspaceId,
      runId,
    });
    await finishAiriChatRun(record._id, {
      status: "failed",
      errorCode: "airi_generation_failed",
      userMessageId: userMessage.id,
      stages,
    }).catch(() => false);
    const failure = describeAiriChatRequestFailure(saveError);
    recorder.publish({
      type: "error",
      message: failure.message,
      code: failure.code,
      status: failure.status,
      persisted: false,
      at: createAiriChatRunEventAt(),
    });
    return { status: "failed", turn: null, error: saveError };
  }
}

/**
 * The user's Stop for a run on this instance: stops it at once (the engine
 * also sees cancelRequestedAt on its next poll when it runs elsewhere).
 */
export function cancelLiveAiriChatRun(runId: string): boolean {
  return abortLiveAiriChatRun(runId, new AiriChatRunCancelledError());
}

/** Waits one poll interval, or less when `signal` aborts. */
export function waitForAiriChatRunPoll(
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * The JSON routes: wait for the run and answer with today's shape. A run
 * started here resolves in process; an attached run is followed in the
 * store until it ends.
 */
export async function awaitAiriChatRunTurn(
  start: Exclude<AiriChatRunStart, { kind: "conflict" }>,
  options: { supabase?: SupabaseClient } = {}
): Promise<AiriChatTurnResult> {
  if (start.kind === "started") {
    const outcome = await start.outcome;
    if (outcome.turn) return outcome.turn;
    throw (
      outcome.error ?? new AiriChatRunEndedWithoutAnswerError(outcome.status)
    );
  }
  let run = await loadAiriChatRun(start.run.runId);
  while (run && run.status === "running") {
    await waitForAiriChatRunPoll(AIRI_CHAT_RUN_TIMING.followPollMs);
    const next = await loadAiriChatRun(start.run.runId);
    run = next ? await reconcileAiriChatRun(next, options) : null;
  }
  if (!run) throw new AiriChatRunEndedWithoutAnswerError("missing");
  const [userMessage, assistantMessage, thread] = await Promise.all([
    run.userMessageId
      ? AiriChatMessage.findOne({
          _id: run.userMessageId,
          workspaceId: run.workspaceId,
        }).lean<MessageLike | null>()
      : null,
    run.assistantMessageId
      ? AiriChatMessage.findOne({
          _id: run.assistantMessageId,
          workspaceId: run.workspaceId,
        }).lean<MessageLike | null>()
      : null,
    loadSerializedThread(run),
  ]);
  if (!userMessage || !assistantMessage || !thread) {
    throw new AiriChatRunEndedWithoutAnswerError(run.status);
  }
  return {
    userMessage: serializeAiriChatMessage(userMessage),
    assistantMessage: serializeAiriChatMessage(assistantMessage),
    thread,
  };
}
