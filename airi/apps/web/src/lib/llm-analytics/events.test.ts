const mockAfter = jest.fn((_callback: () => Promise<void>): void => {
  throw new Error("outside a request scope");
});

jest.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => mockAfter(callback),
}));

import type { LlmAnalyticsEvent } from "@icecore/airi-runtime/llm-analytics";

const mockPersistLlmAnalyticsEventsWithOutbox = jest.fn(
  async (_events: LlmAnalyticsEvent[]) => ({
    applied: true,
    queuedToOutbox: false,
  })
);
const mockBuildReviewItemDraftsForRagTurn = jest.fn((_event: unknown) => []);
const mockPersistReviewItemDrafts = jest.fn(
  async (_drafts: unknown[]) => undefined
);
const mockWarn = jest.fn((_event: string, _context: unknown) => undefined);

jest.mock("@/lib/cross-store-outbox", () => ({
  persistLlmAnalyticsEventsWithOutbox: (events: LlmAnalyticsEvent[]) =>
    mockPersistLlmAnalyticsEventsWithOutbox(events),
}));

jest.mock("@/lib/llm-analytics/review-items", () => ({
  buildReviewItemDraftsForRagTurn: (event: unknown) =>
    mockBuildReviewItemDraftsForRagTurn(event),
  persistReviewItemDrafts: (drafts: unknown[]) =>
    mockPersistReviewItemDrafts(drafts),
}));

jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiReplyLogger: {
    warn: (event: string, context: unknown) => mockWarn(event, context),
  },
}));

import { runInAiriChatRunTaskScope } from "@/lib/airi-chats/after-response";
import {
  drainPendingLlmAnalyticsEvents,
  recordRagTurnAnalyticsEvents,
} from "./events";

