/**
 * One Airi chat turn end to end: the stream route, the real turn service
 * (intent classifier, retrieval orchestration, general answer, throttled
 * previews), lib/ai's provider loop, the SSE framing and the web client's own
 * SSE parser. Only the boundaries are stubbed: the Claude provider call, the
 * Mongo models and connection, Supabase (auth, membership, AI allowance,
 * studio quota), the AI gateway and local search, and analytics writes.
 */
import { Types } from "mongoose";

type StoredDoc = Record<string, unknown> & { _id: Types.ObjectId };

const mockThreads: StoredDoc[] = [];
const mockMessages: StoredDoc[] = [];
const mockGenerateAnthropicText = jest.fn();
const mockRecordCreativeStudioChat = jest.fn();
let mockNow = 0;

// Claude provider boundary (wraps @anthropic-ai/sdk); lib/ai runs for real.
jest.mock("@/lib/ai/anthropic-messages", () => {
  const actual = jest.requireActual("@/lib/ai/anthropic-messages");
  return {
    ...actual,
    generateAnthropicText: (...args: unknown[]) =>
      mockGenerateAnthropicText(...args),
  };
});

// Auth: the cookie session and workspace membership.
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    // The workspace language lookup finds no company setting.
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
  }),
}));
jest.mock("@/lib/sources/utils", () => ({
  verifyWorkspaceAccess: async () => true,
}));

// Supabase admin: the workspace AI allowance admission.
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
              reset_at: null, allowance_period: "lifetime",
              billing_source: "platform",
              source_id: null,
            },
            error: null,
          }
        : { data: null, error: { message: "unexpected rpc" } },
  },
}));

// Studio-chat quota (Supabase and Mongo counters).
jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyStudioChatCapacity: async () => ({ allowed: true, limit: {} }),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyStudioChatLimitExceededResponse: () =>
    new Response(null, { status: 402 }),
}));

