const mockConnectDb = jest.fn();
const mockTraceCreate = jest.fn();
const mockTraceFindOneAndUpdate = jest.fn();
const mockConversationUpdateOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDb(...args),
}));

jest.mock("@/models/airi-reply-trace", () => ({
  __esModule: true,
  default: {
    create: (...args: unknown[]) => mockTraceCreate(...args),
    findOneAndUpdate: (...args: unknown[]) =>
      mockTraceFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));

import {
  persistAiriReplyTrace,
  resolveReplyTraceGroundingSourceKind,
} from "@/lib/airi/reply/runtime/reply-trace";

describe("airi reply trace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDb.mockResolvedValue(undefined);
    mockTraceCreate.mockResolvedValue({ _id: "trace-1" });
    mockTraceFindOneAndUpdate.mockResolvedValue({ _id: "trace-1" });
    mockConversationUpdateOne.mockResolvedValue({ acknowledged: true });
  });

  it("keeps a TTL index on expiresAt", () => {
    const actualModel = jest.requireActual("@/models/airi-reply-trace")
      .default as {
      schema: {
        indexes: () => Array<[Record<string, number>, Record<string, unknown>]>;
      };
    };
    const indexes = actualModel.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
      ])
    );
  });

  it("stores a compact trace payload and updates last grounding after delivery", async () => {
    await persistAiriReplyTrace({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      inboundMessageId: "message-in",
      outboundMessageId: "message-out",
      channel: "telegram",
      delivered: true,
      queryText: "grants and pricing",
      lastMessageQuery: "pricing",
      intentAnchor: "pricing",
      activeGoals: ["grants", "pricing", "pricing"],
      openAsks: ["grants", "pricing"],
      queryVariants: ["grants and pricing", "grants", "pricing"],
      followUpMode: "resume_current_goal",
      followUpAnchor: "pricing",
      fallbackPlanningUsed: true,
      retrievalPriority: "kb",
      groundingSourceKind: "mixed",
      chosenSourceIds: ["snippet-1", "kb-1", "kb-1"],
      snippetShortCircuitedKB: false,
      model: "gemini-3.5-flash",
      provider: "vertex",
      latencyMs: 120,
      finishReason: "stop",
      fallbackAction: "use_generated_reply",
      fallbackReason: "generated_reply_complete",
      coverage: {
        asksDetected: ["grants", "pricing"],
        asksAnswered: ["grants", "pricing"],
        missingAsks: [],
      },
    });

    expect(mockTraceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        activeGoals: ["grants", "pricing"],
        queryVariants: ["grants and pricing", "grants", "pricing"],
        followUpMode: "resume_current_goal",
        fallbackPlanningUsed: true,
        chosenSourceIds: ["snippet-1", "kb-1"],
        coverage: {
          asksDetected: ["grants", "pricing"],
          asksAnswered: ["grants", "pricing"],
          missingAsks: [],
        },
      })
    );
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { _id: "conversation-1" },
      expect.objectContaining({
        $set: {
          "airi_context_memory.lastGrounding": expect.objectContaining({
            sourceKind: "mixed",
            sourceIds: ["snippet-1", "kb-1"],
            intentAnchor: "pricing",
          }),
        },
      })
    );
  });

  it("resolves mixed grounding when both snippet and kb are present", () => {
    expect(
      resolveReplyTraceGroundingSourceKind({ hasSnippet: true, hasKB: true })
    ).toBe("mixed");
    expect(
      resolveReplyTraceGroundingSourceKind({ hasSnippet: false, hasKB: true })
    ).toBe("kb");
  });

  it("upserts a deterministic trace for a retried Temporal effect", async () => {
    await persistAiriReplyTrace({
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      inboundMessageId: "message-in",
      outboundMessageId: "message-out",
      delivered: true,
      idempotencyKey: "delivery-1:persist_reply_trace",
    });

    expect(mockTraceCreate).not.toHaveBeenCalled();
    expect(mockTraceFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: expect.stringMatching(/^[a-f0-9]{24}$/) },
      { $set: expect.objectContaining({ outboundMessageId: "message-out" }) },
      { upsert: true, setDefaultsOnInsert: true }
    );
  });
});
