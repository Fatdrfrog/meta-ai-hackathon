const mockMessageFind = jest.fn();
const mockFindLatestInboundSharedLocation = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/conversation", () => ({ Conversation: {} }));
jest.mock("@/models/scenario", () => ({ Scenario: {} }));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockMessageFind(...args) },
}));
jest.mock("@/lib/business-locations/inbound-location-query", () => ({
  findLatestInboundSharedLocation: (...args: unknown[]) =>
    mockFindLatestInboundSharedLocation(...args),
}));

import { airiScenarioTimerDependencies } from "./timer-runtime-dependencies";

describe("location routes in the scenario timer host", () => {
  beforeEach(() => jest.clearAllMocks());

  // Without this port no wait can rescue a pin its own turn missed.
  it("looks up undecided shares through the inbound location query", async () => {
    const scope = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      since: new Date("2026-10-05T10:00:00.000Z"),
      until: new Date("2026-10-05T10:05:00.000Z"),
      excludeMessageIds: ["message-decided"],
    };
    mockFindLatestInboundSharedLocation.mockResolvedValue(null);

    await expect(
      airiScenarioTimerDependencies.findLatestInboundLocation?.(scope)
    ).resolves.toBeNull();
    expect(mockFindLatestInboundSharedLocation).toHaveBeenCalledWith(scope);
  });

  it("keeps shared locations out of the No reply stop-word scan", async () => {
    type Query = {
      sort: jest.Mock<Query>;
      limit: jest.Mock<Query>;
      select: jest.Mock<Query>;
      lean: jest.Mock;
    };
    const query: Query = {
      sort: jest.fn(() => query),
      limit: jest.fn(() => query),
      select: jest.fn(() => query),
      lean: jest.fn().mockResolvedValue([{ text: "stop" }]),
    };
    mockMessageFind.mockReturnValue(query);
    const after = new Date("2026-10-05T10:00:00.000Z");

    await expect(
      airiScenarioTimerDependencies.findTextMessagesAfter({
        conversationId: "conversation-1",
        after,
        limit: 200,
      })
    ).resolves.toEqual([{ text: "stop" }]);
    // Every saved message has an all-null location, so only numeric
    // coordinates mark a share.
    expect(mockMessageFind).toHaveBeenCalledWith({
      conversation: "conversation-1",
      date: { $gt: after },
      text: { $exists: true, $ne: "" },
      "whatsappLocation.latitude": { $not: { $type: "number" } },
    });
    expect(query.sort).toHaveBeenCalledWith({ date: -1 });
    expect(query.limit).toHaveBeenCalledWith(200);
    expect(query.select).toHaveBeenCalledWith("text");
  });
});
