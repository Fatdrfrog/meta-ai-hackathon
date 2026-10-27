/**
 * Durable Airi chat runs end to end: the message, resume, cancel, thread and
 * message-list routes, the real turn engine and run executor (intent
 * classifier, retrieval orchestration, general answer, persisted progress,
 * heartbeat and cancel polling), the SSE framing and the web client's own
 * SSE parser. Only the boundaries are stubbed: the Claude provider call,
 * the Mongo models (in memory, with their unique indexes), Supabase, the AI
 * gateway and local search, and analytics writes.
 */
import { Types } from "mongoose";

const mockGenerateAnthropicText = jest.fn();
const mockRecordCreativeStudioChat = jest.fn();

jest.mock("@/lib/ai/anthropic-messages", () => {
  const actual = jest.requireActual("@/lib/ai/anthropic-messages");
  return {
    ...actual,
    generateAnthropicText: (...args: unknown[]) =>
      mockGenerateAnthropicText(...args),
  };
});

/** Holds the next workspace language lookup (Supabase) when set. */
let mockLanguageLookup: (() => Promise<unknown>) | null = null;

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const hold = table === "workspaces" ? mockLanguageLookup : null;
            if (!hold) return { data: null };
            mockLanguageLookup = null;
            return hold();
          },
        }),
      }),
    }),
  }),
}));
jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: async () => true,
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: async (name: string, args: { p_workspace_id: string }) =>
      name === "admit_workspace_text_ai_action"
        ? {
            data: {
              workspace_id: args.p_workspace_id,
              company_id: "company-1",
              plan: "pro",
              period_start: "2026-10-01T00:00:00.000Z",
              reset_at: null,
              allowance_period: "lifetime",
              billing_source: "platform",
              source_id: null,
            },
            error: null,
          }
        : { data: null, error: { message: "unexpected rpc" } },
  },
}));
jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyStudioChatCapacity: async () => ({ allowed: true, limit: {} }),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyStudioChatLimitExceededResponse: () =>
    new Response(null, { status: 402 }),
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: async () => undefined,
}));
jest.mock("@/models/airi-chat-thread", () => {
  const { createInMemoryModel } = jest.requireActual(
    "@/lib/airi-chats/turn/in-memory-mongo.test-utils"
  );
  return {
    AiriChatThread: createInMemoryModel({
      timestamps: true,
      defaults: { pinnedAt: null, status: "active" },
    }),
  };
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
jest.mock("@/lib/ai/gcp-ai-gateway", () => ({
  canCallGcpAIGateway: () => false,
  getRemoteAskDataContext: jest.fn(),
}));
jest.mock("@/lib/ai/ask-data-search-local", () => ({
  searchAskDataContextLocal: async () => ({
    conversations: [],
    kbArticles: [
      {
        id: "kb-1",
        title: "Delivery times",
        content: "Standard delivery takes 3-5 business days.",
        relevance_score: 0.9,
        source_type: "article",
      },
    ],
  }),
}));
jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: jest.fn(async () => undefined),
  recordRagTurnAnalyticsEvents: jest.fn(async () => undefined),
}));

import type { NextRequest } from "next/server";
import { readAiriChatEventStream } from "@/components/ai/airi-chat-event-stream";
import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";
import { AIRI_CHAT_RUN_TIMING } from "@/lib/airi-chats/runs";
import type { InMemoryModel } from "@/lib/airi-chats/turn/in-memory-mongo.test-utils";
import {
  reconcileAiriChatRun,
  type AiriChatRunRecord,
} from "@/lib/airi-chats/turn/run-store";
import { AiriChatMessage as AiriChatMessageModel } from "@/models/airi-chat-message";
import { AiriChatRun as AiriChatRunModel } from "@/models/airi-chat-run";
import { AiriChatThread as AiriChatThreadModel } from "@/models/airi-chat-thread";
import { POST as postNewChatStream } from "./messages/stream/route";
import { POST as postNewChatJson } from "./messages/route";
import { POST as postStream } from "./[threadId]/messages/stream/route";
import {
  GET as getMessages,
  POST as postJson,
} from "./[threadId]/messages/route";
import { GET as getThread } from "./[threadId]/route";
import { GET as resumeRun } from "./[threadId]/runs/[runId]/stream/route";
import { POST as cancelRun } from "./[threadId]/runs/[runId]/cancel/route";

