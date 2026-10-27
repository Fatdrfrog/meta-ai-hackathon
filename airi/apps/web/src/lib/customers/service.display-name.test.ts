import mongoose from "mongoose";

const mockConnectDB = jest.fn();
const mockConversationFindById = jest.fn();
const mockConversationFind = jest.fn();
const mockCustomerFindById = jest.fn();
const mockCustomerUpdateOne = jest.fn();
const mockUserFind = jest.fn();
const mockChatFind = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: jest.fn(),
  getHeavyTextModel: jest.fn(() => "test-model"),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    find: (...args: unknown[]) => mockConversationFind(...args),
    updateOne: jest.fn(),
  },
}));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockCustomerFindById(...args),
    findOne: jest.fn(),
    updateOne: (...args: unknown[]) => mockCustomerUpdateOne(...args),
    create: jest.fn(),
  },
}));

jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));

jest.mock("@/models/chat", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockChatFind(...args) },
}));

jest.mock("@/models/user", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockUserFind(...args) },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

import {
  ensureCustomerForConversation,
  previewCustomerDisplayName,
} from "@/lib/customers/service";

const conversationId = new mongoose.Types.ObjectId("69b16a2c8f1e4d0012345678");
const customerId = new mongoose.Types.ObjectId("69b16a2c8f1e4d0012345679");
const syntheticName = `whatsapp:${conversationId.toString()}`;

function buildConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: conversationId,
    workspaceId: "ws-1",
    customerId,
    channel: "whatsapp",
    user: "77011234567",
    chat: null,
    sourceId: "source-1",
    visitor_id: null,
    rename: null,
    internal_labels: [] as string[],
    lastMessageAt: new Date("2026-10-10T10:00:00.000Z"),
    updatedAt: new Date("2026-10-10T10:00:00.000Z"),
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    ...overrides,
  };
}

function queryResolving<T>(value: T) {
  return {
    select: jest.fn(() => ({
      lean: jest.fn().mockResolvedValue(value),
    })),
  };
}

/** Mongo does not cast a Mixed `_id`: "123" never matches a stored 123. */
function usersMatchingStrictly(users: Array<Record<string, unknown>>) {
  return (filter: { _id: { $in: unknown[] } }) =>
    queryResolving(users.filter(user => filter._id.$in.includes(user._id)));
}

function storedDisplayName() {
  const aggregateUpdate = mockCustomerUpdateOne.mock.calls.find(([, update]) =>
    Object.prototype.hasOwnProperty.call(
      (update as { $set?: Record<string, unknown> }).$set || {},
      "displayName"
    )
  )?.[1] as { $set: { displayName: string | null } } | undefined;
  return aggregateUpdate?.$set.displayName;
}

describe("customer display names", () => {
  let conversation: ReturnType<typeof buildConversation>;

  beforeEach(() => {
    jest.clearAllMocks();
    conversation = buildConversation();
    const customer = {
      _id: customerId,
      workspaceId: "ws-1",
      status: "active",
      displayName: syntheticName,
      conversationIds: [conversationId],
      seedKeys: [syntheticName],
      identities: [],
      profileSummary: { tags: [], conversationCount: 1 },
    };

    mockConnectDB.mockResolvedValue(undefined);
    mockConversationFindById.mockImplementation(() =>
      queryResolving(conversation)
    );
    mockConversationFind.mockImplementation(() =>
      queryResolving([conversation])
    );
    mockCustomerFindById.mockImplementation(() => {
      const lean = jest.fn().mockResolvedValue(customer);
      return { lean, select: jest.fn(() => ({ lean })) };
    });
    mockCustomerUpdateOne.mockResolvedValue({ acknowledged: true });
    mockChatFind.mockImplementation(() => queryResolving([]));
    mockUserFind.mockImplementation(usersMatchingStrictly([]));
  });

  it("finds Instagram and Telegram users whose ids are numbers", async () => {
    conversation = buildConversation({
      channel: "instagram",
      user: 17841400000123,
    });
    mockUserFind.mockImplementation(
      usersMatchingStrictly([
        { _id: 17841400000123, firstName: "Aida", lastName: "K." },
      ])
    );

    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    expect(mockUserFind).toHaveBeenCalledWith({
      _id: { $in: [17841400000123] },
    });
    expect(storedDisplayName()).toBe("Aida K.");
  });

  it("names WhatsApp leads from the profile name", async () => {
    mockUserFind.mockImplementation(
      usersMatchingStrictly([
        { _id: "77011234567", whatsapp: { profileName: "Айгерим" } },
      ])
    );

    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    expect(storedDisplayName()).toBe("Айгерим");
  });

  it("stores no name rather than a synthetic channel:id label", async () => {
    await ensureCustomerForConversation({
      conversationId: conversationId.toString(),
    });

    expect(storedDisplayName()).toBeNull();
  });

  it("previews the repaired name without writing", async () => {
    mockUserFind.mockImplementation(
      usersMatchingStrictly([
        { _id: "77011234567", whatsapp: { profileName: "Айгерим" } },
      ])
    );

    await expect(
      previewCustomerDisplayName(customerId.toString())
    ).resolves.toEqual({ current: syntheticName, next: "Айгерим" });
    expect(mockCustomerUpdateOne).not.toHaveBeenCalled();
  });
});
