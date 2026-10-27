const mockConversationFindById = jest.fn();

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

import {
  checkMessagingWindow,
  checkMessagingWindowForConversation,
  formatWindowMessage,
} from "@/lib/messaging-window";

describe("messaging window denormalized timestamps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses conversation.last_inbound_at without a database read", async () => {
    const result = await checkMessagingWindowForConversation({
      _id: "conversation_1",
      last_inbound_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    expect(result.isWithinWindow).toBe(true);
    expect(result.lastCustomerMessageAt).toBeInstanceOf(Date);
    expect(mockConversationFindById).not.toHaveBeenCalled();
  });

  it("reads last_inbound_at when the caller did not select it", async () => {
    const lean = jest.fn().mockResolvedValue({
      last_inbound_at: new Date(Date.now() - 60 * 60 * 1000),
    });
    mockConversationFindById.mockReturnValueOnce({
      select: () => ({ lean }),
    });

    const result = await checkMessagingWindowForConversation({
      _id: "conversation_1",
    });

    expect(result.isWithinWindow).toBe(true);
    expect(mockConversationFindById).toHaveBeenCalledWith("conversation_1");
  });

  it("treats a conversation without last_inbound_at as never messaged", async () => {
    mockConversationFindById.mockReturnValueOnce({
      select: () => ({ lean: jest.fn().mockResolvedValue({}) }),
    });

    await expect(checkMessagingWindow("conversation_1")).resolves.toEqual({
      isWithinWindow: false,
      hoursRemaining: 0,
      lastCustomerMessageAt: null,
    });
  });

  it("does not reload a conversation that already says it has no inbound", async () => {
    await expect(
      checkMessagingWindowForConversation({
        _id: "conversation_1",
        last_inbound_at: null,
      })
    ).resolves.toMatchObject({ lastCustomerMessageAt: null });
    expect(mockConversationFindById).not.toHaveBeenCalled();
  });
});

describe("formatWindowMessage", () => {
  const expired = {
    isWithinWindow: false,
    hoursRemaining: 0,
    lastCustomerMessageAt: new Date("2026-10-01T10:00:00.000Z"),
  };

  it("does not point Instagram managers at message templates", () => {
    expect(formatWindowMessage(expired, "instagram")).toBe(
      "24-hour messaging window expired. Wait for the customer to message you again."
    );
  });

  it("keeps the template hint for WhatsApp", () => {
    expect(formatWindowMessage(expired, "whatsapp")).toContain(
      "approved template messages"
    );
  });
});
