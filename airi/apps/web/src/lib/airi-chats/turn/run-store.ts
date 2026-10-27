/**
 * Persistence of durable Airi chat runs (models/airi-chat-run.ts): claiming
 * a run, the engine's progress writes, cancel requests, and reconciliation
 * of a run whose process died (stale heartbeat or past its deadline).
 */

import { Types } from "mongoose";
import { logger } from "@/lib/logger";
import { AiriChatMessage } from "@/models/airi-chat-message";
import {
  AiriChatRun,
  type AiriChatRunStatus,
  type IAiriChatRun,
  type IAiriChatRunStage,
} from "@/models/airi-chat-run";
import { createAiriChatRunEventAt } from "@/lib/airi-chats/run-events";
import type { AiriLanguage } from "@/lib/airi/shared/language-policy";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import type {
  AiriChatProgressRecorder,
  MessageLike,
  SerializedAiriChatMessage,
  SupabaseClient,
} from "./types";
import { AiriTurnError, buildAiriChatFailureReply } from "./failure";
import { touchAiriChatThreadForTurn } from "./persistence";
import { getWorkspaceLanguage } from "./retrieval";
import { serializeAiriChatMessage } from "./serialization";

export type AiriChatRunRecord = IAiriChatRun & { _id: Types.ObjectId };

/** A running run whose heartbeat is older than this has lost its process. */
export const AIRI_CHAT_RUN_STALE_HEARTBEAT_MS = 45_000;
/** A running run this long past its deadline has lost its process. */
export const AIRI_CHAT_RUN_DEADLINE_GRACE_MS = 30_000;

/** What thread and message reads report about a thread's current run. */
export type AiriChatActiveRun = {
  runId: string;
  status: AiriChatRunStatus;
  startedAt: string;
};

export function isAiriChatRunStale(
  run: Pick<IAiriChatRun, "status" | "heartbeatAt" | "deadlineAt">,
  now: number = Date.now()
): boolean {
  if (run.status !== "running") return false;
  return (
    new Date(run.heartbeatAt).getTime() <
      now - AIRI_CHAT_RUN_STALE_HEARTBEAT_MS ||
    now > new Date(run.deadlineAt).getTime() + AIRI_CHAT_RUN_DEADLINE_GRACE_MS
  );
}

/**
 * Inserts a new run; null when a unique index refused it: the client turn
 * already has a run, or the thread already has a running one.
 */
export async function insertAiriChatRun(
  run: AiriChatRunRecord
): Promise<AiriChatRunRecord | null> {
  try {
    await AiriChatRun.create(run);
    return run;
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) return null;
    throw error;
  }
}

export function findAiriChatRunByClientTurn(params: {
  workspaceId: string;
  userId: string;
  clientTurnId: string;
}): Promise<AiriChatRunRecord | null> {
  return AiriChatRun.findOne({
    workspaceId: params.workspaceId,
    userId: params.userId,
    clientTurnId: params.clientTurnId,
  }).lean<AiriChatRunRecord | null>() as Promise<AiriChatRunRecord | null>;
}

/** A run of the caller's thread, or null (not found or not theirs). */
export function findAiriChatRunForUser(params: {
  runId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
}): Promise<AiriChatRunRecord | null> {
  if (!Types.ObjectId.isValid(params.runId)) return Promise.resolve(null);
  return AiriChatRun.findOne({
    _id: params.runId,
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    userId: params.userId,
  }).lean<AiriChatRunRecord | null>() as Promise<AiriChatRunRecord | null>;
}

export function loadAiriChatRun(
  runId: Types.ObjectId | string
): Promise<AiriChatRunRecord | null> {
  return AiriChatRun.findOne({
    _id: runId,
  }).lean<AiriChatRunRecord | null>() as Promise<AiriChatRunRecord | null>;
}

/** The running runs of a thread, oldest first. */
function findRunningAiriChatRuns(params: {
  workspaceId: string;
  threadId: Types.ObjectId | string;
}): Promise<AiriChatRunRecord[]> {
  return AiriChatRun.find({
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    status: "running",
  })
    .sort({ startedAt: 1, _id: 1 })
    .limit(20)
    .lean<AiriChatRunRecord[]>() as Promise<AiriChatRunRecord[]>;
}

/**
 * The thread's live run, after reconciling any that lost their process.
 * Used before claiming a run (one active run per thread) and by reads.
 */
export async function findActiveAiriChatRun(params: {
  workspaceId: string;
  threadId: Types.ObjectId | string;
  supabase?: SupabaseClient;
}): Promise<AiriChatRunRecord | null> {
  const running = await findRunningAiriChatRuns(params);
  let active: AiriChatRunRecord | null = null;
  for (const run of running) {
    const reconciled = await reconcileAiriChatRun(run, {
      supabase: params.supabase,
    });
    if (reconciled.status === "running" && !active) active = reconciled;
  }
  return active;
}

