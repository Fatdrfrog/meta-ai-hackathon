import { Types } from "mongoose";

jest.mock("@/models/airi-chat-thread", () => {
  const { createInMemoryModel } = jest.requireActual(
    "@/lib/airi-chats/turn/in-memory-mongo.test-utils"
  );
  return { AiriChatThread: createInMemoryModel({ timestamps: true }) };
});
jest.mock("@/models/airi-chat-message", () => {
  const { createInMemoryModel } = jest.requireActual(
    "@/lib/airi-chats/turn/in-memory-mongo.test-utils"
  );
  return {
    AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH: 12000,
    AiriChatMessage: createInMemoryModel({ timestamps: true }),
  };
});
jest.mock("@/models/airi-chat-run", () => {
  const { createInMemoryModel } = jest.requireActual(
    "@/lib/airi-chats/turn/in-memory-mongo.test-utils"
  );
  return {
    AiriChatRun: createInMemoryModel({
      unique: [
        { keys: ["workspaceId", "userId", "clientTurnId"] },
        { keys: ["workspaceId", "threadId"], partial: { status: "running" } },
      ],
    }),
  };
});

// The workspace language lookup (Supabase); runs here have no client.
const mockGetWorkspaceLanguage = jest.fn(async () => "en");
jest.mock("./retrieval", () => ({
  getWorkspaceLanguage: () => mockGetWorkspaceLanguage(),
}));

import type { InMemoryModel } from "./in-memory-mongo.test-utils";
import { AiriChatMessage } from "@/models/airi-chat-message";
import { AiriChatRun } from "@/models/airi-chat-run";
import {
  AIRI_CHAT_RUN_DEADLINE_GRACE_MS,
  AIRI_CHAT_RUN_LANGUAGE_LOOKUP,
  AIRI_CHAT_RUN_STALE_HEARTBEAT_MS,
  getAiriChatActiveRun,
  insertAiriChatRun,
  isAiriChatRunStale,
  reconcileAiriChatRun,
  requestAiriChatRunCancel,
  resolveAiriChatRunLanguage,
  saveAiriChatRunReply,
  type AiriChatRunRecord,
} from "./run-store";
import type { SupabaseClient } from "./types";

const runs = AiriChatRun as unknown as InMemoryModel;
const messages = AiriChatMessage as unknown as InMemoryModel;
const NOW = Date.UTC(2026, 9, 11, 9, 0, 0);

function runRecord(
  overrides: Partial<AiriChatRunRecord> = {}
): AiriChatRunRecord {
  return {
    _id: new Types.ObjectId(),
    workspaceId: "workspace-1",
    threadId: new Types.ObjectId(),
    userId: "user-1",
    clientTurnId: String(new Types.ObjectId()),
    status: "running",
    intent: null,
    stages: [],
    partialText: "",
    partialTextUpdatedAt: null,
    userMessageId: null,
    assistantMessageId: null,
    errorCode: null,
    cancelRequestedAt: null,
    heartbeatAt: new Date(NOW),
    deadlineAt: new Date(NOW + 280_000),
    startedAt: new Date(NOW),
    completedAt: null,
    ...overrides,
  };
}