const threads = AiriChatThreadModel as unknown as InMemoryModel;
const messages = AiriChatMessageModel as unknown as InMemoryModel;
const runs = AiriChatRunModel as unknown as InMemoryModel;

const WORKSPACE_ID = "workspace-1";
const ANSWER_CHUNKS = ["Customers mostly ", "say delivery ", "is slow."];
const ANSWER = ANSWER_CHUNKS.join("");
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AI_ENABLED",
  "AI_CHAT_PROVIDER_ORDER",
] as const;

/** Holds the streamed answer after `afterChunks` chunks until released. */
type AnswerGate = {
  afterChunks: number;
  reached: Promise<void>;
  release: () => void;
};
let mockGate: AnswerGate | null = null;

function holdAnswer(afterChunks = 1): AnswerGate {
  let reach = () => {};
  let release = () => {};
  const reached = new Promise<void>(resolve => {
    reach = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  const gate = {
    afterChunks,
    reached,
    release,
    wait: async (signal?: AbortSignal) => {
      reach();
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        void released.then(resolve);
      });
    },
  };
  mockGate = gate;
  return gate;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now();
  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function jsonRequest(url: string, body?: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

function threadParams(threadId: string) {
  return {
    params: Promise.resolve({ workspaceId: WORKSPACE_ID, threadId }),
  };
}

function runParams(threadId: string, runId: string) {
  return {
    params: Promise.resolve({ workspaceId: WORKSPACE_ID, threadId, runId }),
  };
}

async function createThread(): Promise<string> {
  const thread = await threads.create({
    workspaceId: WORKSPACE_ID,
    createdByUserId: "user-1",
    title: "Delivery",
    source: "manual",
    status: "active",
  });
  return String(thread._id);
}

/**
 * Reads a whole stream with the web client's parser, or, with `stopWhen`,
 * until that event and then disconnects: the reader cancels the body the
 * way a closed drawer's aborted fetch does.
 */
async function readEvents(
  response: Response,
  stopWhen?: (event: AiriChatRunEvent) => boolean
): Promise<AiriChatRunEvent[]> {
  const events: AiriChatRunEvent[] = [];
  if (!stopWhen) {
    await readAiriChatEventStream(response, event => {
      events.push(event as AiriChatRunEvent);
    });
    return events;
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return events;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
      const data = frame
        .split("\n")
        .find(line => line.startsWith("data:"))
        ?.slice("data:".length);
      if (!data) continue;
      const event = JSON.parse(data) as AiriChatRunEvent;
      events.push(event);
      if (stopWhen(event)) {
        await reader.cancel();
        return events;
      }
    }
  }
}

function eventTypes(events: AiriChatRunEvent[]): string[] {
  return events.map(event => event.type);
}

function runDoc(runId?: string) {
  return runs.docs.find(doc => !runId || String(doc._id) === runId) as
    | (Record<string, unknown> & { _id: Types.ObjectId })
    | undefined;
}

function assistantMessages() {
  return messages.docs.filter(doc => doc.role === "assistant");
}

const previousTiming = { ...AIRI_CHAT_RUN_TIMING };

describe("Airi chat durable runs: routes -> engine -> run store -> SSE", () => {
  const previousEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]])
  );

  beforeEach(() => {
    threads.reset();
    messages.reset();
    runs.reset();
    mockGate = null;
    mockLanguageLookup = null;
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = "test-key";
    Object.assign(AIRI_CHAT_RUN_TIMING, {
      controlPollMs: 10,
      heartbeatEveryPolls: 3,
      partialTextWriteMs: 10,
      followPollMs: 10,
    });
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockGenerateAnthropicText.mockImplementation(
      async (
        request: {
          model: string;
          messages: Array<{ content: string }>;
          signal?: AbortSignal;
        },
        callbacks?: {
          onDelta?: (chunk: {
            delta: string;
            accumulated: string;
          }) => void | Promise<void>;
        }
      ) => {
        const prompt = request.messages.map(m => m.content).join("\n");
        if (prompt.includes('"intent": "general_answer" |')) {
          return {
            text: JSON.stringify({
              intent: "general_answer",
              confidence: 0.92,
              reason: "Analysis of customer feedback",
            }),
            finishReason: "end_turn",
            servedModel: request.model,
          };
        }
        if (!callbacks?.onDelta) {
          return {
            text: "Delivery feedback",
            finishReason: "end_turn",
            servedModel: request.model,
          };
        }
        let accumulated = "";
        for (const [index, delta] of ANSWER_CHUNKS.entries()) {
          const gate = mockGate as
            | (AnswerGate & { wait: (signal?: AbortSignal) => Promise<void> })
            | null;
          if (gate && index === gate.afterChunks) {
            await gate.wait(request.signal);
          }
          request.signal?.throwIfAborted();
          accumulated += delta;
          await callbacks.onDelta({ delta, accumulated });
        }
        return {
          text: accumulated,
          finishReason: "end_turn",
          servedModel: request.model,
        };
      }
    );
  });

  afterEach(async () => {
    mockGate?.release();
    // Let runs still in flight settle before the stores are reset.
    await waitFor(() => runs.docs.every(doc => doc.status !== "running")).catch(
      () => undefined
    );
    Object.assign(AIRI_CHAT_RUN_TIMING, previousTiming);
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it("runs a turn: run first, persisted stages and answer, done carries the status", async () => {
    const threadId = await createThread();
    const response = await postStream(
      jsonRequest("http://localhost/api", {
        content: "How do customers feel about delivery times?",
        clientTurnId: "8a6e0c1e-5f7b-4d8e-9a51-2a8b7f3f0c11",
      }),
      threadParams(threadId)
    );
    expect(response.status).toBe(200);
    const events = await readEvents(response);
    const types = eventTypes(events);

    expect(types[0]).toBe("run");
    const runEvent = events[0] as Extract<AiriChatRunEvent, { type: "run" }>;
    expect(runEvent).toMatchObject({
      threadId,
      clientTurnId: "8a6e0c1e-5f7b-4d8e-9a51-2a8b7f3f0c11",
      status: "running",
    });
    expect(types).toContain("user_message");
    expect(types.slice(-2)).toEqual(["assistant_message", "done"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "completed",
      thread: { id: threadId },
    });
    expect(types).not.toContain("error");

    const run = runDoc(runEvent.runId);
    expect(run).toMatchObject({
      status: "completed",
      intent: "general_answer",
      errorCode: null,
    });
    const answer = assistantMessages()[0];
    expect(answer?.content).toBe(ANSWER);
    expect(String(run?.assistantMessageId)).toBe(String(answer?._id));
    expect(String(run?.userMessageId)).toBe(
      String(messages.docs.find(doc => doc.role === "user")?._id)
    );
    const stageIds = (run?.stages as Array<{ id: string }>).map(
      stage => stage.id
    );
    expect(stageIds).toEqual(
      expect.arrayContaining(["history", "intent", "assistant_message"])
    );
    await waitFor(() => mockRecordCreativeStudioChat.mock.calls.length > 0);
    expect(mockRecordCreativeStudioChat).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "airi_chat"
    );
  });

  it("keeps running when the client disconnects and saves the answer", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(1);
    const response = await postStream(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    // The drawer closes after the first preview.
    const events = await readEvents(
      response,
      event => event.type === "assistant_delta"
    );
    expect(eventTypes(events)).toContain("assistant_delta");
    await gate.reached;
    // The partial answer is on the run for a later resume.
    await waitFor(() => runDoc()?.partialText === ANSWER_CHUNKS[0]);
    expect(runDoc()?.status).toBe("running");

    gate.release();
    await waitFor(() => runDoc()?.status === "completed");
    expect(assistantMessages().map(doc => doc.content)).toEqual([ANSWER]);
    expect(String(runDoc()?.assistantMessageId)).toBe(
      String(assistantMessages()[0]?._id)
    );
    await waitFor(() => mockRecordCreativeStudioChat.mock.calls.length > 0);
  });

  it("resumes: replays the run so far, then follows it to completion", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(1);
    const first = await postStream(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    const before = await readEvents(
      first,
      event => event.type === "assistant_delta"
    );
    const runId = (before[0] as Extract<AiriChatRunEvent, { type: "run" }>)
      .runId;
    await gate.reached;

    const resumed = await resumeRun(
      jsonRequest("http://localhost/api", undefined, "GET"),
      runParams(threadId, runId)
    );
    expect(resumed.status).toBe(200);
    const eventsPromise = readEvents(resumed);
    // Resume first replays, then the run goes on.
    await new Promise(resolve => setTimeout(resolve, 30));
    gate.release();
    const events = await eventsPromise;
    const types = eventTypes(events);
    expect(types[0]).toBe("run");
    expect(types).toContain("user_message");
    expect(types).toContain("stage");
    const firstDelta = events.find(event => event.type === "assistant_delta");
    expect(firstDelta).toMatchObject({ text: ANSWER_CHUNKS[0] });
    expect(types.slice(-2)).toEqual(["assistant_message", "done"]);
    expect(events.at(-1)).toMatchObject({ status: "completed" });
    expect(assistantMessages()).toHaveLength(1);
  });

  it("resumes a run executing elsewhere from its document", async () => {
    const threadId = await createThread();
    const user = await messages.create({
      threadId: new Types.ObjectId(threadId),
      workspaceId: WORKSPACE_ID,
      role: "user",
      content: "Delivery feedback?",
      metadata: null,
    });
    const runId = new Types.ObjectId();
    const now = new Date();
    await runs.create({
      _id: runId,
      workspaceId: WORKSPACE_ID,
      threadId: new Types.ObjectId(threadId),
      userId: "user-1",
      clientTurnId: "elsewhere-1",
      status: "running",
      intent: "general_answer",
      stages: [
        {
          id: "intent",
          label: "Classifying request",
          status: "complete",
          detail: "general_answer",
          at: now.toISOString(),
        },
      ],
      partialText: "Customers mostly",
      userMessageId: user._id,
      assistantMessageId: null,
      errorCode: null,
      cancelRequestedAt: null,
      heartbeatAt: now,
      deadlineAt: new Date(now.getTime() + 280_000),
      startedAt: now,
      completedAt: null,
    });

    const response = await resumeRun(
      jsonRequest("http://localhost/api", undefined, "GET"),
      runParams(threadId, String(runId))
    );
    const eventsPromise = readEvents(response);
    await new Promise(resolve => setTimeout(resolve, 30));
    // The other instance finishes the run.
    const answer = await messages.create({
      threadId: new Types.ObjectId(threadId),
      workspaceId: WORKSPACE_ID,
      role: "assistant",
      content: ANSWER,
      metadata: { intent: "general_answer" },
    });
    await runs.updateOne(
      { _id: runId },
      {
        $set: {
          status: "completed",
          assistantMessageId: answer._id,
          heartbeatAt: new Date(),
        },
      }
    );
    const events = await eventsPromise;
    expect(eventTypes(events)).toEqual([
      "run",
      "user_message",
      "stage",
      "assistant_delta",
      "assistant_message",
      "done",
    ]);
    expect(events[3]).toMatchObject({ text: "Customers mostly" });
    expect(events[4]).toMatchObject({ message: { content: ANSWER } });
    expect(events[5]).toMatchObject({ status: "completed" });
  });

  it("stops on cancel and saves the partial answer as cancelled", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(1);
    const response = await postStream(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    const eventsPromise = readEvents(response);
    await gate.reached;
    await waitFor(() => runDoc()?.partialText === ANSWER_CHUNKS[0]);
    const runId = String(runDoc()?._id);

    const cancelled = await cancelRun(
      jsonRequest("http://localhost/api"),
      runParams(threadId, runId)
    );
    expect(cancelled.status).toBe(202);

    const events = await eventsPromise;
    expect(eventTypes(events).slice(-2)).toEqual(["assistant_message", "done"]);
    expect(events.at(-2)).toMatchObject({
      message: {
        content: ANSWER_CHUNKS[0]!.trim(),
        metadata: expect.objectContaining({
          cancelled: true,
          errorCode: "airi_run_cancelled",
          runId,
        }),
      },
    });
    expect(events.at(-1)).toMatchObject({ status: "cancelled" });
    expect(runDoc(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "airi_run_cancelled",
    });
    expect(runDoc(runId)?.cancelRequestedAt).toBeInstanceOf(Date);
    // A stopped turn does not count against the studio-chat quota.
    expect(mockRecordCreativeStudioChat).not.toHaveBeenCalled();
  });

  it("stops through the polled cancel request with a localized note when nothing streamed yet", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(0);
    const responsePromise = postJson(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    await gate.reached;
    // Another instance took the Stop: only the document says so.
    await runs.updateOne(
      { _id: runDoc()?._id },
      { $set: { cancelRequestedAt: new Date() } }
    );
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assistantMessage).toMatchObject({
      content: "Stopped.",
      metadata: expect.objectContaining({ cancelled: true, partial: false }),
    });
    expect(runDoc()).toMatchObject({ status: "cancelled" });
    expect(messages.docs.map(doc => doc.role)).toEqual(["user", "assistant"]);
  });

  /** Makes the run's terminal 'completed' write throw `times` times. */
  function failCompletedRunWrites(times: number) {
    const original = runs.updateOne;
    let remaining = times;
    return jest
      .spyOn(runs, "updateOne")
      .mockImplementation(async (filter, update) => {
        const set = (update as { $set?: { status?: string } }).$set;
        if (set?.status === "completed" && remaining > 0) {
          remaining -= 1;
          throw Object.assign(new Error("not primary"), { code: 10107 });
        }
        return original(filter, update);
      });
  }

  it("keeps the saved answer as the only reply when the terminal write fails once", async () => {
    Object.assign(AIRI_CHAT_RUN_TIMING, { finishRetryMs: 1 });
    const threadId = await createThread();
    const failing = failCompletedRunWrites(1);
    let events: AiriChatRunEvent[];
    try {
      events = await readEvents(
        await postStream(
          jsonRequest("http://localhost/api", {
            content: "Delivery feedback?",
          }),
          threadParams(threadId)
        )
      );
    } finally {
      failing.mockRestore();
    }
    expect(
      events.filter(event => event.type === "assistant_message")
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(assistantMessages().map(doc => doc.content)).toEqual([ANSWER]);
    expect(runDoc()).toMatchObject({ status: "completed", errorCode: null });
    await waitFor(() => mockRecordCreativeStudioChat.mock.calls.length > 0);
  });

  it("adds no failure reply when the terminal write keeps failing, also after reconciliation", async () => {
    Object.assign(AIRI_CHAT_RUN_TIMING, { finishRetryMs: 1 });
    const threadId = await createThread();
    const failing = failCompletedRunWrites(Number.POSITIVE_INFINITY);
    let events: AiriChatRunEvent[];
    try {
      events = await readEvents(
        await postStream(
          jsonRequest("http://localhost/api", {
            content: "Delivery feedback?",
          }),
          threadParams(threadId)
        )
      );
    } finally {
      failing.mockRestore();
    }
    expect(
      events.filter(event => event.type === "assistant_message")
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    await waitFor(() => mockRecordCreativeStudioChat.mock.calls.length > 0);
    const answer = assistantMessages()[0];
    // The answer's id reached the run before the failed terminal write.
    expect(runDoc()).toMatchObject({ status: "running" });
    expect(String(runDoc()?.assistantMessageId)).toBe(String(answer?._id));

    const reconciled = await reconcileAiriChatRun(
      runDoc() as unknown as AiriChatRunRecord,
      { now: Date.now() + 60_000 }
    );
    expect(reconciled.status).toBe("interrupted");
    expect(assistantMessages().map(doc => doc.content)).toEqual([ANSWER]);
  });

  it("gives a stopped turn one reply when a reader reconciles it during the stop's reply", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(1);
    const response = await postStream(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    const eventsPromise = readEvents(response);
    await gate.reached;
    await waitFor(() => runDoc()?.partialText === ANSWER_CHUNKS[0]);
    const runId = String(runDoc()?._id);

    // The stop's reply waits on a slow workspace language lookup.
    let releaseLanguage = () => {};
    let languageAsked = () => {};
    const asked = new Promise<void>(resolve => {
      languageAsked = resolve;
    });
    mockLanguageLookup = () => {
      languageAsked();
      return new Promise(resolve => {
        releaseLanguage = () => resolve({ data: null });
      });
    };
    expect(
      (
        await cancelRun(
          jsonRequest("http://localhost/api"),
          runParams(threadId, runId)
        )
      ).status
    ).toBe(202);
    await asked;

    // Meanwhile the heartbeat goes stale and another reader reconciles.
    const reconciled = await reconcileAiriChatRun(
      runDoc(runId) as unknown as AiriChatRunRecord,
      { now: Date.now() + 60_000 }
    );
    expect(reconciled.status).toBe("interrupted");
    releaseLanguage();

    const events = await eventsPromise;
    expect(assistantMessages()).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "interrupted",
    });
    expect(runDoc(runId)?.status).toBe("interrupted");
    expect(String(runDoc(runId)?.assistantMessageId)).toBe(
      String(assistantMessages()[0]?._id)
    );
  });

  async function stopRightAfterTheAnswerIsSaved(
    stop: (threadId: string, runId: string) => Promise<void>
  ) {
    const threadId = await createThread();
    const original = messages.create;
    const saving = jest
      .spyOn(messages, "create")
      .mockImplementation(async input => {
        const doc = await original(input);
        if (input.role === "assistant") {
          await stop(threadId, String(runDoc()?._id));
        }
        return doc;
      });
    try {
      return await readEvents(
        await postStream(
          jsonRequest("http://localhost/api", {
            content: "Delivery feedback?",
          }),
          threadParams(threadId)
        )
      );
    } finally {
      saving.mockRestore();
    }
  }

  function expectCompletedDespiteLateStop(events: AiriChatRunEvent[]) {
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(runDoc()).toMatchObject({ status: "completed", errorCode: null });
    expect(assistantMessages().map(doc => doc.content)).toEqual([ANSWER]);
  }

  it("records a Stop that lands after the answer is saved as completed and counts the quota", async () => {
    const events = await stopRightAfterTheAnswerIsSaved(
      async (threadId, runId) => {
        const response = await cancelRun(
          jsonRequest("http://localhost/api"),
          runParams(threadId, runId)
        );
        expect(response.status).toBe(202);
      }
    );
    expectCompletedDespiteLateStop(events);
    await waitFor(() => mockRecordCreativeStudioChat.mock.calls.length > 0);
    expect(mockRecordCreativeStudioChat).toHaveBeenCalledTimes(1);
  });

  it("records a polled Stop that lands after the answer is saved as completed", async () => {
    const events = await stopRightAfterTheAnswerIsSaved(async (_, runId) => {
      // Another instance took the Stop; the monitor's poll aborts the run.
      await runs.updateOne(
        { _id: new Types.ObjectId(runId) },
        { $set: { cancelRequestedAt: new Date() } }
      );
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expectCompletedDespiteLateStop(events);
    await waitFor(() => mockRecordCreativeStudioChat.mock.calls.length > 0);
  });

  it("marks a run with a stale heartbeat interrupted and answers its user turn", async () => {
    const threadId = await createThread();
    const user = await messages.create({
      threadId: new Types.ObjectId(threadId),
      workspaceId: WORKSPACE_ID,
      role: "user",
      content: "Delivery feedback?",
      metadata: null,
    });
    const startedAt = new Date(Date.now() - 120_000);
    const runId = new Types.ObjectId();
    await runs.create({
      _id: runId,
      workspaceId: WORKSPACE_ID,
      threadId: new Types.ObjectId(threadId),
      userId: "user-1",
      clientTurnId: "stale-1",
      status: "running",
      intent: "general_answer",
      stages: [],
      partialText: "",
      userMessageId: user._id,
      assistantMessageId: null,
      errorCode: null,
      cancelRequestedAt: null,
      heartbeatAt: new Date(Date.now() - 60_000),
      deadlineAt: new Date(startedAt.getTime() + 280_000),
      startedAt,
      completedAt: null,
    });

    const thread = await getThread(
      jsonRequest("http://localhost/api", undefined, "GET"),
      threadParams(threadId)
    );
    expect(await thread.json()).toMatchObject({
      thread: { id: threadId },
      activeRun: null,
    });
    expect(runDoc(String(runId))).toMatchObject({
      status: "interrupted",
      errorCode: "airi_run_interrupted",
    });

    const list = await getMessages(
      jsonRequest("http://localhost/api", undefined, "GET"),
      threadParams(threadId)
    );
    const body = await list.json();
    expect(body.activeRun).toBeNull();
    expect(
      body.messages.map((message: { role: string }) => message.role)
    ).toEqual(["user", "assistant"]);
    expect(body.messages[1]).toMatchObject({
      content: expect.stringContaining("interrupted"),
      metadata: expect.objectContaining({
        failed: true,
        errorCode: "airi_run_interrupted",
        runId: String(runId),
      }),
    });
    // Reconciled once: a second read adds no second failure reply.
    await getMessages(
      jsonRequest("http://localhost/api", undefined, "GET"),
      threadParams(threadId)
    );
    expect(assistantMessages()).toHaveLength(1);
  });

  it("reports a live run as activeRun on thread and message reads", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(1);
    const response = await postStream(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    const events = await readEvents(
      response,
      event => event.type === "assistant_delta"
    );
    const runId = (events[0] as Extract<AiriChatRunEvent, { type: "run" }>)
      .runId;
    await gate.reached;
    const thread = await getThread(
      jsonRequest("http://localhost/api", undefined, "GET"),
      threadParams(threadId)
    );
    expect((await thread.json()).activeRun).toMatchObject({
      runId,
      status: "running",
      startedAt: expect.any(String),
    });
    const list = await getMessages(
      jsonRequest("http://localhost/api", undefined, "GET"),
      threadParams(threadId)
    );
    expect((await list.json()).activeRun).toMatchObject({ runId });
    gate.release();
    await waitFor(() => runDoc(runId)?.status === "completed");
  });

  it("attaches a retried send with the same clientTurnId to its run", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(1);
    const clientTurnId = "0f1e2d3c-4b5a-4c6d-8e7f-901234567890";
    const first = await postStream(
      jsonRequest("http://localhost/api", {
        content: "Delivery feedback?",
        clientTurnId,
      }),
      threadParams(threadId)
    );
    const firstEvents = await readEvents(
      first,
      event => event.type === "assistant_delta"
    );
    await gate.reached;

    const retried = await postStream(
      jsonRequest("http://localhost/api", {
        content: "Delivery feedback?",
        clientTurnId,
      }),
      threadParams(threadId)
    );
    expect(retried.status).toBe(200);
    const eventsPromise = readEvents(retried);
    await new Promise(resolve => setTimeout(resolve, 30));
    gate.release();
    const events = await eventsPromise;
    expect(events[0]).toMatchObject({
      type: "run",
      runId: (firstEvents[0] as Extract<AiriChatRunEvent, { type: "run" }>)
        .runId,
      clientTurnId,
    });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(runs.docs).toHaveLength(1);
    expect(messages.docs.map(doc => doc.role)).toEqual(["user", "assistant"]);
  });

  it("answers 409 airi_run_active to a second send while a run is active", async () => {
    const threadId = await createThread();
    const gate = holdAnswer(1);
    const first = await postStream(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    const events = await readEvents(
      first,
      event => event.type === "assistant_delta"
    );
    const runId = (events[0] as Extract<AiriChatRunEvent, { type: "run" }>)
      .runId;
    await gate.reached;

    const second = await postStream(
      jsonRequest("http://localhost/api", { content: "Another question" }),
      threadParams(threadId)
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      code: "airi_run_active",
      runId,
    });
    const json = await postJson(
      jsonRequest("http://localhost/api", { content: "Another question" }),
      threadParams(threadId)
    );
    expect(json.status).toBe(409);
    expect(runs.docs).toHaveLength(1);
    expect(messages.docs.filter(doc => doc.role === "user")).toHaveLength(1);
    gate.release();
  });

  it("pages messages newest first, each page in chronological order", async () => {
    const threadId = await createThread();
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(
        await messages.create({
          threadId: new Types.ObjectId(threadId),
          workspaceId: WORKSPACE_ID,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index}`,
          metadata: null,
        })
      );
    }
    const page = async (query: string) => {
      const response = await getMessages(
        jsonRequest(`http://localhost/api${query}`, undefined, "GET"),
        threadParams(threadId)
      );
      return { status: response.status, body: await response.json() };
    };

    const latest = await page("?limit=2");
    expect(
      latest.body.messages.map((m: { content: string }) => m.content)
    ).toEqual(["message 3", "message 4"]);
    expect(latest.body).toMatchObject({ hasMore: true, activeRun: null });

    const older = await page(`?limit=2&before=${latest.body.messages[0].id}`);
    expect(
      older.body.messages.map((m: { content: string }) => m.content)
    ).toEqual(["message 1", "message 2"]);
    expect(older.body.hasMore).toBe(true);

    const oldest = await page(`?limit=2&before=${older.body.messages[0].id}`);
    expect(
      oldest.body.messages.map((m: { content: string }) => m.content)
    ).toEqual(["message 0"]);
    expect(oldest.body.hasMore).toBe(false);

    const all = await page("");
    expect(all.body.messages).toHaveLength(5);
    expect(all.body.hasMore).toBe(false);

    expect((await page("?before=not-an-id")).status).toBe(400);
    expect((await page("?limit=0")).status).toBe(400);
    // Above the maximum the page is capped, not refused.
    expect((await page("?limit=500")).status).toBe(200);
  });

  it("keeps the JSON routes' response shape (mobile)", async () => {
    const threadId = await createThread();
    const existing = await postJson(
      jsonRequest("http://localhost/api", { content: "Delivery feedback?" }),
      threadParams(threadId)
    );
    expect(existing.status).toBe(200);
    const body = await existing.json();
    expect(Object.keys(body).sort()).toEqual([
      "assistantMessage",
      "thread",
      "userMessage",
    ]);
    expect(body).toMatchObject({
      userMessage: { role: "user", threadId, content: "Delivery feedback?" },
      assistantMessage: { role: "assistant", threadId, content: ANSWER },
      thread: { id: threadId, workspaceId: WORKSPACE_ID },
    });

    const created = await postNewChatJson(
      jsonRequest("http://localhost/api", {
        content: "How fast is delivery?",
        source: "manual",
      }),
      { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) }
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(Object.keys(createdBody).sort()).toEqual([
      "assistantMessage",
      "thread",
      "userMessage",
    ]);
    expect(createdBody.assistantMessage.content).toBe(ANSWER);
    // The new chat was created with the id its run recorded first.
    const newRun = runs.docs.find(
      doc => String(doc.threadId) === createdBody.thread.id
    );
    expect(newRun).toMatchObject({ status: "completed" });
  });

  it("streams a new chat as a durable run", async () => {
    const response = await postNewChatStream(
      jsonRequest("http://localhost/api", { content: "How fast is delivery?" }),
      { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) }
    );
    const events = await readEvents(response);
    const runEvent = events[0] as Extract<AiriChatRunEvent, { type: "run" }>;
    expect(runEvent.type).toBe("run");
    const thread = events.find(event => event.type === "thread");
    expect(thread).toMatchObject({ thread: { id: runEvent.threadId } });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(threads.docs.map(doc => String(doc._id))).toEqual([
      runEvent.threadId,
    ]);
  });
});
