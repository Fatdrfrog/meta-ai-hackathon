const mockConnectDB = jest.fn();
const mockEnsureRealtimeEventIndexes = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
const mockPublishRealtimePubSubEvent = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/models/realtime-event", () => ({
  ensureRealtimeEventIndexes: (...args: unknown[]) =>
    mockEnsureRealtimeEventIndexes(...args),
  RealtimeEvent: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

jest.mock("./server", () => ({
  publishRealtimePubSubEvent: (...args: unknown[]) =>
    mockPublishRealtimePubSubEvent(...args),
}));

import { replayRealtimeOutboxBatch } from "./outbox-replay";

function buildOutboxDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "outbox-1",
    eventId: "event-1",
    workspaceId: "workspace-1",
    conversationId: "507f1f77bcf86cd799439011",
    channel: "conversation:workspace-1:507f1f77bcf86cd799439011",
    status: "replaying",
    attempts: 2,
    replayLeaseId: "lease-1",
    event: {
      eventId: "event-1",
      version: 1,
      name: "conversation.message.created",
      workspaceId: "workspace-1",
      conversationId: "507f1f77bcf86cd799439011",
      createdAt: "2026-06-19T00:00:00.000Z",
      dedupeKey: "message:1",
      payload: { messageId: "message-1" },
    },
    ...overrides,
  };
}

function buildV3OutboxDoc() {
  const eventId = "requests-row:v3:legacy-row";
  return buildOutboxDoc({
    eventId,
    channel: "workspace:workspace-1",
    event: {
      eventId,
      version: 1,
      name: "conversation.row.changed",
      workspaceId: "workspace-1",
      conversationId: "507f1f77bcf86cd799439011",
      createdAt: "2026-08-20T12:00:00.000Z",
      dedupeKey: eventId,
      payload: {
        conversationId: "507f1f77bcf86cd799439011",
        changeType: "updated",
        projectionGeneration: "17",
      },
    },
  });
}

