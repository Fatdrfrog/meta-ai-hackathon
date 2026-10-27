const mockUserFind = jest.fn();
const mockChatFind = jest.fn();

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockUserFind(...args) },
}));
jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockChatFind(...args) },
}));

import { loadConversationContactBundles } from "@/lib/customers/conversation-bundles";

type Row = Record<string, unknown> & { _id: unknown };
type QueryChain = {
  select: jest.Mock<QueryChain, [string]>;
  maxTimeMS: jest.Mock<QueryChain, [number]>;
  lean: jest.Mock<Promise<Row[]>, []>;
};

/** Mongo does not cast a Mixed `_id`: "123" never matches a stored 123. */
function findMatchingStrictly(rows: Row[]) {
  return jest.fn((filter: { _id: { $in: unknown[] } }) => {
    const chain: QueryChain = {
      select: jest.fn((_select: string) => chain),
      maxTimeMS: jest.fn((_ms: number) => chain),
      lean: jest.fn(async () =>
        rows.filter(row => filter._id.$in.includes(row._id))
      ),
    };
    return chain;
  });
}

const OPTIONS = {
  userSelect: "_id firstName",
  chatSelect: "_id title",
};

describe("loadConversationContactBundles", () => {
  let userFind: ReturnType<typeof findMatchingStrictly>;
  let chatFind: ReturnType<typeof findMatchingStrictly>;

  beforeEach(() => {
    jest.clearAllMocks();
    userFind = findMatchingStrictly([
      { _id: "wa_77011234567", firstName: "Aigerim" },
      { _id: 123456, firstName: "Daniyar" },
    ]);
    chatFind = findMatchingStrictly([{ _id: 123456, title: "Daniyar chat" }]);
    mockUserFind.mockImplementation(userFind);
    mockChatFind.mockImplementation(chatFind);
  });

  it("looks up Mixed ids with their stored type and keeps conversation order", async () => {
    const conversations = [
      { _id: "a", user: "wa_77011234567", chat: null },
      { _id: "b", user: 123456, chat: 123456 },
      { _id: "c", user: "wa_77011234567" },
      { _id: "d", user: "missing", chat: 999 },
    ];

    const bundles = await loadConversationContactBundles(
      conversations,
      OPTIONS
    );

    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(mockUserFind).toHaveBeenCalledWith({
      _id: { $in: ["wa_77011234567", 123456, "missing"] },
    });
    expect(mockChatFind).toHaveBeenCalledWith({ _id: { $in: [123456, 999] } });
    expect(bundles.map(bundle => bundle.conversation._id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(bundles[0]).toMatchObject({
      user: { firstName: "Aigerim" },
      chat: null,
    });
    expect(bundles[1]).toMatchObject({
      user: { firstName: "Daniyar" },
      chat: { title: "Daniyar chat" },
    });
    expect(bundles[2]?.user).toMatchObject({ firstName: "Aigerim" });
    expect(bundles[3]).toMatchObject({ user: null, chat: null });
  });

  it("prefers inline profiles and skips lookups nobody needs", async () => {
    const inlineUser = { _id: "inline", firstName: "Inline" };
    const bundles = await loadConversationContactBundles(
      [{ _id: "a", user: inlineUser, chat: undefined }],
      OPTIONS
    );

    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockChatFind).not.toHaveBeenCalled();
    expect(bundles).toEqual([
      {
        conversation: { _id: "a", user: inlineUser, chat: undefined },
        user: inlineUser,
        chat: null,
      },
    ]);
  });

  it("passes each caller's select and applies a time limit only when set", async () => {
    const conversations = [{ user: 123456, chat: 123456 }];

    await loadConversationContactBundles(conversations, OPTIONS);
    const untimedUser = userFind.mock.results[0]?.value;
    const untimedChat = chatFind.mock.results[0]?.value;
    expect(untimedUser.select).toHaveBeenCalledWith("_id firstName");
    expect(untimedChat.select).toHaveBeenCalledWith("_id title");
    expect(untimedUser.maxTimeMS).not.toHaveBeenCalled();
    expect(untimedChat.maxTimeMS).not.toHaveBeenCalled();

    await loadConversationContactBundles(conversations, {
      ...OPTIONS,
      maxTimeMS: 5000,
    });
    expect(userFind.mock.results[1]?.value.maxTimeMS).toHaveBeenCalledWith(
      5000
    );
    expect(chatFind.mock.results[1]?.value.maxTimeMS).toHaveBeenCalledWith(
      5000
    );
  });
});