// Mongo: the connection and the two Airi chat collections, in memory.
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: async () => undefined,
}));
jest.mock("@/models/airi-chat-thread", () => ({
  AiriChatThread: {
    create: async (doc: Record<string, unknown>) => {
      const now = new Date("2026-10-08T09:00:00.000Z");
      const thread: StoredDoc = {
        ...doc,
        _id: new Types.ObjectId(),
        pinnedAt: null,
        createdAt: now,
        updatedAt: now,
        save: jest.fn(async () => undefined),
      };
      mockThreads.push(thread);
      return thread;
    },
    updateOne: async (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> }
    ) => {
      const thread = mockThreads.find(
        stored =>
          String(stored._id) === String(filter._id) &&
          (!("title" in filter) || stored.title === filter.title)
      );
      if (!thread) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(thread, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
}));
jest.mock("@/models/airi-chat-message", () => ({
  AIRI_CHAT_MESSAGE_CONTENT_MAX_LENGTH: 12000,
  AiriChatMessage: {
    create: async (doc: Record<string, unknown>) => {
      const message: StoredDoc = {
        ...doc,
        _id: doc._id instanceof Types.ObjectId ? doc._id : new Types.ObjectId(),
        createdAt: new Date("2026-10-08T09:00:01.000Z"),
      };
      mockMessages.push(message);
      return message;
    },
    find: (filter: { threadId: unknown }) => {
      const rows = mockMessages.filter(
        message => String(message.threadId) === String(filter.threadId)
      );
      const query = {
        sort: () => query,
        limit: () => query,
        lean: async () => rows,
      };
      return query;
    },
  },
}));

// The durable run's document (status, stages, preview, heartbeat).
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

// Retrieval services: the AI gateway (HTTP) and local search (embeddings
// plus Mongo vector search). One KB article keeps the general answer path.
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

// Analytics writes (Mongo / event sinks).
jest.mock("@/lib/llm-analytics/events", () => ({
  recordLlmTraceAnalyticsEvent: jest.fn(async () => undefined),
  recordRagTurnAnalyticsEvents: jest.fn(async () => undefined),
}));

import type { NextRequest } from "next/server";
import { readAiriChatEventStream } from "@/components/ai/airi-chat-event-stream";
import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";
import { AIRI_CHAT_DELTA_THROTTLE_MS } from "@/lib/airi-chats/service";
import { POST } from "./route";

const ANSWER_CHUNKS = ["Customers mostly ", "say delivery ", "is slow."];
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AI_ENABLED",
  "AI_CHAT_PROVIDER_ORDER",
] as const;

describe("Airi chat stream: route -> service -> SSE -> client parser", () => {
  const previousEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]])
  );

  beforeEach(() => {
    mockThreads.length = 0;
    mockMessages.length = 0;
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = "test-key";
    // Each chunk lands a full throttle window after the previous one, so
    // every chunk is sent as a preview; Date.now() is the throttle's clock.
    mockNow = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => mockNow);
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
    mockGenerateAnthropicText.mockImplementation(
      async (
        request: { model: string; messages: Array<{ content: string }> },
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
          // Background title generation after the response.
          return {
            text: "Delivery feedback",
            finishReason: "end_turn",
            servedModel: request.model,
          };
        }
        let accumulated = "";
        for (const delta of ANSWER_CHUNKS) {
          accumulated += delta;
          await callbacks.onDelta({ delta, accumulated });
          mockNow += AIRI_CHAT_DELTA_THROTTLE_MS;
        }
        return {
          text: accumulated,
          finishReason: "end_turn",
          servedModel: request.model,
        };
      }
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it("streams thread, user_message, stages, previews, the answer and done, in order", async () => {
    const response = await POST(
      new Request("http://localhost/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "How do customers feel about delivery times?",
        }),
      }) as unknown as NextRequest,
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events: AiriChatRunEvent[] = [];
    await readAiriChatEventStream(response, event => {
      events.push(event);
    });
    const types = events.map(event => event.type);

    // Order: the durable run, then thread, user_message, stages, previews,
    // answer, done.
    expect(types[0]).toBe("run");
    expect(types[1]).toBe("stage");
    expect(types.slice(1).find(type => type !== "stage")).toBe("thread");
    expect(types.indexOf("user_message")).toBeGreaterThan(
      types.indexOf("thread")
    );
    expect(types.slice(-2)).toEqual(["assistant_message", "done"]);
    expect(types.filter(type => type === "error")).toEqual([]);

    // Stages ran between the saved user message and the first preview.
    const userIndex = types.indexOf("user_message");
    const firstDelta = types.indexOf("assistant_delta");
    expect(
      types.slice(userIndex, firstDelta).filter(type => type === "stage").length
    ).toBeGreaterThan(0);
    const stageIds = events.flatMap(event =>
      event.type === "stage" ? [event.id] : []
    );
    expect(stageIds).toEqual(
      expect.arrayContaining([
        "history",
        "intent",
        "workspace_retrieval",
        "assistant_message",
      ])
    );

    // Previews carry the full text so far, end before the answer, and the
    // answer is authoritative.
    const thread = events.find(event => event.type === "thread");
    const threadId = thread?.type === "thread" ? thread.thread.id : "";
    const deltas = events.flatMap(event =>
      event.type === "assistant_delta" ? [event] : []
    );
    expect(deltas.map(delta => delta.text)).toEqual([
      "Customers mostly ",
      "Customers mostly say delivery ",
      "Customers mostly say delivery is slow.",
    ]);
    expect(deltas.every(delta => delta.threadId === threadId)).toBe(true);
    expect(types.lastIndexOf("assistant_delta")).toBeLessThan(
      types.indexOf("assistant_message")
    );
    const answer = events.find(event => event.type === "assistant_message");
    expect(answer).toMatchObject({
      message: {
        role: "assistant",
        threadId,
        content: "Customers mostly say delivery is slow.",
        metadata: expect.objectContaining({ intent: "general_answer" }),
      },
    });
    const done = events[events.length - 1];
    expect(done).toMatchObject({
      type: "done",
      status: "completed",
      thread: {
        id: threadId,
        title: "How do customers feel about delivery times?",
      },
    });

    // The real classifier and answer both went through the provider; only
    // the answer streamed.
    const providerCalls = mockGenerateAnthropicText.mock.calls;
    expect(providerCalls.length).toBeGreaterThanOrEqual(2);
    expect(providerCalls.filter(call => call[1]?.onDelta)).toHaveLength(1);

    // Persisted through the model boundary: the first-message title landed
    // with the answer, before 'done'; after the response the quota is
    // recorded (inline here: no Next request scope).
    expect(mockMessages.map(message => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(mockThreads[0]!.title).not.toBe("New chat");
    for (
      let i = 0;
      i < 50 && mockRecordCreativeStudioChat.mock.calls.length === 0;
      i += 1
    ) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(mockRecordCreativeStudioChat).toHaveBeenCalledWith(
      "workspace-1",
      "airi_chat"
    );
  });
});
