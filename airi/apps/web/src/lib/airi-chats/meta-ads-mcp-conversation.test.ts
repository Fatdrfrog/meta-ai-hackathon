const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
jest.mock("@/models/airi-chat-thread", () => ({
  AiriChatThread: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
}));

import { getMetaAdsMcpConversationId } from "./meta-ads-mcp-conversation";

const context = {
  workspaceId: "workspace-1",
  userId: "user-1",
  threadId: "thread-1",
};

function store(existing?: string) {
  let conversationId = existing;
  let writes = 0;
  const matches = (filter: Record<string, unknown>) =>
    filter._id === context.threadId &&
    filter.workspaceId === context.workspaceId &&
    filter.createdByUserId === context.userId;
  mockFindOne.mockImplementation((filter: Record<string, unknown>) => {
    const snapshot = matches(filter)
      ? { metaAdsMcpConversationId: conversationId }
      : null;
    return { select: () => ({ lean: async () => snapshot }) };
  });
  mockFindOneAndUpdate.mockImplementation(
    (
      filter: Record<string, unknown>,
      update: { $set: { metaAdsMcpConversationId: string } }
    ) => ({
      lean: async () => {
        if (!matches(filter) || conversationId) return null;
        expect(filter.metaAdsMcpConversationId).toEqual({ $exists: false });
        conversationId = update.$set.metaAdsMcpConversationId;
        writes += 1;
        return { metaAdsMcpConversationId: conversationId };
      },
    })
  );
  return { read: () => conversationId, writes: () => writes };
}

describe("Meta Ads provider conversation identity", () => {
  beforeEach(() => jest.clearAllMocks());

  it("persists one opaque provider id across simultaneous and later turns", async () => {
    const data = store();
    const [first, second] = await Promise.all([
      getMetaAdsMcpConversationId(context),
      getMetaAdsMcpConversationId(context),
    ]);
    expect(first).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(second).toBe(first);
    expect(await getMetaAdsMcpConversationId(context)).toBe(first);
    expect(data.read()).toBe(first);
    expect(data.writes()).toBe(1);
  });

  it("does not initialize another workspace or user's thread", async () => {
    const data = store();
    await expect(
      getMetaAdsMcpConversationId({ ...context, userId: "other-user" })
    ).rejects.toThrow(/not found/i);
    await expect(
      getMetaAdsMcpConversationId({
        ...context,
        workspaceId: "other-workspace",
      })
    ).rejects.toThrow(/not found/i);
    expect(data.writes()).toBe(0);
  });

  it("does not silently rotate a malformed saved provider id", async () => {
    const data = store("broken");
    await expect(getMetaAdsMcpConversationId(context)).rejects.toThrow(
      /invalid/i
    );
    expect(data.read()).toBe("broken");
    expect(data.writes()).toBe(0);
  });
});