export function toAiriChatActiveRun(
  run: AiriChatRunRecord | null
): AiriChatActiveRun | null {
  if (!run || run.status !== "running") return null;
  return {
    runId: String(run._id),
    status: run.status,
    startedAt: new Date(run.startedAt).toISOString(),
  };
}

/** The thread's current run for thread and message reads (reconciled). */
export async function getAiriChatActiveRun(params: {
  workspaceId: string;
  threadId: string;
  supabase?: SupabaseClient;
}): Promise<AiriChatActiveRun | null> {
  return toAiriChatActiveRun(await findActiveAiriChatRun(params));
}

/** A progress write of a run that is still running; false once it is not. */
export async function updateRunningAiriChatRun(
  runId: Types.ObjectId,
  set: Partial<
    Pick<
      IAiriChatRun,
      | "stages"
      | "intent"
      | "partialText"
      | "partialTextUpdatedAt"
      | "userMessageId"
      | "assistantMessageId"
    >
  >
): Promise<boolean> {
  const result = await AiriChatRun.updateOne(
    { _id: runId, status: "running" },
    { $set: set }
  );
  return result.matchedCount > 0;
}

type AiriChatRunControl = Pick<
  AiriChatRunRecord,
  "_id" | "status" | "cancelRequestedAt"
>;

/** The heartbeat; null when the run is no longer running (reconciled). */
export function heartbeatAiriChatRun(
  runId: Types.ObjectId,
  at: Date
): Promise<AiriChatRunControl | null> {
  return AiriChatRun.findOneAndUpdate(
    { _id: runId, status: "running" },
    { $set: { heartbeatAt: at } },
    { new: true, projection: { status: 1, cancelRequestedAt: 1 } }
  ).lean<AiriChatRunControl | null>() as Promise<AiriChatRunControl | null>;
}

/** The cancel poll's read. */
export function readAiriChatRunControl(
  runId: Types.ObjectId
): Promise<AiriChatRunControl | null> {
  return AiriChatRun.findOne(
    { _id: runId },
    { status: 1, cancelRequestedAt: 1 }
  ).lean<AiriChatRunControl | null>() as Promise<AiriChatRunControl | null>;
}

/** The terminal write; false when the run was already reconciled. */
export async function finishAiriChatRun(
  runId: Types.ObjectId,
  result: {
    status: Exclude<AiriChatRunStatus, "running">;
    errorCode?: string | null;
    assistantMessageId?: Types.ObjectId | string | null;
    userMessageId?: Types.ObjectId | string | null;
    stages?: IAiriChatRunStage[];
    partialText?: string;
  }
): Promise<boolean> {
  const now = new Date();
  const update = await AiriChatRun.updateOne(
    { _id: runId, status: "running" },
    {
      $set: {
        status: result.status,
        errorCode: result.errorCode ?? null,
        completedAt: now,
        heartbeatAt: now,
        ...(result.assistantMessageId
          ? {
              assistantMessageId: new Types.ObjectId(result.assistantMessageId),
            }
          : {}),
        ...(result.userMessageId
          ? { userMessageId: new Types.ObjectId(result.userMessageId) }
          : {}),
        ...(result.stages ? { stages: result.stages } : {}),
        ...(result.partialText !== undefined
          ? { partialText: result.partialText, partialTextUpdatedAt: now }
          : {}),
      },
    }
  );
  return update.matchedCount > 0;
}

/**
 * Records the user's Stop. The engine polls for it (and a run on this
 * instance is also stopped directly). Null when the run is not the caller's.
 */
export async function requestAiriChatRunCancel(params: {
  runId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
}): Promise<AiriChatRunRecord | null> {
  if (!Types.ObjectId.isValid(params.runId)) return null;
  const owner = {
    _id: params.runId,
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    userId: params.userId,
  };
  const requested = (await AiriChatRun.findOneAndUpdate(
    { ...owner, status: "running", cancelRequestedAt: null },
    { $set: { cancelRequestedAt: new Date() } },
    { new: true }
  ).lean<AiriChatRunRecord | null>()) as AiriChatRunRecord | null;
  if (requested) return requested;
  // Already finished or already cancelling: still the caller's run.
  return (await AiriChatRun.findOne(
    owner
  ).lean<AiriChatRunRecord | null>()) as AiriChatRunRecord | null;
}

/**
 * Saves a reply the run layer writes itself (a stopped, interrupted or
 * failed turn) and bumps the thread like a turn's own answer does.
 */
