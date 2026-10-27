import mongoose from "mongoose";

/**
 * One Airi chat turn run, decoupled from the HTTP request that started it.
 * The turn engine writes its stages, the streamed answer so far, a heartbeat
 * and the terminal status here, so a client that closed the drawer (or a
 * request on another instance) can resume the run, and a run whose process
 * died is reconciled as interrupted on the next read.
 */

export type AiriChatRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AiriChatRunStageStatus = "running" | "complete" | "error";

export interface IAiriChatRunStage {
  id: string;
  label: string;
  status: AiriChatRunStageStatus;
  detail?: string | null;
  durationMs?: number;
  at: string;
}

export interface IAiriChatRun {
  workspaceId: string;
  threadId: mongoose.Types.ObjectId;
  userId: string;
  clientTurnId: string;
  status: AiriChatRunStatus;
  intent?: string | null;
  stages: IAiriChatRunStage[];
  partialText: string;
  partialTextUpdatedAt?: Date | null;
  userMessageId?: mongoose.Types.ObjectId | null;
  assistantMessageId?: mongoose.Types.ObjectId | null;
  errorCode?: string | null;
  cancelRequestedAt?: Date | null;
  heartbeatAt: Date;
  deadlineAt: Date;
  startedAt: Date;
  completedAt?: Date | null;
}

const AiriChatRunStageSchema = new mongoose.Schema<IAiriChatRunStage>(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    status: {
      type: String,
      enum: ["running", "complete", "error"],
      required: true,
    },
    detail: { type: String, default: null },
    durationMs: { type: Number },
    at: { type: String, required: true },
  },
  { _id: false }
);

const AiriChatRunSchema = new mongoose.Schema<IAiriChatRun>(
  {
    workspaceId: { type: String, required: true },
    threadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiriChatThread",
      required: true,
    },
    userId: { type: String, required: true },
    clientTurnId: { type: String, required: true },
    status: {
      type: String,
      enum: ["running", "completed", "failed", "cancelled", "interrupted"],
      required: true,
      default: "running",
    },
    intent: { type: String, default: null },
    stages: { type: [AiriChatRunStageSchema], default: [] },
    partialText: { type: String, default: "" },
    partialTextUpdatedAt: { type: Date, default: null },
    userMessageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    assistantMessageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    errorCode: { type: String, default: null },
    cancelRequestedAt: { type: Date, default: null },
    heartbeatAt: { type: Date, required: true },
    deadlineAt: { type: Date, required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
  },
  { collection: "airichatruns" }
);

// A thread's runs, newest first (active run lookup, resume).
AiriChatRunSchema.index({ workspaceId: 1, threadId: 1, startedAt: -1 });
// One run per client turn: a retried send attaches instead of starting twice.
AiriChatRunSchema.index(
  { workspaceId: 1, userId: 1, clientTurnId: 1 },
  { unique: true }
);
// Stale-heartbeat sweeps.
AiriChatRunSchema.index({ status: 1, heartbeatAt: 1 });
// One running run per thread, enforced by the database: of two sends racing
// into the same thread only one insert succeeds (the other answers 409).
AiriChatRunSchema.index(
  { workspaceId: 1, threadId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "running" },
    name: "airi_chat_run_one_running_per_thread",
  }
);

export const AiriChatRun =
  (mongoose.models.AiriChatRun as mongoose.Model<IAiriChatRun> | undefined) ||
  mongoose.model<IAiriChatRun>("AiriChatRun", AiriChatRunSchema);
