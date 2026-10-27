const mockMessageFind = jest.fn();

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockMessageFind(...args),
  },
}));

import {
  INBOUND_BURST_WINDOW_MS,
  resolveInboundBurstOwnership,
} from "@/lib/airi/reply/runtime/inbound-burst";

function createFindQuery(value: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  };
}

describe("inbound burst ownership", () => {
  const latestInboundAt = new Date("2026-03-28T10:00:04.000Z");

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("combines consecutive inbound customer messages into one burst", async () => {
    mockMessageFind.mockReturnValue(
      createFindQuery([
        {
          _id: "msg-2",
          direction: "inbound",
          date: new Date("2026-03-28T10:00:04.000Z"),
          author: "wa_1",
          text: "\u0411\u0430\u0493\u0430\u0441\u044b \u049b\u0430\u043d\u0448\u0430",
        },
        {
          _id: "msg-1",
          direction: "inbound",
          date: new Date(
            latestInboundAt.getTime() -
              Math.min(INBOUND_BURST_WINDOW_MS - 1000, 4_000)
          ),
          author: "wa_1",
          text: "\u041c\u0435\u0434\u0430\u043b\u044c \u0456\u043b\u0433\u0456\u0448",
        },
      ])
    );

    const result = await resolveInboundBurstOwnership({
      conversationId: "conv-1",
      currentMessageId: "msg-2",
    });

    expect(result).toEqual({
      shouldProcess: true,
      burstText:
        "\u041c\u0435\u0434\u0430\u043b\u044c \u0456\u043b\u0433\u0456\u0448\n\u0411\u0430\u0493\u0430\u0441\u044b \u049b\u0430\u043d\u0448\u0430",
      burstMessageIds: ["msg-1", "msg-2"],
      latestBurstMessageId: "msg-2",
    });
  });

  it("skips older jobs when a newer inbound message owns the burst", async () => {
    mockMessageFind.mockReturnValue(
      createFindQuery([
        {
          _id: "msg-2",
          direction: "inbound",
          date: new Date("2026-03-28T10:00:03.000Z"),
          author: "wa_1",
          text: "newer",
        },
        {
          _id: "msg-1",
          direction: "inbound",
          date: new Date("2026-03-28T10:00:00.000Z"),
          author: "wa_1",
          text: "older",
        },
      ])
    );

    const result = await resolveInboundBurstOwnership({
      conversationId: "conv-1",
      currentMessageId: "msg-1",
    });

    expect(result).toEqual({
      shouldProcess: false,
      reason: "superseded_by_newer_inbound_burst",
      burstOwnerMessageId: "msg-2",
    });
  });

  it("skips retried older jobs when an outbound already answered them", async () => {
    mockMessageFind.mockReturnValue(
      createFindQuery([
        {
          _id: "msg-out",
          direction: "outbound",
          date: new Date("2026-03-28T10:00:02.000Z"),
          text: "reply",
        },
        {
          _id: "msg-1",
          direction: "inbound",
          date: new Date("2026-03-28T10:00:00.000Z"),
          author: "wa_1",
          text: "older",
        },
      ])
    );

    const result = await resolveInboundBurstOwnership({
      conversationId: "conv-1",
      currentMessageId: "msg-1",
    });

    expect(result).toEqual({
      shouldProcess: false,
      reason: "already_answered_by_prior_outbound",
      answeredByMessageId: "msg-out",
    });
  });
});