describe("replayRealtimeOutboxBatch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockEnsureRealtimeEventIndexes.mockResolvedValue(undefined);
    mockFindOneAndUpdate.mockResolvedValue(buildOutboxDoc());
    mockPublishRealtimePubSubEvent.mockResolvedValue({ messageId: "pubsub-1" });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it("does not enter Mongo recovery after scanner ownership is lost", async () => {
    const result = await replayRealtimeOutboxBatch({
      shouldContinue: () => false,
    });
    expect(result).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("finishes an admitted row with its lease CAS but stops claiming when scanner ownership is lost", async () => {
    let owner = true;
    mockPublishRealtimePubSubEvent.mockImplementationOnce(async () => {
      owner = false;
      return { messageId: "pubsub-1" };
    });
    const result = await replayRealtimeOutboxBatch({
      leaseId: "lease-1",
      shouldContinue: () => owner,
    });
    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne.mock.calls[0][0]).toEqual({
      _id: "outbox-1",
      replayLeaseId: "lease-1",
    });
  });

  it("uses a fresh replay lease deadline for each row in a slow production batch", async () => {
    jest.useFakeTimers();
    const startedAt = new Date("2026-10-02T00:00:00.000Z");
    const later = new Date(startedAt.getTime() + 120_000);
    jest.setSystemTime(startedAt);
    try {
      mockFindOneAndUpdate
        .mockResolvedValueOnce(buildOutboxDoc())
        .mockResolvedValueOnce(buildOutboxDoc({ _id: "outbox-2" }))
        .mockResolvedValueOnce(null);
      mockPublishRealtimePubSubEvent.mockImplementationOnce(async () => {
        jest.setSystemTime(later);
        return { messageId: "pubsub-1" };
      });
      await replayRealtimeOutboxBatch({ leaseMs: 60_000 });
      expect(mockFindOneAndUpdate.mock.calls[1][1].$set).toMatchObject({
        lastReplayAt: later,
        replayLeaseExpiresAt: new Date(later.getTime() + 60_000),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("claims failed or stale realtime events with a lease before republishing", async () => {
    const now = new Date("2026-06-19T12:00:00.000Z");

    const result = await replayRealtimeOutboxBatch({
      batchSize: 1,
      now,
      leaseId: "lease-1",
      stalePendingMs: 30_000,
      leaseMs: 60_000,
    });

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(mockEnsureRealtimeEventIndexes).toHaveBeenCalledTimes(1);
    expect(
      mockEnsureRealtimeEventIndexes.mock.invocationCallOrder[0]
    ).toBeLessThan(mockFindOneAndUpdate.mock.invocationCallOrder[0]);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: expect.objectContaining({ $lt: 10 }),
        $and: expect.arrayContaining([
          expect.objectContaining({
            $or: expect.arrayContaining([
              { status: "failed" },
              expect.objectContaining({ status: "pending" }),
              expect.objectContaining({ status: "replaying" }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "replaying",
          replayLeaseId: "lease-1",
          replayLeaseExpiresAt: new Date("2026-06-19T12:01:00.000Z"),
          lastReplayAt: now,
        }),
        $inc: { attempts: 1 },
      }),
      expect.objectContaining({
        new: true,
        sort: { createdAt: 1 },
      })
    );
    expect(mockPublishRealtimePubSubEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "conversation:workspace-1:507f1f77bcf86cd799439011",
        eventId: "event-1",
      })
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "outbox-1", replayLeaseId: "lease-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "published",
          messageId: "pubsub-1",
          publishedAt: expect.any(Date),
          lastError: null,
        }),
        $unset: expect.objectContaining({
          replayLeaseId: "",
          replayLeaseExpiresAt: "",
          nextAttemptAt: "",
        }),
      })
    );
  });

  it("claims explicitly replay-owned pending events immediately without racing legacy publishers", async () => {
    const now = new Date("2026-06-19T12:00:00.000Z");
    const stalePendingBefore = new Date("2026-06-19T11:59:30.000Z");

    await replayRealtimeOutboxBatch({
      batchSize: 1,
      now,
      leaseId: "lease-1",
      stalePendingMs: 30_000,
    });

    const [filter] = mockFindOneAndUpdate.mock.calls[0] as [
      {
        $and: Array<{
          $or?: Array<Record<string, unknown>>;
        }>;
      },
    ];
    expect(filter.$and[0]?.$or).toEqual(
      expect.arrayContaining([
        {
          status: "pending",
          nextAttemptAt: { $type: "date", $lte: now },
        },
        {
          status: "pending",
          createdAt: { $lte: stalePendingBefore },
          $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: null }],
        },
      ])
    );
  });

  it("keeps the leased event retryable when publish fails", async () => {
    const now = new Date("2026-06-19T12:00:00.000Z");
    mockPublishRealtimePubSubEvent.mockRejectedValue(new Error("pubsub down"));

    const result = await replayRealtimeOutboxBatch({
      batchSize: 1,
      now,
      leaseId: "lease-1",
      retryDelayMs: 120_000,
    });

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "outbox-1", replayLeaseId: "lease-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "failed",
          lastError: "pubsub down",
          nextAttemptAt: new Date("2026-06-19T12:02:00.000Z"),
        }),
        $unset: expect.objectContaining({
          replayLeaseId: "",
          replayLeaseExpiresAt: "",
        }),
      })
    );
  });

  it("does not query the outbox when explicit index creation fails", async () => {
    mockEnsureRealtimeEventIndexes.mockRejectedValue(new Error("index denied"));

    await expect(replayRealtimeOutboxBatch({})).rejects.toThrow("index denied");
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("keeps a genuine v3 row on the existing one-effect Pub/Sub path", async () => {
    const doc = buildV3OutboxDoc();
    mockFindOneAndUpdate.mockResolvedValue(doc);

    const result = await replayRealtimeOutboxBatch({
      batchSize: 1,
      leaseId: "lease-1",
    });

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(mockPublishRealtimePubSubEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "requests-row:v3:legacy-row",
        channel: "workspace:workspace-1",
      })
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: doc._id, replayLeaseId: "lease-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "published",
          messageId: "pubsub-1",
        }),
      })
    );
  });
});