describe("Airi chat run store", () => {
  beforeEach(() => {
    runs.reset();
    messages.reset();
  });

  it("treats a run as lost after 45 s without a heartbeat or 30 s past its deadline", () => {
    const run = runRecord();
    expect(
      isAiriChatRunStale(run, NOW + AIRI_CHAT_RUN_STALE_HEARTBEAT_MS)
    ).toBe(false);
    expect(
      isAiriChatRunStale(run, NOW + AIRI_CHAT_RUN_STALE_HEARTBEAT_MS + 1)
    ).toBe(true);
    const beating = runRecord({
      heartbeatAt: new Date(NOW + 300_000),
      deadlineAt: new Date(NOW),
    });
    expect(
      isAiriChatRunStale(beating, NOW + AIRI_CHAT_RUN_DEADLINE_GRACE_MS)
    ).toBe(false);
    expect(
      isAiriChatRunStale(beating, NOW + AIRI_CHAT_RUN_DEADLINE_GRACE_MS + 1)
    ).toBe(true);
    expect(
      isAiriChatRunStale(runRecord({ status: "completed" }), NOW + 3_600_000)
    ).toBe(false);
  });

  it("refuses a second running run in the same thread and a reused client turn", async () => {
    const first = runRecord();
    expect(await insertAiriChatRun(first)).toBe(first);
    expect(
      await insertAiriChatRun(runRecord({ threadId: first.threadId }))
    ).toBeNull();
    expect(
      await insertAiriChatRun(runRecord({ clientTurnId: first.clientTurnId }))
    ).toBeNull();
    // A finished run frees the thread.
    await runs.updateOne({ _id: first._id }, { $set: { status: "completed" } });
    expect(
      await insertAiriChatRun(runRecord({ threadId: first.threadId }))
    ).not.toBeNull();
  });

  it("reconciles a lost run once, answering its saved user turn exactly once", async () => {
    const userMessageId = new Types.ObjectId();
    const run = runRecord({
      userMessageId,
      heartbeatAt: new Date(NOW - 60_000),
    });
    await insertAiriChatRun(run);

    const [first, second] = await Promise.all([
      reconcileAiriChatRun(run, { now: NOW }),
      reconcileAiriChatRun(run, { now: NOW }),
    ]);
    expect(first.status).toBe("interrupted");
    expect(second.status).toBe("interrupted");
    expect(messages.docs).toHaveLength(1);
    expect(messages.docs[0]).toMatchObject({
      role: "assistant",
      metadata: expect.objectContaining({
        failed: true,
        errorCode: "airi_run_interrupted",
        interrupted: true,
      }),
    });
    expect(String(runs.docs[0]?.assistantMessageId)).toBe(
      String(messages.docs[0]?._id)
    );
  });

  it("adds no reply to a lost run whose saved answer's id is on it", async () => {
    const answer = await messages.create({
      role: "assistant",
      content: "The answer",
    });
    const run = runRecord({
      userMessageId: new Types.ObjectId(),
      assistantMessageId: answer._id,
      heartbeatAt: new Date(NOW - 60_000),
    });
    await insertAiriChatRun(run);
    const reconciled = await reconcileAiriChatRun(run, { now: NOW });
    expect(reconciled.status).toBe("interrupted");
    expect(messages.docs).toHaveLength(1);
    expect(String(runs.docs[0]?.assistantMessageId)).toBe(String(answer._id));
  });

  it("writes the failure reply under a reserved id the run never filled, once", async () => {
    const reservedId = new Types.ObjectId();
    const run = runRecord({
      userMessageId: new Types.ObjectId(),
      assistantMessageId: reservedId,
      heartbeatAt: new Date(NOW - 60_000),
    });
    await insertAiriChatRun(run);
    await reconcileAiriChatRun(run, { now: NOW });
    expect(messages.docs.map(doc => String(doc._id))).toEqual([
      String(reservedId),
    ]);
    expect(messages.docs[0]?.metadata).toMatchObject({
      errorCode: "airi_run_interrupted",
    });
    // The run's own late insert under that id is refused.
    await expect(
      saveAiriChatRunReply({
        workspaceId: "workspace-1",
        threadId: run.threadId,
        content: "Stopped.",
        metadata: {},
        _id: reservedId,
      })
    ).rejects.toMatchObject({ code: 11000 });
    expect(messages.docs).toHaveLength(1);
  });

  it("bounds the workspace language lookup of a run's own reply", async () => {
    const previous = AIRI_CHAT_RUN_LANGUAGE_LOOKUP.timeoutMs;
    AIRI_CHAT_RUN_LANGUAGE_LOOKUP.timeoutMs = 10;
    mockGetWorkspaceLanguage.mockImplementationOnce(
      () => new Promise<string>(() => undefined)
    );
    try {
      await expect(
        resolveAiriChatRunLanguage("workspace-1", {} as SupabaseClient)
      ).resolves.toBeNull();
    } finally {
      AIRI_CHAT_RUN_LANGUAGE_LOOKUP.timeoutMs = previous;
    }
  });

  it("only changes the status of a lost run that never saved its user message", async () => {
    const run = runRecord({ deadlineAt: new Date(NOW - 31_000) });
    await insertAiriChatRun(run);
    const reconciled = await reconcileAiriChatRun(run, { now: NOW });
    expect(reconciled).toMatchObject({
      status: "interrupted",
      errorCode: "airi_run_interrupted",
    });
    expect(messages.docs).toHaveLength(0);
  });

  it("reports only a live run as active", async () => {
    const live = runRecord({
      heartbeatAt: new Date(),
      deadlineAt: new Date(Date.now() + 280_000),
    });
    await insertAiriChatRun(live);
    expect(
      await getAiriChatActiveRun({
        workspaceId: "workspace-1",
        threadId: String(live.threadId),
      })
    ).toEqual({
      runId: String(live._id),
      status: "running",
      startedAt: live.startedAt.toISOString(),
    });
    expect(
      await getAiriChatActiveRun({
        workspaceId: "workspace-1",
        threadId: String(new Types.ObjectId()),
      })
    ).toBeNull();
  });

  it("records a cancel only for the caller's run and reports a finished one as is", async () => {
    const run = runRecord();
    await insertAiriChatRun(run);
    const owner = {
      runId: String(run._id),
      workspaceId: "workspace-1",
      threadId: String(run.threadId),
    };
    expect(
      await requestAiriChatRunCancel({ ...owner, userId: "someone-else" })
    ).toBeNull();
    const requested = await requestAiriChatRunCancel({
      ...owner,
      userId: "user-1",
    });
    expect(requested?.cancelRequestedAt).toBeInstanceOf(Date);

    await runs.updateOne({ _id: run._id }, { $set: { status: "cancelled" } });
    expect(
      await requestAiriChatRunCancel({ ...owner, userId: "user-1" })
    ).toMatchObject({ status: "cancelled" });
    expect(
      await requestAiriChatRunCancel({
        ...owner,
        runId: "not-an-id",
        userId: "user-1",
      })
    ).toBeNull();
  });
});
