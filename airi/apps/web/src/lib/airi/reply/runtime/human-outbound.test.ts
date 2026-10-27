import { findRecentHumanOutboundAuthor } from "./human-outbound";

const findMock = jest.fn();

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => findMock(...args),
  },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
  },
}));

function chain(result: unknown[]) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe("findRecentHumanOutboundAuthor", () => {
  beforeEach(() => {
    findMock.mockReset();
  });

  it("ignores campaign outbounds even when author is non-bot", async () => {
    findMock.mockReturnValue(
      chain([
        {
          _id: "msg-campaign",
          author: { _id: "whatsapp_business_1", isBot: false },
          origin: { kind: "campaign" },
          date: new Date("2026-07-16T10:00:00.000Z"),
        },
        {
          _id: "msg-manager",
          author: { _id: "manager-1", isBot: false },
          origin: { kind: "manager" },
          date: new Date("2026-07-16T09:00:00.000Z"),
        },
      ])
    );

    await expect(
      findRecentHumanOutboundAuthor({
        conversationId: "conv-1",
        since: new Date("2026-07-16T00:00:00.000Z"),
      })
    ).resolves.toBe("manager-1");
  });

  it("returns undefined when only automated outbounds exist", async () => {
    findMock.mockReturnValue(
      chain([
        {
          _id: "msg-campaign",
          author: { _id: "whatsapp_business_1", isBot: false },
          origin: { kind: "campaign" },
          date: new Date("2026-07-16T10:00:00.000Z"),
        },
      ])
    );

    await expect(
      findRecentHumanOutboundAuthor({
        conversationId: "conv-1",
        since: new Date("2026-07-16T00:00:00.000Z"),
      })
    ).resolves.toBeUndefined();
  });
});
