const mockConversationFindOneAndUpdate = jest.fn();
const mockScheduleConversationClassificationWakeBestEffort = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockConversationFindOneAndUpdate(...args),
  },
}));
jest.mock("@/lib/classifier/classification-pubsub", () => ({
  scheduleConversationClassificationWakeBestEffort: (input: unknown) =>
    mockScheduleConversationClassificationWakeBestEffort(input),
}));

import { appendMessageToConversationById } from "@/lib/conversation-messages";
import mongoose from "mongoose";

describe("conversation message helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversationFindOneAndUpdate.mockReset();
    mockScheduleConversationClassificationWakeBestEffort.mockResolvedValue(
      undefined
    );
  });

  it("preserves manager read state when a new historical inbound message is appended", async () => {
    mockConversationFindOneAndUpdate.mockReturnValueOnce({ lean: () => ({ exec: async () => ({ _id: new mongoose.Types.ObjectId(), classification_revision: 1 }) }) });
    await appendMessageToConversationById(new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), { direction: "inbound", importMode: "history" } as never);
    const pipeline = mockConversationFindOneAndUpdate.mock.calls[0][1];
    assertHistoryReadState(pipeline);
  });

  it("rejects an append whose message direction is missing", async () => {
    await expect(
      appendMessageToConversationById(
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
        {} as never
      )
    ).rejects.toThrow("direction");

    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    "messages",
    "message_count",
    "last_inbound_at",
    "classification_revision",
    "classification_state.status",
    "classification.category",
    "classification_meta.source_revision",
    "classification_error",
    "is_classified",
    "is_qa_analyzed",
    "__next_messages",
  ])("rejects caller metadata that owns reserved path %s", async path => {
    await expect(
      appendMessageToConversationById(
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
        {
          direction: "inbound",
          set: { [path]: "forged" },
        }
      )
    ).rejects.toThrow("reserved");

    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("returns the committed revision and schedules one wake for a unique inbound append", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    const requestedAt = new Date("2026-08-10T06:00:00.000Z");
    const scheduleWake = jest.fn().mockResolvedValue(undefined);
    mockConversationFindOneAndUpdate.mockReturnValueOnce({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: conversationId,
          classification_revision: 4,
          classification_state: {
            status: "pending",
            requestedRevision: 4,
            generation: 3,
            requestedAt,
          },
        }),
      }),
    });

    await expect(
      appendMessageToConversationById(
        conversationId,
        messageId.toHexString(),
        { direction: "inbound" },
        {
          now: () => requestedAt,
          scheduleWake,
        }
      )
    ).resolves.toEqual({
      appended: true,
      classificationRevision: 4,
      requestedRevision: 4,
      generation: 3,
      status: "pending",
      requestedAt,
    });

    const [filter] = mockConversationFindOneAndUpdate.mock.calls[0] ?? [];
    expect(filter).toEqual({
      _id: conversationId,
      $expr: {
        $not: [
          {
            $in: [
              messageId.toHexString(),
              {
                $map: {
                  input: {
                    $cond: [{ $isArray: "$messages" }, "$messages", []],
                  },
                  as: "linkedMessageId",
                  in: {
                    $convert: {
                      input: "$$linkedMessageId",
                      to: "string",
                      onError: "",
                      onNull: "",
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    });
    expect(scheduleWake).toHaveBeenCalledWith({
      conversationId: conversationId.toHexString(),
      requestedRevision: 4,
      generation: 3,
      requestedAt,
    });
  });

  it("uses the Pub/Sub scheduler as the production default for a unique inbound append", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const requestedAt = new Date("2026-08-10T06:00:00.000Z");
    mockConversationFindOneAndUpdate.mockReturnValueOnce({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: conversationId,
          classification_revision: 4,
          classification_state: {
            status: "pending",
            requestedRevision: 4,
            generation: 3,
            requestedAt,
          },
        }),
      }),
    });

    await appendMessageToConversationById(
      conversationId,
      new mongoose.Types.ObjectId(),
      { direction: "inbound" }
    );

    expect(
      mockScheduleConversationClassificationWakeBestEffort
    ).toHaveBeenCalledWith({
      conversationId: conversationId.toHexString(),
      requestedRevision: 4,
      generation: 3,
      requestedAt,
    });
  });

  it("uses a duplicate-only metadata update without changing state or publishing", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    const scheduleWake = jest.fn();
    mockConversationFindOneAndUpdate
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: conversationId,
            classification_revision: 7,
            classification_state: {
              status: "ready",
              requestedRevision: 7,
              generation: 5,
              requestedAt: new Date("2026-08-10T05:00:00.000Z"),
            },
          }),
        }),
      });

    const result = await appendMessageToConversationById(
      conversationId,
      messageId,
      {
        direction: "inbound",
        set: { sourceId: "source-1" },
      },
      { scheduleWake }
    );

    expect(result.appended).toBe(false);
    expect(mockConversationFindOneAndUpdate).toHaveBeenCalledTimes(2);
    const [duplicateFilter, duplicatePipeline] =
      mockConversationFindOneAndUpdate.mock.calls[1] ?? [];
    expect(duplicateFilter).toMatchObject({
      _id: conversationId,
      $expr: { $in: [messageId.toHexString(), expect.any(Object)] },
    });
    expect(JSON.stringify(duplicatePipeline)).not.toContain(
      "classification_revision"
    );
    expect(duplicatePipeline[0].$set).not.toHaveProperty("is_read_by_manager");
    expect(
      mockConversationFindOneAndUpdate.mock.calls[0][1][1].$set
    ).toHaveProperty("is_read_by_manager", false);
    expect(scheduleWake).not.toHaveBeenCalled();
  });

  it("builds a first-message historical timestamp with a monotonic established fallback", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    const historicalUpdatedAt = new Date("2025-01-01T10:00:00.000Z");
    mockConversationFindOneAndUpdate.mockReturnValueOnce({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: conversationId,
          classification_revision: 1,
          classification_state: {
            status: "not_applicable",
            requestedRevision: 1,
            generation: 0,
            requestedAt: historicalUpdatedAt,
          },
        }),
      }),
    });

    await appendMessageToConversationById(
      conversationId,
      messageId,
      {
        direction: "outbound",
        historicalUpdatedAt,
      },
      {
        now: () => historicalUpdatedAt,
        scheduleWake: jest.fn(),
      }
    );

    const [, uniquePipeline] =
      mockConversationFindOneAndUpdate.mock.calls[0] ?? [];
    expect(uniquePipeline[1].$set.updatedAt).toEqual({
      $let: {
        vars: {
          currentMessages: {
            $cond: [{ $isArray: "$messages" }, "$messages", []],
          },
        },
        in: {
          $cond: [
            { $eq: [{ $size: "$$currentMessages" }, 0] },
            historicalUpdatedAt,
            {
              $cond: [
                {
                  $or: [
                    { $ne: [{ $type: "$updatedAt" }, "date"] },
                    { $gt: [historicalUpdatedAt, "$updatedAt"] },
                  ],
                },
                historicalUpdatedAt,
                "$updatedAt",
              ],
            },
          ],
        },
      },
    });
  });

  it("uses the monotonic historical timestamp expression on duplicate replay", async () => {
    const conversationId = new mongoose.Types.ObjectId();
    const messageId = new mongoose.Types.ObjectId();
    const historicalUpdatedAt = new Date("2025-01-01T10:00:00.000Z");
    mockConversationFindOneAndUpdate
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: conversationId,
            classification_revision: 3,
            classification_state: {
              status: "not_applicable",
              requestedRevision: 3,
              generation: 0,
              requestedAt: historicalUpdatedAt,
            },
          }),
        }),
      });

    await appendMessageToConversationById(
      conversationId,
      messageId,
      {
        direction: "outbound",
        historicalUpdatedAt,
      },
      { scheduleWake: jest.fn() }
    );

    const [, duplicatePipeline] =
      mockConversationFindOneAndUpdate.mock.calls[1] ?? [];
    expect(duplicatePipeline[0].$set.updatedAt).toEqual(
      expect.objectContaining({
        $let: expect.objectContaining({
          in: expect.objectContaining({ $cond: expect.any(Array) }),
        }),
      })
    );
    expect(JSON.stringify(duplicatePipeline[0].$set.updatedAt)).toContain(
      "$updatedAt"
    );
  });
});

function assertHistoryReadState(pipeline: Array<{ $set?: Record<string, unknown> }>) {
  expect(pipeline.some(stage => Object.prototype.hasOwnProperty.call(stage.$set || {}, "is_read_by_manager"))).toBe(false);
}
