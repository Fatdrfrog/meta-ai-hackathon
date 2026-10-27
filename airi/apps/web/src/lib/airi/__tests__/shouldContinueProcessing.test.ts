const mockCacheGet = jest.fn();
const mockHasHumanOutboundSince = jest.fn();
const mockMessageFindOne = jest.fn();

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: (_prefix: string, parts: string[]) => parts.join(":"),
  cache: {
    get: (...args: unknown[]) => mockCacheGet(...args),
  },
}));

jest.mock("@/lib/airi/reply/runtime/human-outbound", () => ({
  hasHumanOutboundSince: (...args: unknown[]) =>
    mockHasHumanOutboundSince(...args),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => mockMessageFindOne(...args),
  },
}));

import { shouldContinueProcessing } from "@/lib/airi/shouldContinueProcessing";

const turnTimestamp = Date.parse("2026-04-02T05:08:02.000Z");

function createFindOneChain(result: unknown) {
  return {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(result),
  };
}

describe("shouldContinueProcessing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageFindOne.mockReturnValue(createFindOneChain(null));
    mockHasHumanOutboundSince.mockResolvedValue(false);
  });

  afterEach(() => {
    // The checkpoint is Mongo-only; Upstash costs a cross-region round trip.
    expect(mockCacheGet).not.toHaveBeenCalled();
  });

  it("cancels when a newer human outbound arrives", async () => {
    mockHasHumanOutboundSince.mockResolvedValue(true);

    const result = await shouldContinueProcessing(
      "workspace-1",
      "conversation-1",
      "msg-1",
      turnTimestamp
    );

    expect(result).toBe(false);
    expect(mockHasHumanOutboundSince).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      since: new Date("2026-04-02T05:08:02.001Z"),
    });
  });

  it("cancels when an inbound message newer than the turn's own message arrived", async () => {
    mockMessageFindOne.mockReturnValue(
      createFindOneChain({
        _id: "msg-2",
        date: new Date("2026-04-02T05:08:05.000Z"),
      })
    );

    const result = await shouldContinueProcessing(
      "workspace-1",
      "conversation-1",
      "msg-1",
      turnTimestamp
    );

    expect(result).toBe(false);
    expect(mockMessageFindOne).toHaveBeenCalledWith({
      conversation: "conversation-1",
      direction: "inbound",
      date: { $gt: new Date(turnTimestamp) },
    });
  });

  it("continues when there is no newer inbound or human outbound", async () => {
    const result = await shouldContinueProcessing(
      "workspace-1",
      "conversation-1",
      "msg-1",
      turnTimestamp
    );

    expect(result).toBe(true);
    expect(mockMessageFindOne).toHaveBeenCalledTimes(1);
    expect(mockHasHumanOutboundSince).toHaveBeenCalledTimes(1);
  });

  it("continues scenario delivery when a newer inbound arrived after the checkpoint turn", async () => {
    mockMessageFindOne.mockReturnValue(
      createFindOneChain({
        _id: "msg-2",
        date: new Date("2026-04-02T05:08:05.000Z"),
      })
    );

    const result = await shouldContinueProcessing(
      "workspace-1",
      "conversation-1",
      "msg-1",
      turnTimestamp,
      {
        preserveScenarioDelivery: true,
        checkpointLabel: "Pre-Scenario-WhatsApp-Template",
      }
    );

    expect(result).toBe(true);
  });

  it("fails open when the Mongo checks throw", async () => {
    mockHasHumanOutboundSince.mockRejectedValue(new Error("mongo timeout"));

    const result = await shouldContinueProcessing(
      "workspace-1",
      "conversation-1",
      "msg-1",
      turnTimestamp
    );

    expect(result).toBe(true);
  });
});