export async function saveAiriChatRunReply(params: {
  workspaceId: string;
  threadId: Types.ObjectId | string;
  content: string;
  metadata: Record<string, unknown>;
  /** The id reserved on the run (assistantMessageId) before the insert. */
  _id?: Types.ObjectId;
}): Promise<SerializedAiriChatMessage> {
  const message = await AiriChatMessage.create({
    ...(params._id ? { _id: params._id } : {}),
    threadId: new Types.ObjectId(params.threadId),
    workspaceId: params.workspaceId,
    role: "assistant",
    content: params.content,
    metadata: params.metadata,
  });
  await touchAiriChatThreadForTurn({
    threadId: new Types.ObjectId(params.threadId),
    seenTitle: null,
    fallbackTitle: null,
    at: new Date(),
  }).catch(error => {
    logger.warn("airi_chat.run_thread_touch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return serializeAiriChatMessage(message as unknown as MessageLike);
}

/** A progress view over a run's persisted stages, for failure replies. */
export function buildAiriChatRunProgressSnapshot(
  stages: IAiriChatRunStage[],
  resources: AiriChatProgressRecorder["resources"] = []
): AiriChatProgressRecorder {
  return {
    emit: async () => undefined,
    stages: stages.map(stage => ({
      id: stage.id,
      label: stage.label,
      status: stage.status,
      detail: stage.detail ?? null,
      ...(stage.durationMs !== undefined
        ? { durationMs: stage.durationMs }
        : {}),
      at: stage.at,
    })),
    resources,
    live: false,
  };
}

/**
 * The workspace language lookup of a reply the run layer writes itself is
 * bounded: a slow Supabase must not hold a run's reply (and its terminal
 * write) past the stale-heartbeat window.
 */
export const AIRI_CHAT_RUN_LANGUAGE_LOOKUP = { timeoutMs: 3_000 };

export async function resolveAiriChatRunLanguage(
  workspaceId: string,
  supabase?: SupabaseClient
): Promise<AiriLanguage | null> {
  if (!supabase) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(
      () => resolve(null),
      AIRI_CHAT_RUN_LANGUAGE_LOOKUP.timeoutMs
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([
      getWorkspaceLanguage({ supabase, workspaceId }).catch(() => null),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A running run whose process died (heartbeat older than 45 s, or 30 s past
 * its deadline) becomes interrupted. The reader that wins the transition
 * saves the failure reply for a saved user message without an answer, so no
 * user turn is left unanswered; a run that never saved its user message
 * only changes status.
 */
export async function reconcileAiriChatRun(
  run: AiriChatRunRecord,
  options: { supabase?: SupabaseClient; now?: number } = {}
): Promise<AiriChatRunRecord> {
  const now = options.now ?? Date.now();
  if (!isAiriChatRunStale(run, now)) return run;
  const interruptedAt = new Date(now);
  const won = (await AiriChatRun.findOneAndUpdate(
    {
      _id: run._id,
      status: "running",
      $or: [
        {
          heartbeatAt: {
            $lt: new Date(now - AIRI_CHAT_RUN_STALE_HEARTBEAT_MS),
          },
        },
        {
          deadlineAt: {
            $lt: new Date(now - AIRI_CHAT_RUN_DEADLINE_GRACE_MS),
          },
        },
      ],
    },
    {
      $set: {
        status: "interrupted",
        errorCode: "airi_run_interrupted",
        completedAt: interruptedAt,
      },
    },
    { new: true }
  ).lean<AiriChatRunRecord | null>()) as AiriChatRunRecord | null;
  if (!won) return (await loadAiriChatRun(run._id)) ?? run;
  if (!won.userMessageId) return won;
  // The run reserves its reply's id (or records its saved answer's id)
  // before writing it: a saved message means the turn is answered. A
  // reserved id without a message is a run that died before its insert; the
  // failure reply takes that id, so the run's own late insert cannot add a
  // second one.
  const reservedId = won.assistantMessageId
    ? new Types.ObjectId(won.assistantMessageId)
    : null;
  if (
    reservedId &&
    (await AiriChatMessage.countDocuments({ _id: reservedId }).catch(() => 1)) >
      0
  ) {
    return won;
  }

  try {
    const language = await resolveAiriChatRunLanguage(
      won.workspaceId,
      options.supabase
    );
    const reply = buildAiriChatFailureReply({
      workspaceId: won.workspaceId,
      threadId: String(won.threadId),
      userMessageId: String(won.userMessageId),
      startedAt: new Date(won.startedAt).getTime(),
      progress: buildAiriChatRunProgressSnapshot(won.stages ?? []),
      error: new AiriTurnError("airi_run_interrupted"),
      language,
    });
    const message = await saveAiriChatRunReply({
      workspaceId: won.workspaceId,
      threadId: won.threadId,
      content: reply.content,
      metadata: {
        ...reply.metadata,
        ...(won.intent ? { intent: won.intent } : {}),
        runId: String(won._id),
        interrupted: true,
        interruptedAt: createAiriChatRunEventAt(),
      },
      ...(reservedId ? { _id: reservedId } : {}),
    });
    if (!reservedId) {
      await AiriChatRun.updateOne(
        { _id: won._id },
        { $set: { assistantMessageId: new Types.ObjectId(message.id) } }
      );
    }
    return { ...won, assistantMessageId: new Types.ObjectId(message.id) };
  } catch (error) {
    // The run's own reply took the reserved id first: the turn is answered.
    if (reservedId && isMongoDuplicateKeyError(error)) return won;
    logger.error("airi_chat.run_interrupt_reply_failed", error, {
      workspaceId: won.workspaceId,
      threadId: String(won.threadId),
      runId: String(won._id),
    });
    return won;
  }
}
