const mockRealtimeTrigger = jest.fn(
  async (_channel: string, _event: string, _payload: unknown) => undefined
);
const mockSendChatAction = jest.fn(
  async (_chatId: string | number, _action: string, _options?: unknown) =>
    undefined
);
const mockSendWhatsappTypingIndicator = jest.fn(
  async (_phoneNumberId: string, _accessToken: string, _messageId: string) => ({
    success: true,
  })
);
const mockConversationUpdateOne = jest.fn(
  async (_filter: unknown, _update: unknown) => undefined
);

jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (channel: string, event: string, payload: unknown) =>
      mockRealtimeTrigger(channel, event, payload),
  },
}));

jest.mock("@/lib/telegram", () => ({
  sendChatAction: (
    chatId: string | number,
    action: string,
    options?: unknown
  ) => mockSendChatAction(chatId, action, options),
}));

jest.mock("@/lib/telegram-business-connection", () => ({
  resolveBusinessConnectionId: jest.fn(() => null),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    updateOne: (filter: unknown, update: unknown) =>
      mockConversationUpdateOne(filter, update),
  },
}));

jest.mock("@/lib/whatsapp", () => ({
  sendWhatsappTypingIndicator: (
    phoneNumberId: string,
    accessToken: string,
    messageId: string
  ) => mockSendWhatsappTypingIndicator(phoneNumberId, accessToken, messageId),
}));

import { TypingManager } from "./auto-reply-realtime";

describe("TypingManager provider indicators", () => {
  beforeEach(() => {
    mockRealtimeTrigger.mockClear();
    mockSendChatAction.mockClear();
    mockSendWhatsappTypingIndicator.mockClear();
    mockConversationUpdateOne.mockClear();
  });

  it("does not mark WhatsApp inbound messages as read before Airi sends a reply", async () => {
    const typing = new TypingManager({
      type: "whatsapp",
      workspaceId: "workspace_1",
      conversation: { _id: "conversation_1" },
      chatDocument: {},
      whatsAppInfo: {
        phoneNumberId: "phone_1",
        accessToken: "token_1",
      },
      newMessage: {
        messageId: "ws_wamid.inbound_1",
      },
    } as never);

    await typing.start();

    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      expect.any(String),
      "airi.typing",
      { workspaceId: "workspace_1", started: true }
    );
    expect(mockSendWhatsappTypingIndicator).not.toHaveBeenCalled();
  });

  it("does not call WhatsApp typing without an inbound platform message id", async () => {
    const typing = new TypingManager({
      type: "whatsapp",
      workspaceId: "workspace_1",
      conversation: { _id: "conversation_1" },
      chatDocument: {},
      whatsAppInfo: {
        phoneNumberId: "phone_1",
        accessToken: "token_1",
      },
      newMessage: {
        messageId: null,
      },
    } as never);

    await typing.start();

    expect(mockSendWhatsappTypingIndicator).not.toHaveBeenCalled();
  });
});