describe("LLM product analytics emission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LLM_ANALYTICS_EVENTS_ENABLED;
  });

  it("awaits one durable RAG fact without redundant deterministic score events", async () => {
    await recordRagTurnAnalyticsEvents(
      {
        eventTs: "2026-08-13T12:00:00.000Z",
        inputText: "Where is my order?",
        outputText: "Your order is in transit.",
        wideEvent: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          resultType: "ai_reply",
          outcome: "ok",
          sourceIds: ["source-1"],
        },
      },
      { persistReviewItems: false }
    );
    await expect(drainPendingLlmAnalyticsEvents(1_000)).resolves.toBe(true);

    expect(mockPersistLlmAnalyticsEventsWithOutbox).toHaveBeenCalledTimes(1);
    const publishedEvents =
      mockPersistLlmAnalyticsEventsWithOutbox.mock.calls[0]?.[0];
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      event_kind: "rag_turn",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
    });
    expect(mockBuildReviewItemDraftsForRagTurn).toHaveBeenCalledTimes(1);
    expect(mockPersistReviewItemDrafts).not.toHaveBeenCalled();
  });

  it("does not hold the AI call outside a request; the drain waits for the write", async () => {
    let resolvePersistence!: (value: {
      applied: boolean;
      queuedToOutbox: boolean;
    }) => void;
    mockPersistLlmAnalyticsEventsWithOutbox.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePersistence = resolve;
      })
    );

    await expect(
      recordRagTurnAnalyticsEvents(
        {
          eventTs: "2026-08-13T12:00:00.000Z",
          inputText: "Where is my order?",
          outputText: "Your order is in transit.",
          wideEvent: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            resultType: "ai_reply",
            outcome: "ok",
            sourceIds: ["source-1"],
          },
        },
        { persistReviewItems: false }
      )
    ).resolves.toBe(true);

    let drained: boolean | undefined;
    const drain = drainPendingLlmAnalyticsEvents(1_000).then(result => {
      drained = result;
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(drained).toBeUndefined();
    resolvePersistence({ applied: false, queuedToOutbox: true });
    await drain;
    expect(drained).toBe(true);
    await expect(drainPendingLlmAnalyticsEvents(1_000)).resolves.toBe(true);
  });

  it("stops waiting for a stuck write once the drain times out", async () => {
    let resolvePersistence!: (value: {
      applied: boolean;
      queuedToOutbox: boolean;
    }) => void;
    mockPersistLlmAnalyticsEventsWithOutbox.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePersistence = resolve;
      })
    );

    await recordRagTurnAnalyticsEvents(
      {
        eventTs: "2026-08-13T12:00:00.000Z",
        inputText: "Where is my order?",
        outputText: "Your order is in transit.",
        wideEvent: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          resultType: "ai_reply",
          outcome: "ok",
          sourceIds: ["source-1"],
        },
      },
      { persistReviewItems: false }
    );

    await expect(drainPendingLlmAnalyticsEvents(10)).resolves.toBe(false);
    resolvePersistence({ applied: true, queuedToOutbox: false });
    await expect(drainPendingLlmAnalyticsEvents(1_000)).resolves.toBe(true);
  });

  it("uses the request lifecycle to finish persistence after the response", async () => {
    let scheduled!: () => Promise<void>;
    mockAfter.mockImplementationOnce(callback => {
      scheduled = callback;
    });
    mockPersistLlmAnalyticsEventsWithOutbox.mockClear();

    await expect(
      recordRagTurnAnalyticsEvents(
        {
          eventTs: "2026-08-13T12:00:00.000Z",
          inputText: "Where is my order?",
          outputText: "Your order is in transit.",
          wideEvent: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            resultType: "ai_reply",
            outcome: "ok",
            sourceIds: ["source-1"],
          },
        },
        { persistReviewItems: false }
      )
    ).resolves.toBe(true);
    expect(mockPersistLlmAnalyticsEventsWithOutbox).not.toHaveBeenCalled();

    await scheduled();
    expect(mockPersistLlmAnalyticsEventsWithOutbox).toHaveBeenCalledTimes(1);
  });

  it("inside a durable Airi chat run, the run's keep-alive waits for the persist instead of after()", async () => {
    let resolvePersistence!: (value: {
      applied: boolean;
      queuedToOutbox: boolean;
    }) => void;
    mockPersistLlmAnalyticsEventsWithOutbox.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePersistence = resolve;
      })
    );
    let resolveReviewItems!: () => void;
    mockBuildReviewItemDraftsForRagTurn.mockReturnValueOnce([
      { id: "draft" },
    ] as never);
    mockPersistReviewItemDrafts.mockReturnValueOnce(
      new Promise<undefined>(resolve => {
        resolveReviewItems = () => resolve(undefined);
      })
    );
    const tasks = new Set<Promise<void>>();

    await expect(
      runInAiriChatRunTaskScope(tasks, () =>
        recordRagTurnAnalyticsEvents({
          eventTs: "2026-08-13T12:00:00.000Z",
          inputText: "Where is my order?",
          outputText: "Your order is in transit.",
          wideEvent: {
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            resultType: "ai_reply",
            outcome: "ok",
            sourceIds: ["source-1"],
          },
        })
      )
    ).resolves.toBe(true);
    // Not queued on the request's (possibly drained) after-queue.
    expect(mockAfter).not.toHaveBeenCalled();
    expect(tasks.size).toBe(2);

    // What turn/run.ts keeps alive: the run's tasks until none are left.
    let keptAlive = false;
    const keepAlive = (async () => {
      while (tasks.size > 0) await Promise.allSettled([...tasks]);
    })().then(() => {
      keptAlive = true;
    });
    resolvePersistence({ applied: true, queuedToOutbox: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(keptAlive).toBe(false);
    resolveReviewItems();
    await keepAlive;
    expect(tasks.size).toBe(0);
    expect(mockPersistLlmAnalyticsEventsWithOutbox).toHaveBeenCalledTimes(1);
    expect(mockPersistReviewItemDrafts).toHaveBeenCalledTimes(1);
  });
});
